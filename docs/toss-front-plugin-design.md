# 토스 프론트 플러그인 설계문서

**작성일**: 2026-06-15  
**상태**: 서버 API 완료 / 단말기 플러그인 **코드 완성 + 개발 배포 완료** (`toss-front-plugin/`) — 실제 프론트 단말기 재온보딩 필요
**갱신**: 2026-06-15 (공식 Template API 확인 → 플러그인 구현 + confirm GAS 계약 수정 + lookup CORS 보강)

---

## 전체 흐름도

```
[손님]
  ↓ 매장 토스 단말기에 전화번호 또는 예약번호 입력
[토스 단말기 — 토스 프론트 플러그인 SDK]  ← 코드/개발배포 완료, 실제 단말기 dev 트랙 노출 미해결
  ↓ GET /api/lookup?phone=... (x-lookup-token 헤더)
[우리 서버: /api/lookup]                  ✅ 완료
  ↓ Supabase village.trades + schedule_items 조회
  ↓ 미결제 예약 목록 + 금액 반환
[토스 단말기 — Template UI]               ← 단말기 재온보딩 후 확인 필요
  ↓ 손님이 예약 선택 → 결제 진행
[토스 결제 처리]                           ← 단말기 노출 후 실결제 테스트 필요
  ↓ POST /api/lookup/confirm {tradeId, paidAmount, method}
[우리 서버: /api/lookup/confirm]           ✅ 뼈대 완료 (실 연동은 승인 후)
  ↓ GAS updatePayment 호출
[Google Sheets (원본)]
  ↓ 90초 이내 Supabase 동기
[Supabase village.trades — deposit_status = '입금완료']
```

---

## 우리가 완료한 것

### `/api/lookup` (GET)
- 파일: `app/api/lookup/route.ts`
- 기능: 전화번호(끝 8자리 정규화 매칭) 또는 거래ID로 미결제 예약 조회
- 필터: `deposit_status != '입금완료'` AND `contract_status != '취소'`
- 응답: `{ matches: [{ tradeId, customerName, itemSummary, amount, checkoutAt, depositStatus }] }`
- 보안: `x-lookup-token` 헤더 == `LOOKUP_TOKEN` 환경변수

### `/api/lookup/confirm` (POST)
- 파일: `app/api/lookup/confirm/route.ts`
- 기능: 결제 완료 후 해당 예약을 '입금완료'로 처리
- 동작: GAS `updatePayment` 액션 호출 → 시트 업데이트 → Supabase 90초 동기
- 상태: 뼈대. 토스 실제 콜백 포맷 미정이므로 내부 포맷으로만 동작

### 전화번호 정규화 (`normalizePhoneLast8`)
- 위치: `apps/today-dashboard/lib/server/phoneNormalize.ts`
- 규칙: 숫자만 추출 후 끝 8자리
- 커버 케이스: `010-6403-9315` / `1063233116` / `+82 10-6403-9315` → 모두 같은 끝 8자리

---

## 단말기 플러그인 — 구현 완료 (2026-06-15)

코드: `toss-front-plugin/village-front/` (index.html · app.js · config.js). 공식 Template API 기준 흐름:
- 대기 `renderIdlePage` → `renderInputPage(type:'phone')` 전화번호 입력 → `/api/lookup` 조회
- 여러 건 → `renderSelectPage` 선택 → `renderOrderPage` 금액 확인
- `sdk.payment.requestPayment({paymentKey,tax,supplyValue})` 카드 승인 → `/api/lookup/confirm` → 시트 입금완료
- `renderResultPage` 결과. 결제 중 이탈은 부팅 시 `sdk.payment.getPaymentByKey`로 복구.

confirm GAS 계약 수정: 기존 뼈대가 `{tradeId, depositStatus}`로 보내 GAS가 무시(입금완료 미반영) →
실제 계약 `{action:'updatePayment', tid, method:'카드결제'}`로 교체(부수효과로 입금완료 자동 처리).

### 운영 전환 시 남은 것

| 항목 | 내용 |
|------|------|
| 단말기 재온보딩 | 개발 배포는 테스트 가맹점 온보딩 + 테스트 단말기 등록 + 재온보딩 후 적용 |
| 토스 공식 인증 | 현재 x-lookup-token은 임시. 토스가 정하는 서명·HMAC·IP 화이트리스트로 교체 |
| 멱등성 처리 | paymentKey 기반 중복결제 방지(현재 입금완료 재설정은 무해) |
| 금액 검증 | 실제 결제금액 vs 예약금액 (초과 결제 차단) |

### 단말기 노출 문제 조사 결과 (2026-06-15)

- 공식 문서상 개발 배포는 테스트 단말기 대상으로만 반영된다.
- 테스트 단말기 등록 후에는 프론트 온보딩을 다시 수행해야 개발 트랙 코드가 적용된다.
- ACL 변경 후에도 프론트 단말기 로그아웃 후 재온보딩이 필요하다.
- Mac `Toss POS.app`은 이미 테스트 가맹점 `빌(BILL.)` 로그인 상태로 확인했다. 남은 핵심은 실제 손님용 프론트 단말기가 같은 테스트 가맹점으로 온보딩됐는지, 등록된 테스트 단말기 일련번호와 일치하는지다.
- `/api/lookup`과 `/api/lookup/confirm`은 플러그인 origin의 preflight가 통과하도록 `OPTIONS`와 CORS 헤더를 반환한다.

---

## 미해결 사항 (설계 보류)

### 1. 부분입금 잔액
- 현재 `village.trades.amount` = 총 받을 금액 (단일 컬럼)
- 잔액 컬럼(`remaining_amount`, `paid_amount` 등) 없음
- 부분결제 흐름이 필요하면 DB 스키마 변경 + GAS 시트 컬럼 추가 필요

### 2. 전화번호 정규화 한계
- 끝 8자리 매칭: `63239315`과 `13239315`이 충돌할 수 있음 (확률 낮음)
- 더 엄격히 하려면 010 제거 후 8자리(국내 고정), 또는 DB에 정규화 컬럼 추가
- 현재 전체 미결제 거래를 메모리에 로드 후 필터링 → 거래 수천 건 이상이면 DB FUNCTION 필요

### 3. village 스키마 PostgREST 노출
- `supabase/schema.sql` 주석에 명시: "Exposed schemas에 'village' 추가 필요"
- 현재 anon RLS(`proto_all`)가 활성화된 경우 anon 키로 조회 가능
- `lockdown.sql` 실행 후에는 **service role 키**(`SUPABASE_SERVICE_ROLE_KEY`)만 RLS 우회 가능
- `/api/lookup`은 service role 키 우선, anon 키 폴백으로 구현 (환경변수 상황 따라 자동 선택)

### 4. 토스 인증 방식 미정
- 현재 `x-lookup-token` = 공유 시크릿 (단순하나 교체 필요)
- 토스 승인 후 정해지는 인증 방식으로 `checkToken` 함수만 교체하면 됨

---

## 환경변수 추가 필요

```bash
# .env.local 에 추가
LOOKUP_TOKEN=<임의의 강력한 랜덤 문자열>          # 단말기와 공유
SUPABASE_SERVICE_ROLE_KEY=<service role secret key>  # RLS 우회용
```

- `LOOKUP_TOKEN`: 단말기 ↔ 서버 공유 시크릿. 토스 SDK 승인 후 토스 방식으로 교체 예정.
- `SUPABASE_SERVICE_ROLE_KEY`: lockdown.sql 적용 환경에서 RLS 우회 필수. 절대 클라이언트에 노출 금지.
