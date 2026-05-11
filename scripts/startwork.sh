#!/usr/bin/env bash
# 두 맥 오갈 때 작업 시작 시 실행
# git pull → GAS 읽기 전용 비교 → 필요 시 백업 후 clasp pull

set -euo pipefail
cd "$(dirname "$0")/.."

BRANCH="$(git branch --show-current)"
SCRIPT_ID="$(node -e "console.log(require('./.clasp.json').scriptId)")"
BACKUP_DIR="$HOME/gas-project-backups"
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

# 3. GAS 읽기 전용 비교
TMPDIR="$(mktemp -d /tmp/gas-startwork.XXXXXX)"
cleanup() { rm -rf "$TMPDIR"; }
trap cleanup EXIT

echo "▶ GAS 원격 확인 (읽기 전용 clone)..."
(
  cd "$TMPDIR"
  clasp clone "$SCRIPT_ID" --rootDir "$TMPDIR" >/dev/null
)

DIFF_COUNT=0
while IFS= read -r f; do
  [[ "$f" == ".clasp.json" ]] && continue
  if [[ ! -f "$f" ]] || ! diff -q "$TMPDIR/$f" "$f" >/dev/null; then
    echo "  ⚠️  GAS와 다름: $f"
    DIFF_COUNT=$((DIFF_COUNT + 1))
  fi
done < <(find "$TMPDIR" -maxdepth 1 -type f -exec basename {} \; | sort)
echo ""

# 4. GAS가 최종본이므로 차이가 있으면 백업 후 pull
if [[ "$DIFF_COUNT" -gt 0 ]]; then
  TS="$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$BACKUP_DIR"
  tar --exclude='./.git' --exclude='./node_modules' -czf "$BACKUP_DIR/my-gas-project2-before-startwork-$TS.tar.gz" .
  git branch "backup/startwork-$TS"
  git tag "backup/startwork-$TS"

  echo "▶ 백업 완료:"
  echo "  - branch: backup/startwork-$TS"
  echo "  - tag: backup/startwork-$TS"
  echo "  - tar: $BACKUP_DIR/my-gas-project2-before-startwork-$TS.tar.gz"
  echo ""

  echo "▶ clasp pull (GAS 최종본으로 로컬 맞춤)..."
  clasp pull
  echo ""

  echo "⚠️  GAS 기준 변경분이 로컬에 반영되었습니다:"
  git status -s
  echo ""
  echo "→ 확인 후 GitHub에도 맞추세요:"
  echo "  git add -A && git commit -m 'sync: GAS final to local'"
  echo "  git push origin $BRANCH"
  exit 2
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "⚠️  git pull 후 로컬 변경사항이 생겼습니다:"
  git status -s
  echo ""
  echo "→ 정리 후 작업을 시작하세요."
  exit 3
fi

echo "✅ 동기화 완료. 작업 시작 OK."
