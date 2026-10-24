import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHermesGatewayHttpHandler } from './hermes-gateway-http.mjs';
import { createHermesGatewayChannel } from './hermes-gateway-channel.mjs';

async function request(handler, method, url, body = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method, url, socket: { remoteAddress: '127.0.0.1' }, headers: { authorization: 'Bearer test', host: 'localhost' } });
  const response = {};
  const res = { writeHead(status) { response.status = status; }, end(text) { response.body = JSON.parse(text); } };
  await handler(req, res, new URL(url, 'http://localhost'));
  await new Promise(resolve => setImmediate(resolve));
  return response;
}
for (const transport of ['gateway_no_send', 'gateway']) {
  test(`${transport} polling and outcomes preserve the notification policy`, async () => {
    const effects = [];
    const handler = createHermesGatewayHttpHandler({ token: 'test', transport,
      channel: { claim: async () => null, recordOutcome: async () => effects.push('outcome') },
      recoverFailureNotifications: async () => effects.push('notify'),
      recoverAuditProjections: async () => effects.push('audit') });
    assert.equal((await request(handler, 'GET', '/hermes/v1/events?consumer_id=test')).status, 200);
    assert.equal((await request(handler, 'POST', '/hermes/v1/outcomes', {lease_id:'lease'})).status, 200);
    assert.deepEqual(effects, transport === 'gateway_no_send' ? ['outcome'] : ['notify','audit','outcome','notify','audit']);
  });
  test(`${transport} result acknowledgement separates durable completion from external application`, async () => {
    const effects = [];
    const handler = createHermesGatewayHttpHandler({ token:'test', transport,
      channel: { complete: async () => { effects.push('durable'); return { application:{state:'pending'} }; } },
      enqueueResultApplication: async () => effects.push('apply') });
    assert.equal((await request(handler,'POST','/hermes/v1/results',{lease_id:'lease'})).status,200);
    assert.deepEqual(effects, transport === 'gateway_no_send' ? ['durable'] : ['durable','apply']);
  });
}

test('diagnostic status preserves a restarted unresolved operation byte-for-byte; normal claim still fences it', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'village-read-status-'));
  try {
    const options = { directory, now: () => Date.parse('2026-10-23T15:00:00Z') };
    const initial = createHermesGatewayChannel(options);
    await initial.enqueue({job_id:'test-job',room_key:'test-room',room_revision:1,detected_at:'2026-10-23T14:00:00Z'});
    const claim = await initial.claim({consumerId:'test',waitMs:0});
    await initial.reserveToolOperation({tool:'confirmation_request',job_id:claim.job_id,room_key:claim.room_key,
      room_revision:claim.room_revision,lease_id:claim.lease_id,request_digest:'test-digest'});
    const queue = path.join(directory,'hermes-gateway');
    const file = path.join(queue,(await readdir(queue))[0]);
    const before = await readFile(file,'utf8');
    const restarted = createHermesGatewayChannel(options);
    const handler = createHermesGatewayHttpHandler({token:'test',transport:'gateway_no_send',channel:restarted});
    assert.equal((await request(handler,'GET','/hermes/v1/status')).status,200);
    assert.equal(await readFile(file,'utf8'),before);
    assert.equal((await restarted.status({readOnly:true})).counts.claimed,1);
    await restarted.claim({consumerId:'test',waitMs:0});
    const after = JSON.parse(await readFile(file,'utf8'));
    assert.equal(after.state,'failed');
    assert.equal(after.tool_operation.operation_id,JSON.parse(before).tool_operation.operation_id);
    assert.equal(after.failure_notification.state,'pending');
  } finally { await rm(directory,{recursive:true,force:true}); }
});

test('read-only status on a missing queue creates no directory and later enqueue still persists', async () => {
  const directory = await mkdtemp(path.join(tmpdir(),'village-empty-status-'));
  try {
    const channel = createHermesGatewayChannel({directory});
    assert.equal((await channel.status({readOnly:true})).counts.ready,0);
    assert.deepEqual(await readdir(directory),[]);
    await channel.enqueue({job_id:'test',room_key:'room',room_revision:1,detected_at:new Date().toISOString()});
    assert.equal((await readdir(path.join(directory,'hermes-gateway'))).length,1);
  } finally { await rm(directory,{recursive:true,force:true}); }
});

const source = fs.readFileSync(new URL('./server.mjs',import.meta.url),'utf8');
const serverCode = source.slice(source.indexOf('const server = http.createServer('),source.indexOf("if (process.env.KAKAO_DOM_BRIDGE_NO_LISTEN !== '1') {"));
for (const url of ['/manual-send','/slack/actions','/maintenance/recover','/maintenance/slack-actions','/maintenance/p0-slack-escalation','/maintenance/work-orchestrator-digest','/maintenance/slack-case-update','/maintenance/cleanup-tabs','/events']) {
  test(`no-send server rejects ${url} before reading payload or calling any operational handler`, async () => {
    let handler; const effects=[];
    const context={URL, CONFIG:{hermesTransport:'gateway_no_send'}, http:{createServer(fn){handler=fn;}},
      gatewayHttpHandler:async()=>false,
      json(res,status,body){res.writeHead(status);res.end(JSON.stringify(body));},
      readJsonBody:async()=>{effects.push('read');return {text:'test',customerName:'test',id:'test'};},
      appendNdjson:()=>effects.push('error'), nowIso:()=>'',
      handleEvent:async(req,res)=>{effects.push('event');res.writeHead(200);res.end('{}');},
      enqueueManualSend:async()=>{effects.push('send');return {sent:true};},
      applySlackFollowUpActionRequest:async()=>{effects.push('slack');return {};},
      runSupabaseRecoverySweep:async()=>{effects.push('recovery');return {};},
      runSlackActionPoll:async()=>{effects.push('poll');return {};},slackActionMaintenanceSucceeded:()=>true,
      runP0SlackEscalationSweep:async()=>{effects.push('p0');return {};},
      workOrchestratorDigestRuntime:{},handleWorkOrchestratorDigestMaintenance:async()=>{effects.push('digest');return {statusCode:200,body:{}};},
      retrySlackFollowUpCaseUpdateById:async()=>{effects.push('case');return {ok:true};},
      cleanupIdleKakaoConversationTabs:async()=>{effects.push('tabs');return {};}};
    vm.runInNewContext(serverCode,context);
    const res=await request(handler,'POST',url);
    assert.equal(res.status,403);
    assert.equal(res.body.error,'writes_disabled');
    assert.deepEqual(effects,[]);
  });
}
test('no-send accepts an exact durable result without applying it or marking obligations delivered', async () => {
  const directory=await mkdtemp(path.join(tmpdir(),'village-held-result-'));
  try {
    const channel=createHermesGatewayChannel({directory});
    await channel.enqueue({job_id:'result-test',room_key:'result-room',room_revision:1});
    const claim=await channel.claim({consumerId:'test',waitMs:0});
    const effects=[];
    const handler=createHermesGatewayHttpHandler({token:'test',transport:'gateway_no_send',channel,
      enqueueResultApplication:async()=>effects.push('apply')});
    const body={job_id:claim.job_id,room_key:claim.room_key,room_revision:claim.room_revision,lease_id:claim.lease_id,content:'FINAL_JSON {}'};
    assert.equal((await request(handler,'POST','/hermes/v1/results',body)).status,200);
    const queue=path.join(directory,'hermes-gateway');
    const saved=JSON.parse(await readFile(path.join(queue,(await readdir(queue))[0]),'utf8'));
    assert.deepEqual(saved.result,body);
    assert.equal(saved.application.state,'pending');
    assert.equal(saved.application.finalized_at,null);
    assert.equal(saved.application.final_audit,null);
    assert.deepEqual(effects,[]);
  } finally { await rm(directory,{recursive:true,force:true}); }
});