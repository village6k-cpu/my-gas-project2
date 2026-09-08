'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');

function harness() {
  const rows=[['RQ-260908-001','','','','','소니 A7S3 바디세트',1],
    ['RQ-260908-001','','','','','소니 CF-A 리더기',1,'','','','','','','','','','[세트]소니 A7S3 바디세트']];
  let writes=0;
  const sheet={getLastRow:()=>3,getRange:(r,c,n=1,w=1)=>({
    getDisplayValues:()=>Array.from({length:n},(_,i)=>Array.from({length:w},(_,j)=>String(rows[r-2+i]?.[c-1+j]??''))),
    setValue(v){writes++;rows[r-2][c-1]=v;return this;},clearContent(){return this;}
  })};
  const catalog={getLastRow:()=>2,getRange:()=>({getDisplayValues:()=>[['소니 A7S3 바디세트']]})};
  const ctx={console,SpreadsheetApp:{getActiveSpreadsheet:()=>({getSheetByName:()=>catalog}),flush(){}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../checkAvailability.js'),'utf8'),ctx);
  ctx._processByReqID=()=>{};
  return {apply:desired=>ctx._applyConfirmedReservationExactSetComponents_(sheet,'RQ-260908-001',desired),getWrites:()=>writes};
}

test('a master-expanded included accessory need not be an independently catalogued rental item',()=>{
  const h=harness();
  const result=h.apply([{set_item:'소니 A7S3 바디세트',component_item:'소니 CF-A 리더기',quantity:1}]);
  assert.equal(result.finalSetComponents[0].component_item,'소니 CF-A 리더기');
});

for(const row of [{component_item:'없는 렌즈',quantity:1},{component_item:'소니 CF-A 리더기',quantity:2}]) {
  test(`unmanaged component changes still fail before writes: ${JSON.stringify(row)}`,()=>{
    const h=harness();
    assert.throws(()=>h.apply([{set_item:'소니 A7S3 바디세트',...row}]),/catalog/);
    assert.equal(h.getWrites(),0);
  });
}
