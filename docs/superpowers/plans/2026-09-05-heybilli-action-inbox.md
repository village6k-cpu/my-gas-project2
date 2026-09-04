# Heybilli Action Inbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Slack item cards with one compact report and make Heybilli `후속조치` the only owner action surface, with one business category and one exact task type per semantic work item.

**Architecture:** Hermes remains the only semantic classifier and emits a reviewed `work_type`. A shared Work Orchestrator taxonomy maps that type to one category; a service-role-only Postgres RPC returns exact safe inbox counts/pages and the Next.js route submits version-CAS actions using the authenticated Heybilli actor. The digest and P0 paths retain their durable delivery fencing but render buttonless reports that direct the owner to Heybilli.

**Tech Stack:** Node.js 24 ESM, PostgreSQL/Supabase RPC, PGlite, Next.js 15 App Router, React 19, Tailwind CSS, Slack Web API Block Kit, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-05-heybilli-action-inbox-design.md`

## Global Constraints

- Hermes chooses semantic `work_type`; no keyword classifier may read customer text to infer category.
- Every owner-visible item has exactly one of `schedule`, `quote`, `settlement`, `customer`, or `operations` and exactly one reviewed task type.
- `completed_log`, `reservation_review_timeout`, `automation_error_review`, and `requires_human_action=false` never enter Heybilli counts/items or Slack reports.
- Ordinary Slack output is one message with at most five highlights and zero `actions`, `button`, `action_id`, or encoded work-action values.
- P0 output is one buttonless semantic alert; acknowledgement remains a Heybilli action and never resolves the work item.
- Browser code never receives a Supabase service-role key, raw payload, pending action, resolution evidence, room key, customer transcript, lease, token, or Slack coordinate.
- All mutations use exact work ID and expected version; stale writers are observable no-ops followed by a fresh safe read.
- A UI “complete” request cannot claim success until the existing authoritative resolution path verifies the business result.
- Feature-branch work performs no live migration apply, Slack/Kakao/customer send, message deletion, GAS deploy, schedule mutation, or production restart.
- Preserve unrelated dirty files and use additive migrations rather than rewriting already-applied migration history.

---

## File Map

### New files

- `tools/work-orchestrator-v2/work-taxonomy.mjs` — canonical reviewed work type, category, and Korean label contract.
- `tools/work-orchestrator-v2/work-taxonomy.test.mjs` — exhaustive one-category and operational-exclusion tests.
- `supabase/migrations/20260905120000_work_orchestrator_v2_heybilli_inbox.sql` — additive taxonomy parity, safe inbox/report read RPC, and Heybilli actor support.
- `apps/today-dashboard/lib/followups/inbox-model.mjs` — pure status/category/list/detail presentation model.
- `apps/today-dashboard/test/followUpInboxModel.test.mjs` — pure responsive-inbox state tests.

### Existing files to modify

- `tools/work-orchestrator-v2/work-items.mjs`
- `tools/work-orchestrator-v2/work-items.test.mjs`
- `tools/work-orchestrator-v2/work-actions.mjs`
- `tools/work-orchestrator-v2/work-actions.test.mjs`
- `tools/work-orchestrator-v2/supabase-store.mjs`
- `tools/work-orchestrator-v2/supabase-store.test.mjs`
- `tools/work-orchestrator-v2/schema.test.mjs`
- `tools/work-orchestrator-v2/pglite-schema.test.mjs`
- `apps/today-dashboard/app/api/follow-ups/route.ts`
- `apps/today-dashboard/test/workOrchestratorFollowUpsRoute.test.mjs`
- `apps/today-dashboard/components/FollowUpView.tsx`
- `apps/today-dashboard/README.md`
- `tools/work-orchestrator-v2/digests.mjs`
- `tools/work-orchestrator-v2/digests.test.mjs`
- `tools/work-orchestrator-v2/digest-runner.mjs`
- `tools/work-orchestrator-v2/digest-runner.test.mjs`
- `tools/kakao-dom-bridge/server.mjs`
- `tools/kakao-dom-bridge/server.test.mjs`
- `tools/work-orchestrator-v2/contracts.mjs`
- `tools/work-orchestrator-v2/contracts.test.mjs`
- `scripts/windows/windows-runtime-config.mjs`
- `apps/follow-up-dashboard/README.md`

---

### Task 1: Canonical semantic work taxonomy

**Files:**
- Create: `tools/work-orchestrator-v2/work-taxonomy.mjs`
- Create: `tools/work-orchestrator-v2/work-taxonomy.test.mjs`
- Modify: `tools/work-orchestrator-v2/work-items.mjs`
- Modify: `tools/work-orchestrator-v2/work-items.test.mjs`
- Modify: `tools/work-orchestrator-v2/supabase-store.mjs`
- Modify: `tools/work-orchestrator-v2/supabase-store.test.mjs`

**Interfaces:**
- Produces: `OWNER_WORK_DEFINITIONS`, `OWNER_WORK_TYPES`, `describeOwnerWorkType(workType)`, `isOwnerWorkType(workType)`.
- `describeOwnerWorkType` returns an immutable `{ type, category, categoryLabel, typeLabel }` or `null`.
- Adds semantic types `schedule_register` and `schedule_change` to candidate/store validation.

- [ ] **Step 1: Write the exhaustive taxonomy RED test**

```js
const expected = [
  ['reservation_review', 'schedule', '예약·스케줄', '예약 확인'],
  ['schedule_check', 'schedule', '예약·스케줄', '스케줄 확인'],
  ['schedule_register', 'schedule', '예약·스케줄', '스케줄 등록'],
  ['schedule_change', 'schedule', '예약·스케줄', '스케줄 변경'],
  ['return_extension', 'schedule', '예약·스케줄', '반납·연장'],
  ['quote_send', 'quote', '견적·가격', '견적서 발송'],
  ['price_review', 'quote', '견적·가격', '가격·할인 확인'],
  ['payment_check', 'settlement', '정산·서류', '입금·결제 확인'],
  ['tax_invoice', 'settlement', '정산·서류', '세금계산서 발행'],
  ['contract_document', 'settlement', '정산·서류', '계약·서류 처리'],
  ['reply_needed', 'customer', '고객 응대', '고객 답변 필요'],
  ['human_review', 'operations', '운영·예외', '기타 사람 확인'],
  ['damage_repair', 'operations', '운영·예외', '파손·수리'],
  ['sheet_duplicate_check', 'operations', '운영·예외', '중복 확인']
];
assert.deepEqual(OWNER_WORK_DEFINITIONS.map((x) => [x.type, x.category, x.categoryLabel, x.typeLabel]), expected);
assert.equal(new Set(expected.map(([type]) => type)).size, expected.length);
for (const type of ['completed_log', 'reservation_review_timeout', 'automation_error_review', 'unknown']) {
  assert.equal(describeOwnerWorkType(type), null);
}
```

- [ ] **Step 2: Run the taxonomy and candidate tests to prove RED**

Run:

```powershell
node --test tools/work-orchestrator-v2/work-taxonomy.test.mjs tools/work-orchestrator-v2/work-items.test.mjs tools/work-orchestrator-v2/supabase-store.test.mjs
```

Expected: FAIL because `work-taxonomy.mjs` and the two new schedule types do not exist.

- [ ] **Step 3: Implement the immutable taxonomy module**

```js
export const OWNER_WORK_DEFINITIONS = Object.freeze([
  Object.freeze({ type: 'reservation_review', category: 'schedule', categoryLabel: '예약·스케줄', typeLabel: '예약 확인' }),
  Object.freeze({ type: 'schedule_check', category: 'schedule', categoryLabel: '예약·스케줄', typeLabel: '스케줄 확인' }),
  Object.freeze({ type: 'schedule_register', category: 'schedule', categoryLabel: '예약·스케줄', typeLabel: '스케줄 등록' }),
  Object.freeze({ type: 'schedule_change', category: 'schedule', categoryLabel: '예약·스케줄', typeLabel: '스케줄 변경' }),
  Object.freeze({ type: 'return_extension', category: 'schedule', categoryLabel: '예약·스케줄', typeLabel: '반납·연장' }),
  Object.freeze({ type: 'quote_send', category: 'quote', categoryLabel: '견적·가격', typeLabel: '견적서 발송' }),
  Object.freeze({ type: 'price_review', category: 'quote', categoryLabel: '견적·가격', typeLabel: '가격·할인 확인' }),
  Object.freeze({ type: 'payment_check', category: 'settlement', categoryLabel: '정산·서류', typeLabel: '입금·결제 확인' }),
  Object.freeze({ type: 'tax_invoice', category: 'settlement', categoryLabel: '정산·서류', typeLabel: '세금계산서 발행' }),
  Object.freeze({ type: 'contract_document', category: 'settlement', categoryLabel: '정산·서류', typeLabel: '계약·서류 처리' }),
  Object.freeze({ type: 'reply_needed', category: 'customer', categoryLabel: '고객 응대', typeLabel: '고객 답변 필요' }),
  Object.freeze({ type: 'human_review', category: 'operations', categoryLabel: '운영·예외', typeLabel: '기타 사람 확인' }),
  Object.freeze({ type: 'damage_repair', category: 'operations', categoryLabel: '운영·예외', typeLabel: '파손·수리' }),
  Object.freeze({ type: 'sheet_duplicate_check', category: 'operations', categoryLabel: '운영·예외', typeLabel: '중복 확인' })
]);

const BY_TYPE = new Map(OWNER_WORK_DEFINITIONS.map((entry) => [entry.type, entry]));
export const OWNER_WORK_TYPES = Object.freeze(OWNER_WORK_DEFINITIONS.map(({ type }) => type));

export function describeOwnerWorkType(value) {
  const entry = typeof value === 'string' ? BY_TYPE.get(value) : null;
  return entry ? { ...entry } : null;
}

export function isOwnerWorkType(value) {
  return describeOwnerWorkType(value) !== null;
}
```

Import `OWNER_WORK_TYPES` or `isOwnerWorkType` in `work-items.mjs` and `supabase-store.mjs`; remove their duplicated owner-work allowlists. Keep operational source types recognized only where historical validation requires them, never as owner-visible types.

- [ ] **Step 4: Add candidate tests for both new schedule types and no keyword fallback**

Add one Hermes result fixture for `schedule_register`, one for `schedule_change`, and a customer sentence containing “견적/세금계산서/스케줄” with explicit `type: 'human_review'`. Assert the explicit type remains `human_review`; deterministic code must not reclassify it from text.

- [ ] **Step 5: Run Task 1 tests and full Work Orchestrator check**

Run:

```powershell
node --test tools/work-orchestrator-v2/work-taxonomy.test.mjs tools/work-orchestrator-v2/work-items.test.mjs tools/work-orchestrator-v2/supabase-store.test.mjs
npm --prefix tools/work-orchestrator-v2 run check
```

Expected: PASS with no unsupported-type regressions.

- [ ] **Step 6: Commit Task 1**

```powershell
git add -- tools/work-orchestrator-v2/work-taxonomy.mjs tools/work-orchestrator-v2/work-taxonomy.test.mjs tools/work-orchestrator-v2/work-items.mjs tools/work-orchestrator-v2/work-items.test.mjs tools/work-orchestrator-v2/supabase-store.mjs tools/work-orchestrator-v2/supabase-store.test.mjs
git commit -m "feat: define owner work taxonomy"
```

---

### Task 2: Add the exact owner-inbox database boundary

**Files:**
- Create: `supabase/migrations/20260905120000_work_orchestrator_v2_heybilli_inbox.sql`
- Modify: `tools/work-orchestrator-v2/schema.test.mjs`
- Modify: `tools/work-orchestrator-v2/pglite-schema.test.mjs`

**Interfaces:**
- Produces SQL helper `public.owner_work_taxonomy_v2(p_work_type text) returns jsonb`.
- Produces service-role-only RPC:

```sql
public.list_heybilli_owner_work_v2(
  p_now timestamptz,
  p_view text,
  p_category text,
  p_limit integer,
  p_after jsonb default null
) returns jsonb
```

- Replaces `request_work_item_action_v2(uuid, integer, jsonb, text)` and `is_processable_pending_work_action_v2(jsonb, integer)` with actor validation that also accepts canonical `heybilli:<lowercase-uuid>`.
- Read RPC response exact keys: `summary`, `items`, `nextCursor`, `omittedCount`.

- [ ] **Step 1: Write static migration contract tests**

Assert the new migration:

```js
assert.match(sql, /create function public\.list_heybilli_owner_work_v2\(/i);
assert.match(sql, /security invoker set search_path = ''/i);
assert.match(sql, /revoke execute .* from public, anon, authenticated/i);
assert.match(sql, /grant execute .* to service_role/i);
assert.doesNotMatch(sql, /customer_message|transcript|source_event_keys|resolution_evidence/i);
```

Also assert the SQL taxonomy contains the exact Task 1 fixture and excludes the three operational types.

- [ ] **Step 2: Write executable PGlite RED coverage**

Seed 202 valid active rows covering all categories, plus `requires_human_action=false`, three operational types, future and expired snooze, P0 acknowledged before/at/after `p_now`, and terminal rows. Assert:

```js
assert.deepEqual(result.summary, {
  now: 201,
  snoozed: 1,
  completed: 2,
  p0: 1,
  byCategory: { schedule: 41, quote: 40, settlement: 40, customer: 40, operations: 41 }
});
assert.equal(result.items.length, 100);
assert.equal(result.omittedCount, 101);
assert.ok(result.nextCursor);
```

Fetch the second page using `nextCursor`; assert no duplicate IDs and that concatenated ordering is P0, overdue, urgent, oldest open, UUID. Assert an expired snooze appears in `now`, while a future snooze appears only in `snoozed`.

- [ ] **Step 3: Run schema/PGlite tests to prove RED**

Run:

```powershell
node --test --test-name-pattern="Heybilli owner inbox" tools/work-orchestrator-v2/schema.test.mjs tools/work-orchestrator-v2/pglite-schema.test.mjs
```

Expected: FAIL because the additive migration and RPC do not exist.

- [ ] **Step 4: Implement taxonomy parity and bounded read RPC**

Use an exact SQL `case` for type/category labels. Build a candidate CTE that applies all eligibility before `limit`:

```sql
where (w.payload->>'requires_human_action')::boolean is true
  and public.owner_work_taxonomy_v2(w.work_type) is not null
  and (
    (p_view = 'now' and w.state in ('open','in_progress','snoozed')
      and (w.state <> 'snoozed' or w.snoozed_until <= p_now))
    or (p_view = 'snoozed' and w.state = 'snoozed' and w.snoozed_until > p_now)
    or (p_view = 'completed' and w.state in ('resolved','dismissed'))
  )
```

Validate `p_now` is finite, `p_view` is one of `now|snoozed|completed`, category is null or one of five keys, `p_limit` is an integer `1..200`, and `p_after` is null or the exact cursor object. Derive `summary` in the same statement before pagination. Project only the spec allowlist.

- [ ] **Step 5: Extend action actor validation without weakening Slack rollback**

Use one exact helper predicate in both request and processor SQL:

```sql
(p_requested_by ~ '^[UW][A-Z0-9]{2,79}$'
 or p_requested_by ~ '^heybilli:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
```

Keep the existing unfinished-digest barrier, active-state CAS, P0 hide rules, future snooze validation, exact pending-action shape, and version increment unchanged.

- [ ] **Step 6: Prove ACL, pagination, category parity, actor CAS, and privacy GREEN**

Run:

```powershell
node --test --test-name-pattern="Heybilli owner inbox|Heybilli actor" tools/work-orchestrator-v2/schema.test.mjs tools/work-orchestrator-v2/pglite-schema.test.mjs
```

Expected: PASS. Test anon/authenticated execute denial, service-role execution, extra cursor keys, invalid/infinite clocks, unsupported category, stale action version, and response JSON key equality.

- [ ] **Step 7: Commit Task 2**

```powershell
git add -- supabase/migrations/20260905120000_work_orchestrator_v2_heybilli_inbox.sql tools/work-orchestrator-v2/schema.test.mjs tools/work-orchestrator-v2/pglite-schema.test.mjs
git commit -m "feat: add Heybilli owner inbox RPC"
```

---

### Task 3: Make the authenticated Heybilli API actionable

**Files:**
- Modify: `tools/work-orchestrator-v2/supabase-store.mjs`
- Modify: `tools/work-orchestrator-v2/supabase-store.test.mjs`
- Modify: `tools/work-orchestrator-v2/work-actions.mjs`
- Modify: `tools/work-orchestrator-v2/work-actions.test.mjs`
- Modify: `apps/today-dashboard/app/api/follow-ups/route.ts`
- Modify: `apps/today-dashboard/test/workOrchestratorFollowUpsRoute.test.mjs`
- Modify: `apps/today-dashboard/README.md`

**Interfaces:**
- Store method:

```js
listHeybilliOwnerWork({ now, view, category, limit, after })
// => { summary, items, nextCursor, omittedCount }
```

- Existing `requestWorkAction({ id, expectedVersion, action, requestedBy })` accepts the server-generated Heybilli actor and retains exact response validation.
- API `GET /api/follow-ups?view=now&category=schedule&limit=100&after=<base64url>`.
- API `PATCH /api/follow-ups` exact body `{ id, expectedVersion, action }`.

- [ ] **Step 1: Write store RED tests for the RPC and exact response**

Assert PostgREST receives:

```js
{
  p_now: '2026-09-05T09:00:00.000Z',
  p_view: 'now',
  p_category: 'schedule',
  p_limit: 100,
  p_after: null
}
```

Reject missing/extra response keys, unknown category/type, noncanonical timestamps, private fields, negative/fractional counts, mismatched summary totals, and invalid cursors with the generic `Heybilli inbox response invalid` error.

- [ ] **Step 2: Write API route RED tests**

Add tests for:

```js
assert.equal(unauthenticated.status, 401);
assert.equal(missingServiceKey.status, 503);
assert.equal(validGetBody.source, 'work_items_v2');
assert.deepEqual(Object.keys(validGetBody.items[0]).sort(), SAFE_ITEM_KEYS);
assert.equal(stalePatch.status, 409);
assert.equal(extraPatchKey.status, 400);
assert.equal(recordedRpcBody.p_requested_by, `heybilli:${AUTH_USER_ID}`);
assert.ok(!JSON.stringify(validGetBody).includes('pending_action'));
```

Verify `requestedBy` supplied by the browser is rejected rather than forwarded.

- [ ] **Step 3: Run store/action/API tests to prove RED**

Run:

```powershell
node --test tools/work-orchestrator-v2/supabase-store.test.mjs tools/work-orchestrator-v2/work-actions.test.mjs apps/today-dashboard/test/workOrchestratorFollowUpsRoute.test.mjs
```

Expected: FAIL because the store read method, Heybilli actor, and v2 PATCH path are absent.

- [ ] **Step 4: Implement strict store parsing and actor support**

Add `HEYBILLI_ACTOR` beside the Slack actor validator in `work-actions.mjs`:

```js
const HEYBILLI_ACTOR = /^heybilli:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function validWorkActor(value) {
  return typeof value === 'string' && (SLACK_USER_ID.test(value) || HEYBILLI_ACTOR.test(value));
}
```

Use it only where `requested_by` is validated; do not change action semantics.

- [ ] **Step 5: Replace the v2 legacy-shape GET and read-only PATCH**

In `route.ts`:

```ts
const user = await getAuthedUser(req);
if (!user) return NextResponse.json({ error: "인증 필요" }, { status: 401 });
const actor = `heybilli:${user.id.toLowerCase()}`;
```

GET validates finite query parameters, decodes a bounded cursor, calls the inbox RPC with the service key, and returns its exact safe model. PATCH validates exact object keys and action shape, calls `request_work_item_action_v2`, maps `applied:false` to 409, then performs a fresh safe item read. Catch blocks return only `후속조치 정보를 불러오지 못했습니다` or `후속조치를 변경하지 못했습니다`, never upstream bodies.

- [ ] **Step 6: Update README environment contract**

Document `WORK_ORCHESTRATOR_V2_DASHBOARD_ENABLED=1`, the service-role-only server requirement, and that v2 PATCH is available only to authenticated Heybilli users. State explicitly that the browser bundle contains no service key.

- [ ] **Step 7: Run Task 3 GREEN plus dashboard build**

Run:

```powershell
node --test tools/work-orchestrator-v2/supabase-store.test.mjs tools/work-orchestrator-v2/work-actions.test.mjs apps/today-dashboard/test/workOrchestratorFollowUpsRoute.test.mjs
npm --prefix apps/today-dashboard test
npm --prefix apps/today-dashboard run build
```

Expected: all PASS; build output must not contain the service-role key name in client chunks.

- [ ] **Step 8: Commit Task 3**

```powershell
git add -- tools/work-orchestrator-v2/supabase-store.mjs tools/work-orchestrator-v2/supabase-store.test.mjs tools/work-orchestrator-v2/work-actions.mjs tools/work-orchestrator-v2/work-actions.test.mjs apps/today-dashboard/app/api/follow-ups/route.ts apps/today-dashboard/test/workOrchestratorFollowUpsRoute.test.mjs apps/today-dashboard/README.md
git commit -m "feat: enable authenticated Heybilli work actions"
```

---

### Task 4: Replace the kanban with the visible action inbox

**Files:**
- Create: `apps/today-dashboard/lib/followups/inbox-model.mjs`
- Create: `apps/today-dashboard/test/followUpInboxModel.test.mjs`
- Modify: `apps/today-dashboard/components/FollowUpView.tsx`

**Interfaces:**
- `buildInboxView({ payload, view, category, selectedId, now })` returns `{ tabs, categories, rows, selected, emptyLabel }`.
- `actionBody(item, action)` returns exact `{ id, expectedVersion: item.version, action }`.
- UI consumes only the Task 3 safe model.

- [ ] **Step 1: Write pure inbox-model RED tests**

Cover five categories, three tabs, priority order, expired snooze visibility, one-row-one-category, selection fallback, stale refresh, and the exact action body:

```js
const model = buildInboxView({ payload, view: 'now', category: 'schedule', selectedId: null, now });
assert.deepEqual(model.rows.map(({ id }) => id), ['p0', 'overdue', 'urgent', 'oldest']);
assert.equal(model.rows.every((row) => row.category === 'schedule'), true);
assert.equal(new Set(model.rows.map(({ id }) => id)).size, model.rows.length);
assert.deepEqual(actionBody(model.rows[0], { type: 'progress' }), {
  id: model.rows[0].id,
  expectedVersion: model.rows[0].version,
  action: { type: 'progress' }
});
```

- [ ] **Step 2: Add a source contract test before replacing JSX**

Read `FollowUpView.tsx` as text and assert the new source contains `지금 할 일`, `미뤄둔 일`, `완료`, and five category labels, while excluding `LANE_DEFS`, `type="checkbox"`, `bulk`, and the four old lane headings.

- [ ] **Step 3: Run model/source tests to prove RED**

Run:

```powershell
node --test apps/today-dashboard/test/followUpInboxModel.test.mjs
```

Expected: FAIL because the model is absent and the component is still a four-lane kanban.

- [ ] **Step 4: Implement the pure view model**

Validate the API shape rather than trusting component props. Preserve server order; do not reclassify text. Return category counts from `payload.summary`, not client recounts. Treat unavailable payload as a separate state, not an empty list.

- [ ] **Step 5: Rebuild `FollowUpView` as responsive master-detail**

Use this component structure:

```tsx
<ViewHeader title="후속조치"><RefreshButton /></ViewHeader>
<StatusTabs value={view} counts={summary} onChange={setView} />
<CategoryChips value={category} counts={summary.byCategory} onChange={setCategory} />
<div className="lg:grid lg:grid-cols-[minmax(320px,0.9fr)_minmax(420px,1.1fr)] lg:gap-4">
  <InboxList rows={rows} selectedId={selectedId} onSelect={setSelectedId} />
  <WorkDetail item={selected} onAction={submitAction} />
</div>
```

Mobile uses a fixed bottom sheet only after a row is selected. Desktop keeps the detail panel sticky. Remove all checkbox/bulk state and lane assignment. Render P0/overdue styling strongly; all other cards use neutral tokens.

- [ ] **Step 6: Wire actions and stale/error behavior**

POST exact PATCH bodies through `authFetch`. Disable the selected item’s controls while a request is in flight. On 409, show `다른 곳에서 이미 변경되었습니다`, refetch the current view, and select the refreshed item if it still exists. On read failure, retain the last good rows with an unavailable banner and disable all mutations.

- [ ] **Step 7: Run dashboard tests and production build**

Run:

```powershell
node --test apps/today-dashboard/test/followUpInboxModel.test.mjs apps/today-dashboard/test/workOrchestratorFollowUpsRoute.test.mjs
npm --prefix apps/today-dashboard test
npm --prefix apps/today-dashboard run build
```

Expected: PASS. Inspect build errors for Tailwind class typos and server/client boundary imports.

- [ ] **Step 8: Commit Task 4**

```powershell
git add -- apps/today-dashboard/lib/followups/inbox-model.mjs apps/today-dashboard/test/followUpInboxModel.test.mjs apps/today-dashboard/components/FollowUpView.tsx
git commit -m "feat: rebuild Heybilli follow-up inbox"
```

---

### Task 5: Render one compact scheduled Slack report

**Files:**
- Modify: `tools/work-orchestrator-v2/digests.mjs`
- Modify: `tools/work-orchestrator-v2/digests.test.mjs`
- Modify: `tools/work-orchestrator-v2/digest-runner.mjs`
- Modify: `tools/work-orchestrator-v2/digest-runner.test.mjs`
- Modify: `tools/work-orchestrator-v2/supabase-store.mjs`
- Modify: `tools/work-orchestrator-v2/supabase-store.test.mjs`

**Interfaces:**
- Store reuses `listHeybilliOwnerWork({ view: 'now', limit: 5 })` and returns exact global summary plus five server-ordered highlights.
- Renderer becomes `buildDigestSlackMessage(highlights, { now, dashboardUrl, summary })`.
- Existing durable digest claim/prepare/delivery/finalize interfaces remain; the content-free snapshot contains only the displayed highlight IDs/versions plus report counts needed to reproduce the immutable message.

- [ ] **Step 1: Replace card-oriented digest tests with report RED tests**

Assert:

```js
const rendered = buildDigestSlackMessage(items, { now, dashboardUrl, summary });
assert.equal(rendered.ordinaryParts.length, 1);
assert.equal(rendered.dailyReminderParts.length, 0);
assert.equal(rendered.ordinaryParts[0].itemIds.length, 5);
assert.ok(rendered.ordinaryParts[0].blocks.length <= 4);
assert.equal(JSON.stringify(rendered).match(/"type":"actions"/g)?.length ?? 0, 0);
for (const forbidden of ['button', 'action_id', 'village_work_v2_', 'automation_error_review', 'reservation_review_timeout']) {
  assert.equal(JSON.stringify(rendered).includes(forbidden), false);
}
assert.match(rendered.ordinaryParts[0].text, /나머지 118건/);
```

Add exact Korean snapshot assertions for category counts and the five highlight lines. Zero `summary.now` must return the existing no-send result.

- [ ] **Step 2: Add runner RED tests for exact aggregate use**

The fake store returns 123 `now`, 4 snoozed, 2 P0, category counts, and exactly five items. Assert the runner never calls the old 500-row `listActionableWork`, prepares one part, posts once, and finalizes only after the one coordinate settles. A reclaimed prepared run must use the stored immutable report snapshot rather than current counts.

- [ ] **Step 3: Run digest/runner tests to prove RED**

Run:

```powershell
node --test tools/work-orchestrator-v2/digests.test.mjs tools/work-orchestrator-v2/digest-runner.test.mjs tools/work-orchestrator-v2/supabase-store.test.mjs
```

Expected: FAIL because the renderer still creates one section and one action block per item and daily reminder parts.

- [ ] **Step 4: Implement the compact renderer**

Return one part shaped for the existing persistence boundary:

```js
return {
  selectedCount: summary.now,
  renderedCount: highlights.length,
  dailyReminderCount: 0,
  ordinaryParts: [{
    kind: 'ordinary',
    partNumber: 1,
    partCount: 1,
    itemIds: highlights.map(({ id }) => id),
    text: fallbackText,
    blocks: [headerBlock, totalsBlock, highlightsBlock, linkContextBlock]
  }],
  dailyReminderParts: []
};
```

Escape Slack text, bound every field, and require an HTTPS dashboard URL. Do not import or call the work-action codec.

- [ ] **Step 5: Adapt runner immutable intent and reclaim validation**

Build the digest from the exact DB report at the scheduled boundary. Persist a content-free snapshot containing highlight IDs/versions, summary integer counts, and taxonomy keys. On reclaim, compare the reconstructed canonical report hash with the stored manifest exactly; retain existing successor-first divergence handling and never repost an ambiguous part.

- [ ] **Step 6: Run focused and full Work Orchestrator tests**

Run:

```powershell
node --test tools/work-orchestrator-v2/digests.test.mjs tools/work-orchestrator-v2/digest-runner.test.mjs tools/work-orchestrator-v2/supabase-store.test.mjs
npm --prefix tools/work-orchestrator-v2 test
npm --prefix tools/work-orchestrator-v2 run check
```

Expected: PASS; ordinary post count is one, daily reminder post count is zero, and durable retry/reclaim/cleanup tests remain green.

- [ ] **Step 7: Commit Task 5**

```powershell
git add -- tools/work-orchestrator-v2/digests.mjs tools/work-orchestrator-v2/digests.test.mjs tools/work-orchestrator-v2/digest-runner.mjs tools/work-orchestrator-v2/digest-runner.test.mjs tools/work-orchestrator-v2/supabase-store.mjs tools/work-orchestrator-v2/supabase-store.test.mjs
git commit -m "feat: render compact owner work reports"
```

---

### Task 6: Make P0 buttonless and bind the report-only runtime mode

**Files:**
- Modify: `tools/kakao-dom-bridge/server.mjs`
- Modify: `tools/kakao-dom-bridge/server.test.mjs`
- Modify: `tools/work-orchestrator-v2/contracts.mjs`
- Modify: `tools/work-orchestrator-v2/contracts.test.mjs`
- Modify: `scripts/windows/windows-runtime-config.mjs`
- Modify: `apps/follow-up-dashboard/README.md`

**Interfaces:**
- `buildP0SlackEscalationMessage` returns one header/section/context message and no action elements.
- New strict environment booleans:
  - `WORK_ORCHESTRATOR_V2_REPORT_ONLY_ENABLED`
  - `WORK_ORCHESTRATOR_V2_HEYBILLI_ACTIONS_READY`
- v2 target mode is valid only when both are `1` and `SLACK_ACTION_POLL_ENABLED=0`.

- [ ] **Step 1: Write P0 payload RED tests**

```js
const message = buildP0SlackEscalationMessage(row, claim, { dashboardUrl });
assert.match(message.text, /긴급 후속조치/);
assert.match(message.text, /헤이빌리에서 처리/);
assert.equal(JSON.stringify(message).includes('village_work_v2_ack_p0'), false);
assert.equal(JSON.stringify(message).includes('actions'), false);
assert.equal(JSON.stringify(message).includes('button'), false);
```

Retain tests for stable client ID, exact row/generation claim, effective acknowledgement stop, terminal stop, retry/backoff, ambiguity reconciliation, and no blind repost.

- [ ] **Step 2: Write exact runtime-mode RED tests**

Reject these partial configurations:

```js
{ reportOnly: true, heybilliActionsReady: false, slackActionPoll: false }
{ reportOnly: false, heybilliActionsReady: true, slackActionPoll: false }
{ reportOnly: true, heybilliActionsReady: true, slackActionPoll: true }
```

Accept only the exact report-only target and exact legacy rollback. Assert health exposes booleans only and never a URL, token, user ID, or database detail.

- [ ] **Step 3: Run P0/config tests to prove RED**

Run:

```powershell
node --test --test-name-pattern="P0|report-only|runtime mode" tools/kakao-dom-bridge/server.test.mjs tools/work-orchestrator-v2/contracts.test.mjs
```

Expected: FAIL because P0 still contains `village_work_v2_ack_p0` and the readiness flags are absent.

- [ ] **Step 4: Remove P0 actions while retaining durable settlement**

Delete the P0 `actions` block construction only. Keep claim, history search, post, settlement, exact Slack coordinate, retry, and acknowledgement eligibility logic unchanged. Build the category/type labels from the validated row taxonomy and include only title, recommended action, and the HTTPS Heybilli link.

- [ ] **Step 5: Implement strict report-only configuration**

Extend `resolveWorkOrchestratorV2CutoverConfig` with the two booleans. In v2 mode require report-only, Heybilli readiness, dashboard readback, P0 cutover, v2 digest, no legacy cards, no immediate raw notice, and no Slack action poll. Preserve the exact legacy rollback matrix.

Update `windows-runtime-config.mjs` target values but do not apply them to any live `.env` or scheduled task. Update README with target/rollback tables and state that all actions now live in Heybilli.

- [ ] **Step 6: Run bridge and contract suites GREEN**

Run:

```powershell
node --test --test-name-pattern="P0|report-only|runtime mode" tools/kakao-dom-bridge/server.test.mjs tools/work-orchestrator-v2/contracts.test.mjs
npm --prefix tools/kakao-dom-bridge test
npm --prefix tools/kakao-dom-bridge run check
```

Expected: PASS; every v2 P0 fixture posts at most once and contains zero interactive elements.

- [ ] **Step 7: Commit Task 6**

```powershell
git add -- tools/kakao-dom-bridge/server.mjs tools/kakao-dom-bridge/server.test.mjs tools/work-orchestrator-v2/contracts.mjs tools/work-orchestrator-v2/contracts.test.mjs scripts/windows/windows-runtime-config.mjs apps/follow-up-dashboard/README.md
git commit -m "feat: move owner actions out of Slack"
```

---

### Task 7: Cross-surface verification and cutover handoff

**Files:**
- Modify only if a directly failing regression requires it: files already listed in Tasks 1–6.
- Verify: `docs/superpowers/specs/2026-09-05-heybilli-action-inbox-design.md`
- Verify: `docs/superpowers/plans/2026-09-05-heybilli-action-inbox.md`

**Interfaces:**
- Consumes all prior task contracts.
- Produces a clean feature branch plus exact offline evidence; it does not perform live cutover.

- [ ] **Step 1: Run the complete offline suites**

```powershell
npm --prefix tools/work-orchestrator-v2 test
npm --prefix tools/work-orchestrator-v2 run check
npm --prefix tools/kakao-dom-bridge test
npm --prefix tools/kakao-dom-bridge run check
npm --prefix apps/today-dashboard test
npm --prefix apps/today-dashboard run build
node --test tools/ai-browser-worker/worker.test.mjs
```

Expected: zero failures. Existing platform skips must be enumerated rather than called passes.

- [ ] **Step 2: Run exact static safety probes**

```powershell
rg -n '"type"\s*:\s*"actions"|action_id|village_work_v2_ack_p0' tools/work-orchestrator-v2/digests.mjs tools/kakao-dom-bridge/server.mjs
rg -n 'automation_error_review|reservation_review_timeout' apps/today-dashboard/components/FollowUpView.tsx tools/work-orchestrator-v2/digests.mjs
git diff --check origin/main...HEAD
```

Expected: the first two searches return no owner-facing renderer hits; any validation/test constant hit must be read and justified. Diff check exits 0.

- [ ] **Step 3: Verify no browser secret and exact API behavior**

Inspect the production build output and route tests. Confirm the browser code contains no `SUPABASE_SERVICE_ROLE_KEY`, no `requestedBy` input, and no private row fields. Use the route fake to prove an authenticated actor is derived from `getAuthedUser().id`.

- [ ] **Step 4: Perform the AGENTS.md self-review**

Record:

- Original request coverage: Slack summary only, Heybilli actions, five categories, concrete badges.
- Naming and Korean copy consistency.
- No hardcoded production URL, token, or customer content.
- No GAS sheet/range/trigger changes.
- No layout break at mobile and desktop breakpoints; validate the production build.
- No live deploy occurred; mark live runtime and migration state `UNKNOWN` until integration authorization.

- [ ] **Step 5: Commit any test-only correction, then confirm clean status**

If Step 1–4 found a real defect, first add a direct failing regression, capture RED, apply the smallest fix, rerun the affected full suite, and commit only those files:

```powershell
git status --short
git diff --check origin/main...HEAD
git log --oneline origin/main..HEAD
```

Expected: tracked status clean and every commit belongs to this plan.

- [ ] **Step 6: Finish the feature branch without deploying GAS**

After the user-authorized execution is fully green, use the repository feature-branch finish path, never `endwork.sh`:

```bash
./scripts/finishbranch.sh "feat: make Heybilli the owner action inbox"
```

Expected: feature branch commit/push succeeds; no `clasp push`, `clasp deploy`, main merge, Vercel deploy, live migration, Slack send, or runtime restart occurs.

- [ ] **Step 7: Hand off the separately authorized integration checklist**

Do not execute these during feature implementation. Report them as the next integration session:

1. Apply the additive Supabase migration and verify function ACLs/readback.
2. Deploy Today Dashboard with v2 dashboard/read/action config.
3. Verify authenticated Heybilli counts, category labels, one non-destructive action, stale CAS, and refresh.
4. Deploy bridge/runner in report-only target mode.
5. Read back one scheduled Slack digest and one test P0 payload only when the user explicitly authorizes sends.
6. Confirm action blocks are zero, disable old action runtime, observe health, then integrate to `main` through `scripts/integrate.sh`.
