import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareWorkspace } from "../src/security/sandbox.ts";
import { runShellTool } from "../src/tools/shell.ts";

const root = mkdtempSync(join(tmpdir(), "miniclaw-shell-"));
const ctx = { workspace: prepareWorkspace(join(root, "ws")) };
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("runs in the workspace and reports exit code and output", async () => {
  const out = await runShellTool.run({ command: "pwd && echo oops >&2 && exit 3" }, ctx);
  expect(out).toContain("Exit code: 3");
  expect(out).toContain(`stdout:\n${ctx.workspace}`);
  expect(out).toContain("stderr:\noops");
});

test("secrets from the agent environment are not passed through", async () => {
  process.env.MINICLAW_TEST_SECRET = "sk-should-not-leak";
  const out = await runShellTool.run({ command: "env" }, ctx);
  delete process.env.MINICLAW_TEST_SECRET;
  expect(out).not.toContain("sk-should-not-leak");
  expect(out).toContain(`HOME=${ctx.workspace}`);
});

test("can be stopped with an abort signal", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const started = Date.now();
  const out = await runShellTool.run({ command: "sleep 5" }, { ...ctx, signal: controller.signal });
  expect(Date.now() - started).toBeLessThan(2000);
  expect(out).toContain("Killed");
});
