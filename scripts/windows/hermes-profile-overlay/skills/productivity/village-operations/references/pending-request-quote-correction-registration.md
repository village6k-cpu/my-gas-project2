# Pending request quote correction → registration

Use when a staff thread starts as a pending `확인요청`/manual quote preview-send task, then the user corrects one item and later says to register the same corrected configuration (e.g. `FX3 풀세트 아니고 바디세트`, then `24-70은 1대만 해서 등록해`).

## Correct workflow

1. Treat the most recent user correction as the source of truth for both the resent quote and the eventual registration.
   - Do not reuse stale `확인요청` rows if they still contain the old item/quantity.
   - Carry forward all unchanged top-level items from the approved/resolved quote payload.
2. Re-price/resend the corrected quote immediately when the user explicitly says no extra approval is needed.
   - Use official `세트마스터` names/prices.
   - After `sendEstimateManual` returns `OK`, verify the generated sheet by CSV export from returned `fileId`; `pdfUrl` may be blank even though the send succeeded.
3. For registration, create a fresh corrected `확인요청` with `insertAndCheckRequest` rather than trying to register the stale request group.
   - Include the corrected item (`소니 FX3 바디세트`, not `소니 FX3 풀세트`).
   - Include the corrected quantity (`소니 GM 24-70mm II` 수량 1).
   - Preserve customer/date/phone/discount from the thread.
4. Register the fresh request (`action=등록&reqID=...`) and verify:
   - `확인요청` has `등록완료` and a `거래ID`.
   - `스케줄상세` top-level rows contain the corrected item/quantity and no stale item.
   - `계약마스터` and `거래내역` contain the new `거래ID`/amount.
5. Only after successful registration, delete the stale old `확인요청` group with `deleteRequest` if it would confuse staff or still contains the wrong items.
   - Never delete the old request before the corrected request is registered and verified.
6. Report separately:
   - quote sent vs reservation registered,
   - new request ID and trade ID,
   - corrected item/quantity verification,
   - any remaining availability warnings.

## Pitfalls

- `tradeCandidates` may find an older registered trade for the same customer/date but not the pending inquiry being corrected. For pending-request registration, search/read `확인요청` and build from the corrected top-level quote payload.
- Registration may still complete even if availability rows contain warnings such as `부족(가용2/3)`. Do not hide this; report it as an operational warning after registration.
- `updateRequest` can rewrite a request group, but for heavily expanded/stale groups with wrong set expansion, a clean `insertAndCheckRequest` + verified registration + old `deleteRequest` is safer.
