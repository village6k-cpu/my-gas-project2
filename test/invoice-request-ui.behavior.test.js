const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const { createRequire } = require('node:module');
const appRoot = path.join(__dirname, '../apps/today-dashboard'), ts = createRequire(path.join(appRoot, 'package.json'))('typescript');
const source = fs.readFileSync(path.join(appRoot, 'components/InvoiceRequestsView.tsx'), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText + '\nmodule.exports.Card = InvoiceCard;';
function harness() {
  let cursor = 0, states = [], requests = [], row;
  const buyer = { corpNum: '1234567890', corpName: 'A', ceoName: '대표', email: 'a@example.com', addr: '', bizType: '', bizClass: '' };
  row = { id: 'work', version: 1, title: '고객 계산서', summary: '요청', requestedAt: '2026-11-02T00:00:00Z', customerLabel: '고객', status: 'ready', canIssue: true, blockers: [], workState: 'open',
    item: { tradeId: '261102-001', buyer, amount: 43890, fingerprint: 'a'.repeat(64) } };
  const mod = { exports: {} };
  const react = { useState(initial) { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], value => { states[i] = typeof value === 'function' ? value(states[i]) : value; }]; },
    useRef(initial) { const i = cursor++; if (!(i in states)) states[i] = { current: initial }; return states[i]; }, useEffect() {}, useCallback: f => f, useMemo: f => f() };
  vm.runInNewContext(js, { module: mod, exports: mod.exports, console, Date, require: id => {
    if (id === 'react') return react;
    if (id === 'react/jsx-runtime') return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
    if (id.includes('authFetch')) return { authFetch: async (_, init) => { const body = JSON.parse(init.body); requests.push(body); return { ok: true, json: async () => ({ ok: true, row: { ...row, version: row.version + 1, item: { ...row.item, buyer: body.buyer } } }) }; } };
    if (id.includes('invoice-model')) return { invoiceRequestSummary() {} };
    if (id.includes('domain/status')) return { shortDate: () => '', timeLabel: () => '' };
    throw Error(id);
  } });
  return { requests, render() { cursor = 0; return mod.exports.Card({ row, buyers: [], disabled: false, onUpdate: value => { row = value; }, onBusy() {} }); } };
}
function all(node, predicate) {
  if (!node || typeof node !== 'object') return [];
  const children = Array.isArray(node.props?.children) ? node.props.children : [node.props?.children];
  return [...(predicate(node) ? [node] : []), ...children.flatMap(child => Array.isArray(child) ? child.flatMap(x => all(x, predicate)) : all(child, predicate))];
}
const text = node => typeof node === 'string' ? node : Array.isArray(node) ? node.map(text).join('') : node && typeof node === 'object' ? text(node.props?.children) : '';
const button = (tree, label) => all(tree, n => n.type === 'button' && text(n) === label)[0];
test('editing buyer fields disables issuance and cannot submit the previous recipient', async () => {
  const h = harness(); button(h.render(), '정보 수정').props.onClick();
  let tree = h.render(); const label = all(tree, n => n.type === 'label' && text(n).startsWith('수신 이메일'))[0];
  all(label, n => n.type === 'input')[0].props.onChange({ target: { value: 'new@example.com' } });
  tree = h.render(); const issue = button(tree, '수정한 정보를 먼저 적용해주세요'); assert.equal(issue.props.disabled, true);
  issue.props.onClick(); await new Promise(resolve => setImmediate(resolve)); assert.equal(h.requests.length, 0);
  button(tree, '이 정보로 발행 준비').props.onClick(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.requests[0].action, 'prepare'); assert.equal(h.requests[0].buyer.email, 'new@example.com');
});
