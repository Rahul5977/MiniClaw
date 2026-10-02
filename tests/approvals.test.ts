import { expect, test } from "bun:test";
import { ApprovalPolicy, type Approver, type Decision } from "../src/security/approvals.ts";
import { openDatabase } from "../src/db/database.ts";
import { AuditLog, redact } from "../src/security/audit.ts";
import { makeRisk } from "../src/security/risk.ts";

function scripted(...answers: Decision[]): Approver & { asked: number } {
  return {
    asked: 0,
    async ask() {
      this.asked++;
      return answers.shift() ?? "deny";
    },
  };
}

const request = (level: "low" | "medium" | "high" | "blocked", scope = "write_file:a.md") => ({
  tool: "t",
  summary: "s",
  risk: makeRisk(level, scope),
});

test("low runs automatically, blocked never asks", async () => {
  const policy = new ApprovalPolicy();
  const approver = scripted();
  expect(await policy.authorize(request("low"), approver)).toBe("auto");
  expect(await policy.authorize(request("blocked"), approver)).toBe("blocked");
  expect(approver.asked).toBe(0);
});

test("medium can be approved for the session, per scope", async () => {
  const policy = new ApprovalPolicy();
  const approver = scripted("approve_session");
  expect(await policy.authorize(request("medium"), approver)).toBe("approved");
  expect(await policy.authorize(request("medium"), approver)).toBe("session");
  expect(await policy.authorize(request("medium", "write_file:other.md"), approver)).toBe("denied");
  expect(approver.asked).toBe(2);
});

test("high always asks, even after session approval", async () => {
  const policy = new ApprovalPolicy();
  const approver = scripted("approve_session", "approve");
  await policy.authorize(request("high"), approver);
  await policy.authorize(request("high"), approver);
  expect(approver.asked).toBe(2);
});

test("plan scopes pre-approve medium calls only", async () => {
  const policy = new ApprovalPolicy();
  policy.allowPlan(["write_file:a.md"]);
  const approver = scripted("deny");
  expect(await policy.authorize(request("medium"), approver)).toBe("plan");
  expect(await policy.authorize(request("high"), approver)).toBe("denied");
  policy.clearPlan();
  expect(approver.asked).toBe(1);
});

test("redact hides keys and secret env values", () => {
  process.env.MY_API_TOKEN = "supersecretvalue123";
  const out = redact("key sk-abcdefghijklmnopqrstuv and supersecretvalue123 and Bearer abcdefghijklmnopqrstu");
  delete process.env.MY_API_TOKEN;
  expect(out).toBe("key [REDACTED] and [REDACTED] and Bearer [REDACTED]");
});

test("audit log stores redacted entries, newest first", () => {
  const audit = new AuditLog(openDatabase(":memory:"));
  const base = { session: "s", summary: "x", risk: "low" as const, reasons: ["r"], verdict: "auto" as const, ok: true, durationMs: 1 };
  audit.record({ ...base, id: audit.nextId(), tool: "first", args: {}, result: "ok" });
  audit.record({ ...base, id: audit.nextId(), tool: "second", args: { key: "sk-abcdefghijklmnopqrstuv" }, result: "ok" });
  const [latest, earlier] = audit.recent();
  expect(latest).toMatchObject({ tool: "second", args: { key: "[REDACTED]" }, reasons: ["r"], ok: true });
  expect(earlier?.tool).toBe("first");
});
