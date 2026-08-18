'use strict';

const fs = require('node:fs');
const { DEFAULT_ENV_FILE, parseEnv } = require('./village-live-read.js');

const MAX_EQUIPMENT = 40;
const MAX_BATCH_REQUESTS = 10;
const MAX_RECONCILE_GROUPS = 10;
const ALLOWED_REQUEST_FIELDS = new Set([
  '반출일', '반출시간', '반납일', '반납시간', '예약자명', '연락처',
  '할인유형', '업체명', '장비', '비고', '추가요청'
]);
const ALLOWED_ITEM_FIELDS = new Set(['이름', '수량']);

// 계획 모델이 바뀌어도(예: 영어 필드명으로 계획을 산출하는 모델) 한 번의 왕복으로
// 스스로 교정하거나 아예 실패하지 않도록, 뜻이 유일한 별칭만 정본 한글 필드로 매핑한다.
// 매핑이 애매해질 수 있는 이름(request, action 등)은 절대 별칭으로 넣지 않는다.
const REQUEST_FIELD_ALIASES = new Map(Object.entries({
  customerName: '예약자명',
  customer_name: '예약자명',
  requesterName: '예약자명',
  requester_name: '예약자명',
  requester: '예약자명',
  reserverName: '예약자명',
  예약자: '예약자명',
  phone: '연락처',
  phoneNumber: '연락처',
  phone_number: '연락처',
  contact: '연락처',
  tel: '연락처',
  전화번호: '연락처',
  pickupDate: '반출일',
  pickup_date: '반출일',
  startDate: '반출일',
  start_date: '반출일',
  rentalStartDate: '반출일',
  pickupTime: '반출시간',
  pickup_time: '반출시간',
  startTime: '반출시간',
  start_time: '반출시간',
  returnDate: '반납일',
  return_date: '반납일',
  endDate: '반납일',
  end_date: '반납일',
  returnTime: '반납시간',
  return_time: '반납시간',
  endTime: '반납시간',
  end_time: '반납시간',
  equipment: '장비',
  equipments: '장비',
  equipmentList: '장비',
  equipment_list: '장비',
  items: '장비',
  discountType: '할인유형',
  discount_type: '할인유형',
  discount: '할인유형',
  company: '업체명',
  companyName: '업체명',
  company_name: '업체명',
  note: '비고',
  notes: '비고',
  memo: '비고',
  additionalRequest: '추가요청',
  additional_request: '추가요청',
  extraRequest: '추가요청'
}));

const ITEM_FIELD_ALIASES = new Map(Object.entries({
  name: '이름',
  equipmentName: '이름',
  equipment_name: '이름',
  장비명: '이름',
  quantity: '수량',
  qty: '수량',
  count: '수량'
}));

function allowedFieldsHelp(allowed, aliases) {
  const aliasSample = Array.from(new Set(aliases.values()))
    .map((canonical) => {
      const names = [];
      for (const [alias, target] of aliases) {
        if (target === canonical) names.push(alias);
        if (names.length >= 2) break;
      }
      return `${names.join('/')}→${canonical}`;
    })
    .join(', ');
  return `Allowed fields: ${Array.from(allowed).join(', ')}. `
    + `Recognized aliases are mapped automatically (${aliasSample}).`;
}

// 별칭 키를 정본 한글 키로 정규화한다. 정본 키와 별칭이 서로 다른 값으로 동시에
// 오면 조용히 하나를 고르지 않고 명시적으로 실패한다(잘못된 예약 데이터 방지).
function canonicalizeFields(value, aliases, allowed, scope) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${scope} must be an object`);
  }
  const canonical = {};
  for (const key of Object.keys(value)) {
    const target = allowed.has(key) ? key : aliases.get(key);
    if (!target) {
      throw new Error(
        `Unsupported or forbidden field in ${scope}: ${key}. ${allowedFieldsHelp(allowed, aliases)}`
      );
    }
    if (target in canonical) {
      const existing = String(canonical[target] ?? '').trim();
      const incoming = String(value[key] ?? '').trim();
      if (existing !== incoming) {
        throw new Error(`Conflicting values for ${target} in ${scope} (alias: ${key})`);
      }
      continue;
    }
    canonical[target] = value[key];
  }
  return canonical;
}

function requiredText(value, name, maxLength = 200) {
  const normalized = String(value ?? '').trim();
  if (!normalized || normalized.length > maxLength) {
    throw new Error(`${name} must contain 1-${maxLength} characters`);
  }
  return normalized;
}

function baseUrl(config) {
  const apiUrl = config?.VILLAGE2_API_URL;
  const apiKey = config?.VILLAGE2_API_KEY;
  if (!apiUrl || !apiKey) throw new Error('Village confirmation-request configuration is incomplete');
  const url = new URL(apiUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'script.google.com') {
    throw new Error('Village confirmation-request endpoint must use https://script.google.com');
  }
  url.searchParams.set('key', apiKey);
  return url;
}

function buildSearchRequest(config, { sheet, query, col = 'A' }) {
  if (sheet !== '목록' && sheet !== '확인요청') {
    throw new Error(`Unsupported confirmation-request sheet: ${sheet}`);
  }
  if (col !== 'A' && col !== 'K') {
    throw new Error(`Unsupported confirmation-request search column: ${col}`);
  }
  const url = baseUrl(config);
  url.searchParams.set('action', 'search');
  url.searchParams.set('sheet', sheet);
  url.searchParams.set('col', col);
  url.searchParams.set('query', requiredText(query, 'query'));
  return { method: 'GET', url: url.toString() };
}

function buildInsertRequest(config, request) {
  const url = baseUrl(config);
  url.searchParams.set('action', 'run');
  url.searchParams.set('func', 'insertAndCheckRequest');
  url.searchParams.set('args', JSON.stringify({ ...request, 장비명원문보존: true }));
  if (url.toString().length > 16_000) {
    throw new Error('Confirmation-request payload is too large for the bounded GET route');
  }
  return { method: 'GET', url: url.toString() };
}

function normalizeRequestId(value) {
  const reqID = requiredText(value, 'reqID', 40);
  if (!/^RQ-\d{6}-\d{3,}$/.test(reqID)) throw new Error('reqID must use RQ-YYMMDD-NNN format');
  return reqID;
}

function buildUpdateRequest(config, reqID, request) {
  const url = baseUrl(config);
  url.searchParams.set('action', 'run');
  url.searchParams.set('func', 'updateRequest');
  url.searchParams.set('args', JSON.stringify({
    reqID: normalizeRequestId(reqID),
    ...request,
    장비명원문보존: true
  }));
  if (url.toString().length > 16_000) {
    throw new Error('Confirmation-request payload is too large for the bounded GET route');
  }
  return { method: 'GET', url: url.toString() };
}

async function fetchJson(fetchImpl, request, timeoutMs, label) {
  const response = await fetchImpl(request.url, {
    method: request.method,
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response?.ok) {
    throw new Error(`${label} failed with HTTP ${response?.status ?? 'unknown'}`);
  }
  const payload = await response.json();
  if (!payload || payload.error) {
    throw new Error(`${label} failed: ${String(payload?.error || 'empty response')}`);
  }
  return payload;
}

function uniqueCandidateNames(payload) {
  const names = [];
  const seen = new Set();
  for (const result of Array.isArray(payload?.results) ? payload.results : []) {
    const name = String(Array.isArray(result?.data) ? result.data[0] : '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
    if (names.length >= 30) break;
  }
  return names;
}

async function searchCatalog({ config, query, fetchImpl, timeoutMs }) {
  const normalizedQuery = requiredText(query, 'equipment query', 120);
  const request = buildSearchRequest(config, { sheet: '목록', query: normalizedQuery });
  const payload = await fetchJson(fetchImpl, request, timeoutMs, `Catalog search for ${normalizedQuery}`);
  return { query: normalizedQuery, candidates: uniqueCandidateNames(payload) };
}

async function resolveEquipment({
  config,
  queries,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  if (!Array.isArray(queries) || queries.length === 0 || queries.length > MAX_EQUIPMENT) {
    throw new Error(`queries must contain 1-${MAX_EQUIPMENT} equipment terms`);
  }
  const normalized = queries.map((query) => requiredText(query, 'equipment query', 120));
  const items = await Promise.all(normalized.map((query) => searchCatalog({
    config, query, fetchImpl, timeoutMs
  })));
  return { ok: true, mode: 'resolve-only', items };
}

function assertOnlyAllowedFields(value, allowed, scope) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${scope} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`Unsupported or forbidden field in ${scope}: ${key}`);
  }
}

// 뜻이 유일한 표기 편차(구분자 ./ 사용, 한 자리 월·일·시)는 정규형으로 흡수한다.
// 애매한 입력(2자리 연도, 12시간제 등)은 그대로 실패시켜 잘못된 예약을 막는다.
function normalizeDate(value, name) {
  const text = requiredText(value, name, 20);
  const match = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})$/.exec(text);
  if (!match) throw new Error(`${name} must use YYYY-MM-DD (got: ${text})`);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`${name} must use YYYY-MM-DD (got: ${text})`);
  }
  return `${match[1]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function normalizeTime(value, name) {
  const text = requiredText(value, name, 8);
  const match = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(text);
  if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) {
    throw new Error(`${name} must use HH:MM (got: ${text})`);
  }
  return `${String(Number(match[1])).padStart(2, '0')}:${match[2]}`;
}

function normalizeConfirmationRequest(request) {
  const canonicalRequest = canonicalizeFields(
    request, REQUEST_FIELD_ALIASES, ALLOWED_REQUEST_FIELDS, 'confirmation request'
  );
  assertOnlyAllowedFields(canonicalRequest, ALLOWED_REQUEST_FIELDS, 'confirmation request');
  if (!Array.isArray(canonicalRequest.장비) || canonicalRequest.장비.length === 0 || canonicalRequest.장비.length > MAX_EQUIPMENT) {
    throw new Error(`장비 must contain 1-${MAX_EQUIPMENT} items`);
  }
  const equipment = canonicalRequest.장비.map((rawItem, index) => {
    const item = canonicalizeFields(rawItem, ITEM_FIELD_ALIASES, ALLOWED_ITEM_FIELDS, `장비[${index}]`);
    assertOnlyAllowedFields(item, ALLOWED_ITEM_FIELDS, `장비[${index}]`);
    const quantity = Number(item.수량 ?? 1);
    if (!Number.isSafeInteger(quantity) || quantity < 1 || quantity > 999) {
      throw new Error(`장비[${index}].수량 must be an integer from 1 to 999`);
    }
    return { 이름: requiredText(item.이름, `장비[${index}].이름`, 120), 수량: quantity };
  });
  const normalized = {
    반출일: normalizeDate(canonicalRequest.반출일, '반출일'),
    반출시간: normalizeTime(canonicalRequest.반출시간, '반출시간'),
    반납일: normalizeDate(canonicalRequest.반납일, '반납일'),
    반납시간: normalizeTime(canonicalRequest.반납시간, '반납시간'),
    예약자명: requiredText(canonicalRequest.예약자명, '예약자명', 80),
    장비: equipment
  };
  for (const key of ['연락처', '할인유형', '업체명', '비고', '추가요청']) {
    if (canonicalRequest[key] !== undefined && canonicalRequest[key] !== null && String(canonicalRequest[key]).trim()) {
      normalized[key] = requiredText(canonicalRequest[key], key, key === '비고' || key === '추가요청' ? 180 : 80);
    }
  }
  return normalized;
}

function normalizeUnregisteredOriginals(values, request) {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values) || values.length > MAX_EQUIPMENT) {
    throw new Error(`unregisteredOriginals must contain 0-${MAX_EQUIPMENT} exact equipment names`);
  }
  const equipmentNames = new Set(request.장비.map((item) => item.이름));
  const normalized = [];
  for (const value of values) {
    const name = requiredText(value, 'unregisteredOriginals item', 120);
    if (!equipmentNames.has(name)) {
      throw new Error(`unregisteredOriginals must exactly match an equipment item: ${name}`);
    }
    if (!normalized.includes(name)) normalized.push(name);
  }
  return normalized;
}

// insert가 성공한 뒤(readback 단계부터)의 실패는 "쓰기가 됐는지 알 수 없는" 상태다.
// reqID를 잃어버리면 에이전트가 재확인(reconcile)할 방법이 없으므로 에러에 구조화해 남긴다.
function markUncertainWrite(error, reqID, stage) {
  error.uncertainWrite = true;
  if (reqID) error.reqID = reqID;
  error.stage = stage;
  return error;
}

function summarizeReadback(payload, reqID) {
  const rows = [];
  for (const result of Array.isArray(payload?.results) ? payload.results : []) {
    const data = Array.isArray(result?.data) ? result.data : [];
    if (String(data[0] ?? '').trim() !== reqID) continue;
    rows.push({
      row: Number(result.row) || null,
      pickupDate: String(data[1] ?? ''),
      pickupTime: String(data[2] ?? ''),
      returnDate: String(data[3] ?? ''),
      returnTime: String(data[4] ?? ''),
      equipment: String(data[5] ?? ''),
      quantity: data[6] ?? '',
      availability: String(data[8] ?? ''),
      detail: String(data[9] ?? ''),
      requester: String(data[10] ?? ''),
      hasContact: Boolean(String(data[11] ?? '').trim()),
      discountType: String(data[12] ?? ''),
      registrationStatus: String(data[14] ?? ''),
      note: String(data[16] ?? ''),
      additionalRequest: String(data[17] ?? '')
    });
  }
  if (rows.length === 0) throw new Error(`Confirmation-request readback verification failed for ${reqID}`);
  return rows;
}

function verifyIntendedReadback(rows, request, reqID) {
  const header = rows.find((row) => row.pickupDate || row.requester) || rows[0];
  if (
    header.pickupDate !== request.반출일
    || header.pickupTime !== request.반출시간
    || header.returnDate !== request.반납일
    || header.returnTime !== request.반납시간
    || header.requester !== request.예약자명
  ) {
    throw new Error(`Confirmation-request schedule readback verification failed for ${reqID}`);
  }
  if (request.연락처 && !header.hasContact) {
    throw new Error(`Confirmation-request contact readback verification failed for ${reqID}`);
  }
  if (request.할인유형 && header.discountType !== request.할인유형) {
    throw new Error(`Confirmation-request discount readback verification failed for ${reqID}`);
  }
  for (const item of request.장비) {
    const found = rows.some((row) => (
      row.equipment === item.이름 && Number(row.quantity) === item.수량
    ));
    if (!found) {
      throw new Error(`Intended equipment readback verification failed for ${reqID}: ${item.이름}`);
    }
  }
}

async function createConfirmationRequest({
  config,
  request,
  unregisteredOriginals = [],
  fetchImpl = globalThis.fetch,
  readTimeoutMs = 30_000,
  writeTimeoutMs = 180_000
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  const normalized = normalizeConfirmationRequest(request);
  const normalizedOriginals = normalizeUnregisteredOriginals(unregisteredOriginals, normalized);

  await preflightCatalog({
    config,
    requests: [normalized],
    unregisteredOriginals: normalizedOriginals,
    fetchImpl,
    timeoutMs: readTimeoutMs
  });

  return insertAndVerifyConfirmationRequest({
    config,
    request: normalized,
    fetchImpl,
    readTimeoutMs,
    writeTimeoutMs
  });
}

async function updateConfirmationRequest({
  config,
  reqID,
  request,
  unregisteredOriginals = [],
  fetchImpl = globalThis.fetch,
  readTimeoutMs = 30_000,
  writeTimeoutMs = 180_000
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  const normalizedReqID = normalizeRequestId(reqID);
  const normalized = normalizeConfirmationRequest(request);
  const normalizedOriginals = normalizeUnregisteredOriginals(unregisteredOriginals, normalized);
  await preflightCatalog({
    config,
    requests: [normalized],
    unregisteredOriginals: normalizedOriginals,
    fetchImpl,
    timeoutMs: readTimeoutMs
  });
  const updatePayload = await fetchJson(
    fetchImpl,
    buildUpdateRequest(config, normalizedReqID, normalized),
    writeTimeoutMs,
    'Confirmation-request update'
  );
  if (updatePayload.success !== true) {
    throw new Error(`Confirmation-request update failed for ${normalizedReqID}`);
  }
  try {
    const readbackPayload = await fetchJson(
      fetchImpl,
      buildSearchRequest(config, { sheet: '확인요청', query: normalizedReqID }),
      readTimeoutMs,
      'Confirmation-request readback'
    );
    const rows = summarizeReadback(readbackPayload, normalizedReqID);
    verifyIntendedReadback(rows, normalized, normalizedReqID);
    return { ok: true, reqID: normalizedReqID, updated: true, verified: true, rows };
  } catch (error) {
    throw markUncertainWrite(error, normalizedReqID, 'update_readback');
  }
}

async function preflightCatalog({ config, requests, unregisteredOriginals = [], fetchImpl, timeoutMs }) {
  const preservedOriginals = new Set(unregisteredOriginals);
  const catalog = await Promise.all(requests.flatMap((request) => (
    request.장비
      .filter((item) => !preservedOriginals.has(item.이름))
      .map((item) => searchCatalog({
      config,
      query: item.이름,
      fetchImpl,
      timeoutMs
      }))
  )));
  const unresolved = catalog.filter((item) => !item.candidates.includes(item.query));
  if (unresolved.length > 0) {
    throw new Error(`Catalog exact match required before mutation: ${unresolved.map((item) => item.query).join(', ')}`);
  }
}

async function insertAndVerifyConfirmationRequest({
  config,
  request,
  fetchImpl,
  readTimeoutMs,
  writeTimeoutMs
}) {
  const insertPayload = await fetchJson(
    fetchImpl,
    buildInsertRequest(config, request),
    writeTimeoutMs,
    'Confirmation-request insert'
  );
  if (insertPayload.success !== true || !/^RQ-\d{6}-\d{3,}$/.test(String(insertPayload.reqID || ''))) {
    throw new Error('Confirmation-request insert did not return a valid request ID');
  }
  const reqID = String(insertPayload.reqID);
  try {
    const readbackPayload = await fetchJson(
      fetchImpl,
      buildSearchRequest(config, { sheet: '확인요청', query: reqID }),
      readTimeoutMs,
      'Confirmation-request readback'
    );
    const rows = summarizeReadback(readbackPayload, reqID);
    verifyIntendedReadback(rows, request, reqID);

    return {
      ok: true,
      reqID,
      duplicate: insertPayload.duplicate === true,
      verified: true,
      rows
    };
  } catch (error) {
    throw markUncertainWrite(error, reqID, 'insert_readback');
  }
}

// summarizeReadback과 같은 열 매핑이지만, 행이 없어도 예외를 던지지 않는다.
// reconcile은 "없다"는 사실 자체가 유효한 답이기 때문이다.
function summarizeReconcileRows(payload, reqID) {
  try {
    return summarizeReadback(payload, reqID);
  } catch {
    return [];
  }
}

const RECONCILE_ALIASES = new Map(Object.entries({
  requestId: 'reqID',
  request_id: 'reqID',
  reqId: 'reqID',
  id: 'reqID',
  요청ID: 'reqID',
  customerName: '예약자명',
  customer_name: '예약자명',
  requester: '예약자명',
  예약자: '예약자명',
  pickupDate: '반출일',
  pickup_date: '반출일',
  startDate: '반출일'
}));
const RECONCILE_FIELDS = new Set(['reqID', '예약자명', '반출일']);

/**
 * 불확실한 쓰기(uncertain write) 전용 읽기 회복 경로.
 * reqID 또는 예약자명(+선택 반출일)으로 확인요청 시트의 실제 상태를 읽어와
 * "쓰기가 실제로 반영됐는지"를 증거로 판정할 수 있게 한다. 어떤 쓰기도 하지 않는다.
 */
async function reconcileConfirmationRequest({
  config,
  query,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  const canonical = canonicalizeFields(query, RECONCILE_ALIASES, RECONCILE_FIELDS, 'reconcile query');
  const wantedDate = canonical.반출일 === undefined || canonical.반출일 === null || String(canonical.반출일).trim() === ''
    ? null
    : normalizeDate(canonical.반출일, '반출일');

  const fetchGroup = async (reqID) => {
    const payload = await fetchJson(
      fetchImpl,
      buildSearchRequest(config, { sheet: '확인요청', query: reqID }),
      timeoutMs,
      `Confirmation-request reconcile readback for ${reqID}`
    );
    return summarizeReconcileRows(payload, reqID);
  };

  if (canonical.reqID !== undefined && canonical.reqID !== null && String(canonical.reqID).trim() !== '') {
    const reqID = normalizeRequestId(canonical.reqID);
    const rows = await fetchGroup(reqID);
    return {
      ok: true,
      mode: 'reconcile',
      readOnly: true,
      reqID,
      found: rows.length > 0,
      rows
    };
  }

  const requester = requiredText(canonical.예약자명, '예약자명', 80);
  const searchPayload = await fetchJson(
    fetchImpl,
    buildSearchRequest(config, { sheet: '확인요청', query: requester, col: 'K' }),
    timeoutMs,
    `Confirmation-request reconcile search for ${requester}`
  );
  const reqIDs = [];
  for (const result of Array.isArray(searchPayload?.results) ? searchPayload.results : []) {
    const data = Array.isArray(result?.data) ? result.data : [];
    const rowReqID = String(data[0] ?? '').trim();
    const rowRequester = String(data[10] ?? '').trim();
    if (!/^RQ-\d{6}-\d{3,}$/.test(rowReqID)) continue;
    if (rowRequester !== requester) continue;
    if (wantedDate && String(data[1] ?? '').trim().slice(0, 10) !== wantedDate) continue;
    if (!reqIDs.includes(rowReqID)) reqIDs.push(rowReqID);
    if (reqIDs.length >= MAX_RECONCILE_GROUPS) break;
  }
  const groups = await Promise.all(reqIDs.map(async (reqID) => {
    const rows = await fetchGroup(reqID);
    return {
      reqID,
      pickupDate: rows[0]?.pickupDate ?? '',
      returnDate: rows[0]?.returnDate ?? '',
      requester: rows[0]?.requester ?? '',
      registrationStatus: rows[0]?.registrationStatus ?? '',
      rows
    };
  }));
  return {
    ok: true,
    mode: 'reconcile',
    readOnly: true,
    query: wantedDate ? { 예약자명: requester, 반출일: wantedDate } : { 예약자명: requester },
    found: groups.length > 0,
    groups
  };
}

async function createConfirmationRequests({
  config,
  requests,
  fetchImpl = globalThis.fetch,
  readTimeoutMs = 30_000,
  writeTimeoutMs = 180_000
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  if (!Array.isArray(requests) || requests.length === 0 || requests.length > MAX_BATCH_REQUESTS) {
    throw new Error(`requests must contain 1-${MAX_BATCH_REQUESTS} AI-planned schedule groups`);
  }
  const plans = requests.map((entry) => {
    const wrapped = entry && typeof entry === 'object' && !Array.isArray(entry) && entry.request;
    const request = normalizeConfirmationRequest(wrapped ? entry.request : entry);
    return {
      request,
      unregisteredOriginals: normalizeUnregisteredOriginals(wrapped ? entry.unregisteredOriginals : [], request)
    };
  });

  // Validate every AI-planned group before the first mutation. This keeps an
  // unresolved item in a later return-time group from producing a partial batch.
  await Promise.all(plans.map((plan) => preflightCatalog({
    config,
    requests: [plan.request],
    unregisteredOriginals: plan.unregisteredOriginals,
    fetchImpl,
    timeoutMs: readTimeoutMs
  })));

  const created = [];
  for (const plan of plans) {
    const request = plan.request;
    try {
      created.push(await insertAndVerifyConfirmationRequest({
        config,
        request,
        fetchImpl,
        readTimeoutMs,
        writeTimeoutMs
      }));
    } catch (error) {
      const completed = created.map((item) => item.reqID).join(', ') || 'none';
      const batchError = new Error(
        `Confirmation-request batch stopped after ${created.length}/${plans.length}; `
        + `completed request IDs: ${completed}. Do not retry completed groups automatically. ${error.message}`
      );
      batchError.completedReqIDs = created.map((item) => item.reqID);
      if (error.uncertainWrite) markUncertainWrite(batchError, error.reqID, error.stage);
      throw batchError;
    }
  }

  return {
    ok: true,
    mode: 'batch',
    verified: created.every((item) => item.verified === true),
    requests: created
  };
}

function parseCliArgs(args) {
  const command = args[0];
  if (command === '--help' || command === '-h' || command === 'help') {
    return { command: 'help', envFile: DEFAULT_ENV_FILE, inputFile: null };
  }
  if (command !== 'resolve' && command !== 'create' && command !== 'create-batch' && command !== 'update' && command !== 'reconcile') {
    throw new Error('Command must be resolve, create, create-batch, update, or reconcile');
  }
  const options = { command, envFile: DEFAULT_ENV_FILE, inputFile: null };
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || (flag !== '--env-file' && flag !== '--input-file')) {
      throw new Error('Only --env-file PATH and --input-file PATH are supported');
    }
    if (flag === '--env-file') options.envFile = value;
    if (flag === '--input-file') options.inputFile = value;
    index += 1;
  }
  return options;
}

function parseJsonInput(source) {
  return JSON.parse(String(source ?? '').replace(/^\uFEFF/, ''));
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.command === 'help') {
    process.stdout.write(
      'Usage: village-confirm-request.js <resolve|create|create-batch|update|reconcile> [--input-file PATH] [--env-file PATH]\n'
      + '  resolve      {"queries":["장비 검색어", ...]} — 목록 시트에서 정확한 장비명 후보 조회 (읽기 전용)\n'
      + '  create       {"반출일","반출시간","반납일","반납시간","예약자명","장비":[{"이름","수량"}], ...} — 확인요청 1건 생성+검증\n'
      + '  create-batch {"requests":[<create payload>, ...]} — 여러 스케줄 그룹을 한 번에 생성+검증\n'
      + '  update       {"reqID":"RQ-YYMMDD-NNN","request":<create payload>} — 기존 미등록 요청 전체 교체+검증\n'
      + '  reconcile    {"reqID":"RQ-..."} 또는 {"예약자명":"이름","반출일":"YYYY-MM-DD"?} — 쓰기 성공 여부가\n'
      + '               불확실할 때(uncertainWrite) 시트 실제 상태를 읽어 판정 (읽기 전용, 재삽입 아님)\n'
      + '  영문 별칭(customerName→예약자명, phone→연락처, pickupDate→반출일, items→장비, name/quantity 등)은 자동 매핑됨.\n'
    );
    return;
  }
  const config = parseEnv(fs.readFileSync(options.envFile, 'utf8'));
  const input = parseJsonInput(fs.readFileSync(options.inputFile || 0, 'utf8'));
  let result;
  if (options.command === 'resolve') {
    result = await resolveEquipment({ config, queries: Array.isArray(input) ? input : input.queries });
  } else if (options.command === 'create-batch') {
    result = await createConfirmationRequests({
      config,
      requests: Array.isArray(input) ? input : input.requests || []
    });
  } else if (options.command === 'update') {
    result = await updateConfirmationRequest({
      config,
      reqID: input.reqID,
      request: input.request || input,
      unregisteredOriginals: input.unregisteredOriginals || []
    });
  } else if (options.command === 'reconcile') {
    result = await reconcileConfirmationRequest({ config, query: input });
  } else {
    result = await createConfirmationRequest({
      config,
      request: input.request || input,
      unregisteredOriginals: input.unregisteredOriginals || []
    });
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

module.exports = {
  buildInsertRequest,
  buildUpdateRequest,
  buildSearchRequest,
  createConfirmationRequest,
  createConfirmationRequests,
  updateConfirmationRequest,
  normalizeConfirmationRequest,
  reconcileConfirmationRequest,
  parseCliArgs,
  parseJsonInput,
  resolveEquipment,
  summarizeReadback,
  verifyIntendedReadback
};

if (require.main === module) {
  main().catch((error) => {
    const failure = { ok: false, error: error.message };
    if (error.uncertainWrite) {
      failure.uncertainWrite = true;
      if (error.reqID) failure.reqID = error.reqID;
      if (error.stage) failure.stage = error.stage;
      failure.guidance = '쓰기가 반영됐을 수 있음. 재삽입 금지. reconcile 명령(reqID 또는 예약자명+반출일)으로 시트 실제 상태를 확인한 뒤 결정할 것.';
    }
    if (Array.isArray(error.completedReqIDs) && error.completedReqIDs.length > 0) {
      failure.completedReqIDs = error.completedReqIDs;
    }
    process.stderr.write(`${JSON.stringify(failure)}\n`);
    process.exitCode = 1;
  });
}
