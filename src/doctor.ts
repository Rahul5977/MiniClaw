import OpenAI from "openai";
import { loadConfig, type Config } from "./config.ts";
import { buildChannels } from "./gateway/channels.ts";

type Status = "ok" | "warn" | "fail";
interface Check {
  status: Status;
  label: string;
  hint?: string;
}

const ICON: Record<Status, string> = {
  ok: "\x1b[32m✔\x1b[0m",
  warn: "\x1b[33m!\x1b[0m",
  fail: "\x1b[31m✖\x1b[0m",
};

/** Runs setup checks, prints them, and returns false if any check failed. */
export async function runDoctor(overrides: { model?: string } = {}): Promise<boolean> {
  const checks: Check[] = [{ status: "ok", label: `Bun ${Bun.version}` }, checkGit()];
  const print = () => {
    for (const c of checks) {
      console.log(`${ICON[c.status]} ${c.label}`);
      if (c.hint) console.log(`  \x1b[2m${c.hint}\x1b[0m`);
    }
  };

  let config: Config;
  try {
    config = loadConfig(overrides);
    checks.push({ status: "ok", label: "Configuration is valid" });
  } catch (error) {
    checks.push({ status: "fail", label: "Configuration", hint: (error as Error).message });
    print();
    return false;
  }

  checks.push(...(await checkLlm(config.llm, config.agent.contextTokens)));
  checks.push(...checkChatApps(config));
  print();
  return checks.every((c) => c.status !== "fail");
}

/** Chat apps are optional: problems are warnings, since the CLI works without them. */
function checkChatApps(config: Config): Check[] {
  const { channels, errors } = buildChannels(config);
  const checks: Check[] = errors.map((error) => ({ status: "warn" as const, label: error }));
  for (const channel of channels) checks.push({ status: "ok", label: `Chat app configured: ${channel.name}` });
  if (channels.length === 0 && errors.length === 0) {
    checks.push({ status: "ok", label: "No chat apps configured (optional; see the README to add Telegram or WhatsApp)" });
  }
  if (config.channels.whatsappWeb.enabled) {
    checks.push({
      status: "warn",
      label: "WhatsApp Web (unofficial) is enabled",
      hint: "It breaks WhatsApp's terms of service and the number can be banned. Use a spare number.",
    });
  }
  return checks;
}

/** /undo (I-1) stores workspace checkpoints with git. */
function checkGit(): Check {
  try {
    const git = Bun.spawnSync(["git", "--version"], { stdout: "pipe", stderr: "pipe" });
    if (git.success) return { status: "ok", label: git.stdout.toString().trim() };
  } catch {
    // Not on PATH.
  }
  return {
    status: "fail",
    label: "git is not installed",
    hint: "MiniClaw uses git for /undo. Install it with `xcode-select --install` or your package manager.",
  };
}

async function checkLlm(llm: Config["llm"], contextTokens: number): Promise<Check[]> {
  const client = new OpenAI({ baseURL: llm.baseURL, apiKey: llm.apiKey, maxRetries: 0, timeout: 5000 });

  let models: string[];
  try {
    models = [];
    for await (const model of client.models.list()) models.push(model.id);
  } catch {
    return [{
      status: "fail",
      label: `LLM server not reachable at ${llm.baseURL}`,
      hint: "Start Ollama with `ollama serve`, or set LLM_BASE_URL in .env.",
    }];
  }

  const checks: Check[] = [{ status: "ok", label: `LLM server reachable at ${llm.baseURL}` }];
  const ollama = await isOllama(llm.baseURL);

  if (!models.includes(llm.model)) {
    checks.push({
      status: "fail",
      label: `Model "${llm.model}" is not available`,
      hint: ollama
        ? `Download it with \`ollama pull ${llm.model}\`. Installed: ${models.join(", ") || "none"}`
        : `Available models: ${models.slice(0, 10).join(", ")}`,
    });
    return checks;
  }
  checks.push({ status: "ok", label: `Model "${llm.model}" is available` });

  // Phase 2 (agent loop) needs tool calling. Ollama can tell us whether a model supports it.
  if (ollama) {
    const capabilities = await ollamaCapabilities(llm.baseURL, llm.model);
    if (capabilities && !capabilities.includes("tools")) {
      checks.push({
        status: "warn",
        label: `Model "${llm.model}" does not support tool calling`,
        hint: "Chat works, but the agent's tools will not. Try qwen2.5:7b, qwen3:8b or llama3.1:8b.",
      });
    } else if (capabilities) {
      checks.push({ status: "ok", label: "Model supports tool calling" });
    }
    const window = await ollamaContextWindow(llm.baseURL, llm.model);
    if (window !== null && window < contextTokens) {
      checks.push({
        status: "warn",
        label: `Ollama runs "${llm.model}" with a ${window}-token window, but agent.contextTokens is ${contextTokens}`,
        hint: `Ollama would silently cut off the start of long prompts. Either set agent.contextTokens to ${window}, or restart Ollama with OLLAMA_CONTEXT_LENGTH=${contextTokens}.`,
      });
    } else if (window !== null) {
      checks.push({ status: "ok", label: `Context window: ${window} tokens (MiniClaw uses ${contextTokens})` });
    }
  }
  return checks;
}

/** The window Ollama actually allocated for the model (loads the model if needed). */
async function ollamaContextWindow(baseURL: string, model: string): Promise<number | null> {
  try {
    const root = ollamaRoot(baseURL);
    // An empty prompt just loads the model into memory.
    await fetch(`${root}/api/generate`, {
      method: "POST",
      body: JSON.stringify({ model, prompt: "" }),
      signal: AbortSignal.timeout(60_000),
    });
    const res = await fetch(`${root}/api/ps`, { signal: AbortSignal.timeout(5000) });
    const body = (await res.json()) as { models?: { name: string; context_length?: number }[] };
    return body.models?.find((m) => m.name === model)?.context_length ?? null;
  } catch {
    return null;
  }
}

/** Ollama's native API lives at the server root, next to the OpenAI-compatible /v1. */
function ollamaRoot(baseURL: string): string {
  return new URL(baseURL).origin;
}

async function isOllama(baseURL: string): Promise<boolean> {
  try {
    const res = await fetch(`${ollamaRoot(baseURL)}/api/version`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function ollamaCapabilities(baseURL: string, model: string): Promise<string[] | null> {
  try {
    const res = await fetch(`${ollamaRoot(baseURL)}/api/show`, {
      method: "POST",
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { capabilities?: string[] };
    return body.capabilities ?? null;
  } catch {
    return null;
  }
}
