# Work Orchestrator v2 Foundation Final Fix Report

## 작업 요약

- 요청 사항: foundation whole-review의 notification transition, cleanup lifecycle, completion gate, health naming 설명 지적을 TDD로 일괄 수정한다.
- 변경 내용:
  - `transitionNotification`이 fetch 전에 모든 `fromStates -> toState` edge를 계약으로 검증하도록 했다.
  - 불법/미지/mixed edge는 상태값을 노출하지 않는 일반 validation error로 실패하고 request를 0회 수행한다.
  - `cleanup_pending -> failed`를 notification delivery graph에서 제거했다. Cleanup 실패는 이후 단계에서 별도 `cleanup_state='failed'`와 `cleanup_error`로 표현하며 foundation에는 cleanup transport method를 추가하지 않았다.
  - foundation 계획의 Task 2 snippet과 completion gate를 같은 불변식으로 교정했다.
  - `shadowReady`가 connectivity probe가 아니라 shadow disabled 또는 local store client construction 상태임을 인접 주석으로 명시했다. Public health field와 동작은 변경하지 않았다.
- 배포/원격 작업: network, Docker, real/remote Supabase, Slack, Kakao, GAS, deploy, push를 수행하지 않았다.

## 원인과 수정 경계

- 계약 원인: `NOTIFICATION_TRANSITIONS.cleanup_pending`가 `failed`를 허용해 cleanup 결과를 이미 성공한 delivery lifecycle과 합쳤다.
- store 원인: `normalizeTransition`은 문자열 형식만 검증하고 `assertNotificationTransition`을 호출하지 않아 CAS filter가 있더라도 불법 state PATCH를 전송했다.
- 최소 수정: store가 normalization 직후 모든 source edge를 검증하고, 그 뒤에만 기존 `id + notification_state=in.(...)` 조건부 PATCH를 구성한다. CAS query와 응답 계약은 그대로다.

## TDD RED 증거

명령:

```powershell
node --test contracts.test.mjs supabase-store.test.mjs
```

작업 디렉터리: `tools/work-orchestrator-v2`

정확한 결과 요약:

```text
Exit code: 1
tests 21
pass 19
fail 2
cancelled 0
skipped 0
todo 0
```

정확한 실패:

```text
notification cleanup failure stays outside the delivery lifecycle
AssertionError [ERR_ASSERTION]: Missing expected exception.

transitionNotification rejects illegal and mixed source edges before any request
AssertionError [ERR_ASSERTION]: Missing expected rejection.
```

두 실패 모두 기존 결함을 직접 재현했다. 첫 테스트는 `cleanup_pending -> failed`가 허용되는 문제, 둘째 테스트는 `deleted -> delivering`이 reject되지 않고 fetch까지 도달하는 문제를 검출했다.

## 집중 GREEN 증거

같은 명령의 수정 후 정확한 결과 요약:

```text
Exit code: 0
tests 21
pass 21
fail 0
cancelled 0
skipped 0
todo 0
```

회귀 범위:

- `cleanup_pending -> failed`: reject
- `cleanup_pending -> deleted`: accept
- `failed -> delivering`: accept
- `pending,failed -> delivering`: 두 source edge가 모두 합법이므로 PATCH 1회, 기존 CAS filter 보존
- `deleted -> delivering`, `unknown -> delivering`, `pending,delivering -> delivering`: 일반 validation error, request 0회

## 최종 GREEN 검증

```text
npm.cmd --prefix tools\work-orchestrator-v2 test
Exit code: 0; tests 28; pass 28; fail 0

npm.cmd --prefix tools\kakao-dom-bridge test
Exit code: 0; tests 152; pass 152; fail 0

npm.cmd --prefix tools\work-orchestrator-v2 run check
Exit code: 0

npm.cmd --prefix tools\kakao-dom-bridge run check
Exit code: 0

git diff --check
Exit code: 0; git diff --check: PASS
```

Foundation 28-test suite에는 checked-in migration의 bounded PGlite PostgreSQL execution, catalog/ACL/security contract, bridge-to-RPC duplicate idempotency proof가 포함된다. Kakao suite는 기존 152개 전체 회귀를 실행했다.

## 변경 파일

- `tools/work-orchestrator-v2/contracts.mjs`
- `tools/work-orchestrator-v2/contracts.test.mjs`
- `tools/work-orchestrator-v2/supabase-store.mjs`
- `tools/work-orchestrator-v2/supabase-store.test.mjs`
- `tools/kakao-dom-bridge/server.mjs`
- `docs/superpowers/plans/2026-08-29-work-orchestrator-v2-foundation.md`
- `.superpowers/sdd/2026-08-29-work-orchestrator-v2-foundation/final-fix-report.md`

## 셀프 리뷰 결과

- ✅ 통과 항목: 원 요청 네 가지 지적 재대조, 모든 source edge 사전검증, zero-request failure, generic safe error, conditional CAS 보존, cleanup/delivery lifecycle 분리, 계획 snippet/gate 일치, public health field 불변, 전체 테스트/check/diff 검증.
- ✅ 기존 기능 보호: delivery 실패의 `failed -> delivering` retry와 정상 cleanup의 `cleanup_pending -> deleted`를 유지했다. Bridge runtime behavior와 health JSON shape는 변경하지 않았다.
- ✅ 보안/민감정보: validation error에 input state, URL, headers, credential, response body를 포함하지 않는다. 보고서에도 secret 값이 없다.
- ✅ GAS/시트/웹앱: GAS, 시트 구조/열, 트리거, doGet/doPost, frontend, 배포 버전을 변경하지 않았다.
- 🔧 자체 수정한 항목: `shadowReady` 의미를 현재 boolean 계산식에 정확히 맞춘 주석으로 제한해 연결성 보장으로 오해되지 않게 했다.
- ⚠️ 사용자 확인 필요: 없음. Production/remote gate는 아래 concern으로 명시하며 이번 작업에서는 의도적으로 실행하지 않았다.

## Concerns / 남은 gate

- Bounded PGlite proof는 offline next-phase code work에만 충분하다.
- Production migration, remote feature activation, deployment, cutover 전에는 PGlite가 아닌 real Supabase stack의 clean reset, PostgREST table/RPC 실행, effective service-role-only ACL, local/linked migration-history 일치 증거가 필수다.
- 이 작업은 production migration과 feature activation을 명시적으로 금지한 상태를 유지한다.
