const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const source = fs.readFileSync(require.resolve('../checkAvailability.js'), 'utf8');
const methodCode = source.slice(source.indexOf('function updateTradePaymentMethod('), source.indexOf('/**\n * 오늘일정 웹앱에서 발행처 상호', source.indexOf('function applyTradePaymentSideEffects_(')));
const proofCode = source.slice(source.indexOf('function updateTradeProofField('), source.indexOf('function requestTradeEstimate('));
function fixture(enabled) {
  const writes = [], claims = [], dirty = [];
  const sheet = {
    getLastRow: () => 2, getLastColumn: () => 13,
    getRange: (row, col) => ({
      getDisplayValues: () => row === 1 ? [['거래ID']] : [['T1']],
      getDataValidation: () => null,
      setValue: value => writes.push({row,col,value}),
      setValues: value => writes.push({row,col,value: JSON.parse(JSON.stringify(value))}),
    }),
  };
  const ctx = vm.createContext({
    ...(enabled === undefined ? {} : { paymentLedgerEnabled_: () => enabled }),
    getTradePaymentOptions_: () => ['카드결제','현금','계좌이체(VAT포함)'],
    claimDashboardAuxMutation_: (...args) => { claims.push(args); return 'claim'; },
    releaseDashboardAuxMutation_: () => {},
    PropertiesService: { getScriptProperties: () => ({getProperty: () => 'configured'}) },
    SpreadsheetApp: { openByUrl: () => ({getSheetByName: () => sheet}) },
    _findHeaderCol_: () => 5, paymentOptionsFromRule_: () => [],
    getVillageTradeSheet_: () => sheet, findVillageTradeRow_: () => 2,
    invalidateDashboardTradeExtraCache_: () => {}, touchDashboardSearchCacheVersion_: () => {},
    invalidateDashboardCache: () => {}, supaMarkTradeDirty_: id => dirty.push(id),
    requestTradeProofIssue: () => ({success:true,issued:true}),
  });
  vm.runInContext(methodCode + '\n' + proofCode, ctx);
  return {ctx,writes,claims,dirty,sheet};
}

test('ledger mode permits payment method metadata without implicit paid/proof writes', () => {
  for (const method of ['카드결제','현금','계좌이체(VAT포함)','']) {
    const f = fixture(true);
    const result = f.ctx.updateTradePaymentMethod('T1', method);
    assert.equal(result.success,true);
    assert.equal(result.wroteSheet,true);
    assert.equal(result.sideEffects.managedByPaymentLedger,true);
    assert.match(result.note,/수납 관리/);
    assert.deepEqual(f.writes,[{row:2,col:10,value:method}]);
    assert.deepEqual(f.dirty,['T1']);
  }
});

test('direct side-effect helper also refuses to mark ledger-managed trades paid', () => {
  const f = fixture(true);
  assert.equal(f.ctx.applyTradePaymentSideEffects_(f.sheet,2,'카드결제').applied,false);
  assert.deepEqual(f.writes,[]);
});

test('all direct deposit status edits fail before locking or writing in ledger mode', () => {
  for (const status of ['입금완료','미입금','부분입금','환불','']) {
    const f = fixture(true);
    const result = f.ctx.updateTradeProofField('T1','depositStatus',status);
    assert.equal(result.success,false);
    assert.match(result.error,/수납 관리/);
    assert.deepEqual(f.writes,[]);
    assert.deepEqual(f.claims,[]);
  }
});

test('proof metadata and invoice issuance remain available in ledger mode', () => {
  const f = fixture(true);
  assert.equal(f.ctx.updateTradeProofField('T1','proofType','미발행').success,true);
  assert.deepEqual(f.writes,[{row:2,col:11,value:'미발행'}]);
  assert.equal(f.ctx.updateTradeProofField('T1','issueStatus','발행요청').issued,true);
});

test('disabled or absent flag preserves legacy paid side effects and direct status edit', () => {
  for (const enabled of [false,undefined]) {
    const f=fixture(enabled);
    const result=f.ctx.updateTradePaymentMethod('T1','카드결제');
    assert.equal(result.success,true);
    assert.equal(result.sideEffects.applied,true);
    assert.deepEqual(f.writes,[{row:2,col:10,value:'카드결제'},{row:2,col:11,value:[['미발행','발행완료','입금완료']]}]);
    assert.equal(f.ctx.updateTradeProofField('T1','depositStatus','환불').success,true);
    assert.deepEqual(f.writes.at(-1),{row:2,col:13,value:'환불'});
  }
});
