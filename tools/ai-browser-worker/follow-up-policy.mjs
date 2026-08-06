import { createHash } from 'node:crypto';

const MANUAL_ACTION_FAMILIES = new Set([
  'invoice_issue',
  'reservation_change',
  'payment_reconcile',
  'inventory_check',
  'document_approval'
]);

export function normalizePolicyKeyPart(value, maxLength = 160) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^0-9a-z가-힣._:/-]+/g, ' ')
    .trim()
    .slice(0, maxLength) || 'unknown';
}

function normalizedCustomer(value) {
  return normalizePolicyKeyPart(value, 80)
    .replace(/\/.*$/, '')
    .replace(/\s+(?:확인|미반납|연락|분실|반납).*$/, '')
    .trim();
}

export function inquiryConversationKey(row = {}) {
  const room = normalizePolicyKeyPart(row.room_key || row.roomKey, 120);
  const customer = normalizedCustomer(row.customer_name || row.customerName);
  if (room === 'unknown' || customer === 'unknown') return '';
  return `inquiry:${room}:${customer}`;
}

export function actionFamilyForFollowUp(row = {}) {
  const payload = row?.payload && typeof row.payload === 'object' ? row.payload : {};
  const required = row.requiresHumanAction
    ?? row.requires_human_action
    ?? payload.requiresHumanAction
    ?? payload.requires_human_action;
  const family = String(row.actionFamily || row.action_family || payload.actionFamily || payload.action_family || '');
  return required === true && MANUAL_ACTION_FAMILIES.has(family) ? family : null;
}

function combinedText(row = {}) {
  return [
    row.title,
    row.summary,
    row.recommended_action || row.recommendedAction,
    ...(Array.isArray(row.evidence) ? row.evidence : []),
    row.payload?.follow_up_task_key
  ].filter(Boolean).join(' ').normalize('NFKC');
}

export function businessObjectKeyForFollowUp(row = {}) {
  const declared = normalizePolicyKeyPart(
    row.businessKey || row.business_key || row.payload?.businessKey || row.payload?.business_key,
    120
  );
  if (declared !== 'unknown') return `business:${declared}`;

  const value = combinedText(row);
  const requestId = value.match(/\bRQ-(\d{6}-\d{3})\b/i)?.[1];
  if (requestId) return `request:RQ-${requestId}`;
  const tradeId = value.match(/\b(\d{6}-\d{3})\b/)?.[1];
  if (tradeId) return `trade:${tradeId}`;

  const explicitTask = normalizePolicyKeyPart(row.payload?.follow_up_task_key, 120);
  return explicitTask === 'unknown' ? '' : `task:${explicitTask}`;
}

export function followUpTaskIdentity(row = {}, caseId = '') {
  const actionFamily = actionFamilyForFollowUp(row);
  const businessObject = businessObjectKeyForFollowUp(row);
  if (!actionFamily || !businessObject || !caseId) return '';
  return `follow-up:${normalizePolicyKeyPart(caseId, 80)}:${businessObject}:${actionFamily}`;
}

function hashJson(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function customerClusterHash(value) {
  const normalized = String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
  return normalized ? hashJson(normalized) : '';
}

export function renderedMessageHash(message = {}) {
  return hashJson({
    text: message.text || '',
    blocks: Array.isArray(message.blocks) ? message.blocks : []
  });
}
