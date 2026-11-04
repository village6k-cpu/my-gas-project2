# Hermes card payment audit repair

The Slack payment investigation stopped at a valid reservation because the
generic finance lookup searched for finance sheets in the reservation GAS
project. A fallback PostgreSQL connection timed out. The existing HTTPS
Supabase credentials worked, but the agent searched the public schema rather
than the canonical `village` payment ledger.

Added a standalone native Hermes skill at
`scripts/hermes/village-card-payment-audit`. It resolves accounts by trade ID or
exact customer and checkout date, reads the current GAS billing snapshot, joins
allocations/receipts/processor aliases/events over HTTPS, and reports distinct
approvals, cancellations and excess received. It never mutates financial data.
Terminal and Toss aliases for one receipt count only once. Historical opening
balances, split allocations, missing provider evidence and changed billing stay
explicit.

Installed identical copies in the current Mac root and Kakao worker skill
directories. The existing root `village-receivables-audit` skill now routes
duplicate-card investigations to this command before requesting screenshots.
The broad Windows-only operations skill was not enabled on Mac; this payment
path uses a separately verified native skill. No gateway restart was needed.

Verification:

- Nine focused tests passed, including reversal, split allocation, alias
  deduplication, incomplete data and credential-safe errors.
- Original customer/date query returned the same two distinct processor-backed
  approvals as independent direct ledger reads, with current billed amount and
  no reconciliation warnings.
- Native Hermes discovery and skill loading succeeded. A bounded Hermes run
  using the configured model selected the new skill, executed the installed
  command and returned the correct finding in three model calls.
- No refund, cancellation, customer message, Slack message or financial write.
- Cancellation status is the current ingested ledger status, not a new issuer
  inquiry. The helper reports this evidence boundary.

Local backup and detailed verification (contains customer data; do not commit):
`/Users/choijaehyeong/VillageMigration/20260930-windows/candidate/control/card-audit-repair-20261104-170220/`.
