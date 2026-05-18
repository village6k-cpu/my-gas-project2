#!/usr/bin/env bash
# feature 브랜치 작업 종료: GAS 배포 없이 git commit + push만 수행.
# 사용법: ./scripts/finishbranch.sh "커밋 메시지"

set -euo pipefail
cd "$(dirname "$0")/.."

BRANCH="$(git branch --show-current)"
MSG="${1:-}"

echo "▶ 현재 브랜치: $BRANCH"
echo ""

if [[ "$BRANCH" == "main" ]]; then
  echo "❌ finishbranch.sh는 feature 브랜치 전용입니다."
  echo "→ main 통합/배포는 ./scripts/endwork.sh \"커밋 메시지\" 를 사용하세요."
  exit 1
fi

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

if git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
  echo "▶ git fetch origin $BRANCH..."
  git fetch origin "$BRANCH"
  BEHIND="$(git rev-list --count "HEAD..origin/$BRANCH" 2>/dev/null || echo 0)"
  if [[ "$BEHIND" != "0" ]]; then
    echo "❌ origin/$BRANCH 에 로컬에 없는 커밋 $BEHIND개가 있습니다."
    echo "→ 먼저 병합/리베이스로 맞춘 뒤 다시 실행하세요."
    exit 2
  fi
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "▶ git commit..."
  git add -A
  git commit -m "$MSG"
else
  echo "ℹ️  로컬 변경사항 없음. commit은 건너뜁니다."
fi

echo ""
echo "▶ git push..."
git push -u origin "$BRANCH"
echo ""
echo "✅ feature 브랜치 push 완료. GAS 배포는 하지 않았습니다."
echo "→ main에서 통합할 때: ./scripts/integrate.sh \"$BRANCH\" \"통합 메시지\""
