# Work Orchestrator v2 Automation, Cleanup, and Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close work only from authoritative automation evidence, update and safely clean Slack notices, move P0 to v2 acknowledgement semantics, expose end-to-end health, and cut over from legacy cards without losing immediate notifications.

**Architecture:** Typed worker results determine whether v2 work remains human-required. The bridge performs exact-coordinate cleanup in a separate retry lifecycle, preserves P0 until acknowledgement, and reports full-path metrics. Cutover disables only legacy durable-card producers after immediate notifications and digests have independent runtime proof.

**Tech Stack:** Node.js 24 ESM, built-in `node:test`, Slack Web API, Supabase PostgREST/RPC, existing Hermes gateway/worker, Windows scheduled runtime scripts.

**Spec:** `docs/superpowers/specs/2026-08-29-work-orchestrator-v2-design.md`

## Global Constraints

- A successful command is not completion; authoritative target-state readback is required.
- Existing write/send/approval authority is unchanged.
- Cleanup is independent of delivery and work status; failure to delete Slack never reopens or closes work.
- Delete only exact configured-bot coordinates. Never delete human messages, other apps, or a thread root unless it is itself the verified bot target.
- Ordinary notices delete only after a delivered digest includes the related work/outcome.
- Auto-processed notices update with verified result and delete only after TTL.
- P0 notices do not delete before acknowledgement.
- Disable legacy card production only after v2 immediate notice and digest paths both pass production readback.
- Keep `ai_follow_up_items` read-only for audit after cutover; never restart `slack-followup-backstop` and never import dismissed rows automatically.
- Production restart/deploy uses repository lifecycle scripts and owned scheduled tasks; no ad-hoc process killing.

## File map

- Create `tools/work-orchestrator-v2/automation-resolution.mjs` and `.test.mjs`: evidence classifier and resolution contract.
- Create `tools/work-orchestrator-v2/notice-cleanup.mjs` and `.test.mjs`: eligibility, exact authorship guard, TTL, and retry sweep.
- Create `tools/work-orchestrator-v2/observability.mjs` and `.test.mjs`: cross-table invariant metrics.
- Modify `tools/work-orchestrator-v2/supabase-store.mjs` and tests: resolution and cleanup CAS operations.
- Modify `tools/ai-browser-worker/worker.mjs` and tests: automation evidence integration and immediate-notice update request.
- Modify `tools/kakao-dom-bridge/server.mjs` and tests: action resolution, P0 v2 sweep, cleanup sweep, health, maintenance routes.
- Modify `tools/kakao-dom-bridge/.env.example`: TTL, cleanup interval, and legacy cutover flags.
- Modify `scripts/windows/KakaoLive.Common.psm1` and its tests if it stamps legacy card flags.
- Modify `docs/kakao-automation-followup-dashboard-ops.md`: phased cutover, rollback, and readback commands.
- Modify `apps/follow-up-dashboard/README.md`: v2 source of truth and legacy read-only status.

---

### Task 1: Derive authoritative automation resolution

**Files:**
- Create: `tools/work-orchestrator-v2/automation-resolution.mjs`
- Create: `tools/work-orchestrator-v2/automation-resolution.test.mjs`

**Interfaces:**
- Consumes: `{decision,sheetResult,postActionResult,autoReplyResult,operationReceipt}`.
- Produces: `deriveAutomationResolution(input) -> {state:'succeeded'|'failed'|'needs_human',resolutionKind,evidence,noticeText}`.

- [ ] **Step 1: Write RED evidence matrix tests**

Required outcomes:

```js
assert.equal(deriveAutomationResolution({ autoReplyResult: { sent: true, readbackConfirmed: true, transportMessageId: 'kakao-1' } }).state, 'succeeded');
assert.equal(deriveAutomationResolution({ autoReplyResult: { sent: true, readbackConfirmed: false } }).state, 'needs_human');
assert.equal(deriveAutomationResolution({ sheetResult: { success: true }, operationReceipt: null }).state, 'needs_human');
assert.equal(deriveAutomationResolution({ sheetResult: { success: true }, operationReceipt: { state: 'completed', authoritativeReadback: true } }).state, 'succeeded');
assert.equal(deriveAutomationResolution({ decision: { requires_owner_approval: true } }).state, 'needs_human');
```

Evidence must contain typed ids/timestamps/status only, no raw secrets or customer message body.

- [ ] **Step 2: Run RED**

```powershell
node --test tools\work-orchestrator-v2\automation-resolution.test.mjs
```

- [ ] **Step 3: Implement a fail-closed classifier**

Reject missing, contradictory, or stale evidence into `needs_human`. Never infer readback from `success:true` alone. Keep owner-approval decisions human-required even when a bounded preliminary operation succeeded.

- [ ] **Step 4: Run GREEN and commit**

```powershell
node --test tools\work-orchestrator-v2\automation-resolution.test.mjs
git add -- tools/work-orchestrator-v2/automation-resolution.mjs tools/work-orchestrator-v2/automation-resolution.test.mjs
git commit -m "feat: require authoritative automation resolution"
```

---

### Task 2: Apply verified results to work and immediate notices

**Files:**
- Modify: `tools/work-orchestrator-v2/supabase-store.mjs`
- Modify: `tools/work-orchestrator-v2/supabase-store.test.mjs`
- Modify: `tools/ai-browser-worker/worker.mjs:10353-10485`
- Modify: `tools/ai-browser-worker/worker.test.mjs`

**Interfaces:**
- Produces store methods `resolveWorkItem({id,expectedVersion,resolution})`, `markAutomationState`, `requestImmediateNoticeUpdate` and worker `automationResolutionResult`.

- [ ] **Step 1: Write RED tests**

Prove verified automation resolves by versioned CAS, unverified automation leaves work open, owner approval cannot auto-resolve, and auto-processed output schedules notice TTL without creating a human item.

- [ ] **Step 2: Run RED**

```powershell
node --test --test-name-pattern "authoritative automation resolution" tools\ai-browser-worker\worker.test.mjs
```

- [ ] **Step 3: Implement minimal integration**

Worker finalization calls `deriveAutomationResolution`, writes typed evidence, and returns an update request referencing `source_event_key`. It does not call Slack directly. The bridge owns `chat.update` and records exact update readback.

- [ ] **Step 4: Run GREEN and commit**

```powershell
node --test --test-name-pattern "authoritative automation resolution" tools\ai-browser-worker\worker.test.mjs
npm --prefix tools\ai-browser-worker test
git add -- tools/work-orchestrator-v2/supabase-store.mjs tools/work-orchestrator-v2/supabase-store.test.mjs tools/ai-browser-worker/worker.mjs tools/ai-browser-worker/worker.test.mjs
git commit -m "feat: resolve verified automated work"
```

---

### Task 3: Implement exact-coordinate notice cleanup

**Files:**
- Create: `tools/work-orchestrator-v2/notice-cleanup.mjs`
- Create: `tools/work-orchestrator-v2/notice-cleanup.test.mjs`
- Modify: `tools/work-orchestrator-v2/slack-client.mjs`
- Modify: `tools/work-orchestrator-v2/slack-client.test.mjs`
- Modify: `tools/work-orchestrator-v2/supabase-store.mjs`
- Modify: `tools/work-orchestrator-v2/supabase-store.test.mjs`

**Interfaces:**
- Consumes: cleanup-eligible receipts, digest snapshots, bot identity, exact Slack coordinates.
- Produces: `runNoticeCleanupSweep({store,slack,config,now})` with per-status counts.

- [ ] **Step 1: Write RED policy tests**

Cover:

- ordinary receipt eligible only when a delivered digest snapshot contains its linked work id/outcome;
- auto-processed receipt eligible only after `cleanup_after`;
- P0 with no acknowledgement returns `blocked_p0`;
- missing coordinates becomes failed audit, not broad search;
- `auth.test` identity mismatch excludes the target;
- `message_not_found` becomes `deleted` with `alreadyAbsent=true`;
- `cant_delete_message` remains failed and never falls back to admin/human deletion.

- [ ] **Step 2: Run RED**

```powershell
node --test tools\work-orchestrator-v2\notice-cleanup.test.mjs
```

- [ ] **Step 3: Implement cleanup claim and sweep**

Add store methods `claimCleanupBatch`, `markCleanupDeleted`, and `markCleanupFailed`. Claim rows by state/age with a bounded batch of 25. Slack client must expose `authTest()` and exact `deleteMessage()` only.

- [ ] **Step 4: Run GREEN and commit**

```powershell
node --test tools\work-orchestrator-v2\notice-cleanup.test.mjs tools\work-orchestrator-v2\slack-client.test.mjs tools\work-orchestrator-v2\supabase-store.test.mjs
git add -- tools/work-orchestrator-v2
git commit -m "feat: clean exact bot notification coordinates"
```

---

### Task 4: Move P0 acknowledgement and reminders onto v2

**Files:**
- Modify: `tools/work-orchestrator-v2/work-items.mjs`
- Modify: `tools/work-orchestrator-v2/work-items.test.mjs`
- Modify: `tools/kakao-dom-bridge/server.mjs:2582-2750`
- Modify: `tools/kakao-dom-bridge/server.test.mjs:1890-1970`

**Interfaces:**
- Consumes: active `work_items_v2` with priority P0 and payload acknowledgement metadata.
- Produces: durable P0 claim/delivery fields in `work_items_v2.payload.p0_delivery`, v2 ack action, and bounded retry readback.

- [ ] **Step 1: Write RED P0 tests**

Prove unacknowledged P0 repeats with existing 10m/exponential/1h cap/3-attempt defaults, acknowledged unresolved P0 stops separate alerts but remains first in digests, resolution stops all alerts, and cleanup remains blocked until ack.

- [ ] **Step 2: Run RED**

```powershell
node --test --test-name-pattern "v2 P0" tools\kakao-dom-bridge\server.test.mjs tools\work-orchestrator-v2\work-items.test.mjs
```

- [ ] **Step 3: Add the v2 P0 fetch/claim path**

Reuse deterministic client ids and compare-and-swap semantics. Keep the legacy P0 sweep enabled until v2 P0 readback has no omissions; ensure a single source event cannot be escalated by both systems after the cutover flag flips.

- [ ] **Step 4: Run GREEN and commit**

```powershell
node --test --test-name-pattern "v2 P0" tools\kakao-dom-bridge\server.test.mjs tools\work-orchestrator-v2\work-items.test.mjs
npm --prefix tools\kakao-dom-bridge test
git add -- tools/work-orchestrator-v2/work-items.mjs tools/work-orchestrator-v2/work-items.test.mjs tools/kakao-dom-bridge/server.mjs tools/kakao-dom-bridge/server.test.mjs
git commit -m "feat: migrate P0 acknowledgement to v2"
```

---

### Task 5: Add cross-path observability and invariant alarms

**Files:**
- Create: `tools/work-orchestrator-v2/observability.mjs`
- Create: `tools/work-orchestrator-v2/observability.test.mjs`
- Modify: `tools/kakao-dom-bridge/server.mjs`
- Modify: `tools/kakao-dom-bridge/server.test.mjs`

**Interfaces:**
- Produces `readWorkOrchestratorHealth({store,now})` and `/health.workOrchestrator` with no PII.

- [ ] **Step 1: Write RED metric tests**

Require counts/oldest age for undelivered receipts, automation states, actionable/snoozed/overdue/P0, digest last success/failure, eligible omitted items, cleanup backlog, stale action conflicts, and scheduler lease freshness.

- [ ] **Step 2: Run RED**

```powershell
node --test tools\work-orchestrator-v2\observability.test.mjs
```

- [ ] **Step 3: Implement bounded aggregate queries and alarms**

Set health `ok=false` for the v2 subsection when an accepted event exceeds the delivery SLA, an eligible work item is omitted from the last delivered digest, or an unacknowledged P0 lacks an alert state. Keep top-level bridge health separate so the failure location is explicit.

- [ ] **Step 4: Run GREEN and commit**

```powershell
node --test tools\work-orchestrator-v2\observability.test.mjs
npm --prefix tools\work-orchestrator-v2 test
npm --prefix tools\kakao-dom-bridge test
git add -- tools/work-orchestrator-v2/observability.mjs tools/work-orchestrator-v2/observability.test.mjs tools/kakao-dom-bridge/server.mjs tools/kakao-dom-bridge/server.test.mjs
git commit -m "feat: expose work orchestrator invariant health"
```

---

### Task 6: Cut over from legacy cards and freeze legacy writes

**Files:**
- Modify: `tools/ai-browser-worker/worker.mjs`
- Modify: `tools/ai-browser-worker/worker.test.mjs`
- Modify: `tools/kakao-dom-bridge/server.mjs`
- Modify: `tools/kakao-dom-bridge/server.test.mjs`
- Modify: `scripts/windows/KakaoLive.Common.psm1`
- Test: the existing corresponding PowerShell lifecycle test discovered with `rg -n "KakaoLive.Common" test scripts`
- Modify: `tools/kakao-dom-bridge/.env.example`
- Modify: `docs/kakao-automation-followup-dashboard-ops.md`
- Modify: `apps/follow-up-dashboard/README.md`

**Interfaces:**
- Consumes: independent v2 proof for immediate delivery, work/digest completeness, P0, and cleanup.
- Produces: one reversible configuration cutover that keeps v2 immediate notifications on while legacy persistent rows/cards/P0 turn off.

- [ ] **Step 1: Write RED cutover guards**

Tests must reject these configurations:

```text
legacy cards off + v2 immediate off
legacy work rows off + v2 work items off
legacy P0 off + v2 P0 off
v2 cleanup on + v2 immediate off
```

The valid production target is:

```dotenv
WORK_ORCHESTRATOR_V2_SHADOW_WRITES=1
WORK_ORCHESTRATOR_V2_IMMEDIATE_ENABLED=1
WORK_ORCHESTRATOR_V2_WORK_ITEMS_ENABLED=1
WORK_ORCHESTRATOR_V2_DIGEST_ENABLED=1
WORK_ORCHESTRATOR_V2_CLEANUP_ENABLED=1
AI_WORKER_FOLLOW_UP_ITEMS_ENABLED=0
KAKAO_FOLLOW_UP_ITEMS_ENABLED=0
SLACK_AGENT_CARD_DELIVERY_ENABLED=0
```

- [ ] **Step 2: Run RED**

```powershell
node --test --test-name-pattern "v2 cutover guard" tools\ai-browser-worker\worker.test.mjs tools\kakao-dom-bridge\server.test.mjs
```

- [ ] **Step 3: Implement fail-closed configuration validation**

Validate at process startup and in `KakaoLive.Common.psm1` before stamping environment. Do not disable `slackBotToken`, watcher, bridge, Hermes, auto-send policy, or bounded Village tools.

- [ ] **Step 4: Run full regression suites**

```powershell
npm --prefix tools\work-orchestrator-v2 test
npm --prefix tools\ai-browser-worker test
npm --prefix tools\kakao-dom-bridge test
npm --prefix apps\follow-up-dashboard run check
npm --prefix apps\today-dashboard test
npm --prefix apps\today-dashboard run build
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 5: Commit code and operations docs**

```powershell
git add -- tools apps/follow-up-dashboard apps/today-dashboard scripts/windows/KakaoLive.Common.psm1 docs/kakao-automation-followup-dashboard-ops.md
git commit -m "feat: cut over follow-up work to orchestrator v2"
```

---

### Task 7: Execute production cutover, verification, and rollback drill

**Files:**
- No new source file; execute the reviewed runbook and save only non-secret verification evidence in the cutover report location defined by `docs/kakao-automation-followup-dashboard-ops.md`.

**Interfaces:**
- Produces: runtime-specific cutover evidence across watcher -> receipt -> Slack -> Hermes -> work -> digest -> action/readback.

- [ ] **Step 1: Re-read migration and security state**

```powershell
npx --yes supabase@2.116.0 migration list --linked
npx --yes supabase@2.116.0 db advisors --linked --level error
```

Expected: migration histories align and no v2 error-level security advisor remains.

- [ ] **Step 2: Capture pre-cutover facts**

Record branch/head, dirty count, live process command lines, active profile path/hash, `/health`, legacy active count, v2 counts, last delivered digest, pending cleanup, and Slack bot identity. Do not record tokens or customer message text.

- [ ] **Step 3: Activate v2 and restart through owned lifecycle**

Apply the valid target environment and restart using the existing production scheduled task/watchdog path. Do not launch a second bridge manually.

- [ ] **Step 4: Verify the full internal test path**

With explicit approval for one internal non-customer test event, prove:

1. accepted event and one notification receipt;
2. one Slack immediate notice and API readback;
3. typed Hermes result;
4. zero work item for verified safe automation or one stable item for a forced human-review fixture;
5. digest inclusion and stable item id;
6. stale action rejection and valid action handling;
7. exact notice cleanup eligibility;
8. legacy `ai_follow_up_items` count does not increase;
9. no legacy per-message card appears.

- [ ] **Step 5: Run the rollback drill without reopening legacy backlog**

Rollback flags:

```dotenv
WORK_ORCHESTRATOR_V2_IMMEDIATE_ENABLED=0
WORK_ORCHESTRATOR_V2_WORK_ITEMS_ENABLED=0
WORK_ORCHESTRATOR_V2_DIGEST_ENABLED=0
WORK_ORCHESTRATOR_V2_CLEANUP_ENABLED=0
AI_WORKER_FOLLOW_UP_ITEMS_ENABLED=1
KAKAO_FOLLOW_UP_ITEMS_ENABLED=1
SLACK_AGENT_CARD_DELIVERY_ENABLED=1
```

Verify the bridge starts and historical dismissed rows remain dismissed. Then restore v2 target flags and repeat health/readback.

- [ ] **Step 6: Finish through repository integration automation**

On the integration `main` session, run the repository-prescribed `scripts/endwork.sh` flow. Verify GAS deploy is skipped when GAS code is unchanged, Vercel build is READY when app files changed, remote `main` contains the commit, and `git status --short` is empty.

---

## Final acceptance gate

Do not claim production completion unless runtime evidence proves:

- every approved internal test event received one immediate notice;
- duplicate and ambiguous-response paths produced no duplicate;
- eligible human work omission count is zero;
- unresolved work survives restart, digest replacement, and snooze expiry;
- automated completion includes authoritative evidence;
- P0 remains until acknowledgement;
- cleanup target authorship is the configured bot and human messages are unchanged;
- legacy row/card counts remain flat after cutover;
- actual sound/mobile push remains separately reported as FACT or UNKNOWN rather than inferred from Slack API delivery.
