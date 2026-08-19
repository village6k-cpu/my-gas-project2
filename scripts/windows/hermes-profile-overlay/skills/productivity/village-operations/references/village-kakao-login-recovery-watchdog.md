> **[정책 우선 고지 2026-08-12]** 이 문서의 인프라 자가 재시작/복구 지시(맥 방언 원문)는 2026-08-11 사장님 정책으로 대체됨 — **치유는 워치독 소유, 업무 턴 중 자가수리 금지** (SKILL.md 'Infrastructure incident guard'가 우선). 원문은 참고용으로 보존.

# Village Kakao login/session recovery watchdog

Use when Village Kakao DOM watcher is alive/half-alive but Kakao Business auth has expired, the wrong Kakao account is selected, or the chat-list URL returns 권한 없음.

## Durable lesson

The normal failure mode is not just “bridge down.” Kakao logout/session drift can leave the bridge green while the watcher cannot see the real chat list and the worker cannot open/verify conversations. For this user, do not stop at “please login manually” when 1Password/passkey UI is already installed and available in `🤖 자동화 크롬`; perform non-secret UI recovery actions, then stop only for secrets/biometrics/2FA approval.

## Known-good recovery path

From `/Users/village6k/my-gas-project2`:

```bash
./scripts/kakao-automation recover-login
./scripts/kakao-automation status
python3 ~/.hermes/scripts/village_kakao_dom_watchdog.py
```

Expected healthy signals:

- `recover-login` JSON has `ok: true`, `chatOk: true`, `watcherVisible: true`, `has1Password: true`, `permissionError: false`.
- `status` reports `automation profile Kakao chat: verified (CUA/profile-aware)`.
- `/health` has `ok: true`, `failedWorkerRuns: 0`, `workerRunning: false` or a bounded run, and live/auto-send enabled when expected.
- Fresh `heartbeats.ndjson` and `events.ndjson`; `jobs.ndjson` is recent when there are live actionable events; `worker-results.ndjson` or `worker-skipped.ndjson` explains each job.
- The watchdog exits 0 while healthy.

## What `recover-login` should do

- Find the Chrome window whose AX title/profile marker is `수이 (🤖 자동화 크롬)` / `Profile 3`; ignore `BILL. (💁🏻 직원용 크롬)` even if it has Kakao tabs.
- If the expected profile window is missing, open the Kakao chat-list URL in the normal Chrome profile store, not a hidden `--user-data-dir` profile.
- If the page shows `권한이 없습니다` / `페이지를 찾을 수 없습니다`, navigate through Kakao logout/account-switch and choose the full login path so the authorized BILL/village item can be used.
- Click safe available controls: passkey choices, 1Password extension, saved Kakao/BILL/village item, and Login after fields are filled.
- Do **not** read/print/type passwords, OTPs, API keys, or other secrets. If 1Password is locked, Touch ID/passkey/2FA is pending, or a password must be entered, report that exact blocker and resume after user approval.

## Watchdog integration

`~/.hermes/scripts/village_kakao_dom_watchdog.py` should use the profile-aware login status, not DevTools-only checks, because the normal Chrome profile can have remote debugging unavailable by design. Categories `kakao-login-needed`, `kakao-chat-tab-missing`, and `watcher-heartbeat-missing` should trigger:

```bash
cd /Users/village6k/my-gas-project2 && ./scripts/kakao-automation recover-login || ./scripts/kakao-automation restart
```

After recovery, re-run the health/watchdog checks before reporting success.

## Reporting style for this outage class

The user is usually in an urgent operational incident. Report tersely:

```text
원인: ...
조치: ...
현재: bridge OK / 🤖 Chrome chat OK / heartbeat OK / worker queue ...
미검증: ...
```

Do not narrate long process logs or treat a green bridge as sufficient proof. Explicitly say whether customer-facing action/result flow was verified.
