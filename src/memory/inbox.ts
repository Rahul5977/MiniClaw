import type { Database } from "bun:sqlite";
import { cleanFact, type Fact, type FactStore } from "./facts.ts";

export interface Proposal {
  id: number;
  fact: string;
  sessionId: string | null;
  expires?: string;
  /** Untrusted content (web pages, files) read in the same turn, before the proposal. */
  untrustedSources: string[];
  createdAt: number;
}

interface Row {
  id: number;
  fact: string;
  session_id: string | null;
  expires_at: string | null;
  untrusted_sources: string;
  created_at: number;
}

/**
 * I-5: The agent can only *propose* memories. Nothing reaches MEMORY.md until the
 * user accepts it, so injected text can't plant fake "facts" about the user.
 */
export class MemoryInbox {
  constructor(
    private db: Database,
    private facts: FactStore,
  ) {}

  /** Returns null if the fact is already known or already waiting for review. */
  propose(input: { fact: string; sessionId?: string; expires?: string; untrustedSources?: string[] }): Proposal | null {
    const fact = cleanFact(input.fact);
    const known = (f: string) => f.trim().toLowerCase() === fact.toLowerCase();
    if (this.facts.all().some((f) => known(f.text)) || this.pending().some((p) => known(p.fact))) return null;

    const row = this.db
      .query<Row, [string, string | null, string | null, string, number]>(
        `INSERT INTO memory_inbox (fact, session_id, expires_at, untrusted_sources, created_at)
         VALUES (?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(fact, input.sessionId ?? null, input.expires ?? null, JSON.stringify(input.untrustedSources ?? []), Date.now())!;
    return fromRow(row);
  }

  pending(sessionId?: string): Proposal[] {
    const rows = sessionId
      ? this.db.query<Row, [string]>("SELECT * FROM memory_inbox WHERE status = 'pending' AND session_id = ? ORDER BY id").all(sessionId)
      : this.db.query<Row, []>("SELECT * FROM memory_inbox WHERE status = 'pending' ORDER BY id").all();
    return rows.map(fromRow);
  }

  accept(id: number): Fact | null {
    const proposal = this.decide(id, "accepted");
    return proposal ? this.facts.add(proposal.fact, proposal.expires) : null;
  }

  reject(id: number): boolean {
    return this.decide(id, "rejected") !== null;
  }

  private decide(id: number, status: "accepted" | "rejected"): Proposal | null {
    const row = this.db
      .query<Row, [string, number, number]>(
        "UPDATE memory_inbox SET status = ?, decided_at = ? WHERE id = ? AND status = 'pending' RETURNING *",
      )
      .get(status, Date.now(), id);
    return row ? fromRow(row) : null;
  }
}

function fromRow(row: Row): Proposal {
  return {
    id: row.id,
    fact: row.fact,
    sessionId: row.session_id,
    expires: row.expires_at ?? undefined,
    untrustedSources: JSON.parse(row.untrusted_sources) as string[],
    createdAt: row.created_at,
  };
}
