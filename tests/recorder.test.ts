import { expect, test } from "bun:test";
import { ApprovalPolicy } from "../src/security/approvals.ts";
import { ScriptedLLM, testRuntime, type Step } from "./helpers/fakes.ts";

async function runOnce(steps: Step[], text: string, options: { abortAfterMs?: number; answer?: "approve" | "deny"; maxSteps?: number } = {}) {
  const llm = new ScriptedLLM(steps);
  const { runtime } = await testRuntime(llm, options.maxSteps ? { agent: { maxSteps: options.maxSteps } } : {});
  const agent = runtime.createAgent({ policy: new ApprovalPolicy(), approver: { ask: async () => options.answer ?? "approve" } });
  const session = runtime.openSession(runtime.sessions.create("cli"));
  const controller = new AbortController();
  if (options.abortAfterMs) setTimeout(() => controller.abort(), options.abortAfterMs);
  try {
    for await (const _ of agent.run(session, text, controller.signal));
  } catch {}
  const [summary] = runtime.runs.list(1);
  return { runtime, run: runtime.runs.get(summary!.id)! };
}

const write = { name: "write_file", arguments: '{"path":"a.md","content":"hi"}' };

test("a run is recorded with its context, model steps and tool calls", async () => {
  const { run } = await runOnce([{ calls: [write] }, { text: "Saved." }], "save hi");
  expect(run).toMatchObject({ userText: "save hi", model: "scripted", status: "done", steps: 2, toolCalls: 1 });
  expect(run.context.at(-1)).toEqual({ role: "user", content: "save hi" });
  expect(run.tools.map((t) => t.name)).toContain("write_file");
  expect(run.events.map((e) => e.type)).toEqual(["llm", "tool", "llm"]);
  expect(run.events[1]).toMatchObject({
    type: "tool",
    data: { name: "write_file", risk: "medium", verdict: "approved", ok: true, changes: ["A\ta.md"], output: expect.stringContaining("Wrote 2") },
  });
  expect(run.events[2]).toMatchObject({ type: "llm", data: { step: 1, text: "Saved.", toolCalls: [] } });
  expect(run.promptTokens).toBeGreaterThan(0);
  expect(run.endedAt).toBeGreaterThanOrEqual(run.startedAt);
});

test("nudges, notices and denials are visible in the trace", async () => {
  const { run } = await runOnce([{ text: "" }, { text: "Added it to your journal." }, { text: "Added it to your journal." }], "add", { answer: "deny" });
  const llmEvents = run.events.filter((e) => e.type === "llm");
  expect(llmEvents[1]?.data).toMatchObject({ nudge: expect.stringContaining("did not answer the user or call a tool") });
  expect(run.events.some((e) => e.type === "notice")).toBe(true);
});

test("stopped, step-limit and error runs get the right status", async () => {
  const loop = { calls: [{ name: "read_file", arguments: '{"path":"x"}' }] };
  expect((await runOnce([loop, loop, loop], "loop", { maxSteps: 2 })).run.status).toBe("step_limit");

  let release!: () => void;
  const slow = new Promise<void>((r) => (release = r));
  setTimeout(() => release(), 100);
  expect((await runOnce([{ wait: slow, text: "late" }], "slow", { abortAfterMs: 20 })).run.status).toBe("stopped");

  const broken = { model: "broken", async *stream(): AsyncIterable<never> { throw new Error("model crashed"); }, chat: async () => ({ text: "", toolCalls: [] }) };
  const { runtime } = await testRuntime(broken);
  const agent = runtime.createAgent({ policy: new ApprovalPolicy(), approver: { ask: async () => "deny" } });
  await expect(async () => {
    for await (const _ of agent.run(runtime.openSession(runtime.sessions.create("cli")), "hi", new AbortController().signal));
  }).toThrow("model crashed");
  expect(runtime.runs.list(1)[0]).toMatchObject({ status: "error", error: "model crashed" });
});

test("secrets are redacted in traces", async () => {
  const { run } = await runOnce([{ text: "ok" }], "my key is sk-abcdefghijklmnopqrstuvwx");
  expect(run.userText).toBe("my key is [REDACTED]");
  expect(JSON.stringify(run.context)).not.toContain("sk-abcdefghijklmnop");
});
