import test from 'node:test';import assert from 'node:assert/strict';
import {captureOwnedKakaoRoom,closeOwnedKakaoRoom} from './owned-room-capture.mjs';
const base='http://127.0.0.1:9223',listUrl='https://business.kakao.com/space/test/channel/_test/chats',roomId='1234567890123',url=listUrl+'/'+roomId;
async function fixture(run,{ready=true,draft=false}={}){
 const main={id:'main',type:'page',url:listUrl,webSocketDebuggerUrl:'ws://127.0.0.1:9223/devtools/page/main'},owned={id:'owned',type:'page',url,webSocketDebuggerUrl:'ws://127.0.0.1:9223/devtools/page/owned'};
 const commands=[],reads=[];let created=false;const targets=()=>created?[main,owned]:[main];
 const fetchJson=async(_base,endpoint)=>{reads.push(endpoint);return endpoint==='/json/version'?{webSocketDebuggerUrl:'ws://127.0.0.1:9223/devtools/browser/fixture'}:targets();};
 const callCdp=async(target,method,params)=>{commands.push({target,method,params});if(method==='Target.createTarget'){created=true;return{targetId:'owned'}}return{success:true};};
 const readEvidence=async target=>{assert.equal(target.id,'owned');return{ready,attempts:1,dom:{href:url,title:'fixture'},evidence:{messages:[{role:'customer',text:'fixture'}]}};};
 const inspectDraft=async()=>({href:owned.url,hasDraft:draft});
 const options={cdpBaseUrl:base,mainTarget:main,knownTargets:[main],roomId,fetchJson,callCdp,readEvidence,inspectDraft};
 await run({options,commands,reads,main,owned});
}
test('exact room capture creates only its own background page without shared list/search/focus mutation',()=>fixture(async({options,commands})=>{
 const capture=await captureOwnedKakaoRoom(options);assert.equal(capture.status,'opened_target_chat');assert.equal(capture.owned_capture,true);
 assert.deepEqual(commands.map(x=>x.method),['Target.createTarget','Runtime.runIfWaitingForDebugger']);assert.equal(commands[1].target.id,'owned');assert.deepEqual(commands[0].params,{url,background:true});
 const closed=await closeOwnedKakaoRoom(capture.conversation_target,options);assert.equal(closed.status,'closed_owned_capture');assert.equal(commands.at(-1).method,'Target.closeTarget');assert.deepEqual(commands.at(-1).params,{targetId:'owned'});
}));
test('failed evidence releases only the newly created owned page before returning',()=>fixture(async({options,commands})=>{const result=await captureOwnedKakaoRoom(options);assert.equal(result.status,'owned_capture_evidence_unavailable');assert.equal(commands.filter(x=>x.method==='Target.closeTarget').length,1);},{ready:false}));
test('forged or existing target ownership never permits closure',()=>fixture(async({options,commands})=>{assert.equal((await closeOwnedKakaoRoom({id:'main',url:listUrl},options)).status,'skipped_unowned_capture');assert.equal(commands.length,0);}));
test('a draft entered into the owned tab is preserved even while another Hermes task is active',()=>fixture(async({options,commands})=>{const result=await captureOwnedKakaoRoom(options);assert.equal((await closeOwnedKakaoRoom(result.conversation_target,options)).status,'skipped_owned_capture_draft');assert.equal(commands.length,2);},{draft:true}));
test('retargeting an owned tab prevents closing it',()=>fixture(async({options,owned,commands})=>{const result=await captureOwnedKakaoRoom(options);owned.url=listUrl+'/9999999999999';assert.equal((await closeOwnedKakaoRoom(result.conversation_target,options)).status,'skipped_changed_owned_capture');assert.equal(commands.length,2);}));
test('wrong page, ambiguous room and external CDP cannot create a tab',()=>fixture(async({options,commands})=>{for(const patch of [{roomId:'../wrong'},{mainTarget:{...options.mainTarget,url:'https://example.com/chats'}},{cdpBaseUrl:'http://example.com:9223'}])await assert.rejects(captureOwnedKakaoRoom({...options,...patch}),/owned capture/i);assert.equal(commands.length,0);}));
test('a create response naming an existing shared target is never treated as owned',()=>fixture(async({options})=>{await assert.rejects(captureOwnedKakaoRoom({...options,callCdp:async()=>({targetId:'main'})}),/existing target/);}));

test('delayed target metadata is polled without creating a second tab',()=>fixture(async({options,commands})=>{let lists=0;const original=options.fetchJson;options.fetchJson=async(...args)=>{const value=await original(...args);if(args[1]==='/json/list'&&++lists<3)return value.map(t=>t.id==='owned'?{...t,url:'about:blank'}:t);return value;};options.sleepImpl=async()=>{};const result=await captureOwnedKakaoRoom(options);assert.equal(result.status,'opened_target_chat');assert.equal(commands.filter(c=>c.method==='Target.createTarget').length,1);await closeOwnedKakaoRoom(result.conversation_target,options);}));
test('a never-loaded created tab is closed by its exact create acknowledgment',()=>fixture(async({options,owned,commands})=>{owned.url='about:blank';options.sleepImpl=async()=>{};const result=await captureOwnedKakaoRoom(options);assert.equal(result.status,'owned_capture_evidence_unavailable');assert.equal(commands.filter(c=>c.method==='Target.closeTarget').length,1);}));

test('actual draft expression sees nested shadow/frame composers and fails closed on inaccessible frames',async()=>{
 const {buildOwnedDraftInspectionExpression}=await import('./owned-room-capture.mjs');
 const {default:vm}=await import('node:vm');
 const root=(children=[],inputs=[])=>({querySelectorAll:selector=>selector==='*'?children:inputs});
 const draft={value:'unsent customer text'},empty={value:''};
 const document=root([{shadowRoot:root([{tagName:'IFRAME',contentDocument:root([], [draft])}])}]);
 const inspect=doc=>vm.runInNewContext(buildOwnedDraftInspectionExpression(),{document:doc,location:{href:'https://business.kakao.com/exact'}});
 assert.equal(inspect(document).hasDraft,true);
 assert.equal(inspect(root([{tagName:'IFRAME',contentDocument:null}])).hasDraft,null);
 assert.equal(inspect(root([], [empty])).hasDraft,false);
});

test('resume failure stays on the owned target, emits cleanup proof, and never reads shared UI',()=>fixture(async({options,commands})=>{
 const call=options.callCdp;options.callCdp=async(target,method,params)=>{if(method==='Runtime.runIfWaitingForDebugger'){commands.push({target,method,params});throw Error('resume failed');}return call(target,method,params);};
 options.readEvidence=()=>assert.fail('must not read after failed resume');const result=await captureOwnedKakaoRoom(options);
 assert.equal(result.status,'owned_capture_evidence_unavailable');assert.equal(result.stage,'resume');assert.equal(result.owned_target.id,'owned');assert.equal(result.cleanup.status,'closed_owned_capture');
 assert.ok(commands.every(c=>c.method==='Target.createTarget'||c.target.id==='owned'||c.method==='Target.closeTarget'));
}));

test('draft expression ignores only an inaccessible zero-height textarea layout measurement, never a hidden real draft',async()=>{
 const {buildOwnedDraftInspectionExpression}=await import('./owned-room-capture.mjs');const {default:vm}=await import('node:vm');
 const field={tagName:'TEXTAREA',value:'x',getAttribute:k=>({'aria-hidden':'true',tabindex:'-1'}[k]),getBoundingClientRect:()=>({height:0}),ownerDocument:{defaultView:{getComputedStyle:()=>({visibility:'hidden',position:'absolute'})}}};
 const doc={querySelectorAll:selector=>selector==='*'?[]:[field]};
 const inspect=()=>vm.runInNewContext(buildOwnedDraftInspectionExpression(),{document:doc,location:{href:'exact'}});
 assert.equal(inspect().hasDraft,false);field.getAttribute=()=>null;assert.equal(inspect().hasDraft,true);
});
