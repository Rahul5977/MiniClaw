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

  /**
   * Returns null if the fact is already known. A fact that is already waiting for
   * review is brought forward (with the new context) so the user is asked again now.
   */
  propose(input: { fact: string; sessionId?: string; expires?: string; untrustedSources?: string[] }): Proposal | null {
    const fact = cleanFact(input.fact);
    const same = (f: string) => f.trim().toLowerCase() === fact.toLowerCase();
    if (this.facts.all().some((f) => same(f.text))) return null;

    const waiting = this.pending().find((p) => same(p.fact));
    if (waiting) {
      const row = this.db
        .query<Row, [string | null, string | null, string, number, number]>(
          "UPDATE memory_inbox SET session_id = ?, expires_at = ?, untrusted_sources = ?, created_at = ? WHERE id = ? RETURNING *",
        )
        .get(
          input.sessionId ?? null,
          input.expires ?? null,
          JSON.stringify([...new Set([...waiting.untrustedSources, ...(input.untrustedSources ?? [])])]),
          Date.now(),
          waiting.id,
        )!;
      return fromRow(row);
    }

    const row = this.db
      .query<Row, [string, string | null, string | null, string, number]>(
        `INSERT INTO memory_inbox (fact, session_id, expires_at, untrusted_sources, created_at)
         VALUES (?, ?, ?, ?, ?) RETURNING *`,
      )
      .get(fact, input.sessionId ?? null, input.expires ?? null, JSON.stringify(input.untrustedSources ?? []), Date.now())!;
    return fromRow(row);
  }

  /** Pending proposals, optionally only those made (or re-made) since a time. */
  pending(since = 0): Proposal[] {
    return this.db
      .query<Row, [number]>("SELECT * FROM memory_inbox WHERE status = 'pending' AND created_at >= ? ORDER BY created_at, id")
      .all(since)
      .map(fromRow);
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
