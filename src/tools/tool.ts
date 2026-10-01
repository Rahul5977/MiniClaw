import { z } from "zod";
import type { ToolSchema } from "../llm/provider.ts";

/** blocked = never run; high = always ask; medium = ask (or session-approve); low = auto-run. */
export type RiskLevel = "low" | "medium" | "high" | "blocked";

export interface Risk {
  level: RiskLevel;
  /** Human-readable explanations shown in the approval prompt. */
  reasons: string[];
  /** What the call touches, e.g. "write_file:notes.md", "web_fetch:example.com", "run_shell:ls". */
  scope: string;
  /** Whether "allow for the rest of this session" may be offered for this scope. */
  sessionApprovable: boolean;
}

export interface ToolContext {
  /** Absolute path of the sandboxed workspace directory. */
  workspace: string;
  signal?: AbortSignal;
}

export interface Tool<A = any> {
  name: string;
  description: string;
  schema: z.ZodType<A>;
  /** True if the tool can modify the workspace, so a checkpoint is taken (undo). */
  changesWorkspace: boolean;
  /** Rule-based risk assessment (no model involved) — see security/risk.ts. */
  assess(args: A, ctx: ToolContext): Risk | Promise<Risk>;
  /** Short one-line description of the call, for prompts, logs and undo history. */
  summarize(args: A): string;
  /** Optional detail for the approval prompt, e.g. a diff of a file write. */
  preview?(args: A, ctx: ToolContext): Promise<string | undefined>;
  run(args: A, ctx: ToolContext): Promise<string>;
}

/** Identity helper so each tool's args are typed from its zod schema. */
export function defineTool<S extends z.ZodType>(tool: Tool<z.infer<S>> & { schema: S }): Tool<z.infer<S>> {
  return tool;
}

export type ParsedCall =
  | { ok: true; tool: Tool; args: unknown }
  | { ok: false; error: string };

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  constructor(tools: Tool[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register(tool: Tool): void {
    if (this.tools.has(tool.name)) throw new Error(`Tool "${tool.name}" is already registered`);
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  schemas(): ToolSchema[] {
    return this.list().map((tool) => {
      const { $schema: _, ...parameters } = z.toJSONSchema(tool.schema) as Record<string, unknown>;
      return { name: tool.name, description: tool.description, parameters };
    });
  }

  /**
   * Validates a raw tool call from the model. Errors are written for the model to read,
   * so it can fix its arguments and try again (small models often get JSON slightly wrong).
   */
  parse(name: string, rawArgs: string): ParsedCall {
    const tool = this.tools.get(name);
    if (!tool) {
      return { ok: false, error: `Unknown tool "${name}". Available tools: ${[...this.tools.keys()].join(", ")}.` };
    }
    let json: unknown;
    try {
      json = rawArgs.trim() ? JSON.parse(rawArgs) : {};
    } catch {
      return { ok: false, error: `Arguments for ${name} are not valid JSON: ${rawArgs}. Send a JSON object.` };
    }
    const result = tool.schema.safeParse(json);
    if (!result.success) {
      return { ok: false, error: `Invalid arguments for ${name}:\n${z.prettifyError(result.error)}` };
    }
    return { ok: true, tool, args: result.data };
  }
}
