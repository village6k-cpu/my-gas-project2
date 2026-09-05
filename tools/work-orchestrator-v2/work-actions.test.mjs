import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeWorkActionContext,
  encodeWorkActionContext,
  parsePendingWorkAction,
  processPendingWorkAction
} from './work-actions.mjs';

const ID = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-08-30T06:00:00.000Z';

function row(overrides = {}) {
  const expectedVersion = overrides.expectedVersion ?? 4;
  const action = overrides.action ?? { type: 'progress' };
  return {
    id: ID,
    state: 'open',
    priority: 'normal',
    actionable_at: '2026-08-30T03:00:00.000Z',
    snoozed_until: null,
    resolution_kind: null,
    resolution_evidence: {},
    resolved_at: null,
    resolved_by: null,
    payload: { requires_human_action: true },
    pending_action: {
      type: action.type,
      action,
      status: 'pending',
      requested_at: '2026-08-30T05:59:00.000Z',
      requested_by: 'UOWNER1',
      expected_version: expectedVersion
    },
    version: expectedVersion + 1,
    updated_at: '2026-08-30T05:59:00.000Z',
    ...overrides,
    pending_action: overrides.pending_action ?? {
      type: action.type,
      action,
      status: 'pending',
      requested_at: '2026-08-30T05:59:00.000Z',
      requested_by: 'UOWNER1',
      expected_version: expectedVersion
    }
  };
}

test('canonical custom-snooze context is bounded, exact, and rejects extra or malformed input', () => {
  const value = encodeWorkActionContext({ id: ID, version: 17 });
  assert.deepEqual(decodeWorkActionContext(value), { id: ID, version: 17 });
  assert.throws(() => encodeWorkActionContext({ id: ID, version: 17, extra: true }), {
    message: 'invalid work action context'
  });
  assert.throws(() => decodeWorkActionContext(Buffer.from(JSON.stringify({ id: ID, version: 17, extra: true })).toString('base64url')), {
    message: 'invalid work action context'
  });
  assert.throws(() => decodeWorkActionContext('not+base64url'), { message: 'invalid work action context' });
});

test('parsePendingWorkAction requires the exact request-stage shape and original-version correlation', () => {
  assert.deepEqual(parsePendingWorkAction(row(), NOW), {
    type: 'progress',
    action: { type: 'progress' },
    requestedAt: '2026-08-30T05:59:00.000Z',
    requestedBy: 'UOWNER1',
    expectedVersion: 4
  });

  const invalid = [
    row({ version: 4 }),
    row({ pending_action: { ...row().pending_action, extra: true } }),
    row({ pending_action: { ...row().pending_action, status: 'processing' } }),
    row({ pending_action: { ...row().pending_action, type: 'dismiss' } }),
    row({ pending_action: { ...row().pending_action, requested_at: '2026-08-30 06:00:00Z' } }),
    row({ pending_action: { ...row().pending_action, requested_at: '2026-02-30T06:00:00.000Z' } }),
    row({ pending_action: { ...row().pending_action, requested_at: '2026-08-30T06:00:00.001Z' } }),
    row({ pending_action: { ...row().pending_action, requested_by: '<!channel>' } }),
    row({ state: 'resolved' })
  ];
  for (const candidate of invalid) {
    assert.throws(() => parsePendingWorkAction(candidate, NOW), { message: 'invalid pending work action' });
  }
});

test('parsePendingWorkAction accepts PostgreSQL JSONB timestamptz offsets and normalizes to the supplied UTC domain', () => {
  const current = row({
    pending_action: {
      ...row().pending_action,
      requested_at: '2026-08-30T15:59:00.123456+09:00'
    }
  });
  assert.equal(
    parsePendingWorkAction(current, '2026-08-30T07:00:00.000Z').requestedAt,
    '2026-08-30T06:59:00.123Z'
  );
});

test('parsePendingWorkAction accepts only canonical authenticated Heybilli actors beside Slack actors', () => {
  const actor = 'heybilli:550e8400-e29b-41d4-a716-446655440000';
  const current = row({ pending_action: { ...row().pending_action, requested_by: actor } });
  assert.equal(parsePendingWorkAction(current, NOW).requestedBy, actor);
  for (const requestedBy of [
    'heybilli:550E8400-E29B-41D4-A716-446655440000',
    'heybilli:not-a-uuid',
    'browser:550e8400-e29b-41d4-a716-446655440000'
  ]) {
    assert.throws(() => parsePendingWorkAction(
      row({ pending_action: { ...row().pending_action, requested_by: requestedBy } }), NOW
    ), { message: 'invalid pending work action' });
  }
});

test('processPendingWorkAction returns exact mechanical CAS patches and clears pending action', async (t) => {
  const cases = [
    {
      name: 'progress',
      action: { type: 'progress' },
      expected: {
        state: 'in_progress', actionable_at: NOW,
        pending_action: {}, version: 6, updated_at: NOW
      }
    },
    {
      name: 'snooze',
      action: { type: 'snooze', snoozedUntil: '2026-08-30T09:00:00.000Z' },
      expected: {
        state: 'snoozed', snoozed_until: '2026-08-30T09:00:00.000Z',
        actionable_at: '2026-08-30T09:00:00.000Z', pending_action: {}, version: 6, updated_at: NOW
      }
    },
    {
      name: 'ack_p0',
      action: { type: 'ack_p0' },
      overrides: { priority: 'p0', payload: { requires_human_action: true } },
      expected: {
        payload: { requires_human_action: true, p0_acknowledged_at: NOW },
        pending_action: {}, version: 6, updated_at: NOW
      }
    },
    {
      name: 'dismiss',
      action: { type: 'dismiss' },
      expected: {
        state: 'dismissed', resolution_kind: 'dismissed', resolved_at: NOW,
        resolved_by: 'UOWNER1', pending_action: {}, version: 6, updated_at: NOW
      }
    }
  ];

  for (const entry of cases) {
    await t.test(entry.name, () => {
      const current = row({ action: entry.action, ...entry.overrides });
      const result = processPendingWorkAction({ row: current, action: current.pending_action, now: NOW });
      assert.deepEqual(result, {
        status: 'ready',
        expectedVersion: 5,
        expectedPendingStatus: 'pending',
        patch: entry.expected
      });
      assert.equal(current.pending_action.status, 'pending');
      assert.equal(current.version, 5);
    });
  }
});

test('pending action parsing and processing require an explicit canonical clock', () => {
  const current = row();
  for (const invalidNow of [undefined, null, '', '2026-08-30T06:00:00Z', 'not-a-time']) {
    assert.throws(() => parsePendingWorkAction(current, invalidNow), {
      message: 'invalid pending work action'
    });
    assert.throws(() => processPendingWorkAction({ row: current, action: current.pending_action, now: invalidNow }), {
      message: 'invalid pending work action'
    });
  }
  assert.throws(() => processPendingWorkAction({ row: current, action: current.pending_action }), {
    message: 'invalid pending work action'
  });
});

test('request_resolve stays pending for authoritative resolution and produces no patch', () => {
  const current = row({ action: { type: 'request_resolve' } });
  assert.deepEqual(processPendingWorkAction({ row: current, action: current.pending_action, now: NOW }), {
    status: 'awaiting_authoritative_resolution',
    expectedVersion: 5,
    expectedPendingStatus: 'pending',
    patch: null
  });
  assert.equal(current.state, 'open');
  assert.equal(current.pending_action.status, 'pending');
});

test('processor rejects action mismatch, stale versions, non-future snooze, and unacknowledged P0 hide', () => {
  const progress = row();
  assert.throws(() => processPendingWorkAction({
    row: progress,
    action: { ...progress.pending_action, action: { type: 'dismiss' }, type: 'dismiss' },
    now: NOW
  }), { message: 'invalid pending work action' });
  assert.throws(() => processPendingWorkAction({ row: row({ version: 7 }), action: row({ version: 7 }).pending_action, now: NOW }), {
    message: 'invalid pending work action'
  });
  const expired = row({ action: { type: 'snooze', snoozedUntil: NOW } });
  assert.throws(() => processPendingWorkAction({ row: expired, action: expired.pending_action, now: NOW }), {
    message: 'invalid pending work action'
  });
  const p0 = row({ action: { type: 'dismiss' }, priority: 'p0' });
  assert.throws(() => processPendingWorkAction({ row: p0, action: p0.pending_action, now: NOW }), {
    message: 'invalid pending work action'
  });
});
