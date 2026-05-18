#!/usr/bin/env bash
# 멀티 세션 충돌 방지용 feature worktree 생성.
# 사용법: ./scripts/newtask.sh dashboard-attention

set -euo pipefail
cd "$(dirname "$0")/.."

SLUG="${1:-}"
if [[ -z "$SLUG" ]]; then
  echo "사용법: ./scripts/newtask.sh <작업-slug>"
  exit 1
fi

SAFE_SLUG="$(printf '%s' "$SLUG" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9._-]+/-/g; s/^-+//; s/-+$//')"
if [[ -z "$SAFE_SLUG" ]]; then
  echo "❌ 사용할 수 없는 작업 이름입니다: $SLUG"
  exit 1
fi

BRANCH="codex/$SAFE_SLUG"
WORKTREE_BASE="${WORKTREE_BASE:-$(cd .. && pwd)/my-gas-project2-worktrees}"
TARGET="$WORKTREE_BASE/$SAFE_SLUG"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "❌ 현재 작업트리에 미커밋 변경사항이 있습니다. 먼저 정리하세요."
  git status -s
  exit 1
fi

if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  echo "❌ 이미 로컬 브랜치가 있습니다: $BRANCH"
  exit 1
fi

if git ls-remote --exit-code --heads origin "$BRANCH" >/dev/null 2>&1; then
  echo "❌ 이미 원격 브랜치가 있습니다: origin/$BRANCH"
  exit 1
fi

if [[ -e "$TARGET" ]]; then
  echo "❌ 이미 경로가 있습니다: $TARGET"
  exit 1
fi

mkdir -p "$WORKTREE_BASE"
git fetch origin main
git worktree add -b "$BRANCH" "$TARGET" origin/main

echo ""
echo "✅ feature worktree 생성 완료"
echo "  branch: $BRANCH"
echo "  path:   $TARGET"
echo ""
echo "다음 작업:"
echo "  cd \"$TARGET\""
echo "  ./scripts/startwork.sh"
echo "  # 작업 후"
echo "  ./scripts/finishbranch.sh \"커밋 메시지\""
