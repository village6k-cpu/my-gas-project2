const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../generatecontract.js'),'utf8');
function fixture(){
 const props=new Map(),tid='260403-015',events=[];let held=false;
 const ctx={Date,PropertiesService:{getScriptProperties:()=>({getProperty:k=>props.get(k)||null,setProperty:(k,v)=>props.set(k,String(v)),deleteProperty:k=>props.delete(k)})},
  Utilities:{getUuid:()=> 'regen-1'},LockService:{getScriptLock:()=>({hasLock:()=>held,tryLock:()=>{held=true;return true;},releaseLock:()=>{held=false;}})},Logger:{log(){}}};
 vm.runInNewContext(source,ctx);
 ctx.trashContractFilesForTrade_=()=>{events.push({stage:'trash',claim:props.has('contractDirectRegen_v1_'+tid),held});};
 ctx.generateContractFile=()=>{events.push({stage:'generate',claim:props.has('contractDirectRegen_v1_'+tid),held});if(ctx.throwDuringGenerate)throw Error('generation failure');return {url:'url'};};
 return {ctx,props,tid,events};
}
test('direct and queued regeneration publish exclusion before any document/ledger mutation without holding global lock',()=>{
 const f=fixture();f.ctx.deleteAndRegenerateContract({getSheetByName:()=>null},f.tid,'');
 assert.deepEqual(f.events.map(e=>e.claim),[true,true]);assert.deepEqual(f.events.map(e=>e.held),[false,false]);assert.equal(f.props.has('contractDirectRegen_v1_'+f.tid),false);
});
test('concurrent direct regeneration is rejected before trashing any document',()=>{
 const f=fixture();f.props.set('contractDirectRegen_v1_'+f.tid,JSON.stringify({at:Date.now(),token:'other'}));
 assert.throws(()=>f.ctx.deleteAndRegenerateContract({getSheetByName:()=>null},f.tid,''),/진행|busy/);assert.equal(f.events.length,0);
});
test('generation error releases only its own exclusion marker',()=>{
 const f=fixture();f.ctx.throwDuringGenerate=true;
 assert.throws(()=>f.ctx.deleteAndRegenerateContract({getSheetByName:()=>null},f.tid,''),/generation failure/);assert.equal(f.props.has('contractDirectRegen_v1_'+f.tid),false);
});
