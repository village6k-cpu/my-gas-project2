const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const source = fs.readFileSync(path.join(__dirname, '../lib/data/store.ts'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const compile = code => ts.transpileModule(code, {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS}}).outputText;
function deferred() {
  let resolve, reject;
  const promise = new Promise((r, j) => { resolve = r; reject = j; });
  return {promise, resolve, reject};
}
function harness() {
  const listeners = new Set(), waits = new Set(), inflight = new Set(), requests = [], applied = [];
  const state = {trades: ['t1', 't2'].map(tradeId => ({tradeId, contractStatus: '예약'}))};
  let seq = 0;
  const ctx = {exports: {}, state, Error, setTimeout, clearTimeout, isSupabase: true, writeBackEnabled: true,
    isGasOutcomeUnknownError: error => !!error?.outcomeUnknown,
    activeTradeTransitions: new Set(), hasTradePending: tid => waits.has(tid) || inflight.has(tid),
    subscribe: callback => {listeners.add(callback); return () => listeners.delete(callback);},
    beginTradeSave: tid => {assert.ok(!inflight.has(tid)); inflight.add(tid); return ++seq;},
    finishTradeSave: tid => {inflight.delete(tid); for (const fn of [...listeners]) fn();},
    showTransientError() {}, createLedgerMutationId: () => 'onsite:' + (++seq),
    gasMutation: (action, params) => {const gate = deferred(); requests.push({params, gate}); return gate.promise;},
    applyGasOnsiteItems_: (tid, items) => applied.push([tid, items.map(item => item.scheduleId).join(',')]),
    categoryOf: () => '기타', ONSITE_EMPH: /카드/,
    unwrapContractMutation: res => res, amountFromMutation: () => null, contractUrlFromMutation: () => '',
  };
  const keyCode = source.slice(source.indexOf('const onsiteIdempotencyKeys:'), source.indexOf('function applyGasOnsiteItems_('));
  const addCode = source.slice(source.indexOf('const onsiteAddsByTrade ='), source.indexOf('export function setOnsiteSettlement'));
  vm.runInNewContext(compile(keyCode + addCode + '\nexports.flush = awaitPendingOnsiteAdds_;'), ctx);
  return {ctx, state, waits, requests, applied, flush: ctx.exports.flush, signal: () => [...listeners].forEach(fn => fn()),
    add: (name, tid = 't1') => ctx.exports.addOnsiteItems(tid, [{name, qty: 1}], '무상'),
    ack: (index, scheduleId) => {
      const {params, gate} = requests[index];
      gate.resolve({addedItems: [{scheduleId, name: JSON.parse(params.entries)[0].name, qty: 1}]});
    },
  };
}

test('현장 추가 2건은 기존 저장 뒤에 순서대로 반영하고 중복 클릭을 병합하며, 다른 거래는 바로 저장한다', async () => {
  const h = harness();
  h.waits.add('t1');
  const a = h.add('라인'), duplicate = h.add('라인'), b = h.add('암'), other = h.add('라인', 't2');
  assert.deepEqual(h.requests.map(r => r.params.tid), ['t2']);
  h.ack(0, 't2-01'); await other;
  let sealed = false;
  const barrier = h.flush('t1').then(() => {sealed = true;});
  h.waits.clear(); h.signal(); await tick();
  assert.deepEqual(h.requests.map(r => JSON.parse(r.params.entries)[0].name), ['라인', '라인']);
  assert.equal(h.ctx.activeTradeTransitions.size, 0, '기존 장비 체크·제외를 잠그지 않는다');
  h.ack(1, 't1-01'); await Promise.all([a, duplicate]); await tick();
  assert.equal(sealed, false);
  assert.equal(JSON.parse(h.requests[2].params.entries)[0].name, '암');
  h.ack(2, 't1-02'); await Promise.all([b, barrier]);
  assert.equal(sealed, true);
  assert.deepEqual(h.applied, [['t2', 't2-01'], ['t1', 't1-01'], ['t1', 't1-02']]);
});

test('원장 응답 유실 때 동일 키 재시도, 후속 독립 품목은 등록, 실패한 대기를 봉인 성공으로 넘기지 않는다', async () => {
  const h = harness();
  const first = h.add('라인'), next = h.add('암'), wait = h.flush('t1');
  const lost = assert.rejects(first, /연결/), blocked = assert.rejects(wait, /연결/);
  const key = h.requests[0].params.idempotencyKey;
  h.requests[0].gate.reject(new Error('연결 끊김'));
  await Promise.all([lost, blocked]); await tick();
  h.ack(1, 't1-02'); await next;
  const retry = h.add('라인');
  assert.equal(h.requests[2].params.idempotencyKey, key);
  h.requests[2].gate.resolve({duplicate:true, addedScheduleIds:['t1-01'], addedItems:[{scheduleId:'t1-01', name:'라인'}]});
  await retry;
  assert.deepEqual(h.applied, [['t1','t1-02'],['t1','t1-01']]);
  const intentional = h.add('라인');
  assert.notEqual(h.requests[3].params.idempotencyKey, key);
  h.ack(3,'t1-03'); await intentional;
});

test('대기 도중 취소·반납완료·거래 이탈 시 원장 쓰기를 중단한다', async () => {
  for (const end of ['취소','반납완료','이탈']) {
    const h = harness();
    h.waits.add('t1');
    const add = h.add('라인');
    if (end === '이탈') h.state.trades = [];
    else h.state.trades[0].contractStatus = end;
    h.waits.clear(); h.signal();
    await assert.rejects(add, /현재 거래 상태/);
    assert.equal(h.requests.length, 0);
  }
});

test('실제 원장 품목 번호가 없는 응답을 저장 완료로 표시하지 않는다', async () => {
  const h = harness(), add = h.add('라인');
  h.ack(0, '');
  await assert.rejects(add, /품목 번호/);
  assert.deepEqual(h.applied, []);
});

test('입력창은 응답 전에 다음 품목을 받고, 먼저 보낸 품목의 순서·실패·동일 조건 재시도를 표시한다', async () => {
  const component = fs.readFileSync(path.join(__dirname, '../components/HandoverChecklist.tsx'), 'utf8');
  const start = component.indexOf('function OnsiteCombobox('), end = component.indexOf('\nfunction Stepper(', start);
  const code = ts.transpileModule(component.slice(start,end) + '\nexports.render = OnsiteCombobox;', {
    compilerOptions: {jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS},
    fileName: 'OnsiteCombobox.tsx',
  }).outputText;
  let index = 0;
  const slots = [], calls = [];
  const ctx = {exports:{}, require, Error, isGasOutcomeUnknownError: error => !!error?.outcomeUnknown, Stepper: 'stepper', Plus: 'plus', MEDIA_RE: /카드/,
    useEquipmentCatalog: () => ({items: []}), searchEquipmentCatalog: () => [], clearToast() {},
    useRef: value => slots[index++] ??= {current:value},
    useState(value) {
      const i = index++;
      if (!(i in slots)) slots[i] = value;
      return [slots[i], next => {slots[i] = typeof next === 'function' ? next(slots[i]) : next;}];
    },
    addOnsiteItems(...args) {const gate = deferred(); calls.push({args,gate}); return gate.promise;},
  };
  vm.runInNewContext(code, ctx);
  function render() {
    index = 0;
    const nodes = [];
    function walk(node) {
      if (Array.isArray(node)) return node.forEach(walk);
      if (!node?.props) return;
      nodes.push(node); walk(node.props.children);
    }
    walk(ctx.exports.render({tradeId:'t1', onClose: () => assert.fail('저장 응답으로 입력창을 닫지 않는다')}));
    return nodes;
  }
  function text(node) {
    if (Array.isArray(node)) return node.map(text).join('');
    return node?.props ? text(node.props.children) : typeof node === 'string' ? node : '';
  }
  const input = () => render().find(n => n.type === 'input' && n.props.placeholder);
  const click = label => render().find(n => n.type === 'button' && text(n) === label).props.onClick();
  const status = () => text(render().find(n => n.props.role === 'status'));
  input().props.onChange({target:{value:'라인'}}); click('유상');
  const first = click('추가');
  assert.match(status(), /라인 ×1 · 유상 · 저장 대기/);
  assert.equal(input().props.value, '');
  calls[0].args[4]();
  input().props.onChange({target:{value:'암'}});
  const second = click('추가');
  assert.match(status(), /라인 ×1 · 유상 · 저장 중.*암 ×1 · 무상 · 저장 대기/);
  calls[0].gate.reject(Object.assign(new Error('응답 유실'), {outcomeUnknown:true})); await first;
  assert.match(status(), /라인.*저장 확인 필요.*응답 유실/);
  calls[1].gate.resolve(); await second;
  assert.match(status(), /암 ×1 · 무상 · 저장 완료/);
  const retry = click('다시 시도');
  assert.deepEqual(calls[2].args.slice(0,4), calls[0].args.slice(0,4));
  calls[2].gate.resolve(); await retry;
  assert.match(status(), /라인 ×1 · 유상 · 저장 완료/);
});
