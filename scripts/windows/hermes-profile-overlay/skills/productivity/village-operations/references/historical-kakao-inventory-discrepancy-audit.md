# Historical Kakao inventory discrepancy audit

Use when staff says their memory of physical stock conflicts with `장비마스터`/ledger/sheet records and asks whether old Kakao history can reveal what happened.

## Goal

Separate three things before answering:

1. **Current truth** — `equipment_ledger` + current `장비마스터` mirror.
2. **Data lineage** — old 실사 values, sheet seed/import artifacts, and `equipment_events` edits.
3. **Historical evidence** — Kakao/Slack traces showing count assumptions, missing-location incidents, purchase/addition notes, repair/loss notes, or contract-vs-actual mismatches.

Do not let a single stale 실사 row override the current ledger if the event history shows it was corrected.

## Search pattern

For an item like `어퓨쳐 아마란 300C`:

1. Search local Kakao raw corpora first:
   - `C:/Village/VILLAGE_Brain/Raw/kakao/01_threads.jsonl`
   - `C:/Village/VILLAGE_Brain/Raw/kakao/01_internal_threads.jsonl`
   - `C:/Village/VILLAGE_Brain/Raw/kakao/04_final.jsonl`
2. Use multiple alias families, not only the exact current ledger name:
   - exact/near exact: `아마란\s*300\s*[cC]`, `300\s*[cC]`, `amaran\s*300\s*[cC]`
   - brand/model variants: `아마란`, `어퓨쳐`, `amaran`, common typos
   - count/action clues near the item: `재고`, `총`, `\d+대`, `부족`, `안 보`, `어디`, `반출`, `반납`, `준비`, `세팅`, `구입`, `추가`, `수리`, `고장`, `파손`, `분실`, `실사`, `CCTV`
3. De-duplicate by `thread_id`; prefer full thread context over isolated matching lines.
4. Classify each thread:
   - `purchase/add`
   - `stock/count`
   - `damage/missing/repair`
   - `rental/ops`
   - `mention/noise`
5. Print a timeline of direct mentions first, then broader clues.

## Interpretation rules

- `"현재 2대만 보임 / 반출 나가있는 건 1대라 3대가 있어야 함"` proves a staff count model at that time, not final physical truth.
- `"가지고 갔지?" → "안 가지고 갔는데 결제했어요"` is strong evidence of contract/checkout mismatch risk, not a stock-count update by itself.
- `"반납 들어온 팀에 N대 있네"` is useful for physical-location evidence and can explain why units were seen together.
- `"위치가 옮겨졌을까요" → "아직 반납 안 됐네요"` indicates apparent shortage may be location/return-state, not actual loss.
- Absence of an exact `5대` sentence does not disprove the owner’s memory if current ledger is verified and old records show seed/실사 contamination.
- Absence of loss/repair Slack/Kakao records is supporting evidence only; never claim no loss happened unless current ledger + events + operational history all support it.

## Current truth cross-check

Before final report, verify:

1. `equipment_ledger` row: `stock_total`, `stock_maint`, `state`, `verify_status`, `open_issues`, `last_verified_at`.
2. Recent `equipment_events` for count edits, alias additions, issue edits, or seed/import anomalies.
3. Current `장비마스터` mirror and old `실사 기록` separately.
4. Recent registered schedules for the item if the user is asking why it is physically missing today.

## Final report shape

Keep it short and operational:

- `현재 원장 기준: N대`
- `기록이 꼬인 지점: ...`
- `Kakao에서 잡힌 단서: 3~5개 bullet, 날짜 포함`
- `가능성 높은 원인 순서`
- `다음 현장 액션: 라벨링/사진/실사값 정리/캐시 갱신`

Do not over-explain generic data theory. The user wants a likely cause and the next action.
