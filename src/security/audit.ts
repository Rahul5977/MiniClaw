import type { Database } from "bun:sqlite";
import type { RiskLevel } from "../tools/tool.ts";
import type { Verdict } from "./approvals.ts";

export interface AuditEntry {
  id: string;
  time: string;
  session: string;
  tool: string;
  summary: string;
  args: unknown;
  risk: RiskLevel;
  reasons: string[];
  verdict: Verdict;
  ok: boolean;
  durationMs: number;
  result: string;
}

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic style keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access keys
  /\bxox[abpr]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g, // Telegram bot tokens
  /(bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
];

/** Values of env vars that look like secrets, so they are redacted even without a known format. */
function secretEnvValues(): string[] {
  return Object.entries(process.env)
    .filter(([name, value]) => /KEY|TOKEN|SECRET|PASSWORD/i.test(name) && value && value.length >= 8)
    .map(([, value]) => value as string);
}

export function redact(text: string): string {
  let out = text;
  for (const value of secretEnvValues()) out = out.replaceAll(value, "[REDACTED]");
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, (match, prefix?: string) =>
      typeof prefix === "string" && /bearer/i.test(prefix) ? `${prefix}[REDACTED]` : "[REDACTED]",
    );
  }
  return out;
}

/** Append-only log of every tool call, stored in SQLite (audit_log table). */
export class AuditLog {
  private counter = 0;

  constructor(private db: Database) {}

  nextId(): string {
    return `${Date.now().toString(36)}-${(this.counter++).toString(36)}`;
  }

  record(entry: Omit<AuditEntry, "time">): void {
    this.db
      .query(
        `INSERT INTO audit_log (id, session_id, tool, summary, args, risk, reasons, verdict, ok, duration_ms, result, created_at)
         VALUES ($id, $session, $tool, $summary, $args, $risk, $reasons, $verdict, $ok, $duration, $result, $time)`,
      )
      .run({
        id: entry.id,
        session: entry.session,
        tool: entry.tool,
        summary: redact(entry.summary),
        args: redact(JSON.stringify(entry.args)),
        risk: entry.risk,
        reasons: JSON.stringify(entry.reasons),
        verdict: entry.verdict,
        ok: entry.ok ? 1 : 0,
        duration: entry.durationMs,
        result: redact(entry.result.slice(0, 500)),
        time: Date.now(),
      });
  }

  /** Newest first. */
  recent(limit = 50): AuditEntry[] {
    type Row = Record<string, string | number | null>;
    return this.db
      .query<Row, [number]>("SELECT * FROM audit_log ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(limit)
      .map((r) => ({
        id: String(r.id),
        time: new Date(Number(r.created_at)).toISOString(),
        session: String(r.session_id),
        tool: String(r.tool),
        summary: String(r.summary),
        args: JSON.parse(String(r.args)),
        risk: r.risk as RiskLevel,
        reasons: JSON.parse(String(r.reasons)),
        verdict: r.verdict as Verdict,
        ok: r.ok === 1,
        durationMs: Number(r.duration_ms),
        result: String(r.result),
      }));
  }
}
