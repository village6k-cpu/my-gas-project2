const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
test('operations computes its usual queues and attaches the shared all-future report on cache miss and hit',()=>{
 const headers={
  '스케줄상세':['스케줄ID','거래ID','세트명','장비명','수량','반출일','반출시간','반납일','반납시간','상태','비고','단가','예약자명'],
  '계약마스터':['거래ID','예약자명','전화','회사','반출일','시간','반납일','시간','회차','상태','할인','비고'],
  '장비마스터':Array(12).fill(''), '확인요청':Array(18).fill('')};
 const rows={
  '스케줄상세':[['s1','t1','','FX3',2,'2026-09-12','12:00','2026-09-13','12:00','대기','','','예약자'],['s2','t2','','FX3',1,'2026-09-12','07:00','2026-09-12','18:00','대기','','','다른예약자']],
  '계약마스터':[['t1','예약자','','','2026-09-12','','2026-09-13','',1,'예약','','']],
  '장비마스터':[['','CAM1','카메라','FX3',2,0,0,0,'정상','','','']], '확인요청':[]};
 const ctx={SpreadsheetApp:{getActiveSpreadsheet:()=>({getSheetByName:name=>({getLastRow:()=>rows[name].length+1,getRange:()=>({getValues:()=>rows[name]})})})},CacheService:{getScriptCache:()=>({})},
  PropertiesService:{getScriptProperties:()=>({getProperty:()=>null})},Utilities:{formatDate:d=>new Date(d).toISOString().slice(0,10)}};
 vm.createContext(ctx);for(const f of ['../sheetAPI.js','../inventoryRiskMonitor.js'])vm.runInContext(fs.readFileSync(require.resolve(f),'utf8'),ctx);
 let cache=null;ctx.inventoryRiskCacheRead_=()=>cache;ctx.inventoryRiskCacheWrite_=(_c,_k,r)=>{cache=JSON.parse(JSON.stringify(r));};
 const report={alerts:[{equipment:'FX3',kind:'shortage',severity:'conflict',start:'2027-01-01T00:00:00Z',stock:2,booked:3,shortage:1,bookings:[]}],coverage:{complete:true,allFuture:true,schedules:2},generatedAt:'2026-09-12T00:00:00Z',conflictCount:1,riskCount:0,turnaroundMinutes:60};
 ctx.getInventoryRiskReport=()=>report;
 const first=ctx.getOperationsData_('2026-09-12');assert.equal(first.todayCheckout[0].tid,'t2');assert.equal(first.inventoryAlerts[0].overBy,1);assert.equal(first.inventoryCoverage.allFuture,true);
 report.alerts=[];report.conflictCount=0;
 const hit=ctx.getOperationsData_('2026-09-12');assert.equal(hit.todayCheckout.length,2);assert.equal(hit.inventoryAlerts.length,0);
});
