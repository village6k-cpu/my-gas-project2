import { createHash } from 'node:crypto';

export const NOTIFICATION_STATES = Object.freeze([
  'pending',
  'delivering',
  'delivered',
  'failed',
  'cleanup_pending',
  'deleted'
]);

export const WORK_STATES = Object.freeze([
  'open',
  'in_progress',
  'snoozed',
  'resolved',
  'dismissed'
]);

const NOTIFICATION_TRANSITIONS = Object.freeze({
  pending: new Set(['delivering']),
  delivering: new Set(['delivered', 'failed']),
  failed: new Set(['delivering']),
  delivered: new Set(['cleanup_pending']),
  cleanup_pending: new Set(['deleted']),
  deleted: new Set()
});

const bounded = (value, max) => String(value ?? '').trim().slice(0, max);
const LONG_SOURCE_EVENT_KEY_PREFIX = 'v2-long-sha256:';
const CANONICAL_LONG_SOURCE_EVENT_KEY = /^v2-long-sha256:[0-9a-f]{64}$/;

function finiteMinutes(value, fallback, minimum) {
  const normalized = bounded(value, 100);
  if (!normalized) return fallback;

  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? Math.max(minimum, numeric) : fallback;
}

function safeHttpsUrl(value) {
  const normalized = bounded(value, 2048);
  if (!normalized) return '';
  try {
    const url = new URL(normalized);
    return url.protocol === 'https:' && url.hostname && !url.username && !url.password && !url.hash
      ? url.href
      : '';
  } catch {
    return '';
  }
}

export function readStrictBooleanEnvironment(value, defaultValue, name = 'environment variable') {
  if (value === undefined || value === null || String(value).trim() === '') return defaultValue;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === '1' || normalized === 'true') return true;
  if (normalized === '0' || normalized === 'false') return false;
  throw new Error(`Invalid boolean environment value for ${name}`);
}

export function canonicalSourceEventKey(value) {
  const sourceEventKey = String(value ?? '');
  if (!sourceEventKey.trim()) throw new Error('source event key is required');
  if (sourceEventKey !== sourceEventKey.trim()) throw new Error('source event key is not canonical');
  if (CANONICAL_LONG_SOURCE_EVENT_KEY.test(sourceEventKey)) return sourceEventKey;
  if (sourceEventKey.length <= 500 && !sourceEventKey.startsWith(LONG_SOURCE_EVENT_KEY_PREFIX)) {
    return sourceEventKey;
  }
  return `${LONG_SOURCE_EVENT_KEY_PREFIX}${createHash('sha256')
    .update(`village-work-orchestrator-v2-source-event-key:${sourceEventKey}`)
    .digest('hex')}`;
}

export function deterministicClientMessageId(sourceEventKey) {
  const canonicalKey = canonicalSourceEventKey(sourceEventKey);
  const hex = createHash('sha256')
    .update(`village-work-orchestrator-v2:${canonicalKey}`)
    .digest('hex')
    .slice(0, 32)
    .split('');
  hex[12] = '5';
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16], 16) % 4];
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function notificationReceiptInput(event = {}) {
  const sourceEventKey = canonicalSourceEventKey(event.sourceEventKey || event.eventHash);

  const roomKey = bounded(event.roomKey, 500);
  if (!roomKey) throw new Error('room key is required');

  const receivedAt = new Date(event.receivedAt || event.detectedAt);
  if (Number.isNaN(receivedAt.getTime())) throw new Error('received at is invalid');

  return {
    source: bounded(event.source, 100) || 'kakao_channel_manager_dom',
    sourceEventKey,
    sourceMessageId: bounded(event.sourceMessageId, 500) || null,
    clientMessageId: deterministicClientMessageId(sourceEventKey),
    roomKey,
    receivedAt: receivedAt.toISOString(),
    payload: {
      previewText: bounded(event.previewText, 1000),
      customerName: bounded(event.customerName, 200),
      messagePreview: bounded(event.messagePreview, 1000)
    }
  };
}

export function assertNotificationTransition(from, to) {
  if (!NOTIFICATION_TRANSITIONS[from]?.has(to)) {
    throw new Error(`invalid notification transition: ${from} -> ${to}`);
  }
}

export function loadWorkOrchestratorConfig(env = process.env) {
  return {
    shadowWrites: readStrictBooleanEnvironment(env.WORK_ORCHESTRATOR_V2_SHADOW_WRITES, false, 'WORK_ORCHESTRATOR_V2_SHADOW_WRITES'),
    immediateEnabled: readStrictBooleanEnvironment(env.WORK_ORCHESTRATOR_V2_IMMEDIATE_ENABLED, false, 'WORK_ORCHESTRATOR_V2_IMMEDIATE_ENABLED'),
    workItemsEnabled: readStrictBooleanEnvironment(env.WORK_ORCHESTRATOR_V2_WORK_ITEMS_ENABLED, false, 'WORK_ORCHESTRATOR_V2_WORK_ITEMS_ENABLED'),
    digestEnabled: readStrictBooleanEnvironment(env.WORK_ORCHESTRATOR_V2_DIGEST_ENABLED, false, 'WORK_ORCHESTRATOR_V2_DIGEST_ENABLED'),
    cleanupEnabled: readStrictBooleanEnvironment(env.WORK_ORCHESTRATOR_V2_CLEANUP_ENABLED, false, 'WORK_ORCHESTRATOR_V2_CLEANUP_ENABLED'),
    reportOnlyEnabled: readStrictBooleanEnvironment(env.WORK_ORCHESTRATOR_V2_REPORT_ONLY_ENABLED, false, 'WORK_ORCHESTRATOR_V2_REPORT_ONLY_ENABLED'),
    heybilliActionsReady: readStrictBooleanEnvironment(env.WORK_ORCHESTRATOR_V2_HEYBILLI_ACTIONS_READY, false, 'WORK_ORCHESTRATOR_V2_HEYBILLI_ACTIONS_READY'),
    dashboardUrl: safeHttpsUrl(env.SLACK_DASHBOARD_URL),
    inboxChannelId: bounded(env.WORK_ORCHESTRATOR_V2_INBOX_CHANNEL_ID, 500),
    digestChannelId: bounded(env.WORK_ORCHESTRATOR_V2_DIGEST_CHANNEL_ID, 500),
    digestIntervalMinutes: finiteMinutes(env.WORK_ORCHESTRATOR_V2_DIGEST_INTERVAL_MINUTES, 180, 60),
    autoNoticeTtlMinutes: finiteMinutes(env.WORK_ORCHESTRATOR_V2_AUTO_NOTICE_TTL_MINUTES, 180, 30)
  };
}

export function resolveWorkOrchestratorRuntimeMode(env = process.env) {
  const runtimeMode = bounded(env.WORK_ORCHESTRATOR_V2_RUNTIME_MODE, 20).toLowerCase() || 'legacy';
  if (runtimeMode !== 'legacy' && runtimeMode !== 'v2') {
    throw new Error('Work Orchestrator v2 runtime mode must be legacy or v2');
  }
  return runtimeMode;
}

export function resolveWorkOrchestratorV2CutoverConfig(env = process.env) {
  const runtimeMode = resolveWorkOrchestratorRuntimeMode(env);
  const workOrchestrator = loadWorkOrchestratorConfig(env);
  const legacyCardsEnabled = readStrictBooleanEnvironment(env.SLACK_AGENT_CARD_DELIVERY_ENABLED, runtimeMode === 'legacy', 'SLACK_AGENT_CARD_DELIVERY_ENABLED');
  const legacyWorkRowsEnabled = readStrictBooleanEnvironment(env.AI_WORKER_FOLLOW_UP_ITEMS_ENABLED, true, 'AI_WORKER_FOLLOW_UP_ITEMS_ENABLED')
    && readStrictBooleanEnvironment(env.KAKAO_FOLLOW_UP_ITEMS_ENABLED, true, 'KAKAO_FOLLOW_UP_ITEMS_ENABLED');
  const legacyP0Enabled = readStrictBooleanEnvironment(env.P0_SLACK_ESCALATION_ENABLED, true, 'P0_SLACK_ESCALATION_ENABLED');
  const legacyActionPollEnabled = readStrictBooleanEnvironment(env.SLACK_ACTION_POLL_ENABLED, true, 'SLACK_ACTION_POLL_ENABLED');
  const p0ReadbackEnabled = readStrictBooleanEnvironment(env.WORK_ORCHESTRATOR_V2_P0_READBACK_ENABLED, false, 'WORK_ORCHESTRATOR_V2_P0_READBACK_ENABLED');
  const p0CutoverEnabled = readStrictBooleanEnvironment(env.WORK_ORCHESTRATOR_V2_P0_CUTOVER_ENABLED, false, 'WORK_ORCHESTRATOR_V2_P0_CUTOVER_ENABLED');

  if (p0CutoverEnabled && !p0ReadbackEnabled) {
    throw new Error('Work Orchestrator v2 P0 cutover requires readback');
  }
  if (!legacyWorkRowsEnabled && !workOrchestrator.workItemsEnabled) {
    throw new Error('Work Orchestrator v2 cutover guard: legacy work rows require v2 work items');
  }
  if (!legacyP0Enabled && !(workOrchestrator.workItemsEnabled && p0ReadbackEnabled && p0CutoverEnabled)) {
    throw new Error('Work Orchestrator v2 cutover guard: legacy P0 requires v2 work items, readback, and cutover');
  }
  const v2FlagsEnabled = !workOrchestrator.shadowWrites
    && !workOrchestrator.immediateEnabled
    && workOrchestrator.workItemsEnabled
    && workOrchestrator.digestEnabled
    && workOrchestrator.cleanupEnabled
    && workOrchestrator.reportOnlyEnabled
    && workOrchestrator.heybilliActionsReady
    && Boolean(workOrchestrator.dashboardUrl)
    && p0ReadbackEnabled
    && p0CutoverEnabled;
  const legacyFlagsEnabled = legacyCardsEnabled
    && legacyWorkRowsEnabled
    && legacyP0Enabled
    && legacyActionPollEnabled;
  if (runtimeMode === 'legacy' && (!legacyFlagsEnabled || v2FlagsEnabled
    || workOrchestrator.shadowWrites || workOrchestrator.immediateEnabled
    || workOrchestrator.workItemsEnabled || workOrchestrator.digestEnabled
    || workOrchestrator.cleanupEnabled || workOrchestrator.reportOnlyEnabled
    || workOrchestrator.heybilliActionsReady || p0ReadbackEnabled || p0CutoverEnabled)) {
    throw new Error('Work Orchestrator cutover guard: legacy runtime mode requires the exact rollback contract');
  }
  if (runtimeMode === 'v2' && (!v2FlagsEnabled || legacyCardsEnabled
    || legacyWorkRowsEnabled || legacyP0Enabled || legacyActionPollEnabled)) {
    throw new Error('Work Orchestrator v2 cutover guard: runtime mode requires the exact cutover contract');
  }
  return {
    runtimeMode,
    ...workOrchestrator,
    legacyCardsEnabled,
    legacyWorkRowsEnabled,
    legacyP0Enabled,
    p0ReadbackEnabled,
    p0CutoverEnabled,
    legacyActionPollEnabled
  };
}

export function validateWorkOrchestratorV2CutoverConfig(env = process.env) {
  return resolveWorkOrchestratorV2CutoverConfig(env);
}
