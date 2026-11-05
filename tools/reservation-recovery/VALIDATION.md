# 검증 범위

## 자동 검증

`run-tests.sh <installed-runtime-root>`: 신규 93개 통과.

- 원문 journal 19개: fsync, 크래시, 손상, 디스크 여유, 정확한 전달 영수증
- intake coordinator 13개: 재기동, 중복, 소스 증거, 불명확 결과 보존, 대기열 공정성, 동시 실행 제한
- watcher 9개: ACK, 불완전 대조, 과거 목록 스크롤과 실제 새 메시지 구분
- bridge 통합 3개, 실시간 우선순위 1개, 안전한 재시도 분류 5개
- 적용 전 무효 AI 응답의 무실행 증거와 재시도 제한 4개
- 알림 분리 1개, 재시도 작업 ID와 작업 버전 2개
- 정확한 소유 탭 로딩 3개, 삭제 메시지 안내 문구 3개
- native adapter lifecycle 9개, collector 소유권 6개, 장애·알림 정책 9개
- 유휴 배포 조건 3개: 실행 중 업무 보호, 실제 consumer 상태, 오래된 상태 파일 구분
- 실제 로컬 TCP 포트 3개: 실행 중 포트 보호, 정상 종료 후 TIME_WAIT, 설치된 launcher 확인

기존 배포 소스 `server.test.mjs`는 변경 전 148개 통과/6개 실패였고,
이번 변경 후에도 같은 148개 통과/동일 6개 실패였다. 이 전체 테스트 묶음이 전부 통과했다고
보고하지 않는다. 새 회귀 실패는 없으며, 기존 실패는 다음과 같다.

- nested skipped Slack failure의 전달 확인 기대값
- health aggregate 필드의 정확한 fixture
- 등록 변경 executor config fixture
- 등록 대체 Task 7 fixture
- confirmation validator boundary fixture
- health safety contract fixture

이 테스트들의 기존 실패를 해결하기 위해 실제 운영의 영수증 검증이나 저장 fence를 완화하지 않았다.

## 운영에서 별도로 확인한 항목

- 정확한 watcher 프로세스만 종료했을 때 launchd가 새 PID로 재기동
- 운영 전용 collector가 전체 상담 목록으로 복구되며 bridge/consumer 연결 확인
- 14일 대화 목록 스캔이 날짜 경계를 넘어 모든 수신 ACK를 받은 후에만 완료로 기록
- 실제 Gateway 작업의 처리와 finalize가 계속 진행
- 실제 장부 읽기, 기존 거래 품목 수의 readback
- 실제 슬랙 수신과 헤이빌리의 지속적인 장애 사례 표시
- 개별 시스템 실패 DM 발송이 멈추고 가격·서류 알림 전송 코드는 보존됨
- 매니페스트, runtime pin, env hash, 활성화 gates 유지

운영 증거·스크린샷·수신 원문과 고객별 결과는 격리 런타임의 비공개 control/state/queue에 보관한다.
이 저장소에는 고객 연락처, 금융정보, 토큰, 원문 대화를 복사하지 않는다.

## 아직 의미하지 않는 것

대화 목록의 수신 대조 완료는 전체 예약 원장 대조 완료가 아니다. 보관 원문, 안전한 자동 재시도,
처리 결과 미확정 기록을 구분한다. 부분 성공·이미 실행된 작업은 원장과의 일치가 입증되기 전까지
다시 등록하지 않으며, 모든 과거 예약이 정상이라고 결론짓지 않는다.
