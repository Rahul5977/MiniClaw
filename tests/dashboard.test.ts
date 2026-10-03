import { expect, test } from "bun:test";
import { join } from "node:path";
import { createDashboard } from "../src/dashboard/server.ts";
import { Gateway } from "../src/gateway/gateway.ts";
import { FakeChannel, ScriptedLLM, testRuntime, type Step } from "./helpers/fakes.ts";

async function setup(steps: Step[] = [], withGateway = false) {
  const { runtime, root } = await testRuntime(new ScriptedLLM(steps));
  const channel = new FakeChannel("telegram", ["42"]);
  const gateway = withGateway ? new Gateway(runtime, [channel]) : undefined;
  if (gateway) await gateway.start();
  const dashboard = createDashboard({ runtime, gateway, tokenFile: join(root, "data/dashboard-token") });
  const cookie = `miniclaw_session=${dashboard.token}`;
  const call = (path: string, init: RequestInit & { auth?: boolean; host?: string } = {}) => {
    const headers = new Headers(init.headers);
    headers.set("host", init.host ?? "127.0.0.1:8787");
    if (init.auth !== false) headers.set("cookie", cookie);
    if (init.method && init.method !== "GET" && init.auth !== false) headers.set("x-miniclaw-csrf", "1");
    return dashboard.handle(new Request(`http://127.0.0.1:8787${path}`, { ...init, headers }));
  };
  return { runtime, dashboard, call, channel, gateway };
}

test("the login link sets an HttpOnly SameSite cookie and strips the token from the URL", async () => {
  const t = await setup();
  const res = await t.call(`/?token=${t.dashboard.token}`, { auth: false });
  expect(res.status).toBe(303);
  expect(res.headers.get("location")).toBe("/");
  expect(res.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict");
  expect((await t.call("/?token=wrong", { auth: false })).status).toBe(401);
});

test("without the cookie: the page says to log in and the API refuses", async () => {
  const t = await setup();
  const page = await t.call("/", { auth: false });
  expect(await page.text()).toContain("Open the login link");
  expect((await t.call("/api/overview", { auth: false })).status).toBe(401);
  expect((await t.call("/api/overview", { auth: false, headers: { authorization: `Bearer ${t.dashboard.token}` } })).status).toBe(200);
});

test("requests for other hosts (DNS rebinding, ngrok tunnels) are refused", async () => {
  const t = await setup();
  expect((await t.call("/api/overview", { host: "evil.example:8787" })).status).toBe(403);
  expect((await t.call("/api/overview", { host: "abc123.ngrok-free.app" })).status).toBe(403);
  expect((await t.call("/api/overview", { host: "localhost:8787" })).status).toBe(200);
});

test("writes need the CSRF header; security headers are set", async () => {
  const t = await setup();
  const headers = new Headers({ host: "127.0.0.1:8787", cookie: `miniclaw_session=${t.dashboard.token}` });
  const res = await t.dashboard.handle(new Request("http://127.0.0.1:8787/api/panic", { method: "POST", headers }));
  expect(res.status).toBe(403);
  expect(t.runtime.guard.paused).toBe(false);
  const ok = await t.call("/api/overview");
  expect(ok.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
});

test("overview, panic and resume", async () => {
  const t = await setup();
  const overview = (await (await t.call("/api/overview")).json()) as any;
  expect(overview).toMatchObject({ agent: "MiniClaw", model: "scripted", paused: null, gateway: null });
  expect((await (await t.call("/api/panic", { method: "POST" })).json()) as any).toMatchObject({ paused: expect.stringContaining("the dashboard") });
  expect(t.runtime.guard.paused).toBe(true);
  await t.call("/api/resume", { method: "POST" });
  expect(t.runtime.guard.paused).toBe(false);
});

test("runs, sessions and audit are browsable", async () => {
  const t = await setup([{ calls: [{ name: "list_reminders", arguments: "{}" }] }, { text: "none" }]);
  const agent = t.runtime.createAgent({ policy: new (await import("../src/security/approvals.ts")).ApprovalPolicy(), approver: { ask: async () => "deny" } });
  for await (const _ of agent.run(t.runtime.openSession(t.runtime.sessions.create("cli")), "any reminders?", new AbortController().signal));

  const runs = (await (await t.call("/api/runs")).json()) as any[];
  expect(runs[0]).toMatchObject({ userText: "any reminders?", status: "done", toolCalls: 1 });
  const run = (await (await t.call(`/api/runs/${runs[0].id}`)).json()) as any;
  expect(run.events.map((e: any) => e.type)).toEqual(["llm", "tool", "llm"]);
  const sessions = (await (await t.call("/api/sessions")).json()) as any[];
  expect(sessions[0]).toMatchObject({ channel: "cli", turns: 1, title: "any reminders?" });
  expect(((await (await t.call(`/api/sessions/${sessions[0].id}`)).json()) as any[])[0][0]).toEqual({ role: "user", content: "any reminders?" });
  expect(((await (await t.call("/api/audit")).json()) as any[])[0]).toMatchObject({ tool: "list_reminders", verdict: "auto" });
  expect((await t.call("/api/runs/nope")).status).toBe(404);
});

test("memory: edit MEMORY.md and IDENTITY.md, review the inbox, delete facts", async () => {
  const t = await setup();
  await t.call("/api/memory/file", { method: "PUT", body: JSON.stringify({ content: "# Memory\n- User likes chai" }) });
  await t.call("/api/identity", { method: "PUT", body: JSON.stringify({ content: "You are a pirate." }) });
  const proposal = t.runtime.inbox.propose({ fact: "User is in Pune" })!;
  await t.call(`/api/inbox/${proposal.id}`, { method: "POST", body: JSON.stringify({ decision: "keep" }) });

  const memory = (await (await t.call("/api/memory")).json()) as any;
  expect(memory.facts.map((f: any) => f.text)).toEqual(["User likes chai", "User is in Pune"]);
  expect(memory.identityFile.content).toBe("You are a pirate.\n");
  await t.call(`/api/facts/${memory.facts[0].id}`, { method: "DELETE" });
  expect(t.runtime.facts.all().map((f) => f.text)).toEqual(["User is in Pune"]);
  expect((await t.call("/api/memory/file", { method: "PUT", body: JSON.stringify({ content: 5 }) })).status).toBe(400);
});

test("live approvals: a question waiting in a chat can be answered from the dashboard", async () => {
  const t = await setup([{ calls: [{ name: "write_file", arguments: '{"path":"a.md","content":"x"}' }] }, { text: "Done." }], true);
  t.channel.receive("42", "write a.md");
  await t.channel.waitFor((s) => !!s.choices);
  const { questions } = (await (await t.call("/api/approvals")).json()) as any;
  expect(questions).toHaveLength(1);
  expect(questions[0]).toMatchObject({ key: "telegram:42", channel: "telegram", text: expect.stringContaining("write a.md") });

  expect((await t.call("/api/approvals/telegram%3A42", { method: "POST", body: JSON.stringify({ choice: "maybe" }) })).status).toBe(409);
  await t.call("/api/approvals/telegram%3A42", { method: "POST", body: JSON.stringify({ choice: "yes" }) });
  await t.channel.waitFor((s) => s.text === "Done.");
  expect(await Bun.file(join(t.runtime.workspace, "a.md")).text()).toBe("x");
  await t.gateway!.stop();
});

test("skills and reminders endpoints", async () => {
  const t = await setup();
  expect((await (await t.call("/api/skills")).json()) as any).toEqual({ skills: [], problems: [] });
  const r = t.runtime.reminders.add({ sessionId: "s", text: "stretch", dueAt: Date.now() + 60_000 });
  expect(((await (await t.call("/api/reminders")).json()) as any[]).map((x) => x.text)).toEqual(["stretch"]);
  await t.call(`/api/reminders/${r.id}`, { method: "DELETE" });
  expect(t.runtime.reminders.pending()).toHaveLength(0);
});
