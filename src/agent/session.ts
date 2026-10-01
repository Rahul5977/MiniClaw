import type { ChatMessage } from "../llm/provider.ts";

export type TurnMessage = Exclude<ChatMessage, { role: "system" }>;

/**
 * In-memory conversation (persisted to SQLite in Phase 3). Stored as whole
 * turns — a user message plus the assistant replies and tool results it led to —
 * so trimming never separates a tool call from its result.
 */
export class Session {
  private turns: TurnMessage[][] = [];

  constructor(
    private systemPrompt: string,
    /** Soft cap on messages kept; the latest turn is always kept in full. */
    private historyLimit: number,
  ) {}

  messages(): ChatMessage[] {
    return [{ role: "system", content: this.systemPrompt }, ...this.turns.flat()];
  }

  addTurn(messages: TurnMessage[]): void {
    if (messages[0]?.role !== "user") throw new Error("A turn must start with a user message");
    this.turns.push(messages);
    while (this.turns.length > 1 && this.length > this.historyLimit) this.turns.shift();
  }

  reset(): void {
    this.turns = [];
  }

  get length(): number {
    return this.turns.reduce((n, turn) => n + turn.length, 0);
  }
}
