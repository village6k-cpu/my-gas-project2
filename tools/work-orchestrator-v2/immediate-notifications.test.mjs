import assert from 'node:assert/strict';
import test from 'node:test';

const immediateModule = await import('./immediate-notifications.mjs').catch(() => ({}));
const { buildImmediateNotice, ensureImmediateNotification } = immediateModule;

const fixedNow = new Date('2026-08-29T00:02:00.000Z');
const clientMessageId = 'b1d33dc4-d1f9-550b-a345-1525035f5e45';
const event = {
  source: 'kakao_channel_manager_dom',
  sourceEventKey: 'event-1',
  sourceMessageId: 'message-1',
  roomKey: 'chat:1',
  receivedAt: '2026-08-29T00:00:00.000Z',
  customerName: '홍길동',
  messagePreview: '대여 문의'
};
const config = { inboxChannelId: 'CINBOX', mentionUserIds: ['UOWNER1'] };

function receipt(overrides = {}) {
  return {
    id: 'receipt-1',
    source_event_key: 'event-1',
    notification_state: 'pending',
    delivery_attempts: 0,
    client_message_id: clientMessageId,
    urgency: 'normal',
    created_at: '2026-08-29T00:00:00.000Z',
    last_delivery_error: null,
    ...overrides
  };
}

function createStore({
  initial = receipt(),
  claimCreated = true,
  claimDeliveryResult,
  markDeliveredResult,
  markFailedResult
} = {}) {
  let row = { ...initial };
  const calls = {
    receiptInputs: [],
    deliveryClaims: [],
    reads: [],
    delivered: [],
    failed: []
  };

  return {
    calls,
    get row() { return { ...row }; },
    async claimNotificationReceipt(input) {
      calls.receiptInputs.push(structuredClone(input));
      return { created: claimCreated, row: { ...row } };
    },
    async claimNotificationDelivery(input) {
      calls.deliveryClaims.push({ ...input });
      if (claimDeliveryResult !== undefined) {
        return typeof claimDeliveryResult === 'function'
          ? claimDeliveryResult({ row: { ...row }, input, setRow: (next) => { row = { ...next }; } })
          : claimDeliveryResult;
      }
      if (
        !['pending', 'failed'].includes(row.notification_state)
        || row.delivery_attempts !== input.expectedDeliveryAttempts
        || row.delivery_attempts >= 3
      ) return { applied: false, row: null };
      row = {
        ...row,
        notification_state: 'delivering',
        delivery_attempts: row.delivery_attempts + 1,
        last_delivery_error: null
      };
      return { applied: true, row: { ...row } };
    },
    async getNotificationByEventKey(sourceEventKey) {
      calls.reads.push(sourceEventKey);
      return { ...row };
    },
    async markNotificationDelivered(input) {
      calls.delivered.push({ ...input });
      if (markDeliveredResult instanceof Error) throw markDeliveredResult;
      if (markDeliveredResult !== undefined) return markDeliveredResult;
      if (row.notification_state !== 'delivering') return { applied: false, row: null };
      row = {
        ...row,
        notification_state: 'delivered',
        slack_channel_id: input.channelId,
        slack_message_ts: input.messageTs,
        delivered_at: input.deliveredAt,
        last_delivery_error: null
      };
      return { applied: true, row: { ...row } };
    },
    async markNotificationFailed(input) {
      calls.failed.push({ ...input });
      if (markFailedResult instanceof Error) throw markFailedResult;
      if (markFailedResult !== undefined) return markFailedResult;
      if (row.notification_state !== 'delivering') return { applied: false, row: null };
      row = { ...row, notification_state: 'failed', last_delivery_error: input.failureCode };
      return { applied: true, row: { ...row } };
    }
  };
}

function createSlack({
  postResult = { ok: true, channel: 'CINBOX', ts: '100.1', message: {} },
  postError,
  historyResult = null,
  historyError
} = {}) {
  const posts = [];
  const searches = [];
  return {
    posts,
    searches,
    async postMessage(input) {
      posts.push(structuredClone(input));
      if (postError) throw postError;
      return postResult;
    },
    async findMessageByClientId(input) {
      searches.push({ ...input });
      if (historyError) throw historyError;
      return historyResult;
    }
  };
}

function now() {
  return new Date(fixedNow);
}

function isTypedError(code, kind) {
  return (error) => error?.name === 'ImmediateNotificationError'
    && error.code === code
    && error.kind === kind;
}

test('a new receipt claims, posts once with the exact client ID, and persists delivery', async () => {
  const store = createStore();
  const slack = createSlack();

  const result = await ensureImmediateNotification({ event, config, store, slack, now });

  assert.equal(result.status, 'delivered');
  assert.equal(result.receipt.notification_state, 'delivered');
  assert.equal(result.receipt.slack_channel_id, 'CINBOX');
  assert.equal(result.receipt.slack_message_ts, '100.1');
  assert.equal(result.reconciled, false);
  assert.equal(slack.posts.length, 1);
  assert.equal(slack.posts[0].clientMsgId, clientMessageId);
  assert.deepEqual(store.calls.deliveryClaims, [{ id: 'receipt-1', expectedDeliveryAttempts: 0 }]);
});

test('a delivered duplicate posts and searches zero times', async () => {
  const store = createStore({ initial: receipt({ notification_state: 'delivered', delivery_attempts: 1 }) });
  const slack = createSlack();

  const result = await ensureImmediateNotification({ event, config, store, slack, now });

  assert.equal(result.status, 'delivered');
  assert.equal(result.receipt.notification_state, 'delivered');
  assert.equal(result.delivery, null);
  assert.equal(slack.posts.length, 0);
  assert.equal(slack.searches.length, 0);
  assert.equal(store.calls.deliveryClaims.length, 0);
});

test('two concurrent pending calls produce one delivery owner and expose the losing CAS', async () => {
  const store = createStore();
  const slack = createSlack();

  const settled = await Promise.allSettled([
    ensureImmediateNotification({ event, config, store, slack, now }),
    ensureImmediateNotification({ event, config, store, slack, now })
  ]);

  assert.equal(settled.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(settled.filter(({ status }) => status === 'rejected').length, 1);
  assert.equal(settled.find(({ status }) => status === 'fulfilled').value.status, 'delivered');
  assert.equal(settled.find(({ status }) => status === 'rejected').reason.code, 'claim_conflict');
  assert.equal(slack.posts.length, 1);
});

test('an exhausted failed receipt returns a typed exhausted result without claiming or posting', async () => {
  const store = createStore({ initial: receipt({ notification_state: 'failed', delivery_attempts: 3 }) });
  const slack = createSlack();

  await assert.rejects(
    ensureImmediateNotification({ event, config, store, slack, now }),
    isTypedError('attempts_exhausted', 'exhausted')
  );
  assert.equal(store.calls.deliveryClaims.length, 0);
  assert.equal(slack.posts.length, 0);
});

test('a failed receipt below the cap claims its exact observed attempt and posts once', async () => {
  const store = createStore({
    initial: receipt({ notification_state: 'failed', delivery_attempts: 1, last_delivery_error: 'post_rejected' })
  });
  const slack = createSlack();

  const result = await ensureImmediateNotification({ event, config, store, slack, now });

  assert.equal(result.status, 'delivered');
  assert.equal(result.receipt.delivery_attempts, 2);
  assert.equal(result.receipt.last_delivery_error, null);
  assert.deepEqual(store.calls.deliveryClaims, [{ id: 'receipt-1', expectedDeliveryAttempts: 1 }]);
  assert.equal(slack.posts.length, 1);
});

test('a delivering receipt reconciles an exact history match without posting', async () => {
  const store = createStore({ initial: receipt({ notification_state: 'delivering', delivery_attempts: 1 }) });
  const match = { client_msg_id: clientMessageId, ts: '100.2' };
  const slack = createSlack({ historyResult: match });

  const result = await ensureImmediateNotification({ event, config, store, slack, now });

  assert.equal(result.status, 'delivered');
  assert.equal(result.reconciled, true);
  assert.equal(result.delivery, match);
  assert.equal(slack.posts.length, 0);
  assert.deepEqual(slack.searches, [{
    channel: 'CINBOX',
    clientMsgId: clientMessageId,
    oldest: (Date.parse('2026-08-29T00:00:00.000Z') - 300_000) / 1000,
    latest: (fixedNow.getTime() + 300_000) / 1000
  }]);
  assert.equal(store.row.notification_state, 'delivered');
  assert.equal(store.row.slack_message_ts, '100.2');
});

test('a delivering receipt with no history match fails unconfirmed without posting in the same call', async () => {
  const store = createStore({ initial: receipt({ notification_state: 'delivering', delivery_attempts: 1 }) });
  const slack = createSlack({ historyResult: null });

  await assert.rejects(
    ensureImmediateNotification({ event, config, store, slack, now }),
    isTypedError('history_no_match', 'unconfirmed')
  );
  assert.equal(slack.posts.length, 0);
  assert.equal(store.row.notification_state, 'failed');
  assert.equal(store.row.last_delivery_error, 'delivery_unconfirmed');
});

test('a delivering receipt stays delivering when history readback fails', async () => {
  const unsafe = 'history response contained customer room event blocks channel client-id and token';
  const store = createStore({ initial: receipt({ notification_state: 'delivering', delivery_attempts: 1 }) });
  const slack = createSlack({ historyError: new Error(unsafe) });

  await assert.rejects(
    ensureImmediateNotification({ event, config, store, slack, now }),
    (error) => isTypedError('history_unavailable', 'unconfirmed')(error) && !error.message.includes(unsafe)
  );
  assert.equal(slack.posts.length, 0);
  assert.equal(store.calls.failed.length, 0);
  assert.equal(store.row.notification_state, 'delivering');
});

test('an ambiguous post reconciles an exact match and never reposts', async () => {
  const ambiguous = Object.assign(new Error('unsafe arbitrary Slack body'), { ambiguous: true });
  const store = createStore();
  const slack = createSlack({
    postError: ambiguous,
    historyResult: { client_msg_id: clientMessageId, ts: '100.3' }
  });

  const result = await ensureImmediateNotification({ event, config, store, slack, now });

  assert.equal(result.status, 'delivered');
  assert.equal(result.reconciled, true);
  assert.equal(slack.posts.length, 1);
  assert.equal(slack.searches.length, 1);
  assert.equal(store.row.slack_message_ts, '100.3');
});

test('an ambiguous post with no history match stores a safe failure and throws typed unconfirmed', async () => {
  const unsafe = 'token customer message room event blocks channel client-id response body';
  const ambiguous = Object.assign(new Error(unsafe), { ambiguous: true });
  const store = createStore();
  const slack = createSlack({ postError: ambiguous, historyResult: null });

  await assert.rejects(
    ensureImmediateNotification({ event, config, store, slack, now }),
    (error) => isTypedError('history_no_match', 'unconfirmed')(error) && !error.message.includes(unsafe)
  );
  assert.equal(slack.posts.length, 1);
  assert.equal(slack.searches.length, 1);
  assert.deepEqual(store.calls.failed, [{ id: 'receipt-1', failureCode: 'delivery_unconfirmed' }]);
  assert.equal(store.row.notification_state, 'failed');
});

test('a definite post rejection stores only a reviewed token and throws no Slack content', async () => {
  const unsafe = 'token customer message room event blocks channel client-id response body';
  const rejected = Object.assign(new Error(unsafe), { ambiguous: false });
  const store = createStore();
  const slack = createSlack({ postError: rejected });

  await assert.rejects(
    ensureImmediateNotification({ event, config, store, slack, now }),
    (error) => isTypedError('post_rejected', 'failed')(error)
      && !error.message.includes(unsafe)
      && error.cause === undefined
  );
  assert.equal(slack.posts.length, 1);
  assert.equal(slack.searches.length, 0);
  assert.deepEqual(store.calls.failed, [{ id: 'receipt-1', failureCode: 'post_rejected' }]);
  assert.equal(store.row.last_delivery_error, 'post_rejected');
});

test('a successful Slack response remains unconfirmed when delivered persistence is empty or throws', async (t) => {
  await t.test('empty CAS', async () => {
    const store = createStore({ markDeliveredResult: { applied: false, row: null } });
    const slack = createSlack();
    await assert.rejects(
      ensureImmediateNotification({ event, config, store, slack, now }),
      isTypedError('delivery_persistence_failed', 'unconfirmed')
    );
    assert.equal(slack.posts.length, 1);
  });

  await t.test('store failure is sanitized', async () => {
    const unsafe = 'service token customer message room event blocks channel client-id response body';
    const store = createStore({ markDeliveredResult: new Error(unsafe) });
    const slack = createSlack();
    await assert.rejects(
      ensureImmediateNotification({ event, config, store, slack, now }),
      (error) => isTypedError('delivery_persistence_failed', 'unconfirmed')(error)
        && !error.message.includes(unsafe)
        && error.cause === undefined
    );
  });
});

test('an empty delivery-claim CAS is observable and never reported as delivered', async () => {
  const store = createStore({
    claimDeliveryResult: { applied: false, row: null }
  });
  const slack = createSlack();

  await assert.rejects(
    ensureImmediateNotification({ event, config, store, slack, now }),
    isTypedError('claim_conflict', 'unconfirmed')
  );
  assert.equal(store.calls.reads.length, 1);
  assert.equal(slack.posts.length, 0);
});

test('buildImmediateNotice escapes Kakao content and emits only validated deduplicated raw mentions', () => {
  const notice = buildImmediateNotice({
    customerName: '<Alice & <!channel>>',
    messagePreview: '<@UINJECT> & <https://evil.example|click>'
  }, {
    mentionUserIds: ['UOWNER1', 'UOWNER1', 'WOWNER2', 'U_BAD', 'U3><!channel>']
  });

  assert.ok(notice.text.includes('<@UOWNER1> <@WOWNER2>'));
  assert.ok(notice.blocks[1].text.text.includes('<@UOWNER1> <@WOWNER2>'));
  assert.ok(notice.text.includes('&lt;Alice &amp; &lt;!channel&gt;&gt;'));
  assert.ok(notice.blocks[1].text.text.includes('&lt;@UINJECT&gt; &amp; &lt;https://evil.example|click&gt;'));
  assert.equal(notice.text.includes('<!channel>'), false);
  assert.equal(notice.text.includes('<@UINJECT>'), false);
  assert.equal(notice.text.includes('<https://evil.example'), false);
  assert.equal(notice.text.includes('U_BAD'), false);
  assert.ok(notice.text.length <= 2900);
  assert.ok(notice.blocks[1].text.text.length <= 2900);
  assert.deepEqual(notice.blocks[0], {
    type: 'header',
    text: { type: 'plain_text', text: '💬 카카오 새 메시지', emoji: true }
  });
});

test('customer urgency text and unreviewed event fields do not override the normal receipt urgency', async () => {
  const store = createStore();
  const slack = createSlack();

  const result = await ensureImmediateNotification({
    event: { ...event, customerName: 'P0 긴급 장애', messagePreview: 'urgent now', urgency: 'p0', trustedAlertLevel: 'p0' },
    config,
    store,
    slack,
    now
  });

  assert.equal(result.receipt.urgency, 'normal');
  assert.equal('urgency' in store.calls.receiptInputs[0], false);
  assert.equal('trustedAlertLevel' in store.calls.receiptInputs[0].payload, false);
});
