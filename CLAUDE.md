# 통합재고관리 (my-gas-project2)

빌리지 렌탈샵 스케줄/재고/계약 관리 시스템. Google Apps Script + clasp.

## 배포
- `clasp push` → GAS 편집기에서 웹앱 새 버전 배포 (sheetAPI.js의 doGet/doPost)
- 웹앱 URL: `https://script.google.com/macros/s/AKfycbyRff4-lLXmne-iPIEf87x4-CH_5wb-Uv5dCGymELLrpiKluhg2gDdLdVP4Y0MmxnnT/exec`
- GitHub Pages: `https://village6k-cpu.github.io/my-gas-project2/` (프론트엔드 페이지)

## GitHub Pages 웹폼 URL
- 타임라인: `https://village6k-cpu.github.io/my-gas-project2/timeline.html`
- 확인요청 관리: `https://village6k-cpu.github.io/my-gas-project2/manage.html`
- 대시보드 (일정): `https://village6k-cpu.github.io/my-gas-project2/dashboard.html`
- 약관 동의: `https://village6k-cpu.github.io/my-gas-project2/index.html`

## 파일 구조
- **Code.js** — 트리거 (onEdit, onEditInstallable), 실사기록 동기화, 장비사진 열 설정
- **checkAvailability.js** — 핵심 로직 (onOpen 메뉴, 스케줄 확인/등록/보류/거절, 알림톡, 타임라인/대시보드 데이터, 중복 체크)
- **sheetAPI.js** — 통합 API (doGet/doPost, key인증, Sheet API + Schedule API, 페이지 라우팅)
- **generatecontract.js** — 계약서 생성 (Google Sheets 템플릿 복사, 할인율 계산, 전체 시트 유효성 해제)
- **setupSchedule.js** — 초기 세팅 (계약마스터, 세트마스터 구조 생성)
- **sheetProtection.js** — 시트 보호 (수식 열 보호)
- **createManual.js** — 매뉴얼 시트 생성
- **Manual.html** — 매뉴얼 다이얼로그
- **timeline.html / timelineMobile.html** — 타임라인 (GAS 내부 서빙용)
- **dashboard.html** — 일정 대시보드 (날짜 선택 가능)
- **requestManage.html** — 확인요청 관리 대시보드
- **docs/** — GitHub Pages 프론트엔드 (API_URL 하드코딩, GAS 거치지 않고 직접 서빙)
- **AGENT_GUIDE.md** — 디스패치 에이전트용 API 사용 지침

## 주요 시트
- **확인요청** — 예약 요청 접수 (요청ID: RQ-YYMMDD-NNN, 18열 A~R)
- **스케줄상세** — 장비별 예약 일정 (12열, A:스케줄ID ~ L:단가)
- **계약마스터** — 계약 현황 (거래ID: YYMMDD-NNN)
- **장비마스터** — 장비 목록 (M열: 장비사진)
- **세트마스터** — 세트 구성 + G열 단가
- **실사기록** — 재고 실사 (장비ID 기준 동기화)
- **목록** — 장비명 자동완성용 마스터 목록

## API (sheetAPI.js)
- 인증: `key=village2026` 필수
- 페이지 라우팅: `?page=timeline|dashboard|manage`
- Sheet API: sheets, info, read, write, append, update, search, run
- Schedule API: list, scan, 확인, 등록, 보류, 거절, 발송승인
- 데이터 API: timeline, dashboard (date 파라미터 지원)

## 핵심 로직
- 확인요청 H열 "확인" → processByReqID() 자동 가용성 체크
- 확인요청 N열 "등록" → registerByReqID() 스케줄상세 + 계약마스터 등록 + 계약서 자동 생성
- 확인요청 N열 "추가/삭제/날짜변경" → 스케줄 수정 + 계약서 재생성
- 중복 방지: 같은 예약자명 + 반출일 + 장비목록이면 입력/등록 모두 차단
- 단가는 세트마스터 G열 참조 (findSetPrice)
- 장기 할인: 2일 10%, 3~5일 20%, 6~9일 35%, 10~14일 40%, 15~19일 45%, 20일+ 50%
- parseDT(): 시간 한 자리(7:00)→두 자리(07:00) 패딩 필수 (ISO 형식)

## 외부 연동
- 팝빌 알림톡 (예약 확인/등록 결과 발송)
- 개고생2.0 웹앱 (계약서 링크 전달: updateContractLink)
- Google Drive (계약서 파일 생성)
- GitHub Pages (프론트엔드 직접 서빙 — 속도 개선)

## 주의사항
- doGet/doPost는 sheetAPI.js에만 정의
- onOpen은 checkAvailability.js에만 정의
- .clasp.json의 scriptId로 GAS 프로젝트 식별
- GAS는 같은 프로젝트 내 모든 .js 파일이 전역 스코프 공유
- clasp push 후 반드시 GAS 편집기에서 새 버전 배포해야 웹앱 반영
- docs/ 폴더 변경은 git push만 하면 GitHub Pages 자동 반영
- 계약서 생성 시 전체 시트 데이터 유효성 해제 (setAllowInvalid) 필수
