// 확인요청 목록 60초 캐시 무효화 회귀 방지:
// API 경로(doScheduleAction/run/registerAsync)는 무효화했지만, 시트 직접 편집(onEdit
// H/N열)과 자동 정리(autoClearRequests)는 무효화하지 않아 헤이빌리 확인요청 화면이
// 낡은 O열 상태를 최대 60초(+Vercel 12초) 더 보여줬다.
// 추가: onEdit '등록'도 실행 전 내구 마커(등록대기+백업 트리거)를 남겨 하드킬에도 복구된다.
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

const editFn = extractFunction('handleScheduleEdit');
assert(/invalidateConfirmListCache_/.test(editFn),
  '시트 직접 편집(H/N열)도 확인요청 목록 캐시를 무효화해야 한다');
assert(/markRegisterQueued_\(sheet, row\);[\s\S]{0,300}registerByReqID\(sheet, row\)/.test(editFn),
  'onEdit 등록도 실행 전 내구 마커를 남겨야 한다 (하드킬 복구)');
assert(/enqueuePendingRegister_/.test(editFn),
  'onEdit 등록은 백업 트리거를 함께 예약해야 한다');

const clearFn = extractFunction('autoClearRequests');
assert(/invalidateConfirmListCache_/.test(clearFn),
  '자동 정리도 목록 캐시를 무효화해야 한다');

console.log('# confirm list cache invalidation checks passed');
