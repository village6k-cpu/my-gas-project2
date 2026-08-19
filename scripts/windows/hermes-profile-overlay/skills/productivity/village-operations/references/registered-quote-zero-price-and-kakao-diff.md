# Registered quote: zero-price rows and Kakao screenshot diffs

Use when staff says `이거 견적서` (or similar preview wording) with a Kakao/Slack screenshot and a registered trade already exists, or when `previewQuote` CSV shows a top-level item at 단가/금액 0.

## Route choice

1. Parse customer name, checkout date, discount, and requested top-level items from the screenshot/thread.
2. Call schedule `tradeCandidates` (name + date). 
   - Exactly one `tradeId` → **registered official path** (`previewQuote` / later `sendEstimate`).
   - Zero candidates → manual Kakao preview (`manual-kakao-single-quote-preview.md`).
   - Multiple → stop and ask.
3. Do **not** rebuild a registered trade with `sendEstimateManual` just because the evidence is a Kakao screenshot.

## Registered path checklist

1. Search raw `스케줄상세` by `거래ID` (`action=search&sheet=스케줄상세&query={tid}`).
2. Diff Kakao-requested top-level items vs schedule top-level/price rows.
3. Fix schedule **before** document generation:
   - Missing priced item → `addEquips` with exact `세트마스터` name.
   - Wrong item / zero-price custom alias → see below.
4. `GET {DOCUMENT_API}?action=previewQuote&key=...&id={tid}&discountType=...`
5. Export CSV and verify customer, period, every paid line, discount label, VAT total.
6. Attach PDF. State customer send not done. Only `보내/발송/전송` triggers send.

## Zero-price top-level fix

Custom aliases that are not exact priced `세트마스터` rows (example: `17인치 모니터(구형)`) often register with `L` 단가 `0` and appear free on the official quote.

**Wrong**
- `updateEquipName` to a priced name and hope `L` updates — it does not; name columns change, unit price stays.
- Leave the 0원 line and “note it” if the monitor was clearly billable.

**Right**
1. Capture `scheduleId` of the bad top-level row.
2. `removeEquip` with `tid` + `scheduleId` (live write — see dry-run pitfall).
3. `addEquips` the exact priced catalog name (`BON 17인치` / `SEETEC 17인치` / staff-confirmed equivalent).
4. Re-read raw `스케줄상세` and confirm positive 단가.
5. Then `previewQuote` and CSV-check.

## Critical API pitfalls

- **`removeEquip` has no dry-run.** sheetAPI does not forward `dryRun` to removal. A probe with `dryRun:true` can still delete. Verify identity first; remove once; restore with `addEquips` if needed.
- **`addEquips` dry-run is real** (`dryRun:true` → availability only). Use it for additions, not removals.
- **`previewQuote` may return `cached:true`.** After schedule edits it should often be `cached:false`, but always export CSV anyway.
- Document webapp default ops key falls back to `village2026` when `VILLAGE_OPS_KEY` is unset; prefer env when present. Never print keys.

## Kakao vs schedule reporting

Before approval, explicitly report:

- **Schedule-only extras** staff may have added (example: `C스탠드` × N when Kakao asked for something else).
- **Kakao-only missing/unmastered** items (example: `슬레이트` with no priced master row) — omit or 0원 only with clear assumption; do not invent price.
- Alias choices used for matching, e.g.:
  - `e to PL` / `E-PL` → `메타본즈 PL(E-PL)`
  - `홀리랜드 파이로7` → `파이로 7`
  - `솔리드컴 C1 pro` 4구 → usually `홀리랜드 솔리드컴 4S` when SE 4S is already a separate line
  - `틸타 뉴클리어스M` → `틸타 뉴클리어스-M` / `뉴클-M`

## Related

- Full registered item replacement workflow: `registered-quote-schedule-item-correction.md`
- Unregistered Kakao manual preview: `manual-kakao-single-quote-preview.md`
- Natural-language document resolve without forcing 거래ID from staff: `document-send-natural-language-resolution.md`
