const test = require("node:test");
const assert = require("node:assert/strict");
const ts = require("typescript");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const cache = new Map();
function load(name) {
  const filename = path.resolve(__dirname, "../lib/domain", name + ".ts");
  if (cache.has(filename)) return cache.get(filename);
  const module = { exports: {} };
  cache.set(filename, module.exports);
  const code = ts.transpileModule(fs.readFileSync(filename,"utf8"), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  vm.runInNewContext(code, {module,exports:module.exports,structuredClone,require: n => load(n.replace("./", "")),Date,Intl,Map,Set});
  return module.exports;
}
const { transitionPacking: step, packingGroups: groups, packingBlockers: blockers } = load("packing");
const { aggregateReturns, returnCompletionBlockers, setupProgress } = load("status");
const now = "2026-10-28T10:00:00.000Z";
function trade() { return {tradeId:"991231-997",contractStatus:"예약",setupDone:false,returnDone:false,returnCounts:{},equipments:[
  {scheduleId:"s1",name:"스몰HD용 SDI 연선",qty:1,setName:"BURANO",isComponent:true,checkoutState:"pending"},
  {scheduleId:"s2",name:"테라덱용 SDI 연선",qty:2,setName:"BURANO",isComponent:true,checkoutState:"pending"},
  {scheduleId:"s3",name:"스몰HD용 D탭",qty:1,setName:"BURANO",isComponent:true,checkoutState:"pending"},
  {scheduleId:"camera",name:"BURANO",qty:1,checkoutState:"pending"},
]}; }
function started() { const t=trade(); t.packing=step(t,{action:"start"},now); return t; }
function save(t, entries) { t.packing=step(t,{action:"save",entries,note:t.packing.note},now); }
function seal(t) { save(t,t.packing.entries.map(e=>({...e,checked:true}))); t.packing=step(t,{action:"seal"},now); }

test("용도별 동일 SDI는 3개로 합산하고 D탭은 별도로 센다",()=>{
  const t=started(); assert.equal(groups(t.packing).find(g=>g.id==="CBL-003").expected,3);
  assert.equal(aggregateReturns(t).filter(g=>g.name==="SDI 연선").length,1);
  assert.equal(aggregateReturns(t).length,3); // camera + SDI + Dtap; originals not counted twice
  assert.equal(setupProgress(t,"checkout").total,4);
});
test("replace removes old physical type, add retains it; 9V, 2pin and 7pin never offset",()=>{
  const t=started(); const rows=t.packing.entries.map(e=>e.id==="s3"?{...e,partId:"smallhd-9v"}:e);
  save(t, rows);
  save(t,[...t.packing.entries,{id:"add1",device:"테라덱",name:"ignored",partId:"teradek-2pin",qty:2,checked:false},{id:"add2",device:"뉴클-M",name:"ignored",partId:"nucleus-m-7pin",qty:1,checked:false}]);
  assert.equal(groups(t.packing).length,4);
  const replaced=t.packing.entries.map(e=>e.id==="s3"?{...e,name:"스몰HD용 더미 모델A",partId:"smallhd-dummy"}:e);
  save(t,replaced); assert.equal(groups(t.packing).some(g=>g.id==="smallhd-9v"),false);
  assert.equal(groups(t.packing).find(g=>g.id==="teradek-2pin").expected,2);
});
test("free text cannot create a part; registered IDs aggregate regardless of supplied display name",()=>{
  const t=started(); const base=t.packing.entries[2];
  assert.throws(()=>save(t,[...t.packing.entries,{...base,id:"copy1",partId:"unknown"}]),/등록/);
  save(t,[...t.packing.entries,{...base,id:"copy2",name:"직원 별칭"}]);
  assert.equal(groups(t.packing).find(g=>g.id===base.partId).expected,2);
});
test("exclude preserves source and requires recheck; cannot drop original rows",()=>{
  const t=started(); seal(t); t.packing=step(t,{action:"revise"},now);
  save(t,t.packing.entries.map(e=>e.id==="s1"?{...e,qty:0,checked:true}:e));
  assert.equal(t.packing.entries[0].checked,false);
  assert.equal(groups(t.packing).find(g=>g.id==="CBL-003").expected,2);
  assert.throws(()=>save(t,t.packing.entries.slice(1)),/제외/);
});
test("SDI or HDMI remains unresolved until selected; quantity change invalidates readiness",()=>{
  const t=trade();t.equipments[2].name="스몰HD 인디7용 SDI or HDMI";
  t.packing=step(t,{action:"start"},now);
  assert.throws(()=>seal(t),/실제 종류/);
  const {PACKING_PARTS}=load("packing");const hdmi=PACKING_PARTS.find(p=>p.name==="스몰HD 인디7용 HDMI");
  save(t,t.packing.entries.map(e=>e.id==="s3"?{...e,partId:hdmi.id}:e));seal(t);
  assert.equal(t.packing.phase,"sealed");
});
test("sealed snapshot survives master change; no rewrite after checkout or after undo",()=>{
  const t=started(); seal(t); const saved=JSON.stringify(t.packing.entries);
  t.equipments[0].qty=99; t.setupDone=true;
  assert.throws(()=>step(t,{action:"revise"},now),/변경할 수/);
  t.setupDone=false; t.packingDispatchedAt=now;
  assert.throws(()=>step(t,{action:"revise"},now),/변경할 수/);
  assert.equal(JSON.stringify(t.packing.entries),saved);
});
test("partial return persists; over/negative counts rejected; complete only exact physical totals",()=>{
  const t=started(); seal(t);
  t.packing=step(t,{action:"receive",partId:"CBL-003",count:{good:2,damaged:0,lost:0}},now);
  t.packing=JSON.parse(JSON.stringify(t.packing));
  assert.equal(blockers(t.packing).find(b=>b.name==="SDI 연선").missing,1);
  assert(returnCompletionBlockers(t).length>0);
  assert.throws(()=>step(t,{action:"receive",partId:"CBL-003",count:{good:4,damaged:0,lost:0}},now),/초과/);
  assert.throws(()=>step(t,{action:"receive",partId:"CBL-003",count:{good:-1,damaged:0,lost:0}},now),/초과/);
  for(const g of groups(t.packing)) t.packing=step(t,{action:"receive",partId:g.id,count:{good:g.expected,damaged:0,lost:0}},now);
  assert.equal(blockers(t.packing).length,0);
});
test("loss requires a reason; old checked-out contracts cannot silently migrate",()=>{
  const t=started();seal(t);
  assert.throws(()=>step(t,{action:"receive",partId:"CBL-003",count:{good:2,damaged:0,lost:1}},now),/사유/);
  const old=trade();old.setupDone=true;assert.throws(()=>step(old,{action:"start"},now),/기존 검수/);
});
test("replacing a shared registered part preserves the other device",()=>{
  const t=started(); const base=t.packing.entries[2];
  save(t,[...t.packing.entries,{...base,id:"copy"}]);
  save(t,t.packing.entries.map(e=>e.id===base.id?{...e,name:"스몰HD용 더미 모델B",partId:"smallhd-dummy"}:e));
  const a=t.packing.entries.find(e=>e.id===base.id), b=t.packing.entries.find(e=>e.id==="copy");
  assert.notEqual(a.partId,b.partId);
  assert.equal(groups(t.packing).find(g=>g.id===b.partId).name,base.name);
});
test("legacy completed cards without packing keep their original completion policy",()=>{
  const t=trade();t.returnDone=true;t.equipments[0].takenQty=1;
  assert.equal(returnCompletionBlockers(t).length,0);
});
test("booking refresh preserves manual additions and cannot duplicate a removed/readded source",()=>{
  const t=started(); save(t,[...t.packing.entries,{id:"extra",device:"여분",name:"SDI 연선",partId:"CBL-003",qty:1,checked:false}]);
  t.equipments[0].qty=2;
  t.packing=step(t,{action:"refresh"},now);
  assert.equal(t.packing.entries.find(e=>e.id==="s1").qty,2);
  assert.equal(t.packing.entries.find(e=>e.id==="extra").qty,1);
  t.equipments[0].checkoutState="excluded";
  t.packing=step(t,{action:"refresh"},now);
  assert.equal(t.packing.entries.find(e=>e.id==="s1").qty,0);
  t.equipments[0].checkoutState="pending";
  t.packing=step(t,{action:"refresh"},now);
  assert.equal(t.packing.entries.filter(e=>e.id==="s1").length,1);
  seal(t);
});

test("excluded unchecked accessory does not block sealing; included unchecked accessory still blocks",()=>{
  const t=started();
  save(t,t.packing.entries.map(e=>e.id==="s1"?{...e,qty:0,checked:false}:{...e,checked:true}));
  assert.equal(t.packing.entries.find(e=>e.id==="s1").checked,false);
  const included=t.packing.entries.find(e=>e.id!=="s1");
  included.checked=false;
  assert.throws(()=>step(t,{action:"seal"},now),/실제 종류/);
  included.checked=true;
  t.packing=step(t,{action:"seal"},now);
  assert.equal(t.packing.phase,"sealed");
  assert.equal(t.packing.entries.find(e=>e.id==="s1").qty,0);
  assert.equal(groups(t.packing).find(g=>g.id==="CBL-003").expected,2);
});

test("missing accessories can be entered explicitly and survive refresh, sealing and return counts",()=>{
  const t=started();
  const custom={id:"field-extra",device:"BURANO",ownerId:"camera",name:"현장용 특수 충전기",partId:"custom:field-extra",custom:true,qty:2,checked:false};
  save(t,[...t.packing.entries,custom]);
  t.packing=JSON.parse(JSON.stringify(t.packing));
  t.packing=step(t,{action:"refresh"},now);
  assert.equal(t.packing.entries.find(e=>e.id===custom.id).custom,true);
  seal(t);
  assert.equal(groups(t.packing).find(g=>g.id===custom.partId).expected,2);
  t.packing=step(t,{action:"receive",partId:custom.partId,count:{good:1,damaged:0,lost:0}},now);
  assert.equal(blockers(t.packing).find(g=>g.partId===custom.partId || g.id===custom.partId || g.name===custom.name).missing,1);
});
test("custom names never merge by spelling; known registered names resolve to canonical identity",()=>{
  const t=started();
  const row={id:"custom-one",device:"BURANO",name:"현장 특수선",partId:"custom:custom-one",custom:true,qty:1,checked:false};
  save(t,[...t.packing.entries,row,{...row,id:"custom-two",partId:"custom:custom-two"}]);
  assert.equal(groups(t.packing).filter(g=>g.name===row.name).length,2);
  save(t,[...t.packing.entries,{...row,id:"known",partId:"custom:known",name:"소니 캠 AX-700용 배터리 충전기"}]);
  const added=t.packing.entries.find(e=>e.id==="known");
  assert.equal(added.custom,undefined);assert.equal(added.unresolved,false);assert(!added.partId.startsWith("custom:"));
  assert.throws(()=>save(t,[...t.packing.entries,{...row,id:"bad",partId:row.partId}]),/ID/);
  assert.throws(()=>save(t,[...t.packing.entries,{...row,id:"blank",partId:"custom:blank",name:"  "}]),/이름/);
  assert.throws(()=>save(t,[...t.packing.entries,{...row,id:"choice",partId:"custom:choice",name:"SDI or HDMI"}]),/한 종류/);
});
