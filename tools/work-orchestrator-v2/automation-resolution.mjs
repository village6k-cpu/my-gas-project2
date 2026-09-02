const MAX_EVIDENCE_IDENTIFIER_LENGTH = 100;
const ISO_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MACHINE_IDENTIFIER = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const AUTO_REPLY_READBACK_RECEIPT = /^reply-readback-[0-9a-f]{64}$/;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function typedMachineIdentifier(value) {
  return typeof value === 'string'
    && value.length <= MAX_EVIDENCE_IDENTIFIER_LENGTH
    && MACHINE_IDENTIFIER.test(value)
    ? value
    : null;
}

function typedAutoReplyReadbackReceipt(value) {
  if (!isRecord(value)) return null;
  const id = typedMachineIdentifier(value.id);
  const timestamp = typedTimestamp(value.confirmedAt);
  if (!id || !AUTO_REPLY_READBACK_RECEIPT.test(id) || !timestamp) return null;
  return { id, timestamp, status: 'readback_confirmed' };
}

function typedOperationId(value) {
  const identifier = typedMachineIdentifier(value);
  return identifier && (UUID.test(identifier)
    || /^(?:operation|registered-operation|op)-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(identifier))
    ? identifier
    : null;
}

function typedReceiptId(value) {
  const identifier = typedMachineIdentifier(value);
  return identifier && (UUID.test(identifier)
    || /^(?:receipt|document-receipt|registered-change-receipt)-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(identifier))
    ? identifier
    : null;
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
  const id = idFields.map(({ field, parse }) => parse(result[field])).find(Boolean);
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
  const replyReceipt = typedAutoReplyReadbackReceipt(autoReplyResult?.readbackReceipt);
  if (isRecord(autoReplyResult)
    && autoReplyResult.sent === false
    && replyReceipt) return true;

  if (isRecord(operationReceipt)
    && ((operationReceipt.state === 'completed' && operationReceipt.status === 'failed')
      || (operationReceipt.state === 'failed' && operationReceipt.status === 'completed'))) return true;

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

  const replyEvidence = typedAutoReplyReadbackReceipt(autoReplyResult.readbackReceipt);
  const operationEvidence = typedEvidence(operationReceipt, {
    idFields: [
      { field: 'operationId', parse: typedOperationId },
      { field: 'receiptId', parse: typedReceiptId }
    ],
    timestampFields: ['readbackAt', 'completedAt'],
    status: typedStatus(operationReceipt.state)
  });
  const sheetEvidence = typedEvidence(sheetResult, {
    idFields: [
      { field: 'operationId', parse: typedOperationId },
      { field: 'sheetOperationId', parse: typedOperationId }
    ],
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
    && replyEvidence) {
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
