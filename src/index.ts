#!/usr/bin/env bun
import { join } from "node:path";
import { Command } from "commander";
import { startCliChat } from "./channels/cli.ts";
import { formatSkills } from "./channels/skillsView.ts";
import { loadConfig } from "./config.ts";
import { openDatabase } from "./db/database.ts";
import { runDoctor } from "./doctor.ts";
import { buildChannels } from "./gateway/channels.ts";
import { Gateway } from "./gateway/gateway.ts";
import { OpenAICompatibleProvider } from "./llm/openaiCompatible.ts";
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
    const gateway = new Gateway(runtime, channels, {
      defaultChat: config.gateway.defaultChat,
      answerTimeoutMs: config.gateway.answerTimeoutMinutes * 60_000,
      http: { host: config.gateway.host, port: config.gateway.port },
    });
    await gateway.start();
    console.log(`🦀 ${config.agent.name} gateway running · model ${llm.model} · channels: ${channels.map((c) => c.name).join(", ")}`);
    if (runtime.guard.paused) console.log(`⛔ ${runtime.guard.pausedInfo()} — send /resume from a chat to continue.`);
    console.log("Press Ctrl+C to stop.");

    const shutdown = async () => {
      console.log("\nStopping…");
      await gateway.stop();
      process.exit(0);
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
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
