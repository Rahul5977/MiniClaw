import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { prepareWorkspace } from "../src/security/sandbox.ts";
import { detectSandbox, seatbeltProfile } from "../src/security/shellSandbox.ts";
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

describe.if(detectSandbox() !== null)("sandbox", () => {
  const run = (command: string) => runShellTool.run({ command }, ctx);

  test("writes work in the workspace and the command's own TMPDIR", async () => {
    const out = await run('echo hi > inside.txt && echo tmp > "$TMPDIR/t" && cat inside.txt "$TMPDIR/t"');
    expect(out).toContain("Exit code: 0");
    expect(out).toContain("hi\ntmp");
  });

  test("writes outside the workspace are refused", async () => {
    const out = await run("echo x > ../escaped.txt");
    expect(existsSync(join(root, "escaped.txt"))).toBe(false);
    expect(out).toContain("sandbox");
  });

  test("the workspace's .git folder is off-limits", async () => {
    await run("mkdir -p .git");
    mkdirSync(join(ctx.workspace, ".git"), { recursive: true });
    await run("echo x > .git/config");
    expect(existsSync(join(ctx.workspace, ".git", "config"))).toBe(false);
  });

  test.if(process.cwd().startsWith(homedir() + sep))("files elsewhere in the home folder can't be read", async () => {
    expect(await run(`cat ${join(process.cwd(), "package.json")}`)).not.toContain('"scripts"');
  });

  test("a command not approved for the network can't reach it", async () => {
    const out = await run(`bun -e "await fetch('https://example.com'); console.log('reached')"`);
    expect(out).not.toContain("reached");
  });
});

test("the Seatbelt profile only drops the network wall when asked", () => {
  expect(seatbeltProfile(0, false)).toContain("(deny network*)");
  expect(seatbeltProfile(0, true)).not.toContain("network");
  expect(seatbeltProfile(2, false)).toContain('(subpath (param "READ1"))');
});
