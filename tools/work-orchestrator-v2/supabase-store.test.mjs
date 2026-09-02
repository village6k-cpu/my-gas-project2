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

function actionablePayload(rows, eligibleCount = rows.length) {
  return { rows, eligible_count: eligibleCount };
}

function digestRow(overrides = {}) {
  const row = {
    id: DIGEST_ID,
    destination_key: 'slack:CINBOX',
    scheduled_at: '2026-08-29T03:00:00.000Z',
    generation: 1,
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
    delivery_retry_at: null,
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
    state: 'delivered',
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

function healthAggregate(overrides = {}) {
  return {
    measured_at: '2026-09-02T12:00:00.000Z',
    notifications: {
      undelivered_count: 1, pending_count: 1, delivering_count: 0, failed_count: 0,
      oldest_undelivered_at: '2026-09-02T11:59:00.000Z', oldest_undelivered_age_seconds: 60
    },
    automation: {
      not_attempted_count: 1, running_count: 0, succeeded_count: 0,
      failed_count: 0, needs_human_count: 0
    },
    work: {
      actionable_count: 1, snoozed_count: 0, overdue_count: 0, p0_count: 0,
      unacknowledged_p0_count: 0, unacknowledged_p0_missing_alert_count: 0
    },
    digests: {
      building_count: 0, delivering_count: 0, delivered_count: 0, failed_count: 0,
      diverged_count: 0, replaced_count: 0, retired_count: 0,
      last_success_at: null, last_failure_at: null,
      latest_delivered_eligible_omitted_count: 0
    },
    cleanup: {
      notice: {
        idle_count: 0, pending_count: 0, failed_count: 0, blocked_p0_count: 0,
        deleted_count: 0, backlog_count: 0, oldest_backlog_age_seconds: null
      },
      digest: {
        idle_count: 0, deleting_count: 0, failed_count: 0, deleted_count: 0,
        already_absent_count: 0, backlog_count: 0, oldest_backlog_age_seconds: null
      }
    },
    actions: { stale_conflict_count: 0 },
    leases: {
      digest: { active_count: 0, expired_count: 0, oldest_expired_age_seconds: null },
      p0: { active_count: 0, expired_count: 0, oldest_expired_age_seconds: null },
      notice_cleanup: { active_count: 0, expired_count: 0, oldest_expired_age_seconds: null },
      digest_cleanup: { active_count: 0, expired_count: 0, oldest_expired_age_seconds: null }
    },
    ...overrides
  };
}

test('readHealthAggregate calls one explicit-clock RPC and accepts only the exact content-free shape', async () => {
  const aggregate = healthAggregate();
  const fetch = createFetch([response({ data: aggregate })]);
  const store = createWorkOrchestratorStore({
    supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl
  });

  const result = await store.readHealthAggregate({ now: '2026-09-02T12:00:00.000Z' });

  assert.deepEqual(result, aggregate);
  assert.equal(fetch.requests.length, 1);
  assert.equal(fetch.requests[0].url, 'https://supabase.example/rest/v1/rpc/read_work_orchestrator_health_v2');
  assert.equal(fetch.requests[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(fetch.requests[0].init.body), {
    p_now: '2026-09-02T12:00:00.000Z'
  });
});

test('readHealthAggregate rejects invalid clock and malformed, extra, fractional, or content-bearing response fields', async () => {
  const invalidFetch = createFetch([]);
  const invalidStore = createWorkOrchestratorStore({
    supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: invalidFetch.fetchImpl
  });
  await assert.rejects(
    invalidStore.readHealthAggregate({ now: '2026-09-02T12:00:00Z', extra: true }),
    /input is invalid/
  );
  assert.equal(invalidFetch.requests.length, 0);

  const malformed = [
    { ...healthAggregate(), source_event_key: 'private-source' },
    { ...healthAggregate(), notifications: { ...healthAggregate().notifications, undelivered_count: -1 } },
    { ...healthAggregate(), actions: { stale_conflict_count: 0.5 } },
    { ...healthAggregate(), measured_at: '2026-09-02T12:00:01.000Z' },
    { ...healthAggregate(), cleanup: { ...healthAggregate().cleanup, notice: { ...healthAggregate().cleanup.notice, payload: 'private' } } }
  ];
  for (const data of malformed) {
    const fetch = createFetch([response({ data })]);
    const store = createWorkOrchestratorStore({
      supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl
    });
    await assert.rejects(
      store.readHealthAggregate({ now: '2026-09-02T12:00:00.000Z' }),
      /response invalid/
    );
  }
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
    ['https://supabase.example/rest/v1/digest_runs?select=id&state=in.%28building%2Cdelivering%2Cfailed%2Cdiverged%29', 'HEAD', '0-0', 'count=exact']
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

const authoritativeResolution = {
  state: 'succeeded',
  resolutionKind: 'auto_reply_readback',
  evidence: { autoReply: { id: 'kakao-7', status: 'readback_confirmed' } },
  noticeText: 'The automated reply was confirmed by authoritative readback.'
};

test('authoritative automation resolution uses an active-state version CAS and stale writers are a no-op', async () => {
  const requests = [];
  const store = createWorkOrchestratorStore({
    supabaseUrl: 'https://supabase.example',
    serviceRoleKey,
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      const body = JSON.parse(init.body);
      return response({ data: requests.length === 1 ? [workRow({
        state: 'resolved', version: 2, automation_state: 'succeeded',
        resolution_kind: authoritativeResolution.resolutionKind,
        resolution_evidence: authoritativeResolution.evidence,
        resolved_at: body.resolved_at,
        resolved_by: 'automation', pending_action: {}
      })] : [] });
    }
  });

  const applied = await store.resolveWorkItem({ id: WORK_ID, expectedVersion: 1, resolution: authoritativeResolution });
  const stale = await store.resolveWorkItem({ id: WORK_ID, expectedVersion: 1, resolution: authoritativeResolution });

  assert.equal(applied.applied, true);
  assert.equal(applied.row.state, 'resolved');
  assert.deepEqual(stale, { applied: false, row: null });
  assert.match(requests[0].url, /work_items_v2\?/);
  assert.match(requests[0].url, /id=eq\.11111111-1111-4111-8111-111111111111/);
  assert.match(requests[0].url, /version=eq\.1/);
  assert.match(requests[0].url, /state=in\.%28open%2Cin_progress%2Csnoozed%29/);
  assert.deepEqual(requests[0].body.resolution_evidence, authoritativeResolution.evidence);
});

test('authoritative automation resolution keeps failed and unverified work open with finite typed evidence', async () => {
  const requests = [];
  const store = createWorkOrchestratorStore({
    supabaseUrl: 'https://supabase.example', serviceRoleKey,
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      requests.push({ url, body });
      return response({ data: [workRow({
        version: 2, automation_state: body.automation_state,
        resolution_kind: body.resolution_kind,
        resolution_evidence: body.resolution_evidence
      })] });
    }
  });
  const resolution = {
    state: 'needs_human', resolutionKind: 'missing_authoritative_readback',
    evidence: { operationReceipt: { id: 'operation-7', status: 'completed' } },
    noticeText: 'Human review is required because authoritative resolution is unavailable.'
  };

  const result = await store.markAutomationState({ id: WORK_ID, expectedVersion: 1, resolution });

  assert.equal(result.applied, true);
  assert.equal(result.row.state, 'open');
  assert.equal(result.row.automation_state, 'needs_human');
  assert.equal(requests[0].body.state, undefined);
  assert.equal(JSON.stringify(requests).includes('customer-private'), false);
});

test('authoritative automation resolution creates a durable exact-key notice update request with bounded TTL', async () => {
  const existing = {
    id: '99999999-9999-4999-8999-999999999999', source_event_key: 'event-exact-7',
    notification_state: 'delivered', slack_channel_id: 'CINBOX', slack_message_ts: '123.45',
    cleanup_after: null, updated_at: '2026-08-31T01:00:00.000Z', payload: { existing: 'preserved' }
  };
  const requests = [];
  const store = createWorkOrchestratorStore({
    supabaseUrl: 'https://supabase.example', serviceRoleKey,
    fetchImpl: async (url, init = {}) => {
      requests.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
      if (!init.body) return response({ data: [existing] });
      const body = JSON.parse(init.body);
      return response({ data: [{ ...existing, ...body, updated_at: '2026-08-31T01:00:01.000Z' }] });
    }
  });

  const result = await store.requestImmediateNoticeUpdate({
    sourceEventKey: 'event-exact-7', resolution: authoritativeResolution,
    cleanupAfter: '2026-08-31T04:00:00.000Z'
  });

  assert.equal(result.applied, true);
  assert.equal(result.row.notification_state, 'cleanup_pending');
  assert.equal(requests[1].body.cleanup_after, '2026-08-31T04:00:00.000Z');
  assert.deepEqual(requests[1].body.payload.existing, 'preserved');
  assert.equal(requests[1].body.payload.automation_notice_update.status, 'pending');
  assert.match(requests[1].url, /source_event_key=eq\.event-exact-7/);
  assert.match(requests[1].url, /updated_at=eq\.2026-08-31T01%3A00%3A00\.000Z/);
});

test('authoritative automation resolution notice queue and readback stay fenced to exact coordinates', async () => {
  const pending = {
    id: '99999999-9999-4999-8999-999999999997', source_event_key: 'event-exact-8',
    notification_state: 'cleanup_pending', slack_channel_id: 'CINBOX', slack_message_ts: '456.78',
    updated_at: '2026-08-31T01:00:00.000Z',
    payload: {
      automation_notice_update: {
        status: 'pending', resolution_kind: 'operation_readback',
        evidence: {},
        notice_text: 'The automated operation was confirmed by authoritative readback.'
      }
    }
  };
  const requests = [];
  const store = createWorkOrchestratorStore({
    supabaseUrl: 'https://supabase.example', serviceRoleKey,
    fetchImpl: async (url, init = {}) => {
      requests.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
      if (requests.length <= 2) return response({ data: [pending] });
      return response({ data: [{ ...pending, payload: requests[2].body.payload, updated_at: '2026-08-31T01:00:01.000Z' }] });
    }
  });

  const queued = await store.listImmediateNoticeUpdateRequests({ limit: 5 });
  const recorded = await store.markImmediateNoticeUpdated({
    sourceEventKey: 'event-exact-8', expectedUpdatedAt: pending.updated_at,
    channelId: 'CINBOX', messageTs: '456.78', updatedAt: '2026-08-31T01:00:01.000Z',
    contentHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  });

  assert.equal(queued.length, 1);
  assert.equal(recorded.applied, true);
  assert.equal(requests[2].body.payload.automation_notice_update.status, 'updated');
  assert.deepEqual(requests[2].body.payload.automation_notice_update.readback, {
    channel_id: 'CINBOX', message_ts: '456.78', updated_at: '2026-08-31T01:00:01.000Z',
    content_sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  });
  assert.match(requests[2].url, /slack_channel_id=eq\.CINBOX/);
  assert.match(requests[2].url, /slack_message_ts=eq\.456\.78/);
});

test('authoritative automation resolution rejects mismatched durable notice mutation responses', async (t) => {
  const existing = {
    id: '99999999-9999-4999-8999-999999999996', source_event_key: 'event-exact-9',
    notification_state: 'delivered', slack_channel_id: 'CINBOX', slack_message_ts: '789.12',
    cleanup_after: null, updated_at: '2026-08-31T01:00:00.000Z', payload: { existing: 'preserved' }
  };
  const cases = [
    ['identity', (row) => ({ ...row, source_event_key: 'event-wrong' })],
    ['state', (row) => ({ ...row, notification_state: 'delivered' })],
    ['cleanup TTL', (row) => ({ ...row, cleanup_after: '2026-08-31T05:00:00.000Z' })],
    ['pending payload', (row) => ({ ...row, payload: { ...row.payload, automation_notice_update: { status: 'pending', resolution_kind: 'operation_readback' } } })]
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      const store = createWorkOrchestratorStore({
        supabaseUrl: 'https://supabase.example', serviceRoleKey,
        fetchImpl: async (_url, init = {}) => {
          if (!init.body) return response({ data: [existing] });
          const body = JSON.parse(init.body);
          return response({ data: [mutate({ ...existing, ...body, updated_at: '2026-08-31T01:00:01.000Z' })] });
        }
      });
      await assert.rejects(store.requestImmediateNoticeUpdate({
        sourceEventKey: existing.source_event_key, resolution: authoritativeResolution,
        cleanupAfter: '2026-08-31T04:00:00.000Z'
      }), /response invalid/i);
    });
  }
});

test('authoritative automation resolution rejects mismatched notice readback mutation responses', async (t) => {
  const pending = {
    id: '99999999-9999-4999-8999-999999999995', source_event_key: 'event-exact-10',
    notification_state: 'cleanup_pending', slack_channel_id: 'CINBOX', slack_message_ts: '790.13',
    cleanup_after: '2026-08-31T04:00:00.000Z', updated_at: '2026-08-31T01:00:00.000Z',
    payload: { automation_notice_update: {
      status: 'pending', resolution_kind: 'auto_reply_readback',
      evidence: {},
      notice_text: 'The automated reply was confirmed by authoritative readback.'
    } }
  };
  const cases = [
    ['identity', (row) => ({ ...row, slack_message_ts: '791.14' })],
    ['status', (row) => ({ ...row, payload: pending.payload })],
    ['authoritative hash', (row) => ({ ...row, payload: { automation_notice_update: {
      ...row.payload.automation_notice_update,
      readback: { ...row.payload.automation_notice_update.readback, content_sha256: 'b'.repeat(64) }
    } } })]
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, async () => {
      let requestCount = 0;
      const store = createWorkOrchestratorStore({
        supabaseUrl: 'https://supabase.example', serviceRoleKey,
        fetchImpl: async (_url, init = {}) => {
          requestCount += 1;
          if (requestCount === 1) return response({ data: [pending] });
          const body = JSON.parse(init.body);
          return response({ data: [mutate({ ...pending, ...body, updated_at: '2026-08-31T01:00:01.000Z' })] });
        }
      });
      await assert.rejects(store.markImmediateNoticeUpdated({
        sourceEventKey: pending.source_event_key, expectedUpdatedAt: pending.updated_at,
        channelId: pending.slack_channel_id, messageTs: pending.slack_message_ts,
        updatedAt: '2026-08-31T01:00:01.000Z',
        contentHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
      }), /response invalid/i);
    });
  }
});

test('authoritative automation resolution store rejects content-bearing evidence generically before fetch', async () => {
  let calls = 0;
  const store = createWorkOrchestratorStore({
    supabaseUrl: 'https://supabase.example', serviceRoleKey,
    fetchImpl: async () => { calls += 1; return response(); }
  });
  await assert.rejects(
    store.resolveWorkItem({
      id: WORK_ID, expectedVersion: 1,
      resolution: { ...authoritativeResolution, evidence: { rawCustomerBody: 'customer-private' } }
    }),
    /input is invalid/i
  );
  assert.equal(calls, 0);
});

test('v2 P0 review round 1 store uses authoritative list and atomic delivery RPCs', async () => {
  const p0 = workRow({
    priority: 'p0', state: 'open', first_opened_at: '2026-09-01T05:30:00.000Z',
    payload: { requires_human_action: true }
  });
  const claimed = {
    ...p0,
    payload: { ...p0.payload, p0_delivery: {
      status: 'claimed', generation: 1, attempt: 1,
      client_message_id: '77777777-7777-5777-8777-777777777777',
      claimed_at: '2026-09-01T06:00:00.000Z', claim_expires_at: '2026-09-01T06:02:00.000Z'
    } }
  };
  const delivered = {
    ...claimed,
    payload: { ...claimed.payload, p0_delivery: {
      ...claimed.payload.p0_delivery, status: 'delivered',
      delivered_at: '2026-09-01T06:00:01.000Z', next_at: '2026-09-01T06:20:01.000Z',
      last_attempt_at: '2026-09-01T06:00:01.000Z',
      readback: { channel_id: 'CP0', message_ts: '100.1', confirmed_at: '2026-09-01T06:00:01.000Z' }
    } }
  };
  const fetch = createFetch([
    response({ data: { eligible_count: 1, selected_count: 1, omitted_count: 0, rows: [p0] } }),
    response({ data: { applied: true, row: claimed } }),
    response({ data: { applied: true, row: delivered } }),
    response({ data: { matched: true, row: delivered } })
  ]);
  const store = createWorkOrchestratorStore({
    supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl
  });

  assert.deepEqual(await store.listDueP0Work({ now: '2026-09-01T06:00:00.000Z', limit: 50 }), {
    eligibleCount: 1, selectedCount: 1, omittedCount: 0, rows: [p0]
  });
  await store.claimP0Delivery({
    id: WORK_ID, expectedVersion: 1, expectedGeneration: 0, generation: 1, attempt: 1,
    clientMessageId: '77777777-7777-5777-8777-777777777777',
    claimedAt: '2026-09-01T06:00:00.000Z', claimExpiresAt: '2026-09-01T06:02:00.000Z'
  });
  await store.settleP0Delivery({
    id: WORK_ID, expectedVersion: 1, expectedStatus: 'claimed', expectedGeneration: 1,
    clientMessageId: '77777777-7777-5777-8777-777777777777', status: 'delivered',
    recordedAt: '2026-09-01T06:00:01.000Z', channelId: 'CP0', messageTs: '100.1'
  });
  await store.readP0Delivery({
    id: WORK_ID, expectedVersion: 1, expectedGeneration: 1,
    clientMessageId: '77777777-7777-5777-8777-777777777777'
  });

  assert.deepEqual(fetch.requests.map((request) => request.url), [
    'https://supabase.example/rest/v1/rpc/list_due_p0_work_v2',
    'https://supabase.example/rest/v1/rpc/claim_p0_delivery_v2',
    'https://supabase.example/rest/v1/rpc/settle_p0_delivery_v2',
    'https://supabase.example/rest/v1/rpc/read_p0_delivery_v2'
  ]);
  assert.deepEqual(JSON.parse(fetch.requests[2].init.body), {
    p_id: WORK_ID,
    p_expected_version: 1,
    p_expected_status: 'claimed',
    p_expected_generation: 1,
    p_client_message_id: '77777777-7777-5777-8777-777777777777',
    p_status: 'delivered',
    p_recorded_at: '2026-09-01T06:00:01.000Z',
    p_channel_id: 'CP0',
    p_message_ts: '100.1',
    p_reconcile_owner: null,
    p_reconcile_token: null
  });
});

test('v2 P0 review round 2 store claims reconciliation and settles with the exact rotated lease', async () => {
  const clientId = '77777777-7777-5777-8777-777777777777';
  const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const token = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const reconciling = workRow({
    priority: 'p0',
    payload: { requires_human_action: true, p0_delivery: {
      status: 'reconciling', generation: 1, attempt: 1, client_message_id: clientId,
      claimed_at: '2026-09-02T05:50:00.000Z', claim_expires_at: '2026-09-02T05:52:00.000Z',
      last_attempt_at: '2026-09-02T05:51:00.000Z', next_at: '2026-09-02T06:00:00.000Z',
      reconcile_owner: owner, reconcile_token: token,
      reconcile_claimed_at: '2026-09-02T06:00:00.000Z', reconcile_expires_at: '2026-09-02T06:02:00.000Z'
    } }
  });
  const retryPending = workRow({
    ...reconciling,
    payload: { requires_human_action: true, p0_delivery: {
      status: 'retry_pending', generation: 1, attempt: 1, client_message_id: clientId,
      claimed_at: '2026-09-02T05:50:00.000Z', claim_expires_at: '2026-09-02T05:52:00.000Z',
      last_attempt_at: '2026-09-02T06:00:01.000Z', next_at: '2026-09-02T06:10:01.000Z'
    } }
  });
  const fetch = createFetch([
    response({ data: { claimed: true, row: reconciling } }),
    response({ data: { applied: true, row: retryPending } })
  ]);
  const store = createWorkOrchestratorStore({
    supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl
  });

  const claimed = await store.claimP0Reconciliation({
    id: WORK_ID, expectedVersion: 1, expectedStatus: 'reconcile_pending', expectedGeneration: 1,
    clientMessageId: clientId, reconcileOwner: owner, leaseSeconds: 120,
    now: '2026-09-02T06:00:00.000Z'
  });
  assert.equal(claimed.claimed, true);
  await store.settleP0Delivery({
    id: WORK_ID, expectedVersion: 1, expectedStatus: 'reconciling', expectedGeneration: 1,
    clientMessageId: clientId, status: 'retry_pending', recordedAt: '2026-09-02T06:00:01.000Z',
    channelId: null, messageTs: null, reconcileOwner: owner, reconcileToken: token
  });

  assert.deepEqual(fetch.requests.map((request) => request.url), [
    'https://supabase.example/rest/v1/rpc/claim_p0_reconciliation_v2',
    'https://supabase.example/rest/v1/rpc/settle_p0_delivery_v2'
  ]);
  assert.deepEqual(JSON.parse(fetch.requests[0].init.body), {
    p_id: WORK_ID, p_expected_version: 1, p_expected_status: 'reconcile_pending',
    p_expected_generation: 1, p_client_message_id: clientId,
    p_reconcile_owner: owner, p_lease_seconds: 120, p_now: '2026-09-02T06:00:00.000Z'
  });
  assert.deepEqual(JSON.parse(fetch.requests[1].init.body), {
    p_id: WORK_ID, p_expected_version: 1, p_expected_status: 'reconciling',
    p_expected_generation: 1, p_client_message_id: clientId, p_status: 'retry_pending',
    p_recorded_at: '2026-09-02T06:00:01.000Z', p_channel_id: null, p_message_ts: null,
    p_reconcile_owner: owner, p_reconcile_token: token
  });
});

test('v2 P0 review round 2 store rejects unknown, extra, or incomplete delivery states generically', async () => {
  const clientId = '77777777-7777-5777-8777-777777777777';
  const base = {
    generation: 1, attempt: 1, client_message_id: clientId,
    claimed_at: '2026-09-02T05:50:00.000Z', claim_expires_at: '2026-09-02T05:52:00.000Z'
  };
  const invalidRows = [
    workRow({ priority: 'p0', payload: { requires_human_action: true, p0_delivery: {
      ...base, status: 'unknown'
    } } }),
    workRow({ priority: 'p0', payload: { requires_human_action: true, p0_delivery: {
      ...base, status: 'delivered', last_attempt_at: '2026-09-02T06:00:00.000Z',
      delivered_at: '2026-09-02T06:00:00.000Z', next_at: '2026-09-02T06:20:00.000Z',
      readback: { channel_id: 'CP0', message_ts: '100.1', confirmed_at: '2026-09-02T06:00:00.000Z' },
      unexpected: 'field'
    } } }),
    workRow({ priority: 'p0', payload: { requires_human_action: true, p0_delivery: {
      ...base, status: 'reconciling', last_attempt_at: '2026-09-02T05:51:00.000Z',
      next_at: '2026-09-02T06:00:00.000Z',
      reconcile_owner: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      reconcile_claimed_at: '2026-09-02T06:00:00.000Z', reconcile_expires_at: '2026-09-02T06:02:00.000Z'
    } } })
  ];
  const fetch = createFetch(invalidRows.map((row) => response({ data: {
    eligible_count: 1, selected_count: 1, omitted_count: 0, rows: [row]
  } })));
  const store = createWorkOrchestratorStore({
    supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl
  });
  for (const row of invalidRows) {
    await assert.rejects(
      store.listDueP0Work({ now: '2026-09-02T06:00:00.000Z', limit: 50 }),
      /response invalid/i,
      `must reject ${row.payload.p0_delivery.status}`
    );
  }
});

test('v2 P0 review round 3 store rejects valid delivery facts that do not match the exact request', async () => {
  const clientId = '77777777-7777-5777-8777-777777777777';
  const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const token = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const claimedAt = '2026-09-02T06:00:00.000Z';
  const claimExpiresAt = '2026-09-02T06:02:00.000Z';
  const recordedAt = '2026-09-02T06:00:01.000Z';
  const claimed = {
    status: 'claimed', generation: 1, attempt: 1, client_message_id: clientId,
    claimed_at: claimedAt, claim_expires_at: claimExpiresAt
  };
  const delivered = {
    ...claimed, status: 'delivered', last_attempt_at: recordedAt,
    delivered_at: recordedAt, next_at: '2026-09-02T06:20:01.000Z',
    readback: { channel_id: 'CP0', message_ts: '100.1', confirmed_at: recordedAt }
  };
  const reconciliationInput = {
    id: WORK_ID, expectedVersion: 1, expectedStatus: 'reconcile_pending', expectedGeneration: 1,
    clientMessageId: clientId, reconcileOwner: owner, leaseSeconds: 120, now: claimedAt
  };
  const claimInput = {
    id: WORK_ID, expectedVersion: 1, expectedGeneration: 0, generation: 1, attempt: 1,
    clientMessageId: clientId, claimedAt, claimExpiresAt
  };
  const deliveredInput = {
    id: WORK_ID, expectedVersion: 1, expectedStatus: 'claimed', expectedGeneration: 1,
    clientMessageId: clientId, status: 'delivered', recordedAt,
    channelId: 'CP0', messageTs: '100.1'
  };
  const retryInput = {
    ...deliveredInput, status: 'retry_pending', channelId: null, messageTs: null
  };
  const cases = [{
    name: 'initial claim wrong state', method: 'claimP0Delivery', input: claimInput,
    data: { applied: true, row: workRow({ priority: 'p0', payload: {
      requires_human_action: true, p0_delivery: delivered
    } }) }
  }, {
    name: 'initial claim wrong claimed time', method: 'claimP0Delivery', input: claimInput,
    data: { applied: true, row: workRow({ priority: 'p0', payload: {
      requires_human_action: true, p0_delivery: {
        ...claimed, claimed_at: '2026-09-02T06:00:00.001Z'
      }
    } }) }
  }, {
    name: 'initial claim wrong lease expiry', method: 'claimP0Delivery', input: claimInput,
    data: { applied: true, row: workRow({ priority: 'p0', payload: {
      requires_human_action: true, p0_delivery: {
        ...claimed, claim_expires_at: '2026-09-02T06:02:00.001Z'
      }
    } }) }
  }, {
    name: 'reconciliation claim wrong attempt', method: 'claimP0Reconciliation', input: reconciliationInput,
    data: { claimed: true, row: workRow({ priority: 'p0', payload: {
      requires_human_action: true, p0_delivery: {
        status: 'reconciling', generation: 2, attempt: 2, client_message_id: clientId,
        claimed_at: '2026-09-02T05:50:00.000Z', claim_expires_at: '2026-09-02T05:52:00.000Z',
        last_attempt_at: '2026-09-02T05:51:00.000Z', next_at: claimedAt,
        reconcile_owner: owner, reconcile_token: token,
        reconcile_claimed_at: claimedAt, reconcile_expires_at: claimExpiresAt
      }
    } }) }
  }, {
    name: 'settlement wrong coordinates', method: 'settleP0Delivery', input: deliveredInput,
    data: { applied: true, row: workRow({ priority: 'p0', payload: {
      requires_human_action: true, p0_delivery: {
        ...delivered,
        readback: { channel_id: 'COTHER', message_ts: '200.2', confirmed_at: recordedAt }
      }
    } }) }
  }, {
    name: 'settlement wrong recorded times', method: 'settleP0Delivery', input: deliveredInput,
    data: { applied: true, row: workRow({ priority: 'p0', payload: {
      requires_human_action: true, p0_delivery: {
        ...delivered, last_attempt_at: '2026-09-02T06:00:01.001Z',
        delivered_at: '2026-09-02T06:00:01.001Z',
        readback: { ...delivered.readback, confirmed_at: '2026-09-02T06:00:01.001Z' }
      }
    } }) }
  }, {
    name: 'settlement wrong next time', method: 'settleP0Delivery', input: deliveredInput,
    data: { applied: true, row: workRow({ priority: 'p0', payload: {
      requires_human_action: true, p0_delivery: {
        ...delivered, next_at: '2026-09-02T06:20:01.001Z'
      }
    } }) }
  }, {
    name: 'retry settlement wrong next time', method: 'settleP0Delivery', input: retryInput,
    data: { applied: true, row: workRow({ priority: 'p0', payload: {
      requires_human_action: true, p0_delivery: {
        ...claimed, status: 'retry_pending', last_attempt_at: recordedAt,
        next_at: '2026-09-02T06:10:01.001Z'
      }
    } }) }
  }];
  const outcomes = [];
  for (const invalidCase of cases) {
    const fetch = createFetch([response({ data: invalidCase.data })]);
    const store = createWorkOrchestratorStore({
      supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl
    });
    try {
      await store[invalidCase.method](invalidCase.input);
      outcomes.push(`${invalidCase.name}:accepted`);
    } catch (error) {
      assert.match(error.message, /response invalid/i);
      outcomes.push(`${invalidCase.name}:rejected`);
    }
  }
  assert.deepEqual(outcomes, [
    'initial claim wrong state:rejected',
    'initial claim wrong claimed time:rejected',
    'initial claim wrong lease expiry:rejected',
    'reconciliation claim wrong attempt:rejected',
    'settlement wrong coordinates:rejected',
    'settlement wrong recorded times:rejected',
    'settlement wrong next time:rejected',
    'retry settlement wrong next time:rejected'
  ]);
});

test('listActionableWork selects a bounded deterministic digest surface including unresolved P0', async () => {
  const fetch = createFetch([response({ data: actionablePayload([workRow({
    priority: 'p0', actionable_at: '2099-01-01T00:00:00.000Z', payload: { requires_human_action: true }
  })]) })]);
  const store = createWorkOrchestratorStore({ supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl });

  const rows = await store.listActionableWork({ now: '2026-08-29T03:00:00.000Z', limit: 50 });

  assert.equal(rows.length, 1);
  assert.equal(fetch.requests[0].url, 'https://supabase.example/rest/v1/rpc/list_actionable_work_v2');
  assert.equal(fetch.requests[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(fetch.requests[0].init.body), {
    p_now: '2026-08-29T03:00:00.000Z', p_limit: 50
  });
});

test('listActionableWork returns an authoritative eligible count at the 500/501 boundary', async () => {
  const rows = Array.from({ length: 500 }, (_, index) => workRow({
    id: `90000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    work_key: `work:${index + 1}`
  }));
  const fetch = createFetch([
    response({ data: actionablePayload(rows, 500) }),
    response({ data: actionablePayload(rows, 501) })
  ]);
  const store = createWorkOrchestratorStore({
    supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl
  });

  const exact = await store.listActionableWork({ now: '2026-08-29T03:00:00.000Z', limit: 500 });
  const overflow = await store.listActionableWork({ now: '2026-08-29T03:00:00.000Z', limit: 500 });

  assert.equal(exact.length, 500);
  assert.equal(exact.eligibleCount, 500);
  assert.equal(overflow.length, 500);
  assert.equal(overflow.eligibleCount, 501);
  assert.ok(fetch.requests.every(({ init }) => JSON.parse(init.body).p_limit === 500));
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

test('claimDivergentDigestRun returns one exact old window below the current boundary', async () => {
  const recovered = digestRow({
    generation: 2,
    window_started_at: '2026-08-29T00:00:00.000Z',
    window_ended_at: '2026-08-29T03:00:00.000Z'
  });
  const fetch = createFetch([response({ data: {
    claimed: true, created: true, row: recovered, previous_digest: previousDigest()
  } })]);
  const store = createWorkOrchestratorStore({
    supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl
  });

  const result = await store.claimDivergentDigestRun({
    destinationKey: 'slack:CINBOX',
    beforeScheduledAt: '2026-08-29T06:00:00.000Z',
    leaseOwner: 'bridge:test',
    leaseSeconds: 120
  });

  assert.equal(result.claimed, true);
  assert.equal(result.row.scheduled_at, '2026-08-29T03:00:00.000Z');
  assert.equal(result.row.window_started_at, '2026-08-29T00:00:00.000Z');
  assert.equal(result.row.window_ended_at, '2026-08-29T03:00:00.000Z');
  assert.equal(fetch.requests[0].url,
    'https://supabase.example/rest/v1/rpc/claim_divergent_digest_run_v2');
  assert.deepEqual(JSON.parse(fetch.requests[0].init.body), {
    p_destination_key: 'slack:CINBOX',
    p_before_scheduled_at: '2026-08-29T06:00:00.000Z',
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

test('divergent prepared intent hands off immutably to a successor without generation cleanup', async () => {
  const oldSnapshot = [{ id: WORK_ID, version: 1, inclusionReason: 'actionable', priority: 'normal' }];
  const newSnapshot = [{ id: WORK_ID, version: 2, inclusionReason: 'actionable', priority: 'normal' }];
  const activeRow = digestRow({
    state: 'delivering', generation: 1, item_snapshot: oldSnapshot,
    manifest_prepared_at: '2026-08-29T03:00:01.000Z'
  });
  const deliveredPart = digestPartRow({
    delivery_state: 'delivered', delivery_attempts: 1,
    delivery_claimed_at: '2026-08-29T03:00:01.000Z', delivered_at: '2026-08-29T03:00:02.000Z',
    slack_channel_id: 'CINBOX', slack_message_ts: '100.20'
  });
  const divergedRow = digestRow({
    state: 'diverged', generation: 1, item_snapshot: oldSnapshot,
    manifest_prepared_at: '2026-08-29T03:00:01.000Z',
    lease_owner: null, lease_token: null, lease_expires_at: null,
    error: 'digest_generation_diverged'
  });
  const fetch = createFetch([
    response({ data: {
      applied: false, created: false, reason: 'manifest_mismatch', row: activeRow, parts: [deliveredPart]
    } }),
    response({ data: { applied: true, row: divergedRow } })
  ]);
  const store = createWorkOrchestratorStore({
    supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl
  });

  const mismatch = await store.prepareDigestParts({
    id: DIGEST_ID,
    leaseOwner: 'bridge:test',
    leaseToken: LEASE_TOKEN,
    itemSnapshot: newSnapshot,
    parts: [{
      kind: 'ordinary', partNumber: 1, partCount: 1,
      itemIds: [WORK_ID], payloadHash: 'b'.repeat(64)
    }]
  });
  assert.equal(mismatch.reason, 'manifest_mismatch');
  assert.equal(mismatch.parts[0].client_message_id, CLIENT_MESSAGE_ID);

  const handoff = await store.markDigestGenerationDiverged({
    id: DIGEST_ID, leaseOwner: 'bridge:test', leaseToken: LEASE_TOKEN,
    error: 'digest_generation_diverged'
  });
  assert.equal(handoff.row.state, 'diverged');
  assert.equal(handoff.row.lease_token, null);
  assert.equal(handoff.row.item_snapshot[0].version, 1);
  assert.equal(mismatch.parts[0].slack_message_ts, '100.20');

  assert.deepEqual(fetch.requests.map(({ url }) => url), [
    'https://supabase.example/rest/v1/rpc/prepare_digest_parts_v2',
    'https://supabase.example/rest/v1/rpc/mark_digest_generation_diverged_v2'
  ]);
  assert.deepEqual(JSON.parse(fetch.requests[1].init.body), {
    p_id: DIGEST_ID, p_lease_owner: 'bridge:test', p_lease_token: LEASE_TOKEN,
    p_error: 'digest_generation_diverged'
  });
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
    delivery_claimed_at: '2026-08-29T03:00:01.000Z', delivery_error: 'rate_limited',
    delivery_retry_at: '2026-08-29T03:05:00.000Z'
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
    expectedDeliveryAttempts: 1, error: 'rate_limited',
    failedAt: '2026-08-29T03:00:00.000Z', retryAt: '2026-08-29T03:05:00.000Z'
  })).applied, true);
  assert.deepEqual(fetch.requests.map(({ url }) => url), [
    'https://supabase.example/rest/v1/rpc/claim_digest_part_delivery_v2',
    'https://supabase.example/rest/v1/rpc/mark_digest_part_delivered_v2',
    'https://supabase.example/rest/v1/rpc/mark_digest_part_failed_v2'
  ]);
  assert.deepEqual(JSON.parse(fetch.requests[2].init.body), {
    p_id: DIGEST_ID, p_part_id: PART_ID,
    p_lease_owner: 'bridge:test', p_lease_token: LEASE_TOKEN,
    p_expected_delivery_attempts: 1, p_error: 'rate_limited',
    p_failed_at: '2026-08-29T03:00:00.000Z', p_retry_at: '2026-08-29T03:05:00.000Z'
  });
});

test('markDigestPartFailed requires an exact bounded retryAt only for rate limits', async () => {
  const fetch = createFetch();
  const store = createWorkOrchestratorStore({
    supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl
  });
  const base = {
    id: DIGEST_ID, partId: PART_ID, leaseOwner: 'bridge:test', leaseToken: LEASE_TOKEN,
    expectedDeliveryAttempts: 1, failedAt: '2026-08-29T03:00:00.000Z'
  };
  for (const input of [
    { ...base, error: 'rate_limited', retryAt: null },
    { ...base, error: 'rate_limited', retryAt: '2026-08-30T03:00:00.001Z' },
    { ...base, error: 'slack_api_error', retryAt: '2026-08-29T03:00:01.000Z' },
    { ...base, error: 'slack_api_error' }
  ]) {
    await assert.rejects(store.markDigestPartFailed(input), /input is invalid/i);
  }
  assert.equal(fetch.requests.length, 0);
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
    response({ data: actionablePayload([{ ...workRow(), version: '1' }]) }),
    response({ data: actionablePayload([workRow({
      priority: 'p0', actionable_at: '2099-01-01T00:00:00.000Z',
      payload: { requires_human_action: true, p0_acknowledged_at: '2026-08-29T00:00:00.000Z' }
    })]) })
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
  const fetch = createFetch([response({ data: actionablePayload([
    workRow({
      id: missingId, priority: 'p0', actionable_at: '2099-01-01T00:00:00.000Z',
      payload: { requires_human_action: true }
    }),
    workRow({
      id: malformedId, priority: 'p0', actionable_at: '2099-01-01T00:00:00.000Z',
      payload: { requires_human_action: true, p0_acknowledged_at: 'not-a-timestamp' }
    })
  ]) })]);
  const store = createWorkOrchestratorStore({
    supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl
  });

  const rows = await store.listActionableWork({ now: '2026-08-29T03:00:00.000Z', limit: 50 });

  assert.deepEqual(rows.map((row) => row.id), [missingId, malformedId]);
});

test('listActionableWork uses the supplied cutoff for future and boundary P0 acknowledgements', async () => {
  const futureId = '88888888-8888-4888-8888-888888888888';
  const fetch = createFetch([
    response({ data: actionablePayload([workRow({
      id: futureId, priority: 'p0', actionable_at: '2099-01-01T00:00:00.000Z',
      payload: {
        requires_human_action: true,
        p0_acknowledged_at: '2026-08-29T03:00:00.001Z'
      }
    })]) }),
    response({ data: actionablePayload([workRow({
      priority: 'p0', actionable_at: '2099-01-01T00:00:00.000Z',
      payload: {
        requires_human_action: true,
        p0_acknowledged_at: '2026-08-29T03:00:00.000Z'
      }
    })]) })
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
      const fetch = createFetch([response({ data: actionablePayload([rowFactory()]) })]);
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
      delivered_at: '2026-08-29T03:00:05.000Z', previous_cleanup_state: 'deleting',
      previous_cleanup_error: null, previous_deleted_at: null
    }), part: deletingPart } }),
    response({ data: { applied: true, row: cleanedRow, part: deletedPart } }),
    response({ data: { applied: false, row: cleanedRow, part: deletedPart } })
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
  const retried = await store.recordDigestPartCleanup({
    id: DIGEST_ID, previousDigestId: PREVIOUS_DIGEST_ID, previousPartId: PREVIOUS_PART_ID,
    cleanupOwner: 'bridge:cleanup', cleanupToken: CLEANUP_TOKEN,
    expectedCleanupAttempts: 1, outcome: 'deleted'
  });
  assert.equal(claimed.claimed, true);
  assert.equal(result.applied, true);
  assert.equal(retried.applied, false);
  assert.equal(fetch.requests[0].url, 'https://supabase.example/rest/v1/rpc/claim_digest_part_cleanup_v2');
  assert.equal(fetch.requests[1].url, 'https://supabase.example/rest/v1/rpc/record_digest_part_cleanup_v2');
  assert.deepEqual(JSON.parse(fetch.requests[1].init.body), {
    p_id: DIGEST_ID, p_previous_digest_id: PREVIOUS_DIGEST_ID,
    p_previous_part_id: PREVIOUS_PART_ID, p_cleanup_owner: 'bridge:cleanup',
    p_cleanup_token: CLEANUP_TOKEN, p_expected_cleanup_attempts: 1,
    p_outcome: 'deleted', p_error: null
  });
});

test('listDigestCleanupBacklog requests one finite destination and accepts only content-free exact targets', async () => {
  const row = {
    successor_digest_id: DIGEST_ID,
    previous_digest_id: PREVIOUS_DIGEST_ID,
    previous_cleanup_state: 'failed',
    parts: [{
      previous_part_id: PREVIOUS_PART_ID,
      part_kind: 'ordinary',
      part_number: 1,
      part_count: 1,
      slack_channel_id: 'COLD',
      slack_message_ts: '100.10',
      cleanup_state: 'failed'
    }]
  };
  const terminalRow = {
    ...row,
    previous_cleanup_state: 'idle',
    parts: [{ ...row.parts[0], cleanup_state: 'deleted' }]
  };
  const fetch = createFetch([
    response({ data: [row] }),
    response({ data: [terminalRow] }),
    response({ data: [{ ...row, payload: serviceRoleKey }] }),
    response({ data: [{ ...row, parts: Array.from({ length: 51 }, () => row.parts[0]) }] })
  ]);
  const store = createWorkOrchestratorStore({
    supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl
  });

  assert.deepEqual(await store.listDigestCleanupBacklog({ destinationKey: 'slack:CINBOX', limit: 10 }), [row]);
  assert.equal(fetch.requests[0].url, 'https://supabase.example/rest/v1/rpc/list_digest_cleanup_backlog_v2');
  assert.deepEqual(JSON.parse(fetch.requests[0].init.body), {
    p_destination_key: 'slack:CINBOX', p_limit: 10
  });
  assert.deepEqual(
    await store.listDigestCleanupBacklog({ destinationKey: 'slack:CINBOX', limit: 10 }),
    [terminalRow],
    'a terminal prior part remains content-free backlog input while a successor aggregate needs reconciliation'
  );
  await assert.rejects(
    store.listDigestCleanupBacklog({ destinationKey: 'slack:CINBOX', limit: 10 }),
    (error) => /response invalid/i.test(error.message) && !error.message.includes(serviceRoleKey)
  );
  await assert.rejects(
    store.listDigestCleanupBacklog({ destinationKey: 'slack:CINBOX', limit: 10 }),
    /response invalid/i
  );
  await assert.rejects(store.listDigestCleanupBacklog({ destinationKey: 'slack:CINBOX', limit: 11 }), /input is invalid/i);
});

test('cleanup claim and record preserve a confirmed replaced successor response shape', async () => {
  const deletingPart = digestPartRow({
    id: PREVIOUS_PART_ID, digest_run_id: PREVIOUS_DIGEST_ID,
    delivery_state: 'delivered', delivery_attempts: 1,
    delivery_claimed_at: '2026-08-29T02:00:01.000Z', slack_channel_id: 'COLD',
    slack_message_ts: '100.10', delivered_at: '2026-08-29T02:00:05.000Z',
    cleanup_state: 'deleting', cleanup_attempts: 2, cleanup_owner: 'bridge:replaced',
    cleanup_token: CLEANUP_TOKEN, cleanup_expires_at: '2026-08-29T03:02:00.000Z',
    cleanup_attempted_at: '2026-08-29T03:00:10.000Z'
  });
  const failedPart = {
    ...deletingPart, cleanup_state: 'failed', cleanup_owner: null, cleanup_token: null,
    cleanup_expires_at: null, cleanup_error: 'rate_limited'
  };
  const replaced = digestRow({
    state: 'replaced', lease_owner: null, lease_token: null, lease_expires_at: null,
    delivered_at: '2026-08-29T03:00:05.000Z', previous_cleanup_state: 'deleting',
    previous_cleanup_error: null, previous_deleted_at: null
  });
  const fetch = createFetch([
    response({ data: { claimed: true, row: replaced, part: deletingPart } }),
    response({ data: {
      applied: true,
      row: { ...replaced, previous_cleanup_state: 'failed', previous_cleanup_error: 'rate_limited' },
      part: failedPart
    } })
  ]);
  const store = createWorkOrchestratorStore({
    supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl
  });
  const claimed = await store.claimDigestPartCleanup({
    id: DIGEST_ID, previousDigestId: PREVIOUS_DIGEST_ID, previousPartId: PREVIOUS_PART_ID,
    cleanupOwner: 'bridge:replaced', leaseSeconds: 120
  });
  const recorded = await store.recordDigestPartCleanup({
    id: DIGEST_ID, previousDigestId: PREVIOUS_DIGEST_ID, previousPartId: PREVIOUS_PART_ID,
    cleanupOwner: 'bridge:replaced', cleanupToken: CLEANUP_TOKEN,
    expectedCleanupAttempts: 2, outcome: 'failed', error: 'rate_limited'
  });
  assert.equal(claimed.row.state, 'replaced');
  assert.equal(recorded.row.state, 'replaced');
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

test('recordDigestPartCleanup accepts finite deleting priority and rejects impossible or content-bearing aggregates', async () => {
  const input = {
    id: DIGEST_ID, previousDigestId: PREVIOUS_DIGEST_ID, previousPartId: PREVIOUS_PART_ID,
    cleanupOwner: 'bridge:cleanup', cleanupToken: CLEANUP_TOKEN,
    expectedCleanupAttempts: 1, outcome: 'failed', error: 'rate_limited'
  };
  const failedPart = digestPartRow({
    id: PREVIOUS_PART_ID, digest_run_id: PREVIOUS_DIGEST_ID,
    part_count: 2, delivery_state: 'delivered', delivery_attempts: 1,
    delivery_claimed_at: '2026-08-29T02:00:01.000Z', slack_channel_id: 'COLD',
    slack_message_ts: '100.10', delivered_at: '2026-08-29T02:00:05.000Z',
    cleanup_state: 'failed', cleanup_attempts: 1,
    cleanup_attempted_at: '2026-08-29T03:00:10.000Z', cleanup_error: 'rate_limited'
  });
  const deletingAggregate = digestRow({
    state: 'delivered', lease_owner: null, lease_token: null, lease_expires_at: null,
    delivered_at: '2026-08-29T03:00:05.000Z', previous_cleanup_state: 'deleting',
    previous_cleanup_error: null, previous_deleted_at: null
  });
  const fetch = createFetch([
    response({ data: { applied: true, row: deletingAggregate, part: failedPart } }),
    response({ data: {
      applied: true, row: { ...deletingAggregate, previous_cleanup_error: serviceRoleKey }, part: failedPart
    } }),
    response({ data: {
      applied: true, row: { ...deletingAggregate, previous_cleanup_state: 'idle' }, part: failedPart
    } })
  ]);
  const store = createWorkOrchestratorStore({
    supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl
  });

  const accepted = await store.recordDigestPartCleanup(input);
  assert.equal(accepted.row.previous_cleanup_state, 'deleting');
  await assert.rejects(
    store.recordDigestPartCleanup(input),
    (error) => error.message === 'Work Orchestrator Supabase request failed: response invalid'
      && !error.message.includes(serviceRoleKey)
  );
  await assert.rejects(store.recordDigestPartCleanup(input), {
    message: 'Work Orchestrator Supabase request failed: response invalid'
  });
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

test('notice cleanup uses one durable bounded claim RPC and exact cleanup generations', async () => {
  const pending = {
    id: WORK_ID,
    notification_state: 'delivered',
    cleanup_state: 'pending',
    cleanup_attempts: 2,
    cleanup_owner: 'bridge:notice-cleanup',
    cleanup_token: CLEANUP_TOKEN,
    cleanup_expires_at: '2026-08-31T06:02:00.000Z',
    cleanup_attempted_at: '2026-08-31T06:00:00.000Z',
    cleaned_at: null,
    cleanup_error: null,
    cleanup_already_absent: false,
    coordinate_status: 'valid',
    slack_channel_id: 'CNOTICE',
    slack_message_ts: '123.45'
  };
  const fetch = createFetch([
    response({ data: [pending] }),
    response({ data: { applied: true, row: {
      id: WORK_ID, notification_state: 'deleted', cleanup_state: 'deleted', cleanup_attempts: 2,
      cleanup_owner: null, cleanup_token: null, cleanup_expires_at: null,
      cleanup_attempted_at: '2026-08-31T06:00:00.000Z', cleaned_at: '2026-08-31T06:00:01.000Z',
      cleanup_error: null, cleanup_already_absent: false
    } } }),
    response({ data: { applied: true, row: {
      id: WORK_ID, notification_state: 'delivered', cleanup_state: 'failed', cleanup_attempts: 2,
      cleanup_owner: null, cleanup_token: null, cleanup_expires_at: null,
      cleanup_attempted_at: '2026-08-31T06:00:00.000Z', cleaned_at: null,
      cleanup_error: 'cant_delete_message', cleanup_already_absent: false
    } } })
  ]);
  const store = createWorkOrchestratorStore({
    supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl
  });

  const claimed = await store.claimCleanupBatch({
    now: '2026-08-31T06:00:00.000Z', cleanupOwner: 'bridge:notice-cleanup',
    leaseSeconds: 120, limit: 25
  });
  const deleted = await store.markCleanupDeleted({
    id: WORK_ID, cleanupOwner: 'bridge:notice-cleanup', cleanupToken: CLEANUP_TOKEN, expectedCleanupAttempts: 2,
    alreadyAbsent: false
  });
  const failed = await store.markCleanupFailed({
    id: WORK_ID, cleanupOwner: 'bridge:notice-cleanup', cleanupToken: CLEANUP_TOKEN, expectedCleanupAttempts: 2,
    error: 'cant_delete_message'
  });

  assert.equal(claimed.length, 1);
  assert.equal(deleted.applied, true);
  assert.equal(failed.applied, true);
  assert.deepEqual(fetch.requests.map(({ url }) => url), [
    'https://supabase.example/rest/v1/rpc/claim_notice_cleanup_batch_v2',
    'https://supabase.example/rest/v1/rpc/mark_notice_cleanup_deleted_v2',
    'https://supabase.example/rest/v1/rpc/mark_notice_cleanup_failed_v2'
  ]);
  assert.deepEqual(JSON.parse(fetch.requests[0].init.body), {
    p_now: '2026-08-31T06:00:00.000Z', p_cleanup_owner: 'bridge:notice-cleanup',
    p_lease_seconds: 120, p_limit: 25
  });
  assert.deepEqual(JSON.parse(fetch.requests[1].init.body), {
    p_id: WORK_ID, p_cleanup_owner: 'bridge:notice-cleanup',
    p_cleanup_token: CLEANUP_TOKEN, p_expected_cleanup_attempts: 2,
    p_already_absent: false
  });
  assert.deepEqual(JSON.parse(fetch.requests[2].init.body), {
    p_id: WORK_ID, p_cleanup_owner: 'bridge:notice-cleanup',
    p_cleanup_token: CLEANUP_TOKEN, p_expected_cleanup_attempts: 2,
    p_error: 'cant_delete_message'
  });
});

test('notice cleanup store rejects unbounded batches and stale or content-bearing generations before fetch', async () => {
  const fetch = createFetch();
  const store = createWorkOrchestratorStore({
    supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl
  });

  await assert.rejects(store.claimCleanupBatch({
    now: '2026-08-31T06:00:00.000Z', cleanupOwner: 'bridge:notice-cleanup',
    leaseSeconds: 120, limit: 26
  }), /input is invalid/i);
  await assert.rejects(store.markCleanupDeleted({
    id: WORK_ID, cleanupOwner: 'bridge:notice-cleanup', cleanupToken: 'not-a-token', expectedCleanupAttempts: 2,
    alreadyAbsent: false
  }), /input is invalid/i);
  await assert.rejects(store.markCleanupFailed({
    id: WORK_ID, cleanupOwner: 'bridge:notice-cleanup', cleanupToken: CLEANUP_TOKEN, expectedCleanupAttempts: 2,
    error: serviceRoleKey
  }), (error) => /input is invalid/i.test(error.message) && !error.message.includes(serviceRoleKey));
  assert.equal(fetch.requests.length, 0);
});

test('notice cleanup rejects extra, missing, state-mismatched, and non-finite RPC response facts', async () => {
  const pending = {
    id: WORK_ID,
    notification_state: 'delivered',
    cleanup_state: 'pending',
    cleanup_attempts: 2,
    cleanup_owner: 'bridge:notice-cleanup',
    cleanup_token: CLEANUP_TOKEN,
    cleanup_expires_at: '2026-08-31T06:02:00.000Z',
    cleanup_attempted_at: '2026-08-31T06:00:00.000Z',
    cleaned_at: null,
    cleanup_error: null,
    cleanup_already_absent: false,
    coordinate_status: 'valid',
    slack_channel_id: 'CNOTICE',
    slack_message_ts: '123.45'
  };
  const terminal = {
    id: WORK_ID,
    notification_state: 'deleted',
    cleanup_state: 'deleted',
    cleanup_attempts: 2,
    cleanup_owner: null,
    cleanup_token: null,
    cleanup_expires_at: null,
    cleanup_attempted_at: '2026-08-31T06:00:00.000Z',
    cleaned_at: '2026-08-31T06:00:01.000Z',
    cleanup_error: null,
    cleanup_already_absent: false
  };
  const claimInput = {
    now: '2026-08-31T06:00:00.000Z', cleanupOwner: 'bridge:notice-cleanup', leaseSeconds: 120, limit: 25
  };
  const deleteInput = {
    id: WORK_ID, cleanupOwner: 'bridge:notice-cleanup', cleanupToken: CLEANUP_TOKEN,
    expectedCleanupAttempts: 2, alreadyAbsent: false
  };
  const invalidBodies = [
    { method: 'claim', data: [{ ...pending, unexpected: serviceRoleKey }] },
    { method: 'claim', data: [{ ...pending, cleanup_attempted_at: 'infinity' }] },
    { method: 'delete', data: { applied: true, row: { ...terminal, notification_state: 'delivered' } } },
    { method: 'delete', data: { applied: true, row: Object.fromEntries(
      Object.entries(terminal).filter(([key]) => key !== 'cleaned_at')
    ) } }
  ];

  for (const invalid of invalidBodies) {
    const fetch = createFetch([response({ data: invalid.data })]);
    const store = createWorkOrchestratorStore({
      supabaseUrl: 'https://supabase.example', serviceRoleKey, fetchImpl: fetch.fetchImpl
    });
    const operation = invalid.method === 'claim'
      ? store.claimCleanupBatch(claimInput)
      : store.markCleanupDeleted(deleteInput);
    await assert.rejects(operation, (error) => error.message === 'Work Orchestrator Supabase request failed: response invalid'
      && !error.message.includes(serviceRoleKey));
  }
});
