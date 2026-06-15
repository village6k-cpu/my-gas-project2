#!/usr/bin/env bash
# 단말기 업로드용 ZIP 생성 → 토스 개발자센터 "개발용 파일 추가"에 업로드
# ⚠️ index.html 을 ZIP 최상위에 둔다(단말기 런타임이 루트에서 진입점을 찾음).
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f village-front/config.js ]; then
  echo "✗ village-front/config.js 가 없습니다." >&2
  echo "  → config.example.js 를 config.js 로 복사하고 LOOKUP_TOKEN 을 채우세요." >&2
  exit 1
fi

rm -f village-front.zip
# village-front/ 의 '내용물'을 ZIP 최상위에 담는다 (폴더로 감싸지 않음)
( cd village-front && zip -r ../village-front.zip index.html idle.css app.js config.js assets/village-idle-bg.png assets/village-logo.png -x '*.DS_Store' >/dev/null )
echo "✓ village-front.zip 생성 (index.html = ZIP 최상위)"
unzip -l village-front.zip
