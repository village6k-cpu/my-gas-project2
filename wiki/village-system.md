---
created: 2026-05-05
domain: Work
type: system-architecture
status: in-use
tags:
  - village
  - camera-rental
  - google-apps-script
  - google-sheet
  - appsheet
  - kakao-alimtalk
  - web-app
related:
  - "[[gaegoseng-2-0]]"
  - "[[village-ai]]"
  - "[[two-mac-workflow]]"
---

# 빌리지(Village) 카메라 렌탈 운영 시스템

## 시스템 정체성

카메라 렌탈샵 "빌리지"의 예약·재고·계약·고객 응대를 통합 관리하는 시스템. **구글 시트가 데이터 진실 원천**이고, 그 위에 GAS 웹앱(API)·GitHub Pages 프론트엔드·외부 AI 검증·알림톡 발송이 얹혀 있는 구조.

- **사용자**: 사장님(혼자 풀타임), 오전 직원(파트타임), 카카오톡으로 문의 받는 디스패치 에이전트(LLM)
- **현재 상태**: 실가동 중 (2026-04-01 첫 커밋, 2026-05-02까지 117개 커밋, 활발한 일일 운영)
- **마지막 활동**: 2026-05-02 (`5e20635 두 맥 워크플로우 자동화 스크립트 추가`)
- **레포**: `village6k-cpu/my-gas-project2`
- **로컬 경로**: `~/my-gas-project2`

---

## 아키텍처 (멘탈 모델)

```
┌──────────────────────────────────────────────────────────┐
│                     사용자 채널                              │
├──────────────┬─────────────┬──────────────┬───────────────┤
│ 카카오톡      │  GAS UI     │ GitHub Pages │  AppSheet     │
│ (LLM 에이전트)│ (직원/사장)  │ (모바일 웹)   │ (개고생2.0 점프)│
└──────┬───────┴──────┬──────┴──────┬───────┴───────┬───────┘
       │              │             │                │
       ▼              ▼             ▼                │
┌──────────────────────────────────────────────────┐ │
│              sheetAPI.js (doGet/doPost)            │
│       key=village2026 인증, JSON 응답              │
│   actions: read/write/run/확인/등록/...            │
│   pages: timeline / dashboard / manage             │
└──────────────────────────────┬─────────────────────┘ │
                               │                       │
                               ▼                       │
┌──────────────────────────────────────────────────┐  │
│         핵심 로직 (checkAvailability.js)            │
│   • 가용 확인 (sweep-line 동시사용량)               │
│   • 등록 (스케줄상세 + 계약마스터 쓰기)             │
│   • 동행 모드 검증 (companion_localChecks)          │
│   • 알림톡 발송 (팝빌)                              │
│   • 대시보드/타임라인 데이터                        │
└──┬──────────────┬─────────────┬─────────────┬─────┘  │
   │              │             │             │        │
   ▼              ▼             ▼             ▼        ▼
┌────────┐  ┌──────────┐  ┌──────────┐  ┌───────────┐ ┌────────┐
│ 구글시트 │  │ village-ai│  │ 팝빌      │  │개고생2.0   │ │ 드라이브 │
│ (진실)   │  │ (AI 검증) │  │ (알림톡)   │  │(거래내역)  │ │(계약서)  │
└────────┘  └──────────┘  └──────────┘  └───────────┘ └────────┘
```

### 데이터 흐름 (예약 1건 처리)
1. **카톡 문의** → LLM 에이전트가 파싱 (장비명/날짜/연락처)
2. **확인요청 시트 입력** (`insertAndCheckRequest`) — 18개 열 A~R
3. **자동 가용 확인** (`processByReqID`) → I/J열에 결과
4. **알림톡 발송** (사장/직원이 H열 "확인" 선택 시 또는 API `발송승인`)
5. **고객 OK** → 직원이 N열 "등록" 선택
6. **검증 게이트 작동** (동행 모드 트리거):
   - 로컬 검증 (스케줄 충돌/필수 필드/포맷/수량/H열 미실행)
   - village-ai 검증 → verdict: ok/warn/block
7. **통과 시 등록**: 스케줄상세에 행 펼치기 + 계약마스터 행 생성 + 거래ID(YYMMDD-NNN) 발급
8. **계약서 자동 생성**: 템플릿 복사 → 데이터 채움 → 드라이브 폴더 저장
9. **개고생2.0(AppSheet) 거래내역 M열에 계약서 링크 입력**
10. **등록 완료 알림톡 발송**

### 통합 지점
| 외부 시스템 | 연결 방식 | 인증 |
|---|---|---|
| **개고생2.0** (AppSheet) | `SpreadsheetApp.openByUrl` 직접 | 스크립트 속성 `개고생2_URL` |
| **village-ai** (Vercel) | `UrlFetchApp.fetch POST /api/advise-booking` | 스크립트 속성 `VILLAGE_AI_URL` |
| **팝빌 알림톡** | `UrlFetchApp.fetch` (HMAC SHA-256 서명) | `POPBILL_LINK_ID`, `POPBILL_SECRET_KEY`, `POPBILL_CORP_NUM`, `POPBILL_SENDER_NUM` |
| **Google Drive** | `DriveApp` (계약서 템플릿 복사) | `CONTRACT_TEMPLATE_ID`, `CONTRACT_FOLDER_ID` |
| **GitHub Pages** | docs/ 폴더 git push (자동 반영) | OAuth (PR 머지) |
| **Slack** | 외부 봇이 GAS API에서 메시지 텍스트 fetch | (외부 측 webhook) |

---

## 결정 로그 (재구성)

코드 구조와 커밋 히스토리에서 추론한 의사결정들. **이 시스템의 판단 패턴**.

### D1: 진실 원천을 구글 시트로
- **선택**: 모든 데이터를 구글 시트(확인요청/스케줄상세/계약마스터 등)에 저장. DB 안 씀.
- **왜**: 사장/직원이 직접 시트에서 보고 수정 가능. 비기술자가 권한 가짐.
- **대안**: Postgres + 별도 어드민 UI / Notion DB / Airtable
- **트레이드오프**: 동시성 제어 약함 / 수식 의존도 높음 / 데이터 량 늘면 느려짐 — 실제로 발생해서 캐시 도입(D7).

### D2: GAS 웹앱 단일 엔드포인트(sheetAPI.js)로 통합
- **선택**: doGet/doPost를 sheetAPI.js 1곳에만. action 파라미터로 분기.
- **왜**: GAS는 doGet/doPost 충돌 시 의미불명 — CLAUDE.md에 "doGet/doPost는 sheetAPI.js에만 정의" 명시
- **대안**: 파일별로 엔드포인트 분리
- **트레이드오프**: action 분기 길어짐 (현재 ~30개) → switch 거대화

### D3: 카카오톡 처리는 LLM 에이전트로 외부화
- **선택**: 빌리지 시스템 자체엔 카톡 파싱 안 넣음. 외부 LLM 에이전트가 카톡 텍스트/이미지 파싱 → 빌리지 API 호출.
- **왜**: 카톡 표현이 비정형(`a7s3 바디세트`, `70200gm2`). 정규식 한계.
- **대안**: GAS 안에서 직접 Claude API 호출
- **트레이드오프**: 외부 의존 / 키 관리 / 응답 지연. 단 GAS의 30초 제한 회피.
- **참고**: `AGENT_GUIDE.md`에 에이전트 처리 단계 (STEP 1~6) 정의. 사장이 사람-인-더-루프로 승인.

### D4: 동행 모드(=AI 검증 게이트)를 N열 등록 시점에
- **선택**: 등록 직전(N열="등록")에 로컬 검증 + village-ai 호출. block/warn/ok로 분기.
- **왜**: 직원·사장이 잘못된 데이터로 등록하기 전 마지막 가드. 실수 비용이 매우 큼(중복 예약·계약서 잘못 발송).
- **대안**: 가용 확인 단계에 검증 / 등록 후 사후 점검
- **트레이드오프**: 결정 지연 / AI 응답 실패 시 fallback 필요(현재 warn 처리). 코드 복잡도 증가.

### D5: GitHub Pages로 프론트엔드 직접 서빙
- **선택**: timeline/dashboard/manage HTML을 docs/에 두고 GitHub Pages가 직접 서빙. GAS는 데이터 API만.
- **왜**: GAS 웹앱은 페이지 로딩이 느림 (`f83907e GitHub Pages 프론트엔드 분리 - 페이지 로딩 속도 대폭 개선`)
- **대안**: 모든 페이지를 GAS HtmlService로
- **트레이드오프**: 두 곳에 HTML 동기화(루트 + docs/) 필요. CORS는 같은 GAS API라 큰 문제 X.

### D6: 계약서를 드라이브 파일로
- **선택**: 시트 안에 계약서 두지 않고 별도 스프레드시트 파일로 복사 → 폴더 저장 → 링크 공유.
- **왜**: 고객 공유 / 인쇄 편의 / 회차 관리 / 계약마스터 시트 비대화 방지
- **트레이드오프**: 백업이 GAS 외 별도 → 폴더 권한·삭제 위험

### D7: 대시보드 5분 캐시 + 캐시 워머 트리거
- **선택**: `getDashboardData`에 CacheService 5분 + 분당 워머 트리거. 등록/취소/일정변경 시 즉시 무효화.
- **왜**: 시트 읽기가 누적되며 응답 느려짐. Stale-while-revalidate 패턴.
- **트레이드오프**: 5분 동안 outdated 데이터 가능 — 변경 시점에 무효화로 보완.

### D8: 두 가지 onEdit (간단 + 설치형)
- **선택**: `onEdit` (간단) + `onEditInstallable` + `onEditInstallable_companion` 3개 운영
- **왜**:
  - 간단 onEdit: 외부 서비스 호출 못 함 (인증)
  - 설치형: 개고생2.0 쓰기 등 외부 권한 필요
  - companion 설치형: 사이드바·UI alert·village-ai 호출 필요
- **트레이드오프**: 트리거 충돌 위험 → CLAUDE.md "트리거 충돌 가능성" 셀프 리뷰 항목으로 명문화

### D9: 장기 할인 계단식 (2일 10% / 3-5일 20% / 6-9일 35% / 10-14일 40% / 15-19일 45% / 20일+ 50%)
- **선택**: 일수 구간별 정해진 율. 하드코딩.
- **위치**: `generatecontract.js:getLongTermDiscountRate`
- **함정**: 2026-05 초 `장기할인 미적용` 두 차례 (커밋 03f0e5b, 91eb1bb) — 셀 number format이 percent로 자동전환되어 H46의 REGEXEXTRACT가 0.1에서 "0"만 추출. **텍스트 포맷 강제 setNumberFormat("@") 필수**.

### D10: 두 맥 동기화는 스크립트로 강제
- **선택**: `scripts/startwork.sh` / `endwork.sh` / `synccheck.sh` 도입. CLAUDE.md에 "떠나는 맥에서 endwork, 도착하는 맥에서 startwork" 원칙 명시.
- **왜**: 한쪽 맥에서 git push 빼먹어 GAS-git 6,695줄 어긋남 사고 (2026-05-02). 사람의 꼼꼼함에 의존하면 반복.
- **PR**: #1 (머지 완료)

---

## 도메인 지식 (시스템이 가르쳐주는 것)

### 비즈니스 규칙
- **거래ID 형식**: `YYMMDD-NNN` (예: `260402-001`). 같은 날 N번째 거래.
- **요청ID 형식**: `RQ-YYMMDD-NNN`. 거래ID 앞에 `RQ-` 접두.
- **같은 요청ID 다중 행**: 한 예약에 여러 장비 → 첫 행에만 날짜·예약자, 나머지 행은 장비만. 가용 확인은 첫 행 트리거 1번에 전체 처리.
- **세트 자동 펼침**: 확인요청 F열에 세트명 입력 + H="확인" → 스케줄상세에 구성품 행 자동 추가
- **장비명 매칭**: 카톡 비정형 → `목록` 시트 마스터에서 레벤슈타인 + 퍼지 매칭 (`fuzzyMatchEquipName`)
- **연락처 정규화**: 끝 10자리 비교 (010-1234-5678 / 1012345678 동일 처리)
- **할인유형**: 학생30% / 개인사업자/프리랜서20% / 단골10% / 제휴업체20%. 고객DB(개고생2.0) I열 매칭 → 확인요청 M열 자동 채움.
- **알림톡 발송 시간 규칙**:
  - 반출 12시간 전 / 반납 = 반출 + 3시간
  - 발송 가능: 09:00~21:00 (밖이면 09:00으로 지연)
  - 트리거: 30분마다 `checkGuideAlimtalk`
  - **3회 미만 고객만** 발송 (반복 고객은 안내톡 X)

### 시트 구조 (열 매핑 — off-by-one 주의)

확인요청 (18열):
- A:요청ID  B:반출일  C:반출시간  D:반납일  E:반납시간
- F:장비    G:수량   H:확인    I:결과    J:상세
- K:예약자  L:연락처  M:업체명/할인유형  N:등록  O:등록상태
- P:거래ID  Q:비고    R:추가요청

스케줄상세 (12열):
- A:스케줄ID  B:거래ID  C:장비  D:반출DT  E:반납DT  F:상태
- G:반납완료  H:?  I:?  J:?  K:수량  L:단가
- (상세 컬럼은 부분 추정 — 실 구조와 검증 필요)

계약마스터:
- A:거래ID  B:예약자명  C:연락처  D:업체명  E:반출일  F:반출시간
- G:반납일  H:반납시간  I:회차  J:계약상태  K:할인유형  L:비고

### 시간 처리
- **타임존**: `Asia/Seoul` (appsscript.json 명시)
- **parseDT**: 시간 한 자리(`7:00`) → 두 자리(`07:00`) 패딩 필수 (ISO 형식)
- **대여일수 계산**: 24시간=1일, 6시간 이내 초과=같은 일수, 6시간 초과=+1일
  - 30시간=1일, 31시간=2일, 54시간=2일, 55시간=3일

---

## 엣지 케이스 & 알려진 함정

### 코드에 흔적이 남은 함정들
- **시간 셀 LMT 버그**: `baa7fde fix(companion): 시간 셀 LMT 버그 회피 — getDisplayValues 사용` — 셀이 시간 타입일 때 getValue가 LMT(Local Mean Time, 32분 단위 비표준 타임존) 반환. `getDisplayValues`로 회피.
- **장기할인 셀 포맷 자동 전환**: 셀 number format이 percent로 자동전환되어 REGEXEXTRACT 결과가 0이 됨. `setNumberFormat("@")` 텍스트 강제 필수.
- **계약서 시트 유효성**: 계약서 생성 시 `setAllowInvalid` 전체 해제 필수 (CLAUDE.md 명시).
- **AppSheet 폭주**: 거래내역 A열 update를 값 변경 시에만 수행 (`8cf1677`). 모든 행 update하면 AppSheet bot 무한 호출.
- **세트 자기참조**: `2c444da autoExpandSetInSchedule — 빈 구성품/자기참조 행 필터` — 세트 헤더가 자기 자신을 구성품으로 갖는 경우 제외.
- **고아 구성품**: `Q열 [세트]XXX에서 XXX가 현재 세트 헤더에 없는 것만 삭제` (checkAvailability.js:1602)
- **GAS 리다이렉트 처리**: POST 요청은 GAS 리다이렉트 문제로 안 됨 → 모든 외부 호출 GET (`AGENT_GUIDE.md`).

### 운영상 함정
- **메모리/리더기 분실**: 본체와 다른 시점 반납 → 추적 불가. 미해결 운영 이슈. **시스템적 가시화 솔루션 필요** (반출/반납 시점 카운트 강제, 박스 사진 의무화 등).
- **두 맥 동기화 누락**: 한쪽에서 git push 빼먹으면 GAS-git 어긋남. 스크립트로 강제했지만 스크립트 안 돌리면 무용.

---

## 활성 부분 vs 죽은 코드

### 활성 (최근 30일 내 수정·실행 흔적)
- `Code.js` — onEdit/onEditInstallable
- `checkAvailability.js` — 가용확인/등록/대시보드/타임라인/팝빌
- `sheetAPI.js` — 통합 API
- `generatecontract.js` — 계약서 생성
- `companionServer.js`, `companionValidator.js`, `companionSidebar.html` — 동행 모드 (2026-05-02 신규 통합)
- `villageAiClient.js` — village-ai 호출 래퍼
- `dashboard.html` / `timeline.html` / `requestManage.html` — 운영 페이지
- `docs/*.html` — GitHub Pages 운영 사본
- `Manual.html` — 업무 매뉴얼 (시나리오 탭 구조 — `68e0f99`)
- `scripts/*.sh` — 두 맥 워크플로우 (2026-05-02 신규)

### 정체/축소
- `setupSchedule.js` (1줄), `createManual.js` (1줄) — 거의 비어있음. 초기 세팅 후 본문 다른 파일로 이동했거나 폐기 후보.
- 디버그 함수 (`debugCheckAvailForSelected`, `forceRerunCheckAvailForSelected`) — 메뉴에 노출. 운영 환경에서 우발 실행 위험.

### 죽음 (커밋에서 제거 흔적)
- 확인요청 입력 웹폼 (`854a595 확인요청 입력 웹폼 제거 (디스패치 에이전트로 대체)`)
- 사진 캡처 OCR (`673290b ... + OCR 코드 롤백`)
- 메뉴 4개 항목 (`9b40fa9 메뉴 정리: 사용하지 않는 4개 항목 제거`)

---

## 의존성 트리

### 외부 서비스 (런타임 필수)
- **Google Apps Script** (호스팅·런타임)
- **Google Sheets** (데이터 저장)
- **Google Drive** (계약서 파일)
- **village-ai** (https://village-ai.vercel.app, `/api/advise-booking`)
- **팝빌** (auth.linkhub.co.kr / popbill.linkhub.co.kr) — 알림톡
- **개고생2.0** (별도 AppSheet/시트 — `개고생2_URL`)
- **GitHub Pages** (`village6k-cpu.github.io/my-gas-project2/`)

### 라이브러리/프레임워크
- 없음 (`appsscript.json: dependencies: {}`)
- 순수 GAS V8 런타임 + UrlFetchApp + DriveApp + SpreadsheetApp + CacheService

### 본인의 다른 시스템과의 연결
- `[[gaegoseng-2-0]]` (개고생2.0) — 거래내역·고객DB 양방향
- `[[village-ai]]` — 등록 검증 (Vercel)
- `[[two-mac-workflow]]` — 작업 동기화

### 인프라
- 두 맥 (사장 데스크탑 + 노트북)
- iCloud Obsidian (이 위키)
- GitHub (`village6k-cpu/my-gas-project2`)

---

## 미해결 질문 / TODO

### 운영적 (사용자가 제기한 미해결)
- **메모리/리더기 분실 추적 시스템 부재**. 언제·어디서 사라졌는지 모르는 상태. 우선순위는 *분실 방지*가 아니라 *분실 시점 가시화*.
  - 후보 솔루션: 반출/반납 폼에 메모리·리더기 카운트 강제, 박스 사진 1장 의무
  - 도입 전: 측정 지표 정의 (분실율 / 발견 시점 분포)
- **인수인계 연속성 부재**: 오전 직원 → 사장 → 무직원 시간대 인수인계가 시스템에 잡히지 않음.

### 코드적 TODO
- 디버그 함수 메뉴 노출 — 운영용 메뉴와 분리 필요
- `setupSchedule.js`, `createManual.js` 정리 (1줄 짜리)
- 스케줄상세 컬럼 G~J 정확한 의미 (이 위키에서 추정만 함 — 실 구조 검증 필요)
- 백업 정책 부재 (드라이브 계약서 파일·시트 자체)
- 디스패치 에이전트(LLM)의 대화 로그 저장·감사 부재

---

## 케이스 스터디

### Case 1: 6,695줄이 GAS에만 있고 git에는 없던 사고 (2026-05-02)
**상황**: 두 맥 오가며 작업 중, 다른 맥에서 `clasp push`만 하고 `git push`를 빼먹음. 사용자가 다른 맥에서 작업 시작하려 `clasp pull` → 19개 파일 수정 + 4개 신규(`companionServer.js`, `companionSidebar.html`, `companionValidator.js`, `villageAiClient.js`) 발견. **다른 맥에서 한 달 분량 작업이 git에 없는 상태**.

**대응**:
1. 일단 현재 GAS 상태를 1개 commit으로 박제 (`d482e27`)
2. 원격이 21개 커밋 앞서있어 `--no-rebase` 머지 (rebase는 6,695줄 재적용 → 충돌 폭발)
3. 머지 결과: CLAUDE.md 31줄 + companion-deploy.md 39줄만 차이. 코드 본체는 100% GAS=원격 일치 (deploy=push 했기 때문)
4. 근본 원인 처방: `scripts/startwork.sh` / `endwork.sh` 도입 → CLAUDE.md에 강제 워크플로우 명시 (PR #1)

**교훈**:
- `clasp push`는 GAS만 갱신. `git push`는 별도 작업. 둘 다 안 하면 한쪽이 진실 원천이 됨.
- 두 맥 환경에서 사람의 꼼꼼함에 의존 = 반드시 빠짐. 스크립트로 강제해야 함.
- `rebase`로 큰 디프 재적용 시 충돌 폭발. 머지가 안전.
- **GAS의 deployed 상태가 실질적인 source of truth임을 인정해야 함**. clasp pull로 일단 박제 후 git에 진입.

### Case 2: 장기할인 미적용 (커밋 03f0e5b, 91eb1bb)
**상황**: 계약서 C45에 `setValue("0.1")` 했는데 셀 number format이 percent로 자동전환되어 `0.1` → `10%`로 표시됐고, H46의 `REGEXEXTRACT(C45, "\d+")`가 "10%"의 첫 숫자 "1"이 아니라 0.1 내부 표현 "0"을 추출 → 할인 0% 처리.

**대응**: 텍스트 포맷 강제 (`setNumberFormat("@")`).

**교훈**: 시트 셀 데이터 타입이 setValue 시점에 자동 전환됨. 텍스트로 다룰 거면 명시적으로 강제.

### Case 3: 동행 모드 통합 (2026-05-02 d482e27)
**상황**: AI 검증 + 사이드바 + 트리거를 한꺼번에 통합. companion 관련 4개 신규 파일 + checkAvailability.js +2,905줄.

**구조 원칙**: village-ai (외부 검증) ↔ companionValidator (로컬 검증) ↔ onEditInstallable_companion (트리거) — 책임 분리. AI 실패 시 warn으로 fallback (block 안 시킴).

---

## 운영 참고 (volatile)

### 서비스 위치
- GAS 프로젝트: scriptId `1MbjcaQygxXn-0zHoYnpmuVKGyQCOLaUwEYNQurRzRJ9tw_6d7-33ZTVh`
- 웹앱 URL (deployment ID): `AKfycbyRff4-lLXmne-iPIEf87x4-CH_5wb-Uv5dCGymELLrpiKluhg2gDdLdVP4Y0MmxnnT`
- 페이지 URL: `https://village6k-cpu.github.io/my-gas-project2/{timeline,dashboard,manage,index}.html`

### 시작/중지/배포
- 모든 동작은 GAS에서 자동. 서비스 "중지"는 의미 없음 (이벤트 기반).
- 배포: `scripts/endwork.sh "변경 요약"` (clasp push + clasp deploy + git push)
- 동기화 진단: `scripts/synccheck.sh` (읽기 전용)
- 작업 시작: `scripts/startwork.sh`

### 로그 경로
- GAS 편집기 `실행` 탭 (StackDriver) — `appsscript.json: exceptionLogging: STACKDRIVER`
- `Logger.log` 출력은 GAS 편집기에서만 조회

### API 키 위치 (값 X — 위치만)
- `API_KEY` (sheetAPI.js 하드코딩) — 코드 노출 (`village2026`)
- 스크립트 속성 (GAS 편집기 → 프로젝트 설정 → 스크립트 속성):
  - `POPBILL_LINK_ID`, `POPBILL_SECRET_KEY`, `POPBILL_CORP_NUM`, `POPBILL_SENDER_NUM`
  - `CONTRACT_TEMPLATE_ID`, `CONTRACT_FOLDER_ID`
  - `개고생2_URL`
  - `VILLAGE_AI_URL`
  - `WEB_APP_URL` (선택)

실제 명령어/코드는 git/스크립트가 보존. 여긴 위치만.

---

## 발견된 위험 신호

### 보안 (긴급)
- **API_KEY 코드 하드코딩**: `sheetAPI.js:24`에 `const API_KEY = "village2026"` 평문. GitHub 공개 레포에 노출 시 무방비. → 스크립트 속성으로 이동 필요.
- **웹앱 access = ANYONE_ANONYMOUS**: 키만 알면 누구든 호출. 키가 단순 단어 + 코드 노출 = 사실상 미인증.
- **AGENT_GUIDE.md / CLAUDE.md에 평문 키 노출**: 동일 키 평문.

### 데이터 보존
- **계약서 드라이브 파일 백업 부재**: 폴더 권한 사고 / 실수 삭제 시 복구 어려움.
- **시트 자체 백업 정책 부재**: 구글 자체 버전 기록은 짧음. 정기 export 없음.
- **`d482e27` 사고처럼 git-GAS 어긋남 가능성** — 이번엔 스크립트로 처방.

### 운영
- **디버그 함수 메뉴 노출** (`forceRerunCheckAvailForSelected`, `debugCheckAvailForSelected`) — 잘못 누르면 데이터 변경
- **단일 파일 비대화** — `checkAvailability.js` 4,432줄. 도메인 분리(가용/등록/알림톡/대시보드/타임라인) 안 됨.
- **장기할인 같은 셀 포맷 함정**이 다른 곳에도 잠복 가능 — 회차 자동계산, 단가 계산 등 percent/숫자 자동 변환 영역

### 비기능적
- 단위 테스트 0건. 회귀는 사람이 직접 시트 보고 확인.
- TypeScript / 스키마 검증 0건 — 시트 컬럼 변경 시 코드 무방비

---

## 다른 세션에 컨텍스트 전달

| 새 세션의 질문 | 우선 읽을 섹션 |
|---|---|
| "이 시스템 뭐 하는 거?" | 시스템 정체성 + 아키텍처 |
| "어떤 외부 서비스 쓰지?" | 의존성 트리 + 운영 참고 |
| "왜 이렇게 짰지?" | 결정 로그 |
| "비즈니스 규칙 알려줘" | 도메인 지식 |
| "버그 의심됨" | 엣지 케이스 & 함정 + 케이스 스터디 |
| "변경하려면 어디 건드려야?" | 활성 부분 vs 죽은 코드 + 아키텍처 |
| "보안 점검" | 발견된 위험 신호 |
| "다음 작업 뭐 할까?" | 미해결 질문 / TODO |
