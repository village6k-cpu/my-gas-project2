import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createHermesGatewayHttpHandler } from './hermes-gateway-http.mjs';
Object.assign(process.env,{KAKAO_DOM_BRIDGE_NO_LISTEN:'1',WORK_ORCHESTRATOR_V2_RUNTIME_MODE:'legacy',WORK_ORCHESTRATOR_V2_SHADOW_WRITES:'0',WORK_ORCHESTRATOR_V2_IMMEDIATE_ENABLED:'0',WORK_ORCHESTRATOR_V2_WORK_ITEMS_ENABLED:'0',WORK_ORCHESTRATOR_V2_DIGEST_ENABLED:'0',WORK_ORCHESTRATOR_V2_CLEANUP_ENABLED:'0',WORK_ORCHESTRATOR_V2_P0_READBACK_ENABLED:'0',WORK_ORCHESTRATOR_V2_P0_CUTOVER_ENABLED:'0',WORK_ORCHESTRATOR_V2_REPORT_ONLY_ENABLED:'0',WORK_ORCHESTRATOR_V2_HEYBILLI_ACTIONS_READY:'0',AI_WORKER_FOLLOW_UP_ITEMS_ENABLED:'1',KAKAO_FOLLOW_UP_ITEMS_ENABLED:'1',SLACK_AGENT_CARD_DELIVERY_ENABLED:'1',P0_SLACK_ESCALATION_ENABLED:'1',SLACK_ACTION_POLL_ENABLED:'1'});
const {createGatewayResultApplicationCoordinator,createGatewayFailureNotificationCoordinator}=await import('./server.mjs');
function request(method,url,body={}){
 const req=Readable.from([JSON.stringify(body)]);req.method=method;req.headers={authorization:'Bearer test-token','content-type':'application/json'};req.socket={remoteAddress:'127.0.0.1'};
 const res={statusCode:0,headers:{},setHeader(k,v){this.headers[k]=v;},writeHead(c,h){this.statusCode=c;Object.assign(this.headers,h);},end(v){this.body=v;}};
 return {req,res,url:new URL(url,'http://127.0.0.1')};
}

test('recovery hold rejects document delivery before validation, queue reads or sender execution',async()=>{
 let touched=0;
 const handler=createHermesGatewayHttpHandler({token:'test-token',transport:'gateway',recoveryHoldMode:true,channel:{get(){touched++;throw Error('must not read');}},executeDocument(){touched++;throw Error('must not send');},validateDocument(){touched++;throw Error('must not validate');}});
 const x=request('POST','/hermes/v1/tools/document-send');
 assert.equal(await handler(x.req,x.res,x.url),true);
 assert.equal(x.res.statusCode,403);
 assert.equal(touched,0);
});

test('recovery hold does not run historical notification/audit recovery on live event polling',async()=>{
 let recoveries=0,claims=0;
 const handler=createHermesGatewayHttpHandler({token:'test-token',transport:'gateway',recoveryHoldMode:true,channel:{async claim(){claims++;return null;}},recoverFailureNotifications(){recoveries++;},recoverAuditProjections(){recoveries++;}});
 const x=request('GET','/hermes/v1/events?consumer_id=test');
 await handler(x.req,x.res,x.url);await Promise.resolve();
 assert.equal(x.res.statusCode,200);assert.equal(claims,1);assert.equal(recoveries,0);
});

test('new failed work remains pending instead of sending or falsely marking a notice delivered',async()=>{
 let notices=0,marked=0,failed=0;
 const job={job_id:'live-job',room_key:'room',room_revision:1,event:{},local_context:{job:{jobId:'live-job'},turn_internal:{}},tool_receipts:[],application:{state:'claimed',application_id:'app'}};
 const channel={async claimApplication(){return {claimed:true,application_id:'app',job};},async beginApplication(){},async recordApplicationApplied(){},async finalizeApplication(){},async failApplication(){failed++;return {...job,application:{...job.application,state:'failed',failure_notification:{state:'pending'}}};},async listPendingApplicationFailureNotifications(){return [];},async markApplicationFailureNotified(){marked++;}};
 const coordinator=createGatewayResultApplicationCoordinator({channel,getConfig:()=>({}),notificationDeliveryEnabled:false,prepare:async()=>{throw Error('planned offline failure');},onFailure:async()=>{notices++;}});
 await coordinator.enqueue(job);await coordinator.idle();
 assert.equal(failed,1);assert.equal(notices,0);assert.equal(marked,0);
});
test('duplicate failed dispatch recovery cannot consume terminal notices when delivery is held',async()=>{
 let reads=0,notified=0,marked=0;
 const coordinator=createGatewayFailureNotificationCoordinator({notificationDeliveryEnabled:false,channel:{async listPendingFailureNotifications(){reads++;return [{job_id:'new-failure',error:{type:'failure'}}];},async markFailureNotified(){marked++;}},notify:async()=>{notified++;return {skipped:true};}});
 await coordinator.recover();await coordinator.recover();
 assert.deepEqual({reads,notified,marked},{reads:0,notified:0,marked:0});
});
