import { z } from "zod";
import { assessShellCommand } from "../security/risk.ts";
import { truncate } from "./format.ts";
import { defineTool } from "./tool.ts";

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 10_000;

/**
 * Only these variables reach the command. API keys and other secrets in the
 * agent's environment (e.g. from .env) are never visible to shell commands.
 * HOME points at the workspace so "~" stays inside it.
 */
function safeEnv(workspace: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    LANG: process.env.LANG ?? "en_US.UTF-8",
    HOME: workspace,
    TERM: "dumb",
  };
}

export const runShellTool = defineTool({
  name: "run_shell",
  description:
    "Run a shell command inside the workspace folder and return its output. " +
    "Prefer read_file/write_file/list_dir for simple file work.",
  schema: z.object({
    command: z.string().min(1).describe("The shell command to run (sh syntax)"),
  }),
  changesWorkspace: true,
  assess: (args) => assessShellCommand(args.command),
  summarize: (args) => `run \`${args.command}\``,
  async run(args, ctx) {
    const proc = Bun.spawn(["/bin/sh", "-c", args.command], {
      cwd: ctx.workspace,
      env: safeEnv(ctx.workspace),
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: TIMEOUT_MS,
      signal: ctx.signal,
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
  },
});
