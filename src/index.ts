#!/usr/bin/env bun
import { join } from "node:path";
import { Command } from "commander";
import { startCliChat } from "./channels/cli.ts";
import { formatSkills } from "./channels/skillsView.ts";
import { loadConfig } from "./config.ts";
import { openDatabase } from "./db/database.ts";
import { runDoctor } from "./doctor.ts";
import { createDashboard, dashboardLink } from "./dashboard/server.ts";
import { buildChannels } from "./gateway/channels.ts";
import { Gateway } from "./gateway/gateway.ts";
import { OpenAICompatibleProvider } from "./llm/openaiCompatible.ts";
import { formatReplay, formatRuns, formatTally } from "./recorder/format.ts";
import { replayRun } from "./recorder/replay.ts";
import { RunStore } from "./recorder/runs.ts";
import { SkillGrants } from "./skills/grants.ts";
import { loadSkills } from "./skills/loader.ts";
import { createRuntime } from "./runtime.ts";

const program = new Command();

program
  .name("miniclaw")
  .description("My personal AI agent")
  .version("1.0.0");

program
  .command("chat")
  .description("Start chatting with the agent")
  .option("-m, --model <name>", "which model to use (default: from config)")
  .action(async (options: { model?: string }) => {
    const config = loadConfig({ model: options.model });
    await startCliChat(config, new OpenAICompatibleProvider(config.llm));
  });

program
  .command("doctor")
  .description("Check that MiniClaw is set up correctly")
  .option("-m, --model <name>", "check this model instead of the configured one")
  .action(async (options: { model?: string }) => {
    const ok = await runDoctor({ model: options.model });
    process.exitCode = ok ? 0 : 1;
  });

program
  .command("gateway")
  .description("Run MiniClaw for your chat apps (Telegram, WhatsApp) and deliver reminders")
  .option("-m, --model <name>", "which model to use (default: from config)")
  .action(async (options: { model?: string }) => {
    const config = loadConfig({ model: options.model });
    const { channels, errors } = buildChannels(config);
    if (errors.length) throw new Error(`Cannot start the gateway:\n- ${errors.join("\n- ")}`);
    if (channels.length === 0) {
      throw new Error("No chat apps are configured. See the README's \"Chat apps\" section to set up Telegram or WhatsApp.");
    }

    const llm = new OpenAICompatibleProvider(config.llm);
    const runtime = await createRuntime(config, llm);
    let dashboard: ReturnType<typeof createDashboard> | undefined;
    const gateway: Gateway = new Gateway(runtime, channels, {
      fallback: (request) => dashboard!.handle(request),
      defaultChat: config.gateway.defaultChat,
      answerTimeoutMs: config.gateway.answerTimeoutMinutes * 60_000,
      http: { host: config.gateway.host, port: config.gateway.port },
      ...(config.gateway.briefingTime && {
        briefing: { time: config.gateway.briefingTime, stateFile: join(config.paths.data, "last-briefing") },
      }),
    });
    dashboard = createDashboard({ runtime, gateway, tokenFile: join(config.paths.data, "dashboard-token") });
    await gateway.start();
    console.log(`🦀 ${config.agent.name} gateway running · model ${llm.model} · channels: ${channels.map((c) => c.name).join(", ")}`);
    if (runtime.guard.paused) console.log(`⛔ ${runtime.guard.pausedInfo()} — send /resume from a chat to continue.`);
    if (config.gateway.briefingTime) console.log(`☀️ Daily briefing at ${config.gateway.briefingTime}`);
    console.log(`📊 Dashboard: ${dashboardLink(config.gateway.host, config.gateway.port, dashboard.token)}`);
    console.log("Press Ctrl+C to stop.");

    const shutdown = async () => {
      console.log("\nStopping…");
      await gateway.stop();
      process.exit(0);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });

program
  .command("dashboard")
  .description("Open the web dashboard without running chat apps (the gateway also serves it)")
  .option("-p, --port <port>", "port (default: gateway.port)")
  .action(async (options: { port?: string }) => {
    const config = loadConfig();
    const runtime = await createRuntime(config, new OpenAICompatibleProvider(config.llm));
    const dashboard = createDashboard({ runtime, tokenFile: join(config.paths.data, "dashboard-token") });
    const port = options.port ? Number(options.port) : config.gateway.port;
    try {
      Bun.serve({ hostname: config.gateway.host, port, fetch: (request) => dashboard.handle(request) });
    } catch {
      throw new Error(`Port ${port} is in use. If \`miniclaw gateway\` is running, it already serves the dashboard; otherwise use --port.`);
    }
    console.log(`📊 MiniClaw dashboard: ${dashboardLink(config.gateway.host, port, dashboard.token)}`);
    console.log("Live approvals need `miniclaw gateway`. Press Ctrl+C to stop.");
  });

program
  .command("runs")
  .description("List recent agent runs from the flight recorder")
  .option("-n, --limit <n>", "how many", "20")
  .action((options: { limit: string }) => {
    const config = loadConfig();
    const runs = new RunStore(openDatabase(join(config.paths.data, "miniclaw.db")));
    console.log(formatRuns(runs.list(Number(options.limit) || 20)));
  });

program
  .command("replay <runId>")
  .description("Re-run a recorded run with another model, without executing any tools")
  .option("-m, --model <name>", "model to replay with (default: from config)")
  .option("-n, --times <n>", "replay several times and tally the outcomes (models are not deterministic)", "1")
  .option("--json", "print the full result(s) as JSON")
  .action(async (runId: string, options: { model?: string; times: string; json?: boolean }) => {
    const config = loadConfig({ model: options.model });
    const run = new RunStore(openDatabase(join(config.paths.data, "miniclaw.db"))).get(runId);
    if (!run) throw new Error(`No run ${runId}. See \`miniclaw runs\`.`);
    const llm = new OpenAICompatibleProvider(config.llm);
    const times = Math.max(1, Number(options.times) || 1);
    const results = [];
    for (let i = 0; i < times; i++) {
      const result = await replayRun(run, llm);
      results.push(result);
      if (!options.json && times === 1) console.log(formatReplay(result));
      else if (!options.json) console.log(`replay ${i + 1}/${times}: ${result.outcome} (${(result.durationMs / 1000).toFixed(1)}s)`);
    }
    if (options.json) console.log(JSON.stringify(times === 1 ? results[0] : results, null, 2));
    else if (times > 1) console.log(`\n${formatTally(results)}`);
  });

const skillsCommand = program.command("skills").description("List installed skills and their permissions");
skillsCommand.action(() => {
  const config = loadConfig();
  const { skills, problems } = loadSkills(config.paths.skills);
  const grants = new SkillGrants(openDatabase(join(config.paths.data, "miniclaw.db")));
  console.log(formatSkills(skills, problems, grants, config.paths.skills));
});
skillsCommand
  .command("revoke <name>")
  .description("Withdraw consent for a skill; it will ask again on next use")
  .action((name: string) => {
    const config = loadConfig();
    new SkillGrants(openDatabase(join(config.paths.data, "miniclaw.db"))).revoke(name);
    console.log(`Consent for "${name}" withdrawn.`);
  });

try {
  await program.parseAsync(process.argv);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
