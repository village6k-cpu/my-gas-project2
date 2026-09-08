'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../checkAvailability.js'), 'utf8');

function row(name, qty, note = '', status = '') {
  const r = Array(18).fill('');
  r[0] = 'RQ-260827-008'; r[5] = name; r[6] = qty; r[14] = status; r[16] = note;
  return r;
}
function fixture(rows, realWriter = false) {
  let writes = 0;
  const sheet = { getLastRow: () => rows.length + 1, getRange: (r, c, nr, nc) => {
    const range = { getValues: () => rows,
      setValues: (values) => { writes++; values.forEach((line, i) => line.forEach((v, j) => { rows[r - 2 + i][c - 1 + j] = v; })); return range; },
      setValue: (v) => { writes++; rows[r - 2][c - 1] = v; return range; },
      setNumberFormat: () => range, setFontWeight: () => range, setBackground: () => range };
    return range;
  } };
  const ctx = { console, SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: () => sheet }) } };
  vm.runInNewContext(source, ctx);
  ctx._assertConfirmRequestEditableRows_ = () => {};
  if (!realWriter) ctx._updateConfirmRequestRowsInPlace_ = () => { writes++; return { recheck: false, changed: true }; };
  return { update: (items, reductions) => ctx._updateRequestUnderLock_({
    reqID: 'RQ-260827-008', 장비: items, equipmentReductions: reductions,
  }), writes: () => writes };
}
const camera = { 이름: '소니 FX6 풀세트', 수량: 1 };
const light = (qty) => ({ 이름: '시네로이드 CFL-800', 수량: qty });
const before = () => [row(camera.이름, 1), row(light(2).이름, 2), row('A스탠드', 2, '[세트]시네로이드 CFL-800')];
const ack = (afterQty) => ({ name: light(2).이름, beforeQty: 2, afterQty, reason: '고객이 명시적으로 변경 요청' });

test('full replacement cannot silently drop a previously requested set', () => {
  const f = fixture(before());
  assert.throws(() => f.update([camera]), /시네로이드 CFL-800.*2.*0/);
  assert.equal(f.writes(), 0);
});

test('in-place inherited component notes cannot mask a standalone quantity reduction', () => {
  const rows = [row('SET', 1), row('LIGHT', 2, '[세트]SET'), row('LIGHT', 2)];
  const f = fixture(rows, true);
  const items = [{ 이름: 'SET', 수량: 1 }, { 이름: 'LIGHT', 수량: 3 }, { 이름: 'LIGHT', 수량: 1 }];
  assert.throws(() => f.update(items), /LIGHT.*2.*1/);
  assert.equal(f.writes(), 0);
  f.update(items, [{ name: 'LIGHT', beforeQty: 2, afterQty: 1, reason: '고객 요청' }]);
  assert.equal(rows[1][16], '[세트]SET');
  assert.equal(rows[2][6], 1);
});
test('quantity 2 to 1 needs exact reduction evidence before any write', () => {
  const f = fixture(before());
  assert.throws(() => f.update([camera, light(1)]), /시네로이드 CFL-800.*2.*1/);
  assert.equal(f.writes(), 0);
});
test('complete top-level plan allows component re-expansion without false omissions', () => {
  const f = fixture(before()); f.update([camera, light(2)]); assert.equal(f.writes(), 1);
});
test('explicit exact reduction is accepted, stale quantities and blank reasons are rejected', () => {
  const f = fixture(before()); f.update([camera, light(1)], [ack(1)]); assert.equal(f.writes(), 1);
  for (const bad of [{ ...ack(1), beforeQty: 1 }, { ...ack(1), afterQty: 0 }, { ...ack(1), reason: '' }]) {
    const g = fixture(before()); assert.throws(() => g.update([camera, light(1)], [bad]), /equipmentReductions|감소/); assert.equal(g.writes(), 0);
  }
});
test('duplicate top-level lines are summed; component quantities do not mask reductions', () => {
  const f = fixture([row('V마운트 배터리', 4, '[세트]소니 FX6 풀세트'), row('V마운트 배터리', 1), row('V마운트 배터리', 1)]);
  assert.throws(() => f.update([{ 이름: 'V마운트 배터리', 수량: 1, 비고: '' }]), /2.*1/);
  assert.equal(f.writes(), 0);
});
test('previously excluded equipment can be omitted but new exclusion is a reduction', () => {
  fixture([row(camera.이름, 1), row(light(2).이름, 2, '', '제외')]).update([camera]);
  const f = fixture(before()); assert.throws(() => f.update([camera, { ...light(2), 제외: true }]), /2.*0/);
  assert.equal(f.writes(), 0);
});
