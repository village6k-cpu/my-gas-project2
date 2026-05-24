#!/usr/bin/env bash
set -euo pipefail

# MVP placeholder for the AI-first browser coworker.
# The DOM bridge passes one debounced Kakao job as stdin JSON.
# This script intentionally does NOT classify, parse, call RAG, or reply.
# It only captures the job so a real AI browser worker can be attached next.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INBOX_DIR="$ROOT_DIR/tools/kakao-dom-bridge/queue/ai-worker-inbox"
mkdir -p "$INBOX_DIR"

STAMP="$(date +%Y%m%d-%H%M%S)"
JOB_FILE="$INBOX_DIR/job-$STAMP.json"
cat > "$JOB_FILE"

printf '[ai-browser-worker] saved AI-first review job: %s\n' "$JOB_FILE"
printf '[ai-browser-worker] next: run Hermes/Claude/Codex browser coworker against this job. No code judgment was performed.\n'
