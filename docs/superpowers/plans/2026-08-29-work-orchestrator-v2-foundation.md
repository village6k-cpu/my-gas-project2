# Work Orchestrator v2 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the private Supabase schema, typed Node contracts, service-role store, feature flags, and shadow receipt writes required by every later Work Orchestrator v2 phase.

**Architecture:** Keep the existing Kakao bridge as the long-running process and add focused modules under `tools/work-orchestrator-v2`; do not create another daemon. The foundation writes one durable notification obligation per accepted Kakao event in shadow mode, without posting Slack messages or changing legacy card production.

**Tech Stack:** Node.js 24 ESM, built-in `node:test`, Supabase Postgres/PostgREST, Supabase CLI 2.116.0, PowerShell/Bash repository scripts.

**Spec:** `docs/superpowers/specs/2026-08-29-work-orchestrator-v2-design.md`

## Global Constraints

- Every accepted inbound customer-message event must eventually have one `message_notification_receipts` row keyed by `source_event_key`; heartbeats, diagnostics, stale history, page chrome, and container events are not customer-message events.
- Shadow mode must not send Slack/Kakao, mutate Sheets/GAS, disable legacy producers, or alter customer-facing behavior.
- Hermes remains the decision-maker; foundation code validates and persists typed lifecycle state only.
- Keep the existing profile-scoped `rpa-automation-operations` skill unchanged as the Kakao Chrome/watcher/bridge/worker health-and-recovery runbook. Work Orchestrator v2 is new application state/orchestration code and must not import, rename, or retrofit that runbook as its decision engine.
- New Supabase tables are service-role only: enable RLS, revoke `PUBLIC`, `anon`, and `authenticated`, grant only `service_role`, and expose no browser policies.
- Use `SECURITY INVOKER` for database functions, `set search_path = ''`, schema-qualify every relation, and revoke default function execution from `PUBLIC`.
- Keep service-role values out of browser code, logs, docs, tests, and committed environment files.
- Generate migrations with `npx --yes supabase@2.116.0 migration new`; do not create a timestamped migration filename manually.
- Before a production database push, inspect `supabase migration list --linked`; do not repair migration history or push against divergence without owner review.
- Follow repository TDD: prove RED, make the smallest implementation, prove GREEN, then commit that task.

## File map

- Create `supabase/config.toml` through `supabase init`: canonical CLI configuration for new root migrations.
- Create the single CLI-generated file matching `supabase/migrations/*_work_orchestrator_v2_foundation.sql` and assign its absolute path to `$migrationPath`: v2 tables, constraints, indexes, triggers, and service-only receipt claim function.
- Create `tools/work-orchestrator-v2/package.json`: isolated test/check commands with no runtime dependency.
- Create `tools/work-orchestrator-v2/contracts.mjs`: enums, input normalization, state-transition validation, and feature config.
- Create `tools/work-orchestrator-v2/contracts.test.mjs`: pure contract tests.
- Create `tools/work-orchestrator-v2/supabase-store.mjs`: bounded PostgREST/RPC client.
- Create `tools/work-orchestrator-v2/supabase-store.test.mjs`: request/response and compare-and-swap tests using injected `fetchImpl`.
- Create `tools/work-orchestrator-v2/shadow-receipts.mjs`: one-event/one-receipt shadow orchestration.
- Create `tools/work-orchestrator-v2/shadow-receipts.test.mjs`: duplicate and failure behavior.
- Create `tools/work-orchestrator-v2/schema.test.mjs`: static migration security/shape checks.
- Modify `tools/kakao-dom-bridge/server.mjs`: load v2 config, create the store, shadow-write after event acceptance, and expose readback.
- Modify `tools/kakao-dom-bridge/server.test.mjs`: integration ordering and health tests.
- Modify `tools/kakao-dom-bridge/.env.example`: non-secret v2 flags and table names.

---

### Task 1: Establish the CLI migration boundary and private schema

**Files:**
- Create: `supabase/config.toml`
- Create: the single CLI-generated file matching `supabase/migrations/*_work_orchestrator_v2_foundation.sql` (`$migrationPath` in every command below)
- Create: `tools/work-orchestrator-v2/package.json`
- Create: `tools/work-orchestrator-v2/schema.test.mjs`

**Interfaces:**
- Consumes: Supabase CLI 2.116.0 and the design data model.
- Produces: REST-visible service-role tables `message_notification_receipts`, `work_items_v2`, and `digest_runs`; RPC `claim_message_notification_receipt`.

- [ ] **Step 1: Initialize the canonical CLI directory and create the migration through the CLI**

Run from the repository root:

```powershell
npx --yes supabase@2.116.0 init
npx --yes supabase@2.116.0 migration new work_orchestrator_v2_foundation
$migrationPath = (Get-ChildItem -LiteralPath supabase\migrations -Filter '*_work_orchestrator_v2_foundation.sql' | Select-Object -Single FullName)
if (-not $migrationPath) { throw 'foundation migration was not generated' }
Write-Output $migrationPath
```

Expected: one CLI-generated migration path and `supabase/config.toml`.

- [ ] **Step 2: Write the failing static schema test**

Create `tools/work-orchestrator-v2/package.json`:

```json
{
  "name": "village-work-orchestrator-v2",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test *.test.mjs",
    "check": "node --check contracts.mjs && node --check supabase-store.mjs && node --check shadow-receipts.mjs"
  },
  "engines": { "node": ">=24" }
}
```

Create `tools/work-orchestrator-v2/schema.test.mjs` with tests that read the single `*_work_orchestrator_v2_foundation.sql` file and assert:

```js
for (const table of ['message_notification_receipts', 'work_items_v2', 'digest_runs']) {
  assert.match(sql, new RegExp(`create table public\\.${table}`, 'i'));
  assert.match(sql, new RegExp(`alter table public\\.${table} enable row level security`, 'i'));
  assert.match(sql, new RegExp(`revoke all on table public\\.${table} from public, anon, authenticated`, 'i'));
  assert.match(sql, new RegExp(`grant select, insert, update, delete on table public\\.${table} to service_role`, 'i'));
}
assert.match(sql, /unique\s*\(source_event_key\)/i);
assert.match(sql, /notification_state in \('pending','delivering','delivered','failed','cleanup_pending','deleted'\)/i);
assert.match(sql, /state in \('open','in_progress','snoozed','resolved','dismissed'\)/i);
assert.match(sql, /security invoker/i);
assert.match(sql, /set search_path = ''/i);
assert.match(sql, /revoke execute on function public\.claim_message_notification_receipt/i);
assert.doesNotMatch(sql, /create policy/i);
```

- [ ] **Step 3: Run the test to verify RED**

Run:

```powershell
node --test tools\work-orchestrator-v2\schema.test.mjs
```

Expected: FAIL because the migration lacks the tables and grants.

- [ ] **Step 4: Add the complete migration**

Write the CLI-generated migration with these exact contracts:

```sql
set lock_timeout = '5s';

create table public.message_notification_receipts (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  source_event_key text not null unique,
  source_message_id text,
  room_key text not null,
  received_at timestamptz not null,
  urgency text not null default 'normal' check (urgency in ('p0','urgent','normal','low')),
  notification_state text not null default 'pending'
    check (notification_state in ('pending','delivering','delivered','failed','cleanup_pending','deleted')),
  client_message_id uuid not null,
  slack_channel_id text,
  slack_message_ts text,
  delivered_at timestamptz,
  cleanup_after timestamptz,
  cleanup_state text not null default 'idle'
    check (cleanup_state in ('idle','pending','deleted','failed','blocked_p0')),
  cleanup_error text,
  delivery_attempts integer not null default 0 check (delivery_attempts >= 0),
  last_delivery_error text,
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.work_items_v2 (
  id uuid primary key default gen_random_uuid(),
  work_key text not null,
  source_event_keys text[] not null default '{}',
  room_key text not null,
  title text not null,
  summary text not null default '',
  work_type text not null,
  priority text not null default 'normal' check (priority in ('p0','urgent','normal','low')),
  state text not null default 'open' check (state in ('open','in_progress','snoozed','resolved','dismissed')),
  owner_id text,
  actionable_at timestamptz not null default now(),
  due_at timestamptz,
  snoozed_until timestamptz,
  first_opened_at timestamptz not null default now(),
  last_activity_at timestamptz not null default now(),
  digest_inclusion_count integer not null default 0 check (digest_inclusion_count >= 0),
  consecutive_unhandled_digests integer not null default 0 check (consecutive_unhandled_digests >= 0),
  last_digest_at timestamptz,
  next_reminder_at timestamptz,
  automation_state text not null default 'not_attempted'
    check (automation_state in ('not_attempted','running','succeeded','failed','needs_human')),
  resolution_kind text,
  resolution_evidence jsonb not null default '{}'::jsonb check (jsonb_typeof(resolution_evidence) = 'object'),
  resolved_at timestamptz,
  resolved_by text,
  pending_action jsonb not null default '{}'::jsonb check (jsonb_typeof(pending_action) = 'object'),
  version integer not null default 1 check (version > 0),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index work_items_v2_active_key_unique
  on public.work_items_v2 (work_key)
  where state not in ('resolved','dismissed');

create table public.digest_runs (
  id uuid primary key default gen_random_uuid(),
  window_started_at timestamptz not null,
  window_ended_at timestamptz not null,
  scheduled_at timestamptz not null,
  state text not null default 'building'
    check (state in ('building','delivering','delivered','failed','replaced')),
  destination_key text not null,
  item_snapshot jsonb not null default '[]'::jsonb check (jsonb_typeof(item_snapshot) = 'array'),
  slack_channel_id text,
  slack_message_ts text,
  delivered_at timestamptz,
  previous_digest_id uuid references public.digest_runs(id) on delete set null,
  previous_deleted_at timestamptz,
  lease_owner text,
  lease_expires_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (destination_key, scheduled_at)
);

create index message_notification_receipts_state_age_idx
  on public.message_notification_receipts (notification_state, created_at);
create index work_items_v2_actionable_idx
  on public.work_items_v2 (state, actionable_at, priority, first_opened_at);
create index digest_runs_destination_state_idx
  on public.digest_runs (destination_key, state, scheduled_at desc);

create function public.touch_work_orchestrator_v2_updated_at()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger touch_message_notification_receipts_updated_at
before update on public.message_notification_receipts
for each row execute function public.touch_work_orchestrator_v2_updated_at();
create trigger touch_work_items_v2_updated_at
before update on public.work_items_v2
for each row execute function public.touch_work_orchestrator_v2_updated_at();
create trigger touch_digest_runs_updated_at
before update on public.digest_runs
for each row execute function public.touch_work_orchestrator_v2_updated_at();

create function public.claim_message_notification_receipt(
  p_source text,
  p_source_event_key text,
  p_source_message_id text,
  p_room_key text,
  p_received_at timestamptz,
  p_client_message_id uuid,
  p_payload jsonb
) returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  v_row public.message_notification_receipts%rowtype;
  v_created boolean := false;
begin
  insert into public.message_notification_receipts
    (source, source_event_key, source_message_id, room_key, received_at, client_message_id, payload)
  values
    (p_source, p_source_event_key, p_source_message_id, p_room_key, p_received_at, p_client_message_id, coalesce(p_payload, '{}'::jsonb))
  on conflict (source_event_key) do nothing
  returning * into v_row;
  if found then
    v_created := true;
  else
    select * into strict v_row
    from public.message_notification_receipts
    where source_event_key = p_source_event_key;
  end if;
  return jsonb_build_object('created', v_created, 'row', to_jsonb(v_row));
end;
$$;

alter table public.message_notification_receipts enable row level security;
alter table public.work_items_v2 enable row level security;
alter table public.digest_runs enable row level security;

revoke all on table public.message_notification_receipts from public, anon, authenticated;
revoke all on table public.work_items_v2 from public, anon, authenticated;
revoke all on table public.digest_runs from public, anon, authenticated;
grant select, insert, update, delete on table public.message_notification_receipts to service_role;
grant select, insert, update, delete on table public.work_items_v2 to service_role;
grant select, insert, update, delete on table public.digest_runs to service_role;

revoke execute on function public.touch_work_orchestrator_v2_updated_at() from public, anon, authenticated;
revoke execute on function public.claim_message_notification_receipt(text,text,text,text,timestamptz,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.touch_work_orchestrator_v2_updated_at() to service_role;
grant execute on function public.claim_message_notification_receipt(text,text,text,text,timestamptz,uuid,jsonb) to service_role;
```

- [ ] **Step 5: Prove the static contract is GREEN**

Run:

```powershell
node --test tools\work-orchestrator-v2\schema.test.mjs
git diff --check
```

Expected: all schema tests pass and `git diff --check` exits 0.

- [ ] **Step 6: Verify the migration in an isolated local Supabase stack**

Run only when Docker is available:

```powershell
npx --yes supabase@2.116.0 start
npx --yes supabase@2.116.0 db reset
npx --yes supabase@2.116.0 migration list --local
```

Expected: reset succeeds and the foundation migration is listed locally. If Docker is unavailable, record this task as blocked and do not push the migration remotely.

- [ ] **Step 7: Commit the schema boundary**

```powershell
git add -- supabase/config.toml supabase/migrations tools/work-orchestrator-v2/package.json tools/work-orchestrator-v2/schema.test.mjs
git commit -m "feat: add work orchestrator v2 schema"
```

---

### Task 2: Add typed lifecycle contracts and configuration

**Files:**
- Create: `tools/work-orchestrator-v2/contracts.mjs`
- Create: `tools/work-orchestrator-v2/contracts.test.mjs`

**Interfaces:**
- Consumes: normalized Kakao event `{source,eventHash,roomKey,detectedAt,receivedAt,previewText,customerName,messagePreview}`.
- Produces: `loadWorkOrchestratorConfig(env)`, `notificationReceiptInput(event)`, `assertNotificationTransition(from,to)`, and `deterministicClientMessageId(sourceEventKey)`.

- [ ] **Step 1: Write failing contract tests**

Cover these exact behaviors:

```js
assert.deepEqual(notificationReceiptInput(event), {
  source: 'kakao_channel_manager_dom',
  sourceEventKey: 'event-1',
  sourceMessageId: null,
  roomKey: 'chat:1',
  receivedAt: '2026-08-29T00:00:00.000Z',
  payload: { previewText: '문의', customerName: '고객', messagePreview: '' }
});
assert.equal(deterministicClientMessageId('event-1'), deterministicClientMessageId('event-1'));
assert.notEqual(deterministicClientMessageId('event-1'), deterministicClientMessageId('event-2'));
assert.doesNotThrow(() => assertNotificationTransition('pending', 'delivering'));
assert.throws(() => assertNotificationTransition('deleted', 'delivering'), /invalid notification transition/i);
assert.equal(loadWorkOrchestratorConfig({ WORK_ORCHESTRATOR_V2_SHADOW_WRITES: '1' }).shadowWrites, true);
assert.equal(loadWorkOrchestratorConfig({}).immediateEnabled, false);
```

- [ ] **Step 2: Run RED**

```powershell
node --test tools\work-orchestrator-v2\contracts.test.mjs
```

Expected: FAIL because `contracts.mjs` does not exist.

- [ ] **Step 3: Implement the minimal pure contracts**

Use exported constants and signatures:

```js
import { createHash } from 'node:crypto';

export const NOTIFICATION_STATES = Object.freeze(['pending','delivering','delivered','failed','cleanup_pending','deleted']);
export const WORK_STATES = Object.freeze(['open','in_progress','snoozed','resolved','dismissed']);

const NOTIFICATION_TRANSITIONS = Object.freeze({
  pending: new Set(['delivering']),
  delivering: new Set(['delivered', 'failed']),
  failed: new Set(['delivering']),
  delivered: new Set(['cleanup_pending']),
  cleanup_pending: new Set(['deleted', 'failed']),
  deleted: new Set()
});

const bounded = (value, max) => String(value ?? '').trim().slice(0, max);

export function deterministicClientMessageId(sourceEventKey) {
  const hex = createHash('sha256')
    .update(`village-work-orchestrator-v2:${bounded(sourceEventKey, 500)}`)
    .digest('hex')
    .slice(0, 32)
    .split('');
  hex[12] = '5';
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16], 16) % 4];
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function notificationReceiptInput(event = {}) {
  const sourceEventKey = bounded(event.sourceEventKey || event.eventHash, 500);
  if (!sourceEventKey) throw new Error('source event key is required');
  return {
    source: bounded(event.source || 'kakao_channel_manager_dom', 100),
    sourceEventKey,
    sourceMessageId: bounded(event.sourceMessageId, 500) || null,
    roomKey: bounded(event.roomKey, 500) || null,
    receivedAt: new Date(event.receivedAt || event.detectedAt).toISOString(),
    payload: {
      previewText: bounded(event.previewText, 1000),
      customerName: bounded(event.customerName, 200),
      messagePreview: bounded(event.messagePreview, 1000)
    }
  };
}

export function assertNotificationTransition(from, to) {
  if (!NOTIFICATION_TRANSITIONS[from]?.has(to)) {
    throw new Error(`invalid notification transition: ${from} -> ${to}`);
  }
}

export function loadWorkOrchestratorConfig(env = process.env) {
  return {
    shadowWrites: env.WORK_ORCHESTRATOR_V2_SHADOW_WRITES === '1',
    immediateEnabled: env.WORK_ORCHESTRATOR_V2_IMMEDIATE_ENABLED === '1',
    workItemsEnabled: env.WORK_ORCHESTRATOR_V2_WORK_ITEMS_ENABLED === '1',
    digestEnabled: env.WORK_ORCHESTRATOR_V2_DIGEST_ENABLED === '1',
    cleanupEnabled: env.WORK_ORCHESTRATOR_V2_CLEANUP_ENABLED === '1',
    inboxChannelId: String(env.WORK_ORCHESTRATOR_V2_INBOX_CHANNEL_ID || '').trim(),
    digestChannelId: String(env.WORK_ORCHESTRATOR_V2_DIGEST_CHANNEL_ID || '').trim(),
    digestIntervalMinutes: Math.max(60, Number(env.WORK_ORCHESTRATOR_V2_DIGEST_INTERVAL_MINUTES || 180)),
    autoNoticeTtlMinutes: Math.max(30, Number(env.WORK_ORCHESTRATOR_V2_AUTO_NOTICE_TTL_MINUTES || 180))
  };
}
```

- [ ] **Step 4: Run GREEN and syntax check**

```powershell
node --test tools\work-orchestrator-v2\contracts.test.mjs
node --check tools\work-orchestrator-v2\contracts.mjs
```

Expected: all contract tests pass.

- [ ] **Step 5: Commit**

```powershell
git add -- tools/work-orchestrator-v2/contracts.mjs tools/work-orchestrator-v2/contracts.test.mjs
git commit -m "feat: define work orchestrator lifecycle contracts"
```

---

### Task 3: Add the service-role Supabase store

**Files:**
- Create: `tools/work-orchestrator-v2/supabase-store.mjs`
- Create: `tools/work-orchestrator-v2/supabase-store.test.mjs`

**Interfaces:**
- Consumes: `{supabaseUrl, serviceRoleKey, fetchImpl}` and normalized receipt input.
- Produces: `createWorkOrchestratorStore(config)` with `claimNotificationReceipt(input)`, `transitionNotification(input)`, `getNotificationByEventKey(key)`, and `counts()`.

- [ ] **Step 1: Write failing store tests with an injected fetch**

Assert the following request contracts:

```js
const store = createWorkOrchestratorStore({
  supabaseUrl: 'https://supabase.example',
  serviceRoleKey: 'test-service-role',
  fetchImpl
});
const claimed = await store.claimNotificationReceipt(input);
assert.equal(request.url, 'https://supabase.example/rest/v1/rpc/claim_message_notification_receipt');
assert.equal(request.init.method, 'POST');
assert.equal(request.init.headers.apikey, 'test-service-role');
assert.equal(claimed.created, true);
```

Also test that `transitionNotification({id,fromStates:['pending'],toState:'delivering'})` sends a PATCH filtered by both `id` and `notification_state=in.(pending)`, returns `{applied:false,row:null}` for an empty representation, and never includes the service key in thrown error messages.

- [ ] **Step 2: Run RED**

```powershell
node --test tools\work-orchestrator-v2\supabase-store.test.mjs
```

Expected: FAIL because the store is missing.

- [ ] **Step 3: Implement the store**

Export:

```js
function toRpcReceipt(input) {
  return {
    p_source: input.source,
    p_source_event_key: input.sourceEventKey,
    p_source_message_id: input.sourceMessageId,
    p_room_key: input.roomKey,
    p_received_at: input.receivedAt,
    p_payload: input.payload,
    p_slack_client_msg_id: input.slackClientMsgId
  };
}

export function createWorkOrchestratorStore({ supabaseUrl, serviceRoleKey, fetchImpl = fetch } = {}) {
  if (!supabaseUrl || !serviceRoleKey) throw new Error('Work Orchestrator Supabase configuration is missing');
  const baseUrl = `${supabaseUrl.replace(/\/$/, '')}/rest/v1/`;
  const request = async (pathAndQuery, init = {}) => {
    const response = await fetchImpl(`${baseUrl}${pathAndQuery}`, {
      ...init,
      headers: {
        apikey: serviceRoleKey,
        authorization: `Bearer ${serviceRoleKey}`,
        accept: 'application/json',
        'content-type': 'application/json',
        prefer: init.prefer || 'return=representation',
        ...init.headers
      },
      signal: init.signal || AbortSignal.timeout(7000)
    });
    const raw = await response.text();
    let data = null;
    if (raw) {
      try { data = JSON.parse(raw); } catch { data = { message: raw.slice(0, 300) }; }
    }
    if (!response.ok) {
      const code = typeof data?.code === 'string' ? data.code.slice(0, 80) : 'unknown';
      throw new Error(`Work Orchestrator Supabase request failed: HTTP ${response.status}, code ${code}`);
    }
    const contentRange = response.headers.get('content-range') || '';
    const countMatch = contentRange.match(/\/(\d+)$/);
    return { data, count: countMatch ? Number(countMatch[1]) : null };
  };
  return {
    claimNotificationReceipt: async (input) => (await request('rpc/claim_message_notification_receipt', {
      method: 'POST',
      body: JSON.stringify(toRpcReceipt(input))
    })).data,
    getNotificationByEventKey: async (sourceEventKey) => {
      const query = new URLSearchParams({
        select: '*',
        source_event_key: `eq.${sourceEventKey}`,
        limit: '1'
      });
      const { data } = await request(`message_notification_receipts?${query}`);
      return Array.isArray(data) ? data[0] || null : null;
    },
    transitionNotification: async ({ id, fromStates, toState, patch = {} }) => {
      const query = new URLSearchParams({
        id: `eq.${id}`,
        notification_state: `in.(${fromStates.join(',')})`,
        select: '*'
      });
      const { data } = await request(`message_notification_receipts?${query}`, {
        method: 'PATCH',
        body: JSON.stringify({ ...patch, notification_state: toState })
      });
      const row = Array.isArray(data) ? data[0] || null : null;
      return { applied: Boolean(row), row };
    },
    counts: async () => {
      const count = async (table, filters = '') => (await request(`${table}?select=id${filters}`, {
        method: 'HEAD',
        headers: { range: '0-0' },
        prefer: 'count=exact'
      })).count ?? 0;
      const [pendingNotifications, activeWorkItems, unfinishedDigests] = await Promise.all([
        count('message_notification_receipts', '&notification_state=in.(pending,delivering,failed,cleanup_pending)'),
        count('work_items_v2', '&state=in.(open,in_progress,snoozed)'),
        count('digest_runs', '&state=in.(building,failed)')
      ]);
      return { pendingNotifications, activeWorkItems, unfinishedDigests };
    }
  };
}
```

Use `AbortSignal.timeout(7000)` unless an injected signal exists. Return bounded errors containing HTTP status and Supabase response code, never headers or credentials.

- [ ] **Step 4: Run GREEN**

```powershell
node --test tools\work-orchestrator-v2\supabase-store.test.mjs
npm --prefix tools\work-orchestrator-v2 test
```

Expected: all foundation tests pass.

- [ ] **Step 5: Commit**

```powershell
git add -- tools/work-orchestrator-v2/supabase-store.mjs tools/work-orchestrator-v2/supabase-store.test.mjs
git commit -m "feat: add work orchestrator Supabase store"
```

---

### Task 4: Integrate shadow receipt writes into accepted Kakao events

**Files:**
- Create: `tools/work-orchestrator-v2/shadow-receipts.mjs`
- Create: `tools/work-orchestrator-v2/shadow-receipts.test.mjs`
- Modify: `tools/kakao-dom-bridge/server.mjs:1-170,3903-4000,4040-4130`
- Modify: `tools/kakao-dom-bridge/server.test.mjs`
- Modify: `tools/kakao-dom-bridge/.env.example`

**Interfaces:**
- Consumes: `notificationReceiptInput(event)` and `store.claimNotificationReceipt(input)`.
- Produces: `recordShadowNotificationObligation({event,config,store}) -> {skipped,created,row,error}` and `/health.state.workOrchestrator` counters.

- [ ] **Step 1: Write failing shadow tests**

Test exact behavior:

```js
assert.deepEqual(await recordShadowNotificationObligation({ event, config: { shadowWrites: false }, store }), {
  skipped: true, reason: 'shadow_disabled'
});
assert.equal((await recordShadowNotificationObligation({ event, config: { shadowWrites: true }, store })).created, true);
assert.equal(store.calls.length, 1);
```

Add a duplicate test returning `created:false`, and a store-failure test returning a bounded error while leaving the caller able to queue Hermes work.

- [ ] **Step 2: Run RED**

```powershell
node --test tools\work-orchestrator-v2\shadow-receipts.test.mjs
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement shadow orchestration**

```js
export async function recordShadowNotificationObligation({ event, config, store } = {}) {
  if (!config?.shadowWrites) return { skipped: true, reason: 'shadow_disabled' };
  try {
    return await store.claimNotificationReceipt(notificationReceiptInput(event));
  } catch (error) {
    return { skipped: false, created: false, error: String(error.message || error).slice(0, 500) };
  }
}
```

- [ ] **Step 4: Add bridge RED tests before modifying `server.mjs`**

Add tests proving:

1. heartbeat/diagnostic/container/stale events never call the shadow hook;
2. one accepted event calls it after `registerAcceptedRoomEvent` and before `scheduleDebouncedJob`;
3. shadow failure increments `state.workOrchestrator.shadowErrors` but still queues the worker;
4. `/health` exposes `config.workOrchestrator.shadowWrites` and receipt counters under `state.workOrchestrator`.

Run:

```powershell
node --test --test-name-pattern "Work Orchestrator shadow" tools\kakao-dom-bridge\server.test.mjs
```

Expected: FAIL because the bridge has no hook/readback.

- [ ] **Step 5: Wire shadow mode without changing live behavior**

In `server.mjs`:

- load config through `loadWorkOrchestratorConfig(process.env)`;
- create the store only when Supabase credentials exist;
- add state `{shadowClaims:0,shadowDuplicates:0,shadowErrors:0,lastShadowReceipt:null}`;
- call `recordShadowNotificationObligation` after room revision acceptance and before the existing `writeSupabaseEvent`/debounce calls;
- never throw the shadow error into `handleEvent`;
- expose only counts/timestamps/errors, not preview/customer content, in `/health`.

Append non-secret example values:

```dotenv
WORK_ORCHESTRATOR_V2_SHADOW_WRITES=0
WORK_ORCHESTRATOR_V2_IMMEDIATE_ENABLED=0
WORK_ORCHESTRATOR_V2_WORK_ITEMS_ENABLED=0
WORK_ORCHESTRATOR_V2_DIGEST_ENABLED=0
WORK_ORCHESTRATOR_V2_CLEANUP_ENABLED=0
WORK_ORCHESTRATOR_V2_INBOX_CHANNEL_ID=
WORK_ORCHESTRATOR_V2_DIGEST_CHANNEL_ID=
WORK_ORCHESTRATOR_V2_DIGEST_INTERVAL_MINUTES=180
WORK_ORCHESTRATOR_V2_AUTO_NOTICE_TTL_MINUTES=180
```

- [ ] **Step 6: Run focused and full GREEN verification**

```powershell
node --test --test-name-pattern "Work Orchestrator shadow" tools\kakao-dom-bridge\server.test.mjs
npm --prefix tools\work-orchestrator-v2 test
npm --prefix tools\kakao-dom-bridge test
git diff --check
```

Expected: all tests pass, with zero Slack/Kakao/GAS calls in v2 shadow tests.

- [ ] **Step 7: Commit**

```powershell
git add -- tools/work-orchestrator-v2/shadow-receipts.mjs tools/work-orchestrator-v2/shadow-receipts.test.mjs tools/kakao-dom-bridge/server.mjs tools/kakao-dom-bridge/server.test.mjs tools/kakao-dom-bridge/.env.example
git commit -m "feat: shadow work orchestrator notification receipts"
```

---

## Foundation completion gate

Do not start the immediate-notification plan until:

- local migration reset passes;
- static schema security tests pass;
- one duplicate accepted event yields one receipt in an isolated database;
- shadow failures do not suppress the existing worker path;
- no Slack/Kakao/GAS call occurs from v2;
- `git status --short` is clean after task commits.

Do not apply the migration to production in this plan. Production migration and feature activation remain cutover actions after all dependent code has passed review.
