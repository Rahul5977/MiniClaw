import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

export const ConfigSchema = z.object({
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
    // I-9: max successful calls per tool per day; the panic button is separate.
    budgets: z.record(z.string(), z.number().int().min(0)).default({ run_shell: 30, web_fetch: 60, write_file: 60 }),
    // Max LLM calls per user message, so a confused model can't loop forever.
    maxSteps: z.number().int().min(1).max(30).default(8),
  }).prefault({}),
  paths: z.object({
    workspace: z.string().default("workspace"),
    skills: z.string().default("skills"),
    data: z.string().default("data"),
  }).prefault({}),
  security: z.object({
    // I-3: flag tool calls that reuse text from web pages or files. Turn off only to measure its effect.
    taintTracking: z.boolean().default(true),
  }).prefault({}),
  gateway: z.object({
    // Localhost only by default; expose webhooks with a tunnel (ngrok) instead of opening the port.
    host: z.string().default("127.0.0.1"),
    port: z.number().int().min(0).max(65535).default(8787),
    // "<channel>:<chatId>" for reminders made in the CLI; defaults to the first allowed user.
    defaultChat: z.string().optional(),
    // Unanswered approval questions count as "no" after this long.
    answerTimeoutMinutes: z.number().min(1).default(10),
    // Daily proactive briefing to the default chat, e.g. "08:00". Off when null.
    briefingTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM, 24-hour").nullable().default(null),
  }).prefault({}),
  channels: z.object({
    telegram: z.object({
      enabled: z.boolean().optional(),
      token: z.string().optional(),
      allowedUsers: z.array(z.coerce.string()).default([]),
      // Change only for a self-hosted Bot API server (or tests).
      apiBase: z.url().default("https://api.telegram.org"),
    }).prefault({}),
    whatsapp: z.object({
      enabled: z.boolean().optional(),
      token: z.string().optional(),
      phoneNumberId: z.string().optional(),
      appSecret: z.string().optional(),
      verifyToken: z.string().optional(),
      allowedNumbers: z.array(z.coerce.string()).default([]),
      apiBase: z.url().default("https://graph.facebook.com/v26.0"),
    }).prefault({}),
    // Unofficial (Baileys). Never enabled automatically because the number can be banned.
    whatsappWeb: z.object({
      enabled: z.boolean().default(false),
      allowedNumbers: z.array(z.coerce.string()).default([]),
    }).prefault({}),
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
  const list = (value?: string) => value?.split(",").map((s) => s.trim()).filter(Boolean);
  const channels = file.channels ?? {};
  const raw = {
    ...file,
    // Secrets only come from the environment (.env), never from the config file.
    channels: {
      ...channels,
      telegram: {
        ...channels.telegram,
        token: env.TELEGRAM_BOT_TOKEN,
        ...(list(env.TELEGRAM_ALLOWED_USERS) && { allowedUsers: list(env.TELEGRAM_ALLOWED_USERS) }),
      },
      whatsapp: {
        ...channels.whatsapp,
        token: env.WHATSAPP_TOKEN,
        phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID ?? channels.whatsapp?.phoneNumberId,
        appSecret: env.WHATSAPP_APP_SECRET,
        verifyToken: env.WHATSAPP_VERIFY_TOKEN,
        ...(list(env.WHATSAPP_ALLOWED_NUMBERS) && { allowedNumbers: list(env.WHATSAPP_ALLOWED_NUMBERS) }),
      },
      whatsappWeb: {
        ...channels.whatsappWeb,
        ...(env.WHATSAPP_WEB_ENABLED && { enabled: env.WHATSAPP_WEB_ENABLED === "true" }),
        ...(list(env.WHATSAPP_WEB_ALLOWED_NUMBERS) && { allowedNumbers: list(env.WHATSAPP_WEB_ALLOWED_NUMBERS) }),
      },
    },
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
