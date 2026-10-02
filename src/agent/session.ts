import type { SessionStore } from "../db/sessions.ts";
import type { ChatMessage } from "../llm/provider.ts";

export type TurnMessage = Exclude<ChatMessage, { role: "system" }>;

export interface SessionOptions {
  id: string;
  /** Rebuilt for every request, so newly confirmed memories show up immediately. */
  systemPrompt: () => string;
  /** Soft cap on messages kept in context; the latest turn is always kept. */
  historyLimit: number;
  /** Where turns are saved. Without a store the session lives only in memory (tests). */
  store?: SessionStore;
}

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

  messages(): ChatMessage[] {
    const kept: TurnMessage[][] = [];
    let count = 0;
    for (let i = this.turns.length - 1; i >= 0; i--) {
      const turn = this.turns[i]!;
      if (kept.length > 0 && count + turn.length > this.options.historyLimit) break;
      kept.unshift(turn);
      count += turn.length;
    }
    return [{ role: "system", content: this.options.systemPrompt() }, ...kept.flat()];
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
