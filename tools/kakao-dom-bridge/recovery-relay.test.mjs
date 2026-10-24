import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecoveryRelay } from './recovery-relay.mjs';
const allowedPageUrl = 'https://business.kakao.com/space/test/channel/_test/chats';
const frame = {};
const source = { page: { url: () => allowedPageUrl, mainFrame: () => frame }, frame };
const message = { type: 'village_kakao_bridge_event', bridgeUrl: 'http://127.0.0.1:8787/events', event: { source: 'kakao_channel_manager_dom', url: allowedPageUrl, eventHash: 'synthetic' } };
test('relay only forwards to recovery-only endpoint after exact collector identity readback', async () => {
  const requests = [];
  const relay = createRecoveryRelay({ allowedPageUrl, runId: 'test-run', request: async (url, options) => {
    requests.push({ url, options });
    return { ok: true, json: async () => url.endsWith('/health')
      ? { mode: 'recovery_collect_only', runId: 'test-run', businessAutomationReady: false, customerSendingEnabled: false }
      : { persisted: true, processed: false, mode: 'recovery_collect_only', runId: 'test-run' } };
  }});
  assert.equal((await relay(source, message)).ok, true);
  assert.deepEqual(requests.map(r => r.url), ['http://127.0.0.1:8787/health', 'http://127.0.0.1:8787/recovery-events']);
  assert.deepEqual(JSON.parse(requests[1].options.body), message.event);
});
test('foreign page, iframe, URL and invalid event never perform a host request', async () => {
  let calls = 0;
  const relay = createRecoveryRelay({ allowedPageUrl, runId: 'test-run', request: async () => { calls++; throw Error('must not call'); } });
  const wrongSource = { page: { url: () => 'https://example.org', mainFrame: () => frame }, frame };
  for (const [s, m] of [[wrongSource,message], [{...source,frame:{}},message], [source,{...message,bridgeUrl:'http://127.0.0.1:8787/manual-send'}], [source,{...message,event:[]}], [source,{...message,event:{...message.event,url:'https://example.org'}}]]) {
    assert.equal((await relay(s,m)).ok,false);
  }
  assert.equal(calls,0);
});
test('switching to production, changed owner, and failed persistence cannot be acknowledged', async () => {
  for (const health of [
    { mode: 'production', runId:'test-run', businessAutomationReady:true },
    { mode:'recovery_collect_only',runId:'different',businessAutomationReady:false,customerSendingEnabled:false }
  ]) {
    let posts=0;
    const relay=createRecoveryRelay({allowedPageUrl,runId:'test-run',request:async(_url,options)=>{if(options?.method==='POST')posts++;return{ok:true,json:async()=>health}}});
    assert.equal((await relay(source,message)).ok,false);assert.equal(posts,0);
  }
});

test('missing durable receipt is a rejected delivery', async () => {
 const relay = createRecoveryRelay({ allowedPageUrl, runId:'test-run',request:async url=>({ok:true,json:async()=>url.endsWith('/health')?{mode:'recovery_collect_only',runId:'test-run',businessAutomationReady:false,customerSendingEnabled:false}:{persisted:false,processed:false,mode:'recovery_collect_only',runId:'test-run'}})});
 assert.equal((await relay(source,message)).ok,false);
});
