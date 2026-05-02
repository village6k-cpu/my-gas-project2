#!/usr/bin/env bash
# 두 맥 오갈 때 작업 종료 시 실행
# clasp push → clasp deploy → git commit → git push
# 인자: $1 = 커밋 메시지 (생략 시 프롬프트)

set -euo pipefail
cd "$(dirname "$0")/.."

BRANCH="$(git branch --show-current)"
DEPLOY_ID="AKfycbyRff4-lLXmne-iPIEf87x4-CH_5wb-Uv5dCGymELLrpiKluhg2gDdLdVP4Y0MmxnnT"

echo "▶ 현재 브랜치: $BRANCH"
echo ""

# 1. 변경사항 있는지 확인
if [[ -z "$(git status --porcelain)" ]]; then
  echo "ℹ️  로컬 변경사항 없음. clasp만 동기화하고 종료."
  echo ""
  echo "▶ clasp push..."
  clasp push -f
  echo "✅ 완료."
  exit 0
fi

# 2. 커밋 메시지 확인
MSG="${1:-}"
if [[ -z "$MSG" ]]; then
  echo "▶ 변경된 파일:"
  git status -s
  echo ""
  read -r -p "커밋 메시지: " MSG
  if [[ -z "$MSG" ]]; then
    echo "❌ 메시지 비어있음. 중단."
    exit 1
  fi
fi

# 3. clasp push (GAS에 코드 반영)
echo ""
echo "▶ clasp push..."
clasp push -f
echo ""

# 4. clasp deploy (기존 웹앱 URL 유지)
echo "▶ clasp deploy..."
clasp deploy -i "$DEPLOY_ID" -d "$MSG"
echo ""

# 5. git commit + push
echo "▶ git commit + push..."
git add -A
git commit -m "$MSG"
git push origin "$BRANCH"
echo ""

echo "✅ 완료. 다른 맥에서는 ./scripts/startwork.sh 실행."
