# CLAUDE.md — 카메라렌탈샵 '빌리지' 시스템

## 프로젝트 개요
카메라 렌탈샵 '빌리지'의 렌탈 관리 시스템.
구글시트, 구글 앱스크립트, 앱시트, 웹앱을 조합해서 구축 중.

## 작업 규칙

### 1. 작업 전 — 요구사항 확인
- 작업을 시작하기 전에, 사용자의 요청을 항목별로 정리해서 되물어 확인할 것
- 애매한 부분이 있으면 추측하지 말고 반드시 질문할 것
- "이 정도면 되겠지"라고 넘기지 말 것

### 2. 작업 중 — 한 번에 끝내기
- 작업은 한 번에 완성해서 넘길 것. 단계별로 나눠서 확인받지 않아도 됨
- 관련된 개선사항이 보이면 요청하지 않았더라도 함께 반영해도 좋음 (단, 보고에 명시)
- 기존 코드나 시트 구조를 수정할 때는 변경 전후를 명확히 설명할 것

### 3. 작업 완료 후 — 셀프 리뷰 (필수)
결과를 제출하기 전에 반드시 아래 체크리스트를 점검할 것.
통과 여부와 수정한 항목을 "셀프 리뷰 결과" 섹션으로 보고할 것.

#### 공통 체크리스트
- [ ] 사용자의 원래 요청을 다시 읽고, 빠진 항목이 없는지
- [ ] 오타, 변수명 불일치, 하드코딩된 값이 없는지
- [ ] 한글 용어와 네이밍이 기존 시스템과 일관적인지
- [ ] 이번 변경이 기존 기능을 깨뜨리지 않는지

#### 구글 앱스크립트 체크리스트
- [ ] 시트 이름, 열 번호, 범위가 실제 시트 구조와 일치하는지
- [ ] getRange/setValue 등에서 off-by-one(1칸 밀림) 에러가 없는지
- [ ] SpreadsheetApp, DriveApp 등 권한 필요 서비스가 빠지지 않았는지
- [ ] 트리거 충돌 가능성이 없는지 (onEdit, onSubmit 등)
- [ ] Logger.log나 console.log 디버그 코드가 남아있지 않은지

#### 구글시트 수식 체크리스트
- [ ] 셀 참조가 올바른지 (절대참조 $, 상대참조 구분)
- [ ] VLOOKUP/INDEX-MATCH 등에서 참조 범위가 충분한지
- [ ] 빈 셀, 0, 텍스트 등 예외값 처리가 되어 있는지

#### 앱시트 체크리스트
- [ ] 데이터 소스(시트)와 컬럼 매핑이 정확한지
- [ ] 앱시트 수식 문법(구글시트 수식과 다름)을 정확히 사용했는지
- [ ] 슬라이스, 필터, 보안 필터 조건이 의도와 맞는지

#### 웹앱 체크리스트
- [ ] doGet/doPost 함수가 정상 작동하는지
- [ ] CORS, 인증 관련 설정이 맞는지
- [ ] HTML/CSS/JS에서 깨지는 레이아웃이 없는지
- [ ] 배포 버전(새 배포 vs 기존 배포)을 명시했는지

### 4. 보고 형식
작업 완료 시 아래 형식으로 정리할 것:

```
## 작업 요약
- 요청 사항: (원래 요청을 한 줄로)
- 변경 내용: (무엇을 어떻게 바꿨는지)
- 변경 파일/시트: (어디를 건드렸는지)

## 셀프 리뷰 결과
- ✅ 통과 항목: ...
- 🔧 자체 수정한 항목: ...
- ⚠️ 사용자 확인 필요: ...
```

### 5. 금지 사항
- 기존 시트 구조나 컬럼 순서를 임의로 변경하지 말 것
- "나머지는 비슷하게 하시면 됩니다" 같은 생략 금지. 전체 코드를 다 작성할 것

---

## 시스템 정보

### 배포
- `clasp push` → GAS 편집기에서 웹앱 새 버전 배포 (sheetAPI.js의 doGet/doPost)
- 웹앱 URL: `https://script.google.com/macros/s/AKfycbyRff4-lLXmne-iPIEf87x4-CH_5wb-Uv5dCGymELLrpiKluhg2gDdLdVP4Y0MmxnnT/exec`
- GitHub Pages: `https://village6k-cpu.github.io/my-gas-project2/`

### GitHub Pages 웹폼 URL
- 타임라인: `https://village6k-cpu.github.io/my-gas-project2/timeline.html`
- 확인요청 관리: `https://village6k-cpu.github.io/my-gas-project2/manage.html`
- 대시보드 (일정): `https://village6k-cpu.github.io/my-gas-project2/dashboard.html`
- 약관 동의: `https://village6k-cpu.github.io/my-gas-project2/index.html`

### 파일 구조
- **Code.js** — 트리거 (onEdit, onEditInstallable), 실사기록 동기화, 장비사진 열 설정
- **checkAvailability.js** — 핵심 로직 (스케줄 확인/등록/보류/거절, 알림톡, 타임라인/대시보드 데이터, 중복 체크)
- **sheetAPI.js** — 통합 API (doGet/doPost, key인증, Sheet API + Schedule API, 페이지 라우팅)
- **generatecontract.js** — 계약서 생성 (Google Sheets 템플릿 복사, 할인율 계산, 전체 시트 유효성 해제)
- **setupSchedule.js** — 초기 세팅 (계약마스터, 세트마스터 구조 생성)
- **sheetProtection.js** — 시트 보호 (수식 열 보호)
- **createManual.js** — 매뉴얼 시트 생성
- **dashboard.html** — 일정 대시보드 (날짜 선택 가능)
- **requestManage.html** — 확인요청 관리 대시보드
- **timeline.html / timelineMobile.html** — 타임라인
- **docs/** — GitHub Pages 프론트엔드 (API_URL 하드코딩, GAS 거치지 않고 직접 서빙)
- **AGENT_GUIDE.md** — 디스패치 에이전트용 API 사용 지침

### 주요 시트
- **확인요청** — 예약 요청 접수 (요청ID: RQ-YYMMDD-NNN, 18열 A~R)
- **스케줄상세** — 장비별 예약 일정 (12열, A:스케줄ID ~ L:단가)
- **계약마스터** — 계약 현황 (거래ID: YYMMDD-NNN)
- **장비마스터** — 장비 목록 (M열: 장비사진)
- **세트마스터** — 세트 구성 + G열 단가
- **실사기록** — 재고 실사 (장비ID 기준 동기화)
- **목록** — 장비명 자동완성용 마스터 목록

### API (sheetAPI.js)
- 인증: `key=village2026` 필수
- 페이지 라우팅: `?page=timeline|dashboard|manage`
- Sheet API: sheets, info, read, write, append, update, search, run
- Schedule API: list, scan, 확인, 등록, 보류, 거절, 발송승인
- 데이터 API: timeline, dashboard (date 파라미터 지원)

### 핵심 로직
- 확인요청 H열 "확인" → processByReqID() 자동 가용성 체크
- 확인요청 N열 "등록" → registerByReqID() 스케줄상세 + 계약마스터 등록 + 계약서 자동 생성
- 확인요청 N열 "추가/삭제/날짜변경" → 스케줄 수정 + 계약서 재생성
- 중복 방지: 같은 예약자명 + 반출일 + 장비목록이면 입력/등록 모두 차단
- 장기 할인: 2일 10%, 3~5일 20%, 6~9일 35%, 10~14일 40%, 15~19일 45%, 20일+ 50%
- parseDT(): 시간 한 자리(7:00)→두 자리(07:00) 패딩 필수 (ISO 형식)

### 외부 연동
- 팝빌 알림톡 (예약 확인/등록 결과 발송)
- 개고생2.0 웹앱 (계약서 링크 전달: updateContractLink)
- Google Drive (계약서 파일 생성)
- GitHub Pages (프론트엔드 직접 서빙 — 속도 개선)

### 배포 순서 (반드시 준수, 전부 자동 실행)
1. `clasp pull` → GAS 편집기에서 작업한 내용 로컬로 가져오기 (덮어쓰기 방지)
2. 로컬에서 코드 수정
3. `clasp push` → GAS에 반영
4. `clasp deploy -i AKfycbyRff4-lLXmne-iPIEf87x4-CH_5wb-Uv5dCGymELLrpiKluhg2gDdLdVP4Y0MmxnnT -d "변경 요약"` → 기존 웹앱 URL 유지한 채 새 버전 배포
5. `git add & commit & push` → 백업 + GitHub Pages(docs/) 자동 반영

**절대 clasp pull 없이 clasp push 하지 말 것** — GAS 편집기에서 직접 작업한 코드가 날아감

**재배포 자동화**: 사용자는 매번 수동 배포하는 걸 원하지 않음. 코드 변경 작업은 4번까지 항상 자동 실행하고 "재배포할까요" 묻지 말 것.

### 두 맥 오갈 때 워크플로우 (스크립트 자동화)
두 맥 오가며 작업할 때 sync 빼먹어서 작업분 날리지 않도록 자동화 스크립트 사용.

**작업 시작 시:**
```
./scripts/startwork.sh
```
→ git fetch+pull, clasp pull, 동기화 상태 점검까지 자동.
GAS에 git 미반영분이 있으면 멈추고 안내함.

**작업 종료 시:**
```
./scripts/endwork.sh "커밋 메시지"
```
→ clasp push, clasp deploy, git commit+push까지 자동.
메시지 생략하면 프롬프트로 물음.

**상태 진단 (읽기 전용):**
```
./scripts/synccheck.sh
```
→ 로컬/원격/GAS 동기화 상태 확인. 변경 없음.

**원칙: 떠나는 맥에서 endwork, 도착하는 맥에서 startwork.** 빼먹으면 다른 맥 작업분이 GAS와 git 사이에서 어긋남.

### 주의사항
- doGet/doPost는 sheetAPI.js에만 정의
- onOpen은 checkAvailability.js에만 정의
- .clasp.json의 scriptId로 GAS 프로젝트 식별
- GAS는 같은 프로젝트 내 모든 .js 파일이 전역 스코프 공유
- docs/ 폴더 변경은 git push만 하면 GitHub Pages 자동 반영
- 계약서 생성 시 전체 시트 데이터 유효성 해제 (setAllowInvalid) 필수

## Skill routing

When the user's request matches an available skill, ALWAYS invoke it using the Skill
tool as your FIRST action. Do NOT answer directly, do NOT use other tools first.
The skill has specialized workflows that produce better results than ad-hoc answers.

Key routing rules:
- Product ideas, "is this worth building", brainstorming → invoke office-hours
- Bugs, errors, "why is this broken", 500 errors → invoke investigate
- Ship, deploy, push, create PR → invoke ship
- QA, test the site, find bugs → invoke qa
- Code review, check my diff → invoke review
- Update docs after shipping → invoke document-release
- Weekly retro → invoke retro
- Design system, brand → invoke design-consultation
- Visual audit, design polish → invoke design-review
- Architecture review → invoke plan-eng-review
- Save progress, checkpoint, resume → invoke checkpoint
- Code quality, health check → invoke health
