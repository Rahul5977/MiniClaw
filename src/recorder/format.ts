import type { ReplayResult } from "./replay.ts";
import type { RunSummary } from "./runs.ts";

const time = (t: number) => new Date(t).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
const short = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function formatRuns(runs: RunSummary[]): string {
  if (runs.length === 0) return "No runs recorded yet.";
  return runs
    .map((r) => {
      const secs = r.endedAt ? `${((r.endedAt - r.startedAt) / 1000).toFixed(1)}s` : "…";
      return `${r.id}  ${time(r.startedAt)}  ${r.status.padEnd(10)} ${String(r.steps).padStart(2)} steps ${String(r.toolCalls).padStart(2)} tools ${secs.padStart(6)}  ${short(r.userText.replace(/\s+/g, " "), 50)}`;
    })
    .join("\n");
}

const OUTCOME: Record<ReplayResult["outcome"], string> = {
  matched: "✔ same actions as the recorded run",
  matched_targets: "≈ same actions on the same targets, with different details (e.g. file content)",
  fewer_calls: "◐ answered with fewer actions than the recorded run",
  diverged: "✖ diverged: made a call the recorded run didn't (stopped there; nothing was executed)",
  step_limit: "! hit the step limit",
};

export function formatReplay(r: ReplayResult): string {
  const call = (c: { name: string; arguments: string }) => `${c.name}(${short(c.arguments, 70)})`;
  const lines = [
    `Replay of ${r.runId}: recorded with ${r.recordedModel}, replayed with ${r.model} (${(r.durationMs / 1000).toFixed(1)}s)`,
    "",
    "Recorded actions:",
    ...(r.recordedCalls.length ? r.recordedCalls.map((c, i) => `  ${i + 1}. ${call(c)}`) : ["  (none)"]),
    "",
    "Replay:",
  ];
  r.steps.forEach((step, i) => {
    if (step.calls.length === 0) lines.push(`  step ${i + 1}: answered (${step.durationMs} ms)`);
    const mark = { exact: "✔", target: "≈", none: "✖" } as const;
    for (const c of step.calls) lines.push(`  step ${i + 1}: ${mark[c.match]} ${call(c)}`);
  });
  if (r.unusedRecordedCalls.length) lines.push("", "Recorded actions it skipped:", ...r.unusedRecordedCalls.map((c) => `  − ${call(c)}`));
  lines.push("", `Outcome: ${OUTCOME[r.outcome]}`);
  if (r.finalText || r.recordedFinalText) {
    lines.push("", `Recorded answer: ${short(r.recordedFinalText.replace(/\s+/g, " "), 200)}`, `Replay answer:   ${short(r.finalText.replace(/\s+/g, " "), 200) || "(none)"}`);
  }
  return lines.join("\n");
}

/** Outcome counts over repeated replays: a consistency measure for the evaluation. */
export function formatTally(results: ReplayResult[]): string {
  const counts = new Map<string, number>();
  for (const r of results) counts.set(r.outcome, (counts.get(r.outcome) ?? 0) + 1);
  const avg = results.reduce((sum, r) => sum + r.durationMs, 0) / results.length / 1000;
  const lines = [`${results.length} replays with ${results[0]?.model} (avg ${avg.toFixed(1)}s):`];
  for (const [outcome, n] of [...counts].sort((a, b) => b[1] - a[1])) {
    lines.push(`  ${outcome.padEnd(16)} ${String(n).padStart(3)}  ${Math.round((n / results.length) * 100)}%`);
  }
  return lines.join("\n");
}
