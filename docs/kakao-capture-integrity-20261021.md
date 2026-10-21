# Kakao incomplete conversation capture incident — 2026-10-21

## Verified failure

`RQ-261020-022` existed but had no registered trade or schedule. The list event
`dom-847c181432e28214` contained the staff confirmation at 20:55 KST on October 20,
but its immutable, already-open conversation snapshot stopped at 19:15. The model
correctly declined to treat a list preview as approval. The host nevertheless
accepted the incomplete capture and finalized the inference. A subsequent snapshot
for `dom-66ec932215da5828` explicitly showed the disconnected-chat UI, omitted the
staff confirmation, and was also treated as usable. Repeated list events were then
deduplicated against already-handled work.

The defect was at the capture contract: matching the customer and finding any
non-header text did not establish that the triggering message had been captured.
The cause of the original browser connection loss is not established by this audit.

## Change

- Reject disconnected conversation UI and text-trigger events absent from message bubbles.
- Match only normalized text; no customer, equipment, or reservation keyword rules.
- Preserve media previews as attachment labels, leaving their meaning to the AI.
- Poll for the current message, then attempt one refresh of the exact conversation.
- Preserve unsent text and file attachments; never refresh a room with a draft.
- Carry failed capture integrity into immutable snapshots and reject before model handoff.
- Retain the existing durable capture-failure/reconciliation path. Do not replay
  historical writes or turn a preview into registration authority.

Production had pre-existing local changes. Only the reviewed worker hunks and new
integrity module/tests were applied, with a backup of the prior worker. No GAS code,
sheet columns, model/provider, or customer-send policy changed.

## Verification and recovery

- Regression tests first failed on the old behavior, then passed after the fix.
- Both original incident snapshots are rejected with distinct, correct reasons.
- Worker suite: 490 tests, 486 passing, 4 environment-specific skips, no failures.
- Production capture + durable retry lifecycle: 12 tests passing.
- Owned bridge and automation Chrome recovered through their lifecycle scripts.
- Direct CDP probe: authenticated and watcher ready; fresh live conversation now
  includes both staff confirmation and the customer's subsequent visit confirmation.
- Official no-send registration recovered the existing RQ as trade `261021-001`:
  October 21, 13:00–19:00, F21C ×2 and DJI microphone Mini2 ×1, including all set components.
- Receipt: `cd302009-b08b-463d-87cf-28c57442a451`; operation:
  `de35696f-7a6c-425a-ab8e-775796cf3434`. Customer notifications attempted/sent: false.
- Independent GAS readback verified six schedule rows, all six request rows registered,
  and one contract. Supabase `village.trades` and `village.schedule_items` subsequently
  confirmed the same period and all six rows through normal synchronization.
- The two related owner work items were resolved with exact ID/version checks and the
  verified operation receipt, then independently read back as resolved.

## Scope limits

Historical capture backlog remains separate from this incident's recovered booking.
A read-only audit of 194 recent snapshots found other potentially incomplete captures;
some were superseded, attachment labels, already-registered bookings, or had partial
operations. They were not blindly replayed. The local incident backup contains the
candidate list for individual reconciliation. This incident's recovery does not
assert that every historical operational task has been resolved.

Local evidence/backup directory (no credentials):
`%LOCALAPPDATA%/Village/incident-backups/kakao-stale-capture-20261021/`.
