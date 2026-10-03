#!/usr/bin/env bash
# Creates a fresh, isolated MiniClaw for recording demos: its own workspace, memory and
# database, and sample files. No .env, so no secrets can appear on screen.
# Temperature 0 keeps the model's answers repeatable between recordings.
# Skills are only included with MINICLAW_DEMO_SKILLS=1 (so they can't misfire in other scenes).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
DEMO="${MINICLAW_DEMO_DIR:-/tmp/miniclaw-demo}"

rm -rf "$DEMO"
mkdir -p "$DEMO/workspace"
if [ "${MINICLAW_DEMO_SKILLS:-0}" = "1" ]; then cp -R "$REPO/skills" "$DEMO/skills"; fi
cat > "$DEMO/miniclaw.config.json" <<JSON
{ "agent": { "name": "MiniClaw" }, "llm": { "temperature": 0 } }
JSON
cat > "$DEMO/workspace/notes.txt" <<'TXT'
Project meeting on Monday at 10:00.
Budget approved: 4,500 rupees.
Email Priya the final slides.
The demo is on Friday.
TXT
cat > "$DEMO/workspace/data.csv" <<'TXT'
item,amount
rent,12000
food,4500
travel,1800
TXT
echo "$DEMO"
