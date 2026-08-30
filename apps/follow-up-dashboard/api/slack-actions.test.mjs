import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';

import { encodeWorkActionValue } from '../../../tools/work-orchestrator-v2/work-items.mjs';
import { decodeWorkActionContext, encodeWorkActionContext } from '../../../tools/work-orchestrator-v2/work-actions.mjs';

import {
  verifySlackSignature,
  parseSlackPayload,
  parseActionIntent,
  buildEditSendModal,
  buildWorkSnoozeModal,
  handleV2BlockAction,
  handleV2ViewSubmission,
  parseV2ActionIntent,
  requestWorkItemActionV2
} from './slack-actions.js';
import slackActionsHandler from './slack-actions.js';

const WORK_ID = '11111111-1111-4111-8111-111111111111';
const NOW = '2026-08-30T06:00:00.000Z';

function canonicalValue(action, version = 4) {
  return encodeWorkActionValue({ id: WORK_ID, version, action });
}

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

test('v2 action ids map only to exact canonical work action types', async (t) => {
  const cases = [
    ['village_work_v2_progress', { type: 'progress' }],
    ['village_work_v2_snooze_3h', { type: 'snooze', snoozedUntil: '2026-08-30T09:00:00.000Z' }],
    ['village_work_v2_snooze_evening', { type: 'snooze', snoozedUntil: '2026-08-30T10:00:00.000Z' }],
    ['village_work_v2_snooze_tomorrow', { type: 'snooze', snoozedUntil: '2026-08-31T00:00:00.000Z' }],
    ['village_work_v2_ack_p0', { type: 'ack_p0' }],
    ['village_work_v2_request_resolve', { type: 'request_resolve' }],
    ['village_work_v2_dismiss', { type: 'dismiss' }]
  ];
  for (const [actionId, action] of cases) {
    await t.test(actionId, () => {
      assert.deepEqual(parseV2ActionIntent({ action_id: actionId, value: canonicalValue(action) }, NOW), {
        kind: 'request', id: WORK_ID, expectedVersion: 4, action
      });
    });
  }

  assert.throws(() => parseV2ActionIntent({
    action_id: 'village_work_v2_progress', value: canonicalValue({ type: 'dismiss' })
  }, NOW), { message: 'invalid work action request' });
  assert.throws(() => parseV2ActionIntent({
    action_id: 'village_work_v2_progress',
    value: Buffer.from(JSON.stringify({ id: WORK_ID, version: 4, action: { type: 'progress' }, extra: true })).toString('base64url')
  }, NOW), { message: 'invalid work action request' });
  assert.throws(() => parseV2ActionIntent({ action_id: 'village_work_v2_progress', value: 'malformed' }, NOW), {
    message: 'invalid work action request'
  });
});

test('custom snooze click accepts only canonical id/version context and builds a bounded modal', () => {
  const context = encodeWorkActionContext({ id: WORK_ID, version: 8 });
  const intent = parseV2ActionIntent({ action_id: 'village_work_v2_snooze_custom', value: context }, NOW);
  assert.deepEqual(intent, { kind: 'custom_snooze', id: WORK_ID, expectedVersion: 8, context });

  const modal = buildWorkSnoozeModal(context);
  assert.equal(modal.callback_id, 'village_work_v2_snooze_custom_submit');
  assert.equal(modal.private_metadata, context);
  assert.equal(modal.blocks[0].block_id, 'snooze_until_block');
  assert.equal(modal.blocks[0].element.action_id, 'snoozed_until_iso');
  assert.ok(JSON.stringify(modal).length < 3000);

  assert.throws(() => parseV2ActionIntent({
    action_id: 'village_work_v2_snooze_custom', value: canonicalValue({ type: 'progress' })
  }, NOW), { message: 'invalid work action request' });
});

test('custom snooze block handler opens only the bounded context modal and does not request a database action', async () => {
  const context = encodeWorkActionContext({ id: WORK_ID, version: 8 });
  const opened = [];
  const result = await handleV2BlockAction({
    type: 'block_actions', user: { id: 'UOWNER1' }, trigger_id: 'trigger-1',
    actions: [{ action_id: 'village_work_v2_snooze_custom', value: context }]
  }, {
    now: NOW,
    requestAction: async () => assert.fail('custom click must not request an action before submission'),
    openView: async (payload) => { opened.push(payload); }
  });
  assert.deepEqual(result, { text: '날짜 지정 미루기 창을 열었습니다.' });
  assert.equal(opened.length, 1);
  assert.equal(opened[0].trigger_id, 'trigger-1');
  assert.equal(opened[0].view.private_metadata, context);
  assert.deepEqual(decodeWorkActionContext(opened[0].view.private_metadata), { id: WORK_ID, version: 8 });
  assert.equal(JSON.stringify(opened[0]).includes('snoozedUntil'), false);
});

test('service-role work action request sends exact RPC body/auth and validates applied and stale responses', async () => {
  const requests = [];
  const action = { type: 'progress' };
  const pending = {
    type: 'progress', action, status: 'pending', requested_at: NOW,
    requested_by: 'UOWNER1', expected_version: 4
  };
  const responses = [
    { applied: true, row: { id: WORK_ID, version: 5, state: 'open', pending_action: pending } },
    { applied: false, row: null }
  ];
  const fetchImpl = async (url, init) => {
    requests.push({ url, init });
    return { ok: true, status: 200, text: async () => JSON.stringify(responses.shift()) };
  };
  const input = { id: WORK_ID, expectedVersion: 4, action, requestedBy: 'UOWNER1' };
  assert.deepEqual(await requestWorkItemActionV2(input, {
    env: { SUPABASE_URL: 'https://supabase.example/', SUPABASE_SERVICE_ROLE_KEY: 'service-secret' }, fetchImpl
  }), { applied: true });
  assert.deepEqual(await requestWorkItemActionV2(input, {
    env: { SUPABASE_URL: 'https://supabase.example/', SUPABASE_SERVICE_ROLE_KEY: 'service-secret' }, fetchImpl
  }), { applied: false });

  assert.equal(requests[0].url, 'https://supabase.example/rest/v1/rpc/request_work_item_action_v2');
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.headers.apikey, 'service-secret');
  assert.equal(requests[0].init.headers.authorization, 'Bearer service-secret');
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    p_id: WORK_ID,
    p_expected_version: 4,
    p_action: { type: 'progress' },
    p_requested_by: 'UOWNER1'
  });
});

test('service-role request rejects malformed responses and transport detail without leaking secrets', async () => {
  const env = { SUPABASE_URL: 'https://supabase.example', SUPABASE_SERVICE_ROLE_KEY: 'service-secret' };
  const malformed = async () => ({
    ok: true, status: 200, text: async () => JSON.stringify({ applied: true, row: { secret: 'customer-content' } })
  });
  await assert.rejects(
    requestWorkItemActionV2({ id: WORK_ID, expectedVersion: 4, action: { type: 'progress' }, requestedBy: 'UOWNER1' }, { env, fetchImpl: malformed }),
    (error) => error.message === 'work action request failed'
      && !error.message.includes('service-secret') && !error.message.includes('customer-content')
  );
});

test('signed v2 block handler requires bounded Slack identity and returns content-free stale response', async () => {
  const calls = [];
  const requestAction = async (input) => {
    calls.push(input);
    return { applied: false };
  };
  const payload = {
    type: 'block_actions',
    user: { id: 'UOWNER1' },
    actions: [{ action_id: 'village_work_v2_request_resolve', value: canonicalValue({ type: 'request_resolve' }) }]
  };
  const result = await handleV2BlockAction(payload, { now: NOW, requestAction });
  assert.deepEqual(calls, [{
    id: WORK_ID, expectedVersion: 4, action: { type: 'request_resolve' },
    requestedBy: 'UOWNER1', now: NOW
  }]);
  assert.deepEqual(result, {
    response_type: 'ephemeral', replace_original: false,
    text: '이미 변경된 항목입니다. 최신 다이제스트에서 다시 시도해 주세요.'
  });
  assert.equal(JSON.stringify(result).includes(WORK_ID), false);

  await assert.rejects(handleV2BlockAction({ ...payload, user: { id: '<!channel>' } }, { now: NOW, requestAction }), {
    message: 'invalid work action request'
  });
});

test('custom snooze modal submission accepts exact future UTC-ms only and rejects stale/past/malformed generically', async () => {
  const context = encodeWorkActionContext({ id: WORK_ID, version: 4 });
  const submission = (value) => ({
    type: 'view_submission', user: { id: 'UOWNER1' },
    view: {
      callback_id: 'village_work_v2_snooze_custom_submit', private_metadata: context,
      state: { values: { snooze_until_block: { snoozed_until_iso: { type: 'plain_text_input', value } } } }
    }
  });
  const calls = [];
  assert.deepEqual(await handleV2ViewSubmission(submission('2026-08-30T09:30:00.000Z'), {
    now: NOW,
    requestAction: async (input) => { calls.push(input); return { applied: true }; }
  }), { response_action: 'clear' });
  assert.deepEqual(calls[0], {
    id: WORK_ID, expectedVersion: 4,
    action: { type: 'snooze', snoozedUntil: '2026-08-30T09:30:00.000Z' },
    requestedBy: 'UOWNER1', now: NOW
  });

  const genericError = {
    response_action: 'errors',
    errors: { snooze_until_block: '입력값을 처리할 수 없습니다. 최신 다이제스트에서 다시 시도해 주세요.' }
  };
  for (const value of [NOW, '2026-08-30T09:30:00Z', 'not-a-time']) {
    assert.deepEqual(await handleV2ViewSubmission(submission(value), { now: NOW, requestAction: async () => ({ applied: true }) }), genericError);
  }
  assert.deepEqual(await handleV2ViewSubmission(submission('2026-08-30T09:30:00.000Z'), {
    now: NOW, requestAction: async () => ({ applied: false })
  }), genericError);
});

test('default v2 route verifies the raw Slack signature before the service-role RPC and never resolves request_resolve', async () => {
  const originalEnv = {
    signing: process.env.SLACK_SIGNING_SECRET,
    url: process.env.SUPABASE_URL,
    key: process.env.SUPABASE_SERVICE_ROLE_KEY
  };
  const originalFetch = globalThis.fetch;
  const signingSecret = 'signing-secret';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const payload = {
    type: 'block_actions', user: { id: 'UOWNER1' },
    actions: [{
      action_id: 'village_work_v2_request_resolve',
      value: canonicalValue({ type: 'request_resolve' })
    }]
  };
  const rawBody = `payload=${encodeURIComponent(JSON.stringify(payload))}`;
  const signature = `v0=${crypto.createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`;
  const response = () => {
    const result = { headers: {} };
    result.setHeader = (name, value) => { result.headers[name] = value; };
    result.end = (body) => { result.body = JSON.parse(body); };
    return result;
  };
  const request = (signed) => {
    const req = Readable.from([rawBody]);
    req.method = 'POST';
    req.headers = {
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': signed
    };
    return req;
  };
  let fetchCalls = 0;
  try {
    process.env.SLACK_SIGNING_SECRET = signingSecret;
    process.env.SUPABASE_URL = 'https://supabase.example';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-secret';
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          applied: true,
          row: {
            id: WORK_ID,
            version: 5,
            state: 'open',
            pending_action: {
              type: 'request_resolve', action: { type: 'request_resolve' }, status: 'pending',
              requested_at: new Date().toISOString(), requested_by: 'UOWNER1', expected_version: 4
            }
          }
        })
      };
    };

    const rejected = response();
    await slackActionsHandler(request('v0=invalid'), rejected);
    assert.equal(rejected.statusCode, 401);
    assert.equal(fetchCalls, 0);

    const accepted = response();
    await slackActionsHandler(request(signature), accepted);
    assert.equal(accepted.statusCode, 200);
    assert.equal(fetchCalls, 1);
    assert.deepEqual(accepted.body, {
      text: '요청을 접수했습니다. 로컬 처리 결과 전까지 완료로 간주하지 않습니다.'
    });
  } finally {
    globalThis.fetch = originalFetch;
    if (originalEnv.signing === undefined) delete process.env.SLACK_SIGNING_SECRET;
    else process.env.SLACK_SIGNING_SECRET = originalEnv.signing;
    if (originalEnv.url === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = originalEnv.url;
    if (originalEnv.key === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = originalEnv.key;
  }
});
