import type { Database } from "bun:sqlite";
import type { ChatMessage, ToolSchema } from "../llm/provider.ts";
import { redact } from "../security/audit.ts";

export type RunStatus = "running" | "done" | "stopped" | "error" | "step_limit";

export interface LlmEvent {
  step: number;
  promptTokens: number;
  durationMs: number;
  text: string;
  toolCalls: { name: string; arguments: string }[];
  /** Set when MiniClaw added a one-off hint before this step (empty reply, unfinished action…). */
  nudge?: string;
}

export interface ToolEvent {
  step: number;
  name: string;
  arguments: string;
  summary?: string;
  risk?: string;
  reasons?: string[];
  verdict: string;
  ok: boolean;
  durationMs: number;
  output: string;
  changes?: string[];
}

export type RunEvent =
  | { at: number; type: "llm"; data: LlmEvent }
  | { at: number; type: "tool"; data: ToolEvent }
  | { at: number; type: "notice"; data: { message: string } };

export interface RunSummary {
  id: string;
  sessionId: string;
  model: string;
  userText: string;
  status: RunStatus;
  steps: number;
  toolCalls: number;
  promptTokens: number;
  error: string | null;
  startedAt: number;
  endedAt: number | null;
}

export interface RunDetail extends RunSummary {
  context: ChatMessage[];
  tools: ToolSchema[];
  events: RunEvent[];
}

const MAX_OUTPUT = 2000;

/** One run being recorded. All writes are best-effort: recording must never break the agent. */
export class RunTrace {
  private started = Date.now();
  private steps = 0;
  private toolCalls = 0;
  private promptTokens = 0;

  constructor(
    private db: Database,
    readonly id: string,
  ) {}

  private add(type: RunEvent["type"], data: unknown): void {
    try {
      this.db
        .query("INSERT INTO run_events (run_id, at, type, data) VALUES (?, ?, ?, ?)")
        .run(this.id, Date.now() - this.started, type, redact(JSON.stringify(data)));
    } catch (error) {
      console.error(`[recorder] ${(error as Error).message}`);
    }
  }

  llm(event: LlmEvent): void {
    this.steps++;
    this.promptTokens += event.promptTokens;
    this.add("llm", event);
  }

  tool(event: ToolEvent): void {
    this.toolCalls++;
    this.add("tool", { ...event, output: event.output.slice(0, MAX_OUTPUT) });
  }

  notice(message: string): void {
    this.add("notice", { message });
  }

  finish(status: RunStatus, error?: string): void {
    try {
      this.db
        .query("UPDATE runs SET status = ?, steps = ?, tool_calls = ?, prompt_tokens = ?, error = ?, ended_at = ? WHERE id = ?")
        .run(status, this.steps, this.toolCalls, this.promptTokens, error ? redact(error) : null, Date.now(), this.id);
    } catch (e) {
      console.error(`[recorder] ${(e as Error).message}`);
    }
  }
}

interface RunRow {
  id: string;
  session_id: string;
  model: string;
  user_text: string;
  context: string;
  tools: string;
  status: RunStatus;
  steps: number;
  tool_calls: number;
  prompt_tokens: number;
  error: string | null;
  started_at: number;
  ended_at: number | null;
}

function summary(row: RunRow): RunSummary {
  return {
    id: row.id,
    sessionId: row.session_id,
    model: row.model,
    userText: row.user_text,
    status: row.status,
    steps: row.steps,
    toolCalls: row.tool_calls,
    promptTokens: row.prompt_tokens,
    error: row.error,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

/** I-8: the flight recorder's storage. */
export class RunStore {
  constructor(private db: Database) {}

  begin(input: { sessionId: string; model: string; userText: string; context: ChatMessage[]; tools: ToolSchema[] }): RunTrace {
    const id = `run_${Date.now().toString(36)}${crypto.randomUUID().slice(0, 4)}`;
    this.db
      .query("INSERT INTO runs (id, session_id, model, user_text, context, tools, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, input.sessionId, input.model, redact(input.userText), redact(JSON.stringify(input.context)), JSON.stringify(input.tools), Date.now());
    return new RunTrace(this.db, id);
  }

  list(limit = 50, before?: number): RunSummary[] {
    return this.db
      .query<RunRow, [number, number]>("SELECT * FROM runs WHERE started_at < ? ORDER BY started_at DESC, rowid DESC LIMIT ?")
      .all(before ?? Number.MAX_SAFE_INTEGER, limit)
      .map(summary);
  }

  get(id: string): RunDetail | null {
    const row = this.db.query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?").get(id);
    if (!row) return null;
    const events = this.db
      .query<{ at: number; type: RunEvent["type"]; data: string }, [string]>("SELECT at, type, data FROM run_events WHERE run_id = ? ORDER BY id")
      .all(id)
      .map((e) => ({ at: e.at, type: e.type, data: JSON.parse(e.data) }) as RunEvent);
    return { ...summary(row), context: JSON.parse(row.context), tools: JSON.parse(row.tools), events };
  }
}
