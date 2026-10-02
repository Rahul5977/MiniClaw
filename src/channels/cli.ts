import { join } from "node:path";
import { stdin as input, stdout as output } from "node:process";
import { createInterface, type Interface } from "node:readline";
import { APIConnectionError } from "openai";
import { Agent, type AgentEvent } from "../agent/agent.ts";
import { createPlan, planScopes, planTask } from "../agent/planner.ts";
import { buildSystemPrompt } from "../agent/prompt.ts";
import { Session } from "../agent/session.ts";
import type { Config } from "../config.ts";
import { openDatabase } from "../db/database.ts";
import { SessionStore } from "../db/sessions.ts";
import type { LLMProvider } from "../llm/provider.ts";
import { ApprovalPolicy, type ApprovalRequest, type Approver, type Decision } from "../security/approvals.ts";
import { AuditLog } from "../security/audit.ts";
import { prepareWorkspace } from "../security/sandbox.ts";
import { listDirTool, readFileTool, writeFileTool } from "../tools/files.ts";
import { runShellTool } from "../tools/shell.ts";
import { ToolRegistry, type RiskLevel } from "../tools/tool.ts";
import { webFetchTool } from "../tools/web.ts";
import { Checkpoints } from "../workspace/checkpoints.ts";

const color = (code: number) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;
const dim = color(2);
const red = color(31);
const green = color(32);
const yellow = color(33);
const cyan = color(36);
const bold = color(1);

const RISK_COLOR: Record<RiskLevel, (s: string) => string> = { low: dim, medium: yellow, high: red, blocked: red };

const HELP = `Commands:
  /plan <task> preview the agent's plan with risk levels, approve it once, then run it
  /undo [n]   undo the last n file changes made by the agent (default 1)
  /history    list recent agent changes that can be undone
  /tools      list the tools the agent can use
  /new        start a new conversation (also forgets "always allow" approvals)
  /help       show this help
  /exit       quit (or press Ctrl+D)
While the agent is working, press Ctrl+C to stop it.`;

export async function startCliChat(config: Config, llm: LLMProvider): Promise<void> {
  const db = openDatabase(join(config.paths.data, "miniclaw.db"));
  const workspace = prepareWorkspace(config.paths.workspace);
  const checkpoints = new Checkpoints(join(config.paths.data, "checkpoints.git"), workspace);
  await checkpoints.init();

  const tools = new ToolRegistry([readFileTool, listDirTool, writeFileTool, runShellTool, webFetchTool]);
  const sessions = new SessionStore(db);
  const openSession = (id: string) =>
    new Session({
      id,
      store: sessions,
      systemPrompt: () => buildSystemPrompt(config.agent.name, tools.list()),
      historyLimit: config.agent.historyLimit,
    });
  // Pick up the last conversation, like a chat app does.
  let session = openSession(sessions.latest("cli")?.id ?? sessions.create("cli"));
  const policy = new ApprovalPolicy();
  const rl = createInterface({ input, output, prompt: cyan("you › ") });

  // Ctrl+C stops the current run (including an open approval prompt), otherwise quits.
  let current: AbortController | null = null;
  rl.on("SIGINT", () => {
    if (current) current.abort();
    else rl.close();
  });

  const approver = new CliApprover(rl, () => current?.signal);
  const agent = new Agent({
    llm,
    tools,
    policy,
    approver,
    audit: new AuditLog(db),
    checkpoints,
    workspace,
    maxSteps: config.agent.maxSteps,
  });

  console.log(cyan(`🦀 ${config.agent.name}`) + dim(` · model ${llm.model} · ${config.llm.baseURL}`));
  console.log(dim(`Workspace: ${workspace}`));
  if (session.turnCount > 0) {
    const n = session.turnCount;
    console.log(dim(`Continuing your last conversation (${n} earlier ${n === 1 ? "message" : "messages"}). /new starts fresh.`));
  }
  console.log(dim("Type /help for commands.\n"));

  // Iterating (instead of rl.question) buffers lines, so pasted or piped input isn't lost.
  // The loop ends when readline closes (Ctrl+D, or Ctrl+C at the prompt).
  rl.prompt();
  for await (const raw of rl) {
    const line = raw.trim();
    if (line.startsWith("/")) {
      const [command = "", ...rest] = line.slice(1).split(/\s+/);
      if (command === "exit" || command === "quit") break;
      await runCommand(command.toLowerCase(), rest.join(" ") || undefined);
    } else if (line) {
      await runAgent(line);
    }
    rl.prompt();
  }

  rl.close();
  console.log(dim("Bye! 👋"));

  async function runCommand(command: string, arg?: string): Promise<void> {
    switch (command) {
      case "new":
        session = openSession(sessions.create("cli"));
        policy.reset();
        console.log(dim("Started a new conversation.\n"));
        return;
      case "undo": {
        const n = arg ? Number(arg) : 1;
        if (!Number.isInteger(n) || n < 1) return void console.log(red("Usage: /undo [n]\n"));
        const result = await checkpoints.undo(n);
        if (!result) return void console.log(dim("Nothing to undo.\n"));
        for (const c of result.undone) console.log(green("↶ undone: ") + c.summary);
        console.log(dim(`  reverted: ${formatChanges(result.files) || "(no file changes)"}\n`));
        return;
      }
      case "history": {
        const history = await checkpoints.history(10);
        if (history.length === 0) return void console.log(dim("No agent changes yet.\n"));
        history.forEach((c, i) => console.log(`${dim(`${i + 1}.`)} ${c.summary} ${dim(`(${c.when})`)}`));
        console.log(dim("Use /undo n to undo the latest n changes.\n"));
        return;
      }
      case "plan":
        if (!arg) return void console.log(red("Usage: /plan <task>\n"));
        await runPlan(arg);
        return;
      case "tools":
        for (const tool of tools.list()) console.log(`${bold(tool.name)} ${dim("— " + tool.description)}`);
        console.log();
        return;
      case "help":
        console.log(HELP + "\n");
        return;
      default:
        console.log(red(`Unknown command: /${command}`) + dim(" (try /help)\n"));
    }
  }

  /** I-2: plan → show risk per step → approve once → run → summarize changes. */
  async function runPlan(task: string): Promise<void> {
    current = new AbortController();
    let steps;
    try {
      console.log(dim("Planning…"));
      steps = await createPlan(llm, tools, task, { workspace, signal: current.signal });
    } catch (error) {
      if (current.signal.aborted) console.log(dim("[stopped]\n"));
      else console.error(red(`Error: ${describeError(error)}\n`));
      current = null;
      return;
    }

    console.log(bold("\nPlan:"));
    steps.forEach((step, i) => {
      const { level, reasons } = step.risk;
      console.log(`  ${dim(`${i + 1}.`)} ${RISK_COLOR[level]("⚙")} ${step.tool} ${bold(step.target)} ${dim(`[${level}]`)} ${dim("— " + step.why)}`);
      if (level === "high" || level === "blocked") for (const r of reasons) console.log(`       ${RISK_COLOR[level]("•")} ${r}`);
    });
    console.log(dim("Approving lets the medium-risk steps run without asking again. High-risk steps still ask; blocked steps never run."));

    const ok = await approver.confirm("Run this plan?");
    current = null;
    if (!ok) return void console.log(dim("Plan cancelled.\n"));

    const start = await checkpoints.head();
    policy.allowPlan(planScopes(steps));
    try {
      await runAgent(planTask(task, steps));
    } finally {
      policy.clearPlan();
    }
    const { stat, actions } = await checkpoints.changesSince(start);
    if (actions > 0) {
      console.log(bold("Changes made by this plan:"));
      console.log(dim(stat));
      console.log(dim(`Use /undo ${actions} to revert all of them.\n`));
    }
  }

  async function runAgent(text: string): Promise<void> {
    current = new AbortController();
    const renderer = new Renderer(config.agent.name.toLowerCase());
    try {
      for await (const event of agent.run(session, text, current.signal)) renderer.render(event);
      renderer.end();
    } catch (error) {
      renderer.end();
      if (current.signal.aborted) console.log(dim("[stopped]\n"));
      else {
        console.error(red(`Error: ${describeError(error)}`));
        console.error(dim("Run `miniclaw doctor` to check your setup.\n"));
      }
    } finally {
      current = null;
    }
  }
}

/** Prints agent events: streamed text, plus one status line per tool call. */
class Renderer {
  private inText = false;

  constructor(private name: string) {}

  render(event: AgentEvent): void {
    switch (event.type) {
      case "text":
        if (!this.inText) output.write(cyan(`${this.name} › `));
        this.inText = true;
        output.write(event.delta);
        return;
      case "tool_start":
        this.breakLine();
        console.log(`  ${RISK_COLOR[event.risk.level]("⚙")} ${event.summary} ${dim(`[${event.risk.level}]`)}`);
        return;
      case "tool_end": {
        const first = event.output.split("\n")[0]?.slice(0, 100) ?? "";
        if (event.verdict === "blocked") console.log(red("    ✖ blocked by safety rules"));
        else if (event.verdict === "denied") console.log(yellow("    ✖ denied"));
        else if (event.verdict === "invalid") console.log(yellow(`    ✖ invalid call, the model will retry: ${dim(first)}`));
        else if (!event.ok) console.log(red(`    ✖ ${first}`));
        else {
          const how = event.verdict === "session" || event.verdict === "plan" ? dim(` (${event.verdict}-approved)`) : "";
          const changed = event.changes.length ? dim(` · changed ${formatChanges(event.changes)}`) : "";
          console.log(green("    ✔ done") + how + changed);
        }
        return;
      }
      case "step_limit":
        this.breakLine();
        console.log(yellow(`  ! reached the limit of ${event.maxSteps} steps`));
        return;
    }
  }

  end(): void {
    if (this.inText) output.write("\n");
    output.write("\n");
    this.inText = false;
  }

  private breakLine(): void {
    if (this.inText) output.write("\n");
    this.inText = false;
  }
}

/** Asks for approval in the terminal. Ctrl+C while asking counts as "no". */
class CliApprover implements Approver {
  constructor(
    private rl: Interface,
    private signal: () => AbortSignal | undefined,
  ) {}

  async ask(request: ApprovalRequest): Promise<Decision> {
    const { risk } = request;
    for (const reason of risk.reasons) console.log(`    ${RISK_COLOR[risk.level]("•")} ${reason}`);
    if (request.preview) console.log(colorDiff(request.preview));

    const target = risk.scope.slice(risk.scope.indexOf(":") + 1);
    const options = risk.sessionApprovable
      ? `${bold("y")}es / ${bold("n")}o / ${bold("a")}lways allow ${target} this session`
      : `${bold("y")}es / ${bold("n")}o`;

    while (true) {
      const answer = await this.question(`    Allow? ${dim("[")}${options}${dim("]")} `);
      if (answer === null) return "deny";
      const a = answer.trim().toLowerCase();
      if (a === "y" || a === "yes") return "approve";
      if (a === "n" || a === "no" || a === "") return "deny";
      if ((a === "a" || a === "always") && risk.sessionApprovable) return "approve_session";
    }
  }

  async confirm(prompt: string): Promise<boolean> {
    const answer = await this.question(`${prompt} ${dim("[")}${bold("y")}es / ${bold("n")}o${dim("]")} `);
    return answer !== null && /^y(es)?$/i.test(answer.trim());
  }

  /** Resolves null if the run is aborted (Ctrl+C) while waiting for an answer. */
  private question(prompt: string): Promise<string | null> {
    const signal = this.signal();
    if (signal?.aborted) return Promise.resolve(null);
    return new Promise((resolve) => {
      const onAbort = () => {
        output.write("\n");
        resolve(null);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      // Passing the signal cancels the pending question, so it can't swallow the next line typed.
      this.rl.question(prompt, { signal }, (answer) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(answer);
      });
    });
  }
}

function colorDiff(diff: string): string {
  return diff
    .split("\n")
    .map((line) => {
      const indented = `      ${line}`;
      if (line.startsWith("+")) return green(indented);
      if (line.startsWith("-")) return red(indented);
      if (line.startsWith("@@")) return cyan(indented);
      return dim(indented);
    })
    .join("\n");
}

/** ["A\tnew.md", "M\tnotes.md"] → "+new.md ~notes.md" */
function formatChanges(changes: string[]): string {
  const marks: Record<string, string> = { A: "+", M: "~", D: "-" };
  return changes
    .map((change) => {
      const [status = "", ...paths] = change.split("\t");
      return `${marks[status[0] ?? ""] ?? status}${paths.at(-1)}`;
    })
    .join(" ");
}

function describeError(error: unknown): string {
  if (error instanceof APIConnectionError) {
    return "cannot reach the LLM server. Is Ollama running? (`ollama serve`)";
  }
  return error instanceof Error ? error.message : String(error);
}
