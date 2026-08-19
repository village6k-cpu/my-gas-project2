# Inventory count dispute: Notion overlap audit

Use when the owner says a stock count in current sheets/ledger conflicts with memory (e.g. “I’m sure we had 5, but records show 4”). This is especially useful for old/legacy periods before Village 2.0 was the sole source of truth.

## Why this matters

Old Notion rental calendar schedules can prove an operational minimum stock count: if the same exact item is scheduled in 5 simultaneous units, then the business either had at least 5 physical units available or used consignment/substitution/duplicate-entry workarounds. That is stronger evidence than a later physical-count seed row alone.

## Workflow

1. Identify exact item aliases and exclusions.
   - Example: `아마란 300C`, `아마란300C`, `어퓨쳐 아마란 300C`.
   - Exclude nearby but different items such as `어퓨쳐 노바 P300C`, `300X`, `600C`, `F21C/F22C`.
2. Check parsed export first if present:
   - `86_notion_schedule.jsonl` from the Notion calendar ingest — on Windows look under `C:\Village\VILLAGE_Brain` (no hits as of last verification; CSV sources listed in `C:\Village\VILLAGE_Brain\Raw\village-notion-calendar-source-manifest.md`).
3. If the parsed export is missing, flag a Windows data gap — no local Notion cache exists on Windows; re-export the jsonl to Brain or run this specific check via the Mac relay. If a Notion `.db` ever lands on Windows, query it with python's `sqlite3` stdlib:
   - DB: none on Windows (the mac-only Notion cache is not mirrored here)
   - Table: `block`
   - Use `type='page'`, `alive=1`, and parse `properties` JSON.
   - Page title format is usually: `<장비명> / <고객명> / 반출HH-반납HH(N회차)`.
   - Date property contains a nested Notion date object like `{type,start_date,end_date}`.
4. Convert each matching page into an interval:
   - Start = `start_date + checkout_hour`.
   - End = `end_date + return_hour`.
   - Treat intervals as half-open `[start, end)` so handoff at the same time does not double-count.
   - If the same-day return hour is earlier than checkout, treat it as next-day return.
   - Quantity defaults to 1 per page unless the title explicitly encodes a quantity like `x2` / `2대`.
5. Sweep-line the intervals and report:
   - max concurrent quantity,
   - every segment where concurrent quantity is at least the disputed count,
   - the exact customer/time rows causing the peak.
6. Interpret carefully:
   - A 5+ overlap is strong evidence against “stock was always 4”.
   - Still check for explicit consignment, substitution, cancellation, or duplicate-entry evidence before claiming physical stock with 100% certainty.
   - If multiple identical Notion pages exist, do not discard them automatically; legacy Notion often used one page per unit. Flag possible duplicate-entry ambiguity only when customer/name/time strongly suggests the same unit was accidentally duplicated.
7. Cross-check loss/missing evidence before concluding a present-day shortage:
   - current `equipment_ledger` + `equipment_events`,
   - live `스케줄상세`/dashboard checkout-checkin status,
   - Slack `재고관리-agent`,
   - 5-year Kakao raw threads,
   - Notion free-text notes for `분실`, `미반납`, `수리`, `고장`, `파손`, `안 보임`, `못 찾음`.

## Reporting shape

Keep it blunt and short:

- `Notion상 N대 동시 겹침 있음/없음` first.
- List 1–3 strongest overlap windows with customer rows.
- Then state whether any loss/missing/repair record was found.
- Distinguish:
  - “stock record is likely contaminated/stale”,
  - “physical location currently unknown”,
  - “confirmed lost/missing”.

## Example: Amaran 300C session finding

For `아마란 300C`, Notion local cache showed simultaneous 5+ overlaps:

- `2024-11-22 23:00 ~ 2024-11-23 05:00`: 6 concurrent rows
  - 진해인 ×2, 김진혁 ×1, 박홍준 ×1, 송준범 ×2
- `2025-08-12 12:00 ~ 22:00`: 5 concurrent rows
  - 김민기 ×1, 성시현 ×1, 정민교 ×1, 권도한 ×2
- `2024-07-06 18:00 ~ 2024-07-07 17:00`: 6 concurrent rows
  - 배창영/정주찬 side ×3, 장주찬/배창형 side ×3; name drift means duplicate-entry ambiguity should be mentioned.

In the same audit, no durable 300C loss/missing record was found: current ledger was `5/0/정상`, `open_issues=[]`; Slack searches for `300C 미반납/분실/파손/수리` were empty; Kakao hits were location/contract confusion, not confirmed loss; and current open dashboard row `260630-010` had 300C body/AC line/A-stand checked in, with the remaining unreturned issue on a 600X C-stand instead.