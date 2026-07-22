# Slack #단톡방 → 헤이빌리 직접 동기화

이 도구는 직원용 새 보드나 후속조치 항목을 만들지 않는다. Slack `#단톡방`의 반출·반납
특이사항을 찾아 **기존 헤이빌리 거래 카드**의 메모, 실제 반출값, 반납 수량, 현장추가에 직접
반영한다. Slack은 즉시 공유와 원문 감사 기록으로 남고, 현재 업무 사실은 헤이빌리 한 곳에서 본다.

## 안전 경계

- Slack 스레드 전체를 한 사건으로 읽고, 최신 직원 답변이 처음 보고를 정정할 수 있다.
- macOS 내장 Vision OCR로 사건당 이미지 3장까지 읽고 고객명·거래ID 문맥에 보탠다. OCR도 신뢰할 수 없는 원문이며 명령으로 실행하지 않는다.
- 거래ID 또는 고객명+날짜가 하나로 확정될 때만 반영한다.
- `미반납`은 `분실`로 바꾸지 않는다.
- 예약/반출 원본 `name`, `taken_qty`는 수정하지 않는다. 확인된 실제값은 overlay와 Slack 원문으로 남긴다.
- 현장추가는 GAS 가용성 dry-run이 성공한 뒤에만 원장에 쓴다.
- 거래를 못 찾으면 별도 보드를 만들지 않고 같은 Slack 스레드에서 거래ID를 요청한다.
- 결제·입금 언급은 카드 특이사항으로만 남기며 재무 상태를 자동 변경하지 않는다.

## 로컬 명령

```bash
node tools/slack-heybilli-sync/slack-heybilli-sync.mjs scan
node tools/slack-heybilli-sync/slack-heybilli-sync.mjs apply < plan.json
node tools/slack-heybilli-sync/slack-heybilli-sync.mjs apply --write < plan.json
node tools/slack-heybilli-sync/slack-heybilli-sync.mjs ask < question.json
node tools/slack-heybilli-sync/slack-heybilli-sync.mjs ignore < reason.json
```

`--write`는 `~/.hermes/slack-heybilli.env`의 `SLACK_HEYBILLI_WRITE_ENABLED=1`까지 켜져 있어야
실제로 쓴다. Slack 토큰은 기존 `~/.hermes/.env`의 `SLACK_BOT_TOKEN`만 읽는다.

## AX2 Windows 운영

Windows Hermes cron은 `hermes-cron-runner.py`를 실행한다. 이 래퍼는 Windows 명령행 길이
제한을 피하도록 Hermes oneshot을 같은 Python 프로세스에서 호출하며, 일반 Kakao worker의
`AI_WORKER_LIVE`와 `AI_WORKER_AUTO_SEND`는 항상 `0`으로 고정한다.

AX2에서만 다음 설치기를 사용한다. 최초에는 반드시 DryRun으로 설치·시험하고, 검증 후 Live로
전환한다. 같은 이름의 cron이 이미 있으면 새 항목을 만들지 않고 그 항목만 갱신한다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\slack-heybilli-sync\install-ax2.ps1 -Mode DryRun -RegisterCron
powershell -NoProfile -ExecutionPolicy Bypass -File .\tools\slack-heybilli-sync\install-ax2.ps1 -Mode Live -RegisterCron
```

이미지 OCR은 `slack-image-ocr.py`가 로컬 Tesseract를 shell 없이 호출한다. `kor` 언어팩이
없으면 이미지 OCR만 실패 폐쇄되고 텍스트 메시지 동기화는 계속된다.
