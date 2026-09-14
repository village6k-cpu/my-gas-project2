'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { normalizeCorrectionInput, runRegisteredTradeCorrection } = require('../scripts/windows/village-registered-trade-correction.js');
const input = {
  tradeId: '260914-002', operationId: 'ce1e3110-3517-48e3-928d-3cbe283d99cf',
  expectedPeriod: { startDate: '2026-09-14', startTime: '18:00', endDate: '2026-09-17', endTime: '18:00' },
  staffApproval: { source: 'kakao_staff_confirmed', conversationRevision: 16, customerRequest: '해당 품목 단가 8만원으로 정정 요청', staffConfirmation: '네 8만원으로 진행 가능합니다.' },
  priceChanges: [{ scheduleId: '260914-002-14', expectedName: 'XEEN CF 세트', expectedQty: 1, expectedUnitPrice: 100000, unitPrice: 80000 }]
};
const copy = value => JSON.parse(JSON.stringify(value));
function harness(options = {}) {
  const calls = { writes: [], regenerations: 0, lockHeld: false, flushes: 0 };
  const props = new Map([['개고생2_URL', 'https://docs.example/ledger']]);
  const properties = { getProperty: key => props.get(key) || '', setProperty(key,value) { props.set(key,value); return this; }, deleteProperty: key => props.delete(key) };
  function sheet(name, data) {
    return { data, getLastRow: () => data.length, getLastColumn: () => Math.max(...data.map(row => row.length)),
      getRange(row, col, rows = 1, cols = 1) {
        if (typeof row === 'string') { assert.equal(row, 'H47'); row = 47; col = 8; }
        const values = () => Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => data[row+r-1]?.[col+c-1] ?? ''));
        return { getValues: () => copy(values()), getDisplayValues: () => values().map(row => row.map(String)), getValue: () => values()[0][0],
          setValue(value) { assert.equal(calls.lockHeld, true); calls.writes.push({ name, row, col, value }); data[row-1][col-1] = value; if(options.afterWrite) options.afterWrite({schedule,contract,ledger,data}); return this; }
        };
      }
    };
  }
  const schedule = sheet('스케줄상세', [Array(13).fill('header'),
    ['260914-002-14','260914-002','XEEN CF 세트','XEEN CF 세트',1,'2026-09-14','18:00','2026-09-17','18:00','등록','직원 메모',100000,'보존 메모'],
    ['260914-002-15','260914-002','XEEN CF 세트','XEEN CF 24mm',1,'2026-09-14','18:00','2026-09-17','18:00','등록','구성품',0,''],
    ['260914-002-18','260914-002','','FX3',2,'2026-09-14','18:00','2026-09-17','18:00','등록','다른 단가',60000,''],
    ['260914-003-01','260914-003','','별도 거래',1,'2026-09-14','18:00','2026-09-17','18:00','등록','',10000,'']
  ]);
  const contract = sheet('계약마스터', [Array(13).fill('header'), ['260914-002','테스트 예약자','synthetic-phone','','2026-09-14','18:00','2026-09-17','18:00',3,'','학생','','보존']]);
  const ledger = sheet('거래내역', [Array(9).fill('header'), ['2026-09-14','','https://docs.example/old','','260914-002','','','',528000]]);
  let generated = null;
  const context = {
    Date, JSON, Object, Array, String, Number, Math, RegExp, Error,
    DASHBOARD_MUTATION_LEASE_MS_: 7*60*1000, DASHBOARD_SETUP_CLOSING_LEASE_MS_: 7*60*1000,
    PropertiesService: { getScriptProperties: () => properties },
    LockService: { getScriptLock: () => ({ tryLock() { if(options.busy) return false; assert.equal(calls.lockHeld,false); calls.lockHeld=true; return true; }, releaseLock() { calls.lockHeld=false; } }) },
    Utilities: { DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' }, formatDate: date => new Date(date).toISOString().slice(0,10), computeDigest: (_alg,value) => [...crypto.createHash('sha256').update(value).digest()] },
    SpreadsheetApp: {
      getActiveSpreadsheet: () => ({ getSheetByName: name => ({ '스케줄상세': schedule, '계약마스터': contract })[name] }),
      openByUrl: () => ({ getSheetByName: name => name === '거래내역' ? ledger : null }),
      openById(id) { assert.equal(id,'price-contract'); return { getSheets: () => [generated] }; },
      flush() { calls.flushes++; }
    },
    isDashboardTradeCheckoutStarted_: () => options.checkoutStarted === true,
    activeDashboardReturnProjectionLease_: () => null,
    invalidateContractSheetScan_() {},
    findTemplateRows: () => ({ itemStart: 10, itemRows: 2 }),
    findContractPaymentRefs_: () => ({ finalAmountCell: 'H47' }),
    readContractAmount_: (ws,ref) => ws.getRange(ref).getValue(),
    registeredTradeCorrectionDate_: (raw) => String(raw),
    registeredTradeCorrectionTime_: (raw) => String(raw),
    regenerateContractById(tid, extra, opts) {
      calls.regenerations++; assert.equal(calls.lockHeld,false,'regeneration must release ScriptLock');
      assert.equal(tid,input.tradeId); assert.equal(opts.strictLedgerLink,true);
      assert.ok(context.dashboardTradeMutationLeaseError_(properties,tid,'checkoutItem','other'),'cross-operation lease must cover regeneration');
      if(options.duringRegeneration) options.duringRegeneration({ run: value => context.correctRegisteredTrade(value), props });
      if(options.regenError) throw new Error('synthetic regeneration failure');
      const table = Array.from({length:47},()=>Array(13).fill(''));
      const tradeRows = schedule.data.slice(1).filter(row => row[1] === tid);
      tradeRows.forEach((item,index) => { const row=9+index%2,col=index<2?1:7; table[row][col]=item[3]; table[row][col+2]=item[4]; table[row][col+4]=item[11] || ''; /* Match the generator: an approved zero price displays blank. */ });
      const total=tradeRows.reduce((sum,row)=>sum+row[4]*row[11]*3,0); table[46][7]=total;
      generated=sheet('generated',table); ledger.data[1][2]='https://docs.example/price-contract'; ledger.data[1][8]=total;
      if(options.afterRegeneration) options.afterRegeneration({schedule,contract,ledger,generated});
      return { success:true,fileId:'price-contract',url:'https://docs.example/price-contract',finalAmount:total,linkUpdate:{success:true} };
    }
  };
  const source=fs.readFileSync(path.resolve(__dirname,'../checkAvailability.js'),'utf8').replace(/\r\n/g,'\n');
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function readDashboardMutationLease_'),source.indexOf('var DASHBOARD_STRUCTURE_QUEUE_PREFIX_')),context);
  vm.runInContext(source.slice(source.indexOf('function normalizeRegisteredTradeCorrection_'),source.indexOf('\nfunction changeRegisteredTradeDates')),context);
  // Date/time parser implementation lives outside this extracted unit.
  context.registeredTradeCorrectionDate_ = raw => String(raw);
  context.registeredTradeCorrectionTime_ = raw => String(raw);
  if(options.lease) props.set('checkoutItemMutation_'+input.tradeId,JSON.stringify({token:'other',at:Date.now()}));
  return { run: value => copy(context.correctRegisteredTrade(value || copy(input))), context,calls,props,schedule,contract,ledger };
}

test('staff-approved price-only correction writes one exact L cell and verifies generated contract and ledger',()=>{
  const h=harness(), before=copy(h.schedule.data), contract=copy(h.contract.data);
  const result=h.run();
  assert.equal(result.success,true,result.error); assert.equal(result.customerNotificationSent,false);
  assert.deepEqual(h.calls.writes,[{name:'스케줄상세',row:2,col:12,value:80000}]);
  before[1][11]=80000; assert.deepEqual(h.schedule.data,before); assert.deepEqual(h.contract.data,contract);
  assert.equal(h.calls.regenerations,1); assert.equal(result.priceReadback.after[0].unitPrice,80000);
  assert.equal(result.priceReadback.contractAmount,600000); assert.equal(result.priceReadback.ledgerAmount,600000);
  assert.equal(result.authoritativeReadback.after.schedule.rows[0].unitPrice,80000);
  assert.equal(result.priceReadback.contractItems[0].unitPrice,80000);
  assert.ok(!h.props.has('registeredTradePriceMutation_'+input.tradeId));
});

test('same operation verifies stored terminal result without reapplying or regenerating; changed payload cannot reuse receipt',()=>{
  const h=harness(); assert.equal(h.run().success,true);
  const replay=h.run(); assert.equal(replay.success,true,replay.error); assert.equal(replay.replayed,true);
  assert.equal(h.calls.regenerations,1); assert.equal(h.calls.writes.length,1);
  const changed=copy(input);changed.priceChanges[0].unitPrice=70000;
  assert.equal(h.run(changed).success,false); assert.equal(h.calls.regenerations,1);
  const stale=copy(input);stale.operationId='ce1e3110-3517-48e3-928d-3cbe283d9900';
  const rejected=h.run(stale); assert.equal(rejected.noMutationPerformed,true); assert.equal(h.calls.writes.length,1);
});

test('normalizers reject missing approval, mixed changes, empty or imprecise prices before any write',()=>{
  const invalid=[
    {...input,staffApproval:undefined}, {...input,expectedPeriod:undefined}, {...input,priceChanges:[]},
    {...input,add:[{name:'FX3',qty:1}]}, {...input,remove:[{scheduleId:'260914-002-18',expectedName:'FX3',expectedQty:2}]},
    {...input,dateChange:{newStartDate:'2026-09-15',newEndDate:'2026-09-17'}}, {...input,sourceRequestId:'RQ-260914-001'},
    ...['80000',-1,Infinity,NaN,1.1].map(unitPrice=>({...input,priceChanges:[{...input.priceChanges[0],unitPrice}]})),
    {...input,priceChanges:[{...input.priceChanges[0],expectedQty:'1'}]},
    {...input,priceChanges:[{...input.priceChanges[0],expectedUnitPrice:'100000'}]},
    {...input,priceChanges:[{...input.priceChanges[0],scheduleId:'260914-003-14'}]},
    {...input,priceChanges:[input.priceChanges[0],input.priceChanges[0]]},
    {...input,priceChanges:[{...input.priceChanges[0],discount:20}]}
  ];
  const h=harness(); for(const value of invalid) { assert.throws(()=>h.context.normalizeRegisteredTradeCorrection_(value)); assert.throws(()=>normalizeCorrectionInput(value)); }
  assert.throws(()=>normalizeCorrectionInput({...input,sendEstimate:true}),/price/i);
  assert.equal(h.calls.writes.length,0);
});

for(const field of ['expectedName','expectedQty','expectedUnitPrice']) test('exact preflight rejects stale '+field,()=>{
  const h=harness(), value=copy(input);value.priceChanges[0][field]=field==='expectedName'?'Other':2;
  const result=h.run(value); assert.equal(result.success,false);assert.equal(result.noMutationPerformed,true); assert.equal(h.calls.writes.length,0);assert.equal(h.calls.regenerations,0);
});

test('component targets, duplicate IDs, active checkout and durable leases cannot mutate',()=>{
  for(const options of [{checkoutStarted:true},{lease:true},{busy:true}]) {const h=harness(options),r=h.run();assert.equal(r.success,false);assert.equal(h.calls.writes.length,0);}
  const h=harness(), value=copy(input);value.priceChanges[0]={scheduleId:'260914-002-15',expectedName:'XEEN CF 24mm',expectedQty:1,expectedUnitPrice:0,unitPrice:80000};assert.equal(h.run(value).noMutationPerformed,true);
  h.schedule.data.push(copy(h.schedule.data[1]));assert.equal(h.run().noMutationPerformed,true);assert.equal(h.calls.writes.length,0);
});

for(const [label, options] of [
  ['regeneration fails',{regenError:true}],
  ['ledger amount is wrong',{afterRegeneration:({ledger})=>ledger.data[1][8]++}],
  ['generated item price is wrong',{afterRegeneration:({generated})=>generated.data[9][5]++}],
  ['unrelated schedule cell changed',{afterRegeneration:({schedule})=>schedule.data[3][10]='concurrent edit'}],
  ['contract discount changed',{afterRegeneration:({contract})=>contract.data[1][10]='일반'}],
  ['target write was not retained',{afterWrite:({schedule})=>schedule.data[1][11]=100000}]
]) test(label+' reports partial state and never repeats a possible mutation',()=>{
  const h=harness(options),result=h.run();assert.equal(result.success,false);assert.equal(result.outcomeUnknown,true);assert.equal(result.code,'PARTIAL_STATE');
  const writes=h.calls.writes.length,regens=h.calls.regenerations;
  const retry=h.run();assert.equal(retry.success,false);assert.equal(retry.outcomeUnknown,true);
  assert.equal(h.calls.writes.length,writes);assert.equal(h.calls.regenerations,regens);
});

test('CLI performs one authenticated native price correction and requires exact price, contract and ledger proof',async()=>{
  const h=harness(); const payload=h.run(); assert.equal(payload.success,true,payload.error);
  const config={VILLAGE2_API_URL:'https://script.google.com/macros/s/synthetic/exec',VILLAGE2_API_KEY:'synthetic'};
  const calls=[];const fetchImpl=async(url,opts)=>{calls.push(JSON.parse(opts.body));return{ok:true,json:async()=>payload};};
  const result=await runRegisteredTradeCorrection({config,input:copy(input),fetchImpl});
  assert.equal(result.verified,true);assert.equal(calls.length,1);assert.equal(calls[0].action,'scheduleCorrectRegisteredTrade');assert.deepEqual(calls[0].args.priceChanges,input.priceChanges);assert.equal(result.send.attempted,false);
  for(const corrupt of [
    value=>{delete value.priceReadback;}, value=>{value.priceReadback.after[0].unitPrice=100000;},
    value=>{value.priceReadback.contractItems[0].unitPrice=100000;}, value=>{value.priceReadback.ledgerAmount++;},
    value=>{value.priceReadback.after[0].isComponent=true;},
    value=>{value.readback.contract.startDate='2026-09-15';value.authoritativeReadback.after=copy(value.readback);},
    value=>{value.readback.schedule.rows[0].unitPrice=100000;value.authoritativeReadback.after=copy(value.readback);}
  ]) {const bad=copy(payload);corrupt(bad);await assert.rejects(runRegisteredTradeCorrection({config,input:copy(input),fetchImpl:async()=>({ok:true,json:async()=>bad})}),/readback/i);}
});


test('duplicate operation during regeneration cannot release the executing invocation lease',()=>{
  const h=harness({duringRegeneration({run,props}) {
    const retry=run(copy(input)); assert.equal(retry.success,false);assert.equal(retry.outcomeUnknown,true);
    assert.ok(props.has('registeredTradePriceMutation_'+input.tradeId));
  }});
  assert.equal(h.run().success,true);assert.equal(h.calls.regenerations,1);assert.equal(h.calls.writes.length,1);
});

test('completed receipt detects later external drift without reapplying the old price',()=>{
  const h=harness();assert.equal(h.run().success,true);h.schedule.data[1][11]=90000;
  const retry=h.run();assert.equal(retry.success,false);assert.equal(retry.outcomeUnknown,true);assert.equal(h.calls.regenerations,1);assert.equal(h.calls.writes.length,1);
});

test('two explicit top-level prices preserve component prices and verify both contract table sides with one regeneration',()=>{
  const h=harness(),value=copy(input);
  value.priceChanges.push({scheduleId:'260914-002-18',expectedName:'FX3',expectedQty:2,expectedUnitPrice:60000,unitPrice:50000});
  const result=h.run(value);assert.equal(result.success,true,result.error);assert.equal(h.calls.writes.length,2);assert.equal(h.calls.regenerations,1);
  assert.equal(h.schedule.data[2][11],0);assert.equal(result.priceReadback.contractItems.length,2);assert.equal(result.priceReadback.ledgerAmount,540000);
  assert.equal(h.run(value).success,true);assert.equal(h.calls.regenerations,1);assert.equal(h.calls.writes.length,2);
});


function includedTransmitterPriceInput(h) {
  const name = 'MARS 400S PRO 세트';
  h.schedule.data.splice(4,0,['260914-002-21','260914-002',name,name,1,'2026-09-14','18:00','2026-09-17','18:00','등록','승인된 동봉품',20000,'보존 메모']);
  const value=copy(input);
  value.priceChanges.push({scheduleId:'260914-002-21',expectedName:name,expectedQty:1,expectedUnitPrice:20000,unitPrice:0});
  value.staffApproval.customerRequest='XEEN 단가 8만원 정정 및 FX9 포함 기본 송수신기 요청';
  value.staffApproval.staffConfirmation='XEEN은 8만원으로 정정하고 기본 송수신기는 FX9 포함품으로 제공합니다.';
  return value;
}

test('explicitly staff-approved included item may change 20000 to 0 alongside XEEN 100000 to 80000, with one regeneration',async()=>{
  const h=harness(),value=includedTransmitterPriceInput(h),before=copy(h.schedule.data);
  const result=h.run(value);assert.equal(result.success,true,result.error);
  before[1][11]=80000;before[4][11]=0;assert.deepEqual(h.schedule.data,before);
  assert.deepEqual(h.calls.writes,[{name:'스케줄상세',row:2,col:12,value:80000},{name:'스케줄상세',row:5,col:12,value:0}]);
  assert.equal(h.calls.regenerations,1);assert.equal(result.priceReadback.after[1].unitPrice,0);assert.equal(result.priceReadback.contractItems[1].unitPrice,0);
  assert.equal(result.priceReadback.contractAmount,600000);assert.equal(result.priceReadback.ledgerAmount,600000);
  assert.equal(h.run(value).success,true);assert.equal(h.calls.writes.length,2);assert.equal(h.calls.regenerations,1);
  const config={VILLAGE2_API_URL:'https://script.google.com/macros/s/synthetic/exec',VILLAGE2_API_KEY:'synthetic'};
  const bodies=[];const out=await runRegisteredTradeCorrection({config,input:value,fetchImpl:async(_url,opts)=>{bodies.push(JSON.parse(opts.body));return{ok:true,json:async()=>result};}});
  assert.equal(out.verified,true);assert.equal(out.send.attempted,false);assert.equal(bodies.length,1);assert.equal(bodies[0].args.priceChanges[1].unitPrice,0);
});

test('zero-priced inclusion still requires staff approval and exact existing identity, quantity and old price',()=>{
  for(const alteration of [
    value=>{delete value.staffApproval;},value=>{delete value.expectedPeriod;},
    value=>{value.priceChanges[1].expectedName='다른 송수신기';},value=>{value.priceChanges[1].expectedQty=2;},
    value=>{value.priceChanges[1].expectedUnitPrice=30000;}
  ]) {
    const h=harness(),value=includedTransmitterPriceInput(h);alteration(value);
    if(!value.staffApproval || !value.expectedPeriod) {
      assert.throws(()=>h.run(value));assert.throws(()=>normalizeCorrectionInput(value));
    } else { const result=h.run(value);assert.equal(result.success,false);assert.equal(result.noMutationPerformed,true); }
    assert.equal(h.calls.writes.length,0);assert.equal(h.calls.regenerations,0);
  }
});
