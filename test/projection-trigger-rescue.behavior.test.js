const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const gas=fs.readFileSync(path.join(__dirname,'../checkAvailability.js'),'utf8');
function fixture(){
 let now=1000000,exists=false;const state={},replaced=[];
 const props={getProperty:k=>state[k],setProperty:(k,v)=>state[k]=v,deleteProperty:k=>delete state[k]};
 const ctx={Date:{now:()=>now},PropertiesService:{getScriptProperties:()=>props},Logger:{log(){}},
 ScriptApp:{getProjectTriggers:()=>exists?[{getHandlerFunction:()=> 'flushDashboardStructureProjectionQueue_'}]:[]}};
 vm.runInNewContext(gas,ctx);
 ctx.replaceOneShotTrigger_=(handler,delay)=>{exists=true;replaced.push({at:now,delay});};
 return {ctx,state,replaced,advance:ms=>now+=ms,missing:()=>exists=false};
}
test('minute rescue preserves a slightly overdue trigger instead of postponing it every minute',()=>{
 const f=fixture();f.ctx.ensureDashboardStructureProjectionTrigger_(1000);
 for(let i=0;i<4;i++){f.advance(60000);f.ctx.ensureDashboardStructureProjectionTrigger_(1000);}
 assert.equal(f.replaced.length,1);
});
test('a genuinely stale trigger is replaced once and the replacement is allowed to fire',()=>{
 const f=fixture();f.ctx.ensureDashboardStructureProjectionTrigger_(1000);
 f.advance(6*60000);f.ctx.ensureDashboardStructureProjectionTrigger_(1000);
 f.advance(60000);f.ctx.ensureDashboardStructureProjectionTrigger_(1000);
 assert.equal(f.replaced.length,2);
});
test('a missing trigger is recreated even while its timestamp is fresh',()=>{
 const f=fixture();f.ctx.ensureDashboardStructureProjectionTrigger_(1000);f.missing();
 f.advance(500);f.ctx.ensureDashboardStructureProjectionTrigger_(1000);assert.equal(f.replaced.length,2);
});
test('urgent due work can preempt a much later future trigger',()=>{
 const f=fixture();f.ctx.ensureDashboardStructureProjectionTrigger_(10*60000);
 f.advance(500);f.ctx.ensureDashboardStructureProjectionTrigger_(1000);assert.equal(f.replaced.length,2);
});
