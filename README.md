# 🦀 MiniClaw

A minimal, self-hosted, security-first personal AI agent inspired by [OpenClaw](https://github.com/openclaw/openclaw).
Runs fully on your machine with a local model through [Ollama](https://ollama.com).

> Final Year Project. See [roadmap.md](roadmap.md) for the full plan, design and timeline.

## Status

| Phase | Status |
|---|---|
| 1. CLI + LLM (chat, streaming, doctor) | ✅ Done |
| 2. Agent loop + tools (+ undo, plan preview, risk scoring) | ⏳ Next |
| 3–8 | Planned |

## Quick start

Requirements: [Bun](https://bun.sh) ≥ 1.1, [pnpm](https://pnpm.io), [Ollama](https://ollama.com).

```bash
pnpm install
ollama pull qwen2.5:7b      # default model (supports tool calling)
cp .env.example .env        # optional: change model / provider
bun run doctor              # check everything is set up
bun run chat                # start chatting
```

Use another model for one session:

```bash
bun src/index.ts chat --model llama3.1:8b
```

Chat commands: `/new` (new conversation), `/help`, `/exit`. Press **Ctrl+C** while the agent is replying to stop it.

## Configuration

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
  "agent": { "name": "MiniClaw", "historyLimit": 20 }
}
```

## Development

```bash
bun test            # unit tests
bun run typecheck   # TypeScript type check
```

```
src/
├── index.ts               # CLI entry (commander)
├── config.ts              # config loading + validation (zod)
├── doctor.ts              # setup checks
├── agent/session.ts       # conversation history
├── channels/cli.ts        # terminal chat
└── llm/                   # provider interface + OpenAI-compatible client
```
