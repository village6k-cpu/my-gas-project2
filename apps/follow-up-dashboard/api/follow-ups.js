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
      const items = await supabaseFetch(`${table}?${filters.join('&')}`);
      return json(res, 200, { ok: true, updatedAt: new Date().toISOString(), summary: summarize(items), items });
    }

    if (req.method === 'PATCH') {
      const body = await new Promise((resolve, reject) => {
        let text = '';
        req.on('data', (chunk) => { text += chunk; });
        req.on('end', () => resolve(text ? JSON.parse(text) : {}));
        req.on('error', reject);
      });
      const id = String(body.id || '');
      const status = String(body.status || '');
      if (!id || !['open', 'in_progress', 'waiting_customer', 'waiting_internal', 'done', 'dismissed'].includes(status)) {
        return json(res, 400, { error: 'invalid id/status' });
      }
      const row = await supabaseFetch(`${table}?id=eq.${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { prefer: 'return=representation' },
        body: JSON.stringify({ status })
      });
      return json(res, 200, { ok: true, item: Array.isArray(row) ? row[0] : row });
    }

    return json(res, 405, { error: 'method not allowed' });
  } catch (error) {
    return json(res, 500, { error: error.message, detail: error.detail || null });
  }
}
