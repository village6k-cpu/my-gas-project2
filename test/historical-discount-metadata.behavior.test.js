const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const gas=fs.readFileSync(require('node:path').join(__dirname,'../checkAvailability.js'),'utf8');
// Replacing the metadata-only path with ordinary discount regeneration must fail:
// paid historical totals, coupon and the original linked document are immutable.
function fixture(){
 const tid='260403-015',master=[tid,'테스트고객','010-1234-5678','','2026-04-03','10:00','2026-04-04','10:00',1,'반납완료','','메모'];
 const ledger=['2026-04-03','테스트고객','https://docs.google.com/spreadsheets/d/contract1/edit','',tid,'010-1234-5678','','',70400,'이체','','','입금완료'];
 const doc=Array.from({length:25},()=>Array(14).fill(''));
 doc[1][0]='예약자(상호)';doc[1][2]='테스트고객';doc[2][0]='연락처';doc[2][2]='010-1234-5678';doc[19][9]=80000;
 doc[6][0]='대여일자';doc[6][2]='2026/04/03 10:00';doc[7][0]='반납일자';doc[7][2]='2026/04/04 10:00';
 doc[20][0]='사전 할인';doc[20][2]='개인사업자/프리랜서20%';doc[20][6]='추가 할인';doc[20][8]='해당없음';
 doc[21][0]='장기 할인';doc[21][2]='해당없음';doc[21][6]='쿠폰 할인';doc[21][8]='5%';
 doc[22][0]='할인 적용 금액';doc[22][7]=64000;doc[23][0]='총 결제 금액';doc[23][7]=70400;
 const formulas=doc.map(r=>r.map(()=>''));formulas[23][7]='=ROUNDUP(H23*1.1,-1)';
 const values=new Map(),writes=[],financialWrites=[];
 const table=rows=>({getLastRow:()=>rows.length+1,getLastColumn:()=>rows[0].length,getRange:(r,c,h=1,w=1)=>({
  getValues:()=>rows.slice(r-2,r-2+h).map(row=>row.slice(c-1,c-1+w)),
  getDisplayValues:()=>rows.slice(r-2,r-2+h).map(row=>row.slice(c-1,c-1+w).map(String)),
  getDisplayValue:()=>String(rows[r-2][c-1]),
  setValue:value=>{writes.push({r,c,value});rows[r-2][c-1]=value;if(ctx.throwAfterWrite)throw Error('uncertain Sheets timeout');}
 })});
 const masterRows=[master],ledgerRows=[ledger],props={getProperty:k=>values.get(k)||null,setProperty:(k,v)=>values.set(k,String(v)),setProperties:o=>Object.entries(o).forEach(([k,v])=>values.set(k,String(v)))};
 const ctx={Date,Math,JSON,Number,PropertiesService:{getScriptProperties:()=>props},
  LockService:{getScriptLock:()=>({tryLock:()=>{if(ctx.onLock)ctx.onLock();return true;},releaseLock(){}})},
  SpreadsheetApp:{getActiveSpreadsheet:()=>({getSheetByName:()=>Object.assign(table(masterRows),{getParent:()=>({getSpreadsheetTimeZone:()=>ctx.masterTimeZone||'Asia/Seoul'})})}),openById:()=>({getName:()=>ctx.documentTitle||'계약서_'+tid+'_테스트고객',getSpreadsheetTimeZone:()=>ctx.documentTimeZone||'Asia/Seoul',getSheets:()=>[{getDataRange:()=>({getValues:()=>doc,getFormulas:()=>formulas}),getName:()=> '계약서'}]})},
  Utilities:{formatDate:(v,tz)=>new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(v),DigestAlgorithm:{SHA_256:'sha256'},Charset:{UTF_8:'utf8'},computeDigest:(_,s)=>Array.from(crypto.createHash('sha256').update(s).digest())}};
 vm.runInNewContext(gas,ctx);
 ctx.openTradeLedgerContext_=()=>({sheet:Object.assign(table(ledgerRows),{getParent:()=>({getSpreadsheetTimeZone:()=>ctx.ledgerTimeZone||'Asia/Seoul'})})});
 ctx.dashboardTradeMutationLeaseError_=()=>null;
 ctx.supaMarkTradeDirty_=()=>financialWrites.push('inventory-notification');ctx.invalidateDashboardCacheForTrade_=()=>{};
 ctx.scheduleContractRegen=()=>financialWrites.push('regen');
 return {ctx,tid,master,masterRows,ledger,ledgerRows,doc,formulas,values,writes,financialWrites,
  input:{tid,discountType:'개인사업자/프리랜서',previousDiscountType:'',mutationId:'history-test-1'}};
}
test('metadata restoration is an explicit supported capability, not a normal repricing call',()=>{
 const f=fixture();assert.equal(typeof f.ctx.restoreTradeDiscountMetadata,'function');
});
test('dry run proves current category and amount without changing any cell',()=>{
 const f=fixture(),r=f.ctx.restoreTradeDiscountMetadata({...f.input,dryRun:true});
 assert.equal(r.success,true);assert.equal(r.dryRun,true);assert.ok(r.snapshotDigest);assert.equal(r.amount,70400);assert.equal(f.writes.length,0);
});
test('read-only inspection does not take the global write lock or block ordinary reservations',()=>{
 const f=fixture();f.ctx.onLock=()=>{throw Error('inspection must not acquire write lock');};
 assert.equal(f.ctx.restoreTradeDiscountMetadata({...f.input,dryRun:true}).success,true);assert.equal(f.writes.length,0);
});
test('read-only inspection does not run mutable expired-lease cleanup outside the write lock',()=>{
 const f=fixture();f.ctx.dashboardTradeMutationLeaseError_=()=>{throw Error('mutable lease cleanup');};
 assert.equal(f.ctx.restoreTradeDiscountMetadata({...f.input,dryRun:true}).success,true);
});
test('current VAT-labelled final total is supported without falling back to a physical row',()=>{
 const f=fixture();f.doc[23][0]='총 결제 금액 (VAT 10% 포함)';
 assert.equal(f.ctx.restoreTradeDiscountMetadata({...f.input,dryRun:true}).success,true);
});
test('the deployed template planned-return label is treated as the rental return date',()=>{
 const f=fixture();f.doc[7][0]='반납일자(예정)';
 assert.equal(f.ctx.restoreTradeDiscountMetadata({...f.input,dryRun:true}).success,true);
});
test('Sheets Date cells keep their type until timezone-aware rental-period comparison',()=>{
 const f=fixture();f.doc[6][2]=new Date('2026-04-03T01:00:00Z');f.doc[7][2]=new Date('2026-04-04T01:00:00Z');
 assert.equal(f.ctx.restoreTradeDiscountMetadata({...f.input,dryRun:true}).success,true);
});
test('late-hour contract Dates use the source spreadsheet timezone, not the server timezone',()=>{
 const f=fixture();f.ctx.documentTimeZone='America/Los_Angeles';
 f.doc[6][2]=new Date('2026-04-03T22:00:00Z');f.doc[7][2]=new Date('2026-04-04T17:00:00Z');
 assert.equal(f.ctx.restoreTradeDiscountMetadata({...f.input,dryRun:true}).success,true);
});
test('legacy ledger and master Date cells are each compared in their own spreadsheet timezone',()=>{
 const f=fixture();legacy(f);f.ctx.masterTimeZone='America/Los_Angeles';f.ctx.ledgerTimeZone='Asia/Seoul';
 f.master[4]=new Date('2026-04-03T22:00:00Z');f.master[6]=new Date('2026-04-04T17:00:00Z');f.ledger[0]=new Date('2026-04-02T15:00:00Z');
 assert.equal(f.ctx.restoreTradeDiscountMetadata({...f.input,dryRun:true}).success,true);
});
function legacy(f){f.doc[1][2]='';f.doc[2][2]='';f.doc[6][2]='';f.doc[7][2]='';}
test('an unfilled legacy template is bound by exact unique ledger identity, checkout date and file title',()=>{
 const f=fixture();legacy(f);
 const p=f.ctx.restoreTradeDiscountMetadata({...f.input,dryRun:true});assert.equal(p.success,true);
 const r=f.ctx.restoreTradeDiscountMetadata({...f.input,expectedSnapshotDigest:p.snapshotDigest});assert.equal(r.success,true);assert.equal(f.writes.length,1);
});
test('a labelled blank legacy additional-discount field is not confused with the next long-discount heading',()=>{
 const f=fixture();f.doc[20]=Array(14).fill('');f.doc[20][0]='사전 할인';f.doc[20][2]='학생30%';f.doc[20][3]='추가 할인';f.doc[20][8]='장기할인';f.doc[20][9]='해당없음';
 assert.equal(f.ctx.restoreTradeDiscountMetadata({...f.input,discountType:'학생',dryRun:true}).success,true);
});
test('a document linked to another trade while waiting for the lock blocks the K write',()=>{
 const f=fixture(),p=f.ctx.restoreTradeDiscountMetadata({...f.input,dryRun:true});
 f.ctx.onLock=()=>{const row=[...f.ledger];row[4]='260403-016';f.ledgerRows.push(row);};
 const r=f.ctx.restoreTradeDiscountMetadata({...f.input,expectedSnapshotDigest:p.snapshotDigest});
 assert.equal(r.success,false);assert.equal(f.writes.length,0);
});
for(const [name,mutate] of [
 ['wrong file title',f=>f.ctx.documentTitle='계약서_260403-016_테스트고객'],
 ['wrong ledger phone',f=>f.ledger[5]='010-9999-9999'],
 ['wrong ledger checkout date',f=>f.ledger[0]='2026-04-02'],
 ['conflicting filled borrower',f=>f.doc[1][2]='다른고객'],
 ['conflicting filled date',f=>f.doc[6][2]='2026/04/02'],
 ['another trade shares the document',f=>{const other=[...f.ledger];other[4]='260403-016';f.ledgerRows.push(other);}],
])test('legacy restoration rejects '+name,()=>{
 const f=fixture();legacy(f);mutate(f);assert.equal(f.ctx.restoreTradeDiscountMetadata({...f.input,dryRun:true}).success,false);assert.equal(f.writes.length,0);
});
test('historical correction only changes K and preserves coupon, document, settlement and no-regen state',()=>{
 const f=fixture(),before=JSON.stringify({ledger:f.ledger,doc:f.doc});
 const proof=f.ctx.restoreTradeDiscountMetadata({...f.input,dryRun:true});
 const r=f.ctx.restoreTradeDiscountMetadata({...f.input,expectedSnapshotDigest:proof.snapshotDigest});
 assert.equal(r.success,true);assert.equal(r.contractRegenPending,false);assert.equal(f.master[10],f.input.discountType);
 assert.equal(JSON.stringify({ledger:f.ledger,doc:f.doc}),before);assert.equal(f.writes.length,1);assert.equal(f.writes[0].c,11);
 assert.equal(f.financialWrites.length,0);assert.equal(f.values.has('contractEditTS_'+f.tid),false);
 assert.ok(f.values.has('SUPA_DIRTY_v2_'+f.tid));
 const retry=f.ctx.restoreTradeDiscountMetadata({...f.input,expectedSnapshotDigest:proof.snapshotDigest});
 assert.equal(retry.success,true);assert.equal(retry.duplicate,true);assert.equal(f.writes.length,1);
});
for(const [name,mutate] of [
 ['concurrent ledger change',f=>{f.ledger[8]=70000;}],
 ['another master row with same tid',f=>{f.masterRows.push([...f.master]);}],
 ['duplicate ledger tid',f=>{f.ledgerRows.push([...f.ledger]);}],
 ['pending regeneration',f=>{f.values.set('contractEditTS_'+f.tid,'1');}],
 ['in-flight direct regeneration',f=>{f.values.set('contractDirectRegen_v1_'+f.tid,'1');}],
 ['changed coupon after inspection',f=>{f.doc[21][8]='10%';}],
 ['changed formula after inspection',f=>{f.formulas[23][7]='=H23';}],
 ['changed customer identity',f=>{f.master[1]='다른고객';}],
 ['document contains another trade ID',f=>{f.doc[0][0]='260403-016';}],
 ['document identity does not match',f=>{f.doc[1][2]='다른고객';}],
 ['name copied in notes cannot hide a different borrower',f=>{f.doc[1][2]='다른고객';f.doc[4][0]='테스트고객';}],
 ['phone copied in notes cannot hide a different contact',f=>{f.doc[2][2]='010-9999-9999';f.doc[4][0]='010-1234-5678';}],
])test(name+' fails closed without a master write',()=>{
 const f=fixture(),proof=f.ctx.restoreTradeDiscountMetadata({...f.input,dryRun:true});mutate(f);
 const r=f.ctx.restoreTradeDiscountMetadata({...f.input,expectedSnapshotDigest:proof.snapshotDigest});
 assert.notEqual(r.success,true);assert.equal(f.writes.length,0);assert.equal(f.financialWrites.length,0);
});
test('wrong target category and missing CAS proof are rejected',()=>{
 const f=fixture();assert.notEqual(f.ctx.restoreTradeDiscountMetadata({...f.input,discountType:'학생',dryRun:true}).success,true);
 assert.notEqual(f.ctx.restoreTradeDiscountMetadata(f.input).success,true);assert.equal(f.writes.length,0);
});
test('inspection rejects an unrelated document even when correct name and phone occur only in its notes',()=>{
 const f=fixture();f.doc[1][2]='다른고객';f.doc[2][2]='010-9999-9999';f.doc[4][0]='테스트고객';f.doc[5][0]='010-1234-5678';
 assert.equal(f.ctx.restoreTradeDiscountMetadata({...f.input,dryRun:true}).success,false);
});
test('inspection rejects a different rental period for the same borrower',()=>{
 const f=fixture();f.doc[6][2]='2026/03/03 10:00';
 assert.equal(f.ctx.restoreTradeDiscountMetadata({...f.input,dryRun:true}).success,false);
});
test('a partially committed receipt is readback-only, never a replayed write',()=>{
 const f=fixture(),proof=f.ctx.restoreTradeDiscountMetadata({...f.input,dryRun:true});
 f.values.set('historicalDiscountRestore_v1_'+f.tid,JSON.stringify({phase:'pending',mutationId:f.input.mutationId}));
 const r=f.ctx.restoreTradeDiscountMetadata({...f.input,expectedSnapshotDigest:proof.snapshotDigest});
 assert.notEqual(r.success,true);assert.equal(f.writes.length,0);
});
test('a write that commits then throws is indeterminate and never advertised safe to retry',()=>{
 const f=fixture(),proof=f.ctx.restoreTradeDiscountMetadata({...f.input,dryRun:true});f.ctx.throwAfterWrite=true;
 const r=f.ctx.restoreTradeDiscountMetadata({...f.input,expectedSnapshotDigest:proof.snapshotDigest});
 assert.equal(f.master[10],f.input.discountType);assert.equal(r.success,false);assert.equal(r.noMutationPerformed,false);assert.equal(r.readbackRequired,true);
 const again=f.ctx.restoreTradeDiscountMetadata({...f.input,expectedSnapshotDigest:proof.snapshotDigest});
 assert.equal(again.success,false);assert.equal(f.writes.length,1);
});
test('metadata repair requires internal authentication and POST',()=>{
 const f=fixture();f.values.set('VILLAGE_API_WRITE_KEY_V1','internal-test');
 vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname,'../sheetAPI.js'),'utf8'),f.ctx);
 f.ctx.jsonResponse=value=>value;
 const publicResult=f.ctx.handleRequestCore_({parameter:{key:'village2026',action:'restoreTradeDiscountMetadata'},villageHttpMethod_:'POST'});
 assert.match(publicResult.error,/internal/);
 const getResult=f.ctx.handleRequestCore_({parameter:{key:'internal-test',action:'restoreTradeDiscountMetadata'},villageHttpMethod_:'GET'});
 assert.match(getResult.error,/POST/);
 const postResult=f.ctx.handleRequestCore_({parameter:{},villageHttpMethod_:'POST',postData:{contents:JSON.stringify({...f.input,dryRun:true,key:'internal-test',action:'restoreTradeDiscountMetadata'})}});
 assert.equal(postResult.success,true);assert.equal(f.writes.length,0);
});
