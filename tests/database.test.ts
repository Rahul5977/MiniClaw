import { expect, test } from "bun:test";
import { openDatabase } from "../src/db/database.ts";

test("migrations create the schema and set the version", () => {
  const db = openDatabase(":memory:");
  const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all();
  expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(["audit_log", "memory_inbox", "messages", "reminders", "run_events", "runs", "sessions", "skill_grants"]));
  expect(db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(4);
});

test("deleting a session deletes its messages", () => {
  const db = openDatabase(":memory:");
  db.run("INSERT INTO sessions (id, channel, created_at, updated_at) VALUES ('s', 'cli', 0, 0)");
  db.run("INSERT INTO messages (session_id, turn, role, content, created_at) VALUES ('s', 0, 'user', 'hi', 0)");
  db.run("DELETE FROM sessions WHERE id = 's'");
  expect(db.query("SELECT * FROM messages").all()).toHaveLength(0);
});
