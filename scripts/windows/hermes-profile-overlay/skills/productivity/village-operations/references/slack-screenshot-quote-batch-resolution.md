# Slack screenshot quote-batch resolution

Use this when staff replies with vague text such as `이거 처리해줘` / `이거` and attaches a Kakao/customer screenshot that contains the actual request.

## Critical guard

Do **not** infer the target from the previous Slack channel card or nearby history when the Slack message has an image attachment or quoted mobile screenshot. First read/OCR the attached image and extract the customer request from it. If the image is missing/unreadable, ask for the image/context instead of acting on an adjacent automation card.

## Typical pattern

A screenshot may include a customer asking for multiple quote files, e.g.:

- `26.06.01 최민석`
- `26.06.19 김태윤`
- `26.07.04 최민석`
- `3건 견적서 파일 보내주실 수 있으실까요? 위에 보고하고, 결재 받은 다음에 입금드리려고 합니다!`

Treat this as an approval-gated document task:

1. Resolve each dated item independently.
   - Try `tradeCandidates&name=&date=` for registered trades.
   - If a dated item has no registered trade, search `확인요청` by name/date/phone before saying not found.
2. For registered trades, generate official `previewQuote` PDFs and verify exported CSV/PDF bytes.
3. For pending `확인요청` rows, read the full request group and create a manual no-send official-template quote preview from top-level rows only.
   - Use `sendEstimateManual` with blank/omitted phone as the no-customer-contact workaround; `status:"ERROR"` + `연락처가 유효하지 않습니다.` + `fileId` means preview was generated and no customer send happened.
   - Export `gid=0` CSV/PDF and verify the quote rows/totals.
4. Attach the resulting PDFs to the staff/user for approval and clearly state `고객 발송은 아직 안 했음`.
5. Surface availability blockers/warnings separately from quote math, especially when pending RQ rows show shortage or system mismatches.

## Pitfalls

- A vague Slack reply can be attached to a thread whose text alone says only `이거 처리해줘`; the real target can be in the image. Acting on the latest channel card is wrong.
- If a date lookup returns multiple registered trades for the same customer/date, do not guess; inspect equipment/customer context or ask.
- For registered + pending mixed batches, do not force everything through registered `sendEstimate`; pending RQ quote previews are manual/no-send until the reservation is registered or explicitly approved for sending.
