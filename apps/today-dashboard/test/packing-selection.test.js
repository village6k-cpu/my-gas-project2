const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path'), ts = require('typescript');
const cache = new Map();
function load(name) {
  if (cache.has(name)) return cache.get(name);
  const m = {exports:{}};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(__dirname,'../lib/domain',name+'.ts'),'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,
    {module:m,exports:m.exports,require:n=>load(n.replace('./','')),structuredClone,Date,Intl,Map,Set});
  cache.set(name,m.exports); return m.exports;
}
const {transitionPacking:step,packingPreparationCommand:prepare} = load('packing');
const {registeredPart,MONITOR_MODELS} = load('packingCatalog');
const now='2026-11-06T00:00:00Z';
const device=(id,name,setName=name)=>({scheduleId:id,name,setName,qty:1,isComponent:true,checkoutState:'pending'});
const save=t=>step(t,{action:'save',entries:t.packing.entries,note:t.packing.note},now);
function monitorTrade() {
  const t={tradeId:'demo',contractStatus:'예약',setupDone:false,returnDone:false,equipments:[device('monitor','포트키 BM7')]};
  t.packing=step(t,{action:'start'},now);return t;
}
test('every monitor replacement produces a manifest that can select, check, save and reload',()=>{
  for (const name of MONITOR_MODELS) {
    const t=monitorTrade(); t.equipments[0].name=name;
    if(name!=='포트키 BM7') t.packing=step(t,{action:'reconcile',ownerId:'monitor',name},now);
    assert(t.packing.entries.every(e=>/^[\w:-]+$/.test(e.id)),name+' generated invalid entry ID');
    t.packing=save(t);
    t.packing.entries=t.packing.entries.map(e=>{const part=registeredPart(e.name.replace(/SDI or HDMI/i,'SDI'));return e.unresolved&&e.qty>0?{...e,name:part.name,partId:part.id}:e;});
    t.packing=save(t);
    t.packing.entries=t.packing.entries.map(e=>({...e,checked:e.qty>0}));
    t.packing=save(t);
    t.packing=JSON.parse(JSON.stringify(t.packing));
    assert(t.packing.entries.filter(e=>e.qty>0).every(e=>e.checked&&!e.unresolved),name);
  }
});
test('already persisted legacy Korean replacement ID does not block unrelated checks or its own selection',()=>{
  const t=monitorTrade();t.equipments[0].name='파이로 7';
  t.packing=step(t,{action:'reconcile',ownerId:'monitor',name:'파이로 7'},now);
  const choice=t.packing.entries.find(e=>e.unresolved&&e.qty);
  choice.id='replacement:monitor:파이로7용sdiorhdmi';
  t.packing.entries.find(e=>e.name==='파이로 7용 D탭').checked=true;
  t.packing=save(t);
  const part=registeredPart('파이로 7용 SDI');
  t.packing.entries=t.packing.entries.map(e=>e.id===choice.id?{...e,name:part.name,partId:part.id}:e);
  t.packing=save(t);
  assert.equal(t.packing.entries.find(e=>e.id===choice.id).unresolved,false);
  assert.equal(t.packing.entries.find(e=>e.name==='파이로 7용 D탭').checked,true);
});
function orphanTrade() {
  const t=monitorTrade();
  t.equipments.push({...device('set','소니 BURANO 베이직세트'),isSetHeader:true,isComponent:false},device('arm','노가암','소니 BURANO 베이직세트'));
  t.packing=step(t,{action:'refresh'},now);
  const arm=t.packing.entries.find(e=>e.sourceId==='arm');
  arm.ownerId='removed-monitor';arm.device='7인치 모니터';arm.checked=true;
  return t;
}
test('dangling owner triggers preparation repair even when source snapshot already matches',()=>{
  const t=orphanTrade();assert.equal(prepare(t)?.action,'refresh');
  t.packing=step(t,prepare(t),now);
  const arm=t.packing.entries.find(e=>e.sourceId==='arm');
  assert.equal(arm.qty,1);assert.notEqual(arm.ownerId,'removed-monitor');assert.equal(arm.checked,false);
  assert.equal(prepare(t),undefined);
  t.packing=save(t);
  const power=t.packing.entries.find(e=>e.name.includes('D탭'));power.checked=true;
  t.packing=save(t);assert.equal(t.packing.entries.find(e=>e.id===power.id).checked,true);
});
test('orphan custom accessory remains visible as common with quantity and identity preserved',()=>{
  const t=orphanTrade();t.packing.entries.push({id:'custom-row',partId:'custom:custom-row',custom:true,name:'현장 추가 케이블',device:'제외 장비',ownerId:'removed-monitor',qty:2,checked:true});
  t.packing=step(t,{action:'refresh'},now);
  const e=t.packing.entries.find(e=>e.id==='custom-row');
  assert(e);assert.equal(e.qty,2);assert.equal(e.ownerId,undefined);assert.equal(e.checked,false);
  assert.equal(e.partId,'custom:custom-row');assert.doesNotThrow(()=>save(t));
});
test('sealed manifests do not automatically repair owners and new malformed IDs remain rejected',()=>{
  const t=orphanTrade();t.packing.phase='sealed';assert.equal(prepare(t),undefined);
  const fresh=monitorTrade();fresh.packing.entries.push({...fresh.packing.entries[0],id:'new/invalid'});
  assert.throws(()=>save(fresh),/구성품 ID/);
});
