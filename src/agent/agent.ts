import type { LLMProvider, ToolCall } from "../llm/provider.ts";
import type { ApprovalPolicy, Approver, Verdict } from "../security/approvals.ts";
import type { AuditLog } from "../security/audit.ts";
import type { Guard } from "../security/guard.ts";
import { applyTaint, TaintTracker } from "../security/taint.ts";
import type { Risk, ToolContext, ToolRegistry } from "../tools/tool.ts";
import type { DailyNotes } from "../memory/notes.ts";
import type { RunStatus, RunStore, RunTrace } from "../recorder/runs.ts";
import { maxLevel } from "../security/risk.ts";
import { permits, type Permission } from "../skills/permissions.ts";
import type { Checkpoints } from "../workspace/checkpoints.ts";
import { truncate } from "../tools/format.ts";
import type { Session, TurnMessage } from "./session.ts";
import { messagesTokens, toolSchemaTokens } from "./tokens.ts";

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "tool_start"; callId: string; tool: string; summary: string; risk: Risk }
  | {
      type: "tool_end";
      callId: string;
      tool: string;
      verdict: Verdict | "invalid";
      ok: boolean;
      output: string;
      /** Files changed by this call, e.g. ["M\tnotes.md"] (empty if none). */
      changes: string[];
    }
  | { type: "step_limit"; maxSteps: number }
  /** Something the user should know about the model's behavior, e.g. an unbacked claim. */
  | { type: "notice"; message: string };

export interface AgentDeps {
  llm: LLMProvider;
  tools: ToolRegistry;
  policy: ApprovalPolicy;
  approver: Approver;
  audit: AuditLog;
  checkpoints: Checkpoints;
  workspace: string;
  maxSteps: number;
  /** I-8: flight recorder; when set, every run is saved as a replayable trace. */
  runs?: RunStore;
  /** I-3: flag calls that reuse text from web pages or files (default on). */
  taintTracking?: boolean;
  /** I-9: panic lock and daily budgets, checked before any approval. */
  guard?: Guard;
  /** Optional daily log: one line per turn with the request and the actions taken. */
  notes?: DailyNotes;
  /** The model's context window and the part of it kept free for the reply. */
  contextTokens: number;
  replyTokens: number;
}

const STOPPED = "(stopped by the user)";

const NUDGE = (tools: string[]) =>
  "(Note from MiniClaw, not the user: your last reply did not answer the user or call a tool. " +
  `Call the tool you need now — the exact names are: ${tools.join(", ")} — or give your final answer.)`;

const CLAIM_NUDGE =
  "(Note from MiniClaw, not the user: you said you did something, but you did not call any tool, so nothing happened. " +
  "Call the tool now to actually do it, or tell the user it was not done.)";

/** Claims a completed change: "Added to today's journal.", "I've saved the file". */
const CLAIMS_ACTION =
  /(^|[.!?\n]\s*)(added|saved|written|appended|stored|recorded) (it |this |that |the entry |them )?(to|in|into)\b|\bI('ve| have)? (just )?(added|saved|written|wrote|created|updated|deleted|removed|appended|stored|recorded)\b|\bhas been (added|saved|written|created|updated|deleted|appended|recorded)\b/i;

/** Ends by promising an action: "Let's do that now.", "I'll fetch the forecast." */
const ANNOUNCES_ACTION =
  /(let'?s (do|proceed with|get started on|go ahead with) (that|it|this)( now)?|I('ll| will) (now )?(fetch|get|check|call|run|look up|retrieve|search|read|download|write|create|do)\b[^.!?\n]*)[.!…]*\s*$/i;

/**
 * The agent loop (ReAct style): ask the model → run any tools it asks for →
 * feed results back → repeat until it answers in plain text or hits maxSteps.
 */
export class Agent {
  constructor(private deps: AgentDeps) {}

  async *run(session: Session, userText: string, signal: AbortSignal): AsyncGenerator<AgentEvent> {
    const { llm, tools, maxSteps, contextTokens, replyTokens } = this.deps;
    const schemas = tools.schemas();
    const budget = contextTokens - replyTokens - toolSchemaTokens(schemas);
    const turn: TurnMessage[] = [{ role: "user", content: userText }];
    // Where untrusted content entered this turn; tools like remember record it (I-5, I-3).
    const untrusted = new Set<string>();
    const actions: string[] = [];
    const activeSkills = new Map<string, Permission[]>();
    // Messages up to this index form a valid conversation (no tool call without its result).
    let consistent = 1;
    let finished = false;
    let status: RunStatus = "done";
    let failure: string | undefined;
    const startContext = session.context(turn, budget);
    const trace = this.deps.runs?.begin({ sessionId: session.id, model: llm.model, userText, context: startContext, tools: schemas });
    const taint = this.deps.taintTracking === false ? undefined : new TaintTracker(userText);
    taint?.addHistory(startContext);

    try {
      let nudged = false;
      let announced = false;
      let challenged = false;
      // Did anything that changes state (files, memory) actually succeed in this turn?
      let changedSomething = false;
      for (let step = 0; step < maxSteps; step++) {
        let text = "";
        let calls: ToolCall[] = [];
        const context = session.context(turn, budget);
        // One-off hint after an empty reply; never saved to the conversation.
        let hint: string | undefined;
        if (nudged) {
          hint = challenged && !announced ? CLAIM_NUDGE : NUDGE(tools.list().map((t) => t.name));
          context.push({ role: "user", content: hint });
        }
        const stepStarted = performance.now();
        for await (const event of llm.stream(context, { tools: schemas, signal })) {
          if (event.type === "text") {
            text += event.delta;
            yield event;
          } else {
            calls = event.calls;
          }
        }
        trace?.llm({
          step,
          promptTokens: messagesTokens(context) + toolSchemaTokens(schemas),
          durationMs: Math.round(performance.now() - stepStarted),
          text,
          toolCalls: calls.map((c) => ({ name: c.name, arguments: c.arguments })),
          ...(hint && { nudge: hint }),
        });

        // Ollama silently drops calls to tools that don't exist, which looks like an
        // empty reply. Retry once with a hint instead of showing the user nothing.
        if (calls.length === 0 && !text.trim() && !nudged) {
          nudged = true;
          step--;
          continue;
        }
        // Small models often announce an action ("Let's do that now.") and then stop.
        // After a tool has run in this turn, give them one nudge to actually do it.
        if (calls.length === 0 && !announced && turn.length > 1 && ANNOUNCES_ACTION.test(text)) {
          announced = true;
          nudged = true;
          yield { type: "text", delta: "\n" };
          continue;
        }
        // Verified actions: a reply claiming "Added/Saved/Created…" when no state-changing
        // tool succeeded in this turn is false. Say so, and ask once for the real call.
        if (calls.length === 0 && !changedSomething && CLAIMS_ACTION.test(text)) {
          if (!challenged) {
            challenged = true;
            nudged = true;
            const message = "The model said it did something, but no tool was called, so nothing happened yet. Asking it to actually do it…";
            trace?.notice(message);
            yield { type: "notice", message };
            continue;
          }
          const message = "No tool was called, so nothing was actually saved or changed.";
          trace?.notice(message);
          yield { type: "notice", message };
        }
        nudged = false;

        if (calls.length === 0) {
          if (!text.trim()) {
            text = "Sorry, I couldn't produce an answer to that. Could you rephrase it?";
            yield { type: "text", delta: text };
          }
          turn.push({ role: "assistant", content: text });
          consistent = turn.length;
          finished = true;
          return;
        }

        turn.push({ role: "assistant", content: text, toolCalls: calls });
        for (const call of calls) {
          signal.throwIfAborted();
          const ctx = { workspace: this.deps.workspace, signal, sessionId: session.id, untrustedSources: untrusted, activeSkills, trace, step, taint };
          const { output, done, changed } = yield* this.execute(call, ctx);
          if (changed) changedSomething = true;
          for (const match of output.matchAll(/<untrusted source="([^"]+)">/g)) untrusted.add(match[1]!);
          taint?.addOutput(output);
          if (done) actions.push(done);
          // One tool result may use at most ~30% of the window, whatever the tool's own cap.
          turn.push({ role: "tool", toolCallId: call.id, content: truncate(output, Math.floor(contextTokens * 0.3 * 3.5)) });
        }
        consistent = turn.length;
      }

      const note = `I stopped after ${maxSteps} steps without finishing. Tell me how you'd like to continue.`;
      yield { type: "step_limit", maxSteps };
      turn.push({ role: "assistant", content: note });
      consistent = turn.length;
      finished = true;
      status = "step_limit";
    } catch (error) {
      status = signal.aborted ? "stopped" : "error";
      failure = (error as Error).message;
      throw error;
    } finally {
      if (!finished && status === "done") status = "stopped"; // e.g. the caller stopped iterating
      trace?.finish(status, failure);
      // Always leave the session valid, even after Ctrl+C or an error mid-step.
      const kept = turn.slice(0, consistent);
      if (!finished) kept.push({ role: "assistant", content: STOPPED });
      session.addTurn(kept);
      const request = userText.length > 120 ? `${userText.slice(0, 120)}…` : userText;
      this.deps.notes?.append(`"${request}"${actions.length ? ` → ${actions.join("; ")}` : ""}${finished ? "" : " (stopped)"}`);
    }
  }

  private async *execute(
    call: ToolCall,
    ctx: ToolContext & { signal: AbortSignal; sessionId: string; trace?: RunTrace; step: number; taint?: TaintTracker },
  ): AsyncGenerator<AgentEvent, { output: string; done?: string; changed?: boolean }> {
    const { tools, policy, approver, audit, checkpoints } = this.deps;
    const { signal, sessionId } = ctx;

    const parsed = tools.parse(call.name, call.arguments);
    if (!parsed.ok) {
      // Tell the model what was wrong so it can fix the call on the next step.
      const output = `Error: ${parsed.error}`;
      ctx.trace?.tool({ step: ctx.step, name: call.name, arguments: call.arguments, verdict: "invalid", ok: false, durationMs: 0, output });
      yield { type: "tool_end", callId: call.id, tool: call.name, verdict: "invalid", ok: false, output, changes: [] };
      return { output };
    }
    const { tool, args } = parsed;
    const summary = tool.summarize(args);

    let risk: Risk;
    try {
      risk = await tool.assess(args, ctx);
    } catch (error) {
      // e.g. SandboxError: path outside the workspace.
      risk = { level: "blocked", reasons: [(error as Error).message], scope: `${tool.name}:?`, sessionApprovable: false };
    }
    risk = enforceSkillPermissions(tool.name, risk, ctx.activeSkills);
    if (ctx.taint) risk = applyTaint(risk, ctx.taint.find(tool.name, args));
    if (this.deps.guard) risk = this.deps.guard.check(tool.name, risk);
    yield { type: "tool_start", callId: call.id, tool: tool.name, summary, risk };

    const preview = risk.level === "medium" || risk.level === "high" ? await tool.preview?.(args, ctx) : undefined;
    const verdict = await policy.authorize({ tool: tool.name, summary, risk, preview }, approver);
    signal.throwIfAborted(); // Ctrl+C during the approval prompt must not run the tool.
    const auditId = audit.nextId();
    const started = performance.now();
    let output: string;
    let ok = false;
    let changes: string[] = [];

    if (verdict === "blocked") {
      output = `Blocked by MiniClaw's safety rules: this ${risk.reasons.join("; ")}. Do not retry. Explain to the user.`;
    } else if (verdict === "denied") {
      output = "The user denied this action. Do not retry it. Ask the user what they would like instead.";
    } else {
      if (tool.changesWorkspace) await checkpoints.before();
      try {
        output = await tool.run(args, ctx);
        ok = true;
      } catch (error) {
        output = signal.aborted ? "Stopped by the user." : `Error: ${(error as Error).message}`;
      }
      if (tool.changesWorkspace) changes = await checkpoints.after(summary, auditId);
    }

    audit.record({
      id: auditId,
      session: sessionId,
      tool: tool.name,
      summary,
      args,
      risk: risk.level,
      reasons: risk.reasons,
      verdict,
      ok,
      durationMs: Math.round(performance.now() - started),
      result: output,
    });
    ctx.trace?.tool({
      step: ctx.step,
      name: tool.name,
      arguments: call.arguments,
      summary,
      risk: risk.level,
      reasons: risk.reasons,
      verdict,
      ok,
      durationMs: Math.round(performance.now() - started),
      output,
      changes,
    });
    yield { type: "tool_end", callId: call.id, tool: tool.name, verdict, ok, output, changes };
    // `done` is the one-line summary of a successful action, for the daily notes.
    return { output, done: ok ? summary : undefined, changed: ok && (tool.changesWorkspace || tool.name === "remember") };
  }
}

/**
 * I-6: while skills are active, a call none of them declared is escalated to high
 * risk (always asks, with the reason). Permissions never lower a call's risk.
 */
export function enforceSkillPermissions(tool: string, risk: Risk, active?: ReadonlyMap<string, Permission[]>): Risk {
  if (!active?.size) return risk;
  for (const permissions of active.values()) if (permits(permissions, tool, risk.scope)) return risk;
  const names = [...active.keys()].map((n) => `"${n}"`).join(", ");
  return {
    ...risk,
    level: maxLevel(risk.level, "high"),
    reasons: [...risk.reasons, `is outside what the active skill ${names} declared it needs`],
    sessionApprovable: false,
  };
}
