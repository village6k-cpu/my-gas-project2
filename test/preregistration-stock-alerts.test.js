const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const path = require('node:path');

function env() {
  const values = {}; let held = false, now = Date.parse('2026-09-13T00:10:00Z');
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const props = {getProperty:k=>values[k]??null, setProperty:(k,v)=>{assert.ok(Buffer.byteLength(String(v))<9000);values[k]=String(v);}, deleteProperty:k=>delete values[k],getProperties:()=>({...values})};
  const lock = {hasLock:()=>held,tryLock:()=>{if(held)return false;held=true;return true;},releaseLock:()=>{held=false;}};
  let inputHeld=false;
  const inputLock={hasLock:()=>inputHeld,waitLock:()=>{inputHeld=true;},tryLock:()=>{inputHeld=true;return true;},releaseLock:()=>{inputHeld=false;}};
  const ctx = {Date:Clock,PropertiesService:{getScriptProperties:()=>props},LockService:{getScriptLock:()=>lock,getUserLock:()=>inputLock},Utilities:{getUuid:()=>crypto.randomUUID(),DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},computeDigest:(_,s)=>[...crypto.createHash('sha256').update(s).digest()],formatDate:d=>new Date(+d+9*3600000).toISOString().slice(5,16).replace('T',' ')}};
  vm.createContext(ctx);
  for(const name of ['inventorySupply.js','inventoryRisk.js','stockAlertReceipt.js','preRegistrationStockAlerts.js']) { const p=path.join(__dirname,'..',name); if(fs.existsSync(p))vm.runInContext(fs.readFileSync(p,'utf8'),ctx); }
  props.setProperty('preRegStock_v1_enabled','true');props.setProperty('preRegStock_v1_channel','C0B769B394K');
  return {c:ctx,props,values,lock,inputLock,advance:ms=>now+=ms};
}
const period={start:'2026-09-13T09:00:00+09:00',end:'2026-09-13T23:00:00+09:00'};
const request=(over={})=>({id:'RQ-260912-013',customer:'김예진',tradeId:'',rows:[{id:'request-1',name:'R6 세트',setName:'R6 세트',quantity:1,...period}],...over});
const equipment=(over={})=>({id:'LNS-028',name:'캐논 100-500mm',aliases:['캐논 100-500 렌즈'],stock:1,maintenance:0,category:'렌즈',...over});
const booking=(over={})=>({id:'old-1',tradeId:'260907-009',customer:'박나림',name:'캐논 100-500 렌즈',quantity:1,start:'2026-09-10T21:00:00+09:00',end:'2026-09-14T22:00:00+09:00',status:'대기',...over});
const snapshot=(over={})=>({equipment:[equipment()],sets:[{name:'R6 세트',components:[{name:'캐논 100-500 렌즈',quantity:1,tracked:true},{name:'메모리 / 배터리',quantity:1,tracked:false}]}],schedules:[booking()],sourceIssues:[],...over});
const plain=x=>JSON.parse(JSON.stringify(x));

test('set component alias finds the real lens shortage before any booking write',()=>{
 const {c}=env();const s=snapshot(),r=request(),before=JSON.stringify([s,r]);
 const result=plain(c.preRegistrationStockEvaluate_(r,s));
 assert.equal(result.shortages.length,1);assert.equal(result.shortages[0].equipment,'캐논 100-500mm');
 assert.equal(result.shortages[0].available,0);assert.equal(result.shortages[0].shortage,1);
 assert.equal(result.shortages[0].bookings[0].customer,'박나림');
 assert.equal(JSON.stringify([s,r]),before);
 const text=c.preRegistrationStockText_(result);
 assert.match(text,/김예진/);assert.match(text,/100-500/);assert.match(text,/필요 1.*가용 0/);assert.ok(text.length<1600);
});

test('memory and batteries never become shortage alerts, even with zero stock',()=>{
 const {c}=env();const r=request({rows:[{id:'m',name:'소니 CF-A 160',quantity:9,...period},{id:'b',name:'NP-FZ100',quantity:9,...period}]});
 const s=snapshot({sets:[],schedules:[],equipment:[equipment({id:'m',name:'소니 CF-A 160',category:'메모리',stock:0}),equipment({id:'b',name:'NP-FZ100',category:'배터리',stock:0})]});
 const result=c.preRegistrationStockEvaluate_(r,s);assert.equal(result.shortages.length,0);assert.equal(result.uncertain.length,0);
});

test('available upper models and confirmed external supply prevent false shortage alerts',()=>{
 const {c}=env();const lower=equipment({id:'g1',name:'소니 GM 70-200mm',aliases:[],stock:1});
 const upper=equipment({id:'g2',name:'소니 GM 70-200mm II',aliases:[],stock:1});
 const r=request({rows:[{id:'g',name:lower.name,quantity:2,...period}]});
 assert.equal(c.preRegistrationStockEvaluate_(r,snapshot({sets:[],schedules:[],equipment:[lower,upper]})).shortages.length,0);
 const external=booking({quantity:2,note:'[외부조달] 아나키 | 캐논 100-500 렌즈 | 2대 | 2026-09-10 21:00 ~ 2026-09-14 22:00'});
 assert.equal(c.preRegistrationStockEvaluate_(request(),snapshot({schedules:[external]})).shortages.length,0);
});

test('unknown tracked models raise uncertainty and never silently become available',()=>{
 const {c}=env();const result=c.preRegistrationStockEvaluate_(request(),snapshot({equipment:[equipment({aliases:[]})]}));
 assert.equal(result.shortages.length,0);assert.ok(result.uncertain.some(a=>a.kind==='unknown_equipment'));
});

test('memory cards missing from the catalog still follow the memory exclusion policy',()=>{
 const {c}=env();const r=request({rows:[{id:'card',name:'소니 XQD 128',quantity:2,...period}]});
 const result=c.preRegistrationStockEvaluate_(r,snapshot({sets:[],equipment:[],schedules:[]}));
 assert.equal(result.shortages.length,0);assert.equal(result.uncertain.length,0);
});

test('unknown inventory count is not falsely reported as zero stock',()=>{
 const {c}=env();const result=c.preRegistrationStockEvaluate_(request(),snapshot({equipment:[equipment({stock:''})]}));
 assert.equal(result.shortages.length,0);assert.ok(result.uncertain.some(a=>a.kind==='unknown_stock'));
});

test('an unverified shortage notice cannot pass the registration step, while sufficient stock can',()=>{
 const {c}=env();c.preRegistrationStockRequest_=()=>request();c.readInventoryRiskSnapshot_=()=>snapshot();
 c.preRegistrationStockFlush_=()=>({status:'pending',results:[]});
 assert.equal(c.checkPreRegistrationStockBeforeRegister_('RQ-260912-013').ready,false);
 c.readInventoryRiskSnapshot_=()=>snapshot({schedules:[]});
 assert.equal(c.checkPreRegistrationStockBeforeRegister_('RQ-260912-013').ready,true);
});

test('registered reconciliation excludes its own trade and preserves other overlaps',()=>{
 const {c}=env();const own=booking({id:'self',tradeId:'260913-001'});
 const r=request({tradeId:'260913-001',registered:true});
 assert.equal(c.preRegistrationStockEvaluate_(r,snapshot({schedules:[own]})).shortages.length,0);
 assert.equal(c.preRegistrationStockEvaluate_(r,snapshot({schedules:[own,booking()]})).shortages[0].shortage,1);
});

test('delivery is immediate at 21:35, verified once, and repeated checks are quiet',()=>{
 const {c,advance}=env();advance(12*3600000+25*60000);let sent=0,posted;
 c.inventoryRiskSlack_=(method,p)=>{if(method==='chat.postMessage'){sent++;posted=p;return {ok:true,channel:p.channel,ts:'100.001'};}return {ok:true,messages:[{ts:'100.001',text:posted.text,metadata:posted.metadata}]};};
 const evaluation=c.preRegistrationStockEvaluate_(request(),snapshot());
 assert.equal(c.preRegistrationStockDeliver_(evaluation).status,'sent');
 assert.equal(c.preRegistrationStockDeliver_(evaluation).status,'already_sent');assert.equal(sent,1);assert.equal(posted.channel,'C0B769B394K');
});

test('uncertain delivery reconciles the existing message instead of replaying it',()=>{
 const {c,advance}=env();let sends=0,posted,offline=true;
 c.inventoryRiskSlack_=(method,p)=>{if(method==='chat.postMessage'){sends++;posted=p;throw Error('connection ended after delivery');}if(offline)throw Error('history unavailable');return {ok:true,messages:[{ts:'100.002',text:posted.text,metadata:posted.metadata}]};};
 const evaluation=c.preRegistrationStockEvaluate_(request(),snapshot());
 assert.equal(c.preRegistrationStockDeliver_(evaluation).status,'pending');
 offline=false;advance(60001);assert.equal(c.preRegistrationStockDeliver_(evaluation).status,'sent');assert.equal(sends,1);
});

test('changed shortage creates one new alert; lack of history evidence never duplicates',()=>{
 const {c,advance}=env();let sends=0,posted,hasMore=false;
 c.inventoryRiskSlack_=(method,p)=>{if(method==='chat.postMessage'){sends++;posted=p;return {ok:true,ts:'100.'+sends};}return hasMore?{ok:true,messages:[],has_more:true}:{ok:true,messages:[{ts:'100.'+sends,text:posted.text,metadata:posted.metadata}]};};
 const r=request(),s=snapshot();assert.equal(c.preRegistrationStockDeliver_(c.preRegistrationStockEvaluate_(r,s)).status,'sent');
 r.rows[0].quantity=2;hasMore=true;assert.equal(c.preRegistrationStockDeliver_(c.preRegistrationStockEvaluate_(r,s)).status,'pending');
 advance(60001);assert.equal(c.preRegistrationStockDeliver_(c.preRegistrationStockEvaluate_(r,s)).status,'pending');assert.equal(sends,2);
});

test('held/rejected rows are checked when registration explicitly resumes them',()=>{
 const {c}=env();c.SpreadsheetApp={getActiveSpreadsheet:()=>({})};
 c.inventoryRiskDateTime_=(day,clock)=>day&&clock?day+'T'+clock+':00+09:00':'';
 c.inventoryRiskSheetRows_=()=>({rows:[{'요청ID':'RQ-260912-013','반출일':'2026-09-13','반출시간':'09:00','반납일':'2026-09-13','반납시간':'23:00','장비or세트명':'R6 세트','수량':'1','예약자명':'김예진','등록상태':'보류','거래ID':'','비고':''}],value:(row,key)=>row[key] || ''});
 assert.equal(c.preRegistrationStockRequest_('RQ-260912-013',false,false),null);
 assert.equal(c.preRegistrationStockRequest_('RQ-260912-013',false,true).rows.length,1);
});

test('registered incident delivery retries through the heartbeat without losing its scope',()=>{
 const {c}=env();let posted,offline=true,sends=0;
 c.preRegistrationStockRequest_=(_,includeRegistered)=>includeRegistered?request({registered:true,tradeId:'260913-001'}):null;
 c.readInventoryRiskSnapshot_=()=>snapshot({schedules:[booking(),booking({id:'own',tradeId:'260913-001'})]});
 c.inventoryRiskSlack_=(method,p)=>{if(method==='chat.postMessage'){sends++;posted=p;throw Error('uncertain POST');}if(offline)throw Error('offline');return {ok:true,messages:[{ts:'110.1',text:posted.text,metadata:posted.metadata}]};};
 assert.equal(c.checkPreRegistrationStockAlert({requestId:'RQ-260912-013',notify:true,includeRegistered:true}).results[0].status,'pending');
 offline=false;assert.equal(c.flushPreRegistrationStockAlerts().results[0].status,'sent');assert.equal(sends,1);
});

test('registered notice retries use the changed schedule instead of the obsolete request copy',()=>{
 const {c}=env(),r=request({registered:true,tradeId:'260913-001'});
 const substitute=equipment({id:'replacement',name:'캐논 100-400mm II',aliases:[],stock:1});
 const own=booking({id:'own',tradeId:'260913-001',name:substitute.name,...period});
 const s=snapshot({equipment:[equipment(),substitute],schedules:[booking(),own]});
 let result=c.preRegistrationStockEvaluate_(r,s);
 assert.equal(result.shortages.length,0);assert.equal(result.uncertain.length,0);
 own.name=equipment().name;own.end='2026-09-13T18:00:00+09:00';
 result=c.preRegistrationStockEvaluate_(r,s);assert.equal(result.shortages.length,1);assert.equal(result.end,own.end);
 own.status='반납완료';
 result=c.preRegistrationStockEvaluate_(r,s);assert.equal(result.shortages.length,0);
 s.schedules=[booking()];result=c.preRegistrationStockEvaluate_(r,s);assert.equal(result.shortages.length,0);
});

test('excluded set components remain structurally present without shortage or missing-component alerts',()=>{
 const {c}=env();c.SpreadsheetApp={getActiveSpreadsheet:()=>({})};
 c.inventoryRiskDateTime_=(day,clock)=>day&&clock?day+'T'+clock+':00+09:00':'';
 const head={'요청ID':'RQ-260912-013','반출일':'2026-09-13','반출시간':'09:00','반납일':'2026-09-13','반납시간':'23:00','장비or세트명':'R6 세트','수량':'1','예약자명':'김예진','등록상태':'','비고':''};
 const lens={...head,'장비or세트명':'캐논 100-500 렌즈','등록상태':'제외','비고':'[세트]R6 세트'};
 let rows=[head,lens];c.inventoryRiskSheetRows_=()=>({rows,value:(row,key)=>row[key] || ''});
 const stock=snapshot({schedules:[],equipment:[equipment({stock:0})]});
 let read=c.preRegistrationStockRequest_('RQ-260912-013');
 assert.equal(read.rows.length,2);assert.equal(read.rows[1].status,'제외');
 let result=c.preRegistrationStockEvaluate_(read,stock);assert.equal(result.shortages.length,0);assert.equal(result.uncertain.length,0);
 rows.push({...head,'장비or세트명':'캐논 R6 Mark 2','비고':'[세트]R6 세트'});
 stock.sets[0].components.push({name:'캐논 R6 Mark 2',quantity:1,tracked:true});
 stock.equipment.push(equipment({id:'body',name:'캐논 R6 Mark 2',aliases:[],stock:1}));
 result=c.preRegistrationStockEvaluate_(c.preRegistrationStockRequest_('RQ-260912-013'),stock);
 assert.equal(result.shortages.length,0);assert.equal(result.uncertain.length,0);
});

test('heartbeat waits for an in-progress request, then checks the completed expansion',()=>{
 const {c,inputLock}=env();let incomplete=true,reads=0;
 inputLock.tryLock=()=>!incomplete;
 c.preRegistrationStockRequest_=()=>{reads++;return incomplete?null:request();};
 c.readInventoryRiskSnapshot_=()=>snapshot();c.preRegistrationStockDeliver_=e=>({status:'sent',requestId:e.requestId});
 c.queuePreRegistrationStockCheck_('RQ-260912-013');
 assert.equal(c.flushPreRegistrationStockAlerts().results[0].status,'pending');assert.equal(reads,0);
 assert.equal(c.getPreRegistrationStockAlertStatus().pending,1);
 incomplete=false;c.queuePreRegistrationStockCheck_('RQ-260912-013');
 assert.equal(c.flushPreRegistrationStockAlerts().results[0].status,'sent');assert.equal(reads,1);
 assert.equal(c.getPreRegistrationStockAlertStatus().pending,0);
});

test('a new generation queued at the exact acknowledgement boundary remains pending',()=>{
 const {c,props}=env();let next=0,checks=0;
 c.preRegistrationStockRequest_=()=>request();c.readInventoryRiskSnapshot_=()=>snapshot();
 c.preRegistrationStockDeliver_=e=>{checks++;return {status:'sent',requestId:e.requestId};};
 c.queuePreRegistrationStockCheck_('RQ-260912-013');
 const set=props.setProperty;
 props.setProperty=(key,value)=>{
   if(key==='preRegStock_v1_checked_RQ-260912-013' && !next++)c.queuePreRegistrationStockCheck_('RQ-260912-013');
   set(key,value);
 };
 c.flushPreRegistrationStockAlerts();assert.equal(c.getPreRegistrationStockAlertStatus().pending,1);
 c.flushPreRegistrationStockAlerts();assert.equal(checks,2);assert.equal(c.getPreRegistrationStockAlertStatus().pending,0);
});

test('retention preserves future receipts and waits for request writers before pruning closed generations',()=>{
 const {c,props,advance,inputLock}=env();const id='RQ-260912-013',prefix='preRegStock_v1_';
 c.queuePreRegistrationStockCheck_(id);props.setProperty(prefix+'checked_'+id,props.getProperty(prefix+'dirty_'+id));
 props.setProperty(prefix+'state_'+id,JSON.stringify({end:'2026-10-01T00:00:00Z'}));
 advance(8*86400000);c.preRegistrationStockPrune_(false);assert.ok(props.getProperty(prefix+'dirty_'+id));
 props.setProperty(prefix+'state_'+id,JSON.stringify({end:'2026-09-13T00:00:00Z'}));
 inputLock.tryLock=()=>false;c.preRegistrationStockPrune_(false);assert.ok(props.getProperty(prefix+'dirty_'+id));
 inputLock.tryLock=()=>true;c.preRegistrationStockPrune_(false);assert.equal(props.getProperty(prefix+'dirty_'+id),null);
 assert.equal(props.getProperty(prefix+'checked_'+id),null);assert.equal(props.getProperty(prefix+'state_'+id),null);
});

test('entry points queue checks and the registration hook precedes schedule writes',()=>{
 const source=fs.readFileSync(path.join(__dirname,'../checkAvailability.js'),'utf8');
 const register=source.slice(source.indexOf('function registerByReqID('),source.indexOf('function registerByReqID(')+42000);
 assert.match(source,/queuePreRegistrationStockCheck_\(triggerReqID\)/);
 const process=source.slice(source.indexOf('function _processByReqID('),source.indexOf('function hasProcessedRows_('));
 assert.ok(process.indexOf('queuePreRegistrationStockCheck_')>process.lastIndexOf('SpreadsheetApp.flush()'));
 const hook=register.indexOf('checkPreRegistrationStockBeforeRegister_');
 assert.ok(hook>0);assert.ok(hook<register.indexOf('schedSheet.getRange('));
 const delivery=fs.readFileSync(path.join(__dirname,'../inventoryRiskDelivery.js'),'utf8');assert.match(delivery,/function inventoryRiskHeartbeat\(\)[\s\S]*?flushPreRegistrationStockAlerts/);
});

test('Google quota exhaustion keeps a durable notice that an authenticated relay can acknowledge with a matching lease',()=>{
 const {c,props}=env();props.setProperty('preRegStock_v1_externalRelay','true');
 c.preRegistrationStockRequest_=()=>request();c.readInventoryRiskSnapshot_=()=>snapshot();
 c.inventoryRiskSlack_=()=>{throw Error('하루에 urlfetch 서비스를 너무 많이 호출했습니다.');};
 c.queuePreRegistrationStockCheck_('RQ-260912-013');
 const claim=c.claimPreRegistrationStockAlertRelay();assert.equal(claim.status,'claimed');assert.equal(claim.pending.transportRejected,true);
 const ack={requestId:claim.requestId,id:claim.pending.id,relayToken:claim.pending.relayToken,channel:'C0B769B394K',ts:'123.456',delivered:true};
 assert.equal(c.acknowledgePreRegistrationStockAlertRelay({...ack,relayToken:'wrong'}).status,'conflict');
 assert.equal(c.acknowledgePreRegistrationStockAlertRelay(ack).status,'sent');
 const result=c.flushPreRegistrationStockAlerts();assert.equal(result.results[0].status,'already_sent');
 assert.equal(c.getPreRegistrationStockAlertStatus().pending,0);
});

test('relay lease prevents a competing GAS send and obsolete release cannot discard a still-current notice',()=>{
 const {c,props}=env();props.setProperty('preRegStock_v1_externalRelay','true');
 c.preRegistrationStockRequest_=()=>request();c.readInventoryRiskSnapshot_=()=>snapshot();let calls=0;
 c.inventoryRiskSlack_=()=>{calls++;throw Error('quota');};c.queuePreRegistrationStockCheck_('RQ-260912-013');
 const claim=c.claimPreRegistrationStockAlertRelay(),before=calls;
 const evaluation=c.preRegistrationStockEvaluate_(request(),snapshot());
 assert.equal(c.preRegistrationStockDeliver_(evaluation).status,'pending');assert.equal(calls,before);
 const ack={requestId:claim.requestId,id:claim.pending.id,relayToken:claim.pending.relayToken,obsolete:true};
 assert.equal(c.acknowledgePreRegistrationStockAlertRelay(ack).status,'conflict');
 evaluation.shortages=[];evaluation.uncertain=[];c.preRegistrationStockDeliver_(evaluation);
 assert.equal(c.acknowledgePreRegistrationStockAlertRelay(ack).status,'obsolete');
});

test('a deleted, ended or skipped request invalidates a pending relay notice without losing its receipt identity',()=>{
 const {c,props}=env();props.setProperty('preRegStock_v1_externalRelay','true');
 c.preRegistrationStockRequest_=()=>request();c.readInventoryRiskSnapshot_=()=>snapshot();
 c.inventoryRiskSlack_=()=>{throw Error('quota');};c.queuePreRegistrationStockCheck_('RQ-260912-013');c.flushPreRegistrationStockAlerts();
 c.preRegistrationStockRequest_=()=>null;
 const claim=c.claimPreRegistrationStockAlertRelay();assert.equal(claim.status,'claimed');assert.equal(claim.pending.actionable,false);
 assert.equal(c.acknowledgePreRegistrationStockAlertRelay({requestId:claim.requestId,id:claim.pending.id,relayToken:claim.pending.relayToken,obsolete:true}).status,'obsolete');
});

test('relay cannot claim stale intent when the exact request is locked or its evaluation fails',()=>{
 const {c,props,inputLock}=env();props.setProperty('preRegStock_v1_externalRelay','true');
 c.preRegistrationStockRequest_=()=>request();c.readInventoryRiskSnapshot_=()=>snapshot();
 c.inventoryRiskSlack_=()=>{throw Error('quota');};c.queuePreRegistrationStockCheck_('RQ-260912-013');c.flushPreRegistrationStockAlerts();
 inputLock.tryLock=()=>false;
 assert.notEqual(c.claimPreRegistrationStockAlertRelay().status,'claimed');
 inputLock.tryLock=()=>true;c.readInventoryRiskSnapshot_=()=>{throw Error('snapshot unavailable');};
 assert.notEqual(c.claimPreRegistrationStockAlertRelay().status,'claimed');
});

test('relay refreshes its exact candidate beyond the batch limit and rejects a newer unverified generation',()=>{
 const {c,props}=env();props.setProperty('preRegStock_v1_externalRelay','true');
 c.preRegistrationStockRequest_=()=>request();c.readInventoryRiskSnapshot_=()=>snapshot();
 c.inventoryRiskSlack_=()=>{throw Error('quota');};const id='RQ-260912-013';
 c.queuePreRegistrationStockCheck_(id);c.flushPreRegistrationStockAlerts();
 for(let i=1;i<=4;i++)props.setProperty('preRegStock_v1_dirty_RQ-260901-00'+i,'1:'+i);
 const readIds=[];c.preRegistrationStockRequest_=key=>{readIds.push(key);return key===id?request():null;};
 const flush=c.preRegistrationStockFlush_;
 c.preRegistrationStockFlush_=(...args)=>{const result=flush(...args);c.queuePreRegistrationStockCheck_(id);return result;};
 assert.notEqual(c.claimPreRegistrationStockAlertRelay().status,'claimed');
 c.preRegistrationStockFlush_=flush;
 const claim=c.claimPreRegistrationStockAlertRelay();assert.equal(claim.status,'claimed');assert.equal(claim.requestId,id);
 assert.ok(readIds.includes(id));
});

test('relay acknowledgement cannot race a GAS state save and erase its verified receipt',()=>{
 const {c,props}=env();props.setProperty('preRegStock_v1_externalRelay','true');
 c.preRegistrationStockRequest_=()=>request();c.readInventoryRiskSnapshot_=()=>snapshot();
 c.inventoryRiskSlack_=()=>{throw Error('quota');};c.queuePreRegistrationStockCheck_('RQ-260912-013');
 const claim=c.claimPreRegistrationStockAlertRelay();
 const ack={requestId:claim.requestId,id:claim.pending.id,relayToken:claim.pending.relayToken,channel:claim.pending.channel,ts:'123.456',delivered:true};
 const set=props.setProperty;let concurrent;
 props.setProperty=(key,value)=>{if(key==='preRegStock_v1_state_'+claim.requestId && !concurrent)concurrent=c.acknowledgePreRegistrationStockAlertRelay(ack);set(key,value);};
 c.flushPreRegistrationStockAlerts();assert.equal(concurrent.status,'busy');
 props.setProperty=set;assert.equal(c.acknowledgePreRegistrationStockAlertRelay(ack).status,'sent');
 const state=JSON.parse(props.getProperty('preRegStock_v1_state_'+claim.requestId));assert.equal(state.pending,null);assert.equal(state.lastReceipt.ts,'123.456');
});

test('quota errors while reconciling history do not declare an uncertain POST rejected',()=>{
 const {c,props}=env();const evaluation=c.preRegistrationStockEvaluate_(request(),snapshot());
 c.inventoryRiskSlack_=method=>{throw Error(method==='chat.postMessage'?'unknown outcome':'하루에 urlfetch 서비스를 너무 많이 호출했습니다.');};
 assert.equal(c.preRegistrationStockDeliver_(evaluation).status,'pending');
 assert.equal(c.preRegistrationStockDeliver_(evaluation).status,'pending');
 const pending=JSON.parse(props.getProperty('preRegStock_v1_state_RQ-260912-013')).pending;
 assert.notEqual(pending.transportRejected,true);
});

test('a new POST clears the previous quota rejection before any uncertain outcome',()=>{
 const {c,props,advance}=env();const evaluation=c.preRegistrationStockEvaluate_(request(),snapshot());
 c.inventoryRiskSlack_=()=>{throw Error('하루에 urlfetch 서비스를 너무 많이 호출했습니다.');};c.preRegistrationStockDeliver_(evaluation);
 advance(60001);c.inventoryRiskSlack_=method=>{if(method==='chat.postMessage')throw Error('unknown outcome');return {messages:[]};};
 c.preRegistrationStockDeliver_(evaluation);
 const pending=JSON.parse(props.getProperty('preRegStock_v1_state_RQ-260912-013')).pending;
 assert.notEqual(pending.transportRejected,true);
});

test('a later owner hold cancels a registration-resume notice and preserves its delivery receipt identity',()=>{
 const {c,props}=env();props.setProperty('preRegStock_v1_externalRelay','true');
 const id='RQ-260912-013';props.setProperty('preRegStock_v1_registering_'+id,'true');
 c.preRegistrationStockRequest_=(_,registered,resume)=>resume?request():null;c.readInventoryRiskSnapshot_=()=>snapshot();
 c.inventoryRiskSlack_=()=>{throw Error('quota');};c.queuePreRegistrationStockCheck_(id);c.flushPreRegistrationStockAlerts();
 c.cancelPreRegistrationStockResume_(id);
 const claim=c.claimPreRegistrationStockAlertRelay();assert.equal(claim.status,'claimed');assert.equal(claim.pending.actionable,false);
 assert.equal(props.getProperty('preRegStock_v1_registering_'+id),null);
});

test('a change during relay history lookup is rejected at the final send decision boundary',async()=>{
 const {relayOnce}=require('../scripts/windows/inventory-stock-alert-relay');
 const {c,props}=env();props.setProperty('preRegStock_v1_externalRelay','true');
 c.preRegistrationStockRequest_=()=>request();c.readInventoryRiskSnapshot_=()=>snapshot();
 c.inventoryRiskSlack_=()=>{throw Error('하루에 urlfetch 서비스를 너무 많이 호출했습니다.');};c.queuePreRegistrationStockCheck_('RQ-260912-013');
 let posts=0;
 const result=await relayOnce({channel:'C0B769B394K',gas:async(name,args=[])=>plain(c[name](...args)),slack:async(name)=>{
   if(name==='chat.postMessage'){posts++;return {ts:'123.456'};}
   c.preRegistrationStockRequest_=()=>null;c.flushPreRegistrationStockAlerts();return {messages:[]};
 }});
 assert.equal(result.status,'stale');assert.equal(posts,0);
});

test('relay send authorization rejects a new request generation and records only an authorized attempt',()=>{
 const {c,props,advance}=env();props.setProperty('preRegStock_v1_externalRelay','true');
 c.preRegistrationStockRequest_=()=>request();c.readInventoryRiskSnapshot_=()=>snapshot();
 c.inventoryRiskSlack_=()=>{throw Error('하루에 urlfetch 서비스를 너무 많이 호출했습니다.');};const id='RQ-260912-013';c.queuePreRegistrationStockCheck_(id);
 const claim=c.claimPreRegistrationStockAlertRelay(),ack={requestId:id,id:claim.pending.id,relayToken:claim.pending.relayToken};
 advance(1000);const authorization=c.authorizePreRegistrationStockAlertRelay(ack);assert.equal(authorization.status,'authorized');
 assert.ok(authorization.validUntil>claim.pending.relayUntil);
 const saved=JSON.parse(props.getProperty('preRegStock_v1_state_'+id)).pending;
 assert.equal(saved.attemptedAt,claim.pending.attemptedAt+1000);assert.notEqual(saved.transportRejected,true);
 c.queuePreRegistrationStockCheck_(id);assert.equal(c.authorizePreRegistrationStockAlertRelay(ack).status,'stale');
});

test('Slack emoji aliases still verify the same receipt but changed wording does not',()=>{
 const {c}=env();const evaluation=c.preRegistrationStockEvaluate_(request(),snapshot());let posted;
 c.inventoryRiskSlack_=(name,p)=>{if(name==='chat.postMessage'){posted=p;return {ts:'123.456'};}return {messages:[{ts:'123.456',text:c.stockAlertSlackText_(posted.text),metadata:posted.metadata}]};};
 assert.equal(c.preRegistrationStockDeliver_(evaluation).status,'sent');
 const pending={id:posted.metadata.event_payload.id,channel:posted.channel,text:posted.text,ts:'123.456'};
 c.inventoryRiskSlack_=()=>({messages:[{ts:'123.456',text:c.stockAlertSlackText_(posted.text)+' changed',metadata:posted.metadata}]});
 assert.equal(c.preRegistrationStockReceipt_(pending).found,false);
});

test('off-catalog SD card names stay excluded even during a supplemental source outage',()=>{
 const {c}=env();
 for(const name of ['sd카드 256','SD 카드 256GB','microSD card 128GB','마이크로 SD 카드','XQD 카드 128','CF-A 160']) {
   const r=request({rows:[{id:'card',name,quantity:6,...period}]});
   const result=c.preRegistrationStockEvaluate_(r,snapshot({sets:[],equipment:[],schedules:[],sourceIssues:['temporary outage']}));
   assert.equal(result.shortages.length,0,name);assert.equal(result.uncertain.length,0,name);
 }
 for(const name of ['SD카드 리더기','소니 CF-A 리더기','FX3 세트 SD 카드 256'])assert.equal(c.inventorySupplyExcluded_(name),false,name);
});

test('flapping supplemental reads do not resend the same proven shortage',()=>{
 const {c}=env();let posts=0,posted;
 c.inventoryRiskSlack_=(name,p)=>{if(name==='chat.postMessage'){posts++;posted=p;return {ts:'123.456'};}return {messages:[{ts:'123.456',text:posted.text,metadata:posted.metadata}]};};
 const good=c.preRegistrationStockEvaluate_(request(),snapshot());
 const unavailable=c.preRegistrationStockEvaluate_(request(),snapshot({sourceIssues:['temporary outage']}));
 assert.equal(c.preRegistrationStockDeliver_(good).status,'sent');
 assert.equal(c.preRegistrationStockDeliver_(unavailable).status,'already_sent');
 assert.equal(c.preRegistrationStockDeliver_(good).status,'already_sent');assert.equal(posts,1);
 assert.ok(!c.preRegistrationStockText_(unavailable).includes('실재고·별칭'));
});
