import { notificationReceiptInput } from './contracts.mjs';

export async function recordShadowNotificationObligation({ event, config, store } = {}) {
  if (!config?.shadowWrites) return { skipped: true, reason: 'shadow_disabled' };

  try {
    if (!store || typeof store.claimNotificationReceipt !== 'function') {
      throw new Error('shadow store unavailable');
    }
    return await store.claimNotificationReceipt(notificationReceiptInput(event));
  } catch {
    return {
      skipped: false,
      created: false,
      error: 'shadow_receipt_store_failed'
    };
  }
}
