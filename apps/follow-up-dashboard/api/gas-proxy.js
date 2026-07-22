// GitHub Pages(docs/) 프론트용 공개 GAS 프록시.
// 브라우저 → GAS 직통은 302 리다이렉트 + 콜드스타트로 호출당 2~5초 바닥이 있다.
// 서버측 호출로 리다이렉트를 흡수하고 읽기를 30초 캐시해 워밍 응답을 ~0.1-0.3초로.
// today-dashboard의 /api/gas와 달리 인증 없음(공개) — 대신 docs 페이지가 실제로 쓰는
// 액션만 화이트리스트로 허용한다. (GAS key는 이미 공개 페이지에 노출돼 있던 값이라
// 이 프록시가 노출 범위를 넓히지 않는다. key는 서버측에서 주입.)

const GAS_URL =
  process.env.GAS_API_URL ||
  'https://script.google.com/macros/s/AKfycbyRff4-lLXmne-iPIEf87x4-CH_5wb-Uv5dCGymELLrpiKluhg2gDdLdVP4Y0MmxnnT/exec';
const GAS_KEY = process.env.GAS_API_KEY || 'village2026';

// 읽기(캐시 30초) — docs/timeline·dashboard·manage·request가 쓰는 조회 액션 전수
const READ_ACTIONS = new Set([
  'timeline', 'timelineContract',
  'dashboard', 'dashboardSearch', 'dashboardSearchIndex',
  'dashboardContractExtras', 'dashboardEquipNames', 'dashboardNotes',
  'card', 'list', 'read', 'search', 'scan'
]);
// 쓰기(캐시 안 함, 관련 읽기 캐시 무효화)
const WRITE_ACTIONS = new Set([
  'updateTime', 'scheduleAddEquip', 'scheduleRemoveEquip',
  'addEquips', 'removeEquip', 'updateEquipQty', 'updatePayment',
  'saveDashboardNotes', 'aiParse', 'registerAsync', 'update',
  '확인', '보류', '거절', '발송승인'
]);
// run&func= 화이트리스트 (쓰기 취급)
const RUN_FUNCTIONS = new Set(['excludeEquipFromRequest', 'updateRequest', 'insertAndCheckRequest']);

const TTL_MS = 30 * 1000;
const MAX_CACHE = 200;
const cache = new Map(); // key(qs) -> { at, body }

function pruneCache(now) {
  for (const [k, v] of cache) {
    if (now - v.at > TTL_MS) cache.delete(k);
  }
  while (cache.size > MAX_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

function invalidateReads() {
  // 쓰기 직후 재조회가 이전 상태를 받지 않도록 읽기 캐시 전체 무효화
  // (docs 페이지 트래픽 규모에서는 선별 무효화의 이득이 없다)
  cache.clear();
}

// GAS는 오류도 200 + {error:...}로 주기도 한다 — 오류 본문을 30초 재배포하지 않도록 정상 JSON만 캐시
function isCacheableBody(body) {
  try {
    const parsed = JSON.parse(body);
    return !(parsed && typeof parsed === 'object' && 'error' in parsed);
  } catch (e) {
    return false;
  }
}

function setCors(res) {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type');
  res.setHeader('access-control-max-age', '86400');
}

function send(res, status, body, extraHeaders) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  if (extraHeaders) {
    for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  }
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function classify(action, func) {
  if (action === 'run') {
    return RUN_FUNCTIONS.has(String(func || '')) ? { ok: true, isWrite: true } : { ok: false, isWrite: false };
  }
  if (WRITE_ACTIONS.has(action)) return { ok: true, isWrite: true };
  if (READ_ACTIONS.has(action)) return { ok: true, isWrite: false };
  return { ok: false, isWrite: false };
}

async function readJsonBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; if (raw.length > 5 * 1024 * 1024) req.destroy(); });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { resolve({}); }
    });
    req.on('error', () => resolve({}));
  });
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

  const url = new URL(req.url, 'http://localhost');
  const sp = url.searchParams;
  let body = {};
  if (req.method === 'POST') body = await readJsonBody(req);

  const action = String(body.action || sp.get('action') || '');
  const func = String(body.func || sp.get('func') || '');
  const { ok, isWrite } = classify(action, func);
  if (!ok) { send(res, 400, { error: "action '" + action + "' 미허용" }); return; }

  const noCacheParam = sp.get('nocache');
  const noCache = noCacheParam === '1' || noCacheParam === 'true';

  // 페이지가 붙여 보내는 key는 무시하고 서버측 key로 교체
  sp.delete('key');
  sp.set('key', GAS_KEY);

  try {
    if (req.method === 'POST') {
      const payload = {};
      sp.forEach((v, k) => { payload[k] = v; });
      Object.assign(payload, body, { action: action, key: GAS_KEY });
      const r = await fetch(GAS_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        redirect: 'follow',
        signal: AbortSignal.timeout(60000)
      });
      const text = await r.text();
      if (isWrite) invalidateReads();
      send(res, r.status, text, { 'x-cache': isWrite ? 'POST-WRITE' : 'POST' });
      return;
    }

    const qs = sp.toString();
    if (!isWrite && !noCache) {
      const hit = cache.get(qs);
      if (hit && Date.now() - hit.at < TTL_MS) {
        send(res, 200, hit.body, { 'x-cache': 'HIT' });
        return;
      }
      if (hit) cache.delete(qs);
    }
    const r = await fetch(GAS_URL + '?' + qs, { redirect: 'follow', signal: AbortSignal.timeout(40000) });
    const text = await r.text();
    if (isWrite) {
      invalidateReads();
    } else if (r.ok && !noCache && isCacheableBody(text)) {
      cache.set(qs, { at: Date.now(), body: text });
      if (cache.size > MAX_CACHE) pruneCache(Date.now());
    }
    send(res, r.status, text, { 'x-cache': isWrite ? 'WRITE' : 'MISS' });
  } catch (e) {
    send(res, 502, { error: 'GAS 호출 실패: ' + (e && e.message ? e.message : String(e)) });
  }
};
