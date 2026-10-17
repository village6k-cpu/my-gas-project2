// Read-only, independent of the Gateway queue: capture may fail BEFORE enqueue.
export async function readCaptureBacklog(config = {}, { fetchImpl = fetch } = {}) {
  const unknown = { status: 'unknown', unresolved: null };
  if (!config.supabaseUrl || !config.supabaseServiceRoleKey || !config.supabaseTable) return unknown;
  try {
    const url = new URL(`/rest/v1/${encodeURIComponent(config.supabaseTable)}`, config.supabaseUrl);
    url.searchParams.set('select', 'event_hash,room_key,detected_at');
    url.searchParams.set('status', 'in.(ai_worker_error,needs_human_review)');
    url.searchParams.set('payload->ai_worker_result->>error_type', 'eq.kakao_conversation_evidence_unavailable');
    url.searchParams.set('order', 'detected_at.asc');
    url.searchParams.set('limit', '1000');
    const request = { method: 'GET', headers: {
      apikey: config.supabaseServiceRoleKey, authorization: `Bearer ${config.supabaseServiceRoleKey}`,
      Prefer: 'count=exact'
    }, signal: AbortSignal.timeout(2500) };
    const response = await fetchImpl(url, request);
    if (!response.ok) return unknown;
    const rows = await response.json();
    const total = /\/(\d+)$/.exec(response.headers.get('content-range') || '');
    if (!Array.isArray(rows) || !total) return unknown;
    if (Number(total[1]) !== rows.length || rows.some(row=>!row.event_hash || !row.room_key)) return unknown;
    let pending = rows;
    if (rows.length) {
      const casesUrl = new URL('/rest/v1/work_items_v2', config.supabaseUrl);
      casesUrl.searchParams.set('select', 'work_key,room_key,source_event_keys,state,resolution_kind,resolution_evidence,resolved_at,resolved_by');
      casesUrl.searchParams.set('work_key', 'like.capture-reconciliation:*');
      casesUrl.searchParams.set('state', 'eq.resolved');
      casesUrl.searchParams.set('limit', '1000');
      const casesResponse = await fetchImpl(casesUrl, request);
      if (!casesResponse.ok) return unknown;
      const cases = await casesResponse.json();
      const caseTotal = /\/(\d+)$/.exec(casesResponse.headers.get('content-range') || '');
      if (!Array.isArray(cases) || !caseTotal || cases.length !== Number(caseTotal[1])) return unknown;
      pending = rows.filter(event => !cases.some(item => {
        if (item.work_key !== `capture-reconciliation:${event.event_hash}` || item.room_key !== event.room_key
          || !item.source_event_keys?.includes(event.event_hash) || item.state !== 'resolved'
          || !(Date.parse(item.resolved_at) >= Date.parse(event.detected_at))) return false;
        // A deliberate owner completion is an authoritative case acknowledgement,
        // not a claim that a booking was created. A mere dismiss never clears it.
        if (item.resolution_kind === 'owner_completed') return /^heybilli:[0-9a-f-]{36}$/.test(item.resolved_by || '');
        const receipt = item.resolution_evidence?.operationReceipt;
        return item.resolution_kind === 'operation_readback' && item.resolved_by === 'automation'
          && receipt?.status === 'completed' && typeof receipt.id === 'string' && !!receipt.id
          && Date.parse(receipt.timestamp) >= Date.parse(event.detected_at);
      }));
    }
    const unresolved = pending.length;
    return { status: unresolved ? 'blocked' : 'clear', unresolved,
      reconciled: rows.length - unresolved,
      oldestJobId: pending[0]?.event_hash || null, oldestDetectedAt: pending[0]?.detected_at || null };
  } catch { return unknown; }
}
