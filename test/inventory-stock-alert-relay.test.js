const test=require('node:test');
const assert=require('node:assert/strict');
const {relayOnce,createClients}=require('../scripts/windows/inventory-stock-alert-relay');
const channel='C0B769B394K';
const pending=()=>({id:'message-id',relayToken:'lease',channel,text:'재고 부족',hash:'same',desiredHash:'same',actionable:true,createdAt:100000,attemptedAt:100000,transportRejected:true});
function env(over={}) {
 const p={...pending(),...over},messages=[],calls=[],acks=[];
 const gas=async (name,args)=>{if(name==='claimPreRegistrationStockAlertRelay')return {status:'claimed',requestId:'RQ-260904-014',pending:p};if(name==='authorizePreRegistrationStockAlertRelay')return {status:'authorized',validUntil:500000};acks.push(args[0]);return {status:args[0].delivered?'sent':'obsolete'};};
 const slack=async (name,args)=>{calls.push(name);if(name==='conversations.history')return {ok:true,messages};messages.push({...args,ts:'123.456'});return {ok:true,channel,ts:'123.456'};};
 return {p,messages,calls,acks,gas,slack,channel,now:()=>200000};
}
test('quota rejection is relayed and acknowledged only after Slack history verifies the exact message',async()=>{
 const e=env();assert.equal((await relayOnce(e)).status,'sent');assert.equal(e.calls.filter(x=>x==='chat.postMessage').length,1);
 assert.equal(e.acks[0].ts,'123.456');assert.equal(e.acks[0].relayToken,'lease');
});
test('a prior accepted post is found instead of posted a second time',async()=>{
 const e=env();e.messages.push({ts:'100.1',text:e.p.text,metadata:{event_type:'preregistration_stock_alert',event_payload:{id:e.p.id}}});
 assert.equal((await relayOnce(e)).status,'sent');assert.ok(!e.calls.includes('chat.postMessage'));
});
test('changed intent is discarded only after complete absence evidence; no obsolete alert is sent',async()=>{
 const e=env({desiredHash:'changed'});assert.equal((await relayOnce(e)).status,'obsolete');assert.equal(e.acks[0].obsolete,true);assert.ok(!e.calls.includes('chat.postMessage'));
});
test('incomplete history, known missing receipt, and recent uncertain post never trigger duplicate sends',async()=>{
 for(const override of [{ts:'100.2'},{transportRejected:false,attemptedAt:190000}]) {
   const e=env(override);assert.equal((await relayOnce(e)).status,'pending');assert.ok(!e.calls.includes('chat.postMessage'));assert.equal(e.acks.length,0);
 }
 const e=env();e.slack=async()=>({messages:[],has_more:true});assert.equal((await relayOnce(e)).status,'pending');assert.equal(e.acks.length,0);
});
test('a failed acknowledgement does not justify replaying an already visible message',async()=>{
 const e=env(),original=e.gas;let unavailable=true;
 e.gas=async(name,args)=>{if(name==='acknowledgePreRegistrationStockAlertRelay'&&unavailable)throw Error('ack timeout');return original(name,args);};
 await assert.rejects(relayOnce(e));unavailable=false;assert.equal((await relayOnce(e)).status,'sent');assert.equal(e.calls.filter(x=>x==='chat.postMessage').length,1);
});
test('relay rejects a different channel before any Slack operation',async()=>{
 const e=env({channel:'COTHER1234'});await assert.rejects(relayOnce(e),/channel_mismatch/);assert.equal(e.calls.length,0);
});

test('an authorization delayed beyond its usable lease never starts a POST',async()=>{
 const e=env(),original=e.gas;e.gas=async(name,args)=>name==='authorizePreRegistrationStockAlertRelay'?{status:'authorized',validUntil:210000}:original(name,args);
 assert.equal((await relayOnce(e)).status,'authorization_expired');assert.ok(!e.calls.includes('chat.postMessage'));
});
test('Slack rate limits persist a retry boundary, and GAS failures do not leak credentials',async()=>{
 let retry=0;const clients=createClients({config:{VILLAGE2_API_URL:'https://script.google.com/macros/s/test/exec',VILLAGE2_API_KEY:'private-test-value'},slackToken:'private-slack-value',onBackoff:t=>retry=t,
 fetchImpl:async()=>({status:429,ok:false,headers:{get:()=> '120'},json:async()=>({success:false,error:'private-test-value'})})});
 await assert.rejects(clients.slack('conversations.history',{channel}),/relay_slack_backoff/);assert.ok(retry>Date.now()+119000);
 await assert.rejects(clients.gas('claimPreRegistrationStockAlertRelay'),e=>e.message==='relay_gas_request_failed');
});
