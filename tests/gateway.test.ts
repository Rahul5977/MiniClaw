import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { matchChoice, splitMessage } from "../src/gateway/channel.ts";
import { Gateway } from "../src/gateway/gateway.ts";
import { FakeChannel, ScriptedLLM, testRuntime, type Step } from "./helpers/fakes.ts";

const OWNER = "111";

async function setup(steps: Step[], options: { answerTimeoutMs?: number } = {}) {
  const llm = new ScriptedLLM(steps);
  const { runtime } = await testRuntime(llm);
  const channel = new FakeChannel("telegram", [OWNER]);
  const gateway = new Gateway(runtime, [channel], { ...options, schedulerIntervalMs: 60_000 });
  await gateway.start();
  gateway.scheduler.stop(); // tests tick it by hand
  return { llm, runtime, channel, gateway };
}

const write = (path: string, content: string) => ({ name: "write_file", arguments: JSON.stringify({ path, content }) });

test("strangers are ignored; the owner gets a reply", async () => {
  const t = await setup([{ text: "Hello!" }]);
  t.channel.receive("999", "hi");
  await Bun.sleep(20);
  expect(t.channel.sent).toHaveLength(0);

  t.channel.receive(OWNER, "hi");
  expect((await t.channel.waitFor((s) => s.text === "Hello!")).chatId).toBe(OWNER);
});

test("approvals are asked with buttons and a tap answers them", async () => {
  const t = await setup([{ calls: [write("a.md", "hi")] }, { text: "Saved a.md." }]);
  t.channel.receive(OWNER, "save hi to a.md");
  const question = await t.channel.waitFor((s) => !!s.choices);
  expect(question.text).toContain("🔐 Allow: write a.md? [medium risk]");
  expect(question.text).toContain("+hi"); // the diff
  expect(question.choices?.map((c) => c.id)).toEqual(["yes", "no", "always"]);

  t.channel.receive(OWNER, "", "yes");
  await t.channel.waitFor((s) => s.text === "Saved a.md.");
  expect(readFileSync(join(t.runtime.workspace, "a.md"), "utf8")).toBe("hi");
});

test("typed answers work for apps without buttons, and other text is held back", async () => {
  const t = await setup([{ calls: [write("b.md", "x")] }, { text: "ok" }]);
  t.channel.receive(OWNER, "write b.md");
  await t.channel.waitFor((s) => !!s.choices);
  t.channel.receive(OWNER, "what's up?");
  await t.channel.waitFor((s) => s.text.startsWith("Please answer the question above"));
  t.channel.receive(OWNER, "2"); // = No
  await t.channel.waitFor((s) => s.text === "ok");
  expect(existsSync(join(t.runtime.workspace, "b.md"))).toBe(false);
});

test("a second message while working gets a busy reply; /stop cancels", async () => {
  let release!: () => void;
  const slow = new Promise<void>((r) => (release = r));
  const t = await setup([{ wait: slow, text: "late answer" }]);
  t.channel.receive(OWNER, "think hard");
  await Bun.sleep(20);
  t.channel.receive(OWNER, "are you there?");
  await t.channel.waitFor((s) => s.text.startsWith("⏳ I'm still working"));
  t.channel.receive(OWNER, "/stop");
  release();
  await t.channel.waitFor((s) => s.text === "⏹ Stopped.");
  expect(t.channel.sent.some((s) => s.text === "late answer")).toBe(false);
});

test("/panic stops a request waiting for approval and blocks risky actions until /resume", async () => {
  const t = await setup([{ calls: [write("c.md", "x")] }, { calls: [write("c.md", "x")] }, { text: "done" }]);
  t.channel.receive(OWNER, "write c.md");
  await t.channel.waitFor((s) => !!s.choices);
  t.channel.receive(OWNER, "/panic");
  await t.channel.waitFor((s) => s.text.startsWith("⛔ Paused"));
  await t.channel.waitFor((s) => s.text === "⏹ Stopped.");
  expect(t.runtime.guard.paused).toBe(true);

  t.channel.sent = [];
  t.channel.receive(OWNER, "write c.md again");
  await t.channel.waitFor((s) => s.text.startsWith("⛔ Blocked: write c.md"));
  t.channel.receive(OWNER, "/resume");
  await t.channel.waitFor((s) => s.text === "▶ Resumed.");
  expect(t.runtime.guard.paused).toBe(false);
});

test("proposed memories are reviewed with Keep / Discard / Later", async () => {
  const t = await setup([{ calls: [{ name: "remember", arguments: '{"fact":"User likes chai."}' }] }, { text: "Noted!" }]);
  t.channel.receive(OWNER, "I like chai");
  const review = await t.channel.waitFor((s) => s.text.startsWith("📥 Remember this?"));
  expect(review.choices?.map((c) => c.label)).toEqual(["Keep", "Discard", "Later"]);
  t.channel.receive(OWNER, "", "keep");
  await t.channel.waitFor((s) => s.text === "✔ Saved to memory.");
  expect(t.runtime.facts.all().map((f) => f.text)).toEqual(["User likes chai."]);
});

test("unanswered approvals time out as no", async () => {
  const t = await setup([{ calls: [write("d.md", "x")] }, { text: "skipped" }], { answerTimeoutMs: 50 });
  t.channel.receive(OWNER, "write d.md");
  await t.channel.waitFor((s) => s.text.startsWith("⌛ No answer"));
  await t.channel.waitFor((s) => s.text === "skipped");
  expect(existsSync(join(t.runtime.workspace, "d.md"))).toBe(false);
});

test("reminders go to the chat they were set in; CLI reminders go to the owner", async () => {
  const t = await setup([{ calls: [{ name: "set_reminder", arguments: '{"text":"drink water","in_minutes":1}' }] }, { text: "Will do." }]);
  t.channel.receive(OWNER, "remind me to drink water in a minute");
  await t.channel.waitFor((s) => s.text === "Will do.");
  t.runtime.reminders.add({ sessionId: t.runtime.sessions.create("cli"), text: "from the terminal", dueAt: 0 });

  expect(await t.gateway.scheduler.tick(Date.now() + 2 * 60_000)).toBe(2);
  const reminders = t.channel.sent.filter((s) => s.text.startsWith("⏰"));
  expect(reminders.map((s) => [s.chatId, s.text])).toEqual([
    [OWNER, "⏰ Reminder: from the terminal"],
    [OWNER, "⏰ Reminder: drink water"],
  ]);
});

test("commands work from chat", async () => {
  const t = await setup([]);
  t.channel.receive(OWNER, "/help");
  await t.channel.waitFor((s) => s.text.includes("/panic – emergency stop"));
  t.channel.receive(OWNER, "/nonsense");
  await t.channel.waitFor((s) => s.text === "Unknown command /nonsense. Send /help for the list.");
});

test("helpers: splitting long messages and matching typed answers", () => {
  const parts = splitMessage("line one\n".repeat(1000), 4096);
  expect(parts.every((p) => p.length <= 4096)).toBe(true);
  expect(parts.join("\n").replaceAll("\n", "")).toBe("line one".repeat(1000));
  const choices = [{ id: "yes", label: "Yes" }, { id: "no", label: "No" }, { id: "always", label: "Always" }];
  expect(matchChoice("2", choices)).toBe("no");
  expect(matchChoice(" YES ", choices)).toBe("yes");
  expect(matchChoice("a", choices)).toBe("always");
  expect(matchChoice("maybe", choices)).toBeUndefined();
});

test("channel routes are served on the gateway's HTTP server", async () => {
  const { runtime } = await testRuntime(new ScriptedLLM([]));
  const channel = new FakeChannel("hooky", ["1"]);
  (channel as any).routes = () => ({ "/webhooks/test": () => new Response("hooked") });
  const gateway = new Gateway(runtime, [channel], { http: { host: "127.0.0.1", port: 0 } });
  await gateway.start();
  expect(await (await fetch(`${gateway.url}/webhooks/test`)).text()).toBe("hooked");
  expect((await fetch(`${gateway.url}/other`)).status).toBe(404);
  await gateway.stop();
});
