import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export class SandboxError extends Error {}

/** Creates the workspace if needed and returns its canonical absolute path. */
export function prepareWorkspace(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return realpathSync(dir);
}

/**
 * Resolves a path the model gave us to an absolute path inside the workspace,
 * or throws. Handles "../" traversal, absolute paths and symlinks that point outside.
 * `workspace` must be canonical (from prepareWorkspace).
 */
export function resolveInWorkspace(workspace: string, userPath: string): string {
  const target = resolve(workspace, userPath);
  if (!isInside(workspace, target)) {
    throw new SandboxError(`"${userPath}" is outside the workspace. Use paths relative to the workspace.`);
  }

  // Follow symlinks on the part of the path that already exists.
  let existing = target;
  while (!existsSync(existing)) existing = dirname(existing);
  const real = join(realpathSync(existing), relative(existing, target));
  if (!isInside(workspace, real)) {
    throw new SandboxError(`"${userPath}" points outside the workspace through a symlink.`);
  }

  if (relative(workspace, real).split(sep).includes(".git")) {
    throw new SandboxError(`"${userPath}" is inside a .git directory, which is off-limits.`);
  }
  return real;
}

/** Path relative to the workspace, for display and approval scopes ("." for the root). */
export function displayPath(workspace: string, absolute: string): string {
  return relative(workspace, absolute) || ".";
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
