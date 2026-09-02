import assert from 'node:assert/strict';
import test from 'node:test';

const resolutionModule = import('./automation-resolution.mjs');

async function derive(input) {
  const { deriveAutomationResolution } = await resolutionModule;
  return deriveAutomationResolution(input);
}

test('verified auto reply succeeds only with a content-free correlated readback receipt', async () => {
  const result = await derive({
    autoReplyResult: {
      sent: true,
      readbackReceipt: {
        id: `reply-readback-${'a'.repeat(64)}`,
        confirmedAt: '2026-09-02T01:02:03.000Z'
      }
    }
  });

  assert.equal(result.state, 'succeeded');
  assert.equal(result.resolutionKind, 'auto_reply_readback');
  assert.deepEqual(result.evidence, {
    autoReply: {
      id: `reply-readback-${'a'.repeat(64)}`,
      timestamp: '2026-09-02T01:02:03.000Z',
      status: 'readback_confirmed'
    }
  });
});

test('transport ids and asserted booleans can never impersonate conversation readback', async () => {
  const result = await derive({
    autoReplyResult: {
      sent: true,
      readbackConfirmed: true,
      transportMessageId: 'kakao-1',
      confirmedAt: '2026-09-02T01:02:03.000Z'
    }
  });

  assert.equal(result.state, 'needs_human');
  assert.equal(result.resolutionKind, 'missing_authoritative_readback');
  assert.deepEqual(result.evidence, {});
});

test('sent auto reply without authoritative readback needs human review', async () => {
  const result = await derive({
    autoReplyResult: { sent: true, readbackConfirmed: false }
  });

  assert.equal(result.state, 'needs_human');
  assert.equal(result.resolutionKind, 'missing_authoritative_readback');
});

test('sheet execution success without a receipt needs human review', async () => {
  const result = await derive({ sheetResult: { success: true }, operationReceipt: null });

  assert.equal(result.state, 'needs_human');
  assert.equal(result.resolutionKind, 'missing_authoritative_readback');
});

test('completed authoritative operation receipt confirms sheet success', async () => {
  const result = await derive({
    sheetResult: { success: true },
    operationReceipt: { state: 'completed', authoritativeReadback: true }
  });

  assert.equal(result.state, 'succeeded');
  assert.equal(result.resolutionKind, 'operation_readback');
  assert.deepEqual(result.evidence, {
    operationReceipt: { status: 'completed' },
    sheet: { status: 'succeeded' }
  });
});

test('owner approval remains human-required after a preliminary operation', async () => {
  const result = await derive({
    decision: { requires_owner_approval: true },
    sheetResult: { success: true },
    operationReceipt: { state: 'completed', authoritativeReadback: true }
  });

  assert.equal(result.state, 'needs_human');
  assert.equal(result.resolutionKind, 'owner_approval_required');
});

test('stale authoritative evidence needs human review', async () => {
  const result = await derive({
    sheetResult: { success: true },
    operationReceipt: {
      state: 'completed',
      authoritativeReadback: true,
      stale: true,
      readbackAt: '2026-08-31T00:00:00.000Z'
    }
  });

  assert.equal(result.state, 'needs_human');
  assert.equal(result.resolutionKind, 'stale_evidence');
});

test('contradictory execution and readback evidence needs human review', async () => {
  const result = await derive({
    sheetResult: { success: false },
    operationReceipt: { state: 'completed', authoritativeReadback: true }
  });

  assert.equal(result.state, 'needs_human');
  assert.equal(result.resolutionKind, 'contradictory_evidence');
});

test('failed receipt state with completed receipt status needs human review', async () => {
  const result = await derive({
    operationReceipt: {
      state: 'failed',
      status: 'completed',
      authoritativeReadback: true,
      operationId: 'operation-1'
    }
  });

  assert.equal(result.state, 'needs_human');
  assert.equal(result.resolutionKind, 'contradictory_evidence');
});

test('post action execution success alone needs human review', async () => {
  const result = await derive({ postActionResult: { success: true } });

  assert.equal(result.state, 'needs_human');
  assert.equal(result.resolutionKind, 'missing_authoritative_readback');
});

test('typed authoritative failure is reported as failed', async () => {
  const result = await derive({
    operationReceipt: { state: 'failed', authoritativeReadback: true, operationId: 'op-1' }
  });

  assert.equal(result.state, 'failed');
  assert.equal(result.resolutionKind, 'authoritative_failure');
  assert.deepEqual(result.evidence, {
    operationReceipt: { id: 'op-1', status: 'failed' }
  });
});

test('evidence excludes unrecognized receipt status text', async () => {
  const result = await derive({
    operationReceipt: {
      state: 'completed secret-token',
      operationId: 'op-2'
    }
  });

  assert.deepEqual(result.evidence, {
    operationReceipt: { id: 'op-2' }
  });
});

test('auto reply evidence ignores every transport message identifier', async () => {
  for (const transportMessageId of [
    ' kakao-3',
    'customer asked for a discount',
    'xoxb-1234567890-secret-token',
    'kakao-3\n',
    'kakao-3<script>'
  ]) {
    const result = await derive({
      autoReplyResult: { sent: true, readbackConfirmed: true, transportMessageId }
    });

    assert.equal(result.state, 'needs_human');
    assert.deepEqual(result.evidence, {});
    assert.equal(JSON.stringify(result).includes(transportMessageId), false);
  }
});

test('operation evidence omits unsafe receipt identifiers', async () => {
  const result = await derive({
    operationReceipt: {
      state: 'failed',
      authoritativeReadback: true,
      operationId: 'Bearer customer-secret-token'
    }
  });

  assert.equal(result.state, 'failed');
  assert.deepEqual(result.evidence, {
    operationReceipt: { status: 'failed' }
  });
  assert.equal(JSON.stringify(result).includes('customer-secret-token'), false);
});

test('evidence removes customer bodies, secrets, and arbitrary nested payloads', async () => {
  const result = await derive({
    autoReplyResult: {
      sent: true,
      readbackReceipt: {
        id: `reply-readback-${'b'.repeat(64)}`,
        confirmedAt: '2026-08-31T01:02:03.000Z'
      },
      customerMessageBody: 'customer-private-message',
      apiToken: 'secret-token',
      metadata: { rawBody: 'never retain this' }
    }
  });

  assert.deepEqual(result.evidence, {
    autoReply: {
      id: `reply-readback-${'b'.repeat(64)}`,
      timestamp: '2026-08-31T01:02:03.000Z',
      status: 'readback_confirmed'
    }
  });
  assert.equal(JSON.stringify(result.evidence).includes('customer-private-message'), false);
  assert.equal(JSON.stringify(result.evidence).includes('secret-token'), false);
  assert.equal(JSON.stringify(result.evidence).includes('rawBody'), false);
});
