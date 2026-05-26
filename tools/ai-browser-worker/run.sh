#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKER_DIR="$ROOT_DIR/tools/ai-browser-worker"
INBOX_DIR="$ROOT_DIR/tools/kakao-dom-bridge/queue/ai-worker-inbox"
mkdir -p "$INBOX_DIR"

JOB_FILE="$INBOX_DIR/job-$(date +%Y%m%d-%H%M%S)-$$.json"
cat > "$JOB_FILE"

# Safe default: bridge-triggered runs are dry-run unless explicitly enabled.
# To let the worker open Kakao and write review rows, run with AI_WORKER_LIVE=1.
if [[ "${AI_WORKER_LIVE:-0}" == "1" ]]; then
  exec node "$WORKER_DIR/worker.mjs" --stdin-job < "$JOB_FILE"
else
  AI_WORKER_DRY_RUN=1 exec node "$WORKER_DIR/worker.mjs" --stdin-job < "$JOB_FILE"
fi
