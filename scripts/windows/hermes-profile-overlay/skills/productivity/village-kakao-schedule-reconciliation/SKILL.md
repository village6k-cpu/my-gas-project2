---
name: village-kakao-schedule-reconciliation
description: Use when auditing Kakao bookings against Heybilli schedules, including requests that also authorize remediation.
version: 1.0.1
platforms: [windows]
metadata:
  hermes:
    tags: [village, kakao, heybilli, reservations, reconciliation, audit]
    related_skills: [village-reservation-commitment-reasoning, village-staff-kakao-reservation-register, village-operations]
---

# Village Kakao–Heybilli Schedule Reconciliation

Use when Village staff asks whether a Kakao reservation, same-day checkout,
change, or inquiry is missing from Heybilli. This skill owns evidence collection
and reconciliation. It does not replace the focused mutation skill.

## Goal

Reconcile customer intent in the full Kakao conversation against the live
Village reservation ledgers. Find both:

- a confirmed booking with no matching confirmation request/trade/schedule; and
- an existing trade whose customer, period, equipment, quantity, or status is
  stale after a later Kakao change.

Do not equate “a row exists” with “the conversation was implemented correctly.”

**REQUIRED SUB-SKILL:** Load `village-reservation-commitment-reasoning` before
classifying reservation intent. Use its stateful conversation result here;
keep this skill's evidence, authorization, and mutation boundaries unchanged.

## Decide the operating mode first

Interpret the current staff request as one of these two modes before collecting
evidence:

1. **Audit only** — report classifications and make no business mutation.
2. **Audit plus authorized remediation** — collect the same evidence, then load
   `village-staff-kakao-reservation-register` and hand every actionable case to
   it for mutation, readback, and completion.

The current staff request determines the mode. Historical Kakao conversation
establishes the booking facts; it does not cancel explicit registration or
correction authority in the current staff request. The focused registration
skill remains the single source of truth for mutation authority, blockers,
partial registration, deduplication, and completion.

For audit-plus-remediation, do not end with an actionable “미반영” list merely
because an older conversation lacks a human acceptance line. Route the case to
the focused execution skill and let that skill apply the current authorization
against the verified facts. Stop only on a genuine hard blocker or unknown
target, and report that exact blocker.

## Audit scope

Natural-language requests such as “오늘 반출이나 문의 중 등록 안 된 것”
usually require two overlapping scans:

1. rooms active during the current local day, including future-date inquiries;
2. conversations whose requested pickup date is the named day, even if the
   latest message arrived earlier.

State the interpreted scope briefly. For a bounded yesterday/today audit, follow
[the gateway-job remediation recipe](references/two-day-kakao-remediation-audit.md).
For an exhaustive bounded audit that must account for event-only rooms, failed
receipts, in-flight revisions, and older accepted work hidden by a newer message,
also follow [the exhaustive gateway/event/live reconciliation](references/exhaustive-gateway-event-live-audit.md).
For “아까 요청한 이후” or any audit running while workers continue to register,
also follow [the rolling concurrent-worker audit](references/rolling-audit-concurrent-registration.md): refresh Sheets before retries and sweep all current-day pending RQs for hidden conflicts.
When gateway application state, deterministic receipts, cached room evidence, and
live Sheets disagree, use [write-outcome arbitration and evidence binding](references/write-outcome-arbitration-and-evidence-binding.md). It also defines the terminal-state/delegation barrier, safe post-checkout quantity-reduction branches, and recovery from partially completed cross-trade moves.
Do not make staff choose paths or remember scripts when both scans can be done safely.

## Evidence order

1. Establish the current local date/time with the system clock.
2. Read the Kakao bridge queue for current-day room activity and dedupe by room.
3. Search recent evidence for explicit pickup dates and relative-date language.
4. For reservation-shaped candidates, open the **full current room** in a
   separate temporary tab while preserving the watcher-owned list tab.
5. Query live `확인요청`, `계약마스터`, and `스케줄상세` using every reliable
   identifier available: customer name, corrected name, phone, request ID,
   trade ID, date, and distinctive equipment.
6. Compare all material fields and classify the case.
7. Recheck for newer jobs/messages before finalizing, then verify the Kakao list
   watcher remains healthy.

See [same-day reconciliation details](references/same-day-kakao-heybilli-audit.md).

## Positive-evidence contract

- A preview or empty convenience field is not the full conversation.
- A snapshot of a different room is not evidence about the requested customer.
- If the full current room or authoritative live state cannot be positively
  verified, classify the case as **unknown** and reacquire the evidence.
- Never convert missing, empty, stale, or wrong-room evidence into
  `pending_customer`, `inquiry_only`, or “Village did not confirm.”
- Only a verified full conversation may support those negative classifications.

## Date and preview guardrails

- Kakao list previews often end with a UI row date such as `9월 16일`. That
  suffix is the message-list date, **not necessarily the requested rental date**.
  Strip the trailing row-date label before using the preview to infer pickup.
- A preview like `네`, `확인했습니다`, `예약 부탁드립니다`, or `사진` is a
  discovery signal only. Read the full conversation before deciding.
- Relative words such as `오늘`, `내일`, or a weekday must be resolved against
  the timestamp of the source message, not the audit time.
- Worker result tails and queue summaries are discovery evidence. If a result
  payload is truncated or lacks the final decision, use the live room and live
  sheets rather than reconstructing the missing tail.

## Classification

Assign every reservation-shaped candidate to exactly one primary class:

- **confirmed_missing** — customer supplied sufficient reservation details,
  Village accepted the booking, and no matching RQ/trade/schedule exists.
- **covered** — matching live state exists and material fields agree.
- **registered_mismatch** — a trade exists, but later accepted Kakao changes
  are absent or stale in live state.
- **pending_customer** — Village proposed a substitute or condition and the
  customer has not accepted it yet.
- **rejected_or_closed** — Village declined availability or the customer ended
  the request; no registration is expected.
- **inquiry_only** — price, compatibility, model, payment, return, or image-only
  conversation without a confirmed reservation.
- **existing_pending_rq** — the inquiry already has an unregistered confirmation
  request; report its current status rather than calling it missing.
- **unknown** — full conversation or authoritative state cannot be verified.

A declined booking is not a schedule omission. A pending substitute is an
operational checkout risk, not yet a confirmed schedule change. An accepted
name/time/equipment change that was not written is a mismatch even if the trade
itself exists.

## Image-only messages

If the latest message is only an image:

1. inspect the latest image when it could contain a reservation form or gear
   request;
2. look for customer/contact/period/equipment fields;
3. if it is only a damage, return, identification, or general equipment photo,
   classify it accordingly and do not manufacture a booking from it.

## Mutation boundary

Audit-only mode authorizes reads, temporary room tabs, and health verification.
It does not authorize a business mutation or customer send.

Audit-plus-remediation mode must not invent a second mutation policy here.
Load `village-staff-kakao-reservation-register`, pass it the verified case and
current staff request, and follow its authorization, deduplication, mutation,
and readback contract through a terminal state.

## Fast-moving gateway and live-state stabilization

A room can move from pending RQ to registered trade while the audit is running.
Do not freeze the verdict at the first lookup or let an earlier failed/partial
receipt override a newer authoritative readback.

1. Dedupe gateway files by `room_key`, taking the highest `room_revision`, but
   separately retain older `tool_receipts` that contain
   `authorized_registration`, `authorized_mutation`, `blocked`, or
   `partial_success` evidence. Also scan every older in-window decision for a
   confirmed-unregistered booking or registered-change intent: a newer stock
   question, acknowledgement, return message, or image must not hide accepted
   work that is still absent from live state.
2. If the newest room is `claimed`, `pending`, or has no valid model result,
   read its raw conversation snapshot immediately; do not silently fall back to
   the previous revision. Recheck the job once before the cutoff.
3. After candidate discovery, query live state again. A trade or schedule that
   appears during the audit supersedes an earlier “missing” result. Reclassify
   it as covered or inventory-risk-only instead of reporting a stale omission.
4. After the last live batch, rescan for room revisions created during that
   lookup. If a newer relevant message exists, reconcile it before finalizing.
5. State a concrete KST cutoff. Report older blocked/partial receipts only when
   they still explain a current mismatch; otherwise note that later live state
   resolved them.

For stock-risk findings, query the exact physical schedule item and its catalog
stock, then perform a timestamp overlap sweep. Report only physical blockers;
ignore memory and battery when policy marks them non-blocking. Do not treat a
calendar-day overlap count as proof of simultaneous shortage.

After all registration/correction writes, run the **global registered-capacity
sweep** in [post-registration-physical-capacity-audit.md](references/post-registration-physical-capacity-audit.md).
Do not rely on per-RQ `최대동시` text as the final stock verdict: it may include
pending demand, predate another worker's write, or miss demand expanded under a
different set. Recompute current registered physical rows with half-open time
intervals and list every contributing trade when stock is exceeded.

If a delegated audit covers the same scope, its result is required evidence for
a definitive completeness claim. Continue other work while it runs, but do not
say “전부 확인 / 누락 없음” until that result is merged and the affected live
state and capacity intervals are refreshed. Otherwise label the report
provisional.

## Verification

Before reporting:

- re-read every candidate with a potentially actionable mismatch;
- confirm exact live IDs and current values;
- check that no newer Kakao job superseded the snapshot;
- in remediation mode, require mutation receipts and authoritative readback;
- close only temporary room tabs; and
- require the original authenticated list tab and watcher health to remain
  intact.

## Report style

Lead with completed registrations/corrections, then confirmed missing cases and
their exact hard blockers. List urgent same-day risks and concise reasons why
apparent candidates need no registration. Include the cutoff time and mutation /
customer-send status. Keep the report short and mobile-readable.
