# Cloning an existing registered reservation into a new schedule

Use when staff says a customer should get “the same equipment as the previous/other date” with small exclusions, and asks for direct schedule registration.

## Workflow

1. Resolve the source trade by `dashboardSearch` / `tradeCandidates`.
   - Prefer exact `거래ID` if known.
   - If the user gives a source date in natural language but `tradeCandidates` misses, search `계약마스터`, `확인요청`, then `dashboardSearch` by customer name and pick the matching date/time.
2. From `dashboardSearch`, copy only `equipments[].isHeader === true` rows as top-level requested items.
   - Do not copy component rows as requested equipment unless staff explicitly asked for individual components.
   - Preserve quantities from header rows.
3. Apply exclusions against header `name`/`setName` before insertion.
   - Example: “아마란 F22C랑 에코플로우만 빼고” means exclude `아마란 F22C` and any `에코플로우 ...` header such as `에코플로우 델타2 맥스`.
4. Call `insertAndCheckRequest` for the new date/time and then register (`action=등록`) only if the user asked for schedule registration, not just availability.
5. Verify with `dashboardSearch` by the new `거래ID`: pickup group/time, return date/time, header item list, and that excluded headers are absent.

## Pitfalls / recovery

- A failed `insertAndCheckRequest` can leave a partially inserted `확인요청` group before throwing (for example, data-validation failure mid-write). Search by customer/request note; if a partial request exists, delete it with `deleteRequest` before retrying.
- If writing to `확인요청` fails with a validation error like `셀 F... 데이터 확인 규칙 위반`, run `refreshEquipmentList` through the API before retrying. This rebuilds `목록` from `세트마스터` and sets 확인요청 F validation to allow invalid values.
- Registration can still block on generic category rows created by set expansion (`❌ 모델 미선택: 소프트박스, 7인치 모니터, 매트박스`). Fix by updating those F cells to concrete `장비마스터`/`목록` display names that match the source reservation or the shop's known default, then clear the affected I/J cells and the first-row O/N status before rerunning `action=확인` and retrying `action=등록`. Examples observed:
  - `소프트박스` → `라이트돔 II`
  - `7인치 모니터` → `스몰HD 인디7` (older references may call it `스몰HD INDIE7`; use the live list spelling)
  - `매트박스` → `미라지 매트박스(틸타 MB-T16)` (older references may call it `틸타 MB-T16(미라지)`; use the live list spelling)
- Do not treat 미등록 component warnings as blockers when they are copied components of a source set and the top-level set/header registration is the requested operational action. Still report material warnings if they affect staff handling.
- Verification fallback: `dashboardSearch` may return duplicated checkout/checkin result objects, may omit the target if `limit` is too low, and may show `checkout/checkin: null` in search cards. For final proof, also search `스케줄상세` column B by the new `거래ID` and verify all rows have the intended 반출/반납 date/time and header quantities.

## Final report checklist

- New `요청ID` and `거래ID`.
- New pickup/return time verified from dashboard.
- Excluded item names explicitly confirmed absent.
- Top-level registered items and quantities.
- State that no customer-facing 알림톡/send was done unless explicitly performed.
