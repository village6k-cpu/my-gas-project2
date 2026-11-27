const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');

function harness() {
  const slots = [], requests = [], modules = new Map();
  let cursor = 0, context;
  const react = {
    createContext() { context = { Provider: 'provider', current: null }; return context; },
    useContext: c => c.current,
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [slots[i], next => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }];
    },
    useRef(initial) { const i = cursor++; return slots[i] ?? (slots[i] = { current: initial }); },
    useMemo: fn => fn(), useEffect() {},
  };
  const jsx = (type, props) => ({ type, props: props || {} });
  const store = {
    savePacking() {}, syncPackingPreparation: async () => {},
    savePackingCheck(tradeId, entryId, checked) {
      return new Promise((resolve, reject) => requests.push({ tradeId, entryId, checked, resolve, reject }));
    },
  };
  function load(file) {
    if (modules.has(file)) return modules.get(file);
    const m = { exports: {} }; modules.set(file, m.exports);
    const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: {
      module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
    } }).outputText;
    vm.runInNewContext(code, {
      module: m, exports: m.exports, structuredClone, Date, Intl, Map, Set, Promise,
      require(name) {
        if (name === 'react') return react;
        if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx, Fragment: 'fragment' };
        if (name === '@/lib/data/store') return store;
        return load(name.startsWith('@/') ? path.join(root, name.slice(2) + '.ts') : path.resolve(path.dirname(file), name + '.ts'));
      },
    });
    modules.set(file, m.exports); return m.exports;
  }
  const domain = load(path.join(root, 'lib/domain/packing.ts'));
  const ui = load(path.join(root, 'components/PackingChecklist.tsx'));
  let trade = { tradeId: '991231-997', contractStatus: '예약', setupDone: false, returnDone: false,
    equipments: [{ scheduleId: 'line', name: '스몰HD용 SDI 연선', qty: 1, setName: 'BURANO', isComponent: true, checkoutState: 'pending' }] };
  trade.packing = domain.transitionPacking(trade, { action: 'start' }, '2026-11-27T09:00:00Z');
  function find(tree, predicate) {
    if (Array.isArray(tree)) return tree.flatMap(t => find(t, predicate));
    if (!tree || typeof tree !== 'object') return [];
    return [...(predicate(tree) ? [tree] : []), ...find(tree.props?.children, predicate)];
  }
  function render() {
    cursor = 0;
    const tree = ui.PackingChecklist({ trade, phase: 'checkout' });
    context.current = tree.props.value;
    const device = ui.PackingDevice({});
    const checks = find(device, n => n.type === 'button' && /준비 확인$/.test(n.props['aria-label'] || ''));
    return { checks, alerts: find(tree, n => n.props?.role === 'alert') };
  }
  function confirm(index) {
    const r = requests[index];
    trade = { ...trade, packing: { ...trade.packing, version: trade.packing.version + 1,
      entries: trade.packing.entries.map(e => e.id === r.entryId ? { ...e, checked: r.checked } : e) } };
    r.resolve();
  }
  return { render, requests, confirm, get trade() { return trade; } };
}

test('a component check responds immediately while its save waits behind another command', async () => {
  const h = harness();
  const saving = h.render().checks[0].props.onClick();
  assert.equal(h.render().checks[0].props['aria-pressed'], true);
  assert.equal(h.requests.length, 1);
  h.confirm(0); await saving;
  assert.equal(h.render().checks[0].props['aria-pressed'], true);
});

test('a second click remains visible when the first delayed response arrives', async () => {
  const h = harness();
  const first = h.render().checks[0].props.onClick();
  const second = h.render().checks[0].props.onClick();
  assert.deepEqual(h.requests.map(r => r.checked), [true, false]);
  h.confirm(0); await first;
  assert.equal(h.render().checks[0].props['aria-pressed'], false);
  h.confirm(1); await second;
  assert.equal(h.render().checks[0].props['aria-pressed'], false);
});

test('a rejected check removes only its unconfirmed display and keeps the server unchecked', async () => {
  const h = harness();
  const saving = h.render().checks[0].props.onClick();
  assert.equal(h.render().checks[0].props['aria-pressed'], true);
  h.requests[0].reject(new Error('구성품이 변경되었습니다'));
  await saving;
  assert.equal(h.render().checks[0].props['aria-pressed'], false);
  assert.equal(h.trade.packing.entries[0].checked, false);
  assert.equal(h.render().alerts.length, 1);
});
