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

function normalizeCustomerForTask(value) {
  const normalized = normalizeKeyPart(value, 80);
  return normalized
    .replace(/\/.*$/, '')
    .replace(/\s+(?:파손|미반납|누락|분실|반납|확인).*$/, '')
    .trim() || normalized;
}

function text(value) {
  return String(value ?? '').trim();
}

function combinedFollowUpText(item = {}) {
  return [
    item.title,
    item.summary,
    item.recommended_action,
    Array.isArray(item.evidence) ? item.evidence.join(' ') : ''
  ].map(text).join(' ').normalize('NFKC');
}

function extractAmountAnchors(value) {
  return (text(value).normalize('NFKC').match(/\d+(?:\.\d+)?\s*(?:만원|원)/g) || [])
    .map((v) => v.replace(/\s+/g, ''));
}

function extractDateAnchors(value) {
  const input = text(value).normalize('NFKC');
  const currentYear = new Date().getFullYear();
  const pad = (value) => String(value).padStart(2, '0');
  const anchors = [];
  for (const match of input.matchAll(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/g)) {
    anchors.push(`${match[1]}-${pad(match[2])}-${pad(match[3])}`);
  }
  for (const match of input.matchAll(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/g)) {
    anchors.push(`${currentYear}-${pad(match[1])}-${pad(match[2])}`);
  }
  for (const match of input.matchAll(/(\d{1,2})\/(\d{1,2})(?:\s*[-~]\s*(\d{1,2})\/(\d{1,2}))?/g)) {
    anchors.push(`${currentYear}-${pad(match[1])}-${pad(match[2])}`);
    if (match[3] && match[4]) anchors.push(`${currentYear}-${pad(match[3])}-${pad(match[4])}`);
  }
  return Array.from(new Set(anchors));
}

function extractTopicBuckets(combined) {
  const buckets = [];
  if (/(반납|다음\s*회차|메모리|배터리|픽업|라오와|장비\s*반납|확인\s*후\s*가져다|가져다\s*드리)/.test(combined)) buckets.push('operations_update');
  if (/(결제|계약|견적|정산|서류|거래명세|세금계산|계산서)/.test(combined)) buckets.push('payment_docs');
  if (/(입금|결제|미수|환불)/.test(combined)) buckets.push('payment_check');
  if (/(학생\s*할인|학생할인|할인율|몇\s*프로|몇\s*퍼센트|할인)/.test(combined)) buckets.push('discount_policy');
  if (!buckets.includes('discount_policy') && !buckets.includes('operations_update') && /(위치|주소|어디|찾아가|오시는\s*길)/.test(combined)) buckets.push('location_faq');
  if (/(예약|반출|반납|대여|렌탈|촬영|일정)/.test(combined)) buckets.push('reservation_review');
  if (/(미반납|누락|분실|파손|손상|수리|고장|회수|경고\s*메시지|배터리)/.test(combined)) buckets.push('damage_repair');
  return buckets;
}

function isReservationTask(item = {}, combined = '') {
  const type = String(item.type || '');
  if (type === 'reservation_review') return true;
  if (!['reply_needed', 'schedule_check', 'quote_send'].includes(type)) return false;
  return /(예약\s*(?:가능|진행|요청|의사|접수)|대여\s*가능|렌탈\s*가능|대여\s*할\s*수|대여\s*할수|렌탈\s*할\s*수|장비\s*예약)/.test(combined);
}

function reservationScopeAnchors(item = {}, combined = '') {
  const roomKey = normalizeKeyPart(item.room_key || '', 120);
  if (roomKey && roomKey !== 'unknown') return [`room:${roomKey}`];
  const dates = extractDateAnchors(combined);
  if (dates.length) return [...new Set(dates)];
  return [];
}

function taskOwnerKey(item = {}, customer = normalizeCustomerForTask(item.customer_name)) {
  const roomKey = normalizeKeyPart(item.room_key || '', 120);
  return roomKey && roomKey !== 'unknown' ? `room:${roomKey}` : customer;
}

export function buildDashboardSemanticKey(item) {
  const customer = normalizeCustomerForTask(item.customer_name);
  const owner = taskOwnerKey(item, customer);
  const type = normalizeKeyPart(item.type, 60);
  const combined = combinedFollowUpText(item);
  const specificAnchors = [
    ...extractAmountAnchors(combined),
    ...extractDateAnchors(combined)
  ];
  const buckets = extractTopicBuckets(combined);
  if (type === 'quote_send') {
    return ['semantic', owner, 'quote_send', ...reservationScopeAnchors(item, combined)]
      .map((v) => normalizeKeyPart(v, 120))
      .join(':');
  }
  if (isReservationTask(item, combined)) {
    return ['semantic', owner, 'reservation_review', ...reservationScopeAnchors(item, combined)]
      .map((v) => normalizeKeyPart(v, 120))
      .join(':');
  }
  if (buckets.includes('operations_update')) {
    return ['semantic', owner, 'operations_update'].map((v) => normalizeKeyPart(v, 120)).join(':');
  }
  if (buckets.includes('discount_policy')) {
    return ['semantic', owner, type, ...new Set(specificAnchors), 'discount_policy'].map((v) => normalizeKeyPart(v, 120)).join(':');
  }
  if (buckets.includes('damage_repair')) {
    return ['semantic', owner, type, ...new Set(specificAnchors), 'damage_repair'].map((v) => normalizeKeyPart(v, 120)).join(':');
  }
  if (!specificAnchors.length && !buckets.length) return `exact:${normalizeKeyPart(item.follow_up_key || item.id || item.title || '', 200)}`;
  return ['semantic', owner, type, ...new Set(specificAnchors), ...new Set(buckets)].map((v) => normalizeKeyPart(v, 120)).join(':');
}

function mergeDuplicateFollowUpItem(primary, duplicate) {
  const priorityRank = { urgent: 0, high: 1, normal: 2, low: 3 };
  const merged = { ...primary };
  if ((priorityRank[duplicate.priority] ?? 2) < (priorityRank[merged.priority] ?? 2)) merged.priority = duplicate.priority;
  if (!text(merged.suggested_reply_draft) && text(duplicate.suggested_reply_draft)) {
    merged.suggested_reply_draft = duplicate.suggested_reply_draft;
  }
  const evidence = [
    ...(Array.isArray(primary.evidence) ? primary.evidence : []),
    ...(Array.isArray(duplicate.evidence) ? duplicate.evidence : [])
  ].map(text).filter(Boolean);
  merged.evidence = Array.from(new Set(evidence)).slice(0, 12);
  return merged;
}

export function dedupeFollowUpItems(items) {
  const seen = new Map();
  const deduped = [];
  for (const item of Array.isArray(items) ? items : []) {
    const key = buildDashboardSemanticKey(item || {});
    if (seen.has(key)) {
      const index = seen.get(key);
      deduped[index] = mergeDuplicateFollowUpItem(deduped[index], item);
      continue;
    }
    seen.set(key, deduped.length);
    deduped.push(item);
  }
  return deduped;
}

export function shouldHideLowValueActiveItem(item) {
  if (item?.status && ['done', 'dismissed'].includes(item.status)) return false;
  if (item?.type !== 'completed_log') return false;
  if (item?.priority && item.priority !== 'low') return false;
  const combined = combinedFollowUpText(item);
  return /(감사|감사히|잘\s*썼|잘썼|고맙)/.test(combined)
    && !/(미반납|파손|입금|결제|변경|추가|확인\s*필요|등록\s*필요)/.test(combined);
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
      const items = dedupeFollowUpItems(rawItems)
        .filter((item) => status !== 'active' || !shouldHideLowValueActiveItem(item));
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
      const ids = Array.isArray(body.ids)
        ? Array.from(new Set(body.ids.map((value) => String(value || '').trim()).filter(Boolean))).slice(0, 100)
        : [];
      const status = String(body.status || '');
      if ((!id && !ids.length) || !['open', 'in_progress', 'waiting_customer', 'waiting_internal', 'done', 'dismissed'].includes(status)) {
        return json(res, 400, { error: 'invalid id/status' });
      }
      const selectFields = 'id,follow_up_key,job_id,room_key,customer_name,type,priority,status,title,summary,recommended_action,suggested_reply_draft,evidence,blocking_reason,due_hint,decision_classification,decision_confidence,created_at,updated_at,completed_at';
      if (ids.length) {
        const patchBody = status === 'open' ? { status, completed_at: null } : { status };
        const rows = await supabaseFetch(`${table}?id=in.(${ids.map(encodeURIComponent).join(',')})`, {
          method: 'PATCH',
          headers: { prefer: 'return=representation' },
          body: JSON.stringify(patchBody)
        });
        return json(res, 200, { ok: true, items: Array.isArray(rows) ? rows : [], updatedIds: ids, updatedCount: Array.isArray(rows) ? rows.length : 0 });
      }
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
