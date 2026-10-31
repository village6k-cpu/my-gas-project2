const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
function domainHarness() {
  const cache = new Map(), calls = { keys: 0, clock: 0 };
  const observedObject = new Proxy(Object, { get(target, key) {
    if (key === 'keys') return value => { calls.keys++; return Object.keys(value); };
    return Reflect.get(target, key);
  }});
  const observedIntl = { ...Intl, DateTimeFormat: function(...args) {
    const formatter = new Intl.DateTimeFormat(...args);
    return { formatToParts(date) { calls.clock++; return formatter.formatToParts(date); } };
  }};
  function load(name) {
    if (cache.has(name)) return cache.get(name);
    const module = { exports: {} }; cache.set(name, module.exports);
    const source = fs.readFileSync(path.join(__dirname, '../lib/domain', name + '.ts'), 'utf8');
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    vm.runInNewContext(code, { module, exports: module.exports, require: n => load(n.replace('./', '')), Object: observedObject, Intl: observedIntl, Date, Map, Set, structuredClone });
    return module.exports;
  }
  return { load, calls };
}
test('반복 체크에서 표준 구성 전체를 매번 순회하지 않고 동일한 모델 구성 반환', () => {
  const { load, calls } = domainHarness();
  const catalog = load('packingCatalog'); calls.keys = 0;
  for (let i = 0; i < 200; i++) {
    assert.equal(catalog.templateFor(' 소니 FX9 풀세트 '), catalog.PACKING_TEMPLATES['소니 FX9 풀세트']);
    assert.equal(catalog.templateFor('스몰HD INDIE7'), catalog.templateFor('스몰HD 인디7'));
    assert.equal(catalog.templateFor('등록 안 된 모델').length, 0);
  }
  assert.equal(calls.keys, 0, '체크마다 전체 마스터 목록을 순회하면 안 된다');
});
test('동일 예약 시각은 한 번 해석하고 날짜 변경·자정·정오는 즉시 새 값 사용', () => {
  const { load, calls } = domainHarness(); const status = load('status');
  for (let i = 0; i < 200; i++) {
    assert.equal(status.reservationDay('2026-10-22T00:00:00+09:00'), '2026-10-21');
    assert.equal(status.timeLabel('2026-10-22T00:00:00+09:00'), '24:00');
    status.timeSortKey('2026-10-22T00:00:00+09:00'); status.timeBand('2026-10-22T00:00:00+09:00');
  }
  assert.equal(calls.clock, 1);
  assert.equal(status.timeLabel('2026-10-22T12:00:00+09:00'), '12:00 (정오)');
  assert.equal(status.reservationDay('2026-10-23T00:00:00+09:00'), '2026-10-22');
  assert.equal(status.reservationDay('invalid'), '');
  // 캐시 용량을 넘은 오래된 일시도 동일한 결과로 다시 해석한다.
  for (let i = 0; i < 2100; i++) status.timeLabel(new Date(1800000000000 + i * 60000).toISOString());
  assert.equal(status.timeLabel('2026-10-22T00:00:00+09:00'), '24:00');
});
// 실제 컴포넌트를 React 서버 렌더링한다. DOM 높이를 바꾸는 대기 문구/확정 안내 자리를 검증.
function checklistHarness(checking) {
  const { load } = domainHarness(); const packing = load('packing');
  const React = require('react'); let stateIndex = 0;
  const react = { ...React, useState(initial) { const index = stateIndex++; return [index === 1 ? checking : initial, () => {}]; } };
  const module = { exports: {} };
  const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../components/PackingChecklist.tsx'), 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, require(n) {
    if (n === 'react') return react;
    if (n === 'react/jsx-runtime') return require(n);
    if (n.endsWith('/packing')) return packing;
    if (n.endsWith('/packingCatalog')) return load('packingCatalog');
    if (n.endsWith('/store')) return {};
    throw Error(n);
  }, Map, Set, crypto: require('node:crypto') });
  const trade = { tradeId: 'test', contractStatus: '예약', setupDone: false, returnDone: false, equipments: [{ scheduleId: 'arm', name: '노가암', qty: 1, isComponent: true, checkoutState: 'pending' }] };
  trade.packing = packing.transitionPacking(trade, { action: 'start' }, '2026-10-31T01:00:00Z');
  return require('react-dom/server').renderToStaticMarkup(React.createElement(module.exports.PackingChecklist, { trade, phase: 'checkout' }));
}
test('저장 대기 전후에도 상태 표시와 확정 안내 영역 높이를 유지', () => {
  const idle = checklistHarness(0), pending = checklistHarness(1);
  for (const html of [idle, pending]) {
    assert.match(html, /class="h-6 px-3[^\"]*" role="status"/);
    assert.match(html, /id="packing-seal-reason-test" class="h-12 overflow-y-auto/);
  }
  assert.match(pending, /저장 중…/);
  assert.doesNotMatch(idle, /저장 중…/);
});
