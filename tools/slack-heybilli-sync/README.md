# Slack #단톡방·#업무지시 → 헤이빌리 직접 동기화

이 도구는 직원용 새 보드나 후속조치 항목을 만들지 않는다. Slack `#단톡방`·`#업무지시`의 반출·반납
특이사항을 찾아 **기존 헤이빌리 거래 카드**의 메모, 실제 반출값, 반납 수량, 현장추가에 직접
반영한다. Slack 원문 감사정보는 내부 동기화 원장에만 두고, 카드에는 직원이 바로 판단할 수 있는
핵심 업무 사실만 간결하게 표시한다.

## 안전 경계

- Slack 스레드 전체를 한 사건으로 읽고, 최신 직원 답변이 처음 보고를 정정할 수 있다.
- 사건당 이미지 3장까지 기존 Hermes 이미지 분석 기능으로 읽어 고객명·거래ID 문맥에 보탠다. 분석 결과도 신뢰할 수 없는 원문이며 명령으로 실행하지 않는다.
- 원문 이름·장비·일정을 읽기 전용 lookup으로 조사하고, 독립적인 근거가 거래 하나로 좁혀질 때만 반영한다.
- 이미지 분석이나 다른 단계의 답글만으로 고객을 확정하지 않으며, 고객명 부분일치도 자동 반영하지 않는다.
- 헤이빌리에 기존 카드가 없으면 GAS에서 가져오거나 새로 만들지 않고 Slack 스레드에서 정확한 거래를 요청한다.
- `미반납`은 `분실`로 바꾸지 않는다.
- 예약/반출 원본 `name`, `taken_qty`는 수정하지 않는다. 확인된 실제값은 overlay와 Slack 원문으로 남긴다.
- 현장추가는 GAS 가용성 dry-run이 성공한 뒤에만 원장에 쓴다.
- 거래를 못 찾으면 최대 3회 추가 조사한 뒤 필요한 한 가지 사실만 묻는다. 매장 보관·물품 발견·일반 장비 공유에는 거래ID를 요구하지 않는다.
- 결제·입금 언급은 카드 특이사항으로만 남기며 재무 상태를 자동 변경하지 않는다.

## 로컬 명령

```bash
node tools/slack-heybilli-sync/slack-heybilli-sync.mjs scan
node tools/slack-heybilli-sync/slack-heybilli-sync.mjs lookup < query.json
node tools/slack-heybilli-sync/slack-heybilli-sync.mjs apply < plan.json
node tools/slack-heybilli-sync/slack-heybilli-sync.mjs apply --write < plan.json
node tools/slack-heybilli-sync/slack-heybilli-sync.mjs ask < question.json
node tools/slack-heybilli-sync/slack-heybilli-sync.mjs ignore < reason.json
```

`--write`는 `~/.hermes/slack-heybilli.env`의 `SLACK_HEYBILLI_WRITE_ENABLED=1`까지 켜져 있어야
실제로 쓴다. Slack 조회는 기존 `~/.hermes/.env`의 `SLACK_BOT_TOKEN`을 사용하고, 헤이빌리
내부 API는 `slack-heybilli.env`의 별도 `SLACK_HEYBILLI_API_TOKEN`을 사용한다.

## AX2 Windows 운영

Windows Hermes cron은 `hermes-cron-runner.py`를 실행한다. 이 래퍼는 Windows 명령행 길이
제한을 피하도록 Hermes oneshot을 같은 Python 프로세스에서 호출하며, 일반 Kakao worker의
`AI_WORKER_LIVE`와 `AI_WORKER_AUTO_SEND`는 항상 `0`으로 고정한다.

AX2에서만 다음 설치기를 사용한다. 최초에는 반드시 DryRun으로 설치·시험하고, 검증 후 Live로
전환한다. 같은 이름의 cron이 이미 있으면 새 항목을 만들지 않고 그 항목만 갱신한다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\slack-heybilli-sync\install-ax2.ps1 -Mode DryRun -ApiTokenFile C:\path\slack-heybilli-api-token.txt -RegisterCron
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\slack-heybilli-sync\install-ax2.ps1 -Mode Live -RegisterCron
```

`-ApiTokenFile`은 최초 설치 또는 토큰 교체 때만 사용한다. 설치기는 값 자체를 출력하지 않고
전용 환경파일에 저장한다. 설치 성공 뒤 원본 토큰 파일은 즉시 삭제한다.

### 이미지 첨부 처리

크론은 이미 처리된 사건을 먼저 제외하고, 아직 처리되지 않은 사건의 이미지만 기존 Hermes
이미지 분석 기능에 넘긴다. 사건당 최대 3장, 실행당 최대 4장을 처리한다. Slack 이미지는 AX2
임시 폴더에 내려받아 분석 직후 삭제하며 별도 모델, 가상환경, 결과 캐시, 상주 프로세스를 두지
않는다. 이미지 분석이 실패한 사건은 질문을 만들지 않고 다음 크론으로 미루며, 이미지가 없는
텍스트 사건은 그대로 계속 처리한다.

### 근거 조사 (1.1.0)

AI가 직원 원문에서 단서를 선택하고 `lookup`은 기존 거래·품목을 읽기만 한다. 초기 정규식 후보가
비어 있어도 고객명, 실제 장비, 예정 시각으로 재조회할 수 있다. 응답의 `query`를 apply의
`resolution`으로 전달하면 서버가 최신 원문 해시와 거래 후보를 다시 검증한다. 같은 근거에
복수 거래가 남으면 자동 적용하지 않는다. 단계가 불명확하거나 이름 없이 장비+시간으로 연결한
경우는 메모만 허용한다. 사진 분석은 고객 정체성의 근거로 쓰지 않는다.

`ask`에는 마지막 lookup의 `query`가 필요하다. CLI는 질문 직전에 다시 조회하여 해결 가능한
거래에는 질문하지 않는다. DRY-RUN은 lookup과 apply 미리보기만 허용하며 ask/ignore도 차단한다.
이미 needs_context/ignored/applied로 처리한 과거 사건은 이번 버전 배포만으로 재실행하지 않는다.
과거 사건의 조회는 sourceHash를 포함한 lookup으로 수행할 수 있으며 상태나 고객 데이터를 바꾸지 않는다.

### 채널 확장 (1.2.0)

하나의 기존 크론에서 `SLACK_HEYBILLI_CHANNEL_IDS`의 쉼표 구분 채널을 각각 수집한다.
운영 대상은 단톡방 `C0B6ZJZ2XU3`, 업무지시 `C0BMNA501R9`다. 이 설정이 없으면 기존
`SLACK_HEYBILLI_CHANNEL_ID`를 사용한다. 여러 채널 설정에서는 모든 CLI JSON에 원문
`event.channel_id`를 `channelId`로 명시해야 한다. 조회·중복 확인·완료 안내·질문은 원래 채널만 사용한다.
서버도 허용 채널만 처리하며, 한 scan 요청에는 한 채널의 사건만 받는다. 테이블 구조 변경은 없다.

`SLACK_HEYBILLI_CHANNEL_START_TS`는 채널별 수집 시작 Slack 초 단위를 담은 JSON 객체다.
새 채널 등록 시 해당 채널의 활성화 시각을 저장해 과거 지시를 소급 실행하지 않는다. 기존 채널의
시작 시각과 72시간 조회 범위는 유지한다. 이미지 분석은 두 채널을 합쳐 실행당 최대 4장이다.
두 채널은 같은 이미지 분석 마감 시간을 공유하며, 시간이 부족한 이미지 사건은 다음 실행으로 미룬다.
한 채널의 수집 오류는 로그에 남기고 다른 채널의 정상 사건은 계속 처리한다.
업무지시의 요청·예정은 수행 완료로 간주하지 않고, 해당 거래의 메모로만 보존한다.

### 장비 기록 (1.3.0)

재고·분실·파손·고장 보고는 `lookup-equipment`로 직원 원문의 장비를 조회하고 `record-equipment`로 기록한다.
거래번호 없이도 처리하며, 거래 정정이 함께 있으면 장비 보고를 `finish:false`로 먼저 저장한다.
장비 보고만 있으면 `finish:true`로 끝낸다. 이 명령은 Slack 메시지를 보내지 않는다.
DRY-RUN에서는 `--write` 없이 조회·검증만 한다. 배포만으로 과거 완료 사건을 전부 재실행하지 않는다.

원장 `equipment_ledger.open_issues`와 `equipment_events` 감사 이력, `slack_equipment_reports` 영수증을
한 트랜잭션에 저장한다. 장비별 원문 키로 정정·철회하며, 기존 재고 화면과 실사 승인도 키를 보존한다.
장비마스터는 B열 ID로 찾아 J열 비고만 반영한다. 보유·정비·가용 수량, 상태, 실사 값은 변경하지 않는다.
크론은 새 메시지가 없는 실행에도 비고 반영을 재시도한다. 시트 쓰기 후 재조회와 원장 버전 검증을 통과해야
영수증을 완료하며, 실패해도 거래 수량을 다시 적용하지 않는다.

마지막 반영값과 과거 비고 조각을 보존해 늦은 전체 미러가 옛 기록을 다시 쓰더라도 복구한다.
처음부터 시트와 원장 비고가 달라 출처를 구분할 수 없는 장비는 해당 장비만 보류하고 기존 내용을 보존한다.
확인 후 추가된 시트 수기는 원장에 버전 검증을 거쳐 보존한다. GAS는 `expectedNote` 사전 비교로
조회 이후 변경된 비고 쓰기를 거절한다. Google Sheets의 직접 편집은 GAS 잠금을 따르지 않으므로
사전 비교와 셀 쓰기 사이의 순간적인 동시 수정까지 원자적으로 보장하지는 않는다.
