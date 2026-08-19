# Register queue drain readback

When `action=등록&reqID=RQ-...` returns quickly with O열 `등록대기` and empty 거래ID, registration is only queued — not finished.

## Done criteria

- 확인요청 header O열 = `등록완료`
- P열 = `거래ID` (`YYMMDD-NNN`)
- 스케줄상세 has rows for that 거래ID
- 계약마스터 has that 거래ID with status `예약` (or expected status)

## Drain

1. Re-read the RQ header first (may already complete via background trigger).
2. If still `등록대기`:
   - `action=run&func=recoverPendingRegistrations`
   - optionally `action=run&func=recoverPartiallyRegisteredRequests`
3. Re-read RQ + 스케줄상세 + 계약마스터.
4. Never report success from the first `등록대기` card alone.

## Related pitfalls

- Model pick: before drain, write F열 for generic `7인치 모니터` → exact list name (e.g. `스몰HD 인디7`) with `action=write` A1 range.
- Quote unit-price overrides may not copy into 스케줄 L열; setmaster 단가 often wins and 스케줄상세 may block API writes.
- Full path with quote corrections: [screenshot-quote-correction-and-register.md](screenshot-quote-correction-and-register.md).
