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

test(".git directories are off-limits", () => {
  expect(() => resolveInWorkspace(ws, ".git/config")).toThrow(/\.git/);
});

test("displayPath is workspace-relative", () => {
  expect(displayPath(ws, join(ws, "x/y.md"))).toBe("x/y.md");
  expect(displayPath(ws, ws)).toBe(".");
});
