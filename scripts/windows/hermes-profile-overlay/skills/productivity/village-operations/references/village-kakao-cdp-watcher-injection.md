> **[정책 우선 고지 2026-08-12]** 이 문서의 인프라 자가 재시작/복구 지시(맥 방언 원문)는 2026-08-11 사장님 정책으로 대체됨 — **치유는 워치독 소유, 업무 턴 중 자가수리 금지** (SKILL.md 'Infrastructure incident guard'가 우선). 원문은 참고용으로 보존.

# Village Kakao DOM watcher: CDP verification/injection fallback

Session learning: the bridge can be green while the Kakao tab is open but the DOM watcher content script is absent. This happened when Chrome opened the automation user-data-dir under the wrong Chrome sub-profile (`Profile 1` / BILL.) while the watcher was installed/configured under `Default` / 수이.

## Diagnostic pattern

Do not rely on `/health`, process liveness, or Kakao tab presence alone. Verify that the watcher is actually installed in the Kakao page context.

Useful CDP checks:

1. Inspect `chrome://version/` in the automation Chrome DevTools port and confirm:
   - `프로필 경로` ends in the expected sub-profile, usually `/Users/village6k/.village-kakao-channel-manager-profile/Default`.
   - Command line includes the expected automation flags.
2. Connect to the Kakao chat page via DevTools and evaluate:

```js
(() => ({
  hasWatcher: !!window.__villageKakaoWatcherInstance,
  started: window.__villageKakaoWatcherInstance?.state?.started ?? null,
  href: location.href,
  title: document.title,
  visibility: document.visibilityState
}))()
```

Healthy means `hasWatcher: true` and `started: true`.

If only generic extension contexts appear (1Password, Claude, etc.) and no Village watcher context/state is present, treat it as broken even if the Kakao page is visible.

## Recovery/hardening pattern

- Launch automation Chrome with both:
  - `--user-data-dir=/Users/village6k/.village-kakao-channel-manager-profile`
  - `--profile-directory=Default`
- Force-load the unpacked watcher extension:
  - `--disable-extensions-except=/Users/village6k/my-gas-project2/tools/kakao-dom-watcher-extension`
  - `--load-extension=/Users/village6k/my-gas-project2/tools/kakao-dom-watcher-extension`
- Add a CDP fallback that injects the watcher `content.js` into the Kakao chat-list page and shims `chrome.storage.sync.get`/`chrome.storage.onChanged.addListener` so the content script can run even when the unpacked extension fails to attach.
- Run the injection from `scripts/kakao-automation start` after opening/reopening Chrome, then print the verification JSON.

## Important pitfall

A DevTools tab list can change during cleanup. If closing duplicate tabs by ID, re-fetch the tab list immediately before closing and preserve the tab already verified with `hasWatcher: true`. After cleanup, run `scripts/kakao-automation status` again; if there are no Kakao tabs, reopen and re-inject before reporting recovery.

## Report honestly

Only claim full recovery after all of these are true:

- bridge health ok
- automation Chrome DevTools reachable
- Kakao chat-list tab present
- watcher state verified with `hasWatcher: true`, `started: true`
- fresh `received`/heartbeat/event counters after the fix
- if new live customer messages are present, worker results/auto-replies or safe-stop gates are observed
