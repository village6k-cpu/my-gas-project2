'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

// Exercise the real insert -> process -> expansion -> availability/formatting path.
// Only Google services and the monotonic request ID allocator are replaced.
class Sheet {
  constructor(rows = []) { this.rows = [['header'], ...rows]; this.styles = []; }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return 18; }
  getParent() { return this.parent; }
  insertRowsAfter(row, count) { this.rows.splice(row, 0, ...Array.from({length: count}, () => [])); this.styles.splice(row, 0, ...Array.from({length: count}, () => [])); }
  deleteRows(row, count) { this.rows.splice(row - 1, count); this.styles.splice(row - 1, count); }
  deleteRow(row) { this.deleteRows(row, 1); }
  getRange(row, col, count = 1, width = 1) {
    if (typeof row === 'string') { const m = row.match(/^A(\d+):A(\d+)$/); return this.getRange(+m[1], 1, +m[2] - +m[1] + 1); }
    const s = this;
    const values = () => Array.from({length: count}, (_, i) => Array.from({length: width}, (_, j) => s.rows[row - 1 + i]?.[col - 1 + j] ?? ''));
    const each = fn => { for (let i = 0; i < count; i++) for (let j = 0; j < width; j++) { s.rows[row-1+i] ??= []; s.styles[row-1+i] ??= []; s.styles[row-1+i][col-1+j] ??= {}; fn(row-1+i, col-1+j); } };
    const style = (key, value) => { each((r,c) => { s.styles[r][c][key] = value; }); return range; };
    const range = {
      getValues: values, getDisplayValues: () => values().map(r => r.map(String)),
      getValue: () => values()[0][0], getDisplayValue: () => String(values()[0][0]),
      setValues(v) {
        each((r,c) => {
          const rule = s.styles[r][c].validation;
          const value = v[r-row+1][c-col+1];
          if (rule?.allowInvalid === false && value !== '' && !rule.values.includes(String(value))) {
            throw new Error(`strict validation rejected row ${r+1} col ${c+1}: ${value}`);
          }
        });
        each((r,c) => { s.rows[r][c] = v[r-row+1][c-col+1]; }); return this;
      },
      setValue(v) { return this.setValues([[v]]); },
      clearContent() { each((r,c) => { s.rows[r][c] = ''; }); return this; },
      setFontWeight: v => style('weight', v), setBackground: v => style('background', v?.toLowerCase() ?? null),
      getBackground: () => s.styles[row-1]?.[col-1]?.background || '#ffffff',
      setDataValidation: v => style('validation', v), clearDataValidations: () => style('validation', null),
      setNumberFormat: v => style('format', v), setNote: v => style('note', v),
      getNote: () => s.styles[row-1]?.[col-1]?.note || '', clearNote: () => style('note', '')
    };
    return range;
  }
}
function harness() {
  const equip = (name, total) => ['', '', '', name, total, '', '', '', '', '', '', 10000];
  const sheets = {
    '확인요청': new Sheet(), '계약마스터': new Sheet(), '스케줄상세': new Sheet(),
    '장비마스터': new Sheet([equip('카메라 바디', 6), equip('메모리', 12), equip('렌즈', 4)]),
    '세트마스터': new Sheet([
      ['카메라 세트', '카메라 바디', 1, '', '', 'Y'],
      ['카메라 세트', '메모리', 2, '', '', 'Y'],
      ['카메라 세트', '배터리 / 앞캡 / 충전기', 1, '', '', 'Y'],
      ['렌즈', '', 1, '', '', 'Y']
    ]),
    // Included manifests are deliberately absent from the independent catalog.
    '목록': new Sheet(['카메라 세트', '카메라 바디', '메모리', '렌즈'].map(n => [n]))
  };
  const ss = {getSheetByName: name => sheets[name] || null};
  Object.values(sheets).forEach(s => { s.parent = ss; });
  const rule = () => {
    const state = {allowInvalid: true, values: []};
    const r = {
      requireValueInRange(range) { state.values = range.getDisplayValues().flat(); return r; },
      requireValueInList(values) { state.values = values; return r; },
      setAllowInvalid(value) { state.allowInvalid = value; return r; },
      setHelpText() { return r; }, build: () => ({...state})
    };
    return r;
  };
  const ctx = {Date, console, Logger: {log() {}}, SpreadsheetApp: {getActiveSpreadsheet: () => ss, flush() {}, newDataValidation: rule},
    Utilities: {formatDate: v => v.toISOString().slice(0,10)}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'checkAvailability.js'), 'utf8'), ctx);
  ctx._reserveNextConfirmRequestId_ = () => 'RQ-260908-001';
  const input = {예약자명:'테스트 예약자', 연락처:'01000000001', 장비명원문보존:true,
    반출일:'2026-09-11', 반출시간:'18:00', 반납일:'2026-09-13', 반납시간:'18:00',
    장비:[{이름:'카메라 세트', 수량:2},{이름:'렌즈', 수량:1}]};
  return {ctx, sheet:sheets['확인요청'], insert: overrides => ctx._insertAndCheckRequest({...input, ...overrides})};
}
const shape = h => h.sheet.rows.slice(1).map((r,i) => ({name:r[5],qty:r[6],confirm:r[7],tag:r[16] || '',background:h.sheet.styles[i+1]?.[5]?.background,weight:h.sheet.styles[i+1]?.[5]?.weight}));

test('unknown dates preserve the same canonical set expansion and formatting as a complete request', () => {
  const complete = harness(); complete.insert();
  const partial = harness(); const result = partial.insert({반출일:'',반출시간:'',반납일:'',반납시간:'',일정미완성:true});
  assert.equal(complete.sheet.rows.length, 6);
  assert.deepEqual(shape(partial), shape(complete));
  assert.deepEqual(partial.sheet.rows[1].slice(1,5), ['','','','']);
  assert.equal(result.scheduleComplete, false);
  assert.equal(partial.sheet.rows[1][8], '세트');
  assert.equal(partial.sheet.rows[4][8], 'ℹ️ 기본구성');
  for (const row of [2,3,5]) {
    assert.equal(partial.sheet.rows[row][8], '❓ 일정 확인 필요');
    assert.match(partial.sheet.rows[row][9], /반출일.*반출시간.*반납일.*반납시간/);
  }
  assert.ok(!partial.sheet.rows.some(r => /✅|가용\d/.test(String(r[8]) + String(r[9]))));
});

test('rechecking a formerly flat incomplete request expands once and retains known partial fields', () => {
  const h = harness();
  h.insert({반출일:'',반출시간:'18:00',반납일:'2026-09-13',반납시간:'',일정미완성:true});
  h.ctx._processByReqID(h.sheet, 2);
  assert.equal(h.sheet.rows.length, 6);
  assert.deepEqual(h.sheet.rows[1].slice(1,5), ['','18:00','2026-09-13','']);
  assert.equal(h.sheet.rows[2][9], '반출일·반납시간 확인 필요');
  h.sheet.getRange(2,2,1,4).setValues([['2026-09-11','18:00','2026-09-13','18:00']]);
  h.ctx._processByReqID(h.sheet, 2);
  assert.equal(h.sheet.rows.length, 6);
  assert.match(h.sheet.rows[2][8], /✅ 가용/);
  assert.equal(h.sheet.rows[4][8], 'ℹ️ 기본구성');
});

const exactComponents = () => [
  {set_item:'카메라 세트',component_item:'카메라 바디',quantity:2},
  {set_item:'카메라 세트',component_item:'메모리',quantity:4},
  {set_item:'카메라 세트',component_item:'배터리 / 앞캡 / 충전기',quantity:2}
];

test('exact projection preserves freshly expanded included manifests under strict catalog validation', () => {
  const h = harness();
  const result = h.insert({staff_confirmed_exact_set_components:exactComponents()});
  assert.equal(result.reqID, 'RQ-260908-001');
  assert.equal(h.sheet.rows[4][5], '배터리 / 앞캡 / 충전기');
  assert.equal(h.sheet.rows[4][8], 'ℹ️ 기본구성');
  assert.equal(h.sheet.styles[4][5].validation.allowInvalid, false);
  const before = JSON.stringify({rows:h.sheet.rows,styles:h.sheet.styles});
  const repeated = h.ctx._applyConfirmedReservationExactSetComponents_(h.sheet, result.reqID, exactComponents().reverse());
  assert.equal(repeated.applied, 0);
  assert.equal(JSON.stringify({rows:h.sheet.rows,styles:h.sheet.styles}), before);
});

test('an exact catalog substitution changes only the selected component and rechecks availability', () => {
  const h = harness(); h.insert();
  const desired = exactComponents(); desired[1] = {...desired[1],component_item:'렌즈',quantity:1};
  const result = h.ctx._applyConfirmedReservationExactSetComponents_(h.sheet,'RQ-260908-001',desired);
  assert.equal(result.applied, 1);
  assert.equal(h.sheet.rows[3][5], '렌즈');
  assert.equal(h.sheet.rows[3][6], 1);
  assert.match(h.sheet.rows[3][8], /✅ 가용/);
  assert.equal(h.sheet.rows[4][8], 'ℹ️ 기본구성');
  const before = JSON.stringify(h.sheet.rows);
  desired[1].component_item = '미보유 대체품';
  assert.throws(() => h.ctx._applyConfirmedReservationExactSetComponents_(h.sheet,'RQ-260908-001',desired), /not an exact catalog item/);
  assert.equal(JSON.stringify(h.sheet.rows), before);
});
