import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  verifySlackSignature,
  parseSlackPayload,
  parseActionIntent,
  buildEditSendModal
} from './slack-actions.js';

test('verifySlackSignature accepts current Slack signatures and rejects stale ones', () => {
  const signingSecret = 'secret';
  const rawBody = 'payload=%7B%22type%22%3A%22block_actions%22%7D';
  const timestamp = '1711111111';
  const signature = `v0=${crypto.createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;

  assert.equal(verifySlackSignature({
    rawBody,
    timestamp,
    signature,
    signingSecret,
    nowMs: 1711111111_000
  }), true);
  assert.equal(verifySlackSignature({
    rawBody,
    timestamp,
    signature,
    signingSecret,
    nowMs: 1711112111_000
  }), false);
});

test('parseSlackPayload reads urlencoded interactive payloads', () => {
  const parsed = parseSlackPayload('payload=' + encodeURIComponent(JSON.stringify({ type: 'block_actions', actions: [{ action_id: 'x' }] })));
  assert.equal(parsed.type, 'block_actions');
  assert.equal(parsed.actions[0].action_id, 'x');
});

test('parseActionIntent maps status, send, and edit-send buttons', () => {
  assert.deepEqual(parseActionIntent({ action_id: 'village_followup_status_done', value: 'abc' }), {
    kind: 'status',
    followUpId: 'abc',
    status: 'done'
  });
  assert.deepEqual(parseActionIntent({ action_id: 'village_followup_send', value: 'abc' }), {
    kind: 'send',
    followUpId: 'abc'
  });
  assert.deepEqual(parseActionIntent({ action_id: 'village_followup_edit_send', value: 'abc' }), {
    kind: 'edit_send',
    followUpId: 'abc'
  });
});

test('buildEditSendModal keeps follow-up id and initial draft', () => {
  const modal = buildEditSendModal({
    id: 'follow-1',
    customer_name: '최재원',
    title: '예약 가능 문의',
    suggested_reply_draft: '확인해보니 예약 가능하십니다.'
  });

  assert.equal(modal.callback_id, 'village_followup_edit_send_submit');
  assert.equal(modal.private_metadata, 'follow-1');
  assert.equal(modal.blocks[1].element.initial_value, '확인해보니 예약 가능하십니다.');
});
