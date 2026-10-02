# 🦀 MiniClaw

A minimal, self-hosted, security-first personal AI agent inspired by [OpenClaw](https://github.com/openclaw/openclaw).
Runs fully on your machine with a local model through [Ollama](https://ollama.com). It can read and write files,
run shell commands and fetch web pages, but only inside a sandboxed workspace, with explainable approvals
and an undo button.

> Final Year Project. See [roadmap.md](roadmap.md) for the full plan, design and timeline.

## Status

| Phase | Status |
|---|---|
| 1. CLI + LLM (chat, streaming, doctor) | ✅ Done |
| 2. Agent loop + tools, undo (I-1), plan preview (I-2), risk scoring (I-4) | ✅ Done |
| 3. Persistence & memory, memory inbox (I-5) | ✅ Done |
| 4. Skills, permission manifests (I-6), verified actions | ✅ Done |
| 5. Gateway, Telegram, scheduler (+ panic button, I-9) | ⏳ Next |
| 6–8 | Planned |

## Quick start

Requirements: [Bun](https://bun.sh) ≥ 1.1, [pnpm](https://pnpm.io), [Ollama](https://ollama.com), git.

```bash
pnpm install
ollama pull qwen2.5:7b      # default model (supports tool calling)
cp .env.example .env        # optional: change model / provider
bun run doctor              # check everything is set up
bun run chat                # start chatting
```

Use another model for one session: `bun src/index.ts chat --model llama3.1:8b`

## What it can do

```
you › Read notes.txt and save a 2-bullet summary to summary.md
  ⚙ read notes.txt [low]
    ✔ done
  ⚙ write summary.md [medium]
    • creates summary.md
    • can be reverted with /undo
      @@ -0,0 +1,2 @@
      +- MiniClaw is a local AI agent.
      +- It can undo changes.
    Allow? [yes / no / always allow summary.md this session] y
    ✔ done · changed +summary.md
miniclaw › I created summary.md with two key points from notes.txt.
```

| Tool | What it does | Usual risk |
|---|---|---|
| `read_file` | Read a text file in the workspace | low (auto) |
| `list_dir` | List a workspace folder | low (auto) |
| `write_file` | Create, overwrite or append to a file (shows a diff) | medium |
| `run_shell` | Run a shell command in the workspace | medium – blocked |
| `web_fetch` | Download a web page as text; for JSON APIs, return only chosen `fields` | medium – high |
| `remember` | Propose a fact about you for long-term memory (you confirm it) | low |
| `recall_notes` | Read the daily log of a given day | low |
| *each skill* | Returns the skill's instructions (asks for consent on first use) | high once, then low |

### Chat commands

| Command | Description |
|---|---|
| `/plan <task>` | Show the agent's plan with a risk level per step, approve it once, then run it |
| `/memory` | Show what MiniClaw remembers about you |
| `/inbox` | Review memories the agent proposed |
| `/forget <words>` | Delete remembered facts containing these words |
| `/notes [date]` | Show the daily log (`today`, `yesterday` or `YYYY-MM-DD`) |
| `/undo [n]` | Undo the last *n* file changes made by the agent |
| `/history` | List agent changes that can be undone |
| `/skills` | List installed skills, their permissions and consent status |
| `/tools` | List available tools |
| `/new` | New conversation (also forgets "always allow" approvals). Otherwise the last conversation continues after a restart. |
| `/help`, `/exit` | Help, quit (or Ctrl+D) |

Press **Ctrl+C** while the agent is working (or at an approval prompt) to stop it.

## Memory

```
you › I'm vegetarian and I'm in Goa this week.
  ⚙ remember "User is vegetarian." [low]
  ⚙ remember "User is in Goa this week." [low]
📥 Remember this? User is vegetarian.        [yes / no / later] y
   ✔ saved to memory
```

- **Conversations** are saved in SQLite (`data/miniclaw.db`) and continue after a restart.
- **Long-term facts** live in `data/memory/MEMORY.md`, a Markdown file you can read and edit. Facts can expire.
- **Memory inbox (I-5):** the agent can only *propose* memories; nothing is saved until you say yes.
  If a proposal comes after the agent read a web page or file, you get a ⚠ prompt-injection warning naming the source.
- **Persona:** edit `data/memory/IDENTITY.md` to change MiniClaw's personality and rules.
- **Daily notes:** `data/memory/notes/YYYY-MM-DD.md` logs each request and the actions taken.

## Skills

A skill is a folder with a `SKILL.md`: instructions for a task plus the permissions it needs. Drop a folder into
`skills/` and restart. No code changes are needed. Included: `weather` (wttr.in), `github-summary` (GitHub API),
`daily-journal` (files in the workspace) and `wikipedia` (topic summaries).

```markdown
---
name: weather
description: Current weather and a 3-day forecast for any city, from wttr.in.
permissions:
  - net:wttr.in
---
# Weather
1. For the current weather, call web_fetch with https://wttr.in/<City>?format=...
```

| Permission | Allows |
|---|---|
| `fs:read` / `fs:write` | read / change files in the workspace |
| `net:<host>` | fetch from that host (`*.example.com` for subdomains, `*` for any) |
| `shell:<program>` | run simple commands with that program (`*` for any command) |
| `memory` | propose memories, read daily notes |

**Permission manifests (I-6):**
- The first time a skill is used, you approve its permissions, like installing an app.
- If its `SKILL.md` changes later, you're asked again.
- While a skill is active, anything outside its permissions is raised to high risk and always asks.

Commands: `miniclaw skills` (list), `miniclaw skills revoke <name>` (ask again next time).

## Safety model

- **Sandbox:** file tools only work inside `workspace/`. Path traversal, symlink escapes and `.git` are refused.
- **Risk scoring (I-4):** every call is rated by fixed rules, not by the model, so a prompt injection can't argue its way past them.
  - `low` runs automatically.
  - `medium` asks, and you can allow it for the rest of the session.
  - `high` always asks and says why (e.g. *"deletes files"*, *"uses the network"*).
  - `blocked` never runs (e.g. `sudo`, `rm -rf ~`, `curl … | sh`).
- **Undo (I-1):** every change the agent makes to the workspace is a git checkpoint stored in `data/checkpoints.git`,
  outside the workspace, so the agent can't tamper with it.
- **Plan preview (I-2):** approve a whole multi-step task once. Only its medium-risk steps are pre-approved.
- **Untrusted content:** file and web content is wrapped in `<untrusted>` tags that can't be escaped, and the model is told never to follow instructions inside them.
- **No secrets to tools:** shell commands get a minimal environment (no API keys); `web_fetch` re-checks every redirect (no SSRF to `localhost`).
- **Verified actions:** if the model claims "Added to your journal" but never called a tool, you see a warning,
  and the model is asked once to actually do it. Small models do this surprisingly often.
- **Audit log:** every tool call is recorded in SQLite (`audit_log`), with secrets redacted.

## Configuration

> **Context window:** Ollama often runs models with a 4096-token window and silently drops anything longer.
> MiniClaw fits everything into `agent.contextTokens` (default 4096). For longer conversations, start Ollama
> with `OLLAMA_CONTEXT_LENGTH=8192` and set `contextTokens` to 8192. `bun run doctor` checks that they match.


Settings are read in this order (later ones win): defaults → `miniclaw.config.json` → `.env` → CLI flags.

| Env var | Default | Description |
|---|---|---|
| `LLM_BASE_URL` | `http://localhost:11434/v1` | Any OpenAI-compatible API (Ollama, OpenAI, Groq, OpenRouter) |
| `LLM_MODEL` | `qwen2.5:7b` | Model name |
| `OPENAI_API_KEY` | – | Only needed for cloud providers |

Example `miniclaw.config.json`:

```json
{
  "llm": { "model": "qwen2.5:7b", "temperature": 0.5 },
  "agent": { "name": "MiniClaw", "maxSteps": 8, "contextTokens": 4096, "replyTokens": 768 },
  "paths": { "workspace": "workspace", "data": "data" }
}
```

## Development

```bash
bun test            # unit + integration tests (the agent loop is tested with a scripted fake LLM)
bun run typecheck   # TypeScript type check
```

```
src/
├── index.ts               # CLI entry (commander): chat, doctor
├── config.ts              # config loading + validation (zod)
├── doctor.ts              # setup checks
├── agent/
│   ├── agent.ts           # agent loop: LLM ⇄ tools, approvals, checkpoints, audit, notes
│   ├── planner.ts         # /plan: structured, risk-scored plans (I-2)
│   ├── prompt.ts          # system prompt: identity + memory + tool rules
│   ├── session.ts         # conversation as whole turns, fitted to the token budget
│   └── tokens.ts          # token estimates
├── db/                    # SQLite: migrations, session store
├── memory/                # MEMORY.md facts, inbox (I-5), IDENTITY.md, daily notes
├── channels/cli.ts        # terminal UI, approval prompts, slash commands
├── llm/                   # provider interface + OpenAI-compatible client (streaming tool calls)
├── skills/                # SKILL.md loader, permission manifests (I-6), consent grants
├── security/
│   ├── sandbox.ts         # workspace path checks
│   ├── risk.ts            # rule-based risk scoring (I-4)
│   ├── approvals.ts       # approval policy (auto / session / plan / ask / block)
│   └── audit.ts           # JSONL audit log with secret redaction
├── tools/                 # read_file, list_dir, write_file, run_shell, web_fetch, remember, recall_notes, skill tools
└── workspace/checkpoints.ts  # git-backed undo (I-1)
```
