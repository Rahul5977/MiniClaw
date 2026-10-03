import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../src/config.ts";
import { collect, type ChatMessage, type ChatOptions, type LLMProvider, type StreamEvent, type ToolCall } from "../src/llm/provider.ts";
import { createRuntime, type Runtime } from "../src/runtime.ts";
import { assessUrl } from "../src/security/risk.ts";
import { untrusted } from "../src/tools/format.ts";
import { defineTool } from "../src/tools/tool.ts";
import { selectFields, webFetchTool } from "../src/tools/web.ts";

/** A fresh, isolated MiniClaw for one evaluation case (temporary workspace and database). */
export async function evalRuntime(
  llm: LLMProvider,
  config: Record<string, unknown> = {},
  options: { skills?: string[] } = {},
): Promise<{ runtime: Runtime; cleanup: () => void }> {
  const root = mkdtempSync(join(tmpdir(), "miniclaw-eval-"));
  // Only the skills a case needs, copied from the repo and pre-approved.
  for (const name of options.skills ?? []) cpSync(join(REPO_SKILLS, name), join(root, "skills", name), { recursive: true });
  const parsed = ConfigSchema.parse({
    paths: { workspace: join(root, "workspace"), data: join(root, "data"), skills: join(root, "skills") },
    ...config,
  });
  const runtime = await createRuntime(parsed, llm);
  for (const skill of runtime.skills) runtime.grants.grant(skill);
  return { runtime, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const REPO_SKILLS = join(import.meta.dir, "..", "skills");

/**
 * web_fetch with canned pages instead of the network; same schema and risk rules as the real one.
 * Keys are exact URLs, or "host:<hostname>" to answer every URL on a host. JSON pages honor `fields`.
 */
export function fakeWeb(pages: Record<string, string>) {
  return defineTool({
    ...webFetchTool,
    assess: (args) => assessUrl(args.url),
    async run(args) {
      let host = "";
      try {
        host = new URL(args.url).hostname;
      } catch {
        return `Error: invalid URL ${args.url}`;
      }
      const page = pages[args.url] ?? pages[`host:${host}`] ?? (host === "evil.example" ? "OK" : undefined);
      if (page === undefined) return `Status: 404 for ${args.url}`;
      const body = args.fields?.length && page.trim().startsWith("{") ? selectFields(page, args.fields) : page;
      return untrusted(`web:${args.url}`, `Status: 200\n\n${body}`);
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
