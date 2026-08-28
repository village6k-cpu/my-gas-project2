# Kakao Staff-Confirmed Reservation Mutation Design

## Problem

Kakao Hermes can understand a customer's equipment addition, removal, replacement,
or date change, but the current execution boundary does not reliably carry that
decision into the authoritative reservation records.

The registered replacement incident demonstrates the gap:

- The customer explicitly asked to cancel the 28-135 lens and use a Sony GM
  70-200mm instead.
- Village staff later answered in the same conversation in a way that confirmed
  the change.
- Hermes correctly reconstructed the desired final plan.
- The worker treated the booking as unregistered, created a separate confirmation
  request, and completed the job without changing registered trade `260824-008`.
- Live readback still showed the old 28-135 schedule row and no 70-200 row.

The defect is not natural-language understanding. It is a missing, durable bridge
between a staff-confirmed Kakao decision and the existing registered-trade
correction executor.

## Product rule

An unambiguous Village staff response in the Kakao conversation is the business
authorization to apply the reservation change described by the immediately
preceding customer request. The system must not ask the owner to approve the same
change a second time.

The rule applies to:

- equipment additions and quantity increases;
- equipment removals and quantity reductions;
- equipment replacements;
- pickup or return date/time changes.

A customer request without a later staff confirmation remains read-only: Hermes
may check availability and prepare a draft or owner follow-up, but it must not
mutate a reservation.

## AI-first boundary

- Native Hermes reads the complete visible conversation and decides whether a
  staff message actually confirms a specific customer-requested mutation.
- No regex or deterministic keyword router decides that `네`, `가능합니다`, or
  similar text is approval in isolation.
- Hermes resolves the target reservation, desired final plan, exact catalog names,
  and evidence. Plumbing code validates the typed decision, fences the mutation,
  executes existing APIs, and verifies readback.
- The current pure Hermes lifecycle and same-room context remain intact. This
  design does not add a second reasoning agent or a business-rule routing layer.

## Typed decision

Hermes emits a structured mutation only after completing authoritative lookups:

```json
{
  "staff_confirmed_mutation": {
    "confirmed": true,
    "kind": "equipment_replace",
    "target_scope": "registered_trade",
    "request_id": null,
    "trade_id": "260824-008",
    "source_evidence": {
      "customer_request": "28-135 취소하고 sony 70-200 gm 2.8 로 부탁드립니당",
      "staff_confirmation": "네",
      "conversation_revision": 8
    },
    "expected_before": [
      { "schedule_id": "260824-008-07", "name": "소니 FE 28-135mm", "quantity": 1 }
    ],
    "desired_after": [
      { "name": "소니 GM 70-200mm", "quantity": 1 }
    ],
    "date_change": null
  }
}
```

Required invariants:

- `confirmed=true` requires an outbound staff confirmation after the customer
  mutation request in the same opened room and conversation revision.
- `target_scope=pending_request` requires one exact mutable `RQ-YYMMDD-NNN`.
- `target_scope=registered_trade` requires one exact trade ID and authoritative
  contract plus schedule readback.
- Equipment removal/replacement requires exact current schedule IDs and expected
  names. Additions require exact catalog or set-master names.
- The complete desired change must fit in one operation digest. Model prose cannot
  supply or override the lease, operation ID, or receipt identity.

## Execution paths

### Pending confirmation request

Reuse the existing confirmation operation:

- additions use `additions_only` with the exact existing RQ;
- removals, reductions, and replacements use `replace_full_plan` with the exact RQ
  and complete final top-level plan;
- GAS verifies and replaces the exact mutable request under its existing lock;
- registered, processing, held, rejected, or missing requests fail closed.

### Registered trade

Reuse `runRegisteredTradeCorrection` from
`scripts/windows/village-registered-trade-correction.js` as an in-process module.
Do not spawn a per-request CLI and do not add another routing service.

The executor must:

1. Read the exact contract and full schedule for the trade.
2. Verify every expected current schedule ID, name, quantity, and date window.
3. Run a projected availability check for the complete desired post-change plan.
4. If safe, execute the existing date, remove, and add APIs with mutation IDs
   derived from the durable Gateway operation.
5. Regenerate the contract when schedule contents or dates change.
6. Read the contract and schedule again and prove that the desired state exists
   and the replaced/removed state does not.
7. Persist a typed receipt before the Kakao job may reach completed/finalized.

No estimate, Kakao message, tax invoice, or payment mutation is part of this flow.
Because staff already answered, the normal result is `no_reply` to avoid a duplicate
customer message.

## Availability and conflict handling

Availability must be evaluated against the projected final reservation, excluding
the exact target trade's current allocation. Counting the target trade against
itself produces false conflicts and is not acceptable.

Before any write, block and report when:

- projected stock is insufficient or another reservation conflicts;
- a requested model cannot be mapped to one exact catalog/set name;
- multiple candidate requests or trades match;
- current authoritative rows differ from `expected_before`;
- the staff confirmation cannot be tied to the customer mutation;
- any required read is unavailable.

The worker must create one urgent, durable Slack owner card containing the customer,
target request/trade, desired change, exact blocking rows, and recommended action.
No customer response may claim that the change was applied.

If an API result becomes unknown after a write, do not replay the mutation. Persist
the applied stages and enter human review. The Slack failure notification remains
pending until delivery is positively verified.

## Durability and idempotency

- A staff-confirmed mutation uses the Gateway's existing durable operation
  reservation and exact lease fencing.
- The canonical digest includes room, revision, target ID, expected-before rows,
  desired-after rows, and date change.
- Semantic retries with the same digest return the persisted receipt.
- A different mutation under the same claim conflicts before external writes.
- Process restart while applying is ambiguous and requires human review; no DOM,
  Hermes, or GAS mutation is replayed automatically.
- Completed means both a successful durable receipt and authoritative final
  readback. Creating a follow-up card alone is not completion.

## Slack reporting

Successful, fully verified staff-confirmed mutations do not require an additional
approval card. They may produce a concise audit card only when configured, clearly
marked as completed.

Conflicts, ambiguous targets, partial application, contract-regeneration failure,
or failed readback always create an urgent owner card. Slack delivery errors must
remain pending and visible in health/status; they must never be marked delivered
from an error-shaped or skipped response.

## Health and observability

Authenticated Gateway status must expose aggregate counts and oldest age for:

- pending staff-confirmed mutations;
- applying/ambiguous mutations;
- failed mutations requiring human review;
- pending Slack failure notifications;
- last successful mutation and readback time.

Logs and receipts must include IDs and stage names, but not secrets or unnecessary
customer message history.

## Verification

Tests are written RED first and must cover:

1. Customer change request without staff confirmation: no mutation.
2. Staff-confirmed pending-RQ addition and full-plan replacement.
3. Staff-confirmed registered addition, removal, replacement, and date change.
4. Projected availability excludes the target trade's own current allocation.
5. Real external conflict: zero writes plus one durable urgent Slack report.
6. Ambiguous equipment or target: zero writes and human review.
7. Exact registered readback, contract regeneration, and `no_reply` completion.
8. API timeout after a partial write: no replay and durable stage evidence.
9. Duplicate event/restart: one mutation and one receipt.
10. Slack failure: pending notification remains recoverable.
11. Regression for trade `260824-008`: the desired plan replaces the 28-135 row
    with `소니 GM 70-200mm` and cannot finalize while the old row remains.

Focused worker, Gateway channel/HTTP/server, registered-correction, and GAS behavior
suites must pass, followed by the combined worker/bridge suite and syntax/diff
checks.

## Rollout and incident repair

Deployment order:

1. Ship typed decision validation and dry-run/readback tests.
2. Ship durable Gateway operation wiring with writes disabled.
3. Run a no-write replay of recorded incidents, including the registered replacement incident.
4. Enable registered mutation execution while retaining customer `no_reply`.
5. Repair live trade `260824-008` through the same production path, regenerate the
   contract, and verify raw schedule plus contract readback.

No direct cell edit is used for the incident repair. The permanent path must prove
it can repair the incident it was designed to prevent.

## Non-goals

- Automatically accepting a customer request before Village staff confirms it.
- Sending schedule availability or change confirmation to the customer without a
  staff response.
- Guessing an equipment model when multiple catalog entries remain plausible.
- Replacing native Hermes reasoning with keyword rules.
- Adding a generic sheet-write tool or widening public write permissions.
- Automatically rolling back or replaying a multi-stage registered mutation whose
  outcome is unknown.
