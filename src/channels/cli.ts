import { stdin as input, stdout as output } from "node:process";
import { createInterface, type Interface } from "node:readline";
import { APIConnectionError } from "openai";
import type { AgentEvent } from "../agent/agent.ts";
import { createPlan, planScopes, planTask } from "../agent/planner.ts";
import type { Config } from "../config.ts";
import type { LLMProvider } from "../llm/provider.ts";
import { addDays, today } from "../memory/facts.ts";
import { createRuntime } from "../runtime.ts";
import { formatDue } from "../scheduler/reminders.ts";
import { ApprovalPolicy, type ApprovalRequest, type Approver, type Decision } from "../security/approvals.ts";
import type { RiskLevel } from "../tools/tool.ts";
import { formatSkills } from "./skillsView.ts";

const color = (code: number) => (s: string) => `\x1b[${code}m${s}\x1b[0m`;
const dim = color(2);
const red = color(31);
const green = color(32);
const yellow = color(33);
const cyan = color(36);
const bold = color(1);

const RISK_COLOR: Record<RiskLevel, (s: string) => string> = { low: dim, medium: yellow, high: red, blocked: red };

const HELP = `Commands:
  /plan <task>     preview the agent's plan with risk levels, approve it once, then run it
  /memory          show what MiniClaw remembers about you
  /inbox           review memories the agent proposed
  /forget <words>  delete remembered facts containing these words
  /notes [date]    show the daily log (today, yesterday or YYYY-MM-DD)
  /undo [n]        undo the last n file changes made by the agent (default 1)
  /history         list recent agent changes that can be undone
  /reminders       list upcoming reminders (/reminders cancel <n> to cancel one)
  /status          pause state and today's action budgets
  /panic           emergency stop: block all risky actions until /resume
  /resume          lift /panic
  /skills          list installed skills and their permissions
  /tools           list the tools the agent can use
  /new             start a new conversation (also forgets "always allow" approvals)
  /help            show this help
  /exit            quit (or press Ctrl+D)
While the agent is working, press Ctrl+C to stop it.`;

export async function startCliChat(config: Config, llm: LLMProvider): Promise<void> {
  const runtime = await createRuntime(config, llm);
  const { checkpoints, facts, inbox, notes, skills, skillProblems, grants, tools, sessions, workspace } = runtime;
  // Pick up the last conversation, like a chat app does.
  let session = runtime.openSession(sessions.latest("cli")?.id ?? sessions.create("cli"));
  const policy = new ApprovalPolicy();
  const rl = createInterface({ input, output, prompt: cyan("you › ") });

  // Ctrl+C stops the current run (including an open approval prompt), otherwise quits.
  let current: AbortController | null = null;
  rl.on("SIGINT", () => {
    if (current) current.abort();
    else rl.close();
  });

  const approver = new CliApprover(rl, () => current?.signal);
  const agent = runtime.createAgent({ policy, approver });

  console.log(cyan(`🦀 ${config.agent.name}`) + dim(` · model ${llm.model} · ${config.llm.baseURL}`));
  console.log(dim(`Workspace: ${workspace}`));
  if (skills.length) console.log(dim(`Skills: ${skills.map((s) => s.name).join(", ")}`));
  for (const p of skillProblems) console.log(yellow(`! skill ${p.dir} skipped: ${p.error}`));
  if (session.turnCount > 0) {
    const n = session.turnCount;
    console.log(dim(`Continuing your last conversation (${n} earlier ${n === 1 ? "message" : "messages"}). /new starts fresh.`));
  }
  const paused = runtime.guard.pausedInfo();
  if (paused) console.log(red(`⛔ MiniClaw is ${paused}. Risky actions are blocked until /resume.`));
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
      const started = Date.now();
      await runAgent(line);
      await reviewInbox(started);
    }
    rl.prompt();
  }

  rl.close();
  console.log(dim("Bye! 👋"));

  async function runCommand(command: string, arg?: string): Promise<void> {
    switch (command) {
      case "new":
        session = runtime.openSession(sessions.create("cli"));
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
      case "memory": {
        const known = facts.all();
        if (known.length === 0) console.log(dim("I don't remember anything about you yet."));
        known.forEach((f, i) => console.log(`${dim(`${i + 1}.`)} ${f.text}${f.expires ? dim(` (until ${f.expires})`) : ""}`));
        const waiting = inbox.pending().length;
        if (waiting) console.log(yellow(`📥 ${waiting} proposed ${waiting === 1 ? "memory is" : "memories are"} waiting — /inbox to review.`));
        console.log(dim(`Edit by hand: ${facts.path}\n`));
        return;
      }
      case "inbox":
        if (inbox.pending().length === 0) return void console.log(dim("No memories waiting for review.\n"));
        await reviewInbox();
        return;
      case "forget": {
        if (!arg) return void console.log(red("Usage: /forget <words>") + dim("  e.g. /forget goa\n"));
        const matches = facts.search(arg);
        if (matches.length === 0) return void console.log(dim(`Nothing remembered matches "${arg}".\n`));
        for (const f of matches) console.log(`  ${red("−")} ${f.text}`);
        if (await approver.confirm(`Forget ${matches.length === 1 ? "this fact" : `these ${matches.length} facts`}?`)) {
          facts.remove(matches.map((f) => f.id));
          console.log(green("Forgotten.\n"));
        } else console.log(dim("Kept.\n"));
        return;
      }
      case "notes": {
        const date = !arg || arg === "today" ? today() : arg === "yesterday" ? addDays(today(), -1) : arg;
        console.log(notes.read(date) ?? dim(`No notes for ${date}.`));
        return;
      }
      case "panic":
        runtime.guard.pause("the terminal");
        console.log(red("⛔ Paused. Risky actions are blocked (reading still works) until /resume.\n"));
        return;
      case "resume":
        runtime.guard.resume();
        console.log(green("▶ Resumed.\n"));
        return;
      case "status": {
        const info = runtime.guard.pausedInfo();
        console.log(info ? red(`⛔ ${info}`) : green("▶ running"));
        for (const u of runtime.guard.usage()) console.log(dim(`  ${u.tool}: ${u.used}/${u.limit} today`));
        console.log(dim(`  ${runtime.reminders.pending().length} upcoming reminders, ${inbox.pending().length} memories to review\n`));
        return;
      }
      case "reminders": {
        const [sub, id] = (arg ?? "").split(/\s+/);
        if (sub === "cancel") {
          const cancelled = runtime.reminders.cancel(Number(id));
          return void console.log(cancelled ? green(`Cancelled #${cancelled.id}: ${cancelled.text}\n`) : red(`No upcoming reminder #${id}\n`));
        }
        const pending = runtime.reminders.pending();
        if (pending.length === 0) console.log(dim("No upcoming reminders."));
        for (const r of pending) console.log(`${dim(`#${r.id}`)} ${formatDue(r.dueAt)}${r.repeat ? dim(` (${r.repeat})`) : ""} ${r.text}`);
        console.log(dim("Reminders are delivered while `miniclaw gateway` is running.\n"));
        return;
      }
      case "skills":
        console.log(formatSkills(skills, skillProblems, grants, config.paths.skills) + "\n");
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

  /** I-5: ask the user about memories the agent proposed (since a time, or all). */
  async function reviewInbox(since = 0): Promise<void> {
    for (const proposal of inbox.pending(since)) {
      const until = proposal.expires ? dim(` (until ${proposal.expires})`) : "";
      console.log(`${cyan("📥 Remember this?")} ${bold(proposal.fact)}${until}`);
      if (proposal.untrustedSources.length) {
        console.log(red(`   ⚠ proposed after reading ${proposal.untrustedSources.join(", ")}`));
        console.log(red("     If you didn't say this yourself, it may be a prompt injection."));
      }
      const answer = (await approver.prompt(`   ${dim("[")}${bold("y")}es / ${bold("n")}o / ${bold("l")}ater${dim("]")} `))?.trim().toLowerCase();
      if (answer === "y" || answer === "yes") {
        inbox.accept(proposal.id);
        console.log(green("   ✔ saved to memory"));
      } else if (answer === "n" || answer === "no") {
        inbox.reject(proposal.id);
        console.log(dim("   ✖ discarded"));
      } else {
        console.log(dim("   kept in /inbox for later"));
      }
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
      const started = Date.now();
      await runAgent(planTask(task, steps));
      await reviewInbox(started);
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
        if (event.risk.level === "blocked") for (const r of event.risk.reasons) console.log(red(`    • ${r}`));
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
      case "notice":
        this.breakLine();
        console.log(yellow(`  ⚠ ${event.message}`));
        return;
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
  private closed = false;
  private mainPrompt: string;

  constructor(
    private rl: Interface,
    private signal: () => AbortSignal | undefined,
  ) {
    this.mainPrompt = rl.getPrompt();
    // After Ctrl+D (or the end of piped input) every question answers null, i.e. "no"/"later".
    rl.on("close", () => (this.closed = true));
  }

  async ask(request: ApprovalRequest): Promise<Decision> {
    const { risk } = request;
    for (const reason of risk.reasons) console.log(`    ${RISK_COLOR[risk.level]("•")} ${reason}`);
    if (request.preview) console.log(colorDiff(request.preview));

    const target = risk.scope.slice(risk.scope.indexOf(":") + 1);
    const options = risk.sessionApprovable
      ? `${bold("y")}es / ${bold("n")}o / ${bold("a")}lways allow ${target} this session`
      : `${bold("y")}es / ${bold("n")}o`;

    while (true) {
      const answer = await this.prompt(`    Allow? ${dim("[")}${options}${dim("]")} `);
      if (answer === null) return "deny";
      const a = answer.trim().toLowerCase();
      if (a === "y" || a === "yes") return "approve";
      if (a === "n" || a === "no" || a === "") return "deny";
      if ((a === "a" || a === "always") && risk.sessionApprovable) return "approve_session";
    }
  }

  async confirm(prompt: string): Promise<boolean> {
    const answer = await this.prompt(`${prompt} ${dim("[")}${bold("y")}es / ${bold("n")}o${dim("]")} `);
    return answer !== null && /^y(es)?$/i.test(answer.trim());
  }

  /** Resolves null if the run is aborted (Ctrl+C) while waiting for an answer. */
  prompt(prompt: string): Promise<string | null> {
    const signal = this.signal();
    if (signal?.aborted || this.closed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const finish = (answer: string | null) => {
        signal?.removeEventListener("abort", onEnd);
        this.rl.off("close", onEnd);
        // A cut-short question leaves its text as readline's prompt; put the normal one back.
        this.rl.setPrompt(this.mainPrompt);
        resolve(answer);
      };
      // Ctrl+C, or input closing (Ctrl+D / end of piped input) while a question is open.
      // Without the close handler the question never resolves and Bun's readline spins at 100% CPU.
      const onEnd = () => {
        output.write("\n");
        finish(null);
      };
      signal?.addEventListener("abort", onEnd, { once: true });
      this.rl.once("close", onEnd);
      // Passing the signal cancels the pending question, so it can't swallow the next line typed.
      this.rl.question(prompt, { signal }, (answer) => finish(answer));
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
