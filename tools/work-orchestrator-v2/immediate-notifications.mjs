import { notificationReceiptInput } from './contracts.mjs';

const RECONCILIATION_MARGIN_MS = 5 * 60 * 1000;
const MAX_DELIVERY_ATTEMPTS = 3;
const SLACK_USER_ID = /^[UW][A-Z0-9]{1,79}$/;
const SLACK_TIMESTAMP = /^\d{1,16}\.\d{1,10}$/;
const DETERMINISTIC_CLIENT_MESSAGE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class ImmediateNotificationError extends Error {
  constructor(code, kind = 'unconfirmed') {
    super(kind === 'failed'
      ? 'Immediate notification delivery failed'
      : 'Immediate notification delivery is unconfirmed');
    this.name = 'ImmediateNotificationError';
    this.code = code;
    this.kind = kind;
  }
}

function typedError(code, kind) {
  return new ImmediateNotificationError(code, kind);
}

function escapeSlackText(value, fallback, maxLength) {
  return String(value || fallback)
    .slice(0, maxLength)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('*', '＊')
    .replaceAll('_', '＿')
    .replaceAll('~', '～')
    .replaceAll('`', '｀');
}

function validatedMentions(mentionUserIds) {
  if (!Array.isArray(mentionUserIds)) return '';
  return [...new Set(mentionUserIds.filter((id) => typeof id === 'string' && SLACK_USER_ID.test(id)))]
    .map((id) => `<@${id}>`)
    .join(' ');
}

function validReceipt(row) {
  return row
    && typeof row === 'object'
    && typeof row.id === 'string'
    && typeof row.source_event_key === 'string'
    && typeof row.client_message_id === 'string'
    && typeof row.notification_state === 'string'
    && Number.isInteger(row.delivery_attempts)
    && row.delivery_attempts >= 0;
}

function hasValidClientMessageId(receipt) {
  return DETERMINISTIC_CLIENT_MESSAGE_ID_PATTERN.test(receipt.client_message_id);
}

function validDelivery(delivery) {
  return delivery
    && typeof delivery === 'object'
    && typeof delivery.channel === 'string'
    && delivery.channel.length > 0
    && typeof delivery.ts === 'string'
    && SLACK_TIMESTAMP.test(delivery.ts);
}

function attemptTime(now) {
  let value;
  try {
    value = now();
  } catch {
    throw typedError('clock_unavailable');
  }
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) throw typedError('clock_unavailable');
  return date;
}

function reconciliationWindow(receipt, attemptedAt) {
  const createdAt = Date.parse(receipt.created_at);
  if (Number.isNaN(createdAt)) throw typedError('history_unavailable');
  return {
    oldest: (createdAt - RECONCILIATION_MARGIN_MS) / 1000,
    latest: (attemptedAt.getTime() + RECONCILIATION_MARGIN_MS) / 1000
  };
}

async function persistDelivered({ store, receipt, channelId, messageTs, deliveredAt }) {
  let result;
  try {
    result = await store.markNotificationDelivered({
      id: receipt.id,
      channelId,
      messageTs,
      deliveredAt: deliveredAt.toISOString()
    });
  } catch {
    throw typedError('delivery_persistence_failed');
  }
  if (!result?.applied || !validReceipt(result.row) || result.row.notification_state !== 'delivered') {
    throw typedError('delivery_persistence_failed');
  }
  return result.row;
}

async function persistFailed({ store, receipt, failureCode }) {
  let result;
  try {
    result = await store.markNotificationFailed({ id: receipt.id, failureCode });
  } catch {
    throw typedError('delivery_persistence_failed');
  }
  if (!result?.applied || !validReceipt(result.row) || result.row.notification_state !== 'failed') {
    throw typedError('delivery_persistence_failed');
  }
  return result.row;
}

async function reconcileDelivery({ receipt, config, store, slack, attemptedAt }) {
  const window = reconciliationWindow(receipt, attemptedAt);
  let match;
  try {
    match = await slack.findMessageByClientId({
      channel: config.inboxChannelId,
      clientMsgId: receipt.client_message_id,
      ...window
    });
  } catch {
    throw typedError('history_unavailable');
  }

  if (match?.client_msg_id === receipt.client_message_id) {
    if (typeof match.ts !== 'string' || !SLACK_TIMESTAMP.test(match.ts)) {
      throw typedError('history_unavailable');
    }
    const deliveredReceipt = await persistDelivered({
      store,
      receipt,
      channelId: config.inboxChannelId,
      messageTs: match.ts,
      deliveredAt: attemptTime(() => attemptedAt)
    });
    return {
      status: 'delivered',
      receipt: deliveredReceipt,
      delivery: match,
      reconciled: true
    };
  }

  await persistFailed({ store, receipt, failureCode: 'delivery_unconfirmed' });
  throw typedError('history_no_match');
}

export function buildImmediateNotice(event = {}, { mentionUserIds = [] } = {}) {
  const mentions = validatedMentions(mentionUserIds);
  const customer = escapeSlackText(event.customerName, '고객명 미확인', 200);
  const preview = escapeSlackText(event.messagePreview || event.previewText, '내용 확인 필요', 1000);
  return {
    text: `${mentions ? `${mentions} ` : ''}💬 카카오 새 메시지 · ${customer} · ${preview}`.slice(0, 2900),
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: '💬 카카오 새 메시지', emoji: true }
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `${mentions ? `${mentions}\n` : ''}*${customer}*\n${preview}`.slice(0, 2900)
        }
      }
    ]
  };
}

export async function ensureImmediateNotification({ event, config = {}, store, slack, now = () => new Date() } = {}) {
  let claim;
  try {
    claim = await store.claimNotificationReceipt(notificationReceiptInput(event));
  } catch {
    throw typedError('receipt_persistence_failed');
  }
  const receipt = claim?.row;
  if (!validReceipt(receipt)) throw typedError('receipt_unavailable');
  if (!hasValidClientMessageId(receipt)) throw typedError('receipt_identity_invalid');

  if (receipt.notification_state === 'delivered') {
    return { status: 'delivered', receipt, delivery: null, reconciled: false };
  }

  const attemptedAt = attemptTime(now);
  if (receipt.notification_state === 'delivering') {
    return reconcileDelivery({ receipt, config, store, slack, attemptedAt });
  }

  if (!['pending', 'failed'].includes(receipt.notification_state)) {
    throw typedError('receipt_state_unavailable');
  }
  if (receipt.delivery_attempts >= MAX_DELIVERY_ATTEMPTS) {
    throw typedError('attempts_exhausted', 'exhausted');
  }

  let deliveryClaim;
  try {
    deliveryClaim = await store.claimNotificationDelivery({
      id: receipt.id,
      expectedDeliveryAttempts: receipt.delivery_attempts
    });
  } catch {
    throw typedError('delivery_persistence_failed');
  }
  if (!deliveryClaim?.applied || !validReceipt(deliveryClaim.row)) {
    try {
      await store.getNotificationByEventKey(receipt.source_event_key);
    } catch {
      throw typedError('delivery_persistence_failed');
    }
    throw typedError('claim_conflict');
  }

  const deliveringReceipt = deliveryClaim.row;
  if (deliveringReceipt.notification_state !== 'delivering') {
    throw typedError('claim_conflict');
  }
  if (!hasValidClientMessageId(deliveringReceipt)) {
    throw typedError('receipt_identity_invalid');
  }

  const notice = buildImmediateNotice(event, { mentionUserIds: config.mentionUserIds });
  let delivery;
  try {
    delivery = await slack.postMessage({
      channel: config.inboxChannelId,
      ...notice,
      clientMsgId: deliveringReceipt.client_message_id
    });
  } catch (error) {
    if (error?.ambiguous === true) {
      return reconcileDelivery({ receipt: deliveringReceipt, config, store, slack, attemptedAt });
    }
    await persistFailed({ store, receipt: deliveringReceipt, failureCode: 'post_rejected' });
    throw typedError('post_rejected', 'failed');
  }

  if (!validDelivery(delivery)) {
    return reconcileDelivery({ receipt: deliveringReceipt, config, store, slack, attemptedAt });
  }
  const deliveredReceipt = await persistDelivered({
    store,
    receipt: deliveringReceipt,
    channelId: delivery.channel,
    messageTs: delivery.ts,
    deliveredAt: attemptedAt
  });
  return {
    status: 'delivered',
    receipt: deliveredReceipt,
    delivery,
    reconciled: false
  };
}
