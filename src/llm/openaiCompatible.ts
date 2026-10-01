import OpenAI from "openai";
import type { Config } from "../config.ts";
import type { ChatMessage, ChatOptions, LLMProvider } from "./provider.ts";

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

  async chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
    const response = await this.client.chat.completions.create(
      {
        model: options.model ?? this.model,
        temperature: options.temperature ?? this.temperature,
        messages,
      },
      { signal: options.signal },
    );
    return response.choices[0]?.message.content ?? "";
  }

  async *stream(messages: ChatMessage[], options: ChatOptions = {}): AsyncIterable<string> {
    const stream = await this.client.chat.completions.create(
      {
        model: options.model ?? this.model,
        temperature: options.temperature ?? this.temperature,
        messages,
        stream: true,
      },
      { signal: options.signal },
    );
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta.content;
      if (delta) yield delta;
    }
  }
}
