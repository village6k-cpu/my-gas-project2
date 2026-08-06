// N열 '추가/삭제'가 세트 구성품을 등록 경로(registerByReqID)와 동일하게 다루는지 검증.
// 회귀: 추가는 헤더 1행만 쓰고 구성품을 전개하지 않아 재고 점유·체크리스트가 누락됐고,
// 삭제는 헤더만 지워 구성품이 고아로 남아 재고를 계속 점유했다.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const backend = fs.readFileSync(path.resolve(__dirname, '..', 'checkAvailability.js'), 'utf8');

function extractFunction(name) {
  const start = backend.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const bodyStart = backend.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < backend.length; i += 1) {
    if (backend[i] === '{') depth += 1;
    if (backend[i] === '}') {
      depth -= 1;
      if (depth === 0) return backend.slice(start, i + 1);
    }
  }
  throw new Error(`${name} incomplete`);
}

const addBody = extractFunction('addEquipmentToContract');
const removeBody = extractFunction('removeEquipmentFromContract');

// ── 추가: 세트면 구성품까지 전개 기록 ──
assert(/getSetComponents\(장비명, setSheet\)/.test(addBody), '추가 시 세트 구성품 조회 필요');
assert(/세트구성품\.forEach|구성품\.forEach/.test(addBody), '추가 시 구성품 행 기록 필요');
assert(/rowsToWrite\.length, 13/.test(addBody), '헤더+구성품을 일괄 기록해야 한다');

// ── 삭제: 헤더(C==D)를 지울 때 구성품(C==세트명)도 함께 삭제 ──
assert(/schedData\[i\]\[2\] === 장비명 && schedData\[i\]\[3\] !== 장비명/.test(removeBody), '삭제 시 구성품 행 식별 필요');
assert(/rowsToDelete/.test(removeBody), '삭제 대상 행 목록 필요');
assert(/sort\(\s*\(?\s*a,\s*b\s*\)?\s*=>\s*b\s*-\s*a\s*\)/.test(removeBody), '뒤에서부터 삭제해야 행 번호가 안 밀린다');
assert(/removeScheduleIds:\s*deletedScheduleIds/.test(removeBody), '구조 투영에 삭제된 전체 스케줄ID 전달 필요');

console.log('# contract add/remove set-component checks passed');
