const test=require('node:test'), assert=require('node:assert/strict');
const ts=require('typescript'), fs=require('node:fs'), vm=require('node:vm'),path=require('node:path');
const cache=new Map();function load(n){const f=path.resolve(__dirname,'../lib/domain',n+'.ts');if(cache.has(f))return cache.get(f);const m={exports:{}};cache.set(f,m.exports);vm.runInNewContext(ts.transpileModule(fs.readFileSync(f,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:m,exports:m.exports,structuredClone,require:n=>load(n.replace('./','')),Date,Intl,Map,Set});return m.exports;}
const {transitionPacking:step,packingGroups:groups}=load('packing');
const now='2026-10-28T12:00:00Z';
function fixture(){return {tradeId:'demo',contractStatus:'예약',setupDone:false,returnDone:false,equipments:[
 {scheduleId:'fx',name:'소니 FX6 풀세트',qty:1,setName:'소니 FX6 풀세트',isSetHeader:true,checkoutState:'pending'},
 {scheduleId:'monitor',name:'7인치 모니터',qty:1,setName:'소니 FX6 풀세트',isComponent:true,checkoutState:'taken'},
 {scheduleId:'lvm',name:'LVM-170A',qty:1,setName:'소니 FX6 풀세트',isComponent:true,checkoutState:'taken'},
 {scheduleId:'bundle',name:'SDI 롱라인, SDI 라인, 노가암',qty:1,setName:'소니 FX6 풀세트',isComponent:true,checkoutState:'taken'},
 {scheduleId:'pyro',name:'파이로 7',qty:1,setName:'파이로 7',isSetHeader:true,checkoutState:'taken'},
 {scheduleId:'pyro-bundle',name:'D탭*1 / SDI or HDMI*1 / 안테나*2',qty:1,setName:'파이로 7',isComponent:true,checkoutState:'taken'}]};}
test('production legacy bundles expand into individual quantities, preserve parent and source',()=>{const t=fixture();t.packing=step(t,{action:'start'},now);assert.equal(t.packing.entries.length,6);assert.equal(t.packing.entries.reduce((n,e)=>n+e.qty,0),7);assert.equal(t.packing.entries.find(e=>e.name==='노가암').ownerId,'monitor');assert.equal(t.packing.entries.find(e=>e.name==='소니 FX6 풀세트용 SDI 라인').ownerId,'monitor');assert.equal(t.packing.entries.find(e=>e.name==='소니 FX6 풀세트용 SDI 롱라인').ownerId,'lvm');assert.equal(t.packing.entries.filter(e=>e.ownerId==='pyro').length,3);assert(!t.packing.entries.some(e=>e.name.includes('*')||e.name.includes(',')));});
test('real monitor model supplies power, inherits existing noga only once, catalog choice replaces it',()=>{const t=fixture();t.packing=step(t,{action:'start'},now);t.packing=step(t,{action:'model',ownerId:'monitor',model:'스몰HD 인디7'},now);assert(t.packing.entries.some(e=>e.ownerId==='monitor'&&e.partId==='smallhd-9v'));assert.equal(t.packing.entries.filter(e=>e.name==='노가암').reduce((n,e)=>n+e.qty,0),1);const rows=t.packing.entries.map(e=>e.partId==='smallhd-9v'?{...e,partId:'smallhd-dummy',name:'직원마다 다른 이름'}:e);t.packing=step(t,{action:'save',entries:rows,note:''},now);assert(t.packing.entries.some(e=>e.name==='스몰HD용 D탭 더미'));assert.throws(()=>step(t,{action:'save',entries:[...rows,{id:'free',ownerId:'monitor',device:'스몰HD 인디7',name:'아무 더미',partId:'free',qty:1,checked:false}],note:''},now),/등록/);});
test('legacy v1 draft repairs without changing schedule, sealed historical facts are not rewritten',()=>{const t=fixture(),before=JSON.stringify(t.equipments);t.packing={version:1,phase:'draft',sources:[{id:'bundle',name:t.equipments[3].name,qty:1}],entries:[{id:'bundle',sourceId:'bundle',device:'소니 FX6 풀세트',name:t.equipments[3].name,partId:'private:bundle',qty:1,checked:false}],counts:{},note:'보존'};t.packing=step(t,{action:'refresh'},now);assert.equal(t.packing.schemaVersion,2);assert.equal(t.packing.entries.length,6);assert.equal(t.packing.note,'보존');assert.equal(JSON.stringify(t.equipments),before);});
test('standard dummy is shared across devices, not by free text, distinct power specs do not offset',()=>{const t=fixture();t.packing=step(t,{action:'start'},now);t.packing=step(t,{action:'model',ownerId:'monitor',model:'스몰HD 인디7'},now);const power=t.packing.entries.find(e=>e.partId==='smallhd-9v');const rows=t.packing.entries.map(e=>e.id===power.id?{...e,partId:'smallhd-dummy'}:e);rows.push({...power,id:'dummy-other',ownerId:'pyro',device:'파이로 7',partId:'smallhd-dummy',qty:2});t.packing=step(t,{action:'save',entries:rows,note:''},now);assert.equal(groups(t.packing).find(g=>g.id==='smallhd-dummy').expected,3);assert(!groups(t.packing).some(g=>g.id==='smallhd-9v'));t.packing=step(t,{action:'refresh'},now);assert.equal(groups(t.packing).find(g=>g.id==='smallhd-dummy').expected,3);assert.equal(t.packing.entries.filter(e=>e.id===power.id).length,1);});
test('selected monitor snapshot follows quantity changes only after explicit refresh',()=>{const t=fixture();t.packing=step(t,{action:'start'},now);t.packing=step(t,{action:'model',ownerId:'monitor',model:'스몰HD 인디7'},now);t.equipments.find(e=>e.scheduleId==='monitor').qty=2;assert.throws(()=>step(t,{action:'seal'},now),/예약 구성품이 변경/);});
test('ambiguous bundle without confirmed quantities cannot seal as one item',()=>{const t=fixture();t.equipments[3].name='새로운 라인, 새로운 암';t.packing=step(t,{action:'start'},now);const unresolved=t.packing.entries.filter(e=>e.sourceId==='bundle');assert(unresolved.every(e=>e.unresolved));assert(unresolved.every(e=>!groups(t.packing).some(g=>g.id===e.partId)));assert.throws(()=>step(t,{action:'save',entries:t.packing.entries.map(e=>({...e,checked:true})),note:''},now),/실제 종류/);});
test('model selection cannot duplicate the already packed unassigned video cable',()=>{const t=fixture();t.packing=step(t,{action:'start'},now);t.packing.entries.find(e=>e.name==='소니 FX6 풀세트용 SDI 라인').ownerId='fx';const before=t.packing.entries.filter(e=>/SDI|HDMI/.test(e.name)).reduce((n,e)=>n+e.qty,0);t.packing=step(t,{action:'model',ownerId:'monitor',model:'스몰HD 인디7'},now);assert.equal(t.packing.entries.filter(e=>/SDI|HDMI/.test(e.name)).reduce((n,e)=>n+e.qty,0),before);assert.throws(()=>step(t,{action:'seal'},now),/영상선/);const line=t.packing.entries.find(e=>e.name==='소니 FX6 풀세트용 SDI 라인');t.packing=step(t,{action:'save',entries:t.packing.entries.map(e=>e.id===line.id?{...e,ownerId:'monitor'}:e),note:''},now);assert.equal(t.packing.entries.filter(e=>e.ownerId==='monitor'&&/SDI|HDMI/.test(e.name)).length,1);});

test('live INDIE7 spelling and actual model correction resolve the same power template',()=>{for(const actual of [false,true]){const t=fixture(),monitor=t.equipments.find(e=>e.scheduleId==='monitor');if(actual)monitor.actualName='스몰HD INDIE7';else monitor.name='스몰HD INDIE7';t.packing=step(t,{action:'start'},now);assert.equal(t.packing.entries.filter(e=>e.ownerId==='monitor'&&e.partId==='smallhd-9v').length,1);assert.equal(t.packing.entries.filter(e=>e.name==='노가암').length,1);assert.equal(t.packing.entries.find(e=>e.name==='소니 FX6 풀세트용 SDI 라인').ownerId,'monitor');assert.equal(t.packing.sources.find(e=>e.id==='monitor').name,'스몰HD INDIE7');if(actual){monitor.actualName='포트키 BM7';assert.throws(()=>step(t,{action:'seal'},now),/예약 구성품이 변경/);}}});

test('existing explicit SDI choice in historic bundle resolves registered device part',()=>{const t=fixture();t.equipments.find(e=>e.scheduleId==='pyro-bundle').name='D탭*1 / SDI*1 / 안테나*2';t.packing=step(t,{action:'start'},now);const line=t.packing.entries.find(e=>e.sourceId==='pyro-bundle'&&/SDI/.test(e.name));assert.equal(line.name,'파이로 7용 SDI');assert.equal(line.unresolved,false);assert.equal(line.qty,1);});

test('legacy camera bundle uses number of sets, never the old aggregate quantity',()=>{for(const [set,qty] of [['소니 FX9 풀세트',1],['소니 FX9 풀세트',2],['PYXIS 6K 시네마 풀세트(EF or PL / BRAW·풀프레임)',1]]){const t=fixture();t.equipments=t.equipments.slice(0,4).map(e=>({...e,setName:set,name:e.scheduleId==='fx'?set:e.name}));t.equipments[0].qty=qty;t.equipments[3].qty=4*qty;t.packing=step(t,{action:'start'},now);assert.equal(t.packing.entries.length,3);assert(t.packing.entries.every(e=>e.qty===qty&&!e.unresolved));assert.equal(t.packing.entries.find(e=>/SDI 롱라인/.test(e.name)).ownerId,'lvm');assert.equal(t.packing.entries.find(e=>/SDI 라인$/.test(e.name)).ownerId,'monitor');}});
test('camera master has one FX3 mattebox and one FX9 LVM per set',()=>{const {templateFor}=load('packingCatalog');assert.equal(templateFor('소니 FX3 풀세트').find(e=>e.name==='매트박스').qty,1);assert.equal(templateFor('소니 FX9 풀세트').find(e=>e.name==='LVM-170A').qty,1);});

test('refresh repairs untouched fourfold draft while preserving already corrected noga',()=>{const t=fixture();t.equipments=t.equipments.slice(0,4);t.equipments[3].qty=4;t.packing=step(t,{action:'start'},now);t.packing.entries.forEach(e=>{if(e.name==='노가암')e.checked=true;else e.qty=4;});t.packing=step(t,{action:'refresh'},now);assert(t.packing.entries.every(e=>e.qty===1));assert.equal(t.packing.entries.find(e=>e.name==='노가암').checked,true);});

test('BURANO basic SDI is one while confirmed full-set wireless and spare lines remain two each',()=>{const {templateFor}=load('packingCatalog');assert.equal(templateFor('소니 BURANO 베이직세트').find(e=>e.name==='SDI 연선').qty,1);for(const name of ['테라덱용 SDI 연선','여분 SDI 연선'])assert.equal(templateFor('소니 BURANO 풀세트').find(e=>e.name===name).qty,2);});
function axFixture(){return {tradeId:'ax-demo',contractStatus:'예약',setupDone:false,returnDone:false,equipments:[{scheduleId:'ax',name:'소니 캠 AX-700',qty:1,setName:'소니 캠 AX-700',isSetHeader:true,checkoutState:'taken'},{scheduleId:'ax-parts',name:'메모리*1 / 배터리*2 / 앞캡 / 후드',qty:1,setName:'소니 캠 AX-700',isComponent:true,checkoutState:'taken'}]};}
test('AX700 legacy memory battery cap bundle becomes four source parts with no default duplicates',()=>{const t=axFixture();t.packing=step(t,{action:'start'},now);assert.equal(t.packing.entries.length,4);assert(t.packing.entries.every(e=>e.sourceId==='ax-parts'&&e.ownerId==='ax'));assert(load('packing').packingSourceIds(t.packing).has('ax-parts'));assert.equal(groups(t.packing).reduce((n,g)=>n+g.expected,0),5);});
test('refresh absorbs old defaults into newly recognized source bundle preserving checks and manual quantity',()=>{const t=axFixture();t.packing=step(t,{action:'start'},now);t.packing.entries=t.packing.entries.map((e,i)=>({...e,id:`default:ax:${i}`,sourceId:undefined,modelDefault:true,checked:true,qty:e.name.includes('배터리')?3:e.qty}));t.packing.sources=t.equipments.map(e=>({id:e.scheduleId,name:e.name,qty:e.qty,device:true}));t.packing=step(t,{action:'refresh'},now);assert.equal(t.packing.entries.length,4);assert(t.packing.entries.every(e=>e.sourceId==='ax-parts'&&e.checked));assert.equal(t.packing.entries.find(e=>e.name.includes('배터리')).qty,3);t.packing=step(t,{action:'refresh'},now);assert.equal(t.packing.entries.length,4);assert.equal(groups(t.packing).reduce((n,g)=>n+g.expected,0),6);});
test('registered bare charger is folded into owner instead of also adding template charger',()=>{const t=axFixture();t.equipments=[{...t.equipments[0],name:'아마란 PT4C 2KIT',setName:'아마란 PT4C 2KIT'},{...t.equipments[1],name:'충전기*2',setName:'아마란 PT4C 2KIT'}];t.packing=step(t,{action:'start'},now);assert.equal(t.packing.entries.filter(e=>e.name.includes('충전기')).length,1);assert.equal(t.packing.entries.find(e=>e.name.includes('충전기')).sourceId,'ax-parts');assert.equal(t.packing.entries.find(e=>e.name.includes('충전기')).qty,2);});
test('refresh keeps checks and replacements on unchanged actual-device defaults',()=>{const t=axFixture();t.equipments.push({scheduleId:'tv',name:'티비로직 F-7HS',qty:1,setName:'티비로직 F-7HS',isSetHeader:true,checkoutState:'taken'});t.packing=step(t,{action:'start'},now);const power=t.packing.entries.find(e=>e.ownerId==='tv'&&e.name.includes('D탭'));power.checked=true;power.qty=2;t.packing=step(t,{action:'refresh'},now);const saved=t.packing.entries.find(e=>e.id===power.id);assert.equal(saved.qty,2);assert.equal(saved.checked,true);});

function lensAudioFixture(){return {tradeId:'lens-audio',contractStatus:'예약',setupDone:false,returnDone:false,equipments:[
 {scheduleId:'cooke',name:'CooKe SP3(25/32/50/75/100)',qty:1,setName:'CooKe SP3(25/32/50/75/100)',isSetHeader:true,checkoutState:'taken'},
 {scheduleId:'rings',name:'58 업링 (3) 77 업링 (1)',qty:1,setName:'CooKe SP3(25/32/50/75/100)',isComponent:true,checkoutState:'pending'},
 {scheduleId:'uwp',name:'소니 UWP-D21',qty:3,setName:'소니 UWP-D21',isSetHeader:true,checkoutState:'pending'},
 {scheduleId:'uwp-parts',name:'핀마이크(솜, 클립) / 3.5 라인*1 / XLR 라인*1',qty:3,setName:'소니 UWP-D21',isComponent:true,checkoutState:'pending'}]};}
test('Cooke explicit ring quantities and UWP parenthesized description produce exactly five registered rows',()=>{
 const t=lensAudioFixture();t.packing=step(t,{action:'start'},now);
 assert.equal(t.packing.entries.length,5);assert(t.packing.entries.every(e=>!e.unresolved));
 assert.deepEqual(Array.from(t.packing.entries.filter(e=>e.ownerId==='cooke'),e=>e.qty),[3,1]);
 assert.equal(t.packing.entries.filter(e=>e.ownerId==='uwp').length,3);
 assert(t.packing.entries.filter(e=>e.ownerId==='uwp').every(e=>e.qty===3));
 assert(load('packing').packingSourceIds(t.packing).has('rings'));
});
test('refresh repairs stored split UWP fragments and absorbs checked Cooke defaults without losing checks',()=>{
 const t=lensAudioFixture();t.packing=step(t,{action:'start'},now);
 const entries=t.packing.entries;
 const cooke=entries.filter(e=>e.ownerId==='cooke').map((e,i)=>({...e,id:`default:cooke:${i}`,sourceId:undefined,modelDefault:true,checked:true}));
 const audio=entries.filter(e=>e.ownerId==='uwp');
 const mic=audio.find(e=>e.name.includes('핀마이크'));
 t.packing.entries=[...cooke,
  {...mic,id:'uwp-parts:0',name:'핀마이크(솜',partId:'unresolved:uwp-parts:0',unresolved:true},
  {...mic,id:'uwp-parts:1',name:'클립)',partId:'unresolved:uwp-parts:1',unresolved:true},
  ...audio.filter(e=>!e.name.includes('핀마이크')).map((e,i)=>({...e,id:`uwp-parts:${i+2}`,checked:true})),
  {...mic,id:'default:uwp:0',sourceId:undefined,modelDefault:true}];
 t.packing.sources=t.packing.sources.map(e=>e.id==='rings'?{...e,device:true}:e);
 t.packing=step(t,{action:'refresh'},now);
 const active=t.packing.entries.filter(e=>e.qty>0);
 assert.equal(active.length,5);assert(active.every(e=>!e.unresolved));
 assert(active.filter(e=>e.ownerId==='cooke').every(e=>e.checked));
 assert(active.filter(e=>/ライン/.test(e.name)).every(e=>e.checked));
 const saved=JSON.stringify(t.packing.entries);t.packing=step(t,{action:'refresh'},now);assert.equal(JSON.stringify(t.packing.entries),saved);
});

function fx3M1Fixture(){return {tradeId:'demo',contractStatus:'예약',setupDone:false,returnDone:false,equipments:[
  {scheduleId:'kit',name:'소니 FX3 풀세트',qty:1,setName:'소니 FX3 풀세트',isSetHeader:true,checkoutState:'pending'},
  {scheduleId:'m1',name:'마스 M1',qty:1,setName:'소니 FX3 풀세트',isComponent:true,checkoutState:'taken'},
  {scheduleId:'arm',name:'매직암',qty:1,setName:'소니 FX3 풀세트',isComponent:true,checkoutState:'taken'},
  {scheduleId:'video',name:'소니 FX3 풀세트용 HDMI 라인',qty:1,setName:'소니 FX3 풀세트',isComponent:true,checkoutState:'pending'},
  {scheduleId:'power',name:'소니 FX3 풀세트용 970더미',qty:1,setName:'소니 FX3 풀세트',isComponent:true,checkoutState:'pending'}]};}
test('a monitor inside an FX3 kit consumes the existing kit power, video and arm exactly once',()=>{
  const t=fx3M1Fixture();t.packing=step(t,{action:'start'},now);
  assert.equal(t.packing.entries.length,2);assert(t.packing.entries.every(e=>e.sourceId&&e.ownerId==='m1'));
  assert.equal(groups(t.packing).reduce((n,g)=>n+g.expected,0),2);
  assert(!load('packing').packingSourceIds(t.packing).has('arm'),'the existing magic arm remains its original physical row');
});
test('standalone M1, another kit, and extra accessories are not merged by similar names',()=>{
  const t=fx3M1Fixture();t.equipments.push({scheduleId:'extra',name:'마스 M1',qty:1,setName:'마스 M1',isSetHeader:true,checkoutState:'taken'});
  t.packing=step(t,{action:'start'},now);
  assert.equal(t.packing.entries.filter(e=>e.ownerId==='extra').length,3);
  assert.equal(t.packing.entries.filter(e=>e.ownerId==='m1').length,2);
});
test('excluded parent accessories do not come back as M1 defaults',()=>{
  const t=fx3M1Fixture();t.equipments.filter(e=>['arm','power','video'].includes(e.scheduleId)).forEach(e=>e.checkoutState='excluded');
  t.packing=step(t,{action:'start'},now);assert.equal(t.packing.entries.length,0);
});
function legacyM1(t){
 t.packing=step(t,{action:'start'},now);
 const {registeredPart}=load('packingCatalog');
 for(const [index,name] of ['마스 M1용 970더미','마스 M1용 HDMI','마스 M1용 숏암'].entries()){
  const part=registeredPart(name);t.packing.entries.push({id:`old:${index}`,ownerId:'m1',device:'마스 M1',name,partId:part.id,qty:1,checked:true,modelDefault:true});
 }
 return t;
}
test('legacy draft repair retires only generated duplicates and is idempotent',()=>{
 const t=legacyM1(fx3M1Fixture());t.packing.entries.forEach(e=>e.checked=true);t.packing.note='인계 보존';
 assert.equal(load('packing').packingPreparationCommand(t).action,'refresh');
 t.packing=step(t,{action:'refresh'},now);assert.equal(t.packing.entries.filter(e=>e.qty>0).length,2);
 assert(t.packing.entries.filter(e=>e.sourceId).every(e=>e.checked));assert.equal(t.packing.note,'인계 보존');
 assert.equal(load('packing').packingPreparationCommand(t),undefined);
 const rows=JSON.stringify(t.packing.entries);t.packing=step(t,{action:'refresh'},now);assert.equal(JSON.stringify(t.packing.entries),rows);
});
test('repair preserves manually increased, replaced, extra, and already returned accessory facts',()=>{
 const t=legacyM1(fx3M1Fixture());t.packing.entries.find(e=>e.id==='old:0').qty=2;
 const hdmi=t.packing.entries.find(e=>e.id==='old:1');t.packing.counts[hdmi.partId]={good:1,damaged:0,lost:0};
 const arm=t.packing.entries.find(e=>e.id==='old:2');arm.custom=true;
 assert.equal(load('packing').packingDuplicateDefaults(t).length,0);
 t.setupDone=true;assert.equal(load('packing').packingPreparationCommand(t),undefined);
});
test('M1 replacement inside the camera kit does not add the same accessories again',()=>{
 const t=fx3M1Fixture();t.equipments[1].name='5인치 모니터';t.packing=step(t,{action:'start'},now);
 t.equipments[1].name='마스 M1';t.packing=step(t,{action:'reconcile',ownerId:'m1',name:'마스 M1'},now);
 assert.equal(t.packing.entries.filter(e=>e.modelDefault&&e.qty>0).length,0);
 assert.equal(t.packing.entries.filter(e=>e.sourceId&&e.qty>0).length,2);
});
test('two monitors retain only the uncovered additional accessories, not a second full allowance',()=>{
 const t=fx3M1Fixture();t.equipments[1].qty=2;t.packing=step(t,{action:'start'},now);
 for(const name of ['마스 M1용 970더미','마스 M1용 숏암','마스 M1용 SDI or HDMI']) assert.equal(t.packing.entries.find(e=>e.name===name).qty,1);
});

function selectedMonitorFixture(){
 const t=fixture();t.packing=step(t,{action:'start'},now);
 t.packing=step(t,{action:'model',ownerId:'monitor',model:'포트키 BM7'},now);
 return t;
}
test('explicit replacement name overrides a previously selected generic monitor immediately',()=>{
 const t=selectedMonitorFixture(),owner=t.equipments.find(e=>e.scheduleId==='monitor');
 assert.equal(load('packing').packingDeviceName(t,owner),'포트키 BM7');
 owner.name='파이로 7';assert.equal(load('packing').packingDeviceName(t,owner),'파이로 7');
 t.packing=step(t,{action:'reconcile',ownerId:'monitor',name:'파이로 7'},now);
 assert.equal(t.packing.deviceModels.monitor,undefined);
 assert(t.packing.entries.some(e=>e.ownerId==='monitor'&&e.qty>0&&e.name==='파이로 7용 안테나'));
 t.packing=step(t,{action:'refresh'},now);
 assert(!t.packing.entries.some(e=>e.ownerId==='monitor'&&e.qty>0&&e.name.includes('BM7')));
 assert(t.packing.entries.filter(e=>e.ownerId==='monitor'&&e.qty>0).every(e=>e.device==='파이로 7'));
});
test('direct refresh discards stale model overrides but retains valid generic selections',()=>{
 const t=selectedMonitorFixture();t.equipments.find(e=>e.scheduleId==='monitor').name='파이로 7';
 t.packing=step(t,{action:'refresh'},now);assert.equal(t.packing.deviceModels.monitor,undefined);
 assert(!t.packing.entries.some(e=>e.ownerId==='monitor'&&e.qty>0&&e.name.includes('BM7')));
 const generic=selectedMonitorFixture();generic.equipments.find(e=>e.scheduleId==='monitor').qty=2;
 generic.packing=step(generic,{action:'reconcile',ownerId:'monitor',name:'7인치 모니터'},now);
 assert.equal(generic.packing.deviceModels.monitor,'포트키 BM7');
 assert.equal(generic.packing.entries.find(e=>e.name==='포트키 BM7용 D탭'&&e.qty>0).qty,2);
});
test('already reconciled drafts with a stale model self-repair without resetting replacement checks',()=>{
 const t=selectedMonitorFixture();t.equipments.find(e=>e.scheduleId==='monitor').name='파이로 7';
 t.packing=step(t,{action:'reconcile',ownerId:'monitor',name:'파이로 7'},now);
 t.packing.deviceModels.monitor='포트키 BM7';
 const power=t.packing.entries.find(e=>e.name==='파이로 7용 D탭');power.checked=true;power.qty=2;
 assert.equal(load('packing').packingPreparationCommand(t)?.action,'refresh');
 t.packing=step(t,{action:'refresh'},now);
 assert.equal(t.packing.deviceModels.monitor,undefined);
 assert.equal(t.packing.entries.find(e=>e.id===power.id).qty,2);
 assert.equal(t.packing.entries.find(e=>e.id===power.id).checked,true);
 assert(!t.packing.entries.some(e=>e.qty>0&&e.ownerId==='monitor'&&e.name.includes('BM7')));
 assert.equal(load('packing').packingPreparationCommand(t),undefined);
});
