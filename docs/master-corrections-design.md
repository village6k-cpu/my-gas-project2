# Verified standing corrections to authoritative catalog

Only explicit standing owner decisions enter master data. Trade exceptions remain trade-scoped. No historical inferred price is promoted. A caller must inspect the authenticated owner's original message; a boolean is not independent proof.

## Boundary
Dedicated internal-only POST `masterCorrection`, never generic write permission expansion. Preview is read-only. Apply requires `correctionId` (16–80 alphanumeric/hyphen), source ref/quote and verifiedOwner attestation, scope standing, exact target, expectedRevision from preview. Kind price updates one G cell; create appends complete set rows with explicit KRW/day integer price and known existing equipment components; component appends known equipment to an existing set. Explicit zero is valid, blank invalid. Current nonblank differing price needs replace.approved and exact replace.expectedPrice. Multiple price cells or formula price require manual review. Inventory quantities/status, existing reservations, and physical equipment identities are not created or changed.

## Persistence and concurrency
ScriptLock serializes this action. Snapshot hash checks before planning and immediately before mutation detect stale snapshots, but do NOT provide atomic compare-and-swap against manual Sheets editors or other writers. A prepared write-ahead receipt is flushed in a new dedicated 마스터정정이력 sheet before a single-range master write. Readback verifies entire snapshot. Then receipt becomes verified. Receipt and master are NOT atomic. Retry compares digest and actual intended values, recovers a completed write, and never blindly appends again after an uncertain operation. Ambiguous/changed receipt requires manual review. Audit source strings are prefixed to prevent formula injection. Existing sheet columns remain unchanged.

## Workflow
Read owner correction and classify trade/standing/ambiguous. For standing use the action preview, inspect exact existing target and proposed write, then apply same payload plus expectedRevision. If source scope or existing price replacement unclear, ask only that missing decision. Never promote a customer message to owner authority. Never report saved before verified readback. Preserve correctionId across retries.

## Downstream synchronization
After master readback, refreshEquipmentList rebuilds the derived 목록 and its dropdown validations (not reservation values). A narrow template helper changes only the exact product price cell or appends the A/B product/price pair. It does not invoke the old wholesale template reset or touch document formulas. Both target presence and price are read back. Failure returns master_saved_sync_pending and same correctionId resumes synchronization without repeating the master mutation. Existing template schema/formula/duplicate anomalies stop sync. No bridge restart required. Physical stock additions remain inventory workflow, not fabricated stock.

## Validation / deployment
Live headers were read and match A:G set fields and equipment D names. Official startwork passed; isolated feature worktree. Unit/in-memory adapter tests run with zero live master writes. Deploy only through repository finishbranch/integrate process and check live preview/capabilities afterward. No real correction values may be fabricated for smoke tests.

## Open deployment gates (2026-11-12)
- Existing refreshEquipmentList uses whole-sheet clear and lacks shared writer lock. Do NOT activate automatic downstream path until narrowed and concurrency reviewed. No live mutation/deployment yet.
- Baseline confirmed-reservation-commit.behavior.test.js fails 7 tests in unchanged main and feature. Official integrate gate must not be bypassed.
- Active Hermes skills not yet changed to call this candidate.
