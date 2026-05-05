# 빌리지(Village) 카메라 렌탈 운영 시스템 — raw

## 한 줄
카메라 렌탈샵 "빌리지"의 예약·재고·계약·고객 응대를 통합 관리하는 시스템. 사장(혼자 풀타임)·오전 직원(파트타임)·카카오톡 디스패치 LLM 에이전트가 사용. 구글 시트가 데이터 진실 원천, GAS 웹앱이 API, GitHub Pages가 모바일 프론트엔드 서빙.

## 현재 상태
- **마지막 작업**: 2026-05-02, 두 맥 워크플로우 자동화 스크립트 추가 (PR #1 머지, 커밋 `5e20635` 외)
- **현재 단계**: 동행 모드(AI 검증 게이트) 통합 직후 + 두 맥 동기화 사고 처방 직후. 핵심 운영 흐름은 안정 가동 중.
- **다음 액션**:
  1. 메모리/리더기 분실 추적 시스템 도입 (반출/반납 카운트 강제 + 박스 사진 의무화) — 사용자가 이번 세션에서 명시적으로 제기
  2. `sheetAPI.js:24` API_KEY 평문 하드코딩(`village2026`) → 스크립트 속성 이동 + 키 변경
  3. `checkAvailability.js` 4,432줄 단일 파일 도메인별 분리 (가용/등록/알림톡/대시보드/타임라인)
- **블로커**: 없음. 단 메모리/리더기 분실은 측정 메커니즘 부재로 효과 검증 어려움 → 가시화가 우선.
- **status**: active

## 작업 환경

| 머신 | OS | 로컬 경로 | 비고 |
|---|---|---|---|
| 사장 데스크탑 맥 | macOS (버전 미상) | ~/my-gas-project2 | 주 작업기 추정 — 미상 |
| 사장 노트북 맥 | macOS (버전 미상) | ~/my-gas-project2 | 미상 |

- **레포**: `github.com/village6k-cpu/my-gas-project2` (공개 여부 미상 — 보안상 확인 필요)
- **브랜치 전략**: 주 브랜치 `main`. 작업 브랜치 `claude/<task>-<id>` 패턴 (예: `claude/multi-machine-workflow-setup-FTbio`, `claude/add-confirmation-response-pfu90`). PR로 머지.
- **배포 위치 / URL**:
  - GAS 웹앱: `https://script.google.com/macros/s/AKfycbyRff4-lLXmne-iPIEf87x4-CH_5wb-Uv5dCGymELLrpiKluhg2gDdLdVP4Y0MmxnnT/exec`
  - GitHub Pages: `https://village6k-cpu.github.io/my-gas-project2/`
    - 타임라인 / dashboard / manage / index 페이지
- **iCloud / 클라우드 sync**: 코드 자체는 iCloud sync 안 함. 두 맥 동기화는 git + clasp(GAS) 양쪽으로. `scripts/startwork.sh` / `scripts/endwork.sh` / `scripts/synccheck.sh`로 강제.

## 기술 스택
- **언어**: JavaScript (GAS V8)
- **프레임워크/런타임**: Google Apps Script (V8 runtime, `appsscript.json: runtimeVersion V8`)
- **호스팅**: 
  - 백엔드 = GAS (`scriptId 1MbjcaQygxXn-0zHoYnpmuVKGyQCOLaUwEYNQurRzRJ9tw_6d7-33ZTVh`)
  - 프론트엔드 = GitHub Pages (docs/ 폴더 자동 서빙)
- **DB/저장소**: Google Sheets (시트 자체가 DB). 별도 RDB 없음.
- **외부 API/서비스**:
  - village-ai (https://village-ai.vercel.app, 등록 검증) — 별도 시스템
  - 팝빌 (auth.linkhub.co.kr, popbill.linkhub.co.kr) — 카카오 알림톡 발송
  - 개고생2.0 (사장 운영 별도 AppSheet/시트) — 거래내역·고객DB 양방향 연결
  - Google Drive (계약서 템플릿 복사 + 폴더 저장)
  - Slack (외부 봇이 GAS API에서 슬랙 메시지 텍스트 fetch)
- **CLI/도구**: 
  - clasp (`@google/clasp` npm 글로벌) — GAS 코드 push/pull/deploy
  - git
  - `scripts/startwork.sh` / `endwork.sh` / `synccheck.sh` (자체 워크플로우)
- **AI 모델 사용처**:
  - 카카오톡 파싱: 외부 LLM 디스패치 에이전트 (Claude API 추정 — `AGENT_GUIDE.md`에 STEP 1~6 정의, 모델 명시 미상)
  - 등록 검증: village-ai (Vercel 별도 시스템, 내부 모델 미상)
- **라이브러리 의존성**: `appsscript.json: dependencies: {}` — 외부 GAS 라이브러리 없음. 순수 GAS 빌트인 (UrlFetchApp, DriveApp, SpreadsheetApp, CacheService, ScriptApp)만 사용.

## 시크릿 위치 (값 X — 위치만)

| 키 이름 | 보관 위치 | 비고 |
|---|---|---|
| `API_KEY` (웹앱 인증) | **⚠️ `sheetAPI.js:24` 코드에 평문 하드코딩** + `AGENT_GUIDE.md` + `CLAUDE.md` 평문 노출 | 단순 단어 `village2026`. **즉시 처치 필요**: 스크립트 속성 이동 + 키 변경 + 코드/문서에서 제거 |
| `POPBILL_LINK_ID` | GAS 스크립트 속성 | 팝빌 알림톡 인증 |
| `POPBILL_SECRET_KEY` | GAS 스크립트 속성 | 팝빌 HMAC 서명용 |
| `POPBILL_CORP_NUM` | GAS 스크립트 속성 | 팝빌 발신 사업자 번호 |
| `POPBILL_SENDER_NUM` | GAS 스크립트 속성 | 팝빌 발신 전화번호 |
| `CONTRACT_TEMPLATE_ID` | GAS 스크립트 속성 | 계약서 템플릿 스프레드시트 ID |
| `CONTRACT_FOLDER_ID` | GAS 스크립트 속성 | 계약서 저장 드라이브 폴더 ID |
| `개고생2_URL` | GAS 스크립트 속성 | 개고생2.0 스프레드시트 URL |
| `VILLAGE_AI_URL` | GAS 스크립트 속성 | https://village-ai.vercel.app (이건 노출돼도 무방) |
| `WEB_APP_URL` | GAS 스크립트 속성 (선택) | 자체 웹앱 URL |
| `contractEditTS_<거래ID>` | GAS 스크립트 속성 (런타임 임시) | 계약서 동시편집 잠금용 — 실제 시크릿 아님 |
| **village-ai 측 시크릿** | Vercel 환경변수 (이 레포 외부) | 프롬프트, 모델 키 등 — 미상 |

## 결정 로그

코드 구조와 커밋 히스토리에서 추론. 시점은 커밋 날짜 기반 추정.

- **D1 (2026-04-01 추정, 초기 커밋 시점)**: 진실 원천을 구글 시트로 — DB·외부 어드민 안 씀
  - 왜: 사장/직원이 직접 시트에서 보고 수정 가능. 비기술자가 권한 가짐. 별도 어드민 UI 안 필요.
  - 대안: Postgres + Notion / Airtable / 자체 어드민
  - 트레이드오프: 동시성 제어 약함, 수식 의존도 높음, 데이터 늘면 느려짐 → 실제 발생, D7로 보완
- **D2 (초기)**: GAS 웹앱 단일 엔드포인트(`sheetAPI.js`) — `doGet/doPost` 1곳에만, action 파라미터로 분기
  - 왜: GAS는 같은 프로젝트 내 doGet/doPost 충돌 시 의미불명. CLAUDE.md에 "doGet/doPost는 sheetAPI.js에만 정의" 명문화.
  - 트레이드오프: switch 분기가 ~30개로 거대화
- **D3 (커밋 `c89f4dc` 부근, 4월 초)**: 카카오톡 처리는 LLM 에이전트로 외부화
  - 왜: 카톡 표현이 비정형 (`a7s3 바디세트`, `70200gm2` 등). 정규식 한계.
  - 대안: GAS 안에서 직접 Claude API 호출
  - 트레이드오프: 외부 의존 / 응답 지연. 단 GAS의 30초 제한 회피.
  - 참고: `AGENT_GUIDE.md` STEP 1~6 정의. 사람-인-더-루프 (사장이 STEP 5·6 승인).
- **D4 (커밋 `2d8f58c`, `573be62` 부근, 4월 말~5월 초)**: 동행 모드 = AI 검증 게이트를 N열 등록 시점에
  - 왜: 직원·사장이 잘못된 데이터로 등록하기 전 마지막 가드. 실수 비용 큼 (중복 예약·계약서 잘못 발송).
  - 대안: 가용 확인 단계에 검증 / 등록 후 사후 점검
  - 트레이드오프: 결정 지연, AI 응답 실패 시 fallback 필요 (현재 warn 처리), 코드 복잡도 증가.
- **D5 (커밋 `f83907e`, 4월 중순 추정)**: GitHub Pages로 프론트엔드 직접 서빙
  - 왜: GAS 웹앱은 페이지 로딩이 느림. 커밋 메시지 직접 인용: "GitHub Pages 프론트엔드 분리 - 페이지 로딩 속도 대폭 개선"
  - 대안: 모든 페이지를 GAS HtmlService로
  - 트레이드오프: 두 곳에 HTML 동기화 필요 (루트 + docs/)
- **D6 (커밋 시점 미상, generatecontract.js 초기)**: 계약서를 드라이브 별도 파일로
  - 왜: 고객 공유 / 인쇄 편의 / 회차 관리 / 계약마스터 시트 비대화 방지
  - 트레이드오프: 백업이 GAS 외 별도 → 폴더 권한·삭제 위험. 백업 정책 부재.
- **D7 (커밋 `f9c9ce4`, `e2e6b36`, `ca2ad8c` 부근, 4월 말)**: 대시보드 5분 캐시 + 캐시 워머 트리거
  - 왜: 시트 읽기 누적 → 응답 느림. Stale-while-revalidate 패턴.
  - 대안: 캐시 없이 매번 실시간
  - 트레이드오프: 5분 동안 outdated 가능 → 변경 시점 즉시 무효화로 보완 (`invalidateDashboardCache`)
- **D8 (코드 진화 결과)**: 세 가지 onEdit (간단 `onEdit` + 설치형 `onEditInstallable` + 동행 `onEditInstallable_companion`)
  - 왜:
    - 간단 onEdit: 외부 서비스 호출 못 함 (인증 한계)
    - 설치형: 개고생2.0 쓰기 등 외부 권한 필요
    - companion 설치형: 사이드바·UI alert·village-ai 호출 필요
  - 트레이드오프: 트리거 충돌 위험 → CLAUDE.md "트리거 충돌 가능성"을 셀프 리뷰 항목으로 명문화
- **D9 (`generatecontract.js` 초기)**: 장기 할인 계단식 (2일 10% / 3-5 20% / 6-9 35% / 10-14 40% / 15-19 45% / 20+ 50%)
  - 위치: `getLongTermDiscountRate` 하드코딩
  - 함정: 2026-05 초 두 차례 미적용 사고 (커밋 `🚨 03f0e5b`, `🚨 91eb1bb`) — 셀 number format이 percent로 자동 전환 → REGEXEXTRACT가 0.1에서 "0"만 추출 → 0% 처리. `setNumberFormat("@")` 텍스트 강제로 처치.
- **D10 (커밋 `5e20635`, 2026-05-02)**: 두 맥 동기화는 스크립트로 강제
  - 왜: 한쪽 맥에서 git push 빼먹어 GAS-git 6,695줄 어긋남 사고 발생. 사람의 꼼꼼함에 의존하면 반복.
  - 결과: `scripts/startwork.sh` / `endwork.sh` / `synccheck.sh` + CLAUDE.md "떠나는 맥에서 endwork, 도착하는 맥에서 startwork" 원칙 명시. PR #1 머지.

## 의존성 / 통합 지점

### 외부 서비스
- **개고생2.0 (AppSheet/시트)**: `generatecontract.js:457` `SpreadsheetApp.openByUrl(개고생2_URL)`. 거래내역 시트 M열 계약서 링크 입력 + 고객DB I열 할인유형 매칭 → 확인요청 M열 자동 채움. 인증: 같은 구글 계정 권한.
- **village-ai (Vercel)**: `villageAiClient.js:38` POST `${VILLAGE_AI_URL}/api/advise-booking`. 응답 `{verdict: ok|warn|block, blocks, warnings, notes}`. 호출 실패 시 warn fallback (block 안 함).
- **팝빌**: `checkAvailability.js:3571` POST `auth.linkhub.co.kr/POPBILL/Token` (토큰 발급, HMAC SHA-256 서명). `checkAvailability.js:3621` POST `popbill.linkhub.co.kr/KakaoTalk/{corpNum}` (알림톡 발송). 템플릿 코드 `TPL_CHECKOUT='026040000902'`, `TPL_CHECKIN='026040000904'`.
- **Google Drive**: `generatecontract.js:92,93` 템플릿 복사 → 지정 폴더 저장. `DriveApp` 사용.
- **GitHub Pages**: docs/ 폴더 git push만 하면 자동 반영. 별도 빌드 X.
- **Slack**: GAS는 호출 X. `getInventoryConflictsSlackMessage`로 텍스트만 만들고 외부 봇/n8n/cowork이 fetch해서 슬랙 메시지로 사용. 매일 아침 보고서용 (커밋 `9d629d0`).

### 다른 시스템과의 연결
- 빌리지 ↔ 개고생2.0 (양방향)
- 빌리지 → village-ai (단방향, 검증 요청)
- 빌리지 → 팝빌 (단방향, 발송)
- 빌리지 → Drive (단방향, 계약서 저장)
- 외부 시스템 → 빌리지 (LLM 디스패치 에이전트 / Slack bot 등이 sheetAPI 호출)

## 도메인 지식 / 비즈니스 규칙

### 식별자 형식
- 거래ID: `YYMMDD-NNN` (예: `260402-001`). 같은 날 N번째 거래.
- 요청ID: `RQ-YYMMDD-NNN`. 거래ID 앞에 `RQ-` 접두.
- 스케줄ID: 미상 (스케줄상세 A열, 코드에서 자동 생성 추정)

### 같은 요청ID 다중 행 규칙
한 예약에 여러 장비 → 첫 행에만 날짜·예약자·연락처, 나머지 행은 장비명·수량만. 가용 확인은 첫 행에 트리거 1번 → 전체 처리 (`processByReqID`).

### 세트 자동 펼침
확인요청 F열에 세트명 입력 + H="확인" → 스케줄상세에 구성품 행 자동 추가.

### 장비명 매칭
카톡 비정형 텍스트 → `목록` 시트 마스터에서 레벤슈타인 + 퍼지 매칭 (`fuzzyMatchEquipName`).

### 연락처 정규화
끝 10자리 비교. `010-1234-5678` / `01012345678` / `1012345678` 모두 동일 처리. 고객DB 매칭 시 사용.

### 할인유형 (확인요청 M열, 계약마스터 K열, 고객DB I열)
- `학생30%` → 사전할인: 학생30%
- `개인사업자/프리랜서20%` → 사전할인: 개인사업자/프리랜서20%
- `단골10%` → 사전: 개인사업자/프리랜서20% + 추가: 단골10%
- `제휴업체20%` → 사전: 개인사업자/프리랜서20% + 추가: 제휴업체20%

(K↔L 스왑 이력: 커밋 `04470cf` "K=할인유형(드롭다운), L=비고")

### 장기 할인율 (대여 일수 기반, `getLongTermDiscountRate`)
- 1일: 0%
- 2일: 10%
- 3~5일: 20%
- 6~9일: 35%
- 10~14일: 40%
- 15~19일: 45%
- 20일 이상: 50%

### 대여일수 계산 (`calcRentalDays`)
24시간 = 1일. 6시간 이내 초과 = 같은 일수. 6시간 초과 = +1일.
- 30시간 = 1일
- 31시간 = 2일
- 54시간 = 2일
- 55시간 = 3일

### 알림톡 발송 규칙
- 반출 안내: 반출 시간 12시간 전
- 반납 안내: 반출 시간 + 3시간 후
- 발송 가능 시간: 09:00~21:00 (밖이면 09:00으로 지연)
- 트리거: 30분마다 `checkGuideAlimtalk`
- 대상: **3회 미만 고객만** (반복 고객은 안내톡 X)

### 시간 처리
- 타임존: `Asia/Seoul` (`appsscript.json` 명시)
- `parseDT`: 시간 한 자리(`7:00`) → 두 자리(`07:00`) 패딩 필수 (ISO 형식)

### 시트 구조 (열 매핑 — off-by-one 주의)

확인요청 (18열):
- A:요청ID  B:반출일  C:반출시간  D:반납일  E:반납시간
- F:장비    G:수량   H:확인    I:결과    J:상세
- K:예약자  L:연락처  M:업체명/할인유형  N:등록  O:등록상태
- P:거래ID  Q:비고    R:추가요청

스케줄상세 (12열):
- A:스케줄ID  B:거래ID  C:장비  D:반출DT  E:반납DT  F:상태
- G:반납완료  H:미상  I:미상  J:미상  K:수량  L:단가
- (G~J 정확한 의미는 코드만으론 추정 한계 — 실제 시트 봐야 함)

계약마스터:
- A:거래ID  B:예약자명  C:연락처  D:업체명  E:반출일  F:반출시간
- G:반납일  H:반납시간  I:회차  J:계약상태  K:할인유형  L:비고

쓰기 화이트리스트 (`sheetAPI.js:26`): "확인요청", "스케줄상세", "신규장비 추가", "실사 기록"

### 중복 방지
같은 예약자명 + 반출일 + 장비목록이면 입력/등록 모두 차단 (CLAUDE.md 명시).

### 핵심 트리거 흐름
- 확인요청 H열 "확인" → `processByReqID()` 자동 가용성 체크
- 확인요청 N열 "등록" → 동행 모드 검증 → `registerByReqID()` 스케줄상세 + 계약마스터 등록 + 계약서 자동 생성
- 확인요청 N열 "추가/삭제/날짜변경" → 스케줄 수정 + 계약서 재생성
- 계약마스터 J열 "취소" → 스케줄상세 삭제 + 개고생2.0 거래내역 삭제

## 알려진 함정 / 엣지 케이스

### 코드/커밋에 흔적 남은 것
- **시간 셀 LMT 버그** (커밋 `baa7fde fix(companion): 시간 셀 LMT 버그 회피 — getDisplayValues 사용`): 셀이 시간 타입일 때 `getValue`가 LMT(Local Mean Time, 32분 단위 비표준 타임존) 반환. 회피: `getDisplayValues` 사용.
- **장기할인 셀 포맷 자동 전환** (커밋 `🚨 03f0e5b`, `🚨 91eb1bb`): C45 셀이 percent format으로 자동 전환되어 REGEXEXTRACT가 0.1에서 "0"만 추출 → 0% 처리. **`setNumberFormat("@")` 강제 필수**.
- **계약서 시트 유효성**: 계약서 생성 시 `setAllowInvalid` 전체 해제 필수 (CLAUDE.md 명시). 안 하면 셀 유효성 검사가 데이터 거부.
- **AppSheet 폭주** (커밋 `8cf1677`): 거래내역 A열 update를 값 변경 시에만 수행. 모든 행 update하면 AppSheet bot 무한 호출.
- **세트 자기참조** (커밋 `2c444da autoExpandSetInSchedule — 빈 구성품/자기참조 행 필터`): 세트 헤더가 자기 자신을 구성품으로 갖는 경우 제외 처리 필요.
- **고아 구성품** (`checkAvailability.js:1602` 주석): "Q열 [세트]XXX에서 XXX가 현재 세트 헤더에 없는 것만 삭제". 잘못 삭제하면 정상 데이터 손실.
- **GAS POST 리다이렉트 문제** (`AGENT_GUIDE.md` 명시): 외부 에이전트 호출은 모두 GET. POST는 GAS 리다이렉트로 안 됨.
- **onEdit 이중 호출 방지** (커밋 `5ab5d97`): onEdit이 자기 자신을 트리거하는 무한 루프 방지 필요.
- **장비명 비정형 매칭** (커밋 `1c09609`, `8c2fc27`, `0edd533`): 카톡 입력은 형태가 매번 다름 → 퍼지 매칭. 미매칭 시 전체 목록 드롭다운 표시.

### 운영상 함정
- **메모리/리더기 분실** (사용자가 이번 세션에서 직접 제기): 본체와 다른 시점 반납 → 추적 불가. 코드/시트에 추적 메커니즘 없음. 직원 부재 시간대(오후·사장 부재) 반출 시 더 심함. **시스템적 가시화 필요**.
- **두 맥 동기화 누락**: 한쪽에서 git push 빼먹으면 GAS와 git 어긋남. PR #1 스크립트로 처방했지만 스크립트 안 돌리면 무용지물.
- **인수인계 연속성 부재**: 오전 직원 → 사장 → 무직원 시간대 인수인계가 시스템에 잡히지 않음.

## 활성 부분 vs 죽은 코드

### 활성 (최근 30일 내 수정·실행)
- `Code.js` (1,279줄) — onEdit / onEditInstallable
- `checkAvailability.js` (4,432줄) — 가용확인 / 등록 / 대시보드 / 타임라인 / 팝빌
- `sheetAPI.js` (727줄) — 통합 API
- `generatecontract.js` (831줄) — 계약서 생성
- `companionServer.js` (199줄), `companionValidator.js` (126줄), `companionSidebar.html` (84줄) — 동행 모드 (2026-05-02 통합)
- `villageAiClient.js` (66줄) — village-ai 호출 래퍼
- `dashboard.html` / `timeline.html` / `requestManage.html` / `timelineMobile.html` — 운영 페이지
- `docs/*.html` — GitHub Pages 운영 사본
- `Manual.html` (455줄) — 업무 매뉴얼 (시나리오 탭 구조, 커밋 `68e0f99`)
- `scripts/*.sh` — 두 맥 워크플로우 (2026-05-02 신규, PR #1)

### 정체 / 축소
- `setupSchedule.js` (1줄) — 거의 비어있음. 정리 후보.
- `createManual.js` (1줄) — 거의 비어있음. 정리 후보.
- 디버그 함수 메뉴 노출: `debugCheckAvailForSelected`, `forceRerunCheckAvailForSelected` — 운영 환경에서 우발 실행 위험. 운영 메뉴와 분리 필요.

### 죽음 (커밋에서 제거)
- 확인요청 입력 웹폼 (커밋 `854a595 확인요청 입력 웹폼 제거 (디스패치 에이전트로 대체)`)
- 사진 캡처 OCR (커밋 `673290b ... + OCR 코드 롤백`)
- 사용하지 않는 메뉴 4개 항목 (커밋 `9b40fa9`)

## 외부 문서·링크
- 레포 내 메타: `CLAUDE.md`, `AGENT_GUIDE.md`, `docs/companion-deploy.md`
- GitHub Pages: https://village6k-cpu.github.io/my-gas-project2/
- 운영 매뉴얼 (시트 안 + Manual.html): GAS UI에서 "📖 업무 매뉴얼" 메뉴
- 외부 NotebookLM 링크 (커밋 `f6a90d4` "동행모드 '빌리지AI한테 물어보기' 링크를 NotebookLM으로 교체"): 사장 운영 노트북LM, URL 미상
- village-ai 측 문서: 미상 (외부 시스템)
- 개고생2.0 측 문서: 미상

## 위험 신호 / TODO

### 보안 (긴급)
- `sheetAPI.js:24` API_KEY 평문 하드코딩 (`village2026` — 단순 단어). GitHub 공개 레포에 노출 시 무방비.
- `AGENT_GUIDE.md:7-8`, `CLAUDE.md`도 동일 키 평문.
- 웹앱 access `ANYONE_ANONYMOUS` (`appsscript.json`). 키만 알면 누구든 호출.
- 처치 순서: (1) 새 키 발급 + 스크립트 속성 이동 (2) 코드/문서 평문 제거 (3) 키 로테이션 정책 수립

### 데이터 보존
- 계약서 드라이브 폴더 백업 부재. 폴더 권한 사고/실수 삭제 시 복구 어려움.
- 시트 자체 백업 정책 부재. 구글 자체 버전 기록은 짧음. 정기 export 없음.
- GAS 코드는 git이 백업 — 단 두 맥 동기화 사고처럼 어긋남 가능 (PR #1로 스크립트 처방)
- 사용자 분실 이력·운영 기록 저장 위치 미상 — 시트에 있는지, 별도 노트인지

### 운영
- 디버그 함수 메뉴 노출 — 잘못 누르면 데이터 변경
- `checkAvailability.js` 4,432줄 단일 파일 비대화 — 도메인 분리 안 됨 (가용/등록/알림톡/대시보드/타임라인 혼재)
- 셀 포맷 함정이 다른 곳에도 잠복 가능 — 회차 자동계산, 단가 계산 등 percent/숫자 자동 변환 영역
- 단위 테스트 0건. 회귀는 사람이 직접 시트 보고 확인.
- TypeScript / 스키마 검증 0건 — 시트 컬럼 변경 시 코드 무방비

### 미해결 질문 (사용자 발화)
- 사용자 인용: "메모리, 리더기 분실 문제로 고통 받고 있어. 시스템을 잡는다고 잡았는데도 해결이 안 되는 것 같다... 오전에만 직원을 쓰고 오후 타임에는 직원도 없고..."
- 사용자 인용: "언제 어디서 어떻게 사라졌는지도 알기 힘들어ㅋㅋㅋㅋ"
- 우선순위: *분실 방지*보다 *분실 시점 가시화*가 먼저 (측정 메커니즘 없으면 어떤 솔루션도 효과 검증 불가)

## 케이스 스터디

### Case 1: 6,695줄이 GAS에만 있고 git에는 없던 사고 (2026-05-02)
**상황**: 두 맥 오가며 작업 중, 한쪽 맥에서 `clasp push`만 하고 `git push`를 빼먹음. 사용자가 다른 맥에서 작업 시작하려 `clasp pull` → 19개 파일 수정 + 4개 신규 (`companionServer.js`, `companionSidebar.html`, `companionValidator.js`, `villageAiClient.js`) 발견. 다른 맥에서 한 달 분량 작업이 git에 없는 상태.

**대응**:
1. 현재 GAS 상태를 1개 commit으로 박제 (`d482e27 다른 맥 작업분 동기화`)
2. 원격이 21개 커밋 앞서있어 `git pull --no-rebase` 머지 (rebase는 6,695줄 재적용 → 충돌 폭발 위험)
3. 머지 결과: `CLAUDE.md` 31줄 + `docs/companion-deploy.md` 39줄만 차이. 코드 본체는 100% GAS=원격 일치 (deploy=push 했기 때문)
4. 근본 원인 처방: `scripts/startwork.sh` / `endwork.sh` / `synccheck.sh` 도입. CLAUDE.md에 "떠나는 맥에서 endwork, 도착하는 맥에서 startwork" 명문화. PR #1 머지.

**교훈**:
- `clasp push`는 GAS만 갱신. `git push`는 별도. 둘 다 안 하면 한쪽이 진실 원천이 됨.
- 두 맥 환경에서 사람의 꼼꼼함에 의존 = 반드시 빠짐. 스크립트로 강제해야 함.
- 큰 디프 재적용 시 `--rebase`는 충돌 폭발. 머지가 안전.
- GAS의 deployed 상태가 실질적 source of truth임을 인정해야 함. clasp pull로 일단 박제 후 git에 진입.

### Case 2: 장기할인 미적용 두 차례 (커밋 `🚨 03f0e5b`, `🚨 91eb1bb`)
**상황**: 계약서 C45에 `setValue("0.1")` 했는데 셀 number format이 percent로 자동 전환되어 `0.1` → `10%`로 표시. H46의 `REGEXEXTRACT(C45, "\d+")`가 "10%"의 첫 숫자가 아닌 0.1의 내부 표현 "0"을 추출 → 할인 0% 처리.

**대응**: 텍스트 포맷 강제 — 모든 할인 셀에 `setNumberFormat("@")`.

**교훈**: 시트 셀 데이터 타입이 `setValue` 시점에 자동 전환됨. 텍스트로 다룰 거면 명시적으로 강제. 비슷한 함정이 회차 자동계산·단가 계산 등 다른 곳에도 잠복 가능.

### Case 3: 동행 모드 통합 (2026-05-02, 커밋 `d482e27` 안에 합쳐짐)
**상황**: AI 검증 + 사이드바 + 트리거를 한꺼번에 통합. companion 관련 4개 신규 파일 + `checkAvailability.js` +2,905줄.

**구조 원칙**:
- village-ai (외부 검증) ↔ companionValidator (로컬 검증) ↔ `onEditInstallable_companion` (트리거) — 책임 분리
- AI 실패 시 warn으로 fallback (block 안 시킴) — 외부 의존 위험 흡수

**교훈**: 위험한 단계 (등록 = 데이터 영구화 직전)에 검증 게이트 두는 게 효과적. 외부 AI 의존은 fallback 정책 명시 필수.
