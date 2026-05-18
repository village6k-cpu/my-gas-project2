#!/usr/bin/env bash
# main 통합/배포: feature 브랜치를 no-commit merge한 뒤 검증하고 endwork로 배포/커밋/푸시.
# 사용법: ./scripts/integrate.sh codex/dashboard-attention "통합 메시지"

set -euo pipefail
cd "$(dirname "$0")/.."

CURRENT_BRANCH="$(git branch --show-current)"
TARGET_BRANCH="${1:-}"
MSG="${2:-}"

if [[ -z "$TARGET_BRANCH" ]]; then
  echo "사용법: ./scripts/integrate.sh <feature-branch> \"통합 메시지\""
  exit 1
fi

if [[ -z "$MSG" ]]; then
  MSG="integrate: $TARGET_BRANCH"
fi

if [[ "$CURRENT_BRANCH" != "main" ]]; then
  echo "❌ integrate.sh는 main에서만 실행하세요. 현재 브랜치: $CURRENT_BRANCH"
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "❌ main 작업트리가 깨끗하지 않습니다. 먼저 정리하세요."
  git status -s
  exit 1
fi

echo "▶ main/GAS 최신화..."
./scripts/startwork.sh

echo ""
echo "▶ feature 브랜치 가져오기: $TARGET_BRANCH"
git fetch origin main
MERGE_REF="$TARGET_BRANCH"
if git ls-remote --exit-code --heads origin "$TARGET_BRANCH" >/dev/null 2>&1; then
  git fetch origin "$TARGET_BRANCH"
  MERGE_REF="origin/$TARGET_BRANCH"
elif ! git show-ref --verify --quiet "refs/heads/$TARGET_BRANCH"; then
  echo "❌ feature 브랜치를 찾을 수 없습니다: $TARGET_BRANCH"
  exit 1
fi

echo ""
echo "▶ merge --no-commit: $MERGE_REF"
if ! git merge --no-ff --no-commit "$MERGE_REF"; then
  echo ""
  echo "❌ merge conflict 발생. 충돌 파일을 정리한 뒤 아래 순서로 마무리하세요:"
  echo "  git status -s"
  echo "  # 충돌 해결"
  echo "  ./scripts/integrate.sh $TARGET_BRANCH \"$MSG\""
  git status -s
  exit 2
fi

echo ""
echo "▶ 통합 검증..."
for f in test/*.static.test.js; do
  node "$f"
done
node --check checkAvailability.js
node --check sheetAPI.js
node --check Code.js
bash -n scripts/*.sh

echo ""
echo "▶ 배포/커밋/푸시..."
./scripts/endwork.sh "$MSG"
