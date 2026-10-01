import { afterEach, expect, test } from "bun:test";
import { loadConfig } from "../src/config.ts";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

test("defaults point at local Ollama", () => {
  delete process.env.LLM_BASE_URL;
  delete process.env.LLM_MODEL;
  const config = loadConfig();
  expect(config.llm.baseURL).toBe("http://localhost:11434/v1");
  expect(config.llm.model).toBe("qwen2.5:7b");
});

test("CLI override beats env var", () => {
  process.env.LLM_MODEL = "from-env";
  expect(loadConfig().llm.model).toBe("from-env");
  expect(loadConfig({ model: "from-flag" }).llm.model).toBe("from-flag");
});

test("invalid base URL is rejected", () => {
  process.env.LLM_BASE_URL = "not a url";
  expect(() => loadConfig()).toThrow(/Invalid configuration/);
});
