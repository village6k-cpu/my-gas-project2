import assert from 'node:assert/strict';
import test from 'node:test';

import { createWorkOrchestratorStore } from './supabase-store.mjs';

const serviceRoleKey = 'test-service-role';
const receipt = {
  source: 'kakao_channel_manager_dom',
  sourceEventKey: 'event-1',
  sourceMessageId: 'message-1',
  clientMessageId: 'b1d33dc4-d1f9-550b-a345-1525035f5e45',
  roomKey: 'chat:1',
  receivedAt: '2026-08-29T00:00:00.000Z',
  payload: { previewText: '문의' }
};

function response({ ok = true, status = 200, data = null, contentRange = null } = {}) {
  return {
    ok,
    status,
    text: async () => data === null ? '' : JSON.stringify(data),
    headers: { get: (name) => name === 'content-range' ? contentRange : null }
  };
}

function createFetch(responses = []) {
  const requests = [];
  return {
    requests,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return responses.shift() ?? response();
    }
  };
}

test('claimNotificationReceipt sends the normalized receipt to the reviewed RPC signature', async () => {
  const fetch = createFetch([response({ data: { created: true, row: { id: 'receipt-1' } } })]);
  const store = createWorkOrchestratorStore({
    supabaseUrl: 'https://supabase.example',
    serviceRoleKey,
    fetchImpl: fetch.fetchImpl
  });

  const claimed = await store.claimNotificationReceipt(receipt);

  assert.equal(fetch.requests[0].url, 'https://supabase.example/rest/v1/rpc/claim_message_notification_receipt');
  assert.equal(fetch.requests[0].init.method, 'POST');
  assert.equal(fetch.requests[0].init.headers.apikey, serviceRoleKey);
  assert.equal(fetch.requests[0].init.headers.authorization, `Bearer ${serviceRoleKey}`);
  assert.deepEqual(JSON.parse(fetch.requests[0].init.body), {
    p_source: 'kakao_channel_manager_dom',
    p_source_event_key: 'event-1',
    p_source_message_id: 'message-1',
    p_room_key: 'chat:1',
    p_received_at: '2026-08-29T00:00:00.000Z',
    p_client_message_id: 'b1d33dc4-d1f9-550b-a345-1525035f5e45',
    p_payload: { previewText: '문의' }
  });
  assert.equal(claimed.created, true);
});

test('getNotificationByEventKey URL-encodes an event-key filter', async () => {
  const fetch = createFetch([response({ data: [{ id: 'receipt-1' }] })]);
  const store = createWorkOrchestratorStore({ supabaseUrl: 'https://supabase.example/', serviceRoleKey, fetchImpl: fetch.fetchImpl });

  const row = await store.getNotificationByEventKey('event?key&one');

  assert.equal(row.id, 'receipt-1');
  assert.equal(fetch.requests[0].url, 'https://supabase.example/rest/v1/message_notification_receipts?select=*&source_event_key=eq.event%3Fkey%26one&limit=1');
});

test('transitionNotification PATCHes only the requested id and source states', async () => {
  const fetch = createFetch([response({ data: [{ id: 'receipt-1', notification_state: 'delivering' }] })]);
  const store = createWorkOrchestratorStore({ supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl });

  const result = await store.transitionNotification({
    id: 'receipt-1',
    fromStates: ['pending'],
    toState: 'delivering',
    patch: { delivery_attempts: 1 }
  });

  assert.deepEqual(result, { applied: true, row: { id: 'receipt-1', notification_state: 'delivering' } });
  assert.equal(fetch.requests[0].init.method, 'PATCH');
  assert.equal(fetch.requests[0].url, 'https://supabase.example/rest/v1/message_notification_receipts?id=eq.receipt-1&notification_state=in.%28pending%29&select=*');
  assert.deepEqual(JSON.parse(fetch.requests[0].init.body), { delivery_attempts: 1, notification_state: 'delivering' });
});

test('transitionNotification reports no application for an empty representation', async () => {
  const fetch = createFetch([response({ data: [] })]);
  const store = createWorkOrchestratorStore({ supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl });

  assert.deepEqual(
    await store.transitionNotification({ id: 'receipt-1', fromStates: ['pending'], toState: 'delivering' }),
    { applied: false, row: null }
  );
});

test('transitionNotification rejects incomplete transition inputs before any request', async () => {
  const fetch = createFetch();
  const store = createWorkOrchestratorStore({ supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl });

  await assert.rejects(store.transitionNotification({ id: '', fromStates: ['pending'], toState: 'delivering' }), /transition input is invalid/i);
  await assert.rejects(store.transitionNotification({ id: 'receipt-1', fromStates: [], toState: 'delivering' }), /transition input is invalid/i);
  await assert.rejects(store.transitionNotification({ id: 'receipt-1', fromStates: ['pending'], toState: '' }), /transition input is invalid/i);
  assert.equal(fetch.requests.length, 0);
});

test('counts uses HEAD requests with URL-encoded state filters', async () => {
  const fetch = createFetch([
    response({ contentRange: '0-0/3' }),
    response({ contentRange: '0-0/2' }),
    response({ contentRange: '0-0/1' })
  ]);
  const store = createWorkOrchestratorStore({ supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl });

  assert.deepEqual(await store.counts(), { pendingNotifications: 3, activeWorkItems: 2, unfinishedDigests: 1 });
  assert.deepEqual(fetch.requests.map(({ url, init }) => [url, init.method, init.headers.range, init.headers.prefer]), [
    ['https://supabase.example/rest/v1/message_notification_receipts?select=id&notification_state=in.%28pending%2Cdelivering%2Cfailed%2Ccleanup_pending%29', 'HEAD', '0-0', 'count=exact'],
    ['https://supabase.example/rest/v1/work_items_v2?select=id&state=in.%28open%2Cin_progress%2Csnoozed%29', 'HEAD', '0-0', 'count=exact'],
    ['https://supabase.example/rest/v1/digest_runs?select=id&state=in.%28building%2Cfailed%29', 'HEAD', '0-0', 'count=exact']
  ]);
});

test('store rejects missing configuration without revealing the service role key', () => {
  assert.throws(
    () => createWorkOrchestratorStore({ supabaseUrl: 'https://supabase.example', serviceRoleKey: '' }),
    (error) => /configuration is missing/i.test(error.message) && !error.message.includes(serviceRoleKey)
  );
});

test('non-2xx errors include status and safe response code without secrets or bodies', async () => {
  const fetch = createFetch([response({ ok: false, status: 403, data: { code: 'PGRST301', detail: `body ${serviceRoleKey}`, payload: receipt } })]);
  const store = createWorkOrchestratorStore({ supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl });

  await assert.rejects(
    store.getNotificationByEventKey('event-1'),
    (error) => /HTTP 403, code PGRST301/.test(error.message)
      && !error.message.includes(serviceRoleKey)
      && !error.message.includes('body')
      && !error.message.includes('event-1')
  );
});

test('thrown fetch errors are bounded and never reveal the service role key', async () => {
  const store = createWorkOrchestratorStore({
    supabaseUrl: 'https://supabase.example',
    serviceRoleKey,
    fetchImpl: async () => { throw new Error(`network failed with Bearer ${serviceRoleKey} and ${JSON.stringify(receipt)}`); }
  });

  await assert.rejects(
    store.getNotificationByEventKey('event-1'),
    (error) => /network error/i.test(error.message)
      && !error.message.includes(serviceRoleKey)
      && !error.message.includes('event-1')
  );
});
