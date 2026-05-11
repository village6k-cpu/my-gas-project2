#!/usr/bin/env bash
# 두 맥 오갈 때 작업 종료 시 실행
# 원격 확인 → GAS 백업 → clasp push → clasp deploy → git commit → git push
# 인자: $1 = 커밋 메시지 (생략 시 프롬프트)

set -euo pipefail
cd "$(dirname "$0")/.."

BRANCH="$(git branch --show-current)"
DEPLOY_ID="AKfycbyRff4-lLXmne-iPIEf87x4-CH_5wb-Uv5dCGymELLrpiKluhg2gDdLdVP4Y0MmxnnT"
SCRIPT_ID="$(node -e "console.log(require('./.clasp.json').scriptId)")"
BACKUP_DIR="$HOME/gas-project-backups"

echo "▶ 현재 브랜치: $BRANCH"
echo ""

# 1. GitHub 원격이 앞서 있으면 중단
echo "▶ git fetch origin $BRANCH..."
git fetch origin "$BRANCH"
BEHIND="$(git rev-list --count "HEAD..origin/$BRANCH" 2>/dev/null || echo 0)"
if [[ "$BEHIND" != "0" ]]; then
  echo "❌ origin/$BRANCH 에 로컬에 없는 커밋 $BEHIND개가 있습니다."
  echo "→ 다른 맥 작업분을 먼저 ./scripts/startwork.sh 로 가져온 뒤 다시 종료 작업을 하세요."
  exit 1
fi
echo ""

# 2. 변경사항 있는지 확인
if [[ -z "$(git status --porcelain)" ]]; then
  echo "ℹ️  로컬 변경사항 없음. GAS를 덮어쓰지 않고 종료합니다."
  exit 0
fi

# 3. HEAD 기준 GAS가 바뀌었는지 확인. 바뀌었으면 push 중단.
TMP_GAS="$(mktemp -d /tmp/gas-endwork-remote.XXXXXX)"
TMP_HEAD="$(mktemp -d /tmp/gas-endwork-head.XXXXXX)"
cleanup() { rm -rf "$TMP_GAS" "$TMP_HEAD"; }
trap cleanup EXIT

echo "▶ GAS 원격 변경 확인..."
(
  cd "$TMP_GAS"
  clasp clone "$SCRIPT_ID" --rootDir "$TMP_GAS" >/dev/null
)
git archive HEAD | tar -x -C "$TMP_HEAD"

REMOTE_CHANGED=0
while IFS= read -r f; do
  [[ "$f" == ".clasp.json" ]] && continue
  if [[ ! -f "$TMP_HEAD/$f" ]] || ! diff -q "$TMP_GAS/$f" "$TMP_HEAD/$f" >/dev/null; then
    echo "  ⚠️  HEAD 이후 GAS에서 바뀐 파일: $f"
    REMOTE_CHANGED=1
  fi
done < <(find "$TMP_GAS" -maxdepth 1 -type f -exec basename {} \; | sort)

if [[ "$REMOTE_CHANGED" -ne 0 ]]; then
  echo ""
  echo "❌ GAS에 아직 GitHub에 반영되지 않은 변경이 있습니다. push하면 덮어씁니다."
  echo "→ 먼저 ./scripts/startwork.sh 로 GAS 최종본을 받아서 병합/정리하세요."
  exit 2
fi
echo ""

# 4. 커밋 메시지 확인
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

# 5. push 전 GAS 백업
TS="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$BACKUP_DIR"
tar -czf "$BACKUP_DIR/gas-remote-before-push-$TS.tar.gz" -C "$TMP_GAS" .
echo ""
echo "▶ GAS 백업 완료: $BACKUP_DIR/gas-remote-before-push-$TS.tar.gz"

# 6. clasp push (GAS에 코드 반영)
echo ""
echo "▶ clasp push..."
clasp push -f
echo ""

# 7. clasp deploy (기존 웹앱 URL 유지)
echo "▶ clasp deploy..."
clasp deploy -i "$DEPLOY_ID" -d "$MSG"
echo ""

# 8. git commit + push
echo "▶ git commit + push..."
git add -A
git commit -m "$MSG"
git push origin "$BRANCH"
echo ""

echo "✅ 완료. 다른 맥에서는 ./scripts/startwork.sh 실행."
