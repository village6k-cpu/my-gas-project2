# Kakao Staff-Authorized Reservation Registration Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Use superpowers:test-driven-development for every production change and superpowers:verification-before-completion before any completion claim.

**Goal:** Add a native-Hermes, durable, exactly-once path that registers the exact pending confirmation request authorized by a Village staff reply, including an optional exact pending-state rewrite in the same operation.

**Architecture:** Hermes semantically produces a typed full-state authorization from one room's latest conversation. A new plugin tool posts it to a new Gateway operation. Gateway durably reserves the operation, a Windows runner invokes one GAS entry point, GAS fences the exact pending baseline and period under lock, optionally replaces the pending request, registers it through the existing implementation, and returns authoritative readback. The result application trusts only the exact durable receipt and records a `reservation_registration` audit event without sending a duplicate customer response.

**Tech Stack:** Google Apps Script JavaScript, Node.js ESM/CommonJS, Python Hermes plugin, JSONL durable Gateway channel, Supabase/Postgres audit, Next.js Today Dashboard.

---

## Task 1: Define the exact GAS and Windows runner contract

**Files:**
- Modify: `checkAvailability.js`
- Modify: `sheetAPI.js`
- Modify: `scripts/windows/village-confirm-request.js`
- Test: `test/confirmed-reservation-commit.behavior.test.js`
- Test: `test/windows-village-confirm-request.test.js`

- [x] Add RED tests for unchanged pending RQ registration, exact desired-state replacement then registration, stale equipment baseline, stale four-part period, wrong/non-pending request, blocker before write, authoritative readback, and post-write uncertain evidence.
- [x] Add a bounded `runFunction` entry point that accepts only the typed registration object and returns a versioned result envelope.
- [x] Under the existing confirmation `ScriptLock`, re-read and compare exact request ID, complete top-level equipment plan, and all four period fields before ID allocation, deletion, replacement, or registration.
- [x] Reuse existing pending replacement and `registerByReqID()` logic; refactor only enough for a structured return value and authoritative before/after evidence.
- [x] Ensure the runner sends internal credentials, preserves all authoritative fields, uses a registration-safe timeout, and marks uncertain writes without retrying.
- [x] Run focused behavior/static tests and syntax checks.

## Task 2: Add the worker decision and trusted-receipt contract

**Files:**
- Modify: `tools/ai-browser-worker/worker.mjs`
- Modify: `tools/ai-browser-worker/worker.test.mjs`

- [x] Add RED tests that diverse semantically authorized fixtures produce one typed commit decision while conditional/ambiguous/customer-only fixtures do not; tests must not require any production keyword list.
- [x] Add strict mechanical validation for target scope, request ID, exact latest room revision, bounded source evidence, complete normalized snapshots, and 24-hour periods.
- [x] Update the native Hermes prompt to distinguish inquiry creation, staff-authorized pending commit, and already-registered mutation without defining a closed phrase vocabulary.
- [x] Add receipt preparation that trusts exactly one correlated durable commit receipt, strips model-authored receipt/evidence fields, returns `no_reply` only on exact success, and produces one no-send owner review for stale/blocked/partial/contradictory states.
- [x] Prove ordinary FAQ, inquiry confirmation requests, and registered changes retain existing behavior.

## Task 3: Add durable Gateway routing and fencing

**Files:**
- Modify: `tools/kakao-dom-bridge/hermes-gateway-channel.mjs`
- Modify: `tools/kakao-dom-bridge/hermes-gateway-channel.test.mjs`
- Modify: `tools/kakao-dom-bridge/hermes-gateway-http.mjs`
- Modify: `tools/kakao-dom-bridge/hermes-gateway-http.test.mjs`
- Modify: `tools/kakao-dom-bridge/server.mjs`
- Modify: `tools/kakao-dom-bridge/server.test.mjs`

- [x] Add RED channel tests for the new receipt schema, exact reservation fence, same-digest coalescing, different-digest conflict, restart-unresolved handling, late exact evidence, and no replay.
- [x] Add RED HTTP tests for exact body fields, pre-executor immutable snapshot/digest, expired/wrong lease rejection, receipt correlation, and body-size boundaries.
- [x] Add RED server tests for config mapping, runner invocation, lease assertions before every possible GAS write, exact durable receipt selection, and result application.
- [x] Implement the new operation by extracting/reusing the generic durable-operation mechanics rather than copying an unfenced route.
- [x] Ensure one job still owns at most one tool operation and all unresolved post-write states remain human-review terminal.

## Task 4: Add the native Hermes plugin tool

**Repository:** `C:\Village\village-ai-worktrees\kakao-hermes-platform-plugin` in a new clean isolated worktree.

**Files:**
- Modify: `migration/hermes/plugins/kakao_village/__init__.py`
- Modify: `migration/hermes/plugins/kakao_village/http_client.py`
- Add: `migration/hermes/plugins/kakao_village/confirmed_reservation_commit_tool.py`
- Modify: corresponding plugin contract, adapter, registration, and round-trip tests.

- [x] Preserve the existing dirty plugin worktree and create a clean feature worktree from its tracked HEAD.
- [x] Add RED tests for model-visible schema, hidden ContextVar lease, exact job/room/revision correlation, canonical UUID lease, timeout, result/no-final/cancelled terminal behavior, and concurrent same-room handoff.
- [x] Register `village_confirmed_reservation_commit` with only the typed registration schema; never expose lease fields to the model.
- [x] Reuse the existing BridgeClient and active-turn lease lifecycle; post to the new Gateway route with a registration-safe timeout below Hermes' outer tool deadline.
- [x] Run the full plugin suite and installed-Hermes import/registration smoke test.

## Task 5: Extend the automatic-processing audit

**Files:**
- Modify: `tools/kakao-dom-bridge/kakao-automation-audit.mjs`
- Modify: `tools/kakao-dom-bridge/kakao-automation-audit.test.mjs`
- Add: a new additive Supabase migration under `supabase/migrations/`
- Modify: `apps/today-dashboard/app/api/automation-audit/route.ts`
- Modify: `apps/today-dashboard/lib/automation-audit/inbox-model.mjs`
- Modify: focused audit API/model/static tests.

- [x] Add RED tests for effect `reservation_registration`, deterministic event identity, bounded no-PII detail, success/blocked/partial outcomes, pagination/filtering, and no Slack delivery requirement.
- [x] Extend the additive database enum/check constraint without changing existing rows or columns.
- [x] Add the effect label and filters to `후속조치 > 자동처리`, preserving the existing inbox layout and cursor behavior.
- [x] Prove registration audit failures are durable and visible but never cause a successful business mutation to replay.

## Task 6: Add cross-layer incident replay and regression coverage

**Files:**
- Add: sanitized fixture under `test/fixtures/kakao-staff-authorized-registration/`
- Modify: relevant worker/server/plugin replay tests.

- [x] Encode the observed missing-registration incident without customer name, phone, or raw conversation.
- [x] Prove full flow: latest room revision -> native typed tool call -> durable reservation -> fake GAS exact write -> authoritative receipt -> result application -> `no_reply` -> one audit row.
- [x] Prove exact semantic retry writes once, different revision conflicts, conditional staff language produces no commit, and a stale pending baseline never writes.
- [x] Run all relevant Node, GAS, dashboard, and Python test suites plus syntax and diff checks.

## Task 7: Review, integrate, deploy, and verify

**Files:**
- Update: implementation report under `.superpowers/sdd/2026-09-07-kakao-staff-authorized-registration/`

- [x] Request an independent code review of the full cross-repository diff and fix every Critical/Important finding with RED-to-GREEN regressions.
- [ ] Finish feature branches with `scripts/finishbranch.sh`; integrate only from clean `main` using `scripts/integrate.sh` in the required order.
- [ ] Deploy GAS through the repository workflow, then install/update only the root Kakao Hermes plugin/profile artifacts required by this feature.
- [ ] Restart only the required root Gateway/worker processes and verify PID, health, skill/tool discovery, exact hashes, and no-send configuration.
- [ ] Run a local no-send replay and verify: one GAS fake/canary mutation, one durable receipt, one result application, zero Kakao/Slack sends, and one `reservation_registration` audit record.
- [ ] Verify the Today Dashboard API/UI readback and one natural watchdog run.
- [ ] Perform any real customer correction or registration only under separate explicit authorization, then verify authoritative sheet/trade/contract/audit readback.

## Completion criteria

- [ ] No Korean approval keyword router or regex exists in production code.
- [ ] A clear staff-authorized pending request can be registered without a manual Sheet click.
- [ ] Ambiguous, conditional, stale, conflicting, or customer-only text cannot write.
- [ ] Optional pending rewrite plus registration is one durable operation with one receipt.
- [ ] Registered changes continue through the existing registered-change operation.
- [ ] Success produces no duplicate customer reply and remains easy to inspect in `자동처리`.
- [ ] Restart, timeout, response loss, and semantic retry cannot duplicate the business write.
