# Village Registered Trade Correction Design

## Goal

등록된 거래의 날짜·스케줄 품목을 고친 뒤 필요할 때 견적서를 발송하는 업무를, 헤르메스가 매번 소스와 API를 재탐색하지 않고 한 번의 명시적 실행으로 끝낸다.

## AI-first boundary

- 헤르메스가 고객 문맥을 이해하고 `tradeId`, 날짜, 제거할 `scheduleId`, 추가할 정확한 장비명과 수량, 발송 여부를 판단한다.
- 실행 도구는 자연어를 해석하거나 업무 규칙을 추론하지 않는다.
- 실행 도구는 임의 시트·범위 쓰기를 받지 않고 기존 GAS의 목적별 API만 호출한다.
- 제거된 `village_operation` 브로커나 별도 라우팅 계층을 되살리지 않는다.
- `스킬 문서 -> AI 판단 -> 명시적 JSON -> 기존 GAS API -> 권위 데이터 재조회`가 전체 흐름이다.

## Interface

```json
{
  "tradeId": "260810-003",
  "operationId": "8f6c77d1-8828-4a85-bf74-13815d96bf51",
  "dateChange": {
    "newStartDate": "2026-08-12",
    "newEndDate": "2026-08-15",
    "startTime": "05:00",
    "endTime": "05:00",
    "allowConflicts": false
  },
  "remove": [
    { "scheduleId": "260810-003-04", "expectedName": "기존 세트명" }
  ],
  "add": [
    { "name": "정확한 세트마스터 장비명", "qty": 1 }
  ],
  "sendEstimate": true
}
```

`tradeId`와 `operationId`는 필수다. 변경할 항목이 하나도 없으면 거부한다. `sendEstimate`는 명시적으로 `true`일 때만 실행한다. 고객명이나 Slack 스레드의 과거 첨부파일로 거래를 추측하지 않는다.

## Execution sequence

1. `스케줄상세`와 `계약마스터`를 거래ID로 병렬 조회하고 정확히 한 거래인지 확인한다.
2. 제거 대상의 `scheduleId`와 선택적 `expectedName`이 현재 행과 일치하는지 검증한다.
3. 날짜 변경이 있으면 기존 `scheduleChangeDates`를 한 번 호출한다.
4. 제거는 정확한 `scheduleId`, 추가는 한 번의 `scheduleAddEquips`로 순차 실행한다. 각 쓰기는 파생된 고유 mutation ID를 사용하고 응답 불명 시 자동 재시도하지 않는다.
5. 품목이 바뀌었으면 `regenerateContract`를 정확히 한 번 호출한다.
6. `sendEstimate:true`이면 재생성 성공 뒤에만 `sendEstimate`를 정확히 한 번 호출한다.
7. 마지막에 `스케줄상세`와 `계약마스터`를 다시 병렬 조회한다. 제거 대상 부재, 추가 품목·수량 존재, 날짜·회차 일치 및 발송 API 성공을 확인한다.

정상 발송 완료 기준은 `sendEstimate`의 명시적 성공 응답과 최종 권위 데이터 재조회다. 팝빌 상세 조회는 API 오류·결과 불명·고객 미수신 이의가 있을 때만 별도 진단한다.

## Failure behavior

- 입력·기준 행 불일치는 쓰기 전에 실패한다.
- 서버 응답이 없거나 성공 여부가 불명확하면 해당 단계와 지금까지의 적용 단계를 구조화해 반환하고 자동 재실행하지 않는다.
- 여러 API에 걸친 전체 트랜잭션을 가장한 자동 롤백은 하지 않는다. 잘못된 보상 쓰기가 원래 결과를 더 망가뜨릴 수 있기 때문이다.
- 일반 `write` API의 쓰기 허용 시트는 넓히지 않는다.

## Scope

이번 구현은 명시적 등록거래 정정 실행 도구, 회차 readback 검증, 간결한 스킬 진입 안내까지만 포함한다. GAS 배포, 실제 고객 발송, Git 커밋·푸시는 별도 승인 없이는 하지 않는다.
