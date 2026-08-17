# Registered quote schedule-item correction

Use when a registered trade's official quote must reflect changed equipment,
quantity, price-bearing rows, or dates before preview or delivery.

## Principle

Hermes decides the exact visible quote delta from the owner's request and live
trade evidence. Execute that decision through the same one-call registered-trade
correction boundary documented in
[registered trade correction](registered-trade-date-change-remove-item.md).
Do not recreate the workflow with raw schedule reads, separate remove/add calls,
manual regeneration, CSV orchestration, or a generic Sheet write.

## Send boundary

- For correction or preview preparation only, use `sendEstimate:false`.
- Use `sendEstimate:true` only when the same instruction explicitly authorizes
  sending the official quote to that customer.
- A previous send approval does not carry over to a new correction.

## Verification

Success requires the runner's authoritative final readback to match the intended
top-level items, component expansion, quantities, prices, dates, and regenerated
contract. If delivery was authorized, it also requires the separate send result.
On partial or unknown state, stop and report the returned stage/readback evidence;
never guess, retry, or manually restore the old set.

The runner is an execution boundary, not a business-decision engine. It must not
infer aliases, substitute equipment, invent prices, or decide whether to send.
