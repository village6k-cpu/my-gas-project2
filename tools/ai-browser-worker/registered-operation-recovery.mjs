// A failed tool call is not replay authority. Only an operation-bound GAS
// preflight result proves that the AI can correct its input without duplicating a write.
export const MAX_REGISTERED_INPUT_CORRECTIONS = 2;

export function isProvenUnappliedRegisteredReceipt(receipt) {
  const details = receipt?.error?.details;
  return receipt?.schema === 'village-registered-reservation-change-receipt/v1'
    && receipt.status === 'blocked' && receipt.authoritative_result === null
    && Array.isArray(receipt.applied_stages) && receipt.applied_stages.length === 0
    && receipt.error?.code === 'gas_rejected'
    && details?.code === 'REGISTERED_CORRECTION_PREFLIGHT_REJECTED'
    && details.noMutationPerformed === true && Boolean(receipt.operation_id)
    && details.operationId === receipt.operation_id && details.tradeId === receipt.trade_id
    && details.attemptedStage === 'preflight'
    && Array.isArray(details.appliedStages) && details.appliedStages.length === 0;
}

export function effectiveRegisteredOperationReceipts(receipts, isExactReceipt) {
  if (!Array.isArray(receipts)) return [];
  const registered = receipts.filter((receipt) => receipt?.schema === 'village-registered-reservation-change-receipt/v1');
  if (registered.length < 2 || registered.length > MAX_REGISTERED_INPUT_CORRECTIONS + 1) return receipts;
  const latest = registered.at(-1);
  const prior = registered.slice(0, -1);
  const unique = (field) => new Set(registered.map((receipt) => receipt[field])).size === registered.length;
  if (!registered.every(isExactReceipt) || !unique('operation_id') || !unique('request_digest') || !unique('receipt_id')
    || !prior.every((receipt) => isProvenUnappliedRegisteredReceipt(receipt)
      && receipt.trade_id === latest.trade_id && Boolean(receipt.lease_id) && receipt.lease_id === latest.lease_id
      && Date.parse(receipt.created_at) <= Date.parse(latest.created_at))) return receipts;
  // Keep all receipts on disk/in the audit trail; only the final corrected action
  // participates in business-result reconciliation.
  return receipts.filter((receipt) => !prior.includes(receipt));
}
