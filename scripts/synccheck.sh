#!/usr/bin/env bash
# 동기화 상태 진단 — git 로컬 / 원격 / GAS 비교
# 변경 없이 읽기만 함. GAS는 임시 폴더로 clone해서 비교한다.

set -uo pipefail
cd "$(dirname "$0")/.."

BRANCH="$(git branch --show-current)"
SCRIPT_ID="$(node -e "console.log(require('./.clasp.json').scriptId)")"
TMPDIR="$(mktemp -d /tmp/gas-synccheck.XXXXXX)"
cleanup() { rm -rf "$TMPDIR"; }
trap cleanup EXIT

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

# 3. GAS와의 차이 (읽기 전용)
echo "[3] GAS 동기화 (읽기 전용)"
(
  cd "$TMPDIR" || exit 1
  clasp clone "$SCRIPT_ID" --rootDir "$TMPDIR" >/dev/null 2>&1
)
GAS_FILE_LIST="$(find "$TMPDIR" -maxdepth 1 -type f ! -name '.clasp.json' -exec basename {} \; | sort)"

if [[ -z "$GAS_FILE_LIST" ]]; then
  echo "  ❌ GAS 파일을 가져오지 못했습니다."
else
  DIFF_COUNT=0
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    if [[ ! -f "$f" ]]; then
      echo "  ❌ 로컬에 없음: $f"
      DIFF_COUNT=$((DIFF_COUNT + 1))
    elif ! diff -q "$TMPDIR/$f" "$f" >/dev/null; then
      echo "  ⚠️  내용 다름: $f"
      DIFF_COUNT=$((DIFF_COUNT + 1))
    fi
  done <<< "$GAS_FILE_LIST"
  if [[ "$DIFF_COUNT" -eq 0 ]]; then
    echo "  ✅ GAS 파일과 로컬 파일 내용 일치"
  else
    echo "  → GAS가 최종본이면 ./scripts/startwork.sh 로 로컬을 맞추세요."
  fi
fi
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
