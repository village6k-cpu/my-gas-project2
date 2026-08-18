import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildFollowUpCaseLifecycle,
  mergeFollowUpCaseLifecycle,
  applyFollowUpCaseAction,
  validateFollowUpCaseAction
} from './follow-up-case-lifecycle.mjs';

test('human actions become ordered steps in one follow-up case', () => {
  const lifecycle = buildFollowUpCaseLifecycle({
    conversationKey: 'inquiry:chat-1:?ㅼ쁺以',
    rows: [
      { follow_up_key: 'invoice', recommended_action: '?멸툑怨꾩궛?쒕? 諛쒗뻾?섏꽭??', payload: { action_family: 'invoice_issue', business_object_key: 'trade:260729-001' } },
      { follow_up_key: 'reservation', recommended_action: '?덉빟 ?쇱젙???섏젙?섏꽭??', payload: { action_family: 'reservation_change', business_object_key: 'trade:260729-001' } }
    ],
    requiresReply: true
  });
  assert.equal(lifecycle.owner_channel, 'follow_up');
  assert.equal(lifecycle.phase, 'internal_action');
  assert.equal(lifecycle.steps.length, 2);
  assert.deepEqual(lifecycle.steps.map((step) => step.status), ['pending', 'pending']);
});

test('reply-only input creates an inquiry reply phase', () => {
  const lifecycle = buildFollowUpCaseLifecycle({ conversationKey: 'inquiry:chat-2:?띻만??', rows: [], requiresReply: true });
  assert.equal(lifecycle.owner_channel, 'inquiry');
  assert.equal(lifecycle.phase, 'customer_reply');
});

test('step completion advances to reply without changing ownership', () => {
  const initial = buildFollowUpCaseLifecycle({
    conversationKey: 'inquiry:chat-1:?ㅼ쁺以',
    rows: [{ follow_up_key: 'invoice', recommended_action: '諛쒗뻾', payload: { action_family: 'invoice_issue' } }],
    requiresReply: true
  });
  const result = applyFollowUpCaseAction(initial, 'village_followup_step_done', { expectedStateVersion: 1 });
  assert.equal(result.payload.owner_channel, 'follow_up');
  assert.equal(result.payload.phase, 'customer_reply');
  assert.equal(result.rowStatus, 'in_progress');
  assert.equal(result.payload.state_version, 2);
});

test('two step completion advances one step at a time without changing ownership', () => {
  const initial = buildFollowUpCaseLifecycle({
    conversationKey: 'inquiry:chat-two-step',
    rows: [
      { follow_up_key: 'invoice', recommended_action: 'issue invoice', payload: { action_family: 'invoice_issue' } },
      { follow_up_key: 'reservation', recommended_action: 'change reservation', payload: { action_family: 'reservation_change' } }
    ],
    requiresReply: true
  });
  const first = applyFollowUpCaseAction(initial, 'village_followup_step_done', { expectedStateVersion: 1 });
  assert.equal(first.payload.owner_channel, 'follow_up');
  assert.equal(first.payload.phase, 'internal_action');
  assert.equal(first.payload.state_version, 2);
  assert.deepEqual(first.payload.steps.map((step) => step.status), ['done', 'pending']);

  const second = applyFollowUpCaseAction(first.payload, 'village_followup_step_done', { expectedStateVersion: 2 });
  assert.equal(second.payload.owner_channel, 'follow_up');
  assert.equal(second.payload.phase, 'customer_reply');
  assert.equal(second.payload.state_version, 3);
  assert.deepEqual(second.payload.steps.map((step) => step.status), ['done', 'done']);
});

test('replayed step action with an old state version is rejected while work remains', () => {
  const initial = buildFollowUpCaseLifecycle({
    conversationKey: 'inquiry:chat-1:?ㅼ쁺以',
    rows: [
      { follow_up_key: 'invoice', recommended_action: '諛쒗뻾', payload: { action_family: 'invoice_issue' } },
      { follow_up_key: 'reservation', recommended_action: '수정', payload: { action_family: 'reservation_change' } }
    ],
    requiresReply: false
  });
  const advanced = applyFollowUpCaseAction(initial, 'village_followup_step_done', { expectedStateVersion: 1 });
  assert.throws(
    () => applyFollowUpCaseAction(advanced.payload, 'village_followup_step_done', { expectedStateVersion: 1 }),
    /stale state version/i
  );
});

test('step completion rejects a phase other than internal_action', () => {
  const replyOnly = buildFollowUpCaseLifecycle({ requiresReply: true });
  assert.throws(
    () => applyFollowUpCaseAction(replyOnly, 'village_followup_step_done', { expectedStateVersion: 1 }),
    /internal_action/i
  );
});

test('merge preserves immutable inquiry ownership when late internal work arrives', () => {
  const existing = buildFollowUpCaseLifecycle({
    conversationKey: 'inquiry:chat-immutable',
    requiresReply: true
  });
  const incoming = buildFollowUpCaseLifecycle({
    conversationKey: 'inquiry:chat-immutable',
    rows: [{ follow_up_key: 'invoice', payload: { action_family: 'invoice_issue' } }],
    requiresReply: true
  });
  const merged = mergeFollowUpCaseLifecycle(existing, incoming);
  assert.equal(merged.owner_channel, 'inquiry');
  assert.equal(merged.phase, 'internal_action');
});

test('merge keeps incoming decision content while preserving only case identity delivery and completed steps', () => {
  const existing = {
    case_id: 'case-established',
    case_key: 'case:established',
    owner_channel: 'inquiry',
    state_version: 5,
    latest_customer_message_cluster: 'old customer request',
    ai_judgment: 'old judgment',
    core_facts: ['old fact'],
    requires_reply: false,
    steps: [{ step_key: 'invoice', action: 'old action', status: 'done' }],
    slack_delivery: { status: 'delivered', channel_id: 'C1', message_ts: '10.1' },
    critical_delivery: { status: 'delivered', attempt: 2, last_sent_at: '2026-08-18T00:00:00.000Z' },
    stale_internal_note: 'must not survive'
  };
  const incoming = {
    case_id: 'case-temporary',
    case_key: 'case:temporary',
    owner_channel: 'follow_up',
    state_version: 1,
    latest_customer_message_cluster: 'new customer request',
    ai_judgment: 'new judgment',
    core_facts: ['new fact'],
    requires_reply: true,
    steps: [{ step_key: 'invoice', action: 'new action', status: 'pending' }]
  };

  const merged = mergeFollowUpCaseLifecycle(existing, incoming, {
    existingContent: { suggested_reply_draft: 'old draft', recommended_action: 'old action' },
    incomingContent: { suggested_reply_draft: 'new draft', recommended_action: 'new action' }
  });

  assert.equal(merged.case_id, 'case-established');
  assert.equal(merged.case_key, 'case:established');
  assert.equal(merged.owner_channel, 'inquiry');
  assert.deepEqual(merged.slack_delivery, existing.slack_delivery);
  assert.deepEqual(merged.critical_delivery, existing.critical_delivery);
  assert.equal(merged.latest_customer_message_cluster, 'new customer request');
  assert.equal(merged.ai_judgment, 'new judgment');
  assert.deepEqual(merged.core_facts, ['new fact']);
  assert.equal(merged.requires_reply, true);
  assert.deepEqual(merged.steps, [{ step_key: 'invoice', action: 'new action', status: 'done' }]);
  assert.equal(merged.stale_internal_note, undefined);
  assert.equal(merged.state_version, 6);
});

test('an unacknowledged p0 alert stays active until the case is closed', () => {
  const existing = {
    case_key: 'case:p0',
    state_version: 1,
    owner_channel: 'follow_up',
    phase: 'internal_action',
    requires_reply: false,
    steps: [{ step_key: 'inspect', action: 'inspect', status: 'pending' }],
    alert_level: 'p0',
    alert_reason: '즉시 확인 필요'
  };
  const incoming = {
    ...existing,
    alert_level: 'none',
    alert_reason: ''
  };
  const merged = mergeFollowUpCaseLifecycle(existing, incoming);
  assert.equal(merged.alert_level, 'p0');
  assert.equal(merged.alert_reason, '즉시 확인 필요');
});

test('canonical send and status actions require the expected phase and version', () => {
  const internal = {
    owner_channel: 'follow_up', phase: 'internal_action', state_version: 3, requires_reply: true,
    steps: [{ step_key: 'invoice', status: 'pending' }]
  };
  const reply = { ...internal, phase: 'customer_reply', steps: [{ step_key: 'invoice', status: 'done' }] };

  for (const actionId of ['village_followup_status_in_progress', 'village_followup_status_dismissed']) {
    assert.doesNotThrow(() => validateFollowUpCaseAction(internal, actionId, { expectedStateVersion: 3 }));
    assert.throws(() => validateFollowUpCaseAction(reply, actionId, { expectedStateVersion: 3 }), /internal_action/i);
  }
  for (const actionId of ['village_followup_send', 'village_followup_edit_send', 'village_followup_edit_send_submit', 'village_followup_reply_not_needed']) {
    assert.doesNotThrow(() => validateFollowUpCaseAction(reply, actionId, { expectedStateVersion: 3 }));
    assert.throws(() => validateFollowUpCaseAction(internal, actionId, { expectedStateVersion: 3 }), /customer_reply/i);
  }
  assert.throws(() => validateFollowUpCaseAction(reply, 'village_followup_send', { expectedStateVersion: 2 }), /stale state version/i);
});

test('explicitly independent request groups get different case keys', () => {
  const first = buildFollowUpCaseLifecycle({ conversationKey: 'inquiry:chat-1:?ㅼ쁺以', requestGroupKey: 'trade:1', rows: [], requiresReply: true });
  const second = buildFollowUpCaseLifecycle({ conversationKey: 'inquiry:chat-1:?ㅼ쁺以', requestGroupKey: 'trade:2', rows: [], requiresReply: true });
  assert.notEqual(first.case_key, second.case_key);
});
