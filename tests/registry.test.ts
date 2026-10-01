import { expect, test } from "bun:test";
import { z } from "zod";
import { defineTool, ToolRegistry } from "../src/tools/tool.ts";

const echo = defineTool({
  name: "echo",
  description: "Echo text back",
  schema: z.object({ text: z.string() }),
  changesWorkspace: false,
  assess: () => ({ level: "low", reasons: [], scope: "echo", sessionApprovable: true }),
  summarize: (a) => `echo ${a.text}`,
  run: async (a) => a.text,
});

const registry = new ToolRegistry([echo]);

test("schemas are JSON Schema without the $schema key", () => {
  const [schema] = registry.schemas();
  expect(schema?.name).toBe("echo");
  expect(schema?.parameters).toMatchObject({ type: "object", required: ["text"] });
  expect(schema?.parameters).not.toHaveProperty("$schema");
});

test("valid call is parsed", () => {
  const parsed = registry.parse("echo", '{"text":"hi"}');
  expect(parsed).toMatchObject({ ok: true, args: { text: "hi" } });
});

test("errors explain what went wrong", () => {
  expect(registry.parse("nope", "{}")).toMatchObject({ ok: false, error: expect.stringContaining("Unknown tool") });
  expect(registry.parse("echo", "{text:")).toMatchObject({ ok: false, error: expect.stringContaining("not valid JSON") });
  expect(registry.parse("echo", '{"text":1}')).toMatchObject({ ok: false, error: expect.stringContaining("Invalid arguments") });
});

test("duplicate names are rejected", () => {
  expect(() => new ToolRegistry([echo, echo])).toThrow(/already registered/);
});
