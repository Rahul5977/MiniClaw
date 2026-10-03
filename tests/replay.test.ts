import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { replayRun } from "../src/recorder/replay.ts";
import { ApprovalPolicy } from "../src/security/approvals.ts";
import { ScriptedLLM, testRuntime, type Step } from "./helpers/fakes.ts";

const read = { name: "read_file", arguments: '{"path":"notes.txt"}' };
const write = { name: "write_file", arguments: '{"path":"summary.md","content":"short"}' };

/** Records a real run: read notes.txt, write summary.md, answer. */
async function recordedRun() {
  const llm = new ScriptedLLM([{ calls: [read] }, { calls: [write] }, { text: "Summary saved." }]);
  const { runtime } = await testRuntime(llm);
  await Bun.write(join(runtime.workspace, "notes.txt"), "MiniClaw notes");
  const agent = runtime.createAgent({ policy: new ApprovalPolicy(), approver: { ask: async () => "approve" } });
  for await (const _ of agent.run(runtime.openSession(runtime.sessions.create("cli")), "summarize notes.txt", new AbortController().signal));
  const run = runtime.runs.get(runtime.runs.list(1)[0]!.id)!;
  return { runtime, run };
}

test("a model making the same calls gets recorded results and matches", async () => {
  const { run } = await recordedRun();
  const other = new ScriptedLLM([
    { calls: [{ name: "read_file", arguments: '{ "path" : "notes.txt" }' }] }, // same args, different formatting
    { calls: [write] },
    { text: "Done!" },
  ]);
  const result = await replayRun(run, other);
  expect(result).toMatchObject({ outcome: "matched", finalText: "Done!", recordedFinalText: "Summary saved.", unusedRecordedCalls: [] });
  // It received the recorded file content, without reading the file.
  expect(other.seen[1]?.at(-1)?.content).toContain("MiniClaw notes");
});

test("replay never executes tools; an unrecorded call diverges", async () => {
  const { runtime, run } = await recordedRun();
  const other = new ScriptedLLM([{ calls: [{ name: "write_file", arguments: '{"path":"evil.md","content":"x"}' }] }]);
  const result = await replayRun(run, other);
  expect(result.outcome).toBe("diverged");
  expect(result.steps[0]?.calls).toEqual([{ name: "write_file", arguments: '{"path":"evil.md","content":"x"}', match: "none" }]);
  expect(existsSync(join(runtime.workspace, "evil.md"))).toBe(false);
});

test("answering without some recorded calls is reported as fewer_calls", async () => {
  const { run } = await recordedRun();
  const result = await replayRun(run, new ScriptedLLM([{ calls: [read] }, { text: "Here is a summary." }]));
  expect(result.outcome).toBe("fewer_calls");
  expect(result.unusedRecordedCalls).toEqual([{ name: "write_file", arguments: write.arguments }]);
});

test("the model starts from the recorded context", async () => {
  const { run } = await recordedRun();
  const other = new ScriptedLLM([{ text: "hi" } as Step]);
  await replayRun(run, other);
  expect(other.seen[0]).toEqual(run.context);
});

test("same tool on the same target with different content is matched_targets", async () => {
  const { run } = await recordedRun();
  const other = new ScriptedLLM([
    { calls: [read] },
    { calls: [{ name: "write_file", arguments: '{"path":"./summary.md","content":"different words"}' }] },
    { text: "ok" },
  ]);
  const result = await replayRun(run, other);
  expect(result.outcome).toBe("matched_targets");
  expect(result.steps.map((s) => s.calls.map((c) => c.match))).toEqual([["exact"], ["target"], []]);
});
