# Alternate-recipient registered quote preview

Use when staff asks to send a registered-trade quote/document for one customer to a different named recipient, e.g. `강지민 견적서 허성한테 보내 주자`.

## Workflow

1. Resolve the registered trade by the document customer first.
   - If no date is supplied, call `tradeCandidates` with `date=` as a fallback.
   - If candidates include exactly one active/upcoming `예약` row plus historical `반납완료`/cancelled rows, select the active row for **preview only** and clearly report the basis.
   - If multiple active/upcoming rows remain, stop and ask for date/selection.
2. Generate the official registered quote preview with `previewQuote` and inspect/export the CSV/PDF.
3. Resolve the alternate recipient separately from `고객DB` or another verified contact source.
   - Do not assume a partial name is enough if multiple customer rows match.
   - If a unique phone is found, report it as the proposed manual recipient.
4. Do **not** call registered `sendEstimate` for alternate-recipient sends. That route uses the trade customer/phone and would contact the registered reservation customer, not the named alternate recipient.
5. Attach/show the preview PDF and summarize customer, period, items, discount, total, and alternate recipient/phone.
6. State explicitly: `고객 발송은 아직 안 했음`. Wait for approval such as `보내` before doing a manual/recipient-adjusted send.

## Report shape

- `보류/미발송`
- 거래ID + selected-candidate basis
- official quote PDF attachment/link
- total amount and key items
- registered-route recipient warning
- verified alternate recipient phone or `연락처 확인 필요`
- one next action: approve send or provide recipient phone
