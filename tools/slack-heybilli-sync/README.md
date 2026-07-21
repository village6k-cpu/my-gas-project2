# Slack #단톡방 → 헤이빌리 직접 동기화

이 도구는 직원용 새 보드나 후속조치 항목을 만들지 않는다. Slack `#단톡방`의 반출·반납
특이사항을 찾아 **기존 헤이빌리 거래 카드**의 메모, 실제 반출값, 반납 수량, 현장추가에 직접
반영한다. Slack은 즉시 공유와 원문 감사 기록으로 남고, 현재 업무 사실은 헤이빌리 한 곳에서 본다.

## 안전 경계

- Slack 스레드 전체를 한 사건으로 읽고, 최신 직원 답변이 처음 보고를 정정할 수 있다.
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
