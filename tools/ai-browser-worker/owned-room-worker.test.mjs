import test from 'node:test';import assert from 'node:assert/strict';
const {openKakaoTargetChatViaDevtools,closeKakaoConversationTargetViaDevtools}=await import(process.env.VILLAGE_TEST_WORKER_URL || './worker.mjs');
test('real worker reads the exact new room while shared Hermes remains active, without evaluating the shared list',async()=>{
 const list='https://business.kakao.com/space/test/channel/_test/chats',url=list+'/1234567890123';let created=false;const commands=[],evaluated=[];
 const main={id:'main',type:'page',url:list,webSocketDebuggerUrl:'ws://127.0.0.1:9223/devtools/page/main'},own={id:'own',type:'page',url,webSocketDebuggerUrl:'ws://127.0.0.1:9223/devtools/page/own'};
 const fetchImpl=async endpoint=>new Response(JSON.stringify(endpoint.endsWith('/json/version')?{webSocketDebuggerUrl:'ws://127.0.0.1:9223/devtools/browser/fixture'}:created?[main,own]:[main]));
 const cdpCallImpl=async(target,method,params)=>{commands.push({method,params});if(method==='Target.createTarget'){created=true;return{targetId:'own'}}return{success:true};};
 const evaluateImpl=async target=>{evaluated.push(target.id);return{href:url,title:'Fixture',text:'Fixture\n예약 확인 요청합니다\n네 확인했습니다',messages:[{message_id:'m1',role:'customer',text:'예약 확인 요청합니다',order:1},{message_id:'m2',role:'staff',text:'네 확인했습니다',order:2}],hasDraft:false};};
 const options={cdpBaseUrl:'http://127.0.0.1:9223',sharedGatewayIdle:()=>false,fetchImpl,evaluateImpl,cdpCallImpl,evidencePollMs:0};
 const result=await openKakaoTargetChatViaDevtools({room_key:'chat:1234567890123',customer_name:'Fixture',preview_text:'Fixture 예약 확인 요청합니다'},options);
 assert.equal(result.status,'opened_target_chat');assert.equal(result.owned_capture,true);assert.equal(result.conversation_evidence.messages.length,2);assert.ok(evaluated.every(id=>id==='own'));
 const close=await closeKakaoConversationTargetViaDevtools(result.conversation_target,options);assert.equal(close.status,'closed_owned_capture');assert.deepEqual(commands.map(x=>x.method),['Target.createTarget','Runtime.runIfWaitingForDebugger','Target.closeTarget']);
});


function staleRoomFixture({existingHealthy=false,ownedDisconnected=false,latestAfter=1,roomKnown=true}={}) {
 const list='https://business.kakao.com/space/test/channel/_test/chats',url=list+'/1234567890123';
 const main={id:'main',type:'page',url:list,webSocketDebuggerUrl:'ws://127.0.0.1:9223/devtools/page/main'};
 const stale={id:'stale',type:'page',url,title:'Fixture - 빌리지 - 카카오비즈니스 파트너센터',webSocketDebuggerUrl:'ws://127.0.0.1:9223/devtools/page/stale'};
 const own={id:'new-owned',type:'page',url,title:'Fixture - 빌리지 - 카카오비즈니스 파트너센터',webSocketDebuggerUrl:'ws://127.0.0.1:9223/devtools/page/new-owned'};
 let created=false,ownReads=0;const commands=[],evaluated=[];
 const fetchImpl=async endpoint=>new Response(JSON.stringify(endpoint.endsWith('/json/version')?{webSocketDebuggerUrl:'ws://127.0.0.1:9223/devtools/browser/fixture'}:created?[main,stale,own]:[main,stale]));
 const cdpCallImpl=async(target,method,params)=>{commands.push({target:target.id,method,params});if(method==='Target.createTarget'){created=true;return{targetId:own.id}}return{success:true};};
 const evaluateImpl=async target=>{
  evaluated.push(target.id);assert.notEqual(target.id,'main','shared list must not be evaluated');
  const isOwn=target.id===own.id;if(isOwn)ownReads++;
  const disconnected=isOwn?ownedDisconnected:!existingHealthy;
  const latest=!isOwn||ownReads>=latestAfter;
  return{href:url,title:'Fixture - 빌리지 - 카카오비즈니스 파트너센터',text:'Fixture\n'+(disconnected?'연결 끊김\n대화가 불가능한 상태입니다':'본문 확인')+'\n'+(latest?'latest confirmation':'older message'),messages:[{message_id:'m1',role:'customer',order:1,text:latest?'latest confirmation':'older message'}],hasDraft:!isOwn};
 };
 const job={...(roomKnown?{room_key:'chat:1234567890123'}:{}),customer_name:'Fixture',messagePreview:'latest confirmation'};
 const options={cdpBaseUrl:'http://127.0.0.1:9223',sharedGatewayIdle:()=>false,fetchImpl,evaluateImpl,cdpCallImpl,evidencePollMs:0,evidenceMaxAttempts:2,refreshStaleConversation:false,allowSearch:false};
 return{job,options,commands,evaluated,get ownReads(){return ownReads}};
}
test('disconnected existing room falls back once to a fresh owned background room without touching its draft',async()=>{
 const h=staleRoomFixture();const r=await openKakaoTargetChatViaDevtools(h.job,h.options);
 assert.equal(r.status,'opened_target_chat');assert.equal(r.owned_capture,true);
 assert.equal(h.commands.filter(c=>c.method==='Target.createTarget').length,1);
 assert.deepEqual(h.commands.find(c=>c.method==='Target.createTarget').params,{url:'https://business.kakao.com/space/test/channel/_test/chats/1234567890123',background:true});
 assert.equal((await closeKakaoConversationTargetViaDevtools(r.conversation_target,h.options)).status,'closed_owned_capture');
 assert.deepEqual(h.commands.filter(c=>c.method==='Target.closeTarget').map(c=>c.params.targetId),['new-owned']);
 assert.ok(!h.commands.some(c=>/navigate|reload|activate/i.test(c.method)));
});
test('owned fallback waits for the actual trigger message instead of accepting earlier loaded history',async()=>{
 const h=staleRoomFixture({latestAfter:2});const r=await openKakaoTargetChatViaDevtools(h.job,h.options);
 assert.equal(r.status,'opened_target_chat');assert.equal(h.ownReads,2);assert.equal(r.conversation_evidence.capture_integrity.reason,'trigger_message_observed');
 await closeKakaoConversationTargetViaDevtools(r.conversation_target,h.options);
});
test('disconnected fresh fallback stays blocked and closes only the newly created target',async()=>{
 const h=staleRoomFixture({ownedDisconnected:true});const r=await openKakaoTargetChatViaDevtools(h.job,h.options);
 assert.equal(r.status,'owned_capture_evidence_unavailable');assert.equal(r.cleanup.status,'closed_owned_capture');
 assert.deepEqual(h.commands.filter(c=>c.method==='Target.closeTarget').map(c=>c.params.targetId),['new-owned']);
});
test('healthy existing room keeps the existing fast path without creating or closing tabs',async()=>{
 const h=staleRoomFixture({existingHealthy:true});const r=await openKakaoTargetChatViaDevtools(h.job,h.options);
 assert.equal(r.status,'opened_target_chat');assert.equal(r.already_open,true);assert.equal(h.commands.length,0);
});
test('a failed existing room without an exact room ID cannot trigger owned capture or shared search',async()=>{
 const h=staleRoomFixture({roomKnown:false});const r=await openKakaoTargetChatViaDevtools(h.job,h.options);
 assert.equal(r.status,'conversation_evidence_unavailable');assert.equal(h.commands.length,0);
});

test('default stale-room recovery delegates the exact draft-safe refresh and rereads without creating a tab',async()=>{const h=staleRoomFixture();let refreshed=false;const original=h.options.evaluateImpl;h.options.refreshStaleConversation=true;h.options.evaluateImpl=async(t,expression)=>{if(expression.includes('const state =')){assert.equal(t.id,'stale');refreshed=true;return{refreshed:true}}if(refreshed)return{href:t.url,title:'Fixture - 빌리지 - 카카오비즈니스 파트너센터',text:'Fixture\nlatest confirmation',messages:[{role:'customer',text:'latest confirmation',order:1}]};return original(t,expression)};h.options.sleepImpl=async()=>{};const r=await openKakaoTargetChatViaDevtools(h.job,h.options);assert.equal(refreshed,true);assert.equal(r.status,'opened_target_chat');assert.equal(r.already_open,true);assert.equal(h.commands.length,0)});
