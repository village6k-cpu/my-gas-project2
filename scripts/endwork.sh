#!/usr/bin/env bash
# 두 맥 오갈 때 작업 종료 시 실행
# 원격 확인 → GAS 백업 → clasp push → clasp deploy → git commit → git push → 헤이빌리 배포
# 인자: $1 = 커밋 메시지 (생략 시 프롬프트)

set -euo pipefail
cd "$(dirname "$0")/.."

BRANCH="$(git branch --show-current)"
DEPLOY_ID="AKfycbyRff4-lLXmne-iPIEf87x4-CH_5wb-Uv5dCGymELLrpiKluhg2gDdLdVP4Y0MmxnnT"
SCRIPT_ID="$(node -e "console.log(require('./.clasp.json').scriptId)")"
BACKUP_DIR="$HOME/gas-project-backups"
VERCEL_ORG_ID="team_c5g0hY4e26h7Aha85tslGSRr"
VERCEL_TODAY_PROJECT_ID="prj_saeOBufXl2hCBDurWbd4wWCQLYqF"

echo "▶ 현재 브랜치: $BRANCH"
echo ""

if [[ "$BRANCH" != "main" ]]; then
  echo "❌ endwork.sh는 main 통합/배포 전용입니다."
  echo "→ feature 브랜치에서는 GAS 배포 없이 ./scripts/finishbranch.sh \"커밋 메시지\" 를 사용하세요."
  echo "→ 통합/배포는 main에서 ./scripts/integrate.sh \"$BRANCH\" \"통합 메시지\" 로 진행하세요."
  exit 4
fi

# 1. GitHub 원격이 앞서 있으면 중단
echo "▶ git fetch origin $BRANCH..."
git fetch origin "$BRANCH"
BEHIND="$(git rev-list --count "HEAD..origin/$BRANCH" 2>/dev/null || echo 0)"
if [[ "$BEHIND" != "0" ]]; then
  echo "❌ origin/$BRANCH 에 로컬에 없는 커밋 ${BEHIND}개가 있습니다."
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
  cp .clasp.json "$TMP_GAS/.clasp.json"
  cd "$TMP_GAS"
  clasp pull >/dev/null
)
git archive HEAD | tar -x -C "$TMP_HEAD"

REMOTE_CHANGED=0
GAS_FILE_LIST="$(find "$TMP_GAS" -maxdepth 1 -type f ! -name '.clasp.json' -exec basename {} \; | sort)"
if [[ -z "$GAS_FILE_LIST" ]]; then
  echo "❌ GAS 파일을 가져오지 못했습니다. push를 중단합니다."
  exit 2
fi

while IFS= read -r f; do
  [[ "$f" == ".clasp.json" ]] && continue
  # clasp pull and Git checkouts may use different CRLF/LF conventions on
  # Windows.  Preserve the remote-change guard, but compare the actual text
  # rather than treating a line-ending-only conversion as remote source drift.
  if [[ ! -f "$TMP_HEAD/$f" ]] || ! git diff --no-index --quiet --ignore-cr-at-eol -- "$TMP_GAS/$f" "$TMP_HEAD/$f"; then
    echo "  ⚠️  HEAD 이후 GAS에서 바뀐 파일: $f"
    REMOTE_CHANGED=1
  fi
done <<< "$GAS_FILE_LIST"

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
PUSH_OUT="$(clasp push -f 2>&1)"
echo "$PUSH_OUT"
echo ""

# 7. clasp deploy (기존 웹앱 URL 유지)
# Apps Script는 프로젝트당 버전 200개가 상한이고 삭제가 안 된다. 앱(Next.js)만 고친
# 배포까지 매번 버전을 태우면 결국 한도에 걸려 모든 배포가 막힌다(2026-08 실제 발생).
# GAS 코드가 그대로면 배포할 것도 없으므로 건너뛴다.
if grep -qi "already up to date" <<<"$PUSH_OUT"; then
  echo "▶ clasp deploy 생략 — GAS 코드 변경 없음 (버전 한도 200 보호)"
  echo ""
else
  echo "▶ clasp deploy..."
  # 배포 실패(버전 200 한도 등)가 git push·Vercel 배포까지 막으면 수정이 통째로 묶인다.
  # 코드는 이미 GAS HEAD에 push됐으므로(시간 트리거는 HEAD로 실행) 경고만 남기고 진행한다.
  if ! clasp deploy -i "$DEPLOY_ID" -d "$MSG"; then
    echo ""
    echo "⚠️ clasp deploy 실패 — 웹앱(doGet/doPost)은 이전 버전으로 남습니다."
    echo "   시간 트리거는 HEAD 코드로 실행되므로 flush/재생성 워커는 새 코드가 반영됩니다."
    echo "   버전 200 한도라면: GAS 편집기 → 프로젝트 기록에서 오래된 버전을 삭제한 뒤"
    echo "   ./scripts/endwork.sh 를 다시 실행하세요."
  fi
  echo ""
fi

# 8. git commit + push
echo "▶ git commit + push..."
git add -A
git commit -m "$MSG"
git push origin "$BRANCH"
echo ""

# 9. 실제 직원용 헤이빌리 프로젝트 배포
# 저장소 루트의 .vercel 링크는 별도 정적 프로젝트를 가리키므로 프로젝트 ID를 명시한다.
VERCEL_BIN="${VERCEL_BIN:-$(command -v vercel || true)}"
if [[ -z "$VERCEL_BIN" && -x "$HOME/.hermes/node/bin/vercel" ]]; then
  VERCEL_BIN="$HOME/.hermes/node/bin/vercel"
fi
if [[ -z "$VERCEL_BIN" ]]; then
  echo "❌ Vercel CLI를 찾지 못해 헤이빌리 운영 배포를 확인할 수 없습니다."
  echo "→ Vercel CLI 설치·로그인 후 VERCEL_BIN=/경로/vercel ./scripts/endwork.sh 를 다시 실행하세요."
  exit 5
fi

echo "▶ 헤이빌리 Vercel 운영 배포..."
VERCEL_ORG_ID="$VERCEL_ORG_ID" \
VERCEL_PROJECT_ID="$VERCEL_TODAY_PROJECT_ID" \
  "$VERCEL_BIN" --prod --yes
echo ""

echo "✅ 완료. 다른 맥에서는 ./scripts/startwork.sh 실행."
