# Full Inventory Audit Implementation Plan

> **Required subskill:** Use `superpowers:subagent-driven-development` to execute this plan task by task, with `superpowers:test-driven-development`, `superpowers:using-git-worktrees`, and `superpowers:verification-before-completion` applied throughout.

**Goal:** Deliver a production-ready HeyBilly inventory-audit mode that lets one logged-in employee complete a detailed, blind, full-shop count in roughly three hours while keeping every observation staged until an owner explicitly approves it.

**Architecture:** Add a separate audit domain beside the existing ledger. Server routes create a hidden cutoff snapshot, accept idempotent staff observations, expose owner-only reconciliation, and invoke one service-only PostgreSQL transaction for final approval. `InventoryView` remains the entry point and delegates the staff and owner experiences to new components. Draft text is dual-written to the API and IndexedDB; evidence photos use a private Supabase Storage bucket and an IndexedDB retry queue.

**Tech Stack:** Next.js 15 App Router, React 19, TypeScript, Supabase Postgres/RLS/Storage/Auth, `@supabase/supabase-js`, IndexedDB, Node built-in test runner, Vercel.

---

## Task 1: Create the isolated implementation worktree and baseline checks

**Files:**
- Verify only: `apps/today-dashboard/package.json`
- Verify only: `apps/today-dashboard/components/InventoryView.tsx`
- Verify only: `apps/today-dashboard/supabase/equipment-ledger.sql`

**Step 1: Preserve the approved design commits**

Push the current `main` commits without staging the pre-existing user changes in `seed.ts` or `sheetAPI.js`.

**Step 2: Create a worktree**

Create branch `codex/full-inventory-audit` at the current approved-design commit in `/Users/choijaehyeong/my-gas-project2-worktrees/full-inventory-audit`.

**Step 3: Run the existing baseline**

Run:

```bash
cd apps/today-dashboard
npm run build
node --test test/*.test.js
```

Expected: build and existing tests pass before feature edits.

**Step 4: Commit**

No feature commit is required for this setup-only task.

## Task 2: Define audit types and pure reconciliation rules with tests

**Files:**
- Create: `apps/today-dashboard/lib/inventory-audit/types.ts`
- Create: `apps/today-dashboard/lib/inventory-audit/logic.ts`
- Create: `apps/today-dashboard/test/inventoryAuditLogic.test.mjs`
- Modify: `apps/today-dashboard/package.json`

**Step 1: Write failing tests**

Cover location aggregation, mutually exclusive bucket totals, explicit zero versus uncounted, confirmed-rental-only candidate totals, issue classification, and ledger-version conflicts.

```js
test("explicit zero is counted while no observation is uncounted", () => {
  assert.equal(reconcileItem(snapshot, [] ).classification, "uncounted");
  assert.equal(reconcileItem(snapshot, [zeroObservation]).physicalTotal, 0);
});
```

Run `node --test test/inventoryAuditLogic.test.mjs`; expected failure because the module does not exist. The production Node 22 runtime can import the dependency-free TypeScript module directly, so the test exercises the real implementation rather than a copied JavaScript version.

**Step 2: Implement pure functions**

Export:

```ts
export function observationTotal(row: CountBuckets): number;
export function aggregateObservations(rows: AuditObservation[]): ObservationAggregate;
export function reconcileItem(snapshot: SnapshotItem, rows: AuditObservation[], decision?: AuditDecision): ReconciledItem;
export function hasLedgerConflict(snapshot: SnapshotItem, current: LedgerVersion): boolean;
```

`candidateTotal` must be `null` for uncounted items and otherwise equal physical total plus only `rental_match_status === "matched"` quantities plus owner-confirmed other offsite quantity.

**Step 3: Run the focused tests**

Run `node --test test/inventoryAuditLogic.test.mjs`; expected all pass.

**Step 4: Add the test script**

Add `"test": "node --test test/*.test.js test/*.test.mjs"` to the dashboard package.

**Step 5: Commit**

```bash
git add apps/today-dashboard/lib/inventory-audit apps/today-dashboard/test/inventoryAuditLogic.test.mjs apps/today-dashboard/package.json
git commit -m "test: define inventory audit reconciliation"
```

## Task 3: Add the Supabase audit schema, RLS, storage, and approval transaction

**Files:**
- Create: `apps/today-dashboard/supabase/migrations/202607140001_full_inventory_audit.sql`
- Create: `apps/today-dashboard/supabase/inventory-audit-security-check.sql`
- Create: `apps/today-dashboard/test/inventoryAuditMigration.test.js`

**Step 1: Write a failing migration contract test**

Read the SQL as text and assert the required tables, constraints, RLS policies, private bucket, draft ledger lock, transaction function, and revoked public execution exist.

```js
assert.match(sql, /create table[^;]+inventory_audit_sessions/is);
assert.match(sql, /revoke execute on function village\.approve_inventory_audit/i);
assert.match(sql, /inventory-audit-evidence/);
```

Run `node --test test/inventoryAuditMigration.test.js`; expected failure.

**Step 2: Create the four audit tables**

Implement the approved columns and checks for:

```sql
village.inventory_audit_sessions
village.inventory_audit_snapshot_items
village.inventory_audit_observations
village.inventory_audit_decisions
```

Use non-negative count checks, exclusive existing-versus-temporary identity checks, unique decision indexes, and update timestamps.

**Step 3: Add RLS and the private storage bucket**

Staff can select their own session metadata and mutate only their own draft observations. Snapshot and decision rows are inaccessible to browser roles. The bucket is private; authenticated users may write only to paths whose session belongs to them and is still `draft`.

**Step 4: Add the draft-session ledger lock**

Replace the broad `equipment_ledger` authenticated mutation policy with separate read/insert/update/delete policies whose write predicates require no active `full_shop` draft. Service role remains the approval path.

**Step 5: Add the service-only approval function**

Implement:

```sql
create function village.approve_inventory_audit(p_session_id uuid, p_approved_by uuid, p_approved_by_email text)
returns jsonb
language plpgsql
security definer
set search_path = village, public
```

The function locks the session and decisions, re-checks ledger `updated_at`, refuses missing decisions or unresolved temporary observations, creates approved new equipment when requested, updates every approved ledger row, inserts `equipment_events`, and changes the session to `approved` in the same transaction. Revoke from `PUBLIC`, `anon`, and `authenticated`; grant only to `service_role`.

Also add service-only `start_inventory_audit` and `request_inventory_audit_recount` functions so session plus snapshot creation and recount-session creation are atomic rather than TypeScript loops that can leave partial rows.

**Step 6: Add a read-only security verification query**

The check file must report table RLS flags, policies, bucket privacy, and function ACL without writing state.

**Step 7: Run the contract test**

Run `node --test test/inventoryAuditMigration.test.js`; expected pass.

**Step 8: Commit**

```bash
git add apps/today-dashboard/supabase apps/today-dashboard/test/inventoryAuditMigration.test.js
git commit -m "feat: add inventory audit database contract"
```

## Task 4: Build server authentication and Supabase helpers

**Files:**
- Modify: `apps/today-dashboard/lib/server/authCache.ts`
- Create: `apps/today-dashboard/lib/server/inventoryAuditAuth.ts`
- Create: `apps/today-dashboard/lib/server/inventoryAuditDb.ts`
- Create: `apps/today-dashboard/test/inventoryAuditAuth.test.mjs`

**Step 1: Write failing owner-email parser tests**

Test whitespace, case normalization, multiple comma-separated emails, missing env behavior, and verified-user matching.

**Step 2: Extend verified-user lookup**

Add a helper that returns the actual Supabase `User`, not only a boolean:

```ts
export async function getAuthedUser(req: NextRequest): Promise<User | null>;
```

Keep the current 60-second token cache and make `isAuthedRequest` delegate to it.

**Step 3: Implement owner gating**

`requireInventoryUser` returns the verified user. `requireInventoryOwner` compares the verified email to `INVENTORY_OWNER_EMAILS`; no request-provided email is trusted.

**Step 4: Implement a server-only service client**

Create a `village` schema client using `SUPABASE_SERVICE_ROLE_KEY`, with session persistence disabled. Fail closed with a clear 503 if server secrets are absent.

**Step 5: Run tests and build**

Run `npm test` and `npm run build`; expected pass.

**Step 6: Commit**

```bash
git add apps/today-dashboard/lib/server apps/today-dashboard/test/inventoryAuditAuth.test.mjs
git commit -m "feat: add inventory audit server guards"
```

## Task 5: Implement session start and employee workspace APIs

**Files:**
- Create: `apps/today-dashboard/app/api/inventory-audits/route.ts`
- Create: `apps/today-dashboard/app/api/inventory-audits/start/route.ts`
- Create: `apps/today-dashboard/app/api/inventory-audits/[sessionId]/observations/route.ts`
- Create: `apps/today-dashboard/app/api/inventory-audits/[sessionId]/submit/route.ts`
- Create: `apps/today-dashboard/app/api/inventory-audits/[sessionId]/cancel/route.ts`
- Create: `apps/today-dashboard/lib/inventory-audit/snapshot.ts`
- Create: `apps/today-dashboard/test/inventoryAuditSnapshot.test.mjs`

**Step 1: Write failing rental-snapshot tests**

Verify cancelled/returned trades, pending items, excluded items, set headers, onsite items, and ambiguous names do not enter confirmed rental totals. Only `taken_qty > 0` or `checkout_state === "taken"` with a unique normalized ledger name/alias match counts.

**Step 2: Implement snapshot matching**

Export a deterministic function:

```ts
export function buildRentalSnapshot(ledgerRows, trades, scheduleItems): Map<string, RentalSnapshot>;
```

**Step 3: Implement `POST /start`**

Require a logged-in user and `movementFrozen: true`. Reuse that user's existing active draft if present. Otherwise read active ledger rows plus current trades/items, compute match results, and invoke a database RPC that atomically creates the session and complete hidden snapshot. Return only staff-safe item fields: ID, name, category, major, aliases, and progress state.

**Step 4: Implement workspace read**

`GET /api/inventory-audits` returns the caller's active draft plus safe catalog and observations, pending submitted sessions for owners, and `isOwner`. Never return snapshot quantity columns to staff responses.

**Step 5: Implement observation upsert**

Validate UUID, ownership, draft status, non-negative integers, identification identity, location, and client timestamp. Upsert by client-generated observation UUID so retries are idempotent.

**Step 6: Implement submit/cancel**

Submit is idempotent, rejects zero-observation sessions and any client-declared pending uploads, then locks observations by moving the session to `submitted`. Cancel only changes a caller-owned `draft`; it never mutates the ledger.

**Step 7: Run focused tests and build**

Run `npm test` and `npm run build`; expected pass.

**Step 8: Commit**

```bash
git add apps/today-dashboard/app/api/inventory-audits apps/today-dashboard/lib/inventory-audit apps/today-dashboard/test/inventoryAuditSnapshot.test.mjs
git commit -m "feat: add staff inventory audit APIs"
```

## Task 6: Implement evidence-photo upload and offline queues

**Files:**
- Create: `apps/today-dashboard/app/api/inventory-audits/[sessionId]/evidence/route.ts`
- Create: `apps/today-dashboard/lib/inventory-audit/offline.ts`
- Create: `apps/today-dashboard/lib/inventory-audit/evidenceQueue.ts`
- Create: `apps/today-dashboard/test/inventoryAuditOffline.test.js`

**Step 1: Write failing queue tests**

Extract and test stable queue identifiers, retry-delay selection, draft replacement by ID, and pending-count behavior.

**Step 2: Implement IndexedDB draft storage**

Store observation bodies under session and observation IDs. On successful server save, remove the pending record. On startup and `online`, resend in creation order without generating a new observation ID.

**Step 3: Implement the evidence queue**

Follow the existing `photoUploadQueue.ts` retry pattern but keep a separate database and audit-specific job shape. Compress images in the browser and retry at most five times with backoff.

**Step 4: Implement evidence API**

The employee endpoint verifies ownership and draft status, then uploads the file to `inventory-audit-evidence/{session}/{observation}/{uuid}.jpg` via the server service client and appends metadata to the observation. Owner GET returns short-lived signed URLs only after owner verification.

**Step 5: Run tests and build**

Run `npm test` and `npm run build`; expected pass.

**Step 6: Commit**

```bash
git add apps/today-dashboard/app/api/inventory-audits apps/today-dashboard/lib/inventory-audit apps/today-dashboard/test/inventoryAuditOffline.test.js
git commit -m "feat: preserve inventory audit drafts and evidence"
```

## Task 7: Build the employee full-count interface

**Files:**
- Create: `apps/today-dashboard/components/inventory-audit/InventoryAuditView.tsx`
- Create: `apps/today-dashboard/components/inventory-audit/InventoryAuditEntryCard.tsx`
- Create: `apps/today-dashboard/components/inventory-audit/InventoryAuditObservationForm.tsx`
- Create: `apps/today-dashboard/components/inventory-audit/InventoryAuditInstructions.tsx`
- Create: `apps/today-dashboard/components/inventory-audit/InventoryAuditProgress.tsx`
- Modify: `apps/today-dashboard/components/InventoryView.tsx`
- Create: `apps/today-dashboard/test/inventoryAuditUiContract.test.js`

**Step 1: Write a failing source-contract test**

Assert the staff components do not render `ledger_stock_total`, `active_rental_qty`, or labels such as `장부 수량`; assert all required fields and the seven-step employee instruction are present.

**Step 2: Add the entry card**

At the top of `InventoryView`, load audit summary state and show one of:

- `전체 재고 실사 시작`
- `전체 재고 실사 이어하기`
- `제출됨 · 승인 대기`
- owner `검토할 실사`

When a `full_shop` draft exists, disable legacy `확인`, quantity editing, add/archive/restore, and name-link mutation controls with one clear movement-freeze message.

**Step 3: Build the mobile staff view**

Show all active catalog items with search, category/major filters, `미계수/계수완료/문제` status filters, and progress. Opening an item shows no expected quantity. Allow multiple location observations per item and unlisted temporary items.

**Step 4: Build the complete observation form**

Require location and four integer count buckets. Preserve missing components, note, identification confidence, and evidence. A deliberate four-zero submission is the only way to mark a known item explicitly counted as zero.

**Step 5: Add autosave and recovery indicators**

Show `저장 중`, `저장됨`, `오프라인 보관`, and pending photo counts. Keep inputs responsive and restore local drafts on refresh.

**Step 6: Add submission guard**

Show counted versus uncounted item totals. Submission requires confirmation that the employee completed the full physical route, and is blocked while text or photos are pending. Uncounted items remain allowed only with an explicit warning because they must surface in owner review.

**Step 7: Run tests and build**

Run `npm test` and `npm run build`; expected pass.

**Step 8: Commit**

```bash
git add apps/today-dashboard/components/inventory-audit apps/today-dashboard/components/InventoryView.tsx apps/today-dashboard/test/inventoryAuditUiContract.test.js
git commit -m "feat: add blind full-shop count workflow"
```

## Task 8: Implement owner review, decisions, and transactional approval APIs

**Files:**
- Create: `apps/today-dashboard/app/api/inventory-audits/[sessionId]/review/route.ts`
- Create: `apps/today-dashboard/app/api/inventory-audits/[sessionId]/decisions/route.ts`
- Create: `apps/today-dashboard/app/api/inventory-audits/[sessionId]/approve/route.ts`
- Create: `apps/today-dashboard/app/api/inventory-audits/[sessionId]/recount/route.ts`
- Create: `apps/today-dashboard/components/inventory-audit/InventoryAuditReview.tsx`
- Create: `apps/today-dashboard/components/inventory-audit/InventoryAuditDecisionCard.tsx`
- Create: `apps/today-dashboard/test/inventoryAuditReviewContract.test.js`

**Step 1: Write failing review contract tests**

Assert owner-only guards appear before service data reads, all decision values are validated, approval calls only the transaction RPC, and no route directly loops over ledger updates.

**Step 2: Implement owner review data**

On first owner read, move `submitted` to `in_review`. Return reconciliation groups: match, quantity difference, condition/component issue, uncertain/unlisted, uncounted, ambiguous rental, and post-cutoff conflict.

**Step 3: Implement decision upsert**

Validate `apply_audit`, `keep_ledger`, or `recount`; resolution for temporary observations; non-negative final totals; and owner identity. Save reviewer and timestamp server-side.

**Step 4: Implement review UI**

Show group counts, bulk `apply_audit` for clean matches, individual exception cards, owner-editable offsite/final totals, evidence, and an unresolved-decision counter. Keep first observations immutable.

**Step 5: Implement final approval**

Require owner verification, call `approve_inventory_audit` once through the service client, return conflicts as 409, and never perform partial ledger changes in TypeScript.

**Step 6: Implement recount request**

Set the source session to `recount_requested`, create a linked draft with only requested items through an atomic RPC, and return its ID. Do not overwrite the first count.

**Step 7: Run tests and build**

Run `npm test` and `npm run build`; expected pass.

**Step 8: Commit**

```bash
git add apps/today-dashboard/app/api/inventory-audits apps/today-dashboard/components/inventory-audit apps/today-dashboard/test/inventoryAuditReviewContract.test.js
git commit -m "feat: add owner inventory audit approval"
```

## Task 9: Add sheet-mirror status and safe retry

**Files:**
- Modify: `apps/today-dashboard/supabase/sync-ledger-to-sheet.mjs`
- Create: `apps/today-dashboard/app/api/inventory-audits/[sessionId]/mirror/route.ts`
- Modify: `apps/today-dashboard/components/inventory-audit/InventoryAuditReview.tsx`
- Modify: `apps/today-dashboard/test/inventoryAuditLogic.test.mjs`

**Step 1: Add a failing mirror-status test**

Verify the sync script can be scoped to an approved session and returns a structured result without touching ledger truth.

**Step 2: Mark approval as mirror pending**

The approval transaction sets `mirror_status = 'pending'` only after ledger application succeeds.

**Step 3: Add owner-only retry**

The route invokes the existing dedicated mirror path, marks `synced` on success and `failed` with a sanitized error on failure. A failure never rolls back the approved ledger.

**Step 4: Surface status**

Show `시트 반영 대기/완료/실패` and an owner retry button.

**Step 5: Run tests, dry-run, and build**

Run:

```bash
npm test
node supabase/sync-ledger-to-sheet.mjs --dry-run
npm run build
```

Expected: tests/build pass and the dry-run writes nothing.

**Step 6: Commit**

```bash
git add apps/today-dashboard/supabase/sync-ledger-to-sheet.mjs apps/today-dashboard/app/api/inventory-audits apps/today-dashboard/components/inventory-audit apps/today-dashboard/test
git commit -m "feat: track inventory sheet mirror delivery"
```

## Task 10: Add the operational handoff artifact

**Files:**
- Create: `docs/operations/2026-07-14-full-inventory-audit-staff-instruction.md`
- Modify: `apps/today-dashboard/components/inventory-audit/InventoryAuditInstructions.tsx`

**Step 1: Write the copy-ready instruction**

Include the fixed three-hour window, full movement stop, all active inventory as the assignment, detailed required fields, no reduction of inputs, how to handle similar/unknown models without interrupting the owner, explicit zero rules, multiple-location behavior, photo expectations, pending-upload check, and the fact that submission does not change the ledger.

**Step 2: Keep in-app and message text aligned**

The in-app card is a concise checklist; the document contains the Kakao/Slack-ready message and the owner’s post-submission checklist.

**Step 3: Commit**

```bash
git add docs/operations/2026-07-14-full-inventory-audit-staff-instruction.md apps/today-dashboard/components/inventory-audit/InventoryAuditInstructions.tsx
git commit -m "docs: add tonight inventory audit handoff"
```

## Task 11: Self-review, full verification, and preview QA

**Files:**
- Review all feature files
- Modify only files required by findings

**Step 1: Review against the approved design**

Check every completion criterion in `docs/superpowers/specs/2026-07-14-full-inventory-audit-design.md`, especially blind counting, no pre-approval ledger mutation, full detail, explicit-zero semantics, offline recovery, owner gating, transactionality, and preserved first counts.

**Step 2: Run static and unit verification**

Run:

```bash
cd apps/today-dashboard
npm test
npx tsc --noEmit
npm run build
```

Expected: all pass.

**Step 3: Run a secret and diff audit**

Run `git diff --check`, inspect the complete diff, and verify no `.env` values or service-role keys are committed.

**Step 4: Deploy a Vercel preview**

Deploy the worktree and test mobile viewport behavior with an authenticated account. Confirm no ledger quantity is visible in the employee flow and a start/cancel smoke cycle leaves ledger aggregates unchanged.

**Step 5: Commit any review fixes**

```bash
git add <only reviewed feature files>
git commit -m "fix: harden inventory audit workflow"
```

## Task 12: Apply production schema, merge, deploy, and smoke test

**Files:**
- Production Supabase project: apply the versioned migration
- Vercel project: add `INVENTORY_OWNER_EMAILS` and deploy
- No source file changes unless verification finds a defect

**Step 1: Capture the pre-deploy ledger baseline**

Read row count, active count, total stock, maintenance stock, and status counts. This is a read-only checkpoint.

**Step 2: Apply the migration and security checks**

Apply the migration once through the authenticated Supabase project tooling. Run the read-only security check and confirm RLS, private storage, and function ACLs.

**Step 3: Re-run the application build and audit tests against production schema**

Create and cancel a test audit draft only; do not approve it. Verify the ledger baseline is unchanged.

**Step 4: Push and merge the feature branch**

Push `codex/full-inventory-audit`, merge through the repository’s safe integration path, and preserve the unrelated local changes in the original dirty main worktree.

**Step 5: Deploy production**

Deploy the merged dashboard to the canonical alias `https://today-dashboard-ten.vercel.app/`.

**Step 6: Production smoke test**

Verify:

1. logged-out access is gated;
2. staff sees the start card and no expected quantities;
3. owner sees owner review affordances;
4. start/resume/cancel works on mobile;
5. a cancelled draft leaves all ledger baseline aggregates unchanged;
6. evidence bucket is private;
7. legacy ledger writes are blocked only during a draft full-shop session and released after cancellation/submission.

**Step 7: Final handoff**

Report the live URL, actual verification evidence, any external blocker, and paste the employee instruction verbatim. Do not describe production as ready unless schema, alias, and authenticated smoke checks all succeeded.
