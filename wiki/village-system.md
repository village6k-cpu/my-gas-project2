---
date: 2026-05-05
type: raw-investigation
source: artifact (codebase + git log + 기존 docs)
target_system: 빌리지(Village) 카메라 렌탈 시스템
status: raw — 정제 안 됨, 코워크가 다른 노트와 합쳐 위키로 가공 필요
related_paths:
  - "~/my-gas-project2"
  - "github.com/village6k-cpu/my-gas-project2"
---

# 빌리지 시스템 조사 노트 (raw)

artifact 직접 조사로 모은 fact와 인용. 합성·해석은 별도 단계.
출처 표기: `파일:라인` 또는 `커밋해시 메시지`.

---

## 0. 조사 범위

- 코드베이스: `~/my-gas-project2` (모든 .js, .html, .json, .md, scripts/)
- git log 117 커밋 (2026-04-01 ~ 2026-05-02)
- 기존 메타 문서: `CLAUDE.md`, `AGENT_GUIDE.md`, `docs/companion-deploy.md`
- 외부 시스템은 직접 조사 X — 코드의 호출 흔적·스크립트 속성만

조사 안 한 것:
- 실제 구글 시트 (열 구조 검증, 데이터 분포)
- village-ai (Vercel) 측 코드
- 개고생2.0 (AppSheet) 측 구조
- 운영 로그 (StackDriver)
- 분실 이력 데이터

---

## 1. 파일 인벤토리

```
1279 lines  Code.js
4432        checkAvailability.js   ← 단일 파일 가장 큼
 199        companionServer.js
 126        companionValidator.js
   1        createManual.js        ← 비어있음
 831        generatecontract.js
   1        setupSchedule.js       ← 비어있음
 727        sheetAPI.js
 119        sheetProtection.js
  66        villageAiClient.js
 455        Manual.html
  84        companionSidebar.html
 604        dashboard.html
 479        requestManage.html
 859        timeline.html
 371        timelineMobile.html
total: 10,633 lines (코드 + HTML)

scripts/
  endwork.sh      (32 lines, 실행권한)
  startwork.sh    (40 lines, 실행권한)
  synccheck.sh    (50 lines, 실행권한)

docs/
  companion-deploy.md
  dashboard.html / index.html / manage.html / timeline.html
  (docs/ 는 GitHub Pages가 직접 서빙 — 루트의 동명 파일과 별도 사본)
```

`appsscript.json`:
- timeZone: `Asia/Seoul`
- runtimeVersion: V8
- exceptionLogging: STACKDRIVER
- webapp: executeAs `USER_DEPLOYING`, access `ANYONE_ANONYMOUS`
- dependencies: 없음

`.clasp.json`:
- scriptId: `1MbjcaQygxXn-0zHoYnpmuVKGyQCOLaUwEYNQurRzRJ9tw_6d7-33ZTVh`
- rootDir: `""` (루트 그대로)
- skipSubdirectories: false

---

## 2. CLAUDE.md에서 직접 인용

> "카메라 렌탈샵 '빌리지'의 렌탈 관리 시스템. 구글시트, 구글 앱스크립트, 앱시트, 웹앱을 조합해서 구축 중."

> "doGet/doPost는 sheetAPI.js에만 정의"
> "onOpen은 checkAvailability.js에만 정의"
> "GAS는 같은 프로젝트 내 모든 .js 파일이 전역 스코프 공유"

> "재배포 자동화: 사용자는 매번 수동 배포하는 걸 원하지 않음. 코드 변경 작업은 4번까지 항상 자동 실행"

배포 순서 (CLAUDE.md 명시):
1. clasp pull → 2. 수정 → 3. clasp push → 4. clasp deploy → 5. git push

핵심 로직 (CLAUDE.md 명시):
- 확인요청 H열 "확인" → `processByReqID()` 자동 가용성 체크
- 확인요청 N열 "등록" → `registerByReqID()` 스케줄상세 + 계약마스터 등록 + 계약서 자동 생성
- N열 "추가/삭제/날짜변경" → 스케줄 수정 + 계약서 재생성
- 중복 방지: 같은 예약자명 + 반출일 + 장비목록이면 입력/등록 모두 차단
- 장기 할인: 2일 10%, 3~5일 20%, 6~9일 35%, 10~14일 40%, 15~19일 45%, 20일+ 50%
- parseDT(): 시간 한 자리(7:00)→두 자리(07:00) 패딩 필수

시트 구조 (CLAUDE.md 명시):
- 확인요청: RQ-YYMMDD-NNN, 18열 A~R
- 스케줄상세: 12열, A:스케줄ID ~ L:단가
- 계약마스터: 거래ID YYMMDD-NNN

---

## 3. 코드에서 본 fact

### sheetAPI.js
- L24: `const API_KEY = "village2026";` ← **하드코딩 평문**
- L26: `WRITABLE_SHEETS = ["확인요청", "스케줄상세", "신규장비 추가", "실사 기록"]` ← 쓰기 화이트리스트
- L35: `doGet(e)` — 페이지 라우팅(`?page=timeline|dashboard|manage`) + JSON API
- L78: `doPost(e)` — handleRequest로 위임
- 페이지 라우팅 시 dashboard는 `INITIAL_DATA` HTML에 직접 박아 fetch 1회 절약 (L62 부근)
- action 분기: read, write, append, update, search, run, list, scan, 확인, 등록, 보류, 거절, 발송승인, toggleSetup, toggleReturn, toggleItem, addEquip, removeEquip 등 ~20개

### checkAvailability.js
- L3: 파일명 v3, 변경사항 메모 — "메뉴 클릭 불필요: 드롭다운 선택만으로 자동 실행", "확인결과 시트 없음: 결과가 확인요청 행에 직접 표시"
- L29: `onOpen()` — 메뉴 정의 + `refreshEquipmentList()` 자동 호출
- 메뉴 항목 (코드에서 추출):
  - 동행 모드 열기, 가용 확인 수동, 예약 등록 수동, 계약서 생성
  - **디버그 함수 메뉴 노출**: `debugCheckAvailForSelected`, `forceRerunCheckAvailForSelected`
  - 할인유형 재조회, 장비 목록 갱신, 실사기록 동기화
  - 확인요청 초기화 (수동), 계약서 설정, 업무 매뉴얼
- L271: `getDashboardData(targetDate, skipCache)` — CacheService 사용, 5분 캐시 (`L274-280`), 키 `dashboard_v2_<today>`
- L441: `getInventoryConflicts(hoursAhead)` — sweep-line 알고리즘으로 동시사용량 측정
- L534: `getInventoryConflictsSlackMessage(hoursAhead)` — 슬랙 텍스트 포맷 (외부 봇이 fetch)
- L766: `parseDT(dateVal, timeVal)` — 시간 패딩 처리
- L1602 주석: "고아 구성품 삭제: Q열 [세트]XXX에서 XXX가 현재 세트 헤더에 없는 것만 삭제"
- L3540 부근: 팝빌 API 호출 (LINKHUB HMAC SHA-256 서명)
- L3585 부근: `sendAlimtalk(templateCode, receiver, ...)`
- 알림톡 템플릿 코드: `TPL_CHECKOUT = '026040000902'`, `TPL_CHECKIN = '026040000904'`
- L3640 부근 주석:
  > "반출/반납 안내톡 (3회 미만 고객 대상)
  > 반출: 반출 시간 12시간 전 발송
  > 반납: 반출 시간 + 3시간 후 발송
  > 발송 가능 시간: 09:00~21:00 (밖이면 09:00으로 지연)
  > 트리거: 30분마다 checkGuideAlimtalk 실행"
- L4146: `onEditInstallable_companion(e)` — N열 "등록" 가드 (로컬 검증 + village-ai)
- L4228: `installCompanionTrigger()` — 사장이 GAS 편집기에서 1회 수동 실행

### Code.js
- L13: `onEdit(e)` — 간단 트리거 (실사 기록 자동입력, 요청ID 상속 등)
- L130: `onEditInstallable(e)` — 설치형 트리거 (개고생2.0 쓰기 등 외부 권한 필요)
- L141: 확인요청 A열에 거래ID(YYMMDD-NNN) 입력 시 자동으로 `RQ-` 접두 (L141-145)
- L161 부근: K(예약자명)/L(연락처) 변경 시 → `lookupDiscountFromCustomerDB(sheet, row)` (개고생2.0 매칭)

### generatecontract.js
- L9-12 주석: 스크립트 속성 `CONTRACT_TEMPLATE_ID`, `CONTRACT_FOLDER_ID`, `개고생2_URL`
- L290 주석: "할인 드롭다운 초기화 — 사전(C44), 추가(I44), 장기(C45), 쿠폰(I45)"
- L300-311: 할인유형 → 사전/추가 매핑
  ```
  학생30%      → 사전: 학생30%
  개인사업자/프리랜서20%  → 사전
  단골10%      → 사전: 개인사업자/프리랜서20% + 추가: 단골10%
  제휴업체20%   → 사전: 개인사업자/프리랜서20% + 추가: 제휴업체20%
  ```
- L314-322 주석: "할인 셀 4개 모두 텍스트 포맷 강제 (중요!)" — `setNumberFormat("@")`
- L654: `getLongTermDiscountRate(days)`:
  - days≥20: 50, ≥15: 45, ≥10: 40, ≥6: 35, ≥3: 20, ≥2: 10, else 0
- L671: `calcRentalDays(...)` — 주석: "24시간 = 1일, 6시간 이내 초과 = 같은 일수, 6시간 초과 = +1일. 예: 30시간=1일, 31시간=2일, 54시간=2일, 55시간=3일"
- L448 부근: `update개고생2거래내역계약서링크` — `개고생2_URL`로 SpreadsheetApp.openByUrl, 거래내역 시트 매칭

### villageAiClient.js
- L4: `villageAi_getUrl()` — 스크립트 속성 `VILLAGE_AI_URL` 필수, 없으면 throw
- L13: POST `/api/advise-booking`
- 응답 형식: `{ verdict: 'ok'|'warn'|'block', blocks: string[], warnings: string[], notes: string[] }`
- 호출 실패 시 caller(`onEditInstallable_companion`)가 catch해서 warn으로 fallback (block 안 시킴)

### companionValidator.js
- L1-9 주석: "5가지 차단 체크 (fail-fast 순서)":
  1. 스케줄 충돌
  2. 필수 필드 빈칸
  3. 날짜/시간 포맷 오류
  4. 수량 이상
  5. H열 확인 미실행

- 필수 필드 (L75-83): 반출일, 반출시간, 반납일, 반납시간, 장비, 수량, 예약자명, 연락처

### docs/companion-deploy.md
- village-ai 배포 확인 → GAS 스크립트 속성 `VILLAGE_AI_URL` 추가 → `installCompanionTrigger` 1회 실행 → 웹앱 재배포
- 트러블슈팅 명시: "VILLAGE_AI_URL 없음" / "AI 판정 실패" / "스케줄 충돌 오탐"

### AGENT_GUIDE.md (디스패치 에이전트용)
- 인증: `key=village2026` (CLAUDE.md와 동일 키 노출)
- "방식: 모든 요청은 GET으로 처리 (POST는 GAS 리다이렉트 문제로 안 됨)"
- STEP 1~6 정의 (파싱→매칭→입력+가용→보고→발송승인→등록)
- "STEP 1~2는 사용자 확인 없이 바로 진행"

### scripts/
- `startwork.sh`: git 미커밋 체크 → fetch+pull → clasp pull → 차이 검증, 차이 있으면 exit 2
- `endwork.sh`: 변경 없으면 clasp push만, 있으면 메시지 인자/프롬프트 → clasp push -f → clasp deploy -i `<DEPLOY_ID>` → git add/commit/push
- `synccheck.sh`: read-only, 로컬 미커밋·ahead/behind·최근 커밋·원격에만 있는 커밋 출력
- DEPLOY_ID 하드코딩: `AKfycbyRff4-lLXmne-iPIEf87x4-CH_5wb-Uv5dCGymELLrpiKluhg2gDdLdVP4Y0MmxnnT`

---

## 4. 외부 통합 (코드의 fetch/openByUrl 흔적)

| 외부 | 호출 위치 | 인증/설정 |
|---|---|---|
| 팝빌 token | `checkAvailability.js:3571` `auth.linkhub.co.kr/POPBILL/Token` | `POPBILL_LINK_ID`, `POPBILL_SECRET_KEY` |
| 팝빌 알림톡 | `checkAvailability.js:3621` `popbill.linkhub.co.kr/KakaoTalk/{corpNum}` | `POPBILL_CORP_NUM`, `POPBILL_SENDER_NUM` |
| village-ai | `villageAiClient.js:38` POST `${VILLAGE_AI_URL}/api/advise-booking` | `VILLAGE_AI_URL` |
| 개고생2.0 시트 | `generatecontract.js:457` `SpreadsheetApp.openByUrl(개고생URL)` | `개고생2_URL` |
| 드라이브 | `generatecontract.js:92,93` 템플릿 복사 | `CONTRACT_TEMPLATE_ID`, `CONTRACT_FOLDER_ID` |

스크립트 속성 grep 결과 (`PropertiesService`):
- `CONTRACT_TEMPLATE_ID`, `CONTRACT_FOLDER_ID` (generatecontract.js)
- `개고생2_URL` (generatecontract.js)
- `POPBILL_LINK_ID`, `POPBILL_SECRET_KEY`, `POPBILL_CORP_NUM`, `POPBILL_SENDER_NUM` (checkAvailability.js)
- `VILLAGE_AI_URL` (villageAiClient.js)
- `WEB_APP_URL` (sheetAPI.js, optional)
- `contractEditTS_<거래ID>` (generatecontract.js, 임시 잠금)

`UrlFetchApp.fetch` 등장 횟수: 4 (팝빌 token + 팝빌 알림톡 + village-ai + ?)

---

## 5. git log 패턴 (117 커밋)

기간: 2026-04-01 16:49 ~ 2026-05-02 19:59 KST (약 한 달)

초기 커밋:
- `fcaeb6a` 통합재고관리 전체 코드 초기 커밋 (2026-04-01)
- `425e9d1` insertAndCheckRequest 함수 추가
- `bba6d91` 모바일 타임라인 페이지 추가 — 실시간 스케줄 조회

주요 흐름 (커밋 메시지에서 추출):
- 확인요청 웹폼 추가 → 디스패치 에이전트로 대체 (`854a595`로 제거)
- OCR 코드 추가 → 롤백 (`673290b`)
- 사진 캡처 파싱 (`4488d24`)
- GitHub Pages 분리로 페이지 로딩 속도 개선 (`f83907e`, `8e245e4`)
- 모바일 UI 확대 작업 다수
- 장기할인 버그 fix 두 차례: `🚨 03f0e5b`, `🚨 91eb1bb`
- 동행 모드 시리즈 (커밋 9개): `5265af1`, `ec34787`, `11c57cd`, `573be62`, `a1e7079`, `2d8f58c`, `297a2b9`, `7bf1ae5`, `25a1172`, `08637a2`, `baa7fde`
- Dashboard 시리즈: 추가/삭제 (`5739b25`), 모달 (`bc3a6b9`), 점프 링크 (`3e2c6f9`), 체크리스트 (`90dbe84`), 캐시 무효화 (`ca2ad8c`), 가속 (`e2e6b36`), 속도 최적화 (`f9c9ce4`), 반출세팅 완료 체크 (`f9c9ce4`)
- 디버그 시리즈 (2026-05-02): `8a4dbcd`, `680c384`, `04d9148`, `e0239e7` — 가용확인 추적
- `d482e27` 다른 맥 작업분 동기화 — 19파일 +6,695줄 (이번 워크플로우 사고)
- `5e20635` 두 맥 워크플로우 자동화 스크립트 추가 (PR #1, 머지됨)

브랜치:
- `main` (활성)
- `claude/multi-machine-workflow-setup-FTbio` (PR #1 머지 후)
- `claude/add-confirmation-response-pfu90` (다른 작업, 활성)

---

## 6. 코드의 명시적 함정 주석 (인용)

- `checkAvailability.js:1602` "고아 구성품 삭제: Q열 [세트]XXX에서 XXX가 현재 세트 헤더에 없는 것만 삭제"
- `generatecontract.js:316` "그러면 H46의 REGEXEXTRACT(C45, "\d+")가 0.1에서 "0"만 추출해 할인 0% 처리됨"
- 커밋 `baa7fde`: "fix(companion): 시간 셀 LMT 버그 회피 — getDisplayValues 사용"
- 커밋 `8cf1677`: "거래내역 A열 update를 값 변경 시에만 — AppSheet 폭주 방지"
- 커밋 `2c444da`: "autoExpandSetInSchedule — 빈 구성품/자기참조 행 필터"
- 커밋 `5ab5d97`: "계약서 유효성 검사 수정 + 회차 자동계산 + onEdit 이중호출 방지"

---

## 7. 사용자가 대화에서 직접 제기한 미해결 운영 문제 (이번 세션 한정)

> "메모리, 리더기 분실 문제로 고통 받고 있어. 시스템을 잡는다고 잡았는데도 해결이 안 되는 것 같다... 오전에만 직원을 쓰고 오후 타임에는 직원도 없고 내가 없을 때도 막 장비를 반출 시키기도 하고... 메모리 리더기만 나중에 반납하는 경우도 있고..."

> "언제 어디서 어떻게 사라졌는지도 알기 힘들어ㅋㅋㅋㅋ"

이 문제는 코드/시트에 추적 메커니즘 없음 (조사 결과 분실 이력 시트·체크 메커니즘 발견 안 됨).
지인 렌탈샵도 풀타임 직원 있어도 같은 문제 → 사용자 본인이 "구조적 한계"로 의심.

---

## 8. 의문점 / 코워크가 채워야 할 빈칸

artifact만으론 답 안 나오는 것들:

- 스케줄상세 컬럼 G~J의 정확한 의미 (코드는 H/I/J 거의 안 읽음 — 시트 자체 봐야 함)
- "신규장비 추가" 시트 구조 (WRITABLE_SHEETS에 있지만 코드에서 거의 안 보임)
- "목록" 시트 구조 (장비명 자동완성 마스터)
- 계약마스터 K↔L 스왑 (커밋 `04470cf` "K=할인유형(드롭다운), L=비고") — 이전 구조 흔적이 코드에 남아있는지
- 분실율 실측 데이터 — 운영 기록 어디 있나? 시트에? 별도 노트에?
- 두 맥 중 어느 쪽이 "주" 작업기인지 (워크플로우 안정화 필요)
- 디스패치 에이전트(LLM)가 어떤 도구·모델 쓰는지 (Claude API? 자체 시스템?)
- village-ai의 prompt·검증 로직 (외부 시스템이라 이 레포에선 불가시)
- 운영 시간대 (오전 직원 / 오후 무직원 / 사장 부재 시간대) — 분실 시점 가설과 연결됨
- 위 사실들에 대한 사용자의 다른 노트 (`개고생2.0`, `village-ai`, `분실 추적` 등 위키화된 게 있는지)

---

## 9. 보안 우려 (artifact 발견)

- `sheetAPI.js:24` API_KEY 평문 + 단순 단어 (`village2026`)
- `AGENT_GUIDE.md:7-8` 동일 키 평문 노출
- `CLAUDE.md`에도 동일 키 평문
- 웹앱 access `ANYONE_ANONYMOUS`
- 깃 공개 레포 (확실치 않음 — 확인 필요)
- 백업 정책 흔적 X (시트도, 계약서 드라이브 폴더도)

---

## 10. 메타 (이 노트 작성 컨텍스트)

이 노트는 사용자가 "{시스템명}의 전체 그림을 정리해서 옵시디언 위키에 저장해줘"라고 요청한 작업의 raw 단계.
처음 시도에서 이미 정제된 위키 형식으로 만들었지만, 사용자가 raw 단계 따로 두는 워크플로우라 형식 다시 잡음.
다음 단계 (코워크): 이 raw 노트 + 사용자의 다른 노트 (`개고생2.0`, `village-ai`, 분실 관련 등) 참조해서 위키 정제.
