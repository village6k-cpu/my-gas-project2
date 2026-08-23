# Kakao Pending Confirmation Request Replacement Spec

## Incident

On 2026-08-23, customer `백남준` first requested `소니 GM 70-200mm II` quantity 2 and `셔틀러에이스 M (75볼)` quantity 2 for `2026-08-25 21:00` through `2026-08-26 21:00`. GAS created `RQ-260823-010` with those two rows.

The customer later replied: `아 넵 그럼 렌즈는 빼고, 캠기어 마크4? 그걸로 2개 가능할까요?` Hermes correctly produced the final plan `캠기어 마크4 (75볼)` quantity 2 only. The live sheet did not change.

## Proven Root Cause

1. The Gateway prompt requires an existing RQ to be verified by calling `village_confirmation_request` with `should_write_to_sheet=false` before the final decision.
2. The durable Gateway channel permits one confirmation operation per job. The verification call consumes that operation reservation, so the subsequent write call has a different digest and fails with `confirmation_request_conflict`.
3. The worker contract allows only `additions_only` for any decision containing an existing RQ ID. An additions-only merge preserves the existing equipment and therefore cannot express removals or replacements.
4. GAS already has a guarded full-plan replacement path: an unregistered mutable request for the same identity and rental window is removed when a different full plan is inserted.

## Required Behavior

- Preserve native Hermes reasoning. Code must not infer replacement intent from Kakao prose.
- Hermes must express a pending-RQ replacement explicitly as `equipment_write_mode="replace_full_plan"` with the complete final equipment list and an exact `existing_confirm_request_ids` value.
- A replacement must use one `village_confirmation_request` call. The executor must verify the exact existing RQ in the authoritative sheet inside that same operation, then send GAS a `full_plan` payload.
- If the exact existing RQ cannot be verified, fail closed without a GAS mutation.
- `additions_only` remains unchanged for true additions or quantity increases.
- Registered bookings must not use `replace_full_plan`.
- Schedule/availability output remains owner-review-only and must not be sent automatically to the customer.
- The live 백남준 request must end with only `캠기어 마크4 (75볼)` quantity 2; the old lens and Sachtler rows must be absent.

## Verification

- Focused worker tests prove RED before implementation and GREEN afterward.
- Existing GAS stale-replacement behavior tests remain green.
- Full worker and relevant bridge/GAS suites remain green.
- Live readback proves the current request group contains exactly one top-level row for `캠기어 마크4 (75볼)` quantity 2 and has no registered trade.
- Auto-reply audit proves no customer message was sent for this repair.
