> **[정책 우선 고지 2026-08-12]** 이 문서의 인프라 자가 재시작/복구 지시(맥 방언 원문)는 2026-08-11 사장님 정책으로 대체됨 — **치유는 워치독 소유, 업무 턴 중 자가수리 금지** (SKILL.md 'Infrastructure incident guard'가 우선). 원문은 참고용으로 보존.

# Village Kakao duplicate backstop / stuck queue failure mode

## Symptom

- `./scripts/kakao-automation status` shows bridge, Chrome, CUA, live mode, and auto-send as enabled.
- `events.ndjson`/heartbeats/backstop rows keep updating.
- `jobs.ndjson` may update, but `worker-results.ndjson` and `auto-replies.ndjson` stay stale for many hours.
- `/health` may show `workerRunning=true` and a growing `workerQueueLength`, or repeated `duplicate_supabase_job_requeued` entries.
- User reports "자동화는 도는 것 같은데 자동 답변 안 함".

## Root cause pattern

Two issues can combine:

1. Repeated unread/backstop scans post the same row every few seconds. If `scheduleDebouncedJob()` resets the debounce timer for duplicate `eventHash` values, the room never flushes to a worker job.
2. If Supabase already has the same `jobId` in `ready_for_ai_worker`/`pending_ai_review`, `shouldRunDuplicateJob()` may requeue it on every scan. That fills the in-memory worker queue with duplicate work and delays live decisions/auto-replies.
3. If `SUPABASE_RECOVERY_ENABLED=false`, durable `ready_for_ai_worker`/`ai_worker_error` rows will not be replayed by the recovery sweeper.

## Fix pattern

- In `tools/kakao-dom-bridge/server.mjs`, only reset the debounce timer for a genuinely new event identity. Duplicate backstop events should keep the original timer.
- In duplicate Supabase handling, do not blindly re-run duplicate `ready_for_ai_worker`/`pending_ai_review` rows on every scan. Skip them while fresh and let the recovery sweeper handle old/stale rows.
- Re-enable recovery when needed: `SUPABASE_RECOVERY_ENABLED=true` in `tools/kakao-dom-bridge/.env`.
- Add/confirm launchd `KeepAlive` for the bridge LaunchAgent if restarts are expected.
- Restart with `./scripts/kakao-automation restart`.

## Verification

- `node --check tools/kakao-dom-bridge/server.mjs`
- `bash -n scripts/kakao-automation`
- `./scripts/kakao-automation restart`
- Confirm health shows `supabaseRecoveryEnabled: true`, `workerEnabled: true`, `workerLive: true`, `autoSendEnabled: true`.
- Wait at least one debounce window and verify `worker-results.ndjson` or `auto-replies.ndjson` has a new timestamp, not just that `events.ndjson` is current.
- If `auto-replies.ndjson` is fresh but every customer reply is `{sent:false, gate.reason:"top_row_time_outside_live_window"}`, inspect worker delay/backlog. The auto-send live gate must evaluate Kakao preview clocks against the fresh DOM event timestamp (`detectedAt`/`lastEventAt`) when that event is recent, not against the much later worker completion time; otherwise live customer messages age out while waiting in the worker queue.

If a final verification command is blocked/denied/interrupted, report exactly that and do not claim full end-to-end recovery.