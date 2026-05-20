# Multi-Session Feature Ledger

Last audited: 2026-05-20 KST
Truth snapshot: `main` / `origin/main` / GAS are aligned at `3964ede` (`정리 완료 상태 장부 반영`).

## Purpose

This ledger exists to prevent silent feature loss when several Codex/Claude sessions work on the same GAS repo at the same time.

The pass condition is not "no git conflict." The pass condition is:

- Every intended feature is either `LIVE`, `CANDIDATE`, `NEEDS_REVIEW`, or `ARCHIVED`.
- Every `CANDIDATE` has files, entrypoints, and tests/proof listed.
- No feature branch or dirty worktree is allowed to reach `clasp push` directly.
- `main` remains the only deploy lane for GAS.

## Current Main Feature Inventory

| Status | Feature / intent | Evidence in main | Notes |
|---|---|---|---|
| LIVE | Multi-session workflow guards | `scripts/newtask.sh`, `scripts/finishbranch.sh`, `scripts/integrate.sh`, `scripts/synccheck.sh`; commit `3e17a76` | Main is the integration/deploy lane. Feature branches must not run `clasp push` or `clasp deploy`. |
| LIVE | Dashboard attention / visible schedule cleanup | `dashboard.html`, `docs/dashboard.html`, `test/dashboard-attention-filter.static.test.js`; commits `414a7c3`, `48bbf42`, `0706ba8` | Includes attention filter and quantity/readability cleanup. |
| LIVE | Contract status and cancelled-contract return guard | `Code.js`, `checkAvailability.js`, `test/contract-cancel-return-guard.static.test.js`; commits `73a2a86`, `d482900`, `f6a27e9` | Protects cancelled contracts from being revived as `반납완료`. |
| LIVE | Contract discount policy and regeneration | `generatecontract.js`, `Code.js`, `test/contract-discount-policy.static.test.js`, `test/contract-master-discount-regen.static.test.js`; commits `b62d54f`, `a3fb950` | Discount policy is multiplicative; contract regeneration reacts to contract-master discount edits. |
| LIVE | Confirmation request row inheritance | `Code.js`, `test/confirm-request-equipment-inherit.test.js`; commits `ec86ec7`, `d38d7b4` | F-column equipment-only entry inherits request/date/customer/trade context without copying N/O execution state. |
| LIVE | Confirmation request set recheck formatting and blank component cleanup | `checkAvailability.js`, `test/confirm-request-recheck.static.test.js`, `test/confirm-request-set-components.test.js`; commit `2bfb095` | Prevents blank set components from shifting rows and breaking green set-header formatting. |
| LIVE | Equipment-risk caution in schedule cards | `checkAvailability.js`, `dashboard.html`, `docs/dashboard.html`, `test/equipment-risk-dashboard.static.test.js`; commits `c01920e`, `96881fc`, `047b618`, `ab286f2`, `f8e7cd8`, `780b98a` | GAS schedule cards expand visible set headers through `세트마스터` and surface component risk warnings. |
| LIVE | Invoice recipient / billing company fields | `dashboard.html`, `docs/dashboard.html`, `test/dashboard-billing-company.static.test.js`; commits `5ff8fcd`, `d7a6559` | Includes recipient company selection/autocomplete in today's schedule flow. |
| LIVE | Deposit status management | `dashboard.html`, `docs/dashboard.html`, `test/dashboard-deposit-status.static.test.js`; commit `0b7d563` | Today's schedule can manage deposit/payment status. |
| LIVE | Onsite add-on / `+ 현장추가` capture from today's checkout cards | `checkAvailability.js`, `sheetAPI.js`, `dashboard.html`, `docs/dashboard.html`, `test/onsite-addon-dashboard.static.test.js`; commits `1b30246`, `0697ee4` | Today's checkout cards can add onsite equipment with settlement status and durable event logging; checkout cards show `+ 현장추가` instead of the generic `+ 장비추가`. |
| LIVE | Confirmation request time dropdown and reject/hold re-registration | `checkAvailability.js`; commits `009b89b`, `2dc7c67`, `9e94330` | C/E time dropdown is hourly `00:00`-`23:00`; reject/hold rows can be re-registered after clearing stale row state. |
| LIVE | Contract cancellation sync by explicit status change | `Code.js`, `checkAvailability.js`; `cancelContract()` | `취소` status removes related schedule rows and external 거래내역 rows; avoids broad row-deletion scans. |

## Not Yet Integrated / Do Not Lose

| Status | Feature / intent | Current location | Evidence | Required next action |
|---|---|---|---|---|
| ARCHIVED | Confirmation response / time dropdown / reject-hold re-registration / contract deletion sync | Deleted remote branch: `origin/claude/add-confirmation-response-pfu90` | Time dropdown and reject/hold re-registration are already covered in `main`; explicit cancellation sync exists through `cancelContract()` | The old `syncDeletedContracts()` row-deletion scan was intentionally not adopted because it can delete rows from `스케줄상세` and external `개고생2.0` after ordinary row changes. |

## Branch / Worktree Classification

| Branch / worktree | Status | Decision |
|---|---|---|
| `main` at `/Users/choijaehyeong/my-gas-project2-worktrees/main-confirm-request-row-inherit` | Clean and GAS-synced | Keep as integration/deploy lane. |
| `codex/equipment-risk-checklist` at `/Users/choijaehyeong/my-gas-project2` | Clean; behind `origin/main`; stale duplicate onsite add-on edits were stashed | Do not deploy from here. The stale duplicate changes are preserved in stash `archive stale onsite addon duplicate after main 3964ede`. |
| `codex/confirm-request-row-inherit` | Fully included in main | Archive after no active session depends on it. |
| `codex/confirm-set-recheck-format` | Fully included in main | Archive after no active session depends on it. |
| `codex/contract-discount-regen` | Fully included in main | Archive after no active session depends on it. |
| `codex/dashboard-deposit-status` | Fully included in main | Archive after no active session depends on it. |
| `codex/hide-checkout-add-equipment` | Follow-up cleanup applied to main | Local branch deleted after merge-equivalent cleanup landed in `0697ee4`. |
| `codex/invoice-recipient-company` | Fully included in main | Archive after no active session depends on it. |
| `codex/billing-company-autocomplete` | Fully included in main | Archive after no active session depends on it. |
| `claude/hopeful-cohen-67f82e` | Very stale; clean after stashing untracked `AGENTS.md` copy | Do not use for deploy. Inspect only if someone remembers an unfinished intent. |

## Pre-Deploy Feature Preservation Checklist

Run this before any `scripts/integrate.sh` or `scripts/endwork.sh`:

1. Run `scripts/feature-ledger-audit.sh`.
2. For every dirty worktree, write down the user-facing feature intent.
3. For every remote branch with `AHEAD > 0`, decide `integrate`, `extract`, or `archive`.
4. For every intended feature, confirm at least one durable proof exists:
   - user-facing UI marker,
   - GAS action/function entrypoint,
   - regression test,
   - or live read/write verification when safe.
5. Never treat "automatic merge succeeds" as enough. Check whether the feature still appears in UI/API/test evidence after merge.
6. Only deploy from `main` after `main`, `origin/main`, and GAS are aligned.

## Current Action Queue

1. Remove or archive feature worktrees that are already fully included in main.
2. Keep this ledger updated whenever a session starts or finishes a feature branch.
