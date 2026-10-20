# 수납 배분 및 잔액 관리 — 2026-10-20

## 구현

- Postgres의 원본 수납, 제공자별 고유키/별칭, 예약별 배분, 기초 수납, 변경 이력을 분리했다.
- 청구액 정본은 빌리지2.0 거래내역 I열. 수납액은 기초 수납 + 취소되지 않은 원본의 배분 합계다.
- 부분입금·여러 원본 입금·한 입금의 여러 예약 배분을 지원한다. 현장 추가/제외 시 잔액과 초과 수납을 재계산한다.
- Toss 단말은 남은 잔액만 청구한다. 금액 직접 결제도 미매칭으로 보존한다. 중단된 승인/취소 재시도와 같은 예약의 여러 승인키 보존을 지원한다.
- Toss 웹훅의 금액/날짜만으로 예약을 자동 완료하지 않는다. 단말이 선택한 거래ID 또는 직원 연결이 필요하다.
- 새 은행 입금은 고유 입금ID로 저장하고, 유일한 입금자 후보와 잔액 범위가 확인될 때만 자동 배분한다. 직원 연결 해제는 재수집으로 뒤집지 않는다.
- 직원 `/payments` 화면에서 미매칭·일부 연결·전체 내역과 예약별 잔액·초과 수납을 조회한다. 연결 변경은 사유, revision, 멱등 요청키로 보호한다.
- 기존 완납은 기초 수납으로 보존한다. 이전 부분입금/환불 및 기초 수납에 포함될 수 있는 과거 승인 취소는 확인필요 처리한다.
- 원장 활성화 시 기존 결제수단/증빙 수정이 M열을 직접 완료·미입금으로 덮지 않는다.

## 검증

- 실제 독립 PostgreSQL 18개 시나리오: 부분/합산/분할 배분, 가격 변동, 초과 수납, 취소, 동시 배분, 중복 요청, 제공자 별칭, 서비스 권한, 과거 취소 검토 전환.
- Today 앱 417개 테스트 통과, TypeScript 검사 및 Next production build 통과.
- main 저장소 root 최종 테스트는 `/tmp/payment-ledger-root-final.log` 참조.
- Finance 전체 453개 테스트 통과. Legacy GAS 전체 66개 테스트 통과.
- 운영 Supabase에 migration `payment_receipt_allocation_ledger` 적용. 5개 테이블 RLS와 anon/authenticated 직접 읽기 차단, 서버 전용 RPC 권한 재조회 완료. REST RPC도 확인했다.
- 서명 확인된 과거 미매칭 Toss 원본 7건 2,177,900원을 dry-run 후 저장했다. 운영 재조회: 배분 0원, 미배분 2,177,900원. 기존 장부 완료 상태는 변경하지 않았다.
- 업로드 ZIP의 4개 파일 원본 일치 검증, TEST_MODE=false 확인. SHA256 `e89380662cfa3b8c41a548f3cf721f6aa2c0e849ec9f66d12cb25cc623c80ff1`.

## 운영 반영 및 확인 — 2026-10-20

- main 통합 `a00921f`, 운영 데이터 예외 보완 `5916ffb`까지 push 완료.
- main GAS **804**를 기존 웹앱 URL에 배포. 활성 별도 배포 522 유지. 승인받은 580·581만 삭제했으며 각 18개 파일과 해시를 보관했다. 581 삭제 직후 Google 버전 한도 반영이 지연되어 첫 배포가 실패했지만, 199개를 확인하고 재시도하여 804 배포를 확인했다.
- Today 운영 alias `https://today-dashboard-ten.vercel.app`에 수납 화면/API 배포, 원장 flag=true. GAS와 Legacy도 원장 flag=true 및 인증 설정 readback 완료.
- Legacy GAS: main `687d0b3`, 기존 웹앱 버전 **135**, Git push 완료. 기존 15분 `matchDeposits` 트리거를 재사용하며 새 트리거를 추가하지 않았다.
- Finance: main `b255cce`, Vercel `village-finance-3sq2o8u62-village2.vercel.app` READY, 운영 alias `village-finance.vercel.app` 반영. 원장 flag=true. 이 저장소에는 Git remote가 없다.
- Supabase 청구계정 **1,802개** 초기화. 금액이 있는 기존 완납 기초 수납 1,019건 보존. 금액 미확인 13건, 수납 확인필요 3건은 자동 결제/배분을 제한한다(중복 포함, 범주 중첩).
- 과거 거래ID `260406-010`의 39,600원/8,000원 두 행은 임의 합산하거나 삭제하지 않았다. 해당 거래만 금액 미확인으로 분리한다. 불완전한 과거 날짜는 null로 전달한다. 1,802개 실제 데이터로 운영 DB 함수 dry-run/rollback 검증 후 초기화했다.
- 토스 플러그인 `village-front-pay`에 ZIP 업로드, **개발 버전 18 배포됨**을 포털에서 재조회. 기존 등록 단말 `25CF2020SL46253` 대상이다. 라이브 심사/배포 탭 변경은 수행하지 않았다.
- 운영 `/payments`에서 미매칭 Toss 7건, 예약별 잔액, 예약 검색 및 부분 배분 계산을 확인. 171,600원 원본 중 100,000원 입력 시 미배분 71,600원, 217,800원 예약 잔액 117,800원 계산 확인 후 입력 취소. 검증 목적의 실제 고객 배분/결제/환불은 만들지 않았다.
- 운영 조회 API에서 완납 카드/계좌 건 `261007-004`, `261009-003`은 전화번호/거래번호 모두 숨김, 미납 `261019-016`은 217,800원 표시. Cache-Control no-store 확인.
- 서명 검증된 기존 webhook 1034(171,600원)를 백업 후 CAS로 1회 재처리했다. 기존 알림 발송 표식을 유지하여 알림을 다시 보내지 않았다. 실제 운영 worker 결과 `unmatched`, `duplicate=true`, 동일 receiptId 확인. 원본 7건과 배분 0원 유지.
- 은행 첫 정기 실행(09:48:41)에서 기존 `InOut=1` 필터가 무효여서 출금 행이 섞이는 문제가 드러났다. 공식 `TradeType=I`로 수정하고 0원 입금 행을 제외하도록 보완해 Legacy 135를 배포했다. 실제 dry-run에서 124건, 합계 26,590,859원, 출금 혼입 0건 확인 후 수집 실행했다. 최종 저장 건수는 아래에 기록한다.
- 팝빌 필터 근거: https://developers.popbill.com/api-reference/easyfinbank/api/search . owner 인증 전용 `syncPaymentLedgerBank`는 필수 dryRun boolean으로 읽기 검증/동일 수집 경로 재실행을 지원한다.
- 직원 화면에서 최신 거래 우선 정렬 및 고객명/거래번호에 따른 잔액 목록 검색을 추가로 보완했다.

## 검증 범위

실제 신규 고객의 단말 결제·취소를 대신 실행하지 않았다. 자동 테스트, 운영 원본 재처리, 기존 고객 조회, 실제 직원 화면, 공급자 배포 상태를 검증했다. 원본 근거가 없는 미매칭을 임의 완료하지 않는다.

## 증거 및 실행 자료

- 작업 tree: `/Users/choijaehyeong/.codex/worktrees/payment-allocation/my-gas-project2`
- 580 backup: `/Users/choijaehyeong/gas-project-backups/payment-ledger-version580-20261020`
- Legacy backup: `/Users/choijaehyeong/gas-project-backups/payment-ledger-legacy-before-20261020.tar`
- 과거 수납 import 증거: `/Users/choijaehyeong/gas-project-backups/payment-ledger-history-import-20261020.json` (0600)
- 운영 helper: `/tmp/payment-ledger-ops.py` (키는 기존 설정에서 메모리 내 파생; 출력하지 않음)
- 과거 미매칭 import: `/tmp/payment-ledger-import-history.py` (`dry-run`/`apply`, 재실행 멱등)
- 업로드 ZIP: 작업 tree의 `toss-front-plugin/village-front.zip` (git 제외, 토큰 포함)

- 581 backup: `/Users/choijaehyeong/gas-project-backups/payment-ledger-version581-20261020`
- Toss 배포 증거: `/Users/choijaehyeong/gas-project-backups/payment-ledger-toss18-deployed.png`
- 추가 회귀 검증: `/tmp/payment-ledger-fix-tests.log` (29 passed)

## 최종 은행 및 운영 재조회

- Legacy 135 실제 수집 응답: success=true, mode=payment_ledger, receipts=124.
- 운영 DB 재조회: 은행 원본 124건 26,590,859원, 토스 원본 7건 2,177,900원. 총 원본 131건, 임의 배분 0원, 장부 반영 오류 0건.
- 수집된 은행 원본은 전환 이전 내역이다. 기존 완납 기초 수납을 다시 더하지 않았다. 미배분 은행 원본이 전부 미입금이라는 뜻은 아니므로 직원 화면에서 기존 수납 기준 확인 안내를 제공한다.
- 완납 대조 2건은 잔액 0/입금완료를 유지한다. 직원 미인증 /api/payments 및 /api/internal/payments 호출은 각각 401 확인.
- Main 1분 flushDirtyToSupabase 트리거 실행 완료 확인. Legacy 기존 15분 matchDeposits 트리거 설정을 유지하며 동일 수집 함수를 운영 API로 실제 실행해 124건 저장 완료를 확인했다.
- 오늘 신규 은행 입금 및 새 고객 단말 승인/취소를 만들어 내는 검증은 하지 않았다. 부분·합산·현장 금액 변경·취소 계산은 자동 회귀 및 독립 PostgreSQL 18개 시나리오로 검증했다.
- 주요 운영 URL: https://today-dashboard-ten.vercel.app/payments
