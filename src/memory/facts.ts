import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface Fact {
  /** Derived from the text, so hand-written facts get stable ids too. */
  id: string;
  text: string;
  /** YYYY-MM-DD */
  added?: string;
  /** YYYY-MM-DD, last day the fact is true. */
  expires?: string;
}

const HEADER = `# Memory

Things MiniClaw knows about you. It only adds facts you have confirmed.
You can edit this file: one fact per line, starting with "- ".
The hidden <!-- ... --> part is optional metadata (date added, expiry date).
`;

const FACT_LINE = /^\s*[-*]\s+(.+?)\s*(?:<!--(.*?)-->)?\s*$/;

export function today(now = new Date()): string {
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function factId(text: string): string {
  return Bun.hash(text.trim().toLowerCase()).toString(36).slice(0, 6);
}

/** Keeps a fact on one line and stops it from injecting a metadata comment. */
export function cleanFact(text: string): string {
  return text.replace(/<!--|-->/g, "").replace(/\s+/g, " ").trim();
}

function parseLine(line: string): Fact | null {
  const match = FACT_LINE.exec(line);
  if (!match) return null;
  const text = match[1]!;
  const meta = Object.fromEntries(
    (match[2] ?? "")
      .trim()
      .split(/\s+/)
      .filter((pair) => pair.includes(":"))
      .map((pair) => [pair.slice(0, pair.indexOf(":")), pair.slice(pair.indexOf(":") + 1)]),
  );
  return { id: factId(text), text, added: meta.added, expires: meta.expires };
}

function formatLine(fact: Omit<Fact, "id">): string {
  const meta = [fact.added && `added:${fact.added}`, fact.expires && `expires:${fact.expires}`].filter(Boolean).join(" ");
  return `- ${fact.text}${meta ? ` <!-- ${meta} -->` : ""}`;
}

/**
 * Long-term memory as a human-readable, hand-editable Markdown file (MEMORY.md).
 * Lines that aren't facts (headings, notes) are left untouched.
 */
export class FactStore {
  constructor(readonly path: string) {}

  private read(): string[] {
    return existsSync(this.path) ? readFileSync(this.path, "utf8").split("\n") : HEADER.split("\n");
  }

  private write(lines: string[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, lines.join("\n").replace(/\n*$/, "\n"));
  }

  /** Facts still valid today. */
  all(now = new Date()): Fact[] {
    const date = today(now);
    return this.read()
      .map(parseLine)
      .filter((f): f is Fact => f !== null && (!f.expires || f.expires >= date));
  }

  add(text: string, expires?: string, now = new Date()): Fact {
    const clean = cleanFact(text);
    const existing = this.all(now).find((f) => f.id === factId(clean));
    if (existing) return existing;
    const fact = { text: clean, added: today(now), expires };
    this.write([...this.read(), formatLine(fact)]);
    return { id: factId(clean), ...fact };
  }

  /** Removes facts by id. Returns the removed facts. */
  remove(ids: string[]): Fact[] {
    const removed: Fact[] = [];
    const lines = this.read().filter((line) => {
      const fact = parseLine(line);
      if (fact && ids.includes(fact.id)) {
        removed.push(fact);
        return false;
      }
      return true;
    });
    if (removed.length) this.write(lines);
    return removed;
  }

  /** Deletes expired facts from the file. Returns them. */
  removeExpired(now = new Date()): Fact[] {
    const date = today(now);
    const expired = this.read()
      .map(parseLine)
      .filter((f): f is Fact => f !== null && !!f.expires && f.expires < date);
    return this.remove(expired.map((f) => f.id));
  }

  /** Facts containing every word of the query (case-insensitive). */
  search(query: string, now = new Date()): Fact[] {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return this.all(now).filter((f) => words.every((w) => f.text.toLowerCase().includes(w)));
  }
}
