#!/usr/bin/env bash
set -euo pipefail

BRIDGE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$BRIDGE_DIR"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

: "${SUPABASE_URL:?Set SUPABASE_URL in tools/kakao-dom-bridge/.env}"
: "${SUPABASE_SERVICE_ROLE_KEY:?Set SUPABASE_SERVICE_ROLE_KEY in tools/kakao-dom-bridge/.env}"
: "${SUPABASE_TABLE:=ai_processing_events}"

export EVENT_HASH="supabase-smoke-$(date +%s)"
PAYLOAD=$(python3 - <<PY
import json, os, datetime
print(json.dumps({
  "source": "kakao_channel_manager_dom",
  "status": "ready_for_ai_worker",
  "room_key": "supabase-smoke-test",
  "event_hash": os.environ["EVENT_HASH"],
  "preview_text": "Supabase smoke test from Kakao DOM bridge",
  "unread_count": 1,
  "detected_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
  "payload": {"kind": "smoke_test", "eventHash": os.environ["EVENT_HASH"]}
}, ensure_ascii=False))
PY
)

ENDPOINT="${SUPABASE_URL%/}/rest/v1/${SUPABASE_TABLE}"

curl -fsS "$ENDPOINT" \
  -X POST \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "content-type: application/json" \
  -H "prefer: return=representation" \
  --data "$PAYLOAD"

echo
