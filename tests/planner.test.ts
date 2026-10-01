import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlan, planScopes, planTask } from "../src/agent/planner.ts";
import { collect, type ChatMessage, type LLMProvider, type StreamEvent } from "../src/llm/provider.ts";
import { prepareWorkspace } from "../src/security/sandbox.ts";
import { listDirTool, readFileTool, writeFileTool } from "../src/tools/files.ts";
import { runShellTool } from "../src/tools/shell.ts";
import { ToolRegistry } from "../src/tools/tool.ts";
import { webFetchTool } from "../src/tools/web.ts";

const root = mkdtempSync(join(tmpdir(), "miniclaw-plan-"));
const ctx = { workspace: prepareWorkspace(join(root, "ws")) };
afterAll(() => rmSync(root, { recursive: true, force: true }));
const tools = new ToolRegistry([readFileTool, listDirTool, writeFileTool, runShellTool, webFetchTool]);

class Replies implements LLMProvider {
  model = "fake";
  prompts: ChatMessage[][] = [];
  constructor(private replies: string[]) {}
  async *stream(messages: ChatMessage[]): AsyncIterable<StreamEvent> {
    this.prompts.push(structuredClone(messages));
    yield { type: "text", delta: this.replies.shift() ?? "" };
  }
  chat(messages: ChatMessage[]) {
    return collect(this.stream(messages));
  }
}

const plan = JSON.stringify({
  steps: [
    { tool: "read_file", target: "notes.txt", why: "get the notes" },
    { tool: "write_file", target: "./summary.md", why: "save summary" },
    { tool: "run_shell", target: "rm notes.txt", why: "clean up" },
    { tool: "read_file", target: "../../etc/passwd", why: "sneaky" },
  ],
});

test("plan steps are risk-scored with the execution-time rules", async () => {
  const steps = await createPlan(new Replies([plan]), tools, "summarize notes", ctx);
  expect(steps.map((s) => s.risk.level)).toEqual(["low", "medium", "high", "blocked"]);
  // Only medium steps are pre-approved, with the same scope assess() will produce.
  expect(planScopes(steps)).toEqual(["write_file:summary.md"]);
  const scope = (await writeFileTool.assess({ path: "summary.md", content: "x", append: false }, ctx)).scope;
  expect(scope).toBe("write_file:summary.md");
});

test("invalid replies are retried once with the reason", async () => {
  const llm = new Replies(["sure! here is my plan", plan]);
  const steps = await createPlan(llm, tools, "x", ctx);
  expect(steps).toHaveLength(4);
  expect(llm.prompts[1]?.at(-1)?.content).toContain("invalid JSON");
});

test("unknown tools are rejected", async () => {
  const bad = JSON.stringify({ steps: [{ tool: "send_email", target: "boss", why: "" }] });
  await expect(createPlan(new Replies([bad, bad]), tools, "x", ctx)).rejects.toThrow(/unknown tools: send_email/);
});

test("approved plan is passed to the agent with the task", () => {
  const text = planTask("do it", [{ tool: "read_file", target: "a", why: "b", risk: readFileTool.assessTarget("a", ctx) }]);
  expect(text).toContain("1. read_file a — b");
});
