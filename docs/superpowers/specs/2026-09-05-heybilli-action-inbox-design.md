# 헤이빌리 후속조치 인박스와 Slack 요약 보고 설계

## 상태

- 2026-09-05 인챗 설계 승인 완료
- 이 문서는 구현 전 최종 서면 검토본이다.
- 구현, 배포, 운영 데이터 변경은 이 문서 커밋에 포함하지 않는다.

## 문제

현재 후속조치 흐름은 사용자의 실제 업무 방식과 반대로 배치되어 있다.

- Slack 다이제스트가 업무마다 긴 카드와 여러 버튼을 만들어 보고 채널이 처리 화면처럼 보인다.
- 헤이빌리 `후속조치`는 4레인 칸반, 상시 체크박스, 벌크 도구, 상세 카드가 동시에 보여 가시성이 낮다.
- v2 후속조치 API는 읽기만 가능하고 상태 변경은 거부하므로, 실제 액션은 Slack에 남아 있다.
- 과거 기술 오류형 업무가 사용자 업무와 섞이면 “내가 무엇을 처리해야 하는지”보다 내부 시스템 상태가 더 크게 보인다.
- 예약, 견적, 정산 같은 업무 성격을 한눈에 나눌 수 있는 일관된 대분류가 없다.

원하는 제품은 알림 시스템이 아니라 직원의 인계 시스템이다. Hermes 직원이 카카오톡 대화를 먼저 읽고, 안전하게 할 수 있는 일은 처리한 뒤, 대표가 직접 결정하거나 실행해야 하는 업무만 정리해서 넘겨야 한다.

## 목표

1. Slack을 버튼 없는 짧은 요약 보고 채널로 단순화한다.
2. 실제 후속조치의 조회와 상태 변경을 헤이빌리 한곳으로 모은다.
3. 모든 사용자 업무에 정확히 하나의 대분류와 하나의 구체 업무 유형을 부여한다.
4. 고객 요청 원문, 내부 오류명, 재시도 코드보다 “고객이 원하는 것 / 직원이 확인한 것 / 대표가 할 한 가지”를 먼저 보여준다.
5. Hermes의 의미 판단을 보존하고 키워드 기반 업무 분류기를 새로 만들지 않는다.

## 제품 원칙

### Hermes는 먼저 일하는 직원이다

- 카카오톡 수신 이벤트 자체는 사용자 알림이 아니다.
- Hermes가 방의 최신 대화 흐름을 읽고 연속된 고객 메시지를 하나의 요청으로 이해한다.
- 안전하게 자동 처리하거나 답변까지 검증된 요청은 사용자 업무를 만들지 않는다.
- 남은 사람의 판단 또는 실행이 있을 때만 하나의 안정적인 `work_items_v2` 업무를 만든다.
- 동일 고객 요청의 후속 메시지와 재시도는 기존 업무에 병합하고 카드 수를 늘리지 않는다.
- 전송 오류, 브라우저 오류, 타임아웃, 재시도 상태는 운영 로그와 health에만 남기고 사용자 후속조치와 다이제스트에는 표시하지 않는다.

### Slack은 보고만 한다

- 일반 업무는 기존 예약된 다이제스트 시점에 한 개의 짧은 보고로 보낸다.
- 업무별 카드, 체크박스, `처리 시작`, `미루기`, `완료`, `P0 확인` 버튼을 렌더링하지 않는다.
- 다이제스트에는 전체 현황, 업무 대분류별 건수, 우선 확인할 최대 5건, 헤이빌리 링크만 포함한다.
- 별도 일일 리마인더 메시지나 여러 multipart 업무 카드를 만들지 않는다.
- 처리할 업무가 0건이면 일반 다이제스트를 보내지 않는다.

### 헤이빌리는 유일한 처리 화면이다

- `후속조치`는 한 개의 우선순위 인박스와 상세 패널로 구성한다.
- 시작, 미루기, 해결 요청, P0 확인, 제외 등 모든 사용자 액션은 헤이빌리에서만 실행한다.
- 브라우저에는 Supabase service-role key를 노출하지 않는다. 인증된 Next.js 서버 라우트가 사용자 신원과 버전을 검증한 뒤 서버 전용 RPC를 호출한다.
- Slack의 기존 인터랙션 코드는 즉시 삭제하지 않지만 새 메시지에는 액션을 만들지 않고, 전환 확인 후 poller를 끈다.

## 업무 분류 계약

### 분류 방식

Hermes가 대화 전체를 바탕으로 유한한 `work_type`을 의미적으로 선택한다. 결정론적 코드는 고객 문구의 키워드로 분류하지 않고, 검증된 `work_type`을 아래 표의 정확한 한 대분류로 투영한다.

| 대분류 | 표시할 구체 업무 유형 | `work_type` |
| --- | --- | --- |
| 예약·스케줄 | 예약 확인 | `reservation_review` |
| 예약·스케줄 | 스케줄 확인 | `schedule_check` |
| 예약·스케줄 | 스케줄 등록 | `schedule_register` |
| 예약·스케줄 | 스케줄 변경 | `schedule_change` |
| 예약·스케줄 | 반납·연장 | `return_extension` |
| 견적·가격 | 견적서 발송 | `quote_send` |
| 견적·가격 | 가격·할인 확인 | `price_review` |
| 정산·서류 | 입금·결제 확인 | `payment_check` |
| 정산·서류 | 세금계산서 발행 | `tax_invoice` |
| 정산·서류 | 계약·서류 처리 | `contract_document` |
| 고객 응대 | 고객 답변 필요 | `reply_needed` |
| 운영·예외 | 기타 사람 확인 | `human_review` |
| 운영·예외 | 파손·수리 | `damage_repair` |
| 운영·예외 | 중복 확인 | `sheet_duplicate_check` |

규칙은 다음과 같다.

- 한 업무는 대분류 하나와 구체 업무 유형 하나만 갖는다. 여러 열이나 여러 카테고리에 중복 표시하지 않는다.
- `schedule_register`와 `schedule_change`는 사용자가 실제로 구분해야 하는 업무이므로 reviewed allowlist에 추가한다.
- 더 구체적인 유형이 있으면 `human_review`를 사용하지 않는다. `human_review`는 의미 판단 후에도 위 유형으로 표현할 수 없는 실제 사람 업무의 마지막 수단이다.
- `completed_log`, `reservation_review_timeout`, `automation_error_review`는 사용자 업무 유형이 아니다. 과거 행은 보존하되 헤이빌리 기본 목록, 건수, Slack 보고에서 제외한다.
- 지원하지 않는 값은 임의로 “기타”에 넣지 않는다. fail-closed 처리하고 비공개 운영 health에만 집계한다.
- 분류 표는 Work Orchestrator 선택, 헤이빌리 API, 헤이빌리 UI, Slack 보고가 같은 fixture로 계약 테스트한다.

## Slack 보고 설계

### 일반 다이제스트

한 메시지는 최대 4개의 비액션 블록으로 제한한다.

```text
후속조치 요약 · 9월 5일 18:00
지금 할 일 12 · 긴급 2 · 미뤄둠 4
예약·스케줄 5 · 견적·가격 3 · 정산·서류 2 · 고객 응대 1 · 운영·예외 1

우선 확인
• 김OO — 9/7 촬영 스케줄 확인
• 박OO — 견적서 발송
• 이OO — 세금계산서 발행

나머지 9건은 헤이빌리 후속조치에서 확인
https://…/follow-ups
```

- `지금 할 일`은 현재 시각에 actionable한 `open` 또는 `in_progress` 업무다.
- `미뤄둠`은 아직 미래인 `snoozed_until`을 가진 업무다.
- `긴급`은 아직 유효하게 확인되지 않은 P0 업무다.
- 대분류 건수는 활성 사용자 업무 전체를 정확히 한 번씩 센다.
- 우선 확인 목록은 P0, 기한 경과, urgent, 오래 미처리 순으로 최대 5건만 보여준다.
- 각 줄은 안전하게 정리된 제목과 필요한 행동만 포함한다. 카카오 원문, room key, stack trace, 내부 error token, 재시도 횟수는 금지한다.
- 데이터가 표시 한도를 넘으면 `나머지 N건`을 정확히 표시한다. 조용히 누락하지 않는다.
- `blocks` 안에 `actions`, `button`, `action_id`, encoded action value가 하나라도 있으면 렌더링 실패로 처리한다.

정확한 전체 건수와 상위 5건을 limit 이전에 계산하는 읽기 전용 DB 경계를 사용한다. 현재의 “최대 500행을 가져와 클라이언트에서 집계” 방식으로 정확성을 추정하지 않는다.

### P0 예외

P0만 예약 시각을 기다리지 않고 별도 한 줄 보고를 허용한다.

```text
긴급 후속조치 · [예약·스케줄] 김OO — 내일 촬영 스케줄 충돌 확인 필요
헤이빌리에서 처리: https://…/follow-ups
```

- Hermes가 의미적으로 P0와 `requires_human_action=true`를 확정한 업무만 대상이다.
- 버튼과 인터랙션은 없다.
- 같은 안정적 업무와 delivery generation은 기존의 정확한 client ID로 중복 전송을 막는다.
- 헤이빌리에서 P0 확인 또는 업무 종결이 적용되면 이후 P0 보고는 중단한다.
- 실패나 재시도 자체를 별도의 사용자 메시지로 보내지 않는다.

## 헤이빌리 후속조치 UX

### 정보 구조

기존 4레인 칸반을 한 개의 우선순위 인박스로 교체한다.

```text
후속조치                                  새로고침
지금 할 일 12   미뤄둔 일 4   완료 38

전체 12 | 예약·스케줄 5 | 견적·가격 3 | 정산·서류 2 | 고객 응대 1 | 운영·예외 1

[긴급] [예약·스케줄] 스케줄 확인
김OO · 내일 촬영 가능 여부를 확인해 주세요
직원이 확인한 내용 한 줄
대표가 할 일: 후보 일정 하나를 선택
                                                   12분 전
```

- 첫 진입은 `지금 할 일`이다. `snoozed` 행도 `snoozed_until <= now`가 되면 상태 정리 작업을 기다리지 않고 여기에서 다시 보인다.
- 상단 상태 탭은 `지금 할 일`, `미뤄둔 일`, `완료` 세 개다.
- 그 아래 대분류 chip은 `전체`와 승인된 5개 분류를 현재 상태 탭 안의 건수와 함께 보여준다.
- 기본 목록에는 체크박스, 벌크 툴바, 드래그, 레인 중복 표시가 없다.
- 목록 한 행은 우선순위, 대분류, 구체 업무 배지, 고객/사건 제목, 직원 요약 한 줄, 대표의 다음 행동 한 줄, 경과/기한만 표시한다.
- P0와 기한 경과만 강한 색을 사용하고 일반 행은 중립 색을 사용한다.
- 모바일은 단일 목록에서 상세 bottom sheet로, 데스크톱은 목록과 상세 패널의 master-detail로 동작한다.
- 빈 상태는 기술 설명 없이 `처리할 후속조치가 없습니다`로 표시한다.

### 상세 화면

상세 패널은 다음 순서로 읽힌다.

1. 고객 또는 사건과 구체 업무 유형
2. 고객이 원하는 것
3. 직원이 이미 확인하거나 처리한 것
4. 대표가 결정하거나 실행할 정확히 한 가지
5. 기한, 우선순위, 현재 상태
6. 가능한 액션

원문 전체와 내부 운영 증거는 기본 상세에도 노출하지 않는다. 향후 원문 보기가 필요하면 별도 권한과 감사 계약을 가진 기능으로 설계한다.

### 사용자 액션

| 화면 액션 | v2 action | 결과 |
| --- | --- | --- |
| 처리 시작 | `progress` | `in_progress`로 전환하고 지금 목록에 유지 |
| AI에게 완료 확인 요청 | `request_resolve` | 기존 authoritative resolution 경로가 실제 결과를 검증; 검증 전에는 업무를 닫지 않음 |
| 미루기 | `snooze` | 3시간, 오늘 저녁, 날짜 지정 중 미래 시각으로 이동 |
| 긴급 확인 | `ack_p0` | P0 재알림만 중단; 업무 자체는 활성 유지 |
| 목록에서 제외 | `dismiss` | 보조 메뉴와 확인 단계를 거쳐 종결 |

- 업무를 실제로 완료했다고 가정하는 낙관적 `done` 변경은 만들지 않는다.
- 지원되는 견적, 서류, 스케줄 자동화는 `request_resolve` 뒤 기존 검증 가능한 실행 경로를 사용한다.
- 자동 실행이 불가능하거나 확인이 부족하면 업무는 열린 채로 남고, 상세의 “대표가 할 일”과 blocking reason만 갱신한다.
- 상세의 주 버튼 문구는 `recommended_action`과 구체 업무 유형에 맞게 보여주되, 서버에 보내는 명령은 위 유한 action 계약으로 제한한다. 화면 문구가 새로운 미검증 사업 동작을 암시해서는 안 된다.
- 네트워크 요청 중 버튼을 비활성화하고 중복 제출을 막는다.
- stale version이면 `409`와 함께 최신 행을 다시 읽고 `다른 곳에서 이미 변경되었습니다`를 보여준다.

## API와 데이터 경계

### 안전한 읽기 모델

`GET /api/follow-ups`의 v2 응답은 legacy 카드 형태로 위장하지 않고 아래의 전용 안전 모델을 반환한다.

```json
{
  "ok": true,
  "source": "work_items_v2",
  "summary": {
    "now": 12,
    "snoozed": 4,
    "completed": 38,
    "p0": 2,
    "byCategory": {
      "schedule": 5,
      "quote": 3,
      "settlement": 2,
      "customer": 1,
      "operations": 1
    }
  },
  "items": [
    {
      "id": "uuid",
      "version": 7,
      "category": "schedule",
      "workType": "schedule_check",
      "workTypeLabel": "스케줄 확인",
      "priority": "urgent",
      "state": "open",
      "title": "김OO 촬영 일정 확인",
      "summary": "직원이 확인한 안전한 요약",
      "recommendedAction": "후보 일정 하나를 선택",
      "dueAt": null,
      "snoozedUntil": null,
      "firstOpenedAt": "canonical timestamp",
      "updatedAt": "canonical timestamp"
    }
  ],
  "nextCursor": null,
  "omittedCount": 0
}
```

- 서버 측 읽기 함수가 `requires_human_action=true`, 활성/완료 view, 지원된 업무 유형, snooze 경계, 분류와 정렬을 limit 전에 적용한다.
- exact summary는 페이지 크기와 무관하다.
- 페이지는 안정적인 우선순위/기한/최초 생성시각/UUID 순서와 불투명 cursor를 사용한다.
- 응답은 위 display allowlist만 포함한다. `work_key`, `source_event_keys`, 전체 `payload`, `pending_action`, `resolution_evidence`, room key, 고객 원문은 포함하지 않는다.
- 잘못된 행을 임의 보정해 보여주지 않는다. 응답 전체를 generic unavailable로 닫고 health에 content-free invalid count를 남긴다.

### 인증된 변경 모델

브라우저는 다음 exact body만 서버에 보낸다.

```json
{
  "id": "uuid",
  "expectedVersion": 7,
  "action": { "type": "progress" }
}
```

- 허용 action shape는 기존 v2 finite allowlist를 재사용한다.
- `requestedBy`는 브라우저 입력을 신뢰하지 않는다. Next.js 서버가 인증된 사용자 UUID로 `heybilli:<uuid>` actor를 만든다.
- 서버는 service-role로 version-CAS RPC를 호출하고 exact content-free 응답을 검증한다.
- SQL과 pending-action processor는 legacy Slack actor와 `heybilli:<uuid>`를 유한하게 허용하되, 새 Slack 메시지는 actor를 생성하지 않는다.
- 변경 성공 후 API는 최신 안전 읽기 모델의 해당 item만 반환한다.
- 버전 불일치, 이미 종결, 미확인 P0를 숨기는 요청, 과거 snooze 시각은 부작용 없는 유한 오류로 응답한다.

## 컴포넌트 경계

1. **Semantic work producer** — Hermes 결과를 검증하고 안정적 work item을 만든다. 업무 의미를 결정하는 유일한 계층이다.
2. **Work taxonomy contract** — reviewed `work_type`과 정확히 한 대분류/표시명을 매핑한다. 원문 텍스트를 읽지 않는다.
3. **Owner-work read RPC** — 필터, exact counts, 정렬, 페이지를 DB에서 일관되게 계산한다.
4. **Heybilli API** — 직원 인증, 안전 projection, actor 생성, action CAS만 담당한다.
5. **Heybilli inbox UI** — 목록/상세/필터/액션 상태를 표현한다. 업무 의미를 재분류하지 않는다.
6. **Digest report renderer** — exact aggregate와 상위 5건을 한 개의 buttonless Slack 보고로 만든다.
7. **P0 reporter** — 의미적으로 확정된 P0 한 건을 buttonless 알림으로 보내고 기존 durable delivery CAS를 유지한다.

각 컴포넌트는 고객 메시지 전송이나 사업상 결정을 새로 만들지 않는다.

## 오류 처리와 가시성

- 목록 읽기 실패 시 마지막 성공 목록을 흐리게 유지하고 `최신 정보를 불러오지 못했습니다` 배너를 표시하되 액션은 비활성화한다.
- action CAS 실패는 데이터베이스 결과를 추측하지 않고 즉시 해당 item을 재조회한다.
- Slack 렌더 또는 집계 증거가 잘못되면 부분적으로 그럴듯한 요약을 보내지 않는다. 전송을 중단하고 비공개 health에 generic reason을 기록한다.
- 운영 오류 건수는 `/health`와 로그에만 남고 Slack 보고와 헤이빌리 사용자 목록에는 나오지 않는다.
- 사용자 화면에는 stack trace, SQLSTATE, Slack error, client message ID, lease/token을 표시하지 않는다.

## 전환과 롤백

전환은 한 번에 사용자 경로를 뒤집지 않는다.

1. DB read/action 경계와 헤이빌리 새 UI를 기본 OFF로 배포한다.
2. 인증된 readback으로 분류별 건수, 상세 allowlist, pagination, stale CAS를 no-send 환경에서 검증한다.
3. 헤이빌리 v2 action을 켜고 실제 사용자 계정으로 읽기/비파괴 상태 변경/재조회 경계를 검증한다.
4. Slack ordinary digest와 P0를 report-only renderer로 전환한다.
5. 새 Slack payload에 action block이 0개임을 readback한 뒤 Slack action poller를 끈다.
6. health와 헤이빌리에서 새 owner work가 누락 없이 보이고 과거 기술형 행이 숨겨졌는지 확인한다.

전환 guard는 다음을 강제한다.

- report-only Slack 전환은 헤이빌리 read와 action readiness가 모두 true일 때만 가능하다.
- Slack action poller OFF와 report-only renderer ON은 같은 runtime mode 계약으로 묶는다.
- 롤백은 과거 행을 삭제하거나 version을 되돌리지 않는다. 이전 renderer/action 경로를 명시적 legacy mode에서만 다시 켠다.
- feature branch 구현과 테스트는 live Supabase migration 적용, Slack 전송, 고객 메시지, GAS 배포, 스케줄 변경을 수행하지 않는다.

## 검증 계획

구현은 테스트를 먼저 실패시키고 최소 변경으로 통과시킨다.

### 분류와 선택

- 모든 지원 `work_type`이 정확히 한 대분류에만 속한다.
- `schedule_register`와 `schedule_change`가 Hermes output부터 저장/조회/표시까지 보존된다.
- 기술형/완료 로그/`requires_human_action=false` 행은 목록, counts, digest 어디에도 나오지 않는다.
- 동일 안정 키의 메시지 여러 개가 카드 하나로 병합된다.
- limit보다 많은 행에서도 exact counts와 `omittedCount`가 맞다.

### Slack

- ordinary digest가 항상 메시지 하나, 최대 5개 하이라이트, action block 0개를 생성한다.
- 별도 daily reminder part를 생성하지 않는다.
- P0 payload에도 button/action ID/encoded value가 없다.
- 기술 오류명과 원문이 payload에 들어가지 않는다.
- 기존 durable claim/reconcile/settlement와 exact client ID 회귀가 통과한다.

### API와 액션

- 인증 없는 read/write, service key 없는 서버, extra input key를 거부한다.
- read 응답은 exact safe allowlist와 exact category counts만 포함한다.
- 인증 사용자가 만든 `heybilli:<uuid>` actor만 서버 측에서 기록된다.
- progress/snooze/request_resolve/ack_p0/dismiss가 version-CAS로 한 번만 적용된다.
- stale version과 중복 요청은 부작용 없이 최신 item 재조회로 수렴한다.
- 미확인 P0 snooze/dismiss 금지와 future snooze 검증을 보존한다.

### UI

- 기본 화면에 칸반 레인, 상시 체크박스, bulk bar가 없다.
- 세 상태 탭과 다섯 category chip의 건수/필터가 일치한다.
- 행에는 대분류와 구체 업무 유형이 동시에 보이고 중복 렌더링되지 않는다.
- 모바일 상세 sheet와 데스크톱 master-detail에서 같은 액션을 제공한다.
- loading, empty, unavailable, stale conflict 상태가 기술 정보 없이 구분된다.

### 전체 회귀

- Today Dashboard test와 production build
- Work Orchestrator unit/PGlite/schema suite
- Kakao bridge와 AI worker의 관련 action/digest/P0 suite
- package checks, TypeScript, changed-file syntax, diff check

## 완료 기준

- Slack에서 일반 업무 한 건당 카드나 버튼이 생기지 않는다.
- Slack에는 예약 다이제스트 한 개와 의미적으로 확정된 P0 한 줄 예외만 남는다.
- 헤이빌리 `후속조치` 첫 화면에서 사용자가 지금 할 일과 업무 성격을 바로 구분한다.
- 모든 실제 사용자 액션은 헤이빌리에서 실행되고 exact version readback으로 확인된다.
- `자동처리 오류`, 타임아웃, 재시도 같은 내부 상태가 사용자 목록과 Slack 보고에서 0건이다.
- 견적서 발송, 세금계산서 발행, 스케줄 확인, 스케줄 등록이 각각 올바른 대분류와 구체 배지로 표시된다.
- 자동 처리된 일은 사용자 업무를 만들지 않고, 남은 업무는 고객 요청 하나당 안정적인 카드 하나로 수렴한다.

## 비목표

- 이 변경 자체가 고객에게 답변, 견적서, 세금계산서 또는 알림톡을 임의 발송하지 않는다.
- 키워드 규칙으로 Hermes 판단을 대체하지 않는다.
- 과거 오류형 work item이나 Slack 메시지를 일괄 삭제하지 않는다.
- GAS 시트 구조와 컬럼 순서를 바꾸지 않는다.
- 브라우저에서 service-role key나 내부 운영 증거를 읽지 않는다.
- 별도 후속조치 앱을 새로 만들지 않는다. 기존 헤이빌리 `후속조치`를 올바른 역할로 재구성한다.
