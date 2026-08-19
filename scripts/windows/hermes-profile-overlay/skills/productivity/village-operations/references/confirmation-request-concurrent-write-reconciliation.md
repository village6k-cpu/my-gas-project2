# Confirmation-request concurrent-write reconciliation

Use after inserting/updating a `확인요청` while Kakao worker/backstop recovery may also be writing the same customer request.

## Why

A direct `insertAndCheckRequest` and an automation worker can create separate RQ groups moments apart. They may disagree on pickup time, phone, or whether quantities are **total requested quantities** versus additions to a set. A successful API response is not enough evidence of the final sheet state.

## Safe reconciliation

1. **Read back all `확인요청` groups** for the customer, phone aliases, and the exact date range immediately after every write. Include full rows, not only the RQ header.
2. Compare each group against the actual Kakao body evidence. Prefer the group with verified phone and precise time, but do not preserve it if its equipment quantities double-count a set’s included components.
3. For set-based requests, expand the set from `세트마스터` and calculate **delta only**:
   - customer asks a set plus a total of 3 cards; set includes 2 cards → enter one additional card, not three;
   - customer asks a set plus a total of 4 batteries; set includes 3 batteries → enter one additional battery.
4. If a duplicate is incomplete or is only a partial write, delete that exact verified `reqID` with `deleteRequest` **only after** the retained group is readable and complete. Re-read the sheet and assert the removed RQ has zero rows.
5. Run `recoverPendingRegistrations` and `recoverPartiallyRegisteredRequests` afterward. A zero-result recovery is evidence that no actual registered schedule remains partially created.

## Partial-update pitfall

`updateRequest` can delete the old rows before a later F-column data-validation failure. Treat its error response as potentially mutating: immediately re-read the target RQ group, identify partial rows, clean them with `deleteRequest`, and recover from a known-good request group. Never retry an update blindly.

## Alias/data-master warning

A set expansion can return a component as `❓ 미등록 장비` even when the set itself is valid (for example, a list/validation alias differs from the `세트마스터` spelling). Keep the entered request and report the automatic-availability warning; do not silently claim full availability or force an unverified spelling. Fix the master/validation alias separately, then rerun availability.
