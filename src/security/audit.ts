import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
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

/** Append-only JSON Lines log of every tool call. Moves to SQLite in Phase 3. */
export class AuditLog {
  private counter = 0;

  constructor(private path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  nextId(): string {
    return `${Date.now().toString(36)}-${(this.counter++).toString(36)}`;
  }

  record(entry: Omit<AuditEntry, "time">): void {
    const line = redact(JSON.stringify({ time: new Date().toISOString(), ...entry, result: entry.result.slice(0, 500) }));
    appendFileSync(this.path, line + "\n");
  }
}
