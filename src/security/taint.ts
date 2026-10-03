import type { ChatMessage } from "../llm/provider.ts";
import type { Risk } from "../tools/tool.ts";
import { maxLevel } from "./risk.ts";

/**
 * I-3: Taint tracking against prompt injection.
 *
 * Text that came from outside (web pages, files: everything inside <untrusted> tags) is
 * remembered for the turn. When a tool call's arguments reuse that text, the call is
 * treated as possibly injected. Following CaMeL's split between control and data flow:
 *
 * - control arguments decide WHAT happens (a shell command, a URL, a file path):
 *   tainted → high risk, always asks, with a warning naming the source;
 * - data arguments are carried along (file content, reminder text): copying is normal
 *   (a summary quotes its source), so tainted → never pre-approved (no "always allow"
 *   or plan approval) and the approval names the source.
 *
 * Text the user typed is trusted even if a page contains it too.
 */

/** Arguments that are data, per tool. Every other string argument is control. */
const DATA_ARGS: Record<string, string[]> = {
  write_file: ["content"],
  set_reminder: ["text"],
};
/** Tools whose taint is handled elsewhere (remember: the memory inbox, I-5). */
const EXEMPT = new Set(["remember"]);

/** Shingle size: matching works on runs of 16-character windows. */
const K = 16;
/** A run of reused text this long counts as copied. */
const MIN_COPIED = 24;
/** A whole argument this long that appears verbatim in untrusted text counts too (short commands, URLs). */
const MIN_WHOLE = 8;
const MAX_SOURCE_CHARS = 50_000;

export interface Taint {
  source: string;
  snippet: string;
  argument: string;
  control: boolean;
}

interface Source {
  name: string;
  text: string;
  shingles: Set<string>;
}

const normalize = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

const UNTRUSTED_BLOCK = /<untrusted source="([^"]+)">\n?([\s\S]*?)\n?<\/untrusted>/g;

export class TaintTracker {
  private sources: Source[] = [];
  private trusted: string;

  constructor(userText: string) {
    this.trusted = normalize(userText);
  }

  /** Seeds the tracker from tool results already in the conversation (earlier turns). */
  addHistory(messages: ChatMessage[]): void {
    for (const m of messages) {
      if (m.role === "tool") this.addOutput(m.content);
      if (m.role === "user") this.trusted += ` ${normalize(m.content)}`;
    }
  }

  /** Records every <untrusted> block in a tool's output. */
  addOutput(output: string): void {
    for (const match of output.matchAll(UNTRUSTED_BLOCK)) this.add(match[1]!, match[2]!);
  }

  add(name: string, raw: string): void {
    const text = normalize(raw).slice(0, MAX_SOURCE_CHARS);
    const shingles = new Set<string>();
    for (let i = 0; i + K <= text.length; i++) shingles.add(text.slice(i, i + K));
    this.sources.push({ name, text, shingles });
  }

  get size(): number {
    return this.sources.length;
  }

  /** The first reuse of untrusted text in a call's string arguments, control arguments first. */
  find(tool: string, args: unknown): Taint | null {
    if (EXEMPT.has(tool) || this.sources.length === 0 || !args || typeof args !== "object") return null;
    const data = DATA_ARGS[tool] ?? [];
    const entries = Object.entries(args as Record<string, unknown>).filter(([, v]) => typeof v === "string") as [string, string][];
    entries.sort(([a], [b]) => Number(data.includes(a)) - Number(data.includes(b)));

    for (const [argument, value] of entries) {
      const snippet = this.copied(normalize(value));
      if (snippet) {
        const source = this.sources.find((s) => s.text.includes(snippet))?.name ?? "untrusted content";
        return { source, snippet, argument, control: !data.includes(argument) };
      }
    }
    return null;
  }

  /** Longest stretch of `value` that appears in an untrusted source and not in the user's own words. */
  private copied(value: string): string | null {
    if (value.length < MIN_WHOLE) return null;
    let best = "";
    for (const source of this.sources) {
      if (value.length < K) {
        if (source.text.includes(value)) best = value.length > best.length ? value : best;
        continue;
      }
      // Longest run of consecutive shingles of `value` that the source also contains.
      let runStart = -1;
      for (let i = 0; i + K <= value.length + 1; i++) {
        const hit = i + K <= value.length && source.shingles.has(value.slice(i, i + K));
        if (hit && runStart < 0) runStart = i;
        if (!hit && runStart >= 0) {
          const run = value.slice(runStart, i - 1 + K);
          if (run.length > best.length) best = run;
          runStart = -1;
        }
      }
      if (value.length <= 200 && source.text.includes(value) && value.length > best.length) best = value;
    }
    if (best.length < Math.min(MIN_COPIED, value.length)) return null;
    if (this.trusted.includes(best)) return null; // the user said it themselves
    return best;
  }
}

/** Applies a taint to a call's risk (see the module comment for the rules). */
export function applyTaint(risk: Risk, taint: Taint | null): Risk {
  if (!taint || risk.level === "blocked") return risk;
  const snippet = taint.snippet.length > 80 ? `${taint.snippet.slice(0, 77)}…` : taint.snippet;
  if (taint.control) {
    return {
      ...risk,
      level: maxLevel(risk.level, "high"),
      reasons: [...risk.reasons, `⚠ its ${taint.argument} comes from ${taint.source}: "${snippet}" — possible prompt injection`],
      sessionApprovable: false,
      tainted: "control",
    };
  }
  return {
    ...risk,
    level: maxLevel(risk.level, "medium"),
    reasons: [...risk.reasons, `its ${taint.argument} includes text from ${taint.source}: "${snippet}" — check it before approving`],
    sessionApprovable: false,
    tainted: "data",
  };
}
