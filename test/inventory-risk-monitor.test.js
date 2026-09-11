const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const crypto=require('node:crypto');
function env(){
 const values={},cache={};let held=false;
 const props={getProperty:k=>values[k]??null,setProperty:(k,v)=>{assert.ok(Buffer.byteLength(String(v))<9000);values[k]=String(v);},deleteProperty:k=>delete values[k],getProperties:()=>({...values}),setProperties:p=>Object.assign(values,p)};
 const lock={tryLock:()=>{if(held)return false;held=true;return true;},releaseLock:()=>{held=false;}};
 const ctx={PropertiesService:{getScriptProperties:()=>props},CacheService:{getScriptCache:()=>({get:k=>cache[k]??null,put:(k,v)=>cache[k]=v,remove:k=>delete cache[k]})},LockService:{getScriptLock:()=>lock},Utilities:{DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},computeDigest:(a,s)=>[...crypto.createHash('sha256').update(s).digest()],getUuid:()=>crypto.randomUUID(),formatDate:d=>d.toISOString().slice(0,10)}};
 vm.createContext(ctx);
 for(const file of ['../inventoryRiskMonitor.js','../inventoryRiskDelivery.js'])if(fs.existsSync(require.resolve(file)))vm.runInContext(fs.readFileSync(require.resolve(file),'utf8'),ctx);
 return {ctx,props,values,lock};
}
const alert={key:'shortage|CAM-1|s1',kind:'shortage',severity:'conflict',equipment:'FX3',stock:1,booked:2,shortage:1,start:'2026-09-15T01:00:00Z',end:'2026-09-15T09:00:00Z',bookings:[{scheduleId:'s1',tradeId:'t1',customer:'예약자',quantity:2,start:'2026-09-15T01:00:00Z',end:'2026-09-15T09:00:00Z'}]};
const report=(alerts=[alert])=>({generatedAt:'2026-09-12T01:00:00Z',coverage:{complete:true,allFuture:true},alerts,conflictCount:alerts.length,riskCount:0});
test('same risk is quiet, changed quantity notifies, and a complete resolution notifies once',()=>{
 const {ctx:c}=env();const first=c.inventoryRiskNotificationPlan_(report(),{});
 assert.equal(first.notify,true);
 assert.equal(c.inventoryRiskNotificationPlan_(report(),first.entries).notify,false);
 assert.equal(c.inventoryRiskNotificationPlan_(report([{...alert,booked:3,shortage:2}]),first.entries).notify,true);
 assert.equal(c.inventoryRiskNotificationPlan_(report([]),first.entries).notify,true);
});
test('failed auxiliary reads never resolve existing stock alerts',()=>{
 const {ctx:c}=env();const first=c.inventoryRiskNotificationPlan_(report(),{});
 const failed={...report([]),sourceUnavailable:true,alerts:[{key:'source_unavailable',kind:'source_unavailable',bookings:[]}],riskCount:1};
 const next=c.inventoryRiskNotificationPlan_(failed,first.entries);
 assert.equal(next.resolved,0);assert.equal(Object.keys(next.entries).length,2);
});
test('moving evaluation cutoff alone does not resend the same risk',()=>{
 const {ctx:c}=env();const first=c.inventoryRiskNotificationPlan_(report(),{});
 assert.equal(c.inventoryRiskNotificationPlan_(report([{...alert,end:'2026-09-15T09:01:00Z'}]),first.entries).notify,false);
});
test('durable state handles Korean payload beyond a single Script Property',()=>{
 const {ctx:c}=env();const state={entries:{},pending:{text:'한글'.repeat(9000)}};
 c.inventoryRiskSaveState_(state);
 assert.equal(c.inventoryRiskLoadState_().pending.text,state.pending.text);
});
test('large report cache round-trips; an evicted chunk is a miss, never a partial report',()=>{
 const {ctx:c}=env(),values={};const cache={get:k=>values[k]??null,getAll:keys=>Object.fromEntries(keys.filter(k=>k in values).map(k=>[k,values[k]])),put:(k,v)=>values[k]=v,putAll:p=>Object.assign(values,p)};
 const report={alerts:['한글'.repeat(40000)]};c.inventoryRiskCacheWrite_(cache,'test',report,30);
 assert.equal(c.inventoryRiskCacheRead_(cache,'test').alerts[0],report.alerts[0]);
 delete values[Object.keys(values).find(k=>k!=='test')];assert.equal(c.inventoryRiskCacheRead_(cache,'test'),null);
});
test('invalid calendar dates do not roll over into different dates',()=>{
 const {ctx:c}=env();assert.equal(c.inventoryRiskDateTime_('2026-02-30','10:00'),'');
 assert.equal(c.inventoryRiskDateTime_('2026. 9. 12.','7:00'),'2026-09-12T07:00:00+09:00');
});
test('confirmed Slack delivery is persisted and the second run sends nothing',()=>{
 const {ctx:c,props}=env();props.setProperty('inventoryRisk_v1_enabled','true');props.setProperty('inventoryRisk_v1_channel','C123');
 c.getInventoryRiskReport=()=>report();let sends=0;
 c.inventoryRiskSlack_=method=>{if(method==='chat.postMessage'){sends++;return {ok:true,ts:'1.0',channel:'C123'};}return {ok:true,messages:[{ts:'1.0',metadata:{event_type:'inventory_risk_alert',event_payload:{id:c.inventoryRiskLoadState_().pending.id}}}]};};
 assert.equal(c.flushInventoryRiskAlerts().status,'sent');
 assert.equal(c.flushInventoryRiskAlerts().status,'unchanged');assert.equal(sends,1);
});
test('accepted-but-timed-out post is reconciled from history before any retry',()=>{
 const {ctx:c,props}=env();props.setProperty('inventoryRisk_v1_enabled','true');props.setProperty('inventoryRisk_v1_channel','C123');
 c.getInventoryRiskReport=()=>report();let sends=0,accepted;
 c.inventoryRiskSlack_=method=>{if(method==='chat.postMessage'){sends++;accepted=c.inventoryRiskLoadState_().pending.id;throw new Error('timeout');}return {ok:true,messages:[{ts:'1.0',metadata:{event_type:'inventory_risk_alert',event_payload:{id:accepted}}}]};};
 assert.equal(c.flushInventoryRiskAlerts().status,'pending');
 assert.equal(c.flushInventoryRiskAlerts().status,'unchanged');assert.equal(sends,1);
});
test('Slack read methods use query arguments and rate-limit retries honor Retry-After',()=>{
 const {ctx:c,props}=env();props.setProperty('inventoryRisk_v1_slackToken','test-token');let calls=0;
 c.UrlFetchApp={fetch:(url,options)=>{calls++;assert.equal(options.method,'get');assert.match(url,/channel=C123/);assert.equal(options.payload,undefined);return {getResponseCode:()=>429,getAllHeaders:()=>({'Retry-After':'120'}),getContentText:()=>'{"ok":false,"error":"ratelimited"}'};}};
 assert.throws(()=>c.inventoryRiskSlack_('conversations.history',{channel:'C123'}));
 assert.throws(()=>c.inventoryRiskSlack_('conversations.history',{channel:'C123'}));
 assert.equal(calls,1);
});
