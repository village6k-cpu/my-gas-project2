const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'checkAvailability.js'), 'utf8');
const builders = source.slice(source.indexOf('function _buildCheckoutMsg'), source.indexOf('function _parseCheckoutDateTime'));
const props = {};
const cache = {};
const responses = {};
let requests = 0;
const ctx = {
  TPL_CHECKOUT: '026060000711', TPL_CHECKIN: '026040000904',
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k,v) => { props[k] = v; } }) },
  CacheService: { getScriptCache: () => ({ get: k => cache[k] || null, put: (k,v) => { cache[k] = v; } }) },
  UrlFetchApp: { fetch: url => { requests++; const code = url.split('/').pop(); if (responses[code] instanceof Error) throw responses[code]; return { getResponseCode: () => 200, getContentText: () => JSON.stringify(responses[code]) }; } },
  _getPopbillToken: () => 'test-token'
};
vm.createContext(ctx);
vm.runInContext(builders, ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'guideDoorAccess.js'), 'utf8'), ctx);
ctx._getCheckoutGuideTemplate_ = () => ctx.TPL_CHECKOUT;
ctx._buildCheckoutGuideMsg = name => ctx._buildCheckoutMsg(name);
const reset = () => { for (const k of Object.keys(cache)) delete cache[k]; };
const password = 'test-code*';
const suffix = '[매장 출입문 비밀번호: ' + password + ']\n나가실 때는 반드시 검정색 철문을 닫고 #버튼을 눌러 문을 잠궈주세요!';
for (const kind of ['checkout', 'checkin']) {
  const old = ctx.getGuideAlimtalkPayload_(kind, '테스트');
  assert(!old.content.includes('출입문 비밀번호'));
}
assert.strictEqual(requests, 0, 'unconfigured rollout must not call Popbill');
assert(ctx.configureGuideDoorAccess({ password: '\n' }).error);
ctx.configureGuideDoorAccess({ password });
for (const kind of ['checkout', 'checkin']) {
  const code = ctx.GUIDE_DOOR_TEMPLATE_CODES_[kind];
  const expected = ctx.buildGuideDoorMessage_(kind, '#{고객명}', '#{출입문비밀번호}');
  responses[code] = { templateCode: code, state: '2', template: expected };
  reset();
  assert(!ctx.getGuideAlimtalkPayload_(kind, '테스트').doorAccess, 'pending review must preserve the approved old pair');
  responses[code].state = '3';
  reset();
  const live = ctx.getGuideAlimtalkPayload_(kind, '테스트');
  assert.strictEqual(live.templateCode, code);
  assert(live.content.endsWith(suffix));
  assert(!live.content.includes('철문은 닫지 마시고'));
  assert.strictEqual(live.vars['#{출입문비밀번호}'], password);
  assert.strictEqual(live.vars['#{고객명}'], '테스트');
  assert.strictEqual(live.content, expected.replace('#{고객명}', '테스트').replace('#{출입문비밀번호}', password));
  responses[code].template += '\n다른 문구';
  reset();
  assert(!ctx.getGuideAlimtalkPayload_(kind, '테스트').doorAccess, 'approved but mismatched body must not activate');
  responses[code] = new Error('network failure');
  reset();
  assert(!ctx.getGuideAlimtalkPayload_(kind, '테스트').doorAccess, 'lookup failure must preserve existing sends');
}
assert(!JSON.stringify(ctx.getGuideDoorAccessStatus()).includes(password), 'status must never disclose the password');
assert(!Object.keys(props).some(k => k.startsWith('GUIDE_SENT')), 'configuration must not reset sent flags');
console.log('guide door access approval, content, fallback and privacy checks OK');
