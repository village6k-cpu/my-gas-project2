#!/usr/bin/env bash
# 동기화 상태 진단 — git 로컬 / 원격 / GAS 비교
# 변경 없이 읽기만 함

set -uo pipefail
cd "$(dirname "$0")/.."

BRANCH="$(git branch --show-current)"

echo "=========================================="
echo " 동기화 상태 진단"
echo "=========================================="
echo "▶ 현재 브랜치: $BRANCH"
echo ""

# 1. 로컬 작업 상태
echo "[1] 로컬 미커밋 변경사항"
if [[ -z "$(git status --porcelain)" ]]; then
  echo "  ✅ 깨끗함"
else
  git status -s | sed 's/^/  /'
fi
echo ""

# 2. 원격 동기화 상태
echo "[2] 원격(origin/$BRANCH) 대비"
git fetch origin "$BRANCH" --quiet
LOCAL_AHEAD=$(git rev-list --count "origin/$BRANCH..HEAD" 2>/dev/null || echo "?")
LOCAL_BEHIND=$(git rev-list --count "HEAD..origin/$BRANCH" 2>/dev/null || echo "?")
echo "  로컬에만: $LOCAL_AHEAD 커밋"
echo "  원격에만: $LOCAL_BEHIND 커밋"
if [[ "$LOCAL_BEHIND" != "0" ]]; then
  echo "  → git pull 필요"
fi
if [[ "$LOCAL_AHEAD" != "0" ]]; then
  echo "  → git push 필요"
fi
echo ""

# 3. GAS와의 차이 (clasp pull 시뮬레이션은 destructive하므로 안내만)
echo "[3] GAS 동기화"
echo "  실제 GAS와 비교하려면: clasp pull 후 git status"
echo "  (위 명령은 로컬 파일을 GAS 내용으로 덮어쓰므로 주의)"
echo ""

# 4. 최근 커밋
echo "[4] 최근 커밋 (로컬)"
git log --oneline -5 | sed 's/^/  /'
echo ""

# 5. 원격에만 있는 커밋 (있을 경우)
if [[ "$LOCAL_BEHIND" != "0" ]] && [[ "$LOCAL_BEHIND" != "?" ]]; then
  echo "[5] 원격에만 있는 커밋"
  git log "HEAD..origin/$BRANCH" --oneline | sed 's/^/  /'
  echo ""
fi

echo "=========================================="
