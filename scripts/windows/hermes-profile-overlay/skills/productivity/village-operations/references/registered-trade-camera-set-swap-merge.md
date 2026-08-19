# Registered trade camera-set swap via merge registration

Use when staff asks to change an **already-registered** reservation's main camera set
(e.g. Kakao: FX9 풀세트 → 부라노 베이직, plus time nudge and add-ons like 뉴클리어스-N).

## Why the simple correction path breaks

`village-registered-trade-correction.js` can:

- `scheduleChangeDates` (times/dates) — usually OK
- `scheduleRemoveEquip` by set header `scheduleId` — removes the whole set
- `scheduleAddEquips` with exact `세트마스터` names

But **`scheduleAddEquips` cannot choose models**. For `소니 BURANO 베이직세트`,
availability expands generic components and returns:

`가용 불가: 7인치 모니터 모델 선택 필요, 매트박스 모델 선택 필요`

There is no entry field for component model overrides on that route.
Do **not** keep retrying add expecting it to succeed.

## Dangerous partial state

If remove already succeeded and Burano add failed, the trade can be **camera-less**
(only leftovers like 메타본즈 / F6 / filters). Treat that as an emergency restore:

1. Do not report "done" or stop for a long explanation.
2. Immediately complete the intended camera set via the merge path below.
3. Only after readback shows the new set header + extras, report to staff.

`ScriptLock` `BUSY` (`다른 변경 작업 처리 중`) is common after date/remove/regen.
Retry remove/add with backoff; date-only success does not mean the full job is done.

## Preferred workflow (set swap + optional time + add-ons)

1. Resolve `거래ID` and raw `스케줄상세` (`lookup --domain schedule` / `search&sheet=스케줄상세&col=B`).
2. Apply **time/date first** when requested (correction `dateChange` or equivalent).
   Verify contract + all schedule rows moved (e.g. 05:00 → 04:30).
3. Remove the old camera set by **header `scheduleId`** only
   (`expectedName` e.g. `소니 FX9 풀세트`). Confirm components are gone.
4. **Do not** call `scheduleAddEquips` for `소니 BURANO 베이직세트` / `풀세트`
   when you know model selection is required. Go to merge registration.
5. Create one `확인요청` with the **same** `예약자명`, verified `연락처`,
   **same** 반출/반납 date-time as the live trade, and the **new** top-level items only
   (Burano set ± 틸타 뉴클리어스-N, etc.). Prefer
   `village-confirm-request.js create` with exact catalog names.
6. Fix blocking model rows on the RQ (F열), clear I/J, rerun `action=확인`:
   - `7인치 모니터` → `스몰HD INDIE7`
   - `매트박스` → `틸타 MB-T16(미라지)`
   Kit-component `❓ 미등록 장비` under the set is usually OK (see Burano pitfalls).
7. `action=등록` once. Success message should be **`등록완료(합침)`** and P열 = existing `거래ID`.
   Same name + same interval + phone match triggers merge into the live trade.
8. Readback:
   - `dashboardSearch&q={거래ID}&summary=1`
   - raw `스케줄상세` top-level: new set header price (Burano 베이직 200000),
     add-ons (뉴클-N 10000), preserved extras, **no** old FX9 header
   - times match the requested 반출/반납
9. Quote/send only if staff asked; schedule change alone is not send approval.

## What to leave alone

- Unaffected extras already on the trade (adapters, audio, filters).
- Customer discount type on `계약마스터` unless staff changed it.
- Side requests like “김민준 B7C 같이 받아가기” when no matching 김민준 schedule
  exists: report and ask; do not invent a second trade or bill B7C onto 강지민.

## Related

- Direct (new) Burano RQ model fixes: [burano-direct-registration-pitfalls.md](burano-direct-registration-pitfalls.md)
- Generic date/remove correction runner: [registered-trade-date-change-remove-item.md](registered-trade-date-change-remove-item.md)
- Quote item correction after schedule is right: [registered-quote-schedule-item-correction.md](registered-quote-schedule-item-correction.md)
