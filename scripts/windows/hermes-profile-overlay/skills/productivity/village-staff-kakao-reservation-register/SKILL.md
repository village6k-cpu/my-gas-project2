---
name: village-staff-kakao-reservation-register
description: "Register a Village reservation from the customer's live Kakao conversation."
version: 2.0.0
author: Village
license: private
platforms: [windows]
metadata:
  hermes:
    tags: [village, reservation, kakao, register, availability, windows]
    related_skills: [village-confirm-request, village-equipment-naming-aliases, village-operations]
---

# Staff Kakao reservation registration

Use this when staff asks to inspect a customer's Kakao conversation and register the resulting Village schedule. This is a familiar operational fast path. It is not repository-development work.

Hermes remains the reasoning layer: read the complete live room and authoritative Village state, decide the exact customer, period, cart, quantities, component selections, and evidence messages. Deterministic runners only capture, validate, execute, and read back that already-understood plan.

## Authority boundary

- A staff request to register authorizes the internal registration mutation and its normal registration-complete Alimtalk only when the established registration API performs it.
- This workflow's validated atomic route disables customer notification. A separate Kakao reply, quote send, or other customer-facing message needs explicit authorization.
- Never replay a registration because a transcript, Slack response, or terminal result was lost. Reconcile the authoritative RQ/trade state first.

## Fixed runners

- Registration: `C:/Village/runtimes/my-gas-project2-production/scripts/windows/village-confirm-request.js`
- Live Kakao inspection: `C:/Village/runtimes/my-gas-project2-production/scripts/windows/village-kakao-room-inspect.mjs`

Use `node` with these native Windows paths from the Hermes Git Bash terminal. The CLI contract is documented by `node 'C:/Village/runtimes/my-gas-project2-production/scripts/windows/village-confirm-request.js' --help`.

For normal operations, do not run repository sync/start scripts, inspect runner source, or patch runtime code. Do not create an ad-hoc script or temporary script.

## Reason once, execute once

1. Inspect the exact customer room and read the whole relevant continuation, not only the first booking block. Distinguish customer requests from staff confirmations and later changes.
2. Read the matching open RQ, existing registered trade, live schedule, catalog/set masters, customer data, and inventory evidence needed to decide the current plan.
3. Resolve aliases contextually. Preserve every accepted add, removal, quantity, set/component choice, discount, contact, and exact period. Ask only when remaining ambiguity materially changes money, equipment, recipient, or schedule.
4. Compare the final plan with authoritative state, then choose exactly one execution path below.
5. Use one UUID v4 as `operationId`. If the outcome is uncertain, keep that UUID and reconcile; never generate a new ID and replay the write.
6. Report success only from authoritative readback, not from a process exit, accepted request, Slack status, or stale receipt.

## One official execution path when the live cart differs

When the open RQ differs from the latest accepted Kakao plan by any item, alias, quantity, component, exclusion, addition, or period, use `commit-registration-live` exactly once. This command captures the current room, creates the immutable evidence snapshot, binds the selected message IDs to their live text, validates the before/after plan, performs the mutation, and verifies RQ/trade/schedule readback.

Input shape:

```json
{
  "customerName": "예약자 이름",
  "roomTitle": "선택 사항: 정확한 방 제목",
  "operationId": "UUID v4",
  "registration": {
    "confirmed": true,
    "target_scope": "pending_request",
    "request_id": "RQ-YYMMDD-NNN",
    "expected_before": [{"name":"현재 RQ 상위 품목","quantity":1}],
    "expected_set_components": [],
    "expected_period": {"start_date":"YYYY-MM-DD","start_time":"HH:00","end_date":"YYYY-MM-DD","end_time":"HH:00"},
    "desired_after": [{"name":"최종 카탈로그/세트명","quantity":1}],
    "desired_period": {"start_date":"YYYY-MM-DD","start_time":"HH:00","end_date":"YYYY-MM-DD","end_time":"HH:00"},
    "set_component_selections": [],
    "source_evidence": {
      "customer_message_ids": ["라이브 고객 메시지 ID"],
      "staff_message_ids": ["라이브 직원 메시지 ID"]
    }
  }
}
```

Pipe the complete UTF-8 JSON to:

```bash
node 'C:/Village/runtimes/my-gas-project2-production/scripts/windows/village-confirm-request.js' commit-registration-live
```

The runner fills live message text, room identity, revision, and evidence hash. Do not fabricate or precompute those fields. Full field and evidence rules: [existing RQ atomic registration](references/existing-rq-atomic-register-from-immutable-kakao-snapshot.md).

## Exact-match fast path

If one verified open RQ already matches the final Kakao cart and period exactly, use the documented `commit-registration` command. Do not enter the atomic replacement path merely because generated child rows exist; follow [generated component selection and readback](references/pending-rq-generated-component-selection-and-register-readback.md) when one deterministic child choice is the only remaining issue.

If a same-cart trade is already registered, this is a correction/readback task, not a second registration. If no RQ exists, use [name-only Kakao registration](references/name-only-kakao-register.md) and the focused `village-confirm-request` create/update commands before final registration.

## Completion gate

For `commit-registration-live`, require all of:

- receipt `status: ok`;
- a valid effective RQ and trade ID;
- final plan, period, and component selections equal the AI-decided plan;
- RQ rows read back as registered to the same trade;
- contract and every expected schedule row read back for that trade and period;
- `customerNotificationAttempted: false` and `customerNotificationSent: false`.

Then report trade ID, effective RQ, period, registered equipment, any explicit stock warning, and that no customer message was sent. Never claim completion from the old RQ alone because a changed plan may create a replacement effective RQ.

## Focused references

- Registration versus send authority: [registration authority and stock evidence](references/registration-authority-and-stock-evidence.md)
- Selecting sufficient live evidence: [confirmed audit evidence quality](references/confirmed-audit-evidence-quality.md)
- Room title versus booker identity: [room title versus booker form](references/room-title-vs-booker-form.md)

Keep customer-specific facts out of this root skill. Preserve learned aliases and exceptional procedures in their focused references; do not expand the routine entrypoint into an incident log.
