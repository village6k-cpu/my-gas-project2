# 빌리지 운영 시스템 종합 맵 (2026-06-08)

> Claude 8-에이전트 병렬 분석 산출물. 신규 통합 앱 설계의 기준 문서.

# 빌리지(빌) 카메라/렌즈 렌탈샵 운영 시스템 종합 맵

> 한 줄 요약: 카카오톡 문의를 AI 코워크 봇이 받아 구글시트(GAS)에 입력하고, 사장이 가용확인→승인→등록→계약서 생성→반출/반납을 결재하는 상태머신. 백엔드는 9,933줄 단일 GAS 파일이 핵심이며, 신규 자동화는 Supabase+Vercel+Hermes로 GAS 바깥으로 이전 중.

## 비즈니스 도메인 & 액터

빌리지는 카메라/렌즈 등 영상장비 렌탈샵으로, 단품과 "세트"(구성품 묶음)를 시간 단위(반출일시~반납일시)로 대여한다. 모든 데이터의 source of truth는 **빌리지 메인 구글 스프레드시트 + GAS**이고, 회계/세무는 외부 **개고생2.0** 스프레드시트가 마스터다.

| 액터 | 역할 | 코드 근거 |
|---|---|---|
| **고객** | 카카오톡으로 반출/반납 일시 + 장비명 문의. 시스템 직접 접근 없음 | `AGENT_GUIDE.md:1-16` |
| **디스패치 에이전트(코워크 봇 / Hermes)** | 카톡 문의 파싱 → `insertAndCheckRequest`로 시트 입력, 결과 카톡 직접 응대. 알림톡 대체 | `AGENT_GUIDE.md` 전체, `worker.mjs:629` |
| **사장(운영자)=최재형** | 가용확인 검토 후 발송 승인 / 등록·거절·보류 결정, 반출/반납 검수, 단골·제휴 할인 수동 지정 | `checkAvailability.js:7252`, `5992-6010`, `6158` |
| **직원** | 별도 권한 모델 없음. 실사 입력자만 이메일로 기록(`Session.getActiveUser`) | `Code.js:22-33` — ⚠️ 직원 역할 부재 |
| **개고생2.0 외부 웹앱** | 거래내역·고객DB·발행처DB 마스터. 등록 시 거래ID·연락처·계약서링크 동기화 | `checkAvailability.js:7954-8167` |
| **팝빌 / 카카오 알림톡** | 반출 12h 전·반납 3h 후 안내톡만 자동발송(3회 미만 고객). 가용확인/등록완료 알림톡은 비활성화 | `checkAvailability.js:9096-9217`, `8199` |

**핵심 비즈니스 규칙(코드 검증):**
- **장기할인 7티어**(`getLongTermDiscountRate:877`): 1일0%/2일10%/3~5일20%/6~9일35%/10~14일40%/15~19일45%/20일+50%. 일수=`Math.ceil((총시간-6)/24)`로 6시간 초과분만 +1일.
- **할인유형(곱셈 합산)**: 학생 사전30% / 개사프 사전20% / 단골 +추가10% / 제휴 +추가20%. 학생30%+장기20% → 0.7×0.8=56% 결제. 단골/제휴는 파서가 못 넣고 사장이 수동 지정(`generatecontract.js:317-353`, `_normalizeDiscountType:6300`).
- **중복 방지 3중**: 확인요청 단계(`_findDuplicateConfirmRequest_:6361`), 등록완료 충돌(`checkDuplicateRequest:8651`), 동시클릭 방지(O열 재확인 `7837`). 키=예약자명+반출일+장비목록 부분포함 매칭.
- **단가 단일 소스 = 세트마스터 G열**(`findSetPrice:8755`). 장비마스터 L열 단가는 레거시.

## 예약 생애주기(상태머신)

각 전이의 트리거는 **'확인요청' 시트 셀 값**(onEdit `handleScheduleEdit:5972`) 또는 **GET API `action`**(`doScheduleAction sheetAPI.js:653`)이며 둘 다 같은 함수로 수렴한다.

```
[S0] 카톡 문의 (고객→봇)
   → 봇이 장비명을 목록 시트로 퍼지매칭 (action=search, fuzzyMatchEquipName)

[S1] 확인요청 접수
   트리거: action=run&func=insertAndCheckRequest 또는 사장 B열(반출일) 입력
   _insertAndCheckRequest(:6462): RQ-YYMMDD-NNN 채번, 18열 기록, 연락처 단일매칭 자동조회

[S2] 가용확인 (자동, S1 연속)
   트리거: H열="확인" 또는 action=확인 또는 insertAndCheck 내부 자동
   processByReqID→_processByReqID(:6802): LockService 직렬화
   세트는 세트마스터 기준 expandSetRows로 전개, 단품은 checkSingleRowWithData(:7368)
   → sweep-line 동시사용 피크 계산 → I열 결과(✅가용/⚠️부족·겹침/❌가용0)
   ⚠️ 가용확인 알림톡은 여기서 발송 안 함

[S3] 발송 승인 (사장 결재)
   트리거: H열="발송승인" 또는 action=발송승인
   sendAvailAlimtalk = 현재 no-op(:7252). 사실상 "봇아 고객에게 결과 카톡 보내라" 게이트

[S4-S5] 등록 결정 → 실행 (사장 결재)
   N열: 거절→rejectByReqID(O="거절" 빨강) / 보류→holdByReqID(노랑) / 등록→registerByReqID(:7716)
   registerByReqID(약 500줄, 최대 함수):
     - 거래ID YYMMDD-NNN 채번(로컬+개고생2.0 양쪽 최대번호)
     - 동일 예약자+일자 기존 거래 시 합치기(merge) 모드
     - 계약마스터 12열(상태="예약") + 스케줄상세 세트헤더/구성품/단품(상태="대기")
     - 개고생2.0 거래내역·고객DB 입력 + 계약서 자동생성(generateContractFile)
     - 대시보드·타임라인 캐시 무효화 + 등록큐 순차처리

[S6] 수정 분기 (등록 후)
   N열: 추가→addEquipmentToContract / 삭제→removeEquipmentFromContract
       / 날짜변경→changeDatesForContract(스케줄 수정 + 계약서 재생성)

[S7] 반출/반납 (사장 수동, 대시보드)
   반출검수: toggleSetupDone(tid) — PropertiesService 플래그(:2618)
   반납검수: toggleReturnDone(tid) → 계약마스터 상태 갱신(:2641)
   안내톡: 30분 주기 checkGuideAlimtalk — 반출 12h전/반출+3h후, 3회 미만 고객만
```

**사장이 아직 수동으로 하는 7단계**: ①발송 승인 ②등록/거절/보류 ③단골·제휴 할인 지정 ④동명이인 연락처 입력 ⑤세트 구성품 모델 선택(F열 드롭다운) ⑥반출/반납 검수 토글 ⑦계약서 품목·결제 확인.

## 데이터 모델

**3종 스프레드시트 + 동적 계약서**로 구성. TypeScript/스키마 검증 전무, 컬럼이 정수 인덱스로 하드코딩(`allData[i][12]`, `data[i][11]`).

**빌리지 메인 SS (핵심 엔티티):**

| 시트 | 구조 | 핵심 컬럼 / PK·FK |
|---|---|---|
| **확인요청** | A~R **18열** | A=요청ID(`RQ-YYMMDD-NNN` PK), B~E=반출/반납 일시, F=장비/세트명, H=확인(트리거), I/J=결과/상세(파생), K/L=예약자/연락처, M=업체명→**할인유형**(의미변경됨), N=등록(트리거), O=등록상태, **P=거래ID(FK)** |
| **스케줄상세** | A~M **13열** ⚠️(위키는 12열로 오기) | A=스케줄ID(`{거래ID}-NN`), **B=거래ID(FK)**, C=세트명, D=장비명(FK), E=수량, F~I=반출/반납 일시, J=상태(기본"대기"), K=예비(빈칸), L=단가(세트마스터 복제), **M=예약자명**(merge 키) |
| **계약마스터** | A~L **12열** | **A=거래ID(PK)**, B/C=예약자/연락처, D=업체명, E~H=일시, I=회차, J=계약상태(예약→반납완료/취소), K=할인유형, L=비고 |
| **장비마스터** | A~M | B=장비ID(PK `CAM-001`), C=카테고리, D=장비명(FK), **E=총보유수량**(가용 기준), F/G/H=가용/대여중/정비중, L=단가(레거시), M=장비사진 |
| **세트마스터** | A~G | A=세트/장비명(PK), B=구성장비명, C=수량, E=대체장비, F=가용체크, **G=단가(전 시스템 단일 가격 출처)** |
| 목록 | 파생 | 세트마스터 A열 중복제거·정렬 → 확인요청 F열 드롭다운(`refreshEquipmentList`) |
| 실사 기록 / 회차 이력 / 신규장비 추가 | — | 실사는 회차마다 `insertColumnBefore(13)`로 `YYMMDD_이메일` 열 **무한 추가**(와이드 시트, `Code.js:1309`) |

**개고생2.0 외부 SS (양방향 연동):**
- **거래내역** (A~N): C=계약서링크(빌리지 입력), **E=거래ID(FK)**, J/K/L/M=결제수단/증빙/발행/입금 — 2026-04-23 재배치(D→E, M→C)로 하드코딩 인덱스 산재.
- **고객DB** (A~I): A=예약자ID(휴대폰), B=성함, C=누적이용, I=할인유형 — ⚠️ C열 의미가 코드 두 곳에서 상충("소속" vs "누적이용").

**계약서(동적 복제본) + 내부 '마스터' 시트**: 거래별 템플릿 복사. 단가 출처가 채워진 줄=스케줄상세 L열, 빈 줄=내부 마스터 VLOOKUP으로 **이원화**. 즉 단가 1건 변경에 세트마스터 G → 스케줄상세 L → 계약서 마스터 → VLOOKUP 다단계 수동 동기화 필요.

**관계 요약**: 확인요청.P → 계약마스터.A → 스케줄상세.B(1:N) / 계약마스터.A → 거래내역.E(개고생2.0) / 스케줄상세.C·D → 세트마스터·장비마스터 / 실사.B → 장비마스터.B.

## API

`sheetAPI.js`(1,479줄)는 **단일 웹앱 엔드포인트**. `doGet`/`doPost` → `handleRequest` → `key=village2026` 인증 → 50+ action 단일 switch 분기.

**4개 API 계열:**
1. **Sheet 범용**(8종): `sheets/info/read/write/append/update/search/run`. write/append/update는 `WRITABLE_SHEETS=["확인요청","스케줄상세","신규장비 추가","실사 기록"]` 화이트리스트(`:26`). read/search는 시트 제한 없음(전 시트 읽기 가능).
2. **Schedule 관리**(7종): `list/scan/확인/등록/보류/거절/발송승인` → `doScheduleAction`이 확인요청 첫 매칭 행을 찾아 `processByReqID`/`registerByReqID` 등 호출.
3. **데이터 API**: `timeline`/`dashboard`/`operations`(유일하게 이 파일 내 구현 `getOperationsData_`, CacheService `operations_v2_{날짜}` TTL 300s) + Dashboard 계열 30+ action(조회/토글/장비편집/증빙/리스크/AI파싱).
4. **페이지 라우팅**: `?page=timeline|dashboard|manage` → HTML 서빙. `XFrameOptionsMode.ALLOWALL`로 GitHub Pages iframe 임베드.

**run action**: 28개 함수 화이트리스트(insertAndCheckRequest, deleteRequest, regenerateContractById, restoreCancelledContractsByIds, setupEquipmentRiskBackendConfig 등). 인자는 `params.args`(JSON)로 전달.

**구조적 약점**: ①API_KEY 평문 하드코딩(`:23`) + 클라이언트 노출 → 사실상 공개. ②`?page=` 무인증 → dashboard INITIAL_DATA(예약/매출성 데이터) 무인증 노출. ③`jsonResponse`의 statusCode 무시 → 모든 응답 HTTP 200, 예외 시 `error.stack` 노출. ④거의 모든 핸들러가 매 호출 `getActiveSpreadsheet().getSheetByName()`로 시트 새로 열고 lastRow 전체 풀스캔.

## 웹앱

**프레임워크 0** — 6개 화면 전부 바닐라 JS + 문자열 템플릿 + `innerHTML` 통짜 주입. 빌드/번들/코드분할 전무. CSS·JS·마크업 100% 인라인. **같은 앱이 두 벌**(루트=`google.script.run` GAS 서빙 / `docs/`=`API_URL` fetch GitHub Pages 서빙)로 존재하며 이미 분기 드리프트(timeline 루트 1,052줄 vs docs 2,714줄).

| 화면 | 크기 | 특징 / 성능 이슈 |
|---|---|---|
| **오늘일정 대시보드** (`dashboard.html`) | 174~182KB / 5,154줄 | 반출/반납 카드, 품목 체크, 장비 추가·삭제, 사진 업로드(base64 인라인), 메모, 글로벌 검색. localStorage SWR 캐시. **변이마다** `queueDashboardSilentRefresh`로 5~7초 후 전체 GAS 재조회+`innerHTML` 통짜 재렌더 → 깜빡임·포커스 유실. `html+=` 112회 |
| **스케줄 타임라인** (`timeline.html`/`timelineMobile`) | 35~88KB | vis-timeline@7.7.3 unpkg **런타임 블로킹 로드**(SRI 없음). 필터/드래그/검색마다 `timeline.destroy()→new Timeline()` 풀 리빌드 jank. docs판은 60초 무음 폴링 |
| **확인요청 관리** (`requestManage`/`manage.html`) | 24KB | 가용성(✅/⚠/❌) 카드, 선택 등록·확인·보류·거절. **캐시 0** → 매 진입 빈 화면. 모든 액션 개별 GET 왕복 + `confirm()`/`alert()` 네이티브 다이얼로그 |
| **카톡 예약입력(AI)** (`docs/request.html`) | 69KB | 카톡 텍스트→AI 예약 파싱, 실패 시 정규식 폴백(장비 별칭 38패턴 하드코딩). docs 전용 |
| **업무 매뉴얼** (`Manual.html`) | 18KB | 직원용 정적 가이드. 서버 호출 0. 거의 무이슈(@import 폰트만) |
| 진입 허브 (`docs/index.html`) | 2KB | 정적 메뉴 카드. (과업의 "약관동의" 화면은 실재하지 않음) |

**근본 한계**: 백엔드가 GAS 단일 엔드포인트(`AKfycby...exec`)라 콜드스타트·동시성·일일 할당량으로 응답 자체가 수백ms~수초. 프론트 최적화로 못 줄이는 사장 체감 '느림'의 가장 큰 축. HTTP 캐시 헤더·Service Worker·PWA 전무.

## 자동화/외부연동

**핵심 철학: "코드는 판단하지 않고, AI가 브라우저에서 직접 본다"**(AI-first). 4단계 파이프라인:

```
카카오 채널관리자 (Chrome 자동화 프로필 :9223)
  ↓ DOM MutationObserver + top-row polling (의미판단 없음)
Chrome 확장(watcher) → POST 127.0.0.1:8787/events  [감지·dedupe만]
  ↓ roomKey/eventHash dedupe + debounce(60s)
로컬 bridge server.mjs (Node 내장모듈만, zero-dep) → Supabase insert + AI worker spawn
  ↓ stdin JSON job
AI worker worker.mjs (161KB) → Hermes(computer_use)로 카카오 화면 직접 판단
  'hermes chat --yolo -Q -t terminal,computer_use,vision'
  ↓ 결과
Supabase(ai_follow_up_items) ↔ Vercel 대시보드 + Slack(헤이빌리) 작업카드
```

- **GAS 쓰기는 단 하나**(`insertAndCheckRequest` GET), 나머지는 전부 **gviz 읽기전용**. `forbidden_actions`에 `발송승인/등록/run/write/append/send` 명시 금지(`worker.mjs:294`). 안전게이트: `safety_checks` 전부 true + kill switch active일 때만 자동발송.
- **Follow-up 대시보드**(Vercel `apps/follow-up-dashboard`): worker 결과 카드의 상태판. Supabase `ai_follow_up_items`를 서버측 `/api/follow-ups`로 읽음(서비스롤 키 브라우저 비노출), 의미 기반 dedup 엔진 보유. `/api/operations`는 GAS를 프록시. **Slack이 1차 작업함, 대시보드는 상태판**.

**호스팅 맵:**

| 컴포넌트 | 호스팅 | 역할 |
|---|---|---|
| 기존 렌탈 백엔드(Code/checkAvailability/sheetAPI/generatecontract) | **GAS + Sheets** | source of truth |
| 기존 웹폼(docs/) | **GitHub Pages** | 프론트 직접 서빙 |
| Chrome 확장 + bridge + Hermes worker | **사장 맥** (127.0.0.1만) | 카카오 감지·판단·실행 |
| queue / 후속조치 카드 DB | **Supabase** | RLS on, 서비스롤만 |
| Follow-up 대시보드 + Slack API + village-ai RAG | **Vercel** | 상태판 / Slack fallback / RAG |
| 헤이빌리 봇 | **Slack(Socket Mode)** | 1차 작업함 |

**탈-GAS 신호 명확**: GAS는 읽기전용으로 격하, 신규 데이터=Supabase(Postgres), 신규 UI/API=Vercel(Node ESM), AI=Hermes/computer_use, 작업함=Slack. legacy 서버 챗봇은 "reference only 복사금지"로 격하.

## 현재 기술 스택 현황

| 레이어 | 현재 스택 | 상태 |
|---|---|---|
| 데이터 저장 | 구글 시트(빌리지 메인 + 개고생2.0) | DB·인덱스 겸용, 풀스캔 패턴, 단일 진실원본 부재 |
| 백엔드 로직 | **GAS V8** — `checkAvailability.js`(377KB/9,933줄/~280함수), `Code.js`(63KB), `sheetAPI.js`(56KB), `generatecontract.js`(53KB), `sheetProtection.js` | 모놀리식, 전역 스코프 공유, executeAs=USER_DEPLOYING + ANYONE_ANONYMOUS |
| 프론트엔드 | 바닐라 JS 인라인 HTML × 6, 루트/docs 이중화 | 프레임워크/빌드 없음, 분기 드리프트 |
| 외부연동 | 개고생2.0(시트), 팝빌 알림톡, Claude/Hermes 파서, 장비리스크 백엔드 | UrlFetchApp 6곳, 동기 호출 |
| 신규 자동화 | Supabase + Vercel + 로컬 Node(zero-dep) + Hermes + Slack | GAS 바깥에 신설, 사장 맥 단일 의존 |
| 운영/협업 | clasp(GAS 동기화), startwork/endwork 스크립트, 29개 정적 테스트(`test/`), 멀티세션 ledger | 두 맥+Claude+Codex 오감, 동기화 누락 시 작업 유실 위험 |

**가용성 알고리즘 핵심(전 시스템 공통)**: `장비명+요청수량+요청기간`에 대해 ①겹침 예약 수집(`startDT<reqEnd && endDT>reqStart`, "반납완료"/"취소" 제외) ②요청기간 내 변곡점마다 동시사용 qty 합의 **피크(maxConcurrent)** 계산(sweep-line) ③`가용 = 총보유 - maxConcurrent ≥ 요청수량` 판정. 이 sweep-line 블록이 **6곳에 복붙 중복**(`:2454,:4781,:5173,:7344,:7431,:8552`) — 단일 헬퍼 미추출이 최대 유지보수 리스크.

**문서-코드 불일치 다수**(신규 작업자 오판 위험): 알림톡 자동발송 여부, 발송시간 08-22 vs 09-21, 파일명 `_v3.gs` vs `checkAvailability.js`, 스케줄상세 13열 vs 위키 12열, 고객DB C열 의미 상충.


---

## 성능·구조 문제 랭킹

### [CRITICAL] Google Sheets를 DB로 쓰는 GAS 아키텍처의 누적 비용 — 모든 ID 조회(계약마스터/세트마스터/장비마스터)가 시트 풀스캔(getValues 88회), 단일 doGet 라우터에 대시보드 빌드를 동기 임베드, executeAs=USER_DEPLOYING 콜드스타트·6분 한도·동시성 한계 상속. 사장 체감 '느림'의 근본 원인이며 프론트 최적화로 못 줄임
- **서브시스템**: 백엔드/데이터(GAS+Sheets)
- **근본원인**: DB·인덱스가 없고 시트가 그 역할을 겸함. 데이터 증가에 선형 악화하며 GAS 런타임 자체의 콜드스타트/스로틀이 구조적으로 남는다

### [CRITICAL] 전역 캐시 무효화로 인한 풀 리빌드 폭발 — 시트 셀 1개만 편집해도 invalidateTimelineCache/DashboardCache가 ScriptProperties 버전을 통째로 갱신해 전 날짜·전 사용자의 다음 첫 요청이 스케줄상세 전체 풀스캔을 떠안음. '방금 빨랐는데 갑자기 느림'의 정체
- **서브시스템**: 백엔드 캐시(checkAvailability.js)
- **근본원인**: 부분/범위 무효화 없이 버전 하나로 전 범위 캐시를 한꺼번에 죽이는 전역 무효화 설계(Code.js:1083-1254, checkAvailability.js:754)

### [CRITICAL] API_KEY 'village2026' 평문 하드코딩 + 클라이언트 노출 + 키 회전 불가. ?page= 라우팅 무인증으로 dashboard INITIAL_DATA(예약/매출성 데이터) 무인증 노출. run action으로 deleteRequest/restoreCancelledContractsByIds/setupEquipmentRiskBackendConfig 등 파괴적·설정변경 함수가 단일 key만으로 실행 가능
- **서브시스템**: API/보안(sheetAPI.js)
- **근본원인**: 읽기/쓰기/파괴적 실행이 모두 동일 단일 공유키로 통제되고 역할 분리·감사 로그·인증 게이트가 없음(sheetAPI.js:23,39-104,878-914)

### [HIGH] 계약서 자동생성이 makeCopy로 스프레드시트를 통째 복사 → 건당 약 30초. 등록 자동생성(autoGenerateContract)마다 삭제+복사+재오픈+flush 반복으로 사용자 대기 길고 대량 처리 불가. 게다가 새 시트 전체 그리드 DataValidation을 셀 단위 copy().build()로 재작성
- **서브시스템**: 계약서 생성(generatecontract.js)
- **근본원인**: 편집 가능 Sheets 사본을 매번 복제하는 방식. PDF 고정출력/플레이스홀더 치환이 아니라 템플릿 전체 복사+셀 단위 검증 해제에 의존(generatecontract.js:158,181-190)

### [HIGH] checkAvailability.js 9,933줄 단일 파일에 7개 도메인(가용성/스케줄·계약 CRUD/대시보드·타임라인 빌더/알림톡/중복체크/장비리스크/LLM파서)이 혼재. registerByReqID 단일 500줄, 가용성 sweep-line이 6곳 복붙 중복, GAS 전역 스코프 공유로 헬퍼 이름 충돌(flushRange_ 중복 정의)
- **서브시스템**: 백엔드 유지보수(checkAvailability.js)
- **근본원인**: 모듈 경계·ES 모듈 부재. 책임 분리 없이 한 파일에 누적되어 변경 시 충돌·회귀 위험 극대(AGENTS.md도 핫스팟 명시)

### [HIGH] 프론트 변이 후 통짜 재렌더 — 대시보드·확인요청 관리가 체크/수정/액션 한 번마다 전체 데이터를 GAS 재조회하고 container.innerHTML 통짜 교체. 5~7초 뒤 화면 다시 그려지며 스크롤·포커스·체크 상태 흔들림. 타임라인은 필터/드래그마다 destroy→재생성 풀 리빌드 jank
- **서브시스템**: 웹앱 UX(dashboard.html/timeline.html/requestManage.html)
- **근본원인**: 프레임워크/부분 갱신 없이 문자열 템플릿+innerHTML 통짜 주입, 옵티미스틱 UI가 일부만 적용(dashboard.html:3793, timeline.html:552)

### [HIGH] 상태가 시트 셀·셀 배경색·PropertiesService 플래그·외부 개고생2.0 시트에 분산 저장돼 단일 진실원본 부재. 특히 반출/반납 검수 완료가 PropertiesService 플래그로만 관리됨. 등록이 1초 후 시간기반 트리거 + LockService 대기열로 비동기 실행돼 디버깅·재현 어려움
- **서브시스템**: 상태관리(checkAvailability.js/Code.js)
- **근본원인**: 정식 상태 컬럼이 아닌 사이드채널(배경색/Properties/외부시트)에 상태가 흩어짐. 단일 상태 저장소·동기 일관성 모델 부재

### [HIGH] 컬럼 의미가 코드 주석에만 존재하고 시트 헤더와 분리 + 정수 인덱스 하드코딩(allData[i][12], data[i][11]) + 스키마/타입 검증 전무. 확인요청 M(업체명→할인유형), 계약마스터 K/L 스왑, 거래내역 D→E·M→C 재배치가 헤더 아닌 주석으로만 추적. 컬럼 추가/삭제 시 off-by-one 연쇄
- **서브시스템**: 데이터 모델(전 GAS 파일)
- **근본원인**: TypeScript/명명 범위/스키마 정의 부재. 컬럼이 위치 의존 매직넘버라 의미 변경이 코드 전체에 무방비 전파(village-system-raw.md:282, CLAUDE.md 체크리스트)

### [HIGH] 운영 자동화가 사장 맥 단일 장애점에 묶임 — 맥이 꺼지면 확장·bridge·Hermes worker 전부 정지, 새 카카오 이벤트 수집/AI 처리 중단. 카카오 로그인 세션 만료·권한팝업·포커스 문제도 처리 차단. 카카오 DOM 감지는 불안정 class명에 의존해 UI 개편 시 조용히 깨짐
- **서브시스템**: 자동화(tools/kakao-*, ai-browser-worker)
- **근본원인**: computer_use/AppleScript가 본질적으로 로컬 데스크톱을 요구하고 클라우드 상시가동 경로가 없음. DOM 휴리스틱은 카카오 UI에 강결합(ops.md:67-72, content.js:153-164)

### [MEDIUM] 같은 앱이 루트/docs 두 벌로 중복되고 이미 기능이 갈라짐(timeline 1,052 vs 2,714줄, docs가 폴링·장비편집 포함 상위판). 한쪽 수정이 다른 쪽에 반영 안 돼 버그·유지보수 비용 누적
- **서브시스템**: 웹앱 코드중복(root vs docs/)
- **근본원인**: GAS HtmlService 서빙과 GitHub Pages 정적 서빙 두 경로를 별도 사본으로 유지. 단일 소스에서 빌드하는 체계 없음

### [MEDIUM] 가용성 sweep-line 6곳 복붙으로 규칙 변경 시 동시 수정 필요 + 겹침 제외 조건이 '반납완료'/'취소' 하드코딩 문자열에 강결합. 표기 흔들림(공백/'반납 완료')이나 한쪽 누락 시 경로별(확인요청/대시보드/날짜변경/재고스캔) 판정 불일치 → 과소/과대 가용 오판
- **서브시스템**: 가용성 알고리즘(checkAvailability.js)
- **근본원인**: computeMaxConcurrent 단일 헬퍼·상태 enum 상수화 미추출. 알고리즘과 상태 문자열이 흩어져 강결합(checkAvailability.js:7407,4764)

### [MEDIUM] 단가/가격 출처 다중 사본 — 세트마스터 G(소스)→스케줄상세 L→계약서 마스터 시트→VLOOKUP + 장비마스터 L(레거시) 잔존. 단가 1건 변경에 다단계 수동 재동기화. 계약서 할인 계산이 시트 수식(REGEXEXTRACT)에 의존해 디버깅 어렵고, %가 0.1로 자동변환되는 버그를 setNumberFormat('@')로 회피
- **서브시스템**: 데이터 정합성(generatecontract.js/checkAvailability.js)
- **근본원인**: 정규화된 단일 가격 소스+계약시점 스냅샷 정책 부재. 비정규화 사본이 여러 시트에 복제됨(generatecontract.js:330-353,395-443)

### [MEDIUM] 계약서 파일을 ANYONE_WITH_LINK + EDIT(VIEW 아님)로 공유 — 고객 이름·연락처·금액이 링크만 알면 수정까지 가능하게 노출. 개고생2.0 컬럼 재배치(D→E,M→C)가 코드 하드코딩이라 외부 시트 구조 변경 시 잘못된 열 조작 위험. 실패가 catch{} Logger.log로 조용히 삼켜짐
- **서브시스템**: 계약서 보안/관측성(generatecontract.js)
- **근본원인**: 공유 권한이 과도(EDIT)하고 외부 시트 결합이 위치 하드코딩. 정상/오류 경로 모두 무시 패턴이라 운영 실패 사후 추적 곤란(generatecontract.js:374,620-625)

### [MEDIUM] 확인요청 관리·AI 예약입력 화면에 localStorage 캐시 전무 → 매 진입 빈 화면 후 GAS 로딩. 모든 액션 개별 GET 왕복. AI 예약파싱 장비 별칭 38패턴이 HTML에 하드코딩돼 장비 추가 시마다 코드 수정 필요
- **서브시스템**: 웹앱 캐시/유지보수(requestManage.html/request.html)
- **근본원인**: 화면별 캐시 전략 불균일 + 파싱 룰을 코드에 박음(requestManage.html:373, request.html:655-696)

### [MEDIUM] 의미 dedup 로직이 worker.mjs와 api/follow-ups.js 두 곳에 한국어 정규식으로 따로 구현돼 한쪽만 수정 시 dedup 불일치. Slack 액션 경로 이원화(Hermes Socket Mode 실사용 vs Vercel slack-actions 미사용 fallback)로 운영자 혼동. 대시보드 전송 버튼이 127.0.0.1 직호출이라 모바일·외부에서 동작 안 함
- **서브시스템**: 자동화 dedup/Slack(ai-browser-worker, follow-up-dashboard)
- **근본원인**: 공유 로직 모듈화 없이 클라이언트/서버 중복 구현, 활성 경로와 fallback 경로 공존(worker.mjs:640, follow-ups.js:63-329, index.html:1027)

### [LOW] 진단/일회성/레거시 함수가 운영 로직과 섞임 — combineDT 잔재, inspect*/fix*/diag*/debug*/force* 다수, 업체명→할인유형 임시 fallback. 실사 기록은 회차마다 열을 무한 추가하는 와이드 시트라 데이터 증가 시 조회·조인 비효율
- **서브시스템**: 죽은코드/스키마(checkAvailability.js/Code.js)
- **근본원인**: 운영/진단/레거시 코드 분리 부재 + 정규화된 롱 테이블 대신 와이드 이력 시트 사용(checkAvailability.js:8694, Code.js:1309)


---

## 재구축 분해안 (빌드 순서)

1. **공유 데이터 모델 & 스키마 (Schema/Types Core)** — 확인요청·스케줄상세·계약마스터·장비마스터·세트마스터·거래·고객·할인유형을 TypeScript 타입/DB 스키마로 정규화 정의. 거래ID/요청ID/스케줄ID 체계, 상태 enum(예약/대기/반납완료/취소), 컬럼 의미를 코드 주석이 아닌 단일 스키마로 확정. 현재 위치 하드코딩(allData[i][12])·문서 불일치(스케줄상세 13열, 고객DB C열)를 여기서 해소
2. **데이터 저장소 & 마이그레이션 (DB Layer)** — Sheets-as-DB를 정규화 DB(Postgres/Supabase, 이미 신규 스택)로 이전하고 거래ID·날짜·장비 인덱스 구성. 풀스캔→인덱스 쿼리, 전역 캐시 무효화→행 단위 캐시 패치. 기존 시트는 읽기전용 미러 또는 마이그레이션 소스로 둘지 결정. 개고생2.0(회계) 연동 인터페이스 정의
3. **가용성 엔진 (Availability Core)** — 6곳 복붙된 sweep-line을 단일 computeMaxConcurrent(overlaps, reqStart, reqEnd)로 추출. 세트 전개(가용체크=Y, 대체장비), 경계 겹침 정책, 점유 상태 enum을 한 곳에서 결정. 확인요청 검증/대시보드 추가/날짜변경/재고스캔이 모두 이 엔진을 호출해 판정 일관성 보장
4. **예약 도메인 서비스 (Reservation Lifecycle)** — 상태머신(접수→가용확인→승인→등록→수정→반출/반납)을 명시적 서비스로 구현. registerByReqID 500줄 분해, 거래ID 채번, merge 모드, 중복방지 3중, 할인 계산(장기 7티어×할인유형 곱셈)을 코드에서 확정. 반출/반납 검수를 PropertiesService 플래그가 아닌 정식 상태 컬럼으로 일원화
5. **계약서 생성 서비스 (Contract Generation)** — makeCopy(30초) 제거 — PDF 고정출력 또는 플레이스홀더 토큰({{예약자명}}) 치환으로 전환. 할인/금액을 시트 수식(REGEXEXTRACT)이 아닌 코드에서 확정해 값으로 박음. 공유 권한 EDIT→VIEW/만료링크. 비동기 큐로 등록 플로우와 분리
6. **통합 API 게이트웨이 (API & Auth)** — 단일 village2026 키→역할 분리(읽기/쓰기/관리자) + 사용자별 인증. 표준 HTTP 상태코드·CORS·stack 비노출. run action 28개를 외부 공개/내부전용으로 분류. ?page= 무인증 노출 차단. Vercel 서버리스(Node ESM)로 doGet/doPost 대체
7. **통합 프론트엔드 SPA (Unified Web App)** — 대시보드·타임라인·확인요청 관리·예약입력을 단일 SPA(프레임워크+부분 갱신+옵티미스틱 UI)로 통합. 루트/docs 이중화 제거, 174KB 인라인→코드분할/캐싱. 변이 후 통짜 재렌더 대신 델타 반영. 타임라인 풀 리빌드 대신 증분 업데이트. 모바일 우선
8. **카카오 자동화 & AI 코워크 (Automation Layer)** — Chrome 확장+bridge+Hermes worker+Supabase 처리판+Slack 작업함을 하나의 설치형/운영 가능 제품으로 정리. worker/follow-ups 중복 dedup 로직 공유 모듈화. 사장 맥 단일 장애점 완화(클라우드 상시가동 vs 로컬-퍼스트 결정). 자동발송 안전게이트·kill switch 유지. 예약 도메인 서비스의 쓰기 API만 호출
9. **외부 연동 & 알림 (Integrations & Notifications)** — 개고생2.0(회계), 팝빌 알림톡, 장비리스크 백엔드, LLM 파서를 어댑터 패턴으로 격리. 위치 하드코딩(D→E,M→C) 제거. 알림톡 자동발송(가용확인/등록완료) 재활성 여부 결정. 동기 UrlFetch를 비동기 큐로 분리해 등록 속도 보호


---

## 미커버 영역 (후속 분석 필요)

- sheetProtection.js — 장비마스터/실사 기록 등 시트 수식 컬럼 보호(protect/setUnprotectedRanges) 로직. 8개 보고 어디에도 분석되지 않음. 신규 앱에서 컬럼 권한·수식 보호를 어떻게 대체할지 영향
- Code.js의 onEditInstallable 외 다수 유틸 함수군 — handleContractMasterStatusEdit_(계약 취소 시 스케줄/거래내역 삭제), propagateContractDates(계약마스터 E~I 수정 시 스케줄·거래내역 전파), previewContractTimeFix/applyContractTimeFix/scanCorruptedContractTimes(1899 타임존 버그 보정), resyncAllContractDates, cancelContract 등은 보고에서 단편적으로만 언급되고 전체 책임 미분석
- test/ 디렉토리 29개 정적 테스트(*.static.test.js: workflow-guard, contract-discount-policy, dashboard-*, timeline-performance, kakao-dom-noise-guards, slack-follow-up-actions 등) — 현존 테스트 커버리지·검증 자산이 8개 보고에서 전혀 다뤄지지 않음. 재구축 시 회귀 안전망으로 활용 가능
- timelineMobile.html(40KB) — sheetAPI pageMap에서 ?page=timeline이 실제로 서빙하는 모바일 전용 타임라인 파일. 프론트엔드 보고는 timeline.html만 분석하고 모바일 전용판의 차이는 미커버
- 운영/협업 스크립트(scripts/): startwork.sh/endwork.sh(두 맥 clasp pull/push 동기화), synccheck.sh, integrate.sh, finishbranch.sh, newtask.sh, feature-ledger-audit.sh, kakao-automation(21KB), patch-hermes-village-followup-slack — 멀티세션 작업 흐름과 동기화 안전장치가 자동화 보고에서 일부 경고로만 언급되고 미분석
- Supabase 백엔드 상세: supabase-schema.sql의 실제 테이블 구조(ai_processing_events, ai_follow_up_items, 트리거/RLS/인덱스/jsonb), village-ai RAG(/api/ask) 내부, follow-up-dashboard의 /api/slack-actions HMAC 검증 코드 — 자동화 보고가 역할은 설명하나 스키마·코드 레벨 디테일은 미분석
- docs/companion-deploy.md, ops/multi-session-feature-ledger.md, AGENTS.md(10.8KB), CLAUDE.md(10.3KB), wiki/village-system-raw.md(23.5KB) — 운영 문서·멀티세션 ledger·기존 위키가 보고의 근거로 인용되나 문서 자체의 전체 내용·지침은 통합 분석되지 않음(문서-코드 불일치 일부만 기록됨)
- equipment risk(장비리스크) 외부 백엔드 연동(checkAvailability.js:1737-2265 약 30개 함수, postEquipmentRiskBackend_/setupEquipmentRiskBackendConfig) — checkAvailability 해부 보고가 그룹으로만 언급하고 외부 URL/토큰 연동·리스크 룰 평가 로직의 상세는 미분석
