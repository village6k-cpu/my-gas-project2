> **[정책 우선 고지 2026-08-12]** 이 문서의 인프라 자가 재시작/복구 지시(맥 방언 원문)는 2026-08-11 사장님 정책으로 대체됨 — **치유는 워치독 소유, 업무 턴 중 자가수리 금지** (SKILL.md 'Infrastructure incident guard'가 우선). 원문은 참고용으로 보존.

# Village Kakao watchdog restart loop / self-inflicted worker starvation

## Symptom

- User reports Kakao automation “seems to be running” but auto replies / worker results are not appearing.
- Bridge health can be green and `events.ndjson` / `jobs.ndjson` continue updating.
- `worker-results.ndjson` and `auto-replies.ndjson` stay stale.
- Bridge log contains many repeated `listening on http://127.0.0.1:8787` lines across a short window.
- Worker processes are killed or disappear before finishing; queue keeps rebuilding.

## Root cause pattern

The watchdog can become the outage source:

1. A fresh job is created and the AI worker starts normally.
2. The watchdog checks too soon and sees “jobs exist but no worker results.”
3. It runs `./scripts/kakao-automation restart` while the worker is still inside its normal processing budget.
4. The restart kills the active worker, so no `worker-results.ndjson` / `auto-replies.ndjson` row is written.
5. The watchdog sees the same stale symptom again on the next tick and repeats the restart loop.

This looks like the automation is alive-but-useless. It is not just a worker timeout; it is a supervisor/watchdog feedback loop.

## Investigation checklist

From `/Users/village6k/my-gas-project2`:

```bash
./scripts/kakao-automation status
launchctl print gui/$(id -u)/com.village.kakao.dom-bridge
python3 - <<'PY'
from pathlib import Path
log=Path('/Users/village6k/.village-kakao-automation/bridge.log').read_text(errors='ignore').splitlines()
print('listening_count_recent', sum('listening on http://127.0.0.1:8787' in x for x in log[-5000:]))
for marker in ['worker start', 'worker done', 'worker failed', 'timed out']:
    print(marker, sum(marker in x for x in log[-5000:]))
PY
```

Also compare queue timestamps:

- `jobs.ndjson` recent but `worker-results.ndjson` stale = action pipeline broken.
- Repeated `listening` lines = bridge is being restarted, often by watchdog recovery.
- `workerRunning=true` with `workerRunMs` under normal budget is not a failure; do not restart yet.

## Durable fix pattern

Patch the watchdog so it does not restart during normal in-flight work:

- Track `workerRunning` and `workerRunMs` from `/health`.
- Add a grace window for `jobs-no-results`, e.g. `VILLAGE_KAKAO_JOBS_NO_RESULTS_GRACE_MINUTES=8`.
- Add a grace window for `events-no-jobs`, e.g. `VILLAGE_KAKAO_EVENTS_NO_JOBS_GRACE_MINUTES=4`, so debounce has time to flush.
- Only declare `jobs-no-results` if the oldest job after bridge start is older than the grace window and there is no worker result after that job.
- If `workerRunning` and `workerRunMs < 10 minutes`, skip auto-recovery; the worker is still inside its normal processing budget.
- In normal Chrome profile + CUA fallback mode, do not treat DevTools port unreachability alone as unhealthy.

Regression checks should assert these behaviours in a watchdog static test.

## Verification

- `python3 -m py_compile ~/.hermes/scripts/village_kakao_dom_watchdog.py`
- Run watchdog with autorecovery skipped and confirm it exits 0 when a worker is legitimately in progress:

```bash
VILLAGE_KAKAO_WATCHDOG_SKIP_AUTORECOVER=1 python3 ~/.hermes/scripts/village_kakao_dom_watchdog.py; echo $?
```

- Confirm bridge LaunchAgent has `KeepAlive` but is not repeatedly restarting:

```bash
launchctl print gui/$(id -u)/com.village.kakao.dom-bridge | sed -n '1,80p'
```

- Wait past one full worker budget only when needed, then verify fresh `worker-results.ndjson` or `auto-replies.ndjson`. Do not claim full customer-facing recovery from bridge health alone.
