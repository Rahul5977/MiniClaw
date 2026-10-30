import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, sep } from "node:path";

/**
 * OS-level sandbox for run_shell. The risk rules decide whether to ask; this decides
 * what an approved command can actually reach, so a command the rules misjudged (or a
 * script it runs) still can't:
 * - write outside the workspace and its own temp folder,
 * - read your home folder (secrets, .env, SSH keys, other projects), except the
 *   workspace, the PATH folders inside it, and any extra readable paths,
 * - use the network, unless the command was flagged as needing it and you approved it.
 *
 * macOS uses sandbox-exec (Seatbelt), Linux uses bubblewrap (bwrap) if installed.
 */

export interface SandboxOptions {
  /** Canonical workspace path (from prepareWorkspace). */
  workspace: string;
  /** Canonical per-command temp folder. */
  tmp: string;
  network: boolean;
  /** Extra folders the command may read, e.g. a tool installed under your home folder. */
  readPaths?: string[];
}

export interface ShellSandbox {
  name: string;
  /** The argv that runs `command` with /bin/sh inside the sandbox. */
  wrap(command: string, options: SandboxOptions): string[];
}

const canonical = (path: string) => (existsSync(path) ? realpathSync(path) : path);

/** Readable folders inside the home folder: PATH entries there (so ~/.bun/bin/bun runs) plus extras. */
function homeReadPaths(home: string, extra: string[]): string[] {
  const fromPath = (process.env.PATH ?? "").split(delimiter).filter((dir) => isAbsolute(dir));
  const all = [...fromPath, ...extra].map(canonical).filter((dir) => dir.startsWith(home + sep));
  return [...new Set(all)];
}

/**
 * Seatbelt profile. Everything is allowed by default except what is denied here; for
 * matching rules the last one wins, so the "allow" lines carve exceptions out of the denies.
 * Paths are passed as -D parameters, never pasted into the profile text.
 */
export function seatbeltProfile(readCount: number, network: boolean): string {
  const reads = Array.from({ length: readCount }, (_, i) => ` (subpath (param "READ${i}"))`).join("");
  return [
    "(version 1)",
    "(allow default)",
    network ? "" : "(deny network*)",
    "(deny file-write*)",
    '(allow file-write* (subpath (param "WORKSPACE")) (subpath (param "TMP"))',
    '  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/stdout") (literal "/dev/stderr")',
    '  (literal "/dev/dtracehelper") (regex #"^/dev/tty") (regex #"^/dev/fd/"))',
    '(deny file-write* (subpath (param "WORKSPACE_GIT")))',
    '(deny file-read-data (subpath (param "HOME")))',
    `(allow file-read-data (subpath (param "WORKSPACE")) (subpath (param "TMP"))${reads})`,
    '(deny file-read-data (subpath (param "WORKSPACE_GIT")))',
    // Asking other apps to run things would escape the sandbox (osascript, open -a Terminal).
    "(deny appleevent-send)",
    '(deny process-exec (literal "/usr/bin/osascript") (literal "/usr/bin/open") (literal "/usr/bin/automator"))',
    '(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd"))',
  ]
    .filter(Boolean)
    .join("\n");
}

const seatbelt: ShellSandbox = {
  name: "sandbox-exec",
  wrap(command, options) {
    const home = canonical(homedir());
    const reads = homeReadPaths(home, options.readPaths ?? []);
    const params = {
      HOME: home,
      WORKSPACE: options.workspace,
      WORKSPACE_GIT: `${options.workspace}${sep}.git`,
      TMP: options.tmp,
      ...Object.fromEntries(reads.map((dir, i) => [`READ${i}`, dir])),
    };
    return [
      "/usr/bin/sandbox-exec",
      "-p",
      seatbeltProfile(reads.length, options.network),
      ...Object.entries(params).flatMap(([key, value]) => ["-D", `${key}=${value}`]),
      "/bin/sh",
      "-c",
      command,
    ];
  },
};

const bubblewrap = (bwrap: string): ShellSandbox => ({
  name: "bwrap",
  wrap(command, options) {
    const home = canonical(homedir());
    const reads = homeReadPaths(home, options.readPaths ?? []);
    return [
      bwrap,
      "--ro-bind", "/", "/",
      "--dev", "/dev",
      "--proc", "/proc",
      "--tmpfs", "/tmp",
      // Hide the home folder, then bring back only what the command may see.
      "--tmpfs", home,
      ...reads.flatMap((dir) => ["--ro-bind", dir, dir]),
      "--bind", options.workspace, options.workspace,
      "--bind", options.tmp, options.tmp,
      ...(existsSync(`${options.workspace}/.git`) ? ["--tmpfs", `${options.workspace}/.git`] : []),
      "--unshare-all",
      ...(options.network ? ["--share-net"] : []),
      "--die-with-parent",
      "--new-session",
      "--chdir", options.workspace,
      "/bin/sh", "-c", command,
    ];
  },
});

/** The sandbox available on this machine, or null if there is none. */
export function detectSandbox(): ShellSandbox | null {
  if (process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec")) return seatbelt;
  if (process.platform === "linux") {
    const bwrap = Bun.which("bwrap");
    if (bwrap) return bubblewrap(bwrap);
  }
  return null;
}

/** Shown with the output when a sandboxed command seems to have hit the walls. */
export const SANDBOX_NOTE =
  "Note: shell commands run in a sandbox. They can write only inside the workspace, can't read the " +
  "rest of the home folder, and have no network unless the command was approved as using it.";

export const looksBlockedBySandbox = (output: string) =>
  /operation not permitted|permission denied|read-only file system|could not resolve host|network is unreachable|name or service not known/i.test(output);
