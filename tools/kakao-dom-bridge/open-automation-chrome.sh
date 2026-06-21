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

open -na "Google Chrome" --args "${OPEN_ARGS[@]}"
