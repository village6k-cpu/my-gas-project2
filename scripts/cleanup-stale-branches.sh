#!/usr/bin/env bash
# 스테일 원격 브랜치 일괄 정리 (2026-07-22 전수 검사 기반 — ops/branch-cleanup-20260722.md 참고)
#
# 검사 결과: 아래 KEEP 목록 외 모든 브랜치의 내용이 main에 반영 완료 확인됨 (유실 0건).
# 안전장치:
#   1) 삭제 전 아카이브 태그 3개를 푸시해 삭제 대상 전체 히스토리를 도달 가능하게 보존
#   2) ops/branch-cleanup-20260722.md 에 브랜치→SHA 복구 맵 보관
#   복원: git push origin <SHA>:refs/heads/<브랜치명>
#
# 사용: ./scripts/cleanup-stale-branches.sh        # 미리보기(dry-run)
#       ./scripts/cleanup-stale-branches.sh --run  # 실제 삭제
set -euo pipefail
cd "$(dirname "$0")/.."

KEEP_REGEX='^origin/(HEAD|main|claude/gas-performance-optimization-r1xn3i|codex/ax2-premium-ocr|safety/.*|codex/backup-.*)$'

# 아카이브 태그: 삭제 대상 전체 커밋의 도달 가능성 보존 (전수 검사에서 확인된 3개 maximal tip)
declare -A ARCHIVE_TAGS=(
  [archive/old-trunk-20260709]=origin/claude/claudefm-music-video-style-qq45vm
  [archive/schedule-app-overhaul-20260603]=origin/claude/schedule-app-overhaul-LD12K
  [archive/village-fm-20260713]=origin/claude/village-youtube-inspired-content-4o3zj4
)

git fetch origin --prune

TARGETS=()
while IFS= read -r b; do
  [[ "$b" =~ $KEEP_REGEX ]] && continue
  TARGETS+=("${b#origin/}")
done < <(git branch -r --format='%(refname:short)')

echo "삭제 대상: ${#TARGETS[@]}개 브랜치"
printf '  %s\n' "${TARGETS[@]}"

if [[ "${1:-}" != "--run" ]]; then
  echo ""
  echo "(dry-run) 실제 삭제하려면: $0 --run"
  exit 0
fi

echo ""
echo "1/2 아카이브 태그 푸시..."
for tag in "${!ARCHIVE_TAGS[@]}"; do
  src="${ARCHIVE_TAGS[$tag]}"
  if git rev-parse -q --verify "refs/remotes/$src" >/dev/null; then
    git tag -f "$tag" "$src"
    git push origin "$tag"
  else
    echo "  (스킵: $src 없음 — 이미 삭제됨, 태그는 기존 것 유지)"
  fi
done

echo ""
echo "2/2 브랜치 삭제 (50개씩)..."
for ((i = 0; i < ${#TARGETS[@]}; i += 50)); do
  git push origin --delete "${TARGETS[@]:i:50}"
done

echo ""
echo "완료. 복원이 필요하면 ops/branch-cleanup-20260722.md 의 SHA로:"
echo "  git push origin <SHA>:refs/heads/<브랜치명>"
