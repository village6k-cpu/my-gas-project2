const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const compile = source => ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const tick = () => new Promise(resolve => setImmediate(resolve));
function load(file, cache = new Map()) {
  if (cache.has(file)) return cache.get(file);
  const m = {exports:{}}; cache.set(file,m.exports);
  vm.runInNewContext(compile(fs.readFileSync(path.join(root,file),'utf8')), {module:m,exports:m.exports,structuredClone,Date,Intl,Map,Set,Promise,require:n=>load(path.relative(root,path.resolve(root,path.dirname(file),n+'.ts')),cache)});
  return m.exports;
}
const domain = load('lib/domain/packing.ts');
function fixture() {
  const trade = {tradeId:'261105-999',contractStatus:'예약',setupDone:false,returnDone:false,equipments:[{scheduleId:'line',name:'스몰HD용 SDI 연선',qty:1,setName:'BURANO',isComponent:true,checkoutState:'pending'}]};
  trade.packing = domain.transitionPacking(trade,{action:'start'},new Date().toISOString());
  return trade;
}
function harness() {
  const state = {trades:[fixture()],savingTrades:{'261105-999':true}}, requests=[];
  const mod={exports:{}};
  const queue = load('lib/data/packingCheckQueue.ts').createPackingCheckQueue({read:()=>state.trades[0],show:(_,packing)=>{state.trades[0]={...state.trades[0],packing}},persist:async()=>{throw new Error('unexpected check')},start:()=>()=>{},recover:async()=>{}});
  const ctx={module:mod,exports:mod.exports,state,packingCheckQueue:queue,activeTradeTransitions:new Set(),pendingRemoveEquipmentTrades:new Set(),hasTradePending:()=>true,
    settlePackingDependencies_:async()=>{},rebasePackingCommand:load("lib/data/packingCommand.ts").rebasePackingCommand,packingPreparationTrade:domain.packingPreparationTrade,optimisticPackingCheck:domain.optimisticPackingCheck,
    beginTradeTransition:()=>1,finishTradeSave:()=>{},AbortSignal,Date,structuredClone,
    mutateTrade:(_,fn)=>{state.trades[0]=fn(state.trades[0])},fetchTradesByIds:async()=>[],mergeTradeChanges:(_,fresh)=>fresh,set:patch=>Object.assign(state,patch),
    authFetch:async(url,options)=>{const body=JSON.parse(options.body);requests.push(body);return {ok:true,json:async()=>({packing:domain.transitionPacking(state.trades[0],body.command,new Date().toISOString())})}}
  };
  const source=fs.readFileSync(process.env.PACKING_STORE_SOURCE||path.join(root,'lib/data/store.ts'),'utf8');
  vm.runInNewContext(compile(source.slice(source.indexOf('export async function savePacking('),source.indexOf('export async function toggleSetup('))),ctx);
  return {state,requests,ctx,save:mod.exports.savePacking};
}
test('unrelated payment/body save does not reject a packing note with whole-trade busy',async()=>{
  const h=harness(),p=h.state.trades[0].packing;
  await h.save('261105-999',p.version,{action:'save',entries:p.entries,note:'인계 메모'});
  assert.equal(h.requests.length,1);
  assert.equal(h.state.trades[0].packing.note,'인계 메모');
});
function deferred(){let resolve,reject;const promise=new Promise((r,j)=>{resolve=r;reject=j});return {promise,resolve,reject};}
const rebase=load('lib/data/packingCommand.ts').rebasePackingCommand;
test('two packing edits wait in order and preserve the earlier note with the later quantity',async()=>{
  const h=harness(),base=structuredClone(h.state.trades[0].packing),gate=deferred();
  const fetch=h.ctx.authFetch;let calls=0;
  h.ctx.authFetch=async(...args)=>{if(++calls===1)await gate.promise;return fetch(...args)};
  const first=h.save('261105-999',base.version,{action:'save',entries:base.entries,note:'최신 메모'});
  const second=h.save('261105-999',base.version,{action:'save',entries:base.entries.map(e=>({...e,qty:2})),note:base.note});
  await tick();assert.equal(calls,1);gate.resolve();await Promise.all([first,second]);
  assert.deepEqual(h.requests.map(r=>r.version),[base.version,base.version+1]);
  assert.equal(h.state.trades[0].packing.note,'최신 메모');assert.equal(h.state.trades[0].packing.entries[0].qty,2);
});
test('packing command waits for structural dependency without reporting whole-trade busy',async()=>{
  const h=harness(),p=h.state.trades[0].packing,gate=deferred();
  h.ctx.settlePackingDependencies_=()=>gate.promise;
  const done=h.save('261105-999',p.version,{action:'save',entries:p.entries,note:'보존'});
  await tick();assert.equal(h.requests.length,0);gate.resolve();await done;assert.equal(h.requests.length,1);
});
test('failed earlier save cancels queued commands rather than applying them to uncertain state',async()=>{
  const h=harness(),base=h.state.trades[0].packing,gate=deferred();let calls=0;
  h.ctx.authFetch=async()=>{calls++;await gate.promise;return {ok:false,json:async()=>({error:'연결 끊김'})}};
  const a=h.save('261105-999',base.version,{action:'save',entries:base.entries,note:'A'});
  const b=h.save('261105-999',base.version,{action:'save',entries:base.entries,note:'B'});
  const results=Promise.allSettled([a,b]);gate.resolve();assert((await results).every(r=>r.status==='rejected'));assert.equal(calls,1);
});
test('rebase retains confirmed checks, another note, and added entries',()=>{
  const base=fixture().packing,latest=structuredClone(base);latest.version++;latest.note='다른 메모';latest.entries[0].checked=true;
  latest.entries.push({...latest.entries[0],id:'other'});
  const cmd={action:'save',entries:base.entries.map(e=>({...e,qty:2})),note:base.note};
  const merged=rebase(cmd,base,latest);assert.equal(merged.entries[0].checked,true);assert.equal(merged.entries[0].qty,2);assert.equal(merged.entries.length,2);assert.equal(merged.note,'다른 메모');
});
test('same-field conflict and removed target are not silently overwritten',()=>{
  const base=fixture().packing,latest=structuredClone(base);latest.version++;latest.entries[0].qty=3;
  const cmd={action:'save',entries:base.entries.map(e=>({...e,qty:2})),note:base.note};
  assert.throws(()=>rebase(cmd,base,latest),/같은 구성품/);latest.entries=[];assert.throws(()=>rebase(cmd,base,latest),/같은 구성품/);
});
test('stale editor version is rejected without sending a write',async()=>{
  const h=harness(),p=h.state.trades[0].packing;
  await assert.rejects(h.save('261105-999',p.version-1,{action:'save',entries:p.entries,note:'old'}),/편집 중/);assert.equal(h.requests.length,0);
});
test('an editor opened before a confirmed check merges its quantity while preserving the check and note',async()=>{
  const h=harness(),base=structuredClone(h.state.trades[0].packing);
  h.state.trades[0].packing.version++;h.state.trades[0].packing.entries[0].checked=true;h.state.trades[0].packing.note='먼저 저장한 메모';
  await h.save('261105-999',base.version,{action:'save',entries:base.entries.map(e=>({...e,qty:2})),note:base.note},base);
  assert.equal(h.requests[0].command.entries[0].checked,true);assert.equal(h.requests[0].command.note,'먼저 저장한 메모');
  assert.equal(h.state.trades[0].packing.entries[0].checked,false,'changed quantity requires actual preparation again');
});
function realDependencies(h){
  Object.assign(h.ctx,{setTimeout,clearTimeout,subscribe:()=>()=>{},flushQueuedItemQtyForTrade:async()=>{},flushItemCheckWritesForTrade:async()=>{},itemNameMutationIds:{},itemNameCommitRetryTimers:{},itemNameCommitInFlight:{},itemNameCommitFailures:{},removeEquipmentFailures:new Map(),flushRemoveEquipmentBatch_:()=>{},pendingRemoveEquipmentEntries_:()=>[]});
  const source=fs.readFileSync(path.join(root,'lib/data/store.ts'),'utf8');
  vm.runInNewContext(compile(source.slice(source.indexOf('async function settlePackingDependencies_'),source.indexOf('export async function savePacking('))),h.ctx);
}
test('exclude then apply reservation changes waits for removal and uses its latest manifest, even during unrelated saving',async()=>{
  const h=harness(),p=h.state.trades[0].packing,gate=deferred();realDependencies(h);
  h.ctx.pendingRemoveEquipmentTrades.add('261105-999');
  h.ctx.commitRemoveEquipmentBatch_=async()=>{await gate.promise;h.ctx.pendingRemoveEquipmentTrades.clear();h.state.trades[0].packing={...p,version:p.version+1};};
  const result=h.save('261105-999',p.version,{action:'refresh'});await tick();assert.equal(h.requests.length,0);
  gate.resolve();await result;assert.equal(h.requests.length,1);assert.equal(h.requests[0].version,p.version+1);assert.equal(h.requests[0].command.action,'refresh');
});
test('a failed dependency prevents reservation refresh instead of acknowledging an uncertain change',async()=>{
  const h=harness(),p=h.state.trades[0].packing;realDependencies(h);h.ctx.pendingRemoveEquipmentTrades.add('261105-999');
  h.ctx.commitRemoveEquipmentBatch_=async()=>{h.ctx.pendingRemoveEquipmentTrades.clear();h.ctx.removeEquipmentFailures.set('261105-999','제외 저장 실패')};
  await assert.rejects(h.save('261105-999',p.version,{action:'refresh'}),/제외 저장 실패/);assert.equal(h.requests.length,0);
});
test('automatic refresh and manual apply can overlap without rejecting or using the same version',async()=>{
  const h=harness(),p=h.state.trades[0].packing,gate=deferred();h.ctx.settlePackingDependencies_=()=>gate.promise;
  const a=h.save('261105-999',p.version,{action:'refresh'}),b=h.save('261105-999',p.version,{action:'refresh'});
  await tick();assert.equal(h.requests.length,0);gate.resolve();await Promise.all([a,b]);
  assert.deepEqual(h.requests.map(r=>r.version),[p.version,p.version+1]);
});
