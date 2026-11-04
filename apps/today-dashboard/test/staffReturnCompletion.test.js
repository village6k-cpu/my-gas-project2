const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

function harness() {
  const source = fs.readFileSync(path.join(__dirname, '../lib/data/store.ts'), 'utf8');
  const start = source.indexOf('export async function toggleReturn(');
  const end = source.indexOf('\n// ── 품목 체크 원장 쓰기 신뢰화', start);
  const code = ts.transpileModule(source.slice(start, end), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const packing = { phase: 'draft', version: 2, entries: [{ id: 'cable', qty: 2, checked: false }], counts: {} };
  const trade = { tradeId: '261031-006', returnDone: false, contractStatus: '예약', packing, returnCounts: {} };
  const module = { exports: {} };
  const outbox = [];
  const context = { module, exports: module.exports, state: { trades: [trade] }, activeTradeTransitions: new Set(), pendingRemoveEquipmentTrades: new Set(),
    packingBlockers: () => [{ scheduleId: 'packing:cable', missing: 2, over: 0 }],
    returnCompletionBlockers: () => [{ scheduleId: 'packing:cable', missing: 2, over: 0 }],
    isSupabase: true, writeBackEnabled: true, writeBackDisabledReason: '',
    createLedgerMutationId: () => 'staff-completion', putCompletionMutationOutbox: entry => outbox.push(entry),
    mutateTrade: (_id, fn) => { context.state.trades = context.state.trades.map(fn); },
    flashSave() {}, scheduleCompletionMutationReplay_() {}, Date, set() {}, toastSeq: 0 };
  vm.runInNewContext(code, context);
  return { toggle: module.exports.toggleReturn, context, outbox, packing };
}

test('직원이 직접 완료하면 초안·구성품 개별 수량 없이도 즉시 완료하며 기록을 꾸미지 않는다', async () => {
  const h = harness();
  const before = JSON.stringify(h.packing);
  const result = await h.toggle('261031-006', { force: true });
  assert.equal(result.ok, true);
  assert.equal(h.context.state.trades[0].returnDone, true);
  assert.equal(h.context.state.trades[0].contractStatus, '반납완료');
  assert.equal(JSON.stringify(h.context.state.trades[0].packing), before);
  assert.equal(JSON.stringify(h.context.state.trades[0].returnCounts), '{}');
  assert.equal(h.outbox[0].force, true, '명시적 직원 완료가 재시도에도 보존된다');
  await h.toggle('261031-006', { force: true });
  assert.equal(h.context.state.trades[0].returnDone, false, '완료 취소도 가능하다');
});

test('완료 버튼은 구성품 별도 확인 팝업 없이 직원 완료 경로를 호출하고 오류를 표시한다', () => {
  const card = fs.readFileSync(path.join(__dirname, '../components/ScheduleCard.tsx'), 'utf8');
  const handler = card.slice(card.indexOf('async function handleDoneToggle'), card.indexOf('// 완료되면 상세'));
  assert.match(handler, /toggleReturn\(trade.tradeId, \{ force: true \}\)/);
  assert.doesNotMatch(handler, /window.confirm|packing.*phase|scheduleId.startsWith/);
  assert.match(handler, /setCompletionError\(result.error\)/);
  assert.doesNotMatch(card, /수량 확인 후 반납완료/);
});
