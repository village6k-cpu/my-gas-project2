// 회귀 방지:
// 1) updateEquipmentCheck가 전역 ScriptLock을 쥔 채 외부 스프레드시트 openByUrl(1~3초)을
//    수행해 다른 카드 저장(반출/반납/체크)까지 전부 BUSY로 튕기던 병목.
// 2) updateScheduleTime/updateScheduleStatus가 클라이언트가 캡처한 행 번호를 검증 없이
//    그대로 써서, 등록/합침/삭제로 행이 밀리면 다른 거래의 날짜·상태를 덮어쓰던 사고.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const backend = fs.readFileSync(path.resolve(__dirname, '..', 'checkAvailability.js'), 'utf8');
const api = fs.readFileSync(path.resolve(__dirname, '..', 'sheetAPI.js'), 'utf8');
const docsTimeline = fs.readFileSync(path.resolve(__dirname, '..', 'docs', 'timeline.html'), 'utf8');
const gasTimeline = fs.readFileSync(path.resolve(__dirname, '..', 'timeline.html'), 'utf8');

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

// ── 1) updateEquipmentCheck: 전역 락 대신 거래별 lease + 원자적 append ──
const equipCheck = extractFunction(backend, 'updateEquipmentCheck');
assert(/claimDashboardAuxMutation_\(tradeId,\s*'equipmentCheck'\)/.test(equipCheck),
  'updateEquipmentCheck는 거래별 lease claim을 사용해야 한다');
assert(/releaseDashboardAuxMutation_\(/.test(equipCheck),
  'updateEquipmentCheck는 lease를 해제해야 한다');
assert(!/LockService\.getScriptLock\(\)/.test(equipCheck),
  '외부 시트 open을 전역 ScriptLock 안에서 수행하면 안 된다 (claim 헬퍼가 짧게만 잡음)');
assert(/appendRow\(/.test(equipCheck),
  '신규 행 생성은 원자적 appendRow를 사용해야 한다 (락 없는 병렬 append 충돌 방지)');

// ── 2) updateScheduleTime: 락 + 거래ID 재검증 ──
const updTime = extractFunction(backend, 'updateScheduleTime');
assert(/LockService\.getScriptLock\(\)/.test(updTime), 'updateScheduleTime에 락이 필요하다');
assert(/expectedTradeId/.test(updTime) && /STALE_ROWS/.test(updTime),
  '행 번호가 밀렸을 때 다른 거래를 덮어쓰지 않도록 거래ID 재검증이 필요하다');

const updStatus = extractFunction(backend, 'updateScheduleStatus');
assert(/expectedTradeId/.test(updStatus) && /STALE_ROWS/.test(updStatus),
  'updateScheduleStatus도 거래ID 재검증이 필요하다');

// ── 3) 라우트/클라이언트가 tid를 전달 ──
assert(/case "updateTime":[\s\S]{0,700}params\.tid \|\| postBody\.tid/.test(api),
  'updateTime 라우트가 tid를 전달해야 한다');
assert(/case "updateStatus":[\s\S]{0,700}params\.tid \|\| postBody\.tid/.test(api),
  'updateStatus 라우트가 tid를 전달해야 한다');
assert(/var tidParam = item\.거래ID[\s\S]{0,300}action=updateTime[\s\S]{0,300}riParam \+ tidParam/.test(docsTimeline),
  'docs 타임라인이 updateTime에 거래ID를 보내야 한다');
assert(/updateScheduleTime\(original\.rowIndex,\s*item\.start,\s*item\.end,\s*riJSON,\s*original\.거래ID/.test(gasTimeline),
  'GAS 타임라인도 updateScheduleTime에 거래ID를 보내야 한다');

console.log('# gas lock scope & row identity checks passed');
