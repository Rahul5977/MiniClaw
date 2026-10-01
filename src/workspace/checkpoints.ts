import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface Checkpoint {
  sha: string;
  when: string;
  summary: string;
}

const AGENT_PREFIX = "agent: ";

/**
 * I-1: Time-travel workspace. Every agent action that changes files becomes a
 * git commit, so `/undo` can roll the workspace back. The git directory lives
 * OUTSIDE the workspace (e.g. data/checkpoints.git), so the agent's own tools
 * can't see, edit or delete the history.
 */
export class Checkpoints {
  private gitDir: string;
  private workTree: string;

  constructor(gitDir: string, workTree: string) {
    // Absolute, because git runs with the workspace as its working directory.
    this.gitDir = resolve(gitDir);
    this.workTree = resolve(workTree);
  }

  private async git(args: string[]): Promise<{ out: string }> {
    const proc = Bun.spawn(
      [
        "git",
        `--git-dir=${this.gitDir}`,
        `--work-tree=${this.workTree}`,
        "-c", "user.name=MiniClaw",
        "-c", "user.email=miniclaw@localhost",
        "-c", "commit.gpgsign=false",
        "-c", "core.autocrlf=false",
        ...args,
      ],
      { cwd: this.workTree, stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
    );
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (code !== 0) throw new Error(`git ${args[0]} failed: ${err.trim() || out.trim()}`);
    return { out: out.trim() };
  }

  async init(): Promise<void> {
    if (existsSync(this.gitDir)) return;
    mkdirSync(dirname(this.gitDir), { recursive: true });
    await this.git(["init", "--quiet"]);
    await this.git(["add", "-A"]);
    await this.git(["commit", "--quiet", "--allow-empty", "-m", "baseline: workspace when MiniClaw started tracking it"]);
  }

  /** Commits everything if anything changed. Returns the changed files, or [] if nothing changed. */
  private async commitIfChanged(message: string): Promise<string[]> {
    await this.git(["add", "-A"]);
    const changed = (await this.git(["diff", "--cached", "--name-status"])).out;
    if (!changed) return [];
    await this.git(["commit", "--quiet", "--no-verify", "-m", message]);
    return changed.split("\n");
  }

  /** Call before an agent action: captures edits the user made by hand so they are never mixed up with the agent's. */
  async before(): Promise<void> {
    await this.commitIfChanged("manual: changes made outside MiniClaw");
  }

  /** Call after an agent action. Returns changed files like ["M\tnotes.md", "A\tnew.txt"]. */
  async after(summary: string, auditId: string): Promise<string[]> {
    return this.commitIfChanged(`${AGENT_PREFIX}${summary.replace(/\s+/g, " ").slice(0, 120)}\n\naudit: ${auditId}`);
  }

  async head(): Promise<string> {
    return (await this.git(["rev-parse", "HEAD"])).out;
  }

  /** Most recent agent actions first. */
  async history(limit = 10): Promise<Checkpoint[]> {
    const { out } = await this.git(["log", "--first-parent", "--format=%H%x09%cr%x09%s"]);
    return out
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [sha = "", when = "", subject = ""] = line.split("\t");
        return { sha, when, subject };
      })
      .filter((c) => c.subject.startsWith(AGENT_PREFIX))
      .slice(0, limit)
      .map(({ sha, when, subject }) => ({ sha, when, summary: subject.slice(AGENT_PREFIX.length) }));
  }

  /**
   * Restores the workspace to just before the n-th most recent agent action.
   * Hand edits made after that point are rolled back too, but they remain in
   * git's reflog, so nothing is permanently lost.
   */
  async undo(n = 1): Promise<{ undone: Checkpoint[]; files: string[] } | null> {
    await this.before();
    const history = await this.history(n);
    const oldest = history[n - 1];
    if (!oldest) return null;
    const target = `${oldest.sha}^`;
    // What undoing does to the workspace, e.g. ["D\tsummary.md"] for a file the agent had created.
    const files = (await this.git(["diff", "--name-status", "HEAD", target])).out.split("\n").filter(Boolean);
    await this.git(["reset", "--quiet", "--hard", target]);
    return { undone: history, files };
  }

  /** Diff summary and number of agent actions since a checkpoint (used for the plan summary). */
  async changesSince(sha: string): Promise<{ stat: string; actions: number }> {
    const stat = (await this.git(["diff", "--stat", sha, "HEAD"])).out;
    const log = (await this.git(["log", "--first-parent", "--format=%s", `${sha}..HEAD`])).out;
    const actions = log.split("\n").filter((s) => s.startsWith(AGENT_PREFIX)).length;
    return { stat, actions };
  }
}
