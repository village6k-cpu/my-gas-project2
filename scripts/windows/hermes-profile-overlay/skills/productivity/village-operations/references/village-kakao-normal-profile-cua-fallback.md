> **[정책 우선 고지 2026-08-12]** 이 문서의 인프라 자가 재시작/복구 지시(맥 방언 원문)는 2026-08-11 사장님 정책으로 대체됨 — **치유는 워치독 소유, 업무 턴 중 자가수리 금지** (SKILL.md 'Infrastructure incident guard'가 우선). 원문은 참고용으로 보존.

# Village Kakao normal-profile CUA fallback

Use this when diagnosing Kakao DOM watcher alerts that mention `chrome-devtools-down`, `wrong-chrome-profile`, `fetch failed`, or “auto-recovery attempted but still unhealthy.”

## Durable lesson

Village Kakao automation may intentionally run in the real Chrome profile store:

- `VILLAGE_KAKAO_CHROME_DIR=/Users/village6k/Library/Application Support/Google/Chrome`
- `VILLAGE_KAKAO_CHROME_PROFILE_DIRECTORY=Profile 3` (`🤖 자동화 크롬`)
- `KAKAO_APPLESCRIPT_FALLBACK=1`
- `KAKAO_WORKER_CONTROL_MODE=cua_first`
- `KAKAO_CUA_MIN_IDLE_SECONDS=0`

In this mode Chrome 149+ can show `--remote-debugging-port=9223` in process args but still not listen on `127.0.0.1:9223`. That alone is not the root failure if the worker is configured for CUA/AppleScript fallback and the watcher extension is posting fresh heartbeats/events.

## What to verify

1. Run `./scripts/kakao-automation status` from `/Users/village6k/my-gas-project2`.
2. Confirm health `ok: true`, worker live, auto-send status, and CUA driver executable.
3. Tail queue files:
   - `heartbeats.ndjson` fresh = extension alive.
   - `events.ndjson` fresh = DOM detection alive.
   - `jobs.ndjson` and `worker-results.ndjson` fresh after debounce = action pipeline alive.
   - `auto-replies.ndjson` for send attempts/results when relevant.
4. Run the watchdog script; no stdout means healthy.

## False-alert root cause to avoid

If `KAKAO_TAB_CLEANUP_ENABLED=true` while DevTools is unavailable in normal-profile/CUA mode, the bridge will log repeated:

```text
kakao_tab_cleanup fetch failed
```

The watchdog may then report auto-recovery as still unhealthy even though detection and worker results are OK. Fix by setting:

```bash
KAKAO_TAB_CLEANUP_ENABLED=false
```

Then restart:

```bash
cd /Users/village6k/my-gas-project2
./scripts/kakao-automation restart
```

Verify `status` shows `kakaoTabCleanupEnabled: false`, fresh heartbeats/events, `failedWorkerRuns: 0`, and no new `kakao_tab_cleanup fetch failed` rows after restart.

## Chrome cache fallback for Kakao photo attachments

When a Kakao customer sends photos but the DOM watcher only records `사진 N장` (no image text/URL), and live CUA/DevTools access is noisy or unavailable, recover recently viewed attachment thumbnails from the automation Chrome cache:

1. Use the Kakao event timestamp from `events.ndjson`/Supabase (KST) and convert to UTC.
2. Scan `/Users/village6k/Library/Caches/Google/Chrome/Profile 3/Cache/Cache_Data` for image-like files (`PNG`/`JPEG`/`WEBP`) with mtimes in a narrow window around the event.
3. Copy candidates to `/tmp/<case>/...` with image extensions and inspect with `vision_analyze`; enlarge/crop with PIL if OCR is ambiguous.
4. Treat cache images as evidence only after matching the Kakao event timing/customer thread; do not use unrelated Chrome profile caches.

This is useful for bank-transfer screenshots/business-registration images where the visible Kakao text is only `사진 3장`.

## Pitfall

Do not “fix” this by recreating `$HOME/.village-kakao-chrome` or another hidden profile. That can lose the installed extension/login session and violates the Village separation between `🤖 자동화 크롬` and `💁🏻 직원용 크롬`.
