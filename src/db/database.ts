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
  `
  -- I-6: which version of each skill the user approved, and with which permissions.
  CREATE TABLE skill_grants (
    name         TEXT NOT NULL,
    hash         TEXT NOT NULL,             -- hash of SKILL.md; a changed file needs new consent
    permissions  TEXT NOT NULL,             -- JSON array, as approved
    granted_at   INTEGER NOT NULL,
    PRIMARY KEY (name, hash)
  );
  `,
  `
  -- Phase 5: chat apps. Each Telegram/WhatsApp chat has its own current session.
  ALTER TABLE sessions ADD COLUMN chat_id TEXT;
  CREATE INDEX sessions_by_chat ON sessions(channel, chat_id, updated_at);

  CREATE TABLE reminders (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL,             -- delivered to the chat this session belongs to
    text        TEXT NOT NULL,
    due_at      INTEGER NOT NULL,
    repeat      TEXT CHECK (repeat IN ('daily', 'weekly')),
    status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'cancelled')),
    created_at  INTEGER NOT NULL,
    sent_at     INTEGER
  );
  CREATE INDEX reminders_due ON reminders(status, due_at);
  `,
  `
  -- I-8: flight recorder. One row per agent run plus its timeline of events.
  CREATE TABLE runs (
    id             TEXT PRIMARY KEY,
    session_id     TEXT NOT NULL,
    model          TEXT NOT NULL,
    user_text      TEXT NOT NULL,
    context        TEXT NOT NULL,           -- JSON: messages at the first step (for replay), secrets redacted
    tools          TEXT NOT NULL,           -- JSON: tool schemas offered to the model
    status         TEXT NOT NULL DEFAULT 'running'
                   CHECK (status IN ('running', 'done', 'stopped', 'error', 'step_limit')),
    steps          INTEGER NOT NULL DEFAULT 0,
    tool_calls     INTEGER NOT NULL DEFAULT 0,
    prompt_tokens  INTEGER NOT NULL DEFAULT 0,  -- estimated, summed over steps
    error          TEXT,
    started_at     INTEGER NOT NULL,
    ended_at       INTEGER
  );
  CREATE INDEX runs_by_time ON runs(started_at);

  CREATE TABLE run_events (
    id      INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id  TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    at      INTEGER NOT NULL,                 -- milliseconds since the run started
    type    TEXT NOT NULL CHECK (type IN ('llm', 'tool', 'notice')),
    data    TEXT NOT NULL                     -- JSON, secrets redacted
  );
  CREATE INDEX run_events_by_run ON run_events(run_id, id);
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
