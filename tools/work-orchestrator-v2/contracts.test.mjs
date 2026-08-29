import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertNotificationTransition,
  deterministicClientMessageId,
  loadWorkOrchestratorConfig,
  notificationReceiptInput
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
