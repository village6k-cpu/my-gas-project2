#!/usr/bin/env bash
set -euo pipefail

PROFILE_DIR="${VILLAGE_KAKAO_CHROME_DIR:-$HOME/Library/Application Support/Google/Chrome}"
URL="${1:-https://business.kakao.com/_xhPMls/chats?t_src=business_partnercenter&t_ch=lnb&t_obj=%EB%82%B4%EC%B1%84%ED%8C%85_%ED%81%B4%EB%A6%AD}"
REMOTE_DEBUGGING_PORT="${KAKAO_REMOTE_DEBUGGING_PORT:-9223}"
CHROME_PROFILE_DIRECTORY="${VILLAGE_KAKAO_CHROME_PROFILE_DIRECTORY:-Default}"
EXTENSION_DIR="${VILLAGE_KAKAO_WATCHER_EXTENSION_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/kakao-dom-watcher-extension}"

mkdir -p "$PROFILE_DIR"

cat <<EOF
[village-kakao-chrome]
Launching Chrome user data dir:
  $PROFILE_DIR
Chrome profile directory:
  $CHROME_PROFILE_DIRECTORY
Chrome DevTools:
  http://127.0.0.1:$REMOTE_DEBUGGING_PORT

After Chrome opens:
1. Log in to Kakao Channel Manager.
2. The watcher extension is force-loaded from:
   $EXTENSION_DIR
3. Keep the Kakao 상담/채팅 관리자 page open.
EOF

DEFAULT_CHROME_USER_DATA_DIR="$HOME/Library/Application Support/Google/Chrome"
if [[ "$PROFILE_DIR" == "$DEFAULT_CHROME_USER_DATA_DIR" ]]; then
  echo "[village-kakao-chrome] Refusing the default Chrome user-data dir: current Chrome disables remote debugging there. Set VILLAGE_KAKAO_CHROME_DIR to the dedicated Village automation profile." >&2
  exit 2
fi

OPEN_ARGS=()
if [[ "$PROFILE_DIR" != "$DEFAULT_CHROME_USER_DATA_DIR" ]]; then
  OPEN_ARGS+=(--user-data-dir="$PROFILE_DIR")
fi
OPEN_ARGS+=(
  --profile-directory="$CHROME_PROFILE_DIRECTORY"
  --remote-debugging-address=127.0.0.1
  --remote-debugging-port="$REMOTE_DEBUGGING_PORT"
  --no-first-run
  --load-extension="$EXTENSION_DIR"
  "$URL"
)

chrome_root_count() {
  # Do not count crashpad helpers: the browser main process can disappear while
  # a helper is still alive, which previously made a failed launch look healthy.
  /bin/ps -axo command= 2>/dev/null | /usr/bin/grep -F 'Google Chrome' | \
    /usr/bin/grep -v -E 'chrome_crashpad_handler| --type=' | /usr/bin/wc -l | /usr/bin/tr -d ' '
}

wait_for_chrome_process() {
  local attempt count
  for attempt in {1..10}; do
    count="$(chrome_root_count || true)"
    if [[ "${count:-0}" -gt 0 ]]; then
      return 0
    fi
    /bin/sleep 1
  done
  return 1
}

wait_for_devtools() {
  local attempt
  for attempt in {1..15}; do
    if /usr/bin/curl --silent --show-error --fail --max-time 2 "http://127.0.0.1:${REMOTE_DEBUGGING_PORT}/json/version" >/dev/null 2>&1; then
      return 0
    fi
    /bin/sleep 1
  done
  return 1
}

if open -na "Google Chrome" --args "${OPEN_ARGS[@]}"; then
  if wait_for_chrome_process && wait_for_devtools; then
    exit 0
  fi
  echo "[village-kakao-chrome] LaunchServices returned success but Chrome did not expose DevTools on 127.0.0.1:$REMOTE_DEBUGGING_PORT" >&2
fi

CHROME_APP="/Applications/Google Chrome.app"
CHROME_EXEC="$CHROME_APP/Contents/MacOS/Google Chrome"
if [[ -x "$CHROME_EXEC" ]]; then
  echo "[village-kakao-chrome] LaunchServices could not open Google Chrome; launching executable directly: $CHROME_EXEC" >&2
  "$CHROME_EXEC" "${OPEN_ARGS[@]}" >/tmp/village-kakao-chrome.log 2>&1 &
  if wait_for_chrome_process && wait_for_devtools; then
    exit 0
  fi
  echo "[village-kakao-chrome] Chrome did not expose DevTools during startup; see /tmp/village-kakao-chrome.log" >&2
fi

exit 1
