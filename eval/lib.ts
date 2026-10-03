import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../src/config.ts";
import { collect, type ChatMessage, type ChatOptions, type LLMProvider, type StreamEvent, type ToolCall } from "../src/llm/provider.ts";
import { createRuntime, type Runtime } from "../src/runtime.ts";
import { assessUrl } from "../src/security/risk.ts";
import { untrusted } from "../src/tools/format.ts";
import { defineTool } from "../src/tools/tool.ts";
import { webFetchTool } from "../src/tools/web.ts";

/** A fresh, isolated MiniClaw for one evaluation case (temporary workspace and database). */
export async function evalRuntime(llm: LLMProvider, config: Record<string, unknown> = {}): Promise<{ runtime: Runtime; cleanup: () => void }> {
  const root = mkdtempSync(join(tmpdir(), "miniclaw-eval-"));
  const parsed = ConfigSchema.parse({
    paths: { workspace: join(root, "workspace"), data: join(root, "data"), skills: join(root, "no-skills") },
    ...config,
  });
  const runtime = await createRuntime(parsed, llm);
  return { runtime, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** web_fetch with canned pages instead of the network; same schema and risk rules as the real one. */
export function fakeWeb(pages: Record<string, string>) {
  return defineTool({
    ...webFetchTool,
    assess: (args) => assessUrl(args.url),
    async run(args) {
      const page = pages[args.url] ?? (new URL(args.url).hostname === "evil.example" ? "OK" : undefined);
      return page === undefined ? `Status: 404 for ${args.url}` : untrusted(`web:${args.url}`, `Status: 200\n\n${page}`);
    },
  });
}

/** Replays fixed steps: a stand-in for a model fully controlled by the injection. */
export class ScriptedModel implements LLMProvider {
  model = "compromised (scripted)";
  private n = 0;
  constructor(private steps: { calls?: Omit<ToolCall, "id">[]; text?: string }[]) {}
  async *stream(_messages: ChatMessage[], options: ChatOptions = {}): AsyncIterable<StreamEvent> {
    options.signal?.throwIfAborted();
    const step = this.steps.shift() ?? { text: "Done." };
    if (step.text) yield { type: "text", delta: step.text };
    if (step.calls) yield { type: "tool_calls", calls: step.calls.map((c) => ({ id: `c${this.n++}`, ...c })) };
  }
  chat(messages: ChatMessage[], options?: ChatOptions) {
    return collect(this.stream(messages, options));
  }
}

export const pct = (n: number, d: number) => (d === 0 ? "–" : `${Math.round((n / d) * 100)}%`);
