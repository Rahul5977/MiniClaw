import type { Database } from "bun:sqlite";

export type Repeat = "daily" | "weekly";

export interface Reminder {
  id: number;
  sessionId: string;
  text: string;
  dueAt: number;
  repeat: Repeat | null;
}

interface Row {
  id: number;
  session_id: string;
  text: string;
  due_at: number;
  repeat: Repeat | null;
}

const DAY = 24 * 60 * 60 * 1000;

/**
 * Turns the model's "when" into a timestamp. Small models handle these two forms well:
 * in_minutes (relative) or at = "HH:MM" / "YYYY-MM-DD HH:MM" in local time.
 * "HH:MM" that already passed today means tomorrow.
 */
export function resolveWhen(when: { in_minutes?: number; at?: string }, now = new Date()): number | string {
  if (when.in_minutes !== undefined && when.at) return "Give either in_minutes or at, not both.";
  if (when.in_minutes !== undefined) return now.getTime() + when.in_minutes * 60_000;
  if (!when.at) return "Give in_minutes (e.g. 30) or at (e.g. \"18:00\" or \"2026-10-03 09:30\").";

  const match = /^(?:(\d{4})-(\d{2})-(\d{2})[ T])?(\d{1,2}):(\d{2})$/.exec(when.at.trim());
  if (!match) return `Could not understand at="${when.at}". Use "HH:MM" or "YYYY-MM-DD HH:MM" (24-hour, local time).`;
  const [, y, mo, d, h, mi] = match;
  const due = new Date(now);
  if (y) due.setFullYear(Number(y), Number(mo) - 1, Number(d));
  due.setHours(Number(h), Number(mi), 0, 0);
  if (Number(h) > 23 || Number(mi) > 59 || Number.isNaN(due.getTime())) return `"${when.at}" is not a valid time.`;
  if (due.getTime() <= now.getTime()) {
    if (y) return `${when.at} is in the past.`;
    due.setDate(due.getDate() + 1);
  }
  return due.getTime();
}

export function formatDue(time: number): string {
  return new Date(time).toLocaleString("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export class ReminderStore {
  constructor(private db: Database) {}

  add(input: { sessionId: string; text: string; dueAt: number; repeat?: Repeat | null }): Reminder {
    const row = this.db
      .query<Row, [string, string, number, Repeat | null, number]>(
        "INSERT INTO reminders (session_id, text, due_at, repeat, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *",
      )
      .get(input.sessionId, input.text.replace(/\s+/g, " ").trim(), input.dueAt, input.repeat ?? null, Date.now())!;
    return fromRow(row);
  }

  /** Pending reminders, soonest first. */
  pending(): Reminder[] {
    return this.db.query<Row, []>("SELECT * FROM reminders WHERE status = 'pending' ORDER BY due_at").all().map(fromRow);
  }

  due(now = Date.now()): Reminder[] {
    return this.db
      .query<Row, [number]>("SELECT * FROM reminders WHERE status = 'pending' AND due_at <= ? ORDER BY due_at")
      .all(now)
      .map(fromRow);
  }

  /** One-off reminders are done; repeating ones move to their next time in the future. */
  markDelivered(reminder: Reminder, now = Date.now()): void {
    if (!reminder.repeat) {
      this.db.query("UPDATE reminders SET status = 'sent', sent_at = ? WHERE id = ?").run(now, reminder.id);
      return;
    }
    const step = reminder.repeat === "daily" ? DAY : 7 * DAY;
    let next = reminder.dueAt + step;
    while (next <= now) next += step; // skip occurrences missed while the gateway was off
    this.db.query("UPDATE reminders SET due_at = ?, sent_at = ? WHERE id = ?").run(next, now, reminder.id);
  }

  cancel(id: number): Reminder | null {
    const row = this.db
      .query<Row, [number]>("UPDATE reminders SET status = 'cancelled' WHERE id = ? AND status = 'pending' RETURNING *")
      .get(id);
    return row ? fromRow(row) : null;
  }
}

function fromRow(row: Row): Reminder {
  return { id: row.id, sessionId: row.session_id, text: row.text, dueAt: row.due_at, repeat: row.repeat };
}
