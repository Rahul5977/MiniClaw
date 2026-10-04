#!/usr/bin/env bash
# Runs the worst-case prompt-injection evaluation and prints its main table, readable on video.
# The result files this run writes are removed again (the committed results stay as they are).
set -euo pipefail
cd "$(dirname "$0")/.."
before=$(ls eval/results)
bun eval/injection/run.ts 2>&1 | sed -n '/^| |/,/^$/p' | grep -v -- '---|' \
  | sed 's/\*\*//g; s/^| |/| Worst case |/; s/^| //; s/ |$//' | column -t -s '|'
for f in $(ls eval/results); do grep -qx "$f" <<<"$before" || rm -f "eval/results/$f"; done
