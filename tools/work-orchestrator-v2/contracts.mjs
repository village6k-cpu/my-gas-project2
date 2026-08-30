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
    shadowWrites: env.WORK_ORCHESTRATOR_V2_SHADOW_WRITES === '1',
    immediateEnabled: env.WORK_ORCHESTRATOR_V2_IMMEDIATE_ENABLED === '1',
    workItemsEnabled: env.WORK_ORCHESTRATOR_V2_WORK_ITEMS_ENABLED === '1',
    digestEnabled: env.WORK_ORCHESTRATOR_V2_DIGEST_ENABLED === '1',
    cleanupEnabled: env.WORK_ORCHESTRATOR_V2_CLEANUP_ENABLED === '1',
    inboxChannelId: bounded(env.WORK_ORCHESTRATOR_V2_INBOX_CHANNEL_ID, 500),
    digestChannelId: bounded(env.WORK_ORCHESTRATOR_V2_DIGEST_CHANNEL_ID, 500),
    digestIntervalMinutes: finiteMinutes(env.WORK_ORCHESTRATOR_V2_DIGEST_INTERVAL_MINUTES, 180, 60),
    autoNoticeTtlMinutes: finiteMinutes(env.WORK_ORCHESTRATOR_V2_AUTO_NOTICE_TTL_MINUTES, 180, 30)
  };
}
