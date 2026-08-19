# Village 서류발송 채널 오분류/정리 노트

Use when a reservation/check/repair/payment automation report appears in the Village document-send Slack channel and the user asks why it landed there or asks to clean it up.

## Symptom seen

A bot report titled like:

- `[예약 후보 확인] ... 당일 예약 확인요청 입력 및 18시 수령 안내`
- `[예약 후보 확인]`, `확인요청`, `가용확인`

was delivered to the 서류발송/document-send workflow even though it was a reservation/schedule operation, not a document-send task.

## Correct classification

Document-send channel/workflow is only for explicit document requests:

- 세금계산서 / 현금영수증
- 견적서
- 거래명세서
- 계약서
- 증빙 문서발송/생성/미리보기
- 사업자등록증·통장사본 standard document handoff

These are **not** document-send work and should route elsewhere, even if the text contains `견적서`/`계약마스터` as secondary context:

- 예약 후보 확인
- 확인요청 입력
- 가용확인
- 재고/가용 상태처리
- 반납/연장/변경 or 완료 처리 기록
- 파손/수리/미반납/장비 문제
- 입금/결제 확인 or 정산 업무
- 카카오 대화 확인 불가 / target-mismatch diagnostics

## Cleanup pattern

1. Treat cleanup as Slack bot-message cleanup: only delete Hermes/헤이빌리 bot-authored messages, not human messages.
2. Pull recent target-channel history first and classify messages manually into keep/delete buckets; `서류발송-agent` may still contain legitimate staff threads and real document bot cards.
3. Dry-run delete by exact `message_ts` when the bad set is known. This is safer than broad keyword deletion because many legitimate document cards contain support words like `RQ`, `가용확인`, or `견적`.
4. For discovery searches, use report-type keywords in the target channel, e.g.:
   - `예약 후보 확인`
   - `확인요청`
   - `가용확인`
   - `파손`, `수리`, `미반납`, `장비 문제`
   - `반납/연장/변경`
   - `입금/결제 확인`
   - `완료 처리됨`
   - `카카오 대화 확인 필요`
5. Preserve legitimate document messages such as `[계약/서류]`, `[세금계산서/증빙]`, 견적서 작성/발송 준비, 거래명세서/계약서/증빙 requests, and staff-authored document commands.
6. Delete only after the user's requested scope is clear or they explicitly ask to clean/delete the misrouted messages.
7. Verify with channel history or the same keyword searches and report remaining count, not just “deleted.”

## Routing fix to remember

For Slack follow-up routing, structured intent must override evidence words. If the structured type is reservation/schedule/availability/checkin/repair/payment, do not route to 서류발송 just because the text mentions `계약마스터`, `견적서 확인`, `계약서 링크`, or schedule/contract lookup evidence. Only route to 서류발송 when the **user-facing request** is to create/preview/send a quote, statement, contract, proof, tax invoice, cash receipt, or standard business/bank document.

Same-conversation follow-ups should not become a new top-level task/card for every fragment. Update the active follow-up row or post as a Slack thread reply under the main task card; reserve new top-level cards for genuinely new customer/work topics.
