/**
 * Task benchmark (§10.2).
 *
 *   bun eval/tasks/run.ts                       # configured model, every task once
 *   bun eval/tasks/run.ts -m llama3.1:8b -n 3   # another model, each task 3 times
 *   bun eval/tasks/run.ts --only reminder
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/config.ts";
import { OpenAICompatibleProvider } from "../../src/llm/openaiCompatible.ts";
import { pct } from "../lib.ts";
import { runTask, type TaskResult } from "./harness.ts";
import { TASKS } from "./tasks.ts";

const args = process.argv.slice(2);
const flag = (name: string) => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined);
const config = loadConfig({ model: flag("-m") });
const times = Math.max(1, Number(flag("-n")) || 1);
const only = flag("--only");
const tasks = TASKS.filter((t) => !only || t.id.includes(only) || t.category === only);
const llm = new OpenAICompatibleProvider(config.llm);

console.log(`Task benchmark · ${config.llm.model} · ${tasks.length} tasks × ${times}\n`);
const results: TaskResult[] = [];
for (const task of tasks) {
  for (let i = 0; i < times; i++) {
    const r = await runTask(task, llm);
    results.push(r);
    console.log(`${r.success ? "✔" : "✖"} ${task.id.padEnd(22)} ${(r.durationMs / 1000).toFixed(1).padStart(6)}s ${String(r.steps).padStart(2)} steps ${r.nudges ? `${r.nudges} nudge ` : ""}${r.reason ? `— ${r.reason}` : ""}`);
  }
}

// ---- report ----------------------------------------------------------------------------
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const avg = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);
const succeeded = results.filter((r) => r.success).length;
const calls = sum(results.map((r) => r.toolCalls));
const invalid = sum(results.map((r) => r.invalidCalls));
const categories = [...new Set(tasks.map((t) => t.category))];

const report = [
  `# Task benchmark: ${config.llm.model}`,
  "",
  `- ${tasks.length} tasks × ${times} run(s), ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
  `- The simulated user approves every action; web content is faked for repeatable results.`,
  "",
  "| Metric | Value |",
  "|---|---|",
  `| **Task success rate** | **${succeeded}/${results.length} (${pct(succeeded, results.length)})** |`,
  `| Tool-call validity | ${calls - invalid}/${calls} (${pct(calls - invalid, calls)}) |`,
  `| Avg model steps per task | ${avg(results.map((r) => r.steps)).toFixed(1)} |`,
  `| Avg time per task | ${(avg(results.map((r) => r.durationMs)) / 1000).toFixed(1)} s |`,
  `| Avg prompt tokens per task | ${Math.round(avg(results.map((r) => r.promptTokens))).toLocaleString()} |`,
  `| Runs needing a nudge | ${results.filter((r) => r.nudges).length}/${results.length} |`,
  "",
  "| Category | Success |",
  "|---|---|",
  ...categories.map((c) => {
    const rs = results.filter((r) => r.category === c);
    const n = rs.filter((r) => r.success).length;
    return `| ${c} | ${n}/${rs.length} (${pct(n, rs.length)}) |`;
  }),
  "",
  "Failures:",
  "",
  ...(results.filter((r) => !r.success).map((r) => `- \`${r.id}\`: ${r.reason}`) || []),
].join("\n");
console.log(`\n${report}`);

mkdirSync(join(import.meta.dir, "../results"), { recursive: true });
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
const base = join(import.meta.dir, "../results", `tasks-${config.llm.model.replace(/[:/]/g, "_")}-${stamp}`);
writeFileSync(`${base}.md`, report + "\n");
writeFileSync(`${base}.json`, JSON.stringify({ model: config.llm.model, times, results }, null, 2));
console.log(`\nSaved ${base}.md and .json`);
