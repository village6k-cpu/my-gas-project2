# 반납일 전 미반납 팀 / V마운트 배터리 미반납 후보 triage

Use when staff asks who has not returned yet because the return date has not arrived, or asks which team likely has missing V-mount batteries.

## Data sources

- Primary live schedule: `스케줄상세` + `계약마스터` joined by `거래ID`.
- Fast resolver/search: `dashboardSearchIndex` and exact `dashboardSearch&q={거래ID}&profile=1`.
- Equipment-check evidence: dashboard item flags and `장비체크` fields exposed by `dashboardSearch`:
  - trade-level: `setupDone`, `returnDone`, `returnStatus`, `returnMemo`
  - row-level: `checkedCheckout`, `checkedCheckin`

## Workflow

1. Get current KST time first; classify against actual timestamp, not just date.
2. Build active/not-yet-due list from `스케줄상세` rows where:
   - `반출일시 <= now < 반납일시`
   - `계약마스터.계약상태` is not `반납완료` or `취소`
   - schedule row `상태` is not `취소`
   - group by `거래ID`; show top-level/header equipment only in the staff-facing answer.
3. Separately list overdue-not-returned rows where `반납일시 <= now` and the contract is not `반납완료/취소`. Do **not** include these in “아직 반납일자 안 됨” answers; call them out separately if relevant.
4. For V마운트/브이마운트 battery suspicion, inspect exact candidate trades, not only an equipment-text search:
   - Search broad aliases (`V마운트 배터리`, `브이마운트`, `V마운트`) for candidates, but know that `dashboardSearch` may miss component rows inside a set.
   - Exact-search likely overdue/active `거래ID` values to read the full `equipments` list and row-level check flags.
   - Treat `checkedCheckout=true` + `checkedCheckin=false` on a V마운트 배터리 row as strong missing/unreturned evidence.
   - If `returnStatus`/`returnMemo` says `반납완료`, downgrade the suspicion even if contract status was not updated.
   - If neither checkout nor checkin is checked, report as lower-confidence / record incomplete, not definitely missing.
5. When answering, separate:
   - 정상 대여중 / 반납일 전 teams
   - already overdue teams
   - likely V-mount missing team(s), with battery count and reason (`체크아웃 O / 체크인 미체크`, return due time passed)

## Report shape

Keep it short and operational:

```text
기준: 7/2 08:29

아직 반납일 전:
- 이름 `거래ID` — 반납 M/D HH:mm — 주요장비

V마운트 미반납 유력:
1순위: 이름 `거래ID` — V배터리 N개(+충전기 N개), 반납 M/D HH:mm 지남, 체크아웃 O / 체크인 미체크

참고: 아직 정상 대여중 V배터리: 이름 N개, 반납일 ...
```

## Pitfalls

- Do not answer from Slack history alone; use live schedule/contract data.
- Do not conflate “계약상태가 아직 예약” with “not returned yet” without comparing return datetime and dashboard check flags.
- Do not put overdue returns in the “아직 반납일자 안 됨” list.
- Equipment search results can omit component rows; exact trade lookup is required before ruling out V-mount batteries in a set (e.g. FX6/FX3/BURANO components).
