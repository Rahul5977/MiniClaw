import { mkdir, readdir, readFile, stat, writeFile, appendFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createTwoFilesPatch } from "diff";
import { z } from "zod";
import { makeRisk } from "../security/risk.ts";
import { displayPath, resolveInWorkspace } from "../security/sandbox.ts";
import { truncate, untrusted } from "./format.ts";
import { defineTool } from "./tool.ts";

const MAX_READ_CHARS = 20_000;
const MAX_LIST_ENTRIES = 200;
const MAX_DIFF_LINES = 60;

async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

export const readFileTool = defineTool({
  name: "read_file",
  description: "Read a text file from the workspace.",
  schema: z.object({
    path: z.string().describe("File path relative to the workspace"),
  }),
  changesWorkspace: false,
  assess: (args, ctx) => {
    const path = displayPath(ctx.workspace, resolveInWorkspace(ctx.workspace, args.path));
    return makeRisk("low", `read_file:${path}`, ["reads a file inside the workspace"]);
  },
  summarize: (args) => `read ${args.path}`,
  async run(args, ctx) {
    const path = resolveInWorkspace(ctx.workspace, args.path);
    const content = await readFile(path, "utf8");
    if (content.includes("\0")) return `${args.path} looks like a binary file and can't be shown as text.`;
    return untrusted(`file:${displayPath(ctx.workspace, path)}`, truncate(content, MAX_READ_CHARS));
  },
});

export const listDirTool = defineTool({
  name: "list_dir",
  description: "List files and folders in a workspace directory.",
  schema: z.object({
    path: z.string().default(".").describe("Directory relative to the workspace (default: workspace root)"),
    depth: z.number().int().min(1).max(4).default(1).describe("How many levels deep to list (1-4)"),
  }),
  changesWorkspace: false,
  assess: (args, ctx) => {
    const path = displayPath(ctx.workspace, resolveInWorkspace(ctx.workspace, args.path));
    return makeRisk("low", `list_dir:${path}`, ["lists a folder inside the workspace"]);
  },
  summarize: (args) => `list ${args.path}`,
  async run(args, ctx) {
    const root = resolveInWorkspace(ctx.workspace, args.path);
    const lines: string[] = [];
    const walk = async (dir: string, level: number) => {
      const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (entry.name === ".git" || lines.length >= MAX_LIST_ENTRIES) continue;
        const indent = "  ".repeat(level);
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          lines.push(`${indent}${entry.name}/`);
          if (level + 1 < args.depth) await walk(full, level + 1);
        } else {
          lines.push(`${indent}${entry.name} (${(await stat(full)).size} bytes)`);
        }
      }
    };
    await walk(root, 0);
    if (lines.length === 0) return `${args.path} is empty.`;
    if (lines.length >= MAX_LIST_ENTRIES) lines.push(`… stopped after ${MAX_LIST_ENTRIES} entries`);
    return lines.join("\n");
  },
});

export const writeFileTool = defineTool({
  name: "write_file",
  description: "Create or overwrite a text file in the workspace, or append to it. Parent folders are created.",
  schema: z.object({
    path: z.string().describe("File path relative to the workspace"),
    content: z.string().describe("Text to write"),
    append: z.boolean().default(false).describe("Append instead of overwriting"),
  }),
  changesWorkspace: true,
  async assess(args, ctx) {
    const abs = resolveInWorkspace(ctx.workspace, args.path);
    const path = displayPath(ctx.workspace, abs);
    const existing = await readIfExists(abs);
    const reasons =
      existing === undefined
        ? [`creates ${path}`]
        : args.append
          ? [`appends to ${path}`]
          : [`overwrites ${path} (${existing.split("\n").length} → ${args.content.split("\n").length} lines)`];
    reasons.push("can be reverted with /undo");
    return makeRisk("medium", `write_file:${path}`, reasons);
  },
  summarize: (args) => `${args.append ? "append to" : "write"} ${args.path}`,
  async preview(args, ctx) {
    const abs = resolveInWorkspace(ctx.workspace, args.path);
    const before = (await readIfExists(abs)) ?? "";
    const after = args.append ? before + args.content : args.content;
    const patch = createTwoFilesPatch(args.path, args.path, before, after, "", "", { context: 2 });
    // Drop the "Index/===/---/+++" header and git's "\ No newline at end of file" markers.
    const lines = patch.split("\n").slice(4).filter((line) => !line.startsWith("\\"));
    return lines.length > MAX_DIFF_LINES
      ? [...lines.slice(0, MAX_DIFF_LINES), `… ${lines.length - MAX_DIFF_LINES} more diff lines`].join("\n")
      : lines.join("\n");
  },
  async run(args, ctx) {
    const abs = resolveInWorkspace(ctx.workspace, args.path);
    await mkdir(dirname(abs), { recursive: true });
    await (args.append ? appendFile : writeFile)(abs, args.content, "utf8");
    return `${args.append ? "Appended" : "Wrote"} ${args.content.length} characters to ${displayPath(ctx.workspace, abs)}.`;
  },
});
