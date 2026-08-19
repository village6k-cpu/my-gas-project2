# Pending RQ Kakao quote from follow-up screenshot

Use when staff forwards a Kakao screenshot and says `이거 견적서 보내 주자`, but the screenshot is part of an ongoing inquiry that may already have a pending `확인요청`.

## Durable pattern

1. OCR/inspect the screenshot first. The staff/Slack bracket name can be the operator (`[최재형]`) while the actual customer in the screenshot is another person.
2. Search `확인요청` by customer name/phone before building a fully manual quote. If a matching pending RQ exists, read the whole RQ group and price only top-level rows (`결과=세트` or unexpanded standalone rows), not component rows.
3. If the customer previously asked for a contract/document dated a different day (e.g. “6월 25일 건”) but the actual pending rental period is visible as `6/26 06:00~6/27 06:00`, treat the document date as a customer wording/context note, not the quote rental period. Use the RQ/visible rental period in the quote and mention the mismatch if relevant.
4. Generate a no-customer-contact preview first, even if staff says `보내주자`; attach the PDF and state `고객 발송은 아직 안 했음` unless the user explicitly approves after seeing the preview.
5. Surface availability blockers from the pending RQ before asking for send approval. If top-level quote is useful but expanded rows show shortages/missing equipment, mark send as blocked/review-needed rather than silently sending.
6. For filter shorthand, use prior same-customer/RQ evidence where available. Example from this workflow: visible `82mm hbm 1/8 필터` mapped to `Hollywood Blackmagic 1/8 원형` because the pending RQ and recent customer history used that exact item; otherwise, if HBM/Blackmagic vs square/round is ambiguous, stop before customer send.

## Verification artifact pattern

- Manual no-send route may return the expected `status: ERROR` / `연락처가 유효하지 않습니다.` with `fileId`; this is a generated preview, not a failed customer send.
- Export `gid=0` CSV/PDF, verify CSV totals and PDF one-page visual rendering.
- If a long all-in-one script times out after the GAS file is generated, check for partially exported `/tmp` artifacts and continue verification from those files rather than re-posting the send-capable route immediately.
