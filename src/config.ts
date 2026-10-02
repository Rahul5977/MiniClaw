import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

const ConfigSchema = z.object({
  llm: z.object({
    baseURL: z.url().default("http://localhost:11434/v1"),
    model: z.string().trim().min(1).default("qwen2.5:7b"),
    // Ollama ignores the key, but the OpenAI client requires a non-empty one.
    apiKey: z.string().min(1).default("ollama"),
    temperature: z.number().min(0).max(2).default(0.7),
  }).prefault({}),
  agent: z.object({
    name: z.string().default("MiniClaw"),
    // Must match the model's real context window. Ollama's default is often 4096,
    // set OLLAMA_CONTEXT_LENGTH to raise it. `miniclaw doctor` checks this.
    contextTokens: z.number().int().min(2048).default(4096),
    // Space kept free for the model's reply.
    replyTokens: z.number().int().min(256).default(768),
    // Max LLM calls per user message, so a confused model can't loop forever.
    maxSteps: z.number().int().min(1).max(30).default(8),
  }).prefault({}),
  paths: z.object({
    workspace: z.string().default("workspace"),
    data: z.string().default("data"),
  }).prefault({}),
});

export type Config = z.infer<typeof ConfigSchema>;

export const CONFIG_FILE = "miniclaw.config.json";

/**
 * Precedence (highest first): overrides (CLI flags) > env vars > miniclaw.config.json > defaults.
 * Bun loads .env automatically, so env vars from it are already in process.env.
 */
export function loadConfig(overrides: { model?: string } = {}): Config {
  const path = resolve(process.cwd(), CONFIG_FILE);
  const file = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};

  const env = process.env;
  const raw = {
    ...file,
    llm: {
      ...file.llm,
      ...(env.LLM_BASE_URL && { baseURL: env.LLM_BASE_URL }),
      ...(env.LLM_MODEL && { model: env.LLM_MODEL }),
      ...(env.OPENAI_API_KEY && { apiKey: env.OPENAI_API_KEY }),
      ...(overrides.model && { model: overrides.model }),
    },
  };

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
