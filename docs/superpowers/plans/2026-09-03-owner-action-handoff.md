# Owner-action handoff implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the live Kakao workflow from raw-message/error notification into a silent Hermes-first employee that hands off only concrete owner actions.

**Architecture:** The Kakao event store and queue remain the silent ingress audit. Hermes remains the sole semantic classifier and consolidates the conversation before deterministic code persists one stable human-work row. Technical delivery/worker failures remain operational evidence; the digest admits only explicit semantic owner handoffs and renders the employee summary plus one recommended action.

**Tech Stack:** Node.js ES modules and `node:test`; PowerShell runtime contracts; PGlite/Supabase-backed Work Orchestrator storage; Slack Block Kit; Windows Kakao bridge.

**Spec:** `docs/superpowers/specs/2026-09-03-owner-action-handoff-design.md`

## Global constraints

- Preserve Hermes as the semantic decision-maker; do not add keyword business routing.
- Accepted Kakao events must not post Slack or create a Slack-delivery receipt before classification.
- Only an explicit `requires_human_action=true` semantic result can create owner work.
- `automation_error_review` and `reservation_review_timeout` are operational evidence and must never enter an owner digest.
- Preserve historical notification receipts and work rows; do not bulk update or delete live data.
- Preserve the existing post-classification P0 path for an explicit unresolved Hermes P0.
- Do not send customer messages or Slack messages during testing.

---

### Task 1: Make the v2 runtime contract silent at ingress

**Files:**
- Modify: `tools/work-orchestrator-v2/contracts.mjs`
- Modify: `tools/work-orchestrator-v2/contracts.test.mjs`
- Modify: `tools/ai-browser-worker/worker.test.mjs`
- Modify: `tools/kakao-dom-bridge/server.test.mjs`
- Modify: `scripts/windows/KakaoLive.Common.psm1`
- Modify: `test/windows-kakao-live-recovery-action.test.mjs`
- Modify: `test/windows-kakao-live-nosend-task.test.mjs`

**Interfaces:**
- Consumes: `validateWorkOrchestratorV2CutoverConfig(env)` and `Get-KakaoLiveRuntimeContract -RuntimeMode v2`.
- Produces: exact v2 contract with legacy cards/work/P0/actions OFF, notification shadow/immediate OFF, semantic work/digest/cleanup/P0 readback/cutover ON.

- [ ] **Step 1: Write failing contract tests**

Use literal v2 expectations:

```js
assert.deepEqual(validateWorkOrchestratorV2CutoverConfig(V2_ENV).workOrchestrator, {
  runtimeMode: 'v2',
  shadowWrites: false,
  immediateEnabled: false,
  workItemsEnabled: true,
  digestEnabled: true,
  cleanupEnabled: true
});
```

PowerShell readback must expect:

```js
assert.equal(contract.WORK_ORCHESTRATOR_V2_SHADOW_WRITES, '0');
assert.equal(contract.WORK_ORCHESTRATOR_V2_IMMEDIATE_ENABLED, '0');
assert.equal(contract.WORK_ORCHESTRATOR_V2_CLEANUP_ENABLED, '1');
```

- [ ] **Step 2: Run RED**

Run:

```powershell
node --test tools/work-orchestrator-v2/contracts.test.mjs tools/ai-browser-worker/worker.test.mjs tools/kakao-dom-bridge/server.test.mjs test/windows-kakao-live-recovery-action.test.mjs test/windows-kakao-live-nosend-task.test.mjs
```

Expected: exact-v2 tests fail because current v2 requires shadow/immediate ON and cleanup depends on immediate.

- [ ] **Step 3: Implement the exact silent contract**

Change both JS and PowerShell validators so v2 means:

```text
legacy cards/work/P0/action poll = false
shadow writes/immediate raw notification = false
work items/digest/cleanup/P0 readback/P0 cutover = true
```

Remove the obsolete `cleanup requires immediate notifications` condition. Keep strict boolean parsing, exact key inventories, legacy rollback, and unknown-mode rejection.

- [ ] **Step 4: Run GREEN and commit**

Run the Step 2 command and the existing PowerShell syntax/parser checks. Commit only after all pass:

```powershell
git add tools/work-orchestrator-v2/contracts.mjs tools/work-orchestrator-v2/contracts.test.mjs tools/ai-browser-worker/worker.test.mjs tools/kakao-dom-bridge/server.test.mjs scripts/windows/KakaoLive.Common.psm1 test/windows-kakao-live-recovery-action.test.mjs test/windows-kakao-live-nosend-task.test.mjs
git commit -m "fix: make Kakao intake silent"
```

---

### Task 2: Remove the pre-classification Slack side effect

**Files:**
- Modify: `tools/kakao-dom-bridge/server.mjs`
- Modify: `tools/kakao-dom-bridge/server.test.mjs`

**Interfaces:**
- Consumes: accepted Kakao event, durable `writeEvent(event, 'event')`, `scheduleEvent(event)`, silent v2 config from Task 1.
- Produces: accepted response and queued AI job with zero calls to shadow receipt creation and immediate Slack delivery.

- [ ] **Step 1: Write a failing real-handler test**

Inject counters for event persistence, scheduling, shadow receipt creation, and Slack post. Send two events from the same room and assert:

```js
assert.equal(persistedEvents, 2);
assert.equal(scheduledRooms.size, 1);
assert.equal(shadowReceiptCalls, 0);
assert.equal(slackPosts, 0);
```

The test must exercise the actual accepted-event request handler, not only a mock helper.

- [ ] **Step 2: Run RED**

Run the named test from `tools/kakao-dom-bridge/server.test.mjs`. Expected: receipt and/or immediate delivery is called by the current handler.

- [ ] **Step 3: Implement minimal silent ingress**

Keep the accepted-room revision fence, event persistence, and scheduling. Ensure the v2 configuration never instantiates an immediate attempt guard and never invokes `deliverAccepted`. Keep historical notice-cleanup runtime independent of `immediateEnabled` so old exact Slack coordinates still converge.

- [ ] **Step 4: Run GREEN and commit**

Run the named test plus all bridge tests. Commit:

```powershell
git add tools/kakao-dom-bridge/server.mjs tools/kakao-dom-bridge/server.test.mjs
git commit -m "fix: remove raw Kakao Slack notifications"
```

---

### Task 3: Keep technical failures out of human work

**Files:**
- Modify: `tools/kakao-dom-bridge/server.mjs`
- Modify: `tools/kakao-dom-bridge/server.test.mjs`
- Modify: `tools/work-orchestrator-v2/work-items.mjs`
- Modify: `tools/work-orchestrator-v2/work-items.test.mjs`
- Modify: `tools/ai-browser-worker/worker.test.mjs`

**Interfaces:**
- Consumes: Hermes `follow_up_items`, worker failure/recovery evidence, `buildHumanWorkCandidates(input)`.
- Produces: owner work only from explicit semantic rows; technical bridge failures return a finite `operational_only` result and create no v2 work.

- [ ] **Step 1: Write failing tests**

Add literal behavior tests:

```js
assert.deepEqual(buildHumanWorkCandidates({ followUpRows: [rowWithoutExplicitHumanAction] }), []);
assert.equal(workStore.upsertCalls, 0);
assert.equal(result.workOrchestratorV2.reason, 'operational_only');
```

Exercise immediate worker failure, completed-skip failure, and recovery-exhausted failure. All must retain job/error audit behavior while creating zero `automation_error_review` or `reservation_review_timeout` work rows. Preserve an explicit semantic Hermes `reply_needed` item as a positive case.

- [ ] **Step 2: Run RED**

Run named tests in the three files. Expected: missing explicit human action is admitted and bridge failure helpers upsert technical work.

- [ ] **Step 3: Implement minimal isolation**

Make `humanActionRequirement` admit only an explicit true value. Remove v2 human-work upserts from `routeWorkerFailureFollowUp`; keep bounded operational logging/state and the legacy branch for legacy mode. Do not change Hermes prompt classification or semantic follow-up construction.

- [ ] **Step 4: Run GREEN and commit**

Run focused then full worker/bridge/Work Orchestrator tests. Commit:

```powershell
git add tools/kakao-dom-bridge/server.mjs tools/kakao-dom-bridge/server.test.mjs tools/work-orchestrator-v2/work-items.mjs tools/work-orchestrator-v2/work-items.test.mjs tools/ai-browser-worker/worker.test.mjs
git commit -m "fix: isolate automation failures from owner work"
```

---

### Task 4: Select and render only meaningful owner handoffs

**Files:**
- Modify: `tools/work-orchestrator-v2/digests.mjs`
- Modify: `tools/work-orchestrator-v2/digests.test.mjs`
- Modify: `tools/work-orchestrator-v2/digest-runner.test.mjs`

**Interfaces:**
- Consumes: actionable work rows containing `work_type` and payload `{requires_human_action, recommended_action}`.
- Produces: selected digest entries containing semantic title, employee summary, and `recommendedAction`; technical/historical rows select to zero.

- [ ] **Step 1: Write failing selector tests**

Use a literal mixed fixture with semantic, automatic, and technical rows:

```js
assert.deepEqual(selectDigestItems(rows, NOW).map(({ id }) => id), [SEMANTIC_ID]);
```

Cover `automation_error_review`, `reservation_review_timeout`, missing/false `requires_human_action`, automatic success, and one valid `reply_needed` item.

- [ ] **Step 2: Write a failing renderer test**

Assert the valid work block contains these owner-facing labels and values:

```js
assert.match(text, /직원이 정리한 내용/);
assert.match(text, /대표님이 할 일/);
assert.match(text, /재고 확인 완료/);
assert.match(text, /대체 렌즈 승인/);
assert.doesNotMatch(text, /worker|automation_error|stack|jobId/i);
```

- [ ] **Step 3: Run RED**

Run `node --test tools/work-orchestrator-v2/digests.test.mjs tools/work-orchestrator-v2/digest-runner.test.mjs`. Expected: technical rows are selected and recommended action is absent from rendered blocks.

- [ ] **Step 4: Implement semantic selection/rendering**

Validate `work_type` and explicit payload intent before selection. Skip technical types and non-human rows without rejecting valid siblings. Add `recommendedAction` to the selected entry but keep `buildDigestSnapshot` content-free as `{id,version,inclusionReason,priority}`. Render:

```text
직원이 정리한 내용: <summary>
대표님이 할 일: <recommended action>
```

Keep existing actions, chunk limits, escaping, P0 acknowledgement semantics, immutable manifests, and multipart delivery.

- [ ] **Step 5: Run GREEN and commit**

Run focused and full Work Orchestrator tests. Commit:

```powershell
git add tools/work-orchestrator-v2/digests.mjs tools/work-orchestrator-v2/digests.test.mjs tools/work-orchestrator-v2/digest-runner.test.mjs
git commit -m "fix: render only owner-action handoffs"
```

---

### Task 5: Verify the complete employee-first path

**Files:**
- Modify: `tools/work-orchestrator-v2/bridge-shadow-pglite.test.mjs`
- Modify: `tools/kakao-dom-bridge/server.test.mjs`
- Modify: `tools/ai-browser-worker/worker.test.mjs`

**Interfaces:**
- Consumes: silent ingress, Hermes semantic output, v2 upsert, digest renderer, P0 runtime.
- Produces: executable proof of silent automatic handling and post-classification owner handoff.

- [ ] **Step 1: Add an end-to-end no-send regression**

Run the real bridge/work/store boundaries with fakes only for external Kakao/Slack transport. Prove:

```js
assert.equal(rawSlackPosts, 0);
assert.equal(semanticWorkRows.length, 1);
assert.equal(semanticWorkRows[0].work_key, 'conversation:room-1:customer-1');
assert.equal(digestItemIds.length, 1);
```

Then supply an automatic-success decision and prove zero work/digest items. Supply explicit P0 semantic work and prove one post-classification P0 call.

- [ ] **Step 2: Run RED, implement only missing wiring, then GREEN**

Run the named end-to-end tests before any wiring change. If they fail because of test setup rather than behavior, correct the fixture and recapture a behavior RED before production edits.

- [ ] **Step 3: Run all verification gates**

```powershell
npm --prefix tools/work-orchestrator-v2 test
npm --prefix tools/work-orchestrator-v2 run check
npm --prefix tools/ai-browser-worker test
npm --prefix tools/kakao-dom-bridge test
npm --prefix tools/kakao-dom-bridge run check
node --test test/windows-kakao-live-recovery-action.test.mjs test/windows-kakao-live-nosend-task.test.mjs
git diff --check
```

Expected: all suites pass, no Slack/Kakao/network side effects.

- [ ] **Step 4: Self-review and branch finish**

Re-read the user request and spec. Confirm no raw-message sender remains reachable in v2, no technical work producer reaches `upsertWorkItem`, semantic P0 still works, and historical cleanup remains ready. Use `./scripts/finishbranch.sh "fix: hand off only owner actions"` after the tracked diff is clean and scoped.

---

### Task 6: Integrate and cut over with bounded readback

**Files:**
- Runtime/config only after the feature branch passes all gates.

**Interfaces:**
- Consumes: reviewed feature branch and exact v2 silent runtime contract.
- Produces: main integration, Windows runtime restart, and content-free live proof that new raw notification receipts/posts stay flat while semantic processing remains live.

- [ ] **Step 1: Integrate from clean main**

Run the repository integration script for `codex/owner-action-digest`. Do not touch unrelated untracked runtime files.

- [ ] **Step 2: Update and restart the Windows production runtime**

Use the reviewed production-runtime recovery path. Do not send a test customer or Slack message.

- [ ] **Step 3: Verify natural runtime readback**

Confirm `/health` reports gateway/worker ready, runtime mode v2, `shadowWrites=false`, `immediateEnabled=false`, work/digest/cleanup/P0 ready, and no new notification-delivery count. Observe a natural accepted event only if one arrives; do not synthesize customer traffic.

- [ ] **Step 4: Report FACT/UNKNOWN**

Report code/tests/runtime readiness as FACT. If no natural post-cutover Kakao event arrives, report end-to-end silent-ingress behavior as test-proven but live-event UNKNOWN rather than sending a synthetic message.
