import type { Session } from "../agent/session.ts";
import { formatDue } from "../scheduler/reminders.ts";
import { ApprovalPolicy, type ApprovalRequest, type Decision } from "../security/approvals.ts";
import type { Runtime } from "../runtime.ts";
import { describePermission, formatPermission } from "../skills/permissions.ts";
import { truncate } from "../tools/format.ts";
import { matchChoice, type ChatChannel, type Choice, type IncomingMessage } from "./channel.ts";

const HELP = `Commands:
/new – start a new conversation
/stop – stop what I'm doing
/undo [n] – undo my last n file changes
/history – my recent file changes
/memory – what I remember about you
/inbox – review memories I proposed
/forget <words> – delete matching memories
/reminders – upcoming reminders (/reminders cancel <n>)
/skills – installed skills and their permissions
/status – pause state and today's action budgets
/panic – emergency stop: block all risky actions
/resume – lift /panic`;

/** Commands that make sense while a request is still running. */
const ALWAYS_AVAILABLE = new Set(["stop", "panic", "status", "help"]);

export interface GatewayControls {
  panic(source: string): void;
  resume(): void;
}

interface PendingQuestion {
  choices: Choice[];
  resolve: (choiceId: string | null) => void;
}

/**
 * One chat in a chat app. Runs the agent for each message, sends the reply as whole
 * messages (chat apps can't stream tokens), and asks approvals and memory reviews as
 * questions with buttons. A question that isn't answered in time counts as "no".
 */
export class Conversation {
  private session: Session;
  private policy = new ApprovalPolicy();
  private running: AbortController | null = null;
  private pending: PendingQuestion | null = null;

  constructor(
    private runtime: Runtime,
    private channel: ChatChannel,
    readonly chatId: string,
    private controls: GatewayControls,
    private answerTimeoutMs = 10 * 60_000,
  ) {
    const { sessions } = runtime;
    this.session = runtime.openSession(sessions.latest(channel.name, chatId)?.id ?? sessions.create(channel.name, chatId));
  }

  get busy(): boolean {
    return this.running !== null;
  }

  async handle(message: IncomingMessage): Promise<void> {
    const text = message.text.trim();
    if (this.pending) {
      const choice = message.choice ?? matchChoice(text, this.pending.choices);
      if (choice) return this.answer(choice);
      if (!text.startsWith("/")) {
        return this.reply("Please answer the question above first (tap a button or reply with its number), or send /stop.");
      }
    } else if (message.choice) {
      return; // a button from an old question
    }

    if (text.startsWith("/")) return this.command(text);
    if (this.running) return this.reply("⏳ I'm still working on your last message. Send /stop to cancel it.");
    if (text) await this.run(text);
  }

  /** Cancels the running request and any open question. */
  stop(): boolean {
    if (!this.running) return false;
    this.running.abort();
    this.answer(null);
    return true;
  }

  private reply(text: string): Promise<void> {
    return this.channel.send(this.chatId, text).catch((error) => {
      console.error(`[${this.channel.name}] could not send to ${this.chatId}: ${(error as Error).message}`);
    });
  }

  private answer(choiceId: string | null): void {
    const pending = this.pending;
    this.pending = null;
    pending?.resolve(choiceId);
  }

  private ask(text: string, choices: Choice[]): Promise<string | null> {
    this.answer(null); // close any older question
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending?.resolve !== finish) return;
        this.pending = null;
        resolve(null);
        void this.reply("⌛ No answer, so I took that as a no.");
      }, this.answerTimeoutMs);
      const finish = (choiceId: string | null) => {
        clearTimeout(timer);
        resolve(choiceId);
      };
      this.pending = { choices, resolve: finish };
      this.channel.ask(this.chatId, text, choices).catch((error) => {
        console.error(`[${this.channel.name}] could not ask ${this.chatId}: ${(error as Error).message}`);
        this.answer(null);
      });
    });
  }

  private async approve(request: ApprovalRequest): Promise<Decision> {
    const { risk } = request;
    const lines = [`🔐 Allow: ${request.summary}? [${risk.level} risk]`, ...risk.reasons.map((r) => `• ${r}`)];
    if (request.preview) lines.push("", truncate(request.preview, 1200));
    const choices: Choice[] = [
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" },
    ];
    if (risk.sessionApprovable) choices.push({ id: "always", label: "Always" });
    const answer = await this.ask(lines.join("\n"), choices);
    return answer === "yes" ? "approve" : answer === "always" ? "approve_session" : "deny";
  }

  private async run(text: string): Promise<void> {
    const controller = new AbortController();
    this.running = controller;
    const started = Date.now();
    const agent = this.runtime.createAgent({ policy: this.policy, approver: { ask: (r) => this.approve(r) } });

    let buffer = "";
    const flush = async () => {
      const out = buffer.trim();
      buffer = "";
      if (out) await this.reply(out);
    };
    try {
      for await (const event of agent.run(this.session, text, controller.signal)) {
        if (event.type === "text") buffer += event.delta;
        else if (event.type === "tool_start") {
          await flush(); // "Let me check…" should arrive before an approval question
          if (event.risk.level === "blocked") {
            await this.reply(`⛔ Blocked: ${event.summary}\n${event.risk.reasons.map((r) => `• ${r}`).join("\n")}`);
          }
        } else if (event.type === "notice") {
          await flush();
          await this.reply(`⚠ ${event.message}`);
        } else if (event.type === "step_limit") {
          await flush();
          await this.reply(`⚠ I reached the limit of ${event.maxSteps} steps.`);
        }
      }
      await flush();
    } catch (error) {
      await flush();
      if (controller.signal.aborted) await this.reply("⏹ Stopped.");
      else await this.reply(`Something went wrong: ${(error as Error).message}`);
    } finally {
      this.running = null;
    }
    await this.reviewInbox(started);
  }

  /** I-5: memories proposed since `since` are confirmed here, one question each. */
  private async reviewInbox(since: number): Promise<void> {
    for (const proposal of this.runtime.inbox.pending(since)) {
      const lines = [`📥 Remember this?\n"${proposal.fact}"${proposal.expires ? ` (until ${proposal.expires})` : ""}`];
      if (proposal.untrustedSources.length) {
        lines.push(`⚠ Proposed after reading ${proposal.untrustedSources.join(", ")}. If you didn't say this, it may be a prompt injection.`);
      }
      const answer = await this.ask(lines.join("\n"), [
        { id: "keep", label: "Keep" },
        { id: "discard", label: "Discard" },
        { id: "later", label: "Later" },
      ]);
      if (answer === "keep") {
        this.runtime.inbox.accept(proposal.id);
        await this.reply("✔ Saved to memory.");
      } else if (answer === "discard") {
        this.runtime.inbox.reject(proposal.id);
        await this.reply("✖ Discarded.");
      }
    }
  }

  private async command(text: string): Promise<void> {
    const [raw = "", ...rest] = text.slice(1).split(/\s+/);
    const command = raw.toLowerCase().replace(/@.*$/, ""); // Telegram group style: /help@MiniClawBot
    const arg = rest.join(" ").trim();
    const { runtime } = this;

    if (this.running && !ALWAYS_AVAILABLE.has(command)) {
      return this.reply("⏳ I'm still working. Send /stop first, or wait for me to finish.");
    }

    switch (command) {
      case "start":
      case "help":
        return this.reply(`👋 I'm ${runtime.config.agent.name}, your personal assistant.\n\n${HELP}`);
      case "new":
        this.session = runtime.openSession(runtime.sessions.create(this.channel.name, this.chatId));
        this.policy.reset();
        return this.reply("Started a new conversation.");
      case "stop":
        return this.reply(this.stop() ? "Stopping…" : "Nothing is running.");
      case "panic":
        this.controls.panic(`${this.channel.name} chat ${this.chatId}`);
        return this.reply("⛔ Paused. All running work was stopped and risky actions are blocked until /resume.");
      case "resume":
        this.controls.resume();
        return this.reply("▶ Resumed.");
      case "status": {
        const lines = [runtime.guard.pausedInfo() ? `⛔ ${runtime.guard.pausedInfo()}` : "▶ Running"];
        for (const u of runtime.guard.usage()) lines.push(`${u.tool}: ${u.used}/${u.limit} today`);
        lines.push(`${runtime.reminders.pending().length} upcoming reminders, ${runtime.inbox.pending().length} memories to review`);
        return this.reply(lines.join("\n"));
      }
      case "undo": {
        const n = arg ? Number(arg) : 1;
        if (!Number.isInteger(n) || n < 1) return this.reply("Usage: /undo [n]");
        const result = await runtime.checkpoints.undo(n);
        if (!result) return this.reply("Nothing to undo.");
        return this.reply(result.undone.map((c) => `↶ Undone: ${c.summary}`).join("\n"));
      }
      case "history": {
        const history = await runtime.checkpoints.history(10);
        if (history.length === 0) return this.reply("No file changes yet.");
        return this.reply(history.map((c, i) => `${i + 1}. ${c.summary} (${c.when})`).join("\n") + "\n\n/undo n undoes the latest n.");
      }
      case "memory": {
        const facts = runtime.facts.all();
        const lines = facts.length ? facts.map((f, i) => `${i + 1}. ${f.text}${f.expires ? ` (until ${f.expires})` : ""}`) : ["I don't remember anything about you yet."];
        const waiting = runtime.inbox.pending().length;
        if (waiting) lines.push(`\n📥 ${waiting} waiting for review: /inbox`);
        return this.reply(lines.join("\n"));
      }
      case "inbox":
        if (runtime.inbox.pending().length === 0) return this.reply("No memories waiting for review.");
        return this.reviewInbox(0);
      case "forget": {
        if (!arg) return this.reply("Usage: /forget <words>, e.g. /forget goa");
        const matches = runtime.facts.search(arg);
        if (matches.length === 0) return this.reply(`Nothing I remember matches "${arg}".`);
        const answer = await this.ask(`Forget ${matches.length === 1 ? "this" : "these"}?\n${matches.map((f) => `− ${f.text}`).join("\n")}`, [
          { id: "yes", label: "Yes" },
          { id: "no", label: "No" },
        ]);
        if (answer !== "yes") return this.reply("Kept.");
        runtime.facts.remove(matches.map((f) => f.id));
        return this.reply("Forgotten.");
      }
      case "reminders": {
        const [sub, id] = arg.split(/\s+/);
        if (sub === "cancel") {
          const cancelled = runtime.reminders.cancel(Number(id));
          return this.reply(cancelled ? `Cancelled #${cancelled.id}: ${cancelled.text}` : `No upcoming reminder #${id}.`);
        }
        const pending = runtime.reminders.pending();
        if (pending.length === 0) return this.reply("No upcoming reminders.");
        return this.reply(pending.map((r) => `#${r.id} ${formatDue(r.dueAt)}${r.repeat ? ` (${r.repeat})` : ""}: ${r.text}`).join("\n"));
      }
      case "skills": {
        if (runtime.skills.length === 0) return this.reply("No skills installed.");
        const lines = runtime.skills.map((s) => {
          const perms = s.permissions.map((p) => `${formatPermission(p)} (${describePermission(p)})`).join(", ") || "no permissions";
          return `• ${s.name}${runtime.grants.isGranted(s) ? "" : " (asks on first use)"}: ${s.description}\n  ${perms}`;
        });
        return this.reply(lines.join("\n"));
      }
      default:
        return this.reply(`Unknown command /${command}. Send /help for the list.`);
    }
  }
}
