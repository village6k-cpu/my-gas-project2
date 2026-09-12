const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const crypto=require('node:crypto');
function env(){
 const values={},cache={};let held=false,now=Date.parse('2026-09-12T00:00:00Z');
 class Clock extends Date {constructor(...args){super(...(args.length?args:[now]));}static now(){return now;}}
 const props={getProperty:k=>values[k]??null,setProperty:(k,v)=>{assert.ok(Buffer.byteLength(String(v))<9000);values[k]=String(v);},deleteProperty:k=>delete values[k],getProperties:()=>({...values}),setProperties:p=>Object.assign(values,p)};
 const lock={tryLock:()=>{if(held)return false;held=true;return true;},releaseLock:()=>{held=false;}};
 const ctx={Date:Clock,PropertiesService:{getScriptProperties:()=>props},CacheService:{getScriptCache:()=>({get:k=>cache[k]??null,put:(k,v)=>cache[k]=v,remove:k=>delete cache[k]})},LockService:{getScriptLock:()=>lock},Utilities:{DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},computeDigest:(a,s)=>[...crypto.createHash('sha256').update(s).digest()],getUuid:()=>crypto.randomUUID(),formatDate:d=>d.toISOString().slice(0,10)}};
 vm.createContext(ctx);
 for(const file of ['../inventoryRiskMonitor.js','../inventoryRiskDelivery.js'])if(fs.existsSync(require.resolve(file)))vm.runInContext(fs.readFileSync(require.resolve(file),'utf8'),ctx);
 return {ctx,props,values,lock,setNow:value=>{now=Date.parse(value);}};
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
 c.inventoryRiskSlack_=method=>{const ts=String(c.Date.now()/1000);if(method==='chat.postMessage'){sends++;return {ok:true,ts,channel:'C123'};}return {ok:true,messages:[{ts,metadata:{event_type:'inventory_risk_alert',event_payload:{id:c.inventoryRiskLoadState_().pending.id}}}]};};
 assert.equal(c.flushInventoryRiskAlerts().status,'sent');
 assert.equal(c.flushInventoryRiskAlerts().status,'already_sent');assert.equal(sends,1);
});
test('accepted-but-timed-out post is reconciled from history before any retry',()=>{
 const {ctx:c,props}=env();props.setProperty('inventoryRisk_v1_enabled','true');props.setProperty('inventoryRisk_v1_channel','C123');
 c.getInventoryRiskReport=()=>report();let sends=0,accepted;
 c.inventoryRiskSlack_=method=>{if(method==='chat.postMessage'){sends++;accepted=c.inventoryRiskLoadState_().pending.id;throw new Error('timeout');}return {ok:true,messages:[{ts:String(c.Date.now()/1000),metadata:{event_type:'inventory_risk_alert',event_payload:{id:accepted}}}]};};
 assert.equal(c.flushInventoryRiskAlerts().status,'pending');
 assert.equal(c.flushInventoryRiskAlerts().status,'already_sent');assert.equal(sends,1);
});

function deliveryEnv(){
 const e=env(),c=e.ctx;e.props.setProperty('inventoryRisk_v1_enabled','true');e.props.setProperty('inventoryRisk_v1_channel','C123');
 const posts=[],messages=[];let scans=0,alerts=[alert];
 c.getInventoryRiskReport=()=>{scans++;return {...report(alerts),generatedAt:new c.Date().toISOString()};};
 c.inventoryRiskSlack_=(method,payload)=>{
  if(method==='chat.postMessage'){
   posts.push(payload);const ts=String(c.Date.now()/1000);messages.push({...payload,ts});return {ok:true,ts,channel:'C123'};
  }
  return {ok:true,messages};
 };
 return {...e,posts,messages,scans:()=>scans,setAlerts:value=>{alerts=value;}};
}

test('quiet hours still scan; only the morning digest sends, including an unchanged risk next day',()=>{
 const e=deliveryEnv(),c=e.ctx;
 e.setNow('2026-09-11T23:59:00Z');assert.equal(c.flushInventoryRiskAlerts().status,'scheduled');
 assert.equal(e.scans(),1);assert.equal(e.posts.length,0);
 e.setNow('2026-09-12T00:00:00Z');assert.equal(c.inventoryRiskHeartbeat().status,'sent');
 e.setAlerts([{...alert,booked:3,shortage:2}]);
 e.setNow('2026-09-12T00:01:00Z');assert.equal(c.flushInventoryRiskAlerts().status,'already_sent');
 e.setNow('2026-09-12T10:00:00Z');c.flushInventoryRiskAlerts();assert.equal(e.posts.length,1);
 e.setNow('2026-09-13T00:00:00Z');assert.equal(c.inventoryRiskHeartbeat().status,'sent');
 assert.equal(e.posts.length,2);assert.match(e.posts[1].text,/아침 재고 점검/);assert.match(e.posts[1].text,/2개 부족/);
 e.setNow('2026-09-14T00:00:00Z');c.inventoryRiskHeartbeat();assert.equal(e.posts.length,3);
 assert.match(e.posts[2].text,/FX3/);assert.equal(e.scans(),6);
});

test('today\'s legacy receipt counts toward the daily limit in Korea, including before 09:00',()=>{
 const e=deliveryEnv(),c=e.ctx;
 c.inventoryRiskSaveState_({entries:{},pending:null,lastReceipt:{ts:String(Date.parse('2026-09-11T22:05:00Z')/1000),at:'2026-09-11T22:05:10Z'}});
 e.setNow('2026-09-12T00:00:00Z');const result=c.flushInventoryRiskAlerts();
 assert.equal(result.status,'already_sent');assert.equal(result.nextNotificationAt,'2026-09-13T00:00:00.000Z');assert.equal(e.posts.length,0);
 e.setNow('2026-09-13T00:00:00Z');c.flushInventoryRiskAlerts();assert.equal(e.posts.length,1);
});

test('a missed morning does not produce an evening alert; a clear morning has one concise summary',()=>{
 const e=deliveryEnv(),c=e.ctx;e.setAlerts([]);
 e.setNow('2026-09-12T10:00:00Z');assert.equal(c.flushInventoryRiskAlerts().status,'scheduled');assert.equal(e.posts.length,0);
 e.setNow('2026-09-13T00:00:00Z');assert.equal(c.flushInventoryRiskAlerts().status,'sent');
 assert.match(e.posts[0].text,/재고 충돌·위험 없음/);
 c.flushInventoryRiskAlerts();assert.equal(e.posts.length,1);
});

test('a previous uncertain delivery is reconciled before 09:00 without counting verification as today\'s send',()=>{
 const e=deliveryEnv(),c=e.ctx,original=c.inventoryRiskSlack_;let first=true;
 c.inventoryRiskSlack_=(method,payload)=>{const result=original(method,payload);if(method==='chat.postMessage'&&first){first=false;throw new Error('timeout');}return result;};
 assert.equal(c.flushInventoryRiskAlerts().status,'pending');assert.equal(e.posts.length,1);
 e.setNow('2026-09-12T23:59:00Z');assert.equal(c.flushInventoryRiskAlerts().status,'scheduled');
 assert.equal(c.inventoryRiskLoadState_().pending,null);assert.equal(e.posts.length,1);
 e.setNow('2026-09-13T00:00:00Z');assert.equal(c.flushInventoryRiskAlerts().status,'sent');assert.equal(e.posts.length,2);
});

test('an unsent outbox waits for morning and sends the fresh snapshot, not yesterday\'s warning',()=>{
 const e=deliveryEnv(),c=e.ctx,original=c.inventoryRiskSlack_;
 c.inventoryRiskSlack_=(method,payload)=>{if(method==='chat.postMessage')throw new Error('timeout');return original(method,payload);};
 assert.equal(c.flushInventoryRiskAlerts().status,'pending');
 c.inventoryRiskSlack_=original;e.setNow('2026-09-12T23:59:00Z');c.flushInventoryRiskAlerts();assert.equal(e.posts.length,0);
 e.setAlerts([{...alert,equipment:'FX6',booked:4,shortage:3}]);
 e.setNow('2026-09-13T00:00:00Z');assert.equal(c.flushInventoryRiskAlerts().status,'already_sent');
 assert.equal(e.posts.length,1);assert.match(e.posts[0].text,/FX6/);assert.match(e.posts[0].text,/3개 부족/);
 c.flushInventoryRiskAlerts();assert.equal(e.posts.length,1);
});

test('schedule setup preserves the existing channel, stock buffer and single scanning trigger',()=>{
 const e=deliveryEnv(),c=e.ctx;
 e.props.setProperty('inventoryRisk_v1_turnaroundMinutes','60');
 c.ScriptApp={getProjectTriggers:()=>[{getHandlerFunction:()=> 'inventoryRiskHeartbeat'}]};
 const status=c.setupInventoryRiskMonitor({notificationHour:9});
 assert.equal(status.enabled,true);assert.equal(status.notificationFrequency,'daily');assert.equal(status.notificationHour,9);
 assert.equal(status.notificationTimeZone,'Asia/Seoul');assert.equal(status.channel,'C123');assert.equal(status.turnaroundMinutes,60);
 assert.equal(status.triggerCount,1);assert.equal(e.posts.length,0);
 assert.throws(()=>c.setupInventoryRiskMonitor({notificationHour:24}),/알림 시간/);
 assert.equal(e.props.getProperty('inventoryRisk_v1_notificationHour'),'9');
});
test('Slack read methods use query arguments and rate-limit retries honor Retry-After',()=>{
 const {ctx:c,props}=env();props.setProperty('inventoryRisk_v1_slackToken','test-token');let calls=0;
 c.UrlFetchApp={fetch:(url,options)=>{calls++;assert.equal(options.method,'get');assert.match(url,/channel=C123/);assert.equal(options.payload,undefined);return {getResponseCode:()=>429,getAllHeaders:()=>({'Retry-After':'120'}),getContentText:()=>'{"ok":false,"error":"ratelimited"}'};}};
 assert.throws(()=>c.inventoryRiskSlack_('conversations.history',{channel:'C123'}));
 assert.throws(()=>c.inventoryRiskSlack_('conversations.history',{channel:'C123'}));
 assert.equal(calls,1);
});
