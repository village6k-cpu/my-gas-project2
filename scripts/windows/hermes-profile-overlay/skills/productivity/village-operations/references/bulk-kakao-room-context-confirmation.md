# Bulk Kakao room-context confirmation

Use this when the user gives a list of Kakao customer names and asks to check whether `확인요청` should be entered.

## Non-negotiable evidence rule

Do not decide from the first event, top-row preview, or sheet history alone. The workflow must open each customer room in `🤖 자동화 크롬` and read the actual visible conversation body around the current request/acceptance.

If the actual room body cannot be opened/read, report `본문 미확인 → 임의 입력 보류` and do not mutate.

## Required sequence

1. Resolve each customer room using watcher/queue data only as a locator.
2. Open the exact customer chat in the automation Chrome profile (`🤖 자동화 크롬`, normally Profile 3).
3. Verify the AX/window title or room header includes the target customer before reading evidence.
4. Read the recent conversation cluster, including:
   - customer reservation block: name/phone/type/items/dates
   - staff availability response such as `네 가능합니다`
   - latest customer acceptance such as `예약진행 부탁드립니다`, `예약해주세요`, `넵 감사합니다`
5. Check `계약마스터`, `스케줄상세`, and existing `확인요청` by phone/name/date to avoid duplicates.
6. Insert `확인요청` only for conversations that have a complete request and customer intent to proceed, or where staff already accepted and the customer asked to book.
7. Rerun availability/`action=확인` after insertion and read back the resulting RQ rows.
8. Report request IDs plus warnings (`모델 선택 필요`, `미등록 장비`, assumptions in item matching). Keep customer-send/registration/payment separate unless explicitly requested.

## Pitfalls from the 2026-06-30 correction

- Short previews like `네~!`, `네 감사합니다`, or `감사합니다!` can hide a full reservation block earlier in the same room. Treat them as a signal to open the room, not as proof there is no work.
- Sheet history can show old reservations for the same customer; that does not prove the current Kakao request is already registered. Match by current date/time/items/phone.
- Some current requests are add-ons to an existing registered trade. If staff says `잡아드렸습니다`, still verify whether the add-on actually appears in `스케줄상세` or whether a new `확인요청`/record correction is needed.
- `세트마스터` aliases matter: e.g. `70-200 gm2` → `소니 GM 70-200mm II`, `ksh17 프롬프터` → `KSH17 프롬프터`, `마스 m1` → `마스 M1`, `스팟라이트` may need `어퓨처 스팟마운트` or explicit model warning depending on context.

## Final-report shape

```text
확인 완료 / 입력 완료:
- 고객명: RQ-... / 기간 / 핵심 장비 / 주요 경고
- 고객명: 기존 거래ID ... 확인 → 신규 입력 X

미해결:
- 모델 선택 필요: ...
- 미등록/구성품 확인: ...
```

Do not over-explain the recovery process unless the user asks; in a frustration context, acknowledge the mistake once and give the operational result.