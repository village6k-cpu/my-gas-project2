import test from 'node:test';
import assert from 'node:assert/strict';
import {enrichSheetPayloadWithCustomerDbDiscount,lookupCustomerDbDiscountForRequest,ensureConfirmRequestDiscountApplied,executeVillageReadOnlyLookup} from './worker.mjs';
const phone='010-1111-2222';
const dbResponse=discount=>({ok:true,status:200,text:async()=>JSON.stringify({table:{rows:[{c:[{v:phone},{v:'현재고객'},{v:discount}]}]}})});
for(const [conversation,database,want] of [['학생','일반','학생'],['개인사업자/프리랜서','일반','개인사업자/프리랜서'],['일반','학생','일반'],['','학생','학생']]){
 test(`current resolved discount ${conversation||'absent'} vs DB ${database} produces ${want}`,async()=>{
  const payload={args:{예약자명:'현재고객',연락처:phone,할인유형:conversation}};
  const result=await enrichSheetPayloadWithCustomerDbDiscount({fetchImpl:async()=>dbResponse(database)},payload);
  assert.equal(result.payload.args.할인유형,want);
 });
}
test('discount fallback never borrows a namesake with a different supplied phone',async()=>{
 const result=await lookupCustomerDbDiscountForRequest({customerName:'현재고객',phone:'010-3333-4444'},{fetchImpl:async()=>dbResponse('단골')});
 assert.equal(result.matched,false);assert.equal(result.discountType,'');
});
test('post-intake verification honors current resolved discount, not the stale DB lookup',async()=>{
 const calls=[];
 const c={gasApiUrl:'https://gas.test/exec',sheetApiKey:'test',fetchImpl:async url=>{
  calls.push(new URL(url).searchParams.get('action'));
  return {ok:true,text:async()=>JSON.stringify({results:[{row:2,data:['RQ-261014-001','','','','','','','','','','현재고객',phone,'학생']}]})};
 }};
 const result=await ensureConfirmRequestDiscountApplied(c,{success:true,reqID:'RQ-261014-001'},{args:{할인유형:'학생'}},{discountType:'일반'});
 assert.equal(result.discountType,'학생');assert.deepEqual(calls,['search']);
});
function quoteConfig(database){
 return {gasApiUrl:'https://gas.test/exec',sheetApiKey:'test',fetchImpl:async url=>{
  const u=new URL(url);
  if(u.hostname==='docs.google.com')return dbResponse(database);
  return {ok:true,text:async()=>JSON.stringify({results:[{data:['카메라','','','','','',100000]}]})};
 }};
}
const quote={source:'catalog',customer_name:'현재고객',phone,discount_type:'학생',start_date:'2026-10-14',start_time:'10:00',end_date:'2026-10-15',end_time:'10:00',items:[{name:'카메라',quantity:1}]};
test('catalog quote uses current student terms despite stale general DB',async()=>{
 const r=await executeVillageReadOnlyLookup(quoteConfig('일반'),{kind:'quote',quote});
 assert.equal(r.totalVatIncluded,77000);assert.equal(r.calculations[0].customerDiscountSource,'conversation');
});
test('catalog quote with absent conversation discount uses safe DB fallback',async()=>{
 const r=await executeVillageReadOnlyLookup(quoteConfig('학생'),{kind:'quote',quote:{...quote,discount_type:''}});
 assert.equal(r.totalVatIncluded,77000);assert.equal(r.calculations[0].customerDiscountSource,'customer_db');
});

for (const stored of ['', '일반']) {
 test(`request quote resolves only absent stored discount through identity-safe DB: ${stored}`,async()=>{
  const c={...quoteConfig('학생'),villageOpsSheetId:'configured-ops-sheet'},base=c.fetchImpl;
  c.fetchImpl=async url=>{
   const u=new URL(url);
   if(u.hostname==='docs.google.com' && u.searchParams.get('sheet')==='확인요청'){
    const labels=['예약자명','연락처','할인유형','장비or세트명','수량','반출일','반출시간','반납일','반납시간'];
    const values=['현재고객',phone,stored,'카메라',1,'2026-10-14','10:00','2026-10-15','10:00'];
    return {ok:true,text:async()=>JSON.stringify({table:{cols:labels.map(label=>({label})),rows:[{c:values.map(v=>({v}))}]}})};
   }
   if(u.hostname==='docs.google.com') assert.ok(u.pathname.includes('/configured-ops-sheet/'));
   return base(url);
  };
  const result=await executeVillageReadOnlyLookup(c,{kind:'quote',quote:{source:'request',id:'RQ-261014-001'}});
  assert.equal(result.totalVatIncluded,stored ? 110000 : 77000);
  assert.equal(result.calculations[0].discountType,stored || '학생');
 });
}
