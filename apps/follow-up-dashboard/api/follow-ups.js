const TYPE_LABELS = {
  reply_needed: '답변 필요',
  quote_send: '견적서 발송',
  tax_invoice: '세금계산서/증빙',
  schedule_check: '스케줄 확인',
  reservation_review: '예약 후보 확인',
  price_review: '가격/할인 확인',
  payment_check: '입금/결제 확인',
  contract_document: '계약/서류',
  return_extension: '반납/연장/변경',
  damage_repair: '파손/수리',
  sheet_duplicate_check: '시트 중복 확인',
  completed_log: '처리 완료 기록'
};

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function checkToken(req) {
  const configured = process.env.DASHBOARD_TOKEN || '';
  if (!configured) return true;
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const headerToken = req.headers['x-dashboard-token'] || '';
  return bearer === configured || headerToken === configured;
}

async function supabaseFetch(pathAndQuery, init = {}) {
  const url = requireEnv('SUPABASE_URL').replace(/\/$/, '');
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const response = await fetch(`${url}/rest/v1/${pathAndQuery}`, {
    ...init,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      ...(init.headers || {})
    }
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!response.ok) {
    const err = new Error(`Supabase ${response.status}`);
    err.detail = data;
    throw err;
  }
  return data;
}

function normalizeKeyPart(value, maxLength = 120) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^0-9a-z가-힣_./:-]+/g, ' ')
    .trim()
    .slice(0, maxLength) || 'unknown';
}

function text(value) {
  return String(value ?? '').trim();
}

export function buildDashboardSemanticKey(item) {
  const customer = normalizeKeyPart(item.customer_name, 80);
  const type = normalizeKeyPart(item.type, 60);
  const combined = [
    item.title,
    item.summary,
    item.recommended_action,
    Array.isArray(item.evidence) ? item.evidence.join(' ') : ''
  ].map(text).join(' ').normalize('NFKC');
  const specificAnchors = [
    ...(combined.match(/\d+(?:\.\d+)?\s*(?:만원|원)/g) || []).map((v) => v.replace(/\s+/g, '')),
    ...(combined.match(/\d{1,2}\s*월\s*\d{1,2}\s*일/g) || []).map((v) => v.replace(/\s+/g, '')),
    ...(combined.match(/\d{4}[-./]\d{1,2}[-./]\d{1,2}/g) || []).map((v) => v.replace(/[./]/g, '-'))
  ];
  if (!specificAnchors.length) return `exact:${normalizeKeyPart(item.follow_up_key || item.id || item.title || '', 200)}`;
  const buckets = [];
  if (/(결제|계약|견적|정산|서류|거래명세|세금계산|계산서)/.test(combined)) buckets.push('payment_docs');
  if (/(입금|결제|미수|환불)/.test(combined)) buckets.push('payment_check');
  if (/(예약|반출|반납|대여|촬영|일정)/.test(combined)) buckets.push('reservation_review');
  return ['semantic', customer, type, ...new Set(specificAnchors), ...new Set(buckets)].map((v) => normalizeKeyPart(v, 120)).join(':');
}

export function dedupeFollowUpItems(items) {
  const seen = new Set();
  const deduped = [];
  for (const item of Array.isArray(items) ? items : []) {
    const key = buildDashboardSemanticKey(item || {});
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}

function summarize(items) {
  const openItems = items.filter((x) => !['done', 'dismissed'].includes(x.status));
  const byType = {};
  for (const item of openItems) byType[item.type] = (byType[item.type] || 0) + 1;
  return {
    total: items.length,
    open: openItems.length,
    urgent: openItems.filter((x) => x.priority === 'urgent').length,
    high: openItems.filter((x) => x.priority === 'high').length,
    byType: Object.entries(byType).map(([type, count]) => ({ type, label: TYPE_LABELS[type] || type, count }))
  };
}

export default async function handler(req, res) {
  try {
    if (!checkToken(req)) return json(res, 401, { error: 'unauthorized' });
    const table = encodeURIComponent(process.env.SUPABASE_FOLLOW_UP_TABLE || 'ai_follow_up_items');

    if (req.method === 'GET') {
      const status = req.query?.status || 'active';
      const limit = Math.min(Number(req.query?.limit || 200) || 200, 500);
      const filters = [
        'select=id,follow_up_key,job_id,room_key,customer_name,type,priority,status,title,summary,recommended_action,suggested_reply_draft,evidence,blocking_reason,due_hint,decision_classification,decision_confidence,created_at,updated_at,completed_at',
        `limit=${limit}`,
        'order=created_at.desc'
      ];
      if (status === 'active') filters.push('status=not.in.(done,dismissed)');
      else if (status && status !== 'all') filters.push(`status=eq.${encodeURIComponent(status)}`);
      const rawItems = await supabaseFetch(`${table}?${filters.join('&')}`);
      const items = dedupeFollowUpItems(rawItems);
      return json(res, 200, { ok: true, updatedAt: new Date().toISOString(), summary: summarize(items), items });
    }

    if (req.method === 'PATCH') {
      const body = await new Promise((resolve, reject) => {
        let text = '';
        req.on('data', (chunk) => {
          text += chunk;
          if (text.length > 20_000) reject(new Error('request body too large'));
        });
        req.on('end', () => {
          try { resolve(text ? JSON.parse(text) : {}); }
          catch { reject(new Error('invalid json')); }
        });
        req.on('error', reject);
      });
      const id = String(body.id || '');
      const status = String(body.status || '');
      if (!id || !['open', 'in_progress', 'waiting_customer', 'waiting_internal', 'done', 'dismissed'].includes(status)) {
        return json(res, 400, { error: 'invalid id/status' });
      }
      const selectFields = 'id,follow_up_key,job_id,room_key,customer_name,type,priority,status,title,summary,recommended_action,suggested_reply_draft,evidence,blocking_reason,due_hint,decision_classification,decision_confidence,created_at,updated_at,completed_at';
      const currentRows = await supabaseFetch(`${table}?select=${selectFields}&id=eq.${encodeURIComponent(id)}`);
      const current = Array.isArray(currentRows) ? currentRows[0] : null;
      if (!current) return json(res, 404, { error: 'not found' });
      const targetSemanticKey = buildDashboardSemanticKey(current);
      const candidateRows = await supabaseFetch(`${table}?select=${selectFields}&status=not.in.(done,dismissed)&limit=500&order=created_at.desc`);
      const duplicateIds = Array.from(new Set(
        (Array.isArray(candidateRows) ? candidateRows : [])
          .filter((item) => buildDashboardSemanticKey(item || {}) === targetSemanticKey)
          .map((item) => item.id)
          .filter(Boolean)
      ));
      if (!duplicateIds.includes(id)) duplicateIds.push(id);
      const patchBody = status === 'open' ? { status, completed_at: null } : { status };
      const row = await supabaseFetch(`${table}?id=in.(${duplicateIds.map(encodeURIComponent).join(',')})`, {
        method: 'PATCH',
        headers: { prefer: 'return=representation' },
        body: JSON.stringify(patchBody)
      });
      return json(res, 200, { ok: true, item: Array.isArray(row) ? row[0] : row, updatedIds: duplicateIds, updatedCount: duplicateIds.length });
    }

    return json(res, 405, { error: 'method not allowed' });
  } catch (error) {
    return json(res, 500, { error: error.message, detail: error.detail || null });
  }
}
