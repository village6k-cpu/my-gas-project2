import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  assertNotificationTransition,
  canonicalSourceEventKey,
  deterministicClientMessageId,
  loadWorkOrchestratorConfig,
  notificationReceiptInput,
  resolveWorkOrchestratorV2CutoverConfig
} from './contracts.mjs';

const event = {
  source: 'kakao_channel_manager_dom',
  eventHash: 'event-1',
  roomKey: 'chat:1',
  detectedAt: '2026-08-29T00:00:00.000Z',
  receivedAt: '2026-08-29T00:00:00.000Z',
  previewText: '문의',
  customerName: '고객',
  messagePreview: ''
};

function readPlanEnvironment(marker) {
  const plan = readFileSync(new URL(
    '../../docs/superpowers/plans/2026-08-29-work-orchestrator-v2-automation-cleanup-cutover.md',
    import.meta.url
  ), 'utf8');
  const markerIndex = plan.indexOf(marker);
  assert.notEqual(markerIndex, -1, `missing plan marker: ${marker}`);
  const match = plan.slice(markerIndex + marker.length).match(/```dotenv\r?\n([\s\S]*?)```/);
  assert.ok(match, `missing dotenv block after: ${marker}`);
  return Object.fromEntries(match[1]
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const separator = line.indexOf('=');
      assert.ok(separator > 0, `invalid dotenv line: ${line}`);
      return [line.slice(0, separator), line.slice(separator + 1)];
    }));
}

test('notificationReceiptInput normalizes a Kakao event into a receipt with a deterministic client id', () => {
  assert.deepEqual(notificationReceiptInput(event), {
    source: 'kakao_channel_manager_dom',
    sourceEventKey: 'event-1',
    sourceMessageId: null,
    clientMessageId: deterministicClientMessageId('event-1'),
    roomKey: 'chat:1',
    receivedAt: '2026-08-29T00:00:00.000Z',
    payload: { previewText: '문의', customerName: '고객', messagePreview: '' }
  });
});

test('deterministicClientMessageId is stable and distinguishes event keys', () => {
  assert.equal(deterministicClientMessageId('event-1'), deterministicClientMessageId('event-1'));
  assert.notEqual(deterministicClientMessageId('event-1'), deterministicClientMessageId('event-2'));
});

test('canonical source keys preserve bounded identifiers and hash the complete oversized identifier', () => {
  const sharedPrefix = 'x'.repeat(500);
  const first = `${sharedPrefix}A`;
  const second = `${sharedPrefix}B`;

  assert.equal(canonicalSourceEventKey('event-1'), 'event-1');
  assert.notEqual(canonicalSourceEventKey(first), canonicalSourceEventKey(second));
  assert.match(canonicalSourceEventKey(first), /^v2-long-sha256:[0-9a-f]{64}$/);
  assert.equal(
    canonicalSourceEventKey(canonicalSourceEventKey(first)),
    canonicalSourceEventKey(first),
    'canonicalization must be idempotent for a stored oversized key'
  );
  assert.notEqual(deterministicClientMessageId(first), deterministicClientMessageId(second));
  assert.notEqual(
    notificationReceiptInput({ ...event, eventHash: first }).sourceEventKey,
    notificationReceiptInput({ ...event, eventHash: second }).sourceEventKey
  );
});

test('canonical source keys reject blank and surrounding whitespace without collapsing identifiers', () => {
  assert.throws(() => canonicalSourceEventKey(''), /source event key is required/i);
  assert.throws(() => canonicalSourceEventKey('   '), /source event key is required/i);
  assert.throws(() => canonicalSourceEventKey(' event-1'), /source event key is not canonical/i);
  assert.throws(() => canonicalSourceEventKey('event-1 '), /source event key is not canonical/i);
});

test('notificationReceiptInput rejects a missing or blank room key', () => {
  assert.throws(() => notificationReceiptInput({ ...event, roomKey: '' }), /room key is required/i);
  assert.throws(() => notificationReceiptInput({ ...event, roomKey: '   ' }), /room key is required/i);
});

test('notificationReceiptInput rejects invalid or missing receipt dates', () => {
  assert.throws(() => notificationReceiptInput({ ...event, receivedAt: 'not-a-date' }), /received at is invalid/i);
  assert.throws(() => notificationReceiptInput({ ...event, receivedAt: '', detectedAt: '' }), /received at is invalid/i);
});

test('assertNotificationTransition accepts valid transitions and rejects invalid transitions', () => {
  assert.doesNotThrow(() => assertNotificationTransition('pending', 'delivering'));
  assert.throws(() => assertNotificationTransition('deleted', 'delivering'), /invalid notification transition/i);
});

test('notification cleanup failure stays outside the delivery lifecycle', () => {
  assert.throws(() => assertNotificationTransition('cleanup_pending', 'failed'), /invalid notification transition/i);
  assert.doesNotThrow(() => assertNotificationTransition('cleanup_pending', 'deleted'));
  assert.doesNotThrow(() => assertNotificationTransition('failed', 'delivering'));
});

test('loadWorkOrchestratorConfig defaults rollout flags off and enables shadow writes explicitly', () => {
  assert.equal(loadWorkOrchestratorConfig({ WORK_ORCHESTRATOR_V2_SHADOW_WRITES: '1' }).shadowWrites, true);
  assert.equal(loadWorkOrchestratorConfig({}).immediateEnabled, false);
});

test('loadWorkOrchestratorConfig falls back to safe finite numeric defaults', () => {
  const config = loadWorkOrchestratorConfig({
    WORK_ORCHESTRATOR_V2_DIGEST_INTERVAL_MINUTES: 'not-a-number',
    WORK_ORCHESTRATOR_V2_AUTO_NOTICE_TTL_MINUTES: 'Infinity'
  });

  assert.equal(config.digestIntervalMinutes, 180);
  assert.equal(config.autoNoticeTtlMinutes, 180);
  assert.equal(Number.isFinite(config.digestIntervalMinutes), true);
  assert.equal(Number.isFinite(config.autoNoticeTtlMinutes), true);
});

test('runtime mode defaults to the exact legacy rollback contract and rejects unknown modes', () => {
  assert.deepEqual(resolveWorkOrchestratorV2CutoverConfig({}), {
    runtimeMode: 'legacy',
    shadowWrites: false,
    immediateEnabled: false,
    workItemsEnabled: false,
    digestEnabled: false,
    cleanupEnabled: false,
    dashboardUrl: '',
    reportOnlyEnabled: false,
    heybilliActionsReady: false,
    inboxChannelId: '',
    digestChannelId: '',
    digestIntervalMinutes: 180,
    autoNoticeTtlMinutes: 180,
    legacyCardsEnabled: true,
    legacyWorkRowsEnabled: true,
    legacyP0Enabled: true,
    p0ReadbackEnabled: false,
    p0CutoverEnabled: false,
    legacyActionPollEnabled: true
  });
  assert.throws(
    () => resolveWorkOrchestratorV2CutoverConfig({ WORK_ORCHESTRATOR_V2_RUNTIME_MODE: 'shadow' }),
    /runtime mode.*legacy.*v2/i
  );
});

test('runtime mode validates the exact v2 target and exact legacy rollback sender contracts', () => {
  const exactV2 = resolveWorkOrchestratorV2CutoverConfig({
    WORK_ORCHESTRATOR_V2_RUNTIME_MODE: 'v2',
    WORK_ORCHESTRATOR_V2_SHADOW_WRITES: '0',
    WORK_ORCHESTRATOR_V2_IMMEDIATE_ENABLED: '0',
    WORK_ORCHESTRATOR_V2_WORK_ITEMS_ENABLED: '1',
    WORK_ORCHESTRATOR_V2_DIGEST_ENABLED: '1',
    WORK_ORCHESTRATOR_V2_CLEANUP_ENABLED: '1',
    WORK_ORCHESTRATOR_V2_P0_READBACK_ENABLED: '1',
    WORK_ORCHESTRATOR_V2_P0_CUTOVER_ENABLED: '1',
    WORK_ORCHESTRATOR_V2_REPORT_ONLY_ENABLED: '1',
    WORK_ORCHESTRATOR_V2_HEYBILLI_ACTIONS_READY: '1',
    SLACK_DASHBOARD_URL: 'https://heybilli.example/follow-ups',
    AI_WORKER_FOLLOW_UP_ITEMS_ENABLED: '0',
    KAKAO_FOLLOW_UP_ITEMS_ENABLED: '0',
    SLACK_AGENT_CARD_DELIVERY_ENABLED: '0',
    SLACK_ACTION_POLL_ENABLED: '0',
    P0_SLACK_ESCALATION_ENABLED: '0'
  });
  assert.equal(exactV2.runtimeMode, 'v2');
  assert.equal(exactV2.shadowWrites, false);
  assert.equal(exactV2.immediateEnabled, false);
  assert.equal(exactV2.cleanupEnabled, true);
  assert.equal(exactV2.legacyP0Enabled, false);
  assert.equal(exactV2.p0CutoverEnabled, true);
  assert.equal(exactV2.legacyActionPollEnabled, false);
  assert.equal(exactV2.reportOnlyEnabled, true);
  assert.equal(exactV2.heybilliActionsReady, true);

  assert.throws(
    () => resolveWorkOrchestratorV2CutoverConfig({
      WORK_ORCHESTRATOR_V2_RUNTIME_MODE: 'legacy',
      P0_SLACK_ESCALATION_ENABLED: '0',
      WORK_ORCHESTRATOR_V2_WORK_ITEMS_ENABLED: '1',
      WORK_ORCHESTRATOR_V2_P0_READBACK_ENABLED: '1',
      WORK_ORCHESTRATOR_V2_P0_CUTOVER_ENABLED: '1'
    }),
    /legacy runtime mode.*exact rollback/i
  );
});

test('report-only runtime mode rejects every partial owner-action cutover', () => {
  const target = {
    WORK_ORCHESTRATOR_V2_RUNTIME_MODE: 'v2',
    WORK_ORCHESTRATOR_V2_SHADOW_WRITES: '0',
    WORK_ORCHESTRATOR_V2_IMMEDIATE_ENABLED: '0',
    WORK_ORCHESTRATOR_V2_WORK_ITEMS_ENABLED: '1',
    WORK_ORCHESTRATOR_V2_DIGEST_ENABLED: '1',
    WORK_ORCHESTRATOR_V2_CLEANUP_ENABLED: '1',
    WORK_ORCHESTRATOR_V2_P0_READBACK_ENABLED: '1',
    WORK_ORCHESTRATOR_V2_P0_CUTOVER_ENABLED: '1',
    WORK_ORCHESTRATOR_V2_REPORT_ONLY_ENABLED: '1',
    WORK_ORCHESTRATOR_V2_HEYBILLI_ACTIONS_READY: '1',
    SLACK_DASHBOARD_URL: 'https://heybilli.example/follow-ups',
    AI_WORKER_FOLLOW_UP_ITEMS_ENABLED: '0',
    KAKAO_FOLLOW_UP_ITEMS_ENABLED: '0',
    SLACK_AGENT_CARD_DELIVERY_ENABLED: '0',
    P0_SLACK_ESCALATION_ENABLED: '0',
    SLACK_ACTION_POLL_ENABLED: '0'
  };
  assert.doesNotThrow(() => resolveWorkOrchestratorV2CutoverConfig(target));
  for (const partial of [
    { WORK_ORCHESTRATOR_V2_REPORT_ONLY_ENABLED: '0' },
    { WORK_ORCHESTRATOR_V2_HEYBILLI_ACTIONS_READY: '0' },
    { SLACK_ACTION_POLL_ENABLED: '1' },
    { SLACK_DASHBOARD_URL: '' }
  ]) {
    assert.throws(() => resolveWorkOrchestratorV2CutoverConfig({ ...target, ...partial }), /exact cutover/i);
  }
});

test('binding Task 7 target and rollback blocks pass the real exact-mode guard', () => {
  const target = readPlanEnvironment('The valid production target is:');
  const rollback = readPlanEnvironment('Rollback flags:');

  assert.deepEqual({
    runtimeMode: target.WORK_ORCHESTRATOR_V2_RUNTIME_MODE,
    p0Readback: target.WORK_ORCHESTRATOR_V2_P0_READBACK_ENABLED,
    p0Cutover: target.WORK_ORCHESTRATOR_V2_P0_CUTOVER_ENABLED,
    legacyP0: target.P0_SLACK_ESCALATION_ENABLED,
    legacyActions: target.SLACK_ACTION_POLL_ENABLED,
    reportOnly: target.WORK_ORCHESTRATOR_V2_REPORT_ONLY_ENABLED,
    heybilliActionsReady: target.WORK_ORCHESTRATOR_V2_HEYBILLI_ACTIONS_READY,
    botUserId: target.WORK_ORCHESTRATOR_V2_SLACK_BOT_USER_ID,
    botId: target.WORK_ORCHESTRATOR_V2_SLACK_BOT_ID,
    teamId: target.WORK_ORCHESTRATOR_V2_SLACK_TEAM_ID,
    cleanupOwner: target.WORK_ORCHESTRATOR_V2_CLEANUP_OWNER,
    cleanupLeaseSeconds: target.WORK_ORCHESTRATOR_V2_CLEANUP_LEASE_SECONDS,
    cleanupIntervalMs: target.WORK_ORCHESTRATOR_V2_CLEANUP_INTERVAL_MS
  }, {
    runtimeMode: 'v2',
    p0Readback: '1',
    p0Cutover: '1',
    legacyP0: '0',
    legacyActions: '0',
    reportOnly: '1',
    heybilliActionsReady: '1',
    botUserId: 'U_FROM_AUTH_TEST',
    botId: 'B_FROM_AUTH_TEST',
    teamId: 'T_FROM_AUTH_TEST',
    cleanupOwner: 'bridge:notice-cleanup',
    cleanupLeaseSeconds: '120',
    cleanupIntervalMs: '300000'
  });
  assert.equal(resolveWorkOrchestratorV2CutoverConfig(target).runtimeMode, 'v2');

  const restored = { ...target, ...rollback };
  assert.deepEqual({
    runtimeMode: restored.WORK_ORCHESTRATOR_V2_RUNTIME_MODE,
    shadowWrites: restored.WORK_ORCHESTRATOR_V2_SHADOW_WRITES,
    immediate: restored.WORK_ORCHESTRATOR_V2_IMMEDIATE_ENABLED,
    workItems: restored.WORK_ORCHESTRATOR_V2_WORK_ITEMS_ENABLED,
    digest: restored.WORK_ORCHESTRATOR_V2_DIGEST_ENABLED,
    cleanup: restored.WORK_ORCHESTRATOR_V2_CLEANUP_ENABLED,
    p0Readback: restored.WORK_ORCHESTRATOR_V2_P0_READBACK_ENABLED,
    p0Cutover: restored.WORK_ORCHESTRATOR_V2_P0_CUTOVER_ENABLED,
    workerLegacy: restored.AI_WORKER_FOLLOW_UP_ITEMS_ENABLED,
    bridgeLegacy: restored.KAKAO_FOLLOW_UP_ITEMS_ENABLED,
    legacyCards: restored.SLACK_AGENT_CARD_DELIVERY_ENABLED,
    legacyP0: restored.P0_SLACK_ESCALATION_ENABLED,
    legacyActions: restored.SLACK_ACTION_POLL_ENABLED,
    reportOnly: restored.WORK_ORCHESTRATOR_V2_REPORT_ONLY_ENABLED,
    heybilliActionsReady: restored.WORK_ORCHESTRATOR_V2_HEYBILLI_ACTIONS_READY
  }, {
    runtimeMode: 'legacy',
    shadowWrites: '0',
    immediate: '0',
    workItems: '0',
    digest: '0',
    cleanup: '0',
    p0Readback: '0',
    p0Cutover: '0',
    workerLegacy: '1',
    bridgeLegacy: '1',
    legacyCards: '1',
    legacyP0: '1',
    legacyActions: '1',
    reportOnly: '0',
    heybilliActionsReady: '0'
  });
  assert.equal(resolveWorkOrchestratorV2CutoverConfig(restored).runtimeMode, 'legacy');
});

test('effective v2 P0 rejects legacy-off unless work items, readback, and cutover are all enabled', () => {
  assert.throws(
    () => resolveWorkOrchestratorV2CutoverConfig({
      WORK_ORCHESTRATOR_V2_RUNTIME_MODE: 'v2',
      WORK_ORCHESTRATOR_V2_IMMEDIATE_ENABLED: '0',
      WORK_ORCHESTRATOR_V2_CLEANUP_ENABLED: '1',
      WORK_ORCHESTRATOR_V2_P0_READBACK_ENABLED: '1',
      WORK_ORCHESTRATOR_V2_P0_CUTOVER_ENABLED: '1',
      AI_WORKER_FOLLOW_UP_ITEMS_ENABLED: '1',
      KAKAO_FOLLOW_UP_ITEMS_ENABLED: '1',
      SLACK_AGENT_CARD_DELIVERY_ENABLED: '0',
      SLACK_ACTION_POLL_ENABLED: '0',
      P0_SLACK_ESCALATION_ENABLED: '0'
    }),
    /legacy P0.*work items.*readback.*cutover/i
  );
});
