const MAX_EVIDENCE_VALUE_LENGTH = 200;
const ISO_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function typedId(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized && normalized.length <= MAX_EVIDENCE_VALUE_LENGTH ? normalized : null;
}

function typedTimestamp(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return ISO_UTC_TIMESTAMP.test(normalized) ? normalized : null;
}

function typedStatus(value) {
  return value === 'completed' || value === 'failed' ? value : null;
}

function typedEvidence(result, { idFields = [], timestampFields = [], status } = {}) {
  if (!isRecord(result)) return null;

  const evidence = {};
  const id = idFields.map((field) => typedId(result[field])).find(Boolean);
  const timestamp = timestampFields.map((field) => typedTimestamp(result[field])).find(Boolean);
  if (id) evidence.id = id;
  if (timestamp) evidence.timestamp = timestamp;
  if (status) evidence.status = status;
  return Object.keys(evidence).length ? evidence : null;
}

function hasStaleEvidence(...results) {
  return results.some((result) => isRecord(result) && (
    result.stale === true
    || result.isStale === true
    || result.readbackStale === true
    || result.evidenceStatus === 'stale'
  ));
}

function hasContradictoryEvidence({ sheetResult, postActionResult, autoReplyResult, operationReceipt }) {
  if (isRecord(autoReplyResult)
    && autoReplyResult.sent === false
    && autoReplyResult.readbackConfirmed === true) return true;

  if (isRecord(operationReceipt)
    && operationReceipt.state === 'completed'
    && operationReceipt.status === 'failed') return true;

  const completedReadback = isRecord(operationReceipt)
    && operationReceipt.state === 'completed'
    && operationReceipt.authoritativeReadback === true;
  return completedReadback && (
    sheetResult?.success === false || postActionResult?.success === false
  );
}

function result(state, resolutionKind, evidence, noticeText) {
  return { state, resolutionKind, evidence, noticeText };
}

export function deriveAutomationResolution(input = {}) {
  const decision = isRecord(input.decision) ? input.decision : {};
  const sheetResult = isRecord(input.sheetResult) ? input.sheetResult : {};
  const postActionResult = isRecord(input.postActionResult) ? input.postActionResult : {};
  const autoReplyResult = isRecord(input.autoReplyResult) ? input.autoReplyResult : {};
  const operationReceipt = isRecord(input.operationReceipt) ? input.operationReceipt : {};

  const replyEvidence = typedEvidence(autoReplyResult, {
    idFields: ['transportMessageId', 'messageId'],
    timestampFields: ['readbackAt', 'sentAt', 'confirmedAt'],
    status: autoReplyResult.readbackConfirmed === true ? 'readback_confirmed' : null
  });
  const operationEvidence = typedEvidence(operationReceipt, {
    idFields: ['operationId', 'receiptId', 'id'],
    timestampFields: ['readbackAt', 'completedAt'],
    status: typedStatus(operationReceipt.state)
  });
  const sheetEvidence = typedEvidence(sheetResult, {
    idFields: ['operationId', 'sheetOperationId'],
    timestampFields: ['readbackAt', 'completedAt'],
    status: sheetResult.success === true ? 'succeeded' : sheetResult.success === false ? 'failed' : null
  });

  if (decision.requires_owner_approval === true) {
    return result(
      'needs_human',
      'owner_approval_required',
      { ...(operationEvidence && { operationReceipt: operationEvidence }), ...(sheetEvidence && { sheet: sheetEvidence }) },
      'Owner approval is required before this automation can be resolved.'
    );
  }

  if (hasStaleEvidence(sheetResult, postActionResult, autoReplyResult, operationReceipt)) {
    return result(
      'needs_human',
      'stale_evidence',
      { ...(operationEvidence && { operationReceipt: operationEvidence }), ...(replyEvidence && { autoReply: replyEvidence }) },
      'Human review is required because the supplied evidence is stale.'
    );
  }

  if (hasContradictoryEvidence({ sheetResult, postActionResult, autoReplyResult, operationReceipt })) {
    return result(
      'needs_human',
      'contradictory_evidence',
      { ...(operationEvidence && { operationReceipt: operationEvidence }), ...(sheetEvidence && { sheet: sheetEvidence }) },
      'Human review is required because the supplied evidence is contradictory.'
    );
  }

  if (operationReceipt.state === 'failed' && operationReceipt.authoritativeReadback === true) {
    return result(
      'failed',
      'authoritative_failure',
      { ...(operationEvidence && { operationReceipt: operationEvidence }) },
      'The automated operation failed according to authoritative readback.'
    );
  }

  if (autoReplyResult.sent === true
    && autoReplyResult.readbackConfirmed === true
    && typedId(autoReplyResult.transportMessageId)) {
    return result(
      'succeeded',
      'auto_reply_readback',
      { autoReply: replyEvidence },
      'The automated reply was confirmed by authoritative readback.'
    );
  }

  if (sheetResult.success === true
    && operationReceipt.state === 'completed'
    && operationReceipt.authoritativeReadback === true) {
    return result(
      'succeeded',
      'operation_readback',
      { ...(operationEvidence && { operationReceipt: operationEvidence }), ...(sheetEvidence && { sheet: sheetEvidence }) },
      'The automated operation was confirmed by authoritative readback.'
    );
  }

  return result(
    'needs_human',
    'missing_authoritative_readback',
    { ...(operationEvidence && { operationReceipt: operationEvidence }), ...(replyEvidence && { autoReply: replyEvidence }) },
    'Human review is required because authoritative resolution is unavailable.'
  );
}
