# BURANO direct schedule registration pitfalls

Use when a staff request says to directly register a `부라노/BURANO 베이직세트` or `풀세트` schedule.

Observed durable workflow:

1. Match Korean `부라노 베이직 세트` to `세트마스터` exact spelling: `소니 BURANO 베이직세트`.
2. If the named customer exists in `고객DB` but the phone cell is blank, search prior `계약마스터` rows for the same customer name and reuse a verified recent phone/discount only when it is clearly the same customer. For `아나키`, prior contracts showed `010-7126-1139` and `개인사업자/프리랜서`.
3. Insert via `insertAndCheckRequest`, then inspect expanded rows before registration.
4. BURANO expanded component rows may show `❓ 미등록 장비` for kit components such as body, memory cards/readers, SWIT V-mount parts, or bundled cable/accessory text. These do **not necessarily block registration** because they are registered as zero-price components under the set header.
5. `⚠️ 모델 선택 필요` rows **do block registration**. For the BURANO 베이직세트 expansion, use concrete models that are already accepted in `장비마스터`:
   - `7인치 모니터` → `스몰HD INDIE7`
   - `매트박스` → `틸타 MB-T16(미라지)`
6. After editing those F cells, clear the same rows' I/J result cells, rerun `action=확인&reqID=...`, then register with `action=등록&reqID=...`.
7. Verify both:
   - `확인요청` rows have `등록완료` and a `거래ID` in P열.
   - `dashboardSearch` or `스케줄상세` by `거래ID` shows the header row `소니 BURANO 베이직세트` with correct pickup/return times.

Example safe API sequence:

```bash
# Insert request
GET ?key=village2026&action=run&func=insertAndCheckRequest&args={..."장비":[{"이름":"소니 BURANO 베이직세트","수량":1}]...}

# If needed, force concrete blocking generic rows
GET ?key=village2026&action=update&sheet=확인요청&cell=F{monitorRow}&value=스몰HD%20INDIE7
GET ?key=village2026&action=update&sheet=확인요청&cell=I{monitorRow}&value=
GET ?key=village2026&action=update&sheet=확인요청&cell=J{monitorRow}&value=
GET ?key=village2026&action=update&sheet=확인요청&cell=F{matteboxRow}&value=틸타%20MB-T16(미라지)
GET ?key=village2026&action=update&sheet=확인요청&cell=I{matteboxRow}&value=
GET ?key=village2026&action=update&sheet=확인요청&cell=J{matteboxRow}&value=

# Recheck, register, verify
GET ?key=village2026&action=확인&reqID=RQ-...
GET ?key=village2026&action=등록&reqID=RQ-...
GET ?key=village2026&action=dashboardSearch&q={거래ID}&summary=1&profile=1
GET ?key=village2026&action=search&sheet=스케줄상세&col=B&query={거래ID}
```
