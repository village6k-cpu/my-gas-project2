#!/usr/bin/env bash
# GitHub Actions용 GAS 배포 — endwork.sh의 안전장치를 CI로 포팅.
# 순서: GAS 원격 드리프트 확인(레포에 없는 GAS 변경 발견 시 중단) → 백업 → clasp push -f → clasp deploy
# 필요 환경: CLASPRC_JSON 시크릿이 ~/.clasprc.json 으로 기록돼 있어야 함 (workflow에서 처리)
# 인자: $1 = 배포 설명 (생략 시 커밋 SHA)

set -euo pipefail
cd "$(dirname "$0")/.."

DEPLOY_ID="AKfycbyRff4-lLXmne-iPIEf87x4-CH_5wb-Uv5dCGymELLrpiKluhg2gDdLdVP4Y0MmxnnT"
DESC="${1:-deploy $(git rev-parse --short HEAD)}"
SKIP_GUARD="${SKIP_DRIFT_GUARD:-0}"

# 1. GAS 원격 드리프트 확인 — GAS 편집기/다른 맥에서만 작업된 변경이 있으면 덮어쓰지 않고 중단
TMP_GAS="$(mktemp -d /tmp/gas-ci-remote.XXXXXX)"
trap 'rm -rf "$TMP_GAS"' EXIT

echo "▶ GAS 원격 읽기 (드리프트 확인)..."
cp .clasp.json "$TMP_GAS/.clasp.json"
(cd "$TMP_GAS" && clasp pull >/dev/null)

GAS_FILE_LIST="$(find "$TMP_GAS" -maxdepth 1 -type f ! -name '.clasp.json' -exec basename {} \; | sort)"
if [[ -z "$GAS_FILE_LIST" ]]; then
  echo "❌ GAS 파일을 가져오지 못했습니다 (clasp 인증/네트워크 확인). 배포 중단."
  exit 2
fi

REMOTE_CHANGED=0
while IFS= read -r f; do
  [[ "$f" == ".clasp.json" ]] && continue
  if [[ ! -f "$f" ]] || ! diff -q "$TMP_GAS/$f" "$f" >/dev/null 2>&1; then
    echo "  ⚠️  레포와 다른 GAS 파일: $f"
    REMOTE_CHANGED=1
  fi
done <<< "$GAS_FILE_LIST"

if [[ "$REMOTE_CHANGED" -ne 0 && "$SKIP_GUARD" != "1" ]]; then
  echo ""
  echo "❌ GAS에 레포(main)에 없는 변경이 있습니다. 그대로 배포하면 덮어씁니다."
  echo "→ 맥에서 ./scripts/startwork.sh 로 GAS 변경분을 main에 먼저 반영하거나,"
  echo "→ 의도된 덮어쓰기라면 workflow_dispatch에서 skip_drift_guard=true 로 재실행하세요."
  exit 2
fi
[[ "$REMOTE_CHANGED" -ne 0 ]] && echo "⚠️  드리프트 가드 건너뜀 (skip_drift_guard=true) — GAS 변경을 덮어씁니다."

# 2. 백업 — 배포 직전 GAS 원본을 아티팩트로 남길 수 있게 고정 경로에 보관
TS="$(date +%Y%m%d-%H%M%S)"
mkdir -p gas-backup
tar -czf "gas-backup/gas-remote-before-push-$TS.tar.gz" -C "$TMP_GAS" .
echo "▶ GAS 백업: gas-backup/gas-remote-before-push-$TS.tar.gz"

# 3. push + deploy (기존 웹앱 URL 유지)
echo "▶ clasp push..."
clasp push -f
echo "▶ clasp deploy..."
clasp deploy -i "$DEPLOY_ID" -d "$DESC"
echo "✅ GAS 배포 완료: $DESC"
