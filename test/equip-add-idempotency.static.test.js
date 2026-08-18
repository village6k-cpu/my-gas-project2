// 회귀 방지: addEquip/addEquips/scheduleAddEquip가 멱등 키 없이 append만 해서
// 응답 유실 뒤 재클릭이 같은 장비 행을 두 번 추가하던 문제 (onsiteAddon만 보호되어 있었음).
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const backend = fs.readFileSync(path.resolve(__dirname, '..', 'checkAvailability.js'), 'utf8');
const api = fs.readFileSync(path.resolve(__dirname, '..', 'sheetAPI.js'), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`${name} incomplete`);
}

const addFn = extractFunction(backend, 'dashboardAddEquipments');
assert(/beginDashboardMutation_\(addProps,\s*tid,\s*addMutationId,\s*'addEquip'/.test(addFn),
  'dashboardAddEquipments가 mutationId 멱등 로그를 사용해야 한다');
assert(/commitDashboardMutation_\(addProps,\s*tid,\s*addMutationId,\s*'addEquip'\)/.test(addFn),
  'append 확정 후 멱등 마커를 커밋해야 한다');
assert(/dashboardAddRecent_/.test(addFn),
  '짧은 창의 동일 내용 재클릭도 지문 기반으로 걸러야 한다');
// 지문 dedupe는 멱등 수단이 없는 레거시 호출에만 — onsiteAddon(자체 예약 멱등)과
// mutationId 요청까지 지문으로 막으면 의도한 동일 내용 재추가가 hollow 성공으로 삼켜진다
assert(/var legacyAddDedupe = !addMutationId && !options\.idempotencyReservation && !lockAlreadyHeld;/.test(addFn),
  '지문 dedupe는 레거시 경로에만 적용해야 한다');
assert(/if \(legacyAddDedupe\) \{[\s\S]{0,200}dashboardAddRecent_/.test(addFn),
  '지문 조회가 legacyAddDedupe 게이트 안에 있어야 한다');
// pending 중복은 재실행(중복 행 위험) 대신 BUSY로 물러난다
assert(/addMutation\.duplicate[\s\S]{0,400}retryable:\s*true/.test(addFn),
  'pending 중복은 fail-closed(BUSY 재시도)여야 한다');

// 라우트 4곳이 mutationId를 전달
const addRoutes = ['case "addEquip":', 'case "addEquips":', 'case "scheduleAddEquip":', 'case "scheduleAddEquips":'];
addRoutes.forEach((marker) => {
  const at = api.indexOf(marker);
  assert(at >= 0, marker + ' 라우트 필요');
  const slice = api.slice(at, at + 900);
  assert(/mutationId:/.test(slice), marker + ' 라우트가 mutationId를 전달해야 한다');
});

console.log('# equipment add idempotency checks passed');
