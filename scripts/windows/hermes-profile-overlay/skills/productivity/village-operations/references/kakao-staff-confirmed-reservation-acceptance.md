# Kakao staff-confirmed reservation acceptance

When Kakao automation sees a customer reply like `그럼 이렇게 부탁드립니다`, do not classify from that text alone as a fresh ambiguous reservation candidate.

## Pattern

Conversation order matters:

1. Customer asks for a rental/reservation configuration.
2. Staff/outbound (`빌리지님`, `김준영님`, `최재형님`, etc.) already answers with availability/permission, e.g. `가능합니다`, `예약 가능`, `진행 가능`.
3. Latest customer/inbound message accepts that answer: `그럼 이렇게 부탁드립니다`, `진행해주세요`, `예약해주세요`, `이렇게 해주세요`.

## Correct handling

- Treat as **staff-confirmed reservation acceptance**, not generic `예약 후보 확인 필요`.
- If the required sheet/register mutation has already succeeded or can be safely inferred from the automation path, use a short confirmation draft/auto-send candidate:
  - `네 감독님, 말씀 주신 구성으로 예약 확정해드렸습니다.`
- If mutation is unavailable/failed, create exactly one operational follow-up that names the failed mutation (`확인요청 입력 실패`, `등록 실패`, etc.). Do not make a vague `답변 필요 / 예약 후보 확인 필요` card.
- Keep existing safety: do not use this pattern for price/payment/refund/damage/legal/tax-sensitive commitments.

## Code guard pattern

`canAutoSendCustomerAnswer` may still block `예약 확정` or `가능` wording by default. Add a narrow exception only when visible message order proves:

- latest meaningful message is customer/inbound,
- a prior staff/outbound message contains a positive availability phrase,
- latest customer text is an acceptance/request-to-proceed phrase,
- proposed reply is a short confirmation and contains no payment/price/refund/damage terms.

Regression-test with the exact shape:

```js
visible_messages_used: [
  { sender: '빌리지님', message: '네 감독님, 해당 구성 예약 가능합니다.' },
  { sender: '김채현', message: '그럼 이렇게 부탁드립니다' }
]
reply_decision.text = '네 감독님, 말씀 주신 구성으로 예약 확정해드렸습니다.'
```
