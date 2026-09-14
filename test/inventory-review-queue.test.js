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