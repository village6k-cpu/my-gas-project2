# Kakao 확인요청: 필터/젬볼/600X 소프트박스 pitfalls

Use when a Kakao reservation screenshot includes lighting sets, H&Y REVORING/VND-CPL filters, Black Pro-Mist filters, and a later add-on such as `웨건 2개` or `젬볼`.

## Durable lessons

- If the customer first requested a partial reservation and then added more items for the same customer + same rental window, inserting the corrected full `insertAndCheckRequest` payload can replace the stale mutable pending RQ. Verify readback: the old `RQ-...` should disappear and the new RQ should contain the full top-level list.
- `H&Y REVORING (3-1000 ND + CPL 필터)` / `H&Y REVORING ND+CPL` should usually map to the stocked set/master item `H&Y VND-CPL 67-82mm 가변 ND`, not `Kipper tie REVOLVA RF-EF` just because `REVO` search hits it.
- `티펜 Black Pro-Mist 필터 1/4, 1/2 (4x5.65)` maps to the 사각 rows:
  - `Black Pro-Mist 1/4 사각`
  - `Black Pro-Mist 1/2 사각`
- Bare `젬볼` is ambiguous operationally: `세트마스터` may contain `젬볼`, while `장비마스터` concrete stock is `젬볼 120` and `젬볼 90`. If inserted as bare `젬볼`, availability may come back `미등록 장비`; report the warning and ask/model-select rather than pretending it is cleanly available. If the conversation clearly means the softbox option for Aputure 600X, prefer selecting/reporting a concrete candidate such as `젬볼 120`/`젬볼 90` after availability context.
- Aputure 600X set expansion can create a `소프트박스` component with `모델 선택 필요`; this is expected and should be surfaced with candidate concrete softboxes. Do not hide this warning under the parent set's apparent availability.

## Verification checklist

1. Search `세트마스터` first for exact final write names; use `목록`/`장비마스터` only to disambiguate.
2. After insertion, read `확인요청` by the new RQ and by customer name/phone.
3. If replacing a stale mutable RQ, also search the old RQ ID and confirm `count: 0`.
4. Final report should separate:
   - top-level items entered,
   - availability OK rows,
   - model-selection / 미등록 warnings such as 600X `소프트박스` and bare `젬볼`.
