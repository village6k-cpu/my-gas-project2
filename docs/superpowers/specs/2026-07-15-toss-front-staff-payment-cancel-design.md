# Toss Front 직원 전용 결제 취소 설계

## 목표

VILLAGE Toss Front 플러그인으로 승인한 최근 결제를 직원이 프론트 단말에서 전액 취소하고, 예약 결제라면 거래 장부의 입금상태까지 `환불`로 일치시킨다.

## 범위

- 직원 전용 접근: `프론트 설정 → 7055 → 플러그인 설정`의 `settings.html`
- 이 플러그인과 동일 단말에서 승인한 결제만 표시
- 카드·현금영수증·바코드 결제 중 Toss 취소 필수정보를 확보할 수 있는 건만 전액 취소
- 취소 전 거래 상세와 최종 확인 화면 제공
- 중복 취소 차단
- 예약 결제 취소 성공 시 거래 장부 `입금상태=환불` 반영
- 금액 직접 결제는 장부 연결 없이 Toss 승인만 취소

이번 범위에서 부분 취소, 타 단말 결제, 플러그인 도입 전 결제, 고객용 첫 화면의 취소 메뉴는 지원하지 않는다.

## 접근 방식

`settings.html`은 직원만 들어가는 플러그인 설정 진입점으로 유지하되 화면은 Toss Template API로 렌더링한다. `settings.html`이 `window.VILLAGE_PAGE_MODE = "settings"`를 설정한 뒤 기존 `app.js`를 로드한다. `app.js`는 페이지 모드에 따라 고객용 결제 홈 또는 직원용 설정 홈을 시작한다.

이 방식은 취소 로직과 기존 `receiptRecords` 저장소를 한 파일에서 재사용하고, 업로드 ZIP의 기존 네 파일(`index.html`, `settings.html`, `app.js`, `config.js`) 구조를 유지한다.

## 직원 화면 흐름

1. 직원 설정 홈에서 `최근 결제 취소`를 선택한다.
2. 로컬 `receiptRecords`에서 취소되지 않은 최근 결제를 최대 20건 표시한다.
3. 결제를 선택하면 저장된 승인정보를 읽는다. 구버전 기록에 필수정보가 없으면 같은 단말의 `sdk.payment.getPayment({ paymentKey })`로 복구한다.
4. 금액, 결제시각, 승인번호, 예약자 또는 `현장 직접 결제`를 보여주고 `전액 취소`를 다시 확인한다.
5. 실행 직전 로컬 취소표시와 `sdk.payment.getPaymentCancel`을 확인해 중복 취소를 막는다.
6. `sdk.payment.requestPaymentCancel`이 `SUCCESS`일 때만 로컬 기록을 취소 완료로 저장한다.
7. 예약 결제는 서버에 장부 환불 반영을 요청한다. 직접결제는 로컬 취소 완료로 종료한다.

취소 버튼은 요청 중 다시 누를 수 없게 잠그고, `CANCELED`, `TIMEOUT`, SDK 오류는 승인취소 실패로 처리한다.

## 결제정보 저장

새 결제부터 다음 취소 필수정보를 `receiptRecords`에 함께 저장한다.

- `paymentKey`
- `paymentMethod`
- `amount`, `tax`, `supplyValue`, `tip`
- `timestamp`, `approvalNumber`, `installment`
- 필요한 경우 `extraData.vanTransactionManagementId`, `isSelfIssuance`

Toss 응답은 결제수단별로 `response.card`, `response.cash.cashReceipt`, `response.barcode`에 값이 들어가므로 공통 정규화 함수가 이를 평탄화한다. 기존 기록은 Toss의 동일 단말 캐시에서 복구할 수 있을 때만 취소 대상으로 인정한다.

## 장부 반영 API

`POST /api/lookup/cancel`을 추가한다.

- 인증: 기존 `x-lookup-token`
- 입력: `tradeId`, `paymentKey`, `amount`, 취소 승인정보
- 처리: GAS `updateTradeProof`에 `field=depositStatus`, `value=환불` 전달
- 응답: 장부 반영 성공 여부

카드 승인취소가 먼저다. 승인취소 성공 후 장부 호출이 실패하면 결제를 다시 취소하지 않고 로컬 기록에 `cancelSyncPending`을 남긴다. 직원 설정 재진입 시 장부 반영만 재시도한다.

## 오류와 안전장치

- Toss 승인취소 성공 전에는 장부를 변경하지 않는다.
- 로컬 `cancelledAt` 또는 Toss 취소 캐시가 있으면 재취소하지 않는다.
- 필수 승인정보를 복구하지 못하면 취소 버튼을 제공하지 않고 터미널/고객센터 취소를 안내한다.
- 장부 동기화 실패와 승인취소 실패를 다른 메시지로 표시한다.
- 고객용 첫 화면과 기존 결제·영수증 경로는 변경하지 않는다.
- 실제 카드 승인이나 취소는 자동 테스트에서 실행하지 않는다.

## 검증

1. 정적 회귀 테스트를 먼저 실패시키고 구현한다.
   - 직원 설정 모드와 고객 홈 분리
   - 결제수단별 승인정보 정규화·저장
   - 공식 `requestPaymentCancel` 필수 파라미터
   - 전액 취소 및 중복 차단
   - 예약만 장부 `환불` 반영
   - 장부 실패 시 `cancelSyncPending`
2. 취소 API의 토큰, CORS, GAS 액션 계약을 검사한다.
3. Toss SDK를 모사한 브라우저에서 목록 → 확인 → 성공/실패 화면을 검증하되 실제 금전 거래는 만들지 않는다.
4. 전체 Toss 정적 테스트, JS 문법 검사, Next.js 프로덕션 빌드를 실행한다.
5. ZIP 항목과 `app.js` 해시가 소스와 일치하는지 확인한다.
6. main 통합 후 운영 API의 OPTIONS·미인증 응답을 확인하고, 개발자센터 업로드는 로그인된 세션에서 별도로 수행한다.

## 완료 기준

- 직원 설정에서 최근 취소 가능 결제를 찾을 수 있다.
- 확인한 한 건만 공식 Toss API로 전액 취소된다.
- 같은 결제를 두 번 취소할 수 없다.
- 예약 결제는 `환불`, 직접결제는 로컬 취소 상태로 정확히 남는다.
- 기존 결제·영수증·자동복귀 회귀가 없다.
