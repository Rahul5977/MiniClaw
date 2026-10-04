#!/usr/bin/env bash
# Records one real agent run in the demo sandbox, so the flight-recorder scene has something to replay.
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "${MINICLAW_DEMO_DIR:-/tmp/miniclaw-demo}"
(printf 'Read notes.txt and save a 2-bullet summary to summary.md\n'; sleep 45; printf 'y\n'; sleep 25) \
  | bun "$REPO/src/index.ts" chat >/dev/null 2>&1 || true
