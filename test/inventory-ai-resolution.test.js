const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
function env(){const c={Utilities:{formatDate:d=>d.toISOString()}};vm.createContext(c);for(const name of ['inventorySupply.js','inventoryRisk.js','inventoryRiskMonitor.js','preRegistrationStockAlerts.js','inventoryStockIntake.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'..',name),'utf8'),c);return c;}
const period={start:'2026-10-01T09:00:00+09:00',end:'2026-10-02T09:00:00+09:00'};
const item=(x={})=>({id:'EQ-1',name:'스크림 세트',stock:3,maintenance:0,status:'정상',aliases:[],...x});
const row=(x={})=>({id:'s1',tradeId:'t1',name:'스크림세트',setName:'스크림세트',quantity:1,status:'대기',...period,...x});
const report=(c,s)=>c.buildInventoryRiskReport_(s,{now:'2026-09-14T00:00:00+09:00',turnaroundMinutes:0});

test('equivalent set spellings cannot erase composition and whole-kit inventory is counted once',()=>{
 const c=env();const sets=[{name:'스크림세트',components:[{name:'고보 / 실크 / 싱글 / 더블 / 우드락',quantity:1,tracked:false}]},{name:'스크림 세트',components:[]}];
 for(const ordered of [sets,[...sets].reverse()]){
  const s={equipment:[item({stock:1})],sets:ordered,schedules:[row({quantity:2}),row({id:'c1',name:sets[0].components[0].name,quantity:2})]};
  const r=report(c,s);assert.equal(r.alerts.filter(a=>a.kind==='unknown_equipment').length,0);
  assert.equal(r.alerts.find(a=>a.kind==='shortage')?.shortage,1);
 }
});

test('a blank maintenance cell uses the same identified verified ledger value, not an invented count',()=>{
 const c=env();const equipment=[item({id:'WRL-025',name:'솔리드컴SE 4S',stock:1,maintenance:''})];
 assert.equal(typeof c.inventoryRiskEnrichLedger_,'function');
 c.inventoryRiskEnrichLedger_(equipment,[{equipment_id:'WRL-025',name:'솔리드컴SE 4S',aliases:[],stock_total:1,stock_maint:0,state:'정상',verify_status:'verified'}]);
 assert.equal(equipment[0].maintenance,0);
 const mismatch=[item({maintenance:''})];c.inventoryRiskEnrichLedger_(mismatch,[{equipment_id:'EQ-1',name:'다른 장비',stock_total:3,stock_maint:0,state:'정상',verify_status:'verified'}]);assert.equal(mismatch[0].maintenance,'');
});

test('known catalog-only equipment is a missing stock record and exact categories expose real model choices',()=>{
 const c=env();const s={equipment:[item({id:'M1',name:'스몰HD INDIE7',category:'7인치 모니터'}),item({id:'M2',name:'티비로직 F-7HS',category:'7인치 모니터'}),item({id:'M3',name:'5인치 모니터',category:'5인치 모니터'})],sets:[{name:'NiSi True Color ND-Vario 가변 ND 필터',components:[]}],schedules:[row({name:'NiSi True Color ND-Vario 가변 ND 필터',setName:''}),row({id:'s2',name:'7인치 모니터',setName:''})]};
 const r=report(c,s);assert.ok(r.alerts.some(a=>a.kind==='catalog_stock_missing'));
 const choice=r.alerts.find(a=>a.kind==='model_selection');assert.deepEqual(Array.from(choice?.candidates||[]),['스몰HD INDIE7','티비로직 F-7HS']);
});

test('request uncertainty retains only this booking and its period, with actionable reasons',()=>{
 const c=env();const name='NiSi True Color ND-Vario 가변 ND 필터';const req={id:'RQ-261001-001',customer:'테스트 고객',rows:[row({id:'r1',name,setName:''})]};
 const s={equipment:[],sets:[{name,components:[]}],schedules:[row({id:'old',tradeId:'other',name,setName:'',start:'2026-11-01T09:00:00+09:00',end:'2026-11-02T09:00:00+09:00'})]};
 const result=c.preRegistrationStockEvaluate_(req,s);assert.equal(result.uncertain[0].start,period.start);assert.equal(result.uncertain[0].bookings.length,1);
 const text=c.preRegistrationStockText_(result);assert.match(text,/카탈로그.*재고|재고.*수량/);assert.doesNotMatch(text,/대체 장비·외부 조달/);
});


test('AI inventory context gives original set composition and full physical choices without writes',()=>{
 const c=env();const equipment=[item({id:'M1',name:'스몰HD INDIE7',category:'7인치 모니터'}),item({id:'M2',name:'티비로직 F-7HS',category:'7인치 모니터'})];
 c.readInventoryRiskSnapshot_=()=>({equipment,sets:[{name:'카메라 풀세트',components:[{name:'7인치 모니터',quantity:1,tracked:true}]}],schedules:[],sourceIssues:[]});
 c.preRegistrationStockRequest_=()=>({id:'RQ-261001-001',customer:'테스트 고객',rows:[row({name:'7인치 모니터',setName:'카메라 풀세트'})]});
 assert.equal(typeof c.getInventoryResolutionContext,'function');
 const result=c.getInventoryResolutionContext({requestId:'RQ-261001-001'});
 assert.equal(result.mode,'read_only');assert.equal(result.equipment.length,2);assert.equal(result.sets[0].components[0].name,'7인치 모니터');
 assert.equal(result.evaluation.uncertain[0].kind,'model_selection');assert.equal(result.decidedBy,'native_ai');
});


test('real GAS runFunction admits the fixed read context endpoint',()=>{
 const c=env();vm.runInContext(fs.readFileSync(path.join(__dirname,'../sheetAPI.js'),'utf8'),c);
 for(const name of ['getInventoryRiskMonitorStatus','setupInventoryRiskMonitor','flushInventoryRiskAlerts'])c[name]=()=>({});
 c.getInventoryResolutionContext=()=>({mode:'read_only',equipment:[],sets:[]});
 const result=c.runFunction('getInventoryResolutionContext',{args:'[]'});
 assert.equal(result.success,true);assert.equal(result.result.mode,'read_only');
});

test('included-component metadata is explicit and retains the packing row and existing note',()=>{
 const c=env();assert.equal(typeof c.inventoryRiskComponentIncluded_,'function');
 assert.equal(c.inventoryRiskComponentIncluded_('[재고:동봉품]\n기존 포장 주의'),true);
 assert.equal(c.inventoryRiskComponentIncluded_('일반 메모'),false);
 vm.runInContext(fs.readFileSync(path.join(__dirname,'../checkAvailability.js'),'utf8'),c);
 const rows=[['테스트 세트','전원 케이블',1,'[재고:동봉품]','','Y',10000]];
 const setSheet={getLastRow:()=>2,getLastColumn:()=>7,getRange:()=>({getValues:()=>rows})};
 c.SpreadsheetApp={getActiveSpreadsheet:()=>({getSheetByName:()=>setSheet})};
 const requestSheet={getRange:()=>({getValue:()=>'[세트]테스트 세트'})};
 assert.equal(c._isSetAccessoryManifestRow_(requestSheet,2,'전원 케이블'),true);
 assert.equal(c.getSetComponents('테스트 세트',setSheet).length,1);
 assert.equal(c._isSetAccessoryManifestRow_(requestSheet,2,'별도 조명'),false);
});


test('duplicate manifests use verified component identities once and expose conflicting quantities',()=>{
 const c=env();const equipment=[item({name:'소니 FX3',stock:1,aliases:['FX 3']})];
 const a={name:'카메라세트',components:[{name:'소니 FX3',quantity:1,tracked:true}]};
 const b={name:'카메라 세트',components:[{name:'FX 3',quantity:'1',tracked:true}]};
 const input={equipment,sets:[a,b],schedules:[row({name:'카메라세트',setName:'카메라세트'})]};
 assert.equal(report(c,input).alerts.filter(a=>a.kind==='shortage').length,0);
 b.components[0].quantity=2;assert.ok(report(c,input).alerts.some(a=>a.kind==='conflicting_set_definition'));
});

test('registered requests never advertise unevaluated hypothetical model choices',()=>{
 const c=env();c.readInventoryRiskSnapshot_=()=>({equipment:[item({name:'모델 A',stock:0,category:'모니터'})],sets:[],schedules:[row({name:'모니터',setName:''})],sourceIssues:[]});
 c.preRegistrationStockRequest_=()=>({id:'RQ-261001-001',registered:true,tradeId:'t1',rows:[row({name:'모니터',setName:''})]});
 const result=c.getInventoryResolutionContext({requestId:'RQ-261001-001'});assert.equal(result.modelChoices.length,0);
});

test('prospective AI plan gets period-specific model availability before an RQ exists',()=>{
 const c=env();c.readInventoryRiskSnapshot_=()=>({equipment:[item({id:'M1',name:'모델 A',stock:1,category:'모니터'}),item({id:'M2',name:'모델 B',stock:1,category:'모니터'})],sets:[{name:'카메라세트',components:[{name:'모니터',quantity:1,tracked:true}]}],schedules:[row({name:'모델 A',setName:''})],sourceIssues:[]});
 const result=c.getInventoryResolutionContext({plan:{items:[{name:'카메라세트',quantity:1}],...period}});
 assert.equal(result.mode,'read_only');assert.equal(result.request.preview,true);
 assert.equal(result.modelChoices[0].candidates[0].shortages.length,1);assert.equal(result.modelChoices[0].candidates[1].shortages.length,0);
});


test('original stock question names survive a narrower later reservation and remain outside lookback',()=>{
 const c=env(),values={};c.PropertiesService={getScriptProperties:()=>({getProperty:k=>values[k]||null,setProperty:(k,v)=>values[k]=v,getProperties:()=>values})};
 const receipt={id:'report',channel:'C1',ts:'1.001'};
 c.rememberInventoryStockQuestion_(receipt,{uncertain:[['catalog_stock_missing','장비 A'],['catalog_stock_missing','장비 B']]});
 c.rememberInventoryStockQuestion_(receipt,{uncertain:[['catalog_stock_missing','장비 A']]});
 values.preRegStock_v1_state_rq=JSON.stringify({lastReceipt:receipt,lastSignature:{uncertain:[['catalog_stock_missing','장비 A']]}});
 c.getInventoryResolutionContext=()=>({sets:[{name:'장비 A'},{name:'장비 B'}],equipment:[]});
 assert.deepEqual(Array.from(c.getInventoryStockQuestions().reports[0].names),['장비 A','장비 B']);
});
