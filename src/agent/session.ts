import type { ChatMessage } from "../llm/provider.ts";

type Turn = Extract<ChatMessage, { role: "user" | "assistant" }>;

/** In-memory conversation. Persisted to SQLite in Phase 3. */
export class Session {
  private turns: Turn[] = [];

  constructor(
    private systemPrompt: string,
    private historyLimit: number,
  ) {}

  /** Messages to send to the LLM: system prompt + the most recent turns. */
  messages(): ChatMessage[] {
    return [{ role: "system", content: this.systemPrompt }, ...this.turns];
  }

  add(turn: Turn): void {
    this.turns.push(turn);
    // Drop whole old turns so the window never starts with an orphaned assistant reply.
    while (this.turns.length > this.historyLimit || this.turns[0]?.role === "assistant") {
      this.turns.shift();
    }
  }

  /** Remove the last user message, e.g. when the reply to it failed. */
  popUser(): void {
    if (this.turns.at(-1)?.role === "user") this.turns.pop();
  }

  reset(): void {
    this.turns = [];
  }

  get length(): number {
    return this.turns.length;
  }
}

export function defaultSystemPrompt(agentName: string): string {
  const today = new Date().toDateString();
  return [
    `You are ${agentName}, a helpful personal AI assistant running locally on the user's computer.`,
    "Be concise and friendly. If you are not sure about something, say so instead of guessing.",
    `Today is ${today}.`,
  ].join("\n");
}
