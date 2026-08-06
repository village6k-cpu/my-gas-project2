# 헤이빌리 상태 권위표 (2026-07-30 전수 감사 기준)

각 필드의 **정본(권위) 저장소**, **복구 방향**, 코드 준수 여부.
복구는 항상 권위 → 미러 방향으로만 흐른다. 미러(스냅샷·realtime 에코)가 권위를 덮어쓰면 회귀다.

| 필드 | 권위 저장소 | 복구 방향 | 비고 |
|---|---|---|---|
| 계약상태 (예약/반출/반납완료/취소) | 계약마스터 J열 | 시트 → Supabase(trades.contract_status) → 앱 | GAS 삼중 쓰기(J열+props+Supabase), 실패 시 롤백 |
| 반출완료 (setupDone/At) | GAS props `setupDone_<tid>` + Supabase trades | GAS 확정응답 → 앱. 앱은 목표만 전송(멱등 mutationId) | 낙관 표시, outcome-unknown은 Supabase 재확인 |
| 반납완료 (returnDone/At) | GAS props + 계약마스터 J + Supabase | GAS 확정응답 → 앱. 재오픈은 expectedReturnDoneAt CAS | force는 작업자 확인 후에만, autoForce는 서버 재검증(2026-07-30) |
| taken_qty (반출 기준선) | Supabase schedule_items.taken_qty — 반출완료 순간 1회 고정, 불변 | 시트→Supabase 1회(빈 기준선+증거 완비시만). 완료된 거래는 재생성 금지(2026-07-30) | 부분 기준선은 fail-closed 유지 |
| 반납 정상·파손·분실 수량 (return_counts) | Supabase trades.return_counts — 앱이 유일 writer (jsonb CAS) | 앱 outbox → Supabase. 완료 충돌 시 정본 재조회로 수렴 | |
| 장비 제외 (품목 존재) | 스케줄상세 행 존재 여부 | 시트 삭제 → Supabase removed_at(워커) → 앱 필터. ID 재사용 시 removed_at 해제(2026-07-30) | 앱은 제외 ACK 후 10분 tombstone으로 좀비 차단(2026-07-30) |
| 장비명·수량 | 스케줄상세 D/E열 (GAS updateEquipQty/Name — canonical 응답) | GAS 응답 → 앱 → Supabase | 사라진 품목의 outbox는 terminal ACK(2026-07-30) |
| 품목 특이사항 (memo_*) | Supabase schedule_items.memo_* — 앱 전용 열 | 앱 → Supabase 단방향, localStorage outbox 내구 | |
| 거래 특이사항 (note_checkin) | Supabase trades.note_* — 앱 소유 | 앱 → Supabase. 시트 returnMemo는 빈 노트 시드만(2026-07-30) | GAS flush가 앱 값을 덮지 않도록 현재값 선조회 |
| 사진 목록 | 빌리지2.0 '반출반납 사진' 시트 (행) + Drive (파일) | 시트 → 앱(replace 정본). 삭제=setTrashed(휴지통) | 읽기 응답에 sheetValue 포함(2026-07-30), 업로드큐는 앱 소유 |
| 결제·증빙·입금상태 | 빌리지2.0 거래내역 J/K/L/M/G열 | 거래내역 → 앱/Supabase | 조회 실패 시 필드 미전송으로 기존값 보존 |
| 할인유형 (등록 전) | 확인요청 M열 = 카카오 확정 > 고객DB I > (공란) | 등록 시 M→K(계약마스터)·M→I(고객DB). 공란이면 등록 시점 고객DB 재조회(2026-07-30) | '일반' 물질화 중단, 강한 할인 강등 금지(2026-07-30) |
| 할인유형 (등록 후) | 계약마스터 K열 | K → 계약서/대시보드/Supabase. 합침·재시도 등록도 K·고객DB 갱신(2026-07-30) | 수동 변경은 updateTradeDiscount |
| 계약서 URL·최종금액 | 생성된 계약서 파일(Drive) → 거래내역 C/I열 writeback | 재생성 워커는 링크 readback 실패를 실패로 처리해 재시도(2026-07-30), I열 금액도 readback | |
| 확인요청 등록상태 (O/P열) | GAS 등록 워커만 쓰기. 등록완료 = 거래내역 행 readback 통과 후에만 | 복구 스윕이 스케줄상세/거래내역에서 재유도. '개고생2.0 입력 중' 스틱도 복구 가능(2026-07-30) | 등록대기 카드는 앱에서 편집 UI 미노출(2026-07-30) |
| 외부 거래내역 A/B/E/F | 계약마스터가 필드 소스 | 계약마스터 → 거래내역 (ensureRegisteredTradeLedgerRow_, readback). 날짜변경도 동일 경로(2026-07-30) | 실패는 pending 속성 + rescue 재시도 |
| 스케줄 행 식별 (타임라인 드래그) | 스케줄상세 A/B열 — 행 번호는 캡처 시점 스냅샷일 뿐 | 쓰기 전 거래ID 재검증, 불일치 시 STALE_ROWS 거부(2026-07-30) | |

## 남은 위반(수용된 잔여 리스크)
- **확인요청 목록 캐시**: GAS 60초 캐시 + Vercel 12초 캐시의 이중 무효화가 일부 쓰기 경로에서 불완전 — 표시 지연(수십 초)만 유발, 정합성 무해.
- **거래 특이사항 내구성**: note_* 는 450ms 디바운스 후 저장되며 전송 전 새로고침 시 유실 가능(품목 메모와 달리 localStorage outbox 없음).
- **다른 기기의 삭제된 사진 잔상**: 사진 모달 재오픈 시 수렴 (realtime 신호 없음 — photo_rev 컬럼 추가 필요).
