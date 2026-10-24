import test from 'node:test';import assert from 'node:assert/strict';
import {openKakaoTargetChatViaDevtools,closeKakaoConversationTargetViaDevtools} from './worker.mjs';
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
