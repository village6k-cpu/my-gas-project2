const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
function env(){const c={};vm.createContext(c);for(const f of ['inventorySupply.js','inventoryRisk.js','checkAvailability.js']){const p=path.join(__dirname,'..',f);if(fs.existsSync(p))vm.runInContext(fs.readFileSync(p,'utf8'),c);}return c;}
const lo='소니 GM 70-200mm',hi='소니 GM 70-200mm II';
const start=new Date('2026-09-13T12:00:00+09:00'),end=new Date('2026-09-14T12:00:00+09:00');
const meta={equipment:{[lo]:{total:3},[hi]:{total:5},'NP-FZ100':{total:0},'소니 CF-A 160':{total:0}},categories:{}};
const row=(name,qty,extra={})=>({equipment:name,qty,startDT:start,endDT:end,status:'대기',...extra});
test('memory and battery stay requested but do not block an addition',()=>{
 const c=env();const r=c.checkAvailabilityForAddCached_([{name:'NP-FZ100',qty:9},{name:'소니 CF-A 160',qty:6}],start,end,meta,[]);
 assert.equal(r.ok,true);assert.equal(r.conflicts.length,0);
});
test('GM1 shortage uses free GM2 and reserves the upper model once across the batch',()=>{
 const c=env();const r=c.checkAvailabilityForAddCached_([{name:lo,qty:3},{name:hi,qty:4}],start,end,meta,[row(lo,1)]);
 assert.equal(r.ok,true);assert.equal(r.allocations.filter(a=>a.requestedName===lo&&a.name===hi)[0].qty,1);
 assert.equal(c.checkAvailabilityForAddCached_([{name:lo,qty:4},{name:hi,qty:4}],start,end,meta,[row(lo,1)]).ok,false);
 assert.equal(c.checkAvailabilityForAddCached_([{name:hi,qty:6}],start,end,meta,[]).ok,false);
});
test('partial external supply is scoped to the row and period; own stock and booking qty remain intact',()=>{
 const c=env();assert.equal(typeof c.inventorySupplyNote_,'function');
 const name='소니 GM 16-35mm',base=row(name,4);
 const note=c.inventorySupplyNote_('기존 직원 메모',base,[{source:'external',name,qty:2,supplier:'아나키'}]);
 const physical=c.inventorySupplyPhysicalRows_({...base,note});
 assert.equal(physical.length,1);assert.equal(physical[0].qty,2);assert.equal(base.qty,4);assert.match(note,/기존 직원 메모/);assert.match(note,/아나키/);
 assert.throws(()=>c.inventorySupplyPhysicalRows_({...base,note,qty:1}),/재고 배정/);
 assert.throws(()=>c.inventorySupplyPhysicalRows_({...base,note,endDT:new Date(end.getTime()+3600000)}),/재고 배정/);
 assert.equal(c.inventorySupplyPhysicalRows_({...base,note:''})[0].qty,4);
});
test('stored upgrade consumes GM2 instead of GM1 without renaming the sales row',()=>{
 const c=env();assert.equal(typeof c.inventorySupplyNote_,'function');const base=row(lo,3);
 const note=c.inventorySupplyNote_('',base,[{source:'own',name:hi,qty:1}]);
 const physical=c.inventorySupplyPhysicalRows_({...base,note});
 assert.equal(physical.find(r=>r.equipment===lo).qty,2);assert.equal(physical.find(r=>r.equipment===hi).qty,1);assert.equal(base.equipment,lo);
 assert.throws(()=>c.inventorySupplyNote_('',row(hi,1),[{source:'own',name:lo,qty:1}]),/상위/);
});
test('risk report uses the same exclusions and external/upgrade allocations',()=>{
 const c=env();assert.equal(typeof c.inventorySupplyNote_,'function');
 const n='소니 GM 16-35mm';const note=c.inventorySupplyNote_('',row(n,4),[{source:'external',supplier:'아나키',name:n,qty:2}]);
 const snap={equipment:[{id:'lens',name:n,stock:4,maintenance:0},{id:'card',name:'소니 CF-A 160',stock:0,maintenance:0}],schedules:[
 {id:'a',name:n,quantity:4,start:start.toISOString(),end:end.toISOString(),note},
 {id:'b',name:n,quantity:2,start:start.toISOString(),end:end.toISOString()},
 {id:'c',name:'소니 CF-A 160',quantity:200,start:start.toISOString(),end:end.toISOString()}]};
 const r=c.buildInventoryRiskReport_(snap,{now:'2026-09-12T12:00:00+09:00'});
 assert.equal(r.conflictCount,0);assert.ok(r.alerts.every(a=>a.equipment!=='소니 CF-A 160'));
 snap.schedules[0].end='2026-09-15T03:00:00Z';assert.ok(c.buildInventoryRiskReport_(snap,{now:'2026-09-12T12:00:00+09:00'}).alerts.some(a=>a.kind==='invalid_supply_allocation'));
});
test('exclusions do not swallow cameras, battery grips, power stations or recorders',()=>{
 const c=env();assert.equal(typeof c.inventorySupplyExcluded_,'function');
 for(const name of ['소니 A7S3 바디세트','배터리그립','에코플로우 델타2','줌 F6 레코더','소니 FX3 (배터리 포함)'])assert.equal(c.inventorySupplyExcluded_(name),false,name);
 for(const name of ['V마운트 배터리','970 배터리 (전체)','NP-FZ100','소니 CF-A 160','SD 128GB'])assert.equal(c.inventorySupplyExcluded_(name),true,name);
});
test('bad supplier notes affect the matching supply family, never every unrelated reservation',()=>{
 const c=env();const data=c.inventorySupplyAvailabilityRows_(row(lo,2,{note:'[상위대체] 깨진 배정 기록'}));
 const r=c.checkAvailabilityForAddCached_([{name:hi,qty:1}],start,end,meta,data);assert.equal(r.ok,false);
 const m={equipment:{카메라:{total:2}},categories:{}};
 assert.equal(c.checkAvailabilityForAddCached_([{name:'카메라',qty:1}],start,end,m,data).ok,true);
});
test('atomic row plan preserves requested price and counts the upgraded lens for the next reservation',()=>{
 const c=env();c.parseDT=(d,t)=>new Date(d+'T'+t+':00+09:00');
 const rows=[['id','trade',lo,lo,3,'2026-09-13','12:00','2026-09-14','12:00','대기','직원 메모',25000,'고객']];
 const plan=c.checkAvailabilityForAddCached_([{name:lo,qty:3}],start,end,meta,[row(lo,1)]);
 c.inventorySupplyApplyRows_(rows,plan);assert.equal(rows[0][3],lo);assert.equal(rows[0][11],25000);assert.match(rows[0][10],/상위대체/);assert.match(rows[0][10],/직원 메모/);
 const actual=c.buildDashboardScheduleData_(rows,[hi]);assert.equal(actual.find(r=>r.equipment===hi).qty,1);
 assert.equal(c.checkAvailabilityForAddCached_([{name:hi,qty:5}],start,end,meta,actual).ok,false);
});
