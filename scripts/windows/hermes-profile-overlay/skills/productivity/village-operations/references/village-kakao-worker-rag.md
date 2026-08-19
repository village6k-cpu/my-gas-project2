# Village Kakao worker RAG verification

Use this when the user asks whether the Kakao DOM watcher / auto-reply system is connected to their Village RAG.

## Key distinction

There are two different surfaces:

1. **Current Hermes/Slack session** — may have no direct RAG tool and `hermes mcp list` may show no MCP servers.
2. **Kakao AI browser worker** — can still be connected to village-ai RAG through its own environment and helper command.

Do not conclude “RAG is not connected” from Hermes global MCP/config alone. Check the worker-specific path.

## Worker RAG path

Project default: `C:\Village\runtimes\my-gas-project2-production`.

Relevant files:

- `tools/kakao-dom-bridge/.env`
- `tools/ai-browser-worker/worker.mjs`
- `tools/kakao-dom-bridge/queue/worker-results.ndjson`
- `tools/kakao-dom-bridge/queue/auto-replies.ndjson`

Expected env keys in `tools/kakao-dom-bridge/.env`:

```text
VILLAGE_AI_URL=...
VILLAGE_AI_KAKAO_SKILL_SECRET=...
VILLAGE_AI_RAG_TIMEOUT_MS=30000
```

VILLAGE_AI_RAG_TIMEOUT_MS=30000
```

The helper path is:
```

VILLAGE_AI_RAG_TIMEOUT_MS=30000
```

The helper path is:

```bash
node tools/ai-browser-worker/worker.mjs --rag-lookup
```

It posts to:

```text
{VILLAGE_AI_URL}/api/ask
```

with `x-kakao-skill-secret` when configured.

## Safe verification probe

Use a non-sensitive read-only question. Example:

```bash
printf '%s' '{"question":"검증용 질문입니다. 빌리지렌탈샵 주소와 영업시간이 어떻게 되나요? 카카오 자동응답 RAG 연결 확인용입니다.","userRole":"customer"}' \
  | node tools/ai-browser-worker/worker.mjs --rag-lookup
```

A healthy response normally includes fields like:

```json
{
  "confidence": "high",
  "knowledgeSource": "retrieved",
  "usedSources": [{"source_type":"documents", "similarity": 0.7}],
  "logId": "...",
  "done": true
}
```

Do not print secrets. Mask `*_SECRET`, `*_KEY`, `*_TOKEN` values in reports.

## Runtime evidence

Recent worker results may contain `decision.rag_usage` inside JSON stdout in `worker-results.ndjson`. Useful fields:

```json
{
  "rag_usage": {
    "used": true,
    "required_for_auto_send": false,
    "logId": "...",
    "confidence": "low|high",
    "knowledgeSource": "retrieved|general",
    "usedSources": [],
    "applied_to_reply": false,
    "reason": "..."
  }
}
```

Interpretation:

- `rag_usage.used=true` means the worker consulted RAG for that job.
- `confidence=low`, `ownerReview=true`, or `knowledgeSource=general` should usually prevent auto-send support.
- `rag_usage.used=false` can be correct for reservation, inventory, duplicate, or screen-evidence-only decisions.

## Policy boundaries

RAG is read-only reference memory. It must not replace:

- current Kakao screen evidence,
- current inventory/availability checks,
- GAS/Sheets duplicate checks,
- booking confirmation or schedule/contract mutations,
- current confirmed policy blocks in the worker prompt.

If current confirmed policy conflicts with older RAG/Kakao history, current confirmed policy wins.

## Reporting pattern

Use this concise shape:

```text
확인 결과:
- 현재 Slack Hermes: 직접 RAG tool 없음 / 있음
- 카카오 AI worker: RAG 연결됨 / 안 됨
- 근거: VILLAGE_AI_URL 설정, --rag-lookup 응답, worker-results rag_usage
- 주의: RAG는 참고 기억이고, 재고/예약 확정 근거는 아님
```
