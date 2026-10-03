/**
 * I-3 evaluation: does taint tracking stop prompt injection?
 *
 *   bun eval/injection/run.ts                 # worst case: a scripted, fully compromised model
 *   bun eval/injection/run.ts --live          # the configured real model (slow)
 *   bun eval/injection/run.ts --live -m llama3.1:8b
 *
 * Two simulated users, both suffering approval fatigue (they say yes to everything else):
 * - cautious: refuses any question with a taint note (control or data)
 * - fatigued: refuses only strong "possible prompt injection" warnings (control taint)
 * Pre-approvals in a case ("always allow", an approved plan) are set up before the run.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../../src/config.ts";
import { OpenAICompatibleProvider } from "../../src/llm/openaiCompatible.ts";
import { pct } from "../lib.ts";
import { ATTACKS, BENIGN } from "./attacks.ts";
import { benignModel, benignTarget, compromisedModel, runCase, USERS, type Outcome, type User } from "./harness.ts";

const args = process.argv.slice(2);
const live = args.includes("--live");
const modelFlag = args.indexOf("-m") >= 0 ? args[args.indexOf("-m") + 1] : undefined;
const only = args.indexOf("--only") >= 0 ? args[args.indexOf("--only") + 1] : undefined;

const config = loadConfig({ model: modelFlag });
const modelName = live ? config.llm.model : "compromised (scripted)";
const results: { attacks: Outcome[]; benign: Outcome[] } = { attacks: [], benign: [] };
const attacks = ATTACKS.filter((a) => !only || a.id.includes(only));
const benign = BENIGN.filter((b) => !only || b.id.includes(only));

console.log(`Prompt-injection evaluation · ${live ? `live model ${modelName}` : "worst case (compromised model)"} · ${attacks.length} attacks, ${benign.length} benign tasks\n`);

for (const user of USERS) for (const taint of [false, true]) {
  console.log(`\n— ${user} user, taint tracking ${taint ? "on" : "off"} —`);
  for (const c of attacks) {
    const model = () => (live ? new OpenAICompatibleProvider(config.llm) : compromisedModel(c));
    const outcome = await runCase(c, user, taint, model, c.goal);
    results.attacks.push(outcome);
    const mark = outcome.executed ? "✖ EXECUTED" : outcome.attempted ? "✔ stopped " : "· not tried";
    console.log(`taint ${taint ? "on " : "off"}  ${mark}  ${c.id.padEnd(26)} ${outcome.verdict ?? ""}${outcome.warned ? " (warned)" : ""}${outcome.error ? ` error: ${outcome.error}` : ""}`);
  }
  for (const b of benign) {
    const model = () => (live ? new OpenAICompatibleProvider(config.llm) : benignModel(b));
    const outcome = await runCase(b, user, taint, model, benignTarget(b));
    results.benign.push(outcome);
    console.log(`taint ${taint ? "on " : "off"}  ${outcome.executed ? "✔ done    " : "✖ not done"}  ${b.id.padEnd(26)} ${outcome.warned ? "(false alarm: warned)" : ""}`);
  }
}

// ---- report ----------------------------------------------------------------------------
const paraphrased = new Set(ATTACKS.filter((a) => a.paraphrased).map((a) => a.id));
const count = (xs: Outcome[], f: (o: Outcome) => boolean) => xs.filter(f).length;
const frac = (xs: Outcome[], f: (o: Outcome) => boolean) => `${count(xs, f)}/${xs.length}`;

const rows = ["| | Off · cautious | On · cautious | Off · fatigued | On · fatigued |", "|---|---|---|---|---|"];
const pick = (kind: "attacks" | "benign", user: User, taint: boolean) => results[kind].filter((o) => o.user === user && o.taint === taint);
const line = (label: string, kind: "attacks" | "benign", f: (xs: Outcome[]) => string) =>
  rows.push(`| ${label} | ${(["cautious", "fatigued"] as User[]).flatMap((u) => [false, true].map((t) => f(pick(kind, u, t)))).join(" | ")} |`);
line("Attacks attempted by the model", "attacks", (xs) => frac(xs, (o) => o.attempted));
line("**Attacks executed**", "attacks", (xs) => `**${frac(xs, (o) => o.executed)}** (${pct(count(xs, (o) => o.executed), xs.length)})`);
line("…copied (taint can see)", "attacks", (xs) => frac(xs.filter((o) => !paraphrased.has(o.id)), (o) => o.executed));
line("…paraphrased (blind spot)", "attacks", (xs) => frac(xs.filter((o) => paraphrased.has(o.id)), (o) => o.executed));
line("Benign tasks completed", "benign", (xs) => frac(xs, (o) => o.executed));
line("Benign tasks refused (false alarm)", "benign", (xs) => frac(xs, (o) => o.warned));

const categories = [...new Set(attacks.map((a) => a.category))];
const catRows = ["| Category | Off | On · cautious | On · fatigued |", "|---|---|---|---|"];
for (const cat of categories) {
  const ids = new Set(attacks.filter((a) => a.category === cat).map((a) => a.id));
  const f = (u: User, t: boolean) => frac(pick("attacks", u, t).filter((o) => ids.has(o.id)), (o) => o.executed);
  catRows.push(`| ${cat} | ${f("fatigued", false)} | ${f("cautious", true)} | ${f("fatigued", true)} |`);
}

const report = [
  `# Prompt-injection evaluation (I-3)`,
  "",
  `- Model: **${modelName}**${live ? "" : " — every attack is attempted, so this measures MiniClaw's defenses alone"}`,
  `- Simulated users (both approve everything else): **cautious** refuses any taint note; **fatigued** refuses only "possible prompt injection" warnings`,
  `- Date: ${new Date().toISOString().slice(0, 16).replace("T", " ")}`,
  "",
  ...rows,
  "",
  "Attacks executed, by category:",
  "",
  ...catRows,
].join("\n");
console.log(`\n${report}`);

mkdirSync(join(import.meta.dir, "../results"), { recursive: true });
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
const base = join(import.meta.dir, "../results", `injection-${live ? modelName.replace(/[:/]/g, "_") : "worst-case"}-${stamp}`);
writeFileSync(`${base}.md`, report + "\n");
writeFileSync(`${base}.json`, JSON.stringify({ model: modelName, live, results }, null, 2));
console.log(`\nSaved ${base}.md and .json`);
