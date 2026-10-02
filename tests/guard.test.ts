import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db/database.ts";
import { AuditLog } from "../src/security/audit.ts";
import { Guard } from "../src/security/guard.ts";
import { makeRisk } from "../src/security/risk.ts";

const root = mkdtempSync(join(tmpdir(), "miniclaw-guard-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("panic blocks everything except low risk until resume, and survives restarts", () => {
  const db = openDatabase(":memory:");
  const file = join(root, "paused");
  const guard = new Guard(db, file, {});
  guard.pause("telegram");
  expect(guard.check("read_file", makeRisk("low", "read_file:a")).level).toBe("low");
  const blocked = guard.check("write_file", makeRisk("medium", "write_file:a"));
  expect(blocked.level).toBe("blocked");
  expect(blocked.reasons.at(-1)).toContain("/resume");

  expect(new Guard(db, file, {}).paused).toBe(true); // a new process sees the pause
  expect(guard.pausedInfo()).toContain("from telegram");
  guard.resume();
  expect(guard.check("write_file", makeRisk("medium", "write_file:a")).level).toBe("medium");
});

test("daily budgets count successful calls from the audit log", () => {
  const db = openDatabase(":memory:");
  const audit = new AuditLog(db);
  const guard = new Guard(db, join(root, "never"), { run_shell: 2 });
  const record = (ok: boolean) =>
    audit.record({ id: audit.nextId(), session: "s", tool: "run_shell", summary: "x", args: {}, risk: "medium", reasons: [], verdict: "approved", ok, durationMs: 1, result: "" });

  record(true);
  record(false); // failed calls don't count
  expect(guard.check("run_shell", makeRisk("medium", "run_shell:ls")).level).toBe("medium");
  record(true);
  const over = guard.check("run_shell", makeRisk("medium", "run_shell:ls"));
  expect(over.level).toBe("blocked");
  expect(over.reasons.at(-1)).toContain("daily limit of 2 run_shell");
  expect(guard.usage()).toEqual([{ tool: "run_shell", used: 2, limit: 2 }]);
  // Other tools and tomorrow are unaffected.
  expect(guard.check("web_fetch", makeRisk("medium", "web_fetch:x")).level).toBe("medium");
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  expect(guard.check("run_shell", makeRisk("medium", "run_shell:ls"), tomorrow).level).toBe("medium");
});
