# Atomic Registered Trade Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the five-stage registered-trade correction workflow with one bounded GAS correction call so normal item/date corrections do not incur repeated model decisions, HTTP round trips, global-lock contention, or a missing-primary-item gap.

**Architecture:** Hermes remains responsible for choosing the exact trade, dates, removal schedule IDs, exact catalog names, quantities, and whether to send. A first-class `scheduleCorrectRegisteredTrade` action acquires the script lock once, rejects active cross-operation leases and unsafe removal states, expands each removal to one exact set-instance boundary, preflights the requested-period inventory after excluding those rows, applies add-before-remove mutations with nested locks and duplicate regeneration disabled, releases the lock, wakes any durable structure queue even after a partial failure, regenerates the contract once, and verifies the result against independent removal/add plans plus authoritative schedule/component/ledger readback. The Windows runner performs one correction POST and at most one separately idempotent customer-send POST; it never retries `BUSY`, a partial state, or an ambiguous write and preserves structured reconciliation evidence.

**Tech Stack:** Google Apps Script JavaScript, Node.js CommonJS, Node test runner, built-in `fetch`.

## Global Constraints

- Preserve stock Hermes reasoning and the compact native Village skill entrypoint.
- Do not add a natural-language broker, generic sheet-write route, or deterministic business-decision layer.
- AI supplies exact `tradeId`, `operationId`, dates, removal identities, additions, and `sendEstimate`.
- Preflight all normal validation before the first mutation.
- Acquire the GAS global lock at most once for the correction mutation and never hold it during Drive/contract generation.
- Apply additions before removals so a failure cannot reproduce the observed period where the primary camera was absent.
- Do not automatically retry `BUSY`, failed writes, contract regeneration, or customer send.
- No live customer mutation is used for verification.
- Preserve all unrelated dirty worktrees and the pulled live GAS source.

---

### Task 1: Executable GAS correction contract

**Files:**
- Create: `test/registered-trade-correction.behavior.test.js`
- Modify: `checkAvailability.js`
- Modify: `sheetAPI.js`

**Interfaces:**
- Consumes: `correctRegisteredTrade({ tradeId, operationId, dateChange?, remove?, add? })`.
- Produces: `{ success, tradeId, operationId, stages, contractRegeneration, readback, customerNotificationSent:false }` or a fail-closed `{ success:false, code, error }` before mutation.

- [x] **Step 1: Write the failing behavior tests**

Use a VM harness with real `correctRegisteredTrade` orchestration and controlled GAS primitives. Assert that:

```js
assert.deepEqual(calls.preflight, ['date', 'remove', 'add']);
assert.deepEqual(calls.mutate, ['date', 'add', 'remove']);
assert.equal(calls.lockTries, 1);
assert.equal(calls.lockHeldDuringRegeneration, false);
assert.equal(result.customerNotificationSent, false);
```

Add a lock-busy fixture and assert zero mutation calls and exactly one `tryLock` call. Add an add-preflight failure fixture and assert zero mutation calls. Add an add mutation failure fixture and assert removal is never attempted.

- [x] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node --test test/registered-trade-correction.behavior.test.js
```

Expected: FAIL because `correctRegisteredTrade` and the API action do not exist.

- [x] **Step 3: Implement the minimal orchestration**

Add strict nested validation for exact fields and quantities. Under one 1.5-second acquisition, read one baseline, expand exact removal instances, and preflight projected inventory before the first write. Reuse the date/add/remove primitives with lock ownership and regeneration deferred, then release before `regenerateContractById(..., { strictLedgerLink:true })`. Verify contract/schedule period, full expanded row multiset, added identities, removed IDs, and ledger link. Any failure after mutation starts returns structured `PARTIAL_STATE` with best-effort readback and never permits customer send.

- [x] **Step 4: Run the focused test and verify GREEN**

Run the Task 1 test and `test/registered-trade-date-change.static.test.js`.

### Task 2: Reuse existing primitives without nested lock or duplicate regeneration

**Files:**
- Modify: `checkAvailability.js`
- Modify: `test/registered-trade-date-change.static.test.js`
- Modify: `test/equipment-remove-batch.behavior.test.js`

**Interfaces:**
- `changeRegisteredTradeDates(args, { lockAlreadyHeld?, deferContractRegeneration? })`
- `dashboardAddEquipments(tid, entries, { lockAlreadyHeld?, deferContractRegeneration?, periodOverride? })`
- `dashboardRemoveEquipmentBatch(tid, entries, { lockAlreadyHeld?, deferContractRegeneration? })`

- [x] **Step 1: Write failing regression tests**

Assert that internal lock-held calls do not call `getScriptLock`, do not queue contract regeneration, and do not wake triggers. Assert that standalone calls retain their prior lock and regeneration behavior. Assert that date-change contract regeneration is invoked only after its owned lock has been released.

- [x] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
node --test test/registered-trade-date-change.static.test.js test/equipment-remove-batch.behavior.test.js test/registered-trade-correction.behavior.test.js
```

- [x] **Step 3: Implement the internal options**

Keep public API payloads unchanged. Make lock ownership explicit, suppress nested acquisition only for direct internal function options, and skip queueing/direct regeneration only when the composite caller requests it. Move standalone date-change regeneration and rollback regeneration outside the owned critical section while preserving readback and rollback verification.

- [x] **Step 4: Run focused tests and verify GREEN**

Run the Task 2 command and the existing dashboard idempotency suite.

### Task 3: Collapse the Windows runner to one correction request

**Files:**
- Modify: `scripts/windows/village-registered-trade-correction.js`
- Modify: `test/windows-village-registered-trade-correction.test.js`

**Interfaces:**
- Continues to expose `normalizeCorrectionInput(input)` and `runRegisteredTradeCorrection(options)`.
- Sends one `scheduleCorrectRegisteredTrade` POST containing the normalized explicit delta.
- Sends one separate `sendEstimate` POST only when `sendEstimate:true` and correction succeeded.

- [x] **Step 1: Change the runner tests and verify RED**

Assert this literal observable action sequence:

```js
assert.deepEqual(postActions, ['scheduleCorrectRegisteredTrade', 'sendEstimate']);
assert.equal(getCalls.length, 0);
```

Assert that `BUSY` is attempted once, sends nothing, and exposes `stage === 'scheduleCorrectRegisteredTrade'`. Assert that a send-only request makes only the send call.

- [x] **Step 2: Run the runner test and verify RED**

Run `node --test test/windows-village-registered-trade-correction.test.js`.

- [x] **Step 3: Implement the one-call runner**

Remove runner-side baseline/final GET orchestration and the date/remove/add/regenerate POST sequence. Post the exact normalized correction once, accept only verified GAS success/readback, then optionally send once. Preserve credential redaction and ambiguous-outcome behavior.

- [x] **Step 4: Run runner tests and verify GREEN**

Run the Task 3 test.

### Task 4: Verification, integration, and safe deployment

**Files:**
- Verify all files above; no customer data writes.

- [x] **Step 1: Run the complete relevant regression set (60/60 passed)**

```powershell
node --test test/windows-village-registered-trade-correction.test.js test/registered-trade-correction.behavior.test.js test/registered-trade-date-change.static.test.js test/equipment-remove-batch.behavior.test.js test/dashboard-mutation-idempotency.test.js
```

- [x] **Step 2: Run static and diff checks (3 syntax checks and `git diff --check` passed)**

Run `git diff --check` and inspect the scoped diff for generic writes, customer-send coupling, nested lock acquisition, unbounded retries, and unrelated files.

- [ ] **Step 3: Commit and integrate without touching dirty worktrees**

Commit only the scoped files on the isolated branch. Integrate through a clean deployment worktree based on current `origin/main`; do not reset or clean the user's dirty `main` or live worker worktree.

- [ ] **Step 4: Pull before push and deploy the existing web-app ID**

Run `clasp pull`, verify no semantic drift, then `clasp push` and deploy the existing deployment ID with a bounded description. Push the integrated Git commit only after all tests pass.

- [ ] **Step 5: Verify live structure without a customer mutation**

Read back the deployed capability/action and use only a synthetic harness or dry-run path. Do not send Slack, Kakao, an estimate, or mutate a real transaction.

## Self-review

- Spec coverage: one correction request, one lock, add-before-remove, regeneration outside lock, no retries, final readback, and optional send separation are covered.
- Placeholder scan: no deferred implementation steps or unspecified error handling remain.
- Type consistency: `scheduleCorrectRegisteredTrade` carries the same normalized correction envelope from runner to GAS.
