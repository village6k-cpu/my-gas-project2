# 통합재고관리 (my-gas-project2)

빌리지 렌탈샵 스케줄/재고/계약 관리 시스템. Google Apps Script + clasp.

## 배포
- `clasp push` → GAS 편집기에서 웹앱 새 버전 배포 (sheetAPI.js의 doGet/doPost)

## 파일 구조
- **Code.js** — 트리거 (onEdit, onEditInstallable), 실사기록 동기화, 장비사진 열 설정
- **checkAvailability.js** — 핵심 로직 (onOpen 메뉴, 스케줄 확인/등록/보류/거절, 알림톡, 장비 관리)
- **sheetAPI.js** — 통합 API (doGet/doPost, key인증, Sheet API + Schedule API)
- **generatecontract.js** — 계약서 생성 (Google Sheets 템플릿 복사, 할인율 계산)
- **setupSchedule.js** — 초기 세팅 (계약마스터, 세트마스터 구조 생성)
- **sheetProtection.js** — 시트 보호 (수식 열 보호)
- **createManual.js** — 매뉴얼 시트 생성
- **Manual.html / timeline.html** — HTML 다이얼로그

## 주요 시트
- **확인요청** — 예약 요청 접수 (요청ID: RQ-YYMMDD-NNN)
- **스케줄상세** — 장비별 예약 일정
- **장비마스터** — 장비 목록 (M열: 장비사진)
- **세트마스터** — 세트 구성 + G열 단가
- **실사기록** — 재고 실사 (장비ID 기준 동기화)
- **계약마스터** — 계약 현황

## API (sheetAPI.js)
- 인증: `key=village2026` 필수
- Sheet API: sheets, info, read, write, append, update, search, run
- Schedule API: list, scan, 확인, 등록, 보류, 거절, 발송승인

## 핵심 로직
- 확인요청 N열 "확인" → 자동 가용성 체크 + 알림톡 발송
- 확인요청 N열 "등록" → 스케줄상세 + 계약마스터 등록 + 계약서 자동 생성
- 단가는 세트마스터 G열 참조 (findSetPrice)
- 장기 할인: 3일 20%, 5일 25%, 10일 30%, 15일 40%, 20일+ 50%

## 외부 연동
- 팝빌 알림톡 (예약 확인/등록 결과 발송)
- 개고생2.0 웹앱 (계약서 링크 전달: updateContractLink)
- Google Drive (계약서 파일 생성)

## 주의사항
- doGet/doPost는 sheetAPI.js에만 정의
- onOpen은 checkAvailability.js에만 정의
- .clasp.json의 scriptId로 GAS 프로젝트 식별
