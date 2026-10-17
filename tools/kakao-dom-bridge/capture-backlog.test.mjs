import test from 'node:test';
import assert from 'node:assert/strict';
import { readCaptureBacklog } from './capture-backlog.mjs';

const config = { supabaseUrl: 'https://example.supabase.co', supabaseServiceRoleKey: 'test-only', supabaseTable: 'ai_processing_events' };
test('health stays blocked by a capture failure even when the Gateway queue is empty', async () => {
  const result = await readCaptureBacklog(config, { fetchImpl: async (url, init) => {
    if (new URL(url).pathname.endsWith('/work_items_v2')) return new Response('[]', { headers: { 'content-range':'*/0' } });
    const q = new URL(url).searchParams;
    assert.equal(init.method, 'GET');
    assert.equal(q.get('status'), 'in.(ai_worker_error,needs_human_review)');
    assert.equal(q.get('payload->ai_worker_result->>error_type'), 'eq.kakao_conversation_evidence_unavailable');
    assert.equal(q.has('created_at'), false, 'outages must not disappear merely by ageing out');
    return new Response(JSON.stringify(['dom-test','dom-test2','dom-test3'].map(event_hash=>({event_hash,room_key:'chat:123',detected_at:'2026-10-17T13:59:30.228Z'}))), {
      headers: { 'content-range': '0-0/3' }
    });
  } });
  assert.equal(result.status, 'blocked');
  assert.equal(result.unresolved, 3);
  assert.equal(result.oldestJobId, 'dom-test');
});

test('only a source-and-room-bound completed reconciliation clears the failed source event', async () => {
  const failed = {event_hash:'dom-test',room_key:'chat:123',detected_at:'2026-10-17T13:59:30.228Z'};
  const completed = {work_key:'capture-reconciliation:dom-test',room_key:'chat:123',source_event_keys:['dom-test'],
    state:'resolved',resolution_kind:'owner_completed',resolved_at:'2026-10-18T00:00:00Z',resolved_by:'heybilli:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'};
  const run = (row) => readCaptureBacklog(config, {fetchImpl:async url=>new Response(JSON.stringify(
    new URL(url).pathname.endsWith('/work_items_v2') ? [row] : [failed]
  ),{headers:{'content-range':'0-0/1'}})});
  assert.equal((await run(completed)).status,'clear');
  for(const patch of [{state:'open'},{state:'dismissed'},{room_key:'chat:other'},{source_event_keys:[]},{resolved_by:''},{resolved_at:'2026-10-16T00:00:00Z'}]) {
    assert.equal((await run({...completed,...patch})).status,'blocked');
  }
});
test('only authoritative empty readback clears capture backlog', async () => {
  assert.equal((await readCaptureBacklog(config, { fetchImpl: async () => new Response('[]', { headers: { 'content-range': '*/0' } }) })).status, 'clear');
  for (const response of [new Response('{}'), new Response('[]'), new Response('error', { status: 503 })]) {
    assert.equal((await readCaptureBacklog(config, { fetchImpl: async () => response })).status, 'unknown');
  }
  const failed = await readCaptureBacklog(config, { fetchImpl: async () => { throw Error('private network detail'); } });
  assert.equal(failed.status, 'unknown');
  assert.doesNotMatch(JSON.stringify(failed), /private/);
});
