import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { Config } from "../config.ts";
import {
  collect,
  type ChatMessage,
  type ChatOptions,
  type LLMProvider,
  type LLMResponse,
  type StreamEvent,
  type ToolCall,
} from "./provider.ts";

/** Works with Ollama, OpenAI, Groq, OpenRouter... anything speaking the OpenAI chat API. */
export class OpenAICompatibleProvider implements LLMProvider {
  private client: OpenAI;
  readonly model: string;
  private temperature: number;

  constructor(config: Config["llm"]) {
    this.client = new OpenAI({ baseURL: config.baseURL, apiKey: config.apiKey });
    this.model = config.model;
    this.temperature = config.temperature;
  }

  chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<LLMResponse> {
    return collect(this.stream(messages, options));
  }

  async *stream(messages: ChatMessage[], options: ChatOptions = {}): AsyncIterable<StreamEvent> {
    const stream = await this.client.chat.completions.create(
      {
        model: options.model ?? this.model,
        temperature: options.temperature ?? this.temperature,
        messages: messages.map(toOpenAI),
        stream: true,
        ...(options.tools?.length && {
          tools: options.tools.map((t) => ({
            type: "function" as const,
            function: { name: t.name, description: t.description, parameters: t.parameters },
          })),
        }),
        ...(options.json && { response_format: { type: "json_object" as const } }),
      },
      { signal: options.signal },
    );

    // Tool calls arrive in fragments keyed by index; stitch them together.
    const partial = new Map<number, ToolCall>();
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;
      if (delta.content) yield { type: "text", delta: delta.content };
      for (const fragment of delta.tool_calls ?? []) {
        const call = partial.get(fragment.index) ?? { id: "", name: "", arguments: "" };
        if (fragment.id) call.id = fragment.id;
        if (fragment.function?.name) call.name += fragment.function.name;
        if (fragment.function?.arguments) call.arguments += fragment.function.arguments;
        partial.set(fragment.index, call);
      }
    }

    if (partial.size > 0) {
      const calls = [...partial.values()].map((call, i) => ({ ...call, id: call.id || `call_${i}` }));
      yield { type: "tool_calls", calls };
    }
  }
}

function toOpenAI(message: ChatMessage): ChatCompletionMessageParam {
  switch (message.role) {
    case "assistant":
      return {
        role: "assistant",
        content: message.content,
        ...(message.toolCalls?.length && {
          tool_calls: message.toolCalls.map((c) => ({
            id: c.id,
            type: "function" as const,
            function: { name: c.name, arguments: c.arguments },
          })),
        }),
      };
    case "tool":
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
    default:
      return message;
  }
}
