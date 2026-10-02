import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSystemPrompt } from "../src/agent/prompt.ts";
import { loadIdentity } from "../src/memory/identity.ts";
import { readFileTool } from "../src/tools/files.ts";

const root = mkdtempSync(join(tmpdir(), "miniclaw-prompt-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("IDENTITY.md is created on first run and comments are not sent", () => {
  const path = join(root, "IDENTITY.md");
  const identity = loadIdentity(path, "Jarvis");
  expect(readFileSync(path, "utf8")).toContain("<!--");
  expect(identity).toStartWith("You are Jarvis");
  expect(identity).not.toContain("<!--");

  writeFileSync(path, "# Identity\nYou are a pirate.\n<!-- note -->\n");
  expect(loadIdentity(path, "Jarvis")).toBe("You are a pirate.");
});

test("facts are included with expiry, newest kept when over budget", () => {
  const facts = Array.from({ length: 50 }, (_, i) => ({ id: `${i}`, text: `Fact number ${i} about the user` }));
  facts.push({ id: "x", text: "User is in Goa", expires: "2026-10-09" } as never);
  const prompt = buildSystemPrompt({ identity: "You are X.", facts, tools: [], memoryTokens: 60 });
  expect(prompt).toContain("## What you know about the user");
  expect(prompt).toContain("- User is in Goa (until 2026-10-09)");
  expect(prompt).not.toContain("Fact number 0 ");
  expect(prompt).toMatch(/\(\d+ older facts not shown\)/);
});

test("no memory or tool sections when there is nothing to say", () => {
  const prompt = buildSystemPrompt({ identity: "You are X.", facts: [], tools: [] });
  expect(prompt).not.toContain("##");
  expect(buildSystemPrompt({ identity: "You are X.", facts: [], tools: [readFileTool] })).toContain("<untrusted>");
});

test("skills are listed by name and description only", () => {
  const skills = [{ name: "weather", description: "Get the weather." }];
  const loadSkill = { ...readFileTool, name: "load_skill" };
  const prompt = buildSystemPrompt({ identity: "X", facts: [], tools: [loadSkill], skills });
  expect(prompt).toContain("## Skills");
  expect(prompt).toContain("- weather: Get the weather.");
  expect(buildSystemPrompt({ identity: "X", facts: [], tools: [readFileTool], skills })).not.toContain("## Skills");
});

test("the date is given in words and ISO form, with the time", () => {
  const prompt = buildSystemPrompt({ identity: "X", facts: [], tools: [], now: new Date("2026-10-02T13:05:00") });
  expect(prompt).toContain("Today is Fri Oct 02 2026 (2026-10-02), 13:05 local time.");
});
