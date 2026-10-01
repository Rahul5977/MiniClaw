import { z } from "zod";
import type { LLMProvider } from "../llm/provider.ts";
import type { Risk, ToolContext, ToolRegistry } from "../tools/tool.ts";

export interface PlanStep {
  tool: string;
  target: string;
  why: string;
  risk: Risk;
}

const PlanSchema = z.object({
  steps: z
    .array(z.object({ tool: z.string(), target: z.string(), why: z.string().default("") }))
    .min(1)
    .max(15),
});

function plannerPrompt(tools: ToolRegistry): string {
  const toolLines = tools.list().map((t) => `- ${t.name}: ${t.description} (target = ${t.targetHint})`);
  return [
    "You are planning how to complete the user's task with tools. Do NOT do the task yet.",
    "Reply with ONLY a JSON object of this shape:",
    '{"steps":[{"tool":"<tool name>","target":"<what it acts on>","why":"<short reason>"}]}',
    "Available tools:",
    ...toolLines,
    "File paths are relative to the workspace. List the steps in order. Keep the plan as short as possible.",
  ].join("\n");
}

/**
 * I-2: Asks the model for a structured plan before anything runs, and scores each step
 * with the same rule-based risk assessment used at execution time.
 */
export async function createPlan(
  llm: LLMProvider,
  tools: ToolRegistry,
  task: string,
  ctx: ToolContext,
): Promise<PlanStep[]> {
  const messages = [
    { role: "system" as const, content: plannerPrompt(tools) },
    { role: "user" as const, content: task },
  ];

  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    if (lastError) messages.push({ role: "user", content: `That was not a valid plan (${lastError}). Reply with only the JSON object.` });
    const { text } = await llm.chat(messages, { json: true, temperature: 0, signal: ctx.signal });

    let json: unknown;
    try {
      json = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    } catch {
      lastError = "invalid JSON";
      continue;
    }
    const parsed = PlanSchema.safeParse(json);
    if (!parsed.success) {
      lastError = z.prettifyError(parsed.error).split("\n")[0] ?? "wrong shape";
      continue;
    }

    const unknown = parsed.data.steps.filter((s) => !tools.get(s.tool)).map((s) => s.tool);
    if (unknown.length) {
      lastError = `unknown tools: ${unknown.join(", ")}`;
      continue;
    }

    return parsed.data.steps.map((step) => ({ ...step, risk: assessStep(tools, step.tool, step.target, ctx) }));
  }
  throw new Error(`The model could not produce a valid plan: ${lastError}`);
}

function assessStep(tools: ToolRegistry, name: string, target: string, ctx: ToolContext): Risk {
  try {
    return tools.get(name)!.assessTarget(target, ctx);
  } catch (error) {
    return { level: "blocked", reasons: [(error as Error).message], scope: `${name}:?`, sessionApprovable: false };
  }
}

/** Scopes an approved plan pre-authorizes. Only medium risk; high still asks and blocked never runs. */
export function planScopes(steps: PlanStep[]): string[] {
  return steps.filter((s) => s.risk.level === "medium").map((s) => s.risk.scope);
}

/** The task message sent to the agent once the plan is approved. */
export function planTask(task: string, steps: PlanStep[]): string {
  const list = steps.map((s, i) => `${i + 1}. ${s.tool} ${s.target} — ${s.why}`).join("\n");
  return `${task}\n\nThe user approved this plan. Follow it; actions outside it will need separate approval:\n${list}`;
}
