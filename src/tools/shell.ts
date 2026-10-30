import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { assessShellCommand, NETWORK_REASONS } from "../security/risk.ts";
import { detectSandbox, looksBlockedBySandbox, SANDBOX_NOTE } from "../security/shellSandbox.ts";
import { truncate } from "./format.ts";
import { defineTool } from "./tool.ts";

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 10_000;

/**
 * Only these variables reach the command. API keys and other secrets in the
 * agent's environment (e.g. from .env) are never visible to shell commands.
 * HOME points at the workspace so "~" stays inside it.
 */
function safeEnv(workspace: string, tmp: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    HOME: workspace,
    TMPDIR: tmp,
    TERM: "dumb",
  };
}

export interface ShellOptions {
  /** Run commands in the OS sandbox (security/shellSandbox.ts); if there is none, refuse to run. */
  sandbox: boolean;
  /** Extra folders sandboxed commands may read. */
  readPaths?: string[];
}

export const createShellTool = ({ sandbox: useSandbox, readPaths }: ShellOptions) => defineTool({
  name: "run_shell",
  description:
    "Run a shell command inside the workspace folder and return its output. " +
    "Prefer read_file/write_file/list_dir for simple file work.",
  schema: z.object({
    command: z.string().min(1).describe("The shell command to run (sh syntax)"),
  }),
  changesWorkspace: true,
  targetHint: "the exact shell command",
  assess: (args) => assessShellCommand(args.command),
  assessTarget: (target) => assessShellCommand(target),
  summarize: (args) => `run \`${args.command}\``,
  async run(args, ctx) {
    const sandbox = useSandbox ? detectSandbox() : null;
    if (useSandbox && !sandbox) {
      return (
        "Refused: no shell sandbox is available on this computer (macOS sandbox-exec, or bubblewrap on Linux). " +
        "Install bubblewrap, or set security.shellSandbox to false to run commands unsandboxed."
      );
    }
    // The user approved network use only if the command was flagged for it.
    const network = assessShellCommand(args.command).reasons.some((r) => NETWORK_REASONS.includes(r));
    const tmp = realpathSync(mkdtempSync(join(tmpdir(), "miniclaw-sh-")));
    try {
      const argv = sandbox?.wrap(args.command, { workspace: ctx.workspace, tmp, network, readPaths }) ?? ["/bin/sh", "-c", args.command];
      const output = await runCommand(argv, ctx.workspace, tmp, ctx.signal);
      return sandbox && looksBlockedBySandbox(output) ? `${output}\n\n${SANDBOX_NOTE}` : output;
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  },
});

export const runShellTool = createShellTool({ sandbox: true });

async function runCommand(argv: string[], workspace: string, tmp: string, signal?: AbortSignal): Promise<string> {
  const proc = Bun.spawn(argv, {
    cwd: workspace,
    env: safeEnv(workspace, tmp),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: TIMEOUT_MS,
    signal,
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const parts = [proc.signalCode ? `Killed (${proc.signalCode}) — took longer than ${TIMEOUT_MS / 1000}s or was stopped.` : `Exit code: ${exitCode}`];
  if (stdout.trim()) parts.push(`stdout:\n${stdout.trimEnd()}`);
  if (stderr.trim()) parts.push(`stderr:\n${stderr.trimEnd()}`);
  if (!stdout.trim() && !stderr.trim()) parts.push("(no output)");
  return truncate(parts.join("\n"), MAX_OUTPUT_CHARS);
}
