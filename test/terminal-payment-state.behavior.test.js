const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
function read(ledgerRows, contractRows, ids = ['A']) {
  const sheet = (rows,width) => ({getLastRow:()=>rows.length+1,getRange:(r,c,n,w)=>{
    assert.deepEqual([r,c,n,w],[2,1,rows.length,width]);
    return {getValues:()=>rows};
  }});
  const context=vm.createContext({getVillageTradeSheet_:()=>sheet(ledgerRows,13),
    SpreadsheetApp:{getActiveSpreadsheet:()=>({getSheetByName:name=>{
      assert.equal(name,'계약마스터');return contractRows===null ? null : sheet(contractRows,10);
    }})}});
  vm.runInContext(fs.readFileSync(require.resolve('../paymentMatching.js'),'utf8'),context);
  return JSON.parse(JSON.stringify(context.getTerminalPaymentState_(ids)));
}
const ledger=(status='',amount=26400,id='A')=>['','이름','','',id,'','','',amount,'카드결제','','',status];
const contract=(status='예약',id='A')=>[id,'','','','','','','','',status];
for (const status of ['입금완료',' 입금완료 ','결제완료','환불','부분입금']) {
  assert.equal(read([ledger(status)],[contract()]).items.A.canPay,false);
}
for (const status of ['', '미입금']) {
  assert.equal(read([ledger(status)],[contract()]).items.A.canPay,true);
}
assert.equal(read([ledger('','26,400원')],[contract()]).items.A.amount,26400);
assert.equal(read([ledger()],[contract('취소')]).items.A.canPay,false);
assert.equal(read([ledger()],[]).items.A.canPay,false);
assert.equal(read([],[contract()]).items.A.found,false);
for(const amount of [0,-1,'invalid',1.2]) assert.equal(read([ledger('',amount)],[contract()]).items.A.canPay,false);
assert.throws(()=>read([ledger(),ledger()],[contract()]),/중복/);
assert.throws(()=>read([ledger()],[contract(),contract()]),/중복/);
assert.throws(()=>read([ledger()],null),/시트 없음/);
assert.throws(()=>read([],[],{}),/거래ID 목록/);
assert.deepEqual(read([],[],[]),{success:true,items:{}});
// 한 번의 원본 읽기로 같은 고객의 완납/미납을 구분하고 현재 금액을 유지한다.
const mixed=read([ledger('입금완료',26400,'A'),ledger('미입금',39600,'B')],[contract('예약','A'),contract('예약','B')],['A','B']);
assert.equal(mixed.items.A.canPay,false);assert.equal(mixed.items.B.canPay,true);assert.equal(mixed.items.B.amount,39600);
console.log('Terminal payment authority: 21 checks passed');
