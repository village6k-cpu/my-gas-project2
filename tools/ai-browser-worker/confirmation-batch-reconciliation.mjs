import { validateConfirmationBatchDecision } from './confirmation-batch.mjs';

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonical = value => Array.isArray(value) ? value.map(canonical) : record(value)
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const text = value => String(value ?? '').trim();
const requestIds = result => [...new Set([result?.reqID, ...(Array.isArray(result?.request_ids) ? result.request_ids : [])]
  .filter(value => typeof value === 'string' && /^RQ-\d{6}-\d{3}$/.test(value)))];

/** Project durable facts into owner review; never execute or interpret customer prose. */
export function reconcileConfirmationBatchReceipt({ receipt, decision = {}, job = {}, validateChildReadback } = {}) {
  decision = record(decision) ? decision : {};
  const errors = [];
  const jobId = text(job.jobId || job.job_id || job.id);
  const roomKey = text(job.roomKey || job.room_key);
  const revision = Number(job.roomRevision ?? job.room_revision);
  const authority = receipt?.authoritative_sheet_result;
  const children = Array.isArray(receipt?.authorized_confirmation_requests) ? receipt.authorized_confirmation_requests : [];
  const entries = Array.isArray(receipt?.request_results) ? receipt.request_results : [];
  const unattempted = Array.isArray(receipt?.unattempted_indices) ? receipt.unattempted_indices : [];
  if (receipt?.schema !== 'village-confirmation-receipt/v1' || authority?.batch !== true
    || receipt.job_id !== jobId || receipt.room_key !== roomKey || receipt.room_revision !== revision) errors.push('batch_receipt_coordinates_invalid');
  if (!validateConfirmationBatchDecision({ confirmation_requests: children }).valid) errors.push('batch_authorized_decisions_invalid');
  if (!same(entries, authority?.request_results) || !same(unattempted, authority?.unattempted_indices)
    || entries.length + unattempted.length !== children.length
    || unattempted.some((index, offset) => index !== entries.length + offset)) errors.push('batch_result_coverage_invalid');
  if (decision.authoritative_sheet_result && !same(decision.authoritative_sheet_result, authority)) errors.push('batch_final_authority_contradiction');
  if (Array.isArray(decision.confirmation_requests) && (decision.confirmation_requests.length !== children.length
    || decision.confirmation_requests.some((child, index) => !same(child?.sheet_row_candidate, children[index]?.sheet_row_candidate)))) {
    errors.push('batch_final_period_plan_contradiction');
  }
  const groups = children.map((authorized, index) => {
    const entry = entries[index];
    const childReceipt = entry?.receipt;
    const childResult = childReceipt?.authoritative_sheet_result ?? null;
    const status = entry ? entry.status : 'unattempted';
    if (entry && (entry.index !== index || !['ok', 'failed', 'partial_success', 'no_action', 'uncertain'].includes(status))) errors.push(`batch_child_${index}_invalid`);
    if (childReceipt && (childReceipt.schema !== receipt.schema || childReceipt.job_id !== jobId
      || childReceipt.room_key !== roomKey || childReceipt.room_revision !== revision
      || childReceipt.status !== status || !same(entry.authoritative_sheet_result, childResult))) errors.push(`batch_child_${index}_receipt_invalid`);
    if (entry && !childReceipt && status !== 'uncertain') errors.push(`batch_child_${index}_receipt_missing`);
    const ids = requestIds(childResult);
    if (entry && !same(ids, entry.request_ids)) errors.push(`batch_child_${index}_request_ids_invalid`);
    let exactReadback = typeof validateChildReadback !== 'function';
    if (childReceipt && typeof validateChildReadback === 'function' && status === 'ok') {
      try {
        const validation = validateChildReadback(childReceipt, authorized, index);
        exactReadback = validation === true || validation?.valid === true;
      } catch { exactReadback = false; }
      if (!exactReadback) errors.push(`batch_child_${index}_readback_contradiction`);
    }
    const uncertain = status === 'uncertain' || status === 'partial_success'
      || childResult?.uncertainWrite === true || childResult?.uncertain_write === true;
    const tradeIds = [childResult?.matchedRegisteredTradeId, childResult?.tradeID].filter(Boolean);
    const tradeId = tradeIds.length && tradeIds.every(id => /^\d{6}-\d{3}$/.test(id) && id === tradeIds[0]) ? tradeIds[0] : null;
    const registered = childResult?.alreadyRegistered === true && childResult.success === true && tradeId && ids.length === 0;
    if (status === 'ok' && !ids.length && !registered) errors.push(`batch_child_${index}_authoritative_target_missing`);
    return {
      index, status, period: Object.fromEntries(['start_date', 'pickup_time', 'end_date', 'return_time'].map(key => [key, authorized?.sheet_row_candidate?.[key] ?? ''])),
      request_ids: ids, trade_id: tradeId, receipt_id: childReceipt?.receipt_id ?? null,
      authoritative_sheet_result: childResult,
      quiet_reconciliation: Boolean(registered && status === 'ok' && !uncertain && exactReadback && typeof validateChildReadback === 'function'),
      confirmed: status === 'ok' && childResult?.success === true && Boolean(ids.length || registered) && !uncertain && childReceipt?.error === null && exactReadback
    };
  });
  const ids = [...new Set(groups.flatMap(group => group.request_ids))];
  if (!same(ids, authority?.request_ids) || !same(ids, receipt?.request_ids)) errors.push('batch_request_ids_invalid');
  const valid = errors.length === 0;
  const complete = valid && receipt?.status === 'ok' && receipt.error === null && groups.every(group => group.confirmed) && unattempted.length === 0;
  const reason = complete ? '모든 대여 기간의 권위 있는 처리 결과를 기간별로 확인하세요.'
    : '일부 대여 기간의 처리가 미완료이거나 결과가 일치하지 않습니다. 완료된 기간을 재실행하지 말고 각 원장 결과를 확인하세요.';
  const reviews = groups.filter(group => !complete || !group.quiet_reconciliation).map(group => ({
    type: 'schedule_check', route: 'schedule', taskKey: `gateway:batch:${jobId}:${group.index}`,
    priority: 'high', status: 'open', customer_name: text(children[group.index]?.sheet_row_candidate?.customer_name),
    title: `대여 일정 ${group.index + 1}/${children.length} 결과 확인`,
    summary: `${Object.values(group.period).map(value => text(value) || '미정').join(' ')} · ${group.status} · ${[...group.request_ids, group.trade_id].filter(Boolean).join(', ') || '처리 대상 미확정'}`,
    recommended_action: reason, suggested_reply_draft: '', requiresHumanAction: true,
    evidence: [`receipt_id: ${receipt?.receipt_id || ''}`, `batch_index: ${group.index}`, `status: ${group.status}`,
      ...group.request_ids.map(id => `request_id: ${id}`), ...(group.trade_id ? [`trade_id: ${group.trade_id}`] : [])],
    confirmation_batch_result: group, due_hint: 'now', alertLevel: 'none'
  }));
  // Missing authorization never authorizes a replay or a completion claim.
  if (!groups.length) reviews.push({ type: 'schedule_check', route: 'schedule', taskKey: `gateway:batch:${jobId}:invalid`,
    priority: 'high', status: 'open', title: '복수 대여 일정 원장 확인 필요', summary: reason,
    recommended_action: reason, suggested_reply_draft: '', requiresHumanAction: true, evidence: [], alertLevel: 'none' });
  const followUps = [...(Array.isArray(decision.follow_up_items) ? decision.follow_up_items : [])
    .filter(item => text(item?.route || item?.follow_up_route) !== 'schedule').map(item => ({ ...item, suggested_reply_draft: '' })), ...reviews];
  const safeChildren = children.map(child => ({ ...structuredClone(child), should_write_to_sheet: false,
    reply_decision: { replyMode: 'no_reply', text: '', safetyClass: 'no_send', shouldCreateTask: false, requiresRag: false } }));
  return {
    valid, errors, complete, reason, sheetResult: authority ?? null,
    decision: { ...decision, should_write_to_sheet: false, confirmation_requests: safeChildren,
      confirmation_batch_results: groups, authoritative_sheet_result: authority ?? null,
      trusted_confirmation_receipt: receipt, owner_review_required: reviews.length > 0,
      post_action_reconciled: complete && reviews.length === 0,
      safety_checks: { ...(decision.safety_checks || {}), latest_customer_message_after_last_staff_reply: true, no_auto_reply_sent: true },
      follow_up_items: followUps, suggested_reply_draft: '',
      reply_decision: { replyMode: 'no_reply', text: '', confidence: 'high', reason,
        shouldCreateTask: reviews.length > 0, safetyClass: 'no_send', grounding: 'authoritative_sheet', requiresRag: false, attachmentKeys: [], alreadyDelivered: false }
    }
  };
}
