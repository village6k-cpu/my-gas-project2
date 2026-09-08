'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(path.join(__dirname, '..', 'checkAvailability.js'), 'utf8');

const period = ['2026-09-12', '11:00', '2026-09-13', '11:00'];
const request = (items = [['카메라 세트', 3], ['표준 줌렌즈', 1]], overrides = {}) => ({
  예약자명: '테스트 예약자', 연락처: '010-0000-0001',
  반출일: period[0], 반출시간: period[1], 반납일: period[2], 반납시간: period[3],
  장비명원문보존: true, 장비: items.map(([이름, 수량]) => ({이름, 수량})), ...overrides
});
const contract = (id = '260907-001', overrides = {}) => Object.assign([
  id, '테스트 예약자', '010-0000-0001', '', ...period, 1, '예약'
], overrides);
const schedule = (name, qty, overrides = {}) => Object.assign([
  'SC-test', '260907-001', '', name, qty, ...period, '반출전', '', 1000
], overrides);
const pending = (overrides = {}) => Object.assign([
  'RQ-260907-001', ...period, '이전 장비', 1, '', '', '', '테스트 예약자',
  '010-0000-0001', '단골', '', '', '', '보존 메모', '보존 추가요청'
], overrides);

class Sheet {
  constructor(rows = [], displayRows) { this.rows = rows; this.displayRows = displayRows; this.writes = 0; }
  getLastRow() { return this.rows.length + 1; }
  getRange(row, col, count = 1, width = 1) {
    const sheet = this;
    const select = rows => Array.from({length: count}, (_, i) =>
      Array.from({length: width}, (_, j) => rows[row - 2 + i]?.[col - 1 + j] ?? ''));
    return {
      getValues: () => select(sheet.rows),
      getDisplayValues: () => select(sheet.displayRows || sheet.rows).map(r => r.map(v => v instanceof Date ? '' : String(v))),
      getDisplayValue: () => String(select(sheet.rows)[0][0]),
      setNumberFormat() { return this; }, clearDataValidations() { return this; },
      setFontWeight() { return this; }, setBackground() { return this; },
      setValue(v) { return this.setValues([[v]]); },
      setValues(values) {
        sheet.writes++;
        values.forEach((r,i) => r.forEach((v,j) => {
          if (!sheet.rows[row - 2 + i]) sheet.rows[row - 2 + i] = Array(18).fill('');
          sheet.rows[row - 2 + i][col - 1 + j] = v;
        }));
        return this;
      }
    };
  }
  deleteRows(row, count) { this.writes++; this.rows.splice(row - 2, count); }
  deleteRow(row) { this.deleteRows(row, 1); }
}
function harness({contracts = [contract()], schedules = [schedule('카메라 세트', 3), schedule('표준 줌렌즈', 1)], requests = [], contractDisplay, scheduleDisplay} = {}) {
  const sheets = {'확인요청': new Sheet(requests), '계약마스터': new Sheet(contracts, contractDisplay), '스케줄상세': new Sheet(schedules, scheduleDisplay)};
  const context = {Date, console, SpreadsheetApp: {getActiveSpreadsheet: () => ({getSheetByName: name => sheets[name] || null}), flush() {}},
    Utilities: {formatDate: (value, tz, format) => format === 'HH:mm' ? value.toISOString().slice(11,16) : value.toISOString().slice(0,10)}};
  vm.runInNewContext(source, context);
  context._findConfirmRequestCustomerDbMatches_ = () => [];
  context._reserveNextConfirmRequestId_ = () => 'RQ-260907-002';
  context._processByReqID = () => {};
  context.getSetComponents = () => [];
  context._applyConfirmedReservationExactSetComponents_ = () => {};
  return {context, sheets, insert: req => context._insertAndCheckRequest(req)};
}

test('registered whole booking is authoritative without inventing or writing an RQ', () => {
  const h = harness(); const result = h.insert(request());
  assert.equal(result.alreadyRegistered, true);
  assert.equal(result.matchedRegisteredTradeId, '260907-001');
  assert.equal(Object.hasOwn(result, 'reqID'), false);
  assert.equal(result.results.length, 2);
  assert.equal(h.sheets['확인요청'].writes, 0);
});
test('already applied additional items reconcile as a subset with quantities', () => {
  const h = harness({schedules: [schedule('카메라 세트', 3), schedule('배터리', 3), schedule('리그', 3)]});
  assert.equal(h.insert(request([['배터리', 3], ['리그', 3]])).alreadyRegistered, true);
  assert.equal(h.sheets['확인요청'].writes, 0);
});
test('known partial period fields reconcile while blank return time stays unknown', () => {
  const h = harness();
  assert.equal(h.insert(request(undefined, {반납시간: '', 일정미완성: true})).alreadyRegistered, true);
  assert.equal(h.sheets['확인요청'].writes, 0);
});
test('mixed Date/display cells and Korean time display reconcile', () => {
  const raw = contract(undefined, {4: new Date('2026-09-12T00:00:00Z'), 5: new Date('1899-12-30T11:00:00Z')});
  const display = contract(undefined, {4:'2026. 9. 12', 5:'오전 11:00'});
  const h = harness({contracts:[raw], contractDisplay:[display]});
  assert.equal(h.insert(request()).alreadyRegistered, true);
});
for (const [label, overrides, items] of [
  ['different return date', {반납일:'2026-09-14'}, undefined],
  ['different pickup time', {반출시간:'12:00'}, undefined],
  ['contradicting phone', {연락처:'010-0000-0002'}, undefined],
  ['real new item', {}, [['새 장비',1]]],
  ['quantity increase', {}, [['카메라 세트',4]]]
]) test(`${label} remains a new inquiry`, () => {
  const h = harness(); const result = h.insert(request(items, overrides));
  assert.equal(result.alreadyRegistered, undefined);
  assert.equal(result.reqID, 'RQ-260907-002');
  assert.ok(h.sheets['확인요청'].writes > 0);
});
test('set component inventory is not counted as independently added equipment', () => {
  const h = harness({schedules:[schedule('카메라 세트',3,{2:'카메라 세트'}), schedule('배터리',3,{2:'카메라 세트'})]});
  assert.equal(h.insert(request([['배터리',3]])).alreadyRegistered, undefined);
});
test('cancelled and incompatible schedule rows cannot prove existing coverage', () => {
  for (const overrides of [{9:'취소'}, {7:'2026-09-14'}]) {
    const h = harness({schedules:[schedule('카메라 세트',3,overrides)]});
    assert.equal(h.insert(request([['카메라 세트',3]])).alreadyRegistered, undefined);
  }
});
test('ambiguous registered targets stop before creating another request', () => {
  const h = harness({contracts:[contract(),contract('260907-002')]});
  assert.throws(() => h.insert(request(undefined,{반납시간:'',일정미완성:true})), e => e.code === 'registered_reconciliation_ambiguous');
  assert.equal(h.sheets['확인요청'].writes, 0);
});

const evidence = {customer_request:'장비 구성을 새 계획으로 바꿔 주세요', conversation_revision:'revision-1', conversation_evidence_hash:'a'.repeat(64), customer_message_ids:['message-1']};
function revision(overrides = {}) { return {target_scope:'pending_request',request_id:'RQ-260907-001',expected_before:[{name:'이전 장비',quantity:1}],expected_period:{start_date:period[0],start_time:period[1],end_date:period[2],end_time:period[3]},expected_set_components:[],source_evidence:evidence,...overrides}; }

test('same-room final form completes an exact nickname and blank contact with explicit AI identity evidence', () => {
  const h = harness({contracts:[],requests:[pending({10:'지윤',11:''})]});
  const finalEvidence = {...evidence,customer_request:'김지윤 / 010-0000-0002 / DJI 마이크 / F21C'};
  h.insert(request([['DJI 마이크',1],['F21C',1]], {예약자명:'김지윤',연락처:'010-0000-0002',
    customer_requested_pending_revision:revision({source_evidence:finalEvidence,
      customer_identity_update:{expected_name:'지윤',expected_phone:'',name:'김지윤',phone:'010-0000-0002'}})}));
  assert.equal(h.sheets['확인요청'].rows[0][10],'김지윤');
  assert.equal(h.sheets['확인요청'].rows[0][11],'010-0000-0002');
});

for (const label of ['contradicting known contact','stale nickname','unsupported final identity']) {
  test(`identity completion rejects ${label} before writes`, () => {
    const h=harness({contracts:[],requests:[pending({10:'지윤',11:label==='contradicting known contact'?'01000000001':''})]});
    assert.throws(()=>h.insert(request([['새 장비',1]],{예약자명:'김지윤',연락처:'01000000002',
      customer_requested_pending_revision:revision({source_evidence:{...evidence,customer_request:label==='unsupported final identity'?'예약할게요':'김지윤 01000000002'},
        customer_identity_update:{expected_name:label==='stale nickname'?'다른 이름':'지윤',expected_phone:label==='contradicting known contact'?'01000000001':'',name:'김지윤',phone:'01000000002'}})})));
    assert.equal(h.sheets['확인요청'].writes,0);
  });
}
test('same-period changed pending plan without a typed revision writes nothing', () => {
  const h = harness({contracts:[],requests:[pending()]});
  assert.throws(() => h.insert(request([['새 장비',1]])), e => e.code === 'pending_revision_required' && e.existingRequestId === 'RQ-260907-001');
  assert.equal(h.sheets['확인요청'].writes, 0);
});
test('customer-requested pending revision replaces exact baseline and preserves commercial fields', () => {
  const h = harness({contracts:[],requests:[pending()]});
  const result = h.insert(request([['새 장비',1]], {customer_requested_pending_revision:revision()}));
  assert.equal(result.customer_requested_pending_revision.target_request_id,'RQ-260907-001');
  assert.equal(result.staff_confirmed_pending_mutation, undefined);
  assert.deepEqual(Array.from(new Set(h.sheets['확인요청'].rows.map(r=>r[0]))),['RQ-260907-002']);
  const final = h.sheets['확인요청'].rows[0];
  assert.equal(final[12], '단골'); assert.equal(final[16],'보존 메모'); assert.equal(final[17],'보존 추가요청');
});
for (const [label, rowOverrides, fenceOverrides, requestOverrides] of [
  ['registered target',{15:'260907-001'}, {}, {}],
  ['cancelled target',{14:'거절'}, {}, {}],
  ['cancellation status',{14:'취소'}, {}, {}],
  ['registration command waiting for trigger',{13:'등록'}, {}, {}],
  ['stale plan', {}, {expected_before:[{name:'다른 장비',quantity:1}]}, {}],
  ['stale period', {}, {expected_period:{start_date:period[0],start_time:'12:00',end_date:period[2],end_time:period[3]}}, {}],
  ['missing source evidence', {}, {source_evidence:{}}, {}],
  ['different customer phone', {}, {}, {연락처:'010-0000-0002'}]
]) test(`customer revision rejects ${label} without writes`, () => {
  const h = harness({contracts:[],requests:[pending(rowOverrides)]});
  assert.throws(() => h.insert(request([['새 장비',1]],{customer_requested_pending_revision:revision(fenceOverrides),...requestOverrides})));
  assert.equal(h.sheets['확인요청'].writes,0);
});
test('customer revision preserves the raw phone value when the caller omits it', () => {
  const h = harness({contracts:[],requests:[pending()]});
  const input = request([['새 장비',1]],{customer_requested_pending_revision:revision()});
  delete input.연락처;
  h.insert(input);
  assert.equal(h.sheets['확인요청'].rows[0][11],'010-0000-0001');
});
test('customer revision uses the supplied phone for identity but preserves stored phone formatting', () => {
  const h = harness({contracts:[],requests:[pending()]});
  h.insert(request([['새 장비',1]],{연락처:'01000000001',customer_requested_pending_revision:revision()}));
  assert.equal(h.sheets['확인요청'].rows[0][11],'010-0000-0001');
});
test('customer revision preserves blank contact and discount instead of filling CustomerDB defaults', () => {
  const h = harness({contracts:[],requests:[pending({11:'',12:''})]});
  h.context._findConfirmRequestCustomerDbMatches_ = () => [{phone:'010-0000-0001',phoneKey:'1000000001',discount:'단골'}];
  const input = request([['새 장비',1]],{customer_requested_pending_revision:revision()});
  delete input.연락처;
  h.insert(input);
  assert.equal(h.sheets['확인요청'].rows[0][11],'');
  assert.equal(h.sheets['확인요청'].rows[0][12],'');
});
test('independent rental preserves pending exact-plan dedupe', () => {
  const h = harness({contracts:[],requests:[pending()]});
  const result = h.insert(request([['이전 장비',1]],{inquiry_disposition:'independent_rental',inquiry_source_evidence:evidence}));
  assert.equal(result.reqID,'RQ-260907-001');
  assert.equal(result.duplicate,true);
  assert.equal(h.sheets['확인요청'].writes,0);
});
test('independent rental replay across room revisions creates only one pending inquiry', () => {
  const h=harness();
  const input=request(undefined,{inquiry_disposition:'independent_rental',inquiry_source_evidence:evidence});
  const first=h.insert(input);const writes=h.sheets['확인요청'].writes;
  const replay=h.insert({...input,inquiry_source_evidence:{...evidence,conversation_revision:'revision-2'}});
  assert.equal(first.reqID,'RQ-260907-002');assert.equal(replay.reqID,first.reqID);
  assert.equal(replay.duplicate,true);assert.equal(h.sheets['확인요청'].writes,writes);
});
test('independent rental cannot bypass an existing changed-plan pending inquiry', () => {
  const h=harness({contracts:[],requests:[pending()]});
  assert.throws(()=>h.insert(request([['새 장비',1]],{inquiry_disposition:'independent_rental',inquiry_source_evidence:evidence})),e=>e.code==='pending_revision_required');
  assert.equal(h.sheets['확인요청'].writes,0);
});
test('customer revision cannot replace a complete schedule with missing fields', () => {
  const h = harness({contracts:[],requests:[pending()]});
  assert.throws(() => h.insert(request([['새 장비',1]],{반납시간:'',일정미완성:true,customer_requested_pending_revision:revision()})));
  assert.equal(h.sheets['확인요청'].writes,0);
});

test('customer can revise equipment while retaining genuinely unknown schedule fields', () => {
  const h=harness({contracts:[],requests:[pending({1:'',2:'',3:'',4:''})]});
  const expected_period={start_date:'',start_time:'',end_date:'',end_time:''};
  const result=h.insert(request([['새 장비',1]],{반출일:'',반출시간:'',반납일:'',반납시간:'',일정미완성:true,
    customer_requested_pending_revision:revision({expected_period})}));
  assert.equal(result.customer_requested_pending_revision.target_request_id,'RQ-260907-001');
  assert.equal(result.scheduleComplete,false);
  assert.equal(h.sheets['확인요청'].rows[0][5],'새 장비');
  assert.deepEqual(h.sheets['확인요청'].rows[0].slice(1,5),['','','','']);
});
test('customer revision fills a precisely matched incomplete baseline period without guessing', () => {
  const h=harness({contracts:[],requests:[pending({3:'',4:''})]});
  const baseline={start_date:period[0],start_time:period[1],end_date:'',end_time:''};
  const result=h.insert(request([['새 장비',1]],{customer_requested_pending_revision:revision({expected_period:baseline})}));
  assert.deepEqual(JSON.parse(JSON.stringify(result.customer_requested_pending_revision.expected_period)),baseline);
  assert.deepEqual(h.sheets['확인요청'].rows[0].slice(1,5),period);
  assert.equal(h.sheets['확인요청'].rows[0][5],'새 장비');
});
test('customer partial baseline requires explicit blanks, never omitted fields or a blank mismatch', () => {
  for(const baseline of [
    {start_date:period[0],start_time:period[1],end_date:''},
    {start_date:period[0],start_time:period[1],end_date:'',end_time:''}
  ]) {
    const h=harness({contracts:[],requests:[pending()]});
    assert.throws(()=>h.insert(request([['새 장비',1]],{customer_requested_pending_revision:revision({expected_period:baseline})})));
    assert.equal(h.sheets['확인요청'].writes,0);
  }
});
test('customer revision preserves the source if availability processing fails', () => {
  const h = harness({contracts:[],requests:[pending()]});
  h.context._processByReqID = () => {throw new Error('synthetic availability failure');};
  assert.throws(() => h.insert(request([['새 장비',1]],{customer_requested_pending_revision:revision()})),/synthetic availability failure/);
  assert.deepEqual(h.sheets['확인요청'].rows,[pending()]);
});
test('customer revision rejects source drift during staging and preserves the manual change', () => {
  const h = harness({contracts:[],requests:[pending()]});
  h.context._processByReqID = () => {h.sheets['확인요청'].rows[0][5] = '동시 변경 장비';};
  assert.throws(() => h.insert(request([['새 장비',1]],{customer_requested_pending_revision:revision()})),/baseline/);
  assert.deepEqual(h.sheets['확인요청'].rows,[pending({5:'동시 변경 장비'})]);
});
test('customer revision verifies staged full plan before deleting its source', () => {
  const h = harness({contracts:[],requests:[pending()]});
  h.context._processByReqID = () => {h.sheets['확인요청'].rows[1][5] = '예상 외 장비';};
  assert.throws(() => h.insert(request([['새 장비',1]],{customer_requested_pending_revision:revision()})),e => e.code === 'pending_revision_readback_mismatch');
  assert.deepEqual(h.sheets['확인요청'].rows,[pending()]);
});
test('customer revision projects retained manual set components with changed set quantity', () => {
  const h = harness({contracts:[],requests:[pending({5:'카메라 세트'}),pending({1:'',2:'',3:'',4:'',5:'선택된 배터리',6:2,10:'',11:'',12:'',16:'[세트]카메라 세트',17:''})]});
  let projection;
  h.context._applyConfirmedReservationExactSetComponents_ = (sheet,id,components) => {
    projection = components;
    components.forEach(c => sheet.rows.push(pending({0:id,1:'',2:'',3:'',4:'',5:c.component_item,6:c.quantity,10:'',11:'',12:'',16:'[세트]'+c.set_item,17:''})));
  };
  const result = h.insert(request([['카메라 세트',3]],{customer_requested_pending_revision:revision({expected_before:[{name:'카메라 세트',quantity:1}],expected_set_components:[{set_item:'카메라 세트',component_item:'선택된 배터리',quantity:2}]})}));
  assert.deepEqual(JSON.parse(JSON.stringify(projection)),[{set_item:'카메라 세트',component_item:'선택된 배터리',quantity:6}]);
  assert.equal(result.customer_requested_pending_revision.final_plan[0].quantity,3);
});

const apiSource = fs.readFileSync(path.join(__dirname,'..','sheetAPI.js'),'utf8');
function api(result, failure) {
  const ctx = {console, insertAndCheckRequest: () => {if (failure) throw failure; return result;}};
  vm.runInNewContext(apiSource,ctx);
  return ctx.runFunction('insertAndCheckRequest',{args:{}});
}
test('API keeps registered receipts distinguishable from RQ receipts', () => {
  const result = api({alreadyRegistered:true,duplicate:true,matchedRegisteredTradeId:'260907-001',results:[]});
  assert.equal(result.alreadyRegistered,true);
  assert.equal(Object.hasOwn(result,'reqID'),false);
});
test('API returns customer authority label and exact replacement receipt', () => {
  const result = api({reqID:'RQ-260907-002',results:[],customer_requested_pending_revision:{target_scope:'pending_request',target_request_id:'RQ-260907-001',replacement_request_id:'RQ-260907-002',expected_before:[],expected_period:{},final_plan:[],final_period:{}}});
  assert.equal(result.customer_requested_pending_revision.target_request_id,'RQ-260907-001');
  assert.equal(result.staff_confirmed_pending_mutation,undefined);
});
test('API preserves no-write revision conflict and uncertain cutover fields', () => {
  for (const error of [Object.assign(new Error('revision required'),{code:'pending_revision_required',existingRequestId:'RQ-260907-001',existingRequestIds:['RQ-260907-001']}),Object.assign(new Error('flush lost'),{code:'pending_request_cutover_uncertain',effectiveRequestId:'RQ-260907-002',replacedReqIDs:['RQ-260907-001'],appliedStages:['pending_request_replacement']})]) {
    const result = api(null,error);
    assert.equal(result.code,error.code);
    if (error.existingRequestId) assert.equal(result.existingRequestId,error.existingRequestId);
    if (error.effectiveRequestId) assert.equal(result.effectiveRequestId,error.effectiveRequestId);
  }
});
test('explicit independently intended same-period rental requires bound source evidence shape', () => {
  const h = harness();
  assert.equal(h.insert(request(undefined,{inquiry_disposition:'independent_rental',inquiry_source_evidence:evidence})).reqID,'RQ-260907-002');
  const invalid = harness();
  assert.throws(() => invalid.insert(request(undefined,{inquiry_disposition:'independent_rental'})));
  assert.equal(invalid.sheets['확인요청'].writes,0);
});
