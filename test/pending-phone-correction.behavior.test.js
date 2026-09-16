const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {normalizePendingCustomerIdentity}=require('../scripts/windows/pending-customer-identity.js');
const identity={expected_name:'김지윤',expected_phone:'010-0000-0001',name:'김지윤',phone:'010-0000-0002'};
const source='김지윤 010-0000-0001 예약합니다.\n연락처를 잘못 적었습니다. 010-0000-0002로 수정 부탁드립니다.';
function gas(){const c={console};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../checkAvailability.js'),'utf8'),c);return c;}
test('an explicit customer correction can replace a known pending phone through JS and GAS',()=>{
 assert.deepEqual(normalizePendingCustomerIdentity(identity,source),identity);
 assert.doesNotThrow(()=>gas()._assertPendingCustomerIdentityUpdate_({name:identity.name,phone:identity.expected_phone},identity,{예약자명:identity.name,연락처:identity.phone},{customer_request:source}));
});
test('GAS rejects a stale old phone before applying the correction',()=>{
 assert.throws(()=>gas()._assertPendingCustomerIdentityUpdate_({name:identity.name,phone:'010-0000-0003'},identity,{예약자명:identity.name,연락처:identity.phone},{customer_request:source}));
});
test('a memo alone cannot replace a known phone without the new number in customer evidence',()=>{
 assert.throws(()=>normalizePendingCustomerIdentity(identity,'김지윤 예약합니다',identity.phone));
 assert.throws(()=>gas()._assertPendingCustomerIdentityUpdate_({name:identity.name,phone:identity.expected_phone},identity,{예약자명:identity.name,연락처:identity.phone},{customer_request:'김지윤 예약합니다',room_memo:identity.phone}));
});
test('an unsupported corrected phone is rejected by both validators',()=>{
 const changed={...identity,phone:'010-0000-9999'};
 assert.throws(()=>normalizePendingCustomerIdentity(changed,source));
 assert.throws(()=>gas()._assertPendingCustomerIdentityUpdate_({name:identity.name,phone:identity.expected_phone},changed,{예약자명:identity.name,연락처:changed.phone},{customer_request:source}));
});
