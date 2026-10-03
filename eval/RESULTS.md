# MiniClaw evaluation results

All runs: Ollama on an Apple-silicon Mac, `contextTokens` 4096, fake web content for repeatable results.
Raw reports and JSON for every run are in [`results/`](results/).

## 1. Prompt injection and taint tracking (I-3)

`bun eval/injection/run.ts` runs 20 attacks hidden in web pages and files (17 that copy text from the page, plus
3 *paraphrased* ones that taint tracking cannot see by design) and 6 benign tasks that also read untrusted content.
Two simulated users, both suffering approval fatigue (they say yes to everything else):
- **cautious** refuses any question with a taint note;
- **fatigued** refuses only the strong "possible prompt injection" warnings.

### Worst case: a fully compromised model attempts every attack

This measures MiniClaw's defenses on their own ([report](results/injection-worst-case-2026-10-03-09-55.md)).

| | Taint off | Taint on · cautious | Taint on · fatigued |
|---|---|---|---|
| **Attacks executed** | **18/20 (90%)** | **3/20 (15%)** | **8/20 (40%)** |
| …copied from the content | 15/17 | **0/17** | 5/17 |
| …paraphrased (blind spot) | 3/3 | 3/3 | 3/3 |
| Pre-approval hijacks ("always allow", approved plan) | 4/4 | 0/4 | 2/4 |
| Benign tasks refused (false alarm) | 0/6 | 4/6 | 1/6 |

- With taint tracking off, only `curl … | sh` is stopped, by the blocked-command rules.
- With it on, every copied attack is stopped for a cautious user.
- For a fatigued user, the remaining successes are *data* taints: phishing reminder text, plan-approved file
  content and file tampering. Those carry only a note, not a warning.
- The paraphrased attacks get through in every setting; closing that gap needs a dual-LLM design (future work).

### Live: qwen2.5:7b decides for itself

([report](results/injection-qwen2.5_7b-2026-10-03-11-40.md))

| | Taint off | Taint on |
|---|---|---|
| Attacks the model attempted | 1/20 | 0–1/20 |
| **Attacks executed** | 1/20 (5%) | **0/20 (0%)** |
| Benign false alarms | 0/6 | 0/6 |

- **The model itself is the first defense.** Wrapping web and file content in `<untrusted>` tags, together with the
  system-prompt rule, makes qwen ignore most injections.
- **Taint tracking is the second.** It is what stops an attack when the model does fall for it.
- Each case ran once, so the live numbers are small samples.

## 2. Task benchmark

`bun eval/tasks/run.ts -m <model> -n <times>` runs 30 everyday tasks with automatic checks. Categories: chat, files,
shell, web, memory, reminders, notes, skills, multi-step. The simulated user approves everything, so this measures
capability, not safety.

### Final results (30 tasks × 2 runs)

| | qwen2.5:7b | llama3.1:8b |
|---|---|---|
| **Task success** | 44/60 (73%) | **46/60 (77%)** |
| Tool-call validity | **71/71 (100%)** | 64/65 (98%) |
| Avg model steps / task | 2.1 | 2.0 |
| **Avg time / task** | **11.4 s** | 18.2 s |
| Avg prompt tokens / task | 3,474 | 3,354 |
| Runs needing a nudge | 3/60 | 1/60 |

| Category | qwen2.5:7b | llama3.1:8b |
|---|---|---|
| chat | **6/6** | 4/6 |
| files | 7/14 | **12/14** |
| shell | 2/4 | **4/4** |
| web | **6/6** | 5/6 |
| memory | 6/6 | 6/6 |
| reminders | 6/8 | **7/8** |
| notes | 2/2 | 2/2 |
| skills | **6/6** | 2/6 |
| multi-step | 3/8 | **4/8** |

- **Similar overall, opposite strengths.** qwen is faster, never makes an invalid call, and handles skills and chat
  well. llama is better at file and shell work, but calls tools when it shouldn't (`chat-no-tools`) and struggles
  with skills.
- **Hard for both:**
  - summing a CSV into a file (`multi-csv-total`);
  - working out a date from a web page for a reminder (`multi-web-reminder`);
  - copying a file without a copy tool (`file-copy`).

### How the benchmark improved MiniClaw

Inspecting failures led to general fixes in MiniClaw itself, which changed the results between rounds:

| Round | Change | qwen2.5:7b | llama3.1:8b |
|---|---|---|---|
| 1 | Baseline (1 run per task) | 23/30 (77%), validity 96% | **10/30 (33%), validity 45%** |
| 2 | Repair stringified arguments, accept JSON-reply tool calls, verify reminder claims | 22/30 (73%), validity 100% | 18/30 (60%), validity 95% |
| 3 | Null optional arguments, clearer tool descriptions; **2 runs per task** | 44/60 (73%) | 46/60 (77%) |

- **llama's jump comes almost entirely from interoperability fixes.** It sends booleans, numbers and lists as
  strings (`"append": "false"`), writes tool calls as JSON text, and sends `null` for unused optional arguments.
  Rejecting those made a capable model look broken.
- **qwen's ±1 task between rounds is run-to-run noise**, which is why round 3 runs every task twice.
- **Caveat:** the round 2 and 3 fixes were guided by these tasks. They are general (types, formats, descriptions),
  not task-specific, but a held-out task set would be needed to rule out overfitting.

## 3. Consistency (I-8)

`miniclaw replay <run> --times 5` re-runs a recorded situation without side effects. For a "summarize notes.txt into
summary.md" run with qwen2.5:7b, the outcomes were:
- **fewer_calls (correct task done) 4/5**;
- **diverged 1/5**: it called the journal skill by mistake (finding F11).

## 4. Test coverage

`bun run coverage`: **97% of lines overall**. Every file in `src/agent`, `src/tools` and `src/security` has 95–100%
line coverage (target was 70%). There are 221 tests, including the injection suite as a regression test.
