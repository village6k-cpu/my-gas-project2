#!/usr/bin/env bash
set -euo pipefail

PROFILE_DIR="${VILLAGE_KAKAO_CHROME_DIR:-$HOME/.village-kakao-chrome}"
URL="${1:-https://business.kakao.com/_xhPMls/chats?t_src=business_partnercenter&t_ch=lnb&t_obj=%EB%82%B4%EC%B1%84%ED%8C%85_%ED%81%B4%EB%A6%AD}"
REMOTE_DEBUGGING_PORT="${KAKAO_REMOTE_DEBUGGING_PORT:-9223}"

mkdir -p "$PROFILE_DIR"

cat <<EOF
[village-kakao-chrome]
Launching isolated Chrome profile:
  $PROFILE_DIR
Chrome DevTools:
  http://127.0.0.1:$REMOTE_DEBUGGING_PORT

After Chrome opens:
1. Log in to Kakao Channel Manager.
2. Go to chrome://extensions
3. Enable Developer mode.
4. Load unpacked:
   $(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/kakao-dom-watcher-extension
5. Keep the Kakao 상담/채팅 관리자 page open.
EOF

open -na "Google Chrome" --args \
  --user-data-dir="$PROFILE_DIR" \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="$REMOTE_DEBUGGING_PORT" \
  --no-first-run \
  "$URL"
