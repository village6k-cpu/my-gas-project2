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
  Utilities: { formatDate: (date, zone) => new Intl.DateTimeFormat('en-GB', {hour:'2-digit',hourCycle:'h23',timeZone:zone}).format(date) },
  _getPopbillToken: () => 'test-token'
};
vm.createContext(ctx);
vm.runInContext(builders, ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'guideParkingNotice.js'), 'utf8'), ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'guideDoorAccess.js'), 'utf8'), ctx);
ctx._getCheckoutGuideTemplate_ = () => ctx.TPL_CHECKOUT;
ctx._buildCheckoutGuideMsg = name => ctx._buildCheckoutMsg(name);
const reset = () => { for (const k of Object.keys(cache)) delete cache[k]; };
const password = 'test-code*';
const nightAt = new Date('2026-10-15T01:00:00+09:00');
const conditional = '22:00~07:00에 반출/반납하실 경우에는 검정색 철문을 닫고 #버튼을 눌러 문을 잠그고 가주세요.';
for (const kind of ['checkout', 'checkin']) {
  assert.throws(() => ctx.getGuideAlimtalkPayload_(kind, '테스트', nightAt), /비밀번호/, 'unconfigured access must not silently fall back to a password-free guide');
}
assert.strictEqual(requests, 0, 'unconfigured rollout must not call Popbill');
assert(ctx.configureGuideDoorAccess({ password: '\n' }).error);
ctx.configureGuideDoorAccess({ password });
for (const kind of ['checkout', 'checkin']) {
  const code = ctx.GUIDE_DOOR_TEMPLATE_CODES_[kind];
  const expected = ctx.buildGuideDoorMessage_(kind, '#{고객명}', '#{출입문비밀번호}');
  responses[code] = { templateCode: code, state: '2', template: expected };
  reset();
  const pending=ctx.getGuideAlimtalkPayload_(kind, '테스트', nightAt);
  assert.equal(pending.channel,'blocked','pending approval must block sending rather than call the SMS API');
  assert.equal(pending.content,undefined);
  responses[code].state = '3';
  reset();
  const live = ctx.getGuideAlimtalkPayload_(kind, '테스트', nightAt);
  assert.strictEqual(live.templateCode, code);
  assert(live.content.includes(conditional));
  assert(live.content.includes(ctx.GUIDE_PARKING_NOTICE_));
  const p=live.content.indexOf('[매장 출입문 비밀번호:');
  const lock=live.content.indexOf(conditional,p);
  const recipient=live.content.indexOf('⚠️ 예약자와 실제 반출자가 다른 경우',lock);
  const parking=live.content.indexOf('❤️❤️주차 주의❤️❤️',recipient);
  assert(p < lock && lock < recipient && recipient < parking, 'password, lock rule and pickup confirmation must be one highlighted block before parking');
  assert(live.content.slice(recipient,parking).includes('━━━━━━━━━━━━━━━━'),'parking must be separated from the access block');
  assert(!live.content.includes('철문은 닫지 마시고'));
  assert.strictEqual(live.vars['#{출입문비밀번호}'], password);
  assert.strictEqual(live.vars['#{고객명}'], '테스트');
  assert.strictEqual(live.content, expected.replace('#{고객명}', '테스트').replace('#{출입문비밀번호}', password));
  for (const [time, required] of [['21:59', false], ['22:00', true], ['06:59', true], ['07:00', false], ['12:00', false]]) {
    const at = new Date('2026-10-15T' + time + ':00+09:00');
    const selected = ctx.getGuideAlimtalkPayload_(kind, '테스트', at);
    assert.strictEqual(selected.doorAccess, true, kind + ' password must be available at every operation time');
    assert(selected.content.includes(conditional), 'the fixed conditional instruction must be included at '+time);
    assert.strictEqual(selected.content,live.content, 'operation time must not select another message');
  }
  assert(ctx.getGuideAlimtalkPayload_(kind, '테스트').doorAccess, 'guide selection must not depend on a provided operation time');
  responses[code].template += '\n다른 문구';
  reset();
  assert.equal(ctx.getGuideAlimtalkPayload_(kind, '테스트', nightAt).channel,'blocked', 'approved but mismatched body must block sending');
  responses[code] = new Error('network failure');
  reset();
  assert.equal(ctx.getGuideAlimtalkPayload_(kind, '테스트', nightAt).channel,'blocked', 'lookup failure must not enable direct SMS sending');
}
for (const kind of ['checkout','checkin']) {
  const sms=ctx.buildGuideAccessSms_(kind,'테스트',password);
  assert(Buffer.byteLength(sms,'utf8')<=2000,'fallback SMS must fit the Popbill byte limit');
  assert(sms.includes(conditional) && sms.includes(ctx.GUIDE_PARKING_NOTICE_) && sms.includes(password));
}
const newCode='026101499999';
ctx.guidePopbillRead_=()=> [{templateCode:newCode,state:'3',template:ctx.buildGuideDoorMessage_('checkout','#{고객명}','#{출입문비밀번호}') }];
reset();
assert.equal(ctx.getGuideAlimtalkPayload_('checkout','테스트').templateCode,newCode,'only an approved exactly matching new template may automatically activate');
assert.equal(props.GUIDE_SAFE_TEMPLATE_checkout,newCode);
assert(!JSON.stringify(ctx.getGuideDoorAccessStatus()).includes(password), 'status must never disclose the password');
ctx.GUIDE_DELIVERY_INCIDENT_SUSPENDED_=true;
assert.equal(ctx.getGuideDoorAccessStatus().checkout.active,false,'template approval cannot override an incident stop');
assert.equal(ctx.getGuideDoorAccessStatus().checkout.channel,'suspended');
assert(!Object.keys(props).some(k => k.startsWith('GUIDE_SENT')), 'configuration must not reset sent flags');
console.log('guide door access approval, content, blocked SMS and privacy checks OK');
