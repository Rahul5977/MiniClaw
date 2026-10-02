import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { today } from "./facts.ts";

/** A plain-Markdown log per day (notes/2026-10-02.md): what was asked and what was done. */
export class DailyNotes {
  constructor(readonly dir: string) {}

  private path(date: string): string {
    return join(this.dir, `${date}.md`);
  }

  append(entry: string, now = new Date()): void {
    const date = today(now);
    const path = this.path(date);
    mkdirSync(this.dir, { recursive: true });
    const time = now.toTimeString().slice(0, 5);
    const header = existsSync(path) ? "" : `# ${date}\n\n`;
    appendFileSync(path, `${header}- ${time} ${entry.replace(/\s+/g, " ").trim()}\n`);
  }

  read(date: string): string | null {
    const path = this.path(date);
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  }
}
