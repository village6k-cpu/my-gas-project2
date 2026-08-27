# Kakao Staff-Confirmed Reservation Mutations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply unambiguous, staff-confirmed Kakao reservation additions, removals, replacements, quantity changes, and date/time changes to the exact pending request or registered trade; block before writes and notify the owner when the target, catalog mapping, stock, or authoritative state is unsafe.

**Architecture:** Native Hermes remains the only conversation-reasoning layer. Pending requests continue through `village_confirmation_request`; registered trades use one new lease-fenced native tool that calls the existing in-process registered-trade correction runner. The GAS operation performs authoritative preflight and final readback under its existing lock, while the Gateway persists one canonical operation digest and one correlated receipt. Successful staff-confirmed changes produce `no_reply`; conflicts and unknown/partial outcomes produce a durable urgent owner notification and never auto-replay a write.

**Tech Stack:** Hermes Python plugin, Node.js ESM worker and Gateway bridge, CommonJS registered-trade runner, Google Apps Script, Node `node:test`, Python `pytest`.

**Spec:** `docs/superpowers/specs/2026-08-27-kakao-staff-confirmed-reservation-mutations-design.md`

## Global Constraints

- Preserve native Hermes reasoning. Do not add keyword approval rules, a second agent, a generic sheet writer, or a new routing service.
- A customer request alone is read-only. A mutation may execute only when Hermes supplies a typed staff-confirmation decision from the same opened room and exact conversation revision.
- Do not trust model-supplied lease IDs, operation IDs, request digests, or receipt IDs. The plugin injects the active ContextVar fence; the Gateway creates the durable operation identity.
- Pending request changes reuse the existing confirmation executor. Registered trade changes reuse `runRegisteredTradeCorrection()` in process; do not spawn its CLI per request.
- Keep `allowConflicts:false` for all agent-initiated date changes. A real stock conflict must produce zero writes.
- No estimate, Kakao message, tax invoice, payment change, or direct cell edit is part of this operation.
- If a write may have started and the outcome is unknown, persist stage evidence, require human review, and never replay automatically.
- Write tests first, prove RED for the missing behavior, make the smallest production change, and run the focused test before moving on.
- Work in feature branches/worktrees. Do not run `clasp push`, `clasp deploy`, `scripts/endwork.sh`, install the plugin into the live Hermes profile, restart Hermes, send Slack/Kakao, or mutate live schedules until the rollout gate in Task 8 is explicitly approved.
- Preserve unrelated worktree changes and the plugin repository's generated `__pycache__/` directories; never reset, clean, or delete them.

---

### Task 1: Create isolated implementation branches and capture the baseline

**Files:**

- Read: `scripts/newtask.sh`
- Read: `scripts/startwork.sh`
- Read: `C:\Village\village-ai-worktrees\kakao-hermes-platform-plugin\AGENTS.md`
- Create through script: `C:\Village\my-gas-project2-worktrees\kakao-staff-confirmed-mutations`

- [ ] **Step 1: Verify the current integration checkout before branching**

Run from `C:\Village\my-gas-project2`:

```powershell
git status --short --branch
git log -3 --oneline
```

Expected: `main` contains design commit `8259748`; no uncommitted tracked files are present. Stop and preserve the state if this differs.

- [ ] **Step 2: Create the main-repository feature worktree**

Use PortableGit Bash already installed for this workspace:

```powershell
$env:PATH = 'C:\Users\ssper\AppData\Local\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v24.18.0-win-x64;C:\Users\ssper\AppData\Local\Village\tools\PortableGit-2.55.0.3\bin;' + $env:PATH
& 'C:\Users\ssper\AppData\Local\Village\tools\PortableGit-2.55.0.3\bin\bash.exe' ./scripts/newtask.sh kakao-staff-confirmed-mutations
```

Expected: branch `codex/kakao-staff-confirmed-mutations` and a separate worktree are created without changing GAS.

- [ ] **Step 3: Run the required start check in the new worktree**

```powershell
Set-Location 'C:\Village\my-gas-project2-worktrees\kakao-staff-confirmed-mutations'
& 'C:\Users\ssper\AppData\Local\Village\tools\PortableGit-2.55.0.3\bin\bash.exe' ./scripts/startwork.sh
```

Expected terminal line: `작업 시작 OK`. Do not edit if the script stops.

- [ ] **Step 4: Verify the plugin branch without changing generated files**

Run a read-only status with a command-local safe-directory setting:

```powershell
$plugin = 'C:\Village\village-ai-worktrees\kakao-hermes-platform-plugin'
git -c safe.directory=$plugin -C $plugin status --short --branch
git -c safe.directory=$plugin -C $plugin log -3 --oneline
```

Expected: the tracked plugin worktree is clean; only the previously observed generated cache directories may be untracked.

- [ ] **Step 5: Record baseline focused suites**

```powershell
$node = 'C:\Users\ssper\AppData\Local\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v24.18.0-win-x64\node.exe'
& $node --test test/windows-village-registered-trade-correction.test.js test/registered-trade-correction.behavior.test.js
& $node --test tools/ai-browser-worker/worker.test.mjs tools/kakao-dom-bridge/hermes-gateway-channel.test.mjs tools/kakao-dom-bridge/hermes-gateway-http.test.mjs tools/kakao-dom-bridge/server.test.mjs
```

Then from the plugin root:

```powershell
$plugin = 'C:\Village\village-ai-worktrees\kakao-hermes-platform-plugin'
$python = 'C:\Users\ssper\AppData\Local\hermes\hermes-agent\.venv\Scripts\python.exe'
$env:PYTHONPATH = $plugin
& $python -m pytest "$plugin\migration\hermes\plugins\kakao_village\tests" -q
```

Expected: baseline suites pass. Record any pre-existing unrelated failure separately; do not repair it in this task.

---

### Task 2: Strengthen the existing registered-trade correction preconditions

**Files:**

- Modify: `scripts/windows/village-registered-trade-correction.js`
- Modify: `checkAvailability.js`
- Test: `test/windows-village-registered-trade-correction.test.js`
- Test: `test/registered-trade-correction.behavior.test.js`

- [ ] **Step 1: Add RED runner tests for exact quantity and period expectations**

Extend normalization tests with this exact input shape:

```js
const normalized = normalizeCorrectionInput({
  tradeId: '260824-008',
  operationId: '11111111-2222-4333-8444-555555555555',
  expectedPeriod: {
    startDate: '2026-08-27',
    startTime: '06:00',
    endDate: '2026-08-27',
    endTime: '18:00'
  },
  remove: [{
    scheduleId: '260824-008-07',
    expectedName: '소니 FE 28-135mm',
    expectedQty: 1
  }],
  add: [{ name: '소니 GM 70-200mm II', qty: 1 }]
});
assert.equal(normalized.remove[0].expectedQty, 1);
assert.equal(normalized.expectedPeriod.startTime, '06:00');
```

Also assert rejection of zero, fractional, missing, and greater-than-99 `expectedQty`, malformed 24-hour times, unknown fields, and an end instant not after the start instant.

Run:

```powershell
& $node --test test/windows-village-registered-trade-correction.test.js
```

Expected RED: `expectedPeriod` and `expectedQty` are currently forbidden or discarded.

- [ ] **Step 2: Add RED GAS behavior tests that prove all mismatches are pre-write**

Add behavior cases for:

1. baseline quantity differs from `expectedQty`;
2. baseline contract period differs from `expectedPeriod`;
3. replacement stock conflicts after excluding the exact removal schedule ID;
4. the same replacement is available only when the target trade's current allocation is excluded.

Each mismatch/conflict case must assert zero calls to date, add, remove, regeneration, and notification mutations. The self-exclusion case must assert the dry-run receives the exact `excludeScheduleIds` list and then succeeds.

Run:

```powershell
& $node --test test/registered-trade-correction.behavior.test.js
```

Expected RED: the current operation checks removal name but not expected quantity or expected period.

- [ ] **Step 3: Implement strict CommonJS input normalization**

Add `expectedPeriod` to `ALLOWED_INPUT_FIELDS`; require `expectedQty` on every removal; normalize the period with the existing date/time helpers. The normalized contract is:

```js
{
  tradeId,
  operationId,
  expectedPeriod: {
    startDate: 'YYYY-MM-DD',
    startTime: 'HH:mm',
    endDate: 'YYYY-MM-DD',
    endTime: 'HH:mm'
  },
  dateChange,
  remove: [{ scheduleId, expectedName, expectedQty }],
  add: [{ name, qty }],
  sendEstimate: false
}
```

`expectedPeriod` is mandatory for an agent-triggered correction. Preserve CLI backward compatibility only if a test proves an existing human CLI call without the field is required; the new Gateway executor must always supply it.

- [ ] **Step 4: Enforce the same contract inside GAS before `mutationStarted`**

Update `normalizeRegisteredTradeCorrection_()` and `preflightRegisteredTradeRemoval_()` so that:

```js
if (Number(row.qty) !== Number(removal.expectedQty)) {
  throw new Error('removal preflight: 수량이 일치하지 않습니다: ' + removal.scheduleId);
}
```

Immediately after `lockedBaseline` is read, compare all four baseline period values to `correction.expectedPeriod`. Throw `baseline period mismatch` before add dry-run or any write. Keep the existing `ScriptLock`, mutation lease check, exact catalog requirement, target-trade exclusion, contract regeneration, ledger verification, and final row multiset verification unchanged.

- [ ] **Step 5: Pass the focused correction suites**

```powershell
& $node --test test/windows-village-registered-trade-correction.test.js test/registered-trade-correction.behavior.test.js
& $node --check scripts/windows/village-registered-trade-correction.js
git diff --check
```

Expected GREEN: exact baseline mismatches fail before writes; the own-trade-exclusion success path remains green.

- [ ] **Step 6: Commit the correction precondition slice on the main-repository feature branch**

```powershell
git add -- scripts/windows/village-registered-trade-correction.js checkAvailability.js test/windows-village-registered-trade-correction.test.js test/registered-trade-correction.behavior.test.js
git commit -m "fix: fence registered trade correction baselines"
```

---

### Task 3: Add the pure staff-confirmed mutation contract and registered executor

**Files:**

- Create: `tools/ai-browser-worker/staff-confirmed-mutation.mjs`
- Create: `tools/ai-browser-worker/staff-confirmed-mutation.test.mjs`
- Read only for reuse: `scripts/windows/village-registered-trade-correction.js`

- [ ] **Step 1: Write RED contract tests for the typed AI decision**

Define one canonical registered replacement fixture:

```js
const MUTATION = {
  confirmed: true,
  kind: 'equipment_replace',
  target_scope: 'registered_trade',
  trade_id: '260824-008',
  source_evidence: {
    customer_request: '28-135 취소하고 sony 70-200 gm 2.8 로 부탁드립니당',
    staff_confirmation: '네',
    conversation_revision: 8
  },
  expected_period: {
    start_date: '2026-08-27',
    start_time: '06:00',
    end_date: '2026-08-27',
    end_time: '18:00'
  },
  expected_before: [{
    schedule_id: '260824-008-07',
    name: '소니 FE 28-135mm',
    quantity: 1
  }],
  desired_after: [{ name: '소니 GM 70-200mm II', quantity: 1 }],
  date_change: null
};
```

Add a `target_scope:'pending_request'` fixture that uses one canonical `request_id`, omits `trade_id` and `expected_period`, and carries top-level `{name, quantity}` rows without schedule IDs. Assert rejection of: `confirmed:false`, revision mismatch, malformed request/trade/schedule IDs, scope-specific fields on the wrong scope, duplicate schedule IDs, blank evidence, non-24-hour time, an empty change, unsupported keys, and model-supplied `lease_id`, `operation_id`, `request_digest`, or receipt fields.

Run:

```powershell
& $node --test tools/ai-browser-worker/staff-confirmed-mutation.test.mjs
```

Expected RED: the module does not exist.

- [ ] **Step 2: Implement normalization and the correction-input projection**

Export exactly:

```js
export function validateStaffConfirmedMutation(mutation, { roomRevision } = {})
export function buildRegisteredTradeCorrectionInput(mutation, operationId)
export async function executeVillageRegisteredReservationChange(request, options = {})
```

`validateStaffConfirmedMutation()` is the discriminated-union validator:

- `target_scope:'pending_request'` requires one exact `request_id`, forbids `trade_id` and schedule IDs, and leaves execution to the existing confirmation operation;
- `target_scope:'registered_trade'` requires one exact `trade_id`, `expected_period`, and exact schedule IDs for every `expected_before` row, and is the only scope accepted by `buildRegisteredTradeCorrectionInput()` and the registered executor.

`buildRegisteredTradeCorrectionInput()` maps:

```js
return {
  tradeId: mutation.trade_id,
  operationId,
  expectedPeriod: {
    startDate: mutation.expected_period.start_date,
    startTime: mutation.expected_period.start_time,
    endDate: mutation.expected_period.end_date,
    endTime: mutation.expected_period.end_time
  },
  dateChange: mutation.date_change === null ? null : {
    newStartDate: mutation.date_change.new_start_date,
    startTime: mutation.date_change.new_start_time,
    newEndDate: mutation.date_change.new_end_date,
    endTime: mutation.date_change.new_end_time,
    allowConflicts: false
  },
  remove: mutation.expected_before.map((row) => ({
    scheduleId: row.schedule_id,
    expectedName: row.name,
    expectedQty: row.quantity
  })),
  add: mutation.desired_after.map((row) => ({ name: row.name, qty: row.quantity })),
  sendEstimate: false
};
```

Use `createRequire(import.meta.url)` once at module load to import `runRegisteredTradeCorrection`; do not spawn a process.

- [ ] **Step 3: Write RED executor tests for success, conflict, and unknown outcome**

The executor tests must prove:

- exact job/room/revision validation;
- `options.operationFence.operation_id` becomes the correction operation ID;
- `options.assertCurrentClaim()` runs immediately before the external correction call;
- success returns a correlated `village-registered-reservation-change-receipt/v1` receipt with `status:'ok'`, exact trade ID, authoritative readback, `customer_reply:'no_reply'`, and no send result;
- an explicit pre-write GAS rejection returns `status:'blocked'`, `applied_stages:[]`, and exact error evidence;
- `CorrectionStageError` with `outcomeUnknown:true` returns `status:'partial_success'` with preserved applied/attempted stages;
- an unstructured exception before any write returns `status:'failed'`;
- no path calls the runner more than once.

- [ ] **Step 4: Implement correlated receipts without automatic replay**

The executor receives:

```js
{
  config,
  job: { job_id, room_key, room_revision },
  roomRevision,
  mutation,
  dependencies: {
    operationFence,
    assertCurrentClaim,
    runRegisteredTradeCorrection,
    randomUUID,
    now
  }
}
```

Receipt fields are fixed to:

```js
{
  schema: 'village-registered-reservation-change-receipt/v1',
  receipt_id,
  job_id,
  room_key,
  room_revision,
  status,
  target_scope: 'registered_trade',
  trade_id,
  mutation_kind,
  authoritative_result,
  applied_stages,
  attempted_stage,
  customer_reply: 'no_reply',
  created_at,
  error
}
```

Never catch an unknown/partial result and call the correction runner again.

- [ ] **Step 5: Pass and commit the pure executor slice**

```powershell
& $node --test tools/ai-browser-worker/staff-confirmed-mutation.test.mjs
& $node --check tools/ai-browser-worker/staff-confirmed-mutation.mjs
git diff --check
git add -- tools/ai-browser-worker/staff-confirmed-mutation.mjs tools/ai-browser-worker/staff-confirmed-mutation.test.mjs
git commit -m "feat: execute staff confirmed registered changes"
```

---

### Task 4: Fence the new operation durably in the Gateway

**Files:**

- Modify: `tools/kakao-dom-bridge/hermes-gateway-channel.mjs`
- Modify: `tools/kakao-dom-bridge/hermes-gateway-channel.test.mjs`
- Modify: `tools/kakao-dom-bridge/hermes-gateway-http.mjs`
- Modify: `tools/kakao-dom-bridge/hermes-gateway-http.test.mjs`
- Modify: `tools/kakao-dom-bridge/server.mjs`
- Modify: `tools/kakao-dom-bridge/server.test.mjs`

- [ ] **Step 1: Add RED channel tests for the new tool/receipt pair**

Add this mapping expectation:

```js
['registered_reservation_change', 'village-registered-reservation-change-receipt/v1']
```

Prove that a reservation persists the exact job, room, revision, current lease, canonical digest, opaque operation ID, and tool type. Wrong/no lease, wrong digest, wrong operation ID, or a different mutation under the same claim must be rejected. Restart with a reserved operation must become `confirmation_operation_unresolved`-equivalent human review and must never become ready for automatic replay.

Expected RED: the tool is unsupported.

- [ ] **Step 2: Add RED HTTP tests for `/hermes/v1/tools/registered-reservation-change`**

Cover:

1. one valid request reserves once, executes once, persists once, and returns the exact fenced receipt;
2. a semantic retry with reordered object keys reuses the same receipt;
3. a different typed mutation under the same lease returns `409 registered_reservation_change_conflict` before execution;
4. an expired lease before reservation returns `409 stale_lease` and execution count zero;
5. lease expiry or same-room supersession during the external call still allows only the exact reserved operation to persist its late evidence receipt;
6. restart with an unresolved reservation returns `409 registered_reservation_change_unresolved` and execution count zero;
7. `gateway_no_send` returns `403 writes_disabled` before reservation or execution;
8. the canonical digest includes the complete mutation, job, room, revision, and lease-correlated request envelope but ignores JSON key order.

- [ ] **Step 3: Add the channel receipt schema and status aggregates**

Extend `TOOL_RECEIPT_SCHEMAS` only. Reuse the current exact operation envelope, receipt matching, late-evidence, restart, reaper, result, and no-final rules.

Extend `channel.status()` with non-sensitive aggregates:

```js
registered_reservation_change: {
  reserved: 0,
  completed: 0,
  failed_human_review: 0,
  pending_failure_notifications: 0,
  oldest_reserved_age_ms: null,
  last_success_at: null
}
```

Derive these from persisted jobs; do not introduce a second state store.

- [ ] **Step 4: Add the HTTP route by mirroring the proven durable tool sequence**

Add exports:

```js
export function validateRegisteredReservationChangeBody(body)
export function registeredReservationChangeRequestDigest(body)
```

The route sequence is fixed:

1. parse bounded JSON and require trusted lease;
2. fail closed for `gateway_no_send`;
3. validate the typed body;
4. read the exact current claim;
5. check in-process coalescing and durable prior operation;
6. persist `registered_reservation_change` reservation;
7. re-check the current claim;
8. call `executeRegisteredReservationChange(body, { assertCurrentClaim, operationFence })` once;
9. server-author `lease_id`, `request_digest`, and `operation_id` onto the receipt;
10. persist the receipt before returning 200.

Keep this a local route implementation beside confirmation/document handling. Do not perform a broad tool-router refactor in this task.

- [ ] **Step 5: Wire the server executor and prove the operation fence reaches the worker**

Add:

```js
export function createGatewayRegisteredReservationChangeExecutor({
  getConfig,
  executeOperation = executeVillageRegisteredReservationChange
} = {})
```

Map the HTTP body to the executor's exact job/revision/mutation contract. The server test must prove that the exact `operationFence` and `assertCurrentClaim` objects received from HTTP are passed into `dependencies` unchanged.

- [ ] **Step 6: Pass and commit the Gateway slice**

```powershell
& $node --test tools/kakao-dom-bridge/hermes-gateway-channel.test.mjs tools/kakao-dom-bridge/hermes-gateway-http.test.mjs tools/kakao-dom-bridge/server.test.mjs
& $node --check tools/kakao-dom-bridge/hermes-gateway-channel.mjs
& $node --check tools/kakao-dom-bridge/hermes-gateway-http.mjs
& $node --check tools/kakao-dom-bridge/server.mjs
git diff --check
git add -- tools/kakao-dom-bridge/hermes-gateway-channel.mjs tools/kakao-dom-bridge/hermes-gateway-channel.test.mjs tools/kakao-dom-bridge/hermes-gateway-http.mjs tools/kakao-dom-bridge/hermes-gateway-http.test.mjs tools/kakao-dom-bridge/server.mjs tools/kakao-dom-bridge/server.test.mjs
git commit -m "feat: fence registered reservation changes"
```

---

### Task 5: Add the native Hermes registered-change tool

**Files in `C:\Village\village-ai-worktrees\kakao-hermes-platform-plugin`:**

- Create: `migration/hermes/plugins/kakao_village/registered_change_tool.py`
- Create: `migration/hermes/plugins/kakao_village/tests/test_registered_change_tool.py`
- Modify: `migration/hermes/plugins/kakao_village/__init__.py`
- Modify: `migration/hermes/plugins/kakao_village/http_client.py`
- Modify: `migration/hermes/plugins/kakao_village/tests/test_registration.py`
- Modify: `migration/hermes/plugins/kakao_village/tests/fake_bridge.py`
- Modify: `migration/hermes/plugins/kakao_village/tests/test_round_trip.py`

- [ ] **Step 1: Write RED plugin tests before production code**

The tool name is exactly `village_registered_reservation_change`. Its model-visible schema has one required property, `mutation`, with the typed fields from Task 3. It must not expose `lease_id`, `operation_id`, `request_digest`, `receipt_id`, `job_id`, or `room_key`.

Tests must prove:

- valid registered additions, removals, replacements, reductions, and date changes pass;
- customer-only/unconfirmed, pending-request scope, missing evidence, malformed IDs, invalid 24-hour time, unknown properties, and empty changes fail locally;
- absent/closed active turn fence fails before HTTP;
- the handler overwrites any hidden correlation attempt with the exact active ContextVar job/room/revision/lease;
- a receipt with any mismatched job/room/revision/lease/trade/schema fails;
- concurrent room tool calls preserve their own ContextVar fences;
- round-trip fake Bridge observes exactly one POST to the new route.

Run:

```powershell
$plugin = 'C:\Village\village-ai-worktrees\kakao-hermes-platform-plugin'
$python = 'C:\Users\ssper\AppData\Local\hermes\hermes-agent\.venv\Scripts\python.exe'
$env:PYTHONPATH = $plugin
& $python -m pytest "$plugin\migration\hermes\plugins\kakao_village\tests\test_registered_change_tool.py" "$plugin\migration\hermes\plugins\kakao_village\tests\test_registration.py" "$plugin\migration\hermes\plugins\kakao_village\tests\test_round_trip.py" -q
```

Expected RED: module, registration, client method, and fake route do not exist.

- [ ] **Step 2: Implement the transport-only tool**

Use constants:

```python
REGISTERED_CHANGE_REQUEST_SCHEMA_TAG = "village-registered-reservation-change-request/v1"
REGISTERED_CHANGE_RECEIPT_SCHEMA_TAG = "village-registered-reservation-change-receipt/v1"
```

`handle_registered_reservation_change()` validates only typed transport shape, reads `ACTIVE_TURN_FENCE`, injects the trusted correlation, calls `BridgeClient.registered_reservation_change()` once, validates the exact correlated receipt, and returns `tool_result(receipt)`. It never interprets Korean prose and never retries.

- [ ] **Step 3: Register the tool and client route**

Add the third Village tool registration in `__init__.py` and this client method:

```python
def registered_reservation_change(self, payload: dict[str, Any]) -> dict[str, Any]:
    return self._post("/hermes/v1/tools/registered-reservation-change", payload)
```

Extend the fake Bridge with the same route and exact receipt schema. Keep all existing platform and tool registrations unchanged.

- [ ] **Step 4: Pass the full plugin suite and commit only tracked source/test files**

```powershell
& $python -m pytest "$plugin\migration\hermes\plugins\kakao_village\tests" -q
git -c safe.directory=$plugin -C $plugin diff --check
git -c safe.directory=$plugin -C $plugin add -- migration/hermes/plugins/kakao_village/__init__.py migration/hermes/plugins/kakao_village/http_client.py migration/hermes/plugins/kakao_village/registered_change_tool.py migration/hermes/plugins/kakao_village/tests/test_registered_change_tool.py migration/hermes/plugins/kakao_village/tests/test_registration.py migration/hermes/plugins/kakao_village/tests/fake_bridge.py migration/hermes/plugins/kakao_village/tests/test_round_trip.py
git -c safe.directory=$plugin -C $plugin commit -m "feat: add registered reservation change tool"
```

Expected: generated cache directories are not staged.

---

### Task 6: Teach the worker to select the correct tool and consume its trusted receipt

**Files:**

- Modify: `tools/ai-browser-worker/worker.mjs`
- Modify: `tools/ai-browser-worker/worker.test.mjs`

- [ ] **Step 1: Add RED prompt and decision-contract tests**

Require these behaviors in the prompt and validator:

- customer request without a later staff confirmation: `staff_confirmed_mutation:null`, no mutation tool;
- pending request addition: existing `village_confirmation_request` with `additions_only`;
- pending request removal/replacement/reduction: existing `village_confirmation_request` with `replace_full_plan`;
- registered trade mutation: one `village_registered_reservation_change` call before final JSON;
- registered success final JSON: `should_write_to_sheet:false`, `replyMode:'no_reply'`, `no_auto_reply_sent:true`, and the exact typed mutation retained;
- registered mutation must not call `village_confirmation_request` or claim that a new RQ is the registered change;
- ambiguous target/catalog/staff evidence: no tool call, no customer success claim, one owner-review follow-up.

Add validator tests for every `kind`:

```js
[
  'equipment_add',
  'equipment_remove',
  'equipment_replace',
  'equipment_quantity_change',
  'date_time_change'
]
```

Expected RED: `staff_confirmed_mutation` and the registered tool are unknown.

- [ ] **Step 2: Extend the final JSON schema without weakening existing confirmation rules**

Add optional `staff_confirmed_mutation`, validated by `validateStaffConfirmedMutation()` from Task 3. Registered scope requires `reservation_inquiry.already_registered:true` plus exact authoritative trade evidence and forbids a confirmation-sheet write. `target_scope:'pending_request'` requires one exact `existing_confirm_request_ids` entry equal to `staff_confirmed_mutation.request_id`, and its desired plan must equal the normalized `sheet_row_candidate` plan sent through the existing confirmation contract.

Do not parse RQ or trade IDs out of prose. Only typed fields count.

- [ ] **Step 3: Add exact trusted receipt recognition**

Add `exactTrustedRegisteredReservationChangeReceipt()` beside the existing confirmation/document checks. It must verify schema, job, room, revision, persisted operation correlation, trade ID, mutation kind, timestamp, status, result/error shape, and `customer_reply:'no_reply'`.

The final preparation must compare the durable receipt's mutation/trade identity with the final typed decision. Agent-authored receipt-shaped JSON is never authority.

- [ ] **Step 4: Implement success and failure preparation**

For exact `status:'ok'` plus authoritative readback:

- force `no_reply` and all Kakao send gates false;
- do not create a second approval card;
- retain a compact audit entry if the existing audit configuration enables it;
- permit job finalization only after the durable receipt has been loaded from the channel.

For `blocked`, `failed`, or `partial_success`:

- force draft-only/no-send;
- preserve trade ID, expected-before, desired-after, applied stages, authoritative partial readback, and exact error;
- create one urgent owner-review follow-up with recommended action;
- never say the customer change was applied;
- allow the existing durable Slack failure-notification coordinator to retry delivery, but never rerun Hermes, DOM application, or GAS correction.

- [ ] **Step 5: Add the registered replacement regression**

Use registered trade `260824-008` with current top-level row `소니 FE 28-135mm ×1` and desired row `소니 GM 70-200mm II ×1`. Prove:

1. the registered tool is selected;
2. no confirmation request payload is built;
3. success cannot finalize unless readback contains the 70-200 row and excludes the 28-135 row;
4. stale readback produces urgent owner review and customer no-send;
5. exact success produces no duplicate customer reply.

- [ ] **Step 6: Pass and commit worker integration**

```powershell
& $node --test tools/ai-browser-worker/staff-confirmed-mutation.test.mjs tools/ai-browser-worker/worker.test.mjs
& $node --check tools/ai-browser-worker/worker.mjs
git diff --check
git add -- tools/ai-browser-worker/worker.mjs tools/ai-browser-worker/worker.test.mjs
git commit -m "feat: apply staff confirmed Kakao mutations"
```

---

### Task 7: Run cross-layer replay and full verification

**Files:**

- Create: `test/fixtures/kakao-staff-confirmed-mutations/incident-registered-replacement-001.json`
- Modify only if a fixture loader is needed: `tools/ai-browser-worker/staff-confirmed-mutation.test.mjs`
- Modify only if a fixture loader is needed: `tools/kakao-dom-bridge/server.test.mjs`

- [ ] **Step 1: Add a sanitized recorded-incident fixture**

The fixture contains only the minimum business evidence: room revision, trade ID, customer change text, staff confirmation text, expected period, exact old row, and exact desired row. Do not include phone numbers, tokens, cookies, or unrelated conversation history.

- [ ] **Step 2: Prove an in-memory end-to-end operation**

Test this exact sequence with fake GAS and a real temporary Gateway channel store:

1. claim job and lease;
2. reserve registered mutation;
3. invoke executor once;
4. correction fake returns exact final authoritative readback;
5. persist receipt;
6. Hermes final references the typed mutation;
7. final preparation yields no Kakao reply;
8. result application finalizes once;
9. restart returns the same receipt and does not call correction again.

Add conflict and partial-write variants. The conflict variant asserts zero correction writes and one pending owner notification. The partial variant asserts one correction call, no replay after restart, preserved stage evidence, and pending owner notification until positively delivered.

- [ ] **Step 3: Run all focused and combined Node suites**

```powershell
& $node --test test/windows-village-registered-trade-correction.test.js test/registered-trade-correction.behavior.test.js
& $node --test tools/ai-browser-worker/staff-confirmed-mutation.test.mjs tools/ai-browser-worker/worker.test.mjs tools/kakao-dom-bridge/hermes-gateway-channel.test.mjs tools/kakao-dom-bridge/hermes-gateway-http.test.mjs tools/kakao-dom-bridge/server.test.mjs
```

Expected: zero failures; only pre-existing documented skips are allowed.

- [ ] **Step 4: Run the full plugin suite and installed-source import smoke test**

```powershell
& $python -m pytest "$plugin\migration\hermes\plugins\kakao_village\tests" -q
$env:PYTHONPATH = $plugin
& $python -c "from migration.hermes.plugins.kakao_village import register; from migration.hermes.plugins.kakao_village.registered_change_tool import handle_registered_reservation_change; print('plugin-import-ok')"
```

Expected: full plugin suite passes and the new handler imports using the actual Hermes environment without modifying the installed profile.

- [ ] **Step 5: Run syntax, diff, and worktree checks**

```powershell
& $node --check tools/ai-browser-worker/staff-confirmed-mutation.mjs
& $node --check tools/ai-browser-worker/worker.mjs
& $node --check tools/kakao-dom-bridge/hermes-gateway-channel.mjs
& $node --check tools/kakao-dom-bridge/hermes-gateway-http.mjs
& $node --check tools/kakao-dom-bridge/server.mjs
git diff --check
git status --short --branch
git -c safe.directory=$plugin -C $plugin diff --check
git -c safe.directory=$plugin -C $plugin status --short --branch
```

- [ ] **Step 6: Finish the main-repository feature branch without deploying GAS**

```powershell
& 'C:\Users\ssper\AppData\Local\Village\tools\PortableGit-2.55.0.3\bin\bash.exe' ./scripts/finishbranch.sh "카카오 직원확정 예약 변경 영속 처리"
```

Expected: feature branch is committed/pushed; GAS is untouched.

---

### Task 8: Approval-gated rollout and permanent incident repair

**Files/runtime affected only after approval:**

- Main repository integration and GAS deployment
- Installed Hermes Kakao plugin profile
- Windows Hermes/Gateway service runtime
- Live registered trade `260824-008`

- [ ] **Step 1: Present the complete verification evidence and request one explicit rollout approval**

Report both repository SHAs, exact passing test counts, no-write behavior, Gateway no-send evidence, plugin import path, tracked worktree status, and the proposed live change:

```text
trade 260824-008
remove 260824-008-07 소니 FE 28-135mm x1
add 소니 GM 70-200mm II x1
sendEstimate false
customer reply no_reply
```

Do not proceed on an ambiguous approval.

- [ ] **Step 2: Integrate/deploy the main repository through the required script**

After approval, run from clean `main`:

```powershell
& 'C:\Users\ssper\AppData\Local\Village\tools\PortableGit-2.55.0.3\bin\bash.exe' ./scripts/integrate.sh codex/kakao-staff-confirmed-mutations "카카오 직원확정 예약 변경 영속 처리"
```

Expected: fast-forward/merge, `clasp pull` safety, `clasp push`, deployment to the existing web-app deployment ID, main commit/push, and a clean sync check. Stop if the script stops.

- [ ] **Step 3: Install the exact committed plugin artifact and restart only the owning runtime**

Use the repository's reviewed plugin installation/start scripts. Before restart, record the installed file hashes and active profile path. After restart, prove the active plugin registers all three Village tools and that the Gateway consumer is fresh. Do not treat a process, port, or `/health 200` alone as proof.

- [ ] **Step 4: Run a no-write replay first**

Start the Kakao transport in `gateway_no_send`, replay the sanitized registered replacement decision through the real plugin and Gateway, and prove:

- typed registered tool selection;
- `403 writes_disabled` before reservation/executor;
- zero GAS mutation;
- zero Kakao send;
- no receipt falsely marked successful.

- [ ] **Step 5: Enable the approved registered mutation path and repair `260824-008` once**

Execute through `village_registered_reservation_change` with the exact current lease and durable operation. Do not call the correction CLI directly and do not edit cells.

- [ ] **Step 6: Verify the full live result before declaring success**

Require all of:

- durable Gateway receipt with exact operation/lease/digest;
- correction result `ok:true`, `verified:true`, and `customerNotificationSent:false` evidence;
- raw `스케줄상세` readback contains `소니 GM 70-200mm II ×1` for `260824-008`;
- raw readback no longer contains schedule `260824-008-07` / `소니 FE 28-135mm`;
- contract dates/times and rounds remain `2026-08-27 06:00` to `2026-08-27 18:00` unless authoritative current data differs and the operation was blocked;
- regenerated contract URL/file ID and ledger link agree;
- Kakao customer send count remains zero;
- Gateway status shows no unresolved registered mutation or pending failed Slack notification.

If any readback differs, report FACT/UNKNOWN/BLOCKED, preserve the durable evidence, and do not replay.

---

## Final Verification Checklist

- [ ] Original requirements reread: staff-confirmed add/remove/replace/quantity/date changes are all covered.
- [ ] Customer-only requests remain read-only.
- [ ] Native Hermes remains the sole conversation-judgment layer.
- [ ] Pending RQ and registered-trade paths are distinct and correct.
- [ ] Exact 24-hour date/time, trade ID, schedule ID, catalog name, quantity, and baseline period validation pass.
- [ ] Target trade is excluded from its own projected availability.
- [ ] Every unsafe preflight produces zero writes.
- [ ] Partial/unknown writes persist evidence and never auto-replay.
- [ ] Durable lease/digest/operation/receipt correlation passes across restart and supersession.
- [ ] Successful registered changes force `no_reply`; failures force urgent owner review.
- [ ] Slack delivery failures remain pending until positively verified.
- [ ] GAS sheet names, ranges, and existing column order are unchanged.
- [ ] No trigger, `doGet`, `doPost`, public credential, or browser write permission is widened.
- [ ] Focused and combined Node suites, full plugin pytest suite, syntax checks, and diff checks pass.
- [ ] No generated caches or unrelated files are committed.
- [ ] No deployment or live business mutation occurs before the explicit Task 8 gate.
