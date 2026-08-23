# Kakao Confirmation Loss Prevention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a Kakao reservation turn from completing without usable live conversation evidence, durably recover startup unread turns without customer auto-send, and replay the confirmed outage omissions through the native Hermes confirmation tool.

**Architecture:** Keep the native Hermes Gateway and `village_confirmation_request` decision lifecycle unchanged. Strengthen only the mechanical boundaries: wait for a real Kakao conversation body, reject header-only snapshots before Hermes, turn Gateway startup unread scans into no-send catch-up jobs, and mark evidence-capture failures retryable in the existing Supabase recovery state machine. Live repair uses the same deduplicated Gateway/tool path rather than direct GAS writes.

**Tech Stack:** Node.js ESM, `node:test`, Kakao CDP/DOM watcher, Hermes Gateway channel, Supabase recovery, GAS readback.

**Spec:** `docs/superpowers/plans/2026-08-23-kakao-confirmation-loss-prevention.md` (incident requirements and evidence are embedded below)

## Global Constraints

- Preserve native Hermes reasoning; do not add deterministic reservation classification or schedule decisions.
- Do not auto-send Kakao replies for startup catch-up, operator recovery, or Supabase replay jobs.
- Schedule/availability results remain owner-review-only.
- Use the existing confirmation tool and its durable receipt/dedupe contract for sheet writes.
- Do not directly modify the ambiguous Jo Hyo-jae equipment replacement.
- Do not run `clasp push`, `clasp deploy`, or `scripts/endwork.sh` from the feature branch.
- Preserve unrelated runtime temporary files and do not clean/reset other worktrees.

## Incident Evidence

- Kakao chat-list API returned live rows while the React DOM stayed at one row for roughly 38 hours.
- After reload, startup `initial_scan` events were logged but ignored because `PROCESS_INITIAL_SCAN=false`.
- AHN and Lee Sang-yul Gateway snapshots recorded `status=opened_target_chat` with empty or header-only conversation text.
- Their Hermes finals therefore had `visible_messages_used=[]`, `should_write_to_sheet=false`, and no confirmation receipt.
- Original sheet readback showed no `RQ-260823-*`; Kim Hye-ji, Ahn Jae-yong, and Lee Sang-yul had complete reservation forms but no RQ/contract.
- Jo Hyo-jae contract `260819-007` still contains two SmallHD Indie 7 rows after the customer requested a Mars M1 replacement.

---

### Task 1: Require real Kakao conversation evidence

**Files:**
- Modify: `tools/ai-browser-worker/worker.mjs`
- Test: `tools/ai-browser-worker/worker.test.mjs`

**Interfaces:**
- Produces: `isUsableKakaoConversationEvidence(evidence): boolean`
- Produces: `readKakaoConversationTargetEvidence(target, options): Promise<{dom,evidence,ready}>`
- Changes: `openKakaoTargetChatViaDevtools()` returns `conversation_evidence_unavailable` after bounded polling instead of a false `opened_target_chat`.
- Changes: `buildKakaoGatewayTurn()` throws typed `kakao_conversation_evidence_unavailable` before lookup/Hermes when the immutable snapshot is empty/header-only.

- [ ] **Step 1: Write failing tests** for header-only then-loaded polling, permanently header-only failure, and build-turn rejection before lookup.
- [ ] **Step 2: Run focused tests and verify RED** because the current function accepts the first empty/header-only DOM capture.
- [ ] **Step 3: Implement minimal bounded evidence polling and the defense-in-depth snapshot assertion.**
- [ ] **Step 4: Run focused tests and verify GREEN.**

### Task 2: Turn startup unread scans into safe Gateway catch-up

**Files:**
- Modify: `tools/kakao-dom-bridge/server.mjs`
- Test: `tools/kakao-dom-bridge/server.test.mjs`
- Test: `tools/ai-browser-worker/worker.test.mjs`

**Interfaces:**
- Produces: `classifyInitialScanIngress(event, { processInitialScan, hermesTransport })` returning `continue`, `ignore`, or `queue` plus a normalized event.
- Gateway normalization changes `initial_scan` to `startup_catchup`, preserves the original reason, and sets `recoveryOnly=true`.
- CLI mode continues to honor `PROCESS_INITIAL_SCAN=false`.
- Existing `isAutoSendEligibleLiveJob()` must return `startup_catchup_never_auto_sends` for normalized catch-up jobs.

- [ ] **Step 1: Write failing table-driven tests** for Gateway override, unread requirement, CLI disable behavior, and no-send eligibility.
- [ ] **Step 2: Run focused tests and verify RED** because the current handler discards every disabled initial scan.
- [ ] **Step 3: Implement the pure ingress classifier and use it in `handleEvent()`.**
- [ ] **Step 4: Run focused tests and verify GREEN.**

### Task 3: Retry evidence-capture failure through the existing durable recovery path

**Files:**
- Modify: `tools/kakao-dom-bridge/server.mjs`
- Test: `tools/kakao-dom-bridge/server.test.mjs`

**Interfaces:**
- Produces: `gatewayDispatchFailurePolicy(error)`.
- `kakao_conversation_evidence_unavailable` maps to `ai_worker_error` so the existing bounded Supabase sweeper retries it.
- All other dispatch failures retain `needs_human_review`; max attempts remain exactly the configured bound.

- [ ] **Step 1: Write failing policy and coordinator tests** proving evidence failure is retryable while a generic failure is terminal review.
- [ ] **Step 2: Run focused tests and verify RED.**
- [ ] **Step 3: Implement the minimal typed policy and wire it into `recordGatewayDispatchFailure()`.**
- [ ] **Step 4: Run focused tests and verify GREEN.**

### Task 4: Verify, deploy only to the owned runtime, and replay confirmed omissions

**Files:**
- Runtime mirror: `C:\Village\runtimes\my-gas-project2-production`
- No GAS source or sheet schema changes.

**Interfaces:**
- Consumes the normal `/events` bridge contract with deterministic `operator_recovery:<chat_id>:<last_log_id>` event hashes.
- Produces confirmation receipts and real RQ IDs only through `village_confirmation_request`.

- [ ] **Step 1: Run worker, bridge, watcher, syntax, and diff verification suites.**
- [ ] **Step 2: Commit feature changes, cherry-pick only that commit into the owned runtime branch, and restart the owned watchdog/runtime.**
- [ ] **Step 3: Verify CDP authentication, API/DOM parity, Gateway consumer freshness, and zero queued/failed unnotified work.**
- [ ] **Step 4: Submit no-send operator-recovery events for Kim Hye-ji, Ahn Jae-yong, Lee Sang-yul, and Jo Hyo-jae.**
- [ ] **Step 5: Read back exact confirmation receipts, RQ rows, Slack owner-review cards, and confirm no customer auto-send.**
- [ ] **Step 6: Leave Jo Hyo-jae's registered schedule unchanged unless the owner resolves replacement quantity.**

## Self-Review

- Spec coverage: evidence readiness, startup catch-up, bounded retry, no-send recovery, durable RQ receipts, and ambiguous schedule protection each have a task.
- Placeholder scan: no TBD/TODO/"similar to" steps remain.
- Type consistency: worker evidence errors use `error.code=kakao_conversation_evidence_unavailable`; server retry policy consumes the same exact code.
