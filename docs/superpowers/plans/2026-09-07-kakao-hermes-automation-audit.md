# Kakao Hermes automation audit implementation plan

> **Execution:** Use `superpowers:test-driven-development` for every production change and `superpowers:verification-before-completion` before rollout claims. This plan is executed inline on the explicitly approved clean `main` integration branch; no subagent or parallel worktree is used.

**Goal:** Add a quiet, read-only `자동처리` tab to the existing Today Dashboard follow-up screen that shows only externally proven Kakao Hermes effects, once per effect, without creating owner work or sending an audit notification.

**Architecture:** Existing Gateway tool receipts and exact Kakao DOM send readback remain the only authorities. The local Gateway channel durably queues bounded audit projections after business evidence exists. A separate projector idempotently inserts immutable rows into Supabase and updates a content-free singleton projection-status row. A separate authenticated read-only API and UI render those rows; neither `work_items_v2` nor business execution depends on the audit database.

**Tech stack:** Node.js 24 ESM, built-in `node:test`, atomic local JSON channel, Supabase PostgreSQL/PostgREST, PGlite, Next.js 15, React 19, TypeScript.

## Locked scope and safety contract

- Included: proven Kakao auto-reply, confirmation-request write, registered-reservation change, quote/document send, and exact blocked/failed/partial receipts for those operations.
- Excluded: Slack agent activity, manual Sheet/AppSheet changes, GAS triggers, manual scripts, and all audit-only notifications.
- One immutable row per authoritative effect. `event_key` is a SHA-256 identity derived from the exact operation/readback identifier and effect type.
- The projector may retry only its Supabase insert/readback. It must never rerun Hermes, GAS, DOM send, document generation, follow-up finalization, or customer delivery.
- Incoming chat text, phone numbers, secrets, tokens, prompts, stack traces, model logs, arbitrary payloads, and raw receipts are forbidden.
- `자동처리` is independent of `work_items_v2` counts and has no complete/snooze/dismiss/action controls.
- The later “ample stock may auto-register a pending RQ” capability is **not part of this implementation**. Manual sheet review remains the current registration default until a separately approved numeric stock-margin contract exists.

## Fixed event contract

The production mapper emits exactly this bounded shape:

```js
{
  event_key: 'kakao:<effect_type>:<64 lowercase hex>',
  job_id: '<1..160 chars>',
  room_revision: 1,
  operation_id: '<trusted id or null>',
  receipt_id: '<trusted id or null>',
  occurred_at: '<canonical UTC ISO timestamp>',
  effect_type: 'auto_reply' | 'confirmation_request' | 'registered_reservation_change' | 'document_send',
  action_type: 'send' | 'create' | 'update' | 'add' | 'remove' | 'replace' | 'quantity_change' | 'date_time_change',
  outcome: 'success' | 'partial_success' | 'failed' | 'blocked' | 'no_action',
  customer_label: '<safe display label, max 120>',
  target_type: 'room' | 'request' | 'trade' | 'document',
  target_id: '<verified RQ/trade/document id or null>',
  summary: '<owner-readable sentence, max 500>',
  change_items: [{ field: '<allowlisted>', before: '<bounded scalar|null>', after: '<bounded scalar|null>' }],
  outbound_text: '<safe exact sent text, max 2000, or null>',
  evidence: { schema: '<allowlisted>', status: '<allowlisted>', readback: true },
  source_message_at: '<canonical UTC ISO or null>',
  historical_import: false
}
```

`change_items` allows only `equipment`, `quantity`, `start_at`, `end_at`, `tax_mode`, and `document`. Customer phone, bank/account strings, and secret-shaped values cause the optional display field to be omitted; they never enter the audit row.

## Task 1: Immutable Supabase audit contract

**Files**

- Create: `supabase/migrations/20260907110000_kakao_automation_audit_events.sql`
- Create: `tools/work-orchestrator-v2/kakao-automation-audit-pglite.test.mjs`
- Modify: `tools/work-orchestrator-v2/schema.test.mjs`

### Step 1: Write RED schema/PGlite tests

Tests must require:

1. the dedicated table and indexes;
2. exact enum/check bounds and JSON size/type limits;
3. RLS plus service-role-only select/insert grants;
4. update/delete rejection through an immutable-row trigger;
5. duplicate `event_key` idempotency and conflicting-content detection by the projector contract;
6. newest-first composite `(occurred_at,event_key)` pagination and date/effect/outcome/customer/target filters;
7. zero dependency on or mutation of `work_items_v2`.
8. a separate singleton `kakao_automation_audit_projection_status` row contains only pending/conflict counts and timestamps for the UI's `기록 동기화 지연` indicator.

Run:

```powershell
node --test tools/work-orchestrator-v2/kakao-automation-audit-pglite.test.mjs tools/work-orchestrator-v2/schema.test.mjs
```

Expected RED: migration is absent.

### Step 2: Implement the migration

The core SQL must be materially equivalent to:

```sql
create table public.kakao_automation_audit_events (
  event_key text primary key check (event_key ~ '^kakao:(auto_reply|confirmation_request|registered_reservation_change|document_send):[0-9a-f]{64}$'),
  job_id text not null check (char_length(job_id) between 1 and 160),
  room_revision integer not null check (room_revision > 0),
  operation_id text null check (operation_id is null or char_length(operation_id) between 1 and 160),
  receipt_id text null check (receipt_id is null or char_length(receipt_id) between 1 and 200),
  occurred_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  effect_type text not null check (effect_type in ('auto_reply','confirmation_request','registered_reservation_change','document_send')),
  action_type text not null check (action_type in ('send','create','update','add','remove','replace','quantity_change','date_time_change')),
  outcome text not null check (outcome in ('success','partial_success','failed','blocked','no_action')),
  customer_label text not null check (char_length(customer_label) between 1 and 120),
  target_type text not null check (target_type in ('room','request','trade','document')),
  target_id text null check (target_id is null or char_length(target_id) between 1 and 160),
  summary text not null check (char_length(summary) between 1 and 500),
  change_items jsonb not null default '[]'::jsonb check (jsonb_typeof(change_items) = 'array' and jsonb_array_length(change_items) <= 20 and octet_length(change_items::text) <= 8000),
  outbound_text text null check (outbound_text is null or char_length(outbound_text) between 1 and 2000),
  evidence jsonb not null check (jsonb_typeof(evidence) = 'object' and octet_length(evidence::text) <= 4000),
  source_message_at timestamptz null,
  historical_import boolean not null default false
);
```

Add indexes on `(occurred_at desc,event_key desc)`, `(outcome,occurred_at desc)`, `(effect_type,occurred_at desc)`, `lower(customer_label)`, and `(target_id,occurred_at desc)`. A `before update or delete` trigger must always raise `kakao_automation_audit_event_immutable`. Revoke all from `public, anon, authenticated`; grant only `select,insert` to `service_role`; enable RLS.

Create the content-free singleton separately:

```sql
create table public.kakao_automation_audit_projection_status (
  singleton boolean primary key default true check (singleton),
  pending_count integer not null default 0 check (pending_count >= 0),
  conflict_count integer not null default 0 check (conflict_count >= 0),
  oldest_pending_at timestamptz null,
  last_success_at timestamptz null,
  updated_at timestamptz not null default now()
);
```

It receives service-role `select,insert,update` only and stores no job, customer, target, receipt, or error text.

### Step 3: Verify GREEN

Run the Task 1 test command and `git diff --check`.

## Task 2: Pure trusted-evidence mapper and Supabase projector

**Files**

- Create: `tools/kakao-dom-bridge/kakao-automation-audit.mjs`
- Create: `tools/kakao-dom-bridge/kakao-automation-audit.test.mjs`

### Step 1: Write RED mapper tests

Cover these exact cases:

- exact confirmation receipt with authoritative `reqID` becomes one create/update event;
- exact registered receipt maps each mutation kind and bounded before/after delta;
- exact document receipt with authoritative trade/tax readback becomes one send event;
- exact `autoReplyResult.readbackReceipt` plus `sent/readback_confirmed` becomes one reply event;
- one mutation plus one reply produces two distinct keys;
- failed/blocked/partial receipts preserve outcome and failed stage without claiming success;
- wrong revision, operation/receipt mismatch, receipt-shaped model text, missing readback, unsafe phone/secret text, oversized arrays/text, and unknown fields are rejected or omitted as specified;
- mapper output contains no raw conversation, phone, prompt, token, error stack, or arbitrary receipt object.

### Step 2: Write RED projector tests

The wished-for API is:

```js
const store = createKakaoAutomationAuditStore({
  supabaseUrl,
  serviceRoleKey,
  fetchImpl,
  timeoutMs: 7000
});
const result = await store.insertAndReadback(events);
// { inserted: number, existing: number, events: exactNormalizedRows }
await store.recordProjectionStatus({ pendingCount, conflictCount, oldestPendingAt, lastSuccessAt });
```

Tests require one POST using `Prefer: resolution=ignore-duplicates,return=representation`, followed by exact GET readback for every requested key. A same-key byte-equivalent row is success; a same-key differing immutable fact throws `automation_audit_projection_conflict`. Missing config, anon-key fallback, malformed DB output, timeout, or private-field input fails closed before delivery is marked.

### Step 3: Implement minimal mapper/store

Export:

```js
export function buildKakaoAutomationAuditEvents({ durableJob, prepared = null, applied = null, historicalImport = false } = {})
export function normalizeKakaoAutomationAuditEvent(value)
export function createKakaoAutomationAuditStore(options)
```

Tool events must use only the one receipt that exactly matches the durable `tool_operation` envelope. Reply events must use only the persisted application readback envelope or the current applied result where `sent === true`, `sendResult.readback_confirmed === true`, and `readbackReceipt.id/confirmedAt` are exact.

### Step 4: Verify GREEN

```powershell
node --test tools/kakao-dom-bridge/kakao-automation-audit.test.mjs
node --check tools/kakao-dom-bridge/kakao-automation-audit.mjs
```

## Task 3: Durable projection queue in the Gateway channel

**Files**

- Modify: `tools/kakao-dom-bridge/hermes-gateway-channel.mjs`
- Modify: `tools/kakao-dom-bridge/hermes-gateway-channel.test.mjs`

### Step 1: Write RED channel tests

Require:

- new jobs start with `audit_projection:null`;
- `queueAuditProjection({job_id,events})` atomically persists one bounded pending projection;
- exact retry is idempotent; different facts under the same event key throw `audit_projection_conflict` without mutation;
- `listPendingAuditProjections({limit})` is stable and bounded;
- `markAuditProjectionDelivered({job_id,event_keys,audit})` requires exact keys and persists delivered state;
- failed delivery remains pending across process restart;
- `listAuditProjectionCandidates({limit})` returns jobs with an exact completed tool receipt or persisted reply readback but no projection;
- status exposes only aggregate `pending`, `conflict`, and oldest age, never event/customer content;
- projection recovery never changes `job.state`, tool receipt, application state, lease, or failure notification.

### Step 2: Implement the channel state

Persist this bounded metadata:

```js
audit_projection: {
  state: 'pending' | 'delivered' | 'conflict',
  events: [/* normalized audit events, max 4 */],
  event_keys: ['...'],
  created_at: '<ISO>',
  delivered_at: null,
  attempts: 0,
  last_attempt_at: null,
  error_type: null
}
```

No reconciliation path may requeue an AI job or application because of this field.

### Step 3: Verify GREEN

```powershell
node --test tools/kakao-dom-bridge/hermes-gateway-channel.test.mjs
node --check tools/kakao-dom-bridge/hermes-gateway-channel.mjs
```

## Task 4: Wire projection after durable business evidence

**Files**

- Modify: `tools/kakao-dom-bridge/server.mjs`
- Modify: `tools/kakao-dom-bridge/server.test.mjs`
- Modify: `tools/kakao-dom-bridge/hermes-gateway-http.mjs`
- Modify: `tools/kakao-dom-bridge/hermes-gateway-http.test.mjs`

### Step 1: Write RED integration tests

Add tests proving:

1. `recordApplicationApplied` persists the exact bounded auto-reply readback envelope, not only booleans;
2. after finalize evidence, server records and durably finalizes the normal business application first, then schedules audit queue/projection work without awaiting it;
3. Supabase projection failure returns the normal finalized customer/business result and leaves only audit pending;
4. restart recovers the pending audit projection and does not call prepare/apply/finalize/Hermes/GAS/DOM/document/customer send;
5. a crash before queueing is recovered from exact durable tool receipt or persisted reply readback;
6. response loss/retry creates one DB row;
7. `gateway_no_send` produces no reply event but still records proven tool outcome;
8. health exposes only bounded projection counts/delay/conflict;
9. HTTP claim/outcome responses never await the optional Supabase audit path, and concurrent projection retries coalesce into one in-process attempt.

### Step 2: Implement a dedicated coordinator

Add:

```js
export function createKakaoAutomationAuditCoordinator({ channel, store, now = Date.now, log = () => {} }) {
  return {
    queueFromEvidence(input) {},
    projectPending({ limit = 25 } = {}) {},
    recover({ limit = 100, historicalImport = true } = {}) {}
  };
}
```

In `runApplication`, persist bounded reply proof inside `recordApplicationApplied.audit`, finish the existing finalize assertions, call existing business `record`, and durably finalize the application. Only then schedule queue/projection work as a detached, error-contained retry. Startup calls `recover()` after existing application recovery. HTTP claim/outcome paths may trigger a coalesced projection recovery pass, but they never await it and cannot execute a business operation.

Projection errors go to the existing bounded local error log as `kakao_automation_audit_projection`; they never call `failApplication` and never create/send a Slack card.

### Step 3: Verify GREEN

```powershell
node --test tools/kakao-dom-bridge/kakao-automation-audit.test.mjs tools/kakao-dom-bridge/hermes-gateway-channel.test.mjs tools/kakao-dom-bridge/hermes-gateway-http.test.mjs tools/kakao-dom-bridge/server.test.mjs
node --check tools/kakao-dom-bridge/server.mjs
node --check tools/kakao-dom-bridge/hermes-gateway-http.mjs
```

## Task 5: Authenticated read-only API

**Files**

- Create: `apps/today-dashboard/app/api/automation-audit/route.ts`
- Create: `apps/today-dashboard/test/kakaoAutomationAuditRoute.test.mjs`
- Modify: `apps/today-dashboard/README.md`

### Step 1: Write RED API tests

Require unauthenticated `401`, missing service role `503`, GET-only behavior, strict query/cursor validation, service-role headers, 15-second timeout, newest-first bounded pagination, today/7d/custom date filters, effect/outcome/customer-or-target filters, exact response keys, private-field rejection, and no `work_items_v2` query.

The response contract is:

```json
{
  "ok": true,
  "source": "kakao_automation_audit_events",
  "items": [],
  "nextCursor": null,
  "sync": { "delayed": false }
}
```

### Step 2: Implement the route

Use `getAuthedUser(req)` before config or database access. Require `SUPABASE_SERVICE_ROLE_KEY`; do not fall back to anon. Allow only `range=today|7d|custom`, canonical UTC `from/to`, allowlisted effect/outcome, a trimmed search string up to 120 chars, `limit=1..100`, and a canonical base64url `{occurredAt,eventKey}` cursor. Return only the fixed UI DTO.

### Step 3: Verify GREEN

```powershell
node --test apps/today-dashboard/test/kakaoAutomationAuditRoute.test.mjs
```

## Task 6: Fourth read-only `자동처리` tab

**Files**

- Create: `apps/today-dashboard/lib/automation-audit/inbox-model.mjs`
- Create: `apps/today-dashboard/test/kakaoAutomationAuditInboxModel.test.mjs`
- Create: `apps/today-dashboard/components/AutomationAuditView.tsx`
- Modify: `apps/today-dashboard/components/FollowUpView.tsx`
- Create: `test/today-dashboard-kakao-automation-audit.static.test.js`

### Step 1: Write RED model/static tests

Require:

- fourth top tab label `자동처리` exactly once;
- default today/newest-first view and safe status icons;
- filters for today/7d/custom, search, effect, and failed/partial/blocked;
- compact owner line plus mobile/desktop detail;
- loading, empty, stale/error, and delayed-sync states;
- no PATCH, complete, snooze, reopen, acknowledge, bulk action, Slack, Kakao, or send controls in the audit component;
- existing three work tabs/counts/actions unchanged.

### Step 2: Implement the independent view

`FollowUpView` owns only the top-level choice:

```tsx
type FollowUpSection = ViewKey | "automation";
// Existing work view remains unchanged for now/snoozed/completed.
// section === "automation" renders <AutomationAuditView active={paneActive} />.
```

`AutomationAuditView` fetches only `/api/automation-audit`, refreshes every 30 seconds while visible, and contains no mutation callback. Reuse the existing responsive list/detail visual pattern without coupling audit rows to `InboxModel`.

### Step 3: Verify GREEN

```powershell
node --test apps/today-dashboard/test/kakaoAutomationAuditInboxModel.test.mjs test/today-dashboard-kakao-automation-audit.static.test.js
npm --prefix apps/today-dashboard test
npm --prefix apps/today-dashboard run build
```

## Task 7: Bounded no-send history import and rollout

**Files**

- Create: `scripts/windows/backfill-kakao-automation-audit.mjs`
- Create: `tools/kakao-dom-bridge/kakao-automation-audit-backfill.test.mjs`
- Modify: `docs/superpowers/specs/2026-09-06-kakao-hermes-automation-audit-design.md` only to record final verified implementation/operational details if they differ from this plan.

### Step 1: Write RED backfill tests

Require a queue-directory scan that:

- reads only regular non-reparse hashed job JSON files;
- imports only exact completed tool receipts and persisted DOM reply readbacks;
- sets `historical_import=true`;
- skips and counts missing/invalid/unprovable evidence;
- caps files/events and supports `--dry-run`;
- never imports worker modules that execute business actions and never exposes raw job data;
- performs no Hermes/GAS/DOM/document/follow-up/customer-send call.

### Step 2: Implement and verify no-send backfill

The CLI requires explicit `--queue-dir`, defaults to dry-run, and requires both `--apply` and valid Supabase service-role configuration to insert. Its output is aggregate counts only.

```powershell
node --test tools/kakao-dom-bridge/kakao-automation-audit-backfill.test.mjs
node scripts/windows/backfill-kakao-automation-audit.mjs --queue-dir "$env:QUEUE_DIR" --dry-run --max-files 500 --max-events 500
```

### Step 3: Full offline verification

```powershell
node --test tools/kakao-dom-bridge/*.test.mjs tools/ai-browser-worker/worker.test.mjs
node --test tools/work-orchestrator-v2/*.test.mjs
npm --prefix apps/today-dashboard test
npm --prefix apps/today-dashboard run build
git diff --check
```

### Step 4: Production preflight and migration

1. Verify clean/expected main source state and inspect `supabase migration list --linked`.
2. Stop on migration divergence; do not repair/reset history automatically.
3. Apply only the new migration with the repository-linked Supabase CLI.
4. Read back table, grants/RLS, immutable trigger, and an empty/newest-first query without printing customer data.

### Step 5: Repository-prescribed deploy

Run:

```bash
./scripts/endwork.sh "feat: add Kakao Hermes automation audit"
```

Expected: GAS is unchanged and its version deployment is skipped; Git main is committed/pushed; Today Dashboard Vercel production deployment reaches READY.

### Step 6: Root Gateway rollout

Use the existing root-only restart wrapper after source, DB, and config gates pass. Verify old/new PID, process survival, trusted Gateway transport, and aggregate projection health. Do not restart the worker profile or alter scheduled-task definitions.

### Step 7: One bounded live proof

1. Run the backfill in dry-run and confirm only aggregate provable/skipped counts.
2. Run one `--apply` pass only after dry-run is safe.
3. Verify one retained trusted event appears exactly once in Supabase and the authenticated `/api/automation-audit` response.
4. Open the deployed FollowUp page read-only and verify the rendered `자동처리` row/detail.
5. Confirm no Slack/Kakao/SMS/email audit message and no GAS/sheet/customer mutation occurred.

## Final verification matrix

- Source: exact commit on `origin/main`; clean worktree.
- Gateway: exact root process/PID and aggregate projection readback, not port-only health.
- Database: migration/grants/immutable trigger and exact row identity/readback.
- API: authenticated route returns the exact fixed DTO; unauthenticated is 401.
- UI: deployed rendered fourth tab and detail; no audit action buttons.
- Safety: no business replay, no audit notification, no private fields, no `work_items_v2` audit row.
- Regression: confirmation requests, registered changes, document sends, Kakao auto-send, Gateway leases/applications, Work Orchestrator, and Today Dashboard tests stay green.
