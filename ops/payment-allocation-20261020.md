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
- Finance 전체 453개 테스트 통과. Legacy GAS 전체 64개 테스트 통과.
- 운영 Supabase에 migration `payment_receipt_allocation_ledger` 적용. 5개 테이블 RLS와 anon/authenticated 직접 읽기 차단, 서버 전용 RPC 권한 재조회 완료. REST RPC도 확인했다.
- 서명 확인된 과거 미매칭 Toss 원본 7건 2,177,900원을 dry-run 후 저장했다. 운영 재조회: 배분 0원, 미배분 2,177,900원. 기존 장부 완료 상태는 변경하지 않았다.
- 업로드 ZIP의 4개 파일 원본 일치 검증, TEST_MODE=false 확인. SHA256 `e89380662cfa3b8c41a548f3cf721f6aa2c0e849ec9f66d12cb25cc623c80ff1`.

## 현재 운영 반영 상태 — 미완료

- main 저장소: `codex/payment-allocation`에 구현/테스트 push 완료. main 통합 및 새 GAS 배포는 미완료.
- 운영 main GAS는 여전히 802. 활성 별도 배포 522도 유지한다.
- Legacy GAS: main `99eb536`, 기존 웹앱 URL에 버전 134 배포 및 Git push 완료. 내부키 저장 확인, 원장 flag=false로 기존 수집 유지 중.
- Finance: main `b255cce`로 fast-forward, 로컬 테스트 완료. 운영 Vercel 재배포/flag 활성화 미완료. 이 저장소는 Git remote가 없다.
- Today production 환경변수 PAYMENT_LEDGER_ENABLED=true 및 PAYMENT_LEDGER_CUTOVER_AT는 준비했으나 아직 새 배포가 사용하지 않는다. **GAS 새 버전 배포 전에 Today만 새로 배포하지 않는다.**
- Supabase 수납 테이블/함수와 과거 원본 7건은 배포됨. 청구계정 전체 초기화/운영 자동 수집 활성화는 아직 하지 않았다.
- Toss 업로드 ZIP은 준비됨. 실제 개발자센터 업로드는 로그인 대기이며 아직 수행하지 않았다.

## 사용자 입력 대기

1. GAS 200개 버전 한도: 미사용 **580 한 개 삭제** 승인을 요청했다. 18개 원본과 SHA256 목록 백업 완료. 이전 579 승인으로 580을 삭제하지 않는다. 현재 브라우저 삭제 대화상자에 580만 선택되어 있다.
2. Toss 개발자센터 세션 만료: Chrome 로그인 탭을 열고 로그인 요청했다. 비밀번호를 받지 않는다.

## 남은 실행 순서

1. 580 승인 후 정확히 그 버전만 삭제하고, `clasp deployments`로 522/802 보존을 확인한다.
2. main에서 `scripts/integrate.sh codex/payment-allocation "feat: receipt allocations balances and payment reconciliation"` 실행. GAS 배포 성공 및 Today 운영 배포를 각각 확인한다. endwork는 GAS 배포 실패에도 다음 단계를 진행하므로 반드시 실제 버전을 확인한다.
3. 내부 paymentLedgerSnapshot으로 현재 청구액/완납 기초 수납 전체 초기화. `/tmp/payment-ledger-ops.py snapshot`, `sync`를 사용할 수 있다. 개인 증거 파일에는 고객 정보가 있어 공개 저장소에 넣지 않는다.
4. main GAS 원장 flag=true. Legacy 원장 flag=true. Finance PAYMENT_LEDGER_ENABLED=true 설정 후 올바른 village-finance 프로젝트에 배포. 각 source→receipt→allocation→M열→mirror/화면을 재조회한다.
5. 과거 은행 원본은 기존 기초 수납에 포함된 건을 중복 배분하지 않도록 확인한다. 애매한 것은 수납 관리에 남긴다.
6. 새 Today 직원 화면 및 실제 조회 API에서 기존 완납 숨김, 미납 잔액, 부분 수납, 합산 배분, 추가/제외 차액, 실패 재시도를 검증한다. 실제 고객 결제/환불을 테스트 목적으로 만들지 않는다.
7. Toss 로그인 후 해당 기존 플러그인에 검증한 ZIP 업로드 및 등록된 매장 단말 배포 상태 확인. 서버 배포나 ZIP 생성만으로 업로드 완료라고 보고하지 않는다.
8. 최종 운영 상태/버전/검증 증거를 이 문서에 갱신한다.

## 증거 및 실행 자료

- 작업 tree: `/Users/choijaehyeong/.codex/worktrees/payment-allocation/my-gas-project2`
- 580 backup: `/Users/choijaehyeong/gas-project-backups/payment-ledger-version580-20261020`
- Legacy backup: `/Users/choijaehyeong/gas-project-backups/payment-ledger-legacy-before-20261020.tar`
- 과거 수납 import 증거: `/Users/choijaehyeong/gas-project-backups/payment-ledger-history-import-20261020.json` (0600)
- 운영 helper: `/tmp/payment-ledger-ops.py` (키는 기존 설정에서 메모리 내 파생; 출력하지 않음)
- 과거 미매칭 import: `/tmp/payment-ledger-import-history.py` (`dry-run`/`apply`, 재실행 멱등)
- 업로드 ZIP: 작업 tree의 `toss-front-plugin/village-front.zip` (git 제외, 토큰 포함)
