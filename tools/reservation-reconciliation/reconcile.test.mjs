import test from 'node:test';import assert from 'node:assert/strict';
import { reconcileReservations, reconcileObligations, parseDecision } from './reconcile.mjs';
const now='2026-11-02T12:00:00Z';
const decision={inquiry_disposition:'already_applied',reservation_inquiry:{confirmed:true},sheet_row_candidate:{customer_name:'고객',phone:'010-1111-2222',plan_complete:true,start_date:'2026-11-03',end_date:'2026-11-04',pickup_time:'09:30',return_time:'10:00',equipment:[{item:'카메라',quantity:1}]}};
const job={job_id:'job1',room_key:'chat:1',created_at:now,state:'completed',application:{state:'finalized'},result:{content:JSON.stringify(decision)},local_context:{job:{customerName:'고객'},turn_internal:{snapshot:{navigation:{conversation_evidence:{capture_integrity:{ok:true},messages:[{text:'예약 부탁드립니다'}]}}}}}};
const trade={trade_id:'t1',customer_name:'고객',customer_phone:'01011112222',checkout_at:'2026-11-03T00:30:00Z',return_at:'2026-11-04T01:00:00Z',contract_status:'예약'};
const item={schedule_id:'s1',trade_id:'t1',name:'카메라',qty:1,is_component:false};
const run=(extra={})=>reconcileReservations({jobs:[job],trades:[trade],items:[item],now,...extra});
test('completed worker is not a completed booking',()=>{const r=run({trades:[],items:[]});assert.equal(r.findings[0].kind,'approved_booking_missing');});
test('authoritative period and quantities close the gap',()=>{assert.equal(run().findings.length,0);assert.equal(run().rooms[0].status,'verified');});
test('a successful historical retry makes a stale failure harmless',()=>{assert.equal(run({jobs:[{...job,state:'failed'}]}).findings.length,0);});
test('30 minute approved change is compared to actual stored timestamps',()=>{const r=run({trades:[{...trade,checkout_at:'2026-11-03T01:00:00Z'}]});assert.equal(r.findings[0].kind,'approved_period_mismatch');});
test('matching period alone cannot hide missing equipment',()=>{assert.equal(run({items:[]}).findings[0].kind,'approved_equipment_mismatch');});
test('removed component and set header cannot satisfy a top-level item',()=>{assert.equal(run({items:[{...item,removed_at:now}]}).findings.length,1);assert.equal(run({items:[{...item,is_component:true}]}).findings.length,1);});
test('aliases require unique explicit identity; no fuzzy equipment inference',()=>{const e={...item,name:'camera'};assert.equal(run({items:[e]}).findings.length,1);assert.equal(run({items:[e],aliases:[['camera','카메라']]}).findings.length,0);});
test('same name with a different phone is not authoritative identity',()=>{assert.equal(run({trades:[{...trade,customer_phone:'01099998888'}]}).findings[0].kind,'approved_booking_missing');});
test('inquiry is not falsely described as a confirmed missing booking',()=>{const d={...decision,reservation_inquiry:{confirmed:false}};const r=run({jobs:[{...job,result:{content:JSON.stringify(d)}}],trades:[]});assert.equal(r.findings[0].kind,'inquiry_not_registered');});
test('uncaptured failed work remains visible without guessing a booking',()=>{const r=run({jobs:[{...job,result:null,local_context:{job:{customerName:'고객'}}}]});assert.equal(r.findings[0].kind,'capture_or_decision_missing');});
test('multiple matches are not silently chosen',()=>{assert.equal(run({trades:[trade,{...trade,trade_id:'t2'}]}).findings[0].kind,'duplicate_candidate');});
test('partial canonical reads cannot produce an all-clear',()=>{assert.throws(()=>run({trades:null}),/complete/);});
test('open obligations survive the scan window and dismissed cards',()=>{const old={key:'old',kind:'approved_period_mismatch',state:'open',firstSeen:now};const r=reconcileObligations({previous:[old],findings:[],verifiedKeys:[],now});assert.equal(r[0].state,'open');assert.equal(r[0].kind,'source_no_longer_current');});
test('only exact fresh readback resolves an existing obligation',()=>{const old={key:'x',state:'open',firstSeen:now};assert.equal(reconcileObligations({previous:[old],findings:[],verifiedKeys:['x'],now})[0].state,'resolved');});

test('later unrelated messages cannot erase earlier approved booking',()=>{const later={...job,job_id:'job2',created_at:'2026-11-02T13:00:00Z',result:{content:JSON.stringify({inquiry_disposition:'inventory_only'})}};const r=run({jobs:[job,later],trades:[],items:[]});assert.ok(r.findings.some(f=>f.kind==='approved_booking_missing'));});
test('excess quantities cannot be called reconciled',()=>{assert.equal(run({items:[{...item,qty:2}]}).findings[0].kind,'approved_equipment_mismatch');});

test('legacy numeric Korean phone and +82 resolve to the same identity',()=>{assert.equal(run({trades:[{...trade,customer_phone:'1011112222'}]}).findings.length,0);assert.equal(run({trades:[{...trade,customer_phone:'+82 10 1111 2222'}]}).findings.length,0);});

test('FINAL_JSON without code fences and earlier sample objects are parsed correctly',()=>{assert.deepEqual(parseDecision('example {} FINAL_JSON {\"value\":1}'),{value:1});});
test('an unwanted extra top-level item cannot resolve a removal obligation',()=>{assert.equal(run({items:[item,{...item,schedule_id:'s2',name:'삼각대'}]}).findings[0].kind,'approved_equipment_mismatch');});
