export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string from the model; may be malformed, so tools must validate it. */
  arguments: string;
}

export type ChatMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

/** A tool as the LLM sees it: name, description and JSON Schema for its arguments. */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  tools?: ToolSchema[];
  /** Ask for a JSON object reply (used for plan generation). */
  json?: boolean;
  signal?: AbortSignal;
}

export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "tool_calls"; calls: ToolCall[] };

export interface LLMResponse {
  text: string;
  toolCalls: ToolCall[];
}

/**
 * Anything that can hold a conversation and call tools. Channels and the
 * agent loop only depend on this interface, never on a vendor SDK.
 */
export interface LLMProvider {
  readonly model: string;
  /** Streams text deltas, then (if the model wants tools) one tool_calls event at the end. */
  stream(messages: ChatMessage[], options?: ChatOptions): AsyncIterable<StreamEvent>;
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<LLMResponse>;
}

/** Collects a stream into a single response. */
export async function collect(events: AsyncIterable<StreamEvent>): Promise<LLMResponse> {
  let text = "";
  let toolCalls: ToolCall[] = [];
  for await (const event of events) {
    if (event.type === "text") text += event.delta;
    else toolCalls = event.calls;
  }
  return { text, toolCalls };
}
