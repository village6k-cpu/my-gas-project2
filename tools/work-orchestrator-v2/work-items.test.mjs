import assert from 'node:assert/strict';
import test from 'node:test';
import * as workItems from './work-items.mjs';

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

test('work candidate builder never independently suppresses a reply obligation', () => {
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

  assert.deepEqual(candidates.map((item) => item.work_key), ['room:1:reply', 'trade:1:tax-invoice']);
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

test('raw completed work keys cannot independently suppress classifier-owned work', () => {
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
    'room:1:reply:b',
    'trade:1:payment'
  ]);
});

test('nested verified send reasons cannot independently suppress work', () => {
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

  assert.deepEqual(candidates.map((item) => item.work_key), ['room:1:reply', 'trade:1:document']);
});

test('top-level verified send reasons cannot independently suppress work', () => {
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

  assert.deepEqual(verified.map((item) => item.work_key), [
    'room:1:reply',
    'trade:1:payment'
  ]);
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
    () => buildHumanWorkCandidates({ followUpRows: [{ work_key: 'audit:1', requires_human_action: true }] }),
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

test('only explicit semantic owner actions become work while operational failures stay internal', () => {
  const candidates = buildHumanWorkCandidates({
    now: NOW,
    followUpRows: [
      { work_key: 'trade:implicit', type: 'payment_check' },
      { work_key: 'trade:false', type: 'payment_check', requires_human_action: false },
      { work_key: 'room:error', type: 'automation_error_review', requires_human_action: true },
      { work_key: 'room:timeout', type: 'reservation_review_timeout', requires_human_action: true },
      {
        work_key: 'room:reply',
        type: 'reply_needed',
        requires_human_action: true,
        recommended_action: '고객에게 답변하기'
      }
    ]
  });

  assert.deepEqual(candidates.map((item) => item.work_key), ['room:reply']);
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
    () => buildHumanWorkCandidates({ followUpRows: [{ type: 'reservation_review', customer_name: '동명이인', requires_human_action: true }] }),
    /typed work_key/i
  );
  assert.throws(
    () => buildHumanWorkCandidates({ followUpRows: [{ type: 'reservation_review', work_key: '   ', requires_human_action: true }] }),
    /typed work_key/i
  );
  assert.throws(
    () => buildHumanWorkCandidates({ followUpRows: [{ type: 'reservation_review', work_key: ' room:1 ', requires_human_action: true }] }),
    /typed work_key/i
  );
  assert.throws(
    () => buildHumanWorkCandidates({ followUpRows: [{ type: 'reservation_review', work_key: 'x'.repeat(501), requires_human_action: true }] }),
    /typed work_key/i
  );
  assert.throws(
    () => buildHumanWorkCandidates({
      followUpRows: [{ work_key: 'room:1', follow_up_key: 'room:2', type: 'reservation_review', requires_human_action: true }]
    }),
    /typed work_key is ambiguous/i
  );
});

test('same-name people remain separate when their explicit stable keys differ', () => {
  const candidates = buildHumanWorkCandidates({
    now: NOW,
    followUpRows: [
      { work_key: 'trade:1:payment', type: 'payment_check', customer_name: '동명이인', requires_human_action: true },
      { work_key: 'trade:2:payment', type: 'payment_check', customer_name: '동명이인', requires_human_action: true }
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

test('operational failure rows do not create cleanup-linked owner work', () => {
  const candidates = buildHumanWorkCandidates({
    now: NOW,
    job: {
      eventHash: 'event-job',
      events: [
        { eventHash: 'event-receipt-b' },
        { event_hash: 'event-receipt-a' },
        { source_event_key: 'event-receipt-b' }
      ]
    },
    followUpRows: [{
      work_key: 'room:1:failure',
      source_event_key: 'event-row',
      room_key: 'room:1',
      type: 'automation_error_review',
      requires_human_action: true
    }]
  });

  assert.deepEqual(candidates, []);
});

test('unsupported typed work and state values fail closed', () => {
  assert.throws(
    () => buildHumanWorkCandidates({ followUpRows: [{ work_key: 'x', type: 'invented_business_judgment', requires_human_action: true }] }),
    /unsupported human work type/i
  );
  assert.throws(
    () => buildHumanWorkCandidates({ followUpRows: [{ work_key: 'x', type: 'payment_check', status: 'mystery', requires_human_action: true }] }),
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

test('an at-cutoff P0 acknowledgement is effective and does not broadly wake a snooze', () => {
  const existing = activeItem({
    state: 'snoozed',
    priority: 'p0',
    snoozed_until: '2026-08-29T09:00:00.000Z',
    actionable_at: '2026-08-29T09:00:00.000Z',
    payload: {
      requires_human_action: true,
      p0_acknowledged_at: '2026-08-29T06:00:00.000Z'
    }
  });

  const merged = mergeWorkItem(existing, activeItem({ priority: 'p0' }), NOW);

  assert.equal(merged.state, 'snoozed');
  assert.equal(merged.snoozed_until, '2026-08-29T09:00:00.000Z');
  assert.equal(merged.actionable_at, '2026-08-29T09:00:00.000Z');
});

test('a future P0 acknowledgement is ineffective and cannot suppress snooze wake', () => {
  const existing = activeItem({
    state: 'snoozed',
    priority: 'p0',
    snoozed_until: '2026-08-29T09:00:00.000Z',
    actionable_at: '2026-08-29T09:00:00.000Z',
    payload: {
      requires_human_action: true,
      p0_acknowledged_at: '2026-08-29T06:00:00.001Z'
    }
  });

  const merged = mergeWorkItem(existing, activeItem({ priority: 'p0' }), NOW);

  assert.equal(merged.state, 'open');
  assert.equal(merged.snoozed_until, null);
  assert.equal(merged.actionable_at, '2026-08-29T06:00:00.000Z');
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
      p0_acknowledged_at: '2026-08-29T06:00:00.000Z'
    }
  }), { type: 'ack_p0', expectedVersion: 4 }, NOW);

  assert.equal(result.item.payload.p0_acknowledged_at, '2026-08-29T06:00:00.000Z');
  assert.equal(result.item.version, 5);
  assert.equal(result.item.state, 'open');
});

test('future P0 acknowledgement metadata cannot authorize snooze or dismissal', () => {
  const item = activeItem({
    priority: 'p0',
    payload: {
      requires_human_action: true,
      p0_acknowledged_at: '2026-08-29T06:00:00.001Z'
    }
  });
  assert.throws(() => applyWorkAction(item, {
    type: 'snooze', expectedVersion: 4, snoozedUntil: '2026-08-29T09:00:00.000Z'
  }, NOW), /acknowledge P0/i);
  assert.throws(
    () => applyWorkAction(item, { type: 'dismiss', expectedVersion: 4, requestedBy: 'UOWNER' }, NOW),
    /acknowledge P0/i
  );
});

test('ack_p0 replaces a future acknowledgement with the supplied action time', () => {
  const result = applyWorkAction(activeItem({
    priority: 'p0',
    payload: {
      requires_human_action: true,
      p0_acknowledged_at: '2026-08-29T06:00:00.001Z'
    }
  }), { type: 'ack_p0', expectedVersion: 4 }, NOW);

  assert.equal(result.item.payload.p0_acknowledged_at, '2026-08-29T06:00:00.000Z');
});

test('P0 hide actions accept only canonical millisecond UTC acknowledgements in years 0001 through 9999', async (t) => {
  const cases = [
    ['missing payload', undefined, NOW, false],
    ['null payload', null, NOW, false],
    ['non-record payload', 'not-a-record', NOW, false],
    ['array payload', [], NOW, false],
    ['missing acknowledgement', { requires_human_action: true }, NOW, false],
    ['null acknowledgement', { p0_acknowledged_at: null }, NOW, false],
    ['array acknowledgement', { p0_acknowledged_at: [] }, NOW, false],
    ['malformed acknowledgement', { p0_acknowledged_at: 'not-a-time' }, NOW, false],
    ['impossible calendar date', { p0_acknowledged_at: '2026-02-30T00:00:00.000Z' }, NOW, false],
    ['year zero', { p0_acknowledged_at: '0000-01-01T00:00:00.000Z' }, NOW, false],
    ['negative extended year', { p0_acknowledged_at: '-000001-01-01T00:00:00.000Z' }, NOW, false],
    ['positive extended year', { p0_acknowledged_at: '+010000-01-01T00:00:00.000Z' }, '+010001-01-01T00:00:00.000Z', false],
    ['minimum supported year', { p0_acknowledged_at: '0001-01-01T00:00:00.000Z' }, NOW, true],
    ['normal past acknowledgement', { p0_acknowledged_at: '2026-08-29T05:59:59.999Z' }, NOW, true],
    ['normal boundary acknowledgement', { p0_acknowledged_at: '2026-08-29T06:00:00.000Z' }, NOW, true],
    ['normal future acknowledgement', { p0_acknowledged_at: '2026-08-29T06:00:00.001Z' }, NOW, false],
    ['maximum supported year', { p0_acknowledged_at: '9999-12-31T23:59:59.999Z' }, '9999-12-31T23:59:59.999Z', true]
  ];

  for (const [name, payload, cutoff, effective] of cases) {
    await t.test(name, () => {
      const run = () => applyWorkAction(activeItem({ priority: 'p0', payload }), {
        type: 'dismiss', expectedVersion: 4, requestedBy: 'UOWNER'
      }, cutoff);
      if (effective) {
        assert.equal(run().item.state, 'dismissed');
      } else {
        assert.throws(run, /acknowledge P0/i);
      }
    });
  }
});

test('ack_p0 rejects operation clocks that cannot produce an effective acknowledgement', async (t) => {
  for (const clock of [
    '0000-01-01T00:00:00.000Z',
    '-000001-01-01T00:00:00.000Z',
    '+010000-01-01T00:00:00.000Z'
  ]) {
    await t.test(clock, () => {
      assert.throws(
        () => applyWorkAction(
          activeItem({ priority: 'p0' }),
          { type: 'ack_p0', expectedVersion: 4 },
          clock
        ),
        (error) => error.message === 'invalid work action' && !error.message.includes(clock)
      );
    });
  }
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

test('v2 P0 reminder uses 10m exponential retries, a 1h cap, and a three-attempt limit', async (t) => {
  const base = activeItem({
    priority: 'p0',
    first_opened_at: '2026-08-29T06:00:00.000Z',
    payload: { requires_human_action: true }
  });
  const cases = [
    ['before initial interval', base, '2026-08-29T06:09:59.999Z', 3, { due: false, reason: 'interval' }],
    ['first attempt', base, '2026-08-29T06:10:00.000Z', 3, { due: true, attempt: 1 }],
    ['second attempt before 20m', activeItem({
      priority: 'p0', payload: { requires_human_action: true, p0_delivery: {
        status: 'delivered', generation: 1, attempt: 1,
        client_message_id: '11111111-2222-5333-8444-555555555555',
        delivered_at: '2026-08-29T06:10:00.000Z', next_at: '2026-08-29T06:30:00.000Z',
        readback: { channel_id: 'CP0', message_ts: '100.1', confirmed_at: '2026-08-29T06:10:00.000Z' }
      } } }), '2026-08-29T06:29:59.999Z', 3, { due: false, reason: 'interval' }],
    ['second attempt at 20m', activeItem({
      priority: 'p0', payload: { requires_human_action: true, p0_delivery: {
        status: 'delivered', generation: 1, attempt: 1,
        client_message_id: '11111111-2222-5333-8444-555555555555',
        delivered_at: '2026-08-29T06:10:00.000Z', next_at: '2026-08-29T06:30:00.000Z',
        readback: { channel_id: 'CP0', message_ts: '100.1', confirmed_at: '2026-08-29T06:10:00.000Z' }
      } } }), '2026-08-29T06:30:00.000Z', 3, { due: true, attempt: 2 }],
    ['definite failure before retry time', activeItem({
      priority: 'p0', payload: { requires_human_action: true, p0_delivery: {
        status: 'retry_pending', generation: 1, attempt: 1,
        client_message_id: '11111111-2222-5333-8444-555555555555',
        last_attempt_at: '2026-08-29T06:10:00.000Z', next_at: '2026-08-29T06:20:00.000Z'
      } } }), '2026-08-29T06:19:59.999Z', 3, { due: false, reason: 'interval' }],
    ['definite failure retries at its durable time', activeItem({
      priority: 'p0', payload: { requires_human_action: true, p0_delivery: {
        status: 'retry_pending', generation: 1, attempt: 1,
        client_message_id: '11111111-2222-5333-8444-555555555555',
        last_attempt_at: '2026-08-29T06:10:00.000Z', next_at: '2026-08-29T06:20:00.000Z'
      } } }), '2026-08-29T06:20:00.000Z', 3, { due: true, attempt: 2 }],
    ['one-hour cap', activeItem({
      priority: 'p0', payload: { requires_human_action: true, p0_delivery: {
        status: 'delivered', generation: 6, attempt: 6,
        client_message_id: '11111111-2222-5333-8444-555555555555',
        delivered_at: '2026-08-29T06:10:00.000Z', next_at: '2026-08-29T07:10:00.000Z',
        readback: { channel_id: 'CP0', message_ts: '100.1', confirmed_at: '2026-08-29T06:10:00.000Z' }
      } } }), '2026-08-29T07:10:00.000Z', 10, { due: true, attempt: 7 }],
    ['attempt limit', activeItem({
      priority: 'p0', payload: { requires_human_action: true, p0_delivery: {
        status: 'delivered', generation: 3, attempt: 3,
        client_message_id: '11111111-2222-5333-8444-555555555555',
        delivered_at: '2026-08-29T06:10:00.000Z', next_at: '2026-08-29T06:50:00.000Z',
        readback: { channel_id: 'CP0', message_ts: '100.1', confirmed_at: '2026-08-29T06:10:00.000Z' }
      } } }), '2026-08-29T09:00:00.000Z', 3, { due: false, reason: 'max_attempts' }]
  ];

  for (const [name, item, now, maxAttempts, expected] of cases) {
    await t.test(name, () => {
      const decision = workItems.v2P0ReminderDecision(item, { now, maxAttempts });
      assert.equal(decision.due, expected.due);
      if (expected.reason) assert.equal(decision.reason, expected.reason);
      if (expected.attempt) assert.equal(decision.attempt, expected.attempt);
      if (name === 'one-hour cap') assert.equal(decision.dueAt, '2026-08-29T07:10:00.000Z');
    });
  }
});

test('v2 P0 review round 2 reconciliation decisions honor durable retry and lease expiry', () => {
  const clientId = '11111111-2222-5333-8444-555555555555';
  const baseDelivery = {
    generation: 1,
    attempt: 1,
    client_message_id: clientId,
    claimed_at: '2026-08-29T05:50:00.000Z',
    claim_expires_at: '2026-08-29T05:52:00.000Z',
    last_attempt_at: '2026-08-29T05:51:00.000Z',
    next_at: '2026-08-29T06:10:00.000Z'
  };
  const pending = activeItem({
    priority: 'p0',
    payload: { requires_human_action: true, p0_delivery: { ...baseDelivery, status: 'reconcile_pending' } }
  });
  assert.deepEqual(
    workItems.v2P0ReminderDecision(pending, { now: '2026-08-29T06:09:59.999Z' }),
    { due: false, reason: 'interval', dueAt: '2026-08-29T06:10:00.000Z', cleanupEligible: false }
  );
  assert.equal(
    workItems.v2P0ReminderDecision(pending, { now: '2026-08-29T06:10:00.000Z' }).reconcile,
    true
  );

  const reconciling = activeItem({
    priority: 'p0',
    payload: { requires_human_action: true, p0_delivery: {
      ...baseDelivery,
      status: 'reconciling',
      reconcile_owner: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      reconcile_token: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      reconcile_claimed_at: '2026-08-29T06:10:00.000Z',
      reconcile_expires_at: '2026-08-29T06:12:00.000Z'
    } }
  });
  assert.deepEqual(
    workItems.v2P0ReminderDecision(reconciling, { now: '2026-08-29T06:11:59.999Z' }),
    { due: false, reason: 'reconciling', cleanupEligible: false }
  );
  const expired = workItems.v2P0ReminderDecision(reconciling, { now: '2026-08-29T06:12:00.000Z' });
  assert.equal(expired.reconcile, true);
  assert.equal(expired.generation, 1);
  assert.equal(expired.clientMessageId, clientId);
});

test('v2 P0 canonical acknowledgement stops separate alerts but leaves the unresolved item active', async (t) => {
  for (const [name, acknowledgement, reason] of [
    ['effective acknowledgement', '2026-08-29T06:00:00.000Z', 'acknowledged'],
    ['future acknowledgement', '2026-08-29T06:00:00.001Z', 'due'],
    ['malformed acknowledgement', 'not-a-time', 'due']
  ]) {
    await t.test(name, () => {
      const item = activeItem({
        priority: 'p0',
        first_opened_at: '2026-08-29T05:00:00.000Z',
        payload: { requires_human_action: true, p0_acknowledged_at: acknowledgement }
      });
      const decision = workItems.v2P0ReminderDecision(item, { now: NOW });
      assert.equal(decision.reason, reason);
      assert.equal(item.state, 'open');
    });
  }
});

test('v2 P0 terminal work stops all alerts and acknowledgement gates cleanup', () => {
  const unacknowledged = activeItem({ priority: 'p0', first_opened_at: '2026-08-29T05:00:00.000Z' });
  assert.equal(workItems.v2P0ReminderDecision(unacknowledged, { now: NOW }).cleanupEligible, false);
  assert.deepEqual(
    workItems.v2P0ReminderDecision(activeItem({ ...unacknowledged, state: 'resolved' }), { now: NOW }),
    { due: false, reason: 'terminal', cleanupEligible: false }
  );
  assert.equal(workItems.v2P0ReminderDecision(activeItem({
    priority: 'p0', payload: { requires_human_action: true, p0_acknowledged_at: NOW.toISOString() }
  }), { now: NOW }).cleanupEligible, true);
});

test('v2 P0 claim is deterministic for one generation and carries exact version-generation CAS', () => {
  const item = activeItem({
    priority: 'p0', version: 17, first_opened_at: '2026-08-29T05:00:00.000Z',
    payload: { requires_human_action: true }
  });
  const first = workItems.buildV2P0DeliveryClaim(item, { now: NOW, claimTtlMs: 120_000 });
  const retry = workItems.buildV2P0DeliveryClaim(item, { now: NOW, claimTtlMs: 120_000 });

  assert.deepEqual(first, retry);
  assert.equal(first.expectedVersion, 17);
  assert.equal(first.expectedGeneration, 0);
  assert.equal(first.generation, 1);
  assert.equal(first.attempt, 1);
  assert.match(first.clientMessageId, /^[0-9a-f-]{36}$/);
  assert.equal(first.claimExpiresAt, '2026-08-29T06:02:00.000Z');
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
