# Homepage 신규 장비 → 세트마스터/장비마스터/RQ 반영

Use when staff says a product is already on the homepage but reservation automation/세트마스터 does not recognize it (e.g. newly added camera body sets).

## Workflow

1. Verify the homepage product exists from the deployed site bundle or product page, but treat homepage as **discovery only**. Reservation truth is still `세트마스터` + `장비마스터`.
2. Read `세트마스터` for the closest existing set pattern. For a new Sony mirrorless body set, mirror the existing `소니 A7S3 바디세트` rows unless staff says otherwise:
   - body row with the new exact body name
   - `소니 CF-A 160` ×2
   - `소니 CF-A 리더기` ×1
   - `NP-FZ100` ×3
   - `NP-FZ100 충전기` ×1
   - first row carries the set price.
3. Add/verify the new set name appears in `목록` by running `refreshEquipmentList` after `세트마스터` mutation.
4. If availability should show stock, also add exact body/standalone product rows to `장비마스터`; otherwise expanded rows can remain `미등록 장비` even after the set exists.
   - Generate the next ID by prefix from existing `장비마스터` IDs (`CAM-###`, `MON-###`, etc.).
   - Use homepage price as a starting 단가 only when it matches the known staff intent; do not invent stock counts beyond obvious newly purchased quantity.
   - Run/schedule `syncAuditFromMaster` after adding master rows.
5. Rebuild the affected `확인요청` with `updateRequest` rather than only editing F cells when the wrong set was already expanded. This deletes stale expanded component rows and re-expands the new set.
6. `updateRequest` may drop M열 `할인유형` because its item-rebuild path does not preserve it. Read back the first row and restore the discount type if needed.
7. Rerun `확인`/availability and read back the whole RQ group. If all blocking issues are gone and the user asked to register, call `등록`, then verify `확인요청`, `계약마스터`, and `스케줄상세` by the resulting `거래ID`.

## Pitfalls

- A set existing in `세트마스터` alone can still show expanded body/standalone product rows as `미등록 장비` if `장비마스터` lacks the exact component/product name.
- Some legacy component spellings remain intentionally mismatched (e.g. `소니 CF-A 리더기` vs `장비마스터` exact `소니 CFA/SD 리더기`). Do not block registration solely on that legacy warning if the same warning is present in source sets and registration preflight does not treat it as blocking; report it as a cleanup item.
- Do not use `목록` as the source of truth; it is a generated validation/list surface.
- Customer-facing sends/Alimtalk are separate side effects. Registering a corrected RQ does not imply sending the customer anything.
