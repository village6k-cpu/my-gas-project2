# Reservation missing-contact guard

Use when modifying Village Kakao/customer automation or GAS reservation-confirmation flows around 예약문의 where the customer's phone number is absent.

## Durable rule

A reservation inquiry can be parsed and discussed without a phone number, but it must not be registered/inserted as a confirmation request unless a contact phone is available from either:

1. the visible Kakao/customer conversation, or
2. a unique existing Village customer DB/profile match.

If both are missing, ask for contact first. Use language like:

> 감독님, 예약 등록은 연락처가 있어야 가능해서 먼저 연락처 부탁드립니다. 연락처 확인되면 바로 이어서 확인 도와드리겠습니다.

Do not answer stock/availability/price first when the phone is the blocker.

## Lookup sequence

1. Inspect the actual Kakao/customer conversation for a phone number.
2. If absent, search the stored profile/customer DB by customer name.
   - `고객DB` columns in the GAS project are typically: A=phone, B=customer name, C=affiliation, I=loyalty/partner flag when present.
   - Treat exactly one matching phone as usable.
   - Treat zero matches, multiple matches, or unclear customer name as missing contact.
3. Only after phone is available should the automation proceed to `insertAndCheckRequest` / confirmation-request write.

## GAS-side hard guard

Do not rely only on prompt instructions. In `insertAndCheckRequest`, resolve the usable phone **before** any existing-RQ or registered-schedule duplicate check:

- if `req.연락처` is blank, lookup `고객DB` by exact `예약자명`,
- use the match only when exactly one nonblank phone is found,
- copy that resolved phone into the request object used by duplicate detection,
- otherwise throw a structured error such as `NO_CONTACT: 연락처가 없으면 예약 등록이 불가능합니다 ... 고객에게 연락처부터 요청하세요.`

This prevents accidental blank-phone `확인요청` rows even when the AI prompt chooses the wrong `should_write_to_sheet` value.

Duplicate protection must compare same real customer by phone as well as name:

- existing `확인요청`: same phone dedupes even when Kakao nickname and 예약자명 differ; if same name but explicit phones differ, treat as 동명이인.
- registered `스케줄상세`/`계약마스터`: pass phone into the registered-duplicate check and compare against 계약마스터 연락처, not just 예약자명. This prevents cases like a customer’s already-registered trade being re-entered as another RQ because the visible Kakao label and reservation name differ.
- perform the registered-duplicate check before creating a new RQ, using the phone resolved from `고객DB` if Kakao supplied no phone.
- `❌ 연락처 입력 필요` or similar validation text in O열 is not a finalized request; after phone is resolved it can be stale-replaced with the latest full equipment list. Only trade ID, `등록완료`, or explicit `거절/보류/취소` should protect a group from stale replacement.

## Worker-side handling pattern

- Expose a read-only `customer_db_by_name_search_template` in lookup context so the AI can check DB before deciding.
- Expose existing `확인요청` lookup columns through at least A,B,C,D,E,F,G,I,J,K,L,M,N,O,P,Q,R; L/O/P are required to distinguish a true completed/registered request from a stranded `❌ 연락처 입력 필요` row.
- Prompt rule: missing phone + no unique DB match => `should_write_to_sheet=false`, reply/follow-up asks for contact first.
- Existing RQ rule: if L is blank or O contains `연락처 입력 필요`, availability results are secondary; the operational sequence is `연락처 즉시 요청 → 연락처 입력 → 가용 재확인 → 등록`.
- Classify `NO_CONTACT` GAS errors as a distinct `no_contact` error type, not generic sheet validation.
- `no_contact` should produce a contact-request follow-up or safe auto-reply; other sheet-write rejections should continue to block auto-send.
- Auto-send safety filters must not mistake “예약 등록은 연락처가 있어야 가능” for “예약 가능/확정”. Add/keep a contact-first exception that allows only phone-request wording and still blocks availability, price, payment, refund, damage, or confirmation commitments.

## Verification checklist

- Unit test prompt contains: customer DB lookup, `should_write_to_sheet=false` when no phone, and contact-first wording.
- Unit test lookup context contains `고객DB` name-search URL.
- Unit test `NO_CONTACT` classification returns `error_type: no_contact`.
- Unit test contact-first auto-reply is allowed, while “네 예약 가능합니다” remains blocked unless staff-confirmed acceptance rules apply.
- After code changes, run worker tests and syntax check before deploying GAS or restarting automation.
