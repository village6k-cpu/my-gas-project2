import assert from 'node:assert/strict';
import test from 'node:test';

import { createWorkOrchestratorStore } from './supabase-store.mjs';

const serviceRoleKey = 'test-service-role';
const WORK_ID = '11111111-1111-4111-8111-111111111111';
const DIGEST_ID = '22222222-2222-4222-8222-222222222222';
const PREVIOUS_DIGEST_ID = '33333333-3333-4333-8333-333333333333';
const LEASE_TOKEN = '44444444-4444-4444-8444-444444444444';
const receipt = {
  source: 'kakao_channel_manager_dom',
  sourceEventKey: 'event-1',
  sourceMessageId: 'message-1',
  clientMessageId: 'b1d33dc4-d1f9-550b-a345-1525035f5e45',
  roomKey: 'chat:1',
  receivedAt: '2026-08-29T00:00:00.000Z',
  payload: { previewText: '문의' }
};
const workCandidate = {
  work_key: 'room:1:payment',
  source_event_keys: ['event-1'],
  room_key: 'room:1',
  title: 'Payment review',
  summary: 'Verify the typed payment outcome.',
  work_type: 'payment_check',
  priority: 'normal',
  state: 'open',
  owner_id: 'UOWNER',
  actionable_at: '2026-08-29T00:00:00.000Z',
  due_at: null,
  snoozed_until: null,
  first_opened_at: '2026-08-29T00:00:00.000Z',
  last_activity_at: '2026-08-29T00:00:00.000Z',
  automation_state: 'needs_human',
  payload: { requires_human_action: true, action_family: 'payment_reconcile' }
};

function workRow(overrides = {}) {
  return {
    id: WORK_ID,
    work_key: 'room:1:payment',
    room_key: 'room:1',
    title: 'Payment review',
    summary: 'Verify the typed payment outcome.',
    work_type: 'payment_check',
    priority: 'normal',
    state: 'open',
    owner_id: 'UOWNER',
    actionable_at: '2026-08-29T00:00:00.000Z',
    due_at: null,
    snoozed_until: null,
    first_opened_at: '2026-08-20T00:00:00.000Z',
    last_activity_at: '2026-08-29T00:00:00.000Z',
    digest_inclusion_count: 0,
    consecutive_unhandled_digests: 0,
    last_digest_at: null,
    next_reminder_at: '2026-08-23T00:00:00.000Z',
    version: 1,
    payload: { requires_human_action: true },
    ...overrides
  };
}

function digestRow(overrides = {}) {
  return {
    id: DIGEST_ID,
    destination_key: 'slack:CINBOX',
    scheduled_at: '2026-08-29T03:00:00.000Z',
    state: 'building',
    lease_owner: 'bridge:test',
    lease_token: LEASE_TOKEN,
    lease_expires_at: '2026-08-29T03:02:00.000Z',
    previous_digest_id: PREVIOUS_DIGEST_ID,
    item_snapshot: [],
    slack_channel_id: null,
    slack_message_ts: null,
    delivered_at: null,
    ...overrides
  };
}

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
    expectedDeliveryAttempts: 2,
    channelId: 'CINBOX',
    messageTs: '100.1',
    deliveredAt: '2026-08-29T00:01:00.000Z'
  });

  assert.equal(result.applied, true);
  assert.equal(fetch.requests[0].url, 'https://supabase.example/rest/v1/message_notification_receipts?id=eq.receipt-1&notification_state=in.%28delivering%29&delivery_attempts=eq.2&select=*');
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

  const result = await store.markNotificationFailed({
    id: 'receipt-1',
    expectedDeliveryAttempts: 2,
    failureCode: 'delivery_unconfirmed'
  });

  assert.equal(result.applied, true);
  assert.equal(fetch.requests[0].url, 'https://supabase.example/rest/v1/message_notification_receipts?id=eq.receipt-1&notification_state=in.%28delivering%29&delivery_attempts=eq.2&select=*');
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
    store.markNotificationFailed({
      id: 'receipt-1', expectedDeliveryAttempts: 1, failureCode: `customer room token ${serviceRoleKey}`
    }),
    (error) => error.message === 'Work Orchestrator Supabase transition input is invalid'
      && !error.message.includes(serviceRoleKey)
  );
  assert.equal(fetch.requests.length, 0);
});

test('terminal notification transitions reject missing or non-positive delivery generations before requests', async () => {
  const fetch = createFetch();
  const store = createWorkOrchestratorStore({
    supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl
  });

  for (const expectedDeliveryAttempts of [undefined, 0, -1, 1.5, '1']) {
    await assert.rejects(
      store.markNotificationDelivered({
        id: 'receipt-1', expectedDeliveryAttempts, channelId: 'CINBOX', messageTs: '100.1',
        deliveredAt: '2026-08-29T00:01:00.000Z'
      }),
      (error) => error.message === 'Work Orchestrator Supabase transition input is invalid'
    );
    await assert.rejects(
      store.markNotificationFailed({ id: 'receipt-1', expectedDeliveryAttempts, failureCode: 'post_rejected' }),
      (error) => error.message === 'Work Orchestrator Supabase transition input is invalid'
    );
  }
  assert.equal(fetch.requests.length, 0);
});

test('stale terminal writers are observable as empty generation CAS results', async () => {
  const fetch = createFetch([response({ data: [] }), response({ data: [] })]);
  const store = createWorkOrchestratorStore({
    supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl
  });

  assert.deepEqual(await store.markNotificationDelivered({
    id: 'receipt-1', expectedDeliveryAttempts: 1, channelId: 'CINBOX', messageTs: '100.1',
    deliveredAt: '2026-08-29T00:01:00.000Z'
  }), { applied: false, row: null });
  assert.deepEqual(await store.markNotificationFailed({
    id: 'receipt-1', expectedDeliveryAttempts: 1, failureCode: 'delivery_unconfirmed'
  }), { applied: false, row: null });
  assert.ok(fetch.requests.every(({ url }) => url.includes('delivery_attempts=eq.1')));
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

test('upsertWorkItem sends only the reviewed bounded candidate to the atomic RPC', async () => {
  const fetch = createFetch([response({ data: { applied: true, created: true, row: workRow() } })]);
  const store = createWorkOrchestratorStore({ supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl });

  const result = await store.upsertWorkItem({
    ...workCandidate,
    version: 99,
    digest_inclusion_count: 99,
    pending_action: { type: 'dismiss' },
    resolution_evidence: { customer: 'must-not-cross-rpc-boundary' }
  });

  assert.equal(fetch.requests[0].url, 'https://supabase.example/rest/v1/rpc/upsert_work_item_v2');
  assert.equal(fetch.requests[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(fetch.requests[0].init.body), { p_candidate: workCandidate });
  assert.deepEqual(result, { applied: true, created: true, row: workRow() });
});

test('requestWorkAction preserves exact id/version action CAS and exposes stale no-op', async () => {
  const fetch = createFetch([
    response({ data: { applied: true, row: workRow({ version: 5, pending_action: {
      type: 'request_resolve', action: { type: 'request_resolve' }, status: 'pending',
      requested_at: '2026-08-29T01:00:00.000Z', requested_by: 'UOWNER', expected_version: 4
    } }) } }),
    response({ data: { applied: false, row: null } })
  ]);
  const store = createWorkOrchestratorStore({ supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl });
  const input = {
    id: '11111111-1111-4111-8111-111111111111',
    expectedVersion: 4,
    action: { type: 'request_resolve' },
    requestedBy: 'UOWNER'
  };

  assert.equal((await store.requestWorkAction(input)).applied, true);
  assert.deepEqual(await store.requestWorkAction(input), { applied: false, row: null });
  assert.ok(fetch.requests.every(({ url }) => url === 'https://supabase.example/rest/v1/rpc/request_work_item_action_v2'));
  assert.deepEqual(JSON.parse(fetch.requests[0].init.body), {
    p_id: input.id,
    p_expected_version: 4,
    p_action: { type: 'request_resolve' },
    p_requested_by: 'UOWNER'
  });
});

test('listActionableWork selects a bounded deterministic digest surface including unresolved P0', async () => {
  const fetch = createFetch([response({ data: [workRow({
    priority: 'p0', actionable_at: '2099-01-01T00:00:00.000Z', payload: { requires_human_action: true }
  })] })]);
  const store = createWorkOrchestratorStore({ supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl });

  const rows = await store.listActionableWork({ now: '2026-08-29T03:00:00.000Z', limit: 50 });

  assert.equal(rows.length, 1);
  assert.equal(fetch.requests[0].url, 'https://supabase.example/rest/v1/rpc/list_actionable_work_v2');
  assert.equal(fetch.requests[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(fetch.requests[0].init.body), {
    p_now: '2026-08-29T03:00:00.000Z', p_limit: 50
  });
});

test('claimDigestRun sends exact lease inputs and preserves the one-winner result shape', async () => {
  const fetch = createFetch([
    response({ data: {
      claimed: true, created: true, row: digestRow(),
      previous_digest: { id: PREVIOUS_DIGEST_ID, slack_channel_id: 'COLD', slack_message_ts: '100.10' }
    } }),
    response({ data: {
      claimed: false, created: false, row: digestRow(),
      previous_digest: { id: PREVIOUS_DIGEST_ID, slack_channel_id: 'COLD', slack_message_ts: '100.10' }
    } })
  ]);
  const store = createWorkOrchestratorStore({ supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl });
  const input = {
    destinationKey: 'slack:CINBOX',
    scheduledAt: '2026-08-29T03:00:00.000Z',
    windowStartedAt: '2026-08-29T00:00:00.000Z',
    windowEndedAt: '2026-08-29T03:00:00.000Z',
    leaseOwner: 'bridge:test',
    leaseSeconds: 120
  };

  const first = await store.claimDigestRun(input);
  const second = await store.claimDigestRun(input);

  assert.equal(first.claimed, true);
  assert.equal(second.claimed, false);
  assert.equal(first.row.lease_token, LEASE_TOKEN);
  assert.deepEqual(first.previous_digest, {
    id: PREVIOUS_DIGEST_ID, slack_channel_id: 'COLD', slack_message_ts: '100.10'
  });
  assert.deepEqual(JSON.parse(fetch.requests[0].init.body), {
    p_destination_key: 'slack:CINBOX',
    p_scheduled_at: '2026-08-29T03:00:00.000Z',
    p_window_started_at: '2026-08-29T00:00:00.000Z',
    p_window_ended_at: '2026-08-29T03:00:00.000Z',
    p_lease_owner: 'bridge:test',
    p_lease_seconds: 120
  });
});

test('finalizeDigestRun sends a content-free versioned snapshot and exact lease owner', async () => {
  const itemSnapshot = [{
    id: WORK_ID, version: 4, inclusionReason: 'overdue', priority: 'urgent'
  }];
  const fetch = createFetch([response({ data: { applied: true, row: digestRow({
    state: 'delivered', lease_owner: null, lease_token: null, lease_expires_at: null,
    item_snapshot: itemSnapshot, slack_channel_id: 'CINBOX', slack_message_ts: '123.45',
    delivered_at: '2026-08-29T03:00:05.000Z'
  }), updated_count: 1 } })]);
  const store = createWorkOrchestratorStore({ supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl });

  const result = await store.finalizeDigestRun({
    id: DIGEST_ID,
    leaseOwner: 'bridge:test',
    leaseToken: LEASE_TOKEN,
    itemSnapshot,
    channelId: 'CINBOX',
    messageTs: '123.45',
    deliveredAt: '2026-08-29T03:00:05.000Z'
  });

  assert.equal(result.applied, true);
  assert.deepEqual(JSON.parse(fetch.requests[0].init.body), {
    p_id: '22222222-2222-4222-8222-222222222222',
    p_lease_owner: 'bridge:test',
    p_lease_token: LEASE_TOKEN,
    p_item_snapshot: itemSnapshot,
    p_slack_channel_id: 'CINBOX',
    p_slack_message_ts: '123.45',
    p_delivered_at: '2026-08-29T03:00:05.000Z'
  });
  assert.deepEqual(Object.keys(itemSnapshot[0]).sort(), ['id', 'inclusionReason', 'priority', 'version']);
});

test('finalizeDigestRun accepts an empty snapshot only with null Slack coordinates and surfaces stale lease no-op', async () => {
  const fetch = createFetch([
    response({ data: { applied: true, row: digestRow({
      state: 'delivered', lease_owner: null, lease_token: null, lease_expires_at: null,
      item_snapshot: [], slack_channel_id: null, slack_message_ts: null,
      delivered_at: '2026-08-29T03:00:05.000Z'
    }), updated_count: 0 } }),
    response({ data: { applied: false, row: null, updated_count: 0 } })
  ]);
  const store = createWorkOrchestratorStore({ supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl });
  const input = {
    id: DIGEST_ID, leaseOwner: 'bridge:test', leaseToken: LEASE_TOKEN, itemSnapshot: [],
    deliveredAt: '2026-08-29T03:00:05.000Z'
  };

  assert.equal((await store.finalizeDigestRun({
    ...input, channelId: null, messageTs: null
  })).updated_count, 0);
  assert.deepEqual(await store.finalizeDigestRun(input), { applied: false, row: null, updated_count: 0 });
  assert.equal(JSON.parse(fetch.requests[0].init.body).p_slack_channel_id, null);
  assert.equal(JSON.parse(fetch.requests[0].init.body).p_slack_message_ts, null);
});

test('finalizeDigestRun rejects provided coordinates for an empty snapshot before fetch', async () => {
  const fetch = createFetch();
  const store = createWorkOrchestratorStore({
    supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl
  });
  const base = {
    id: DIGEST_ID, leaseOwner: 'bridge:test', leaseToken: LEASE_TOKEN, itemSnapshot: [],
    deliveredAt: '2026-08-29T03:00:05.000Z'
  };

  await assert.rejects(
    store.finalizeDigestRun({ ...base, channelId: 'CINBOX' }),
    { message: 'Work Orchestrator Supabase input is invalid' }
  );
  await assert.rejects(
    store.finalizeDigestRun({ ...base, messageTs: '123.45' }),
    { message: 'Work Orchestrator Supabase input is invalid' }
  );
  assert.equal(fetch.requests.length, 0);
});

test('failDigestRun sends only an allowlisted error token and exact owner plus generation fencing', async () => {
  const fetch = createFetch([response({ data: { applied: true, row: digestRow({
    state: 'failed', error: 'digest_delivery_failed'
  }) } })]);
  const store = createWorkOrchestratorStore({ supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl });

  await store.failDigestRun({
    id: DIGEST_ID, leaseOwner: 'bridge:test', leaseToken: LEASE_TOKEN,
    error: 'digest_delivery_failed'
  });

  assert.deepEqual(JSON.parse(fetch.requests[0].init.body), {
    p_id: '22222222-2222-4222-8222-222222222222',
    p_lease_owner: 'bridge:test',
    p_lease_token: LEASE_TOKEN,
    p_error: 'digest_delivery_failed'
  });
});

test('work and digest methods reject unbounded or content-bearing input before requests', async () => {
  const fetch = createFetch();
  const store = createWorkOrchestratorStore({ supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl });

  await assert.rejects(store.upsertWorkItem({ ...workCandidate, work_key: ' x ' }), /input is invalid/i);
  await assert.rejects(store.upsertWorkItem({ ...workCandidate, work_type: 'completed_log' }), /input is invalid/i);
  await assert.rejects(store.requestWorkAction({
    id: '11111111-1111-4111-8111-111111111111', expectedVersion: 1,
    action: { type: 'request_resolve', customer: serviceRoleKey }, requestedBy: 'U'
  }), /input is invalid/i);
  await assert.rejects(store.finalizeDigestRun({
    id: DIGEST_ID, leaseOwner: 'bridge:test', leaseToken: LEASE_TOKEN,
    itemSnapshot: [{ id: '11111111-1111-4111-8111-111111111111', version: 1, inclusionReason: 'actionable', priority: 'normal', summary: serviceRoleKey }],
    channelId: 'C', messageTs: '1.1', deliveredAt: '2026-08-29T03:00:00.000Z'
  }), /input is invalid/i);
  await assert.rejects(store.failDigestRun({
    id: DIGEST_ID, leaseOwner: 'bridge:test', leaseToken: LEASE_TOKEN, error: serviceRoleKey
  }), (error) => /input is invalid/i.test(error.message) && !error.message.includes(serviceRoleKey));
  assert.equal(fetch.requests.length, 0);
});

test('requestWorkAction rejects non-future snooze requests before fetch', async () => {
  const fetch = createFetch();
  const store = createWorkOrchestratorStore({ supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl });
  await assert.rejects(store.requestWorkAction({
    id: WORK_ID,
    expectedVersion: 1,
    action: { type: 'snooze', snoozedUntil: '2026-08-29T02:00:00.000Z' },
    requestedBy: 'UOWNER',
    now: '2026-08-29T03:00:00.000Z'
  }), /input is invalid/i);
  assert.equal(fetch.requests.length, 0);
});

test('finalizeDigestRun canonicalizes snapshot UUIDs and validates nonempty Slack coordinates', async () => {
  const uppercaseId = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
  const lowercaseId = uppercaseId.toLowerCase();
  const snapshot = [{ id: lowercaseId, version: 1, inclusionReason: 'actionable', priority: 'normal' }];
  const fetch = createFetch([response({ data: { applied: true, row: digestRow({
    state: 'delivered', lease_owner: null, lease_token: null, lease_expires_at: null,
    item_snapshot: snapshot, slack_channel_id: 'CINBOX', slack_message_ts: '123.45',
    delivered_at: '2026-08-29T03:00:05.000Z'
  }), updated_count: 1 } })]);
  const store = createWorkOrchestratorStore({ supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl });

  await store.finalizeDigestRun({
    id: DIGEST_ID, leaseOwner: 'bridge:test', leaseToken: LEASE_TOKEN,
    itemSnapshot: [{ id: uppercaseId, version: 1, inclusionReason: 'actionable', priority: 'normal' }],
    channelId: 'CINBOX', messageTs: '123.45', deliveredAt: '2026-08-29T03:00:05.000Z'
  });
  assert.equal(JSON.parse(fetch.requests[0].init.body).p_item_snapshot[0].id, lowercaseId);

  const rejectedFetch = createFetch();
  const rejectedStore = createWorkOrchestratorStore({
    supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: rejectedFetch.fetchImpl
  });
  await assert.rejects(rejectedStore.finalizeDigestRun({
    id: DIGEST_ID, leaseOwner: 'bridge:test', leaseToken: LEASE_TOKEN,
    itemSnapshot: [{ id: WORK_ID, version: 1, inclusionReason: 'actionable', priority: 'normal' }],
    channelId: 'CINBOX', messageTs: 'not-a-slack-ts', deliveredAt: '2026-08-29T03:00:05.000Z'
  }), /input is invalid/i);
  assert.equal(rejectedFetch.requests.length, 0);
});

test('method-specific RPC validators reject typed-looking malformed response bodies generically', async () => {
  const malformed = [
    ['upsertWorkItem', workCandidate, { applied: 'true', created: true, row: workRow() }],
    ['requestWorkAction', {
      id: WORK_ID, expectedVersion: 1, action: { type: 'progress' }, requestedBy: 'UOWNER'
    }, { applied: true, row: workRow({ version: 1 }) }],
    ['claimDigestRun', {
      destinationKey: 'slack:CINBOX', scheduledAt: '2026-08-29T03:00:00.000Z',
      windowStartedAt: '2026-08-29T00:00:00.000Z', windowEndedAt: '2026-08-29T03:00:00.000Z',
      leaseOwner: 'bridge:test', leaseSeconds: 120
    }, { claimed: 'false', created: false, row: digestRow(), previous_digest: null }],
    ['finalizeDigestRun', {
      id: DIGEST_ID, leaseOwner: 'bridge:test', leaseToken: LEASE_TOKEN, itemSnapshot: [],
      deliveredAt: '2026-08-29T03:00:05.000Z'
    }, { applied: true, row: digestRow({ state: 'delivered' }), updated_count: '0' }],
    ['failDigestRun', {
      id: DIGEST_ID, leaseOwner: 'bridge:test', leaseToken: LEASE_TOKEN, error: 'digest_delivery_failed'
    }, { applied: true, row: digestRow({ state: 'delivered' }) }]
  ];

  for (const [method, input, data] of malformed) {
    const fetch = createFetch([response({ data })]);
    const store = createWorkOrchestratorStore({ supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl });
    await assert.rejects(
      store[method](input),
      (error) => error.message === 'Work Orchestrator Supabase request failed: response invalid'
        && !error.message.includes(JSON.stringify(data))
    );
  }
});

test('action and finalize responses compare JSON structurally across JSONB key ordering', async () => {
  const snoozedUntil = '2026-08-30T00:00:00.000Z';
  const snapshotInput = [{
    id: WORK_ID, version: 4, inclusionReason: 'overdue', priority: 'urgent'
  }];
  const postgresOrderedSnapshot = [{
    id: WORK_ID, version: 4, priority: 'urgent', inclusionReason: 'overdue'
  }];
  assert.deepEqual(
    Object.keys(postgresOrderedSnapshot[0]),
    ['id', 'version', 'priority', 'inclusionReason'],
    'fixture mirrors executable PGlite/PostgreSQL JSONB key ordering'
  );
  const fetch = createFetch([
    response({ data: { applied: true, row: workRow({
      version: 5,
      pending_action: {
        type: 'snooze',
        action: { snoozedUntil, type: 'snooze' },
        status: 'pending',
        requested_at: '2026-08-29T03:00:00.000Z',
        requested_by: 'UOWNER',
        expected_version: 4
      }
    }) } }),
    response({ data: {
      applied: true,
      row: digestRow({
        state: 'delivered', lease_owner: null, lease_token: null, lease_expires_at: null,
        item_snapshot: postgresOrderedSnapshot,
        slack_channel_id: 'CINBOX', slack_message_ts: '123.45',
        delivered_at: '2026-08-29T03:00:05.000Z'
      }),
      updated_count: 1
    } })
  ]);
  const store = createWorkOrchestratorStore({
    supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl
  });

  const action = await store.requestWorkAction({
    id: WORK_ID, expectedVersion: 4,
    action: { type: 'snooze', snoozedUntil }, requestedBy: 'UOWNER',
    now: '2026-08-29T03:00:00.000Z'
  });
  const finalized = await store.finalizeDigestRun({
    id: DIGEST_ID, leaseOwner: 'bridge:test', leaseToken: LEASE_TOKEN,
    itemSnapshot: snapshotInput, channelId: 'CINBOX', messageTs: '123.45',
    deliveredAt: '2026-08-29T03:00:05.000Z'
  });

  assert.equal(action.applied, true);
  assert.equal(finalized.applied, true);

  const extraFetch = createFetch([
    response({ data: { applied: true, row: workRow({
      version: 5,
      pending_action: {
        type: 'snooze',
        action: { type: 'snooze', snoozedUntil, extra: 'must-not-pass' },
        status: 'pending',
        requested_at: '2026-08-29T03:00:00.000Z',
        requested_by: 'UOWNER',
        expected_version: 4
      }
    }) } }),
    response({ data: {
      applied: true,
      row: digestRow({
        state: 'delivered', lease_owner: null, lease_token: null, lease_expires_at: null,
        item_snapshot: [{ ...postgresOrderedSnapshot[0], extra: 'must-not-pass' }],
        slack_channel_id: 'CINBOX', slack_message_ts: '123.45',
        delivered_at: '2026-08-29T03:00:05.000Z'
      }),
      updated_count: 1
    } })
  ]);
  const extraStore = createWorkOrchestratorStore({
    supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: extraFetch.fetchImpl
  });
  await assert.rejects(extraStore.requestWorkAction({
    id: WORK_ID, expectedVersion: 4,
    action: { type: 'snooze', snoozedUntil }, requestedBy: 'UOWNER',
    now: '2026-08-29T03:00:00.000Z'
  }), { message: 'Work Orchestrator Supabase request failed: response invalid' });
  await assert.rejects(extraStore.finalizeDigestRun({
    id: DIGEST_ID, leaseOwner: 'bridge:test', leaseToken: LEASE_TOKEN,
    itemSnapshot: snapshotInput, channelId: 'CINBOX', messageTs: '123.45',
    deliveredAt: '2026-08-29T03:00:05.000Z'
  }), { message: 'Work Orchestrator Supabase request failed: response invalid' });
});

test('listActionableWork rejects malformed and future acknowledged P0 rows from a bad response', async () => {
  const fetch = createFetch([
    response({ data: [{ ...workRow(), version: '1' }] }),
    response({ data: [workRow({
      priority: 'p0', actionable_at: '2099-01-01T00:00:00.000Z',
      payload: { requires_human_action: true, p0_acknowledged_at: '2026-08-29T00:00:00.000Z' }
    })] })
  ]);
  const store = createWorkOrchestratorStore({ supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl });
  await assert.rejects(
    store.listActionableWork({ now: '2026-08-29T03:00:00.000Z', limit: 50 }),
    { message: 'Work Orchestrator Supabase request failed: response invalid' }
  );
  await assert.rejects(
    store.listActionableWork({ now: '2026-08-29T03:00:00.000Z', limit: 50 }),
    { message: 'Work Orchestrator Supabase request failed: response invalid' }
  );
});

test('listActionableWork keeps missing or malformed P0 acknowledgements visible', async () => {
  const missingId = '55555555-5555-4555-8555-555555555555';
  const malformedId = '66666666-6666-4666-8666-666666666666';
  const fetch = createFetch([response({ data: [
    workRow({
      id: missingId, priority: 'p0', actionable_at: '2099-01-01T00:00:00.000Z',
      payload: { requires_human_action: true }
    }),
    workRow({
      id: malformedId, priority: 'p0', actionable_at: '2099-01-01T00:00:00.000Z',
      payload: { requires_human_action: true, p0_acknowledged_at: 'not-a-timestamp' }
    })
  ] })]);
  const store = createWorkOrchestratorStore({
    supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl
  });

  const rows = await store.listActionableWork({ now: '2026-08-29T03:00:00.000Z', limit: 50 });

  assert.deepEqual(rows.map((row) => row.id), [missingId, malformedId]);
});

test('listActionableWork uses the supplied cutoff for future and boundary P0 acknowledgements', async () => {
  const futureId = '88888888-8888-4888-8888-888888888888';
  const fetch = createFetch([
    response({ data: [workRow({
      id: futureId, priority: 'p0', actionable_at: '2099-01-01T00:00:00.000Z',
      payload: {
        requires_human_action: true,
        p0_acknowledged_at: '2026-08-29T03:00:00.001Z'
      }
    })] }),
    response({ data: [workRow({
      priority: 'p0', actionable_at: '2099-01-01T00:00:00.000Z',
      payload: {
        requires_human_action: true,
        p0_acknowledged_at: '2026-08-29T03:00:00.000Z'
      }
    })] })
  ]);
  const store = createWorkOrchestratorStore({
    supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl
  });

  const futureRows = await store.listActionableWork({ now: '2026-08-29T03:00:00.000Z', limit: 50 });
  assert.deepEqual(futureRows.map((row) => row.id), [futureId]);
  await assert.rejects(
    store.listActionableWork({ now: '2026-08-29T03:00:00.000Z', limit: 50 }),
    { message: 'Work Orchestrator Supabase request failed: response invalid' }
  );
});

test('recordDigestCleanup sends exact replacement evidence without touching Slack', async () => {
  const cleanedRow = digestRow({
    state: 'delivered', lease_owner: null, lease_token: null, lease_expires_at: null,
    delivered_at: '2026-08-29T03:00:05.000Z',
    previous_cleanup_state: 'deleted', previous_cleanup_error: null,
    previous_deleted_at: '2026-08-29T03:01:00.000Z'
  });
  const fetch = createFetch([response({ data: { applied: true, row: cleanedRow } })]);
  const store = createWorkOrchestratorStore({ supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl });

  const result = await store.recordDigestCleanup({
    id: DIGEST_ID, previousDigestId: PREVIOUS_DIGEST_ID, outcome: 'deleted'
  });
  assert.equal(result.applied, true);
  assert.equal(fetch.requests[0].url, 'https://supabase.example/rest/v1/rpc/record_digest_cleanup_v2');
  assert.deepEqual(JSON.parse(fetch.requests[0].init.body), {
    p_id: DIGEST_ID, p_previous_digest_id: PREVIOUS_DIGEST_ID, p_outcome: 'deleted', p_error: null
  });
});

test('recordDigestCleanup accepts only reviewed failure tokens and exact previous digest identity', async () => {
  const fetch = createFetch();
  const store = createWorkOrchestratorStore({ supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl });
  await assert.rejects(store.recordDigestCleanup({
    id: DIGEST_ID, previousDigestId: PREVIOUS_DIGEST_ID, outcome: 'failed', error: serviceRoleKey
  }), (error) => /input is invalid/i.test(error.message) && !error.message.includes(serviceRoleKey));
  await assert.rejects(store.recordDigestCleanup({
    id: DIGEST_ID, previousDigestId: 'not-a-uuid', outcome: 'already_absent'
  }), /input is invalid/i);
  assert.equal(fetch.requests.length, 0);
});

test('recordDigestCleanup records a reviewed failure while the new digest remains delivered', async () => {
  const failedCleanupRow = digestRow({
    state: 'delivered', lease_owner: null, lease_token: null, lease_expires_at: null,
    delivered_at: '2026-08-29T03:00:05.000Z', previous_cleanup_state: 'failed',
    previous_cleanup_error: 'rate_limited', previous_deleted_at: null
  });
  const fetch = createFetch([response({ data: { applied: true, row: failedCleanupRow } })]);
  const store = createWorkOrchestratorStore({ supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl });
  const result = await store.recordDigestCleanup({
    id: DIGEST_ID, previousDigestId: PREVIOUS_DIGEST_ID, outcome: 'failed', error: 'rate_limited'
  });
  assert.equal(result.row.state, 'delivered');
  assert.equal(result.row.previous_cleanup_error, 'rate_limited');
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
