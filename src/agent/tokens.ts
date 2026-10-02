import type { ChatMessage, ToolSchema } from "../llm/provider.ts";

/**
 * Rough token count. Real tokenizers differ per model; ~3.5 characters per token
 * is a slightly pessimistic average for English text and code, which is what
 * we want when the alternative is silently overflowing the context window.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

const PER_MESSAGE_OVERHEAD = 4;

export function messageTokens(message: ChatMessage): number {
  let text = message.content;
  if (message.role === "assistant") for (const call of message.toolCalls ?? []) text += call.name + call.arguments;
  return estimateTokens(text) + PER_MESSAGE_OVERHEAD;
}

export function messagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, m) => sum + messageTokens(m), 0);
}

export function toolSchemaTokens(tools: ToolSchema[]): number {
  return estimateTokens(JSON.stringify(tools));
}
