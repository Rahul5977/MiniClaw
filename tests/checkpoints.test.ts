import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareWorkspace } from "../src/security/sandbox.ts";
import { Checkpoints } from "../src/workspace/checkpoints.ts";

const root = mkdtempSync(join(tmpdir(), "miniclaw-ckpt-"));
const ws = prepareWorkspace(join(root, "ws"));
const cp = new Checkpoints(join(root, "data/checkpoints.git"), ws);
const file = (name: string) => join(ws, name);
afterAll(() => rmSync(root, { recursive: true, force: true }));

beforeAll(async () => {
  writeFileSync(file("existing.txt"), "from user");
  await cp.init();
});

test("git history lives outside the workspace", () => {
  expect(existsSync(join(ws, ".git"))).toBe(false);
  expect(existsSync(join(root, "data/checkpoints.git"))).toBe(true);
});

test("agent actions are checkpointed and undone in order", async () => {
  await cp.before();
  writeFileSync(file("notes.md"), "v1");
  expect(await cp.after("write notes.md", "a1")).toEqual(["A\tnotes.md"]);

  await cp.before();
  writeFileSync(file("notes.md"), "v2");
  rmSync(file("existing.txt"));
  await cp.after("rewrite notes and delete existing", "a2");

  await cp.before();
  expect(await cp.after("no-op", "a3")).toEqual([]);

  expect((await cp.history()).map((c) => c.summary)).toEqual(["rewrite notes and delete existing", "write notes.md"]);

  const result = await cp.undo();
  expect(result?.undone.map((c) => c.summary)).toEqual(["rewrite notes and delete existing"]);
  expect(readFileSync(file("notes.md"), "utf8")).toBe("v1");
  expect(readFileSync(file("existing.txt"), "utf8")).toBe("from user");

  await cp.undo();
  expect(existsSync(file("notes.md"))).toBe(false);
  expect(await cp.undo()).toBeNull();
});

test("hand edits are committed separately, not attributed to the agent", async () => {
  writeFileSync(file("manual.txt"), "typed by user");
  await cp.before();
  writeFileSync(file("agent.txt"), "by agent");
  await cp.after("write agent.txt", "a4");
  await cp.undo();
  expect(existsSync(file("agent.txt"))).toBe(false);
  expect(readFileSync(file("manual.txt"), "utf8")).toBe("typed by user");
});
