import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, parseTextToolCall, type AgentEvent } from "../src/agent/agent.ts";
import { Session } from "../src/agent/session.ts";
import type { ChatMessage, ChatOptions, LLMProvider, StreamEvent, ToolCall } from "../src/llm/provider.ts";
import { collect } from "../src/llm/provider.ts";
import { ApprovalPolicy, type Approver, type Decision } from "../src/security/approvals.ts";
import { openDatabase } from "../src/db/database.ts";
import { AuditLog } from "../src/security/audit.ts";
import { prepareWorkspace } from "../src/security/sandbox.ts";
import { readFileTool, writeFileTool } from "../src/tools/files.ts";
import { runShellTool } from "../src/tools/shell.ts";
import { ToolRegistry } from "../src/tools/tool.ts";
import { Checkpoints } from "../src/workspace/checkpoints.ts";

const root = mkdtempSync(join(tmpdir(), "miniclaw-agent-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

type Step = { text?: string; calls?: Omit<ToolCall, "id">[] };

/** Fake LLM that replays scripted steps and records what it was sent. */
class ScriptedLLM implements LLMProvider {
  model = "scripted";
  seen: ChatMessage[][] = [];
  constructor(private steps: Step[]) {}
  async *stream(messages: ChatMessage[], options: ChatOptions = {}): AsyncIterable<StreamEvent> {
    options.signal?.throwIfAborted();
    this.seen.push(structuredClone(messages));
    const step = this.steps.shift() ?? { text: "done" };
    if (step.text) yield { type: "text", delta: step.text };
    if (step.calls) yield { type: "tool_calls", calls: step.calls.map((c, i) => ({ id: `c${this.seen.length}-${i}`, ...c })) };
  }
  chat(messages: ChatMessage[]) {
    return collect(this.stream(messages));
  }
}

async function setup(steps: Step[], answers: Decision[] = [], maxSteps = 5) {
  const dir = mkdtempSync(join(root, "case-"));
  const workspace = prepareWorkspace(join(dir, "ws"));
  const checkpoints = new Checkpoints(join(dir, "data/checkpoints.git"), workspace);
  await checkpoints.init();
  const approver: Approver & { asked: number } = {
    asked: 0,
    async ask() {
      this.asked++;
      return answers.shift() ?? "deny";
    },
  };
  const llm = new ScriptedLLM(steps);
  const audit = new AuditLog(openDatabase(":memory:"));
  const agent = new Agent({
    llm,
    tools: new ToolRegistry([readFileTool, writeFileTool, runShellTool]),
    policy: new ApprovalPolicy(),
    approver,
    audit,
    checkpoints,
    workspace,
    maxSteps,
    contextTokens: 8192,
    replyTokens: 512,
  });
  const session = new Session({ id: "test", systemPrompt: () => "sys" });
  const run = async (text: string, signal = new AbortController().signal) => {
    const events: AgentEvent[] = [];
    for await (const e of agent.run(session, text, signal)) events.push(e);
    return events;
  };
  return { dir, workspace, checkpoints, approver, llm, session, audit, run };
}

const write = (path: string, content: string) => ({
  name: "write_file",
  arguments: JSON.stringify({ path, content }),
});

test("tool call → approval → result fed back → final answer", async () => {
  const t = await setup([{ calls: [write("a.md", "hello")] }, { text: "Saved a.md" }], ["approve"]);
  const events = await t.run("save hello to a.md");

  expect(readFileSync(join(t.workspace, "a.md"), "utf8")).toBe("hello");
  expect(t.approver.asked).toBe(1);
  expect(events.find((e) => e.type === "tool_end")).toMatchObject({ verdict: "approved", ok: true, changes: ["A\ta.md"] });
  expect(t.llm.seen[1]?.at(-1)).toMatchObject({ role: "tool", content: expect.stringContaining("Wrote 5 characters") });
  expect(t.session.context([], 100_000).at(-1)).toEqual({ role: "assistant", content: "Saved a.md" });

  // I-1: the change is checkpointed and can be undone.
  expect((await t.checkpoints.history())[0]?.summary).toBe("write a.md");
  await t.checkpoints.undo();
  expect(existsSync(join(t.workspace, "a.md"))).toBe(false);

  const audit = t.audit.recent();
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ tool: "write_file", verdict: "approved", risk: "medium", ok: true, args: { path: "a.md" } });
});

test("denied actions are not run and the model is told why", async () => {
  const t = await setup([{ calls: [write("a.md", "x")] }, { text: "ok, I won't" }], ["deny"]);
  await t.run("write");
  expect(existsSync(join(t.workspace, "a.md"))).toBe(false);
  expect(t.llm.seen[1]?.at(-1)?.content).toContain("denied");
});

test("blocked commands never reach the approver", async () => {
  const t = await setup([{ calls: [{ name: "run_shell", arguments: '{"command":"sudo rm -rf /"}' }] }, { text: "can't" }]);
  const events = await t.run("wipe");
  expect(t.approver.asked).toBe(0);
  expect(events.find((e) => e.type === "tool_end")).toMatchObject({ verdict: "blocked", ok: false });
});

test("sandbox violations are blocked", async () => {
  const t = await setup([{ calls: [{ name: "read_file", arguments: '{"path":"../../etc/passwd"}' }] }, { text: "no" }]);
  const events = await t.run("read");
  expect(events.find((e) => e.type === "tool_end")).toMatchObject({ verdict: "blocked" });
});

test("malformed arguments come back as an error the model can fix", async () => {
  const t = await setup([{ calls: [{ name: "write_file", arguments: "{path: a.md" }] }, { calls: [write("a.md", "fixed")] }, { text: "done" }], ["approve"]);
  await t.run("write");
  expect(t.llm.seen[1]?.at(-1)?.content).toContain("not valid JSON");
  expect(readFileSync(join(t.workspace, "a.md"), "utf8")).toBe("fixed");
});

test("step limit stops runaway loops and keeps the session valid", async () => {
  const loop = { calls: [{ name: "read_file", arguments: '{"path":"missing.txt"}' }] };
  const t = await setup([loop, loop, loop, loop], [], 2);
  const events = await t.run("loop");
  expect(events.at(-1)).toEqual({ type: "step_limit", maxSteps: 2 });
  const last = t.session.context([], 100_000).at(-1);
  expect(last?.role).toBe("assistant");
  expect(last?.content).toContain("stopped after 2 steps");
});

test("Ctrl+C during approval cancels the tool and keeps the session valid", async () => {
  const controller = new AbortController();
  const t = await setup([{ calls: [write("a.md", "x")] }, { text: "never reached" }]);
  t.approver.ask = async () => {
    controller.abort();
    return "approve";
  };
  await expect(t.run("write a.md", controller.signal)).rejects.toThrow();
  expect(existsSync(join(t.workspace, "a.md"))).toBe(false);
  expect(t.session.context([], 100_000).slice(1)).toEqual([
    { role: "user", content: "write a.md" },
    { role: "assistant", content: "(stopped by the user)" },
  ]);
});

test("an empty reply is retried once with a hint that is not saved", async () => {
  const t = await setup([{ text: "" }, { text: "Here you go" }]);
  const events = await t.run("hi");
  expect(events).toEqual([{ type: "text", delta: "Here you go" }]);
  expect(t.llm.seen[1]?.at(-1)?.content).toContain("did not answer the user or call a tool");
  expect(t.session.context([], 100_000).slice(1)).toEqual([
    { role: "user", content: "hi" },
    { role: "assistant", content: "Here you go" },
  ]);
});

test("two empty replies in a row give the user a fallback message", async () => {
  const t = await setup([{ text: "" }, { text: "" }]);
  const events = await t.run("hi");
  expect(events).toEqual([{ type: "text", delta: expect.stringContaining("couldn't produce an answer") }]);
});

test("an announced-but-not-taken action after a tool call gets one nudge", async () => {
  const t = await setup([
    { calls: [{ name: "read_file", arguments: '{"path":"missing.txt"}' }] },
    { text: "The file is missing. I'll check the folder instead. Let's do that now." },
    { text: "There is no such file." },
  ]);
  const events = await t.run("read missing.txt");
  expect(t.llm.seen).toHaveLength(3);
  expect(t.llm.seen[2]?.at(-1)?.content).toContain("Call the tool you need now");
  expect(t.session.context([], 100_000).at(-1)).toEqual({ role: "assistant", content: "There is no such file." });
  expect(events.filter((e) => e.type === "text").length).toBeGreaterThan(1);
});

test("a normal final answer is not mistaken for an announcement", async () => {
  const t = await setup([{ calls: [{ name: "read_file", arguments: '{"path":"x"}' }] }, { text: "I read it and it is empty." }]);
  await t.run("read x");
  expect(t.llm.seen).toHaveLength(2);
});

test("a claimed action without a tool call is flagged and retried once", async () => {
  const t = await setup([{ text: "Added to today's journal." }, { calls: [write("j.md", "entry")] }, { text: "Done." }], ["approve"]);
  const events = await t.run("journal: entry");
  expect(events.find((e) => e.type === "notice")).toMatchObject({ message: expect.stringContaining("no tool was called") });
  expect(t.llm.seen[1]?.at(-1)?.content).toContain("you did not call any tool");
  expect(readFileSync(join(t.workspace, "j.md"), "utf8")).toBe("entry");
});

test("a repeated false claim ends with a warning to the user", async () => {
  const t = await setup([{ text: "I've saved it." }, { text: "Saved it for you." }]);
  const events = await t.run("save it");
  const notices = events.filter((e) => e.type === "notice");
  expect(notices).toHaveLength(2);
  expect(notices[1]).toMatchObject({ message: "No tool was called, so nothing was actually saved or changed." });
});

test("ordinary sentences are not mistaken for claims", async () => {
  const t = await setup([{ text: "Created in 2020, the repo has 10 stars. Updated daily by its authors." }]);
  const events = await t.run("tell me about the repo");
  expect(events.some((e) => e.type === "notice")).toBe(false);
});

test("claims backed by a real change are not flagged", async () => {
  const t = await setup([{ calls: [write("a.md", "x")] }, { text: "I've saved a.md." }], ["approve"]);
  const events = await t.run("save");
  expect(events.some((e) => e.type === "notice")).toBe(false);
});

test("a reply that is only a JSON tool call is executed as a real call", async () => {
  const t = await setup([{ text: '```json\n{"name": "write_file", "parameters": {"path": "j.md", "content": "hi"}}\n```' }, { text: "Done." }], ["approve"]);
  await t.run("write j.md");
  expect(readFileSync(join(t.workspace, "j.md"), "utf8")).toBe("hi");
});

test("parseTextToolCall only accepts a whole-reply call to a known tool", () => {
  const names = ["write_file"];
  expect(parseTextToolCall('{"name":"write_file","arguments":{"path":"a"}}', names)).toEqual({ name: "write_file", arguments: '{"path":"a"}' });
  expect(parseTextToolCall('Sure! {"name":"write_file","parameters":{}}', names)).toBeNull();
  expect(parseTextToolCall('{"name":"rm_everything","parameters":{}}', names)).toBeNull();
  expect(parseTextToolCall("not json", names)).toBeNull();
});

test("claims about reminders need a reminder tool to have succeeded", async () => {
  const t = await setup([{ text: "I called cancel_reminder. The reminder was cancelled." }, { text: "Sorry, nothing was cancelled." }]);
  const events = await t.run("cancel my gym reminder");
  expect(events.some((e) => e.type === "notice")).toBe(true);
});

test("\"I've set a reminder\" without a successful reminder call is flagged", async () => {
  const t = await setup([{ text: "I've set a reminder for you at 09:00." }, { text: "Sorry, I did not set it." }]);
  expect((await t.run("remind me at 9")).some((e) => e.type === "notice")).toBe(true);
});
