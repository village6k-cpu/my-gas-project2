// Supabase 투영 권위 회귀 방지:
// I1) 제외→추가로 스케줄ID가 재사용될 때 이전 제외의 removed_at tombstone이
//     merge-duplicates upsert에 승계되어 새 장비가 앱에서 영영 안 보이던 문제.
// I3) 시트 실사기록 returnMemo가 1분 flush마다 앱이 쓴 trades.note_checkin을
//     덮어써 방금 저장한 특이사항이 옛 메모로 롤백되던 문제.
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const supabase = fs.readFileSync(path.resolve(__dirname, '..', 'supabaseSync.js'), 'utf8');
const syncTs = fs.readFileSync(
  path.resolve(__dirname, '..', 'apps', 'today-dashboard', 'lib', 'data', 'sync.ts'), 'utf8');

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

// I1: 반출 전 insert 경로는 removed_at tombstone을 명시적으로 해제한다
const flushFn = extractFunction(supabase, 'flushDirtyToSupabase');
assert(/removed_at:\s*null/.test(flushFn),
  '시트에 현존하는 반출 전 행은 removed_at: null로 tombstone을 해제해야 한다');

// I3: 앱 노트 정본 보호
assert(/function supaDropOverwritingNotes_\(/.test(supabase),
  'note_checkin 덮어쓰기 방지 헬퍼가 필요하다');
assert(/supaDropOverwritingNotes_\(cfg,\s*built\.trades\)/.test(flushFn),
  'flush는 upsert 전에 앱 노트 덮어쓰기를 제거해야 한다');
const dropFn = extractFunction(supabase, 'supaDropOverwritingNotes_');
assert(/delete row\.note_checkin/.test(dropFn) && /catch/.test(dropFn),
  '현재값 조회 실패 시에도 보수적으로 노트를 보내지 않아야 한다');

// I3 앱측: GAS 재조회 병합에서 앱 노트가 시트 returnMemo보다 우선
assert(/noteCheckin:\s*base\.noteCheckin\s*\|\|\s*it\.returnMemo/.test(syncTs),
  'sync 병합은 앱 노트를 우선하고 returnMemo는 시드로만 써야 한다');
assert(!/noteCheckin:\s*it\.returnMemo\s*\|\|\s*base\.noteCheckin/.test(syncTs),
  '옛 returnMemo 우선 병합이 남아 있으면 안 된다');

console.log('# supabase projection authority checks passed');
