import assert from 'node:assert/strict';
import test from 'node:test';

import { createWorkOrchestratorStore } from './supabase-store.mjs';

const serviceRoleKey = 'test-service-role';
const WORK_ID = '11111111-1111-4111-8111-111111111111';
const DIGEST_ID = '22222222-2222-4222-8222-222222222222';
const PREVIOUS_DIGEST_ID = '33333333-3333-4333-8333-333333333333';
const LEASE_TOKEN = '44444444-4444-4444-8444-444444444444';
const PART_ID = '55555555-5555-4555-8555-555555555555';
const PREVIOUS_PART_ID = '66666666-6666-4666-8666-666666666666';
const CLIENT_MESSAGE_ID = '77777777-7777-4777-8777-777777777777';
const CLEANUP_TOKEN = '88888888-8888-4888-8888-888888888888';
const PAYLOAD_HASH = 'a'.repeat(64);
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
  const row = {
    id: DIGEST_ID,
    destination_key: 'slack:CINBOX',
    scheduled_at: '2026-08-29T03:00:00.000Z',
    state: 'building',
    lease_owner: 'bridge:test',
    lease_token: LEASE_TOKEN,
    lease_expires_at: '2026-08-29T03:02:00.000Z',
    previous_digest_id: PREVIOUS_DIGEST_ID,
    item_snapshot: [],
    manifest_prepared_at: null,
    slack_channel_id: null,
    slack_message_ts: null,
    delivered_at: null,
    ...overrides
  };
  if ((row.state === 'delivered' || row.state === 'replaced') && row.manifest_prepared_at === null) {
    row.manifest_prepared_at = '2026-08-29T03:00:01.000Z';
  }
  return row;
}

function digestPartRow(overrides = {}) {
  return {
    id: PART_ID,
    digest_run_id: DIGEST_ID,
    part_kind: 'ordinary',
    part_number: 1,
    part_count: 1,
    item_ids: [WORK_ID],
    payload_hash: PAYLOAD_HASH,
    client_message_id: CLIENT_MESSAGE_ID,
    delivery_state: 'planned',
    delivery_attempts: 0,
    delivery_claimed_at: null,
    slack_channel_id: null,
    slack_message_ts: null,
    delivered_at: null,
    delivery_error: null,
    cleanup_state: 'idle',
    cleanup_attempts: 0,
    cleanup_owner: null,
    cleanup_token: null,
    cleanup_expires_at: null,
    cleanup_attempted_at: null,
    cleaned_at: null,
    cleanup_error: null,
    created_at: '2026-08-29T03:00:00.000Z',
    updated_at: '2026-08-29T03:00:00.000Z',
    ...overrides
  };
}

function previousDigest() {
  return {
    id: PREVIOUS_DIGEST_ID,
    parts: [{
      id: PREVIOUS_PART_ID,
      part_kind: 'ordinary',
      part_number: 1,
      part_count: 1,
      slack_channel_id: 'COLD',
      slack_message_ts: '100.10'
    }]
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
    ['https://supabase.example/rest/v1/digest_runs?select=id&state=in.%28building%2Cdelivering%2Cfailed%29', 'HEAD', '0-0', 'count=exact']
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
      previous_digest: previousDigest()
    } }),
    response({ data: {
      claimed: false, created: false, row: digestRow(),
      previous_digest: previousDigest()
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
  assert.deepEqual(first.previous_digest, previousDigest());
  assert.deepEqual(JSON.parse(fetch.requests[0].init.body), {
    p_destination_key: 'slack:CINBOX',
    p_scheduled_at: '2026-08-29T03:00:00.000Z',
    p_window_started_at: '2026-08-29T00:00:00.000Z',
    p_window_ended_at: '2026-08-29T03:00:00.000Z',
    p_lease_owner: 'bridge:test',
    p_lease_seconds: 120
  });
});

test('claimDigestRun rejects an incomplete previous part coordinate manifest', async () => {
  const incomplete = previousDigest();
  incomplete.parts[0].part_count = 2;
  const fetch = createFetch([response({ data: {
    claimed: true, created: true, row: digestRow(), previous_digest: incomplete
  } })]);
  const store = createWorkOrchestratorStore({
    supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl
  });
  await assert.rejects(store.claimDigestRun({
    destinationKey: 'slack:CINBOX', scheduledAt: '2026-08-29T03:00:00.000Z',
    windowStartedAt: '2026-08-29T00:00:00.000Z', windowEndedAt: '2026-08-29T03:00:00.000Z',
    leaseOwner: 'bridge:test', leaseSeconds: 120
  }), { message: 'Work Orchestrator Supabase request failed: response invalid' });
});

test('prepareDigestParts sends only an exact content-free snapshot and immutable part intent', async () => {
  const itemSnapshot = [{
    id: WORK_ID, version: 4, inclusionReason: 'overdue', priority: 'urgent'
  }];
  const parts = [{
    kind: 'ordinary', partNumber: 1, partCount: 1, itemIds: [WORK_ID], payloadHash: PAYLOAD_HASH
  }];
  const preparedRow = digestRow({
    state: 'delivering', item_snapshot: itemSnapshot, manifest_prepared_at: '2026-08-29T03:00:01.000Z'
  });
  const persistedPart = digestPartRow();
  const fetch = createFetch([
    response({ data: { applied: true, created: true, row: preparedRow, parts: [persistedPart] } }),
    response({ data: { applied: true, created: false, row: preparedRow, parts: [persistedPart] } })
  ]);
  const store = createWorkOrchestratorStore({ supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl });

  const input = { id: DIGEST_ID, leaseOwner: 'bridge:test', leaseToken: LEASE_TOKEN, itemSnapshot, parts };
  const first = await store.prepareDigestParts(input);
  const retry = await store.prepareDigestParts(input);

  assert.equal(first.created, true);
  assert.equal(retry.created, false);
  assert.equal(first.parts[0].client_message_id, CLIENT_MESSAGE_ID);
  assert.equal(retry.parts[0].client_message_id, CLIENT_MESSAGE_ID);
  assert.deepEqual(JSON.parse(fetch.requests[0].init.body), {
    p_id: DIGEST_ID, p_lease_owner: 'bridge:test', p_lease_token: LEASE_TOKEN,
    p_item_snapshot: itemSnapshot,
    p_parts: parts
  });
  assert.equal(fetch.requests[0].url, 'https://supabase.example/rest/v1/rpc/prepare_digest_parts_v2');
});

test('part delivery methods preserve exact run lease and attempt generation fencing', async () => {
  const deliveringPart = digestPartRow({
    delivery_state: 'delivering', delivery_attempts: 1,
    delivery_claimed_at: '2026-08-29T03:00:01.000Z'
  });
  const deliveredPart = digestPartRow({
    delivery_state: 'delivered', delivery_attempts: 1,
    delivery_claimed_at: '2026-08-29T03:00:01.000Z', slack_channel_id: 'CINBOX',
    slack_message_ts: '123.45', delivered_at: '2026-08-29T03:00:05.000Z'
  });
  const failedPart = digestPartRow({
    delivery_state: 'failed', delivery_attempts: 1,
    delivery_claimed_at: '2026-08-29T03:00:01.000Z', delivery_error: 'rate_limited'
  });
  const fetch = createFetch([
    response({ data: { claimed: true, row: deliveringPart } }),
    response({ data: { applied: true, row: deliveredPart } }),
    response({ data: { applied: true, row: failedPart } })
  ]);
  const store = createWorkOrchestratorStore({ supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl });

  assert.equal((await store.claimDigestPartDelivery({
    id: DIGEST_ID, partId: PART_ID, leaseOwner: 'bridge:test', leaseToken: LEASE_TOKEN
  })).claimed, true);
  assert.equal((await store.markDigestPartDelivered({
    id: DIGEST_ID, partId: PART_ID, leaseOwner: 'bridge:test', leaseToken: LEASE_TOKEN,
    expectedDeliveryAttempts: 1, channelId: 'CINBOX', messageTs: '123.45',
    deliveredAt: '2026-08-29T03:00:05.000Z'
  })).applied, true);
  assert.equal((await store.markDigestPartFailed({
    id: DIGEST_ID, partId: PART_ID, leaseOwner: 'bridge:test', leaseToken: LEASE_TOKEN,
    expectedDeliveryAttempts: 1, error: 'rate_limited'
  })).applied, true);
  assert.deepEqual(fetch.requests.map(({ url }) => url), [
    'https://supabase.example/rest/v1/rpc/claim_digest_part_delivery_v2',
    'https://supabase.example/rest/v1/rpc/mark_digest_part_delivered_v2',
    'https://supabase.example/rest/v1/rpc/mark_digest_part_failed_v2'
  ]);
});

test('finalizeDigestRun sends only run lease generation and delivered time', async () => {
  const itemSnapshot = [{ id: WORK_ID, version: 4, inclusionReason: 'overdue', priority: 'urgent' }];
  const fetch = createFetch([response({ data: { applied: true, row: digestRow({
    state: 'delivered', lease_owner: null, lease_token: null, lease_expires_at: null,
    item_snapshot: itemSnapshot, manifest_prepared_at: '2026-08-29T03:00:01.000Z',
    slack_channel_id: 'CINBOX', slack_message_ts: '123.45', delivered_at: '2026-08-29T03:00:05.000Z'
  }), updated_count: 1 } })]);
  const store = createWorkOrchestratorStore({ supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl });

  assert.equal((await store.finalizeDigestRun({
    id: DIGEST_ID, leaseOwner: 'bridge:test', leaseToken: LEASE_TOKEN,
    deliveredAt: '2026-08-29T03:00:05.000Z'
  })).applied, true);
  assert.deepEqual(JSON.parse(fetch.requests[0].init.body), {
    p_id: DIGEST_ID, p_lease_owner: 'bridge:test', p_lease_token: LEASE_TOKEN,
    p_delivered_at: '2026-08-29T03:00:05.000Z'
  });
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
  await assert.rejects(store.prepareDigestParts({
    id: DIGEST_ID, leaseOwner: 'bridge:test', leaseToken: LEASE_TOKEN,
    itemSnapshot: [{ id: '11111111-1111-4111-8111-111111111111', version: 1, inclusionReason: 'actionable', priority: 'normal', summary: serviceRoleKey }],
    parts: [{ kind: 'ordinary', partNumber: 1, partCount: 1, itemIds: [WORK_ID], payloadHash: PAYLOAD_HASH }]
  }), /input is invalid/i);
  await assert.rejects(store.prepareDigestParts({
    id: DIGEST_ID, leaseOwner: 'bridge:test', leaseToken: LEASE_TOKEN,
    itemSnapshot: [{ id: WORK_ID, version: 1, inclusionReason: 'actionable', priority: 'normal' }],
    parts: [{
      kind: 'ordinary', partNumber: 1, partCount: 1, itemIds: [WORK_ID],
      payloadHash: PAYLOAD_HASH, text: serviceRoleKey
    }]
  }), (error) => /input is invalid/i.test(error.message) && !error.message.includes(serviceRoleKey));
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

test('prepareDigestParts canonicalizes snapshot and part UUIDs', async () => {
  const uppercaseId = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
  const lowercaseId = uppercaseId.toLowerCase();
  const snapshot = [{ id: lowercaseId, version: 1, inclusionReason: 'actionable', priority: 'normal' }];
  const persistedPart = digestPartRow({ item_ids: [lowercaseId] });
  const fetch = createFetch([response({ data: {
    applied: true, created: true,
    row: digestRow({ state: 'delivering', item_snapshot: snapshot, manifest_prepared_at: '2026-08-29T03:00:01.000Z' }),
    parts: [persistedPart]
  } })]);
  const store = createWorkOrchestratorStore({ supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl });

  await store.prepareDigestParts({
    id: DIGEST_ID, leaseOwner: 'bridge:test', leaseToken: LEASE_TOKEN,
    itemSnapshot: [{ id: uppercaseId, version: 1, inclusionReason: 'actionable', priority: 'normal' }],
    parts: [{ kind: 'ordinary', partNumber: 1, partCount: 1, itemIds: [uppercaseId], payloadHash: PAYLOAD_HASH }]
  });
  assert.equal(JSON.parse(fetch.requests[0].init.body).p_item_snapshot[0].id, lowercaseId);
  assert.equal(JSON.parse(fetch.requests[0].init.body).p_parts[0].itemIds[0], lowercaseId);

  const rejectedFetch = createFetch();
  const rejectedStore = createWorkOrchestratorStore({
    supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: rejectedFetch.fetchImpl
  });
  await assert.rejects(rejectedStore.prepareDigestParts({
    id: DIGEST_ID, leaseOwner: 'bridge:test', leaseToken: LEASE_TOKEN,
    itemSnapshot: [{ id: WORK_ID, version: 1, inclusionReason: 'actionable', priority: 'normal' }],
    parts: [{ kind: 'ordinary', partNumber: 1, partCount: 1, itemIds: [WORK_ID], payloadHash: 'A'.repeat(64) }]
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
    ['prepareDigestParts', {
      id: DIGEST_ID, leaseOwner: 'bridge:test', leaseToken: LEASE_TOKEN,
      itemSnapshot: [{ id: WORK_ID, version: 1, inclusionReason: 'actionable', priority: 'normal' }],
      parts: [{ kind: 'ordinary', partNumber: 1, partCount: 1, itemIds: [WORK_ID], payloadHash: PAYLOAD_HASH }]
    }, { applied: true, created: true, row: digestRow({ state: 'delivering' }), parts: [{ ...digestPartRow(), client_message_id: serviceRoleKey }] }],
    ['claimDigestPartDelivery', {
      id: DIGEST_ID, partId: PART_ID, leaseOwner: 'bridge:test', leaseToken: LEASE_TOKEN
    }, { claimed: true, row: { ...digestPartRow(), delivery_attempts: '1' } }],
    ['finalizeDigestRun', {
      id: DIGEST_ID, leaseOwner: 'bridge:test', leaseToken: LEASE_TOKEN, deliveredAt: '2026-08-29T03:00:05.000Z'
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

test('action and prepare responses compare JSON structurally across JSONB key ordering', async () => {
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
      applied: true, created: true,
      row: digestRow({
        state: 'delivering', item_snapshot: postgresOrderedSnapshot,
        manifest_prepared_at: '2026-08-29T03:00:01.000Z'
      }),
      parts: [digestPartRow({ item_ids: [WORK_ID] })]
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
  const prepared = await store.prepareDigestParts({
    id: DIGEST_ID, leaseOwner: 'bridge:test', leaseToken: LEASE_TOKEN,
    itemSnapshot: snapshotInput,
    parts: [{ kind: 'ordinary', partNumber: 1, partCount: 1, itemIds: [WORK_ID], payloadHash: PAYLOAD_HASH }]
  });

  assert.equal(action.applied, true);
  assert.equal(prepared.applied, true);

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
      applied: true, created: true,
      row: digestRow({
        state: 'delivering', item_snapshot: [{ ...postgresOrderedSnapshot[0], extra: 'must-not-pass' }],
        manifest_prepared_at: '2026-08-29T03:00:01.000Z'
      }),
      parts: [digestPartRow()]
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
  await assert.rejects(extraStore.prepareDigestParts({
    id: DIGEST_ID, leaseOwner: 'bridge:test', leaseToken: LEASE_TOKEN,
    itemSnapshot: snapshotInput,
    parts: [{ kind: 'ordinary', partNumber: 1, partCount: 1, itemIds: [WORK_ID], payloadHash: PAYLOAD_HASH }]
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

test('listActionableWork validates the exact effective P0 acknowledgement timestamp domain', async (t) => {
  const futureActionableAt = '2099-01-01T00:00:00.000Z';
  const cases = [
    ['missing payload', () => {
      const row = workRow({ priority: 'p0', actionable_at: futureActionableAt });
      delete row.payload;
      return row;
    }, '2026-08-29T03:00:00.000Z', 'invalid-response'],
    ['null payload', () => workRow({ priority: 'p0', actionable_at: futureActionableAt, payload: null }), '2026-08-29T03:00:00.000Z', 'invalid-response'],
    ['non-record payload', () => workRow({ priority: 'p0', actionable_at: futureActionableAt, payload: 'not-a-record' }), '2026-08-29T03:00:00.000Z', 'invalid-response'],
    ['array payload', () => workRow({ priority: 'p0', actionable_at: futureActionableAt, payload: [] }), '2026-08-29T03:00:00.000Z', 'invalid-response'],
    ['missing acknowledgement', () => workRow({ priority: 'p0', actionable_at: futureActionableAt, payload: {} }), '2026-08-29T03:00:00.000Z', 'visible'],
    ['null acknowledgement', () => workRow({ priority: 'p0', actionable_at: futureActionableAt, payload: { p0_acknowledged_at: null } }), '2026-08-29T03:00:00.000Z', 'visible'],
    ['array acknowledgement', () => workRow({ priority: 'p0', actionable_at: futureActionableAt, payload: { p0_acknowledged_at: [] } }), '2026-08-29T03:00:00.000Z', 'visible'],
    ['malformed acknowledgement', () => workRow({ priority: 'p0', actionable_at: futureActionableAt, payload: { p0_acknowledged_at: 'not-a-time' } }), '2026-08-29T03:00:00.000Z', 'visible'],
    ['impossible calendar date', () => workRow({ priority: 'p0', actionable_at: futureActionableAt, payload: { p0_acknowledged_at: '2026-02-30T00:00:00.000Z' } }), '2026-08-29T03:00:00.000Z', 'visible'],
    ['year zero', () => workRow({ priority: 'p0', actionable_at: futureActionableAt, payload: { p0_acknowledged_at: '0000-01-01T00:00:00.000Z' } }), '2026-08-29T03:00:00.000Z', 'visible'],
    ['negative extended year', () => workRow({ priority: 'p0', actionable_at: futureActionableAt, payload: { p0_acknowledged_at: '-000001-01-01T00:00:00.000Z' } }), '2026-08-29T03:00:00.000Z', 'visible'],
    ['positive extended year', () => workRow({ priority: 'p0', actionable_at: '+020000-01-01T00:00:00.000Z', payload: { p0_acknowledged_at: '+010000-01-01T00:00:00.000Z' } }), '+010001-01-01T00:00:00.000Z', 'visible'],
    ['normal past acknowledgement', () => workRow({ priority: 'p0', actionable_at: futureActionableAt, payload: { p0_acknowledged_at: '2026-08-29T02:59:59.999Z' } }), '2026-08-29T03:00:00.000Z', 'invalid-response'],
    ['normal boundary acknowledgement', () => workRow({ priority: 'p0', actionable_at: futureActionableAt, payload: { p0_acknowledged_at: '2026-08-29T03:00:00.000Z' } }), '2026-08-29T03:00:00.000Z', 'invalid-response'],
    ['normal future acknowledgement', () => workRow({ priority: 'p0', actionable_at: futureActionableAt, payload: { p0_acknowledged_at: '2026-08-29T03:00:00.001Z' } }), '2026-08-29T03:00:00.000Z', 'visible']
  ];

  for (const [name, rowFactory, now, outcome] of cases) {
    await t.test(name, async () => {
      const fetch = createFetch([response({ data: [rowFactory()] })]);
      const store = createWorkOrchestratorStore({
        supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl
      });
      const operation = store.listActionableWork({ now, limit: 50 });
      if (outcome === 'visible') {
        assert.equal((await operation).length, 1);
      } else {
        await assert.rejects(operation, {
          message: 'Work Orchestrator Supabase request failed: response invalid'
        });
      }
    });
  }
});

test('digest part cleanup claim and terminal record carry exact rotating lease generation', async () => {
  const deletingPart = digestPartRow({
    id: PREVIOUS_PART_ID, digest_run_id: PREVIOUS_DIGEST_ID,
    delivery_state: 'delivered', delivery_attempts: 1,
    delivery_claimed_at: '2026-08-29T02:00:01.000Z', slack_channel_id: 'COLD',
    slack_message_ts: '100.10', delivered_at: '2026-08-29T02:00:05.000Z',
    cleanup_state: 'deleting', cleanup_attempts: 1, cleanup_owner: 'bridge:cleanup',
    cleanup_token: CLEANUP_TOKEN, cleanup_expires_at: '2026-08-29T03:02:00.000Z',
    cleanup_attempted_at: '2026-08-29T03:00:10.000Z'
  });
  const deletedPart = {
    ...deletingPart, cleanup_state: 'deleted', cleanup_owner: null, cleanup_token: null,
    cleanup_expires_at: null, cleaned_at: '2026-08-29T03:01:00.000Z'
  };
  const cleanedRow = digestRow({
    state: 'delivered', lease_owner: null, lease_token: null, lease_expires_at: null,
    delivered_at: '2026-08-29T03:00:05.000Z',
    previous_cleanup_state: 'deleted', previous_cleanup_error: null,
    previous_deleted_at: '2026-08-29T03:01:00.000Z'
  });
  const fetch = createFetch([
    response({ data: { claimed: true, row: digestRow({
      state: 'delivered', lease_owner: null, lease_token: null, lease_expires_at: null,
      delivered_at: '2026-08-29T03:00:05.000Z', previous_cleanup_state: 'deleting'
    }), part: deletingPart } }),
    response({ data: { applied: true, row: cleanedRow, part: deletedPart } })
  ]);
  const store = createWorkOrchestratorStore({ supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl });

  const claimed = await store.claimDigestPartCleanup({
    id: DIGEST_ID, previousDigestId: PREVIOUS_DIGEST_ID, previousPartId: PREVIOUS_PART_ID,
    cleanupOwner: 'bridge:cleanup', leaseSeconds: 120
  });
  const result = await store.recordDigestPartCleanup({
    id: DIGEST_ID, previousDigestId: PREVIOUS_DIGEST_ID, previousPartId: PREVIOUS_PART_ID,
    cleanupOwner: 'bridge:cleanup', cleanupToken: CLEANUP_TOKEN,
    expectedCleanupAttempts: 1, outcome: 'deleted'
  });
  assert.equal(claimed.claimed, true);
  assert.equal(result.applied, true);
  assert.equal(fetch.requests[0].url, 'https://supabase.example/rest/v1/rpc/claim_digest_part_cleanup_v2');
  assert.equal(fetch.requests[1].url, 'https://supabase.example/rest/v1/rpc/record_digest_part_cleanup_v2');
  assert.deepEqual(JSON.parse(fetch.requests[1].init.body), {
    p_id: DIGEST_ID, p_previous_digest_id: PREVIOUS_DIGEST_ID,
    p_previous_part_id: PREVIOUS_PART_ID, p_cleanup_owner: 'bridge:cleanup',
    p_cleanup_token: CLEANUP_TOKEN, p_expected_cleanup_attempts: 1,
    p_outcome: 'deleted', p_error: null
  });
});

test('digest part cleanup rejects secrets, stale generations, and malformed identities generically', async () => {
  const fetch = createFetch();
  const store = createWorkOrchestratorStore({ supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl });
  await assert.rejects(store.recordDigestPartCleanup({
    id: DIGEST_ID, previousDigestId: PREVIOUS_DIGEST_ID, previousPartId: PREVIOUS_PART_ID,
    cleanupOwner: 'bridge:cleanup', cleanupToken: CLEANUP_TOKEN,
    expectedCleanupAttempts: 1, outcome: 'failed', error: serviceRoleKey
  }), (error) => /input is invalid/i.test(error.message) && !error.message.includes(serviceRoleKey));
  await assert.rejects(store.claimDigestPartCleanup({
    id: DIGEST_ID, previousDigestId: 'not-a-uuid', previousPartId: PREVIOUS_PART_ID,
    cleanupOwner: 'bridge:cleanup', leaseSeconds: 120
  }), /input is invalid/i);
  assert.equal(fetch.requests.length, 0);
});

test('recordDigestPartCleanup records a reviewed failure while the new digest remains delivered', async () => {
  const failedCleanupRow = digestRow({
    state: 'delivered', lease_owner: null, lease_token: null, lease_expires_at: null,
    delivered_at: '2026-08-29T03:00:05.000Z', previous_cleanup_state: 'failed',
    previous_cleanup_error: 'rate_limited', previous_deleted_at: null
  });
  const failedPart = digestPartRow({
    id: PREVIOUS_PART_ID, digest_run_id: PREVIOUS_DIGEST_ID,
    delivery_state: 'delivered', delivery_attempts: 1,
    delivery_claimed_at: '2026-08-29T02:00:01.000Z', slack_channel_id: 'COLD',
    slack_message_ts: '100.10', delivered_at: '2026-08-29T02:00:05.000Z',
    cleanup_state: 'failed', cleanup_attempts: 1,
    cleanup_attempted_at: '2026-08-29T03:00:10.000Z', cleanup_error: 'rate_limited'
  });
  const fetch = createFetch([response({ data: { applied: true, row: failedCleanupRow, part: failedPart } })]);
  const store = createWorkOrchestratorStore({ supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl });
  const result = await store.recordDigestPartCleanup({
    id: DIGEST_ID, previousDigestId: PREVIOUS_DIGEST_ID, previousPartId: PREVIOUS_PART_ID,
    cleanupOwner: 'bridge:cleanup', cleanupToken: CLEANUP_TOKEN,
    expectedCleanupAttempts: 1, outcome: 'failed', error: 'rate_limited'
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
