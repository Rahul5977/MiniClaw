import type { LLMProvider, ToolCall } from "../llm/provider.ts";
import type { ApprovalPolicy, Approver, Verdict } from "../security/approvals.ts";
import type { AuditLog } from "../security/audit.ts";
import type { Risk, ToolContext, ToolRegistry } from "../tools/tool.ts";
import type { DailyNotes } from "../memory/notes.ts";
import type { Checkpoints } from "../workspace/checkpoints.ts";
import { truncate } from "../tools/format.ts";
import type { Session, TurnMessage } from "./session.ts";
import { toolSchemaTokens } from "./tokens.ts";

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
  | { type: "step_limit"; maxSteps: number };

export interface AgentDeps {
  llm: LLMProvider;
  tools: ToolRegistry;
  policy: ApprovalPolicy;
  approver: Approver;
  audit: AuditLog;
  checkpoints: Checkpoints;
  workspace: string;
  maxSteps: number;
  /** Optional daily log: one line per turn with the request and the actions taken. */
  notes?: DailyNotes;
  /** The model's context window and the part of it kept free for the reply. */
  contextTokens: number;
  replyTokens: number;
}

const STOPPED = "(stopped by the user)";

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
    // Messages up to this index form a valid conversation (no tool call without its result).
    let consistent = 1;
    let finished = false;

    try {
      for (let step = 0; step < maxSteps; step++) {
        let text = "";
        let calls: ToolCall[] = [];
        for await (const event of llm.stream(session.context(turn, budget), { tools: schemas, signal })) {
          if (event.type === "text") {
            text += event.delta;
            yield event;
          } else {
            calls = event.calls;
          }
        }

        if (calls.length === 0) {
          turn.push({ role: "assistant", content: text });
          consistent = turn.length;
          finished = true;
          return;
        }

        turn.push({ role: "assistant", content: text, toolCalls: calls });
        for (const call of calls) {
          signal.throwIfAborted();
          const ctx = { workspace: this.deps.workspace, signal, sessionId: session.id, untrustedSources: untrusted };
          const { output, done } = yield* this.execute(call, ctx);
          for (const match of output.matchAll(/<untrusted source="([^"]+)">/g)) untrusted.add(match[1]!);
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
    } finally {
      // Always leave the session valid, even after Ctrl+C or an error mid-step.
      const kept = turn.slice(0, consistent);
      if (!finished) kept.push({ role: "assistant", content: STOPPED });
      session.addTurn(kept);
      const request = userText.length > 120 ? `${userText.slice(0, 120)}…` : userText;
      this.deps.notes?.append(`"${request}"${actions.length ? ` → ${actions.join("; ")}` : ""}${finished ? "" : " (stopped)"}`);
    }
  }

  private async *execute(call: ToolCall, ctx: ToolContext & { signal: AbortSignal; sessionId: string }): AsyncGenerator<AgentEvent, { output: string; done?: string }> {
    const { tools, policy, approver, audit, checkpoints } = this.deps;
    const { signal, sessionId } = ctx;

    const parsed = tools.parse(call.name, call.arguments);
    if (!parsed.ok) {
      // Tell the model what was wrong so it can fix the call on the next step.
      const output = `Error: ${parsed.error}`;
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
    yield { type: "tool_end", callId: call.id, tool: tool.name, verdict, ok, output, changes };
    // `done` is the one-line summary of a successful action, for the daily notes.
    return { output, done: ok ? summary : undefined };
  }
}
