const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const gas=fs.readFileSync(path.join(__dirname,'../checkAvailability.js'),'utf8');
const tid='261014-001',rq='RQ-261014-001';
function context(discount){
 const ctx={SpreadsheetApp:{getActiveSpreadsheet:()=>({getSheetByName:()=>({})})}};
 vm.runInNewContext(gas,ctx);
 const period={start_date:'2026-10-14',start_time:'10:00',end_date:'2026-10-15',end_time:'10:00'};
 const group={reqID:rq,discount:'학생',rows:[2],statuses:['등록완료'],registerActions:['등록'],tradeIds:[tid],setComponentItems:[]};
 ctx._buildConfirmRequestGroups_=()=>[group];
 ctx.readRegisteredTradeCorrectionState_=()=>({contract:{startDate:'2026-10-14',startTime:'10:00',endDate:'2026-10-15',endTime:'10:00',discountType:discount},
  schedule:{rows:[{name:'카메라',qty:1,isComponent:false}],periods:['2026-10-14|10:00|2026-10-15|10:00'],topLevelQuantities:{카메라:1}},ledger:{rows:1,startDate:'2026-10-14'}});
 return{ctx,input:{request_id:rq,desired_after:[{name:'카메라',quantity:1}],desired_period:period}};
}
test('equipment/date success cannot conceal a different registered contract discount',()=>{
 const f=context('일반');assert.throws(()=>f.ctx._confirmedReservationResult_(f.input,rq,[],{},[]),/할인|discount|readback/);
});
test('aligned request and master discount is exposed in successful authoritative readback',()=>{
 const f=context('학생'),r=f.ctx._confirmedReservationResult_(f.input,rq,[],{},[]);
 assert.equal(r.success,true);assert.equal(r.authoritative.registered_trade.contract.discountType,'학생');
});
test('real registered-state reader reads the actual K-column discount rather than omitting it',()=>{
 const contract=[[tid,'현재고객','010-1111-2222','','2026-10-14','10:00','2026-10-15','10:00',1,'예약','학생']];
 const schedule=[[tid+'-01',tid,'카메라','카메라',1,'2026-10-14','10:00','2026-10-15','10:00','대기','',100000,'현재고객']];
 const sheet=rows=>({getLastRow:()=>rows.length+1,getRange:(row,col,count,width)=>({getValues:()=>rows.slice(row-2,row-2+count).map(r=>r.slice(col-1,col-1+width)),getDisplayValues:()=>rows.slice(row-2,row-2+count).map(r=>r.slice(col-1,col-1+width).map(String))})});
 const ctx={SpreadsheetApp:{getActiveSpreadsheet:()=>({getSheetByName:name=>name==='계약마스터'?sheet(contract):sheet(schedule)})}};
 vm.runInNewContext(gas,ctx);
 assert.equal(ctx.readRegisteredTradeCorrectionState_(tid,false).contract.discountType,'학생');
});
