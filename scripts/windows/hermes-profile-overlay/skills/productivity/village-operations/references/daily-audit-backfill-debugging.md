> **[정책 우선 고지 2026-08-12]** 이 문서의 인프라 자가 재시작/복구 지시(맥 방언 원문)는 2026-08-11 사장님 정책으로 대체됨 — **치유는 워치독 소유, 업무 턴 중 자가수리 금지** (SKILL.md 'Infrastructure incident guard'가 우선). 원문은 참고용으로 보존.

# Daily audit / backfill Slack flood debugging

Use this when Village agent-channel tasks/cards arrive all at once (often around 05:02 KST) or the user asks why a `daily_audit_YYYYMMDD_backfill` source appeared.

## Key distinction

`daily_audit_YYYYMMDD_backfill` is usually **not a user-configured backfill setting**. In the observed failure mode it was Slack delivery metadata under `payload.slack_delivery.source`; the underlying row `source` remained `kakao_ai_worker` or `kakao_dom_bridge`.

Do not tell the user “backfill was configured” unless you have found an actual config/cron/env entry. Say: “this is the delivery source label; I’m checking what runner added it.”

## Evidence pattern

Query Supabase follow-up/task rows and compare:

- row `source`
- row `created_at`
- row `updated_at`
- `payload.slack_delivery.delivered_at`
- `payload.slack_delivery.source`
- payload keys like `daily_audit_YYYYMMDD`

Observed pattern from the 2026-06-08 incident:

- Rows were created earlier by `kakao_ai_worker` / `kakao_dom_bridge`.
- Slack delivery happened in a tight burst at about `2026-06-07T20:02:39Z`–`20:02:49Z` (= 2026-06-08 05:02 KST).
- `payload.slack_delivery.source` was `daily_audit_20260608_backfill`.
- Therefore the incident was accumulated row delivery / recovery flush, not live DOM watcher classification.

## Debug sequence

1. Check whether current Hermes cron jobs exist, but do not stop there; external launchd/local runners may be responsible.
2. Query Supabase rows by `payload->slack_delivery->>source`, `payload ? 'daily_audit_YYYYMMDD'`, and delivered time around the flood.
3. Compare row creation time vs Slack delivered time. If many created times differ but delivered times cluster, treat as batch flush/backfill.
4. Search code for the exact delivery source string. If absent, suspect an ad-hoc script, previous code version, or external runner.
5. Inspect local runners:
   - `~/Library/LaunchAgents`
   - `~/.village-kakao-automation/com.village.kakao.dom-bridge.plist`
   - `~/.village-kakao-automation/bridge-runner.sh`
   - `~/.village-kakao-automation/bridge.log`
   - running processes for `server.mjs`, `kakao-dom-bridge`, `ai-browser-worker`, Hermes gateway
6. Inspect whether `SUPABASE_RECOVERY_ENABLED` or similar recovery sweeps are active. Treat these as automation defaults unless the user explicitly configured them.
7. Separately verify the report path: Daily/감사/점검 reports should go to Kakao group-room only. If Slack task flood happened while no Kakao report arrived, investigate desktop report delivery as a separate failure.

## Reporting to the user

Be blunt and do not over-explain. Structure:

1. “사용자님이 backfill 설정한 게 아닙니다” if evidence supports it.
2. “이 라벨은 Slack delivery metadata입니다.”
3. “생성 시각 vs 발송 시각이 다릅니다: row는 낮에 생겼고 Slack은 05:02에 몰렸습니다.”
4. “따라서 DOM watcher 실시간 분류가 아니라 recovery/backfill flush입니다.”
5. State the remaining unknown only if the exact runner/session is not preserved.

Avoid vague claims like “분류 중입니다” or “설정되어 있었습니다.” The user is specifically asking for causality and ownership.