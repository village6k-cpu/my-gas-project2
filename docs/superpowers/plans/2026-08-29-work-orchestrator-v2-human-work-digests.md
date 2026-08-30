# Work Orchestrator v2 Human Work and Digests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist only real human-required work and present it in durable three-hour Slack digests with carry-over, overdue, snooze, P0, and stale-action protection.

**Architecture:** The worker maps typed Hermes outcomes into `work_items_v2` while legacy writes continue in dual-write mode. The bridge owns a leased digest scheduler and local Slack action poller; the existing Vercel Slack endpoint records versioned pending actions but never declares authoritative completion itself.

**Tech Stack:** Node.js 24 ESM, built-in `node:test`, Supabase PostgREST/RPC, Slack Block Kit and signed interactions, existing bridge/worker, Vercel Node functions.

**Spec:** `docs/superpowers/specs/2026-08-29-work-orchestrator-v2-design.md`

## Global Constraints

- A digest appearance never resolves work.
- Every eligible unresolved item appears in every delivered digest until resolved, dismissed, or actively snoozed.
- After two consecutive unhandled delivered digests, mention the owner; at 24 hours mark overdue; at 72 hours send at most one separate reminder per day.
- Snooze choices are three hours, today evening, tomorrow, or explicit date/time; expiry preserves original age.
- P0 bypasses ordinary timing and cannot be hidden or deleted before acknowledgement.
- New activity merges only through a typed stable `work_key`; never merge by loose customer-name matching.
- Slack action values include work item id and expected version; stale actions are no-ops.
- Vercel may request an action, but local authoritative runtime performs/validates completion.
- Keep dual writes and legacy cards enabled until digest/runtime acceptance passes.

## File map

- Create `tools/work-orchestrator-v2/work-items.mjs` and `.test.mjs`: pure work lifecycle and typed outcome mapping.
- Create `tools/work-orchestrator-v2/digests.mjs` and `.test.mjs`: eligibility, aging, ordering, rendering, and snapshots.
- Create `tools/work-orchestrator-v2/digest-runner.mjs` and `.test.mjs`: database lease, Slack delivery, counters, replacement.
- Create `tools/work-orchestrator-v2/work-actions.mjs` and `.test.mjs`: versioned action codec and application policy.
- Modify `tools/work-orchestrator-v2/supabase-store.mjs` and tests: work/digest RPCs and queries.
- Modify the foundation migration before production application, or create a CLI-generated additive migration if already applied: work/digest RPCs.
- Modify `tools/ai-browser-worker/worker.mjs` and tests: v2 dual-write integration in `finalizePreparedKakaoDecision`.
- Modify `tools/kakao-dom-bridge/server.mjs` and tests: scheduler and action poller.
- Modify `apps/follow-up-dashboard/api/slack-actions.js` and tests: signed v2 action requests.
- Modify `apps/today-dashboard/app/api/follow-ups/route.ts` and tests: v2 read surface behind a flag.
- Modify `tools/kakao-dom-bridge/.env.example`: work/digest flags, owner ids, intervals.

---

### Task 1: Implement the pure human-work lifecycle

**Files:**
- Create: `tools/work-orchestrator-v2/work-items.mjs`
- Create: `tools/work-orchestrator-v2/work-items.test.mjs`

**Interfaces:**
- Consumes: `{decision,job,followUpRows,autoReplyResult,sheetResult,postActionResult}`.
- Produces: `buildHumanWorkCandidates(input)`, `mergeWorkItem(existing,incoming,now)`, `applyWorkAction(item,action,now)`, `decodeWorkActionValue(value)`.

- [ ] **Step 1: Write RED tests**

Cover:

```js
assert.deepEqual(buildHumanWorkCandidates({ autoReplyResult: { sent: true, readbackConfirmed: true, completed_work_key: 'room:1:reply' }, followUpRows: [{ work_key: 'room:1:reply', type: 'reply_needed' }] }), []);
assert.equal(buildHumanWorkCandidates({ autoReplyResult: { sent: false }, followUpRows: [{ payload: { work_key: 'room:1:reply', requires_human_action: true } }] })[0].work_key, 'room:1:reply');
assert.throws(() => buildHumanWorkCandidates({ followUpRows: [{ customer_name: '동명이인' }] }), /typed work_key/i);
assert.equal(mergeWorkItem(existing, incoming, now).version, existing.version + 1);
assert.throws(() => applyWorkAction(item, { type: 'progress', expectedVersion: item.version - 1 }, now), /stale work version/i);
```

An untyped row may map to the finite `human_review` type only for the reviewed legacy form that has both an explicit `requires_human_action=true` boolean and a stable payload key. A key-only audit row is invalid. Verified auto-reply suppression uses an exact confirmed work/follow-up key; the legacy no-key fallback applies only when the batch contains one distinct `reply_needed` key.

Add snooze expiry, P0 escalation wake-up, first-acknowledgement preservation, resolved evidence, and dismissed terminal-state tests.

- [ ] **Step 2: Run RED**

```powershell
node --test tools\work-orchestrator-v2\work-items.test.mjs
```

Expected: FAIL because the lifecycle is missing.

- [ ] **Step 3: Implement explicit typed transitions**

Export action types:

```js
export const WORK_ACTIONS = Object.freeze(['progress','snooze','ack_p0','request_resolve','dismiss']);
export function encodeWorkActionValue({ id, version, action }) { return Buffer.from(JSON.stringify({ id, version, action })).toString('base64url'); }
export function decodeWorkActionValue(value) {
  const decoded = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(decoded.id)) throw new Error('invalid work id');
  if (!Number.isSafeInteger(decoded.version) || decoded.version < 1) throw new Error('invalid work version');
  if (!WORK_ACTIONS.includes(decoded.action?.type)) throw new Error('invalid work action');
  return decoded;
}

export function applyWorkAction(item, action, now = new Date()) {
  if (action.expectedVersion !== item.version) throw new Error('stale work version');
  if (['resolved', 'dismissed'].includes(item.state)) throw new Error('terminal work item');
  const changedAt = now.toISOString();
  const next = { ...item, version: item.version + 1, updated_at: changedAt };
  let requestedLocalOperation = null;
  if (action.type === 'progress') next.state = 'in_progress';
  if (action.type === 'snooze') {
    const snoozedUntil = new Date(action.snoozedUntil);
    if (!(snoozedUntil > now)) throw new Error('snooze must end in the future');
    next.state = 'snoozed';
    next.snoozed_until = snoozedUntil.toISOString();
  }
  if (action.type === 'ack_p0') next.p0_acknowledged_at = changedAt;
  if (action.type === 'request_resolve') {
    next.pending_action = { type: 'resolve', status: 'pending', requested_at: changedAt, requested_by: action.requestedBy };
    requestedLocalOperation = { type: 'resolve', workItemId: item.id, expectedVersion: next.version };
  }
  if (action.type === 'dismiss') {
    next.state = 'dismissed';
    next.dismissed_at = changedAt;
  }
  return { item: next, requestedLocalOperation };
}
```

`request_resolve` sets `pending_action={type:'resolve',status:'pending',requested_at,...}` and does not set `state='resolved'`.

- [ ] **Step 4: Run GREEN and commit**

```powershell
node --test tools\work-orchestrator-v2\work-items.test.mjs
git add -- tools/work-orchestrator-v2/work-items.mjs tools/work-orchestrator-v2/work-items.test.mjs
git commit -m "feat: define durable human work lifecycle"
```

---

### Task 2: Add atomic work and digest database operations

**Files:**
- Modify: the single file matching `supabase/migrations/*_work_orchestrator_v2_foundation.sql` when `migration list --local` proves it is unapplied
- Or create: the single CLI-generated file matching `supabase/migrations/*_work_orchestrator_v2_work_digest_rpcs.sql` when foundation is already applied
- Modify: `tools/work-orchestrator-v2/schema.test.mjs`
- Modify: `tools/work-orchestrator-v2/supabase-store.mjs`
- Modify: `tools/work-orchestrator-v2/supabase-store.test.mjs`

**Interfaces:**
- Produces RPCs `upsert_work_item_v2`, `request_work_item_action_v2`, `claim_digest_run_v2`, `finalize_digest_run_v2`, `fail_digest_run_v2`, and `record_digest_cleanup_v2`, plus store methods with the same camelCase names.
- Every successful digest claim/reclaim returns a unique `lease_token`; finalize/fail require exact run ID, lease owner, and token.
- A new run records and returns the exact latest prior delivered digest coordinate. Cleanup evidence is recorded only after the new run is delivered.

- [ ] **Step 1: Generate an additive migration only when the foundation is already in migration history**

```powershell
npx --yes supabase@2.116.0 migration list --local
```

If foundation is unapplied, amend it. If applied, run:

```powershell
npx --yes supabase@2.116.0 migration new work_orchestrator_v2_work_digest_rpcs
```

- [ ] **Step 2: Add failing schema/store tests**

Assert each function is `SECURITY INVOKER`, has `set search_path=''`, is revoked from public/anon/authenticated, and granted to service_role. Store tests must prove optimistic version filters and one digest lease winner.

- [ ] **Step 3: Run RED**

```powershell
node --test tools\work-orchestrator-v2\schema.test.mjs tools\work-orchestrator-v2\supabase-store.test.mjs
```

Expected: FAIL because RPCs/methods are absent.

- [ ] **Step 4: Implement exact RPC behavior**

- `upsert_work_item_v2`: lock active row by `work_key`, insert if absent, otherwise merge typed source keys and update content/version; terminal rows are never reopened.
- `request_work_item_action_v2`: update only when `id`, `version`, and active state match; store pending action and increment version.
- `claim_digest_run_v2`: insert by `(destination_key,scheduled_at)` or claim an expired `building|failed` lease; only one caller receives `claimed=true`.
- `finalize_digest_run_v2`: require the exact lease generation, lock run and snapshot work rows, validate content-free snapshot semantics, then mark delivered and increment counters only for matching active IDs and versions. An empty snapshot stores null Slack coordinates and represents a no-send delivery.
- `record_digest_cleanup_v2`: only after the new run is delivered, record confirmed deletion/already-absence or a reviewed cleanup failure for its exact `previous_digest_id`; mark the prior run replaced only after confirmed deletion/absence.

Each function returns JSON `{applied|claimed|created,row}` and schema-qualifies all tables.

- [ ] **Step 5: Extend the store and run GREEN**

Add methods:

```js
upsertWorkItem(candidate)
requestWorkAction({ id, expectedVersion, action, requestedBy })
listActionableWork({ now, limit })
claimDigestRun({ destinationKey, scheduledAt, windowStartedAt, windowEndedAt, leaseOwner, leaseSeconds })
finalizeDigestRun({ id, leaseOwner, leaseToken, itemSnapshot, channelId, messageTs, deliveredAt })
failDigestRun({ id, leaseOwner, leaseToken, error })
recordDigestCleanup({ id, previousDigestId, outcome, error })
```

Run:

```powershell
node --test tools\work-orchestrator-v2\schema.test.mjs tools\work-orchestrator-v2\supabase-store.test.mjs
git diff --check
```

- [ ] **Step 6: Commit**

```powershell
git add -- supabase/migrations tools/work-orchestrator-v2/schema.test.mjs tools/work-orchestrator-v2/supabase-store.mjs tools/work-orchestrator-v2/supabase-store.test.mjs
git commit -m "feat: add atomic work and digest operations"
```

---

### Task 3: Dual-write typed Hermes outcomes into v2 work items

**Files:**
- Modify: `tools/ai-browser-worker/worker.mjs:10353-10485`
- Modify: `tools/ai-browser-worker/worker.test.mjs`

**Interfaces:**
- Consumes: `buildHumanWorkCandidates` and `store.upsertWorkItem`.
- Produces: `workOrchestratorResult={skipped,inserted,merged,rows,error}` alongside existing `followUpResult`.

- [ ] **Step 1: Write worker RED tests**

Test that:

1. successful verified auto-reply writes zero work items;
2. approval-required typed candidate writes one stable work item;
3. duplicate processing merges the same `work_key`;
4. v2 failure is recorded but does not alter the legacy result during dual-write mode;
5. missing typed `work_key` becomes a v2 validation error, never a name-based merge.

- [ ] **Step 2: Run RED**

```powershell
node --test --test-name-pattern "Work Orchestrator v2 work item" tools\ai-browser-worker\worker.test.mjs
```

- [ ] **Step 3: Add feature-gated dual write**

Extend config with `WORK_ORCHESTRATOR_V2_WORK_ITEMS_ENABLED`. In `finalizePreparedKakaoDecision`, preserve the full legacy branch, then call v2 candidate/upsert logic and return `workOrchestratorResult`. Do not call `deliverSlackFollowUpRows` for v2 rows.

- [ ] **Step 4: Run GREEN and commit**

```powershell
node --test --test-name-pattern "Work Orchestrator v2 work item" tools\ai-browser-worker\worker.test.mjs
npm --prefix tools\ai-browser-worker test
git add -- tools/ai-browser-worker/worker.mjs tools/ai-browser-worker/worker.test.mjs
git commit -m "feat: dual write typed human work items"
```

---

### Task 4: Implement digest selection, reminders, and rendering

**Files:**
- Create: `tools/work-orchestrator-v2/digests.mjs`
- Create: `tools/work-orchestrator-v2/digests.test.mjs`

**Interfaces:**
- Consumes: active work rows and a supplied clock.
- Produces: `selectDigestItems(items,now)`, `buildDigestSnapshot(items,now)`, `buildDigestSlackMessage(snapshot,config)`, `nextDigestScheduledAt(lastDeliveredAt,intervalMinutes)`.

- [ ] **Step 1: Write table-driven RED tests**

Use fixed KST timestamps to prove:

- snoozed rows are excluded before but included at `snoozed_until`;
- every active actionable row appears;
- P0 acknowledged unresolved precedes overdue, urgent, carry-over, normal;
- `consecutive_unhandled_digests >= 2` adds owner mention;
- age >=24h adds overdue section;
- age >=72h and `next_reminder_at <= now` adds daily reminder reason;
- snapshot stores only `{id,version,inclusionReason,priority}`;
- rendered buttons encode id/version/action.

- [ ] **Step 2: Run RED**

```powershell
node --test tools\work-orchestrator-v2\digests.test.mjs
```

- [ ] **Step 3: Implement deterministic pure functions**

Define sections as `p0`, `overdue`, `urgent`, `carry_over`, `actionable`; cap each Slack message at 45 work rows and create additional numbered digest messages only when required. A run snapshot contains all rows across its messages.

- [ ] **Step 4: Run GREEN and commit**

```powershell
node --test tools\work-orchestrator-v2\digests.test.mjs
git add -- tools/work-orchestrator-v2/digests.mjs tools/work-orchestrator-v2/digests.test.mjs
git commit -m "feat: build durable focus digests"
```

---

### Task 5: Add the leased digest runner and safe replacement

**Files:**
- Create: `tools/work-orchestrator-v2/digest-runner.mjs`
- Create: `tools/work-orchestrator-v2/digest-runner.test.mjs`
- Modify: `tools/work-orchestrator-v2/slack-client.mjs`
- Modify: `tools/work-orchestrator-v2/slack-client.test.mjs`
- Modify: `tools/kakao-dom-bridge/server.mjs`
- Modify: `tools/kakao-dom-bridge/server.test.mjs`

**Interfaces:**
- Consumes: store, Slack client, digest pure functions.
- Produces: `runDigestCycle({store,slack,config,now,leaseOwner})` and bridge `/maintenance/work-orchestrator-digest`.

- [ ] **Step 1: Write RED runner tests**

Prove:

1. two runners race and one claims;
2. zero eligible items finalizes with an empty snapshot and null Slack coordinates, and sends no digest;
3. new digest posts and finalizes before previous digest deletion;
4. post failure preserves previous digest and counters;
5. the claimed run's exact `previous_digest` coordinate is deleted only after new delivery, and deletion failure is recorded through `recordDigestCleanup` without failing the delivered new digest;
6. work counters advance only after finalize succeeds.

- [ ] **Step 2: Run RED**

```powershell
node --test tools\work-orchestrator-v2\digest-runner.test.mjs
```

- [ ] **Step 3: Add `updateMessage` and `deleteMessage` to the Slack client**

`deleteMessage` accepts only exact channel/ts and returns `{status:'deleted'|'already_absent'}`; `cant_delete_message` remains an error.

- [ ] **Step 4: Implement the runner and bridge schedule**

The bridge checks every minute, computes a three-hour scheduled boundary, and relies on the DB lease for single execution. Add startup catch-up for one missed boundary only. Expose last run, next scheduled time, failures, and omitted eligible count in health.

- [ ] **Step 5: Run GREEN and commit**

```powershell
node --test tools\work-orchestrator-v2\digest-runner.test.mjs tools\work-orchestrator-v2\slack-client.test.mjs
npm --prefix tools\work-orchestrator-v2 test
npm --prefix tools\kakao-dom-bridge test
git add -- tools/work-orchestrator-v2 tools/kakao-dom-bridge/server.mjs tools/kakao-dom-bridge/server.test.mjs
git commit -m "feat: schedule and replace focus digests"
```

---

### Task 6: Add signed versioned Slack actions and snooze

**Files:**
- Create: `tools/work-orchestrator-v2/work-actions.mjs`
- Create: `tools/work-orchestrator-v2/work-actions.test.mjs`
- Modify: `apps/follow-up-dashboard/api/slack-actions.js`
- Modify: `apps/follow-up-dashboard/api/slack-actions.test.mjs`
- Modify: `tools/kakao-dom-bridge/server.mjs`
- Modify: `tools/kakao-dom-bridge/server.test.mjs`

**Interfaces:**
- Vercel consumes Slack-signed `village_work_v2_*` actions and calls `request_work_item_action_v2`.
- Bridge consumes pending actions and calls `processPendingWorkAction({row,action,now})`.

- [ ] **Step 1: Write Vercel RED tests**

Add action ids:

```text
village_work_v2_progress
village_work_v2_snooze_3h
village_work_v2_snooze_evening
village_work_v2_snooze_tomorrow
village_work_v2_ack_p0
village_work_v2_request_resolve
village_work_v2_dismiss
```

Test valid signature, decoded id/version, stale-version response, and that `request_resolve` does not directly set `state=resolved`.

- [ ] **Step 2: Run RED**

```powershell
node --test apps\follow-up-dashboard\api\slack-actions.test.mjs
```

- [ ] **Step 3: Implement signed v2 request handling**

Reuse existing signature verification. Route legacy ids unchanged. For v2, call the service-only RPC and return an ephemeral stale-state message when `applied=false`.

- [ ] **Step 4: Write and implement local action tests**

Progress/snooze/ack/dismiss update with versioned CAS. Resolve stays pending until the final plan's authoritative resolution handler runs. Explicit date snooze uses a Slack modal with ISO timestamp validation and must be future-dated.

- [ ] **Step 5: Run GREEN and commit**

```powershell
node --test apps\follow-up-dashboard\api\slack-actions.test.mjs
node --test --test-name-pattern "Work Orchestrator action" tools\kakao-dom-bridge\server.test.mjs
npm --prefix tools\work-orchestrator-v2 test
git add -- apps/follow-up-dashboard/api/slack-actions.js apps/follow-up-dashboard/api/slack-actions.test.mjs tools/work-orchestrator-v2/work-actions.mjs tools/work-orchestrator-v2/work-actions.test.mjs tools/kakao-dom-bridge/server.mjs tools/kakao-dom-bridge/server.test.mjs
git commit -m "feat: add versioned digest actions and snooze"
```

---

### Task 7: Add a v2 read surface behind a server flag

**Files:**
- Modify: `apps/today-dashboard/app/api/follow-ups/route.ts`
- Create: `apps/today-dashboard/test/workOrchestratorFollowUpsRoute.test.mjs`
- Modify: `apps/today-dashboard/.env.example` if present; otherwise document variables in `apps/today-dashboard/README.md`

**Interfaces:**
- Consumes: authenticated staff request and server-side service role.
- Produces: existing response shape with `source:'work_items_v2'` when `WORK_ORCHESTRATOR_V2_DASHBOARD_ENABLED=1`.

- [ ] **Step 1: Write RED route tests**

Prove unauthenticated 401, service-role-only table access, active state filter, no customer raw message payload in response, and legacy fallback when the flag is off.

- [ ] **Step 2: Run RED**

```powershell
node --test apps\today-dashboard\test\workOrchestratorFollowUpsRoute.test.mjs
```

- [ ] **Step 3: Implement the flagged query**

Map v2 fields to the current UI item shape server-side. Do not expose `pending_action`, resolution evidence internals, or source message content.

- [ ] **Step 4: Run GREEN, build, and commit**

```powershell
node --test apps\today-dashboard\test\workOrchestratorFollowUpsRoute.test.mjs
npm --prefix apps\today-dashboard test
npm --prefix apps\today-dashboard run build
git add -- apps/today-dashboard/app/api/follow-ups/route.ts apps/today-dashboard/test/workOrchestratorFollowUpsRoute.test.mjs apps/today-dashboard/README.md
git commit -m "feat: expose v2 work items to staff dashboard"
```

---

## Human-work and digest completion gate

Do not disable legacy rows/cards until:

- dual-write comparison proves every typed legacy human task has one v2 work item and no auto-processed reply item;
- a restart test preserves digest cadence and reminders;
- every eligible active item is present in a delivered digest snapshot;
- two-miss, 24-hour, 72-hour, snooze expiry, and P0 ordering tests pass;
- stale Slack buttons are proven no-ops;
- new digest delivery is proven before old digest deletion;
- staff dashboard v2 access is authenticated and service-role remains server-side.
