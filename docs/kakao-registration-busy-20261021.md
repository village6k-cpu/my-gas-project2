# Confirmed reservation lost after a zero-write lock failure

## Verified failure

Room `chat:4985249027026699` contained the staff-confirmed three-item plan for
October 21 14:00 through October 23 14:00 and the customer's acceptance. The
fresh capture passed `trigger_message_observed`; this was not the preceding
stale-capture defect.

Gateway job `dom-857df92d5c78017c` attempted registration. Receipt
`adf2da0d-7d00-4381-b516-afc7b128d04a` proved `registration_busy`, `preflight`,
no applied/replaced stages, no new request/trade, and no customer notification.
The GAS client made three bounded attempts, but the Gateway finalized the
model turn and retained only owner review. It had no durable continuation for
this proven temporary failure. Model completion was not business completion.

## Repair

- Persist a pending continuation atomically with a strictly proven zero-write
  lock receipt. Do not infer replay safety from an error string alone.
- Resume one continuation at a time, after the native turn has finished and the
  gateway is idle. Re-capture the exact room and require unchanged conversation.
- Reuse the sealed AI approval, operation ID, digest, and original baseline.
  GAS checks the pending request and registered state again under its lock.
- Persist the mutation fence before execution. A crash after that point or any
  ambiguous/partial result is blocked for readback, never automatically replayed.
- Keep lock failures pending with backoff. Preserve prior zero-write receipts
  in the retry history and retain one effective receipt for ordinary validation.
- After authoritative success, restore the sealed approval in the final result
  and use the existing no-send result-application pipeline. Projection failure
  leaves a durable pending application, not another business write.
- Expose pending/active/blocked retry states in health. Active continuations count
  as claimed work so existing lifecycle scripts do not restart over a write.

Historical failed jobs are not bulk-enrolled or replayed. A later room revision
supersedes a pending continuation; changed conversation requires fresh AI review.

## Incident recovery

Live room and GAS readback proved the original request still contained only the
Delta2 at 13:00, with no new trade. The official live-registration command reused
operation `55781840-b949-46ba-a251-d9159962992b`, bound fresh conversation evidence,
and recovered the final full plan once:

- Original request `RQ-261021-002` replaced by `RQ-261021-005`.
- Trade `261021-004`; October 21 14:00 through October 23 14:00.
- Solidcom SE 4S, reflector, EcoFlow Delta2: one each, plus AC cable component.
- Success receipt `e8db7dfe-369e-4ce9-b2e5-169ab9497079`.
- Independent GAS and Supabase dashboard readback verified four rows and contract.
- Customer notifications attempted/sent: false.

The ledger reports Solidcom SE 4S overlapping another booking through October 22
00:00. The owner card was updated with the successful registration evidence while
keeping this supply check and the reflector stock check open. Registration does
not prove physical equipment availability.

## Verification

Regression tests cover persistence/restart, zero-write proof exclusions, supersession,
capture failure, changed conversation, unknown execution outcomes, repeat lock failure,
same-operation fencing, success projection, and no customer send. The existing Gateway,
HTTP, server and worker suites also run. Production changes are applied as targeted
hunks to preserve unrelated local changes; no GAS source or sheet schema changes.

Local incident evidence: `%LOCALAPPDATA%/Village/incident-backups/yejin-registration-busy-20261021/`.


Final validation: 832 tests ran (828 passed, 4 existing skips, 0 failed).
The production checkout independently passed all 10 durable retry tests.
Review also caught and repaired the following completion gaps:

- Original application and retry cannot run concurrently.
- Missing success projection or supersession after execution retains explicit review.
- Lock-wait and final-success audit records have distinct immutable event keys.
- Busy owner work is bound to the sealed operation, including bootstrap registrations
  without an existing RQ; exact id/version references survive successful recovery.
- A receipt-only finalization validates the authoritative full registration readback
  before resolving those references. It does not close independent quote work or
  request cleanup of the original event notice.
- Tests exercise actual busy preparation/finalization followed by successful
  preparation/finalization for both existing and bootstrap requests with quote work.


Production activation completed at 2026-10-21T06:25:50.813Z using the owned
Restart-KakaoBridgeLive lifecycle, after the active native job completed.
PID 22272 was replaced by PID 22612. Independent probe confirmed CDP ready,
authenticated Kakao, watcher ready, and fresh Gateway consumer. Ready/claimed
queues and active applications were zero; the new registration_retry counters
were present. Twelve existing runtime registration/automation tests also passed.
The new retry module SHA-256 matched the reviewed worktree, and reverse patch
validation confirmed all targeted production hunks. Existing historical failed
jobs were preserved; this is not a claim that every historical failure is resolved.
