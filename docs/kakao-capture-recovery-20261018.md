# Kakao pre-enqueue capture failure recovery

## Verified failure chain

A customer event was accepted on 2026-10-17 at 22:59 KST. Conversation capture
failed before Gateway enqueue, including its bounded retry. The event became
`needs_human_review`, but legacy follow-ups were disabled and v2 classified the
failure as `operational_only`: zero durable reconciliation cases were created.
The watchdog subsequently cleared its incident based on connection health alone.

The original browser failure cannot be reconstructed from the old generic error.
A current read-only capture succeeded. This patch does not claim that all browser
disconnects are eliminated.

## Changes

- Capture failures alone receive a P0 `human_review` reconciliation case, keyed by
  the exact source job. Generic technical failures remain outside owner work.
- Empty follow-up output no longer proves delivery. Persisted v2 case receipts
  are accepted; storage failures remain failures.
- `/health.captureBacklog` independently checks failed pre-enqueue source events.
  Unknown, partial, or failed database reads never mean zero backlog.
- Exact room/source-bound owner completion or authoritative operation readback
  can reconcile a case. Dismissal, stale completion, or unrelated receipts cannot.
- `kakao-runtime-incident --healthy` checks backlog before closing an incident.
  A busy lock or unresolved/unknown backlog exits nonzero. The incident lock stays
  held until asynchronous delivery/readback completes.
- Future capture failures persist bounded navigation status, hint match, message
  count and attempt count, without conversation text or credentials.

## Automatic capture continuation (follow-up correction)

Alerting alone does not prevent omission. A verified pre-enqueue capture failure
now retains a durable `capture_retry` marker and remains automatically retryable
after the former one-retry limit. Escalation runs alongside recovery, not instead
of it. Retries use 1-5 minute backoff, the existing five-minute sweep and batch
limit, and shared oldest-first ordering. Marked unfinished captures do not age out
of the 36-hour generic recovery window. Existing historical failures are not
silently opted into this policy.

Recovery claims compare exact row ID, status and update timestamp. Empty claims
do not dispatch. Late capture failures also compare the claim before persisting,
so they cannot replace a newer handoff or resolution. Existing durable Gateway
jobs are read back without recapture or repeat execution; the source capture
marker becomes `handed_off` even when that durable job is already terminal.
Handoff is not claimed as successful registration: the existing Gateway
application, operation receipts and ledger checks still determine the outcome.

The isolated lifecycle test uses the real REST persistence code, recovery sweep
and durable Gateway channel. It covers three continued failures, process-state
loss, an older source, lost claims, late stale failures, restored capture without
new messages, one queue entry, restart readback and already-terminal handoff.
It does not inject failures into customer conversations or create live bookings.

## Historical reconciliation remaining

Historical database readback found 138 capture-error events in 77 rooms, dating
from August 23 to October 17. These are **unreconciled failure records**, not proof
of 138 missing reservations. Never bulk replay them or mark them complete merely
because the connection is healthy. Reconcile each with the source conversation
and authoritative booking evidence. The reported latest booking already exists.

Both source and completion queries require exact counts and are bounded at 1,000
rows. Above that bound the status is `unknown`, not falsely clear.

## Validation and deployment

Regression tests reproduce the zero-row handoff and false-green recovery, then
verify the corrected paths. Bridge tests must run from repository root because
an existing audit-backfill test uses a repository-relative fixture path.
Worker suite: 475 passed, 4 pre-existing skips. No customer message or reservation
mutation is used for validation. Promote only the changed bridge/incident files;
preserve the production worktree's unrelated changes. Restart only an idle owned
bridge, never the whole Chrome/Slack/Hermes stack. No GAS deployment is involved.
