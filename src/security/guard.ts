import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Risk } from "../tools/tool.ts";

export interface BudgetUsage {
  tool: string;
  used: number;
  limit: number;
}

function startOfToday(now: Date): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * I-9: Emergency stop and daily action budgets, enforced before any approval.
 * - pause() ("/panic") blocks every non-low-risk action until resume(). The flag is
 *   a file, so a restart does not silently lift it.
 * - budgets cap how often a tool may run per day (e.g. 30 shell commands), counted
 *   from the audit log, so a runaway or hijacked agent can only do bounded damage.
 */
export class Guard {
  constructor(
    private db: Database,
    private pauseFile: string,
    private budgets: Record<string, number>,
  ) {}

  get paused(): boolean {
    return existsSync(this.pauseFile);
  }

  /** When and from where the pause was triggered, if paused. */
  pausedInfo(): string | null {
    return this.paused ? readFileSync(this.pauseFile, "utf8").trim() : null;
  }

  pause(source: string, now = new Date()): void {
    mkdirSync(dirname(this.pauseFile), { recursive: true });
    writeFileSync(this.pauseFile, `paused at ${now.toLocaleString()} from ${source}\n`);
  }

  resume(): void {
    rmSync(this.pauseFile, { force: true });
  }

  usage(now = new Date()): BudgetUsage[] {
    return Object.entries(this.budgets).map(([tool, limit]) => ({ tool, used: this.usedToday(tool, now), limit }));
  }

  private usedToday(tool: string, now: Date): number {
    return this.db
      .query<{ n: number }, [string, number]>("SELECT COUNT(*) AS n FROM audit_log WHERE tool = ? AND ok = 1 AND created_at >= ?")
      .get(tool, startOfToday(now))!.n;
  }

  check(tool: string, risk: Risk, now = new Date()): Risk {
    if (risk.level === "blocked") return risk;
    if (this.paused && risk.level !== "low") {
      return block(risk, "MiniClaw is paused (/panic). Send /resume to allow actions again");
    }
    const limit = this.budgets[tool];
    if (limit !== undefined && this.usedToday(tool, now) >= limit) {
      return block(risk, `the daily limit of ${limit} ${tool} actions is used up (raise agent.budgets.${tool} in the config)`);
    }
    return risk;
  }
}

function block(risk: Risk, reason: string): Risk {
  return { ...risk, level: "blocked", reasons: [...risk.reasons, reason], sessionApprovable: false };
}
