import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHermesGatewayChannel } from './hermes-gateway-channel.mjs';
import { createHermesGatewayHttpHandler } from './hermes-gateway-http.mjs';
import { notificationReceiptInput } from '../work-orchestrator-v2/contracts.mjs';

const SAFE_PRE_CUTOVER_ENV = Object.freeze({
  WORK_ORCHESTRATOR_V2_SHADOW_WRITES: '0',
  WORK_ORCHESTRATOR_V2_IMMEDIATE_ENABLED: '0',
  WORK_ORCHESTRATOR_V2_WORK_ITEMS_ENABLED: '0',
  WORK_ORCHESTRATOR_V2_DIGEST_ENABLED: '0',
  WORK_ORCHESTRATOR_V2_CLEANUP_ENABLED: '0',
  WORK_ORCHESTRATOR_V2_P0_READBACK_ENABLED: '0',
  WORK_ORCHESTRATOR_V2_P0_CUTOVER_ENABLED: '0',
  AI_WORKER_FOLLOW_UP_ITEMS_ENABLED: '1',
  KAKAO_FOLLOW_UP_ITEMS_ENABLED: '1',
  SLACK_AGENT_CARD_DELIVERY_ENABLED: '1',
  P0_SLACK_ESCALATION_ENABLED: '1'
});
Object.assign(process.env, SAFE_PRE_CUTOVER_ENV, { KAKAO_DOM_BRIDGE_NO_LISTEN: '1' });
const {
  buildCorsHeaders,
  buildHealthConfig,
  buildWorkOrchestratorHealthState,
  attachWorkOrchestratorInvariantHealth,
  readBridgeWorkOrchestratorHealth,
  buildGatewayHealthReadback,
  assertGatewayFailureNotificationDelivered,
  buildWorkerResultAudit,
  buildWorkerTreeKillInvocation,
  compactQueueAuditRecord,
  buildP0SlackEscalationClaim,
  buildP0SlackEscalationMessage,
  createWorkOrchestratorP0Runtime,
  p0SlackEscalationBackoffMs,
  p0SlackEscalationDue,
  resolveWorkOrchestratorP0Config,
  validateWorkOrchestratorV2CutoverConfig,
  runP0EscalationPair,
  createKakaoPhaseScheduler,
  createGatewayConfirmationExecutor,
  createGatewayRegisteredReservationChangeExecutor,
  createGatewayConfirmationValidator,
  createGatewayDocumentExecutor,
  resolveGatewayDocumentConfig,
  createGatewayApplicationFailureNotifier,
  createGatewayFailureNotificationCoordinator,
  createGatewayResultApplicationCoordinator,
  createAiJobDispatcher,
  createErrorsAuditAppender,
  createImmediateNotificationAttemptGuard,
  createWorkOrchestratorDigestRuntime,
  createWorkOrchestratorImmediateRuntime,
  createWorkOrchestratorActionPoller,
  createImmediateNoticeUpdatePoller,
  createWorkOrchestratorShadowRuntime,
  configForHermesTransport,
  classifyInitialScanIngress,
  gatewayDispatchFailurePolicy,
  finalizeGatewayDispatchFailurePolicy,
  registerAcceptedRoomEvent,
  semanticRoomEventIdentity,
  hasUnreadCount,
  handleEvent,
  handleWorkOrchestratorDigestMaintenance,
  listPendingWorkActionsV2,
  resolveSlackActionPollIntervalMs,
  applyPendingWorkActionPatchV2,
  runSlackActionPollPair,
  slackActionMaintenanceSucceeded,
  mergeQueuedRoomJobs,
  kakaoSendAllowedForTransport,
  mapWorkerPayloadToSupabaseStatus,
  normalizeEvent,
  roomKeyForDebounce,
  recoverFailedGatewayDispatch,
  resolveHermesTransport,
  resolveHermesMaxAttempts,
  shouldDetachWorkerProcess,
  shouldQueueTopRowEvent,
  shouldSkipSupabaseRowAsLowValue,
  shouldSkipWorkerForPreview
} = await import('./server.mjs');

test('authoritative automation resolution bridge updates exact coordinates and records exact readback', async () => {
  const updates = [];
  const readbacks = [];
  const receipt = {
    id: '99999999-9999-4999-8999-999999999999',
    source_event_key: 'event-authoritative-bridge-1',
    slack_channel_id: 'CINBOX', slack_message_ts: '123.45',
    updated_at: '2026-08-31T01:00:00.000Z',
    payload: {
      automation_notice_update: {
        status: 'pending', resolution_kind: 'auto_reply_readback',
        notice_text: 'The automated reply was confirmed by authoritative readback.'
      }
    }
  };
  const runtime = createImmediateNoticeUpdatePoller({
    config: { immediateEnabled: true, workItemsEnabled: true },
    store: {
      listImmediateNoticeUpdateRequests: async () => [receipt],
      markImmediateNoticeUpdated: async (input) => {
        readbacks.push(input);
        return { applied: true, row: { ...receipt, updated_at: input.updatedAt } };
      }
    },
    slack: {
      updateMessage: async (input) => {
        updates.push(input);
        return {
          ok: true, channel: input.channel, ts: input.ts,
          message: { text: input.text, blocks: input.blocks }
        };
      }
    },
    now: () => new Date('2026-08-31T01:00:01.000Z')
  });

  const result = await runtime.poll('manual');

  assert.deepEqual(result, { status: 'ok', trigger: 'manual', scanned: 1, updated: 1, failed: 0, conflicts: 0 });
  assert.equal(updates[0].channel, 'CINBOX');
  assert.equal(updates[0].ts, '123.45');
  assert.equal(readbacks[0].sourceEventKey, 'event-authoritative-bridge-1');
  assert.equal(readbacks[0].channelId, 'CINBOX');
  assert.equal(readbacks[0].messageTs, '123.45');
  assert.equal(readbacks[0].contentHash, 'b05d0e2c5e96484a6fe9c03d6405ceccdf79ae05bfeab5ded4c952e93aa32221');
});

test('authoritative automation resolution bridge rejects matching coordinates with mismatched updated content', async () => {
  const secret = 'customer-private response';
  let readbacks = 0;
  const receipt = {
    id: '99999999-9999-4999-8999-999999999994', source_event_key: 'event-authoritative-bridge-3',
    slack_channel_id: 'CINBOX', slack_message_ts: '124.46', updated_at: '2026-08-31T01:00:00.000Z',
    payload: { automation_notice_update: { status: 'pending', resolution_kind: 'auto_reply_readback' } }
  };
  const runtime = createImmediateNoticeUpdatePoller({
    config: { immediateEnabled: true, workItemsEnabled: true },
    store: {
      listImmediateNoticeUpdateRequests: async () => [receipt],
      markImmediateNoticeUpdated: async () => { readbacks += 1; return { applied: true, row: receipt }; }
    },
    slack: { updateMessage: async (input) => ({
      ok: true, channel: input.channel, ts: input.ts,
      message: { text: `${input.text} ${secret}`, blocks: input.blocks }
    }) }
  });

  const result = await runtime.poll('manual');

  assert.deepEqual(result, { status: 'ok', trigger: 'manual', scanned: 1, updated: 0, failed: 1, conflicts: 0 });
  assert.equal(readbacks, 0);
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('authoritative automation resolution bridge rejects missing or unsafe update readback without leaking content', async (t) => {
  const secret = 'customer-private unsafe-response';
  const responses = [
    ['missing', {}],
    ['unsafe', { text: secret, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: secret } }] }]
  ];
  for (const [name, message] of responses) {
    await t.test(name, async () => {
      let readbacks = 0;
      const receipt = {
        id: '99999999-9999-4999-8999-999999999993',
        source_event_key: `event-authoritative-bridge-${name}`,
        slack_channel_id: 'CINBOX', slack_message_ts: '125.47',
        updated_at: '2026-08-31T01:00:00.000Z',
        payload: { automation_notice_update: { status: 'pending', resolution_kind: 'operation_readback' } }
      };
      const runtime = createImmediateNoticeUpdatePoller({
        config: { immediateEnabled: true, workItemsEnabled: true },
        store: {
          listImmediateNoticeUpdateRequests: async () => [receipt],
          markImmediateNoticeUpdated: async () => { readbacks += 1; return { applied: true, row: receipt }; }
        },
        slack: { updateMessage: async (input) => ({
          ok: true, channel: input.channel, ts: input.ts, message
        }) }
      });

      const result = await runtime.poll('interval');

      assert.equal(result.failed, 1);
      assert.equal(result.updated, 0);
      assert.equal(readbacks, 0);
      assert.equal(JSON.stringify(result).includes(secret), false);
    });
  }
});

test('authoritative automation resolution bridge leaves failed update pending for bounded retry without touching work', async () => {
  let attempts = 0;
  let readbacks = 0;
  const receipt = {
    id: '99999999-9999-4999-8999-999999999998',
    source_event_key: 'event-authoritative-bridge-2',
    slack_channel_id: 'CINBOX', slack_message_ts: '999.1',
    updated_at: '2026-08-31T01:00:00.000Z',
    payload: {
      automation_notice_update: {
        status: 'pending', resolution_kind: 'operation_readback',
        notice_text: 'The automated operation was confirmed by authoritative readback.'
      }
    }
  };
  const runtime = createImmediateNoticeUpdatePoller({
    config: { immediateEnabled: true, workItemsEnabled: true },
    store: {
      listImmediateNoticeUpdateRequests: async () => [receipt],
      markImmediateNoticeUpdated: async () => { readbacks += 1; return { applied: true, row: receipt }; }
    },
    slack: {
      updateMessage: async (input) => {
        attempts += 1;
        if (attempts === 1) throw new Error('customer-private transport failure');
        return {
          ok: true, channel: input.channel, ts: input.ts,
          message: { text: input.text, blocks: input.blocks }
        };
      }
    }
  });

  const failed = await runtime.poll('interval');
  const retried = await runtime.poll('interval');

  assert.equal(failed.failed, 1);
  assert.equal(readbacks, 1);
  assert.equal(retried.updated, 1);
  assert.equal(JSON.stringify(failed).includes('customer-private'), false);
});

function shadowEventRequest(event) {
  const req = Readable.from([JSON.stringify(event)]);
  req.method = 'POST';
  req.url = '/events';
  req.headers = { host: '127.0.0.1' };
  return req;
}

function shadowEventResponse() {
  let resolve;
  const completed = new Promise((done) => { resolve = done; });
  return {
    completed,
    response: {
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        this.body = JSON.parse(body);
        resolve(this);
      }
    }
  };
}

async function postShadowEvent(event, dependencies) {
  const { response, completed } = shadowEventResponse();
  await handleEvent(shadowEventRequest(event), response, dependencies);
  await completed;
  return response;
}

const TASK7_NEUTRAL_INCIDENT_URL = new URL(
  '../../test/fixtures/kakao-staff-confirmed-mutations/incident-registered-replacement-001.json',
  import.meta.url
);
const TASK7_INCIDENT = JSON.parse(await readFile(TASK7_NEUTRAL_INCIDENT_URL, 'utf8'));
const TASK7_TOKEN = 'task-7-local-token';
const TASK7_NOW = Date.parse('2026-08-27T01:00:00.000Z');

test('Task 7 loads the sanitized replay fixture through a neutral incident identifier', async () => {
  const incident = JSON.parse(await readFile(TASK7_NEUTRAL_INCIDENT_URL, 'utf8'));
  assert.equal(incident.trade_id, '260824-008');
  assert.equal(incident.room_revision, 8);
  assert.deepEqual(incident.exact_old_rows, [{
    schedule_id: '260824-008-07',
    name: '소니 FE 28-135mm',
    quantity: 1
  }]);
});

const WORK_ACTION_ID = '11111111-1111-4111-8111-111111111111';
const WORK_ACTION_NOW = '2026-08-30T06:00:00.000Z';

function pendingWorkActionRow(overrides = {}) {
  const action = overrides.action ?? { type: 'progress' };
  return {
    id: WORK_ACTION_ID,
    state: 'open',
    priority: 'normal',
    actionable_at: '2026-08-30T03:00:00.000Z',
    snoozed_until: null,
    resolution_kind: null,
    resolution_evidence: {},
    resolved_at: null,
    resolved_by: null,
    pending_action: {
      type: action.type,
      action,
      status: 'pending',
      requested_at: '2026-08-30T05:59:00.000Z',
      requested_by: 'UOWNER1',
      expected_version: 4
    },
    version: 5,
    payload: { requires_human_action: true },
    updated_at: '2026-08-30T05:59:00.000Z',
    ...overrides,
    pending_action: overrides.pending_action ?? {
      type: action.type,
      action,
      status: 'pending',
      requested_at: '2026-08-30T05:59:00.000Z',
      requested_by: 'UOWNER1',
      expected_version: 4
    }
  };
}

test('Work Orchestrator action list uses the service-only filtered RPC with an exact bounded request', async () => {
  const requests = [];
  const row = pendingWorkActionRow();
  const rows = await listPendingWorkActionsV2({
    supabaseUrl: 'https://supabase.example/', serviceRoleKey: 'service-secret', limit: 3,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return { ok: true, status: 200, text: async () => JSON.stringify([row]) };
    }
  });
  assert.deepEqual(rows, [row]);
  assert.equal(requests[0].url, 'https://supabase.example/rest/v1/rpc/list_pending_work_actions_v2');
  assert.equal(requests[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(requests[0].init.body), { p_limit: 3 });
  assert.equal(requests[0].init.headers.apikey, 'service-secret');
  assert.equal(requests[0].init.headers.authorization, 'Bearer service-secret');
});

test('Work Orchestrator pending-action RPC bounds requests to 1..50 and rejects non-exact rows', async () => {
  for (const limit of [0, 51, -1, 1.5, Number.NaN]) {
    await assert.rejects(listPendingWorkActionsV2({
      supabaseUrl: 'https://supabase.example', serviceRoleKey: 'service-secret', limit,
      fetchImpl: async () => assert.fail('invalid limits must fail before fetch')
    }), { message: 'Work Orchestrator action request failed' });
  }
  const row = pendingWorkActionRow();
  await assert.rejects(listPendingWorkActionsV2({
    supabaseUrl: 'https://supabase.example', serviceRoleKey: 'service-secret', limit: 50,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify([{ ...row, extra: true }]) })
  }), { message: 'Work Orchestrator action request failed' });
});

test('Slack action poll interval is a strict bounded integer with a safe fallback', () => {
  for (const value of [undefined, null, '', '0', '999', '-1', '1.5', 'NaN', 'Infinity', '300001', 0, -1, Number.NaN]) {
    assert.equal(resolveSlackActionPollIntervalMs(value), 10_000, String(value));
  }
  assert.equal(resolveSlackActionPollIntervalMs('1000'), 1000);
  assert.equal(resolveSlackActionPollIntervalMs(45_000), 45_000);
  assert.equal(resolveSlackActionPollIntervalMs('300000'), 300_000);
});

test('Work Orchestrator action apply PATCH is fenced by id, current version, active state, and pending status', async () => {
  const requests = [];
  const row = pendingWorkActionRow();
  const transition = {
    status: 'ready', expectedVersion: 5, expectedPendingStatus: 'pending',
    patch: {
      state: 'in_progress', snoozed_until: null, actionable_at: WORK_ACTION_NOW,
      pending_action: {}, version: 6, updated_at: WORK_ACTION_NOW
    }
  };
  const returned = { ...row, ...transition.patch };
  const result = await applyPendingWorkActionPatchV2({
    supabaseUrl: 'https://supabase.example', serviceRoleKey: 'service-secret', row, transition,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return { ok: true, status: 200, text: async () => JSON.stringify([returned]) };
    }
  });
  assert.deepEqual(result, { applied: true });
  const url = new URL(requests[0].url);
  assert.equal(url.searchParams.get('id'), `eq.${WORK_ACTION_ID}`);
  assert.equal(url.searchParams.get('version'), 'eq.5');
  assert.equal(url.searchParams.get('state'), 'in.(open,in_progress,snoozed)');
  assert.equal(url.searchParams.get('pending_action->>status'), 'eq.pending');
  assert.equal(requests[0].init.method, 'PATCH');
  assert.equal(requests[0].init.headers.prefer, 'return=representation');
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    state: 'in_progress', snoozed_until: null, actionable_at: WORK_ACTION_NOW,
    pending_action: {}, version: 6
  });
});

test('Work Orchestrator action apply accepts equivalent PostgreSQL timestamps and trigger-owned updated_at', async () => {
  const row = pendingWorkActionRow();
  const transition = {
    status: 'ready', expectedVersion: 5, expectedPendingStatus: 'pending',
    patch: {
      state: 'snoozed', snoozed_until: '2026-08-30T09:00:00.000Z',
      actionable_at: '2026-08-30T09:00:00.000Z', pending_action: {},
      version: 6, updated_at: WORK_ACTION_NOW
    }
  };
  const returned = {
    ...row,
    ...transition.patch,
    snoozed_until: '2026-08-30T18:00:00+09:00',
    actionable_at: '2026-08-30T18:00:00+09:00',
    updated_at: '2026-08-30T15:00:00.123+09:00'
  };
  const result = await applyPendingWorkActionPatchV2({
    supabaseUrl: 'https://supabase.example', serviceRoleKey: 'service-secret', row, transition,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify([returned]) })
  });
  assert.deepEqual(result, { applied: true });
});

test('Work Orchestrator action poller uses terminal CAS so two pollers have one winner', async () => {
  let current = pendingWorkActionRow();
  const list = async () => current.pending_action?.status === 'pending' ? [structuredClone(current)] : [];
  const apply = async ({ row, transition }) => {
    await Promise.resolve();
    if (current.version !== row.version || current.pending_action?.status !== 'pending') return { applied: false };
    current = { ...current, ...structuredClone(transition.patch) };
    return { applied: true };
  };
  const config = { workItemsEnabled: true };
  const first = createWorkOrchestratorActionPoller({ config, storeReady: true, list, apply, now: () => WORK_ACTION_NOW });
  const second = createWorkOrchestratorActionPoller({ config, storeReady: true, list, apply, now: () => WORK_ACTION_NOW });
  const results = await Promise.all([first.poll('manual'), second.poll('manual')]);
  assert.equal(results.reduce((sum, result) => sum + result.applied, 0), 1);
  assert.equal(results.reduce((sum, result) => sum + result.conflicts, 0), 1);
  assert.equal(current.state, 'in_progress');
  assert.equal(current.version, 6);
  assert.deepEqual(current.pending_action, {});
});

test('Work Orchestrator action poller preserves request_resolve, fails invalid rows closed, and has no stuck pre-claim state', async () => {
  const resolveRow = pendingWorkActionRow({ action: { type: 'request_resolve' } });
  const invalidRow = pendingWorkActionRow({ pending_action: { status: 'pending', customer: 'private-content' } });
  const applied = [];
  const runtime = createWorkOrchestratorActionPoller({
    config: { workItemsEnabled: true }, storeReady: true,
    list: async () => [resolveRow, invalidRow],
    apply: async (value) => { applied.push(value); return { applied: true }; },
    now: () => WORK_ACTION_NOW
  });
  assert.deepEqual(await runtime.poll('manual'), {
    status: 'ok', trigger: 'manual', scanned: 2, applied: 0,
    awaitingResolution: 1, conflicts: 0, invalid: 1
  });
  assert.deepEqual(applied, []);
  assert.equal(resolveRow.pending_action.status, 'pending');
  assert.equal(JSON.stringify(runtime.state).includes('private-content'), false);

  let firstAttempt = true;
  let durable = pendingWorkActionRow();
  const list = async () => [structuredClone(durable)];
  const flakyApply = async ({ transition }) => {
    if (firstAttempt) { firstAttempt = false; throw new Error('private transport detail'); }
    durable = { ...durable, ...transition.patch };
    return { applied: true };
  };
  const failed = createWorkOrchestratorActionPoller({
    config: { workItemsEnabled: true }, storeReady: true, list, apply: flakyApply, now: () => WORK_ACTION_NOW
  });
  assert.equal((await failed.poll('interval')).status, 'error');
  assert.equal(durable.pending_action.status, 'pending');
  const restarted = createWorkOrchestratorActionPoller({
    config: { workItemsEnabled: true }, storeReady: true, list, apply: flakyApply, now: () => WORK_ACTION_NOW
  });
  assert.equal((await restarted.poll('startup')).applied, 1);
  assert.deepEqual(durable.pending_action, {});
});

test('Work Orchestrator action poller is active only with enabled work-items and ready store/seams', async () => {
  const list = async () => [];
  const apply = async () => ({ applied: true });
  const off = createWorkOrchestratorActionPoller({ config: { workItemsEnabled: false }, storeReady: true, list, apply });
  const noStore = createWorkOrchestratorActionPoller({ config: { workItemsEnabled: true }, storeReady: false, list, apply });
  const ready = createWorkOrchestratorActionPoller({ config: { workItemsEnabled: true }, storeReady: true, list, apply });
  assert.equal(off.enabled, false);
  assert.equal(noStore.enabled, false);
  assert.equal(ready.enabled, true);
  assert.deepEqual(await off.poll('manual'), {
    status: 'disabled', trigger: 'manual', scanned: 0, applied: 0,
    awaitingResolution: 0, conflicts: 0, invalid: 0
  });
});

test('Work Orchestrator action health exposes only bounded status and counts', async () => {
  const shared = {};
  const runtime = createWorkOrchestratorActionPoller({
    config: { workItemsEnabled: true }, storeReady: true,
    list: async () => [pendingWorkActionRow({
      pending_action: { status: 'pending', id: WORK_ACTION_ID, customer: 'private-customer-content' }
    })],
    apply: async () => ({ applied: true }),
    now: () => WORK_ACTION_NOW,
    state: shared
  });
  await runtime.poll('manual');
  const health = buildWorkOrchestratorHealthState(shared);
  assert.deepEqual(health.lastWorkActionPoll, {
    status: 'ok', trigger: 'manual', scanned: 1, applied: 0,
    awaitingResolution: 0, conflicts: 0, invalid: 1
  });
  assert.equal(health.workActionPollRunning, false);
  assert.equal(JSON.stringify(health).includes(WORK_ACTION_ID), false);
  assert.equal(JSON.stringify(health).includes('private-customer-content'), false);
});

test('combined Slack action maintenance keeps legacy and v2 independent and v2 output content-free', async () => {
  let legacyCalls = 0;
  const result = await runSlackActionPollPair({
    reason: 'manual',
    legacy: async () => { legacyCalls += 1; return { scanned: 1, handled: 1, errors: [] }; },
    workActions: { poll: async () => { throw new Error(`private ${WORK_ACTION_ID}`); } }
  });
  assert.equal(legacyCalls, 1);
  assert.deepEqual(result.legacy, { scanned: 1, handled: 1, errors: [] });
  assert.deepEqual(result.workOrchestratorV2, {
    status: 'error', trigger: 'manual', scanned: 0, applied: 0,
    awaitingResolution: 0, conflicts: 0, invalid: 0
  });
  assert.equal(JSON.stringify(result).includes(WORK_ACTION_ID), false);
  assert.equal(slackActionMaintenanceSucceeded(result), false);

  let v2Calls = 0;
  const second = await runSlackActionPollPair({
    reason: 'interval',
    legacy: async () => { throw new Error('legacy failure'); },
    workActions: { poll: async () => { v2Calls += 1; return {
      status: 'ok', trigger: 'interval', scanned: 0, applied: 0,
      awaitingResolution: 0, conflicts: 0, invalid: 0
    }; } }
  });
  assert.equal(v2Calls, 1);
  assert.equal(second.legacyError, true);
  assert.equal(second.workOrchestratorV2.status, 'ok');
  assert.equal(slackActionMaintenanceSucceeded(second), false);
  assert.equal(slackActionMaintenanceSucceeded({
    legacy: { errors: [] },
    workOrchestratorV2: {
      status: 'ok', trigger: 'manual', scanned: 0, applied: 0,
      awaitingResolution: 0, conflicts: 0, invalid: 0
    }
  }), true);
});

function task7Mutation(overrides = {}) {
  return {
    confirmed: true,
    kind: 'equipment_replace',
    target_scope: 'registered_trade',
    trade_id: TASK7_INCIDENT.trade_id,
    source_evidence: {
      customer_request: TASK7_INCIDENT.customer_change_text,
      staff_confirmation: TASK7_INCIDENT.staff_confirmation_text,
      conversation_revision: TASK7_INCIDENT.room_revision
    },
    expected_period: structuredClone(TASK7_INCIDENT.expected_period),
    expected_before: structuredClone(TASK7_INCIDENT.exact_old_rows),
    desired_after: structuredClone(TASK7_INCIDENT.exact_desired_rows),
    date_change: null,
    ...overrides
  };
}

function task7HermesDecision(mutation) {
  return {
    classification: 'reservation',
    confidence: 'high',
    should_write_to_sheet: false,
    kill_switch_observed: 'active',
    customer: { name: '테스트 고객' },
    owner_review_required: false,
    reservation_inquiry: {
      is_reservation_inquiry: true,
      confirmed: true,
      already_registered: true,
      equipment_requested: []
    },
    existing_confirm_request_ids: [],
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      duplicate_checked_contract_master: true,
      duplicate_checked_schedule_detail: true,
      duplicate_checked_request_sheet: true,
      no_auto_reply_sent: true,
      latest_customer_message_after_last_staff_reply: false
    },
    staff_confirmed_mutation: mutation,
    follow_up_items: [{
      type: 'reservation_review', route: 'schedule', taskKey: 'must-be-removed-after-exact-success',
      priority: 'high', status: 'open', title: '중복 승인', customer_name: '테스트 고객',
      summary: '이미 직원 확정된 변경', recommended_action: '다시 승인', suggested_reply_draft: '',
      evidence: [], requiresHumanAction: true, actionFamily: 'reservation_change',
      businessKey: `trade:${mutation.trade_id}`, alertLevel: 'none'
    }],
    suggested_reply_draft: '변경 완료되었습니다.',
    reply_decision: {
      replyMode: 'no_reply', text: '', confidence: 'high', reason: '직원 답변으로 이미 안내됨',
      shouldCreateTask: false, safetyClass: 'no_send', grounding: 'staff_confirmation',
      requiresRag: false, attachmentKeys: [], alreadyDelivered: true
    }
  };
}

function task7AuthoritativeReadback() {
  const desired = TASK7_INCIDENT.exact_desired_rows[0];
  return {
    contract: {
      startDate: TASK7_INCIDENT.expected_period.start_date,
      startTime: TASK7_INCIDENT.expected_period.start_time,
      endDate: TASK7_INCIDENT.expected_period.end_date,
      endTime: TASK7_INCIDENT.expected_period.end_time
    },
    schedule: {
      periods: [`${TASK7_INCIDENT.expected_period.start_date}|${TASK7_INCIDENT.expected_period.start_time}|${TASK7_INCIDENT.expected_period.end_date}|${TASK7_INCIDENT.expected_period.end_time}`],
      rows: [{
        scheduleId: '260824-008-08', setName: '', name: desired.name,
        qty: desired.quantity, isComponent: false
      }],
      topLevelQuantities: { [desired.name]: desired.quantity }
    },
    ledger: {
      rows: 1,
      startDate: TASK7_INCIDENT.expected_period.start_date,
      contractLink: 'https://example.test/contracts/260824-008',
      links: ['https://example.test/contracts/260824-008']
    }
  };
}

function task7AuthoritativeBeforeReadback() {
  const expected = TASK7_INCIDENT.exact_old_rows[0];
  return {
    contract: {
      startDate: TASK7_INCIDENT.expected_period.start_date,
      startTime: TASK7_INCIDENT.expected_period.start_time,
      endDate: TASK7_INCIDENT.expected_period.end_date,
      endTime: TASK7_INCIDENT.expected_period.end_time
    },
    schedule: {
      periods: [`${TASK7_INCIDENT.expected_period.start_date}|${TASK7_INCIDENT.expected_period.start_time}|${TASK7_INCIDENT.expected_period.end_date}|${TASK7_INCIDENT.expected_period.end_time}`],
      rows: [{
        scheduleId: expected.schedule_id, setName: '', name: expected.name,
        qty: expected.quantity, isComponent: false
      }],
      topLevelQuantities: { [expected.name]: expected.quantity }
    },
    ledger: null
  };
}

async function startTask7Http(handler) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (!(await handler(req, res, url))) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  let closed = false;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => {
      if (closed) return Promise.resolve();
      closed = true;
      return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  };
}

async function task7Post(app, pathname, body) {
  return fetch(app.url + pathname, {
    method: 'POST',
    headers: { authorization: `Bearer ${TASK7_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function createTask7Replay({ id, runRegisteredTradeCorrection, finalize, onFailure } = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), `kakao-staff-confirmed-${id}-`));
  const channel = createHermesGatewayChannel({
    directory, leaseMs: 60_000, maxAttempts: 2, now: () => TASK7_NOW
  });
  const jobId = `task7-${id}-job`;
  const roomKey = `task7-${id}-room`;
  const revision = TASK7_INCIDENT.room_revision;
  const event = {
    schema: 'village-kakao-gateway-event/v1', job_id: jobId, room_key: roomKey,
    room_revision: revision, detected_at: '2026-08-27T00:59:59.000Z', prompt: 'native Hermes prompt', raw: {}
  };
  const localJob = {
    jobId, roomKey, roomRevision: revision,
    detectedAt: event.detected_at, previewText: TASK7_INCIDENT.customer_change_text
  };
  await channel.enqueue(event, {
    localContext: {
      job: localJob,
      turn_internal: {
        snapshot: { schema: 'kakao-room-snapshot/v1', jobId, roomKey, roomRevision: revision },
        lookupContext: { kill_switch: { status: 'active', error: null } },
        ragContext: null,
        brainContext: null
      }
    }
  });
  const claim = await channel.claim({ consumerId: `task7-${id}-consumer`, waitMs: 0 });
  const preparedDecisions = [];
  let applyCalls = 0;
  let finalizeCalls = 0;
  const coordinator = createGatewayResultApplicationCoordinator({
    channel,
    getConfig: () => ({ autoSendEnabled: true }),
    apply: async ({ prepared }) => {
      applyCalls += 1;
      preparedDecisions.push(structuredClone(prepared.decision));
      return {
        prepared, snapshotChanged: false, superseded: false,
        autoReplyResult: { attempted: false, sent: false }
      };
    },
    finalize: async ({ applied }) => {
      finalizeCalls += 1;
      if (typeof finalize === 'function') return finalize(applied.prepared);
      return {
        status: 'ai_completed', decision: applied.prepared.decision,
        followUpResult: { inserted: 0, rows: [] },
        slackDeliveryResult: { skipped: true, reason: 'no_rows', results: [] },
        autoReplyResult: { attempted: false, sent: false }
      };
    },
    onFailure: typeof onFailure === 'function' ? onFailure : async () => {}
  });
  const executeRegisteredReservationChange = createGatewayRegisteredReservationChangeExecutor({
    getConfig: () => ({
      gasApiUrl: 'https://script.google.com/macros/s/offline-fixture/exec',
      sheetApiKey: 'offline-fake-only'
    }),
    runRegisteredTradeCorrection,
    randomUUID: () => `task7-${id}-receipt`,
    now: () => new Date(TASK7_NOW)
  });
  const handler = createHermesGatewayHttpHandler({
    token: TASK7_TOKEN, channel, transport: 'gateway', now: () => TASK7_NOW,
    executeRegisteredReservationChange,
    enqueueResultApplication: (completed) => coordinator.enqueue(completed)
  });
  const app = await startTask7Http(handler);
  const mutation = task7Mutation();
  const toolBody = {
    schema: 'village-registered-reservation-change-request/v1',
    job_id: claim.job_id, room_key: claim.room_key, room_revision: claim.room_revision,
    lease_id: claim.lease_id, mutation
  };
  return {
    app, channel, claim, coordinator, directory, mutation, toolBody, preparedDecisions,
    counts: () => ({ applyCalls, finalizeCalls }),
    async executeTool() {
      const response = await task7Post(app, '/hermes/v1/tools/registered-reservation-change', toolBody);
      assert.equal(response.status, 200);
      return response.json();
    },
    async completeHermesFinal() {
      const response = await task7Post(app, '/hermes/v1/results', {
        job_id: claim.job_id, room_key: claim.room_key, room_revision: claim.room_revision,
        lease_id: claim.lease_id,
        content: `FINAL_JSON\n${JSON.stringify(task7HermesDecision(mutation))}`
      });
      assert.equal(response.status, 200);
      await coordinator.idle();
    },
    async close() {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  };
}

test('Gateway initial unread scans become no-send startup catch-up work even when legacy scan processing is disabled', () => {
  for (const hermesTransport of ['gateway', 'gateway_no_send']) {
    const result = classifyInitialScanIngress({
      reason: 'initial_scan', roomKey: 'chat:recovery', unreadCount: 2,
      previewText: '중요 이상율 2 예약 양식'
    }, { processInitialScan: false, hermesTransport });
    assert.equal(result.action, 'queue');
    assert.equal(result.event.reason, 'startup_catchup');
    assert.equal(result.event.originalReason, 'initial_scan');
    assert.equal(result.event.recoveryOnly, true);
  }
});

test('initial scan ingress remains conservative for CLI and rows without a visible unread count', () => {
  assert.deepEqual(classifyInitialScanIngress({
    reason: 'initial_scan', roomKey: 'chat:cli', unreadCount: 1
  }, { processInitialScan: false, hermesTransport: 'cli' }), {
    action: 'ignore', reason: 'initial_scan_disabled'
  });
  assert.deepEqual(classifyInitialScanIngress({
    reason: 'initial_scan', roomKey: 'chat:read', unreadCount: 0
  }, { processInitialScan: true, hermesTransport: 'gateway' }), {
    action: 'ignore', reason: 'initial_scan_without_unread'
  });
  const ordinary = { reason: 'mutation', roomKey: 'chat:live', unreadCount: 1 };
  assert.deepEqual(classifyInitialScanIngress(ordinary, {
    processInitialScan: false, hermesTransport: 'gateway'
  }), { action: 'continue', event: ordinary });
});

test('missing Kakao conversation evidence gets exactly one durable retry before human review', () => {
  const error = new Error('conversation body not rendered');
  error.code = 'kakao_conversation_evidence_unavailable';
  assert.deepEqual(gatewayDispatchFailurePolicy(error, { recoveryAttempts: 0 }), {
    status: 'ai_worker_error',
    retryable: true,
    notifyHuman: false,
    errorType: 'kakao_conversation_evidence_unavailable'
  });
  assert.deepEqual(gatewayDispatchFailurePolicy(error, { recoveryAttempts: 1 }), {
    status: 'needs_human_review',
    retryable: false,
    notifyHuman: true,
    errorType: 'kakao_conversation_evidence_unavailable'
  });
  assert.deepEqual(gatewayDispatchFailurePolicy(new Error('invalid contract'), { recoveryAttempts: 0 }), {
    status: 'needs_human_review',
    retryable: false,
    notifyHuman: true,
    errorType: 'gateway_dispatch_failed'
  });
});

test('a retry that cannot be durably recorded is promoted to immediate human review', () => {
  const retry = {
    status: 'ai_worker_error', retryable: true, notifyHuman: false,
    errorType: 'kakao_conversation_evidence_unavailable'
  };
  assert.deepEqual(finalizeGatewayDispatchFailurePolicy(retry, { ok: true }), retry);
  assert.deepEqual(finalizeGatewayDispatchFailurePolicy(retry, { skipped: true }), {
    status: 'needs_human_review', retryable: false, notifyHuman: true,
    errorType: 'kakao_conversation_evidence_unavailable'
  });
  assert.deepEqual(finalizeGatewayDispatchFailurePolicy(retry, null), {
    status: 'needs_human_review', retryable: false, notifyHuman: true,
    errorType: 'kakao_conversation_evidence_unavailable'
  });
});

test('event ingress canonicalizes valid high-precision ISO timestamps for the strict Gateway contract', () => {
  const event = normalizeEvent({
    roomKey: 'chat:operator-recovery',
    reason: 'operator_recovery',
    detectedAt: '2026-08-23T00:54:20.1696859Z'
  });
  assert.equal(event.detectedAt, '2026-08-23T00:54:20.169Z');
  assert.equal(event.raw.detectedAt, '2026-08-23T00:54:20.1696859Z');
});

test('Hermes transport defaults only to CLI and rejects unknown values without activating Gateway', () => {
  assert.equal(resolveHermesTransport(undefined), 'cli');
  assert.equal(resolveHermesTransport(''), 'cli');
  assert.equal(resolveHermesTransport('cli'), 'cli');
  assert.equal(resolveHermesTransport('gateway'), 'gateway');
  assert.equal(resolveHermesTransport('gateway_no_send'), 'gateway_no_send');
  assert.throws(() => resolveHermesTransport('gateawy'), /Unsupported KAKAO_HERMES_TRANSPORT/);
});

test('Hermes Gateway max-attempt environment boundary defaults to two and rejects a third claim', () => {
  assert.equal(resolveHermesMaxAttempts(undefined), 2);
  assert.equal(resolveHermesMaxAttempts(''), 2);
  assert.equal(resolveHermesMaxAttempts('1'), 1);
  assert.equal(resolveHermesMaxAttempts('2'), 2);
  assert.throws(() => resolveHermesMaxAttempts('3'), /KAKAO_HERMES_MAX_ATTEMPTS/);
  assert.throws(() => resolveHermesMaxAttempts('1.5'), /KAKAO_HERMES_MAX_ATTEMPTS/);
});

test('AI job dispatcher preserves the exact legacy CLI path when transport is missing', async () => {
  const calls = [];
  const dispatcher = createAiJobDispatcher({
    transport: undefined,
    runLegacy: async (job, context) => {
      calls.push({ job, context });
      return { ok: true, legacy: true };
    },
    capture: async () => { throw new Error('Gateway capture must not run'); },
    buildTurn: async () => { throw new Error('Gateway turn builder must not run'); },
    channel: { enqueue: async () => { throw new Error('Gateway channel must not run'); } }
  });
  const job = { jobId: 'cli-job', roomKey: 'cli-room', roomRevision: 1 };
  const result = await dispatcher(job, { origin: 'test' });
  assert.deepEqual(result, { ok: true, legacy: true });
  assert.deepEqual(calls, [{ job, context: { origin: 'test' } }]);
});

test('Gateway dispatcher captures once and enqueues only seven plugin fields with local context kept durable', async () => {
  const calls = [];
  const enqueued = [];
  const job = {
    jobId: 'gateway-job', roomKey: 'gateway-room', roomRevision: 4,
    detectedAt: '2026-08-21T01:02:03.000Z', previewText: 'customer text'
  };
  const snapshot = {
    schema: 'kakao-room-snapshot/v1', jobId: job.jobId, roomKey: job.roomKey,
    roomRevision: job.roomRevision, capturedAt: '2026-08-21T01:02:04.000Z'
  };
  const internal = { snapshot, private_lookup: { secret: 'local only' } };
  const event = {
    schema: 'village-kakao-gateway-event/v1', job_id: job.jobId, room_key: job.roomKey,
    room_revision: job.roomRevision, prompt: 'native Hermes prompt',
    detected_at: job.detectedAt, raw: { safe: true }
  };
  const dispatcher = createAiJobDispatcher({
    transport: 'gateway',
    getConfig: () => ({ autoSendEnabled: true }),
    capture: async ({ config, job: capturedJob }) => {
      calls.push(['capture', config, capturedJob]);
      return { snapshot };
    },
    buildTurn: async ({ config, job: builtJob, capture }) => {
      calls.push(['build', config, builtJob, capture]);
      return { event, internal };
    },
    channel: {
      async enqueue(envelope, options) {
        enqueued.push({ envelope: structuredClone(envelope), options: structuredClone(options) });
        return { job_id: envelope.job_id, state: 'ready' };
      }
    },
    runLegacy: async () => { throw new Error('legacy Hermes child path must not run'); }
  });

  const result = await dispatcher(job, { origin: 'live_dom_event' });
  assert.equal(result.queued, true);
  assert.equal(calls.filter(([kind]) => kind === 'capture').length, 1);
  assert.equal(calls.filter(([kind]) => kind === 'build').length, 1);
  assert.deepEqual(Object.keys(enqueued[0].envelope).sort(), [
    'detected_at', 'job_id', 'prompt', 'raw', 'room_key', 'room_revision', 'schema'
  ]);
  assert.deepEqual(enqueued[0].envelope, event);
  assert.deepEqual(enqueued[0].options.localContext, { job, turn_internal: internal });
  assert.equal(JSON.stringify(enqueued[0].envelope).includes('local only'), false);
});

test('gateway_no_send still builds a native turn while forcing all runtime send and write gates off', async () => {
  assert.equal(kakaoSendAllowedForTransport('gateway_no_send'), false);
  assert.equal(kakaoSendAllowedForTransport('gateway'), true);
  assert.equal(kakaoSendAllowedForTransport('cli'), true);
  assert.deepEqual(
    configForHermesTransport({ autoSendEnabled: true, windowsWritesEnabled: true, marker: 'shared' }, 'gateway_no_send'),
    { autoSendEnabled: false, windowsWritesEnabled: false, marker: 'shared' }
  );
  let seenConfig = null;
  let legacyCalls = 0;
  const dispatcher = createAiJobDispatcher({
    transport: 'gateway_no_send',
    getConfig: () => ({ autoSendEnabled: true, windowsWritesEnabled: true, marker: 'preserved' }),
    capture: async ({ config, job }) => {
      seenConfig = config;
      return { snapshot: { schema: 'kakao-room-snapshot/v1', jobId: job.jobId, roomKey: job.roomKey, roomRevision: job.roomRevision } };
    },
    buildTurn: async ({ config, job }) => {
      assert.equal(config.autoSendEnabled, false);
      assert.equal(config.windowsWritesEnabled, false);
      return {
        event: {
          schema: 'village-kakao-gateway-event/v1', job_id: job.jobId, room_key: job.roomKey,
          room_revision: job.roomRevision, prompt: 'reason natively', detected_at: '2026-08-21T00:00:00.000Z', raw: {}
        },
        internal: { snapshot: {} }
      };
    },
    channel: { enqueue: async () => ({ state: 'ready' }) },
    runLegacy: async () => { legacyCalls += 1; }
  });
  const result = await dispatcher({ jobId: 'nosend-job', roomKey: 'nosend-room', roomRevision: 1 });
  assert.equal(result.queued, true);
  assert.equal(seenConfig.autoSendEnabled, false);
  assert.equal(seenConfig.windowsWritesEnabled, false);
  assert.equal(seenConfig.marker, 'preserved');
  assert.equal(legacyCalls, 0);
});

test('Gateway dispatcher surfaces an existing terminal failed job for human review instead of reporting queue success', async () => {
  const job = { jobId: 'already-failed', roomKey: 'failed-room', roomRevision: 2 };
  const dispatcher = createAiJobDispatcher({
    transport: 'gateway',
    getConfig: () => ({}),
    capture: async () => ({ snapshot: {} }),
    buildTurn: async () => ({
      event: {
        schema: 'village-kakao-gateway-event/v1', job_id: job.jobId, room_key: job.roomKey,
        room_revision: job.roomRevision, prompt: 'native', detected_at: '2026-08-21T00:00:00.000Z', raw: {}
      },
      internal: { snapshot: {} }
    }),
    channel: {
      enqueue: async () => ({
        job_id: job.jobId, state: 'failed', human_review_required: true,
        error: { type: 'lease_retry_exhausted' }
      })
    },
    runLegacy: async () => { throw new Error('legacy path must not run'); }
  });
  assert.deepEqual(await dispatcher(job), {
    ok: false, queued: false, transport: 'gateway', job_id: job.jobId,
    state: 'failed', human_review_required: true, error_type: 'lease_retry_exhausted'
  });

  let recoveryCalls = 0;
  assert.equal(await recoverFailedGatewayDispatch({
    result: await dispatcher(job),
    recover: async () => { recoveryCalls += 1; return [{ job_id: job.jobId, notified: true }]; }
  }), true);
  assert.equal(await recoverFailedGatewayDispatch({
    result: { ok: true, queued: false, state: 'completed' },
    recover: async () => { recoveryCalls += 1; }
  }), false);
  assert.equal(recoveryCalls, 1);
});

test('Gateway failure notification recovery is durable and retries notification without rerunning work', async () => {
  let delivered = false;
  let notificationCalls = 0;
  let workCalls = 0;
  const failedJob = {
    job_id: 'failed-job', room_key: 'failed-room', room_revision: 1,
    local_context: { job: { jobId: 'failed-job', roomKey: 'failed-room', roomRevision: 1 } },
    error: { type: 'lease_retry_exhausted' },
    failure_notification: { state: 'pending' }
  };
  const channel = {
    async listPendingFailureNotifications() { return delivered ? [] : [structuredClone(failedJob)]; },
    async markFailureNotified({ job_id, audit }) {
      assert.equal(job_id, failedJob.job_id);
      assert.deepEqual(audit, { follow_up_id: 'follow-up-1' });
      delivered = true;
    }
  };
  const first = createGatewayFailureNotificationCoordinator({
    channel,
    notify: async () => { notificationCalls += 1; throw new Error('temporary Slack outage'); }
  });
  assert.deepEqual(await first.recover(), [{ job_id: failedJob.job_id, notified: false, error: 'temporary Slack outage' }]);
  assert.equal(delivered, false);

  const restarted = createGatewayFailureNotificationCoordinator({
    channel,
    notify: async ({ durableJob }) => {
      notificationCalls += 1;
      assert.equal(durableJob.job_id, failedJob.job_id);
      return { follow_up_id: 'follow-up-1' };
    },
    runWork: async () => { workCalls += 1; }
  });
  assert.deepEqual(await restarted.recover(), [{ job_id: failedJob.job_id, notified: true }]);
  assert.equal(delivered, true);
  assert.equal(notificationCalls, 2);
  assert.equal(workCalls, 0);
  assert.deepEqual(await restarted.recover(), []);
});

test('Gateway failure notification keeps pending when enabled Slack returns a nested skipped error', async () => {
  const badDelivery = {
    inserted: 1,
    rows: [{ id: 'failure-card-1' }],
    slackDeliveryResult: {
      skipped: true,
      reason: 'two_channel_preflight_failed',
      error: 'Slack routing preflight failed',
      results: []
    }
  };
  assert.throws(
    () => assertGatewayFailureNotificationDelivered(badDelivery, { slackEnabled: true }),
    /gateway_failure_notification_slack_failed/
  );
  assert.doesNotThrow(() => assertGatewayFailureNotificationDelivered({
    inserted: 0, rows: [],
    slackDeliveryResult: { skipped: true, reason: 'no_rows', results: [] }
  }, { slackEnabled: true }));
  assert.doesNotThrow(() => assertGatewayFailureNotificationDelivered({
    inserted: 1, rows: [{ id: 'failure-card-disabled' }],
    slackDeliveryResult: { skipped: true, reason: 'disabled', results: [] }
  }, { slackEnabled: false }));

  let marks = 0;
  const channel = {
    async listPendingFailureNotifications() {
      return [{ job_id: 'nested-slack-failure', error: { type: 'lease_retry_exhausted' } }];
    },
    async markFailureNotified() { marks += 1; }
  };
  const coordinator = createGatewayFailureNotificationCoordinator({
    channel,
    notify: async () => {
      assertGatewayFailureNotificationDelivered(badDelivery, { slackEnabled: true });
      return badDelivery;
    }
  });
  const result = await coordinator.recover();
  assert.equal(result[0].notified, false);
  assert.match(result[0].error, /gateway_failure_notification_slack_failed/);
  assert.equal(marks, 0);
});

test('Gateway health readback requires a fresh consumer and exposes only safe aggregate fields', () => {
  const readback = buildGatewayHealthReadback({
    transport: 'gateway', gatewayConfigured: true,
    nowMs: Date.parse('2026-08-21T00:02:00.000Z'), consumerFreshnessMs: 180_000,
    status: {
      counts: { ready: 2, claimed: 1, retry_wait: 0, failed: 3, completed: 4, superseded: 1 },
      application_counts: { pending: 1, claimed: 0, applying: 0, applied: 0, finalized: 3, failed: 1 },
      failure_notification_counts: { pending: 2, delivered: 5 },
      unnotified_application_failures: 1,
      oldest_lease_age_ms: 75_000,
      last_completed_job_id: 'completed-job',
      last_consumer_id: 'gateway-consumer-1',
      last_consumer_seen_at: '2026-08-21T00:00:30.000Z',
      registered_reservation_change: {
        reserved: 2, completed: 5, failed_human_review: 1, pending_failure_notifications: 1,
        oldest_reserved_age_ms: 45_000, last_success_at: '2026-08-21T00:00:20.000Z'
      },
      token: 'must-not-leak', prompt: 'must-not-leak', local_context: { secret: true }
    }
  });
  assert.deepEqual(readback, {
    transport: 'gateway', gatewayConfigured: true, gatewayReady: true,
    consumer: { id: 'gateway-consumer-1', last_seen_at: '2026-08-21T00:00:30.000Z', age_ms: 90_000, fresh: true },
    queue: { ready: 2, claimed: 1, retry: 0, failed: 3, oldest_claim_age_ms: 75_000, last_completed_job_id: 'completed-job' },
    application_counts: { pending: 1, claimed: 0, applying: 0, applied: 0, finalized: 3, failed: 1 },
    failure_notification_counts: { pending: 2, delivered: 5 },
    unnotified_application_failures: 1,
    registered_reservation_change: {
      reserved: 2, completed: 5, failed_human_review: 1, pending_failure_notifications: 1,
      oldest_reserved_age_ms: 45_000, last_success_at: '2026-08-21T00:00:20.000Z'
    }
  });
  assert.equal(JSON.stringify(readback).includes('must-not-leak'), false);
  const stale = buildGatewayHealthReadback({
    transport: 'gateway', gatewayConfigured: true,
    nowMs: Date.parse('2026-08-21T00:05:00.001Z'), consumerFreshnessMs: 180_000,
    status: {
      last_consumer_id: 'gateway-consumer-1', last_consumer_seen_at: '2026-08-21T00:00:30.000Z',
      oldest_lease_age_ms: null
    }
  });
  assert.equal(stale.gatewayReady, false);
  assert.equal(stale.consumer.fresh, false);
  assert.equal(stale.queue.oldest_claim_age_ms, null);
});

test('server confirmation executor forwards the channel claim fence into the worker mutation boundary', async () => {
  let leaseChecks = 0;
  let operationArgs = null;
  const assertCurrentClaim = async () => { leaseChecks += 1; };
  const operationFence = {
    schema: 'village-tool-operation-reservation/v1', operation_id: 'operation-1',
    tool: 'confirmation_request', job_id: 'job-1', room_key: 'room-1', room_revision: 3,
    lease_id: 'lease-1', request_digest: 'digest-1', state: 'reserved',
    created_at: '2026-08-21T00:00:00.000Z', receipt_id: null, completed_at: null
  };
  const executor = createGatewayConfirmationExecutor({
    getConfig: () => ({ sheetApiKey: 'test-internal-key' }),
    executeOperation: async (args) => {
      operationArgs = args;
      await args.dependencies.assertCurrentClaim();
      return { status: 'ok' };
    }
  });

  const result = await executor({
    job_id: 'job-1', room_key: 'room-1', room_revision: 3,
    detected_at: '2026-08-21T00:00:00.000Z', decision: { should_write_to_sheet: true }
  }, { assertCurrentClaim, operationFence });

  assert.deepEqual(result, { status: 'ok' });
  assert.equal(leaseChecks, 1);
  assert.equal(operationArgs.job.jobId, 'job-1');
  assert.equal(operationArgs.job.roomKey, 'room-1');
  assert.equal(operationArgs.job.roomRevision, 3);
  assert.equal(operationArgs.dependencies.assertCurrentClaim, assertCurrentClaim);
  assert.equal(operationArgs.dependencies.operationFence, operationFence);
});

test('server registered change executor maps authenticated worker config into the real correction runner contract', async () => {
  const assertCurrentClaim = async () => {};
  const operationFence = {
    schema: 'village-tool-operation-reservation/v1', operation_id: 'registered-operation-1',
    tool: 'registered_reservation_change', job_id: 'registered-job-1', room_key: 'registered-room-1',
    room_revision: 8, lease_id: 'registered-lease-1', request_digest: 'registered-digest-1',
    state: 'reserved', created_at: '2026-08-27T00:00:00.000Z', receipt_id: null, completed_at: null
  };
  const mutation = {
    confirmed: true, kind: 'equipment_replace', target_scope: 'registered_trade', trade_id: '260824-008',
    source_evidence: { customer_request: '교체 요청', staff_confirmation: '교체 확정', conversation_revision: 8 },
    expected_period: { start_date: '2026-08-28', start_time: '09:00', end_date: '2026-08-29', end_time: '18:00' },
    expected_before: [{ schedule_id: '260824-008-07', name: '기존 렌즈', quantity: 1 }],
    desired_after: [{ name: '교체 렌즈', quantity: 1 }], date_change: null
  };
  const runnerCalls = [];
  const authoritativeAfter = { contract: {}, schedule: {}, ledger: {} };
  const executor = createGatewayRegisteredReservationChangeExecutor({
    getConfig: () => ({
      gasApiUrl: 'https://script.google.com/macros/s/internal-only/exec',
      sheetApiKey: 'internal-key',
      publicCatalogKey: 'must-not-be-forwarded'
    }),
    runRegisteredTradeCorrection: async (request) => {
      runnerCalls.push(request);
      return {
        ok: true,
        verified: true,
        tradeId: mutation.trade_id,
        readback: authoritativeAfter,
        authoritativeReadback: { before: { contract: {}, schedule: {} }, after: authoritativeAfter },
        appliedStages: ['scheduleCorrectRegisteredTrade']
      };
    }
  });

  const result = await executor({
    schema: 'village-registered-reservation-change-request/v1',
    job_id: 'registered-job-1', room_key: 'registered-room-1', room_revision: 8,
    lease_id: 'registered-lease-1', mutation
  }, { assertCurrentClaim, operationFence });

  assert.equal(result.schema, 'village-registered-reservation-change-receipt/v1');
  assert.equal(result.status, 'ok');
  assert.match(result.receipt_id, /^[0-9a-f-]{36}$/i);
  assert.equal(JSON.stringify(result).includes('internal-key'), false);
  assert.equal(runnerCalls.length, 1);
  assert.deepEqual(runnerCalls[0], {
    config: {
      VILLAGE2_API_URL: 'https://script.google.com/macros/s/internal-only/exec',
      VILLAGE2_API_KEY: 'internal-key'
    },
    input: {
      tradeId: '260824-008',
      operationId: 'registered-operation-1',
      expectedPeriod: {
        startDate: '2026-08-28', startTime: '09:00', endDate: '2026-08-29', endTime: '18:00'
      },
      remove: [{ scheduleId: '260824-008-07', expectedName: '기존 렌즈', expectedQty: 1 }],
      add: [{ name: '교체 렌즈', qty: 1 }],
      sendEstimate: false
    }
  });
});

test('server registered change executor rejects missing authenticated transport config before the correction runner', async () => {
  const mutation = task7Mutation();
  const operationFence = { operation_id: 'registered-operation-missing-config' };
  for (const config of [
    { gasApiUrl: '', sheetApiKey: 'internal-key' },
    { gasApiUrl: 'https://script.google.com/macros/s/internal-only/exec', sheetApiKey: '' }
  ]) {
    let runnerCalls = 0;
    const executor = createGatewayRegisteredReservationChangeExecutor({
      getConfig: () => config,
      runRegisteredTradeCorrection: async () => { runnerCalls += 1; }
    });
    await assert.rejects(
      executor({
        job_id: 'registered-missing-config', room_key: 'registered-room', room_revision: 8,
        mutation
      }, { assertCurrentClaim: async () => {}, operationFence }),
      /registered reservation change configuration is incomplete/i
    );
    assert.equal(runnerCalls, 0);
  }
});

test('Task 7 replays the sanitized registered replacement across the durable channel and worker exactly once', async () => {
  let correctionCalls = 0;
  const replay = await createTask7Replay({
    id: 'success',
    runRegisteredTradeCorrection: async ({ input }) => {
      correctionCalls += 1;
      assert.deepEqual(input, {
        tradeId: TASK7_INCIDENT.trade_id,
        operationId: input.operationId,
        expectedPeriod: {
          startDate: '2026-08-27', startTime: '06:00', endDate: '2026-08-27', endTime: '18:00'
        },
        remove: [{ scheduleId: '260824-008-07', expectedName: '소니 FE 28-135mm', expectedQty: 1 }],
        add: [{ name: '소니 GM 70-200mm II', qty: 1 }],
        sendEstimate: false
      });
      assert.match(input.operationId, /^[0-9a-f-]{36}$/i);
      return {
        ok: true, verified: true, tradeId: TASK7_INCIDENT.trade_id,
        readback: task7AuthoritativeReadback(),
        authoritativeReadback: {
          before: task7AuthoritativeBeforeReadback(),
          after: task7AuthoritativeReadback()
        },
        appliedStages: ['scheduleCorrectRegisteredTrade']
      };
    }
  });
  try {
    const receipt = await replay.executeTool();
    assert.equal(correctionCalls, 1);
    assert.equal(receipt.schema, 'village-registered-reservation-change-receipt/v1');
    assert.equal(receipt.status, 'ok');
    assert.deepEqual(receipt.authoritative_result, {
      before: task7AuthoritativeBeforeReadback(),
      after: task7AuthoritativeReadback()
    });
    await replay.completeHermesFinal();

    assert.deepEqual(replay.counts(), { applyCalls: 1, finalizeCalls: 1 });
    assert.equal(replay.preparedDecisions.length, 1);
    assert.equal(replay.preparedDecisions[0].reply_decision.replyMode, 'no_reply');
    assert.equal(replay.preparedDecisions[0].reply_decision.text, '');
    assert.equal(replay.preparedDecisions[0].reply_decision.shouldCreateTask, false);
    assert.equal(replay.preparedDecisions[0].owner_review_required, false);
    assert.deepEqual(replay.preparedDecisions[0].follow_up_items, []);
    assert.deepEqual(
      replay.preparedDecisions[0].trusted_registered_reservation_change_receipt,
      receipt
    );
    assert.equal((await replay.channel.get(replay.claim.job_id)).application.state, 'finalized');

    await replay.app.close();
    const restarted = createHermesGatewayChannel({
      directory: replay.directory, leaseMs: 60_000, maxAttempts: 2, now: () => TASK7_NOW
    });
    let restartCorrectionCalls = 0;
    const restartExecutor = createGatewayRegisteredReservationChangeExecutor({
      getConfig: () => ({
        gasApiUrl: 'https://script.google.com/macros/s/offline-fixture/exec',
        sheetApiKey: 'offline-fake-only'
      }),
      runRegisteredTradeCorrection: async () => { restartCorrectionCalls += 1; },
      randomUUID: () => 'must-not-create-another-receipt',
      now: () => new Date(TASK7_NOW)
    });
    const restartedApp = await startTask7Http(createHermesGatewayHttpHandler({
      token: TASK7_TOKEN, channel: restarted, transport: 'gateway', now: () => TASK7_NOW,
      executeRegisteredReservationChange: restartExecutor
    }));
    try {
      const retry = await task7Post(
        restartedApp,
        '/hermes/v1/tools/registered-reservation-change',
        replay.toolBody
      );
      assert.equal(retry.status, 200);
      assert.deepEqual(await retry.json(), receipt);
      assert.equal(restartCorrectionCalls, 0);
      assert.equal((await restarted.get(replay.claim.job_id)).application.state, 'finalized');
    } finally {
      await restartedApp.close();
    }
  } finally {
    await replay.close();
  }
});

test('Task 7 conflict performs zero correction writes and leaves one durable owner notification pending', async () => {
  let correctionCalls = 0;
  let correctionWrites = 0;
  const fakeGasOperations = [];
  const fakeCorrectionGas = {
    async preflight(input) {
      fakeGasOperations.push({ stage: 'preflight', input: structuredClone(input) });
      return { conflicts: [{ name: '소니 GM 70-200mm II', available: 0, requested: 1 }] };
    },
    async write(input) {
      correctionWrites += 1;
      fakeGasOperations.push({ stage: 'write', input: structuredClone(input) });
    }
  };
  const replay = await createTask7Replay({
    id: 'conflict',
    runRegisteredTradeCorrection: async ({ input }) => {
      correctionCalls += 1;
      const preflight = await fakeCorrectionGas.preflight(input);
      if (!preflight.conflicts.length) {
        await fakeCorrectionGas.write(input);
        return {
          ok: true, verified: true, tradeId: input.tradeId,
          readback: task7AuthoritativeReadback(), appliedStages: ['scheduleCorrectRegisteredTrade']
        };
      }
      const error = new Error('replacement stock conflict');
      error.name = 'CorrectionStageError';
      error.stage = 'preflight';
      error.appliedStages = [];
      error.outcomeUnknown = false;
      error.details = preflight;
      throw error;
    },
    finalize: async (prepared) => {
      assert.equal(prepared.decision.follow_up_items.length, 1);
      assert.equal(prepared.decision.follow_up_items[0].priority, 'urgent');
      assert.equal(prepared.decision.follow_up_items[0].alertLevel, 'p0');
      return {
        status: 'ai_completed', decision: prepared.decision,
        followUpResult: { inserted: 1, rows: [{ id: 'task7-conflict-owner-card' }] },
        slackDeliveryResult: {
          skipped: false,
          results: [{ ok: false, rowId: 'task7-conflict-owner-card', error: 'offline Slack fixture' }]
        },
        autoReplyResult: { attempted: false, sent: false }
      };
    },
    onFailure: async () => { throw new Error('owner notification remains offline'); }
  });
  try {
    const receipt = await replay.executeTool();
    assert.equal(receipt.status, 'blocked');
    assert.deepEqual(receipt.applied_stages, []);
    assert.equal(receipt.attempted_stage, 'preflight');
    assert.equal(correctionCalls, 1);
    assert.deepEqual(fakeGasOperations.map((operation) => operation.stage), ['preflight']);
    assert.equal(fakeGasOperations[0].input.tradeId, TASK7_INCIDENT.trade_id);
    assert.deepEqual(fakeGasOperations[0].input.remove, [{
      scheduleId: '260824-008-07', expectedName: '소니 FE 28-135mm', expectedQty: 1
    }]);
    assert.equal(correctionWrites, 0);
    await replay.completeHermesFinal();

    const pending = await replay.channel.listPendingApplicationFailureNotifications();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].job_id, replay.claim.job_id);
    assert.equal(pending[0].application.failure_notification.state, 'pending');
    assert.deepEqual(replay.preparedDecisions[0].registered_mutation_review.error, receipt.error);
    assert.deepEqual(replay.preparedDecisions[0].registered_mutation_review.applied_stages, []);
    assert.equal(replay.preparedDecisions[0].reply_decision.replyMode, 'draft_only');
    assert.equal(replay.preparedDecisions[0].reply_decision.text, '');
  } finally {
    await replay.close();
  }
});

test('Task 7 partial write persists stage evidence, never replays after restart, and notifies only on delivery', async () => {
  let correctionCalls = 0;
  let correctionWrites = 0;
  const notificationAttempts = [];
  const notificationStatusUpdates = [];
  let notificationDeliveryAvailable = false;
  const applicationFailureNotifier = createGatewayApplicationFailureNotifier({
    slackEnabled: true,
    createFollowUp: async ({ job, error, context }) => {
      notificationAttempts.push(notificationDeliveryAvailable);
      assert.equal(job.jobId, 'task7-partial-job');
      assert.match(error.message, /gateway_owner_review_slack_failed/);
      assert.equal(context.origin, 'hermes_gateway_result_application');
      return {
        inserted: 1,
        rows: [{ id: 'task7-partial-failure-notification' }],
        slackDeliveryResult: {
          skipped: false,
          results: [notificationDeliveryAvailable
            ? { ok: true, rowId: 'task7-partial-failure-notification', channelId: 'C-OFFLINE', ts: '1.0' }
            : { ok: false, rowId: 'task7-partial-failure-notification', error: 'Slack still offline' }]
        }
      };
    },
    updateStatus: async (jobId, patch) => {
      notificationStatusUpdates.push({ jobId, patch: structuredClone(patch) });
    },
    now: () => '2026-08-27T01:00:01.000Z'
  });
  const replay = await createTask7Replay({
    id: 'partial',
    runRegisteredTradeCorrection: async () => {
      correctionCalls += 1;
      correctionWrites += 1;
      const error = new Error('add response lost after remove write');
      error.name = 'CorrectionStageError';
      error.stage = 'scheduleAddEquips';
      error.appliedStages = ['scheduleRemoveEquips'];
      error.outcomeUnknown = true;
      error.details = {
        last_readback: {
          tradeId: TASK7_INCIDENT.trade_id,
          remaining: structuredClone(TASK7_INCIDENT.exact_old_rows)
        }
      };
      throw error;
    },
    finalize: async (prepared) => ({
      status: 'ai_completed', decision: prepared.decision,
      followUpResult: { inserted: 1, rows: [{ id: 'task7-partial-owner-card' }] },
      slackDeliveryResult: {
        skipped: false,
        results: [{ ok: false, rowId: 'task7-partial-owner-card', error: 'offline Slack fixture' }]
      },
      autoReplyResult: { attempted: false, sent: false }
    }),
    onFailure: applicationFailureNotifier
  });
  try {
    const receipt = await replay.executeTool();
    assert.equal(receipt.status, 'partial_success');
    assert.deepEqual(receipt.applied_stages, ['scheduleRemoveEquips']);
    assert.equal(receipt.attempted_stage, 'scheduleAddEquips');
    assert.deepEqual(receipt.error.details, {
      last_readback: {
        tradeId: TASK7_INCIDENT.trade_id,
        remaining: TASK7_INCIDENT.exact_old_rows
      }
    });
    assert.deepEqual({ correctionCalls, correctionWrites }, { correctionCalls: 1, correctionWrites: 1 });
    await replay.completeHermesFinal();
    assert.deepEqual(
      replay.preparedDecisions[0].registered_mutation_review.applied_stages,
      ['scheduleRemoveEquips']
    );
    assert.deepEqual(replay.preparedDecisions[0].registered_mutation_review.error, receipt.error);
    assert.equal((await replay.channel.listPendingApplicationFailureNotifications()).length, 1);

    await replay.app.close();
    const restarted = createHermesGatewayChannel({
      directory: replay.directory, leaseMs: 60_000, maxAttempts: 2, now: () => TASK7_NOW
    });
    let replayedCorrections = 0;
    const restartedExecutor = createGatewayRegisteredReservationChangeExecutor({
      getConfig: () => ({
        gasApiUrl: 'https://script.google.com/macros/s/offline-fixture/exec',
        sheetApiKey: 'offline-fake-only'
      }),
      runRegisteredTradeCorrection: async () => { replayedCorrections += 1; },
      randomUUID: () => 'must-not-create-partial-receipt',
      now: () => new Date(TASK7_NOW)
    });
    const restartedApp = await startTask7Http(createHermesGatewayHttpHandler({
      token: TASK7_TOKEN, channel: restarted, transport: 'gateway', now: () => TASK7_NOW,
      executeRegisteredReservationChange: restartedExecutor
    }));
    try {
      const retry = await task7Post(
        restartedApp,
        '/hermes/v1/tools/registered-reservation-change',
        replay.toolBody
      );
      assert.equal(retry.status, 200);
      assert.deepEqual(await retry.json(), receipt);
      assert.equal(replayedCorrections, 0);

      let recoveryWork = 0;
      const failedDelivery = createGatewayResultApplicationCoordinator({
        channel: restarted, getConfig: () => ({}),
        prepare: async () => { recoveryWork += 1; },
        apply: async () => { recoveryWork += 1; },
        finalize: async () => { recoveryWork += 1; },
        onFailure: applicationFailureNotifier
      });
      assert.deepEqual(await failedDelivery.recoverApplicationFailureNotifications(), [{
        job_id: replay.claim.job_id,
        notified: false,
        error: 'gateway_failure_notification_slack_failed: Slack still offline'
      }]);
      assert.equal((await restarted.listPendingApplicationFailureNotifications()).length, 1);

      notificationDeliveryAvailable = true;
      const delivered = createGatewayResultApplicationCoordinator({
        channel: restarted, getConfig: () => ({}),
        prepare: async () => { recoveryWork += 1; },
        apply: async () => { recoveryWork += 1; },
        finalize: async () => { recoveryWork += 1; },
        onFailure: applicationFailureNotifier
      });
      assert.deepEqual(await delivered.recoverApplicationFailureNotifications(), [{
        job_id: replay.claim.job_id, notified: true
      }]);
      assert.equal((await restarted.listPendingApplicationFailureNotifications()).length, 0);
      assert.equal(recoveryWork, 0);
      assert.equal(replayedCorrections, 0);
      assert.deepEqual(notificationAttempts, [false, false, true]);
      assert.equal(notificationStatusUpdates.length, 1);
      assert.equal(notificationStatusUpdates[0].jobId, replay.claim.job_id);
      assert.equal(notificationStatusUpdates[0].patch.status, 'needs_human_review');
      assert.equal(notificationStatusUpdates[0].patch.completed_at, '2026-08-27T01:00:01.000Z');
      assert.deepEqual(
        notificationStatusUpdates[0].patch.payload.ai_worker_result.failure_follow_up.slackDeliveryResult.results,
        [{ ok: true, rowId: 'task7-partial-failure-notification', channelId: 'C-OFFLINE', ts: '1.0' }]
      );
    } finally {
      await restartedApp.close();
    }
  } finally {
    await replay.close();
  }
});

test('server document executor fences then sends the exact registered supply-only quote and returns a correlated receipt', async () => {
  const calls = [];
  let leaseChecks = 0;
  const executor = createGatewayDocumentExecutor({
    getConfig: () => ({ documentApiBaseUrl: 'https://docs.example/exec', documentApiKey: 'doc-key' }),
    executeRequest: async (request, options) => {
      calls.push({ request, options });
      return {
        ok: true, documentType: 'quote', tradeId: '260822-001', taxMode: 'supply_only',
        response: { status: 'OK', tradeID: '260822-001', taxMode: 'supply_only', pdfUrl: 'https://drive.example/quote.pdf' }
      };
    },
    randomUUID: () => 'document-receipt-1',
    now: () => new Date('2026-08-24T01:00:00.000Z')
  });

  const receipt = await executor({
    job_id: 'job-document', room_key: 'room-document', room_revision: 9,
    document_type: 'quote', trade_id: '260822-001', tax_mode: 'supply_only'
  }, { assertCurrentClaim: async () => { leaseChecks += 1; } });

  assert.equal(leaseChecks, 1);
  assert.deepEqual(calls, [{
    request: { document_type: 'quote', trade_id: '260822-001', tax_mode: 'supply_only' },
    options: { documentApiBaseUrl: 'https://docs.example/exec', documentApiKey: 'doc-key' }
  }]);
  assert.deepEqual(receipt, {
    schema: 'village-document-receipt/v1', receipt_id: 'document-receipt-1',
    job_id: 'job-document', room_key: 'room-document', room_revision: 9, status: 'ok',
    document_type: 'quote', trade_id: '260822-001', tax_mode: 'supply_only',
    authoritative_document_result: {
      status: 'OK', tradeID: '260822-001', taxMode: 'supply_only', pdfUrl: 'https://drive.example/quote.pdf'
    },
    created_at: '2026-08-24T01:00:00.000Z', error: null
  });
});

test('server document executor turns transport exceptions into a durable failed receipt', async () => {
  const executor = createGatewayDocumentExecutor({
    getConfig: () => ({ documentApiBaseUrl: 'https://docs.example/exec', documentApiKey: 'doc-key' }),
    executeRequest: async () => { throw new Error('network reset after request'); },
    randomUUID: () => 'document-receipt-failed-1',
    now: () => new Date('2026-08-24T01:01:00.000Z')
  });

  const receipt = await executor({
    job_id: 'job-document-failed', room_key: 'room-document', room_revision: 10,
    document_type: 'quote', trade_id: '260822-001', tax_mode: 'supply_only'
  }, { assertCurrentClaim: async () => {} });

  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.error.type, 'document_send_exception');
  assert.match(receipt.error.message, /network reset after request/);
});

test('gateway document config uses explicit overrides or the existing internal GAS credential', () => {
  assert.deepEqual(resolveGatewayDocumentConfig({
    documentApiBaseUrl: '', documentApiKey: ''
  }, { sheetApiKey: 'derived-internal-key' }), {
    documentApiBaseUrl: 'https://script.google.com/macros/s/AKfycbwX2V0SqRf23DCwaVojlc5YFXKTfMNLBt68edpGmCx8j0i9hkYdP_bXHKEGIcde2iS5EA/exec',
    documentApiKey: 'derived-internal-key'
  });
  assert.deepEqual(resolveGatewayDocumentConfig({
    documentApiBaseUrl: 'https://override.example/exec', documentApiKey: 'override-key'
  }, { sheetApiKey: 'derived-internal-key' }), {
    documentApiBaseUrl: 'https://override.example/exec', documentApiKey: 'override-key'
  });
});

test('server confirmation validator rejects invalid decisions before durable reservation wiring', async () => {
  const validator = createGatewayConfirmationValidator({
    validateDecision: (decision) => decision.sheet_row_candidate?.discount_type
      ? { valid: true, errors: [] }
      : { valid: false, errors: ['discount required'] }
  });
  assert.deepEqual(await validator({ decision: { sheet_row_candidate: { discount_type: '' } } }), {
    valid: false,
    errors: ['discount required']
  });
  assert.deepEqual(await validator({ decision: { sheet_row_candidate: { discount_type: '일반' } } }), {
    valid: true,
    errors: []
  });
  const serverSource = await readFile(new URL('./server.mjs', import.meta.url), 'utf8');
  assert.match(serverSource, /validateConfirmation:\s*gatewayConfirmationValidator/);
});

test('server confirmation validator rejects a claimed existing RQ that is absent from live GAS', async () => {
  const lookups = [];
  const validator = createGatewayConfirmationValidator({
    getConfig: () => ({ gasApiUrl: 'https://gas.example/exec', sheetApiKey: 'secret' }),
    fetchExistingRequest: async (_config, decision) => {
      lookups.push(structuredClone(decision.existing_confirm_request_ids));
      return null;
    }
  });
  const decision = {
    classification: 'already_answered',
    should_write_to_sheet: false,
    reservation_inquiry: { is_reservation_inquiry: true, already_registered: false },
    existing_confirm_request_ids: ['RQ-260823-001'],
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      latest_customer_message_after_last_staff_reply: true
    },
    sheet_row_candidate: {},
    follow_up_items: [{
      type: 'reservation_review',
      route: 'schedule',
      taskKey: 'reservation:kim-hyeji:2026-09-02:canon-rf-100-500',
      priority: 'high',
      status: 'open',
      title: 'Existing confirmation request review',
      customer_name: '김혜지',
      summary: 'Review the existing confirmation request result before replying.',
      recommended_action: 'Use the authoritative request result for owner review.',
      suggested_reply_draft: '',
      evidence: ['Hermes claimed RQ-260823-001 exists.'],
      blocking_reason: '',
      due_hint: 'now'
    }],
    reply_decision: {
      replyMode: 'no_reply',
      text: '',
      confidence: 'high',
      reason: 'Staff already replied; verify the claimed request before closing the turn.',
      shouldCreateTask: true,
      safetyClass: 'no_send',
      grounding: 'visible_conversation',
      requiresRag: false,
      attachmentKeys: [],
      alreadyDelivered: true
    }
  };

  assert.deepEqual(await validator({ decision }), {
    valid: false,
    errors: [
      'existing confirm request RQ-260823-001 was not found in the live sheet; if the reservation remains unregistered, correct the decision and write it'
    ]
  });
  assert.deepEqual(lookups, [['RQ-260823-001']]);

  const verified = createGatewayConfirmationValidator({
    getConfig: () => ({ gasApiUrl: 'https://gas.example/exec', sheetApiKey: 'secret' }),
    fetchExistingRequest: async () => ({ reqID: 'RQ-260823-001', results: [] })
  });
  assert.deepEqual(await verified({ decision }), { valid: true, errors: [] });

  const unavailable = createGatewayConfirmationValidator({
    getConfig: () => ({ gasApiUrl: 'https://gas.example/exec', sheetApiKey: 'secret' }),
    fetchExistingRequest: async () => ({
      reqID: 'RQ-260823-001',
      results: [],
      lookup_error: 'network timeout'
    })
  });
  assert.deepEqual(await unavailable({ decision }), {
    valid: false,
    errors: [
      'existing confirm request RQ-260823-001 could not be verified in the live sheet; retry the tool before finishing'
    ]
  });
});

test('server default confirmation validator matches the safe sheet payload boundary', () => {
  const validator = createGatewayConfirmationValidator();
  const decision = {
    classification: 'reservation',
    should_write_to_sheet: true,
    reservation_inquiry: {
      is_reservation_inquiry: true,
      already_registered: false,
      confirmed: true,
      equipment_requested: [{
        raw_text: 'FX3',
        normalized_guess: '소니 FX3 바디세트',
        exact_name_from_equipment_catalog: '소니 FX3 바디세트',
        exact_name_from_set_master: null,
        catalog_match_status: 'matched',
        quantity: 1,
        confidence: 'high'
      }]
    },
    sheet_row_candidate: {
      plan_complete: true,
      start_date: '2026-08-28',
      pickup_time: '15:00',
      end_date: '2026-08-29',
      return_time: '15:00',
      customer_name: '안재용',
      phone: '010-0000-0000',
      discount_type: '학생',
      equipment_write_mode: 'full_plan',
      equipment: [{ item: '소니 FX3 바디세트', quantity: 1 }]
    }
  };

  const missing = validator({ decision });
  assert.equal(missing.valid, false);
  assert.match(missing.errors.join('|'), /safety_checks|safe confirmation-request payload/);

  decision.safety_checks = {
    kakao_conversation_opened: true,
    did_not_classify_from_preview_only: true,
    latest_customer_message_after_last_staff_reply: true
  };
  assert.deepEqual(validator({ decision }), { valid: true, errors: [] });
});

test('Gateway result coordinator serializes prepare, fresh DOM apply, finalize, and audit exactly once', async () => {
  const order = [];
  let applicationState = 'pending';
  const durableJob = {
    job_id: 'job-result-apply', room_key: 'room-result-apply', room_revision: 2,
    event: { schema: 'village-kakao-gateway-event/v1', job_id: 'job-result-apply', room_key: 'room-result-apply', room_revision: 2 },
    local_context: {
      job: { jobId: 'job-result-apply', roomKey: 'room-result-apply', roomRevision: 2 },
      turn_internal: { snapshot: { schema: 'kakao-room-snapshot/v1', jobId: 'job-result-apply', roomKey: 'room-result-apply', roomRevision: 2 } }
    },
    result: { content: 'FINAL_JSON {}' }, tool_receipts: [], application: { state: 'pending' }
  };
  const channel = {
    async claimApplication() {
      if (applicationState !== 'pending') return { claimed: false, job: structuredClone(durableJob) };
      applicationState = 'claimed';
      return { claimed: true, application_id: 'application-1', job: structuredClone({ ...durableJob, application: { state: 'claimed' } }) };
    },
    async beginApplication() { order.push('persist_applying'); applicationState = 'applying'; },
    async recordApplicationApplied() { order.push('persist_applied'); applicationState = 'applied'; },
    async finalizeApplication() { order.push('persist_finalized'); applicationState = 'finalized'; },
    async failApplication() { throw new Error('unexpected failure'); },
    async listPendingApplicationFailureNotifications() { return []; },
    async markApplicationFailureNotified() {}
  };
  const coordinator = createGatewayResultApplicationCoordinator({
    channel,
    getConfig: () => ({ openTargetChat: false }),
    prepare: async () => { order.push('prepare'); return { status: 'ai_prepared', snapshot: durableJob.local_context.turn_internal.snapshot }; },
    apply: async () => { order.push('apply_fresh_dom'); return { prepared: { status: 'ai_prepared' }, autoReplyResult: { sent: false } }; },
    finalize: async () => { order.push('finalize_followup'); return { status: 'ai_completed', autoReplyResult: { sent: false } }; },
    record: async () => { order.push('audit'); }
  });

  const first = await coordinator.enqueue(durableJob);
  const duplicate = await coordinator.enqueue(durableJob);
  assert.equal(first.accepted, true);
  assert.equal(duplicate.accepted, false);
  await coordinator.idle();
  assert.deepEqual(order, ['prepare', 'persist_applying', 'apply_fresh_dom', 'persist_applied', 'finalize_followup', 'audit', 'persist_finalized']);
});

test('Gateway result coordinator keeps one application lane across rooms', async () => {
  const order = [];
  const states = new Map();
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const channel = {
    async claimApplication({ jobId }) {
      if (states.has(jobId)) return { claimed: false };
      states.set(jobId, 'applying');
      return {
        claimed: true, application_id: `application-${jobId}`,
        job: {
          job_id: jobId, room_key: `room-${jobId}`, room_revision: 1,
          event: { job_id: jobId, room_key: `room-${jobId}`, room_revision: 1 },
          local_context: { job: { jobId, roomKey: `room-${jobId}`, roomRevision: 1 }, turn_internal: { snapshot: {} } },
          result: { content: 'FINAL_JSON {}' }, tool_receipts: []
        }
      };
    },
    async beginApplication() {},
    async recordApplicationApplied({ job_id }) { states.set(job_id, 'applied'); },
    async finalizeApplication({ job_id }) { states.set(job_id, 'finalized'); },
    async failApplication() {},
    async listPendingApplicationFailureNotifications() { return []; },
    async markApplicationFailureNotified() {}
  };
  const coordinator = createGatewayResultApplicationCoordinator({
    channel, getConfig: () => ({}),
    prepare: async ({ job }) => ({ status: 'ai_prepared', snapshot: {}, id: job.jobId }),
    apply: async ({ job, prepared }) => {
      order.push(`start:${job.jobId}`);
      if (job.jobId === 'one') await firstGate;
      order.push(`end:${job.jobId}`);
      return { prepared, autoReplyResult: { sent: false } };
    },
    finalize: async ({ applied }) => ({ ...applied.prepared, status: 'ai_completed' }),
    record: async () => {}
  });

  await coordinator.enqueue({ job_id: 'one' });
  await coordinator.enqueue({ job_id: 'two' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['start:one']);
  releaseFirst();
  await coordinator.idle();
  assert.deepEqual(order, ['start:one', 'end:one', 'start:two', 'end:two']);
});

test('Gateway result coordinator trusts only the receipt fenced by the durable channel operation', async () => {
  let receivedReceipts = null;
  const exact = {
    schema: 'village-confirmation-receipt/v1', receipt_id: 'receipt-exact',
    operation_id: 'operation-exact', lease_id: 'lease-exact', request_digest: 'digest-exact',
    job_id: 'job-receipt-provenance', room_key: 'room-receipt-provenance', room_revision: 1,
    status: 'ok', availability_report: [], authoritative_sheet_result: null,
    created_at: '2026-08-21T00:00:00.000Z', error: null
  };
  const fabricated = { ...exact, receipt_id: 'receipt-fabricated', operation_id: 'other-operation' };
  const durableJob = {
    job_id: exact.job_id, room_key: exact.room_key, room_revision: exact.room_revision,
    event: { job_id: exact.job_id, room_key: exact.room_key, room_revision: exact.room_revision },
    local_context: {
      job: { jobId: exact.job_id, roomKey: exact.room_key, roomRevision: exact.room_revision },
      turn_internal: { snapshot: {} }
    },
    result: { content: 'FINAL_JSON {}' },
    tool_operation: {
      schema: 'village-tool-operation-reservation/v1', state: 'completed',
      operation_id: exact.operation_id, receipt_id: exact.receipt_id,
      lease_id: exact.lease_id, request_digest: exact.request_digest,
      job_id: exact.job_id, room_key: exact.room_key, room_revision: exact.room_revision
    },
    tool_receipts: [fabricated, exact]
  };
  const channel = {
    async claimApplication() { return { claimed: true, application_id: 'application-provenance', job: structuredClone(durableJob) }; },
    async beginApplication() {},
    async recordApplicationApplied() {}, async finalizeApplication() {}, async failApplication() {},
    async listPendingApplicationFailureNotifications() { return []; },
    async markApplicationFailureNotified() {}
  };
  const coordinator = createGatewayResultApplicationCoordinator({
    channel, getConfig: () => ({}),
    prepare: async ({ trustedToolReceipts }) => {
      receivedReceipts = trustedToolReceipts;
      return { status: 'ai_prepared', snapshot: {} };
    },
    apply: async ({ prepared }) => ({ prepared, autoReplyResult: { sent: false } }),
    finalize: async ({ applied }) => ({ ...applied.prepared, status: 'ai_completed' })
  });
  await coordinator.enqueue(durableJob);
  await coordinator.idle();
  assert.deepEqual(receivedReceipts, [exact]);
});

test('Gateway result coordinator records audit before terminal finalize and fails closed when recording crashes', async () => {
  const order = [];
  const durableJob = {
    job_id: 'job-record-crash', room_key: 'room-record-crash', room_revision: 1,
    event: { job_id: 'job-record-crash', room_key: 'room-record-crash', room_revision: 1 },
    local_context: {
      job: { jobId: 'job-record-crash', roomKey: 'room-record-crash', roomRevision: 1 },
      turn_internal: { snapshot: {} }
    },
    result: { content: 'FINAL_JSON {}' }, tool_receipts: []
  };
  const channel = {
    async claimApplication() { return { claimed: true, application_id: 'application-record-crash', job: structuredClone(durableJob) }; },
    async beginApplication() { order.push('persist_applying'); },
    async recordApplicationApplied() { order.push('persist_applied'); },
    async finalizeApplication() { order.push('persist_finalized'); },
    async failApplication({ error }) {
      order.push('persist_failed_review');
      return structuredClone({
        ...durableJob,
        application: {
          state: 'failed', application_id: 'application-record-crash', error,
          failure_notification: { state: 'pending' }
        }
      });
    },
    async listPendingApplicationFailureNotifications() { return []; },
    async markApplicationFailureNotified() { order.push('persist_notified'); }
  };
  const coordinator = createGatewayResultApplicationCoordinator({
    channel, getConfig: () => ({}),
    prepare: async () => ({ status: 'ai_prepared', snapshot: {} }),
    apply: async ({ prepared }) => ({ prepared, autoReplyResult: { sent: false } }),
    finalize: async ({ applied }) => { order.push('finalize_followup'); return { ...applied.prepared, status: 'ai_completed' }; },
    record: async () => { order.push('audit'); throw new Error('offline audit failure'); },
    onFailure: async () => { order.push('human_review'); }
  });

  await coordinator.enqueue(durableJob);
  await coordinator.idle();
  assert.deepEqual(order, ['persist_applying', 'persist_applied', 'finalize_followup', 'audit', 'persist_failed_review', 'human_review', 'persist_notified']);
  assert.equal(order.includes('persist_finalized'), false);
});

test('Gateway result coordinator fails closed when required owner review persistence or Slack delivery fails', async () => {
  const cases = [
    {
      name: 'follow-up persistence error',
      finalization: {
        followUpResult: { inserted: 0, rows: [], error: 'Supabase owner card insert failed' },
        slackDeliveryResult: { skipped: true, reason: 'no_rows', results: [] }
      },
      error: /gateway_owner_review_persistence_failed/
    },
    {
      name: 'required owner-review row missing',
      finalization: {
        followUpResult: { inserted: 0, rows: [] },
        slackDeliveryResult: { skipped: true, reason: 'no_rows', results: [] }
      },
      error: /gateway_owner_review_not_persisted/
    },
    {
      name: 'Slack owner-card delivery error',
      finalization: {
        followUpResult: { inserted: 1, rows: [{ id: 'owner-card-1' }] },
        slackDeliveryResult: { skipped: false, results: [{ ok: false, rowId: 'owner-card-1', error: 'Slack offline' }] }
      },
      error: /gateway_owner_review_slack_failed/
    }
  ];

  for (const entry of cases) {
    const order = [];
    let failureMessage = '';
    const durableJob = {
      job_id: `job-${entry.name}`, room_key: `room-${entry.name}`, room_revision: 1,
      event: { job_id: `job-${entry.name}`, room_key: `room-${entry.name}`, room_revision: 1 },
      local_context: {
        job: { jobId: `job-${entry.name}`, roomKey: `room-${entry.name}`, roomRevision: 1 },
        turn_internal: { snapshot: {} }
      },
      result: { content: 'FINAL_JSON {}' }, tool_receipts: [], application: { state: 'pending' }
    };
    const channel = {
      async claimApplication() {
        return { claimed: true, application_id: `application-${entry.name}`, job: structuredClone({ ...durableJob, application: { state: 'claimed' } }) };
      },
      async beginApplication() { order.push('persist_applying'); },
      async recordApplicationApplied() { order.push('persist_applied'); },
      async finalizeApplication() { order.push('unexpected_finalized'); },
      async failApplication({ error }) {
        failureMessage = error.message;
        order.push('persist_failed_review');
        return structuredClone({
          ...durableJob,
          application: {
            state: 'failed', application_id: `application-${entry.name}`, error,
            failure_notification: { state: 'pending' }
          }
        });
      },
      async listPendingApplicationFailureNotifications() { return []; },
      async markApplicationFailureNotified() { order.push('persist_notified'); }
    };
    const prepared = {
      status: 'ai_prepared', snapshot: {},
      decision: { owner_review_required: true, reply_decision: { shouldCreateTask: true } },
      availabilityAwareRows: [{ type: 'schedule_check', payload: { follow_up_route: 'schedule' } }]
    };
    const coordinator = createGatewayResultApplicationCoordinator({
      channel, getConfig: () => ({}),
      prepare: async () => prepared,
      apply: async () => { order.push('apply'); return { prepared, autoReplyResult: { sent: false } }; },
      finalize: async () => { order.push('finalize'); return { ...prepared, status: 'ai_completed', ...entry.finalization }; },
      record: async () => { order.push('unexpected_audit'); },
      onFailure: async () => { order.push('human_review'); }
    });

    await coordinator.enqueue(durableJob);
    await coordinator.idle();
    assert.match(failureMessage, entry.error, entry.name);
    assert.deepEqual(order, ['persist_applying', 'apply', 'persist_applied', 'finalize', 'persist_failed_review', 'human_review', 'persist_notified'], entry.name);
  }
});

test('Gateway result coordinator marks an apply-phase crash ambiguous and never replays DOM apply', async () => {
  const order = [];
  let claimed = false;
  let applyCount = 0;
  const durableJob = {
    job_id: 'job-apply-crash', room_key: 'room-apply-crash', room_revision: 1,
    event: { job_id: 'job-apply-crash', room_key: 'room-apply-crash', room_revision: 1 },
    local_context: {
      job: { jobId: 'job-apply-crash', roomKey: 'room-apply-crash', roomRevision: 1 },
      turn_internal: { snapshot: {} }
    },
    result: { content: 'FINAL_JSON {}' }, tool_receipts: [], application: { state: 'pending' }
  };
  const channel = {
    async claimApplication() {
      if (claimed) return { claimed: false, job: { ...durableJob, application: { state: 'failed' } } };
      claimed = true;
      return { claimed: true, application_id: 'application-apply-crash', job: structuredClone({ ...durableJob, application: { state: 'claimed' } }) };
    },
    async beginApplication() { order.push('persist_applying'); },
    async recordApplicationApplied() { order.push('unexpected_applied'); },
    async finalizeApplication() { order.push('unexpected_finalized'); },
    async failApplication({ error }) {
      order.push('persist_failed_review');
      return structuredClone({
        ...durableJob,
        application: {
          state: 'failed', application_id: 'application-apply-crash', error,
          failure_notification: { state: 'pending' }
        }
      });
    },
    async listPendingApplicationFailureNotifications() { return []; },
    async markApplicationFailureNotified() { order.push('persist_notified'); }
  };
  const coordinator = createGatewayResultApplicationCoordinator({
    channel, getConfig: () => ({}),
    prepare: async () => ({ status: 'ai_prepared', snapshot: {} }),
    apply: async () => { applyCount += 1; order.push('apply'); throw new Error('uncertain DOM outcome'); },
    finalize: async () => { order.push('unexpected_finalize'); },
    record: async () => { order.push('unexpected_audit'); },
    onFailure: async ({ durableJob: failedJob }) => {
      order.push(`human_review:${failedJob.application.state}:${failedJob.application.error.type}`);
    }
  });

  assert.equal((await coordinator.enqueue(durableJob)).accepted, true);
  await coordinator.idle();
  assert.equal((await coordinator.enqueue(durableJob)).accepted, false);
  await coordinator.idle();
  assert.equal(applyCount, 1);
  assert.deepEqual(order, ['persist_applying', 'apply', 'persist_failed_review', 'human_review:failed:ambiguous_dom_apply_failure', 'persist_notified']);
});

test('Gateway result coordinator recovers only durable pending applications after restart', async () => {
  const order = [];
  let state = 'pending';
  const durableJob = {
    job_id: 'job-startup-pending', room_key: 'room-startup-pending', room_revision: 1,
    event: { job_id: 'job-startup-pending', room_key: 'room-startup-pending', room_revision: 1 },
    local_context: {
      job: { jobId: 'job-startup-pending', roomKey: 'room-startup-pending', roomRevision: 1 },
      turn_internal: { snapshot: {} }
    },
    result: { content: 'FINAL_JSON {}' }, tool_receipts: [], application: { state: 'pending' }
  };
  const channel = {
    async listPendingApplications() { return [structuredClone(durableJob)]; },
    async claimApplication() {
      if (state !== 'pending') return { claimed: false };
      state = 'claimed';
      return { claimed: true, application_id: 'application-startup', job: structuredClone({ ...durableJob, application: { state: 'claimed' } }) };
    },
    async beginApplication() { state = 'applying'; order.push('apply_boundary'); },
    async recordApplicationApplied() { state = 'applied'; },
    async finalizeApplication() { state = 'finalized'; },
    async failApplication() { state = 'failed'; },
    async listPendingApplicationFailureNotifications() { return []; },
    async markApplicationFailureNotified() {}
  };
  const coordinator = createGatewayResultApplicationCoordinator({
    channel, getConfig: () => ({}),
    prepare: async () => ({ status: 'ai_prepared', snapshot: {} }),
    apply: async ({ prepared }) => { order.push('apply'); return { prepared, autoReplyResult: { sent: false } }; },
    finalize: async ({ applied }) => ({ ...applied.prepared, status: 'ai_completed' })
  });

  const recovered = await coordinator.recoverPendingApplications();
  await coordinator.idle();
  assert.deepEqual(recovered, [{ accepted: true, application_id: 'application-startup' }]);
  assert.deepEqual(order, ['apply_boundary', 'apply']);
  assert.equal(state, 'finalized');
});

test('Gateway result coordinator notifies restarted application failures without replaying apply or finalize', async () => {
  const order = [];
  let notificationState = 'pending';
  const failedJob = {
    job_id: 'job-restart-failure', room_key: 'room-restart-failure', room_revision: 1,
    event: { job_id: 'job-restart-failure', room_key: 'room-restart-failure', room_revision: 1 },
    local_context: {
      job: { jobId: 'job-restart-failure', roomKey: 'room-restart-failure', roomRevision: 1 },
      turn_internal: { snapshot: {} }
    },
    application: {
      state: 'failed', application_id: 'application-restart-failure',
      error: { type: 'ambiguous_post_apply_restart', message: 'DOM outcome is ambiguous' },
      failure_notification: { state: 'pending' }
    }
  };
  const channel = {
    async claimApplication() { throw new Error('must not claim failed application'); },
    async beginApplication() { throw new Error('must not begin failed application'); },
    async recordApplicationApplied() { throw new Error('must not apply failed application'); },
    async finalizeApplication() { throw new Error('must not finalize failed application'); },
    async failApplication() { throw new Error('must not fail an already failed application again'); },
    async listPendingApplicationFailureNotifications() {
      return notificationState === 'pending' ? [structuredClone(failedJob)] : [];
    },
    async markApplicationFailureNotified({ job_id, application_id }) {
      order.push(`notified:${job_id}:${application_id}`);
      notificationState = 'delivered';
    }
  };
  const coordinator = createGatewayResultApplicationCoordinator({
    channel, getConfig: () => ({}),
    prepare: async () => { order.push('unexpected_prepare'); },
    apply: async () => { order.push('unexpected_apply'); },
    finalize: async () => { order.push('unexpected_finalize'); },
    onFailure: async ({ durableJob, error }) => {
      order.push(`human_review:${durableJob.job_id}:${error.message}`);
    }
  });

  const recovered = await coordinator.recoverApplicationFailureNotifications();
  const duplicate = await coordinator.recoverApplicationFailureNotifications();
  assert.deepEqual(recovered, [{ job_id: failedJob.job_id, notified: true }]);
  assert.deepEqual(duplicate, []);
  assert.deepEqual(order, [
    'human_review:job-restart-failure:DOM outcome is ambiguous',
    'notified:job-restart-failure:application-restart-failure'
  ]);
});

test('Gateway result coordinator leaves failure notification pending when human-review notification fails', async () => {
  let marked = 0;
  const durableJob = {
    job_id: 'job-notification-retry', room_key: 'room-notification-retry', room_revision: 1,
    event: { job_id: 'job-notification-retry', room_key: 'room-notification-retry', room_revision: 1 },
    local_context: { job: { jobId: 'job-notification-retry' }, turn_internal: { snapshot: {} } },
    result: { content: 'FINAL_JSON {}' }, application: { state: 'claimed' }
  };
  const failedJob = {
    ...durableJob,
    application: {
      state: 'failed', application_id: 'application-notification-retry',
      error: { type: 'gateway_application_failed', message: 'apply failed' },
      failure_notification: { state: 'pending' }
    }
  };
  const channel = {
    async claimApplication() { return { claimed: true, application_id: 'application-notification-retry', job: structuredClone(durableJob) }; },
    async beginApplication() {}, async recordApplicationApplied() {}, async finalizeApplication() {},
    async failApplication() { return structuredClone(failedJob); },
    async listPendingApplicationFailureNotifications() { return [structuredClone(failedJob)]; },
    async markApplicationFailureNotified() { marked += 1; }
  };
  const coordinator = createGatewayResultApplicationCoordinator({
    channel, getConfig: () => ({}),
    prepare: async () => { throw new Error('apply failed'); },
    onFailure: async () => { throw new Error('owner card unavailable'); }
  });

  await coordinator.enqueue(durableJob);
  await coordinator.idle();
  const retry = await coordinator.recoverApplicationFailureNotifications();
  assert.equal(marked, 0);
  assert.deepEqual(retry, [{ job_id: failedJob.job_id, notified: false, error: 'owner card unavailable' }]);
});

test('Gateway application recovery keeps nested Slack skipped errors pending without replaying DOM work', async () => {
  let marks = 0;
  let statusUpdates = 0;
  let domWork = 0;
  const durableJob = {
    job_id: 'application-nested-slack-error', room_key: 'application-nested-room', room_revision: 1,
    local_context: {
      job: { jobId: 'application-nested-slack-error', roomKey: 'application-nested-room', roomRevision: 1 }
    },
    application: {
      state: 'failed', application_id: 'application-nested-id',
      error: { type: 'ambiguous_post_apply_restart' },
      failure_notification: { state: 'pending' }
    }
  };
  const channel = {
    async listPendingApplicationFailureNotifications() { return [structuredClone(durableJob)]; },
    async markApplicationFailureNotified() { marks += 1; },
    async claimApplication() { domWork += 1; },
    async beginApplication() { domWork += 1; },
    async recordApplicationApplied() { domWork += 1; },
    async finalizeApplication() { domWork += 1; },
    async failApplication() { domWork += 1; }
  };
  const onFailure = createGatewayApplicationFailureNotifier({
    slackEnabled: true,
    createFollowUp: async () => ({
      inserted: 1,
      rows: [{ id: 'application-failure-card' }],
      slackDeliveryResult: {
        skipped: true,
        reason: 'two_channel_preflight_failed',
        error: 'Slack routing unavailable',
        results: []
      }
    }),
    updateStatus: async () => { statusUpdates += 1; }
  });
  const coordinator = createGatewayResultApplicationCoordinator({
    channel,
    getConfig: () => ({}),
    prepare: async () => { domWork += 1; },
    apply: async () => { domWork += 1; },
    finalize: async () => { domWork += 1; },
    onFailure
  });

  const recovered = await coordinator.recoverApplicationFailureNotifications();
  assert.deepEqual({
    notified: recovered[0].notified,
    error: recovered[0].error || '',
    marks,
    statusUpdates
  }, {
    notified: false,
    error: 'gateway_failure_notification_slack_failed: Slack routing unavailable',
    marks: 0,
    statusUpdates: 0
  });
  assert.equal(domWork, 0);
});

test('Gateway result coordinator audit elapsed time includes durable Hermes session and tool wait', async () => {
  const detectedAt = '2026-08-21T00:00:00.000Z';
  const localStart = Date.parse('2026-08-21T00:02:00.000Z');
  const finished = Date.parse('2026-08-21T00:02:05.000Z');
  const clock = [localStart, finished];
  let recorded = null;
  const durableJob = {
    job_id: 'job-total-elapsed', room_key: 'room-total-elapsed', room_revision: 1,
    created_at: '2026-08-21T00:00:03.000Z',
    event: {
      job_id: 'job-total-elapsed', room_key: 'room-total-elapsed', room_revision: 1,
      detected_at: detectedAt
    },
    local_context: {
      job: { jobId: 'job-total-elapsed', roomKey: 'room-total-elapsed', roomRevision: 1, detectedAt },
      turn_internal: { snapshot: {} }
    },
    result: { content: 'FINAL_JSON {}' }, tool_receipts: [], application: { state: 'pending' }
  };
  const channel = {
    async claimApplication() { return { claimed: true, application_id: 'application-total-elapsed', job: structuredClone(durableJob) }; },
    async beginApplication() {}, async recordApplicationApplied() {}, async finalizeApplication() {}, async failApplication() {},
    async listPendingApplicationFailureNotifications() { return []; }, async markApplicationFailureNotified() {}
  };
  const coordinator = createGatewayResultApplicationCoordinator({
    channel,
    getConfig: () => ({}),
    now: () => clock.shift(),
    prepare: async () => ({ status: 'ai_prepared', snapshot: {} }),
    apply: async ({ prepared }) => ({ prepared, autoReplyResult: { sent: false } }),
    finalize: async ({ applied }) => ({ ...applied.prepared, status: 'ai_completed' }),
    record: async (value) => { recorded = value; }
  });

  await coordinator.enqueue(durableJob);
  await coordinator.idle();
  assert.equal(recorded.elapsedMs, 125_000);
  assert.equal(recorded.localApplicationElapsedMs, 5_000);
});

test('P0 Slack escalation repeats only after the durable interval and stops on closure', () => {
  const row = {
    id: 'p0-row',
    status: 'open',
    customer_name: '백남준',
    title: '대여 장비 이상 즉시 확인',
    payload: {
      alert_level: 'p0',
      alert_reason: '대여 중 장비 상태에 즉시 사람 판단 필요',
      slack_delivery: {
        status: 'delivered',
        channel_id: 'CINV',
        message_ts: '100.1',
        thread_ts: '100.1',
        delivered_at: '2026-08-18T00:00:00.000Z'
      }
    }
  };
  assert.equal(p0SlackEscalationDue(row, { nowMs: Date.parse('2026-08-18T00:02:59.000Z'), repeatMs: 180_000 }).due, false);
  assert.equal(p0SlackEscalationDue(row, { nowMs: Date.parse('2026-08-18T00:03:00.000Z'), repeatMs: 180_000 }).due, true);
  assert.equal(p0SlackEscalationDue({ ...row, status: 'done' }, { nowMs: Date.parse('2026-08-18T01:00:00.000Z') }).due, false);
});

test('P0 Slack escalation claim is durable and produces a deterministic Slack message id', () => {
  const row = {
    id: 'p0-row', status: 'open', customer_name: '백남준', title: '즉시 확인',
    payload: {
      alert_level: 'p0', alert_reason: '금액 또는 장비 사고',
      slack_delivery: { status: 'delivered', channel_id: 'CINV', message_ts: '100.1', thread_ts: '100.1', delivered_at: '2026-08-18T00:00:00.000Z' }
    }
  };
  const first = buildP0SlackEscalationClaim(row, { nowMs: Date.parse('2026-08-18T00:03:00.000Z'), repeatMs: 180_000 });
  const retry = buildP0SlackEscalationClaim(row, { nowMs: Date.parse('2026-08-18T00:03:00.000Z'), repeatMs: 180_000 });
  assert.equal(first.attempt, 1);
  assert.equal(first.clientMessageId, retry.clientMessageId);
  assert.match(first.clientMessageId, /^[0-9a-f-]{36}$/);
  const message = buildP0SlackEscalationMessage(row, first, { mentionUserIds: ['UOWNER'] });
  assert.match(message.text, /<!channel>/);
  assert.match(message.text, /<@UOWNER>/);
  assert.equal(message.thread_ts, '100.1');
  assert.equal(message.reply_broadcast, true);
  assert.equal(message.client_msg_id, first.clientMessageId);
});

test('P0 Slack escalation backs off exponentially and stops at the attempt cap', () => {
  const base = {
    id: 'p0-row', status: 'open', customer_name: '백남준', title: '즉시 확인',
    payload: {
      alert_level: 'p0', alert_reason: '금액 또는 장비 사고',
      slack_delivery: { status: 'delivered', channel_id: 'CINV', message_ts: '100.1', thread_ts: '100.1', delivered_at: '2026-08-18T00:00:00.000Z' }
    }
  };
  assert.equal(p0SlackEscalationBackoffMs(0, 600_000, 3_600_000), 600_000);
  assert.equal(p0SlackEscalationBackoffMs(1, 600_000, 3_600_000), 1_200_000);
  assert.equal(p0SlackEscalationBackoffMs(2, 600_000, 3_600_000), 2_400_000);
  assert.equal(p0SlackEscalationBackoffMs(6, 600_000, 3_600_000), 3_600_000);
  const afterFirst = {
    ...base,
    payload: { ...base.payload, critical_delivery: { status: 'delivered', attempt: 1, last_sent_at: '2026-08-18T00:10:00.000Z' } }
  };
  assert.equal(p0SlackEscalationDue(afterFirst, { nowMs: Date.parse('2026-08-18T00:29:59.000Z'), repeatMs: 600_000 }).due, false);
  assert.equal(p0SlackEscalationDue(afterFirst, { nowMs: Date.parse('2026-08-18T00:30:00.000Z'), repeatMs: 600_000 }).due, true);
  const exhausted = {
    ...base,
    payload: { ...base.payload, critical_delivery: { status: 'delivered', attempt: 159, last_sent_at: '2026-08-18T00:10:00.000Z' } }
  };
  assert.equal(p0SlackEscalationDue(exhausted, { nowMs: Date.parse('2026-08-19T00:00:00.000Z') }).reason, 'max_attempts');
  assert.equal(p0SlackEscalationDue(base, { nowMs: Date.parse('2026-08-19T00:00:00.000Z'), maxAttempts: 0 }).reason, 'disabled');
});

test('P0 escalation without an initial Slack card falls back to a standalone channel message', () => {
  const row = {
    id: 'p0-row-2', status: 'open', customer_name: '김손님', title: '즉시 확인',
    created_at: '2026-08-18T00:00:00.000Z', updated_at: '2026-08-18T00:00:00.000Z',
    payload: { alert_level: 'p0', alert_reason: '초기 카드 전달 실패' }
  };
  const due = p0SlackEscalationDue(row, { nowMs: Date.parse('2026-08-18T00:10:00.000Z'), repeatMs: 600_000 });
  assert.equal(due.due, true);
  const claim = buildP0SlackEscalationClaim(row, { nowMs: Date.parse('2026-08-18T00:10:00.000Z'), repeatMs: 600_000 });
  const message = buildP0SlackEscalationMessage(row, claim, { mentionUserIds: ['UOWNER'], fallbackChannelId: 'CFOLLOWUP' });
  assert.equal(message.channel, 'CFOLLOWUP');
  assert.equal(message.thread_ts, undefined);
  assert.equal(message.reply_broadcast, false);
});

test('v2 P0 review round 1 cutover controls are distinct, default OFF, and readback precedes cutover', async () => {
  assert.deepEqual(resolveWorkOrchestratorP0Config({}), {
    readbackEnabled: false, cutoverEnabled: false
  });
  assert.deepEqual(resolveWorkOrchestratorP0Config({
    WORK_ORCHESTRATOR_V2_P0_READBACK_ENABLED: '1'
  }), { readbackEnabled: true, cutoverEnabled: false });
  assert.throws(() => resolveWorkOrchestratorP0Config({
    WORK_ORCHESTRATOR_V2_P0_CUTOVER_ENABLED: '1'
  }), /readback/i);

  const calls = [];
  const legacyResult = { marker: 'legacy' };
  const dryResult = { status: 'ok', eligibleCount: 0, selectedCount: 0, omittedCount: 0 };
  const staged = await runP0EscalationPair({
    readbackEnabled: true,
    cutoverEnabled: false,
    legacy: async () => { calls.push('legacy'); return legacyResult; },
    v2Readback: async () => { calls.push('readback'); return dryResult; },
    v2: async () => { calls.push('v2'); }
  });
  assert.deepEqual(calls, ['readback', 'legacy']);
  assert.deepEqual(staged, { legacy: legacyResult, readback: dryResult, sender: 'legacy' });

  calls.length = 0;
  const failedReadback = await runP0EscalationPair({
    readbackEnabled: true,
    legacy: async () => { calls.push('legacy'); return legacyResult; },
    v2Readback: async () => { calls.push('readback'); throw new Error('private readback failure'); }
  });
  assert.deepEqual(calls, ['readback', 'legacy']);
  assert.deepEqual(failedReadback, {
    legacy: legacyResult,
    readback: { status: 'error', errors: ['readback_failed'] },
    sender: 'legacy'
  });

  calls.length = 0;
  await runP0EscalationPair({
    readbackEnabled: true,
    cutoverEnabled: true,
    legacy: async () => calls.push('legacy'),
    v2Readback: async () => calls.push('readback'),
    v2: async () => { calls.push('v2'); return { status: 'ok' }; }
  });
  assert.deepEqual(calls, ['v2']);
});

test('v2 cutover guard validates the bridge startup target independently', () => {
  const validTarget = {
    WORK_ORCHESTRATOR_V2_SHADOW_WRITES: '1',
    WORK_ORCHESTRATOR_V2_IMMEDIATE_ENABLED: '1',
    WORK_ORCHESTRATOR_V2_WORK_ITEMS_ENABLED: '1',
    WORK_ORCHESTRATOR_V2_DIGEST_ENABLED: '1',
    WORK_ORCHESTRATOR_V2_CLEANUP_ENABLED: '1',
    WORK_ORCHESTRATOR_V2_P0_READBACK_ENABLED: '1',
    WORK_ORCHESTRATOR_V2_P0_CUTOVER_ENABLED: '1',
    AI_WORKER_FOLLOW_UP_ITEMS_ENABLED: '0',
    KAKAO_FOLLOW_UP_ITEMS_ENABLED: '0',
    SLACK_AGENT_CARD_DELIVERY_ENABLED: '0',
    P0_SLACK_ESCALATION_ENABLED: '0'
  };

  assert.doesNotThrow(() => validateWorkOrchestratorV2CutoverConfig(validTarget));
  assert.throws(
    () => validateWorkOrchestratorV2CutoverConfig({
      ...validTarget,
      WORK_ORCHESTRATOR_V2_IMMEDIATE_ENABLED: '0',
      WORK_ORCHESTRATOR_V2_CLEANUP_ENABLED: '0'
    }),
    /legacy cards.*immediate/i
  );
  assert.throws(
    () => validateWorkOrchestratorV2CutoverConfig({
      ...validTarget,
      WORK_ORCHESTRATOR_V2_WORK_ITEMS_ENABLED: '0'
    }),
    /legacy work rows.*work items/i
  );
  assert.throws(
    () => validateWorkOrchestratorV2CutoverConfig({
      ...validTarget,
      WORK_ORCHESTRATOR_V2_P0_READBACK_ENABLED: '0',
      WORK_ORCHESTRATOR_V2_P0_CUTOVER_ENABLED: '0'
    }),
    /legacy P0.*v2 P0/i
  );
  assert.throws(
    () => validateWorkOrchestratorV2CutoverConfig({
      ...validTarget,
      SLACK_AGENT_CARD_DELIVERY_ENABLED: '1',
      AI_WORKER_FOLLOW_UP_ITEMS_ENABLED: '1',
      KAKAO_FOLLOW_UP_ITEMS_ENABLED: '1',
      P0_SLACK_ESCALATION_ENABLED: '1',
      WORK_ORCHESTRATOR_V2_IMMEDIATE_ENABLED: '0'
    }),
    /cleanup.*immediate/i
  );
});

test('v2 cutover guard blocks invalid bridge module startup', () => {
  const bridgeDirectory = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, '$1'));
  for (const [name, overrides, omitted] of [
    ['missing legacy card flag', {}, ['SLACK_AGENT_CARD_DELIVERY_ENABLED']],
    ['false legacy card flag', { SLACK_AGENT_CARD_DELIVERY_ENABLED: 'false' }, []],
    ['mixed legacy work flags', { KAKAO_FOLLOW_UP_ITEMS_ENABLED: 'false' }, []],
    ['legacy P0 false', { P0_SLACK_ESCALATION_ENABLED: 'false' }, []],
    ['cleanup without immediate', { WORK_ORCHESTRATOR_V2_CLEANUP_ENABLED: '1' }, []]
  ]) {
    const env = { ...process.env, ...SAFE_PRE_CUTOVER_ENV, ...overrides, KAKAO_DOM_BRIDGE_NO_LISTEN: '1' };
    for (const key of omitted) delete env[key];
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', "import './server.mjs'"], {
      cwd: bridgeDirectory, env, encoding: 'utf8'
    });
    assert.equal(result.status, 1, name);
    assert.match(`${result.stdout}\n${result.stderr}`, /cutover guard/i, name);
  }
});

test('v2 P0 review round 1 dry readback is authoritative and never claims, searches, or sends', async () => {
  const calls = [];
  const runtime = createWorkOrchestratorP0Runtime({
    config: {
      workItemsEnabled: true, p0ReadbackEnabled: true, p0CutoverEnabled: false,
      digestChannelId: 'CP0'
    },
    store: {
      async listDueP0Work(input) {
        calls.push(['list', input]);
        return { rows: Array.from({ length: 50 }, () => ({
          id: '11111111-1111-4111-8111-111111111111', version: 7,
          priority: 'p0', state: 'open', first_opened_at: '2026-09-01T05:00:00.000Z',
          title: 'Immediate review', summary: 'Review required',
          payload: { requires_human_action: true }
        })), eligibleCount: 61, selectedCount: 50, omittedCount: 11 };
      },
      async claimP0Delivery() { calls.push(['claim']); },
      async settleP0Delivery() { calls.push(['settle']); },
      async readP0Delivery() { calls.push(['read']); }
    },
    slack: {
      async postMessage() { calls.push(['post']); },
      async findMessageByClientId() { calls.push(['search']); }
    },
    now: () => new Date('2026-09-01T06:00:00.000Z')
  });

  assert.deepEqual(await runtime.sweep('dry'), {
    status: 'not_ready', mode: 'readback', eligibleCount: 61, selectedCount: 50,
    omittedCount: 11, scanned: 50, ready: false, errors: ['p0_eligible_overflow']
  });
  assert.deepEqual(calls, [['list', { now: '2026-09-01T06:00:00.000Z', limit: 50 }]]);
});

test('v2 P0 review round 1 known Slack coordinates survive lost settlement response without repost or retry state', async () => {
  const row = {
    id: '11111111-1111-4111-8111-111111111111', version: 7, priority: 'p0', state: 'open',
    first_opened_at: '2026-09-01T05:30:00.000Z', title: 'Immediate review', summary: 'Review required',
    payload: { requires_human_action: true }
  };
  let posts = 0;
  const settlements = [];
  const reads = [];
  const runtime = createWorkOrchestratorP0Runtime({
    config: {
      workItemsEnabled: true, p0ReadbackEnabled: true, p0CutoverEnabled: true,
      digestChannelId: 'CP0'
    },
    store: {
      async listDueP0Work() {
        return { rows: [row], eligibleCount: 1, selectedCount: 1, omittedCount: 0 };
      },
      async claimP0Delivery(input) {
        return { applied: true, row: { ...row, payload: { ...row.payload, p0_delivery: {
          status: 'claimed', generation: input.generation, attempt: input.attempt,
          client_message_id: input.clientMessageId, claimed_at: input.claimedAt,
          claim_expires_at: input.claimExpiresAt
        } } } };
      },
      async claimP0Reconciliation() { throw new Error('reconciliation must not run'); },
      async settleP0Delivery(input) {
        settlements.push(input);
        throw new Error('response lost after commit');
      },
      async readP0Delivery(input) {
        reads.push(input);
        return { matched: true, row: { ...row, payload: { ...row.payload, p0_delivery: {
          status: 'delivered', generation: 1, attempt: 1,
          client_message_id: input.clientMessageId,
          claimed_at: '2026-09-01T06:00:00.000Z', claim_expires_at: '2026-09-01T06:02:00.000Z',
          last_attempt_at: '2026-09-01T06:00:00.000Z', delivered_at: '2026-09-01T06:00:00.000Z',
          next_at: '2026-09-01T06:20:00.000Z',
          readback: { channel_id: 'CP0', message_ts: '100.1', confirmed_at: '2026-09-01T06:00:00.000Z' }
        } } } };
      }
    },
    slack: {
      async postMessage() { posts += 1; return { channel: 'CP0', ts: '100.1' }; },
      async findMessageByClientId() { throw new Error('new claim posts directly'); }
    },
    now: () => new Date('2026-09-01T06:00:00.000Z')
  });

  const result = await runtime.sweep('test');
  assert.equal(result.delivered, 1);
  assert.deepEqual(result.errors, []);
  assert.equal(posts, 1);
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].expectedStatus, 'claimed');
  assert.equal(settlements[0].status, 'delivered');
  assert.equal(reads.length, 1);
  assert.equal(reads[0].clientMessageId, settlements[0].clientMessageId);
  assert.doesNotMatch(JSON.stringify(settlements), /retry_pending|post_failed/);
});

test('bridge exposes invariant health as a separate top-level subsystem without changing bridge ok', async () => {
  const now = '2026-09-02T12:00:00.000Z';
  const aggregate = {
    measured_at: now,
    invalid_evidence_count: 0,
    notifications: {
      undelivered_count: 1, pending_count: 1, delivering_count: 0, failed_count: 0,
      oldest_undelivered_at: '2026-09-02T11:54:59.000Z', oldest_undelivered_age_seconds: 301
    },
    automation: {
      not_attempted_count: 0, running_count: 0, succeeded_count: 0,
      failed_count: 0, needs_human_count: 0
    },
    work: {
      actionable_count: 0, snoozed_count: 0, overdue_count: 0, p0_count: 0,
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
    }
  };
  const subsystem = await readBridgeWorkOrchestratorHealth({
    store: { readHealthAggregate: async (input) => {
      assert.deepEqual(input, { now });
      return aggregate;
    } },
    now: () => now
  });
  const response = attachWorkOrchestratorInvariantHealth({
    ok: true, gateway: { authenticated: true }, state: { privatePayload: 'not-inspected' }
  }, subsystem);

  assert.equal(response.ok, true, 'the bridge process remains independently healthy');
  assert.equal(response.workOrchestrator.ok, false);
  assert.deepEqual(response.workOrchestrator.reasons, ['immediate_delivery_sla_breached']);
  assert.equal(response.gateway.authenticated, true);
  assert.equal(response.state.privatePayload, 'not-inspected');
  assert.doesNotMatch(JSON.stringify(response.workOrchestrator), /not-inspected/);
});

test('v2 P0 review round 1 exposes finite content-free cutover readiness health', () => {
  const config = buildHealthConfig({
    workOrchestrator: {
      shadowWrites: false, immediateEnabled: true, workItemsEnabled: true,
      digestEnabled: true, cleanupEnabled: true,
      p0ReadbackEnabled: true, p0CutoverEnabled: false
    },
    workOrchestratorStoreConfigured: true,
    workOrchestratorShadowReady: true,
    workOrchestratorImmediateLocalConfigReady: true,
    workOrchestratorP0LocalConfigReady: true
  });
  assert.deepEqual({
    readbackEnabled: config.workOrchestrator.p0ReadbackEnabled,
    cutoverEnabled: config.workOrchestrator.p0CutoverEnabled,
    localConfigReady: config.workOrchestrator.p0LocalConfigReady
  }, { readbackEnabled: true, cutoverEnabled: false, localConfigReady: true });
  const health = buildWorkOrchestratorHealthState({
    lastP0Readback: {
      status: 'not_ready', mode: 'readback', eligibleCount: 61,
      selectedCount: 50, omittedCount: 11, ready: false,
      errors: ['p0_eligible_overflow'], privatePayload: 'must-not-leak'
    }
  });
  assert.deepEqual(health.lastP0Readback, {
    status: 'not_ready', mode: 'readback', eligibleCount: 61,
    selectedCount: 50, omittedCount: 11, ready: false,
    errors: ['p0_eligible_overflow']
  });
  assert.doesNotMatch(JSON.stringify(health), /must-not-leak/);
});

test('v2 P0 review round 2 dry readback validates every selected delivery before readiness', async () => {
  const row = {
    id: '11111111-1111-4111-8111-111111111111', version: 7, priority: 'p0', state: 'open',
    first_opened_at: '2026-09-02T05:00:00.000Z', title: 'Immediate review', summary: 'Review required',
    payload: { requires_human_action: true, p0_delivery: {
      status: 'unknown', generation: 1, attempt: 1,
      client_message_id: '11111111-2222-5333-8444-555555555555'
    } }
  };
  const calls = [];
  const runtime = createWorkOrchestratorP0Runtime({
    config: {
      workItemsEnabled: true, p0ReadbackEnabled: true, p0CutoverEnabled: false,
      digestChannelId: 'CP0'
    },
    store: {
      async listDueP0Work() {
        return { rows: [row], eligibleCount: 1, selectedCount: 1, omittedCount: 0 };
      },
      async claimP0Delivery() { calls.push('claim'); },
      async claimP0Reconciliation() { calls.push('reconcile_claim'); },
      async settleP0Delivery() { calls.push('settle'); },
      async readP0Delivery() { calls.push('read'); }
    },
    slack: {
      async postMessage() { calls.push('post'); },
      async findMessageByClientId() { calls.push('search'); }
    },
    now: () => new Date('2026-09-02T06:00:00.000Z')
  });

  assert.deepEqual(await runtime.sweep('dry'), {
    status: 'not_ready', mode: 'readback', eligibleCount: 1, selectedCount: 1,
    omittedCount: 0, scanned: 1, ready: false, errors: ['invalid_delivery']
  });
  assert.deepEqual(calls, []);
});

test('v2 P0 review round 2 self-review rejects unprocessable dry rows with one finite error', async () => {
  const base = {
    version: 7, priority: 'p0', state: 'open',
    first_opened_at: '2026-09-02T05:00:00.000Z', title: 'Immediate review', summary: 'Review required'
  };
  const rows = [{
    ...base,
    id: '11111111-1111-4111-8111-111111111111',
    payload: { requires_human_action: true, p0_delivery: {
      status: 'delivered', generation: 1, attempt: 1,
      client_message_id: '11111111-2222-5333-8444-555555555555',
      delivered_at: '2026-09-02T05:10:00.000Z', next_at: '2026-09-02T05:30:00.000Z',
      readback: { channel_id: 'CP0', message_ts: '100.1', confirmed_at: '2026-09-02T05:10:00.000Z' },
      unexpected: 'field'
    } }
  }, {
    ...base,
    id: 'not-a-work-id',
    payload: { requires_human_action: true }
  }];
  const calls = [];
  const runtime = createWorkOrchestratorP0Runtime({
    config: { workItemsEnabled: true, p0ReadbackEnabled: true, p0CutoverEnabled: false, digestChannelId: 'CP0' },
    store: {
      async listDueP0Work() { return { rows, eligibleCount: 2, selectedCount: 2, omittedCount: 0 }; },
      async claimP0Delivery() { calls.push('claim'); },
      async claimP0Reconciliation() { calls.push('reconcile_claim'); },
      async settleP0Delivery() { calls.push('settle'); },
      async readP0Delivery() { calls.push('read'); }
    },
    slack: {
      async postMessage() { calls.push('post'); },
      async findMessageByClientId() { calls.push('search'); }
    },
    now: () => new Date('2026-09-02T06:00:00.000Z')
  });

  assert.deepEqual(await runtime.sweep('dry'), {
    status: 'not_ready', mode: 'readback', eligibleCount: 2, selectedCount: 2,
    omittedCount: 0, scanned: 2, ready: false, errors: ['invalid_delivery']
  });
  assert.deepEqual(calls, []);
});

test('v2 P0 review round 2 two runtimes reclaim one expired lease and post exactly once', async () => {
  const clientId = '11111111-2222-5333-8444-555555555555';
  const expired = {
    id: '11111111-1111-4111-8111-111111111111', version: 8, priority: 'p0', state: 'open',
    first_opened_at: '2026-09-02T05:00:00.000Z', title: 'Immediate review', summary: 'Review required',
    payload: { requires_human_action: true, p0_delivery: {
      status: 'reconciling', generation: 1, attempt: 1, client_message_id: clientId,
      claimed_at: '2026-09-02T05:50:00.000Z', claim_expires_at: '2026-09-02T05:52:00.000Z',
      last_attempt_at: '2026-09-02T05:51:00.000Z', next_at: '2026-09-02T05:52:00.000Z',
      reconcile_owner: '99999999-9999-4999-8999-999999999999',
      reconcile_token: '88888888-8888-4888-8888-888888888888',
      reconcile_claimed_at: '2026-09-02T05:55:00.000Z', reconcile_expires_at: '2026-09-02T05:57:00.000Z'
    } }
  };
  let winner = null;
  let posts = 0;
  let searches = 0;
  const settlements = [];
  const store = {
    async listDueP0Work() {
      return { rows: [expired], eligibleCount: 1, selectedCount: 1, omittedCount: 0 };
    },
    async claimP0Delivery() { throw new Error('must retain the same generation'); },
    async claimP0Reconciliation(input) {
      if (winner !== null) return { claimed: false, row: null };
      winner = input.reconcileOwner;
      return { claimed: true, row: { ...expired, payload: { ...expired.payload, p0_delivery: {
        ...expired.payload.p0_delivery,
        reconcile_owner: input.reconcileOwner,
        reconcile_token: '77777777-7777-4777-8777-777777777777',
        reconcile_claimed_at: input.now,
        reconcile_expires_at: '2026-09-02T06:02:00.000Z'
      } } } };
    },
    async settleP0Delivery(input) { settlements.push(input); return { applied: true, row: expired }; },
    async readP0Delivery() { throw new Error('read must not run'); }
  };
  const slack = {
    async findMessageByClientId() { searches += 1; return null; },
    async postMessage() { posts += 1; return { channel: 'CP0', ts: '100.1' }; }
  };
  const makeRuntime = (reconciliationOwner) => createWorkOrchestratorP0Runtime({
    config: {
      workItemsEnabled: true, p0ReadbackEnabled: true, p0CutoverEnabled: true,
      digestChannelId: 'CP0'
    },
    store, slack, reconciliationOwner,
    now: () => new Date('2026-09-02T06:00:00.000Z')
  });

  const results = await Promise.all([
    makeRuntime('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa').sweep('test'),
    makeRuntime('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb').sweep('test')
  ]);
  assert.equal(posts, 1);
  assert.equal(searches, 1);
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].expectedStatus, 'reconciling');
  assert.equal(settlements[0].reconcileOwner, winner);
  assert.equal(settlements[0].reconcileToken, '77777777-7777-4777-8777-777777777777');
  assert.equal(results.reduce((sum, result) => sum + result.delivered, 0), 1);
});

test('v2 P0 review round 2 definite reconciliation rejection becomes durable same-generation retry', async () => {
  const clientId = '11111111-2222-5333-8444-555555555555';
  const pending = {
    id: '11111111-1111-4111-8111-111111111111', version: 8, priority: 'p0', state: 'open',
    first_opened_at: '2026-09-02T05:00:00.000Z', title: 'Immediate review', summary: 'Review required',
    payload: { requires_human_action: true, p0_delivery: {
      status: 'reconcile_pending', generation: 1, attempt: 1, client_message_id: clientId,
      claimed_at: '2026-09-02T05:50:00.000Z', claim_expires_at: '2026-09-02T05:52:00.000Z',
      last_attempt_at: '2026-09-02T05:51:00.000Z', next_at: '2026-09-02T06:00:00.000Z'
    } }
  };
  const records = [];
  const runtime = createWorkOrchestratorP0Runtime({
    config: {
      workItemsEnabled: true, p0ReadbackEnabled: true, p0CutoverEnabled: true,
      digestChannelId: 'CP0'
    },
    reconciliationOwner: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    store: {
      async listDueP0Work() { return { rows: [pending], eligibleCount: 1, selectedCount: 1, omittedCount: 0 }; },
      async claimP0Delivery() { throw new Error('must not claim a new generation'); },
      async claimP0Reconciliation(input) {
        return { claimed: true, row: { ...pending, payload: { ...pending.payload, p0_delivery: {
          ...pending.payload.p0_delivery, status: 'reconciling',
          reconcile_owner: input.reconcileOwner,
          reconcile_token: '77777777-7777-4777-8777-777777777777',
          reconcile_claimed_at: input.now, reconcile_expires_at: '2026-09-02T06:02:00.000Z'
        } } } };
      },
      async settleP0Delivery(input) { records.push(input); return { applied: true, row: pending }; },
      async readP0Delivery() { throw new Error('read must not run'); }
    },
    slack: {
      async findMessageByClientId() { return null; },
      async postMessage() { throw Object.assign(new Error('private rejection'), { ambiguous: false }); }
    },
    now: () => new Date('2026-09-02T06:00:00.000Z')
  });

  const result = await runtime.sweep('test');
  assert.deepEqual(result.errors, ['post_failed']);
  assert.equal(records.length, 1);
  assert.equal(records[0].expectedStatus, 'reconciling');
  assert.equal(records[0].status, 'retry_pending');
  assert.equal(records[0].expectedGeneration, 1);
  assert.equal(records[0].clientMessageId, clientId);
  assert.equal(records[0].reconcileToken, '77777777-7777-4777-8777-777777777777');
});

test('v2 P0 review round 2 ambiguous reconciliation releases to a delayed same-ID reconcile path', async () => {
  const clientId = '11111111-2222-5333-8444-555555555555';
  const pending = {
    id: '11111111-1111-4111-8111-111111111111', version: 8, priority: 'p0', state: 'open',
    first_opened_at: '2026-09-02T05:00:00.000Z', title: 'Immediate review', summary: 'Review required',
    payload: { requires_human_action: true, p0_delivery: {
      status: 'reconcile_pending', generation: 1, attempt: 1, client_message_id: clientId,
      claimed_at: '2026-09-02T05:50:00.000Z', claim_expires_at: '2026-09-02T05:52:00.000Z',
      last_attempt_at: '2026-09-02T05:51:00.000Z', next_at: '2026-09-02T06:00:00.000Z'
    } }
  };
  const records = [];
  const runtime = createWorkOrchestratorP0Runtime({
    config: {
      workItemsEnabled: true, p0ReadbackEnabled: true, p0CutoverEnabled: true,
      digestChannelId: 'CP0'
    },
    reconciliationOwner: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    store: {
      async listDueP0Work() { return { rows: [pending], eligibleCount: 1, selectedCount: 1, omittedCount: 0 }; },
      async claimP0Delivery() { throw new Error('must not claim a new generation'); },
      async claimP0Reconciliation(input) {
        return { claimed: true, row: { ...pending, payload: { ...pending.payload, p0_delivery: {
          ...pending.payload.p0_delivery, status: 'reconciling',
          reconcile_owner: input.reconcileOwner,
          reconcile_token: '77777777-7777-4777-8777-777777777777',
          reconcile_claimed_at: input.now, reconcile_expires_at: '2026-09-02T06:02:00.000Z'
        } } } };
      },
      async settleP0Delivery(input) { records.push(input); return { applied: true, row: pending }; },
      async readP0Delivery() { throw new Error('read must not run'); }
    },
    slack: {
      async findMessageByClientId() { return null; },
      async postMessage() { throw Object.assign(new Error('private ambiguity'), { ambiguous: true }); }
    },
    now: () => new Date('2026-09-02T06:00:00.000Z')
  });

  const result = await runtime.sweep('test');
  assert.deepEqual(result.errors, ['post_failed']);
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'reconcile_pending');
  assert.equal(records[0].expectedGeneration, 1);
  assert.equal(records[0].clientMessageId, clientId);
});

test('v2 P0 review round 3 settlement reads a fresh clock after Slack post', async () => {
  const row = {
    id: '11111111-1111-4111-8111-111111111111', version: 7, priority: 'p0', state: 'open',
    first_opened_at: '2026-09-02T05:00:00.000Z', title: 'Immediate review', summary: 'Review required',
    payload: { requires_human_action: true }
  };
  const settlements = [];
  const clock = [
    '2026-09-02T06:00:00.000Z',
    '2026-09-02T06:00:05.000Z'
  ];
  let clockIndex = 0;
  const runtime = createWorkOrchestratorP0Runtime({
    config: { workItemsEnabled: true, p0ReadbackEnabled: true, p0CutoverEnabled: true, digestChannelId: 'CP0' },
    store: {
      async listDueP0Work() { return { rows: [row], eligibleCount: 1, selectedCount: 1, omittedCount: 0 }; },
      async claimP0Delivery(input) {
        return { applied: true, row: { ...row, payload: { ...row.payload, p0_delivery: {
          status: 'claimed', generation: input.generation, attempt: input.attempt,
          client_message_id: input.clientMessageId, claimed_at: input.claimedAt,
          claim_expires_at: input.claimExpiresAt
        } } } };
      },
      async claimP0Reconciliation() { throw new Error('reconciliation must not run'); },
      async settleP0Delivery(input) { settlements.push(input); return { applied: true, row }; },
      async readP0Delivery() { throw new Error('read must not run'); }
    },
    slack: {
      async postMessage() { return { channel: 'CP0', ts: '100.1' }; },
      async findMessageByClientId() { throw new Error('history must not run'); }
    },
    now: () => new Date(clock[Math.min(clockIndex++, clock.length - 1)])
  });

  const result = await runtime.sweep('test');
  assert.equal(result.delivered, 1);
  assert.equal(settlements.length, 1);
  assert.equal(settlements[0].recordedAt, '2026-09-02T06:00:05.000Z');
  assert.equal(clockIndex, 2);
});

test('v2 P0 review round 3 a lease expiring during Slack work makes fresh settlement stale', async () => {
  const clientId = '11111111-2222-5333-8444-555555555555';
  const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const token = '77777777-7777-4777-8777-777777777777';
  const leaseExpiresAt = '2026-09-02T06:02:00.000Z';
  const pending = {
    id: '11111111-1111-4111-8111-111111111111', version: 8, priority: 'p0', state: 'open',
    first_opened_at: '2026-09-02T05:00:00.000Z', title: 'Immediate review', summary: 'Review required',
    payload: { requires_human_action: true, p0_delivery: {
      status: 'reconcile_pending', generation: 1, attempt: 1, client_message_id: clientId,
      claimed_at: '2026-09-02T05:50:00.000Z', claim_expires_at: '2026-09-02T05:52:00.000Z',
      last_attempt_at: '2026-09-02T05:51:00.000Z', next_at: '2026-09-02T06:00:00.000Z'
    } }
  };
  const reconciling = { ...pending, payload: { ...pending.payload, p0_delivery: {
    ...pending.payload.p0_delivery, status: 'reconciling', reconcile_owner: owner,
    reconcile_token: token, reconcile_claimed_at: '2026-09-02T06:00:00.000Z',
    reconcile_expires_at: leaseExpiresAt
  } } };
  const settlements = [];
  const clock = [
    '2026-09-02T06:00:00.000Z',
    '2026-09-02T06:03:00.000Z',
    '2026-09-02T06:03:00.001Z'
  ];
  let clockIndex = 0;
  const runtime = createWorkOrchestratorP0Runtime({
    config: { workItemsEnabled: true, p0ReadbackEnabled: true, p0CutoverEnabled: true, digestChannelId: 'CP0' },
    reconciliationOwner: owner,
    store: {
      async listDueP0Work() { return { rows: [pending], eligibleCount: 1, selectedCount: 1, omittedCount: 0 }; },
      async claimP0Delivery() { throw new Error('new generation must not run'); },
      async claimP0Reconciliation() { return { claimed: true, row: reconciling }; },
      async settleP0Delivery(input) {
        settlements.push(input);
        return Date.parse(input.recordedAt) > Date.parse(leaseExpiresAt)
          ? { applied: false, row: null }
          : { applied: true, row: reconciling };
      },
      async readP0Delivery() { return { matched: true, row: reconciling }; }
    },
    slack: {
      async findMessageByClientId() { return null; },
      async postMessage() { return { channel: 'CP0', ts: '100.1' }; }
    },
    now: () => new Date(clock[Math.min(clockIndex++, clock.length - 1)])
  });

  const result = await runtime.sweep('test');
  assert.equal(result.delivered, 0);
  assert.deepEqual(result.errors, ['record_failed']);
  assert.equal(settlements.length, 2);
  assert.deepEqual(settlements.map((input) => input.recordedAt), [
    '2026-09-02T06:03:00.000Z',
    '2026-09-02T06:03:00.001Z'
  ]);
});

test('v2 P0 review round 3 record paths read fresh clocks after Slack rejection', async () => {
  const clientId = '11111111-2222-5333-8444-555555555555';
  const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const token = '77777777-7777-4777-8777-777777777777';
  const base = {
    id: '11111111-1111-4111-8111-111111111111', version: 8, priority: 'p0', state: 'open',
    first_opened_at: '2026-09-02T05:00:00.000Z', title: 'Immediate review', summary: 'Review required'
  };
  const initialRow = { ...base, payload: { requires_human_action: true } };
  const pending = { ...base, payload: { requires_human_action: true, p0_delivery: {
    status: 'reconcile_pending', generation: 1, attempt: 1, client_message_id: clientId,
    claimed_at: '2026-09-02T05:50:00.000Z', claim_expires_at: '2026-09-02T05:52:00.000Z',
    last_attempt_at: '2026-09-02T05:51:00.000Z', next_at: '2026-09-02T06:00:00.000Z'
  } } };
  const reconciling = { ...pending, payload: { ...pending.payload, p0_delivery: {
    ...pending.payload.p0_delivery, status: 'reconciling', reconcile_owner: owner,
    reconcile_token: token, reconcile_claimed_at: '2026-09-02T06:00:00.000Z',
    reconcile_expires_at: '2026-09-02T06:02:00.000Z'
  } } };
  const recordedAt = [];
  const makeClock = () => {
    const values = ['2026-09-02T06:00:00.000Z', '2026-09-02T06:00:05.000Z'];
    let index = 0;
    return () => new Date(values[Math.min(index++, values.length - 1)]);
  };
  const initialRuntime = createWorkOrchestratorP0Runtime({
    config: { workItemsEnabled: true, p0ReadbackEnabled: true, p0CutoverEnabled: true, digestChannelId: 'CP0' },
    store: {
      async listDueP0Work() { return { rows: [initialRow], eligibleCount: 1, selectedCount: 1, omittedCount: 0 }; },
      async claimP0Delivery(input) {
        return { applied: true, row: { ...initialRow, payload: { ...initialRow.payload, p0_delivery: {
          status: 'claimed', generation: 1, attempt: 1, client_message_id: input.clientMessageId,
          claimed_at: input.claimedAt, claim_expires_at: input.claimExpiresAt
        } } } };
      },
      async claimP0Reconciliation() { throw new Error('reconciliation must not run'); },
      async settleP0Delivery(input) { recordedAt.push(input.recordedAt); return { applied: true, row: initialRow }; },
      async readP0Delivery() { throw new Error('read must not run'); }
    },
    slack: {
      async postMessage() { throw Object.assign(new Error('private rejection'), { ambiguous: false }); },
      async findMessageByClientId() { throw new Error('history must not run'); }
    },
    now: makeClock()
  });
  const reconciliationRuntime = createWorkOrchestratorP0Runtime({
    config: { workItemsEnabled: true, p0ReadbackEnabled: true, p0CutoverEnabled: true, digestChannelId: 'CP0' },
    reconciliationOwner: owner,
    store: {
      async listDueP0Work() { return { rows: [pending], eligibleCount: 1, selectedCount: 1, omittedCount: 0 }; },
      async claimP0Delivery() { throw new Error('new generation must not run'); },
      async claimP0Reconciliation() { return { claimed: true, row: reconciling }; },
      async settleP0Delivery(input) { recordedAt.push(input.recordedAt); return { applied: true, row: pending }; },
      async readP0Delivery() { throw new Error('read must not run'); }
    },
    slack: {
      async findMessageByClientId() { return null; },
      async postMessage() { throw Object.assign(new Error('private rejection'), { ambiguous: false }); }
    },
    now: makeClock()
  });

  await initialRuntime.sweep('test');
  await reconciliationRuntime.sweep('test');
  assert.deepEqual(recordedAt, [
    '2026-09-02T06:00:05.000Z',
    '2026-09-02T06:00:05.000Z'
  ]);
});

test('v2 P0 stale claim CAS never reaches Slack', async () => {
  let posts = 0;
  const row = {
    id: '11111111-1111-4111-8111-111111111111', version: 7, priority: 'p0', state: 'open',
    first_opened_at: '2026-08-29T05:00:00.000Z', title: 'Immediate review', summary: 'Review required',
    payload: { requires_human_action: true }
  };
  const runtime = createWorkOrchestratorP0Runtime({
    config: { workItemsEnabled: true, p0ReadbackEnabled: true, p0CutoverEnabled: true, digestChannelId: 'CP0' },
    store: {
      async listDueP0Work() { return { rows: [row], eligibleCount: 1, selectedCount: 1, omittedCount: 0 }; },
      async claimP0Delivery() { return { applied: false, row: null }; },
      async claimP0Reconciliation() { throw new Error('reconciliation must not run'); },
      async settleP0Delivery() { throw new Error('settle must not run'); },
      async readP0Delivery() { throw new Error('read must not run'); }
    },
    slack: {
      async postMessage() { posts += 1; throw new Error('must not post'); },
      async findMessageByClientId() { throw new Error('must not search'); }
    },
    now: () => new Date('2026-08-29T06:00:00.000Z')
  });

  const result = await runtime.sweep('test');
  assert.equal(result.status, 'ok');
  assert.equal(result.scanned, 1);
  assert.equal(result.skipped, 1);
  assert.deepEqual(result.errors, []);
  assert.equal(posts, 0);
});

test('v2 P0 ambiguous retry reconciles the same generation and deterministic client id without blind repost', async () => {
  const clientId = '11111111-2222-5333-8444-555555555555';
  const claimed = {
    id: '11111111-1111-4111-8111-111111111111', version: 8, priority: 'p0', state: 'open',
    first_opened_at: '2026-08-29T05:00:00.000Z', title: 'Immediate review', summary: 'Review required',
    payload: { requires_human_action: true, p0_delivery: {
      status: 'reconcile_pending', generation: 1, attempt: 1, client_message_id: clientId,
      claimed_at: '2026-08-29T05:59:00.000Z', claim_expires_at: '2026-08-29T05:59:30.000Z',
      last_attempt_at: '2026-08-29T05:59:01.000Z', next_at: '2026-08-29T06:09:01.000Z'
    } }
  };
  let posts = 0;
  const searches = [];
  const records = [];
  const runtime = createWorkOrchestratorP0Runtime({
    config: { workItemsEnabled: true, p0ReadbackEnabled: true, p0CutoverEnabled: true, digestChannelId: 'CP0' },
    store: {
      async listDueP0Work() { return { rows: [claimed], eligibleCount: 1, selectedCount: 1, omittedCount: 0 }; },
      async claimP0Delivery() { throw new Error('same generation must reconcile before claiming'); },
      async claimP0Reconciliation(input) {
        return { claimed: true, row: { ...claimed, payload: { ...claimed.payload, p0_delivery: {
          ...claimed.payload.p0_delivery, status: 'reconciling',
          reconcile_owner: input.reconcileOwner,
          reconcile_token: '77777777-7777-4777-8777-777777777777',
          reconcile_claimed_at: input.now,
          reconcile_expires_at: '2026-08-29T06:11:01.000Z'
        } } } };
      },
      async settleP0Delivery(input) { records.push(input); return { applied: true, row: { version: 9 } }; },
      async readP0Delivery() { throw new Error('read must not run'); }
    },
    slack: {
      async postMessage() { posts += 1; throw new Error('must not repost'); },
      async findMessageByClientId(input) {
        searches.push(input);
        return { channel: 'CP0', ts: '100.1', client_msg_id: clientId };
      }
    },
    now: () => new Date('2026-08-29T06:09:01.000Z')
  });

  const result = await runtime.sweep('test');
  assert.equal(result.reconciled, 1);
  assert.equal(result.delivered, 1);
  assert.equal(posts, 0);
  assert.equal(searches[0].clientMsgId, clientId);
  assert.equal(records[0].expectedVersion, 8);
  assert.equal(records[0].expectedGeneration, 1);
  assert.equal(records[0].clientMessageId, clientId);
  assert.equal(records[0].status, 'delivered');
});

test('v2 P0 flag OFF preserves exact legacy sweep parity', async () => {
  const legacyResult = { scanned: 4, delivered: 1, marker: 'legacy-exact' };
  let v2Calls = 0;
  const result = await runP0EscalationPair({
    readbackEnabled: false,
    cutoverEnabled: false,
    legacy: async () => legacyResult,
    v2: async () => { v2Calls += 1; }
  });
  assert.equal(result, legacyResult);
  assert.equal(v2Calls, 0);
});

test('v2 P0 cutover lets one source event reach only the v2 escalation path', async () => {
  const calls = [];
  const result = await runP0EscalationPair({
    readbackEnabled: true,
    cutoverEnabled: true,
    legacy: async () => calls.push('legacy'),
    v2: async () => { calls.push('v2'); return { status: 'ok', scanned: 1 }; }
  });
  assert.deepEqual(calls, ['v2']);
  assert.deepEqual(result, { status: 'ok', scanned: 1 });
});

test('v2 P0 ambiguous Slack result durably records reconciliation before any later retry', async () => {
  const row = {
    id: '11111111-1111-4111-8111-111111111111', version: 7, priority: 'p0', state: 'open',
    first_opened_at: '2026-08-29T05:00:00.000Z', title: 'Immediate review', summary: 'Review required',
    payload: { requires_human_action: true }
  };
  const records = [];
  let claimedClientId = '';
  const runtime = createWorkOrchestratorP0Runtime({
    config: { workItemsEnabled: true, p0ReadbackEnabled: true, p0CutoverEnabled: true, digestChannelId: 'CP0' },
    store: {
      async listDueP0Work() { return { rows: [row], eligibleCount: 1, selectedCount: 1, omittedCount: 0 }; },
      async claimP0Delivery(input) {
        claimedClientId = input.clientMessageId;
        return { applied: true, row: { ...row, payload: { ...row.payload, p0_delivery: {
          status: 'claimed', generation: input.generation, attempt: input.attempt,
          client_message_id: input.clientMessageId, claimed_at: input.claimedAt,
          claim_expires_at: input.claimExpiresAt
        } } } };
      },
      async claimP0Reconciliation() { throw new Error('reconciliation must not run'); },
      async settleP0Delivery(input) { records.push(input); return { applied: true, row: { version: 9 } }; },
      async readP0Delivery() { throw new Error('read must not run'); }
    },
    slack: {
      async postMessage() { throw Object.assign(new Error('private transport failure'), { ambiguous: true }); },
      async findMessageByClientId() { throw new Error('reconciliation occurs on the next sweep'); }
    },
    now: () => new Date('2026-08-29T06:00:00.000Z')
  });

  const result = await runtime.sweep('test');
  assert.deepEqual(result.errors, ['post_failed']);
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'reconcile_pending');
  assert.equal(records[0].expectedVersion, 7);
  assert.equal(records[0].expectedGeneration, 1);
  assert.equal(records[0].clientMessageId, claimedClientId);
  assert.doesNotMatch(JSON.stringify(result), /private transport failure/);
});

test('v2 P0 definite Slack rejection records a same-generation retry without leaking content', async () => {
  const row = {
    id: '11111111-1111-4111-8111-111111111111', version: 7, priority: 'p0', state: 'open',
    first_opened_at: '2026-08-29T05:00:00.000Z', title: 'Immediate review', summary: 'Review required',
    payload: { requires_human_action: true }
  };
  const records = [];
  const runtime = createWorkOrchestratorP0Runtime({
    config: { workItemsEnabled: true, p0ReadbackEnabled: true, p0CutoverEnabled: true, digestChannelId: 'CP0' },
    store: {
      async listDueP0Work() { return { rows: [row], eligibleCount: 1, selectedCount: 1, omittedCount: 0 }; },
      async claimP0Delivery(input) {
        return { applied: true, row: { ...row, payload: { ...row.payload, p0_delivery: {
          status: 'claimed', generation: input.generation, attempt: input.attempt,
          client_message_id: input.clientMessageId, claimed_at: input.claimedAt,
          claim_expires_at: input.claimExpiresAt
        } } } };
      },
      async claimP0Reconciliation() { throw new Error('reconciliation must not run'); },
      async settleP0Delivery(input) { records.push(input); return { applied: true, row: { version: 9 } }; },
      async readP0Delivery() { throw new Error('read must not run'); }
    },
    slack: {
      async postMessage() { throw Object.assign(new Error('private rejected content'), { ambiguous: false }); },
      async findMessageByClientId() { throw new Error('must not search a definite rejection'); }
    },
    now: () => new Date('2026-08-29T06:00:00.000Z')
  });

  const result = await runtime.sweep('test');
  assert.deepEqual(result.errors, ['post_failed']);
  assert.equal(records.length, 1);
  assert.equal(records[0].status, 'retry_pending');
  assert.equal(records[0].expectedGeneration, 1);
  assert.doesNotMatch(JSON.stringify(result), /private rejected content/);
});

test('v2 P0 alert carries a current versioned acknowledgement action', async () => {
  const row = {
    id: '11111111-1111-4111-8111-111111111111', version: 7, priority: 'p0', state: 'open',
    first_opened_at: '2026-08-29T05:00:00.000Z', title: 'Immediate review', summary: 'Review required',
    payload: { requires_human_action: true }
  };
  let postedInput = null;
  const runtime = createWorkOrchestratorP0Runtime({
    config: { workItemsEnabled: true, p0ReadbackEnabled: true, p0CutoverEnabled: true, digestChannelId: 'CP0' },
    store: {
      async listDueP0Work() { return { rows: [row], eligibleCount: 1, selectedCount: 1, omittedCount: 0 }; },
      async claimP0Delivery(input) {
        return { applied: true, row: { ...row, payload: { ...row.payload, p0_delivery: {
          status: 'claimed', generation: input.generation, attempt: input.attempt,
          client_message_id: input.clientMessageId, claimed_at: input.claimedAt,
          claim_expires_at: input.claimExpiresAt
        } } } };
      },
      async claimP0Reconciliation() { throw new Error('reconciliation must not run'); },
      async settleP0Delivery() { return { applied: true, row }; },
      async readP0Delivery() { throw new Error('read must not run'); }
    },
    slack: {
      async postMessage(input) { postedInput = input; return { channel: 'CP0', ts: '100.1' }; },
      async findMessageByClientId() { throw new Error('must not search'); }
    },
    now: () => new Date('2026-08-29T06:00:00.000Z')
  });

  const result = await runtime.sweep('test');
  const action = postedInput.blocks[1].elements[0];
  const decoded = JSON.parse(Buffer.from(action.value, 'base64url').toString('utf8'));
  assert.equal(result.delivered, 1);
  assert.equal(action.action_id, 'village_work_v2_ack_p0');
  assert.deepEqual(decoded, {
    id: row.id,
    version: 7,
    action: { type: 'ack_p0' }
  });
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('slow Hermes decisions release the DOM lane for another room and manual sends', async () => {
  const firstDecision = deferred();
  const events = [];
  let domActive = 0;
  let maxDomActive = 0;
  let decisionActive = 0;
  let maxDecisionActive = 0;
  const withDomProbe = async (label, value) => {
    domActive += 1;
    maxDomActive = Math.max(maxDomActive, domActive);
    events.push(`${label}:start`);
    await new Promise((resolve) => setImmediate(resolve));
    events.push(`${label}:end`);
    domActive -= 1;
    return value;
  };
  const scheduler = createKakaoPhaseScheduler({
    decisionConcurrency: 2,
    capture: async (job) => withDomProbe(`capture:${job.roomKey}`, { job }),
    decide: async (snapshot) => {
      decisionActive += 1;
      maxDecisionActive = Math.max(maxDecisionActive, decisionActive);
      try {
        if (snapshot.job.roomKey === 'A') await firstDecision.promise;
        return { snapshot };
      } finally {
        decisionActive -= 1;
      }
    },
    apply: async (prepared) => withDomProbe(`apply:${prepared.snapshot.job.roomKey}`, prepared),
    finalize: async (applied) => applied,
    manualSend: async (payload) => withDomProbe('manual', { sent: true, payload })
  });

  const roomA = scheduler.run({ roomKey: 'A' });
  await new Promise((resolve) => setImmediate(resolve));
  const roomB = scheduler.run({ roomKey: 'B' });
  const manual = scheduler.runManual({ text: 'staff reply' });

  const [roomBResult, manualResult] = await Promise.all([roomB, manual]);
  assert.equal(roomBResult.snapshot.job.roomKey, 'B');
  assert.equal(manualResult.sent, true);
  assert.equal(maxDomActive, 1, 'capture/apply/manual DOM work must stay serial');
  assert.equal(maxDecisionActive, 2, 'two rooms may think concurrently');
  assert.ok(!events.includes('apply:A:start'), 'room A is still thinking');
  assert.equal(typeof roomBResult.phaseTimings.captureQueueMs, 'number');
  assert.equal(typeof roomBResult.phaseTimings.decisionMs, 'number');
  assert.equal(typeof roomBResult.phaseTimings.applyMs, 'number');
  assert.equal(typeof roomBResult.phaseTimings.totalMs, 'number');

  firstDecision.resolve();
  await roomA;
});

test('phase scheduler propagates a bridge deadline into an active Hermes decision', async () => {
  const controller = new AbortController();
  const deadlineError = new Error('bridge deadline exceeded');
  const scheduler = createKakaoPhaseScheduler({
    capture: async (job) => ({ job }),
    decide: async (snapshot, job, options = {}) => {
      if (!options.signal) throw new Error('missing phase abort signal');
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    },
    apply: async (prepared) => prepared,
    finalize: async (applied) => applied,
    manualSend: async (payload) => payload
  });

  const run = scheduler.run({ roomKey: 'deadline-room' }, { signal: controller.signal });
  controller.abort(deadlineError);

  await assert.rejects(run, (error) => error === deadlineError);
});

test('phase scheduler enforces the configured end-to-end worker timeout', async () => {
  // The production timeout is intentionally unref'ed; keep this isolated test's
  // event loop alive long enough to observe that timer without relying on other files.
  const keepAlive = setTimeout(() => {}, 100);
  const scheduler = createKakaoPhaseScheduler({
    workerTimeoutMs: 20,
    capture: async (job) => ({ job }),
    decide: async (snapshot, job, options = {}) => {
      if (!options.signal) {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return { snapshot };
      }
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    },
    apply: async (prepared) => prepared,
    finalize: async (applied) => applied,
    manualSend: async (payload) => payload
  });

  try {
    await assert.rejects(
      scheduler.run({ roomKey: 'timed-room' }),
      /worker timed out after 20ms/
    );
  } finally {
    clearTimeout(keepAlive);
  }
});

test('worker result audit keeps phase timings and AI attempt counts without customer payload', () => {
  const audit = buildWorkerResultAudit({
    status: 'ai_completed',
    hermesAttempts: 3,
    hermesRecovered: true,
    timings: { lookupMs: 100, hermesMs: 2000, sheetAndReconciliationMs: 500, totalMs: 2600 },
    phaseTimings: { captureQueueMs: 4, captureMs: 50, decisionQueueMs: 8, decisionMs: 2600, applyQueueMs: 2, applyMs: 30, finalizeMs: 20, totalMs: 2714 },
    decision: { reason: 'private customer content' },
    snapshot: { navigation: { conversation_evidence: { visible_static_text_tail: 'private chat' } } }
  }, 2714);
  const record = compactQueueAuditRecord('worker-results.ndjson', {
    at: '2026-08-18T00:00:00.000Z',
    jobId: 'dom-test',
    result: { code: 0, signal: null, timedOut: false, stdout: 'private stdout', stderr: '', audit }
  });

  assert.deepEqual(record.result.audit, audit);
  assert.equal(record.result.audit.status, 'ai_completed');
  assert.equal(record.result.audit.phaseTimings.decisionMs, 2600);
  assert.doesNotMatch(JSON.stringify(record.result.audit), /private|customer|chat/);
});

test('error audit persists only a valid content-free event correlation digest', () => {
  const validDigest = 'fb6c3ebcef1e697091ac9bd41203f918504979c64268d5ee44060340c8adb4e3';
  const record = compactQueueAuditRecord('errors.ndjson', {
    at: '2026-08-30T00:00:00.000Z',
    type: 'immediate_notification',
    eventCorrelationSha256: validDigest,
    eventHash: 'raw-event-hash-message-secret',
    event: { message: 'private-message', secret: 'xoxb-private-secret' },
    secret: 'top-level-private-secret'
  });

  assert.equal(record.eventCorrelationSha256, validDigest);
  assert.equal(Object.hasOwn(record, 'eventHash'), false);
  assert.equal(Object.hasOwn(record, 'event'), false);
  assert.equal(Object.hasOwn(record, 'secret'), false);
  assert.doesNotMatch(JSON.stringify(record), /raw-event-hash|private-message|xoxb-private-secret|top-level-private-secret/);

  for (const invalidDigest of [
    validDigest.toUpperCase(),
    validDigest.slice(1),
    `${validDigest}0`,
    'g'.repeat(64),
    ` ${validDigest}`,
    'message=private-secret'
  ]) {
    const invalidRecord = compactQueueAuditRecord('errors.ndjson', {
      type: 'immediate_notification',
      eventCorrelationSha256: invalidDigest
    });
    assert.equal(Object.hasOwn(invalidRecord, 'eventCorrelationSha256'), false);
    assert.doesNotMatch(JSON.stringify(invalidRecord), /private-secret/);
  }
});

test('production errors appender persists only content-free immediate correlation metadata', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kakao-immediate-error-audit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const appendError = createErrorsAuditAppender({ queueDir: directory });
  const validDigest = 'fb6c3ebcef1e697091ac9bd41203f918504979c64268d5ee44060340c8adb4e3';
  const privateFields = {
    eventHash: 'raw-event-hash-private',
    customer: 'private-customer',
    customerName: 'private-customer-name',
    message: 'private-message',
    secret: 'xoxb-private-secret',
    payload: { message: 'nested-private-message', token: 'nested-private-token' }
  };

  appendError({
    at: '2026-08-30T00:00:00.000Z',
    type: 'immediate_notification',
    eventCorrelationSha256: validDigest,
    ...privateFields
  });
  for (const invalidDigest of [
    validDigest.toUpperCase(),
    ` ${validDigest}`,
    'not-a-valid-private-message-secret-digest'
  ]) {
    appendError({
      at: '2026-08-30T00:00:01.000Z',
      type: 'immediate_notification',
      eventCorrelationSha256: invalidDigest,
      ...privateFields
    });
  }
  appendError({
    at: '2026-08-30T00:00:02.000Z',
    type: 'worker',
    message: 'existing generic error audit'
  });

  const records = (await readFile(path.join(directory, 'errors.ndjson'), 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.equal(records.length, 5);
  assert.deepEqual(records[0], {
    at: '2026-08-30T00:00:00.000Z',
    type: 'immediate_notification',
    eventCorrelationSha256: validDigest
  });
  for (const record of records.slice(1, 4)) {
    assert.deepEqual(record, {
      at: '2026-08-30T00:00:01.000Z',
      type: 'immediate_notification'
    });
  }
  assert.equal(records[4].message, 'existing generic error audit');
  assert.doesNotMatch(
    JSON.stringify(records.slice(0, 4)),
    /raw-event-hash|private-customer|private-message|xoxb-private-secret|nested-private-message|nested-private-token|eventHash|customer|message|secret|payload/i
  );
});

test('room revisions ignore unread-badge duplicates and supersede older semantic turns', () => {
  const versions = new Map();
  const first = registerAcceptedRoomEvent(versions, 'chat:1', '홍길동 문의 오후 1:00');
  const duplicate = registerAcceptedRoomEvent(versions, 'chat:1', '홍길동 문의 오후 1:00');
  const newer = registerAcceptedRoomEvent(versions, 'chat:1', '홍길동 추가 문의 오후 1:01');

  assert.equal(first.revision, 1);
  assert.equal(duplicate.revision, 1);
  assert.equal(duplicate.changed, false);
  assert.equal(newer.revision, 2);
  assert.equal(newer.changed, true);
});

test('room revisions continue after the durable Gateway revision when the bridge restarts', () => {
  const versions = new Map();
  const firstAfterRestart = registerAcceptedRoomEvent(
    versions,
    'chat:restarted',
    '김혜지 새 예약 요청',
    7
  );
  const duplicate = registerAcceptedRoomEvent(
    versions,
    'chat:restarted',
    '김혜지 새 예약 요청',
    7
  );
  const newer = registerAcceptedRoomEvent(
    versions,
    'chat:restarted',
    '김혜지 추가 메시지',
    7
  );

  assert.equal(firstAfterRestart.revision, 8);
  assert.equal(duplicate.revision, 8);
  assert.equal(duplicate.changed, false);
  assert.equal(newer.revision, 9);
});

test('immediate notification ignores heartbeat, diagnostic, container, non-message, ignored-room, and stale events', async () => {
  const calls = [];
  const shadowRuntime = { recordAccepted: () => calls.push('shadow') };
  const dependencies = {
    appendNdjson: () => {},
    shadowRuntime,
    immediateRuntime: { enabled: true, deliverAccepted: () => calls.push('immediate') },
    writeSupabaseEvent: async () => calls.push('legacy-write'),
    scheduleDebouncedJob: () => calls.push('legacy-queue')
  };
  const ignoredEvents = [
    { status: 'watcher_heartbeat', reason: 'heartbeat', roomKey: 'watcher', previewText: 'heartbeat' },
    { status: 'dom_diagnostic', reason: 'top_rows_snapshot', roomKey: 'diagnostic', previewText: 'snapshot' },
    { status: 'pending_ai_review', reason: 'dom_event', roomKey: 'attr:kakaoWrap', previewText: '전체 채팅목록' },
    { status: 'pending_ai_review', reason: 'dom_event', roomKey: 'chrome-control', previewText: '저장하기' },
    { status: 'pending_ai_review', reason: 'initial_scan', roomKey: 'chat:ignored-room', previewText: 'already read room' },
    { status: 'pending_ai_review', reason: 'mutation', roomKey: 'chat:stale', previewText: 'old room 2025. 1. 1' }
  ];

  for (const event of ignoredEvents) {
    const response = await postShadowEvent(event, dependencies);
    assert.equal(response.status, 202);
  }

  assert.deepEqual(calls, []);
});

function immediateNotificationEvent(overrides = {}) {
  return {
    reason: 'dom_event',
    roomKey: 'chat:immediate-notification',
    previewText: 'new camera question',
    customerName: '테스트 고객',
    displayTime: '오후 4:00',
    eventHash: 'immediate-notification-event-1',
    detectedAt: '2026-08-29T07:00:00.000Z',
    ...overrides
  };
}

function immediateNotificationRuntime({ ensure, store = {}, slack = {}, now, attemptGuard } = {}) {
  return createWorkOrchestratorImmediateRuntime({
    config: { immediateEnabled: true, inboxChannelId: 'CINBOX', mentionUserIds: ['UOWNER'] },
    store: {
      getNotificationByEventKey: async () => null,
      getOldestPendingNotificationCreatedAt: async () => null,
      ...store
    },
    slack: {
      postMessage: async () => ({ ok: true, channel: 'CINBOX', ts: '100.1', message: {} }),
      findMessageByClientId: async () => null,
      ...slack
    },
    slackToken: 'test-slack-token',
    ensure,
    now,
    attemptGuard
  });
}

test('immediate notification attempt guard is exact, bounded, private, and survives restart readback', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kakao-immediate-attempt-guard-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const privateKey = 'private-source-event-key-A';
  const first = createImmediateNotificationAttemptGuard({ queueDir: directory, maxEntries: 2 });

  assert.equal(first.claim(privateKey), true);
  assert.equal(first.claim(privateKey), false);
  assert.equal(first.claim('source-event-B'), true);

  const restarted = createImmediateNotificationAttemptGuard({ queueDir: directory, maxEntries: 2 });
  assert.equal(restarted.claim(privateKey), false);
  assert.equal(restarted.claim('source-event-C'), true);
  assert.equal(restarted.claim('source-event-B'), false);
  const persisted = await readFile(path.join(directory, 'immediate-notification-attempts.ndjson'), 'utf8');
  const records = persisted.trim().split('\n').map((line) => JSON.parse(line));
  assert.doesNotMatch(persisted, /private-source-event-key|source-event-B|source-event-C/);
  assert.equal(records.length, 2);
  assert.equal(records.every((record) => (
    Object.keys(record).length === 1
    && /^[0-9a-f]{64}$/.test(record.source_event_key_sha256)
  )), true);
  assert.equal((await readdir(directory)).some((name) => name.endsWith('.tmp')), false);
});

test('immediate notification attempt guard fails closed on every corrupt non-empty startup record', async (t) => {
  const privateContent = 'private-corrupt-event-content';
  const corruptRecords = [
    `{"source_event_key_sha256":"${privateContent}`,
    JSON.stringify({ source_event_key_sha256: privateContent }),
    JSON.stringify({ source_event_key_sha256: 'a'.repeat(64), unexpected: true })
  ];

  for (const [index, record] of corruptRecords.entries()) {
    const directory = await mkdtemp(path.join(tmpdir(), `kakao-immediate-attempt-corrupt-${index}-`));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await writeFile(
      path.join(directory, 'immediate-notification-attempts.ndjson'),
      `${record}\n`,
      'utf8'
    );

    assert.throws(
      () => createImmediateNotificationAttemptGuard({ queueDir: directory, maxEntries: 2 }),
      (error) => error.message === 'Immediate notification attempt guard is unavailable'
        && !error.message.includes(privateContent)
        && error.cause === undefined
    );
  }
});

test('attempt guard compaction atomically preserves the live file and memory when replacement fails', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kakao-immediate-attempt-atomic-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const livePath = path.join(directory, 'immediate-notification-attempts.ndjson');
  const seeded = createImmediateNotificationAttemptGuard({ queueDir: directory, maxEntries: 2 });
  assert.equal(seeded.claim('atomic-A'), true);
  assert.equal(seeded.claim('atomic-B'), true);
  const original = await readFile(livePath, 'utf8');
  let renameAttempts = 0;
  const failingFs = Object.create((await import('node:fs')).default);
  failingFs.renameSync = () => {
    renameAttempts += 1;
    throw new Error('private atomic replacement failure');
  };
  const guard = createImmediateNotificationAttemptGuard({
    queueDir: directory,
    maxEntries: 2,
    fileSystem: failingFs
  });

  assert.throws(
    () => guard.claim('atomic-C'),
    (error) => error.message === 'Immediate notification attempt guard is unavailable'
      && !error.message.includes('private atomic replacement failure')
  );
  assert.equal(await readFile(livePath, 'utf8'), original);
  assert.equal(guard.claim('atomic-A'), false);
  assert.equal(guard.claim('atomic-B'), false);
  assert.throws(() => guard.claim('atomic-C'), /attempt guard is unavailable/i);
  assert.equal(renameAttempts, 2, 'failed replacement must not admit the new digest into memory');
  assert.equal((await readdir(directory)).some((name) => name.endsWith('.tmp')), false);

  const restarted = createImmediateNotificationAttemptGuard({ queueDir: directory, maxEntries: 2 });
  assert.equal(restarted.claim('atomic-A'), false);
  assert.equal(restarted.claim('atomic-B'), false);
});

test('immediate notification follows acceptance, precedes legacy persistence, and gates HTTP 202', async () => {
  const callOrder = [];
  const runtime = immediateNotificationRuntime({
    ensure: async ({ event }) => {
      assert.equal(event.roomRevision, 1);
      callOrder.push('immediate-notice');
      return {
        status: 'delivered',
        receipt: { id: 'receipt-1' },
        delivery: { channel: 'CINBOX', ts: '100.1' },
        reconciled: false
      };
    }
  });
  const event = immediateNotificationEvent({ roomKey: 'chat:immediate-order' });
  const response = await postShadowEvent(event, {
    appendNdjson: () => {},
    shadowRuntime: { recordAccepted: () => null },
    immediateRuntime: runtime,
    onRoomRevisionAccepted: () => {
      callOrder.push('accept-room-revision');
    },
    writeSupabaseEvent: async () => callOrder.push('legacy-supabase-event'),
    scheduleDebouncedJob: () => callOrder.push('schedule-worker')
  });

  assert.deepEqual(callOrder, ['accept-room-revision', 'immediate-notice', 'legacy-supabase-event', 'schedule-worker']);
  assert.equal(response.status, 202);
  assert.deepEqual(response.body.immediateNotification, {
    status: 'delivered',
    duplicate: false,
    reconciled: false
  });
});

test('immediate notification responds after delivery without awaiting a slow Hermes worker promise', async () => {
  let resolveWorker;
  let workerResolved = false;
  const workerPending = new Promise((resolve) => {
    resolveWorker = () => {
      workerResolved = true;
      resolve();
    };
  });
  const runtime = immediateNotificationRuntime({
    ensure: async () => ({
      status: 'delivered', receipt: { id: 'receipt-slow' },
      delivery: { channel: 'CINBOX', ts: '101.1' }, reconciled: false
    })
  });

  try {
    const response = await Promise.race([
      postShadowEvent(immediateNotificationEvent({
        roomKey: 'chat:immediate-slow-worker',
        eventHash: 'immediate-slow-worker-1'
      }), {
        appendNdjson: () => {},
        shadowRuntime: { recordAccepted: () => null },
        immediateRuntime: runtime,
        writeSupabaseEvent: async () => ({ ok: true }),
        scheduleDebouncedJob: () => workerPending
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('HTTP response waited for Hermes')), 200))
    ]);

    assert.equal(response.status, 202);
    assert.equal(response.body.immediateNotification.status, 'delivered');
    assert.equal(workerResolved, false);
  } finally {
    resolveWorker();
    await workerPending;
  }
});

test('immediate notification failure returns typed 503 with content-free metadata and no legacy queue', async () => {
  const calls = [];
  const privateValue = 'private-customer-room-preview-token-channel';
  const maliciousEventHash = 'evt|customer=홍길동|preview=secret-message|token=xoxb-super-secret|channel=CSECRET|'
    + 'Z'.repeat(600);
  const runtime = immediateNotificationRuntime({
    ensure: async () => {
      const error = new Error(privateValue);
      error.code = privateValue;
      throw error;
    }
  });

  const response = await postShadowEvent(immediateNotificationEvent({
    roomKey: `chat:${privateValue}`,
    previewText: privateValue,
    customerName: privateValue,
    eventHash: maliciousEventHash
  }), {
    appendNdjson: (file, value) => calls.push({ file, value }),
    shadowRuntime: { recordAccepted: () => null },
    immediateRuntime: runtime,
    writeSupabaseEvent: async () => calls.push({ file: 'legacy-write' }),
    scheduleDebouncedJob: () => calls.push({ file: 'legacy-queue' })
  });

  assert.equal(response.status, 503);
  assert.deepEqual(response.body, {
    ok: false,
    error: 'immediate_notification_unconfirmed',
    eventHash: maliciousEventHash
  });
  assert.equal(calls.some(({ file }) => ['legacy-write', 'legacy-queue'].includes(file)), false);
  const failureLog = calls.find(({ file, value }) => file === 'errors.ndjson' && value.type === 'immediate_notification');
  assert.ok(failureLog);
  assert.deepEqual(Object.keys(failureLog.value).sort(), ['at', 'code', 'eventCorrelationSha256', 'type']);
  assert.equal(failureLog.value.eventCorrelationSha256, 'fb6c3ebcef1e697091ac9bd41203f918504979c64268d5ee44060340c8adb4e3');
  assert.doesNotMatch(
    JSON.stringify(failureLog),
    /private-customer|홍길동|secret-message|xoxb-super-secret|CSECRET|eventHash|roomKey|preview|customer|client|channel|token/i
  );
  assert.doesNotMatch(
    JSON.stringify(buildWorkOrchestratorHealthState(runtime.state)),
    /private-customer|홍길동|secret-message|xoxb-super-secret|CSECRET|eventHash|roomKey|preview|customer|client|channel|token/i
  );
  assert.equal(runtime.state.immediateFailed, 1);
});

test('immediate notification exact retry resumes an existing receipt, delivers once, then preserves duplicate scheduling', async () => {
  const calls = [];
  let receipt = null;
  let failFirstDeliveryClaim = true;
  const slackPosts = [];
  const exactLookups = [];
  const event = immediateNotificationEvent({
    roomKey: 'chat:immediate-exact-retry',
    eventHash: 'immediate-exact-retry-1'
  });
  const runtime = immediateNotificationRuntime({
    store: {
      claimNotificationReceipt: async (input) => {
        const created = !receipt;
        if (!receipt) {
          receipt = {
            id: 'receipt-retry',
            source_event_key: input.sourceEventKey,
            client_message_id: input.clientMessageId,
            notification_state: 'pending',
            delivery_attempts: 0,
            created_at: input.receivedAt
          };
        }
        return { created, row: { ...receipt } };
      },
      getNotificationByEventKey: async (eventKey) => {
        exactLookups.push(eventKey);
        return receipt?.source_event_key === eventKey ? { ...receipt } : null;
      },
      claimNotificationDelivery: async ({ expectedDeliveryAttempts }) => {
        if (failFirstDeliveryClaim) {
          failFirstDeliveryClaim = false;
          throw new Error('private store outage');
        }
        if (!['pending', 'failed'].includes(receipt.notification_state)
          || receipt.delivery_attempts !== expectedDeliveryAttempts) {
          return { applied: false, row: null };
        }
        receipt = {
          ...receipt,
          notification_state: 'delivering',
          delivery_attempts: receipt.delivery_attempts + 1,
          last_delivery_error: null
        };
        return { applied: true, row: { ...receipt } };
      },
      markNotificationDelivered: async ({ channelId, messageTs, deliveredAt }) => {
        if (receipt.notification_state !== 'delivering') return { applied: false, row: null };
        receipt = {
          ...receipt,
          notification_state: 'delivered',
          slack_channel_id: channelId,
          slack_message_ts: messageTs,
          delivered_at: deliveredAt
        };
        return { applied: true, row: { ...receipt } };
      },
      markNotificationFailed: async () => {
        throw new Error('not expected');
      }
    },
    slack: {
      postMessage: async (input) => {
        slackPosts.push(input);
        return { ok: true, channel: 'CINBOX', ts: '102.1', message: {} };
      },
      findMessageByClientId: async () => {
        throw new Error('not expected');
      }
    }
  });
  const dependencies = {
    appendNdjson: () => {},
    shadowRuntime: { recordAccepted: () => null },
    immediateRuntime: runtime,
    writeSupabaseEvent: async () => calls.push('legacy-supabase-event'),
    scheduleDebouncedJob: () => calls.push('schedule-worker')
  };

  const failed = await postShadowEvent(event, dependencies);
  const recovered = await postShadowEvent(event, dependencies);
  const duplicate = await postShadowEvent(event, dependencies);

  assert.equal(failed.status, 503);
  assert.equal(recovered.status, 202);
  assert.equal(duplicate.status, 202);
  assert.equal(slackPosts.length, 1);
  assert.equal(slackPosts[0].clientMsgId, receipt.client_message_id);
  assert.deepEqual(exactLookups, ['immediate-exact-retry-1', 'immediate-exact-retry-1']);
  assert.deepEqual(calls, [
    'legacy-supabase-event',
    'schedule-worker',
    'legacy-supabase-event',
    'schedule-worker'
  ]);
  assert.deepEqual({
    delivered: runtime.state.immediateDelivered,
    duplicates: runtime.state.immediateDuplicates,
    failed: runtime.state.immediateFailed
  }, { delivered: 1, duplicates: 1, failed: 1 });
});

test('immediate notification A-B-retry-A never creates a missing stale A receipt', async () => {
  const ensured = [];
  const lookups = [];
  const legacy = [];
  const receipts = new Map();
  const runtime = immediateNotificationRuntime({
    store: {
      getNotificationByEventKey: async (eventKey) => {
        lookups.push(eventKey);
        return receipts.get(eventKey) || null;
      }
    },
    ensure: async ({ event }) => {
      ensured.push(event.eventHash);
      if (event.eventHash === 'attempt-A') {
        const error = new Error('receipt store unavailable before insert');
        error.code = 'receipt_persistence_failed';
        throw error;
      }
      receipts.set(event.eventHash, { id: `receipt-${event.eventHash}` });
      return {
        status: 'delivered', receipt: receipts.get(event.eventHash),
        delivery: { channel: 'CINBOX', ts: '105.1' }, reconciled: false
      };
    }
  });
  const dependencies = {
    appendNdjson: () => {},
    shadowRuntime: { recordAccepted: () => null },
    immediateRuntime: runtime,
    writeSupabaseEvent: async (event) => legacy.push(`write:${event.eventHash}`),
    scheduleDebouncedJob: (event) => legacy.push(`schedule:${event.eventHash}`)
  };
  const base = immediateNotificationEvent({ roomKey: 'chat:attempt-a-b-a' });

  const firstA = await postShadowEvent({ ...base, previewText: 'A', eventHash: 'attempt-A' }, dependencies);
  const b = await postShadowEvent({ ...base, previewText: 'B', eventHash: 'attempt-B' }, dependencies);
  const retryA = await postShadowEvent({ ...base, previewText: 'A', eventHash: 'attempt-A' }, dependencies);

  assert.equal(firstA.status, 503);
  assert.equal(b.status, 202);
  assert.equal(retryA.status, 503);
  assert.deepEqual(ensured, ['attempt-A', 'attempt-B']);
  assert.deepEqual(lookups, ['attempt-A']);
  assert.deepEqual(legacy, ['write:attempt-B', 'schedule:attempt-B']);
});

test('handleEvent keeps oversized source identifiers distinct through immediate notice attempts', async () => {
  const attempts = [];
  const runtime = immediateNotificationRuntime({
    ensure: async ({ event }) => {
      const input = notificationReceiptInput(event);
      attempts.push({ sourceEventKey: input.sourceEventKey, clientMessageId: input.clientMessageId });
      return {
        status: 'delivered', receipt: { id: `receipt-${attempts.length}` },
        delivery: { channel: 'CINBOX', ts: `106.${attempts.length}` }, reconciled: false
      };
    }
  });
  const dependencies = {
    appendNdjson: () => {}, shadowRuntime: { recordAccepted: () => null }, immediateRuntime: runtime,
    writeSupabaseEvent: async () => {}, scheduleDebouncedJob: () => {}
  };
  const sharedPrefix = 'x'.repeat(500);
  const base = immediateNotificationEvent({ roomKey: 'chat:oversized-source-keys' });

  const first = await postShadowEvent({ ...base, previewText: 'first', eventHash: `${sharedPrefix}A` }, dependencies);
  const second = await postShadowEvent({ ...base, previewText: 'second', eventHash: `${sharedPrefix}B` }, dependencies);

  assert.equal(first.status, 202);
  assert.equal(second.status, 202);
  assert.equal(attempts.length, 2);
  assert.notEqual(attempts[0].sourceEventKey, attempts[1].sourceEventKey);
  assert.notEqual(attempts[0].clientMessageId, attempts[1].clientMessageId);
});

test('immediate notification accepts a genuinely new exact event key even when its semantic preview is unchanged', async () => {
  const ensuredHashes = [];
  const lookedUpHashes = [];
  const legacyCalls = [];
  const runtime = immediateNotificationRuntime({
    store: {
      getNotificationByEventKey: async (eventKey) => {
        lookedUpHashes.push(eventKey);
        return null;
      }
    },
    ensure: async ({ event }) => {
      ensuredHashes.push(event.eventHash);
      return {
        status: 'delivered', receipt: { id: 'receipt-first' },
        delivery: { channel: 'CINBOX', ts: '103.1' }, reconciled: false
      };
    }
  });
  const dependencies = {
    appendNdjson: () => {},
    shadowRuntime: { recordAccepted: () => null },
    immediateRuntime: runtime,
    writeSupabaseEvent: async () => legacyCalls.push('legacy-write'),
    scheduleDebouncedJob: () => legacyCalls.push('legacy-queue')
  };
  const first = immediateNotificationEvent({
    roomKey: 'chat:immediate-different-hash',
    eventHash: 'immediate-different-hash-a'
  });
  const staleDuplicate = { ...first, eventHash: 'immediate-different-hash-b' };

  await postShadowEvent(first, dependencies);
  const response = await postShadowEvent(staleDuplicate, dependencies);

  assert.equal(response.status, 202);
  assert.deepEqual(ensuredHashes, ['immediate-different-hash-a', 'immediate-different-hash-b']);
  assert.deepEqual(lookedUpHashes, []);
  assert.deepEqual(legacyCalls, ['legacy-write', 'legacy-queue', 'legacy-write', 'legacy-queue']);
  assert.equal(runtime.state.immediateFailed, 0);
});

test('immediate notification concurrent duplicate fails closed while the first exact receipt is not visible', async () => {
  let enterFirst;
  let releaseFirst;
  const firstEntered = new Promise((resolve) => { enterFirst = resolve; });
  const firstDelivery = new Promise((resolve) => { releaseFirst = resolve; });
  const exactLookups = [];
  const legacyCalls = [];
  let ensureCalls = 0;
  let slackPosts = 0;
  const runtime = immediateNotificationRuntime({
    store: {
      getNotificationByEventKey: async (eventKey) => {
        exactLookups.push(eventKey);
        return null;
      }
    },
    ensure: async () => {
      ensureCalls += 1;
      enterFirst();
      await firstDelivery;
      slackPosts += 1;
      return {
        status: 'delivered', receipt: { id: 'receipt-concurrent-first' },
        delivery: { channel: 'CINBOX', ts: '104.1' }, reconciled: false
      };
    }
  });
  const event = immediateNotificationEvent({
    roomKey: 'chat:immediate-concurrent-visibility',
    eventHash: 'immediate-concurrent-visibility-1'
  });
  const dependencies = {
    appendNdjson: () => {},
    shadowRuntime: { recordAccepted: () => null },
    immediateRuntime: runtime,
    writeSupabaseEvent: async () => legacyCalls.push('legacy-write'),
    scheduleDebouncedJob: () => legacyCalls.push('legacy-queue')
  };

  const firstResponsePromise = postShadowEvent(event, dependencies);
  await firstEntered;
  const concurrentResponse = await postShadowEvent(event, dependencies);
  releaseFirst();
  const firstResponse = await firstResponsePromise;

  assert.equal(concurrentResponse.status, 503);
  assert.equal(firstResponse.status, 202);
  assert.equal(ensureCalls, 1);
  assert.equal(slackPosts, 1);
  assert.deepEqual(exactLookups, ['immediate-concurrent-visibility-1']);
  assert.deepEqual(legacyCalls, ['legacy-write', 'legacy-queue']);
});

test('immediate notification gate rejects every non-delivered runtime result before legacy work', async () => {
  const outcomes = [undefined, null, {}, { status: 'skipped' }, { status: 'busy' }, { status: 'unconfirmed' }];
  for (const [index, outcome] of outcomes.entries()) {
    const legacyCalls = [];
    const eventHash = `immediate-unconfirmed-result-${index}`;
    const response = await postShadowEvent(immediateNotificationEvent({
      roomKey: `chat:immediate-unconfirmed-result-${index}`,
      eventHash
    }), {
      appendNdjson: () => {},
      shadowRuntime: { recordAccepted: () => null },
      immediateRuntime: { enabled: true, deliverAccepted: async () => outcome },
      writeSupabaseEvent: async () => legacyCalls.push('legacy-write'),
      scheduleDebouncedJob: () => legacyCalls.push('legacy-queue')
    });

    assert.equal(response.status, 503);
    assert.equal(response.body.error, 'immediate_notification_unconfirmed');
    assert.equal(response.body.eventHash, eventHash);
    assert.deepEqual(legacyCalls, []);
  }
});

test('immediate notification OFF makes zero store or Slack calls and preserves legacy duplicate behavior', async () => {
  const calls = [];
  const runtime = createWorkOrchestratorImmediateRuntime({
    config: { immediateEnabled: false },
    store: new Proxy({}, { get: () => () => { throw new Error('store must not be called'); } }),
    slack: new Proxy({}, { get: () => () => { throw new Error('Slack must not be called'); } }),
    ensure: async () => { throw new Error('immediate ensure must not be called'); }
  });
  const event = immediateNotificationEvent({
    roomKey: 'chat:immediate-off',
    eventHash: 'immediate-off-1'
  });
  const dependencies = {
    appendNdjson: () => {},
    shadowRuntime: { recordAccepted: (_, roomVersion) => calls.push(`shadow:${roomVersion.changed}`) },
    immediateRuntime: runtime,
    writeSupabaseEvent: async () => calls.push('legacy-write'),
    scheduleDebouncedJob: () => calls.push('legacy-queue')
  };

  const first = await postShadowEvent(event, dependencies);
  const duplicate = await postShadowEvent(event, dependencies);

  assert.deepEqual(first.body, { ok: true, roomKey: 'chat:immediate-off', eventHash: 'immediate-off-1' });
  assert.deepEqual(duplicate.body, first.body);
  assert.deepEqual(calls, ['shadow:true', 'legacy-write', 'legacy-queue', 'legacy-write', 'legacy-queue']);
});

test('immediate notification startup is locally fail-closed and performs no network at construction', () => {
  const store = {
    getNotificationByEventKey: async () => null,
    getOldestPendingNotificationCreatedAt: async () => null
  };
  const slack = {
    postMessage: async () => { throw new Error('not called'); },
    findMessageByClientId: async () => { throw new Error('not called'); }
  };
  const enabled = { immediateEnabled: true, inboxChannelId: 'CINBOX' };

  assert.throws(() => createWorkOrchestratorImmediateRuntime({ config: enabled, store, slack, slackToken: '' }), /local configuration is missing/i);
  assert.throws(() => createWorkOrchestratorImmediateRuntime({ config: enabled, store: null, slack, slackToken: 'test' }), /local configuration is missing/i);
  assert.throws(() => createWorkOrchestratorImmediateRuntime({ config: { ...enabled, inboxChannelId: '' }, store, slack, slackToken: 'test' }), /local configuration is missing/i);
  assert.throws(() => createWorkOrchestratorImmediateRuntime({ config: enabled, store, slack: null, slackToken: 'test' }), /local configuration is missing/i);

  const runtime = immediateNotificationRuntime({
    ensure: async () => { throw new Error('not called'); }
  });
  assert.equal(runtime.localConfigReady, true);
  assert.equal(runtime.state.immediateDelivered, 0);
  assert.equal(runtime.state.immediateBacklogReadback, 'not_checked');
});

test('immediate notification health uses durable backlog age and fails content-free on query errors', async () => {
  const privateValue = 'private-backlog-customer-room-token-channel';
  const runtime = immediateNotificationRuntime({
    ensure: async () => { throw new Error('not called'); },
    store: {
      getOldestPendingNotificationCreatedAt: async () => '2026-08-29T06:59:30.000Z'
    },
    now: () => new Date('2026-08-29T07:00:00.000Z')
  });
  await runtime.refreshBacklogHealth();
  assert.deepEqual(buildWorkOrchestratorHealthState(runtime.state), {
    shadowClaims: 0,
    shadowDuplicates: 0,
    shadowErrors: 0,
    lastShadowReceipt: null,
    immediateDelivered: 0,
    immediateDuplicates: 0,
    immediateFailed: 0,
    oldestPendingNotificationAgeMs: 30_000,
    immediateBacklogReadback: 'ok'
  });

  runtime.store.getOldestPendingNotificationCreatedAt = async () => { throw new Error(privateValue); };
  await runtime.refreshBacklogHealth();
  const health = {
    config: buildHealthConfig({
      workOrchestrator: { immediateEnabled: true },
      workOrchestratorImmediateLocalConfigReady: true
    }).workOrchestrator,
    state: buildWorkOrchestratorHealthState({
      ...runtime.state,
      payload: privateValue,
      roomKey: privateValue,
      channelId: privateValue,
      token: privateValue
    })
  };
  assert.equal(health.config.immediateEnabled, true);
  assert.equal(health.config.immediateLocalConfigReady, true);
  assert.equal(health.state.oldestPendingNotificationAgeMs, null);
  assert.equal(health.state.immediateBacklogReadback, 'error');
  assert.doesNotMatch(JSON.stringify(health), new RegExp(privateValue));
});

test('Work Orchestrator shadow starts after revision acceptance and does not block the legacy queue', async () => {
  const calls = [];
  let settleShadow;
  const shadowPending = new Promise((resolve) => { settleShadow = resolve; });
  const shadowRuntime = {
    recordAccepted(event, roomVersion) {
      calls.push(`shadow:${event.roomRevision}:${roomVersion.changed}`);
      return shadowPending;
    }
  };

  const response = await postShadowEvent({
    reason: 'dom_event',
    roomKey: 'chat:work-orchestrator-order',
    previewText: 'new camera question',
    displayTime: '오후 1:00',
    eventHash: 'work-orchestrator-order-1',
    detectedAt: '2026-08-29T04:00:00.000Z'
  }, {
    appendNdjson: () => {},
    shadowRuntime,
    writeSupabaseEvent: async () => calls.push('legacy-write'),
    scheduleDebouncedJob: () => calls.push('legacy-queue')
  });

  assert.equal(response.status, 202);
  assert.deepEqual(calls, ['shadow:1:true', 'legacy-write', 'legacy-queue']);
  settleShadow({ created: true });
  await shadowPending;
});

test('Work Orchestrator shadow failure increments bounded health state and still queues legacy work', async () => {
  const calls = [];
  const privateValue = 'private-customer-payload';
  const runtime = createWorkOrchestratorShadowRuntime({
    config: { shadowWrites: true },
    store: { claimNotificationReceipt: async () => { throw new Error(privateValue); } },
    now: () => '2026-08-29T04:00:01.000Z'
  });

  const response = await postShadowEvent({
    reason: 'dom_event',
    roomKey: 'chat:work-orchestrator-failure',
    previewText: privateValue,
    eventHash: 'work-orchestrator-failure-1',
    detectedAt: '2026-08-29T04:00:00.000Z'
  }, {
    appendNdjson: () => {},
    shadowRuntime: runtime,
    writeSupabaseEvent: async () => calls.push('legacy-write'),
    scheduleDebouncedJob: () => calls.push('legacy-queue')
  });

  assert.equal(response.status, 202);
  assert.deepEqual(calls, ['legacy-write', 'legacy-queue']);
  await runtime.settled();
  assert.deepEqual(buildWorkOrchestratorHealthState(runtime.state), {
    shadowClaims: 0,
    shadowDuplicates: 0,
    shadowErrors: 1,
    lastShadowReceipt: {
      at: '2026-08-29T04:00:01.000Z',
      outcome: 'error',
      error: 'shadow_receipt_store_failed'
    },
    immediateDelivered: 0,
    immediateDuplicates: 0,
    immediateFailed: 0,
    oldestPendingNotificationAgeMs: null,
    immediateBacklogReadback: 'disabled'
  });
  assert.doesNotMatch(JSON.stringify(buildWorkOrchestratorHealthState(runtime.state)), /private-customer-payload/);
});

test('Work Orchestrator shadow skips a rejected duplicate revision without suppressing legacy scheduling', async () => {
  const calls = [];
  const runtime = createWorkOrchestratorShadowRuntime({
    config: { shadowWrites: true },
    store: {
      async claimNotificationReceipt() {
        calls.push('shadow');
        return { created: false, row: { id: 'private-row-id' } };
      }
    },
    now: () => '2026-08-29T04:02:01.000Z'
  });
  const event = {
    reason: 'dom_event', roomKey: 'chat:work-orchestrator-duplicate',
    previewText: 'same semantic event', displayTime: '오후 1:02',
    eventHash: 'work-orchestrator-duplicate-1', detectedAt: '2026-08-29T04:02:00.000Z'
  };
  const dependencies = {
    appendNdjson: () => {}, shadowRuntime: runtime,
    writeSupabaseEvent: async () => calls.push('legacy-write'),
    scheduleDebouncedJob: () => calls.push('legacy-queue')
  };

  await postShadowEvent(event, dependencies);
  await postShadowEvent(event, dependencies);
  await runtime.settled();

  assert.deepEqual(calls, ['shadow', 'legacy-write', 'legacy-queue', 'legacy-write', 'legacy-queue']);
  assert.deepEqual(buildWorkOrchestratorHealthState(runtime.state), {
    shadowClaims: 0,
    shadowDuplicates: 1,
    shadowErrors: 0,
    lastShadowReceipt: {
      at: '2026-08-29T04:02:01.000Z',
      outcome: 'duplicate'
    },
    immediateDelivered: 0,
    immediateDuplicates: 0,
    immediateFailed: 0,
    oldestPendingNotificationAgeMs: null,
    immediateBacklogReadback: 'disabled'
  });
  assert.doesNotMatch(JSON.stringify(runtime.state.lastShadowReceipt), /private-row-id/);
});

test('Work Orchestrator shadow health exposes only flags, readiness, counters, timestamps, and generic errors', () => {
  const configHealth = buildHealthConfig({
    workOrchestrator: {
      shadowWrites: true,
      immediateEnabled: false,
      workItemsEnabled: false,
      p0ReadbackEnabled: false,
      p0CutoverEnabled: false,
      digestEnabled: false,
      cleanupEnabled: false
    },
    workOrchestratorStoreConfigured: false,
    workOrchestratorShadowReady: false
  });
  const runtime = createWorkOrchestratorShadowRuntime({
    config: { shadowWrites: true },
    store: null,
    now: () => '2026-08-29T04:00:00.000Z'
  });
  const health = {
    config: configHealth.workOrchestrator,
    state: buildWorkOrchestratorHealthState(runtime.state)
  };

  assert.deepEqual(health, {
    config: {
      shadowWrites: true,
      immediateEnabled: false,
      workItemsEnabled: false,
      p0ReadbackEnabled: false,
      p0CutoverEnabled: false,
      digestEnabled: false,
      cleanupEnabled: false,
      storeConfigured: false,
      shadowReady: false,
      immediateLocalConfigReady: false
    },
    state: {
      shadowClaims: 0,
      shadowDuplicates: 0,
      shadowErrors: 1,
      lastShadowReceipt: {
        at: '2026-08-29T04:00:00.000Z',
        outcome: 'configuration_error',
        error: 'shadow_store_unavailable'
      },
      immediateDelivered: 0,
      immediateDuplicates: 0,
      immediateFailed: 0,
      oldestPendingNotificationAgeMs: null,
      immediateBacklogReadback: 'disabled'
    }
  });
  assert.doesNotMatch(
    JSON.stringify(health),
    /sourceEventKey|roomKey|preview|customer|payload|supabase\.co|service-role|private-row-id/i
  );
});

test('Work Orchestrator shadow health fails closed on arbitrary internal receipt metadata', () => {
  const privateValue = 'private-customer-payload';

  const health = buildWorkOrchestratorHealthState({
    shadowClaims: 1,
    shadowDuplicates: 2,
    shadowErrors: 3,
    lastShadowReceipt: {
      at: privateValue,
      outcome: privateValue,
      error: privateValue,
      row: { sourceEventKey: privateValue, roomKey: privateValue }
    }
  });

  assert.deepEqual(health, {
    shadowClaims: 1,
    shadowDuplicates: 2,
    shadowErrors: 3,
    lastShadowReceipt: {
      at: '',
      outcome: 'error',
      error: 'shadow_receipt_failed'
    },
    immediateDelivered: 0,
    immediateDuplicates: 0,
    immediateFailed: 0,
    oldestPendingNotificationAgeMs: null,
    immediateBacklogReadback: 'disabled'
  });
  assert.doesNotMatch(JSON.stringify(health), /private-customer-payload|sourceEventKey|roomKey/);
});

function digestStoreStub() {
  return Object.fromEntries([
    'claimDivergentDigestRun', 'claimDigestRun', 'listActionableWork', 'prepareDigestParts', 'claimDigestPartDelivery',
    'markDigestPartDelivered', 'markDigestPartFailed', 'finalizeDigestRun', 'failDigestRun',
    'markDigestGenerationDiverged',
    'listDigestCleanupBacklog', 'claimDigestPartCleanup', 'recordDigestPartCleanup'
  ].map((name) => [name, () => {}]));
}

test('digest runtime is default-off and creates no timer or runner work while disabled', async () => {
  assert.equal(typeof createWorkOrchestratorDigestRuntime, 'function');
  let timers = 0;
  let runs = 0;
  const runtime = createWorkOrchestratorDigestRuntime({
    config: { digestEnabled: false },
    run: async () => { runs += 1; },
    setIntervalImpl: () => { timers += 1; }
  });
  assert.equal(runtime.enabled, false);
  assert.equal(runtime.localConfigReady, false);
  assert.deepEqual(await runtime.start(), { status: 'disabled' });
  assert.deepEqual(await runtime.runNow('manual'), { status: 'disabled' });
  assert.equal(timers, 0);
  assert.equal(runs, 0);
});

test('enabled digest runtime requires local store, Slack client, and one exact channel', () => {
  const missingRecoveryClaim = digestStoreStub();
  delete missingRecoveryClaim.claimDivergentDigestRun;
  for (const input of [
    { config: { digestEnabled: true, digestChannelId: 'CFOCUS' } },
    { config: { digestEnabled: true, digestChannelId: 'CFOCUS' }, store: {} },
    { config: { digestEnabled: true, digestChannelId: '' }, store: {}, slack: {} },
    {
      config: { digestEnabled: true, digestChannelId: 'CFOCUS' },
      store: missingRecoveryClaim,
      slack: { postMessage() {}, findMessageByClientId() {}, deleteMessage() {} }
    }
  ]) {
    assert.throws(
      () => createWorkOrchestratorDigestRuntime(input),
      { message: 'Work Orchestrator digest local configuration is missing' }
    );
  }
});

test('digest startup catches up only the latest boundary and checks once per minute', async () => {
  let currentNow = '2026-08-29T08:50:00.000Z';
  const intervals = [];
  const calls = [];
  const runtime = createWorkOrchestratorDigestRuntime({
    config: {
      digestEnabled: true,
      digestChannelId: 'CFOCUS',
      digestIntervalMinutes: 180,
      cleanupEnabled: false
    },
    store: digestStoreStub(),
    slack: { postMessage() {}, findMessageByClientId() {}, deleteMessage() {} },
    now: () => currentNow,
    leaseOwner: 'bridge:test',
    run: async (input) => {
      calls.push(input);
      return {
        status: 'delivered', scheduledAt: input.now === '2026-08-29T08:50:00.000Z'
          ? '2026-08-29T06:00:00.000Z'
          : '2026-08-29T09:00:00.000Z',
        runId: '10000000-0000-4000-8000-000000000001',
        selectedCount: 2, renderedCount: 2, omittedEligibleCount: 0,
        partCount: 1, deliveredPartCount: 1,
        cleanup: { attempted: 0, settled: 0, failed: 0 }
      };
    },
    setIntervalImpl(callback, milliseconds) {
      intervals.push({ callback, milliseconds });
      return { timer: true };
    },
    clearIntervalImpl() {}
  });

  assert.deepEqual(await runtime.start(), {
    status: 'delivered', scheduledAt: '2026-08-29T06:00:00.000Z',
    runId: '10000000-0000-4000-8000-000000000001',
    selectedCount: 2, renderedCount: 2, omittedEligibleCount: 0,
    partCount: 1, deliveredPartCount: 1,
    cleanup: { attempted: 0, settled: 0, failed: 0 }
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].now, '2026-08-29T08:50:00.000Z');
  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].milliseconds, 60_000);
  assert.equal(runtime.state.nextScheduledAt, '2026-08-29T09:00:00.000Z');

  currentNow = '2026-08-29T08:59:59.000Z';
  await intervals[0].callback();
  assert.equal(calls.length, 1);
  currentNow = '2026-08-29T09:00:00.000Z';
  await intervals[0].callback();
  assert.equal(calls.length, 2);
  assert.equal(runtime.state.nextScheduledAt, '2026-08-29T12:00:00.000Z');
});

test('minute checks retry failed cleanup on the same delivered boundary', async () => {
  let currentNow = '2026-08-29T06:01:00.000Z';
  let callback;
  let runs = 0;
  const runtime = createWorkOrchestratorDigestRuntime({
    config: { digestEnabled: true, digestChannelId: 'CFOCUS', cleanupEnabled: true },
    store: digestStoreStub(),
    slack: { postMessage() {}, findMessageByClientId() {}, deleteMessage() {} },
    now: () => currentNow,
    run: async () => {
      runs += 1;
      return {
        status: runs === 1 ? 'delivered' : 'not_claimed',
        scheduledAt: '2026-08-29T06:00:00.000Z',
        runId: '10000000-0000-4000-8000-000000000001',
        selectedCount: 1, renderedCount: 1, omittedEligibleCount: 0,
        partCount: 1, deliveredPartCount: 1,
        cleanup: runs === 1
          ? { attempted: 1, settled: 0, failed: 1 }
          : { attempted: 1, settled: 1, failed: 0 }
      };
    },
    setIntervalImpl(fn) { callback = fn; return {}; }
  });
  await runtime.start();
  assert.equal(runtime.state.lastDigestRun.cleanupFailed, 1);
  currentNow = '2026-08-29T06:02:00.000Z';
  await callback();
  assert.equal(runs, 2);
  assert.equal(runtime.state.lastDigestRun.cleanupFailed, 0);
});

test('minute checks retry an unfinished not-claimed run after its database lease can expire', async () => {
  let callback;
  let runs = 0;
  let currentNow = '2026-08-29T06:01:00.000Z';
  const seenNow = [];
  const runtime = createWorkOrchestratorDigestRuntime({
    config: { digestEnabled: true, digestChannelId: 'CFOCUS' },
    store: digestStoreStub(),
    slack: { postMessage() {}, findMessageByClientId() {}, deleteMessage() {} },
    now: () => currentNow,
    run: async (input) => {
      runs += 1;
      seenNow.push(input.now);
      return {
        status: runs < 3 ? 'not_claimed' : 'delivered',
        scheduledAt: '2026-08-29T06:00:00.000Z',
        runId: '10000000-0000-4000-8000-000000000001',
        selectedCount: 0, renderedCount: 0, omittedEligibleCount: 0,
        partCount: 0, deliveredPartCount: 0,
        cleanup: { attempted: 0, settled: 0, failed: 0 },
        retryable: runs < 3
      };
    },
    setIntervalImpl(fn) { callback = fn; return {}; }
  });
  const first = await runtime.start();
  assert.equal(first.retryable, true);
  currentNow = '2026-08-29T06:02:00.000Z';
  await callback();
  assert.equal(runs, 2, 'one minute check makes only one fenced attempt before lease expiry');
  assert.equal(runtime.state.lastDigestRun.retryable, true);
  currentNow = '2026-08-29T06:03:00.000Z';
  await callback();
  assert.equal(runs, 3);
  assert.equal(runtime.state.lastDigestRun.status, 'delivered');
  assert.deepEqual(seenNow, [
    '2026-08-29T06:01:00.000Z',
    '2026-08-29T06:02:00.000Z',
    '2026-08-29T06:03:00.000Z'
  ]);
});

test('minute checks respect a durable delivery Retry-After without burning an in-cycle attempt', async () => {
  let callback;
  let currentNow = '2026-08-29T06:25:00.000Z';
  let actualAttempts = 0;
  const clientMessageId = '10000000-0000-4000-8000-000000000011';
  const observations = [];
  const runtime = createWorkOrchestratorDigestRuntime({
    config: { digestEnabled: true, digestChannelId: 'CFOCUS' },
    store: digestStoreStub(),
    slack: { postMessage() {}, findMessageByClientId() {}, deleteMessage() {} },
    now: () => currentNow,
    run: async ({ now }) => {
      const due = Date.parse(now) >= Date.parse('2026-08-29T06:30:00.000Z');
      if (now === '2026-08-29T06:25:00.000Z' || due) actualAttempts += 1;
      observations.push({ now, actualAttempts, clientMessageId });
      return {
        status: due ? 'delivered' : 'failed',
        error: due ? undefined : 'digest_delivery_failed',
        retryable: !due,
        scheduledAt: '2026-08-29T06:00:00.000Z',
        runId: '10000000-0000-4000-8000-000000000001',
        selectedCount: 1, renderedCount: 1, omittedEligibleCount: 0,
        partCount: 1, deliveredPartCount: due ? 1 : 0,
        cleanup: { attempted: 0, settled: 0, failed: 0 }
      };
    },
    setIntervalImpl(fn) { callback = fn; return {}; }
  });

  await runtime.start();
  assert.equal(actualAttempts, 1);
  currentNow = '2026-08-29T06:26:00.000Z';
  await callback();
  assert.equal(actualAttempts, 1, 'a pre-due minute check does not represent another transport attempt');
  currentNow = '2026-08-29T06:30:00.000Z';
  await callback();
  assert.equal(actualAttempts, 2);
  assert.equal(runtime.state.lastDigestRun.status, 'delivered');
  assert.deepEqual(new Set(observations.map((entry) => entry.clientMessageId)), new Set([clientMessageId]));
});

test('cleanup-enabled minute checks sweep durable backlog even after a successful same-boundary run', async () => {
  let callback;
  let runs = 0;
  let currentNow = '2026-08-29T06:01:00.000Z';
  const runtime = createWorkOrchestratorDigestRuntime({
    config: { digestEnabled: true, digestChannelId: 'CFOCUS', cleanupEnabled: true },
    store: digestStoreStub(),
    slack: { postMessage() {}, findMessageByClientId() {}, deleteMessage() {} },
    now: () => currentNow,
    run: async () => {
      runs += 1;
      return {
        status: runs === 1 ? 'delivered' : 'not_claimed',
        scheduledAt: '2026-08-29T06:00:00.000Z',
        runId: '10000000-0000-4000-8000-000000000001',
        selectedCount: 0, renderedCount: 0, omittedEligibleCount: 0,
        partCount: 0, deliveredPartCount: 0,
        cleanup: runs === 1
          ? { attempted: 0, settled: 0, failed: 0 }
          : { attempted: 1, settled: 1, failed: 0 }
      };
    },
    setIntervalImpl(fn) { callback = fn; return {}; }
  });
  await runtime.start();
  currentNow = '2026-08-29T06:02:00.000Z';
  const swept = await callback();
  assert.equal(runs, 2);
  assert.deepEqual(swept.cleanup, { attempted: 1, settled: 1, failed: 0 });
  assert.equal(runtime.state.nextScheduledAt, '2026-08-29T09:00:00.000Z');
});

test('cleanup backlog is picked up when cleanup turns on after a same-boundary restart', async () => {
  let currentNow = '2026-08-29T06:01:00.000Z';
  let disabledRuns = 0;
  const off = createWorkOrchestratorDigestRuntime({
    config: { digestEnabled: true, digestChannelId: 'CFOCUS', cleanupEnabled: false },
    store: digestStoreStub(),
    slack: { postMessage() {}, findMessageByClientId() {}, deleteMessage() {} },
    now: () => currentNow,
    run: async () => {
      disabledRuns += 1;
      return {
        status: 'delivered', scheduledAt: '2026-08-29T06:00:00.000Z',
        runId: '10000000-0000-4000-8000-000000000001',
        selectedCount: 0, renderedCount: 0, omittedEligibleCount: 0,
        partCount: 0, deliveredPartCount: 0,
        cleanup: { attempted: 0, settled: 0, failed: 0 }
      };
    },
    setIntervalImpl: () => ({})
  });
  await off.start();
  off.stop();

  currentNow = '2026-08-29T06:02:00.000Z';
  let enabledRuns = 0;
  const on = createWorkOrchestratorDigestRuntime({
    config: { digestEnabled: true, digestChannelId: 'CFOCUS', cleanupEnabled: true },
    store: digestStoreStub(),
    slack: { postMessage() {}, findMessageByClientId() {}, deleteMessage() {} },
    now: () => currentNow,
    run: async () => {
      enabledRuns += 1;
      return {
        status: 'not_claimed', scheduledAt: '2026-08-29T06:00:00.000Z',
        runId: '10000000-0000-4000-8000-000000000001',
        selectedCount: 0, renderedCount: 0, omittedEligibleCount: 0,
        partCount: 0, deliveredPartCount: 0,
        cleanup: { attempted: 1, settled: 1, failed: 0 }
      };
    },
    setIntervalImpl: () => ({})
  });
  const swept = await on.start();
  assert.equal(disabledRuns, 1);
  assert.equal(enabledRuns, 1);
  assert.deepEqual(swept.cleanup, { attempted: 1, settled: 1, failed: 0 });
});

test('digest health is content-free, finite, and derives exact omission without guessing beyond 500', async () => {
  const privateValue = 'private-customer-room-message-token';
  let fail = false;
  const sharedState = {};
  const runtime = createWorkOrchestratorDigestRuntime({
    config: { digestEnabled: true, digestChannelId: 'CFOCUS', digestIntervalMinutes: 180 },
    store: digestStoreStub(),
    slack: { postMessage() {}, findMessageByClientId() {}, deleteMessage() {} },
    state: sharedState,
    now: () => fail ? '2026-08-29T09:01:00.000Z' : '2026-08-29T06:01:00.000Z',
    run: async () => {
      if (fail) throw new Error(privateValue);
      return {
        status: 'delivered', scheduledAt: '2026-08-29T06:00:00.000Z',
        runId: '10000000-0000-4000-8000-000000000001',
        selectedCount: 500, renderedCount: 500, omittedEligibleCount: 999,
        partCount: 42, deliveredPartCount: 42,
        cleanup: { attempted: 2, settled: 2, failed: 0 },
        payload: privateValue
      };
    },
    setIntervalImpl: () => ({})
  });
  await runtime.runNow('manual');
  let health = buildWorkOrchestratorHealthState({ ...sharedState, payload: privateValue, token: privateValue });
  assert.equal(health.digestFailureCount, 0);
  assert.equal(health.omittedEligibleCount, 0);
  assert.equal(health.lastDigestSuccessAt, '2026-08-29T06:01:00.000Z');
  assert.equal(health.nextScheduledAt, '2026-08-29T09:00:00.000Z');
  assert.doesNotMatch(JSON.stringify(health), new RegExp(privateValue));

  fail = true;
  await runtime.runNow('manual');
  health = buildWorkOrchestratorHealthState(sharedState);
  assert.equal(health.digestFailureCount, 1);
  assert.equal(health.lastDigestFailureAt, '2026-08-29T09:01:00.000Z');
  assert.equal(health.lastDigestRun.error, 'digest_cycle_failed');
  assert.doesNotMatch(JSON.stringify(health), new RegExp(privateValue));
});

test('digest runtime preserves authoritative 501 overflow evidence and its finite typed health error', async () => {
  const sharedState = {};
  const runtime = createWorkOrchestratorDigestRuntime({
    config: { digestEnabled: true, digestChannelId: 'CFOCUS', digestIntervalMinutes: 180 },
    store: digestStoreStub(),
    slack: { postMessage() {}, findMessageByClientId() {}, deleteMessage() {} },
    state: sharedState,
    now: () => '2026-08-29T06:01:00.000Z',
    run: async () => ({
      status: 'failed', error: 'digest_eligible_overflow', retryable: true,
      scheduledAt: '2026-08-29T06:00:00.000Z',
      runId: '10000000-0000-4000-8000-000000000001',
      selectedCount: 501, renderedCount: 0, omittedEligibleCount: 501,
      partCount: 0, deliveredPartCount: 0,
      cleanup: { attempted: 0, settled: 0, failed: 0 }
    }),
    setIntervalImpl: () => ({})
  });

  const result = await runtime.runNow('manual');
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'digest_eligible_overflow');
  assert.equal(result.selectedCount, 501);
  assert.equal(result.omittedEligibleCount, 501);
  const health = buildWorkOrchestratorHealthState(sharedState);
  assert.equal(health.lastDigestRun.error, 'digest_eligible_overflow');
  assert.equal(health.lastDigestRun.selectedCount, 501);
  assert.equal(health.omittedEligibleCount, 501);
});

test('digest runtime, maintenance, and health preserve only successor-first generation errors', async () => {
  const scheduledAt = '2026-08-29T06:00:00.000Z';
  const failedResult = (error) => ({
    status: 'failed', error, retryable: true, scheduledAt,
    runId: '10000000-0000-4000-8000-000000000001',
    selectedCount: 1, renderedCount: 1, omittedEligibleCount: 0,
    partCount: 1, deliveredPartCount: 1,
    cleanup: { attempted: 0, settled: 0, failed: 0 }
  });

  for (const error of ['digest_generation_diverged', 'digest_generation_handoff_failed']) {
    const sharedState = {};
    const runtime = createWorkOrchestratorDigestRuntime({
      config: { digestEnabled: true, digestChannelId: 'CFOCUS' },
      store: digestStoreStub(),
      slack: { postMessage() {}, findMessageByClientId() {}, deleteMessage() {} },
      state: sharedState,
      now: () => '2026-08-29T06:01:00.000Z',
      run: async () => failedResult(error),
      setIntervalImpl: () => ({})
    });
    const result = await runtime.runNow('manual');
    assert.equal(result.error, error);
    assert.equal(buildWorkOrchestratorHealthState(sharedState).lastDigestRun.error, error);
    const maintenance = await handleWorkOrchestratorDigestMaintenance({
      runNow: async () => failedResult(error)
    });
    assert.equal(maintenance.body.result.error, error);
  }

  for (const retiredError of ['digest_generation_cleanup_failed', 'digest_generation_retired']) {
    const health = buildWorkOrchestratorHealthState({
      lastDigestRun: {
        at: '2026-08-29T06:01:00.000Z', trigger: 'manual', status: 'failed',
        scheduledAt, error: retiredError
      }
    });
    assert.equal(health.lastDigestRun.error, 'digest_cycle_failed');
    const maintenance = await handleWorkOrchestratorDigestMaintenance({
      runNow: async () => failedResult(retiredError)
    });
    assert.equal(maintenance.body.result.error, 'digest_cycle_failed');
  }
});

test('maintenance digest handler uses the injectable runtime and returns finite status only', async () => {
  assert.equal(typeof handleWorkOrchestratorDigestMaintenance, 'function');
  const response = await handleWorkOrchestratorDigestMaintenance({
    runNow: async (trigger) => ({
      status: 'not_claimed', scheduledAt: '2026-08-29T06:00:00.000Z',
      runId: '10000000-0000-4000-8000-000000000001', trigger
    })
  });
  assert.deepEqual(response, {
    statusCode: 200,
    body: {
      ok: true,
      result: {
        status: 'not_claimed', scheduledAt: '2026-08-29T06:00:00.000Z',
        runId: '10000000-0000-4000-8000-000000000001', trigger: 'manual'
      }
    }
  });
});

test('digest runtime, maintenance, and health preserve bounded cleanup counts through 500', async () => {
  for (const cleanupCount of [51, 500]) {
    const sharedState = {};
    const runtime = createWorkOrchestratorDigestRuntime({
      config: { digestEnabled: true, digestChannelId: 'CFOCUS', cleanupEnabled: true },
      store: digestStoreStub(),
      slack: { postMessage() {}, findMessageByClientId() {}, deleteMessage() {} },
      state: sharedState,
      now: () => '2026-08-29T06:01:00.000Z',
      run: async () => ({
        status: 'delivered', scheduledAt: '2026-08-29T06:00:00.000Z',
        runId: '10000000-0000-4000-8000-000000000001',
        selectedCount: 0, renderedCount: 0, omittedEligibleCount: 0,
        partCount: 0, deliveredPartCount: 0,
        cleanup: { attempted: cleanupCount, settled: cleanupCount, failed: 0 }
      }),
      setIntervalImpl: () => ({})
    });
    const result = await runtime.runNow('manual');
    assert.deepEqual(result.cleanup, { attempted: cleanupCount, settled: cleanupCount, failed: 0 });

    const maintenance = await handleWorkOrchestratorDigestMaintenance({
      runNow: async () => result
    });
    assert.equal(maintenance.statusCode, 200);
    assert.deepEqual(maintenance.body.result.cleanup, result.cleanup);

    sharedState.lastDigestRun.cleanupFailed = cleanupCount;
    assert.equal(buildWorkOrchestratorHealthState(sharedState).lastDigestRun.cleanupFailed, cleanupCount);
  }
});

test('digest cleanup counts above 500 or malformed are rejected without leaking private fields', async () => {
  const privateValue = 'private-cleanup-token';
  for (const attempted of [501, '51', Number.NaN]) {
    const runtime = createWorkOrchestratorDigestRuntime({
      config: { digestEnabled: true, digestChannelId: 'CFOCUS', cleanupEnabled: true },
      store: digestStoreStub(),
      slack: { postMessage() {}, findMessageByClientId() {}, deleteMessage() {} },
      now: () => '2026-08-29T06:01:00.000Z',
      run: async () => ({
        status: 'delivered', scheduledAt: '2026-08-29T06:00:00.000Z',
        runId: '10000000-0000-4000-8000-000000000001',
        selectedCount: 0, renderedCount: 0, omittedEligibleCount: 0,
        partCount: 0, deliveredPartCount: 0,
        cleanup: { attempted, settled: 0, failed: 0 },
        token: privateValue
      }),
      setIntervalImpl: () => ({})
    });
    const result = await runtime.runNow('manual');
    assert.equal(result.status, 'failed');
    assert.equal(result.error, 'digest_cycle_failed');
    assert.doesNotMatch(JSON.stringify(result), new RegExp(privateValue));

    const maintenance = await handleWorkOrchestratorDigestMaintenance({
      runNow: async () => ({
        status: 'delivered', cleanup: { attempted, settled: 0, failed: 0 }, token: privateValue
      })
    });
    assert.equal(maintenance.statusCode, 502);
    assert.deepEqual(maintenance.body, {
      ok: false, result: { status: 'failed', error: 'digest_cycle_failed' }
    });
    assert.doesNotMatch(JSON.stringify(maintenance), new RegExp(privateValue));
  }

  for (const cleanupFailed of [501, '51', Number.NaN]) {
    const health = buildWorkOrchestratorHealthState({
      lastDigestRun: {
        at: '2026-08-29T06:01:00.000Z', trigger: 'manual', status: 'delivered',
        scheduledAt: '2026-08-29T06:00:00.000Z', cleanupFailed
      }
    });
    assert.equal(health.lastDigestRun.cleanupFailed, 0);
  }
});

test('digest runtime work is independent from immediate notification delivery ordering', async () => {
  let releaseDigest;
  const pendingDigest = new Promise((resolve) => { releaseDigest = resolve; });
  const order = [];
  const digest = createWorkOrchestratorDigestRuntime({
    config: { digestEnabled: true, digestChannelId: 'CFOCUS' },
    store: digestStoreStub(),
    slack: { postMessage() {}, findMessageByClientId() {}, deleteMessage() {} },
    now: () => '2026-08-29T06:01:00.000Z',
    run: async () => {
      order.push('digest-start');
      await pendingDigest;
      order.push('digest-end');
      return {
        status: 'not_claimed', scheduledAt: '2026-08-29T06:00:00.000Z',
        runId: '10000000-0000-4000-8000-000000000001',
        selectedCount: 0, renderedCount: 0, omittedEligibleCount: 0,
        partCount: 0, deliveredPartCount: 0,
        cleanup: { attempted: 0, settled: 0, failed: 0 }
      };
    },
    setIntervalImpl: () => ({})
  });
  const digestRun = digest.runNow('manual');
  await Promise.resolve();
  order.push('immediate-delivered');
  assert.deepEqual(order, ['digest-start', 'immediate-delivered']);
  releaseDigest();
  await digestRun;
  assert.deepEqual(order, ['digest-start', 'immediate-delivered', 'digest-end']);
});

test('identical reply text at a later displayed time is a new room revision', () => {
  const earlier = semanticRoomEventIdentity({ previewText: '홍길동 네', displayTime: '오전 9:10' });
  const unreadMutation = semanticRoomEventIdentity({ previewText: '홍길동 2 네', displayTime: '오전 9:10' });
  const later = semanticRoomEventIdentity({ previewText: '홍길동 네', displayTime: '오전 9:25' });

  assert.equal(unreadMutation, earlier);
  assert.notEqual(later, earlier);
});

test('a superseded phase result stays superseded in the durable event row', () => {
  assert.deepEqual(mapWorkerPayloadToSupabaseStatus({
    status: 'superseded_by_newer_room_event',
    decision: { should_write_to_sheet: true },
    sheetResult: { success: true }
  }), {
    status: 'superseded_by_newer_room_event',
    error_message: null
  });
});

test('production queue uses the phase scheduler and publishes freshness before durable writes', async () => {
  const source = await readFile(new URL('./server.mjs', import.meta.url), 'utf8');
  assert.match(source, /CONFIG\.aiDomSplitEnabled\s*\?\s*run\(\)\s*:\s*workerChain\.then/);
  assert.match(source, /getKakaoPhaseScheduler\(\)\.runManual/);
  assert.match(source, /url\.pathname === '\/worker\/freshness'/);
  const revisionIndex = source.indexOf('const roomVersion = registerAcceptedRoomEvent(');
  const durableRevisionIndex = source.lastIndexOf('gatewayChannel.latestRoomRevision', revisionIndex);
  const shadowIndex = source.indexOf('shadowRuntime?.recordAccepted?.(event, roomVersion)', revisionIndex);
  const supabaseIndex = source.indexOf("await writeEvent(event, 'event')", revisionIndex);
  assert.ok(durableRevisionIndex >= 0 && durableRevisionIndex < revisionIndex, 'durable Gateway revision must seed the in-memory revision');
  assert.ok(revisionIndex >= 0 && supabaseIndex > revisionIndex, 'freshness revision must advance before Supabase latency');
  assert.ok(shadowIndex > revisionIndex && shadowIndex < supabaseIndex, 'shadow starts after accepted revision and before legacy Supabase');
  assert.match(source, /readBooleanEnvironment\(process\.env\.KAKAO_AI_DOM_SPLIT_ENABLED, false\)/);
  assert.match(source, /getKakaoPhaseScheduler\(\)\.runManual\(\{[\s\S]*?cleanupIdleKakaoConversationTabs\('worker_finished'/);
});

test('health config exposes the live safety contract used by supervised restarts', async () => {
  assert.deepEqual(buildHealthConfig({
    workerLive: true,
    autoSendEnabled: true,
    workerDryRun: false,
    windowsWritesEnabled: true,
    startupCatchupSupported: true
  }), {
    workerLive: true,
    autoSendEnabled: true,
    workerDryRun: false,
    windowsWritesEnabled: true,
    startupCatchupSupported: true
  });

  const source = await readFile(new URL('./server.mjs', import.meta.url), 'utf8');
  assert.match(source, /startupCatchupSupported:\s*true/);
  assert.match(source, /documentExecutionConfigured:\s*Boolean\(/);
  assert.doesNotMatch(
    source,
    /startupCatchupSupported:\s*process\.env\.PROCESS_INITIAL_SCAN/,
    'catch-up capability is independent from whether initial-scan events are currently processed'
  );
});

test('bridge-created failure cards forward configured Slack mention recipients', async () => {
  const source = await readFile(new URL('./server.mjs', import.meta.url), 'utf8');
  assert.match(
    source,
    /slackMentionUserIds:\s*String\(process\.env\.SLACK_CARD_MENTION_USER_IDS/
  );
});

test('stable Kakao chat identity survives normalization and debounce grouping', () => {
  const first = normalizeEvent({
    roomKey: 'chat:4978438284325090',
    customerName: '김정태',
    messagePreview: '첫 문의',
    displayTime: '오후 2:51',
    previewText: '중요 김정태 1 첫 문의 오후 2:51',
    eventHash: 'event-1'
  });
  const second = normalizeEvent({
    roomKey: 'chat:4978438284325090',
    customerName: '김정태',
    messagePreview: '추가 문의',
    displayTime: '오후 2:52',
    previewText: '중요 김정태 2 추가 문의 오후 2:52',
    eventHash: 'event-2'
  });

  assert.equal(first.customerName, '김정태');
  assert.equal(first.messagePreview, '첫 문의');
  assert.equal(first.displayTime, '오후 2:51');
  assert.equal(roomKeyForDebounce(first), 'chat:4978438284325090');
  assert.equal(roomKeyForDebounce(second), 'chat:4978438284325090');
});

test('queued jobs for one chat coalesce into the newest AI read instead of piling up', () => {
  const previous = {
    jobId: 'old-job',
    roomKey: 'chat:4978438284325090',
    firstEventAt: '2026-07-23T05:00:00.000Z',
    lastEventAt: '2026-07-23T05:01:00.000Z',
    previewText: '첫 문의',
    events: [{ eventHash: 'event-1', previewText: '첫 문의' }]
  };
  const latest = {
    jobId: 'new-job',
    roomKey: 'chat:4978438284325090',
    customerName: '김정태',
    firstEventAt: '2026-07-23T05:02:00.000Z',
    lastEventAt: '2026-07-23T05:03:00.000Z',
    previewText: '추가 문의',
    events: [{ eventHash: 'event-2', previewText: '추가 문의' }]
  };

  assert.deepEqual(mergeQueuedRoomJobs(previous, latest), {
    ...latest,
    firstEventAt: previous.firstEventAt,
    eventCount: 2,
    events: [...previous.events, ...latest.events]
  });
});

test('bridge queue replaces pending same-room work and cleans conversation tabs after every worker', async () => {
  const source = await readFile(new URL('./server.mjs', import.meta.url), 'utf8');
  assert.match(source, /const queuedWorkerSlotsByRoom = new Map\(\)/);
  assert.match(source, /superseded_by_newer_room_event/);
  assert.match(source, /cleanupIdleKakaoConversationTabs\('worker_finished', \{ allowQueued: true \}\)/);
});

test('stable job identity ignores a disappearing Kakao unread badge for the same message', async () => {
  const { semanticPreviewIdentity } = await import('./server.mjs');
  assert.equal(
    semanticPreviewIdentity('중요 김명선 2 여쭤볼라했는데 전원이 꺼져있어서 카톡으로 남겨드립니다! 오후 4:17'),
    semanticPreviewIdentity('중요 김명선 여쭤볼라했는데 전원이 꺼져있어서 카톡으로 남겨드립니다! 오후 4:17')
  );
});

test('CORS preflight permits Chrome private-network access to the loopback bridge', () => {
  assert.equal(buildCorsHeaders()['access-control-allow-private-network'], 'true');
});

test('Windows workers stay in the owned tree and timeout cleanup targets the whole tree', () => {
  assert.equal(shouldDetachWorkerProcess('win32'), false);
  assert.equal(shouldDetachWorkerProcess('linux'), true);
  assert.deepEqual(buildWorkerTreeKillInvocation(1234, 'SIGTERM', 'win32'), {
    command: 'taskkill.exe',
    args: ['/PID', '1234', '/T'],
    options: { shell: false, stdio: 'ignore', windowsHide: true }
  });
  assert.deepEqual(buildWorkerTreeKillInvocation(1234, 'SIGKILL', 'win32'), {
    command: 'taskkill.exe',
    args: ['/PID', '1234', '/T', '/F'],
    options: { shell: false, stdio: 'ignore', windowsHide: true }
  });
  assert.equal(buildWorkerTreeKillInvocation(1234, 'SIGTERM', 'linux'), null);
});

test('generic DOM unreadSignal does not turn a read top-row backstop into a worker job', () => {
  const staleOutgoingRow = {
    reason: 'top_rows_backstop',
    previewText: '중요 임우혁 네, 예약 정보 확인해보겠습니다! 오전 10:31',
    unreadCount: null,
    raw: { unreadSignal: true }
  };

  assert.equal(hasUnreadCount(staleOutgoingRow), false);
  assert.equal(shouldQueueTopRowEvent(staleOutgoingRow), false);
  assert.equal(shouldSkipSupabaseRowAsLowValue({
    status: 'ai_worker_error',
    preview_text: staleOutgoingRow.previewText,
    payload: {
      reason: 'top_rows_backstop',
      raw: { unreadSignal: true }
    }
  }), 'untrusted_backstop_row');
});

test('a counted unread top-row remains eligible for normal processing', () => {
  const unreadCustomerRow = {
    reason: 'top_rows_backstop',
    previewText: '중요 새고객 2 FX3 내일 대여 가능할까요? 오후 10:31',
    unreadCount: 2,
    raw: { unreadSignal: true }
  };

  assert.equal(hasUnreadCount(unreadCustomerRow), true);
  assert.equal(shouldQueueTopRowEvent(unreadCustomerRow), true);
  assert.equal(shouldSkipWorkerForPreview(unreadCustomerRow), '');
});

test('semantic-looking previews are never suppressed before Hermes sees the room', () => {
  const semanticPreviews = [
    '감사합니다',
    '빌리지님이 보냄 요청하신 통장 사본 전달드립니다',
    '입금했습니다',
    '네 가능합니다',
    '반납 완료했습니다'
  ];

  for (const previewText of semanticPreviews) {
    assert.equal(
      shouldSkipWorkerForPreview({
        reason: 'mutation',
        previewText,
        unreadCount: null
      }),
      '',
      `preview must reach Hermes: ${previewText}`
    );
  }
});

test('recovery only rejects untrusted historical rows, not message semantics', () => {
  for (const previewText of ['감사합니다', '입금했습니다', '운영자님이 보냄', '네 가능합니다']) {
    assert.equal(shouldSkipSupabaseRowAsLowValue({
      status: 'ai_worker_error',
      preview_text: previewText,
      payload: {
        reason: 'mutation',
        raw: { unreadSignal: false }
      }
    }), '');
  }
});

test('a meaningful live top-row change remains eligible without an unread counter', () => {
  const now = new Date();
  const hour = now.getHours() % 12 || 12;
  const minute = String(now.getMinutes()).padStart(2, '0');
  const period = now.getHours() < 12 ? '오전' : '오후';
  const liveCustomerRow = {
    reason: 'top_row_changed',
    previewText: `새고객 FX3 내일 대여 가능할까요? ${period} ${hour}:${minute}`,
    unreadCount: null,
    raw: { unreadSignal: false }
  };

  assert.equal(hasUnreadCount(liveCustomerRow), false);
  assert.equal(shouldQueueTopRowEvent(liveCustomerRow), true);
});

test('server keeps Gateway HTTP disabled by default and dispatches it before public routes', async () => {
  const source = await readFile(new URL('./server.mjs', import.meta.url), 'utf8');
  assert.match(source, /hermesTransport:\s*resolveHermesTransport\(process\.env\.KAKAO_HERMES_TRANSPORT\)/);
  assert.match(source, /hermesBridgeToken:\s*String\(process\.env\.KAKAO_HERMES_BRIDGE_TOKEN\s*\|\|\s*''\)\.trim\(\)/);
  assert.match(source, /KAKAO_HERMES_LEASE_MS/);
  assert.match(source, /KAKAO_HERMES_MAX_ATTEMPTS/);
  assert.match(source, /createHermesGatewayHttpHandler/);
  assert.ok(source.indexOf('gatewayHttpHandler(req, res, url)') < source.indexOf("url.pathname === '/health'"));
});
