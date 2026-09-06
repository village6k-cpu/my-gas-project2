# Heybilli Semantic Inquiry Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace time-window grouping and taxonomy-only summaries with durable AI semantic case/task identity, owner-readable business reporting, and a dismissible mobile detail sheet.

**Architecture:** The AI receives a bounded exact-room list of unresolved semantic cases and reuses their exact case/task keys when the customer continues the same issue. Reviewed metadata is persisted in the existing `work_items_v2.payload`; the database groups only by semantic case key and the Today Dashboard renders request/problem/next-action fields. Existing active rows are reconciled once with version fencing and no customer-side mutation.

**Tech Stack:** Node.js ESM, Hermes AI worker, PostgreSQL/Supabase RPC, PGlite, Next.js/React/TypeScript, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-06-heybilli-semantic-case-correction-design.md`

## Global Constraints

- Work only in `codex/heybilli-semantic-cards-v2` until verified.
- Use strict RED before every production behavior change.
- The AI owns semantic same-case/same-task judgment; do not add keyword similarity or elapsed-time grouping.
- Preserve `work_items_v2` action id/version semantics and all lifecycle fields.
- Do not expose raw messages, phone numbers, room/source keys, payloads, internal IDs, or technical errors to the browser.
- Every new database function is `SECURITY INVOKER`, `search_path = ''`, explicitly schema-qualified, and service-role-only.
- No Kakao/Slack send, reservation/inventory/document mutation, or live data reconciliation before code/tests pass and exact targets are reread.

---

### Task 1: AI semantic owner-case contract

**Files:**
- Modify: `tools/ai-browser-worker/worker.mjs`
- Modify: `tools/ai-browser-worker/worker.test.mjs`

**Interfaces:**
- Consumes: `ownerCaseContext` containing exact active `caseKey` and `taskKey` values for one room.
- Produces: validated `decision.owner_case` and `follow_up_items[].taskKey` values copied into follow-up row payloads.

- [ ] **Step 1: Write the failing tests**

Add fixtures equivalent to the three Jeong Apple-box paraphrases and one later NUC/slider inquiry. Assert the prompt contains the bounded existing-case context and explicit reuse rules; assert `follow_upRowsFromDecision` preserves the exact owner case fields and existing task key without inferring from text.

- [ ] **Step 2: Run the focused RED**

Run: `node --test --test-name-pattern="semantic owner case" worker.test.mjs`

Expected: FAIL because `owner_case` and `ownerCaseContext` are not part of the current contract.

- [ ] **Step 3: Implement the minimal contract**

Extend the decision schema/prompt validator with exact keys:

```js
owner_case: {
  caseKey,
  title,
  requestSummary,
  problemSummary,
  nextActionSummary
}
```

Bound the fields, preserve them in follow-up payloads, and include the exact-room context in `buildHermesPrompt` with the reuse/new-case rules from the spec.

- [ ] **Step 4: Run the focused GREEN**

Run the same command and require all selected tests to pass.

### Task 2: Safe payload and exact-room context store

**Files:**
- Modify: `tools/work-orchestrator-v2/work-items.mjs`
- Modify: `tools/work-orchestrator-v2/work-items.test.mjs`
- Modify: `tools/work-orchestrator-v2/supabase-store.mjs`
- Modify: `tools/work-orchestrator-v2/supabase-store.test.mjs`
- Create: `supabase/migrations/20260906190000_work_orchestrator_v2_semantic_owner_cases.sql`
- Modify: `tools/work-orchestrator-v2/schema.test.mjs`
- Modify: `tools/work-orchestrator-v2/pglite-schema.test.mjs`

**Interfaces:**
- Produces: `listOwnerCaseContext({roomKey, limit})` and reviewed owner metadata on work candidates.
- Preserves: `upsertWorkItem(candidate)` and exact work action CAS.

- [ ] **Step 1: Write work-item/store/schema/PGlite RED tests**

Assert the seven owner metadata fields survive the reviewed allowlist with exact length/type checks. Assert exact-room context returns only bounded case/task/business summaries, is service-role-only, and never returns raw evidence. Assert same `work_key` merges without changing age/action/P0 state.

- [ ] **Step 2: Run the focused RED**

Run:

`node --test work-items.test.mjs supabase-store.test.mjs schema.test.mjs pglite-schema.test.mjs`

Expected: the new metadata/context assertions fail while existing tests remain green.

- [ ] **Step 3: Implement the minimal payload/context path**

Extend `safePayload` and SQL upsert allowlists. Add `list_heybilli_owner_case_context_v2(p_room_key text, p_limit integer)` as a read-only service RPC. Add the exact store validator/method. Load it only for the current room before building the Hermes prompt; a read failure produces a typed unavailable context rather than a time heuristic.

- [ ] **Step 4: Run focused GREEN**

Require the four focused files to pass.

### Task 3: Semantic case read model and meaningful summaries

**Files:**
- Modify: `supabase/migrations/20260906190000_work_orchestrator_v2_semantic_owner_cases.sql`
- Modify: `tools/work-orchestrator-v2/schema.test.mjs`
- Modify: `tools/work-orchestrator-v2/pglite-schema.test.mjs`
- Modify: `tools/work-orchestrator-v2/supabase-store.mjs`
- Modify: `tools/work-orchestrator-v2/supabase-store.test.mjs`

**Interfaces:**
- Replaces: time-window grouping inside `list_heybilli_owner_cases_v2`.
- Produces per case: `requestSummary`, `problemSummary`, `nextActionSummary` plus existing safe counts/steps.

- [ ] **Step 1: Write the direct semantic grouping RED**

Create PGlite rows proving:

- same semantic case key across more than 30 minutes becomes one case;
- different semantic case keys in the same room and minute remain separate;
- duplicate task keys converge to one step;
- Jeong Apple-box text becomes one readable case while NUC/slider remains separate;
- Yoon output contains model-selection/unconfirmed facts and excludes `confirmation_request`, RQ IDs, phone numbers, and raw payload.

- [ ] **Step 2: Run RED**

Run the selected semantic-case test pattern and require failures against the 30-minute/taxonomy implementation.

- [ ] **Step 3: Implement semantic grouping**

Partition only by reviewed `owner_case_key`. Isolate rows without it by row id. Select the latest reviewed owner report fields for the case, retain strongest priority/state ordering, and emit exact bounded summaries. Remove the elapsed-time session CTE from the new function body.

- [ ] **Step 4: Run GREEN**

Require schema, PGlite, and store tests to pass.

### Task 4: API/model/UI report and mobile dismissal

**Files:**
- Modify: `apps/today-dashboard/app/api/follow-ups/route.ts`
- Modify: `apps/today-dashboard/test/workOrchestratorFollowUpsRoute.test.mjs`
- Modify: `apps/today-dashboard/lib/followups/inbox-model.mjs`
- Modify: `apps/today-dashboard/test/followUpInboxModel.test.mjs`
- Modify: `apps/today-dashboard/components/FollowUpView.tsx`

**Interfaces:**
- Consumes exact semantic case response.
- Renders `고객 요청`, `현재 문제`, `처리할 일` and exact per-task actions.

- [ ] **Step 1: Write API/model/UI RED tests**

Assert exact new fields and unsafe text rejection. Assert owner-facing business words remain visible. Source/behavior tests must prove a visible close button, backdrop close, Escape listener, header-only downward swipe threshold, and background scroll restoration.

- [ ] **Step 2: Run RED**

Run: `npm test -- --test-name-pattern="semantic inquiry|mobile detail dismissal"`

Expected: FAIL on missing fields and close behavior.

- [ ] **Step 3: Implement the report UI**

Render the three report sections with concise typography and a single deduplicated task checklist. Add a fixed backdrop, visible close button, Escape effect, header pointer/touch tracking with a downward threshold, and body overflow cleanup.

- [ ] **Step 4: Run GREEN and build**

Run the focused tests, full Today Dashboard tests, and `npm run build`.

### Task 5: Existing active-card reconciliation

**Files:**
- Create: `tools/work-orchestrator-v2/reconcile-owner-cases.mjs`
- Create: `tools/work-orchestrator-v2/reconcile-owner-cases.test.mjs`
- Modify: `tools/work-orchestrator-v2/supabase-store.mjs`
- Modify: `tools/work-orchestrator-v2/supabase-store.test.mjs`
- Modify: `supabase/migrations/20260906190000_work_orchestrator_v2_semantic_owner_cases.sql`

**Interfaces:**
- Consumes a reviewed semantic assignment with exact work ids/versions.
- Produces a dry-run plan or a fenced metadata/task convergence result; no customer-side action.

- [ ] **Step 1: Write reconciliation RED tests**

Assert dry-run by default, exact id/version checks, preservation of lifecycle fields, duplicate-task merge only, no cross-room assignment, no messaging API, and stale-version no-op. Include the exact Jeong/Yoon sanitized fixtures.

- [ ] **Step 2: Run RED**

Run: `node --test reconcile-owner-cases.test.mjs supabase-store.test.mjs pglite-schema.test.mjs`

Expected: FAIL because the fenced reconciliation surface does not exist.

- [ ] **Step 3: Implement and verify locally**

Add a service-only atomic RPC that updates only reviewed owner metadata and converges an exact duplicate task under id/version locks while preserving the canonical lifecycle. Build a dry-run tool that prints only ids, versions, selected case keys, and counts.

- [ ] **Step 4: Inspect the live dry-run before mutation**

Read current active rows, generate the semantic plan, and verify the Jeong/Yoon cases plus total merge counts. Do not apply until code, PGlite, and dry-run shape are green.

### Task 6: Full verification, integration, deployment, and readback

- [ ] Run full Work Orchestrator, AI worker, Today Dashboard tests and checks.
- [ ] Run Today Dashboard production build and `git diff --check`.
- [ ] Self-review original screenshots: meaningful facts retained, duplicate inquiries collapsed, distinct later inquiry preserved, and sheet dismisses four ways.
- [ ] Finish the feature branch with `scripts/finishbranch.sh`.
- [ ] Integrate from clean `main` with `scripts/integrate.sh`; apply the additive Supabase migration and deploy Today Dashboard through the existing production path.
- [ ] Run the reviewed active-card reconciliation with exact version fencing.
- [ ] Read back the live RPC and production UI for Jeong and Yoon without clicking work actions or sending customer messages.
- [ ] Report deployment IDs, migration name, live counts, exact tests, and any UNKNOWN/BLOCKED evidence.
