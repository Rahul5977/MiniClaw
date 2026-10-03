import type { LLMProvider } from "../../src/llm/provider.ts";
import type { LlmEvent, ToolEvent } from "../../src/recorder/runs.ts";
import { ApprovalPolicy } from "../../src/security/approvals.ts";
import { evalRuntime, fakeWeb } from "../lib.ts";
import { WEB, type Task } from "./tasks.ts";

export interface TaskResult {
  id: string;
  category: string;
  success: boolean;
  reason?: string;
  status: string;
  steps: number;
  toolCalls: number;
  invalidCalls: number;
  nudges: number;
  durationMs: number;
  promptTokens: number;
  answer: string;
}

/** Runs one task in an isolated MiniClaw; the user approves everything (this measures capability, not safety). */
export async function runTask(task: Task, llm: LLMProvider, maxSteps = 8): Promise<TaskResult> {
  const { runtime, cleanup } = await evalRuntime(llm, { agent: { maxSteps } }, { skills: task.skills });
  try {
    runtime.tools.replace(fakeWeb(WEB));
    await task.setup?.(runtime);
    const agent = runtime.createAgent({ policy: new ApprovalPolicy(), approver: { ask: async () => "approve" } });
    const session = runtime.openSession(runtime.sessions.create("eval"));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 240_000);
    let answer = "";
    let error: string | undefined;
    try {
      for await (const event of agent.run(session, task.request, controller.signal)) {
        if (event.type === "tool_start") answer = ""; // the answer is the text after the last tool call
        if (event.type === "text") answer += event.delta;
      }
    } catch (e) {
      error = (e as Error).message;
    } finally {
      clearTimeout(timer);
    }

    const run = runtime.runs.get(runtime.runs.list(1)[0]!.id)!;
    const tools = run.events.filter((e) => e.type === "tool").map((e) => e.data as ToolEvent);
    const llmSteps = run.events.filter((e) => e.type === "llm").map((e) => e.data as LlmEvent);
    let verdict: true | string;
    try {
      verdict = error ? `error: ${error}` : task.check({ runtime, answer: answer.trim(), tools: tools.map((t) => t.name) });
    } catch (e) {
      verdict = `check failed: ${(e as Error).message}`;
    }
    return {
      id: task.id,
      category: task.category,
      success: verdict === true,
      ...(verdict !== true && { reason: verdict }),
      status: run.status,
      steps: run.steps,
      toolCalls: run.toolCalls,
      invalidCalls: tools.filter((t) => t.verdict === "invalid").length,
      nudges: llmSteps.filter((s) => s.nudge).length,
      durationMs: (run.endedAt ?? Date.now()) - run.startedAt,
      promptTokens: run.promptTokens,
      answer: answer.trim().slice(0, 500),
    };
  } finally {
    cleanup();
  }
}
