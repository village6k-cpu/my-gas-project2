# Popbill Kakao send audit for Village document/schedule work

Use this when a customer appears to have received duplicate Kakao/알림톡 messages after a schedule/document operation.

## Durable lesson from 한미령 260619-001

A Slack/user screenshot showed three identical yellow Kakao admin bubbles saying `알림톡/친구톡 메시지는 관리자센터에서 확인할 수 없습니다.`. They looked like three duplicate quote sends, but Popbill history showed they were three different approved Kakao messages to the same phone:

1. 예약 확정 알림톡 — sent automatically by `my-gas-project2` registration flow when the schedule was registered.
2. 반출 안내 알림톡 — sent automatically by `checkGuideAlimtalk` because checkout was within the guide window.
3. 견적서 알림톡 — sent by the explicit quote send after user approval.

Do **not** infer duplicate quote sends from the Kakao Channel Manager UI placeholder. The UI hides 알림톡/친구톡 contents, so different templates can look identical there.

## Investigation pattern

1. Identify customer name/phone and date from the thread/screenshot.
2. Query Popbill Kakao search for that phone/name/date, not just the ledger note.
3. Compare `content`, `sendDT`, `receiptNum`, `template`/message wording, and `btns`.
4. Report whether the apparent duplicates are:
   - same document/template repeated, or
   - distinct workflow notifications (reservation confirmation, checkout guide, quote, proof, etc.).

## API shape that worked

Popbill Kakao REST search endpoint:

```text
GET https://popbill.linkhub.co.kr/KakaoTalk/Search
  ?SDate=YYYYMMDD
  &EDate=YYYYMMDD
  &State=2
  &Item=ATS
  &ReserveYN=false
  &SenderOnly=false
  &Page=1
  &PerPage=100
  &Order=D
  &QString=<phone digits or customer name>
Authorization: Bearer <Popbill member/153 token>
```

Useful broader query:

```text
State=0,1,2,3,4,5,6,7,8,9&Item=ATS,FTS,FMS
```

`result: 100` / `state: 3` means delivered/processed successfully in the examples observed. Keep credentials out of transcripts and summaries.

## Operational pitfall

When registering a schedule close to checkout time, expect automatic messages from `my-gas-project2`:

- `sendRegisterCompleteAlimtalk_` may send reservation confirmation once per trade ID if `POPBILL_TPL_REGISTER` is configured.
- `checkGuideAlimtalk` may send checkout/return guide messages based on timing and customer usage count.

Before saying “only the quote was sent,” verify whether these automatic messages fired. In user-facing reports, explicitly distinguish: `예약확정 1통 + 반출안내 1통 + 견적서 1통`, etc.