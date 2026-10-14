'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');

function harness(masterNames=[],strictDropdown=false) {
  const rows=[['RQ-260908-001','','','','','소니 A7S3 바디세트',1],
    ['RQ-260908-001','','','','','소니 CF-A 리더기',1,'','','','','','','','','','[세트]소니 A7S3 바디세트']];
  let writes=0;
  let allowInvalid=!strictDropdown;
  const rule={copy:()=>({setAllowInvalid(value){allowInvalid=value;return this;},build:()=>rule})};
  const sheet={getLastRow:()=>3,getRange:(r,c,n=1,w=1)=>({
    getDisplayValues:()=>Array.from({length:n},(_,i)=>Array.from({length:w},(_,j)=>String(rows[r-2+i]?.[c-1+j]??''))),
    getDisplayValue:()=>String(rows[r-2]?.[c-1]??''),
    getDataValidations:()=>[[strictDropdown?rule:null]],setDataValidations(){return this;},
    setValue(v){if(c===6&&!allowInvalid&&v!=='소니 A7S3 바디세트')throw Error('strict dropdown rejected equipment');writes++;rows[r-2][c-1]=v;return this;},clearContent(){return this;}
  })};
  const catalog={getLastRow:()=>2,getRange:()=>({getDisplayValues:()=>[['소니 A7S3 바디세트']]})};
  const master={getLastRow:()=>masterNames.length+1,getRange:()=>({getDisplayValues:()=>masterNames.map(name=>[name])})};
  const ctx={console,SpreadsheetApp:{getActiveSpreadsheet:()=>({getSheetByName:name=>name==='목록'?catalog:name==='장비마스터'?master:null}),flush(){}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../checkAvailability.js'),'utf8'),ctx);
  ctx._processByReqID=()=>{};
  return {apply:desired=>ctx._applyConfirmedReservationExactSetComponents_(sheet,'RQ-260908-001',desired),
    select:selection=>ctx._applyConfirmedReservationSetSelections_(sheet,'RQ-260908-001',[selection]),getWrites:()=>writes,
    componentName:()=>rows[1][5]};
}

for(const operation of ['select','apply']) {
  test(`confirmed ${operation} changes only the target dropdown to warning before master-only selection`,()=>{
    const h=harness(['소니 CFA/SD 리더기'],true);
    if(operation==='select')h.select({set_item:'소니 A7S3 바디세트',component_item:'소니 CF-A 리더기',selected_item:'소니 CFA/SD 리더기'});
    else h.apply([{set_item:'소니 A7S3 바디세트',component_item:'소니 CFA/SD 리더기',quantity:1}]);
    assert.equal(h.componentName(),'소니 CFA/SD 리더기');
  });
}

for(const operation of ['select','apply']) {
  test(`confirmed ${operation} accepts an authoritative master item missing from autocomplete`,()=>{
    const h=harness(['소니 CFA/SD 리더기']);
    if(operation==='select') h.select({set_item:'소니 A7S3 바디세트',component_item:'소니 CF-A 리더기',selected_item:'소니 CFA/SD 리더기'});
    else h.apply([{set_item:'소니 A7S3 바디세트',component_item:'소니 CFA/SD 리더기',quantity:1}]);
    assert.equal(h.componentName(),'소니 CFA/SD 리더기');
  });
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
