# Pending RQ Kakao manual quote + schedule correction

Use when a Kakao customer with an existing **pending `확인요청`** asks for a quote after changing equipment, especially when the user says to “read the conversation, modify the currently registered schedule/detail, and write a quote” but no `거래ID` exists yet.

## Trigger example

- Customer thread: asks to cancel items (`넉자 플로피`, `넉자 디퓨전`) and add another item (`스크림 1세트 더 추가`), then asks for a 견적서.
- Sheet state: `계약마스터`/`스케줄상세` has no registered trade yet, but `확인요청` has a full request group (e.g. `RQ-...`) with customer/phone/discount.

## Workflow

1. **Read actual Kakao context or queue evidence.** Treat `events.ndjson` previews as discovery only, but they can confirm recent customer deltas when actual room access is not needed for a non-send preview. Extract only explicit changes:
   - removals/exclusions (`대여 취소`, `사진도 괜찮습니다`)
   - additions (`스크림 1세트 더 추가해주세요`)
   - customer asks for document (`견적서를 받을 수 있을까요?`)
2. **Resolve pending request before registered-trade routes.** Search `확인요청` by customer name/phone and read the full request group by `요청ID`. If `dashboardSearch`/`tradeCandidates` returns no trade, do not force registered `previewQuote`.
3. **Apply correction logically to the quote payload.** Price only top-level rows from the pending RQ / `세트마스터` G열. Remove explicitly cancelled items even if they appear in the RQ. For “1 more” additions, update total quantity (e.g. existing `스크림세트` 1 + requested 1 = 2; if RQ already reflects 2, do not add a third).
4. **Use the official manual quote template, not a local substitute.** If no safe preview-only manual route exists, `sendEstimateManual` with blank/invalid phone is an expected no-send workaround: it returns `status:ERROR`, `연락처가 유효하지 않습니다`, plus a `fileId`/sheet URL. That means the sheet was created but no customer contact happened.
5. **Export only the 견적서 sheet.** For Google Sheets export, include `gid=0`; otherwise hidden/support sheets such as `마스터` can inflate the PDF into many pages. Verify the exported bytes start with `%PDF`, check page count, and extract/inspect totals.
6. **Keep customer-send approval-gated.** Final report: “고객 발송 아직 안 함,” attach/share preview, summarize reflected changes and total. Do not call the real send route with the customer phone until explicit approval.

## Verification checklist

- Pending `확인요청` group found and customer/phone/discount match.
- Removed items are absent from quote payload.
- Added item quantity matches the latest customer wording.
- Student/business/loyal discount label and final total are verified from the exported PDF/CSV/text.
- Exported PDF is a real single-page quote PDF (`%PDF`, `gid=0`) and not a multi-sheet workbook export.

## Pitfalls

- Do not search only `계약마스터`/`스케줄상세`; pending quote requests often have no registered `거래ID` yet.
- Do not use `목록` as pricing source. Use `세트마스터` G열/top-level rows.
- If a `sendEstimateManual` preview is attempted with a blank phone, the `ERROR` is expected; the returned `fileId` is the usable preview artifact. Do not describe it as a failed quote creation.
- Slack `send_message` may omit media attachments for Slack; if a PDF must be shared in Slack, provide the Drive URL or use a Slack-native file upload path when available rather than assuming `MEDIA:` delivered.