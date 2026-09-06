# Heybilli inquiry case cards implementation plan

**Goal:** Replace flat technical work cards with one owner-readable inquiry card containing independently actionable business steps, inquiry date/time, and age.

**Architecture:** Preserve `work_items_v2` as the mutation source of truth. Add a read-only service RPC that groups eligible rows into inquiry cases before counts and pagination, emits only bounded owner-safe fields, and keeps exact id/version on each step. Switch Today Dashboard API/model/UI to the case contract and reload after per-step actions.

**Tech:** PostgreSQL/Supabase RPC, PGlite, Next.js/React/TypeScript, Node test runner.

## Global constraints

- Work only in `codex/heybilli-inquiry-cards` linked worktree.
- Do not touch the unrelated dirty worker/GAS changes in main.
- Add tests and capture RED before each production slice.
- Do not deploy, push, send messages, or mutate live business data during implementation.
- Use additive migration; retain the old inbox RPC.
- New RPC is service-role-only, `SECURITY INVOKER`, empty `search_path`.

## Task 1: Database inquiry-case read model

**Files:**

- Create: `supabase/migrations/<timestamp>_work_orchestrator_v2_heybilli_cases.sql`
- Modify: `tools/work-orchestrator-v2/schema.test.mjs`
- Modify: `tools/work-orchestrator-v2/pglite-schema.test.mjs`

1. Add static tests for the exact function signature, security mode, empty search path, and service-role-only ACL.
2. Add PGlite fixtures for one 22-minute same-room inquiry, one later inquiry, multi-category membership, excluded technical work, pagination after grouping, and privacy fields.
3. Run focused tests and record the missing-function RED.
4. Implement `list_heybilli_owner_cases_v2` with strict inputs, finite-evidence checks, 30-minute rolling sessions, case-level state/order/counts, safe title/brief, and bounded step JSON.
5. Run focused tests to GREEN.

## Task 2: Store and API exact case contract

**Files:**

- Modify: `tools/work-orchestrator-v2/supabase-store.mjs`
- Modify: `tools/work-orchestrator-v2/supabase-store.test.mjs`
- Modify: `apps/today-dashboard/app/api/follow-ups/route.ts`
- Modify: `apps/today-dashboard/test/workOrchestratorFollowUpsRoute.test.mjs`

1. Add exact-shape store/API tests for cases, steps, overlapping category counts, cursors, bounds, and privacy rejection.
2. Run focused tests and record RED against the old flat RPC/validator.
3. Implement the shared case response validator and `listOwnerCases` store method.
4. Switch GET to `list_heybilli_owner_cases_v2`; keep PATCH per step unchanged.
5. Remove client-side legacy dedupe from the v2 GET path.
6. Run focused tests to GREEN.

## Task 3: Presentation model and date/age

**Files:**

- Modify: `apps/today-dashboard/lib/followups/inbox-model.mjs`
- Modify: `apps/today-dashboard/test/followUpInboxModel.test.mjs`

1. Add tests for case selection, overlapping category counts, exact step action bodies, KST inquiry date/time, today/yesterday/N-day calendar labels, and invalid clocks.
2. Run focused tests and record RED.
3. Implement the pure case inbox model and deterministic Korean time labels using the supplied clock.
4. Run focused tests to GREEN.

## Task 4: Owner-report card UI

**Files:**

- Modify: `apps/today-dashboard/components/FollowUpView.tsx`
- Modify: `apps/today-dashboard/test/followUpInboxModel.test.mjs`

1. Add source-contract tests for one case card, checklist steps, received/age labels, safe section headings, and absence of raw diagnostic sections.
2. Run the source tests and record RED.
3. Replace flat work rendering with compact case rows and checklist detail; invoke mutations with the selected step.
4. Keep responsive master-detail/mobile bottom-sheet behavior.
5. Run focused tests and production build to GREEN.

## Task 5: Full verification and delivery

1. Run Work Orchestrator full tests/checks and Today Dashboard full tests/build.
2. Run explicit syntax checks and `git diff --check`.
3. Self-review grouping boundaries, action-version safety, privacy, Korean wording, empty/loading/error states, and no unrelated changes.
4. Run `scripts/finishbranch.sh` with a concise commit message.
5. Integrate/deploy only from main through `scripts/integrate.sh` after confirming the unrelated main dirt is no longer a blocker; then perform real browser readback without customer-side mutations.

