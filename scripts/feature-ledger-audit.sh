#!/usr/bin/env bash
# Multi-session feature-loss audit.
# Read-only by default. Set SKIP_GAS=1 to skip the slower GAS comparison in synccheck.

set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"

echo "=========================================="
echo " Feature ledger audit"
echo "=========================================="
echo "repo: $ROOT"
echo "branch: $(git branch --show-current)"
echo "head: $(git rev-parse --short HEAD) $(git log -1 --format=%s)"
echo ""

echo "[1] main / origin / GAS sync"
if [[ "${SKIP_GAS:-0}" == "1" ]]; then
  git fetch origin main >/dev/null
  echo "  SKIP_GAS=1, checking git only"
  echo "  local-only commits: $(git rev-list --count origin/main..HEAD 2>/dev/null || echo '?')"
  echo "  remote-only commits: $(git rev-list --count HEAD..origin/main 2>/dev/null || echo '?')"
else
  ./scripts/synccheck.sh
fi
echo ""

echo "[2] worktree inventory"
printf '%-72s %8s %8s %6s %s\n' "branch" "ahead" "behind" "dirty" "path"
while IFS= read -r d; do
  branch="$(git -C "$d" branch --show-current)"
  [[ -n "$branch" ]] || branch="(detached)"
  ahead="$(git -C "$d" rev-list --count origin/main..HEAD 2>/dev/null || echo '?')"
  behind="$(git -C "$d" rev-list --count HEAD..origin/main 2>/dev/null || echo '?')"
  dirty="$(git -C "$d" status --porcelain | wc -l | tr -d ' ')"
  printf '%-72s %8s %8s %6s %s\n' "$branch" "$ahead" "$behind" "$dirty" "$d"
done < <(git worktree list --porcelain | awk '/^worktree /{print substr($0, 10)}')
echo ""

echo "[3] remote branches not fully in main"
printf '%-64s %8s %8s %-9s %s\n' "remote_branch" "ahead" "behind" "conflict" "head"
while IFS= read -r ref; do
  ahead="$(git rev-list --count origin/main.."$ref")"
  behind="$(git rev-list --count "$ref"..origin/main)"
  [[ "$ahead" != "0" ]] || continue

  base="$(git merge-base origin/main "$ref")"
  if git merge-tree "$base" origin/main "$ref" | grep -q '<<<<<<<'; then
    conflict="yes"
  else
    conflict="no"
  fi
  head_line="$(git log -1 --oneline "$ref")"
  printf '%-64s %8s %8s %-9s %s\n' "$ref" "$ahead" "$behind" "$conflict" "$head_line"
done < <(git for-each-ref --format='%(refname:short)' refs/remotes/origin | grep -v '^origin/HEAD$' | grep -v '^origin/main$')
echo ""

echo "[4] local conflict markers"
if rg -n '<<<<<<<|>>>>>>>' . --glob '!scripts/feature-ledger-audit.sh' >/tmp/feature-ledger-conflicts.$$; then
  cat /tmp/feature-ledger-conflicts.$$
  rm -f /tmp/feature-ledger-conflicts.$$
  exit 2
fi
rm -f /tmp/feature-ledger-conflicts.$$
echo "  none"
echo ""

echo "[5] next checks"
echo "  - Update ops/multi-session-feature-ledger.md for every feature marked CANDIDATE or NEEDS_REVIEW."
echo "  - Do not deploy from any worktree with dirty > 0 or behind > 0."
echo "  - If a branch shows conflict=yes, extract behavior manually instead of merging wholesale."
