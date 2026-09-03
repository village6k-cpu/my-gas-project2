import assert from 'node:assert/strict';
import test from 'node:test';

import { recordShadowNotificationObligation } from './shadow-receipts.mjs';

const event = {
  source: 'kakao_channel_manager_dom',
  eventHash: 'event-1',
  roomKey: 'chat:1',
  receivedAt: '2026-08-29T00:00:00.000Z',
  previewText: 'camera availability question',
  customerName: 'Test Customer',
  messagePreview: 'camera availability question'
};

function createStore(result) {
  const calls = [];
  return {
    calls,
    async claimNotificationReceipt(input) {
      calls.push(input);
      return result;
    }
  };
}

test('shadow disabled skips before normalizing the event or touching the store', async () => {
  const store = createStore({ created: true, row: { id: 'must-not-exist' } });

  assert.deepEqual(
    await recordShadowNotificationObligation({ event: {}, config: { shadowWrites: false }, store }),
    { skipped: true, reason: 'shadow_disabled' }
  );
  assert.equal(store.calls.length, 0);
});

test('shadow enabled claims one normalized notification receipt', async () => {
  const row = { id: 'receipt-1', notification_state: 'pending' };
  const store = createStore({ created: true, row });

  const result = await recordShadowNotificationObligation({
    event,
    config: { shadowWrites: true },
    store
  });

  assert.deepEqual(result, { created: true, row });
  assert.equal(store.calls.length, 1);
  assert.equal(store.calls[0].sourceEventKey, 'event-1');
  assert.equal(store.calls[0].roomKey, 'chat:1');
});

test('duplicate shadow claim stays observable without creating another receipt', async () => {
  const row = { id: 'receipt-1', notification_state: 'pending' };
  const store = createStore({ created: false, row });

  const result = await recordShadowNotificationObligation({
    event,
    config: { shadowWrites: true },
    store
  });

  assert.deepEqual(result, { created: false, row });
  assert.equal(store.calls.length, 1);
});

test('store failure returns bounded generic metadata without echoing secrets or payloads', async () => {
  const secret = 'service-role-secret-value';
  const privatePayload = 'private-customer-payload';
  const store = {
    async claimNotificationReceipt() {
      throw new Error(`${secret} ${privatePayload} ${'x'.repeat(2000)}`);
    }
  };

  const result = await recordShadowNotificationObligation({
    event,
    config: { shadowWrites: true },
    store
  });

  assert.deepEqual(result, {
    skipped: false,
    created: false,
    error: 'shadow_receipt_store_failed'
  });
  assert.ok(result.error.length <= 100);
  assert.doesNotMatch(JSON.stringify(result), /service-role-secret-value|private-customer-payload/);
});
