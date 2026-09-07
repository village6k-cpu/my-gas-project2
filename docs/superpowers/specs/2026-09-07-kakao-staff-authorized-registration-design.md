# Kakao Staff-Authorized Reservation Registration Design

**Date:** 2026-09-07
**Status:** Approved for implementation
**Scope:** Kakao Hermes only

## Problem

The Kakao worker already has durable operations for creating or rewriting a confirmation request, changing a registered reservation, and sending a document. It does not have a durable operation that turns the exact pending confirmation request authorized by a Village staff reply into a registered reservation.

This is an execution-contract gap, not a Korean phrase-detection gap. Native Hermes can understand that a staff reply authorizes the customer's preceding request, but Gateway mode deliberately treats `FINAL_JSON` as non-mutating. Without a registration tool, the understood intent cannot reach `registerByReqID()` with the same lease, revision, baseline, receipt, and restart guarantees as the other Kakao operations.

## Product rule

Hermes reads the complete latest conversation for one Kakao room and decides semantically whether a Village-authored reply clearly and unconditionally authorizes the customer's exact request. Approval wording is open-ended. Examples include short acknowledgements, affirmative answers, and natural promises to proceed; they are examples, not a finite trigger list. Conditional, future-checking, contradictory, or target-ambiguous replies are not authorization.

No production code may route this behavior with a Korean keyword list, regular expression, or a special case for `가능합니다`.

When authorization is clear, the requested business result is applied:

- a pending new reservation is registered;
- a pending request may first be brought to the exact staff-approved equipment and period, then registered;
- an already registered reservation continues to use the existing registered-change operation for add, remove, replace, quantity, or date/time changes.

The staff reply is the approval. A separate sheet click is not required. Authoritative inventory, schedule, identity, and safety checks still run immediately before every write. A conflict never becomes an optimistic registration; it becomes one owner-review item with no automatic replay.

## Native-reasoning boundary

Hermes owns semantic interpretation of the conversation. Mechanical code owns only invariants:

1. the event belongs to the exact Kakao room and latest durable revision;
2. the structured evidence identifies both the customer request and the Village staff reply in that revision;
3. the target is either one exact mutable pending request ID, or a missing-request bootstrap candidate bound to one exact customer identity and commercial snapshot;
4. the complete current top-level equipment plan, exact set-component state, and four-part 24-hour period match `expected_before`, `expected_set_components`, and `expected_period`;
5. the complete desired plan, typed set-component selections, and desired period are valid and catalog-resolved;
6. the durable operation reservation, request digest, lease, receipt, and result correlation all match;
7. authoritative post-write readback proves the resulting request/trade, equipment, period, and registration status.

Code does not infer approval from prose. It accepts or rejects the typed decision produced by native Hermes.

## New operation

The native tool and Gateway operation are named `village_confirmed_reservation_commit` and `confirmed_reservation_commit` respectively.

The tool accepts one typed object:

```json
{
  "registration": {
    "confirmed": true,
    "target_scope": "pending_request",
    "request_id": "RQ-YYMMDD-NNN",
    "source_evidence": {
      "customer_request": "bounded evidence",
      "staff_confirmation": "bounded evidence",
      "conversation_revision": 8,
      "conversation_evidence_hash": "lowercase-sha256",
      "customer_message_ids": ["exact-customer-message-id"],
      "staff_message_ids": ["exact-staff-message-id"]
    },
    "expected_before": [
      { "name": "catalog name", "quantity": 1 }
    ],
    "expected_set_components": [
      { "set_item": "catalog set name", "component_item": "current component", "quantity": 1 }
    ],
    "set_component_selections": [
      { "set_item": "catalog set name", "component_item": "current component", "selected_item": "approved component" }
    ],
    "expected_period": {
      "start_date": "YYYY-MM-DD",
      "start_time": "HH:00",
      "end_date": "YYYY-MM-DD",
      "end_time": "HH:00"
    },
    "desired_after": [
      { "name": "catalog name", "quantity": 1 }
    ],
    "desired_period": {
      "start_date": "YYYY-MM-DD",
      "start_time": "HH:00",
      "end_date": "YYYY-MM-DD",
      "end_time": "HH:00"
    }
  }
}
```

`expected_before`, `expected_set_components`, `desired_after`, and both periods are complete snapshots, not deltas. An unchanged request repeats the same snapshots. `set_component_selections` contains only explicit component substitutions selected by Hermes from the approved request. Mechanical diffing may describe the audit result, but it never determines whether the staff reply meant approval.

When the customer inquiry and the staff authorization arrive before a pending RQ exists, `request_id` is exactly `null`, `expected_set_components` is empty, and `pending_request_candidate` carries the complete bounded customer identity and commercial fields. Phone and discount type are explicit and nonblank. GAS neither fills them from CustomerDB nor truncates/sanitizes the authorized memo or extra request. GAS may reuse an existing pending RQ only when its identity, period, plan, complete set components, and commercial fields all match exactly; otherwise it creates a new pending RQ inside the same operation. No name-only reuse is allowed.

## Atomic execution

One Kakao Gateway job permits one durable tool operation. Hermes must not call a confirmation-request mutation and then a registration tool in sequence. The new operation therefore performs the entire authorized transition:

1. reserve the exact Gateway operation durably before GAS;
2. validate the typed decision and exact room revision;
3. under the existing GAS confirmation lock, re-read the target request and compare its complete plan, set components, period, identity, and commercial fields;
4. if desired state differs, stage and verify the exact replacement before deleting the old contiguous RQ group, retaining the authoritative replacement request ID; after cutover begins, an ambiguous flush/response loss must retain the staged request for reconciliation rather than deleting both old and new evidence;
5. register that exact current/replacement request through the existing registration implementation;
6. read back the request, trade, schedule, contract linkage, complete final plan, and period;
7. return a correlated `village-confirmed-reservation-commit-receipt/v1` receipt;
8. persist the receipt before the Gateway job can complete.

The registration implementation retains its existing availability, duplicate, customer/contact, discount, queue, contract, schedule, ledger, and document-regeneration checks. The operation must not bypass them or invent a separate "plentiful inventory" shortcut.

## Outcomes and replay safety

- `ok`: authoritative readback proves exactly one successful registration. Customer output is `no_reply` because staff already replied.
- `blocked`: nothing was written; persist the typed blocker and create exactly one owner-review follow-up.
- `partial_success`: a write may have happened but final proof failed. Persist all known evidence, require human review, and never replay the mutation automatically.
- `invalid` or `stale`: zero write, fail closed, one owner-review follow-up where actionable.
- process restart with a reserved or applying operation: mark unresolved/human-review; do not replay.
- while the confirmed operation owns registration, its operation marker is never rewritten into the legacy `등록대기` queue by a concurrent manual registration or recovery sweep.
- semantic retry with the same canonical digest: reuse/coalesce the exact receipt; a different decision under the same lease conflicts.

## Audit history

Every terminal attempt writes a Kakao automation audit event with effect `reservation_registration`. The Today Dashboard `후속조치 > 자동처리` view exposes success, blocked, partial, and failed entries without sending an additional Slack notification. The event records bounded identifiers, before/after equipment and period summaries, receipt status, and duration; it does not store customer phone numbers or raw conversation text.

## Prompt contract

The model-visible Kakao prompt must say:

- interpret authorization from full same-room conversation context, speaker role, target, chronology, and latest revision;
- wording examples are illustrative only;
- do not call the operation for a conditional answer, a promise merely to check, unresolved inventory, an ambiguous target, or customer-authored approval;
- use the existing confirmation-request operation for an inquiry that is not yet staff-authorized;
- use the new commit operation exactly once for an exact pending request that staff has authorized;
- use the registered-change operation for an already registered reservation;
- after successful commit/change, emit `no_reply` and do not duplicate the staff's answer.

## Rollout gates

Implementation is not live until all of the following are proven:

1. focused RED-to-GREEN tests at GAS runner, worker, Gateway channel/HTTP/server, plugin, and audit UI layers;
2. full relevant Node and Python suites pass;
3. feature branches are reviewed and integrated through the repository workflow;
4. GAS and the root Hermes plugin/runtime are deployed with hashes and process readback;
5. no-send Gateway replay proves exact registration receipt, audit visibility, no customer send, and no duplicate execution;
6. a separately authorized real correction/registration is read back from the authoritative sheet and durable audit.

## Non-goals

- no deterministic Korean phrase router;
- no change to Slack Hermes behavior;
- no automatic mutation from customer text alone;
- no bypass of availability or registration safety checks;
- no automatic replay after an ambiguous post-write state;
- no new immediate notification for successful automation.
