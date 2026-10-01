// The "tool" role (with tool_call_id) arrives with tool calling in Phase 2.
export type Role = "system" | "user" | "assistant";

// A union per role (not { role: Role }) so it matches the OpenAI SDK's message types.
export type ChatMessage = { [R in Role]: { role: R; content: string } }[Role];

export interface ChatOptions {
  model?: string;
  temperature?: number;
  signal?: AbortSignal;
}

/**
 * Anything that can hold a conversation. Tool calling is added to this
 * interface in Phase 2; channels and the agent loop only depend on it.
 */
export interface LLMProvider {
  readonly model: string;
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
  stream(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<string>;
}
