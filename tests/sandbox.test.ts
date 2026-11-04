import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { displayPath, prepareWorkspace, resolveInWorkspace } from "../src/security/sandbox.ts";

const root = mkdtempSync(join(tmpdir(), "miniclaw-sandbox-"));
const ws = prepareWorkspace(join(root, "workspace"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("relative and in-workspace absolute paths resolve", () => {
  expect(resolveInWorkspace(ws, "notes/a.txt")).toBe(join(ws, "notes/a.txt"));
  expect(resolveInWorkspace(ws, join(ws, "b.txt"))).toBe(join(ws, "b.txt"));
  expect(resolveInWorkspace(ws, ".")).toBe(ws);
});

test("traversal and outside absolute paths are rejected", () => {
  expect(() => resolveInWorkspace(ws, "../secret.txt")).toThrow(/outside the workspace/);
  expect(() => resolveInWorkspace(ws, "a/../../x")).toThrow(/outside the workspace/);
  expect(() => resolveInWorkspace(ws, "/etc/passwd")).toThrow(/outside the workspace/);
});

test("symlinks pointing outside are rejected", () => {
  symlinkSync(root, join(ws, "escape"));
  expect(() => resolveInWorkspace(ws, "escape/anything.txt")).toThrow(/symlink/);
});

test("broken symlinks are judged by where they point, not where they sit", () => {
  // Their targets don't exist yet, so realpath alone can't see where they lead.
  symlinkSync(join(root, "planted.txt"), join(ws, "dangling-file"));
  symlinkSync(join(root, "missing-dir"), join(ws, "dangling-dir"));
  symlinkSync("../planted-relative.txt", join(ws, "dangling-relative"));
  expect(() => resolveInWorkspace(ws, "dangling-file")).toThrow(/symlink/);
  expect(() => resolveInWorkspace(ws, "dangling-dir/new.txt")).toThrow(/symlink/);
  expect(() => resolveInWorkspace(ws, "dangling-relative")).toThrow(/symlink/);
});

test("a broken symlink to a new file inside the workspace still works", () => {
  symlinkSync("drafts/later.md", join(ws, "later-link"));
  expect(resolveInWorkspace(ws, "later-link")).toBe(join(ws, "drafts/later.md"));
});

test("symlink loops are refused instead of hanging", () => {
  symlinkSync("loop-b", join(ws, "loop-a"));
  symlinkSync("loop-a", join(ws, "loop-b"));
  expect(() => resolveInWorkspace(ws, "loop-a")).toThrow(/too many symlinks/);
});

test(".git directories are off-limits", () => {
  expect(() => resolveInWorkspace(ws, ".git/config")).toThrow(/\.git/);
});

test("displayPath is workspace-relative", () => {
  expect(displayPath(ws, join(ws, "x/y.md"))).toBe("x/y.md");
  expect(displayPath(ws, ws)).toBe(".");
});
