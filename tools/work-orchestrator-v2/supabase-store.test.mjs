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

test('getOldestPendingNotificationCreatedAt reads one bounded content-free durable backlog row', async () => {
  const fetch = createFetch([response({ data: [{ created_at: '2026-08-29T00:00:00.000Z' }] })]);
  const store = createWorkOrchestratorStore({ supabaseUrl: 'https://supabase.example/', serviceRoleKey, fetchImpl: fetch.fetchImpl });

  assert.equal(await store.getOldestPendingNotificationCreatedAt(), '2026-08-29T00:00:00.000Z');
  assert.equal(
    fetch.requests[0].url,
    'https://supabase.example/rest/v1/message_notification_receipts?select=created_at&notification_state=in.%28pending%2Cdelivering%2Cfailed%29&order=created_at.asc&limit=1'
  );
  assert.equal(fetch.requests[0].init.method, undefined);
  assert.doesNotMatch(fetch.requests[0].url, /payload|preview|customer|room|channel|token/i);
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

test('transitionNotification permits a delivery retry only when every source state can reach the target', async () => {
  const fetch = createFetch([response({ data: [{ id: 'receipt-1', notification_state: 'delivering' }] })]);
  const store = createWorkOrchestratorStore({ supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl });

  const result = await store.transitionNotification({
    id: 'receipt-1',
    fromStates: ['pending', 'failed'],
    toState: 'delivering'
  });

  assert.equal(result.applied, true);
  assert.equal(fetch.requests.length, 1);
  assert.equal(fetch.requests[0].url, 'https://supabase.example/rest/v1/message_notification_receipts?id=eq.receipt-1&notification_state=in.%28pending%2Cfailed%29&select=*');
});

test('transitionNotification rejects illegal and mixed source edges before any request', async () => {
  const fetch = createFetch();
  const store = createWorkOrchestratorStore({ supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl });

  await assert.rejects(
    store.transitionNotification({ id: 'receipt-1', fromStates: ['deleted'], toState: 'delivering' }),
    { message: 'Work Orchestrator Supabase transition input is invalid' }
  );
  await assert.rejects(
    store.transitionNotification({ id: 'receipt-1', fromStates: ['pending', 'delivering'], toState: 'delivering' }),
    { message: 'Work Orchestrator Supabase transition input is invalid' }
  );
  await assert.rejects(
    store.transitionNotification({ id: 'receipt-1', fromStates: ['unknown'], toState: 'delivering' }),
    { message: 'Work Orchestrator Supabase transition input is invalid' }
  );
  assert.equal(fetch.requests.length, 0);
});

test('transitionNotification reports no application for an empty representation', async () => {
  const fetch = createFetch([response({ data: [] })]);
  const store = createWorkOrchestratorStore({ supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl });

  assert.deepEqual(
    await store.transitionNotification({ id: 'receipt-1', fromStates: ['pending'], toState: 'delivering' }),
    { applied: false, row: null }
  );
});

test('claimNotificationDelivery atomically compares the observed attempt count for concurrent callers', async () => {
  let claimed = false;
  const requests = [];
  const store = createWorkOrchestratorStore({
    supabaseUrl: 'https://supabase.example',
    serviceRoleKey,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      if (claimed) return response({ data: [] });
      claimed = true;
      return response({ data: [{ id: 'receipt-1', notification_state: 'delivering', delivery_attempts: 2 }] });
    }
  });

  const results = await Promise.all([
    store.claimNotificationDelivery({ id: 'receipt-1', expectedDeliveryAttempts: 1 }),
    store.claimNotificationDelivery({ id: 'receipt-1', expectedDeliveryAttempts: 1 })
  ]);

  assert.equal(results.filter(({ applied }) => applied).length, 1);
  assert.equal(results.filter(({ applied }) => !applied).length, 1);
  assert.deepEqual(requests.map(({ url }) => url), [
    'https://supabase.example/rest/v1/message_notification_receipts?id=eq.receipt-1&notification_state=in.%28pending%2Cfailed%29&delivery_attempts=eq.1&select=*',
    'https://supabase.example/rest/v1/message_notification_receipts?id=eq.receipt-1&notification_state=in.%28pending%2Cfailed%29&delivery_attempts=eq.1&select=*'
  ]);
  assert.deepEqual(requests.map(({ init }) => JSON.parse(init.body)), [
    { delivery_attempts: 2, last_delivery_error: null, notification_state: 'delivering' },
    { delivery_attempts: 2, last_delivery_error: null, notification_state: 'delivering' }
  ]);
});

test('claimNotificationDelivery fails closed at the three-attempt cap without a request', async () => {
  const fetch = createFetch();
  const store = createWorkOrchestratorStore({ supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl });

  assert.deepEqual(
    await store.claimNotificationDelivery({ id: 'receipt-1', expectedDeliveryAttempts: 3 }),
    { applied: false, row: null }
  );
  assert.equal(fetch.requests.length, 0);
});

test('markNotificationDelivered stores exact coordinates only from delivering and clears the prior error', async () => {
  const fetch = createFetch([response({ data: [{ id: 'receipt-1', notification_state: 'delivered' }] })]);
  const store = createWorkOrchestratorStore({ supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl });

  const result = await store.markNotificationDelivered({
    id: 'receipt-1',
    channelId: 'CINBOX',
    messageTs: '100.1',
    deliveredAt: '2026-08-29T00:01:00.000Z'
  });

  assert.equal(result.applied, true);
  assert.equal(fetch.requests[0].url, 'https://supabase.example/rest/v1/message_notification_receipts?id=eq.receipt-1&notification_state=in.%28delivering%29&select=*');
  assert.deepEqual(JSON.parse(fetch.requests[0].init.body), {
    slack_channel_id: 'CINBOX',
    slack_message_ts: '100.1',
    delivered_at: '2026-08-29T00:01:00.000Z',
    last_delivery_error: null,
    notification_state: 'delivered'
  });
});

test('markNotificationFailed persists only a bounded reviewed token and no nonexistent attempted-at column', async () => {
  const fetch = createFetch([response({ data: [{ id: 'receipt-1', notification_state: 'failed' }] })]);
  const store = createWorkOrchestratorStore({ supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl });

  const result = await store.markNotificationFailed({ id: 'receipt-1', failureCode: 'delivery_unconfirmed' });

  assert.equal(result.applied, true);
  assert.equal(fetch.requests[0].url, 'https://supabase.example/rest/v1/message_notification_receipts?id=eq.receipt-1&notification_state=in.%28delivering%29&select=*');
  assert.deepEqual(JSON.parse(fetch.requests[0].init.body), {
    last_delivery_error: 'delivery_unconfirmed',
    notification_state: 'failed'
  });
  assert.equal('attempted_at' in JSON.parse(fetch.requests[0].init.body), false);
});

test('markNotificationFailed rejects arbitrary failure text before any request', async () => {
  const fetch = createFetch();
  const store = createWorkOrchestratorStore({ supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl });

  await assert.rejects(
    store.markNotificationFailed({ id: 'receipt-1', failureCode: `customer room token ${serviceRoleKey}` }),
    (error) => error.message === 'Work Orchestrator Supabase transition input is invalid'
      && !error.message.includes(serviceRoleKey)
  );
  assert.equal(fetch.requests.length, 0);
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

test('non-2xx errors replace oversized PostgREST codes with unknown', async () => {
  const oversizedCode = `PGRST${'9'.repeat(400)}`;
  const fetch = createFetch([response({ ok: false, status: 500, data: { code: oversizedCode, detail: serviceRoleKey } })]);
  const store = createWorkOrchestratorStore({ supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl });

  await assert.rejects(
    store.getNotificationByEventKey('event-1'),
    (error) => /HTTP 500, code unknown/.test(error.message)
      && !error.message.includes(oversizedCode)
      && !error.message.includes(serviceRoleKey)
  );
});

test('non-2xx errors preserve a fixed-width PostgreSQL SQLSTATE without secrets', async () => {
  const fetch = createFetch([response({ ok: false, status: 400, data: { code: '42P01', detail: serviceRoleKey } })]);
  const store = createWorkOrchestratorStore({ supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl });

  await assert.rejects(
    store.getNotificationByEventKey('event-1'),
    (error) => /HTTP 400, code 42P01/.test(error.message) && !error.message.includes(serviceRoleKey)
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
