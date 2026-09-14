const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),crypto=require('node:crypto');
function env(){const c={Utilities:{formatDate:d=>d.toISOString(),computeDigest:(_a,s)=>Array.from(crypto.createHash('sha256').update(s).digest()),DigestAlgorithm:{SHA_256:'sha'},Charset:{UTF_8:'utf8'}}};vm.createContext(c);for(const f of ['inventorySupply.js','inventoryRisk.js','inventoryRiskMonitor.js','preRegistrationStockAlerts.js','inventoryStockIntake.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'..',f),'utf8'),c);return c;}
const equipment=[{id:'MON-012',name:'LVM-170A',category:'17인치 모니터',stock:4,maintenance:0,status:'정상',aliases:[]}];
const row={id:'s1',tradeId:'t1',customer:'고객',name:'TVLogic 17인치',setName:'시네마 세트',quantity:1,status:'대기',start:'2099-10-01T09:00:00+09:00',end:'2099-10-02T09:00:00+09:00'};
const snapshot=()=>({equipment:structuredClone(equipment),sets:[{name:'시네마 세트',components:[{name:row.name,quantity:1,tracked:true}]}],schedules:[row],sourceIssues:[]});
test('component-only unknowns enter AI investigation without a Slack report or owner reply',()=>{
 const c=env();c.readInventoryRiskSnapshot_=snapshot;c.inventoryReviewPendingRows_=()=>[];c.PropertiesService={getScriptProperties:()=>({getProperties:()=>({preRegStock_v1_channel:'C123'})})};
 const r=c.getInventoryStockQuestions();assert.equal(r.reports.length,0);assert.equal(r.investigations?.find(a=>a.name===row.name)?.kinds.includes('unknown_equipment'),true);assert.ok(r.sets.some(s=>s.name===row.name));assert.equal(r.equipment[0].name,'LVM-170A');
});
test('unreviewed identity is not a vague human alert, and real shortage remains visible',()=>{
 const c=env(),unknown={kind:'unknown_equipment',equipment:row.name,bookings:[row]};
 const r={requestId:'RQ-990101-001',customer:'고객',start:row.start,end:row.end,shortages:[],uncertain:[unknown]};
 assert.equal(c.preRegistrationStockText_(r),null);assert.equal(r.uncertain.length,1);
 const mixed={...r,shortages:[{equipment:'배터리',requested:2,available:1,shortage:1,start:row.start,end:row.end,bookings:[]}]};
 const text=c.preRegistrationStockText_(mixed);assert.match(text,/배터리/);assert.doesNotMatch(text,/TVLogic|AI 장비 연결 검토/);
});
test('durable identity mapping reuses physical stock without changing the source asset',()=>{
 const c=env(),eq=structuredClone(equipment),before=structuredClone(eq[0]);
 c.inventoryRiskEnrichLedger_(eq,[],[{source_name:row.name,equipment_id:'MON-012',equipment_name:'LVM-170A'}]);
 assert.ok(eq[0].aliases.includes(row.name));assert.equal(eq[0].stock,before.stock);assert.equal(eq[0].maintenance,before.maintenance);
 const r=c.buildInventoryRiskReport_({...snapshot(),equipment:eq},{now:'2099-09-14T00:00:00+09:00'});assert.equal(r.alerts.some(a=>a.kind==='unknown_equipment'),false);
});
test('packing rows are excluded before malformed dates can produce employee alerts',()=>{
 const c=env(),s=snapshot();s.sets[0].components[0].tracked=false;s.schedules=[{...row,start:'',end:''}];
 const r=c.buildInventoryRiskReport_(s);assert.equal(r.alerts.length,0);
});
test('data investigations and exact-capacity bookings stay off the stock shortage channel',()=>{
 const c=env(),alerts=['invalid_schedule','capacity_tight','overdue_return','set_component_missing','unknown_equipment'].map(kind=>({kind,key:kind,equipment:'packing row',bookings:[],start:null}));
 const r={alerts,conflictCount:0,riskCount:alerts.length};assert.equal(c.inventoryRiskSlackText_(r,{changed:alerts},'https://example.com'),null);
 const shortage={kind:'shortage',key:'real',equipment:'OSEE',stock:1,booked:2,shortage:1,start:row.start,bookings:[row]};
 const text=c.inventoryRiskSlackText_({...r,alerts:[...alerts,shortage],conflictCount:1},{changed:[...alerts,shortage]},'https://example.com');
 assert.match(text,/OSEE/);assert.doesNotMatch(text,/packing row|예약 날짜|위험 5/);
});

test('pre-registration dates and packing metadata do not become a vague shortage message',()=>{
 const c=env(),r={requestId:'RQ-990101-001',customer:'고객',start:row.start,end:row.end,shortages:[],uncertain:['invalid_schedule','invalid_quantity','set_component_missing'].map(kind=>({kind,equipment:'old packing data'}))};assert.equal(c.preRegistrationStockText_(r),null);
});
