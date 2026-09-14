const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = process.env.CANCEL_TEST_ROOT || path.resolve(__dirname, '..');
const code = fs.readFileSync(path.join(root, 'Code.js'), 'utf8');
const start = code.indexOf('function scheduleCancelledTradeCleanupTriggerOutsideLock_');
const body = code.slice(start, code.indexOf('\nfunction ensureCancelledTradeCleanupTrigger_', start));

function fixture() {
  let now = 1000000, seq = 0;
  const values = new Map(), timers = new Map();
  const props = {getProperty:k=>values.get(k),setProperty:(k,v)=>values.set(k,v),deleteProperty:k=>values.delete(k)};
  const context = {Date:{now:()=>now},Math,Number,String,
    CANCEL_CLEANUP_HANDLER_:'processCancelledTradeCleanup',
    CANCEL_CLEANUP_TRIGGER_PROP_:'cancelCleanupTriggerAt_v1',
    CANCEL_CLEANUP_LEASE_MS_:7*60*1000,
    Logger:{log(){}},
    ScriptApp:{getProjectTriggers:()=>[...timers.keys()].map(id=>({getHandlerFunction:()=>context.CANCEL_CLEANUP_HANDLER_,getUniqueId:()=>id}))},
    replaceOneShotTrigger_(_handler, delay){timers.clear();const id=String(++seq);timers.set(id,now+delay+65000);return id;}
  };
  vm.createContext(context);vm.runInContext(body,context);
  return {values,timers,setNow:t=>now=t,now:()=>now,ensure:delay=>context.scheduleCancelledTradeCleanupTriggerOutsideLock_(props,delay),created:()=>seq};
}

test('minute rescue lets an already scheduled delayed cancellation trigger fire',()=>{
  const f=fixture();let fired=0;f.ensure(1000);const base=f.now();
  for(let elapsed=1000;elapsed<=180000;elapsed+=1000){
    f.setNow(base+elapsed);
    if(elapsed%60000===0 && !fired)f.ensure(1000);
    for(const [id,due] of f.timers)if(due<=f.now()){f.timers.delete(id);fired++;}
  }
  assert.equal(fired,1,'a minute rescue must not postpone the pending worker forever');
  assert.equal(f.created(),1);
});

test('rescue recreates a missing trigger even when its saved deadline is in the future',()=>{
  const f=fixture();f.ensure(60000);f.timers.clear();f.ensure(60000);
  assert.equal(f.timers.size,1);
  assert.equal(f.created(),2);
});

test('an overdue trigger is eventually replaced if it never starts',()=>{
  const f=fixture();f.ensure(1000);f.setNow(f.now()+7*60000+2000);f.ensure(1000);
  assert.equal(f.created(),2);assert.equal(f.timers.size,1);
});

test('new ready work advances a later lease watchdog',()=>{
  const f=fixture();f.ensure(7*60000);f.ensure(1000);
  assert.equal(f.created(),2);assert.equal(f.timers.size,1);
});
