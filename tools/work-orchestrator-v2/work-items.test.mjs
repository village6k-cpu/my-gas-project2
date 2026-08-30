import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WORK_ACTIONS,
  applyWorkAction,
  buildHumanWorkCandidates,
  decodeWorkActionValue,
  encodeWorkActionValue,
  mergeWorkItem
} from './work-items.mjs';

const NOW = new Date('2026-08-29T06:00:00.000Z');
const EARLIER = '2026-08-28T06:00:00.000Z';
const UUID = '11111111-1111-4111-8111-111111111111';

function activeItem(overrides = {}) {
  return {
    id: UUID,
    work_key: 'room:1:payment',
    source_event_keys: ['event-a'],
    room_key: 'room:1',
    title: 'Payment review',
    summary: 'Verify the typed payment outcome.',
    work_type: 'payment_check',
    priority: 'normal',
    state: 'open',
    owner_id: 'UOWNER',
    actionable_at: EARLIER,
    due_at: null,
    snoozed_until: null,
    first_opened_at: EARLIER,
    last_activity_at: EARLIER,
    digest_inclusion_count: 2,
    consecutive_unhandled_digests: 2,
    last_digest_at: '2026-08-29T03:00:00.000Z',
    next_reminder_at: '2026-08-30T03:00:00.000Z',
    automation_state: 'needs_human',
    resolution_kind: null,
    resolution_evidence: {},
    resolved_at: null,
    resolved_by: null,
    pending_action: {},
    version: 4,
    payload: {
      requires_human_action: true,
      action_family: 'payment_reconcile',
      recommended_action: 'Check the authoritative ledger.'
    },
    created_at: EARLIER,
    updated_at: EARLIER,
    ...overrides
  };
}

test('verified auto reply suppresses only the reply obligation it completed', () => {
  const candidates = buildHumanWorkCandidates({
    now: NOW,
    autoReplyResult: { sent: true, readbackConfirmed: true },
    followUpRows: [
      {
        work_key: 'room:1:reply', room_key: 'room:1', type: 'reply_needed',
        requires_human_action: true, title: 'Reply to customer'
      },
      {
        work_key: 'trade:1:tax-invoice', room_key: 'room:1', type: 'tax_invoice',
        requires_human_action: true, title: 'Issue tax invoice'
      }
    ]
  });

  assert.deepEqual(candidates.map((item) => item.work_key), ['trade:1:tax-invoice']);
});

test('verified auto reply without an exact key keeps two distinct reply obligations', () => {
  const candidates = buildHumanWorkCandidates({
    now: NOW,
    autoReplyResult: { sent: true, readbackConfirmed: true },
    followUpRows: [
      { work_key: 'room:1:reply:a', type: 'reply_needed', requires_human_action: true },
      { work_key: 'room:1:reply:b', type: 'reply_needed', requires_human_action: true }
    ]
  });

  assert.deepEqual(candidates.map((item) => item.work_key), [
    'room:1:reply:a',
    'room:1:reply:b'
  ]);
});

test('verified auto reply suppresses only its exact confirmed work key', () => {
  const candidates = buildHumanWorkCandidates({
    now: NOW,
    autoReplyResult: {
      sent: true,
      readbackConfirmed: true,
      completed_work_key: 'room:1:reply:b'
    },
    followUpRows: [
      { work_key: 'room:1:reply:a', type: 'reply_needed', requires_human_action: true },
      { work_key: 'room:1:reply:b', type: 'reply_needed', requires_human_action: true },
      { work_key: 'trade:1:payment', type: 'payment_check', requires_human_action: true }
    ]
  });

  assert.deepEqual(candidates.map((item) => item.work_key), [
    'room:1:reply:a',
    'trade:1:payment'
  ]);
});

test('one reply obligation uses the real verified send-result contract as a safe fallback', () => {
  const candidates = buildHumanWorkCandidates({
    now: NOW,
    autoReplyResult: {
      sent: true,
      sendResult: { sent: true, reason: 'sent_via_chrome_verified' }
    },
    followUpRows: [
      { work_key: 'room:1:reply', type: 'reply_needed', requires_human_action: true },
      { work_key: 'trade:1:document', type: 'contract_document', requires_human_action: true }
    ]
  });

  assert.deepEqual(candidates.map((item) => item.work_key), ['trade:1:document']);
});

test('one reply obligation accepts the current top-level verified send result only', () => {
  const verified = buildHumanWorkCandidates({
    now: NOW,
    autoReplyResult: { sent: true, reason: 'sent_via_chrome_verified' },
    followUpRows: [
      { work_key: 'room:1:reply', type: 'reply_needed', requires_human_action: true },
      { work_key: 'trade:1:payment', type: 'payment_check', requires_human_action: true }
    ]
  });
  const unverified = buildHumanWorkCandidates({
    now: NOW,
    autoReplyResult: { sent: true, reason: 'send_button_clicked' },
    followUpRows: [
      { work_key: 'room:1:reply', type: 'reply_needed', requires_human_action: true },
      { work_key: 'trade:1:payment', type: 'payment_check', requires_human_action: true }
    ]
  });

  assert.deepEqual(verified.map((item) => item.work_key), ['trade:1:payment']);
  assert.deepEqual(unverified.map((item) => item.work_key), [
    'room:1:reply',
    'trade:1:payment'
  ]);
});

test('a sent reply without authoritative readback does not suppress human work', () => {
  const candidates = buildHumanWorkCandidates({
    now: NOW,
    autoReplyResult: { sent: true, readbackConfirmed: false },
    followUpRows: [{
      work_key: 'room:1:reply', room_key: 'room:1', type: 'reply_needed',
      requires_human_action: true
    }]
  });

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].work_key, 'room:1:reply');
});

test('reviewed payload work keys and reviewed legacy follow-up keys map without name identity', () => {
  const candidates = buildHumanWorkCandidates({
    now: NOW,
    followUpRows: [
      { payload: { work_key: 'room:1:reply', requires_human_action: true } },
      { follow_up_key: 'trade:1:document', type: 'contract_document', requires_human_action: true },
      { type: 'payment_check', requires_human_action: true, payload: { follow_up_key: 'trade:1:payment' } }
    ]
  });

  assert.deepEqual(candidates.map((item) => [item.work_key, item.work_type]), [
    ['room:1:reply', 'human_review'],
    ['trade:1:document', 'contract_document'],
    ['trade:1:payment', 'payment_check']
  ]);
});

test('an arbitrary untyped key-only row is not promoted into human work', () => {
  assert.throws(
    () => buildHumanWorkCandidates({ followUpRows: [{ payload: { work_key: 'audit:1' } }] }),
    /explicit human work type/i
  );
});

test('explicit non-human, terminal, and completed-log rows never become work', () => {
  const candidates = buildHumanWorkCandidates({
    now: NOW,
    followUpRows: [
      { work_key: 'a', type: 'payment_check', requires_human_action: false },
      { work_key: 'b', type: 'tax_invoice', payload: { requires_human_action: false } },
      { work_key: 'c', type: 'damage_repair', status: 'done', requires_human_action: true },
      { work_key: 'd', type: 'reservation_review', state: 'resolved', requires_human_action: true },
      { work_key: 'e', type: 'completed_log', status: 'open', requires_human_action: true },
      { status: 'dismissed', type: 'unknown_historical_type' }
    ]
  });

  assert.deepEqual(candidates, []);
});

test('human-action flags must remain typed booleans', () => {
  assert.throws(
    () => buildHumanWorkCandidates({
      followUpRows: [{ work_key: 'a', type: 'payment_check', requires_human_action: 'false' }]
    }),
    /requires_human_action must be boolean/i
  );
});

test('missing, blank, non-canonical, and name-only keys fail closed', () => {
  assert.throws(
    () => buildHumanWorkCandidates({ followUpRows: [{ type: 'reservation_review', customer_name: '동명이인' }] }),
    /typed work_key/i
  );
  assert.throws(
    () => buildHumanWorkCandidates({ followUpRows: [{ type: 'reservation_review', work_key: '   ' }] }),
    /typed work_key/i
  );
  assert.throws(
    () => buildHumanWorkCandidates({ followUpRows: [{ type: 'reservation_review', work_key: ' room:1 ' }] }),
    /typed work_key/i
  );
  assert.throws(
    () => buildHumanWorkCandidates({ followUpRows: [{ type: 'reservation_review', work_key: 'x'.repeat(501) }] }),
    /typed work_key/i
  );
  assert.throws(
    () => buildHumanWorkCandidates({
      followUpRows: [{ work_key: 'room:1', follow_up_key: 'room:2', type: 'reservation_review' }]
    }),
    /typed work_key is ambiguous/i
  );
});

test('same-name people remain separate when their explicit stable keys differ', () => {
  const candidates = buildHumanWorkCandidates({
    now: NOW,
    followUpRows: [
      { work_key: 'trade:1:payment', type: 'payment_check', customer_name: '동명이인' },
      { work_key: 'trade:2:payment', type: 'payment_check', customer_name: '동명이인' }
    ]
  });

  assert.deepEqual(candidates.map((item) => item.work_key), ['trade:1:payment', 'trade:2:payment']);
  assert.doesNotMatch(JSON.stringify(candidates), /동명이인/);
});

test('candidate output is bounded, table-shaped, JSON-safe, and payload-allowlisted', () => {
  const candidate = buildHumanWorkCandidates({
    now: NOW,
    job: { source_event_key: 'event-job' },
    followUpRows: [{
      work_key: 'trade:1:invoice',
      source_event_key: 'event-row',
      source_event_keys: ['event-z', 'event-row'],
      room_key: 'room:1',
      type: 'tax_invoice',
      priority: 'high',
      title: 'T'.repeat(400),
      summary: 'S'.repeat(2500),
      owner_id: 'UOWNER',
      recommended_action: 'Issue only after authoritative review.',
      customer_name: 'PRIVATE CUSTOMER',
      payload: {
        requires_human_action: true,
        action_family: 'invoice_issue',
        business_key: 'trade:1',
        follow_up_route: 'settlement',
        alert_level: 'none',
        p0_acknowledged_at: '2026-08-29T05:00:00.000Z',
        raw_message: 'PRIVATE RAW MESSAGE',
        customer_secret: 'PRIVATE SECRET',
        evidence: ['PRIVATE EVIDENCE']
      }
    }]
  })[0];

  assert.equal(candidate.title.length, 300);
  assert.equal(candidate.summary.length, 2000);
  assert.equal(candidate.priority, 'urgent');
  assert.deepEqual(candidate.source_event_keys, ['event-job', 'event-row', 'event-z']);
  assert.deepEqual(candidate.payload, {
    requires_human_action: true,
    action_family: 'invoice_issue',
    business_key: 'trade:1',
    follow_up_route: 'settlement',
    alert_level: 'none',
    recommended_action: 'Issue only after authoritative review.'
  });
  assert.equal(candidate.created_at, '2026-08-29T06:00:00.000Z');
  assert.equal(candidate.first_opened_at, '2026-08-29T06:00:00.000Z');
  assert.doesNotThrow(() => JSON.stringify(candidate));
  assert.doesNotMatch(JSON.stringify(candidate), /PRIVATE/);
  assert.deepEqual(Object.keys(candidate).sort(), [
    'actionable_at', 'automation_state', 'consecutive_unhandled_digests', 'created_at',
    'digest_inclusion_count', 'due_at', 'first_opened_at', 'last_activity_at',
    'last_digest_at', 'next_reminder_at', 'owner_id', 'payload', 'pending_action',
    'priority', 'resolution_evidence', 'resolution_kind', 'resolved_at', 'resolved_by',
    'room_key', 'snoozed_until', 'source_event_keys', 'state', 'summary', 'title',
    'updated_at', 'version', 'work_key', 'work_type'
  ]);
});

test('unsupported typed work and state values fail closed', () => {
  assert.throws(
    () => buildHumanWorkCandidates({ followUpRows: [{ work_key: 'x', type: 'invented_business_judgment' }] }),
    /unsupported human work type/i
  );
  assert.throws(
    () => buildHumanWorkCandidates({ followUpRows: [{ work_key: 'x', type: 'payment_check', status: 'mystery' }] }),
    /invalid human work state/i
  );
});

test('exact-key merge preserves age, increments version, and deterministically deduplicates source keys', () => {
  const existing = activeItem({ source_event_keys: ['event-b', 'event-a'] });
  const incoming = activeItem({
    id: undefined,
    source_event_keys: ['event-c', 'event-a'],
    title: 'Updated payment review',
    last_activity_at: '2026-08-29T05:00:00.000Z',
    created_at: '2026-08-29T05:00:00.000Z',
    first_opened_at: '2026-08-29T05:00:00.000Z',
    version: 1
  });

  const merged = mergeWorkItem(existing, incoming, NOW);

  assert.equal(merged.version, 5);
  assert.deepEqual(merged.source_event_keys, ['event-a', 'event-b', 'event-c']);
  assert.equal(merged.title, 'Updated payment review');
  assert.equal(merged.created_at, EARLIER);
  assert.equal(merged.first_opened_at, EARLIER);
  assert.equal(merged.digest_inclusion_count, 2);
  assert.equal(merged.consecutive_unhandled_digests, 2);
});

test('merge requires the exact work key and never reopens a terminal row', () => {
  assert.throws(
    () => mergeWorkItem(activeItem(), activeItem({ work_key: 'room:2:payment' }), NOW),
    /exact work_key/i
  );
  assert.throws(
    () => mergeWorkItem(activeItem({ state: 'resolved' }), activeItem(), NOW),
    /terminal work item/i
  );
  assert.throws(
    () => mergeWorkItem(activeItem({ state: 'dismissed' }), activeItem(), NOW),
    /terminal work item/i
  );
});

test('lower-priority stale merge cannot erase P0, overdue, owner, acknowledgement, or action metadata', () => {
  const existing = activeItem({
    priority: 'p0',
    due_at: '2026-08-28T05:00:00.000Z',
    owner_id: 'UOWNER',
    last_activity_at: '2026-08-29T05:30:00.000Z',
    pending_action: { type: 'resolve', status: 'pending', requested_at: '2026-08-29T05:00:00.000Z' },
    payload: {
      requires_human_action: true,
      action_family: 'payment_reconcile',
      recommended_action: 'Preserve this action.',
      p0_acknowledged_at: '2026-08-29T05:15:00.000Z'
    }
  });
  const incoming = activeItem({
    priority: 'low',
    due_at: null,
    owner_id: null,
    title: 'Stale title',
    summary: '',
    last_activity_at: '2026-08-29T04:00:00.000Z',
    pending_action: {},
    payload: { requires_human_action: true, recommended_action: '' }
  });

  const merged = mergeWorkItem(existing, incoming, NOW);

  assert.equal(merged.priority, 'p0');
  assert.equal(merged.due_at, '2026-08-28T05:00:00.000Z');
  assert.equal(merged.owner_id, 'UOWNER');
  assert.equal(merged.title, 'Payment review');
  assert.deepEqual(merged.pending_action, existing.pending_action);
  assert.equal(merged.payload.recommended_action, 'Preserve this action.');
  assert.equal(merged.payload.p0_acknowledged_at, '2026-08-29T05:15:00.000Z');
});

test('new typed activity cannot forge a P0 acknowledgement', () => {
  const existing = activeItem({ priority: 'p0' });
  const incoming = activeItem({
    priority: 'p0',
    last_activity_at: '2026-08-29T05:30:00.000Z',
    payload: {
      requires_human_action: true,
      p0_acknowledged_at: '2026-08-29T05:29:00.000Z'
    }
  });

  const merged = mergeWorkItem(existing, incoming, NOW);

  assert.equal(merged.payload.p0_acknowledged_at, undefined);
});

test('merge clears an expired snooze without resetting original age', () => {
  const existing = activeItem({
    state: 'snoozed',
    snoozed_until: '2026-08-29T05:59:59.000Z',
    actionable_at: '2026-08-29T05:59:59.000Z'
  });

  const merged = mergeWorkItem(existing, activeItem({ last_activity_at: '2026-08-29T05:00:00.000Z' }), NOW);

  assert.equal(merged.state, 'open');
  assert.equal(merged.snoozed_until, null);
  assert.equal(merged.actionable_at, '2026-08-29T06:00:00.000Z');
  assert.equal(merged.created_at, EARLIER);
  assert.equal(merged.first_opened_at, EARLIER);
});

test('merge preserves a future snooze and original age', () => {
  const existing = activeItem({
    state: 'snoozed',
    snoozed_until: '2026-08-29T09:00:00.000Z',
    actionable_at: '2026-08-29T09:00:00.000Z'
  });

  const merged = mergeWorkItem(existing, activeItem({ priority: 'low' }), NOW);

  assert.equal(merged.state, 'snoozed');
  assert.equal(merged.snoozed_until, '2026-08-29T09:00:00.000Z');
  assert.equal(merged.first_opened_at, EARLIER);
});

test('a fresh non-P0 to P0 escalation wakes a future snooze immediately', () => {
  const existing = activeItem({
    state: 'snoozed',
    priority: 'normal',
    snoozed_until: '2026-08-29T09:00:00.000Z',
    actionable_at: '2026-08-29T09:00:00.000Z',
    last_activity_at: '2026-08-29T05:00:00.000Z'
  });
  const incoming = activeItem({
    priority: 'p0',
    last_activity_at: '2026-08-29T05:30:00.000Z'
  });

  const merged = mergeWorkItem(existing, incoming, NOW);

  assert.equal(merged.priority, 'p0');
  assert.equal(merged.state, 'open');
  assert.equal(merged.snoozed_until, null);
  assert.equal(merged.actionable_at, '2026-08-29T06:00:00.000Z');
  assert.equal(merged.created_at, EARLIER);
  assert.equal(merged.first_opened_at, EARLIER);
});

test('an already-P0 acknowledged item is not broadly woken without a new escalation', () => {
  const existing = activeItem({
    state: 'snoozed',
    priority: 'p0',
    snoozed_until: '2026-08-29T09:00:00.000Z',
    actionable_at: '2026-08-29T09:00:00.000Z',
    payload: {
      requires_human_action: true,
      p0_acknowledged_at: '2026-08-29T04:00:00.000Z'
    }
  });

  const merged = mergeWorkItem(existing, activeItem({ priority: 'p0' }), NOW);

  assert.equal(merged.state, 'snoozed');
  assert.equal(merged.snoozed_until, '2026-08-29T09:00:00.000Z');
  assert.equal(merged.actionable_at, '2026-08-29T09:00:00.000Z');
});

test('an unacknowledged existing P0 cannot remain hidden by a future snooze', () => {
  const existing = activeItem({
    state: 'snoozed',
    priority: 'p0',
    snoozed_until: '2026-08-29T09:00:00.000Z',
    actionable_at: '2026-08-29T09:00:00.000Z',
    payload: { requires_human_action: true }
  });

  const merged = mergeWorkItem(existing, activeItem({ priority: 'p0' }), NOW);

  assert.equal(merged.state, 'open');
  assert.equal(merged.snoozed_until, null);
  assert.equal(merged.actionable_at, '2026-08-29T06:00:00.000Z');
  assert.equal(merged.first_opened_at, EARLIER);
});

test('actions require the exact current version and an active state', () => {
  assert.throws(
    () => applyWorkAction(activeItem(), { type: 'progress', expectedVersion: 3 }, NOW),
    /stale work version/i
  );
  assert.throws(
    () => applyWorkAction(activeItem({ state: 'resolved' }), { type: 'progress', expectedVersion: 4 }, NOW),
    /terminal work item/i
  );
  assert.throws(
    () => applyWorkAction(activeItem({ state: 'dismissed' }), { type: 'progress', expectedVersion: 4 }, NOW),
    /terminal work item/i
  );
});

test('progress wakes an item without changing its original age', () => {
  const result = applyWorkAction(activeItem({
    state: 'snoozed',
    snoozed_until: '2026-08-29T09:00:00.000Z',
    actionable_at: '2026-08-29T09:00:00.000Z'
  }), { type: 'progress', expectedVersion: 4 }, NOW);

  assert.equal(result.item.state, 'in_progress');
  assert.equal(result.item.snoozed_until, null);
  assert.equal(result.item.actionable_at, '2026-08-29T06:00:00.000Z');
  assert.equal(result.item.first_opened_at, EARLIER);
  assert.equal(result.item.version, 5);
  assert.equal(result.requestedLocalOperation, null);
});

test('snooze must end in the future and preserves the original age', () => {
  assert.throws(
    () => applyWorkAction(activeItem(), {
      type: 'snooze', expectedVersion: 4, snoozedUntil: '2026-08-29T06:00:00.000Z'
    }, NOW),
    /snooze must end in the future/i
  );
  assert.throws(
    () => applyWorkAction(activeItem(), {
      type: 'snooze', expectedVersion: 4, snoozedUntil: 'not-a-date'
    }, NOW),
    /snooze must end in the future/i
  );

  const result = applyWorkAction(activeItem(), {
    type: 'snooze', expectedVersion: 4, snoozedUntil: '2026-08-29T09:00:00.000Z'
  }, NOW);
  assert.equal(result.item.state, 'snoozed');
  assert.equal(result.item.snoozed_until, '2026-08-29T09:00:00.000Z');
  assert.equal(result.item.actionable_at, '2026-08-29T09:00:00.000Z');
  assert.equal(result.item.first_opened_at, EARLIER);
});

test('P0 acknowledgement never resolves the item and is rejected for non-P0 work', () => {
  assert.throws(
    () => applyWorkAction(activeItem(), { type: 'ack_p0', expectedVersion: 4 }, NOW),
    /P0 work item/i
  );

  const result = applyWorkAction(
    activeItem({ priority: 'p0' }),
    { type: 'ack_p0', expectedVersion: 4 },
    NOW
  );
  assert.equal(result.item.state, 'open');
  assert.equal(result.item.payload.p0_acknowledged_at, '2026-08-29T06:00:00.000Z');
  assert.equal(result.item.resolved_at, null);
  assert.equal(result.item.version, 5);
});

test('repeated P0 acknowledgement preserves the first acknowledgement timestamp', () => {
  const result = applyWorkAction(activeItem({
    priority: 'p0',
    payload: {
      requires_human_action: true,
      p0_acknowledged_at: '2026-08-29T05:00:00.000Z'
    }
  }), { type: 'ack_p0', expectedVersion: 4 }, NOW);

  assert.equal(result.item.payload.p0_acknowledged_at, '2026-08-29T05:00:00.000Z');
  assert.equal(result.item.version, 5);
  assert.equal(result.item.state, 'open');
});

test('malformed P0 acknowledgement metadata does not unlock hide actions', () => {
  assert.throws(
    () => applyWorkAction(activeItem({
      priority: 'p0',
      payload: { requires_human_action: true, p0_acknowledged_at: 'not-a-date' }
    }), {
      type: 'snooze', expectedVersion: 4, snoozedUntil: '2026-08-29T09:00:00.000Z'
    }, NOW),
    /acknowledge P0/i
  );
});

test('unacknowledged P0 work cannot be hidden by snooze or dismissal', () => {
  const item = activeItem({ priority: 'p0' });
  assert.throws(
    () => applyWorkAction(item, {
      type: 'snooze', expectedVersion: 4, snoozedUntil: '2026-08-29T09:00:00.000Z'
    }, NOW),
    /acknowledge P0/i
  );
  assert.throws(
    () => applyWorkAction(item, { type: 'dismiss', expectedVersion: 4, requestedBy: 'UOWNER' }, NOW),
    /acknowledge P0/i
  );
});

test('request_resolve records a pending request and local operation without resolving', () => {
  const result = applyWorkAction(activeItem(), {
    type: 'request_resolve', expectedVersion: 4, requestedBy: 'UOWNER'
  }, NOW);

  assert.equal(result.item.state, 'open');
  assert.equal(result.item.resolved_at, null);
  assert.equal(result.item.resolution_kind, null);
  assert.deepEqual(result.item.pending_action, {
    type: 'resolve',
    status: 'pending',
    requested_at: '2026-08-29T06:00:00.000Z',
    requested_by: 'UOWNER'
  });
  assert.deepEqual(result.requestedLocalOperation, {
    type: 'resolve',
    workItemId: UUID,
    expectedVersion: 5
  });
});

test('dismissal is terminal and records bounded audit metadata', () => {
  const result = applyWorkAction(activeItem(), {
    type: 'dismiss', expectedVersion: 4, requestedBy: 'UOWNER'
  }, NOW);

  assert.equal(result.item.state, 'dismissed');
  assert.equal(result.item.resolution_kind, 'dismissed');
  assert.equal(result.item.resolved_at, '2026-08-29T06:00:00.000Z');
  assert.equal(result.item.resolved_by, 'UOWNER');
  assert.equal(result.item.version, 5);
});

test('only the finite work action allowlist is accepted', () => {
  assert.deepEqual(WORK_ACTIONS, ['progress', 'snooze', 'ack_p0', 'request_resolve', 'dismiss']);
  assert.throws(
    () => applyWorkAction(activeItem(), { type: 'auto_refund', expectedVersion: 4 }, NOW),
    /invalid work action/i
  );
});

test('work action codec round-trips strict bounded base64url values', () => {
  const fixtures = [
    { id: UUID, version: 4, action: { type: 'progress' } },
    { id: UUID, version: 4, action: { type: 'snooze', snoozedUntil: '2026-08-29T09:00:00.000Z' } },
    { id: UUID, version: 4, action: { type: 'ack_p0' } },
    { id: UUID, version: 4, action: { type: 'request_resolve' } },
    { id: UUID, version: 4, action: { type: 'dismiss' } }
  ];

  for (const fixture of fixtures) {
    const encoded = encodeWorkActionValue(fixture);
    assert.match(encoded, /^[A-Za-z0-9_-]+$/);
    assert.ok(encoded.length <= 1000);
    assert.deepEqual(decodeWorkActionValue(encoded), fixture);
  }
});

test('work action codec rejects malformed, oversized, extra, and unsafe payloads', () => {
  const invalidValues = [
    '',
    '%%%not-base64url%%%',
    'a'.repeat(1001),
    Buffer.from('{bad json').toString('base64url'),
    Buffer.from(JSON.stringify({ id: UUID, version: 4, action: { type: 'progress' }, extra: true })).toString('base64url'),
    Buffer.from(JSON.stringify({ id: 'not-a-uuid', version: 4, action: { type: 'progress' } })).toString('base64url'),
    Buffer.from(JSON.stringify({ id: UUID, version: 0, action: { type: 'progress' } })).toString('base64url'),
    Buffer.from(JSON.stringify({ id: UUID, version: 4, action: { type: 'auto_refund' } })).toString('base64url'),
    Buffer.from(JSON.stringify({ id: UUID, version: 4, action: { type: 'progress', secret: 'PRIVATE-VALUE' } })).toString('base64url'),
    Buffer.from(JSON.stringify({ id: UUID, version: 4, action: { type: 'snooze' } })).toString('base64url')
  ];

  for (const value of invalidValues) {
    assert.throws(() => decodeWorkActionValue(value), (error) => {
      assert.equal(error.message, 'invalid work action value');
      assert.doesNotMatch(error.message, /PRIVATE-VALUE|auto_refund|not-a-uuid/);
      return true;
    });
  }

  assert.throws(
    () => encodeWorkActionValue({ id: UUID, version: 4, action: { type: 'dismiss', reason: 'PRIVATE-VALUE' } }),
    (error) => {
      assert.equal(error.message, 'invalid work action value');
      assert.doesNotMatch(error.message, /PRIVATE-VALUE/);
      return true;
    }
  );
});
