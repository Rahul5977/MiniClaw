import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Schema migrations, applied in order. Never edit a released migration;
 * append a new one. PRAGMA user_version records how many have run.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE sessions (
    id          TEXT PRIMARY KEY,          -- e.g. 'cli:3f9a1c2b'
    channel     TEXT NOT NULL,             -- 'cli' | 'telegram' | 'web'
    title       TEXT,                      -- first user message, for listings
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE messages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    turn          INTEGER NOT NULL,        -- messages of one user turn share a number
    role          TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
    content       TEXT NOT NULL,
    tool_calls    TEXT,                    -- JSON array, assistant only
    tool_call_id  TEXT,                    -- tool only
    created_at    INTEGER NOT NULL
  );
  CREATE INDEX messages_by_session ON messages(session_id, turn, id);

  CREATE TABLE audit_log (
    id           TEXT PRIMARY KEY,
    session_id   TEXT,
    tool         TEXT NOT NULL,
    summary      TEXT NOT NULL,
    args         TEXT NOT NULL,            -- JSON, secrets redacted
    risk         TEXT NOT NULL,
    reasons      TEXT NOT NULL,            -- JSON array
    verdict      TEXT NOT NULL,            -- auto | session | plan | approved | denied | blocked
    ok           INTEGER NOT NULL,
    duration_ms  INTEGER NOT NULL,
    result       TEXT NOT NULL,            -- first 500 chars, secrets redacted
    created_at   INTEGER NOT NULL
  );
  CREATE INDEX audit_by_time ON audit_log(created_at);

  CREATE TABLE memory_inbox (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    fact               TEXT NOT NULL,
    session_id         TEXT,
    expires_at         INTEGER,           -- NULL = permanent
    untrusted_sources  TEXT NOT NULL,     -- JSON array: untrusted content read before the proposal (I-5)
    status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
    created_at         INTEGER NOT NULL,
    decided_at         INTEGER
  );
  `,
];

export function openDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");
  migrate(db);
  return db;
}

function migrate(db: Database): void {
  const { user_version: version } = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!;
  if (version > MIGRATIONS.length) {
    throw new Error(`Database is from a newer MiniClaw (schema v${version}). Please update MiniClaw.`);
  }
  for (let i = version; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]!);
      db.exec(`PRAGMA user_version = ${i + 1}`);
    })();
  }
}
