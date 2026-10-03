import type { ChatMessage, LLMProvider } from "../llm/provider.ts";
import type { RunDetail, ToolEvent } from "./runs.ts";

/** exact: same tool and arguments; target: same tool and target (path/url/command), other arguments differ. */
export type MatchLevel = "exact" | "target" | "none";

export interface ReplayCall {
  name: string;
  arguments: string;
  match: MatchLevel;
}

export interface ReplayStep {
  text: string;
  calls: ReplayCall[];
  durationMs: number;
}

export type ReplayOutcome =
  /** Same tool calls as the recording (order may differ). */
  | "matched"
  /** Same tools on the same targets, but some arguments (e.g. file content) differ. */
  | "matched_targets"
  /** Every call matched, but it skipped some recorded calls. */
  | "fewer_calls"
  /** It made a call the recording didn't; replay stops there, since the result is unknown. */
  | "diverged"
  | "step_limit";

export interface ReplayResult {
  runId: string;
  recordedModel: string;
  model: string;
  outcome: ReplayOutcome;
  steps: ReplayStep[];
  finalText: string;
  recordedFinalText: string;
  recordedCalls: { name: string; arguments: string }[];
  unusedRecordedCalls: { name: string; arguments: string }[];
  durationMs: number;
}

/** Compares JSON arguments regardless of key order and whitespace. */
function canonical(json: string): string {
  try {
    const sort = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).sort().map(([k, x]) => [k, sort(x)])) : v;
    return JSON.stringify(sort(JSON.parse(json || "{}")));
  } catch {
    return json.trim();
  }
}

/** The argument that says what a call acts on. */
const TARGET_KEYS = ["path", "url", "command", "id", "date"];

function target(json: string): string | undefined {
  try {
    const args = JSON.parse(json || "{}") as Record<string, unknown>;
    const key = TARGET_KEYS.find((k) => args[k] !== undefined);
    return key ? `${key}=${String(args[key]).replace(/^\.\//, "")}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * I-8: re-runs a recorded situation with another model, without side effects.
 * The model gets the run's original context and tools. When it calls a tool the
 * recording also called (same arguments), it receives the recorded result; nothing is
 * executed. A call the recording never made ends the replay as "diverged".
 * MiniClaw's nudges are not applied, so this compares the models' raw behavior.
 */
export async function replayRun(run: RunDetail, llm: LLMProvider, options: { maxSteps?: number; signal?: AbortSignal } = {}): Promise<ReplayResult> {
  const started = performance.now();
  const recorded = run.events.filter((e): e is { at: number; type: "tool"; data: ToolEvent } => e.type === "tool").map((e) => e.data);
  const recordedLlm = run.events.filter((e) => e.type === "llm");
  const recordedFinalText = recordedLlm.length ? String((recordedLlm.at(-1)!.data as { text: string }).text) : "";
  const unused = [...recorded];
  const messages: ChatMessage[] = structuredClone(run.context);
  const steps: ReplayStep[] = [];
  const maxSteps = options.maxSteps ?? Math.max(run.steps + 2, 4);
  let outcome: ReplayOutcome = "step_limit";
  let finalText = "";

  replay: for (let step = 0; step < maxSteps; step++) {
    const stepStarted = performance.now();
    const response = await llm.chat(messages, { tools: run.tools, signal: options.signal });
    const calls: ReplayCall[] = [];
    steps.push({ text: response.text, calls, durationMs: Math.round(performance.now() - stepStarted) });

    if (response.toolCalls.length === 0) {
      finalText = response.text;
      const allExact = steps.every((s) => s.calls.every((c) => c.match === "exact"));
      outcome = unused.length > 0 ? "fewer_calls" : allExact ? "matched" : "matched_targets";
      break;
    }
    messages.push({ role: "assistant", content: response.text, toolCalls: response.toolCalls });
    for (const call of response.toolCalls) {
      let index = unused.findIndex((r) => r.name === call.name && canonical(r.arguments) === canonical(call.arguments));
      let match: MatchLevel = index >= 0 ? "exact" : "none";
      if (index < 0) {
        const wanted = target(call.arguments);
        index = wanted === undefined ? -1 : unused.findIndex((r) => r.name === call.name && target(r.arguments) === wanted);
        if (index >= 0) match = "target";
      }
      calls.push({ name: call.name, arguments: call.arguments, match });
      if (index < 0) {
        outcome = "diverged";
        break replay;
      }
      const [recordedCall] = unused.splice(index, 1);
      messages.push({ role: "tool", toolCallId: call.id, content: recordedCall!.output });
    }
  }

  return {
    runId: run.id,
    recordedModel: run.model,
    model: llm.model,
    outcome,
    steps,
    finalText,
    recordedFinalText,
    recordedCalls: recorded.map((r) => ({ name: r.name, arguments: r.arguments })),
    unusedRecordedCalls: unused.map((r) => ({ name: r.name, arguments: r.arguments })),
    durationMs: Math.round(performance.now() - started),
  };
}
