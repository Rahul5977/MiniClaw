import type { Database } from "bun:sqlite";
import type { ToolCall } from "../llm/provider.ts";
import type { TurnMessage } from "../agent/session.ts";

interface MessageRow {
  turn: number;
  role: TurnMessage["role"];
  content: string;
  tool_calls: string | null;
  tool_call_id: string | null;
}

export interface SessionInfo {
  id: string;
  title: string | null;
  updatedAt: number;
}

/** Conversations in SQLite. A session is a list of turns; each turn is a list of messages. */
export class SessionStore {
  constructor(private db: Database) {}

  create(channel: string): string {
    const id = `${channel}:${crypto.randomUUID().slice(0, 8)}`;
    const now = Date.now();
    this.db
      .query("INSERT INTO sessions (id, channel, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(id, channel, now, now);
    return id;
  }

  /** Most recently used session of a channel. */
  latest(channel: string): SessionInfo | null {
    const row = this.db
      .query<{ id: string; title: string | null; updated_at: number }, [string]>(
        "SELECT id, title, updated_at FROM sessions WHERE channel = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1",
      )
      .get(channel);
    return row ? { id: row.id, title: row.title, updatedAt: row.updated_at } : null;
  }

  /** The last `maxTurns` turns, oldest first. */
  load(sessionId: string, maxTurns = 200): TurnMessage[][] {
    const rows = this.db
      .query<MessageRow, [string, string, number]>(
        `SELECT turn, role, content, tool_calls, tool_call_id FROM messages
         WHERE session_id = ? AND turn >= (SELECT COALESCE(MAX(turn), 0) FROM messages WHERE session_id = ?) - ? + 1
         ORDER BY turn, id`,
      )
      .all(sessionId, sessionId, maxTurns);

    const turns = new Map<number, TurnMessage[]>();
    for (const row of rows) {
      const turn = turns.get(row.turn) ?? [];
      turn.push(fromRow(row));
      turns.set(row.turn, turn);
    }
    return [...turns.values()];
  }

  appendTurn(sessionId: string, messages: TurnMessage[]): void {
    const now = Date.now();
    const insert = this.db.query(
      "INSERT INTO messages (session_id, turn, role, content, tool_calls, tool_call_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    this.db.transaction(() => {
      const { next } = this.db
        .query<{ next: number }, [string]>("SELECT COALESCE(MAX(turn), -1) + 1 AS next FROM messages WHERE session_id = ?")
        .get(sessionId)!;
      for (const m of messages) {
        insert.run(
          sessionId,
          next,
          m.role,
          m.content,
          m.role === "assistant" && m.toolCalls?.length ? JSON.stringify(m.toolCalls) : null,
          m.role === "tool" ? m.toolCallId : null,
          now,
        );
      }
      const title = messages[0]?.role === "user" ? messages[0].content.slice(0, 80) : null;
      this.db.query("UPDATE sessions SET updated_at = ?, title = COALESCE(title, ?) WHERE id = ?").run(now, title, sessionId);
    })();
  }
}

function fromRow(row: MessageRow): TurnMessage {
  switch (row.role) {
    case "user":
      return { role: "user", content: row.content };
    case "tool":
      return { role: "tool", toolCallId: row.tool_call_id ?? "", content: row.content };
    case "assistant":
      return row.tool_calls
        ? { role: "assistant", content: row.content, toolCalls: JSON.parse(row.tool_calls) as ToolCall[] }
        : { role: "assistant", content: row.content };
  }
}
