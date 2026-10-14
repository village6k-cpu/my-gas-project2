const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'../supabaseSync.js'),'utf8');
const body=source.slice(source.indexOf('function buildSupabaseTrades_'),source.indexOf('/** payload 키 구성이 같은 행끼리'));
const tid='260403-015',url='https://docs.google.com/spreadsheets/d/fixture-contract/edit';
function fixture(){
 const master=[tid,'테스트고객','010-1234-5678','','2026-04-03','10:00','2026-04-04','10:00',1,'반납완료','개인사업자/프리랜서'];
 const ledger=['2026-04-03','테스트고객',url,'',tid,'010-1234-5678','','',70400];
 const masters=[master],ledgers=[ledger],props={},calls=[];
 const table=rows=>({getLastRow:()=>rows.length+1,getRange:(_r,c,_h,w)=>({getValues:()=>rows.map(r=>r.slice(c-1,c-1+w)),getDisplayValues:()=>rows.map(r=>r.slice(c-1,c-1+w).map(String))})});
 const context={Date,Math,JSON,Object,String,Number,Array,
  Utilities:{formatDate:(d,tz)=>new Intl.DateTimeFormat('en-CA',{timeZone:tz,year:'numeric',month:'2-digit',day:'2-digit'}).format(d)},
  PropertiesService:{getScriptProperties:()=>({getProperties:()=>({...props})})},
  parseDT:(d,t)=>new Date(d+'T'+t+':00+09:00'),
  getTimelineData:()=>({groups:[],items:[]}),getDashboardData:()=>{throw Error('old financial values must not depend on a current dashboard window');},
  SpreadsheetApp:{getActiveSpreadsheet:()=>({getSheetByName:n=>n==='계약마스터'?table(masters):null})},
  openTradeLedgerContext_:()=>{calls.push('ledger-read');return{sheet:table(ledgers),spreadsheet:{getSpreadsheetTimeZone:()=>context.ledgerTimeZone||'Asia/Seoul'}};}
 };
 vm.runInNewContext(body,context);return{context,master,ledger,masters,ledgers,props,calls,build:()=>context.buildSupabaseTrades_([tid])};
}
test('out-of-window historical projection carries authoritative amount and original contract link',()=>{
 const f=fixture(),before=JSON.stringify({master:f.master,ledger:f.ledger}),row=f.build().trades[0];
 assert.equal(row.amount,70400);assert.equal(row.contract_url,url);assert.equal(row.discount_type,'개인사업자/프리랜서');
 assert.equal(JSON.stringify({master:f.master,ledger:f.ledger}),before);assert.deepEqual(f.calls,['ledger-read']);
 for(const field of ['deposit_status','proof_type','payment_method','issue_status','setup_done','return_done','checkout_state','contract_regen_pending'])assert.equal(field in row,false,field);
});
test('manual paid totals are copied exactly, never recalculated from a current discount policy',()=>{
 const f=fixture();f.ledger[8]=123457;assert.equal(f.build().trades[0].amount,123457);
});
test('native ledger Date identity uses its source spreadsheet timezone',()=>{
 const f=fixture();f.context.ledgerTimeZone='America/Los_Angeles';f.ledger[0]=new Date('2026-04-03T22:00:00Z');assert.equal(f.build().trades[0].amount,70400);
});
for(const [name,mutate] of [
 ['duplicate ledger',f=>f.ledgers.push([...f.ledger])],
 ['duplicate master',f=>f.masters.push([...f.master])],
 ['other customer',f=>f.ledger[1]='다른고객'],
 ['other phone',f=>f.ledger[5]='010-9999-9999'],
 ['other checkout date',f=>f.ledger[0]='2026-04-02'],
 ['shared contract',f=>{const r=[...f.ledger];r[4]='260403-016';f.ledgers.push(r);}],
 ['pending regeneration',f=>f.props['contractEditTS_'+tid]='1'],
 ['running direct regeneration',f=>f.props['contractDirectRegen_v1_'+tid]='1'],
 ['price correction ownership gap',f=>f.props['registeredTradePriceMutation_'+tid]=JSON.stringify({expiresAt:Date.now()+60000})],
 ['unresolved price correction marker',f=>f.props['registeredTradePriceMutation_'+tid]='requires readback'],
 ['unpriced zero',f=>f.ledger[8]=0],
 ['missing contract',f=>f.ledger[2]=''],
])test('unproven archival financial fields preserve existing projection values: '+name,()=>{
 const f=fixture();mutate(f);const row=f.build().trades[0];assert.equal('amount' in row,false);assert.equal('contract_url' in row,false);
});
test('ledger outage fails the dirty build instead of claiming an incomplete financial projection',()=>{
 const f=fixture();f.context.openTradeLedgerContext_=()=>{throw Error('ledger unavailable');};assert.throws(f.build,/ledger unavailable/);
});
test('cancelled archival trades do not acquire a new financial projection',()=>{
 const f=fixture();f.master[9]='취소';const out=f.build();assert.equal(out.trades.length,0);assert.equal(f.calls.length,0);
});
