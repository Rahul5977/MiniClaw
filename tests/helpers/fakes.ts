import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../../src/config.ts";
import type { ChatChannel, Choice, IncomingMessage } from "../../src/gateway/channel.ts";
import { collect, type ChatMessage, type ChatOptions, type LLMProvider, type StreamEvent, type ToolCall } from "../../src/llm/provider.ts";
import { createRuntime } from "../../src/runtime.ts";

export type Step = { text?: string; calls?: Omit<ToolCall, "id">[]; wait?: Promise<unknown> };

/** Fake LLM that replays scripted steps; a step can wait on a promise to simulate a slow model. */
export class ScriptedLLM implements LLMProvider {
  model = "scripted";
  seen: ChatMessage[][] = [];
  private n = 0;
  constructor(public steps: Step[]) {}
  async *stream(messages: ChatMessage[], options: ChatOptions = {}): AsyncIterable<StreamEvent> {
    options.signal?.throwIfAborted();
    this.seen.push(structuredClone(messages));
    const step = this.steps.shift() ?? { text: "ok" };
    if (step.wait) await step.wait;
    options.signal?.throwIfAborted();
    if (step.text) yield { type: "text", delta: step.text };
    if (step.calls) yield { type: "tool_calls", calls: step.calls.map((c) => ({ id: `c${this.n++}`, ...c })) };
  }
  chat(messages: ChatMessage[], options?: ChatOptions) {
    return collect(this.stream(messages, options));
  }
}

export interface Sent {
  chatId: string;
  text: string;
  choices?: Choice[];
}

/** In-memory chat app: records what MiniClaw sends; tests inject incoming messages. */
export class FakeChannel implements ChatChannel {
  sent: Sent[] = [];
  private handler: ((m: IncomingMessage) => void) | null = null;
  constructor(
    readonly name: string,
    private allowed: string[],
  ) {}
  async start(onMessage: (m: IncomingMessage) => void) {
    this.handler = onMessage;
  }
  async stop() {}
  async send(chatId: string, text: string) {
    this.sent.push({ chatId, text });
  }
  async ask(chatId: string, text: string, choices: Choice[]) {
    this.sent.push({ chatId, text, choices });
  }
  isAllowed(senderId: string) {
    return this.allowed.includes(senderId);
  }
  defaultChatId() {
    return this.allowed[0];
  }
  /** Simulates the user sending a message (or tapping a button with `choice`). */
  receive(chatId: string, text: string, choice?: string) {
    this.handler?.({ chatId, senderId: chatId, text, choice });
  }
  /** Waits until MiniClaw has sent something matching. */
  async waitFor(match: (s: Sent) => boolean, timeoutMs = 3000): Promise<Sent> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.sent.find(match);
      if (found) return found;
      await Bun.sleep(5);
    }
    throw new Error(`Timed out waiting. Sent so far:\n${this.sent.map((s) => s.text).join("\n---\n")}`);
  }
}

export async function testRuntime(llm: LLMProvider, extra: Record<string, unknown> = {}) {
  const root = mkdtempSync(join(tmpdir(), "miniclaw-rt-"));
  const config = ConfigSchema.parse({
    paths: { workspace: join(root, "workspace"), data: join(root, "data"), skills: join(root, "skills") },
    ...extra,
  });
  return { root, runtime: await createRuntime(config, llm) };
}
