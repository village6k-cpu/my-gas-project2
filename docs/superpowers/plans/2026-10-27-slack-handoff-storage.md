# Slack handoff storage: inactive building block

Part of migration step 4 in `2026-10-27-studio-migration.md`. The user asked for
autonomous migration while preserving current service. The existing Windows drain
answers new requests with a resend message; it does not retain them for handoff.

The implementation choice is a small Python/SQLite storage primitive, reusing the
native Python runtime and adding no package dependency. It remains unconnected to
production. Existing Windows and Mac adapters, models and business consumers are
unchanged. This document does not authorize source shutdown or native activation.

## Storage contract

- Bind each database to one expected Slack app and team and refuse identity/schema
  changes. The caller must durably provision a protected local directory first;
  missing directories are rejected. New DB files use mode 0600 on POSIX.
- Save the complete JSON envelope, a canonical payload hash and a stable event
  identity in one SQLite transaction. Use DELETE journaling, EXTRA synchronization
  and fullfsync on Mac. The ACK callback runs only after the commit returns.
- Same event/payload with another envelope is a duplicate delivery, retained without
  becoming another event. If the same event changes payload, or an envelope ID is
  reused for a different event, retain both payloads and hold affected events.
- ACK identity comes from the committed receipt, not the caller's mutable object.
- Storage failure, wrong app/team, missing identity or unsupported envelope type
  cannot produce an ACK. Retain representable unsupported requests for inspection.
  Invalid JSON/over-limit envelopes fail before insertion, also without ACK.
- No execution, automatic replay, queue reset, expiry or business recovery API.
  Crash after commit/before ACK may cause delivery retry; dedup retains one event.

## Verification

Offline tests cover separate-connection commit visibility, process death after
commit, lost ACK/redelivery, concurrent connections, duplicate/conflicting payloads,
wrong identity, unsupported interactions and storage rollback. Tests use temporary
databases and synthetic payloads only, without network or production credentials.

Current result: 17 storage cases pass on Windows and native Mac. The complete
helper suite passes 50/50 on Mac; Windows passes 49 with the one POSIX ownership
case skipped. A fresh independent review found a directory provisioning durability
gap; the missing-directory rejection test was observed failing, then passing after
the fix. Direct COMMIT/ROLLBACK fault injection remains deferred; the storage-abort
test covers transactional rollback and no ACK. No physical power-loss test ran.

## Remaining handoff requirements

This module alone does not make Slack handoff lossless. A future connection layer
must prove Socket Mode ownership, supported event classes, receiver closure and
ordering, then feed the original Hermes dispatch under a single consumer fence.
Interactive/slash command response deadlines and expiring trigger IDs need a
separate timely handling design; ACKing them into a delayed replay queue is unsafe.
Unknown prior accepted work must remain held until authoritative outcome readback.
Rollback must account for every retained delivery and every uncertain dispatch.
No collector should connect until these requirements have been rehearsed.

## Review focus

Inspect durability before ACK, failures during commit/rollback, cross-connection
dedup/conflicts, input mutation, identity binding and privacy. Verify that the
module cannot execute business work or silently make unsupported interaction safe.
Do not grade this storage-only component as a completed production handoff.
