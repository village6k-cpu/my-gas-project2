# Village Registered Trade Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Hermes one explicit, bounded, verified execution path for registered-trade date/item correction and optional quote send without replacing AI judgment.

**Architecture:** A focused Windows Node runner accepts only an exact JSON envelope chosen by the AI and calls existing purpose-built GAS actions. It performs preflight and final authoritative reads but contains no natural-language parser, router, business inference, generic sheet write, or replacement orchestration layer.

**Tech Stack:** Node.js CommonJS, built-in `fetch`, Node test runner, Google Apps Script endpoints.

## Global Constraints

- Preserve stock Hermes behavior and the compact native skill entrypoint.
- Do not revive `village_operation` or add a natural-language broker.
- Do not widen the generic GAS sheet-write allowlist.
- Never retry an ambiguous write automatically.
- `sendEstimate` runs only when the explicit JSON field is `true`.
- Normal send proof is API success plus authoritative schedule/contract readback; Popbill is exception-only.
- Do not send to a customer, deploy GAS, commit, or push during this implementation without separate authorization.
- Preserve all unrelated dirty-worktree changes.

---

### Task 1: Explicit runner contract and preflight

**Files:**
- Create: `scripts/windows/village-registered-trade-correction.js`
- Create: `test/windows-village-registered-trade-correction.test.js`

**Interfaces:**
- Consumes: `{ config, input, fetchImpl, timeoutMs }`.
- Produces: `normalizeCorrectionInput(input)`, `runRegisteredTradeCorrection(options)` and a CLI accepting `execute --input-file PATH --env-file PATH`.

- [ ] **Step 1: Write the failing tests**

```js
assert.throws(() => normalizeCorrectionInput({ tradeId: '260810-003', sendEstimate: true }), /operationId/);
assert.throws(() => normalizeCorrectionInput({ tradeId: '260810-003', operationId, sheet: '계약마스터' }), /unsupported/i);
```

Add a fetch fixture where the first two calls are parallel read-only searches for `스케줄상세` and `계약마스터`, and assert that a mismatched `scheduleId`/`expectedName` causes zero POST calls.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/windows-village-registered-trade-correction.test.js`

Expected: FAIL because the runner module does not exist.

- [ ] **Step 3: Write minimal implementation**

Implement strict allowlisted JSON validation, exact trade ID and UUID-like operation ID validation, bounded dates/quantities, HTTPS `script.google.com` endpoint validation, parallel baseline reads, exact row filtering, and fail-closed removal preflight.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/windows-village-registered-trade-correction.test.js`

Expected: preflight tests PASS.

- [ ] **Step 5: Prepare an isolated commit only after authorization**

```powershell
git add -- scripts/windows/village-registered-trade-correction.js test/windows-village-registered-trade-correction.test.js
git commit -m "feat: add bounded registered trade correction runner"
```

Do not execute this step without explicit user authorization.

### Task 2: Sequential mutation, one regeneration, optional send

**Files:**
- Modify: `scripts/windows/village-registered-trade-correction.js`
- Modify: `test/windows-village-registered-trade-correction.test.js`

**Interfaces:**
- Consumes: normalized `dateChange`, `remove`, `add`, `sendEstimate` fields.
- Produces: ordered `stages`, `send.accepted`, and final `readback` with no credentials.

- [ ] **Step 1: Write the failing tests**

```js
assert.deepEqual(actions, [
  'scheduleChangeDates',
  'scheduleRemoveEquip',
  'scheduleAddEquips',
  'regenerateContract',
  'sendEstimate'
]);
assert.equal(posts.filter((call) => call.action === 'sendEstimate').length, 1);
```

Also assert that `sendEstimate:false` never posts a customer action and an ambiguous response is not retried.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/windows-village-registered-trade-correction.test.js`

Expected: FAIL because mutation execution is not implemented.

- [ ] **Step 3: Write minimal implementation**

Call the existing actions in order. Derive per-stage mutation IDs from `operationId`, set `directRegenerate:false` on item mutations, then call `regenerateContract` once. Accept only `success:true` or `status:"OK"`; otherwise throw a structured stage error without retry.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/windows-village-registered-trade-correction.test.js`

Expected: sequencing, no-send, and no-retry tests PASS.

- [ ] **Step 5: Prepare an isolated commit only after authorization**

Use the Task 1 file list and do not execute without explicit user authorization.

### Task 3: Final authoritative verification and skill routing

**Files:**
- Modify: `scripts/windows/village-registered-trade-correction.js`
- Modify: `test/windows-village-registered-trade-correction.test.js`
- Modify: `scripts/windows/hermes-profile-overlay/skills/productivity/village-operations/SKILL.md`
- Modify: `test/windows-hermes-village-native-skill.static.test.js`

**Interfaces:**
- Consumes: final raw `스케줄상세` and `계약마스터` search results.
- Produces: `verified:true` only when requested dates/rounds and item deltas match.

- [ ] **Step 1: Write the failing tests**

```js
assert.equal(result.verified, true);
await assert.rejects(() => runWithStaleFinalRows(), /final readback/i);
assert.match(skill, /village-registered-trade-correction\.js/);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/windows-village-registered-trade-correction.test.js test/windows-hermes-village-native-skill.static.test.js`

Expected: FAIL until final verification and the compact skill pointer exist.

- [ ] **Step 3: Write minimal implementation**

Verify exact trade filtering, removed schedule IDs absent, added top-level name quantities present, date tuple consistency, and contract rental rounds. Add one concise registered-correction command pointer to the skill; do not add business rules or prose duplication.

- [ ] **Step 4: Run focused and broader tests**

Run:

```powershell
node --test test/windows-village-registered-trade-correction.test.js test/windows-village-trade-date-change.test.js test/registered-trade-date-change.static.test.js test/windows-hermes-village-native-skill.static.test.js
```

Expected: all tests PASS.

- [ ] **Step 5: Run static safety checks**

Run `git diff --check` for the scoped files and confirm the new runner contains no generic `write`, natural-language parsing, Popbill normal-path audit, or credentials in output.

- [ ] **Step 6: Prepare an isolated commit only after authorization**

Do not commit, push, copy into the live Hermes profile, or deploy GAS without explicit authorization.

## Self-review

- Spec coverage: strict AI/tool boundary, one send, no retry, final readback, exception-only Popbill, and no generic writes are each covered by Tasks 1-3.
- Placeholder scan: no deferred implementation placeholders are present.
- Type consistency: all tasks use `normalizeCorrectionInput(input)` and `runRegisteredTradeCorrection({ config, input, fetchImpl, timeoutMs })`.
