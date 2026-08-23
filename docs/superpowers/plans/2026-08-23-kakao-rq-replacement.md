# Kakao Pending Confirmation Request Replacement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a same-window pending confirmation request converge to Hermes's complete replacement plan in one fenced tool operation.

**Architecture:** Add an explicit `replace_full_plan` decision mode at the worker boundary. The worker verifies the exact existing RQ during the same durable confirmation operation and then maps the typed replacement to GAS's existing `full_plan` stale-replacement contract. The Gateway keeps its one-operation fence; the prompt stops consuming that operation with a separate verification call when a mutation is intended.

**Tech Stack:** Node.js 24 `node:test`, Google Apps Script JavaScript, Hermes Gateway HTTP/channel, repository shell deployment scripts.

**Spec:** `docs/superpowers/specs/2026-08-23-kakao-rq-replacement.md`

## Global Constraints

- Preserve native Hermes reasoning; do not classify replacement prose in deterministic code.
- Never auto-send schedule or availability guidance to the customer.
- Do not change sheet names, column order, or registration behavior.
- Keep the durable one-operation lease and request-digest fencing intact.
- Use test-first RED then minimal GREEN for every production behavior change.

---

### Task 1: Typed pending-RQ replacement contract

**Files:**
- Modify: `tools/ai-browser-worker/worker.test.mjs`
- Modify: `tools/ai-browser-worker/worker.mjs`

**Interfaces:**
- Consumes: an AI decision containing `existing_confirm_request_ids`, `reservation_inquiry.already_registered=false`, and `sheet_row_candidate.equipment_write_mode="replace_full_plan"`.
- Produces: a validated `insertAndCheckRequest` payload with `args.입력모드="full_plan"` and exactly the AI-provided complete equipment list.

- [ ] **Step 1: Write the failing contract tests**

Add a 백남준 fixture whose existing rows are GM 70-200 II and Sachtler Ace but whose typed final plan is only `캠기어 마크4 (75볼)` quantity 2. Assert that validation accepts it and `buildSheetAppendPayload` emits only that row. Add negative assertions for missing existing RQ ID and `already_registered=true`.

- [ ] **Step 2: Run the focused contract tests and verify RED**

Run: `node --test --test-name-pattern "pending RQ replacement" tools/ai-browser-worker/worker.test.mjs`

Expected: FAIL because `replace_full_plan` is not an accepted equipment mode.

- [ ] **Step 3: Implement the minimal validation and payload mapping**

Accept `replace_full_plan` only when at least one exact existing RQ ID is present and the booking is not registered. Preserve the AI list and map only the outgoing GAS `입력모드` to `full_plan`.

- [ ] **Step 4: Run the focused contract tests and verify GREEN**

Run the Step 2 command and expect all matching tests to pass.

### Task 2: One-operation authoritative replacement execution

**Files:**
- Modify: `tools/ai-browser-worker/worker.test.mjs`
- Modify: `tools/ai-browser-worker/worker.mjs`

**Interfaces:**
- Consumes: the Task 1 typed replacement decision and `fetchExistingConfirmRequestResultForDecision(config, decision)`.
- Produces: one authoritative receipt; either one GAS mutation after exact RQ verification or a typed failure with zero mutations.

- [ ] **Step 1: Write failing executor tests**

Assert the executor reads exact `RQ-260823-010`, calls GAS once with only `캠기어 마크4 (75볼)` quantity 2, and returns the new authoritative result. Add a missing/mismatched lookup case asserting zero GAS calls.

- [ ] **Step 2: Run the focused executor tests and verify RED**

Run: `node --test --test-name-pattern "executes pending RQ replacement|rejects unverified pending RQ replacement" tools/ai-browser-worker/worker.test.mjs`

Expected: the replacement decision is rejected or mutation is attempted without the required exact pre-read.

- [ ] **Step 3: Implement the minimal pre-write fence**

For `replace_full_plan`, call the existing authoritative lookup inside `executeVillageConfirmationRequest`. Require the returned `reqID` to match one of the exact claimed IDs before enrichment, lease recheck, and GAS mutation. Return a typed failed receipt otherwise.

- [ ] **Step 4: Run the focused executor tests and verify GREEN**

Run the Step 2 command and expect both cases to pass.

### Task 3: Single-call Hermes prompt contract

**Files:**
- Modify: `tools/ai-browser-worker/worker.test.mjs`
- Modify: `tools/ai-browser-worker/worker.mjs`

**Interfaces:**
- Consumes: Gateway tool availability and the existing decision schema.
- Produces: prompt guidance that uses `replace_full_plan` for removals/replacements and exactly one tool call for a mutation; `should_write_to_sheet=false` verification is reserved for unchanged existing RQs.

- [ ] **Step 1: Write a failing prompt-boundary test**

Assert the built prompt distinguishes an unchanged existing RQ lookup from a replacement mutation and explicitly prohibits a separate verification call before a write.

- [ ] **Step 2: Run the focused prompt test and verify RED**

Run: `node --test --test-name-pattern "one native confirmation call for pending RQ replacement" tools/ai-browser-worker/worker.test.mjs`

Expected: FAIL because the current prompt requires the separate false-mode verification call.

- [ ] **Step 3: Update only the conflicting prompt/schema lines**

Add `replace_full_plan` to the JSON schema and decision policy. State that the write call performs authoritative existing-RQ verification internally and that a separate false-mode verification is only for an unchanged/no-write RQ.

- [ ] **Step 4: Run the focused prompt test and verify GREEN**

Run the Step 2 command and expect it to pass.

### Task 4: Regression, integration, and live repair

**Files:**
- Verify: `test/confirm-request-stale-replace.behavior.test.js`
- Verify: `test/confirm-request-stale-replacement.test.js`
- Verify: `tools/kakao-dom-bridge/*.test.mjs`
- Live data: Google Sheet `확인요청` through the authenticated GAS `insertAndCheckRequest` API.

**Interfaces:**
- Consumes: Tasks 1-3 and the existing GAS guarded stale-replacement behavior.
- Produces: deployed worker/GAS parity and a corrected live request with no customer send.

- [ ] **Step 1: Run focused and full suites**

Run the worker suite, the two stale-replacement GAS tests, relevant bridge tests, syntax checks, and `git diff --check`.

- [ ] **Step 2: Finish the feature branch and integrate through the repository scripts**

Run `./scripts/finishbranch.sh "fix: support pending RQ equipment replacement"`, then from clean `main` run `./scripts/integrate.sh codex/kakao-rq-replacement "fix: support pending RQ equipment replacement"` so GAS deploy and Git push follow repository policy.

- [ ] **Step 3: Repair 백남준 through the authenticated GAS boundary**

Submit one `full_plan` request for customer `백남준`, phone `010-8739-5793`, `2026-08-25 21:00` through `2026-08-26 21:00`, discount `개인사업자/프리랜서`, and equipment `캠기어 마크4 (75볼)` quantity 2. Do not send Kakao.

- [ ] **Step 4: Verify live readback and no-send evidence**

Read back the resulting RQ and confirm exactly one top-level equipment row. Confirm the prior GM/Sachtler request is absent, no trade exists, and the repair added no sent auto-reply entry.

## Self-Review

- Spec coverage: typed replacement, one-operation tool use, authoritative pre-read, additions-only preservation, registered-booking guard, no-send, live repair, and regression coverage are assigned.
- Placeholder scan: no deferred or unspecified implementation steps remain.
- Type consistency: `replace_full_plan`, `existing_confirm_request_ids`, `fetchExistingConfirmRequestResultForDecision`, and GAS `입력모드="full_plan"` are used consistently.
