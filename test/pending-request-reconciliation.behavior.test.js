'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),modulePath=path.join(root,'pendingRequestReconciliation.js');
const source=fs.existsSync(modulePath)?fs.readFileSync(modulePath,'utf8'):'';
const gas=fs.readFileSync(path.join(root,'checkAvailability.js'),'utf8');
const rejectSource=gas.slice(gas.indexOf('function rejectByReqID('),gas.indexOf('// jsonResponse()',gas.indexOf('function rejectByReqID(')));
const id='RQ-261021-001';
const row=(item='장비')=>[id,'2026-10-23','09:00','2026-10-24','09:00',item,1,'확인','가용','상세','테스트','01000000000','일반','','','','비고','추가요청'];
function fixture(options={}) {
 const rows=structuredClone(options.rows||[row(),row('구성품'),['RQ-261021-002',...row().slice(1)]]),writes=[],order=[];
 let scriptHeld=false,userHeld=false,followups=0;
 const script={tryLock(){order.push('script');if(options.scriptBusy)return false;options.beforeLock?.(rows);scriptHeld=true;return true;},releaseLock(){order.push('release-script');scriptHeld=false;}};
 const user={waitLock(){assert.equal(scriptHeld,true);order.push('user');if(options.userBusy)throw Error('input busy');userHeld=true;},releaseLock(){order.push('release-user');userHeld=false;}};
 const sheet={getLastRow:()=>rows.length+1,getRange(r,c,n=1,m=1){return {getValues:()=>rows.slice(r-2,r-2+n).map(x=>x.slice(c-1,c-1+m)),setValue(v){assert.ok(scriptHeld&&userHeld);writes.push([r,c,v]);rows[r-2][c-1]=v;return this;},clearContent(){return this.setValue('');},setBackground(){return this;}};}};
 const context={Date,JSON,LockService:{getScriptLock:()=>script,getUserLock:()=>user},SpreadsheetApp:{getActiveSpreadsheet:()=>({getSheetByName:n=>n==='확인요청'?sheet:null}),flush(){options.onFlush?.(rows);}},Utilities:{formatDate:(v,tz,format)=>{assert.equal(tz,'Asia/Seoul');assert.equal(format,'yyyy-MM-dd HH:mm:ss');return '2026-10-23 00:00:00';}},cancelPreRegistrationStockResume_(){followups++;if(options.followupError)throw Error('queue unavailable');}};
 vm.runInNewContext(rejectSource+'\n'+source,context);
 const input={requestId:id,baselineFormat:'sheet-api-values-18-v1',expectedRows:rows.filter(r=>r[0]===id).map(r=>r.slice()),disposition:'reject',send:false,sourceEvidence:{roomKey:'chat:1234567890',snapshotSha256:'a'.repeat(64),capturedAt:new Date().toISOString(),decisionMessageIds:['dom-1','dom-2'],confirmed:true}};
 return {rows,writes,order,input,run(patch={}){assert.equal(typeof context.reconcilePendingRequest,'function','guarded pending reconciliation entry point must exist');return context.reconcilePendingRequest({...input,...patch});},get followups(){return followups;}};
}
test('valid exact pending request rejects only its O/N cells under ScriptLock then UserLock, with independent readback',()=>{
 const f=fixture(),before=structuredClone(f.rows),out=f.run();
 assert.equal(out.ok,true);assert.equal(out.status,'applied');assert.equal(out.customerNotificationSent,false);assert.equal(out.readbackVerified,true);assert.equal(out.noReplay,true);
 assert.deepEqual(f.order,['script','user','release-user','release-script']);assert.equal(f.writes.length,4);assert.equal(f.followups,1);
 for(let i=0;i<before.length;i++){const expected=before[i];if(expected[0]===id)expected[14]='거절';assert.deepEqual(f.rows[i],expected);}
});
test('exact already-rejected state is read-only proof and never invokes reject or followup again',()=>{
 const f=fixture();f.run();f.writes.length=0;const out=f.run();assert.equal(out.status,'already_applied');assert.equal(out.readbackVerified,true);assert.equal(out.writeAttempted,false);assert.equal(f.writes.length,0);assert.equal(f.followups,1);
});
test('registration appearing before lock acquisition causes zero writes',()=>{
 for(const change of [r=>r[0][13]='등록',r=>r[0][14]='등록대기',r=>r[0][15]='261023-001',r=>r[0][14]='⚠️ 자동등록 후처리 실패 — 수동확인 필요']){
  const f=fixture({beforeLock:change}),out=f.run();assert.equal(out.ok,false);assert.equal(out.writeAttempted,false);assert.equal(f.writes.length,0);
 }
});
test('busy registration or request-edit lock fails closed and releases only acquired locks',()=>{
 const script=fixture({scriptBusy:true});assert.equal(script.run().code,'registration_busy');assert.equal(script.writes.length,0);assert.deepEqual(script.order,['script']);
 const user=fixture({userBusy:true});assert.equal(user.run().status,'blocked');assert.equal(user.writes.length,0);assert.deepEqual(user.order,['script','user','release-script']);
});
test('row shifts before lock are resolved by current request identity and complete row multiplicity',()=>{
 const f=fixture({beforeLock:r=>r.unshift(['RQ-261021-003',...row('unrelated inserted').slice(1)])});const out=f.run();assert.equal(out.ok,true);assert.equal(f.rows[0][14],'');assert.equal(f.rows[1][14],'거절');assert.equal(f.rows[2][14],'거절');assert.equal(f.rows[3][14],'');
 const duplicate=fixture({beforeLock:r=>r.push(row())});assert.equal(duplicate.run().code,'baseline_changed');assert.equal(duplicate.writes.length,0);
});
test('missing request and every full 18-column source change fail before mutation',()=>{
 const gone=fixture({beforeLock:r=>r.splice(0,2)});assert.equal(gone.run().code,'request_missing');assert.equal(gone.writes.length,0);
 for(let col=1;col<18;col++){const f=fixture({beforeLock:r=>{r[0][col]=String(r[0][col])+'changed';}});assert.equal(f.run().ok,false,'column '+col);assert.equal(f.writes.length,0);}
 const extra=fixture({beforeLock:r=>r.push(row('new component'))});assert.equal(extra.run().code,'baseline_changed');assert.equal(extra.writes.length,0);
});
test('truncated, other-request, nonblank baseline and stale source fail with zero writes',()=>{
 for(const patch of [f=>({expectedRows:[f.input.expectedRows[0].slice(0,17)]}),f=>({expectedRows:[[...row()].map((v,i)=>i===0?'RQ-261021-999':v)]}),f=>({expectedRows:f.input.expectedRows.map(r=>r.map((v,i)=>i===14?'거절':v))}),f=>({sourceEvidence:{...f.input.sourceEvidence,capturedAt:new Date(Date.now()-3600000).toISOString()}}),()=>({send:true})]){
  const f=fixture(),out=f.run(patch(f));assert.equal(out.ok,false);assert.equal(f.writes.length,0);
 }
});
test('partial exception or unexpected independent readback is outcome_unknown and cannot be advertised as zero-write',()=>{
 const queue=fixture({followupError:true}),a=queue.run();assert.equal(a.status,'outcome_unknown');assert.equal(a.writeAttempted,true);assert.equal(a.noReplay,true);
 const drift=fixture({onFlush:r=>{r[2][17]='concurrent drift';}}),b=drift.run();assert.equal(b.status,'outcome_unknown');assert.equal(b.writeAttempted,true);assert.equal(b.readbackVerified,false);
});
test('raw dates use the same explicit Asia/Seoul serialization as Sheet API; primitive types are not silently coerced',()=>{
 const f=fixture();f.rows[0][1]=new Date('2026-10-22T15:00:00Z');f.input.expectedRows[0][1]='2026-10-23 00:00:00';assert.equal(f.run().ok,true);
 const changed=fixture();changed.input.expectedRows[0][6]='1';assert.equal(changed.run().code,'baseline_changed');assert.equal(changed.writes.length,0);
});
test('internal run exposes the guarded operation without introducing a public action',()=>{
 const api=fs.readFileSync(path.join(root,'sheetAPI.js'),'utf8');assert.match(api,/"reconcilePendingRequest"/);assert.match(api,/funcName === "reconcilePendingRequest"/);assert.doesNotMatch(api,/case "reconcilePendingRequest"/);
});
test('guarded reconciliation denies public credentials and GET before any dispatch',()=>{
 const api=fs.readFileSync(path.join(root,'sheetAPI.js'),'utf8'),calls=[];
 const c={PropertiesService:{getScriptProperties:()=>({getProperty:()=> 'private-test-key'})}};
 vm.runInNewContext(api,c);
 c.jsonResponse=(payload,status=200)=>({payload,status});c.invalidateConfirmListCache_=()=>{};
 c.runFunction=(name,args)=>{calls.push({name,args});return {success:true};};
 const request=(key,method)=>({parameter:{key,action:'run',func:'reconcilePendingRequest'},villageHttpMethod_:method});
 assert.equal(c.handleRequestCore_(request('village2026','POST')).status,403);
 assert.equal(c.handleRequestCore_(request('private-test-key','GET')).status,405);
 assert.equal(calls.length,0);
 assert.equal(c.handleRequestCore_(request('private-test-key','POST')).payload.success,true);
 assert.equal(calls.length,1);
});
