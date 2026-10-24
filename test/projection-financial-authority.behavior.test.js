const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'..','supabaseSync.js'),'utf8');
const start=source.indexOf('function buildSupabaseTrades_'),end=source.indexOf('\n/** payload 키 구성이 같은 행끼리 묶어 upsert');
function fixture({fresh={tradeRowFound:true,actualAmount:182160,contractUrl:'new-contract',contractRegenPending:false,paymentMethod:'must-not-copy'},missingDetail=false,readThrows=false}={}){
 const calls=[];const rows=[['target-01','target','','camera',1,'2026-10-23','19:00','2026-10-25','22:00','予約','',10000]];
 const sheet={getLastRow:()=>2,getRange:()=>({getValues:()=>rows,getDisplayValues:()=>rows})};
 const c={Date,JSON,Math,Object,String,Number,Array,Utilities:{formatDate:()=> '2026-10-23'},parseDT:()=>null,
  PropertiesService:{getScriptProperties:()=>({getProperties:()=>({})})},
  SpreadsheetApp:{getActiveSpreadsheet:()=>({getSheetByName:()=>sheet})},
  getTimelineData:()=>({groups:[],items:[{tid:'target',s:Date.parse('2026-10-23T10:00Z'),e:Date.parse('2026-10-25T13:00Z')}]}),
  getDashboardData:()=>({checkout:missingDetail?[]:[{tradeId:'target',name:'target',contractUrl:'stale-contract',actualAmount:134640,contractRegenPending:true,paymentMethod:'preserve-card',equipments:[]}],checkin:[]}),
  getTradeExtrasForIds_:(ids,props,options)=>{calls.push({ids,options});if(readThrows)throw Error('ledger unavailable');return {target:fresh};}
 };vm.createContext(c);vm.runInContext(source.slice(start,end),c);return{out:c.buildSupabaseTrades_(['target']),calls};
}
test('stale dashboard cannot restore an older amount, document, or pending state',()=>{
 const {out,calls}=fixture(),row=out.trades[0];
 assert.equal(row.amount,182160);assert.equal(row.contract_url,'new-contract');assert.equal(row.contract_regen_pending,false);
 assert.equal(row.payment_method,'preserve-card');assert.equal(out.items[0].schedule_id,'target-01');
 assert.equal(calls.length,1);assert.equal(calls[0].options.forceFresh,true);assert.deepEqual(Array.from(calls[0].ids),['target']);
});
test('a missing cached card still projects fresh contract metadata with authoritative sheet items',()=>{
 const {out}=fixture({missingDetail:true});assert.equal(out.trades[0].amount,182160);assert.equal(out.trades[0].contract_url,'new-contract');assert.equal(out.items.length,1);
});
for(const options of [{fresh:{tradeRowFound:false,actualAmount:0,contractUrl:''}},{readThrows:true}])test('failed or absent financial authority preserves existing DB fields instead of writing cached values '+JSON.stringify(options),()=>{
 const {out}=fixture(options);assert.equal(out.trades.length,0);assert.equal(out.items.length,0);assert.deepEqual(Array.from(out.deferredTradeIds),['target']);
});
function runDirtyWorker(allDeferred=false){
 const values={dirty_target:'one',dirty_other:'two'},sent=[],mirrored=[];
 const context={Logger:{log(){}},SUPA_DIRTY_PREFIX_:'dirty_',SUPA_CFG_:()=>({url:'https://example.invalid',apikey:'test'}),rescueDashboardAsyncWorkerTriggers_:()=>{},migrateLegacySupaDirtyProperties_:()=>{},
  PropertiesService:{getScriptProperties:()=>({getProperties:()=>({...values}),getProperty:k=>values[k],deleteProperty:k=>{delete values[k];}})},LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},
  buildSupabaseTrades_:()=>({trades:allDeferred?[]:[{trade_id:'other'}],items:[],deferredTradeIds:allDeferred?['target','other']:['target']}),
  supaDropOverwritingNotes_:()=>{},supaUpsertGrouped_:(_cfg,table,rows)=>{sent.push({table,rows});return true;},flushPaymentLedgerMirror_:ids=>{mirrored.push(Array.from(ids));return true;}
 };vm.createContext(context);const a=source.indexOf('function flushDirtyToSupabase()'),b=source.indexOf('/** 거래ID 배열',a);vm.runInContext(source.slice(a,b),context);context.flushDirtyToSupabase();return{values,sent,mirrored};
}
test('dirty cleanup retains unreadable financial work while completing other trades',()=>{
 const {values,sent,mirrored}=runDirtyWorker();assert.equal(values.dirty_target,'one');assert.equal(Object.hasOwn(values,'dirty_other'),false);assert.equal(sent.length,1);assert.deepEqual(mirrored,[['other']]);
});
test('a financial outage keeps dirty markers and causes no projection or payment HTTP',()=>{
 const {values,sent,mirrored}=runDirtyWorker(true);assert.equal(Object.keys(values).length,2);assert.equal(sent.length,0);assert.equal(mirrored.length,0);
});

test('full sync refuses partial authority without any external projection or success report',()=>{
 const calls=[],logs=[];const c={Utilities:{formatDate:()=> '2026-10-23'},getTimelineData:()=>({items:[{tid:'target'}]}),SUPA_CFG_:()=>({url:'https://example.invalid',apikey:'test'}),
 buildSupabaseTrades_:()=>({trades:[],items:[],deferredTradeIds:['target']}),supaUpsert_:()=>{calls.push('http');},Logger:{log:m=>logs.push(m)}};
 vm.createContext(c);const a=source.indexOf('function fullSyncToSupabase()'),b=source.indexOf('/* ─',a);vm.runInContext(source.slice(a,b),c);
 assert.throws(()=>c.fullSyncToSupabase(),/원장/);assert.equal(calls.length,0);assert.equal(logs.some(x=>x.includes('전체 동기화:')),false);
});
