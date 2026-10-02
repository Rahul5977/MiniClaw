import type { SessionStore } from "../db/sessions.ts";
import type { ChatMessage } from "../llm/provider.ts";
import { messagesTokens } from "./tokens.ts";

export type TurnMessage = Exclude<ChatMessage, { role: "system" }>;

export interface SessionOptions {
  id: string;
  /** Rebuilt for every request, so newly confirmed memories show up immediately. */
  systemPrompt: () => string;
  /** Where turns are saved. Without a store the session lives only in memory (tests). */
  store?: SessionStore;
}

const TRIMMED = "[older output removed to fit the context window]";

/**
 * A conversation, stored as whole turns — a user message plus the assistant replies
 * and tool results it led to — so trimming never separates a tool call from its result.
 */
export class Session {
  readonly id: string;
  private turns: TurnMessage[][];

  constructor(private options: SessionOptions) {
    this.id = options.id;
    this.turns = options.store?.load(options.id) ?? [];
  }

  /**
   * Messages for the next LLM request within `budget` tokens: the system prompt,
   * the in-progress turn, then as many earlier turns as fit (newest first).
   * If the in-progress turn alone is too big, its oldest tool outputs are shortened.
   */
  context(pending: TurnMessage[], budget: number): ChatMessage[] {
    const system: ChatMessage = { role: "system", content: this.options.systemPrompt() };
    const current = compactTurn(pending, budget - messagesTokens([system]));
    let used = messagesTokens([system, ...current]);

    const history: TurnMessage[][] = [];
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const cost = messagesTokens(this.turns[i]!);
      if (used + cost > budget) break;
      history.unshift(this.turns[i]!);
      used += cost;
    }
    return [system, ...history.flat(), ...current];
  }

  addTurn(messages: TurnMessage[]): void {
    if (messages[0]?.role !== "user") throw new Error("A turn must start with a user message");
    this.turns.push(messages);
    this.options.store?.appendTurn(this.id, messages);
  }

  get turnCount(): number {
    return this.turns.length;
  }
}

/** Shortens the oldest tool results of a turn until it fits, keeping the newest one intact. */
function compactTurn(turn: TurnMessage[], budget: number): TurnMessage[] {
  const out = [...turn];
  for (let i = 0; i < out.length - 1 && messagesTokens(out) > budget; i++) {
    const m = out[i]!;
    if (m.role === "tool" && m.content !== TRIMMED) out[i] = { ...m, content: TRIMMED };
  }
  return out;
}
