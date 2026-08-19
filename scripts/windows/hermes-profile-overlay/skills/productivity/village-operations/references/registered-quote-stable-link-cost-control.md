# Registered quote stable-link / Popbill cost-control policy

Use for Village registered-trade 견적서 sends and resends.

## Problem learned

Sending or resending a quote through the old route generated/sent a fixed PDF link every time. That meant each correction/resend could call Popbill Alimtalk again, wasting cost and consuming Apps Script `UrlFetchApp` quota. When quota is exhausted, GAS can return `하루에 urlfetch 서비스를 너무 많이 호출했습니다`, blocking PDF export and Popbill calls.

## Preferred policy

- Registered-trade quote sends should default to a **stable live quote link**:
  - `...?action=quote&id={거래ID}`
  - include `discountType=` when the send uses an ad-hoc discount override.
- Popbill Alimtalk should be called **only once per 거래ID + discount policy**.
- Mark the trade note with a durable marker such as:
  - `[견적링크:discount=계약마스터]`
  - `[견적링크:discount=단골]`
- On later quote edits/resends with the same marker, do **not** call Popbill again. Append a note like `견적 수정 반영 / 기존 견적 링크 유지 / Popbill 재호출 생략` and rely on the already-sent stable link opening the latest PDF.

## Exceptions

Direct PDF Alimtalk sends are allowed only when a stable trade link cannot represent the document, for example:

- combined/batch PDF sent once to one recipient;
- mixed-recipient or cross-trade merged quote package;
- explicitly requested fixed PDF resend.

Require an explicit flag/intent such as `forcePdfUrl: true`, `deliveryMode: "pdf"`, or `linkMode: "pdf"`. Do not treat a supplied `pdfUrl` alone as permission to spend another Popbill send.

## Implementation guardrails

- `sendEstimate` for registered trades should default to the stable-link helper, not `sendQuoteByFileId` or raw `pdfUrl` delivery.
- Failed Popbill sends must return `status: ERROR` / `success:false`; never report `OK` with a failure message.
- Cache Linkhub/Popbill access tokens with `CacheService` to reduce `UrlFetchApp` usage.
- If GAS `UrlFetchApp` quota is exhausted during an approved urgent send, a direct Popbill REST fallback can be used, but verify `receiptNum`/delivery status and append/read back a ledger note because normal GAS side effects may not have completed.

## Verification checklist

- Static check: stable-link helper exists and skip-marker branch occurs before `sendContractAlimtalk`.
- Static check: direct PDF route requires an explicit force flag.
- Static check: token cache read occurs before Linkhub token `UrlFetchApp.fetch`.
- Runtime no-side-effect check: call `sendEstimate` with a nonexistent 거래ID and verify it returns `거래ID 없음` without sending.
