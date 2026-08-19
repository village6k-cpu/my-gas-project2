# Staff CCTV / missing accessory report workflow

Use when staff reports that a customer returned fewer small accessories than were checked out and asks for CCTV confirmation, e.g. `FX9 2세트 반출한 날 노가암 7개 반출했는데 6개만 반납함. CCTV 확인 필요`.

## Workflow

1. Treat it as an inventory/return exception in `재고관리-agent`, not as a document/payment/customer-message task.
2. Resolve the registered trade from live schedule data:
   - Search by customer name first (`tradeCandidates`, then `dashboardSearch`).
   - Use the equipment clue (`FX9`, `노가암`, etc.) to choose the exact trade when the customer has multiple reservations.
   - Verify the trade’s checkout/return time and the relevant equipment row before writing anything.
3. Locate the specific schedule row in `dashboardSearch.equipments`:
   - For bundled accessories, the row may be a component row, e.g. `SDI 롱라인, SDI 라인, 노가암` under `소니 FX9 풀세트`.
   - Record the visible scheduleId/quantity as evidence.
4. Record the exception in the dashboard equipment-check layer:
   - `updateEquipmentCheck(... field=returnStatus, value=미반납)`
   - `updateEquipmentCheck(... field=memo, value="품목 N개 반출 / M개 반납 → 차이 X개 미반납. CCTV 확인 필요. 제보: {staff/date}.")`
5. Verify by re-reading `dashboardSearch` for the trade and confirm `returnStatus`, `returnMemo`, and `equipmentCheckRow` changed.
6. If CCTV/NAS is not reachable from the current environment, do not claim video review. Report the exact verified schedule timestamps that staff should inspect:
   - setup/checkout timestamp if present (`setupDoneAt`) and/or scheduled checkout time
   - return timestamp if present (`returnDoneAt`) and/or scheduled return time

## Reporting shape

Keep it short:

- `처리함` / `기록 완료`
- 거래ID + customer
- relevant row + quantity
- `반납상태=미반납`, memo summary
- CCTV 확인 window(s)
- If video was not actually reviewed, explicitly say `CCTV 직접 확인은 못 했음`.

## Pitfalls

- Do not mark the whole contract as unresolved if only one accessory is missing; use the equipment-check return status/memo layer.
- Do not mutate inventory ledger/stock count or charge the customer from staff text alone. CCTV/physical confirmation or owner approval is needed for responsibility/claim decisions.
- Dashboard checklist booleans can show a component as checked in even when staff later reports a count discrepancy; the staff report should be captured as `미반납` + memo so it surfaces in 확인필요.
