const TRADE_ID = /\b\d{6}-\d{3}\b/g;
export function invoiceWorkReferences(work) {
  const payload = work.payload || {};
  const primary = String(payload.business_key || '').match(TRADE_ID) || [];
  const text = [work.title, work.summary, payload.owner_request_summary, payload.recommended_action, payload.owner_task_key].filter(Boolean).join(' ');
  const originalIds = [...new Set(primary.length ? primary : text.match(TRADE_ID) || [])];
  const evidence = work.resolution_evidence || {};
  const verified = evidence.taxInvoice?.mgtKey && /^\d{6}-\d{3}$/.test(evidence.taxInvoice.tradeId) ? evidence.taxInvoice : null;
  const draft = /^\d{6}-\d{3}$/.test(evidence.invoiceDraft?.tradeId || '') ? evidence.invoiceDraft : null;
  const prepared = verified || draft;
  const ids = prepared ? [prepared.tradeId] : originalIds;
  const complexReason = /정정|재발행|수정\s*계산서|계산서.*취소|취소.*계산서/.test(text)
    ? '정정·취소 요청입니다. 기존 계산서를 확인한 뒤 처리해주세요.'
    : /합산|여러\s*건|[2-9]\s*건.*(?:계산서|발행)|(?:두|세)\s*(?:건|대여건)/.test(text) || originalIds.length > 1
      ? '여러 거래의 합산 요청입니다. 발행 대상과 합계 금액을 먼저 확인해주세요.' : null;
  return { ids, complexReason, ...(prepared?.buyer ? { buyer: prepared.buyer } : {}), ...(verified ? { expectedAmount: verified.amount } : {}) };
}
/** @param {any} work @param {any} snapshot */
export function invoiceRequestRow(work, snapshot = null) {
  const { ids, complexReason } = invoiceWorkReferences(work);
  const closed = ['resolved', 'dismissed'].includes(work.state);
  const blockers = [...(snapshot?.missing || []), ...(complexReason ? [complexReason] : [])];
  if (!snapshot) blockers.unshift(ids.length > 1 ? '발행할 거래를 선택해주세요' : '계산서에 연결할 거래를 선택해주세요');
  // 기존 계산서가 있어도 정정·합산 요청 자체가 완료된 것은 아니다.
  const issued = snapshot?.status === 'issued' && !complexReason;
  const roomId = String(work.room_key || '').match(/^(?:chat:)?(\d+)$/)?.[1];
  return { id: work.id, version: work.version, title: work.title, summary: work.payload?.owner_request_summary || work.summary,
    requestedAt: work.first_opened_at, priority: work.priority, workState: work.state,
    customerLabel: snapshot?.customerName || String(work.title || '').split(' ')[0] || '고객',
    tradeIds: ids, item: snapshot, complexReason, blockers,
    status: issued ? 'issued' : !closed && snapshot?.canIssue && !complexReason ? 'ready' : 'needs_info',
    canIssue: !closed && !!snapshot?.canIssue && !complexReason,
    conversationUrl: roomId ? 'https://business.kakao.com/space/353491/channel/_xhPMls/chats/' + roomId : null };
}
export function invoiceRequestSummary(rows) {
  const pending = rows.filter(r => !['resolved', 'dismissed'].includes(r.workState) && r.status !== 'issued');
  return { total: rows.length, pending: pending.length, ready: pending.filter(r => r.status === 'ready').length,
    needsInfo: pending.filter(r => r.status === 'needs_info').length, issued: rows.filter(r => r.status === 'issued').length };
}
