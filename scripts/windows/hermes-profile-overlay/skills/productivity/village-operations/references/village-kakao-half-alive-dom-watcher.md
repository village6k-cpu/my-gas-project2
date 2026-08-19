> **[정책 우선 고지 2026-08-12]** 이 문서의 인프라 자가 재시작/복구 지시(맥 방언 원문)는 2026-08-11 사장님 정책으로 대체됨 — **치유는 워치독 소유, 업무 턴 중 자가수리 금지** (SKILL.md 'Infrastructure incident guard'가 우선). 원문은 참고용으로 보존.

# Village Kakao DOM watcher: half-alive failure pattern

## Symptom
The pipeline can look healthy while customer-facing automation is effectively stopped:

- Bridge `/health` returns ok.
- Chrome automation profile and Kakao chat tab are present.
- `events.ndjson` and `heartbeats.ndjson` keep receiving rows.
- But `jobs.ndjson`, `worker-results.ndjson`, and `auto-replies.ndjson` are stale for hours.

This means the detector/content script is alive, but events are not turning into worker jobs or worker outcomes.

## Checks that caught it
From `/Users/village6k/my-gas-project2`:

```bash
./scripts/kakao-automation status
./scripts/kakao-automation logs 240
```

Then compare recent timestamps/counts across queue files:

- `tools/kakao-dom-bridge/queue/events.ndjson`
- `tools/kakao-dom-bridge/queue/heartbeats.ndjson`
- `tools/kakao-dom-bridge/queue/jobs.ndjson`
- `tools/kakao-dom-bridge/queue/worker-results.ndjson`
- `tools/kakao-dom-bridge/queue/auto-replies.ndjson`
- `tools/kakao-dom-bridge/queue/backstop-events.ndjson`

Key diagnostic: many recent `pending_ai_review`/`top_rows_backstop` events but zero recent jobs/results/replies.

## Common causes observed
- Automation Chrome profile had stale/duplicate Kakao chat tabs.
- A Kakao login / 2FA tab appeared in the automation profile, which can block workers from opening target conversations.
- The active tab/list was showing old dated rows, so backstop events kept arriving but did not qualify as live worker jobs.

## Recovery sequence
Use non-customer-facing recovery first:

```bash
./scripts/kakao-automation cleanup-tabs
./scripts/kakao-automation start
```

If jobs still do not appear after the debounce window, fully restart bridge and the automation Chrome profile:

```bash
./scripts/kakao-automation stop
# then kill only Chrome processes whose command includes --user-data-dir=$HOME/.village-kakao-chrome
./scripts/kakao-automation start
```

After restart, wait at least `DEBOUNCE_MS` (usually 60s), then verify:

- `/health` shows `debouncedJobs > 0` when there are live/unread candidates.
- `workerRunning` or fresh `worker-results.ndjson` rows appear.
- `failedWorkerRuns` remains 0.
- Recent `auto-replies.ndjson` rows explain whether a send was attempted, blocked, or correctly skipped.

## Watchdog pattern
A useful recurring monitor should alert only on unhealthy patterns, staying silent when healthy:

- Bridge health unreachable or `ok=false`.
- Chrome DevTools unreachable.
- No Kakao `/chats` tab.
- Kakao login/2FA tab detected.
- Recent live-like events exist but no jobs in a time window.
- Jobs exist but no worker results.
- Worker has been running longer than a sane maximum.

Do not treat heartbeats alone as proof of automation health.
