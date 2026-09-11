const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const file = path.join(__dirname, '../inventoryRisk.js');
const ctx = {};
vm.createContext(ctx);
if (fs.existsSync(file)) vm.runInContext(fs.readFileSync(file, 'utf8'), ctx);
const report = (snapshot, extra = {}) => JSON.parse(JSON.stringify(ctx.buildInventoryRiskReport_(snapshot, {now:'2026-09-12T00:00:00+09:00',turnaroundMinutes:60,...extra})));
const item = (over={}) => ({id:'CAM-1',name:'소니 FX3 바디(케이지)',stock:2,maintenance:0,aliases:['FX3 바디'],...over});
const row = (over={}) => ({id:'260912-001-01',tradeId:'260912-001',customer:'예약자',name:'소니 FX3 바디(케이지)',quantity:1,start:'2026-09-12T10:00:00+09:00',end:'2026-09-12T18:00:00+09:00',status:'대기',...over});
const data = (rows,equipment=[item()],sets=[]) => ({equipment,sets,schedules:rows});
const conflicts = r => r.alerts.filter(a=>a.kind==='shortage');

test('a single request exceeding usable stock is a real conflict; zero is not one',()=>{
 assert.equal(conflicts(report(data([row({quantity:3})])))[0].shortage,1);
 assert.equal(conflicts(report(data([row()],[item({stock:0})])))[0].shortage,1);
 assert.equal(conflicts(report(data([row({quantity:2})],[item({maintenance:1})])))[0].stock,1);
});
test('same-day nonoverlapping reservations do not conflict, exact handoff is a separate risk',()=>{
 const r=report(data([row({end:'2026-09-12T12:00:00+09:00'}),row({id:'b',tradeId:'b',start:'2026-09-12T12:00:00+09:00'})],[item({stock:1})]));
 assert.equal(conflicts(r).length,0);
 assert.ok(r.alerts.some(a=>a.kind==='turnaround'));
});
test('all future reservations are scanned, beyond 90 days and year boundaries',()=>{
 const r=report(data([row({quantity:4,start:'2027-04-12T10:00:00+09:00',end:'2027-04-13T10:00:00+09:00'})]));
 assert.equal(conflicts(r)[0].shortage,2);
 assert.equal(r.coverage.end,'2027-04-13T01:00:00.000Z');
});
test('formatting and established aliases join the same physical inventory',()=>{
 const r=report(data([row({quantity:2}),row({id:'b',tradeId:'b',name:' FX3   바디 ',quantity:1})]));
 assert.equal(conflicts(r)[0].booked,3);
 assert.deepEqual(conflicts(r)[0].sourceNames.sort(),[' FX3   바디 ','소니 FX3 바디(케이지)'].sort());
});
test('ambiguous and unknown names stay visible, and FX30 does not consume FX3',()=>{
 const r=report(data([row({name:'FX30'})]));
 assert.equal(conflicts(r).length,0);
 assert.equal(r.alerts[0].kind,'unknown_equipment');
 assert.equal(r.coverage.complete,false);
 const ambiguous=report(data([row({name:'FX3 바디'})],[item(),item({id:'CAM-2',name:'소니 FX30',aliases:['FX3 바디']})]));
 assert.ok(ambiguous.alerts.some(a=>a.kind==='ambiguous_equipment'));
});
test('exactly expanded set header is not counted twice; header-only sets are expanded',()=>{
 const sets=[{name:'FX3 바디세트',components:[{name:'소니 FX3 바디(케이지)',quantity:1},{name:'메모리 / 배터리',quantity:1,tracked:false}]}];
 const header=row({name:'FX3 바디세트',setName:'FX3 바디세트',quantity:2});
 const component=row({id:'component',setName:'FX3 바디세트',quantity:2});
 assert.equal(conflicts(report(data([header,component],[item()],sets))).length,0);
 assert.equal(conflicts(report(data([header],[item({stock:1})],sets)))[0].shortage,1);
});
test('completed, cancelled and excluded rows never occupy stock, and zero quantity remains zero',()=>{
 const r=report(data(['취소','반납완료','제외','거절'].map((status,i)=>row({id:String(i),status,quantity:20})).concat(row({id:'zero',quantity:0}))));
 assert.equal(r.alerts.length,0);
});
test('bad dates and unknown stock are exposed rather than silently omitted',()=>{
 assert.ok(report(data([row({start:''})])).alerts.some(a=>a.kind==='invalid_schedule'));
 assert.ok(report(data([row()],[item({stock:null})])).alerts.some(a=>a.kind==='unknown_stock'));
 assert.ok(report(data([row({quantity:'oops'})])).alerts.some(a=>a.kind==='invalid_quantity'));
});
test('unrecorded past returns are explicit uncertainty rather than invented future overlaps',()=>{
 const r=report(data([row({id:'old',tradeId:'old',start:'2026-09-09T10:00:00+09:00',end:'2026-09-11T10:00:00+09:00',checkedOut:true}),row()],[item({stock:1})]));
 assert.ok(r.alerts.some(a=>a.kind==='overdue_return'));
 assert.equal(conflicts(r).length,0);
 assert.equal(r.alerts.find(a=>a.kind==='overdue_return').bookings[0].tradeId,'old');
});
test('peak shortage and implicated bookings belong to the same peak interval',()=>{
 const r=report(data([row({quantity:3}),row({id:'b',tradeId:'b',quantity:3,start:'2026-09-12T14:00:00+09:00'})]));
 const c=conflicts(r)[0];
 assert.equal(c.booked,6); assert.equal(c.shortage,4); assert.equal(c.bookings.length,2);
 assert.equal(c.start,'2026-09-12T05:00:00.000Z');
});
test('an excluded expanded component is not resurrected from its set header',()=>{
 const sets=[{name:'FX3 세트',components:[{name:item().name,quantity:1}]}];
 const r=report(data([row({name:'FX3 세트',setName:'FX3 세트'}),row({id:'component',setName:'FX3 세트',status:'제외'})],[item({stock:0})],sets));
 assert.equal(conflicts(r).length,0);
});
test('near-capacity allocation is a risk without inventing a shortage',()=>{
 const r=report(data([row({quantity:2})]));
 assert.ok(r.alerts.some(a=>a.kind==='capacity_tight' && a.shortage===0));
 assert.equal(conflicts(r).length,0);
});
test('different rental stages of a set retain their own expansion',()=>{
 const sets=[{name:'FX3 세트',components:[{name:item().name,quantity:1}]}];
 const r=report(data([row({name:'FX3 세트',setName:'FX3 세트'}),row({id:'c',setName:'FX3 세트'}),row({id:'later',name:'FX3 세트',setName:'FX3 세트',quantity:3,start:'2026-10-12T10:00:00+09:00',end:'2026-10-13T10:00:00+09:00'})],[item()],sets));
 assert.equal(conflicts(r)[0].shortage,1);
});
