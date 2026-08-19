# Screenshot quote correction → send → register

Session-hardened path for Kakao screenshot quotes that get staff corrections, then send, then schedule registration (김민솔-style threads).

## Owner rules (hard)

1. **Preview before send.** After any correction, show verified lines/total first.
2. Customer send only when the *current* turn has `보내`/`발송`/`보내라`/`전송` for that corrected payload.
3. Never auto-dedupe customer-listed extras against 풀세트 contents.
4. Honor staff naming/price overrides on the quote even when catalog defaults differ.

## Quote build

1. Parse screenshot: name, phone, discount, period, every listed top-level line.
2. Match against live `세트마스터` via one catalog read (`village-live-query.js catalog --sheet 세트마스터`).
3. Keep listed extras that also appear inside a set (classic fail: drop `V마운트 배터리 4개` because 코모도 풀세트 already has batteries).
4. Common overrides from this class of thread:
   - `무선 송수신기(1:2)` → default often `테라덱 볼트 1000XT (1:2)`; if staff says 마스 프로 → `마스 400S 프로(1:2)` with staff 회차 단가 (e.g. 10,000 not setmaster 30,000).
   - staff `바식스 IR ND 사각 0.6/1.2` → quote label `VAXIS IRND 사각(...)`; do not switch back to NiSi.
   - `INDIE7` → memo + later F열 model pick on 확인요청.
5. Preview: `sendEstimateManual` with blank phone → expect invalid-contact ERROR + fileId; CSV verify.
6. Send only after current-turn approval: real phone + `force:true` when resending same customer/day; CSV verify again.

## Register the corrected quote

1. Create fresh RQ from the **final corrected top-level list** (`village-confirm-request.js create`), not a stale RQ.
2. Resolve names against `목록` for registration:
   - `VAXIS IRND 사각` may resolve empty → use `VAXIS IRND 원형(0.6)/(1.2)` and note label gap in 비고/report.
3. If set expansion left `7인치 모니터` + model-select warning and staff/customer wanted INDIE7:
   - search 확인요청 for that row under the new reqID
   - `POST action=write` F cell to `스몰HD 인디7` (generic `update` needing `cell` may fail)
4. `action=등록&reqID=...`
   - Response may stop at O=`등록대기` with empty 거래ID → **not done**
   - Drain: `action=run&func=recoverPendingRegistrations` (+ `recoverPartiallyRegisteredRequests` if needed)
   - Done only when O=`등록완료` and P has 거래ID
5. Readback:
   - 스케줄상세 top-level rows include every corrected quote line (incl. separate batteries)
   - 계약마스터 has 거래ID / customer / dates / 예약
   - Quote unit-price overrides may **not** copy into 스케줄 L열 (setmaster 단가 wins; `스케줄상세` API write may be blocked: `쓰기 허용되지 않은 시트`). Report quote-vs-schedule price gap.
6. Surface availability warnings that still registered (short DZOFILM/CF overlaps, etc.).
7. Report: RQ, 거래ID, sent quote total vs schedule 단가 gaps, warnings.

## Anti-patterns

- Send corrected quote without showing the new CSV/total.
- Drop listed V-mount (or other extras) because “set already includes them”.
- Treat `등록대기` as success.
- Claim staff 1만원 마스 override registered when L열 still shows 30,000.
- Revert staff VAXIS/NiSi or Teradek/Mars choices on the next rewrite.
