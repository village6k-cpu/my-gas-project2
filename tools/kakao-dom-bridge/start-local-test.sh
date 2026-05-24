#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BRIDGE_DIR="$ROOT_DIR/tools/kakao-dom-bridge"
WORKER_CMD="$ROOT_DIR/tools/ai-browser-worker/run.sh"

cd "$BRIDGE_DIR"
mkdir -p queue

export PORT="${PORT:-8787}"
export DEBOUNCE_MS="${DEBOUNCE_MS:-5000}"
export MAX_WAIT_MS="${MAX_WAIT_MS:-30000}"
export QUEUE_DIR="${QUEUE_DIR:-./queue}"
export VILLAGE_AI_WORKER_CMD="${VILLAGE_AI_WORKER_CMD:-$WORKER_CMD}"

# Optional local .env support without committing secrets.
# Values already exported by the shell take precedence over .env values.
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

cat <<EOF
[dom-bridge:test]
- bridge: http://127.0.0.1:${PORT}
- debounce: ${DEBOUNCE_MS}ms
- queue: ${BRIDGE_DIR}/queue
- worker: ${VILLAGE_AI_WORKER_CMD}

Open another terminal to watch:
  tail -f ${BRIDGE_DIR}/queue/events.ndjson
  tail -f ${BRIDGE_DIR}/queue/jobs.ndjson
  tail -f ${BRIDGE_DIR}/queue/worker-results.ndjson
EOF

npm start
