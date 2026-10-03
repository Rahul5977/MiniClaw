/**
 * Task benchmark (§10.2): 30 everyday tasks with automatic success checks.
 * Web content is faked (see `web` below) so results don't depend on the internet.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { addDays, today } from "../../src/memory/facts.ts";
import type { Runtime } from "../../src/runtime.ts";

export interface TaskContext {
  runtime: Runtime;
  /** The final answer shown to the user. */
  answer: string;
  /** Tool names called during the run (successful or not). */
  tools: string[];
}

export interface Task {
  id: string;
  category: string;
  request: string;
  /** Skills the task needs (copied in and pre-approved). */
  skills?: string[];
  setup?: (runtime: Runtime) => void | Promise<void>;
  /** Returns true on success, or a short reason for failure. */
  check: (ctx: TaskContext) => true | string;
}

const file = (rt: Runtime, path: string) => join(rt.workspace, path);
const read = (rt: Runtime, path: string) => (existsSync(file(rt, path)) ? readFileSync(file(rt, path), "utf8") : null);
const write = (rt: Runtime, path: string, content: string) => Bun.write(file(rt, path), content);
const has = (text: string | null | undefined, ...words: string[]) => !!text && words.every((w) => text.toLowerCase().includes(w.toLowerCase()));
const ok = (condition: boolean, reason: string): true | string => (condition ? true : reason);
const bullets = (text: string | null) => (text ?? "").split("\n").filter((l) => /^\s*([-*•]|\d+[.)])\s+\S/.test(l)).length;

const NOTES = "Project meeting on Monday at 10:00.\nBudget approved: 4,500 rupees.\nEmail Priya the final slides.\nThe demo is on Friday.\n";
const CSV = "item,amount\nrent,12000\nfood,4500\ntravel,1800\nbooks,700\n";

/** Fake web used by every task: exact URLs, or "host:<name>" for a whole site. */
export const WEB: Record<string, string> = {
  "https://news.example.com/solar":
    "Solar power in India grew 30% last year. Rajasthan leads with the most installed capacity. " +
    "Rooftop solar subsidies were extended to 2027. Experts expect costs to fall another 10%.",
  "https://events.example.com/hackathon":
    "MiniHack 2026: a 24-hour student hackathon. Registration closes on 2026-10-20. Venue: IIT Patna, Bihta campus.",
  "https://api.example.com/repos/mini/claw": JSON.stringify({
    full_name: "mini/claw",
    stargazers_count: 4321,
    forks_count: 210,
    language: "TypeScript",
    owner: { login: "mini" },
    urls: { a: "x".repeat(4000) },
  }),
  "host:wttr.in": "Delhi: ☀️ Sunny, +31°C (feels like +33°C), wind ↗12km/h, humidity 40%",
  "host:en.wikipedia.org": JSON.stringify({
    title: "Alan Turing",
    description: "English computer scientist (1912–1954)",
    extract: "Alan Turing was an English mathematician and logician, widely regarded as the father of theoretical computer science.",
  }),
};

export const TASKS: Task[] = [
  // --- chat: no tools needed ---------------------------------------------------------
  { id: "chat-math", category: "chat", request: "What is 17 times 23? Reply with just the number.", check: (c) => ok(c.answer.includes("391"), "wrong number") },
  { id: "chat-fact", category: "chat", request: "What is the capital of Japan? One word.", check: (c) => ok(has(c.answer, "tokyo"), "not Tokyo") },
  { id: "chat-no-tools", category: "chat", request: "Tell me a one-line joke about computers.", check: (c) => ok(c.tools.length === 0 && c.answer.length > 10, "used tools or no joke") },

  // --- files ---------------------------------------------------------------------------
  {
    id: "file-create-todo", category: "files", request: "Create todo.md with a bulleted list of 3 tasks for preparing a hackathon.",
    check: (c) => ok(bullets(read(c.runtime, "todo.md")) >= 3, "todo.md missing or fewer than 3 bullets"),
  },
  {
    id: "file-read-answer", category: "files", request: "Read notes.txt. How much budget was approved?",
    setup: (rt) => write(rt, "notes.txt", NOTES),
    check: (c) => ok(/4,?500/.test(c.answer), "budget not in answer"),
  },
  {
    id: "file-append", category: "files", request: "Add the line 'Deployed version 1.2' to the end of log.md without removing what is already there.",
    setup: (rt) => write(rt, "log.md", "Started project\nFixed login bug\n"),
    check: (c) => { const t = read(c.runtime, "log.md"); return ok(has(t, "started project", "fixed login bug", "deployed version 1.2"), "old lines lost or new line missing"); },
  },
  {
    id: "file-list-count", category: "files", request: "How many files are in the reports folder? Answer with the number.",
    setup: async (rt) => { for (const n of ["jan.txt", "feb.txt", "mar.txt", "apr.txt"]) await write(rt, `reports/${n}`, n); },
    check: (c) => ok(/\b4\b|four/i.test(c.answer), "wrong count"),
  },
  {
    id: "file-json", category: "files", request: 'Create config.json containing a JSON object with "theme" set to "dark" and "fontSize" set to 14.',
    check: (c) => { try { const j = JSON.parse(read(c.runtime, "config.json") ?? ""); return ok(j.theme === "dark" && Number(j.fontSize) === 14, "wrong values"); } catch { return "config.json missing or not valid JSON"; } },
  },
  {
    id: "file-copy", category: "files", request: "Make a copy of draft.txt named final.txt.",
    setup: (rt) => write(rt, "draft.txt", "The quick brown fox.\n"),
    check: (c) => ok(has(read(c.runtime, "final.txt"), "quick brown fox"), "final.txt missing or different"),
  },
  {
    id: "file-find", category: "files", request: "Which file in the workspace mentions the word 'Friday'? Tell me the file name.",
    setup: async (rt) => { await write(rt, "a.txt", "Lunch on Monday."); await write(rt, "b.txt", "Demo on Friday."); await write(rt, "c.txt", "Gym on Sunday."); },
    check: (c) => ok(has(c.answer, "b.txt"), "b.txt not named"),
  },

  // --- shell -----------------------------------------------------------------------------
  {
    id: "shell-count-lines", category: "shell", request: "Use a shell command to count the lines in data.csv. Tell me the number.",
    setup: (rt) => write(rt, "data.csv", CSV),
    check: (c) => ok(c.tools.includes("run_shell") && /\b5\b|five/i.test(c.answer), "no shell or wrong count"),
  },
  {
    id: "shell-mkdir", category: "shell", request: "Create a folder called archive and move old.txt into it.",
    setup: (rt) => write(rt, "old.txt", "old stuff\n"),
    check: (c) => ok(existsSync(file(c.runtime, "archive/old.txt")) && !existsSync(file(c.runtime, "old.txt")), "not moved"),
  },

  // --- web (fake) ------------------------------------------------------------------------
  {
    id: "web-summary", category: "web", request: "Summarize https://news.example.com/solar in 3 bullet points.",
    check: (c) => ok(c.tools.includes("web_fetch") && bullets(c.answer) >= 2 && has(c.answer, "solar"), "not fetched or not a bulleted summary"),
  },
  {
    id: "web-json-field", category: "web", request: "How many stars does the repository at https://api.example.com/repos/mini/claw have? It is a JSON API.",
    check: (c) => ok(/4,?321/.test(c.answer), "star count missing"),
  },
  {
    id: "web-to-file", category: "web", request: "Read https://news.example.com/solar and save a 2-sentence summary to solar.md.",
    check: (c) => ok(has(read(c.runtime, "solar.md"), "solar"), "solar.md missing or off-topic"),
  },

  // --- memory ----------------------------------------------------------------------------
  {
    id: "memory-propose", category: "memory", request: "Please remember that I'm allergic to peanuts.",
    check: (c) => ok(c.runtime.inbox.pending().some((p) => has(p.fact, "peanut")), "no memory proposed"),
  },
  {
    id: "memory-recall", category: "memory", request: "Which city do I live in?",
    setup: (rt) => void rt.facts.add("User lives in Pune."),
    check: (c) => ok(has(c.answer, "pune"), "did not use memory"),
  },
  {
    id: "memory-use", category: "memory", request: "Suggest one dinner dish for me tonight. One line.",
    setup: (rt) => void rt.facts.add("User is vegetarian."),
    check: (c) => ok(!/chicken|mutton|fish|beef|pork|prawn|egg|meat/i.test(c.answer) && c.answer.length > 3, "suggested a non-vegetarian dish"),
  },

  // --- reminders -------------------------------------------------------------------------
  {
    id: "reminder-relative", category: "reminders", request: "Remind me in 30 minutes to stretch.",
    check: (c) => { const r = c.runtime.reminders.pending()[0]; const mins = r ? (r.dueAt - Date.now()) / 60_000 : -1; return ok(!!r && has(r.text, "stretch") && mins > 25 && mins < 35, "no reminder about 30 minutes from now"); },
  },
  {
    id: "reminder-daily", category: "reminders", request: "Every day at 08:00, remind me to drink water.",
    check: (c) => { const r = c.runtime.reminders.pending()[0]; return ok(!!r && r.repeat === "daily" && new Date(r.dueAt).getHours() === 8 && has(r.text, "water"), "no daily 08:00 reminder"); },
  },
  {
    id: "reminder-list", category: "reminders", request: "What reminders do I have coming up?",
    setup: (rt) => void rt.reminders.add({ sessionId: "setup", text: "Pay electricity bill", dueAt: Date.now() + 86_400_000 }),
    check: (c) => ok(has(c.answer, "electricity"), "reminder not listed"),
  },
  {
    id: "reminder-cancel", category: "reminders", request: "Cancel my reminder about the gym.",
    setup: (rt) => { rt.reminders.add({ sessionId: "setup", text: "Go to the gym", dueAt: Date.now() + 3_600_000 }); rt.reminders.add({ sessionId: "setup", text: "Call mom", dueAt: Date.now() + 7_200_000 }); },
    check: (c) => { const left = c.runtime.reminders.pending().map((r) => r.text); return ok(left.length === 1 && left[0] === "Call mom", `left: ${left.join(", ")}`); },
  },

  // --- notes -----------------------------------------------------------------------------
  {
    id: "notes-yesterday", category: "notes", request: "What did we work on yesterday?",
    setup: (rt) => {
      const y = new Date(`${addDays(today(), -1)}T15:00:00`);
      rt.notes.append('"Fix the payment page bug" → write checkout.js', y);
    },
    check: (c) => ok(has(c.answer, "payment") || has(c.answer, "checkout"), "did not recall yesterday's notes"),
  },

  // --- skills ----------------------------------------------------------------------------
  { id: "skill-weather", category: "skills", skills: ["weather"], request: "What's the weather in Delhi right now?", check: (c) => ok(c.answer.includes("31"), "temperature missing") },
  { id: "skill-wikipedia", category: "skills", skills: ["wikipedia"], request: "Who was Alan Turing? Two sentences.", check: (c) => ok(has(c.answer, "mathematician") || has(c.answer, "computer science"), "no Wikipedia facts") },
  {
    id: "skill-journal", category: "skills", skills: ["daily-journal"], request: "Journal: had a productive day finishing the dashboard.",
    check: (c) => ok(has(read(c.runtime, `journal/${today()}.md`), "dashboard"), "journal entry missing"),
  },

  // --- multi-step ------------------------------------------------------------------------
  {
    id: "multi-summary-file", category: "multi-step", request: "Read notes.txt and save a 2-bullet summary to summary.md.",
    setup: (rt) => write(rt, "notes.txt", NOTES),
    check: (c) => ok(bullets(read(c.runtime, "summary.md")) >= 2, "summary.md missing or not 2 bullets"),
  },
  {
    id: "multi-csv-total", category: "multi-step", request: "Read data.csv, add up the amount column, and write just the total to total.txt.",
    setup: (rt) => write(rt, "data.csv", CSV),
    check: (c) => ok(/19,?000/.test(read(c.runtime, "total.txt") ?? ""), `total.txt has: ${read(c.runtime, "total.txt")?.trim() ?? "nothing"}`),
  },
  {
    id: "multi-web-reminder", category: "multi-step", request: "Check https://events.example.com/hackathon and remind me at 09:00 on the day registration closes.",
    check: (c) => { const r = c.runtime.reminders.pending()[0]; const d = r && new Date(r.dueAt); return ok(!!d && d.getDate() === 20 && d.getMonth() === 9 && d.getHours() === 9, "no reminder at 09:00 on 20 Oct"); },
  },
  {
    id: "multi-project", category: "multi-step", request: "Create project/src/index.js that prints 'hello' with console.log, and a project/README.md that says how to run it with node.",
    check: (c) => ok(has(read(c.runtime, "project/src/index.js"), "console.log", "hello") && has(read(c.runtime, "project/README.md"), "node"), "files missing or incomplete"),
  },
];
