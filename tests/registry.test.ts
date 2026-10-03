import { expect, test } from "bun:test";
import { z } from "zod";
import { defineTool, ToolRegistry } from "../src/tools/tool.ts";

const echo = defineTool({
  name: "echo",
  description: "Echo text back",
  schema: z.object({ text: z.string() }),
  changesWorkspace: false,
  targetHint: "text",
  assess: () => ({ level: "low", reasons: [], scope: "echo", sessionApprovable: true }),
  assessTarget: () => ({ level: "low", reasons: [], scope: "echo", sessionApprovable: true }),
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

test("stringified booleans, numbers and lists are repaired to the schema's types", () => {
  const typed = defineTool({
    name: "typed",
    description: "x",
    schema: z.object({ flag: z.boolean().default(false), n: z.number().int().optional(), list: z.array(z.string()).optional(), text: z.string() }),
    changesWorkspace: false,
    targetHint: "x",
    assess: () => ({ level: "low", reasons: [], scope: "typed", sessionApprovable: true }),
    assessTarget: () => ({ level: "low", reasons: [], scope: "typed", sessionApprovable: true }),
    summarize: () => "typed",
    run: async () => "",
  });
  const registry = new ToolRegistry([typed]);
  expect(registry.parse("typed", '{"flag":"false","n":"14","list":"[\'*\']","text":"true"}')).toMatchObject({
    ok: true,
    args: { flag: false, n: 14, list: ["*"], text: "true" }, // strings stay strings where the schema wants a string
  });
  expect(registry.parse("typed", '{"list":"a, b","text":"x"}')).toMatchObject({ ok: true, args: { list: ["a", "b"] } });
  expect(registry.parse("typed", '{"flag":"maybe","text":"x"}')).toMatchObject({ ok: false });
  expect(registry.parse("typed", '{"n":null,"text":"x"}')).toMatchObject({ ok: true, args: { text: "x" } });
  expect(registry.parse("typed", '{"text":null}')).toMatchObject({ ok: false }); // required stays required
});
