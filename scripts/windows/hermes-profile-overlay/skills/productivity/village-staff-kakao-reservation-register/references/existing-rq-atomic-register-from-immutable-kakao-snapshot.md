# Existing RQ to atomic registration from live Kakao evidence

Use this when a verified open RQ exists but the latest staff-accepted Kakao cart differs by item, alias, quantity, component, exclusion, addition, or period. A fully matching RQ uses the simpler documented registration command.

## Prepare the AI decision

Read the whole relevant live conversation plus the current RQ, contract, schedule, catalog/set, customer, and inventory state. Build:

- `expected_before`: current top-level RQ rows only;
- `expected_set_components`: every current child row marked as a set component;
- `expected_period`: exact current RQ period;
- `desired_after`: final staff-accepted cart in canonical catalog/set names;
- `desired_period`: final accepted booking period;
- `set_component_selections`: only explicit or established deterministic component choices;
- `source_evidence.customer_message_ids` and `staff_message_ids`: live message IDs proving the request, acceptance, later changes, and staff confirmation.

Do not infer parent/child status from neighboring columns. In raw A:R RQ data, Q (`비고`) beginning with `[세트]` marks a child; F is name and G is quantity. A packing/pre-check request does not change the official rental period unless the conversation explicitly changes checkout or handover time.

## Execute once

Supply the complete decision plus a fresh UUID v4 `operationId` to the fixed runner:

```bash
node 'C:/Village/runtimes/my-gas-project2-production/scripts/windows/village-confirm-request.js' commit-registration-live
```

The command itself captures the live room, verifies the exact room/hint, creates the immutable snapshot, binds every selected ID to live message text, derives room identity/revision/hash, applies the validated replacement/registration once, and performs authoritative readback. Do not add snapshot internals to the input and do not inspect implementation code to recreate them.

The backend may replace the old RQ and return a new `effective_request_id`; that is expected when the plan changed.

## Fail closed and reconcile

- Missing room, mismatched title/hint, absent evidence ID, stale before-state, hash mismatch, or plan/readback mismatch must stop before success is reported.
- On an uncertain write, never change the operation UUID or submit again. Query the effective/original RQ, trade, contract, and schedule to determine whether the write landed.
- Registration-only staff wording does not authorize a separate Kakao reply.

## Success readback

Require `status: ok`, valid effective RQ and trade ID, final plan/period/components matching the decision, registered RQ rows sharing the trade ID, and matching contract/schedule rows. This route must also report `customerNotificationAttempted: false` and `customerNotificationSent: false` unless a separately authorized send path was used.
