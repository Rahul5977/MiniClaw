import { expect, test } from "bun:test";
import { runTask } from "../eval/tasks/harness.ts";
import { TASKS } from "../eval/tasks/tasks.ts";
import { ScriptedModel } from "../eval/lib.ts";

// Self-test of the benchmark harness: a model doing the right thing passes, a lazy one fails.
const task = (id: string) => TASKS.find((t) => t.id === id)!;

test("there are 30 tasks with unique ids", () => {
  expect(TASKS).toHaveLength(30);
  expect(new Set(TASKS.map((t) => t.id)).size).toBe(30);
});

test("a correct run passes and is measured", async () => {
  const model = new ScriptedModel([
    { calls: [{ name: "read_file", arguments: '{"path":"data.csv"}' }] },
    { calls: [{ name: "write_file", arguments: '{"path":"total.txt","content":"19000"}' }] },
    { text: "The total is 19000." },
  ]);
  const r = await runTask(task("multi-csv-total"), model);
  expect(r).toMatchObject({ success: true, steps: 3, toolCalls: 2, invalidCalls: 0, status: "done" });
});

test("a wrong answer fails with a reason", async () => {
  const r = await runTask(task("chat-math"), new ScriptedModel([{ text: "It is 400." }]));
  expect(r).toMatchObject({ success: false, reason: "wrong number" });
});

test("skills and the fake web are available to tasks", async () => {
  const model = new ScriptedModel([
    { calls: [{ name: "weather", arguments: "{}" }] },
    { calls: [{ name: "web_fetch", arguments: '{"url":"https://wttr.in/Delhi?format=3"}' }] },
    { text: "It is +31°C and sunny in Delhi." },
  ]);
  const r = await runTask(task("skill-weather"), model);
  expect(r.success).toBe(true);
});
