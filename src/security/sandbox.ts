import { existsSync, lstatSync, mkdirSync, readlinkSync, realpathSync } from "node:fs";
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

  const real = realLocation(target);
  if (!isInside(workspace, real)) {
    throw new SandboxError(`"${userPath}" points outside the workspace through a symlink.`);
  }

  if (relative(workspace, real).split(sep).includes(".git")) {
    throw new SandboxError(`"${userPath}" is inside a .git directory, which is off-limits.`);
  }
  return real;
}

/** Most symlinks followed in one path, like the OS limit; more means a loop. */
const MAX_SYMLINKS = 40;

/**
 * Where `target` really leads, following every symlink in it, including broken ones.
 * realpath can only resolve the part of a path that exists, and a broken symlink
 * (one whose target is missing) counts as not existing. Stopping there would judge
 * the link by its own location, while a write through it creates its target, which
 * may be anywhere ("workspace/report.txt" → "~/Library/LaunchAgents/evil.plist").
 * So a broken link is followed by hand and its target is resolved in turn.
 */
function realLocation(target: string, hops = 0): string {
  let existing = target;
  while (!existsSync(existing)) {
    if (lstatSync(existing, { throwIfNoEntry: false })?.isSymbolicLink()) {
      if (hops >= MAX_SYMLINKS) throw new SandboxError(`"${target}" has too many symlinks (or a symlink loop).`);
      const pointsTo = resolve(dirname(existing), readlinkSync(existing));
      return realLocation(join(pointsTo, relative(existing, target)), hops + 1);
    }
    existing = dirname(existing);
  }
  return join(realpathSync(existing), relative(existing, target));
}

/** Path relative to the workspace, for display and approval scopes ("." for the root). */
export function displayPath(workspace: string, absolute: string): string {
  return relative(workspace, absolute) || ".";
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
