#!/usr/bin/env bash
set -euo pipefail

PROFILE_DIR="${VILLAGE_KAKAO_CHROME_DIR:-$HOME/.village-kakao-chrome}"
URL="${1:-https://center-pf.kakao.com/}"

mkdir -p "$PROFILE_DIR"

cat <<EOF
[village-kakao-chrome]
Launching isolated Chrome profile:
  $PROFILE_DIR

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
  "$URL"
