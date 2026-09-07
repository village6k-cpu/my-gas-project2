import test from 'node:test';
import assert from 'node:assert/strict';
import * as worker from './worker.mjs';

function config() {
  const calls = [];
  return { calls, gasApiUrl:'https://gas.test/exec', sheetApiKey:'private-test-key',
    fetchImpl: async (url, options={}) => {
      const u=new URL(url); calls.push({u,options});
      assert.equal(options.method || 'GET','GET');
      if(u.hostname==='docs.google.com') return {ok:true,text:async()=>JSON.stringify({table:{rows:[]}})};
      assert.equal(u.searchParams.get('action'),'search');
      const name=u.searchParams.get('query');
      const prices={'카메라 세트':60000,'렌즈':30000};
      return {ok:true,text:async()=>JSON.stringify({success:true,results: prices[name] ? [{data:[name,'', '', '', '', '',prices[name]]}]:[]})};
    }};
}
const quote={source:'catalog',customer_name:'테스트 고객',phone:'',discount_type:'개인사업자/프리랜서',
  start_date:'2026-09-09',start_time:'08:00',end_date:'2026-09-10',end_time:'08:00',
  items:[{name:'카메라 세트',quantity:1},{name:'렌즈',quantity:1}]};
test('native price inquiry can read and calculate a complete unregistered quote without writing an RQ',async()=>{
  assert.equal(typeof worker.executeVillageReadOnlyLookup,'function');
  const c=config();
  const result=await worker.executeVillageReadOnlyLookup(c,{kind:'quote',quote});
  assert.equal(result.complete,true);
  assert.equal(result.totalVatIncluded,79200);
  assert.equal(result.calculations[0].payment.discountType,'개인사업자/프리랜서');
  const verification=await worker.buildAuthoritativePriceVerification(c,{
    classification:'price',price_quote:quote,
    reply_decision:{safetyClass:'sensitive_commitment',grounding:'authoritative_sheet'}
  });
  assert.equal(verification.complete,true);
  assert.equal(verification.totalVatIncluded,79200);
  assert.ok(c.calls.length>0);
});
test('native read boundary rejects writes and incomplete price plans without a made-up total',async()=>{
  assert.equal(typeof worker.executeVillageReadOnlyLookup,'function');
  const c=config();
  for(const request of [{kind:'write',sheet:'확인요청'},{kind:'catalog',query:'',url:'https://evil.test'},
    {kind:'quote',quote:{...quote,end_date:'2026-09-08'}}]) {
    await assert.rejects(()=>worker.executeVillageReadOnlyLookup(c,request));
  }
  const result=await worker.executeVillageReadOnlyLookup(c,{kind:'quote',quote:{...quote,items:[...quote.items,{name:'없는 렌즈',quantity:1}]}});
  assert.equal(result.complete,false);
  assert.equal(result.totalVatIncluded,null);
  assert.deepEqual(result.unresolved,['없는 렌즈 x1']);
});

test('request quote counts the set once and includes billable rows after expanded accessories',async()=>{
  const c=config(); const fetchBase=c.fetchImpl;
  c.fetchImpl=async(url,options)=>{
    const u=new URL(url);
    if(u.hostname!=='docs.google.com') return fetchBase(url,options);
    assert.doesNotMatch(u.searchParams.get('tq'),/LIMIT 30/);
    const cols=['장비or세트명','수량','반출일','반출시간','반납일','반납시간','할인유형','비고'];
    const rows=[['카메라 세트',1,'2026-09-09','08:00','2026-09-10','08:00','개인사업자/프리랜서',''],
      ...Array.from({length:31},()=>['포함 액세서리',1,'','','','','','[세트]카메라 세트']),
      ['렌즈',1,'','','','','','']];
    return {ok:true,text:async()=>JSON.stringify({table:{cols:cols.map(label=>({label})),rows:rows.map(v=>({c:v.map(v=>({v}))}))}})};
  };
  const result=await worker.executeVillageReadOnlyLookup(c,{kind:'quote',quote:{source:'request',id:'RQ-260909-001'}});
  assert.equal(result.complete,true);
  assert.equal(result.totalVatIncluded,79200);
  assert.equal(result.calculations[0].pricedItems.length,2);
});

test('quote uses current customerDB discount and send-time relookup detects a changed price',async()=>{
  const c=config(); const fetchBase=c.fetchImpl; let unitPrice=60000;
  c.fetchImpl=async(url,options)=>{
    const u=new URL(url);
    if(u.hostname==='docs.google.com') return {ok:true,text:async()=>JSON.stringify({table:{rows:[{c:[{v:'010-1111-2222'},{v:'테스트 고객'},{v:'단골'}]}]}})};
    if(u.searchParams.get('query')==='카메라 세트') return {ok:true,text:async()=>JSON.stringify({results:[{data:['카메라 세트','','','','','',unitPrice]}]})};
    return fetchBase(url,options);
  };
  const plan={...quote,phone:'010-1111-2222'};
  const result=await worker.executeVillageReadOnlyLookup(c,{kind:'quote',quote:plan});
  assert.equal(result.totalVatIncluded,71280);
  assert.equal(result.calculations[0].customerDiscountSource,'customer_db');
  unitPrice=70000;
  const verification=await worker.buildAuthoritativePriceVerification(c,{classification:'price',price_quote:plan,
    reply_decision:{safetyClass:'sensitive_commitment',grounding:'authoritative_sheet'}});
  assert.equal(verification.totalVatIncluded,79200);
});

test('customerDB errors and ambiguous unit prices cannot become a complete quote',async()=>{
  const c=config(); const fetchBase=c.fetchImpl;
  c.fetchImpl=async(url,options)=>new URL(url).hostname==='docs.google.com'
    ? {ok:true,text:async()=>JSON.stringify({status:'error',errors:[{reason:'access_denied'}]})}
    : fetchBase(url,options);
  await assert.rejects(()=>worker.executeVillageReadOnlyLookup(c,{kind:'quote',quote}),/Customer DB/);
  c.fetchImpl=async(url,options)=>new URL(url).hostname==='docs.google.com'
    ? fetchBase(url,options)
    : {ok:true,text:async()=>JSON.stringify({results:[60000,70000].map(price=>({data:['카메라 세트','','','','','',price]}))})};
  const result=await worker.executeVillageReadOnlyLookup(c,{kind:'quote',quote:{...quote,items:[{name:'카메라 세트',quantity:1}]}});
  assert.equal(result.complete,false);
  assert.equal(result.totalVatIncluded,null);
});

test('native record lookup keeps real headers and exact IDs with the GAS column contract',async()=>{
  const c=config();
  c.fetchImpl=async(url)=>{
    const u=new URL(url);
    assert.equal(u.searchParams.get('col'),'A');
    return {ok:true,text:async()=>JSON.stringify({headers:['요청ID','반출일'],results:[
      {data:['RQ-260909-001','2026-09-09']},{data:['RQ-260909-0010','2026-09-10']}]})};
  };
  const result=await worker.executeVillageReadOnlyLookup(c,{kind:'request',query:'RQ-260909-001'});
  assert.deepEqual(result.sources[0].headers,['요청ID','반출일']);
  assert.equal(result.sources[0].rows.length,1);
});
