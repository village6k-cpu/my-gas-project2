const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const gas=fs.readFileSync(path.join(__dirname,'../checkAvailability.js'),'utf8');
const tid='261008-003';
function fixture(raw){
 const state={['dashboardStructureQueue_v1_'+tid]:raw,INTERNAL_KEY:'secret-must-not-leak'};
 let writes=0,remote=0;
 const props={getProperty:k=>state[k],getProperties:()=>({...state}),setProperty(){writes++;},deleteProperty(){writes++;}};
 const ctx={PropertiesService:{getScriptProperties:()=>props},ScriptApp:{getProjectTriggers:()=>[{getHandlerFunction:()=> 'flushDashboardStructureProjectionQueue_'}]},
  SpreadsheetApp:{getActiveSpreadsheet:()=>({getSheetByName:()=>({getLastRow:()=>2,getRange:()=>({getDisplayValues:()=>[[tid+'-01',tid]]})})})}};
 vm.runInNewContext(gas,ctx);ctx.supaGetCheckoutBaselineState_=()=>{remote++;throw Error('not a mutation/status dependency');};
 return {ctx,state,writes:()=>writes,remote:()=>remote};
}
test('projection status is read-only and reports only bounded operational fields, never credentials or tokens',()=>{
 const f=fixture(JSON.stringify({tradeId:tid,token:'secret-must-not-leak',revision:4,attempts:2,nextAt:123,addedScheduleIds:[tid+'-02'],removeScheduleIds:[tid+'-08'],lastError:'authorized_additions: failed',baselineItems:[{secret:'secret-must-not-leak'}]}));
 const x=f.ctx.repairDashboardTradeProjection_(tid,undefined,true);
 assert.equal(x.success,true);assert.equal(x.statusOnly,true);assert.equal(x.queue.revision,4);
 assert.deepEqual(Array.from(x.queue.addedScheduleIds),[tid+'-02']);assert.deepEqual(Array.from(x.sourceScheduleIds),[tid+'-01']);
 assert.equal(x.triggerCount,1);assert.equal(f.writes(),0);assert.equal(f.remote(),0);
 assert.equal(JSON.stringify(x).includes('secret-must-not-leak'),false);
});
test('a malformed queue remains inspectable without deleting accepted work',()=>{
 const f=fixture('not-json');const x=f.ctx.repairDashboardTradeProjection_(tid,undefined,true);
 assert.equal(x.queue.parseError,true);assert.equal(f.writes(),0);
});
test('diagnostic rejects a malformed trade id without exposing unrelated state',()=>{
 const f=fixture('{}');assert.ok(f.ctx.repairDashboardTradeProjection_('other',undefined,true).error);assert.equal(f.writes(),0);
});
test('authenticated repair action passes only an explicit statusOnly flag',()=>{
 const api=fs.readFileSync(path.join(__dirname,'../sheetAPI.js'),'utf8');
 const branch=api.slice(api.indexOf('case "repairTradeProjection":'),api.indexOf('case "getTradeDiscountState":'));
 assert.match(branch,/statusOnly/);
});
test('diagnostic includes setup-closing and uses the return-projection-specific expiry',()=>{
 const f=fixture('{}'),now=Date.now();
 f.state['setupClosing_'+tid]=now+'|private-token';
 f.state['dashboardReturnProjectionInFlight_'+tid]=JSON.stringify({at:now-4*60000,token:'private-token'});
 const x=f.ctx.repairDashboardTradeProjection_(tid,undefined,true);
 assert.equal(x.claims.find(c=>c.kind==='setupClosing_')?.expired,false);
 assert.equal(x.claims.find(c=>c.kind==='dashboardReturnProjectionInFlight_')?.expired,true);
 assert.equal(JSON.stringify(x).includes('private-token'),false);assert.equal(f.writes(),0);
});
