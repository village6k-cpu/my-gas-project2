'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const period = { startDate: '2026-11-02', startTime: '20:00', endDate: '2026-11-05', endTime: '02:00' };
const marker = '[승인회차:v1 회차=2.5 기간=2026-11-02T20:00/2026-11-05T02:00]';
function load(ctx, file) { vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), ctx); }
function context() {
  const ctx = vm.createContext({ console });
  const file = path.join(root, 'approvedBillingRounds.js');
  if (fs.existsSync(file)) load(ctx, 'approvedBillingRounds.js');
  return ctx;
}
function registration() {
  return { confirmed: true, target_scope: 'pending_request', request_id: 'RQ-261101-001',
    source_evidence: { customer_request: '카메라 1대 2.5회차 요청', staff_confirmation: '2.5회차 승인',
      conversation_revision: 1, conversation_evidence_hash: 'a'.repeat(64), customer_message_ids: ['c1'], staff_message_ids: ['s1'] },
    expected_before: [{ name: '카메라', quantity: 1 }], desired_after: [{ name: '카메라', quantity: 1 }],
    expected_set_components: [], set_component_selections: [],
    expected_period: { start_date: period.startDate, start_time: period.startTime, end_date: period.endDate, end_time: period.endTime },
    desired_period: { start_date: period.startDate, start_time: period.startTime, end_date: period.endDate, end_time: period.endTime },
    billing_rounds: 2.5 };
}
test('source-bound approved half rounds survive worker, Windows and GAS normalization without coercion', async () => {
  const worker = await import('../tools/ai-browser-worker/staff-confirmed-registration.mjs');
  const { normalizeConfirmedReservationCommit } = require('../scripts/windows/village-confirm-request.js');
  const ctx = context(); load(ctx, 'checkAvailability.js');
  const input = registration();
  assert.equal(worker.validateStaffConfirmedRegistration(input, { roomRevision: 1 }).valid, true);
  const normalized = normalizeConfirmedReservationCommit(input);
  assert.equal(normalized.billing_rounds, 2.5);
  assert.equal(ctx._normalizeConfirmedReservationCommit_(normalized).billing_rounds, 2.5);
  for (const invalid of ['2.5', 2.25, 0.5, 0, 99.5, Infinity, NaN, null]) {
    const value = { ...input, billing_rounds: invalid };
    assert.equal(worker.validateStaffConfirmedRegistration(value, { roomRevision: 1 }).valid, false);
    assert.throws(() => normalizeConfirmedReservationCommit(value));
    assert.throws(() => ctx._normalizeConfirmedReservationCommit_(value));
  }
});

function generator({ note = marker, rounds = 2.5, endTime = period.endTime, pendingPrice = false, rawTimeCells = false } = {}) {
  const ctx = context(), cells = new Map(), formulas = new Map(), events = [];
  function range(row, col, height = 1, width = 1) {
    if (typeof row === 'string') { const m = row.match(/^([A-Z]+)(\d+)$/); col = [...m[1]].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0); row = Number(m[2]); }
    const r = {
      setValue(v) { cells.set(`${row}:${col}`, v); return r; },
      setValues(values) { values.forEach((a, i) => a.forEach((v, j) => cells.set(`${row + i}:${col + j}`, v))); return r; },
      setFormula(v) { formulas.set(`${row}:${col}`, v); return r; },
      setFormulas(values) { values.forEach((a, i) => a.forEach((v, j) => formulas.set(`${row + i}:${col + j}`, v))); return r; },
      getDataValidations() { return Array.from({ length: height }, () => Array(width).fill(null)); },
      getDisplayValue() { return String(cells.get(`${row}:${col}`) ?? ''); },
      getValue() { return cells.get(`${row}:${col}`) ?? ''; },
    };
    for (const method of ['clearContent', 'setNumberFormat', 'setDataValidations', 'setDataValidation', 'setBackgrounds', 'setFontWeights']) r[method] = () => r;
    return r;
  }
  const ws = { getRange: range, getLastRow: () => 50, getLastColumn: () => 13 };
  const row = ['261101-001', '합성고객', 'synthetic-contact', '', period.startDate, period.startTime, period.endDate, endTime, rounds, '예약', '일반', note];
  const displayRow = row.map(String);
  if (rawTimeCells) { row[5] = new Date('1899-12-30T11:27:52Z'); row[7] = new Date('1899-12-29T17:27:52Z'); }
  const item = ['261101-001-01', '261101-001', '', '카메라', 2, period.startDate, period.startTime, period.endDate, endTime, '대기', pendingPrice ? '[단가확인필요]' : '', pendingPrice ? '' : 10000];
  const readSheet = data => ({ getLastRow: () => 2, getRange: (_r, c, _h, w) => ({ getValues: () => [data.slice(c - 1, c - 1 + w)], getDisplayValues: () => [(data === row ? displayRow : data.map(String)).slice(c - 1, c - 1 + w)] }) });
  const ss = { getSheetByName: name => name === '계약마스터' ? readSheet(row) : readSheet(item) };
  ctx.PropertiesService = { getScriptProperties: () => ({ getProperty: key => key === 'CONTRACT_TEMPLATE_ID' ? 'template' : '' }) };
  const rule = { requireValueInList() { return this; }, setAllowInvalid() { return this; }, setHelpText() { return this; }, build() { return {}; } };
  ctx.SpreadsheetApp = { openById: () => ({ getSheets: () => [ws] }), newDataValidation: () => rule, flush() {} };
  ctx.DriveApp = { getFileById: () => ({ makeCopy() { events.push('copy'); return { getId: () => 'generated', getUrl: () => 'https://example.test/contract', setSharing() {} }; } }), Access: {}, Permission: {} };
  ctx.Logger = { log() {} };
  load(ctx, 'checkAvailability.js'); load(ctx, 'generatecontract.js');
  ctx.findTemplateRows = () => ({ lessee1: 8, lessee2: 9, rentalStart: 11, itemStart: 15, itemRows: 2 });
  ctx.repairContractItemHeaders_ = () => {};
  ctx.findValueColAfterLabel_ = (_ws, _r, _label, fallback) => fallback;
  ctx.expandContractItemTableIfNeeded_ = (_ws, layout) => layout;
  ctx.findContractPaymentRefs_ = () => ({ preDiscountCell: 'C40', addDiscountCell: 'C41', longDiscountCell: 'C42', couponDiscountCell: 'C43', totalBeforeDiscountCell: 'G44', discountedAmountCell: 'G45', finalAmountCell: 'H47' });
  ctx.applyManualEntryAutofill_ = () => {};
  ctx.updateContractLink = () => { events.push('ledger'); return { success: true }; };
  // Real generation writes item multipliers and formulas; Sheets evaluates those externally.
  // Assert the actual cells/formulas, not an invented mock final amount.
  return { run: () => ctx.generateContractFile(ss, '261101-001', ''), ctx, ss, cells, formulas, events };
}
test('real contract generation uses period-bound approved 2.5 in item amounts and existing 10% tier', () => {
  const h = generator(); h.run();
  assert.equal(h.cells.get('15:5'), 2.5);
  assert.equal(h.cells.get('15:4'), 2);
  assert.equal(h.cells.get('15:6'), 10000);
  assert.equal(h.formulas.get('15:7'), '=D15*E15*F15');
  assert.equal(h.cells.get('42:3'), '10%');
});
test('no marker keeps legacy 54-hour policy even when I contains another historical number', () => {
  const h = generator({ note: '직원 메모 보존', rounds: 1 }); h.run();
  assert.equal(h.cells.get('15:5'), 3);
  assert.equal(h.cells.get('42:3'), '20%');
});
test('stale period, mismatched I, duplicate or damaged approval fail before document copy', () => {
  for (const options of [{ endTime: '03:00' }, { rounds: 3 }, { note: marker + '\n' + marker }, { note: '[승인회차:v1 손상]' }]) {
    const h = generator(options);
    assert.throws(h.run, /승인회차|approved.*round/i);
    assert.deepEqual(h.events, []);
  }
});
test('approved half rounds do not bypass pending unit-price document hold', () => {
  const h = generator({ pendingPrice: true });
  assert.throws(h.run, /단가확인필요/);
  assert.deepEqual(h.events, []);
});
test('stale approval cannot trash the previous document or clear its ledger link during regeneration', () => {
  const h = generator({ endTime: '03:00' });
  h.ctx.LockService = { getScriptLock: () => ({ hasLock: () => false, tryLock: () => true, releaseLock() {} }) };
  h.ctx.Utilities = { getUuid: () => 'synthetic-regen' };
  h.ctx.PropertiesService = { getScriptProperties: () => ({ getProperty: key => key === 'CONTRACT_TEMPLATE_ID' ? 'template' : null, setProperty() {}, deleteProperty() {} }) };
  h.ctx.trashContractFilesForTrade_ = () => h.events.push('trash');
  assert.throws(() => h.ctx.deleteAndRegenerateContract(h.ss, '261101-001', ''), /승인회차/);
  assert.deepEqual(h.events, []);
});

test('regeneration and same-period approval guards use displayed F/H rather than 1899 raw Date offsets', () => {
  const h = generator({ rawTimeCells: true });
  h.ctx.LockService = { getScriptLock: () => ({ hasLock: () => false, tryLock: () => true, releaseLock() {} }) };
  h.ctx.Utilities = { getUuid: () => 'synthetic-regen', formatDate: () => { throw Error('raw historical time must not be reformatted'); } };
  h.ctx.PropertiesService = { getScriptProperties: () => ({ getProperty: key => key === 'CONTRACT_TEMPLATE_ID' ? 'template' : null, setProperty() {}, deleteProperty() {} }) };
  h.ctx.trashContractFilesForTrade_ = () => h.events.push('trash');
  h.ctx.deleteAndRegenerateContract(h.ss, '261101-001', '');
  assert.equal(h.cells.get('15:5'), 2.5);
  assert.deepEqual(h.events, ['trash', 'copy', 'ledger']);
  const range = h.ss.getSheetByName('계약마스터').getRange(2, 1, 1, 12);
  assert.equal(h.ctx.assertApprovedBillingDateChange_(range.getValues()[0], period, range.getDisplayValues()[0]), 2.5);
});
test('explicit marker update preserves unrelated contract note bytes and rejects invalid fractional input', () => {
  const ctx = context();
  assert.equal(typeof ctx.writeApprovedBillingRoundsNote_, 'function');
  const original = '인수 메모\n  여백 보존  ';
  const note = ctx.writeApprovedBillingRoundsNote_(original, 2.5, period);
  assert.equal(note, original + '\n' + marker);
  assert.equal(ctx.readApprovedBillingRounds_(note, 2.5, period), 2.5);
  assert.equal(ctx.readApprovedBillingRounds_('그대로', 8, period), null);
  const changed = ctx.writeApprovedBillingRoundsNote_(note, 3.5, period);
  assert.equal(changed, original + '\n' + marker.replace('회차=2.5', '회차=3.5'));
  assert.equal(ctx.writeApprovedBillingRoundsNote_(0, 2.5, period), '0\n' + marker);
  for (const invalid of ['2.5', 2.25, 0.5, 99.5, null]) assert.throws(() => ctx.writeApprovedBillingRoundsNote_('', invalid, period));
});

test('actual initial contract row writes approved I and durable period-bound L in the same batch', () => {
  const source = fs.readFileSync(path.join(root, 'checkAvailability.js'), 'utf8');
  const begin = source.indexOf('  // ── 회차 계산', source.indexOf('function registerByReqID('));
  const end = source.indexOf('    // ── 스케줄상세에 장비 등록', begin);
  assert.ok(begin > 0 && end > begin);
  const ctx = context(), writes = [];
  Object.assign(ctx, { 반출일str: period.startDate, 반출시간str: period.startTime, 반납일str: period.endDate, 반납시간str: period.endTime,
    예약자명: '합성고객', 연락처: 'synthetic', 할인유형: '일반', 거래ID: '261101-001',
    hasTransferredConfirmedLock: true, registerOptions: { billingRounds: 2.5 },
    mergeMode: false, registrationPriceNotes: {}, contractLastRow: 1,
    contractSheet: { getRange: (row, col, height, width) => ({ setValues(values) { writes.push({ row, col, height, width, values: JSON.parse(JSON.stringify(values)) }); } }) },
    parseDT: (date, time) => new Date(date + 'T' + time + ':00+09:00') });
  vm.runInContext(source.slice(begin, end), ctx);
  assert.equal(writes.length, 1);
  assert.deepEqual([writes[0].row, writes[0].col, writes[0].height, writes[0].width], [2, 1, 1, 12]);
  assert.equal(writes[0].values[0][8], 2.5);
  assert.equal(writes[0].values[0][11], marker);
});

test('actual authoritative reader exposes validated approved billing and rejects a stale marker', () => {
  const ctx = context(); load(ctx, 'checkAvailability.js');
  const row = ['261101-001', '합성고객', 'synthetic', '', period.startDate, period.startTime, period.endDate, period.endTime, 2.5, '예약', '일반', marker];
  const schedule = ['261101-001-01', '261101-001', '', '카메라', 1, period.startDate, period.startTime, period.endDate, period.endTime, '대기', '', 10000];
  const sheet = data => ({ getLastRow: () => 2, getRange: (_r, c, _h, w) => ({ getValues: () => [data.slice(c - 1, c - 1 + w)], getDisplayValues: () => [data.slice(c - 1, c - 1 + w).map(String)] }) });
  ctx.SpreadsheetApp = { getActiveSpreadsheet: () => ({ getSheetByName: name => sheet(name === '계약마스터' ? row : schedule) }) };
  assert.equal(ctx.readRegisteredTradeCorrectionState_('261101-001', false).contract.billingRounds, 2.5);
  row[8] = 3;
  assert.throws(() => ctx.readRegisteredTradeCorrectionState_('261101-001', false), /승인회차/);
});

function dateMutationFixture() {
  const ctx = context(), writes = [], tid = '261101-001';
  const contract = [tid, '합성고객', 'synthetic', '', period.startDate, period.startTime, period.endDate, period.endTime, 2.5, '예약', '일반', marker];
  const schedule = [tid + '-01', tid, '', '카메라', 1, period.startDate, period.startTime, period.endDate, period.endTime, '대기', '', 10000];
  function sheet(name, row) {
    return { getLastRow: () => row ? 2 : 1, getRange: (_r, col, _h = 1, width = 1) => {
      const range = { getValues: () => [row.slice(col - 1, col - 1 + width)], getDisplayValues: () => [row.slice(col - 1, col - 1 + width).map(String)], getValue: () => row[col - 1], getDisplayValue: () => String(row[col - 1]), setNumberFormat() { return this; }, setNumberFormats() { return this; }, setValue(value) { writes.push({ name, col, value }); throw Error('unexpected business write'); }, setValues(value) { writes.push({ name, col, value }); throw Error('unexpected business write'); } };
      return range;
    } };
  }
  const sheets = { '계약마스터': sheet('contract', contract), '스케줄상세': sheet('schedule', schedule), '장비마스터': sheet('equipment', null) };
  ctx.SpreadsheetApp = { getActiveSpreadsheet: () => ({ getSheetByName: name => sheets[name] }) };
  ctx.LockService = { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) };
  ctx.PropertiesService = { getScriptProperties: () => ({ getProperty: () => null }) };
  ctx.Utilities = { formatDate: (date, _zone, format) => format === 'yyyy-MM-dd' ? date.toISOString().slice(0, 10) : date.toISOString().slice(11, 16) };
  load(ctx, 'checkAvailability.js'); load(ctx, 'generatecontract.js');
  ctx.dashboardTradeMutationLeaseError_ = () => null;
  ctx.supaMarkTradeDirty_ = () => {};
  ctx.invalidateDashboardCacheForTrade_ = () => {};
  return { ctx, writes, tid, sheet };
}
test('official date correction rejects period-bound approval before any ledger or schedule mutation', () => {
  const h = dateMutationFixture();
  assert.throws(() => h.ctx.changeRegisteredTradeDates({ tradeId: h.tid, newStartDate: period.startDate, newEndDate: '2026-11-06', startTime: period.startTime, endTime: period.endTime }), /승인회차/);
  assert.deepEqual(h.writes, []);
});
test('dashboard and timeline date writers cannot silently carry approved rounds to another period', () => {
  let h = dateMutationFixture();
  const result = h.ctx.dashboardUpdateTradeDetails(h.tid, { customerName: '합성고객', customerPhone: 'synthetic', company: '', checkoutDate: period.startDate, checkoutTime: period.startTime, returnDate: '2026-11-06', returnTime: period.endTime });
  assert.match(result.error || '', /승인회차/);
  assert.deepEqual(h.writes, []);
  h = dateMutationFixture();
  assert.throws(() => h.ctx.updateScheduleTime(2, '2026-11-02T20:00:00Z', '2026-11-06T02:00:00Z', '[2]', h.tid), /승인회차/);
  assert.deepEqual(h.writes, []);
});
test('legacy request date action cannot mutate an approved contract period', () => {
  const h = dateMutationFixture();
  const request = h.sheet('request', [h.tid, period.startDate, period.startTime, '2026-11-06', period.endTime]);
  assert.throws(() => h.ctx.changeDatesForContract(request, 2), /승인회차/);
  assert.deepEqual(h.writes, []);
});

test('extension rejects stale approved billing before any availability or ledger mutation', () => {
  const h = dateMutationFixture();
  assert.throws(() => h.ctx.extendRegisteredTrade({ tradeId: h.tid, endDate: '2026-11-06', endTime: period.endTime }), /승인회차/);
  assert.deepEqual(h.writes, []);
});

test('real billing merge detector fences schedule-period match even when contract dates differ', () => {
  const ctx = context(); load(ctx, 'checkAvailability.js');
  const tid = '261101-001';
  const contract = [tid, '합성고객', '010-0000-0000', '', '2026-11-01', '09:00', '2026-11-02', '09:00', 1, '예약'];
  const schedule = [tid + '-01', tid, '', '카메라', 1, period.startDate, period.startTime, period.endDate, period.endTime, '대기', '', 10000, '합성고객'];
  const sheet = row => ({ getLastRow: () => 2, getRange: () => ({ getDisplayValues: () => [row] }) });
  const ss = { getSheetByName: name => sheet(name === '계약마스터' ? contract : schedule) };
  const req = { 예약자명: '합성고객', 연락처: '01000000000', 반출일: period.startDate, 반출시간: period.startTime, 반납일: period.endDate, 반납시간: period.endTime };
  assert.deepEqual(Array.from(ctx._findConfirmedBillingMergeCandidates_(ss, req)), [tid]);
  for (const [column, value] of [[9, '반납완료'], [2, '01011111111']]) {
    const before = contract[column]; contract[column] = value;
    assert.deepEqual(Array.from(ctx._findConfirmedBillingMergeCandidates_(ss, req)), []);
    contract[column] = before;
  }
});

test('worker never acknowledges a registered trade that omitted or changed approved billing rounds', async () => {
  const { executeVillageConfirmedReservationCommit } = await import('../tools/ai-browser-worker/staff-confirmed-registration.mjs');
  for (const replacedIds of [[], ['RQ-261101-001']]) {
  for (const billingRounds of [2.5, 3, undefined]) {
    const input = registration(); let posts = 0;
    const result = { schema: 'village-confirmed-reservation-commit-result/v1', success: true, status: 'ok',
      request_id: input.request_id, effective_request_id: 'RQ-261101-002', trade_id: '261101-001', replaced_request_ids: replacedIds,
      final_plan: input.desired_after, final_period: input.desired_period, final_set_components: [], customerNotificationAttempted: false, customerNotificationSent: false,
      authoritative: { request: { reqID: 'RQ-261101-002', tradeIds: ['261101-001'], topLevelEquipItems: input.desired_after, setComponentItems: [], ...period },
        registered_trade: { contract: { ...period, rounds: 2.5, ...(billingRounds !== undefined ? { billingRounds } : {}) }, schedule: { rows: [] } } } };
    const receipt = await executeVillageConfirmedReservationCommit({ job: { job_id: 'half-rounds', room_key: 'synthetic-room', room_revision: 1 }, roomRevision: 1,
      registration: input, dependencies: { operationFence: { operation_id: 'synthetic-once' }, commitConfirmedReservation: async () => { posts++; return result; } } });
    assert.equal(receipt.status, billingRounds === 2.5 ? 'ok' : 'partial_success');
    assert.equal(posts, 1);
  }
  }
});
