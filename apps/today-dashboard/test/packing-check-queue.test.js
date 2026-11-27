const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),ts=require('typescript');
const cache=new Map();function load(file){if(cache.has(file))return cache.get(file);const m={exports:{}};cache.set(file,m.exports);const source=path.basename(file)==='packingCheckQueue.ts'&&process.env.PACKING_QUEUE_SOURCE?process.env.PACKING_QUEUE_SOURCE:file;vm.runInNewContext(ts.transpileModule(fs.readFileSync(source,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{module:m,exports:m.exports,require:n=>load(path.resolve(path.dirname(file),n+'.ts')),structuredClone,Date,Intl,Map,Set,Promise});return m.exports;}
const {createPackingCheckQueue}=load(path.resolve(__dirname,'../lib/data/packingCheckQueue.ts'));
const {transitionPacking}=load(path.resolve(__dirname,'../lib/domain/packing.ts'));
function harness(){let trade={tradeId:'261019-009',contractStatus:'예약',setupDone:false,returnDone:false,equipments:[{scheduleId:'line',name:'스몰HD용 SDI 연선',qty:1,setName:'BURANO',isComponent:true,checkoutState:'pending'}]};trade.packing=transitionPacking(trade,{action:'start'},'2026-10-28T12:00:00Z');trade.packing.entries.push({...trade.packing.entries[0],id:'second'});const requests=[],finished=[];let fresh;
const q=createPackingCheckQueue({read:()=>trade,show:(_,packing)=>{trade={...trade,packing};},start:()=>error=>finished.push(error),recover:async()=>{if(fresh)trade=fresh;},persist:(id,version,command)=>new Promise((resolve,reject)=>requests.push({version,command,resolve,reject}))});
return {q,requests,finished,get trade(){return trade;},set fresh(t){fresh=t;},confirm(i){const r=requests[i];r.resolve(transitionPacking({...trade,packing:{...trade.packing,version:r.version}},r.command,'2026-10-28T12:01:00Z'));}};}
const tick=()=>new Promise(r=>setImmediate(r));
test('a stale local dispatch flag reloads the same draft and checks the same entry once', async()=>{
  const h=harness(),id=h.trade.packing.entries[0].id;
  h.fresh=structuredClone(h.trade);h.trade.setupDone=true;
  const saving=h.q.check('t',id,true);
  await tick();assert.equal(h.requests.length,1);h.confirm(0);
  await saving;assert.equal(h.trade.packing.entries[0].checked,true);
});
test('refreshing a locally locked draft never checks a dispatched or replaced entry', async()=>{
  for(const different of ['dispatched','version','entry']){
    const h=harness(),id=h.trade.packing.entries[0].id, fresh=structuredClone(h.trade);
    h.trade.setupDone=true;
    if(different==='dispatched')fresh.setupDone=true;
    if(different==='version')fresh.packing.version++;
    if(different==='entry')fresh.packing.entries[0].partId='different';
    h.fresh=fresh;
    await assert.rejects(h.q.check('t',id,true));
    assert.equal(h.requests.length,0,different);
  }
});
test('rapid checks display immediately while delayed saves serialize; older response preserves later intent',async()=>{const h=harness(),id=h.trade.packing.entries[0].id,version=h.trade.packing.version;
const a=h.q.check('t',id,true),b=h.q.check('t','second',true),c=h.q.check('t',id,false);
assert.equal(h.requests.length,1);assert.equal(h.trade.packing.entries[0].checked,false);assert.equal(h.trade.packing.entries[1].checked,true);
h.confirm(0);await tick();assert.equal(h.requests.length,2);assert.equal(h.trade.packing.entries[0].checked,false);assert.equal(h.trade.packing.entries[1].checked,true);assert.equal(h.requests[1].version,version+1);
h.confirm(1);await Promise.all([a,b,c]);await tick();assert.equal(h.trade.packing.version,version+2);assert.equal(h.q.pending('t'),false);});
test('failure rolls back all unconfirmed clicks but retains previous confirmed checks',async()=>{const h=harness(),id=h.trade.packing.entries[0].id;const a=h.q.check('t',id,true),b=h.q.check('t','second',true);const rejected=assert.rejects(b,/offline/);h.confirm(0);await a;await tick();h.requests[1].reject(new Error('offline'));await rejected;assert.equal(h.trade.packing.entries[0].checked,true);assert.equal(h.trade.packing.entries[1].checked,false);assert.ok(h.finished[0]);});
test('conflict cancels pending work and loads authoritative state without overwriting other staff changes',async()=>{const h=harness();const fresh=structuredClone(h.trade);fresh.packing.version=99;fresh.packing.note='다른 직원 수정';h.fresh=fresh;const a=h.q.check('t',h.trade.packing.entries[0].id,true),b=h.q.check('t','second',true);const done=Promise.allSettled([a,b]);h.requests[0].reject(new Error('conflict'));assert.ok((await done).every(r=>r.status==='rejected'));assert.equal(h.trade.packing.version,99);assert.equal(h.requests.length,1);assert.equal(h.q.pending('t'),false);});

test('flush waits through checks queued during the first save',async()=>{const h=harness();const a=h.q.check('t',h.trade.packing.entries[0].id,true);let settled=false;const drain=h.q.flush('t').then(()=>{settled=true;});const b=h.q.check('t','second',true);h.confirm(0);await a;await tick();assert.equal(settled,false);h.confirm(1);await Promise.all([b,drain]);assert.equal(h.q.pending('t'),false);assert.equal(h.finished.length,1);});
test('flush propagates failed persistence after authoritative recovery',async()=>{const h=harness();const a=h.q.check('t',h.trade.packing.entries[0].id,true);const rejected=assert.rejects(a,/offline/);const drain=assert.rejects(h.q.flush('t'),/offline/);h.requests[0].reject(new Error('offline'));await Promise.all([rejected,drain]);assert.equal(h.q.pending('t'),false);assert.equal(h.finished.length,1);});
test('a command drains checks then later checks use the command version and note',async()=>{
  const h=harness(),id=h.trade.packing.entries[0].id;
  const first=h.q.check('t',id,true);
  let commandRan=false;
  const command=h.q.command('t',async()=>{commandRan=true;h.trade.packing.version++;h.trade.packing.note='새 메모';});
  const later=h.q.check('t','second',true);
  await tick();assert.equal(commandRan,false);assert.equal(h.requests.length,1);
  h.confirm(0);await Promise.all([first,command]);await tick();
  assert.equal(h.requests.length,2);assert.equal(h.requests[1].version,h.requests[0].version+2);assert.equal(h.requests[1].command.note,'새 메모');
  h.confirm(1);await later;await h.q.flush('t');assert.equal(h.q.pending('t'),false);
});
test('a command failure cancels later queued check and releases the queue for recovery',async()=>{
  const h=harness();const a=h.q.command('t',async()=>{throw new Error('offline')});const b=h.q.check('t','second',true);
  const results=await Promise.allSettled([a,b]);assert(results.every(r=>r.status==='rejected'));assert.equal(h.requests.length,0);assert.equal(h.q.pending('t'),false);
  const c=h.q.check('t','second',true);h.confirm(0);await c;assert.equal(h.trade.packing.entries[1].checked,true);
});

test('a check waiting behind a command cannot certify a changed quantity or physical identity',async()=>{
  for(const change of ['qty','partId','ownerId']){
    const h=harness(),entry=h.trade.packing.entries[0];let release;
    const gate=new Promise(r=>release=r);
    const command=h.q.command('t',async()=>{await gate;h.trade.packing.version++;entry[change]=change==='qty'?2:'changed';});
    const result=h.q.check('t',entry.id,true).then(()=>({ok:true}),error=>({error}));
    release();await command;await tick();assert.equal(h.requests.length,0,change);
    assert.match(String((await result).error),/종류와 수량/);
    assert.equal(h.q.pending('t'),false);
  }
});

test('an unchanged checked entry can follow a note edit without reverting a sibling check',async()=>{
  const h=harness(),entry=h.trade.packing.entries[0];let release;
  const gate=new Promise(r=>release=r);
  const command=h.q.command('t',async()=>{await gate;h.trade.packing.version++;h.trade.packing.note='최신 메모';h.trade.packing.entries[1].checked=true;});
  const saving=h.q.check('t',entry.id,true);release();await command;await tick();
  assert.equal(h.requests[0].command.note,'최신 메모');assert.equal(h.requests[0].command.entries[1].checked,true);
  h.confirm(0);await saving;assert.equal(h.trade.packing.entries[0].checked,true);
});
