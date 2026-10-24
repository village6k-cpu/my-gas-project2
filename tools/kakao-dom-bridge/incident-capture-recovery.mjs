// Incident recovery may only reclaim new failures that never reached business execution.
export function isIncidentCaptureRetry(row = {}, freezeBefore, now = Date.now(), staleMs = 10 * 60_000) {
  const cutoff = Date.parse(freezeBefore || '');
  const detected = Date.parse(row.detected_at || '');
  const payload = row.payload;
  if (!Number.isFinite(cutoff) || !Number.isFinite(detected) || detected <= cutoff
    || !Number.isFinite(now) || !row.id || !row.event_hash || !row.updated_at
    || !payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const retry = payload.capture_retry;
  if (!['ai_worker_error', 'processing_by_ai_worker'].includes(row.status)
    || retry?.version !== 1 || retry.state !== 'pending' || retry.stage !== 'before_gateway_enqueue'
    || payload.ai_worker_result?.error_type !== 'kakao_conversation_evidence_unavailable'
    || payload.gateway_dispatch || payload.tool_operation || payload.tool_operations
    || payload.application || payload.operation_receipt || row.completed_at) return false;
  const due = Date.parse(retry.next_attempt_at || '');
  if (!Number.isFinite(due) || due > now) return false;
  if (row.status === 'processing_by_ai_worker') {
    const claimed = Date.parse(row.claimed_at || row.updated_at || '');
    return Number.isFinite(claimed) && Number.isFinite(staleMs) && staleMs >= 10 * 60_000 && now - claimed > staleMs;
  }
  return true;
}
