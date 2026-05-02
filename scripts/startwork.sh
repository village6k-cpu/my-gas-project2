#!/usr/bin/env bash
# 두 맥 오갈 때 작업 시작 시 실행
# git pull → clasp pull → 동기화 상태 점검

set -euo pipefail
cd "$(dirname "$0")/.."

BRANCH="$(git branch --show-current)"
echo "▶ 현재 브랜치: $BRANCH"
echo ""

# 1. 로컬 미커밋 변경사항 체크 (덮어쓰기 방지)
if [[ -n "$(git status --porcelain)" ]]; then
  echo "❌ 로컬에 커밋되지 않은 변경사항이 있습니다:"
  git status -s
  echo ""
  echo "→ 먼저 정리하세요 (commit 또는 stash)."
  exit 1
fi

# 2. git fetch + pull
echo "▶ git fetch + pull origin $BRANCH..."
git fetch origin "$BRANCH"
git pull --no-rebase origin "$BRANCH"
echo ""

# 3. clasp pull
echo "▶ clasp pull (GAS 편집기 직접 수정분 회수)..."
clasp pull
echo ""

# 4. clasp pull 후 차이 확인
if [[ -n "$(git status --porcelain)" ]]; then
  echo "⚠️  GAS에 git 미반영 변경사항이 있습니다:"
  git status -s
  echo ""
  echo "→ 다른 맥에서 git push를 빼먹었거나 GAS 편집기에서 직접 수정한 내용입니다."
  echo "→ git diff로 확인 후 git add/commit/push 하세요."
  echo ""
  echo "  git diff --stat"
  echo "  git add -A && git commit -m '동기화'"
  echo "  git push origin $BRANCH"
  exit 2
fi

echo "✅ 동기화 완료. 작업 시작 OK."
