const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const normalized = value => String(value ?? '').normalize('NFKC').trim();
const periodKey = decision => JSON.stringify(['start_date', 'pickup_time', 'end_date', 'return_time']
  .map(key => normalized(decision?.sheet_row_candidate?.[key])));
const identityKey = decision => JSON.stringify([
  normalized(decision?.sheet_row_candidate?.customer_name),
  normalized(decision?.sheet_row_candidate?.phone).replace(/[\s()+.-]/g, '')
]);
const forbiddenOperation = decision => Boolean(decision?.staff_confirmed_registration
  || decision?.registered_reservation_change
  || decision?.staff_confirmed_mutation?.target_scope === 'registered_trade'
  || decision?.reservation_inquiry?.already_registered === true);

/** Validate only structured model decisions; no conversation interpretation happens here. */
export function validateConfirmationBatchDecision(decision, { validateDecision } = {}) {
  const errors = [];
  const children = decision?.confirmation_requests;
  if (!Array.isArray(children) || children.length < 2 || children.length > 8) {
    return { valid: false, errors: ['confirmation_requests must contain 2..8 complete decisions'] };
  }
  if (forbiddenOperation(decision)) errors.push('batch cannot contain registration or registered-trade mutations');
  const identity = identityKey(children[0]);
  const periods = new Set();
  const requestTargets = new Set();
  children.forEach((child, index) => {
    const prefix = `confirmation_requests[${index}]`;
    if (!object(child)) {
      errors.push(`${prefix} must be a complete decision object`);
      return;
    }
    if (Object.hasOwn(child, 'confirmation_requests')) errors.push(`${prefix} cannot contain a nested batch`);
    if (forbiddenOperation(child)) errors.push(`${prefix} cannot contain registration or registered-trade mutations`);
    if (!normalized(child.sheet_row_candidate?.customer_name)) errors.push(`${prefix} requires customer identity`);
    if (identityKey(child) !== identity) errors.push(`${prefix} must have the same customer identity`);
    const period = periodKey(child);
    if (periods.has(period)) errors.push(`${prefix} repeats a rental period group`);
    periods.add(period);
    const childTargets = new Set((Array.isArray(child.existing_confirm_request_ids) ? child.existing_confirm_request_ids : [])
      .map(value => normalized(value).toUpperCase()).filter(Boolean));
    for (const target of childTargets) {
      if (requestTargets.has(target)) errors.push(`${prefix} repeats an existing confirmation request target`);
      requestTargets.add(target);
    }
    if (typeof validateDecision === 'function') {
      try {
        const validation = validateDecision(child, index);
        if (validation?.valid !== true) {
          const childErrors = Array.isArray(validation?.errors) ? validation.errors : ['invalid child decision'];
          errors.push(...childErrors.slice(0, 20).map(error => `${prefix}: ${String(error).slice(0, 300)}`));
        }
      } catch {
        errors.push(`${prefix}: child decision validation failed`);
      }
    }
  });
  return { valid: errors.length === 0, errors };
}

function operationError(error, fallbackCode, fallbackMessage) {
  return {
    code: normalized(error?.code || error?.error_type) || fallbackCode,
    message: normalized(error?.message || (typeof error === 'string' ? error : '')).slice(0, 1000) || fallbackMessage
  };
}

function receiptRequestIds(receipt) {
  const result = receipt?.authoritative_sheet_result;
  return [...new Set([result?.reqID, ...(Array.isArray(result?.request_ids) ? result.request_ids : [])]
    .map(normalized).filter(value => /^RQ-\d{6}-\d{3}$/.test(value)))];
}

/**
 * Execute one already-interpreted durable operation, with every child preflighted
 * before the first execution. Callback closures own the shared job, room and
 * revision. executeDecision returns a receipt or { receipt, executionState }.
 * No execution callback is retried, including when its response is lost.
 */
export async function executeConfirmationBatch({
  decision,
  validateDecision,
  preflightDecision,
  executeDecision,
  buildReceipt,
  assertCurrent = async () => {},
  signal = null,
  onExecutionState = () => {}
} = {}) {
  const children = Array.isArray(decision?.confirmation_requests) ? structuredClone(decision.confirmation_requests) : [];
  const authorizedConfirmationRequests = structuredClone(children);
  const authorizedTargets = children.map(child => ({ identity: identityKey(child), period: periodKey(child), schema: JSON.stringify(child) }));
  const requestResults = [];
  const childExecutionStates = [];
  let prepared = [];
  const checkCurrent = async () => {
    if (signal?.aborted) throw { code: 'confirmation_batch_aborted', message: 'Batch execution aborted' };
    await assertCurrent();
    if (signal?.aborted) throw { code: 'confirmation_batch_aborted', message: 'Batch execution aborted' };
  };
  const finish = (status, error = null) => {
    const childReceipts = requestResults.map(result => result.receipt).filter(Boolean);
    const requestIds = [...new Set(requestResults.flatMap(result => result.request_ids))];
    const unattemptedIndices = children.map((_child, index) => index).slice(requestResults.length);
    const availabilityReport = childReceipts.flatMap(receipt => Array.isArray(receipt.availability_report) ? receipt.availability_report : []);
    const authoritativeSheetResult = {
      success: status === 'ok', batch: true,
      request_results: requestResults, request_ids: requestIds, unattempted_indices: unattemptedIndices,
      ...(requestIds.length ? { reqID: requestIds[0] } : {})
    };
    const receipt = {
      ...buildReceipt({ status, authoritativeSheetResult, availabilityReport, error }),
      authorized_confirmation_requests: authorizedConfirmationRequests,
      child_receipts: childReceipts, request_results: requestResults,
      request_ids: requestIds, unattempted_indices: unattemptedIndices
    };
    onExecutionState({
      decision: { ...decision, confirmation_requests: prepared.length === children.length ? prepared : children },
      batch: true, childExecutionStates, requestResults, requestIds,
      authoritativeSheetResult, sheetResult: authoritativeSheetResult,
      availabilityReport: { rows: availabilityReport },
      unattemptedIndices, postPrimaryError: status === 'partial_success' ? error : null
    });
    return receipt;
  };

  try {
    await checkCurrent();
    if (![validateDecision, preflightDecision, executeDecision].every(callback => typeof callback === 'function')) {
      return finish('failed', { code: 'invalid_confirmation_batch_callbacks', message: 'Batch requires validation, preflight and execution callbacks' });
    }
    const validation = validateConfirmationBatchDecision({ ...decision, confirmation_requests: children }, { validateDecision });
    if (!validation.valid) {
      return finish('failed', { code: 'invalid_decision', message: 'AI batch decision contract validation failed', validation_errors: validation.errors });
    }
    for (let index = 0; index < children.length; index += 1) {
      await checkCurrent();
      const result = await preflightDecision(children[index], index);
      if (result?.ok !== true) {
        return finish('failed', operationError(result?.error, 'confirmation_batch_preflight_failed', 'Confirmation request preflight failed'));
      }
      prepared.push(result.decision ?? children[index]);
    }
    // Catalog resolution must not alter which customer or period was authorized.
    const resolvedValidation = validateConfirmationBatchDecision({ ...decision, confirmation_requests: prepared }, {
      validateDecision: (child, index) => JSON.stringify(child) === authorizedTargets[index].schema
        ? { valid: true } : validateDecision(child, index)
    });
    const changedTarget = prepared.some((child, index) => identityKey(child) !== authorizedTargets[index].identity || periodKey(child) !== authorizedTargets[index].period);
    if (!resolvedValidation.valid || changedTarget) {
      return finish('failed', { code: 'invalid_decision', message: 'Batch preflight changed the authorized customer, period, or operation' });
    }
  } catch (error) {
    return finish('failed', operationError(error, 'confirmation_batch_preflight_failed', 'Batch preflight failed'));
  }

  for (let index = 0; index < prepared.length; index += 1) {
    try {
      await checkCurrent();
    } catch (error) {
      return finish(index > 0 ? 'partial_success' : 'failed', operationError(error, 'confirmation_batch_freshness_failed', 'Batch freshness check failed'));
    }
    let receipt;
    try {
      const execution = await executeDecision(prepared[index], index);
      receipt = execution?.receipt ?? execution;
      childExecutionStates.push(execution?.executionState ?? null);
      if (!object(receipt) || receipt.schema !== 'village-confirmation-receipt/v1'
        || !['ok', 'no_action', 'failed', 'partial_success'].includes(receipt.status)) {
        throw new Error('Child execution returned no valid confirmation receipt');
      }
    } catch {
      const uncertainError = operationError(null, 'confirmation_batch_execution_uncertain', 'Child execution did not return a confirmed result; reconcile before any retry');
      requestResults.push({ index, status: 'uncertain', receipt: object(receipt) ? receipt : null, request_ids: receiptRequestIds(receipt), error: uncertainError });
      return finish('partial_success', uncertainError);
    }
    requestResults.push({ index, status: receipt.status, receipt, authoritative_sheet_result: receipt.authoritative_sheet_result, request_ids: receiptRequestIds(receipt) });
    if (receipt.authoritative_sheet_result?.uncertainWrite === true || receipt.authoritative_sheet_result?.uncertain_write === true) {
      return finish('partial_success', receipt.error || {
        code: 'confirmation_batch_execution_uncertain', message: 'Child has uncertain write evidence; reconcile before any retry'
      });
    }
    if (receipt.status !== 'ok') {
      const hasEvidence = requestResults.some(result => result.request_ids.length || result.receipt?.status === 'partial_success');
      return finish(index > 0 || hasEvidence ? 'partial_success' : 'failed', receipt.error || {
        code: 'confirmation_batch_incomplete', message: 'Child did not complete; remaining periods were not attempted'
      });
    }
  }
  return finish('ok');
}
