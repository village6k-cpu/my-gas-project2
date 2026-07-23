#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_GAS_API_URL = 'https://script.google.com/macros/s/AKfycbyRff4-lLXmne-iPIEf87x4-CH_5wb-Uv5dCGymELLrpiKluhg2gDdLdVP4Y0MmxnnT/exec';
const DEFAULT_SHEET_API_KEY = 'village2026';
const VILLAGE_SHEET_ID = '17cl0YlZYA6j9hlTqPFIe5J0UdjuLcfxZyQfKGF00Ksk';
const VILLAGE_OPS_SHEET_ID = '1ssb6EyuRRCU04Zf4UAtdbpYYkWcseGqnhWVONdrqol8';
const DEFAULT_KAKAO_CHANNEL_MANAGER_URL = 'https://business.kakao.com/_xhPMls/chats?t_src=business_partnercenter&t_ch=lnb&t_obj=%EB%82%B4%EC%B1%84%ED%8C%85_%ED%81%B4%EB%A6%AD';
const DEFAULT_KAKAO_REMOTE_DEBUGGING_PORT = '9223';
const DEFAULT_SLACK_CHANNELS = {
  schedule: '스케쥴-agent',
  document: '서류발송-agent',
  settlement: '정산-agent',
  inventory: '재고관리-agent',
  other: '기타문의'
};

export function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return false;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
  return true;
}

export function kakaoDevtoolsBaseUrlFromEnv(env = process.env) {
  const explicit = env.KAKAO_DEVTOOLS_URL || env.KAKAO_CDP_HTTP_URL || env.KAKAO_CDP_URL;
  if (explicit) return String(explicit).replace(/\/+$/, '');
  const port = env.KAKAO_REMOTE_DEBUGGING_PORT || env.VILLAGE_KAKAO_REMOTE_DEBUGGING_PORT;
  if (!port) return '';
  return `http://127.0.0.1:${port || DEFAULT_KAKAO_REMOTE_DEBUGGING_PORT}`;
}

function isExecutable(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveHermesCommand(command = 'hermes', env = process.env) {
  if (String(command).includes('/')) return command;
  const home = env.HOME || process.env.HOME || '';
  const dirs = [
    ...(env.PATH || '').split(path.delimiter).filter(Boolean),
    home ? path.join(home, '.local/bin') : '',
    home ? path.join(home, '.hermes/hermes-agent/venv/bin') : '',
    home ? path.join(home, '.hermes/hermes-agent') : ''
  ].filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, command);
    if (isExecutable(candidate)) return candidate;
  }
  return command;
}

export function resolveCuaDriverCommand(command = 'cua-driver', env = process.env) {
  if (!command) return '';
  if (String(command).includes('/')) return isExecutable(command) ? command : '';
  const home = env.HOME || process.env.HOME || '';
  const dirs = [
    ...(env.PATH || '').split(path.delimiter).filter(Boolean),
    home ? path.join(home, '.local/bin') : '',
    '/opt/homebrew/bin',
    '/usr/local/bin'
  ].filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, command);
    if (isExecutable(candidate)) return candidate;
  }
  return '';
}

export function normalizeKakaoWorkerControlMode(value = '') {
  const mode = String(value || '').trim().toLowerCase();
  if (mode === 'cua_first') return 'cua_first';
  if (mode === 'devtools_only' || mode === 'cua_disabled' || mode === 'no_cua') return 'devtools_only';
  return 'devtools_first';
}

function numberFromEnv(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function parseMacHidIdleSeconds(ioregText = '') {
  const match = String(ioregText || '').match(/"HIDIdleTime"\s*=\s*(\d+)/);
  if (!match) return null;
  const nanoseconds = Number(match[1]);
  if (!Number.isFinite(nanoseconds)) return null;
  return nanoseconds / 1_000_000_000;
}

export function buildGasReadUrl(gasApiUrl, apiKey, params = {}) {
  const url = new URL(gasApiUrl);
  url.searchParams.set('key', apiKey);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function buildGvizUrl(sheet, tq) {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${VILLAGE_SHEET_ID}/gviz/tq`);
  url.searchParams.set('tqx', 'out:json');
  url.searchParams.set('sheet', sheet);
  url.searchParams.set('tq', tq);
  return url.toString();
}

function buildOpsGvizUrl(sheet, tq, sheetId = VILLAGE_OPS_SHEET_ID) {
  const url = new URL(`https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq`);
  url.searchParams.set('tqx', 'out:json');
  url.searchParams.set('sheet', sheet);
  url.searchParams.set('tq', tq);
  return url.toString();
}

function parseGvizResponse(textBody = '') {
  const raw = String(textBody || '').trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Invalid GViz response');
  return JSON.parse(raw.slice(start, end + 1));
}

export function normalizeCustomerDbPhoneKey(value = '') {
  let digits = text(value).replace(/\D/g, '');
  if (digits.startsWith('82') && digits.length >= 11) digits = `0${digits.slice(2)}`;
  return digits.length > 10 ? digits.slice(-10) : digits;
}

export function normalizeCustomerDbDiscountType(value = '') {
  const normalized = text(value).normalize('NFKC').replace(/\s+/g, '').trim();
  if (!normalized) return '';
  if (normalized === '일반') return '일반';
  if (/단골/.test(normalized)) return '단골';
  if (/제휴/.test(normalized)) return '제휴';
  if (/학생|재학|학번|학사|대학|고등|중학/.test(normalized)) return '학생';
  if (/사업자|개인사업자|프리랜서|프리|개사프|자영|1인|소상공/.test(normalized)) return '개인사업자/프리랜서';
  return '';
}

function pickBestCustomerDbDiscount(matches = []) {
  const rank = { '일반': 1, '개인사업자/프리랜서': 2, '학생': 3, '제휴': 4, '단골': 5 };
  return matches.reduce((best, match) => {
    const discountType = normalizeCustomerDbDiscountType(match.discount);
    if (!discountType) return best;
    if (!best.discountType || (rank[discountType] || 0) > (rank[best.discountType] || 0)) {
      return { discountType, source: match.source, matchedBy: match.matchedBy, rawDiscount: match.discount };
    }
    return best;
  }, { discountType: '', source: '', matchedBy: '', rawDiscount: '' });
}

export async function lookupCustomerDbDiscountForRequest({ customerName = '', phone = '' } = {}, config = {}, options = {}) {
  const fetchImpl = options.fetchImpl || config.fetchImpl || fetch;
  const sheetId = config.villageOpsSheetId || process.env.VILLAGE_OPS_SHEET_ID || VILLAGE_OPS_SHEET_ID;
  const nameKey = text(customerName).trim();
  const phoneKey = normalizeCustomerDbPhoneKey(phone);
  if (!nameKey && !phoneKey) return { matched: false, discountType: '', reason: 'missing_customer_identity', matches: [] };

  const url = options.url || buildOpsGvizUrl('고객DB', 'SELECT A,B,I', sheetId);
  const response = await fetchImpl(url, {
    signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(options.timeoutMs || config.customerDbTimeoutMs || 20000) : undefined
  });
  const textBody = await response.text();
  if (!response.ok) throw new Error(`Customer DB lookup failed HTTP ${response.status}: ${textBody.slice(0, 300)}`);
  const parsed = parseGvizResponse(textBody);
  const rows = Array.isArray(parsed?.table?.rows) ? parsed.table.rows : [];
  const mapped = rows.map((row) => {
    const cells = Array.isArray(row?.c) ? row.c : [];
    return {
      phone: text(cells[0]?.v).trim(),
      name: text(cells[1]?.v).trim(),
      discount: text(cells[2]?.v).trim(),
      source: 'village2_customer_db_gviz'
    };
  });
  const phoneMatches = phoneKey
    ? mapped.filter((row) => normalizeCustomerDbPhoneKey(row.phone) === phoneKey).map((row) => ({ ...row, matchedBy: 'phone' }))
    : [];
  const nameMatches = nameKey
    ? mapped.filter((row) => row.name === nameKey).map((row) => ({ ...row, matchedBy: 'name' }))
    : [];
  const matches = phoneMatches.length ? phoneMatches : nameMatches;
  const distinctPhones = Array.from(new Set(matches.map((row) => normalizeCustomerDbPhoneKey(row.phone)).filter(Boolean)));
  const ambiguous = !phoneKey && distinctPhones.length > 1;
  const best = pickBestCustomerDbDiscount(matches);
  return {
    matched: matches.length > 0,
    ambiguous,
    discountType: ambiguous ? '' : best.discountType,
    rawDiscount: ambiguous ? '' : best.rawDiscount,
    matchedBy: ambiguous ? 'ambiguous_name' : (best.matchedBy || (phoneMatches.length ? 'phone' : (nameMatches.length ? 'name' : ''))),
    source: best.source || (matches[0]?.source || ''),
    matchCount: matches.length,
    distinctPhoneCount: distinctPhones.length,
    matches: matches.slice(0, 5).map((row) => ({ name: row.name, phone: row.phone, discount: row.discount, matchedBy: row.matchedBy }))
  };
}

export async function enrichSheetPayloadWithCustomerDbDiscount(config = {}, sheetPayload = null, options = {}) {
  if (!sheetPayload?.args) return { payload: sheetPayload, lookup: { matched: false, reason: 'missing_sheet_payload' } };
  const args = sheetPayload.args;
  const lookup = await lookupCustomerDbDiscountForRequest({
    customerName: args.예약자명,
    phone: args.연락처
  }, config, options);
  if (!lookup.discountType) return { payload: sheetPayload, lookup };
  return {
    payload: {
      ...sheetPayload,
      args: {
        ...args,
        할인유형: lookup.discountType
      }
    },
    lookup
  };
}

async function fetchReadOnlyJson(url, { fetchImpl = fetch, timeoutMs = 30000 } = {}) {
  const response = await fetchImpl(url, {
    signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined
  });
  const textBody = await response.text();
  let data = null;
  try { data = textBody ? JSON.parse(textBody) : null; } catch { data = { raw: textBody }; }
  if (!response.ok) throw new Error(`Read-only GAS lookup failed HTTP ${response.status}: ${JSON.stringify(data).slice(0, 500)}`);
  return data;
}

function extractKillSwitchStatus(data) {
  return data?.data?.[0]?.[0] || data?.values?.[0]?.[0] || data?.value || data?.headers?.[0] || 'not_checked';
}

export function parseVillageAiSse(textBody = '') {
  const result = {
    text: '',
    confidence: null,
    ownerReview: null,
    knowledgeSource: null,
    usedSources: [],
    topSimilarity: null,
    logId: null,
    error: null,
    done: false
  };
  for (const eventBlock of String(textBody).split(/\n\n+/)) {
    const dataLines = eventBlock
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim());
    if (!dataLines.length) continue;
    const raw = dataLines.join('\n');
    if (!raw || raw === '[DONE]') {
      result.done = true;
      continue;
    }
    let event;
    try { event = JSON.parse(raw); } catch { continue; }
    if (event.type === 'text') {
      result.text += event.text || event.content || '';
    } else if (event.type === 'meta') {
      if ('confidence' in event) result.confidence = event.confidence;
      if ('ownerReview' in event) result.ownerReview = event.ownerReview;
      if ('knowledgeSource' in event) result.knowledgeSource = event.knowledgeSource;
      if ('usedSources' in event) result.usedSources = event.usedSources || [];
      if ('topSimilarity' in event) result.topSimilarity = event.topSimilarity;
      if ('logId' in event) result.logId = event.logId;
    } else if (event.type === 'done') {
      result.done = true;
    } else if (event.type === 'error') {
      result.error = event.error || event.message || 'RAG error';
    }
  }
  return result;
}

export async function askVillageAi(questionOrPayload, config = {}, options = {}) {
  const villageAiUrl = String(config.villageAiUrl || '').replace(/\/$/, '');
  if (!villageAiUrl) throw new Error('VILLAGE_AI_URL is not configured');
  const payload = typeof questionOrPayload === 'string'
    ? { question: questionOrPayload, userRole: 'customer' }
    : { userRole: 'customer', ...questionOrPayload };
  if (!payload.question || typeof payload.question !== 'string') throw new Error('RAG question is required');
  const headers = { 'Content-Type': 'application/json' };
  if (config.villageAiKakaoSkillSecret) headers['x-kakao-skill-secret'] = config.villageAiKakaoSkillSecret;
  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl(`${villageAiUrl}/api/ask`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(options.timeoutMs || config.ragTimeoutMs || 30000) : undefined
  });
  const textBody = await response.text();
  if (!response.ok) throw new Error(`Village AI RAG lookup failed HTTP ${response.status}: ${textBody.slice(0, 500)}`);
  const parsed = parseVillageAiSse(textBody);
  return {
    text: parsed.text.trim(),
    confidence: parsed.confidence,
    ownerReview: parsed.ownerReview,
    knowledgeSource: parsed.knowledgeSource,
    usedSources: parsed.usedSources,
    topSimilarity: parsed.topSimilarity,
    logId: parsed.logId,
    error: parsed.error,
    done: parsed.done
  };
}

export function buildReadOnlyRagContext(config = {}) {
  const enabled = Boolean(config.villageAiUrl);
  return {
    enabled,
    provider: 'village-ai',
    mode: 'read_only_reference',
    query_policy: {
      use_after_opening_kakao_conversation: true,
      include_screen_context_in_question_string: true,
      use_cases: [
        'current-safe FAQ, included components, pickup/return procedure, and non-mutable policy reference',
        'similar past Kakao conversations and village reply tone examples',
        'follow-up questions such as 그거/이거/같이/아까 말한 것 where recent Kakao context must be summarized into the question',
        'homepage or village historical policy grounding before drafting a reviewed reply'
      ],
      forbidden_uses: [
        'do not replace Kakao screen evidence',
        'do not replace Sheets/GAS duplicate checks',
        'do not use for equipment-name normalization, booking-name extraction, or phone extraction',
        'do not use for current inventory availability, actual booking confirmation, or schedule/contract mutations',
        'do not override the worker current_confirmed_policy block with older historical Kakao/RAG when they conflict',
        'do not send Kakao messages or write Sheets from RAG tool output',
        'do not copy-paste RAG text verbatim into the final reply draft'
      ],
      interpretation_rules: {
        high: 'Use actively as reply/procedure reference. For mutable policies, current_confirmed_policy wins when present; otherwise high/retrieved RAG may support auto-send.',
        low: 'Use only for tone/procedure hints; be cautious.',
        no_match_or_empty: 'Do not trust RAG; rely on Kakao screen and operational flow.',
        ownerReview_true: 'Price/discount/payment/refund sensitive; require extra human verification before any auto-send phase.',
        knowledgeSource_retrieved: 'Village material based.',
        knowledgeSource_general: 'May include general knowledge; do not present as firm village policy.'
      }
    },
    tool: enabled
      ? {
          command: 'node tools/ai-browser-worker/worker.mjs --rag-lookup',
          stdin_schema: {
            question: '고객 최신 질문 + 필요한 앞 대화 맥락을 짧게 합친 질문',
            userRole: 'customer',
            context: { previousLogId: 'optional', previousQuestion: 'optional', previousAnswer: 'optional' }
          },
          output_schema: ['text', 'confidence', 'ownerReview', 'knowledgeSource', 'usedSources', 'topSimilarity', 'logId', 'error'],
          env: {
            village_ai_url: 'VILLAGE_AI_URL',
            secret_env: config.villageAiKakaoSkillSecret ? 'VILLAGE_AI_KAKAO_SKILL_SECRET' : null
          },
          secret_policy: 'Do not print API keys or shared secrets. The helper sends x-kakao-skill-secret internally when configured.'
        }
      : null,
    unavailable_reason: enabled ? null : 'VILLAGE_AI_URL is not configured in the worker environment.',
    note: 'RAG 답변을 그대로 복붙하지 말고, 카카오 화면의 실제 대화 순서와 최신 고객 메시지를 1차 진실로 본다. 현재 확정 정책과 충돌하는 과거 카톡/RAG는 무시하고, 확정 정책에 없는 보증금/환불/계좌/증빙 등은 high/retrieved RAG로 보강한다.'
  };
}

export async function buildReadOnlyLookupContext(config, job = {}, options = {}) {
  const gasApiUrl = config.gasApiUrl || DEFAULT_GAS_API_URL;
  const sheetApiKey = config.sheetApiKey || DEFAULT_SHEET_API_KEY;
  const killSwitchUrl = buildGasReadUrl(gasApiUrl, sheetApiKey, {
    action: 'read',
    sheet: '설정',
    range: 'A1'
  });

  let killSwitch = { status: 'not_checked', error: null };
  try {
    const data = await fetchReadOnlyJson(killSwitchUrl, options);
    killSwitch = { status: extractKillSwitchStatus(data), error: null };
  } catch (error) {
    killSwitch = { status: 'not_checked', error: error.message };
  }

  return {
    generated_at: new Date().toISOString(),
    job_preview_text: job.preview_text || job.previewText || '',
    kill_switch: killSwitch,
    lookup_policy: {
      mode: 'read_only',
      allowed_methods: ['GET'],
      forbidden_actions: ['write', 'append', 'run', 'insertAndCheckRequest', 'updateRequest', 'deleteRequest', '발송승인', '등록', 'send']
    },
    lookup_urls: {
      kill_switch_read: killSwitchUrl,
      set_master_search_template: buildGasReadUrl(gasApiUrl, sheetApiKey, {
        action: 'search',
        sheet: '세트마스터',
        col: 1,
        query: '{AI_ENCODED_SEARCH_QUERY}'
      }),
      equipment_master_search_template: buildGasReadUrl(gasApiUrl, sheetApiKey, {
        action: 'search',
        sheet: '장비마스터',
        col: 1,
        query: '{AI_ENCODED_SEARCH_QUERY}'
      }),
      request_search_template: buildGasReadUrl(gasApiUrl, sheetApiKey, {
        action: 'search',
        sheet: '확인요청',
        col: 'A',
        query: '{AI_ENCODED_REQ_ID_OR_NAME}'
      }),
      contract_master_recent_gviz: buildGvizUrl('계약마스터', "SELECT A,B,E,G,J WHERE J='예약' ORDER BY A DESC LIMIT 80"),
      schedule_detail_by_trade_id_gviz_template: buildGvizUrl('스케줄상세', "SELECT B,C,D,E,F,H WHERE B='{AI_TRADE_ID}' LIMIT 50"),
      request_recent_gviz: buildGvizUrl('확인요청', "SELECT K,B,F WHERE K!='' ORDER BY A DESC LIMIT 50"),
      request_recent_with_results_gviz: buildGvizUrl('확인요청', "SELECT A,B,C,D,E,F,G,I,J,K,L,M,N,O,P,Q,R WHERE A!='' ORDER BY A DESC LIMIT 80"),
      request_by_req_id_gviz_template: buildGvizUrl('확인요청', "SELECT A,B,C,D,E,F,G,I,J,K,L,M,N,O,P,Q,R WHERE A='{AI_REQ_ID}' LIMIT 30"),
      request_by_customer_gviz_template: buildGvizUrl('확인요청', "SELECT A,B,C,D,E,F,G,I,J,K,L,M,N,O,P,Q,R WHERE K='{AI_CUSTOMER_NAME}' ORDER BY A DESC LIMIT 30"),
      customer_db_by_name_search_template: buildGasReadUrl(gasApiUrl, sheetApiKey, {
        action: 'search',
        sheet: '고객DB',
        col: 2,
        query: '{AI_CUSTOMER_NAME}'
      }),
      village2_customer_db_discount_gviz: buildOpsGvizUrl('고객DB', 'SELECT A,B,I'),
      contract_by_trade_id_search_template: buildGasReadUrl(gasApiUrl, sheetApiKey, {
        action: 'search',
        sheet: '계약마스터',
        col: 1,
        query: '{AI_TRADE_ID}'
      }),
      schedule_by_trade_id_search_template: buildGasReadUrl(gasApiUrl, sheetApiKey, {
        action: 'search',
        sheet: '스케줄상세',
        col: 2,
        query: '{AI_TRADE_ID}'
      })
    },
    note: 'These URLs are read-only lookup aids. 확인요청 columns: A=reqID, B-E period, F equipment, G qty, I result, J detail, K customer, L phone, M discount, N register command, O register status, P tradeID, Q memo, R extra. 계약마스터 columns include A tradeID, B customer, C phone, E-H period, J status, K discount. 고객DB columns: A phone, B customer name, C affiliation when present, I discount/segment when present; village2_customer_db_discount_gviz is the authoritative discount lookup and outranks Kakao text. AI must decide what to query and how to interpret results. Do not use write/run/register/send actions.'
  };
}

export function extractNavigationHints(job = {}) {
  const preview = String(job.preview_text || job.previewText || job.payload?.previewText || '').trim();
  const explicit = [
    job.customer_name,
    job.customerName,
    job.sender_name,
    job.senderName,
    job.room_title,
    job.roomTitle,
    job.payload?.customerName,
    job.payload?.senderName,
    job.payload?.roomTitle
  ].filter(Boolean).map((value) => String(value).trim()).filter(Boolean);
  let normalized = preview
    .replace(/^중요\s+/, '')
    .replace(/\s+(오전|오후)\s*\d{1,2}:\d{2}.*$/, '')
    .trim();
  normalized = normalized.replace(/^([^\s]+)\s+\d+\s+/, '$1 ');
  const firstToken = normalized.split(/\s+/)[0] || '';
  const hints = [...explicit];
  if (/^[가-힣A-Za-z0-9_./()-]{2,30}$/.test(firstToken) && !['네네', '넵', '확인했습니다', '대표님'].includes(firstToken)) {
    hints.push(firstToken);
  }
  return [...new Set(hints)].slice(0, 4);
}

export function buildCompactJobForPrompt(job = {}) {
  return {
    id: job.id || job.jobId || null,
    source: job.source || job.payload?.source || null,
    status: job.status || job.payload?.status || null,
    room_key: job.room_key || job.roomKey || job.payload?.roomKey || '',
    event_hash: job.event_hash || job.eventHash || job.payload?.jobId || null,
    preview_text: job.preview_text || job.previewText || job.payload?.previewText || '',
    navigation_hints: extractNavigationHints(job),
    unread_count: job.unread_count ?? job.unreadCount ?? job.payload?.unreadCount ?? null,
    detected_at: job.detected_at || job.detectedAt || job.payload?.detectedAt || null
  };
}

export function buildHermesPrompt(job, options = {}) {
  const gasApiUrl = options.gasApiUrl || DEFAULT_GAS_API_URL;
  const lookupPromptContext = options.lookupContext
    ? {
        kill_switch: options.lookupContext.kill_switch,
        lookup_urls: options.lookupContext.lookup_urls
      }
    : null;
  const lookupContextText = lookupPromptContext
    ? `\nREAD-ONLY GAS LOOKUP CONTEXT:\n${JSON.stringify(lookupPromptContext, null, 2)}\nUse only GET/read-only URLs above; terminal may use read-only GAS GET only. write/insert/register/send APIs are 금지. AI decides what to query and how to interpret results.\n`
    : '';
  const navigationContextText = options.navigationContext
    ? `\nBROWSER NAVIGATION RESULT:\n${JSON.stringify(options.navigationContext, null, 2)}\n\nThis was deterministic UI navigation and live AX text capture only. If status is opened_target_chat and conversation_evidence.hint_matched is true, treat conversation_evidence.visible_static_text_tail as current Kakao screen evidence to inspect first; do not spend extra actions re-opening the chat list unless the evidence is insufficient or mismatched. Do not treat the navigation step itself as business classification evidence; the AI must still judge from the visible Kakao evidence.\n`
    : '';
  const ragContextText = options.ragContext
    ? `\nREAD-ONLY VILLAGE-AI RAG TOOL:\n${options.ragContext.enabled ? 'enabled' : 'disabled'}; command: node tools/ai-browser-worker/worker.mjs --rag-lookup; input: {question,userRole:"customer",context?}; output: {text,confidence,ownerReview,knowledgeSource,usedSources,topSimilarity,logId,error}.\nUse as long-term reference memory after Kakao; put visible Kakao context in the question string itself. RAG must not replace current Kakao screen evidence or Sheets/GAS, and never covers inventory, booking, mutations, or duplicates. CURRENT_CONFIRMED_POLICY wins over older RAG conflicts. Uncovered policy FAQ: high/retrieved RAG may support auto_send; low/no_match/error ignore; ownerReview=true review. RAG 답변을 그대로 복붙하지 말고 현재 Kakao 대화와 합성한다.\n`
    : '';
  const currentConfirmedPolicyText = options.ragContext
    ? `\nCURRENT_CONFIRMED_POLICY: 주소=서울 마포구 동교로 23길 32, 2층, 지도=https://naver.me/5mIWTFQ1, 영업=24시간. 절차=장비명+기간→가용확인→방문수령→반납, 필수=장비명/수량/반출일시/반납일시/예약자명/연락처. 할인=학생 30%, 개인사업자/프리랜서 20%, 단골=개사프20%+10%, 제휴=개사프20%+20%. 장기=2일10%,3~5일20%,6~9일35%,10~14일40%,15~19일45%,20일+50%. 계산=할인 곱셈, 24시간 1일, +6시간 동일, 6시간 초과 +1일, VAT=할인후*1.1 10원 올림.\n`
    : '';
  return `AI-first Kakao rental-shop worker task.

CRITICAL RULES:
- This is AI-first. 코드의 역할은 queue/claim/API 호출 같은 plumbing뿐이다.
- 코드가 고객 의도, 예약 여부, 날짜/시간/장비를 최종 판단하면 안 된다. 코드 판단 금지: AI가 화면과 맥락을 보고 판단하고, 코드는 queue/claim/API write만 수행한다.
- Outer code will validate your typed decision but will never infer names/dates/equipment, merge a different equipment list, synthesize reply prose, choose attachments, bypass RAG, or reroute follow-ups from keywords. If a required field is incomplete, Hermes is asked to repair it.
- 카카오 Channel Manager Chrome 화면을 computer_use로 직접 확인하고, 화면에서 보이는 대화 맥락을 우선한다.
- 미리보기만 보고 분류하지 마라. 채팅방을 열어 실제 대화 맥락을 확인해야 한다.
- No artificial low tool/UI cap: continue until evidence is sufficient or the global timeout. Batch read-only lookups only when query breadth/detail are preserved; avoid repeats.
- Once sufficient, return FINAL_JSON immediately. Tool/API failures are evidence gaps: encode uncertainty in confidence/reason/follow-up; never substitute an apology or progress report.
- 답장/시트 처리에 과도하게 보수적으로 굴지 않는다. 전송 기능이 켜진 환경에서는 AI가 reply_decision.replyMode="auto_send"로 명시하고 confidence가 high이며 kill switch가 active일 때만 간단한 답변을 자동발송 후보로 둔다. 전송 기능이 꺼진 환경에서는 suggested_reply_draft/follow_up_items만 만든다.
- 자동발송 후보: FAQ/절차/수령·반납/단순 후속/예약 접수/연락처 요청. 직원 가능안내 뒤 고객 수락이면 짧은 예약완료 auto_send 가능. 가격/환불/파손/세금 draft_only. 입금 알림은 완료 단정 없이 접수 ACK만 auto_send.
- 예약 확정, 재고 가능 단정, 가격 확정은 화면/시트 근거 없이 단정하지 않는다. 하지만 고객이 예약형식에 맞게 정보를 준 경우 확인요청 시트 입력은 적극 수행한다.
- Google Sheets 입력은 API로 가능하다. 어떤 값을 넣을지는 AI가 판단하되, 예약형식이 충분하면 should_write_to_sheet=true를 기본값으로 둔다.

CLAUDE COWORKER POLICY TO CARRY FORWARD:
- 최근 1시간 내 새 메시지 후보라도 반드시 채팅방을 열고, 화면에서 보이는 메시지 + 가능하면 최근 24시간 맥락을 확인한다.
- 고객의 마지막 문의에 대해 직원(빌리지님/김준영님/최재형님)이 이미 답변했는지 확인한다. 직원이 이미 답변했으면 새 답장 초안은 만들지 말고, 미등록 예약 여부만 검토한다.
- read-catchup/backstop job일 수 있다. 마지막 버블이 "네네/감사합니다/견적서 부탁"이어도 같은 최근 고객 턴 앞쪽 예약형식 메시지가 있으면 확인요청/계약/스케줄 등록 여부를 확인한다.
- 확인요청에 이미 RQ가 있으면 중복 입력 금지. 단, 그 RQ가 자동화가 만든 것이라고 추정하거나 보고하지 마라. 수동 입력일 수 있다.
- 확인요청에 이미 RQ가 있으면 중복 입력은 금지하되, 반드시 그 RQ의 I열(결과)과 J열(상세)을 읽어서 가용확인 결과 기준으로 follow_up_items.summary/recommended_action/suggested_reply_draft를 만든다. 사람에게 "RQ 결과를 검토하라"고만 떠넘기지 마라.
- L열 연락처 공란/O열 등록상태 "연락처 입력 필요": "연락처 즉시 요청 → 연락처 입력 → 가용 재확인 → 등록".
- 기존 RQ 결과가 비어 있거나 읽히지 않으면 "가용확인 결과 없음/재확인 필요"로 보고한다. 결과가 ✅ 가용일 때만 고객 답변 초안에 예약 가능하다고 쓴다. ⚠️/❌/가용0/결과없음이면 가능 단정 금지.
- 예약/가격/FAQ/무시를 AI가 분류한다. 미리보기 텍스트만으로 예약·가격·FAQ를 확정하지 않는다.
- 킬 스위치 상태는 paused / price_paused / active 중 하나다. paused면 실제 자동 발송은 중단하고 시트/처리판 기록은 계속한다. price_paused면 가격 자동 응답만 중단한다.
- CURRENT_CONFIRMED_POLICY가 최신 FAQ/정책 기준이다. RAG가 충돌하면 현재 정책으로 고치고, 없는 정책 FAQ는 high/retrieved RAG로 보강하거나 draft_only/follow_up.
- 가격 문의는 세트마스터 단가, 고객할인, 장기할인으로 초안/follow_up을 만든다. price_paused면 가격 자동발송 금지.
- 서류(계약서/견적서/세금계산서/거래명세서)는 계산 생략 금지. 거래ID는 계약마스터+스케줄상세 대표/단품 L열 단가로 수량×일수×단가 계산; RQ는 확인요청 결과+세트마스터 단가로 부분계산하고 미등록/단가불명은 "미계산/확인 필요"로 표시한다.
-반복견적=내예약 견적 안내
- 금액 산식: 24시간=1일, +6시간 동일, 초과 +1일; 정가×고객/제휴/단골 할인×장기할인×VAT1.1, 10원 올림.
- unread/미처리면 오래된 메시지도 검토한다. 날짜만 오래된 backfill/row movement는 자동발송하지 않는다.
- 유입로그 단서는 evidence에만 보존한다. API 별도 worker 책임이다.

SENDER AND TURN-TAKING POLICY:
- 반드시 각 visible message를 staff/outbound와 customer/inbound로 구분한다. 내/직원/채널 발화는 고객 요청으로 취급하면 안 된다.
- Staff/outbound labels include: 빌리지님, 김준영님, 최재형님, 운영자/상담원/매니저로 보이는 채널 측 발화, and any message visually on the business/outbound side.
- Customer/inbound is the chat customer/nickname side, determined from the Kakao room title, bubble side/labels, and surrounding message order. A nickname like hellodesk may be a customer if it is the room/customer side; do not assume from text alone.
- The actionable trigger is normally the latest customer/inbound message or a cluster of consecutive customer/inbound messages after the last staff/outbound reply.
- For read-catchup/backstop jobs, a short later bubble ("네", "감사합니다", "견적서 부탁드립니다") must not erase an earlier unresolved reservation-format request in the same post-staff customer cluster.
- If newest meaningful message is staff/outbound, no new reply. Exception: staff-confirmed-unregistered case = customer reservation + staff confirmation + not found in contract/schedule/request; then set should_write_to_sheet=true, reservation_inquiry.confirmed=true, already_registered=false, replyMode=no_reply, no_auto_reply_sent=true.
- Customers often split one thought across several bubbles. Merge consecutive customer/inbound messages within the same recent turn before classification, e.g. "안녕하세요" + "27일날" + "fx3 가능한가요?" = one reservation/availability question.
- For Sheets append, safety_checks.latest_customer_message_after_last_staff_reply must be true except for the staff-confirmed-unregistered case above. If sender order is unclear, set it false and should_write_to_sheet=false.

EQUIPMENT AND SHEET SAFETY POLICY:
- 장비명은 AI가 최대한 추론/정규화해서 확인요청 F열 item에 넣는다. 세트마스터 또는 목록 시트의 정확한 이름을 찾으면 그 정확명을 우선 사용하고, 정확 매칭이 불완전하면 AI의 best normalized guess를 쓴다.
- 장비별로 세트마스터와 장비마스터 read-only 검색을 모두 활용한다. 이미지/대화에 적힌 모든 장비를 빠짐없이 하나씩 매칭한 뒤 sheet_row_candidate.equipment에 최종 전체 목록을 넣는다.
- 예약 메시지에 명시된 예약자명/연락처는 프로필명보다 우선한다.
- RAG는 장비명 정규화/예약자명/연락처 추출에 사용 금지.
- 정규화가 애매해도 확인요청 입력은 막지 않는다. 실패 시 원문을 item에 넣고, Q/R에는 원문/추론/가용확인 후 안내 등 내부 설명을 넣지 않는다.
- 약어/속어는 검색 키워드 힌트다. 예: FX3, A7S3, FX6, FX9, A7M4, A7C2, 2470gm2 등. AI는 가능한 한 장비명을 추론/정규화해야 하며, 원문 그대로 쓰는 것은 정규화 실패 시 fallback이다.
- 렌즈 힌트: 70-200 GM II -> 소니 GM 70-200mm II, 24-70 GM II -> 소니 GM 24-70mm II, 16-35 -> 소니 GM 16-35mm.
- 조명/기타 힌트: 600x -> 어퓨쳐 600X, 파보튜브 30xr -> 파보튜브 II 30XR, 시대/C대 -> C스탠드, 줌 F6/윈 F6 -> 줌 F6.
- 할인유형: 고객DB I열이 카톡보다 우선. DB 값(학생/개인사업자/프리랜서/단골/제휴/일반)이 있으면 sheet_row_candidate.discount_type에 그대로 쓰고, 없을 때만 카톡에서 학생/개사프/일반 추론.
- 예약문의인데 연락처가 없으면 고객DB를 예약자명으로 먼저 조회한다. 정확히 1명 매칭되면 sheet_row_candidate.phone에 넣고 계속 처리한다. 없거나 동명이인이어도 확인요청 생성은 막지 말고 sheet_row_candidate.phone=""로 둔다. 연락처는 등록 단계 필수라 follow_up/답장에서는 연락처 요청을 남긴다.
- 중복 입력 방지: 계약마스터, 스케줄상세, 확인요청 3단계를 확인한다. 불완전성/판단근거는 follow_up/evidence에만 남기고 Q/R에는 쓰지 않는다.
- 예약형식이면 확인요청 입력이 기본이다. 불확실한 장비명/중복확인/연락처 없음은 입력 차단 사유가 아니라 follow_up/evidence 대상이다. F열 item은 best 장비명으로 넣고, Q/R에는 AI 설명을 넣지 않는다. 연락처는 있으면 넣고 없으면 L열 공란으로 둔다.
- memo/extra_request 기본값은 빈 문자열. 계약서에 보여도 되는 짧은 현장 요청만 허용한다. 카카오 원문/요약/AI 판단/중복조회/정규화/가용확인 후 안내는 금지한다.
- 확인요청 API는 고객이 말한 분 단위 시간을 HH:MM으로 그대로 받을 수 있다. Hermes는 화면과 대화에서 확인한 시간을 보존하고, outer code는 절대로 분을 버리거나 반올림하지 않는다. 시간이 실제로 모호할 때만 확인 질문/후속조치를 만든다.
- read-catchup에서 기존 RQ를 발견하면 should_write_to_sheet=false는 중복 방지일 뿐이다. reason에는 "기존 RQ 발견으로 중복 입력 방지"라고 쓰고 자동화 처리 결과라고 단정하지 않는다.
- read-catchup에서 기존 RQ를 발견한 경우에도 확인요청 I/J 결과를 읽은 뒤, 그 결과가 ✅/⚠️/❌/미확인 중 무엇인지 후속카드에 명시한다.
- 기존 RQ를 발견하면 정확한 ID를 existing_confirm_request_ids 배열에 넣는다. 이유/요약 문장에만 쓰지 마라. 외부 코드는 prose에서 RQ를 추출하지 않는다.

JOB EVIDENCE FROM SUPABASE:
${JSON.stringify(buildCompactJobForPrompt(job), null, 2)}
${currentConfirmedPolicyText}
${navigationContextText}
${lookupContextText}${ragContextText}
SHEETS TOOL AVAILABLE VIA GAS API:
- URL: ${gasApiUrl}
- Target sheet for reservation inquiry candidates: 확인요청
- Outer worker writes to 확인요청 when your FINAL_JSON says should_write_to_sheet=true. Be 적극적: if the latest customer turn is a reservation-format request with enough fields for a review row, set should_write_to_sheet=true.
- Do not call write/insert/register/send APIs yourself in this Hermes prompt. Return the final decision JSON only; outer worker will write when appropriate.

TASK:
1. Use supplied BROWSER NAVIGATION RESULT/live DevTools DOM first; it is isolated automation Chrome evidence.
2. Use terminal CUA only when DevTools evidence is insufficient/mismatched and allowed; read/navigation only (list_windows/get_window_state/page get_text/query_dom). Never use CUA to write Sheets or send Kakao.
3. If using CUA output, print only filtered context around hints/customer, max 2000 chars.
4. If BROWSER NAVIGATION RESULT says opened_target_chat with hint_matched=true, start from its live conversation_evidence and do not re-open the chat list.
4. Start with DOM/AX; if insufficient or clipped, use read-only image/vision capture on the already-open automation Kakao target. Never type or send as part of evidence capture.
5. Use JOB EVIDENCE navigation_hints only to find/open the target Kakao chat. This is navigation evidence, not business classification evidence.
6. If the target conversation is not already open/visible, use the supplied read-only DevTools chat-list search first and CUA/vision navigation fallback when allowed. Searching the chat list is allowed evidence navigation; never type into the message compose box and never send during evidence capture. Return unclear only after those read-only discovery paths fail.
7. Read visible conversation content and recent context; separate staff/outbound vs customer/inbound before classifying. Merge consecutive customer bubbles in the latest customer turn; do not treat staff/outbound messages as customer requests.
8. If RAG is useful, call it only after reading Kakao. Embed visible Kakao context in the question. Never use RAG for inventory, booking, mutations, duplicates, or to override CURRENT_CONFIRMED_POLICY.
9. RAG interpretation: high/retrieved can support policy FAQ draft/auto_send when not covered by CURRENT_CONFIRMED_POLICY; low is tone/procedure hint; no_match/empty/error means ignore; ownerReview=true means review; knowledgeSource=general is not firm village policy.
9-1. For FAQ/procedure/policy/components auto_send, use CURRENT_CONFIRMED_POLICY first, otherwise call RAG and fill rag_usage. Outer worker verifies current-policy match or high-confidence retrieved support. Never use RAG for current stock/booking/schedule truth.
10. Decide whether this is reservation inquiry, price inquiry, FAQ, ignored message, or already-answered message.
10-1. Doc types은 서류 생성/발송/발행만. 확인요청/예약/가용/스케줄/파손/반납/정산은 견적서 단어가 섞여도 doc 아님; primary item에 합친다.
11. For reservation-format requests, missing phone is NOT a sheet-write blocker. Search 고객DB by name; if a unique DB phone is found, use it, otherwise leave sheet_row_candidate.phone="" and still write 확인요청. discount_type: 고객DB I열 outranks Kakao; use DB 학생/개인사업자/프리랜서/단골/제휴/일반 when present, otherwise infer from Kakao. Missing equipment/duplicate lookup/phone goes to follow_up/evidence, not Q/R. Set false for non-reservation, unopened/mismatched chat, unclear sender order, or obvious duplicate/already-registered booking. If newest actionable message is staff/outbound, write only for staff-confirmed-unregistered; phone may still be blank.
11-1. Never invent or fill a request_id for 확인요청. The outer worker calls GAS insertAndCheckRequest, and GAS must generate the real RQ-YYMMDD-NNN request ID.
11-2. Multiple/revised equipment: sheet_row_candidate.equipment must be separate top-level objects for the final whole list, never concatenated or delta-only. Each object = one 확인요청 row. Set sheet_row_candidate.plan_complete=true only after you have reconciled the complete final equipment plan; outer code will not repair a delta.
11-3. sheet_row_candidate date/time must be API-safe: YYYY-MM-DD and HH:MM, including minute-level times such as 16:30. Preserve the customer's explicit minutes. Resolve 오늘/내일 and 24시 yourself from Kakao date context. 6월6일 24시 => 2026-06-07 00:00. If context is unavailable, set should_write_to_sheet=false; outer code will never floor or round it.
11-4. If you find an existing matching RQ, read its 확인요청 result/detail (I/J) before writing follow_up_items. The follow-up must report the availability result itself, not ask the owner to inspect the RQ. If I/J is blank or unavailable, say so and ask for recheck.
12. Create at most one follow_up_item per latest customer message cluster. Do not split one customer turn into separate reply_needed/schedule_check/damage_repair/completed_log cards. Choose the single primary type, an explicit route (schedule/document/settlement/inventory/other), and a concise stable taskKey for this unresolved business task; outer code never scans prose to change or merge it. Put secondary work as a concise checklist inside recommended_action/evidence.
13. If a reply is useful, put suggested_reply_draft on that single follow_up_item instead of creating an extra reply_needed card. Also fill reply_decision. Set reply_decision.replyMode="auto_send" only for simple, high-confidence replies that are safe to send now under the kill-switch policy. For auto_send, explicitly choose safetyClass, grounding, requiresRag, attachmentKeys, and alreadyDelivered. Text alone can never grant an auto-send or attachment. Otherwise use draft_only or no_reply.
14. Return only the final machine-readable JSON below.

FINAL OUTPUT FORMAT:
Print a line containing FINAL_JSON, then a fenced json object.
The JSON schema:
{
  "should_write_to_sheet": boolean,
  "reason": string,
  "confidence": "low" | "medium" | "high",
  "classification": "reservation" | "price" | "faq" | "ignore" | "already_answered" | "unclear",
  "kill_switch_observed": "active" | "paused" | "price_paused" | "not_checked",
  "customer": { "name": string, "source": "Kakao Channel Manager", "chat_status": string | null },
  "reservation_inquiry": {
    "is_reservation_inquiry": boolean,
    "is_test_message": boolean,
    "equipment_requested": [{ "raw_text": string, "normalized_guess": string | null, "exact_name_from_set_master": string | null, "quantity": number | string | null, "confidence": "low" | "medium" | "high" }],
    "rental_start": string | null,
    "rental_end": string | null,
    "pickup_time": string | null,
    "return_time": string | null,
    "quantity": number | string | null,
    "price": string | null,
    "discount_type": "학생" | "개인사업자/프리랜서" | "단골" | "제휴" | "일반" | null,
    "confirmed": boolean,
    "already_registered": boolean
  },
  "safety_checks": {
    "kakao_conversation_opened": boolean,
    "did_not_classify_from_preview_only": boolean,
    "exact_equipment_name_verified_from_set_master": boolean,
    "duplicate_checked_contract_master": boolean,
    "duplicate_checked_schedule_detail": boolean,
    "duplicate_checked_request_sheet": boolean,
    "latest_customer_message_after_last_staff_reply": boolean,
    "no_auto_reply_sent": boolean
  },
  "conversation_turns": [{ "speaker_type": "customer" | "staff" | "unknown", "sender_label": string, "message": string, "time": string | null }],
  "latest_customer_message_cluster": string,
  "latest_staff_message": string | null,
  "visible_messages_used": [{ "sender": string, "message": string, "time": string | null }],
  "existing_confirm_request_ids": ["RQ-YYMMDD-NNN"],
  "rag_usage": { "used": boolean, "required_for_auto_send": boolean, "question": string | null, "logId": string | null, "confidence": string | null, "knowledgeSource": string | null, "usedSources": array, "applied_to_reply": boolean, "reason": string },
  "follow_up_items": [
    {
      "type": "reply_needed" | "quote_send" | "tax_invoice" | "schedule_check" | "reservation_review" | "price_review" | "payment_check" | "contract_document" | "return_extension" | "damage_repair" | "sheet_duplicate_check" | "completed_log",
      "route": "schedule" | "document" | "settlement" | "inventory" | "other",
      "taskKey": string,
      "priority": "urgent" | "high" | "normal" | "low",
      "status": "open" | "done" | "dismissed",
      "title": string,
      "customer_name": string,
      "summary": string,
      "recommended_action": string,
      "suggested_reply_draft": string,
      "evidence": [string],
      "blocking_reason": string | null,
      "due_hint": "now" | "today" | "tomorrow" | "this_week" | null
    }
  ],
  "sheet_row_candidate": {
    "plan_complete": boolean,
    "customer_name": string,
    "equipment": [{ "item": string, "quantity": number | string | "" }],
    "start_date": string,
    "end_date": string,
    "pickup_time": string,
    "return_time": string,
    "phone": string,
    "discount_type": "학생" | "개인사업자/프리랜서" | "단골" | "제휴" | "일반" | "",
    "memo": string,
    "extra_request": string
  },
  "suggested_human_review_action": string,
  "suggested_reply_draft": string,
  "reply_decision": {
    "replyMode": "auto_send" | "draft_only" | "no_reply",
    "text": string,
    "confidence": "high" | "medium" | "low" | "no_match",
    "reason": string,
    "shouldCreateTask": boolean,
    "safetyClass": "simple_ack" | "contact_request" | "reservation_intake_ack" | "payment_receipt_ack" | "document_handoff" | "current_policy_answer" | "rag_grounded_answer" | "authoritative_availability_answer" | "staff_confirmed_reservation_acceptance" | "live_quote_link_guidance" | "sensitive_commitment" | "no_send",
    "grounding": "visible_conversation" | "current_confirmed_policy" | "retrieved_rag" | "authoritative_sheet" | "staff_confirmation" | "none",
    "requiresRag": boolean,
    "attachmentKeys": ["village_bankbook_copy" | "village_business_registration"],
    "alreadyDelivered": boolean
  }
}`;
}
export function extractJsonObject(text) {
  const input = String(text || '');
  const afterMarker = input.includes('FINAL_JSON') ? input.slice(input.lastIndexOf('FINAL_JSON') + 'FINAL_JSON'.length) : input;
  let start = afterMarker.indexOf('{');
  while (start >= 0) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < afterMarker.length; index += 1) {
      const char = afterMarker[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(afterMarker.slice(start, index + 1));
          } catch {
            break;
          }
        }
      }
    }
    start = afterMarker.indexOf('{', start + 1);
  }
  throw new Error('No valid JSON object found in Hermes output');
}

function text(value) {
  return value === null || value === undefined ? '' : String(value);
}

const AI_REPLY_SAFETY_CLASSES = new Set([
  'simple_ack',
  'contact_request',
  'reservation_intake_ack',
  'payment_receipt_ack',
  'document_handoff',
  'current_policy_answer',
  'rag_grounded_answer',
  'authoritative_availability_answer',
  'staff_confirmed_reservation_acceptance',
  'live_quote_link_guidance',
  'sensitive_commitment',
  'no_send'
]);

const AI_REPLY_GROUNDING_CLASSES = new Set([
  'visible_conversation',
  'current_confirmed_policy',
  'retrieved_rag',
  'authoritative_sheet',
  'staff_confirmation',
  'none'
]);

const AI_FOLLOW_UP_ROUTES = new Set(['schedule', 'document', 'settlement', 'inventory', 'other']);
const AI_FOLLOW_UP_TYPES = new Set(['reply_needed', 'quote_send', 'tax_invoice', 'schedule_check', 'reservation_review', 'price_review', 'payment_check', 'contract_document', 'return_extension', 'damage_repair', 'sheet_duplicate_check', 'completed_log']);
const AI_FOLLOW_UP_PRIORITIES = new Set(['urgent', 'high', 'normal', 'low']);
const AI_FOLLOW_UP_STATUSES = new Set(['open', 'done', 'dismissed']);
const HERMES_WORKER_TOOLSETS = 'terminal,file,web,skills,memory,session_search,computer_use,vision';
const CONFIRM_REQUEST_DISCOUNT_TYPES = new Set(['학생', '개인사업자/프리랜서', '단골', '제휴', '일반']);
const CUSTOMER_DOCUMENT_ATTACHMENT_KEYS = new Set([
  'village_bankbook_copy',
  'village_business_registration'
]);

function isStrictIsoDate(value = '') {
  const raw = text(value).trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return false;
  const date = new Date(`${raw}T00:00:00.000Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === raw;
}

function isStrictConfirmRequestTime(value = '') {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text(value).trim());
}

function decisionReply(decision = {}) {
  return decision?.reply_decision && typeof decision.reply_decision === 'object'
    ? decision.reply_decision
    : {};
}

function replySafetyClass(decision = {}) {
  const reply = decisionReply(decision);
  return text(reply.safetyClass || reply.safety_class).trim();
}

function replyGrounding(decision = {}) {
  const reply = decisionReply(decision);
  return text(reply.grounding).trim();
}

function replyRequiresRag(decision = {}) {
  const reply = decisionReply(decision);
  return reply.requiresRag ?? reply.requires_rag;
}

function replyAttachmentKeys(decision = {}) {
  const reply = decisionReply(decision);
  const values = reply.attachmentKeys || reply.attachment_keys;
  return Array.isArray(values) ? values.map((value) => text(value).trim()).filter(Boolean) : [];
}

function replyAlreadyDelivered(decision = {}) {
  const reply = decisionReply(decision);
  return reply.alreadyDelivered ?? reply.already_delivered;
}

export function validateAiDecisionContract(decision = {}) {
  const errors = [];
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) {
    return { valid: false, errors: ['decision must be an object'] };
  }

  if (decision.should_write_to_sheet === true) {
    const row = decision.sheet_row_candidate && typeof decision.sheet_row_candidate === 'object'
      ? decision.sheet_row_candidate
      : {};
    if (row.plan_complete !== true) errors.push('sheet_row_candidate.plan_complete must be true');
    if (!isStrictIsoDate(row.start_date)) errors.push('sheet_row_candidate.start_date must be YYYY-MM-DD');
    if (!isStrictIsoDate(row.end_date)) errors.push('sheet_row_candidate.end_date must be YYYY-MM-DD');
    if (!isStrictConfirmRequestTime(row.pickup_time)) errors.push('sheet_row_candidate.pickup_time must be HH:MM');
    if (!isStrictConfirmRequestTime(row.return_time)) errors.push('sheet_row_candidate.return_time must be HH:MM');
    if (!text(row.customer_name).trim()) errors.push('sheet_row_candidate.customer_name is required');
    if (!CONFIRM_REQUEST_DISCOUNT_TYPES.has(text(row.discount_type).trim())) {
      errors.push('sheet_row_candidate.discount_type must be an explicit allowed value');
    }
    if (!Array.isArray(row.equipment) || !row.equipment.length) {
      errors.push('sheet_row_candidate.equipment must contain the complete AI equipment plan');
    } else {
      row.equipment.forEach((item, index) => {
        if (!item || typeof item !== 'object' || !text(item.item).trim()) {
          errors.push(`sheet_row_candidate.equipment[${index}].item is required`);
        }
        const quantity = Number(item?.quantity);
        if (!Number.isFinite(quantity) || quantity <= 0) {
          errors.push(`sheet_row_candidate.equipment[${index}].quantity must be positive`);
        }
      });
    }
  }

  const reply = decisionReply(decision);
  const replyMode = text(reply.replyMode || reply.reply_mode).trim();
  if (replyMode === 'auto_send') {
    const safetyClass = replySafetyClass(decision);
    const grounding = replyGrounding(decision);
    if (!AI_REPLY_SAFETY_CLASSES.has(safetyClass)) errors.push('reply_decision.safetyClass must be an explicit allowed value');
    if (safetyClass === 'sensitive_commitment' || safetyClass === 'no_send') {
      errors.push(`reply_decision.safetyClass ${safetyClass} cannot use auto_send`);
    }
    if (!AI_REPLY_GROUNDING_CLASSES.has(grounding) || grounding === 'none') {
      errors.push('reply_decision.grounding must be an explicit evidence source');
    }
    if (typeof replyRequiresRag(decision) !== 'boolean') {
      errors.push('reply_decision.requiresRag must be boolean');
    }
    if (!text(reply.text).trim()) errors.push('reply_decision.text is required for auto_send');
    if (safetyClass === 'document_handoff') {
      const keys = replyAttachmentKeys(decision);
      if (!keys.length || keys.some((key) => !CUSTOMER_DOCUMENT_ATTACHMENT_KEYS.has(key))) {
        errors.push('reply_decision.attachmentKeys must contain allowlisted document keys');
      }
      if (typeof replyAlreadyDelivered(decision) !== 'boolean') {
        errors.push('reply_decision.alreadyDelivered must be boolean for document_handoff');
      }
    }
  }

  const followUps = Array.isArray(decision.follow_up_items) ? decision.follow_up_items : [];
  followUps.forEach((item, index) => {
    if (!AI_FOLLOW_UP_TYPES.has(text(item?.type).trim())) {
      errors.push(`follow_up_items[${index}].type must be an explicit allowed value`);
    }
    const route = text(item?.route || item?.follow_up_route).trim();
    if (!AI_FOLLOW_UP_ROUTES.has(route)) {
      errors.push(`follow_up_items[${index}].route must be an explicit allowed value`);
    }
    if (!text(item?.taskKey || item?.task_key).trim()) {
      errors.push(`follow_up_items[${index}].taskKey is required`);
    }
    if (!AI_FOLLOW_UP_PRIORITIES.has(text(item?.priority).trim())) {
      errors.push(`follow_up_items[${index}].priority must be an explicit allowed value`);
    }
    if (!AI_FOLLOW_UP_STATUSES.has(text(item?.status).trim())) {
      errors.push(`follow_up_items[${index}].status must be an explicit allowed value`);
    }
    if (!text(item?.title).trim()) errors.push(`follow_up_items[${index}].title is required`);
    if (!text(item?.customer_name || item?.customerName).trim()) {
      errors.push(`follow_up_items[${index}].customer_name is required`);
    }
    if (!text(item?.summary).trim()) errors.push(`follow_up_items[${index}].summary is required`);
  });

  if (decision.existing_confirm_request_ids !== undefined) {
    if (!Array.isArray(decision.existing_confirm_request_ids)) {
      errors.push('existing_confirm_request_ids must be an array');
    } else {
      decision.existing_confirm_request_ids.forEach((id, index) => {
        if (!/^RQ-\d{6}-\d{3}$/i.test(text(id).trim())) {
          errors.push(`existing_confirm_request_ids[${index}] must be RQ-YYMMDD-NNN`);
        }
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

export function normalizeKakaoAttachmentPaths(value = []) {
  const rawItems = Array.isArray(value)
    ? value
    : text(value).split(/[\n,]/);
  const home = process.env.HOME || '';
  return rawItems
    .map((item) => text(item).trim())
    .filter(Boolean)
    .map((item) => item.startsWith('~/') && home ? path.join(home, item.slice(2)) : item)
    .map((item) => path.resolve(item));
}

export function defaultCustomerDocumentAssetPaths(env = process.env) {
  const home = env.HOME || process.env.HOME || '';
  const baseDir = env.VILLAGE_CUSTOMER_DOCUMENT_ASSET_DIR
    || (home ? path.join(home, '.hermes/village-documents/customer-request-docs') : '');
  if (!baseDir) return [];
  return normalizeKakaoAttachmentPaths([
    env.VILLAGE_CUSTOMER_DOCUMENT_BANKBOOK_PATH || path.join(baseDir, 'village_woori_bankbook_copy.jpeg'),
    env.VILLAGE_CUSTOMER_DOCUMENT_BUSINESS_REGISTRATION_PATH || path.join(baseDir, 'village_business_registration_certificate.jpeg')
  ]);
}

export function customerDocumentAssetsAlreadySent(decision = {}) {
  return replyAlreadyDelivered(decision) === true;
}

export function isCustomerDocumentAssetRequest(decision = {}) {
  const keys = replyAttachmentKeys(decision);
  return replySafetyClass(decision) === 'document_handoff'
    && keys.length > 0
    && keys.every((key) => CUSTOMER_DOCUMENT_ATTACHMENT_KEYS.has(key));
}

export function customerDocumentAssetPathsForDecision(decision = {}, config = {}) {
  if (!isCustomerDocumentAssetRequest(decision)) return [];
  const configured = config.customerDocumentAssetPaths || process.env.VILLAGE_CUSTOMER_DOCUMENT_ATTACHMENT_PATHS || '';
  const paths = normalizeKakaoAttachmentPaths(configured).length
    ? normalizeKakaoAttachmentPaths(configured)
    : defaultCustomerDocumentAssetPaths();
  const configuredByKey = {
    village_bankbook_copy: paths[0],
    village_business_registration: paths[1]
  };
  return replyAttachmentKeys(decision)
    .map((key) => configuredByKey[key])
    .filter(Boolean);
}

export function canAutoSendCustomerDocumentAssets(decision = {}, config = {}) {
  if (!config.autoSendEnabled) return { allowed: false, reason: 'auto_send_disabled' };
  const reply = decisionReply(decision);
  const replyMode = text(reply.replyMode || reply.reply_mode).trim();
  const confidence = text(reply.confidence || decision.confidence).trim();
  const replyText = text(reply.text).trim();
  const grounding = replyGrounding(decision);
  if (!isCustomerDocumentAssetRequest(decision)) return { allowed: false, reason: 'document_handoff_not_ai_planned' };
  if (replyMode !== 'auto_send') return { allowed: false, reason: `replyMode_${replyMode || 'missing'}` };
  if (confidence !== 'high') return { allowed: false, reason: `confidence_${confidence || 'missing'}` };
  if (!replyText) return { allowed: false, reason: 'reply_text_missing' };
  if (!AI_REPLY_GROUNDING_CLASSES.has(grounding) || grounding === 'none') return { allowed: false, reason: 'reply_grounding_missing' };
  if (replyRequiresRag(decision) !== false) return { allowed: false, reason: 'document_handoff_requires_rag_must_be_false' };
  if (customerDocumentAssetsAlreadySent(decision)) return { allowed: false, reason: 'customer_document_assets_already_sent' };
  const killSwitch = text(decision.kill_switch_observed).trim();
  if (killSwitch === 'paused') return { allowed: false, reason: 'kill_switch_paused' };
  if (killSwitch !== 'active' && killSwitch !== 'price_paused') return { allowed: false, reason: `kill_switch_${killSwitch || 'unknown'}` };
  if (decision?.safety_checks?.kakao_conversation_opened !== true) return { allowed: false, reason: 'conversation_not_opened' };
  if (decision?.safety_checks?.did_not_classify_from_preview_only !== true) return { allowed: false, reason: 'preview_only' };
  if (decision?.safety_checks?.latest_customer_message_after_last_staff_reply !== true) return { allowed: false, reason: 'latest_turn_not_customer' };
  if (decision.owner_review_required === true || decision.ownerReviewRequired === true) return { allowed: false, reason: 'owner_review_required' };
  const attachmentPaths = customerDocumentAssetPathsForDecision(decision, config);
  if (!attachmentPaths.length) return { allowed: false, reason: 'customer_document_assets_missing_config' };
  const missing = attachmentPaths.filter((filePath) => !fs.existsSync(filePath));
  if (missing.length) return { allowed: false, reason: 'customer_document_asset_file_missing', missing, attachmentPaths };
  return {
    allowed: true,
    reason: 'document_handoff',
    text: replyText,
    replyMode: 'auto_send',
    confidence: 'high',
    attachmentPaths,
    safetyClass: 'document_handoff',
    grounding
  };
}

const REQUIRED_SHEET_SAFETY_CHECKS = [
  'kakao_conversation_opened',
  'did_not_classify_from_preview_only',
  'latest_customer_message_after_last_staff_reply'
];

function isStaffConfirmedUnregisteredSheetCandidate(decision = {}) {
  const checks = decision?.safety_checks || {};
  const reservation = decision?.reservation_inquiry || {};
  const equipment = Array.isArray(reservation.equipment_requested) ? reservation.equipment_requested : [];
  const hasReservationEvidence = reservation.is_reservation_inquiry === true || equipment.length > 0;
  const duplicateChecked = checks.duplicate_checked_contract_master === true
    || checks.duplicate_checked_schedule_detail === true
    || checks.duplicate_checked_request_sheet === true;
  return checks.kakao_conversation_opened === true
    && checks.did_not_classify_from_preview_only === true
    && checks.latest_customer_message_after_last_staff_reply === false
    && checks.no_auto_reply_sent === true
    && hasReservationEvidence
    && reservation.confirmed === true
    && reservation.already_registered === false
    && duplicateChecked;
}

function hasRequiredSheetSafetyChecks(decision) {
  const checks = decision?.safety_checks || {};
  if (isStaffConfirmedUnregisteredSheetCandidate(decision)) return true;
  return REQUIRED_SHEET_SAFETY_CHECKS.every((key) => checks[key] === true);
}

function normalizeSheetEquipmentItems(decision = {}) {
  const row = decision.sheet_row_candidate || {};
  if (!Array.isArray(row.equipment)) return [];
  // sheet_row_candidate is Hermes's final, complete plan. The worker must not
  // guess that another field is more complete or replace exact master names
  // with raw customer wording.
  return row.equipment.map((item) => ({
    item: text(item?.item).trim(),
    quantity: item?.quantity
  }));
}

export function normalizeConfirmRequestTimeForSheet(value = '') {
  const raw = text(value).trim();
  if (!raw) return '';
  let match = raw.match(/Date\(\d{4},\s*\d{1,2},\s*\d{1,2},\s*(\d{1,2}),\s*(\d{1,2})/);
  if (!match) match = raw.match(/\b(\d{1,2}):(\d{2})\b/);
  if (!match) match = raw.match(/\b(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분)?/);
  if (!match) return raw;
  const hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  if (!Number.isFinite(hour) || hour < 0 || hour > 24) return raw;
  if (!Number.isFinite(minute) || minute < 0 || minute > 59) return raw;
  if (hour === 24) return minute === 0 ? '00:00' : raw;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function kstDateParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now).reduce((acc, part) => {
    if (part.type !== 'literal') acc[part.type] = part.value;
    return acc;
  }, {});
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

function ymd({ year, month, day }) {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function addDaysToYmd(dateText, days) {
  const match = String(dateText || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return dateText;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  return date.toISOString().slice(0, 10);
}

export function normalizeConfirmRequestDateForSheet(value = '', { now = new Date() } = {}) {
  const raw = text(value).normalize('NFKC').trim();
  if (!raw) return '';
  const today = kstDateParts(now);
  if (/(오늘|금일|당일)/.test(raw)) return ymd(today);
  if (/(내일|명일)/.test(raw)) return addDaysToYmd(ymd(today), 1);
  if (/모레/.test(raw)) return addDaysToYmd(ymd(today), 2);

  let match = raw.match(/(20\d{2})\s*[년.\/-]\s*(\d{1,2})\s*(?:월|[.\/-])\s*(\d{1,2})\s*일?/);
  if (match) return ymd({ year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) });

  match = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (match) return ymd({ year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) });

  match = raw.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일?/);
  if (!match) match = raw.match(/\b(\d{1,2})\s*[./]\s*(\d{1,2})\b/);
  if (match) return ymd({ year: today.year, month: Number(match[1]), day: Number(match[2]) });

  return raw;
}

const CONFIRM_REQUEST_INTERNAL_NOTE_PATTERN = /(?:카카오|원문|고객\s*메시지|메시지에서|예약형식|가용\s*확인|가용확인|확인요청|계약마스터|스케줄상세|고객DB|중복|정규화|세트마스터|장비마스터|모델\s*선택|미등록|AI|자동화|worker|reason|evidence|follow[_\s-]*up|후속|검토\s*필요|안내\s*필요|고객에게|답변|시트|등록\s*대상|작성\s*필요)/i;

function sanitizeConfirmRequestFreeText(value = '', { maxLength = 180 } = {}) {
  const lines = text(value)
    .normalize('NFKC')
    .split(/\r?\n+/)
    .map((line) => line.trim().replace(/^[-•*]\s*/, ''))
    .filter(Boolean)
    .filter((line) => !CONFIRM_REQUEST_INTERNAL_NOTE_PATTERN.test(line))
    .filter((line) => line.length <= 80);
  const deduped = [];
  const seen = new Set();
  for (const line of lines) {
    const key = line.replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(line);
  }
  return deduped.join('\n').slice(0, maxLength);
}

export function buildSheetAppendPayload(decision, options = {}) {
  if (!decision || decision.should_write_to_sheet !== true) return null;
  if (!hasRequiredSheetSafetyChecks(decision)) return null;
  const validation = validateAiDecisionContract(decision);
  if (!validation.valid) return null;
  const row = decision.sheet_row_candidate || {};
  const equipment = normalizeSheetEquipmentItems(decision);
  if (!equipment.length) return null;
  const memo = sanitizeConfirmRequestFreeText(row.memo || '', { maxLength: 180 });
  const extra = sanitizeConfirmRequestFreeText(row.extra_request || '', { maxLength: 180 });
  const args = {
    반출일: text(row.start_date).trim(),
    반출시간: text(row.pickup_time).trim(),
    반납일: text(row.end_date).trim(),
    반납시간: text(row.return_time).trim(),
    예약자명: text(row.customer_name).trim(),
    연락처: text(row.phone).trim(),
    할인유형: text(row.discount_type).trim(),
    비고: memo,
    추가요청: extra,
    장비: equipment.map((item) => ({ 이름: item.item, 수량: item.quantity }))
  };
  return {
    key: options.apiKey || DEFAULT_SHEET_API_KEY,
    action: 'run',
    func: 'insertAndCheckRequest',
    args
  };
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function normalizeKeyPart(value, maxLength = 120) {
  return text(value)
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

function conversationCustomerKey(value) {
  const normalized = normalizeCustomerForTask(value);
  const withoutStatus = normalized
    .replace(/^중요\s+/, '')
    .replace(/\s+\d+\s*$/, '')
    .trim();
  const firstKoreanName = withoutStatus.match(/^([가-힣]{2,5})(?:\s+\d+)?(?:\s+|$)/)?.[1];
  return firstKoreanName || withoutStatus || normalized;
}

function extractConcreteAnchors(value) {
  const input = text(value).normalize('NFKC');
  return [
    ...(input.match(/\d+(?:\.\d+)?\s*(?:만원|원)/g) || []).map((v) => v.replace(/\s+/g, '')),
    ...(input.match(/\d{1,2}\s*월\s*\d{1,2}\s*일/g) || []).map((v) => v.replace(/\s+/g, '')),
    ...(input.match(/\d{4}[-./]\d{1,2}[-./]\d{1,2}/g) || []).map((v) => v.replace(/[./]/g, '-'))
  ];
}

function extractDateConcreteAnchors(value) {
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

function followUpCombinedText(row = {}) {
  return [
    row.title,
    row.summary,
    row.recommended_action || row.recommendedAction,
    Array.isArray(row.evidence) ? row.evidence.join(' ') : ''
  ].map(text).join(' ').normalize('NFKC');
}

const DOCUMENT_FOLLOW_UP_TYPES = new Set(['contract_document', 'quote_send', 'tax_invoice']);
const SCHEDULE_FOLLOW_UP_TYPES = new Set(['reservation_review', 'schedule_check', 'sheet_duplicate_check']);
const SETTLEMENT_FOLLOW_UP_TYPES = new Set(['payment_check']);

function explicitFollowUpRoute(row = {}) {
  const payload = row?.payload && typeof row.payload === 'object' ? row.payload : {};
  const explicit = text(
    row.route
    || row.follow_up_route
    || payload.follow_up_route
    || payload.route
  ).trim();
  if (AI_FOLLOW_UP_ROUTES.has(explicit)) return explicit;
  const type = text(row.type || row.follow_up_type).trim();
  if (SCHEDULE_FOLLOW_UP_TYPES.has(type) || type === 'return_extension') return 'schedule';
  if (DOCUMENT_FOLLOW_UP_TYPES.has(type)) return 'document';
  if (SETTLEMENT_FOLLOW_UP_TYPES.has(type)) return 'settlement';
  if (type === 'damage_repair') return 'inventory';
  return 'other';
}

function explicitFollowUpTaskKey(row = {}) {
  const payload = row?.payload && typeof row.payload === 'object' ? row.payload : {};
  return normalizeKeyPart(
    row.taskKey
    || row.task_key
    || row.follow_up_task_key
    || payload.follow_up_task_key
    || payload.taskKey
    || payload.task_key,
    120
  );
}

function isReservationFollowUpTopic(row = {}, combined = followUpCombinedText(row)) {
  void combined;
  const type = String(row.type || row.follow_up_type || '');
  return explicitFollowUpRoute(row) === 'schedule' || SCHEDULE_FOLLOW_UP_TYPES.has(type);
}

function stableFollowUpType(row = {}, combined = followUpCombinedText(row)) {
  void combined;
  return normalizeKeyPart(row.type, 60);
}

function stableFollowUpAnchors(row = {}, combined = followUpCombinedText(row)) {
  const taskKey = explicitFollowUpTaskKey(row);
  if (taskKey && taskKey !== 'unknown') return [taskKey];
  if (isReservationFollowUpTopic(row, combined)) {
    return [...new Set([...extractDateConcreteAnchors(combined), 'reservation_review'])];
  }
  return extractConcreteAnchors(combined);
}

export function buildFollowUpSemanticKey(row = {}) {
  const customer = normalizeCustomerForTask(row.customer_name || row.customerName);
  const type = normalizeKeyPart(row.type, 60);
  const taskKey = explicitFollowUpTaskKey(row);
  if (taskKey && taskKey !== 'unknown') {
    return ['semantic', customer, explicitFollowUpRoute(row), type, taskKey]
      .map((v) => normalizeKeyPart(v, 120))
      .join(':');
  }
  const combined = followUpCombinedText(row);
  const concreteAnchors = extractConcreteAnchors(combined);
  if (!concreteAnchors.length) {
    return `exact:${normalizeKeyPart(row.follow_up_key || row.id || row.title || '', 200)}`;
  }
  return ['semantic', customer, explicitFollowUpRoute(row), type, ...new Set(concreteAnchors)]
    .map((v) => normalizeKeyPart(v, 120))
    .join(':');
}

export function buildFollowUpTopicKey(row = {}) {
  const customer = normalizeCustomerForTask(row.customer_name || row.customerName);
  const taskKey = explicitFollowUpTaskKey(row);
  if (taskKey && taskKey !== 'unknown') {
    return ['topic', customer, explicitFollowUpRoute(row), taskKey]
      .map((v) => normalizeKeyPart(v, 120))
      .join(':');
  }
  const combined = followUpCombinedText(row);
  const concreteAnchors = extractConcreteAnchors(combined);
  const route = explicitFollowUpRoute(row);
  const type = normalizeKeyPart(row.type, 60);
  if (!concreteAnchors.length) return buildFollowUpSemanticKey(row);
  const parts = ['topic', customer, route, type, ...new Set(concreteAnchors)];
  return parts.map((v) => normalizeKeyPart(v, 120)).join(':');
}

export function mergeFollowUpRowsByTopic(rows = []) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const taskKey = explicitFollowUpTaskKey(row);
    const payload = row?.payload && typeof row.payload === 'object' ? row.payload : {};
    const declaredRoute = text(row.route || row.follow_up_route || payload.follow_up_route || payload.route).trim();
    const key = taskKey && taskKey !== 'unknown' && AI_FOLLOW_UP_ROUTES.has(declaredRoute)
      ? ['ai-topic', normalizeCustomerForTask(row.customer_name || row.customerName), declaredRoute, taskKey].join(':')
      : Symbol('untyped-follow-up');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].map((items) => {
    if (items.length === 1) return items[0];
    const sorted = items.slice().sort((a, b) => {
      const priority = { urgent: 0, high: 1, normal: 2, low: 3 };
      return (priority[a.priority] ?? 2) - (priority[b.priority] ?? 2);
    });
    const primary = { ...sorted[0] };
    const summaries = sorted.map((item) => text(item.summary)).filter(Boolean);
    const actions = sorted.map((item) => text(item.recommended_action)).filter(Boolean);
    const drafts = sorted.map((item) => text(item.suggested_reply_draft)).filter(Boolean);
    const evidence = sorted.flatMap((item) => Array.isArray(item.evidence) ? item.evidence.map(text).filter(Boolean) : []);
    primary.summary = summaries[0] || primary.summary;
    primary.recommended_action = actions.length
      ? actions.map((value) => `- ${value.replace(/^\s*-\s*/, '')}`).join('\n')
      : primary.recommended_action;
    primary.suggested_reply_draft = drafts[0] || primary.suggested_reply_draft;
    primary.evidence = Array.from(new Set(evidence)).slice(0, 12);
    primary.payload = {
      ...(primary.payload && typeof primary.payload === 'object' ? primary.payload : {}),
      merged_follow_up_items: sorted.map((item) => ({
        type: item.type,
        title: item.title,
        summary: item.summary,
        recommended_action: item.recommended_action
      }))
    };
    return primary;
  });
}

function priorityRank(value) {
  const priority = { urgent: 0, high: 1, normal: 2, low: 3 };
  return priority[value] ?? 2;
}

function routeRankForMerge(row = {}) {
  const ranks = { schedule: 0, inventory: 1, document: 2, settlement: 3, other: 4 };
  return ranks[explicitFollowUpRoute(row)] ?? 5;
}

function mergeFollowUpRowGroup(items = []) {
  const rows = (Array.isArray(items) ? items : []).filter(Boolean);
  if (!rows.length) return null;
  const sorted = rows.slice().sort((a, b) => {
    const routeDiff = routeRankForMerge(a) - routeRankForMerge(b);
    if (routeDiff) return routeDiff;
    return priorityRank(a.priority) - priorityRank(b.priority);
  });
  const primary = { ...sorted[0] };
  const latest = rows[rows.length - 1] || primary;
  const summaries = rows.map((item) => text(item.summary)).filter(Boolean);
  const actions = rows.map((item) => text(item.recommended_action)).filter(Boolean);
  const drafts = rows.map((item) => text(item.suggested_reply_draft)).filter(Boolean);
  const evidence = rows.flatMap((item) => Array.isArray(item.evidence) ? item.evidence.map(text).filter(Boolean) : []);
  const latestPayload = [...rows].reverse().find((item) => item.payload && typeof item.payload === 'object')?.payload || {};
  const primaryPayload = primary.payload && typeof primary.payload === 'object' ? primary.payload : {};

  primary.priority = rows.reduce((best, item) => (
    priorityRank(item.priority) < priorityRank(best) ? item.priority : best
  ), primary.priority || 'normal');
  primary.status = 'open';
  primary.title = text(primary.title) || text(latest.title);
  primary.summary = text(latest.summary) || summaries[0] || primary.summary;
  primary.recommended_action = Array.from(new Set(actions)).slice(0, 3).join('\n') || primary.recommended_action;
  primary.suggested_reply_draft = drafts[0] || primary.suggested_reply_draft;
  primary.evidence = Array.from(new Set(evidence)).slice(0, 12);
  primary.payload = {
    ...primaryPayload,
    ...latestPayload,
    merged_follow_up_items: rows.map((item) => ({
      id: item.id || null,
      type: item.type,
      title: item.title,
      summary: item.summary,
      recommended_action: item.recommended_action
    }))
  };
  return primary;
}

function conversationBundleKey(row = {}) {
  const customer = conversationCustomerKey(row.customer_name || row.customerName);
  const room = normalizeKeyPart(row.room_key || row.roomKey, 120);
  if (!customer || customer === 'unknown' || !room || room === 'unknown') return '';
  const type = String(row.type || '');
  if (type === 'completed_log') return '';
  return ['conversation', room, customer].join(':');
}

function sameConversationBundle(a = {}, b = {}) {
  const aKey = conversationBundleKey(a);
  const bKey = conversationBundleKey(b);
  return Boolean(aKey && bKey && aKey === bKey);
}

function threadConversationBundleKey(row = {}) {
  const customer = conversationCustomerKey(row.customer_name || row.customerName);
  const room = normalizeKeyPart(row.room_key || row.roomKey, 120);
  if (!customer || customer === 'unknown' || !room || room === 'unknown') return '';
  return ['conversation', room, customer].join(':');
}

function sameConversationThreadBundle(a = {}, b = {}) {
  const aKey = threadConversationBundleKey(a);
  const bKey = threadConversationBundleKey(b);
  return Boolean(aKey && bKey && aKey === bKey);
}

function mergeFollowUpRowsByConversation(rows = []) {
  const groups = new Map();
  const passthrough = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = conversationBundleKey(row);
    if (!key) {
      passthrough.push(row);
      continue;
    }
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const merged = [...groups.values()].map((items) => (
    items.length > 1 ? mergeFollowUpRowGroup(items) : items[0]
  )).filter(Boolean);
  return [...passthrough, ...merged];
}

function buildStableFollowUpKey({ roomKey, customerName, type, route, taskKey, title, summary, recommendedAction, evidence }) {
  const combined = [title, summary, recommendedAction, Array.isArray(evidence) ? evidence.join(' ') : ''].join(' ');
  const rowForKey = { customer_name: customerName, type, route, taskKey, title, summary, recommended_action: recommendedAction, evidence };
  const anchors = stableFollowUpAnchors(rowForKey, combined);
  const base = [
    normalizeKeyPart(roomKey, 120),
    normalizeKeyPart(customerName, 80),
    stableFollowUpType(rowForKey, combined)
  ];
  if (anchors.length) {
    base.push(normalizeKeyPart(anchors.join('-'), 120));
  } else {
    base.push(createHash('sha256').update(normalizeKeyPart(`${title} ${summary}`, 300)).digest('hex').slice(0, 16));
  }
  return base.join(':');
}

export function buildFollowUpRows(decision, job = {}) {
  const items = Array.isArray(decision?.follow_up_items) ? decision.follow_up_items : [];
  const rawJobId = text(job.id || job.jobId || '');
  const jobId = isUuid(rawJobId) ? rawJobId : null;
  const roomKey = text(job.room_key || job.roomKey || job.payload?.roomKey || '').slice(0, 240);
  const fallbackCustomer = text(decision?.customer?.name || job.customer_name || '');
  const conversationSnapshot = {
    latest_customer_message_cluster: text(decision?.latest_customer_message_cluster).slice(0, 1500),
    latest_staff_message: text(decision?.latest_staff_message).slice(0, 1000),
    rag_usage: decision?.rag_usage && typeof decision.rag_usage === 'object'
      ? {
          used: Boolean(decision.rag_usage.used),
          required_for_auto_send: Boolean(decision.rag_usage.required_for_auto_send),
          logId: text(decision.rag_usage.logId || decision.rag_usage.log_id).slice(0, 120) || null,
          confidence: text(decision.rag_usage.confidence).slice(0, 40) || null,
          knowledgeSource: text(decision.rag_usage.knowledgeSource || decision.rag_usage.knowledge_source).slice(0, 80) || null,
          usedSources: Array.isArray(decision.rag_usage.usedSources || decision.rag_usage.used_sources)
            ? (decision.rag_usage.usedSources || decision.rag_usage.used_sources).slice(0, 5)
            : [],
          applied_to_reply: Boolean(decision.rag_usage.applied_to_reply),
          reason: text(decision.rag_usage.reason).slice(0, 500)
        }
      : null,
    visible_messages_used: Array.isArray(decision?.visible_messages_used)
      ? decision.visible_messages_used.slice(-5).map((message) => ({
          sender: text(message?.sender).slice(0, 80),
          message: text(message?.message).slice(0, 1200),
          time: text(message?.time).slice(0, 80) || null
        })).filter((message) => message.message)
      : []
  };
  return items
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const type = text(item.type).trim();
      const requestedRoute = text(item.route || item.follow_up_route).trim();
      const route = requestedRoute;
      const taskKey = text(item.taskKey || item.task_key).trim();
      const priority = text(item.priority).trim();
      const status = text(item.status).trim();
      const title = text(item.title).slice(0, 240);
      const customerName = text(item.customer_name || item.customerName || fallbackCustomer).slice(0, 120);
      const summary = text(item.summary).slice(0, 3000);
      const recommendedAction = text(item.recommended_action || item.recommendedAction).slice(0, 3000);
      const suggestedReplyDraft = text(item.suggested_reply_draft || item.suggestedReplyDraft).slice(0, 3000);
      const evidence = Array.isArray(item.evidence) ? item.evidence.map((v) => text(v)).filter(Boolean).slice(0, 12) : [];
      return {
        follow_up_key: buildStableFollowUpKey({ roomKey, customerName, type, route, title, summary, recommendedAction, evidence, taskKey }),
        source: 'kakao_ai_worker',
        job_id: jobId,
        room_key: roomKey,
        customer_name: customerName,
        type,
        priority,
        status,
        title,
        summary,
        recommended_action: recommendedAction,
        suggested_reply_draft: suggestedReplyDraft,
        evidence,
        blocking_reason: text(item.blocking_reason || item.blockingReason).slice(0, 1000) || null,
        due_hint: text(item.due_hint || item.dueHint).slice(0, 80) || null,
        decision_classification: text(decision?.classification).slice(0, 80),
        decision_confidence: text(decision?.confidence).slice(0, 80),
        payload: {
          ...item,
          follow_up_route: route,
          follow_up_task_key: taskKey || null,
          ...conversationSnapshot
        }
      };
    });
}

function isAutomationAuditFollowUpRow(row = {}) {
  const source = text(row.source || '').trim().toLowerCase();
  if (source === 'daily_audit' || source === 'automation_audit') return true;
  const title = text(row.title || row.summary || '');
  if (/Daily audit|자동화\s*(감사|점검|보고)|감사\s*후속처리/i.test(title)) return true;
  const payload = row?.payload && typeof row.payload === 'object' ? row.payload : {};
  return payload.report_only_audit === true || payload.runtime_audit === true;
}

function filterAutomationAuditFollowUpRows(rows = []) {
  return (Array.isArray(rows) ? rows : []).filter((row) => !isAutomationAuditFollowUpRow(row));
}

export async function upsertFollowUpRows(config, rows) {
  if (!rows.length) return { inserted: 0, rows: [] };
  const taskRows = filterAutomationAuditFollowUpRows(rows);
  if (!taskRows.length) return { inserted: 0, rows: [], skippedAutomationAudit: rows.length };
  const table = encodeURIComponent(config.followUpTable || 'ai_follow_up_items');
  const mergedRows = mergeFollowUpRowsByTopic(taskRows);
  const filteredRows = await filterFollowUpRowsWithClosedHistory(config, mergedRows);
  if (!filteredRows.length) return { inserted: 0, rows: [], skippedClosed: rows.length };
  const activeMergeResult = await mergeFollowUpRowsWithActiveHistory(config, filteredRows);
  const rowsToInsert = activeMergeResult.rowsToInsert || [];
  if (!rowsToInsert.length) {
    return {
      inserted: activeMergeResult.updatedRows.length,
      rows: activeMergeResult.updatedRows,
      merged: rows.length - mergedRows.length,
      skippedClosed: mergedRows.length - filteredRows.length,
      mergedActive: activeMergeResult.updatedRows.length
    };
  }
  const inserted = await supabaseFetch(config, `${table}?on_conflict=follow_up_key`, {
    method: 'POST',
    headers: supabaseHeaders(config, 'resolution=merge-duplicates,return=representation'),
    body: JSON.stringify(rowsToInsert)
  });
  const insertedRows = Array.isArray(inserted) ? inserted : [];
  return {
    inserted: activeMergeResult.updatedRows.length + insertedRows.length,
    rows: [...activeMergeResult.updatedRows, ...insertedRows],
    merged: rows.length - mergedRows.length,
    skippedClosed: mergedRows.length - filteredRows.length,
    mergedActive: activeMergeResult.updatedRows.length
  };
}

function escapeSlackText(value = '') {
  return text(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function truncateSlackText(value = '', max = 2800) {
  const clean = escapeSlackText(value).trim();
  return clean.length > max ? `${clean.slice(0, Math.max(0, max - 1))}…` : clean;
}

function codeBlockForSlack(value = '', max = 2400) {
  const clean = text(value).replace(/```/g, "'''").trim();
  if (!clean) return '';
  const clipped = clean.length > max ? `${clean.slice(0, Math.max(0, max - 1))}…` : clean;
  return `\`\`\`${clipped}\`\`\``;
}

function formatMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '';
  return `${Math.round(number).toLocaleString('ko-KR')}원`;
}

function parseNumber(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const raw = text(value).replace(/,/g, '').trim();
  const match = raw.match(/-?\d+(?:\.\d+)?/);
  if (!match) return fallback;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function splitReadableClauses(value = '', limit = 4) {
  const raw = text(value).replace(/\s+/g, ' ').trim();
  if (!raw) return [];
  const normalized = raw
    .replace(/다\. /g, '다.\n')
    .replace(/요\. /g, '요.\n')
    .replace(/입니다\. /g, '입니다.\n')
    .replace(/\. /g, '.\n');
  return normalized
    .split(/\n+|(?<=\])\s+|(?<=\))\s+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, limit);
}

function splitLongMobileLine(value = '', maxLine = 54) {
  let remaining = text(value).trim();
  const chunks = [];
  const separators = [' / ', ' — ', ' - ', ', ', '이며 ', '이고 ', '이나 ', '다만 ', '단 ', ' 결과는 ', ' 기준 ', ' 확인 ', ' 요청 ', ' 필요 '];
  while (remaining.length > maxLine) {
    let splitAt = -1;
    for (const sep of separators) {
      const idx = remaining.lastIndexOf(sep, maxLine);
      if (idx > 18) {
        splitAt = idx + sep.length;
        break;
      }
    }
    if (splitAt < 0) {
      const spaceIdx = remaining.lastIndexOf(' ', maxLine);
      splitAt = spaceIdx > 18 ? spaceIdx + 1 : maxLine;
    }
    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks.filter(Boolean);
}

function mobileBulletsForSlack(value = '', { limit = 5, maxLine = 54, icon = '•' } = {}) {
  const clauses = splitReadableClauses(value, limit * 2);
  const lines = [];
  for (const clause of clauses) {
    for (const part of splitLongMobileLine(clause, maxLine)) {
      lines.push(`${icon} ${escapeSlackText(part)}`);
      if (lines.length >= limit) break;
    }
    if (lines.length >= limit) break;
  }
  return lines.join('\n\n');
}

function normalizeDatePart(value = '') {
  const raw = text(value).trim();
  let match = raw.match(/Date\((\d{4}),\s*(\d{1,2}),\s*(\d{1,2})/);
  if (match) return `${match[1]}-${String(Number(match[2]) + 1).padStart(2, '0')}-${String(Number(match[3])).padStart(2, '0')}`;
  match = raw.match(/(\d{4})[.\-/]\s*(\d{1,2})[.\-/]\s*(\d{1,2})/);
  if (match) return `${match[1]}-${String(Number(match[2])).padStart(2, '0')}-${String(Number(match[3])).padStart(2, '0')}`;
  return '';
}

function normalizeTimePart(value = '') {
  const raw = text(value).trim();
  let match = raw.match(/Date\(\d{4},\s*\d{1,2},\s*\d{1,2},\s*(\d{1,2}),\s*(\d{1,2})/);
  if (match) return `${String(Number(match[1])).padStart(2, '0')}:${String(Number(match[2])).padStart(2, '0')}`;
  match = raw.match(/(\d{1,2}):(\d{2})/);
  if (match) return `${String(Number(match[1])).padStart(2, '0')}:${match[2]}`;
  return '';
}

function parseLocalDateTime(dateValue = '', timeValue = '') {
  const date = normalizeDatePart(dateValue);
  const time = normalizeTimePart(timeValue) || '00:00';
  if (!date) return null;
  const parts = `${date}T${time}`.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!parts) return null;
  return new Date(Date.UTC(
    Number(parts[1]),
    Number(parts[2]) - 1,
    Number(parts[3]),
    Number(parts[4]),
    Number(parts[5])
  ));
}

function calcRentalDaysForQuote(startDate, startTime, endDate, endTime) {
  const start = parseLocalDateTime(startDate, startTime);
  const end = parseLocalDateTime(endDate, endTime);
  if (!start || !end || end <= start) return 1;
  const totalHours = (end - start) / (1000 * 60 * 60);
  return Math.max(1, Math.ceil((totalHours - 6) / 24));
}

function longTermDiscountRate(days) {
  const d = Number(days) || 1;
  if (d >= 20) return 50;
  if (d >= 15) return 45;
  if (d >= 10) return 40;
  if (d >= 6) return 35;
  if (d >= 3) return 20;
  if (d >= 2) return 10;
  return 0;
}

function discountRatesForType(discountType = '') {
  const type = text(discountType).trim();
  if (type === '학생') return [{ label: '학생', rate: 30 }];
  if (type === '개인사업자/프리랜서') return [{ label: '개인사업자/프리랜서', rate: 20 }];
  if (type === '단골') return [{ label: '개인사업자/프리랜서 기준', rate: 20 }, { label: '단골', rate: 10 }];
  if (type === '제휴') return [{ label: '개인사업자/프리랜서 기준', rate: 20 }, { label: '제휴', rate: 20 }];
  return [];
}

function calculateVillagePayment(baseAmount, days, discountType = '') {
  const base = Math.max(0, Number(baseAmount) || 0);
  const discountRates = [
    ...discountRatesForType(discountType),
    ...(longTermDiscountRate(days) ? [{ label: '장기', rate: longTermDiscountRate(days) }] : [])
  ];
  const multiplier = discountRates.reduce((acc, item) => acc * Math.max(0, 1 - (item.rate / 100)), 1);
  const discountedAmount = base * multiplier;
  // Avoid floating-point tails (e.g. 50000 * 1.1 = 55000.00000000001)
  // being rounded up by an extra 10원.
  const vatIncludedRaw = discountedAmount * 1.1;
  const finalVatIncluded = Math.ceil((vatIncludedRaw - 1e-6) / 10) * 10;
  return {
    baseAmount: base,
    days: Number(days) || 1,
    discountType: text(discountType).trim() || '일반',
    discountRates,
    discountMultiplier: multiplier,
    discountedAmount,
    finalVatIncluded
  };
}

function discountLabel(payment = {}) {
  if (!Array.isArray(payment.discountRates) || !payment.discountRates.length) return '할인 없음';
  return payment.discountRates.map((item) => `${item.label}${item.rate}%`).join(' × ');
}

function parseGvizTable(textBody = '') {
  const raw = text(textBody);
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('Invalid gviz response');
  const parsed = JSON.parse(raw.slice(start, end + 1));
  const cols = parsed?.table?.cols || [];
  const rows = parsed?.table?.rows || [];
  return rows.map((row) => {
    const out = {};
    (row.c || []).forEach((cell, index) => {
      const key = cols[index]?.label || cols[index]?.id || String(index);
      out[key] = cell?.f ?? cell?.v ?? '';
    });
    return out;
  });
}

async function fetchGvizRows(config = {}, sheet, tq) {
  const fetchImpl = config.fetchImpl || fetch;
  const response = await fetchImpl(buildGvizUrl(sheet, tq), {
    signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(30000) : undefined
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`GViz lookup failed HTTP ${response.status}: ${body.slice(0, 500)}`);
  return parseGvizTable(body);
}

async function fetchGasSearch(config = {}, sheet, col, query) {
  const data = await fetchReadOnlyJson(buildGasReadUrl(config.gasApiUrl || DEFAULT_GAS_API_URL, config.sheetApiKey || DEFAULT_SHEET_API_KEY, {
    action: 'search',
    sheet,
    col,
    query
  }), {
    fetchImpl: config.fetchImpl || fetch,
    timeoutMs: 30000
  });
  return Array.isArray(data?.results) ? data.results : [];
}

function extractTradeIdsFromFollowUp(row = {}) {
  const combined = followUpCombinedText(row);
  const ids = [];
  for (const match of combined.matchAll(/\b\d{6}-\d{3}\b/g)) {
    const before = combined.slice(Math.max(0, match.index - 3), match.index).toUpperCase();
    if (before === 'RQ-') continue;
    ids.push(match[0]);
  }
  return Array.from(new Set(ids)).slice(0, 4);
}

function shouldCalculateForFollowUp(row = {}) {
  const type = String(row.type || '');
  if (['quote_send', 'tax_invoice', 'contract_document', 'payment_check', 'price_review'].includes(type)) return true;
  return /(계약서|견적서|세금계산|거래명세|결제|금액|정산|서류)/.test(followUpCombinedText(row));
}

async function fetchSetMasterPrice(config = {}, name = '') {
  const query = text(name).trim();
  if (!query) return null;
  const results = await fetchGasSearch(config, '세트마스터', 1, query);
  const rows = results.map((entry) => Array.isArray(entry?.data) ? entry.data : []);
  const exact = rows.filter((row) => text(row[0]).trim() === query && parseNumber(row[6], 0) > 0);
  const exactStandalone = exact.find((row) => !text(row[1]).trim());
  // GAS search is substring-like: searching a component bundle such as
  // "메모리*1 / 배터리*2 / ..." can return its parent set row (e.g. 소니 Z90).
  // For calculation enrichment, do not price non-exact hits as separate billable
  // items; otherwise expanded components double-count the parent set.
  const chosen = exactStandalone || exact[0];
  if (!chosen) return null;
  return {
    name: text(chosen[0]).trim() || query,
    price: parseNumber(chosen[6], 0)
  };
}

async function buildContractCalculation(config = {}, tradeId = '') {
  const [contractRows, scheduleRows] = await Promise.all([
    fetchGasSearch(config, '계약마스터', 1, tradeId),
    fetchGasSearch(config, '스케줄상세', 2, tradeId)
  ]);
  const contract = Array.isArray(contractRows?.[0]?.data) ? contractRows[0].data : [];
  const schedule = scheduleRows.map((entry) => Array.isArray(entry?.data) ? entry.data : []).filter((row) => row.length);
  if (!contract.length || !schedule.length) return null;
  const first = schedule.find((row) => row[5] && row[7]) || schedule[0];
  const days = calcRentalDaysForQuote(first[5], first[6], first[7], first[8]);
  const pricedItems = schedule
    .map((row) => ({
      name: text(row[3] || row[2]).trim(),
      qty: parseNumber(row[4], 1) || 1,
      price: parseNumber(row[11], 0)
    }))
    .filter((item) => item.name && item.price > 0);
  const baseAmount = pricedItems.reduce((sum, item) => sum + (item.qty * item.price * days), 0);
  if (!baseAmount) return {
    kind: 'contract',
    tradeId,
    customer: text(contract[1]).trim(),
    error: 'priced_schedule_rows_not_found'
  };
  const payment = calculateVillagePayment(baseAmount, days, contract[10] || '일반');
  return {
    kind: 'contract',
    tradeId,
    customer: text(contract[1]).trim(),
    phone: text(contract[2]).trim(),
    status: text(contract[9]).trim(),
    discountType: text(contract[10]).trim() || '일반',
    period: `${normalizeDatePart(first[5])} ${normalizeTimePart(first[6])} ~ ${normalizeDatePart(first[7])} ${normalizeTimePart(first[8])}`.replace(/\s+/g, ' ').trim(),
    pricedItems,
    payment
  };
}

async function fetchConfirmRequestRows(config = {}, reqID = '') {
  const tq = `SELECT A,B,C,D,E,F,G,I,J,K,L,M,Q,R WHERE A='${String(reqID).replace(/'/g, "\\'")}' LIMIT 30`;
  return fetchGvizRows(config, '확인요청', tq);
}

async function buildConfirmRequestCalculation(config = {}, reqID = '') {
  const rows = await fetchConfirmRequestRows(config, reqID);
  if (!rows.length) return null;
  const first = rows.find((row) => row['반출일'] || row['반납일']) || rows[0];
  const days = calcRentalDaysForQuote(first['반출일'], first['반출시간'], first['반납일'], first['반납시간']);
  const items = [];
  const unresolved = [];
  for (const row of rows) {
    const name = text(row['장비or세트명']).trim();
    if (!name) continue;
    const qty = parseNumber(row['수량'], 1) || 1;
    let priceInfo = null;
    try { priceInfo = await fetchSetMasterPrice(config, name); } catch {}
    if (priceInfo?.price > 0) {
      items.push({
        name,
        qty,
        price: priceInfo.price,
        result: text(row['결과']).trim(),
        detail: text(row['상세']).trim()
      });
    } else {
      unresolved.push({
        name,
        qty,
        result: text(row['결과']).trim(),
        detail: text(row['상세']).trim()
      });
    }
  }
  const baseAmount = items.reduce((sum, item) => sum + (item.qty * item.price * days), 0);
  const payment = calculateVillagePayment(baseAmount, days, first['할인유형'] || '일반');
  return {
    kind: 'confirm_request',
    reqID,
    customer: text(first['예약자명']).trim(),
    phone: text(first['연락처']).trim(),
    discountType: text(first['할인유형']).trim() || '일반',
    period: `${normalizeDatePart(first['반출일'])} ${normalizeTimePart(first['반출시간'])} ~ ${normalizeDatePart(first['반납일'])} ${normalizeTimePart(first['반납시간'])}`.replace(/\s+/g, ' ').trim(),
    pricedItems: items,
    unresolvedItems: unresolved,
    payment: baseAmount ? payment : null,
    availabilityLines: rows.map((row) => `${text(row['장비or세트명']).trim()}: ${text(row['결과']).trim()} ${text(row['상세']).trim()}`.trim()).filter(Boolean)
  };
}

function formatCalculationLine(calc = {}) {
  if (calc.kind === 'contract') {
    if (calc.error) return `거래 ${calc.tradeId}: 금액 계산 실패(${calc.error})`;
    return `거래 ${calc.tradeId}: 정가 ${formatMoney(calc.payment.baseAmount)} → 할인 후 ${formatMoney(calc.payment.discountedAmount)} → VAT 포함 ${formatMoney(calc.payment.finalVatIncluded)} (${calc.payment.days}일, ${discountLabel(calc.payment)})`;
  }
  if (calc.kind === 'confirm_request') {
    const unresolved = (calc.unresolvedItems || []).map((item) => `${item.name} x${item.qty}`).join(', ');
    if (!calc.payment) return `RQ ${calc.reqID}: 계산 가능한 단가 없음${unresolved ? ` / 미계산 ${unresolved}` : ''}`;
    return `RQ ${calc.reqID}: 계산 가능 항목 정가 ${formatMoney(calc.payment.baseAmount)} → VAT 포함 ${formatMoney(calc.payment.finalVatIncluded)} (${calc.payment.days}일, ${discountLabel(calc.payment)})${unresolved ? ` / 미계산 ${unresolved}` : ''}`;
  }
  return '';
}

function buildCalculationPayload(calculations = []) {
  const lines = calculations.map(formatCalculationLine).filter(Boolean);
  const unresolved = calculations
    .flatMap((calc) => calc.unresolvedItems || [])
    .map((item) => `${item.name} x${item.qty}`);
  const totalVatIncluded = calculations.reduce((sum, calc) => sum + (calc.payment?.finalVatIncluded || 0), 0);
  return {
    calculations,
    lines,
    unresolved,
    totalVatIncluded: totalVatIncluded || null
  };
}

export async function enrichFollowUpRowWithOperationalCalculations(config = {}, row = {}) {
  if (!row?.id && !row?.follow_up_key) return row;
  if (!shouldCalculateForFollowUp(row)) return row;
  if (row.payload?.operational_calculation?.lines?.length) return row;

  const tradeIds = extractTradeIdsFromFollowUp(row);
  const reqIDs = extractConfirmRequestIds(followUpCombinedText(row));
  if (!tradeIds.length && !reqIDs.length) return row;

  const calculations = [];
  for (const tradeId of tradeIds.slice(0, 3)) {
    try {
      const calc = await buildContractCalculation(config, tradeId);
      if (calc) calculations.push(calc);
    } catch (error) {
      calculations.push({ kind: 'contract', tradeId, error: error.message });
    }
  }
  for (const reqID of reqIDs.slice(0, 3)) {
    try {
      const calc = await buildConfirmRequestCalculation(config, reqID);
      if (calc) calculations.push(calc);
    } catch (error) {
      calculations.push({ kind: 'confirm_request', reqID, error: error.message });
    }
  }
  if (!calculations.length) return row;

  const calculationPayload = buildCalculationPayload(calculations);
  const calcText = calculationPayload.lines.join('\n');
  const unresolvedText = calculationPayload.unresolved.length
    ? `\n미계산/확인 필요: ${calculationPayload.unresolved.join(', ')}`
    : '';
  const recommended = [
    calcText ? `계산 결과를 기준으로 서류/계약서/견적서 금액을 확인하세요.\n${calcText}${unresolvedText}` : '',
    row.recommended_action
  ].filter(Boolean).join('\n');

  return {
    ...row,
    summary: row.summary,
    recommended_action: recommended || row.recommended_action,
    evidence: Array.from(new Set([
      ...(Array.isArray(row.evidence) ? row.evidence.map(text).filter(Boolean) : []),
      ...calculationPayload.lines
    ])).slice(0, 12),
    payload: {
      ...(row.payload && typeof row.payload === 'object' ? row.payload : {}),
      operational_calculation: calculationPayload
    }
  };
}

function slackTypeLabel(type = '') {
  const labels = {
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
  return labels[type] || type || '후속처리';
}

export function routeFollowUpToSlack(row = {}, config = {}) {
  const route = explicitFollowUpRoute(row);
  const channels = {
    ...DEFAULT_SLACK_CHANNELS,
    ...(config.slackChannels || {})
  };
  return {
    route,
    channel: channels[route] || DEFAULT_SLACK_CHANNELS.schedule
  };
}

function formatSlackCalculationBlock(row = {}) {
  const calc = row.payload?.operational_calculation;
  if (!calc?.lines?.length) return '';
  const lines = [];
  for (const line of calc.lines) {
    const raw = text(line);
    const label = raw.split(':')[0].replace(/^거래\s+/, '거래 ').slice(0, 34);
    const amount = raw.match(/VAT\s*포함\s*([\d,]+원)/)?.[1] || raw.match(/([\d,]+원)/)?.[1] || '';
    const unresolved = raw.match(/미계산\s*([^/]+)/)?.[1]?.trim() || '';
    const compact = [
      label,
      amount,
      unresolved ? `확인 ${unresolved}` : ''
    ].filter(Boolean).join(' · ');
    lines.push(`🧾 ${escapeSlackText(compact || raw.slice(0, 70))}`);
  }
  if (calc.totalVatIncluded) {
    lines.push(`💰 합계 VAT 포함 ${formatMoney(calc.totalVatIncluded)}`);
  }
  return lines.filter(Boolean).slice(0, 4).join('\n').trim();
}

function formatSlackRecommendation(row = {}) {
  const calc = row.payload?.operational_calculation;
  const lines = [];
  if (calc?.lines?.length) {
    lines.push('1. 🧾 계산 금액과 파일 금액 대조');
    if (calc.unresolved?.length) {
      lines.push(`2. 🔎 미계산 항목 확인: ${calc.unresolved.join(', ')}`);
      lines.push('3. 📤 확인된 파일만 고객에게 발송');
    } else {
      lines.push('2. 📤 금액이 맞으면 파일 발송');
      lines.push('3. ✅ 발송 후 완료 처리');
    }
  }
  const original = mobileBulletsForSlack(row.recommended_action, { limit: calc?.lines?.length ? 1 : 3, maxLine: 48, icon: '▫️' });
  if (original) lines.push(original);
  return lines.join('\n\n') || mobileBulletsForSlack(row.recommended_action, { limit: 3, maxLine: 48, icon: '▫️' });
}

function cleanSlackBriefText(value = '') {
  return text(value)
    .replace(/\s+/g, ' ')
    .replace(/^고객[이가은는을\s]*/g, '')
    .replace(/^카카오(?:\s*화면)?[:：]?\s*/g, '')
    .replace(/^확인요청\s*(?:조회|결과)?[:：]?\s*/g, '')
    .replace(/했습니다\.?$/g, '')
    .replace(/합니다\.?$/g, '')
    .trim();
}

function cleanSlackChatText(value = '') {
  return text(value)
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanEvidenceChatBody(value = '') {
  return cleanSlackChatText(value)
    .replace(/^카카오\s*(?:화면|최신)?[:：]?\s*/g, '')
    .replace(/^(?:최신\s*)?고객\s*메시지[:：]?\s*/g, '')
    .replace(/^고객(?:이|은|는)?\s*/g, '')
    .replace(/^직전\s*직원\s*답변[:：]?\s*/g, '')
    .replace(/^직원\s*(?:최신|직전)?\s*답변(?:\s*이후)?[:：]?\s*/g, '')
    .replace(/^[\"'“”‘’]+|[\"'“”‘’]+$/g, '')
    .replace(/\s+오[전후]\s*\d{1,2}:\d{2}$/g, '')
    .trim();
}

function evidenceChatMessages(row = {}) {
  const evidence = Array.isArray(row.evidence) ? row.evidence.map(text).filter(Boolean) : [];
  return evidence.map((item) => {
    const isStaff = /^(?:직전\s*)?직원\s*(?:최신|직전)?\s*답변[:：]|^직전\s*직원\s*답변[:：]|^(?:빌리지|김준영|최재형).{0,20}답변[:：]/.test(item);
    const isCustomer = /최신 고객 메시지|카카오 화면:\s*고객|고객 최종 양식|고객이 예약|고객이 ['"“”]|고객이 .*(?:보냄|공유|요청|문의|전송)/.test(item);
    if (!isStaff && !isCustomer) return null;
    const body = cleanEvidenceChatBody(item);
    if (!body) return null;
    return { sender: isStaff ? '직원' : '고객', message: body };
  }).filter(Boolean).slice(-4);
}

function latestCustomerChatText(row = {}) {
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
  const messages = Array.isArray(payload.visible_messages_used) ? payload.visible_messages_used : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (slackSpeakerLabel(message?.sender) !== '고객') continue;
    const body = cleanSlackChatText(message?.message);
    if (body) return body;
  }
  const evidenceCustomer = evidenceChatMessages(row)
    .reverse()
    .find((message) => slackSpeakerLabel(message?.sender) === '고객');
  return cleanSlackChatText(payload.latest_customer_message_cluster || evidenceCustomer?.message || '');
}

function compactSheetRequestLine(row = {}) {
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
  const request = payload.sheet_request && typeof payload.sheet_request === 'object' ? payload.sheet_request : null;
  if (!request) return '';
  const period = [
    request.반출일,
    request.반출시간,
    request.반납일 ? '~' : '',
    request.반납일,
    request.반납시간
  ].map(text).filter(Boolean).join(' ').replace(/\s+~\s+/g, '~').trim();
  const equipment = Array.isArray(request.장비)
    ? request.장비
      .map((item) => {
        const name = text(item?.이름 || item?.name || item?.item);
        if (!name) return '';
        const qty = text(item?.수량 || item?.quantity || item?.qty);
        return `${name}${qty ? ` x${qty}` : ''}`;
      })
      .filter(Boolean)
      .slice(0, 3)
      .join(', ')
    : text(request.장비or세트명 || request.equipment || request.item);
  return [period, equipment].filter(Boolean).join(' · ');
}

function availabilityStatusLabel(status = '') {
  if (status === 'available') return '전체 가용';
  if (status === 'warning') return '확인 필요';
  if (status === 'unavailable') return '불가/가용0';
  return '결과 미확인';
}

function availabilityProblemRank(row = {}) {
  const combined = `${row.result || ''} ${row.detail || ''}`.normalize('NFKC');
  if (/(❌|가용\s*0|가용0|사용\s*중|전량\s*사용|불가)/.test(combined)) return 0;
  if (/(⚠️|❓|부족|겹침|모델\s*선택|확인\s*필요|미등록)/.test(combined)) return 1;
  if (/(✅|가용\s*[1-9]\d*)/.test(combined)) return 2;
  return 3;
}

function formatAvailabilityRowForSlack(row = {}) {
  const name = text(row.equipment || row.name || row.item || '장비명 미확인');
  const qty = text(row.quantity || row.qty);
  const result = text(row.result || '결과 없음');
  const detail = text(row.detail);
  const line = `${name}${qty ? ` x${qty}` : ''}: ${result}${detail ? ` · ${detail}` : ''}`;
  return splitLongMobileLine(line, 68).slice(0, 1).join('');
}

function formatSlackAvailabilityBriefLines(row = {}) {
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
  const availability = payload.sheet_availability && typeof payload.sheet_availability === 'object'
    ? payload.sheet_availability
    : null;
  if (!availability) return [];
  const rows = Array.isArray(availability.results) ? availability.results : [];
  const header = [
    availability.reqID ? availability.reqID : 'RQ 미확인',
    availability.duplicate ? '기존 중복' : '',
    availabilityStatusLabel(availability.status)
  ].filter(Boolean).join(' · ');
  const resultLines = rows
    .slice()
    .sort((a, b) => availabilityProblemRank(a) - availabilityProblemRank(b))
    .map(formatAvailabilityRowForSlack)
    .filter(Boolean);
  const visible = resultLines.slice(0, 3);
  if (resultLines.length > visible.length) visible.push(`외 ${resultLines.length - visible.length}개`);
  return [header, ...visible];
}

function compactSheetRequestParts(row = {}) {
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
  const request = payload.sheet_request && typeof payload.sheet_request === 'object' ? payload.sheet_request : null;
  const evidence = Array.isArray(row.evidence) ? row.evidence.map(text).filter(Boolean).join('\n') : '';
  let period = '';
  let equipment = '';

  if (request) {
    period = [
      request.반출일,
      request.반출시간,
      request.반납일 ? '~' : '',
      request.반납일,
      request.반납시간
    ].map(text).filter(Boolean).join(' ').replace(/\s+~\s+/g, ' ~ ').trim();
    if (Array.isArray(request.장비)) {
      const items = request.장비
        .map((item) => {
          const name = text(item?.이름 || item?.name || item?.item);
          if (!name) return '';
          const qty = text(item?.수량 || item?.quantity || item?.qty);
          return `${name}${qty ? ` x${qty}` : ''}`;
        })
        .filter(Boolean);
      equipment = [
        items.slice(0, 4).join(', '),
        items.length > 4 ? `외 ${items.length - 4}개` : ''
      ].filter(Boolean).join(', ');
    } else {
      equipment = text(request.장비or세트명 || request.equipment || request.item);
    }
  }

  if (!period) period = evidence.match(/기간:\s*([^\n]+)/)?.[1]?.trim() || '';
  if (!equipment) equipment = evidence.match(/장비:\s*([^\n]+)/)?.[1]?.trim() || '';
  return { period, equipment };
}

function formatSlackEquipmentPeriodBlock(row = {}, { includeEquipment = true } = {}) {
  const { period, equipment } = compactSheetRequestParts(row);
  const lines = [];
  if (includeEquipment && equipment) lines.push(`장비: ${equipment}`);
  if (period) lines.push(`기간: ${period}`);
  const latest = latestCustomerChatText(row);
  if (!lines.length && latest && /(예약|가용|가능|대여|렌탈|반출|반납|촬영|일정)/.test(latest)) {
    lines.push(`요청 원문: ${latest}`);
  }
  return lines.map((line) => truncateSlackText(line, 320)).join('\n');
}

function conciseSlackActionLine(row = {}) {
  const calc = row.payload?.operational_calculation;
  if (calc?.unresolved?.length) return `미확인 항목 확인: ${calc.unresolved.slice(0, 2).join(', ')}`;
  if (calc?.lines?.length) return '계산 금액 대조 후 파일 발송';
  const availability = row.payload?.sheet_availability;
  if (availability) {
    if (availability.status === 'available') return '가능 안내 후 예약 진행 여부 확인';
    if (availability.status === 'warning') return '경고/부족 항목 확인 후 대안 또는 추가확인 안내';
    if (availability.status === 'unavailable') return '불가 항목 확인 후 대체 일정/장비 안내';
    const detailed = text(row.recommended_action)
      .replace(/확인요청\s*RQ-\d{6}-\d{3}\s*/gi, '')
      .replace(/\bRQ-\d{6}-\d{3}\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (detailed && !/^가용 결과 확인 후 답변$/.test(detailed)) return truncateSlackText(detailed, 180);
    return 'RQ I/J 결과 재확인 후 안내';
  }
  const type = String(row.type || '');
  if (['quote_send', 'contract_document'].includes(type)) return '서류/파일 확인 후 발송';
  if (type === 'tax_invoice') return '세금계산서 정보 확인 후 발행';
  if (type === 'payment_check') return '입금/결제 상태 확인';
  if (['reservation_review', 'schedule_check', 'sheet_duplicate_check'].includes(type)) return '가용 결과 확인 후 답변';
  if (type === 'price_review') return '가격 계산 후 답변';
  if (type === 'return_extension') return '반납/연장 변경 확인 후 답변';
  if (type === 'damage_repair') return '파손/수리 상태 확인';
  if (type === 'reply_needed') return '짧게 답변';
  return cleanSlackBriefText(row.recommended_action).slice(0, 80);
}

function priorityLabelForSlack(priority = '') {
  if (priority === 'urgent') return '긴급';
  if (priority === 'high') return '중요';
  if (priority === 'normal') return '보통';
  if (priority === 'low') return '낮음';
  return text(priority || '보통');
}

function formatSlackProblemBlock(row = {}) {
  const availability = row.payload?.sheet_availability;
  if (availability) {
    const lines = [];
    if (availability.duplicate) lines.push('기존 확인요청에서 읽은 가용확인 결과입니다.');
    if (availability.status === 'available') lines.push('요청 일정은 전체 가용으로 확인됐습니다.');
    else if (availability.status === 'warning') lines.push('일부 항목에 겹침/부족/확인 필요가 있습니다.');
    else if (availability.status === 'unavailable') lines.push('불가 또는 가용0 항목이 있습니다.');
    else lines.push('가용확인 결과 판독이 필요합니다.');
    return lines.join('\n');
  }
  const customerAsk = latestCustomerChatText(row);
  const summaryLines = splitReadableClauses(row.summary || row.title, 3)
    .map(cleanSlackBriefText)
    .filter((line) => line && !/^(카카오 화면|확인요청 조회|세트마스터 조회|계약마스터|스케줄상세)/.test(line));
  const lines = [];
  if (customerAsk) lines.push(`고객 요청: ${customerAsk}`);
  for (const line of summaryLines) {
    if (!lines.some((existing) => existing.includes(line) || line.includes(existing.replace(/^고객 요청:\s*/, '')))) {
      lines.push(line);
    }
  }
  return lines.slice(0, 4).map((line) => truncateSlackText(line, 360)).join('\n');
}

function formatSlackCardTitle(row = {}, typeLabel = '') {
  const customer = text(row.customer_name || '').trim();
  return (customer || typeLabel || cleanSlackBriefText(row.title || '') || '후속처리').slice(0, 150);
}

function formatSlackBriefSummary(row = {}, { typeLabel = '', priorityLabel = '' } = {}) {
  const availabilityLines = formatSlackAvailabilityBriefLines(row);
  const equipmentPeriod = formatSlackEquipmentPeriodBlock(row, { includeEquipment: availabilityLines.length <= 1 });
  const action = conciseSlackActionLine(row);
  const statusLines = [
    [typeLabel || slackTypeLabel(row.type), priorityLabel || priorityLabelForSlack(row.priority)].filter(Boolean).join(' · '),
    availabilityLines[0] || ''
  ].filter(Boolean);
  const detailLines = [
    equipmentPeriod,
    ...availabilityLines.slice(1, 5).map((line) => `결과: ${line}`)
  ].filter(Boolean);
  const sections = [
    statusLines.length ? `⚠️ 분류/상태\n${statusLines.join('\n')}` : '',
    `🧩 문제\n${formatSlackProblemBlock(row) || truncateSlackText(row.summary || row.title, 240)}`,
    detailLines.length ? `🎒 장비 / 📅 기간\n${detailLines.join('\n')}` : '',
    action ? `➡️ 다음\n${truncateSlackText(action, 360)}` : ''
  ];
  return sections.filter(Boolean).join('\n\n');
}

function slackSpeakerLabel(sender = '') {
  const value = text(sender);
  if (/빌리지|김준영|최재형|직원|챗봇|상담원|매니저/.test(value)) return '직원';
  return '고객';
}

function formatSlackRecentChat(row = {}) {
  const payload = row.payload && typeof row.payload === 'object' ? row.payload : {};
  const messages = Array.isArray(payload.visible_messages_used)
    ? payload.visible_messages_used
    : [];
  const displayMessages = messages.length ? messages : evidenceChatMessages(row);
  const lines = displayMessages
    .map((message) => {
      const body = cleanSlackChatText(message?.message).replace(/\n+/g, ' / ');
      if (!body) return '';
      return `• ${slackSpeakerLabel(message?.sender)}: ${truncateSlackText(body, 240)}`;
    })
    .filter(Boolean)
    .slice(-3);
  if (lines.length) return lines.join('\n\n');
  const latest = cleanSlackChatText(payload.latest_customer_message_cluster || '');
  if (latest) return `• 고객: ${truncateSlackText(latest, 320)}`;
  return '';
}

export function buildSlackFollowUpMessage(row = {}, options = {}) {
  const route = options.route || routeFollowUpToSlack(row, options.config || {});
  const typeLabel = slackTypeLabel(row.type);
  const priorityLabel = priorityLabelForSlack(row.priority);
  const title = formatSlackCardTitle(row, typeLabel);
  const draft = text(row.suggested_reply_draft || '').trim();
  const calculationBlock = formatSlackCalculationBlock(row);
  const recentChatBlock = formatSlackRecentChat(row);
  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: title.slice(0, 150), emoji: true }
    }
  ];
  if (row.summary || row.recommended_action || recentChatBlock) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*처리 요약*\n${formatSlackBriefSummary(row, { typeLabel, priorityLabel })}` } });
  }
  if (recentChatBlock) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*💬 최근 대화*\n${recentChatBlock}` } });
  }
  if (calculationBlock) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*🧮 계산*\n${truncateSlackText(calculationBlock, 1200)}` } });
  }
  if (draft) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*💬 답변 초안*\n${codeBlockForSlack(draft, 1800)}` } });
  }
  const actionElements = [
    { type: 'button', text: { type: 'plain_text', text: '전송' }, style: 'primary', action_id: 'village_followup_send', value: String(row.id || '') },
    { type: 'button', text: { type: 'plain_text', text: '수정 후 전송' }, action_id: 'village_followup_edit_send', value: String(row.id || '') },
    { type: 'button', text: { type: 'plain_text', text: '진행중' }, action_id: 'village_followup_status_in_progress', value: String(row.id || '') },
    { type: 'button', text: { type: 'plain_text', text: '완료' }, action_id: 'village_followup_status_done', value: String(row.id || '') },
    { type: 'button', text: { type: 'plain_text', text: '무시' }, style: 'danger', action_id: 'village_followup_status_dismissed', value: String(row.id || '') }
  ];
  blocks.push({ type: 'actions', elements: actionElements.slice(0, 5) });
  return {
    channel: route.channel,
    text: `[${typeLabel}] ${row.customer_name || ''} ${row.title || ''}`.trim(),
    blocks
  };
}

async function slackApi(config = {}, method, payload = {}, { httpMethod = 'POST' } = {}) {
  const token = config.slackBotToken || process.env.SLACK_BOT_TOKEN || '';
  if (!token) throw new Error('Missing SLACK_BOT_TOKEN');
  const fetchImpl = config.slackFetchImpl || config.fetchImpl || fetch;
  const url = new URL(`https://slack.com/api/${method}`);
  const init = {
    method: httpMethod,
    headers: {
      authorization: `Bearer ${token}`
    }
  };
  if (httpMethod === 'GET') {
    for (const [key, value] of Object.entries(payload || {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
    }
  } else {
    init.headers['content-type'] = 'application/json; charset=utf-8';
    init.body = JSON.stringify(payload || {});
  }
  const response = await fetchImpl(url.toString(), init);
  const bodyText = await response.text();
  let data = null;
  try { data = bodyText ? JSON.parse(bodyText) : {}; } catch { data = { raw: bodyText }; }
  if (!response.ok || data?.ok === false) {
    throw new Error(`Slack ${method} failed: ${response.status} ${data?.error || bodyText.slice(0, 500)}`);
  }
  return data;
}

export async function resolveSlackChannelId(channelNameOrId = '', config = {}) {
  const raw = text(channelNameOrId).trim();
  if (!raw) throw new Error('Slack channel is required');
  if (/^[CGD][A-Z0-9]{6,}$/.test(raw)) return raw;
  const name = raw.replace(/^#/, '');
  if (!config._slackChannelCache) config._slackChannelCache = new Map();
  if (config._slackChannelCache.has(name)) return config._slackChannelCache.get(name);
  const aliasConfig = config.slackChannelAliases || {};
  const candidates = [
    name,
    ...(aliasConfig[name] || [])
  ].filter(Boolean);
  let cursor = '';
  for (let page = 0; page < 10; page += 1) {
    const data = await slackApi(config, 'conversations.list', {
      types: 'public_channel,private_channel',
      limit: 1000,
      cursor
    }, { httpMethod: 'GET' });
    const match = (data.channels || []).find((channel) => (
      candidates.includes(channel?.name) || candidates.includes(channel?.name_normalized)
    ));
    if (match?.id) {
      config._slackChannelCache.set(name, match.id);
      return match.id;
    }
    cursor = data.response_metadata?.next_cursor || '';
    if (!cursor) break;
  }
  throw new Error(`Slack channel not found: ${raw}`);
}

async function mergeFollowUpPayload(config, rowId, payloadPatch = {}, extraPatch = {}) {
  if (!rowId) return null;
  const table = encodeURIComponent(config.followUpTable || 'ai_follow_up_items');
  const currentRows = await supabaseFetch(config, `${table}?select=payload&id=eq.${encodeURIComponent(rowId)}&limit=1`, {
    headers: supabaseHeaders(config)
  });
  const current = Array.isArray(currentRows) ? currentRows[0] : null;
  const currentPayload = current?.payload && typeof current.payload === 'object' ? current.payload : {};
  const rows = await supabaseFetch(config, `${table}?id=eq.${encodeURIComponent(rowId)}`, {
    method: 'PATCH',
    headers: supabaseHeaders(config, 'return=representation'),
    body: JSON.stringify({
      ...extraPatch,
      payload: {
        ...currentPayload,
        ...payloadPatch
      }
    })
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

async function findSlackThreadParentForRow(config = {}, row = {}, route = {}, channelId = '') {
  if (config.slackThreadFollowUpsEnabled !== true) return null;
  const roomKey = text(row.room_key || row.roomKey || '').trim();
  if (!roomKey || !row?.id || !config.supabaseUrl || !config.serviceRoleKey) return null;
  const table = encodeURIComponent(config.followUpTable || 'ai_follow_up_items');
  const query = [
    'select=id,room_key,customer_name,type,status,payload,created_at,updated_at',
    `room_key=eq.${encodeURIComponent(roomKey)}`,
    `id=neq.${encodeURIComponent(row.id)}`,
    'order=updated_at.desc',
    'limit=30'
  ].join('&');
  const candidates = await supabaseFetch(config, `${table}?${query}`, {
    headers: supabaseHeaders(config)
  });
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!sameConversationThreadBundle(candidate, row)) continue;
    const delivery = candidate?.payload?.slack_delivery && typeof candidate.payload.slack_delivery === 'object'
      ? candidate.payload.slack_delivery
      : {};
    if (delivery.status !== 'delivered') continue;
    const deliveredChannel = text(delivery.channel_id || '').trim();
    const deliveredName = text(delivery.channel_name || '').trim();
    if (deliveredChannel && channelId && deliveredChannel !== channelId) continue;
    if (!deliveredChannel && deliveredName && route?.channel && deliveredName !== route.channel) continue;
    const threadTs = text(delivery.thread_ts || delivery.message_ts || '').trim();
    if (!threadTs) continue;
    return {
      rowId: candidate.id,
      threadTs,
      channelId: deliveredChannel || channelId,
      channelName: deliveredName || route.channel || ''
    };
  }
  return null;
}

export async function postSlackFollowUpRow(config = {}, row = {}) {
  if (!row?.id) return { skipped: true, reason: 'missing_follow_up_id' };
  if (row.status && ['done', 'dismissed'].includes(row.status)) return { skipped: true, reason: 'closed_follow_up' };
  const enrichedRow = await enrichFollowUpRowWithOperationalCalculations(config, row);
  const route = routeFollowUpToSlack(enrichedRow, config);
  const message = buildSlackFollowUpMessage(enrichedRow, { route, config });

  const existingDelivery = enrichedRow.payload?.slack_delivery || {};
  const existingTs = row.slack_message_ts || existingDelivery.message_ts;
  const existingChannelId = row.slack_channel_id || existingDelivery.channel_id;
  if (
    existingTs
    || row.slack_delivery_status === 'delivered'
    || existingDelivery.status === 'delivered'
  ) {
    if (!existingTs) return { skipped: true, reason: 'already_delivered_missing_ts', rowId: row.id };
    const channelId = existingChannelId || await resolveSlackChannelId(existingDelivery.channel_name || route.channel, config);
    const updatedMessage = await slackApi(config, 'chat.update', {
      channel: channelId,
      ts: existingTs,
      text: message.text,
      blocks: message.blocks,
      unfurl_links: false,
      unfurl_media: false
    });
    const updated = await mergeFollowUpPayload(config, row.id, {
      operational_calculation: enrichedRow.payload?.operational_calculation || null,
      slack_delivery: {
        ...existingDelivery,
        status: 'delivered',
        channel_name: existingDelivery.channel_name || route.channel,
        channel_id: updatedMessage.channel || channelId,
        message_ts: existingTs,
        thread_ts: existingDelivery.thread_ts || existingTs,
        refreshed_at: new Date().toISOString(),
        error: null
      }
    }, {
      summary: enrichedRow.summary,
      recommended_action: enrichedRow.recommended_action,
      evidence: enrichedRow.evidence
    });
    return { ok: true, updatedSlack: true, rowId: row.id, route, channelId, ts: existingTs, updated };
  }

  const channelId = await resolveSlackChannelId(route.channel, config);
  const threadParent = await findSlackThreadParentForRow(config, enrichedRow, route, channelId);
  const postPayload = {
    channel: channelId,
    text: message.text,
    blocks: message.blocks,
    unfurl_links: false,
    unfurl_media: false
  };
  if (threadParent?.threadTs) {
    postPayload.thread_ts = threadParent.threadTs;
    postPayload.reply_broadcast = false;
  }
  const posted = await slackApi(config, 'chat.postMessage', postPayload);
  const updated = await mergeFollowUpPayload(config, row.id, {
    slack_delivery: {
      status: 'delivered',
      channel_name: route.channel,
      channel_id: posted.channel || channelId,
      message_ts: posted.ts || null,
      thread_ts: threadParent?.threadTs || posted.message?.thread_ts || posted.ts || null,
      is_thread_reply: Boolean(threadParent?.threadTs),
      parent_follow_up_id: threadParent?.rowId || null,
      delivered_at: new Date().toISOString(),
      error: null
    }
  }, {
    summary: enrichedRow.summary,
    recommended_action: enrichedRow.recommended_action,
    evidence: enrichedRow.evidence
  });
  return { ok: true, rowId: row.id, route, channelId, ts: posted.ts, threadTs: threadParent?.threadTs || posted.message?.thread_ts || posted.ts, updated };
}

export async function deliverSlackFollowUpRows(config = {}, rows = []) {
  if (!config.slackFollowUpEnabled) return { skipped: true, reason: 'disabled', results: [] };
  if (!rows.length) return { skipped: true, reason: 'no_rows', results: [] };
  const deliverableRows = filterAutomationAuditFollowUpRows(rows);
  if (!deliverableRows.length) return { skipped: true, reason: 'automation_audit_rows', results: [] };
  const results = [];
  for (const row of deliverableRows) {
    try {
      results.push(await postSlackFollowUpRow(config, row));
    } catch (error) {
      const rowId = row?.id || null;
      results.push({ ok: false, rowId, error: error.message });
      try {
        if (rowId) {
          await mergeFollowUpPayload(config, rowId, {
            slack_delivery: {
              status: 'error',
              error: error.message.slice(0, 1000),
              attempted_at: new Date().toISOString()
            }
          });
        }
      } catch {}
    }
  }
  return { skipped: false, results };
}

export function filterFollowUpRowsAgainstClosedHistory(rows = [], historyRows = []) {
  const closed = (Array.isArray(historyRows) ? historyRows : [])
    .filter((row) => ['done', 'dismissed'].includes(row?.status));
  const closedSemantic = new Set(closed.map(buildFollowUpSemanticKey));
  const closedTopics = new Set(closed.map(buildFollowUpTopicKey));
  return (Array.isArray(rows) ? rows : []).filter((row) => {
    if (closedSemantic.has(buildFollowUpSemanticKey(row))) return false;
    if (closedTopics.has(buildFollowUpTopicKey(row))) return false;
    return true;
  });
}

async function filterFollowUpRowsWithClosedHistory(config, rows) {
  const table = encodeURIComponent(config.followUpTable || 'ai_follow_up_items');
  const customerNames = Array.from(new Set(rows.map((row) => normalizeKeyPart(row.customer_name, 80)).filter((value) => value && value !== 'unknown')));
  if (!customerNames.length) return rows;
  const selectFields = 'id,follow_up_key,customer_name,type,status,title,summary,recommended_action,evidence,blocking_reason,created_at,updated_at,completed_at';
  const history = await supabaseFetch(config, `${table}?select=${selectFields}&status=in.(done,dismissed)&order=updated_at.desc&limit=1000`, {
    headers: supabaseHeaders(config)
  });
  const scopedHistory = (Array.isArray(history) ? history : [])
    .filter((row) => customerNames.includes(normalizeKeyPart(row.customer_name, 80)));
  return filterFollowUpRowsAgainstClosedHistory(rows, scopedHistory);
}

async function mergeFollowUpRowsWithActiveHistory(config, rows) {
  if (!rows.length) return { rowsToInsert: [], updatedRows: [] };
  const table = encodeURIComponent(config.followUpTable || 'ai_follow_up_items');
  const customerNames = new Set(rows.map((row) => conversationCustomerKey(row.customer_name)).filter((value) => value && value !== 'unknown'));
  const roomKeys = new Set(rows.map((row) => normalizeKeyPart(row.room_key, 120)).filter((value) => value && value !== 'unknown'));
  if (!roomKeys.size) return { rowsToInsert: rows, updatedRows: [] };

  const activeRows = await supabaseFetch(config, `${table}?select=*&status=not.in.(done,dismissed)&order=updated_at.desc&limit=1000`, {
    headers: supabaseHeaders(config)
  });
  const scopedActiveRows = (Array.isArray(activeRows) ? activeRows : [])
    .filter((row) => roomKeys.has(normalizeKeyPart(row.room_key, 120)))
    .filter((row) => {
      if (!customerNames.size) return true;
      const activeCustomer = conversationCustomerKey(row.customer_name);
      return customerNames.has(activeCustomer);
    });

  const rowsToInsert = [];
  const updatedRows = [];
  const activeById = new Map(scopedActiveRows.map((row) => [row.id, row]));

  for (const row of rows) {
    const match = [...activeById.values()].find((active) => {
      if (!sameConversationBundle(active, row)) return false;
      const activeTaskKey = explicitFollowUpTaskKey(active);
      const rowTaskKey = explicitFollowUpTaskKey(row);
      if (!activeTaskKey || activeTaskKey === 'unknown' || !rowTaskKey || rowTaskKey === 'unknown') return false;
      const activePayload = active?.payload && typeof active.payload === 'object' ? active.payload : {};
      const rowPayload = row?.payload && typeof row.payload === 'object' ? row.payload : {};
      const activeRoute = text(active.route || active.follow_up_route || activePayload.follow_up_route || activePayload.route).trim();
      const rowRoute = text(row.route || row.follow_up_route || rowPayload.follow_up_route || rowPayload.route).trim();
      return AI_FOLLOW_UP_ROUTES.has(activeRoute)
        && AI_FOLLOW_UP_ROUTES.has(rowRoute)
        && activeRoute === rowRoute
        && activeTaskKey === rowTaskKey;
    });
    if (!match?.id) {
      rowsToInsert.push(row);
      continue;
    }

    const merged = mergeFollowUpRowGroup([match, row]);
    const patch = {
      type: merged.type,
      priority: merged.priority,
      status: 'open',
      title: merged.title,
      summary: merged.summary,
      recommended_action: merged.recommended_action,
      suggested_reply_draft: merged.suggested_reply_draft,
      evidence: merged.evidence,
      blocking_reason: merged.blocking_reason || null,
      due_hint: merged.due_hint || null,
      payload: merged.payload
    };
    const patched = await supabaseFetch(config, `${table}?id=eq.${encodeURIComponent(match.id)}`, {
      method: 'PATCH',
      headers: supabaseHeaders(config, 'return=representation'),
      body: JSON.stringify(patch)
    });
    const updated = Array.isArray(patched) ? patched[0] : patched;
    if (updated) {
      activeById.set(match.id, updated);
      updatedRows.push(updated);
    }
  }
  return { rowsToInsert, updatedRows };
}

export function filterFollowUpRowsAfterAutoReply(rows = [], autoReplyResult = {}) {
  if (!autoReplyResult?.sent) return rows;
  return rows.filter((row) => row.type !== 'reply_needed');
}

export function mapDecisionToStatusPatch(decision, context = {}) {
  if (decision?.should_write_to_sheet === true && context.sheetResult?.success === true) {
    return { status: 'needs_human_review', error_message: null };
  }
  if (decision?.should_write_to_sheet === true && context.sheetResult?.success === false) {
    const errorMessage = text(context.sheetResult.error).slice(0, 500) || 'GAS rejected sheet write';
    if (context.sheetResult.error_type === 'duplicate_request') {
      return { status: 'ai_skipped_needs_review', error_message: `GAS duplicate skipped: ${errorMessage}` };
    }
    return { status: 'needs_human_review', error_message: `GAS sheet write rejected: ${errorMessage}` };
  }
  if (decision?.should_write_to_sheet === true) {
    return { status: 'ai_decision_ready_no_sheet_write', error_message: 'AI wanted sheet write, but sheet append was not completed' };
  }
  return { status: 'ai_skipped_needs_review', error_message: text(decision?.reason).slice(0, 500) || null };
}

function supabaseHeaders(config, prefer = '') {
  const headers = {
    apikey: config.serviceRoleKey,
    authorization: `Bearer ${config.serviceRoleKey}`,
    'content-type': 'application/json'
  };
  if (prefer) headers.prefer = prefer;
  return headers;
}

function requireConfig() {
  const config = {
    supabaseUrl: process.env.SUPABASE_URL || '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    table: process.env.SUPABASE_TABLE || 'ai_processing_events',
    gasApiUrl: process.env.GAS_API_URL || DEFAULT_GAS_API_URL,
    sheetApiKey: process.env.SHEET_API_KEY || DEFAULT_SHEET_API_KEY,
    hermesCommand: resolveHermesCommand(process.env.HERMES_WORKER_COMMAND || 'hermes'),
    hermesProfile: process.env.HERMES_WORKER_PROFILE || '',
    hermesTimeoutMs: Number(process.env.HERMES_WORKER_TIMEOUT_MS || process.env.WORKER_TIMEOUT_MS || '240000'),
    ensureKakaoTab: process.env.KAKAO_WORKER_ENSURE_TAB !== '0',
    kakaoChannelManagerUrl: process.env.KAKAO_CHANNEL_MANAGER_URL || DEFAULT_KAKAO_CHANNEL_MANAGER_URL,
    openTargetChat: process.env.KAKAO_WORKER_OPEN_TARGET_CHAT !== '0',
    searchTargetChat: process.env.KAKAO_WORKER_SEARCH_TARGET_CHAT !== '0',
    cuaDriverCommand: resolveCuaDriverCommand(process.env.CUA_DRIVER_COMMAND || 'cua-driver'),
    workerControlMode: normalizeKakaoWorkerControlMode(process.env.KAKAO_WORKER_CONTROL_MODE),
    cuaMinIdleSeconds: Math.max(0, numberFromEnv(process.env.KAKAO_CUA_MIN_IDLE_SECONDS, 0)),
    villageAiUrl: process.env.VILLAGE_AI_URL || '',
    villageAiKakaoSkillSecret: process.env.VILLAGE_AI_KAKAO_SKILL_SECRET || process.env.KAKAO_SKILL_SECRET || '',
    ragTimeoutMs: Number(process.env.VILLAGE_AI_RAG_TIMEOUT_MS || 30000) || 30000,
    followUpTable: process.env.SUPABASE_FOLLOW_UP_TABLE || 'ai_follow_up_items',
    followUpRowsEnabled: process.env.AI_WORKER_FOLLOW_UP_ITEMS_ENABLED !== '0' && process.env.KAKAO_FOLLOW_UP_ITEMS_ENABLED !== '0',
    autoSendEnabled: process.env.AI_WORKER_AUTO_SEND === '1',
    autoSendLogPath: process.env.AI_WORKER_AUTO_SEND_LOG || path.resolve(__dirname, '../kakao-dom-bridge/queue/auto-replies.ndjson'),
    autoSendTimeoutMs: Number(process.env.AI_WORKER_AUTO_SEND_TIMEOUT_MS || 20000) || 20000,
    requireAutomationChromeProfile: process.env.KAKAO_REQUIRE_AUTOMATION_CHROME_PROFILE === '1',
    customerDocumentAssetPaths: normalizeKakaoAttachmentPaths(process.env.VILLAGE_CUSTOMER_DOCUMENT_ATTACHMENT_PATHS).length
      ? normalizeKakaoAttachmentPaths(process.env.VILLAGE_CUSTOMER_DOCUMENT_ATTACHMENT_PATHS)
      : defaultCustomerDocumentAssetPaths(),
    slackFollowUpEnabled: process.env.SLACK_AGENT_CARD_DELIVERY_ENABLED === '1',
    slackThreadFollowUpsEnabled: process.env.SLACK_FOLLOW_UP_THREAD_REPLIES !== '0',
    slackBotToken: process.env.SLACK_BOT_TOKEN || '',
    slackChannels: {
      schedule: process.env.SLACK_CHANNEL_SCHEDULE_AGENT || DEFAULT_SLACK_CHANNELS.schedule,
      document: process.env.SLACK_CHANNEL_DOCUMENT_AGENT || DEFAULT_SLACK_CHANNELS.document,
      settlement: process.env.SLACK_CHANNEL_SETTLEMENT_AGENT || DEFAULT_SLACK_CHANNELS.settlement,
      inventory: process.env.SLACK_CHANNEL_INVENTORY_AGENT || DEFAULT_SLACK_CHANNELS.inventory,
      other: process.env.SLACK_CHANNEL_OTHER_AGENT || DEFAULT_SLACK_CHANNELS.other
    }
  };
  if (!config.supabaseUrl || !config.serviceRoleKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Load tools/kakao-dom-bridge/.env first.');
  }
  return config;
}

async function supabaseFetch(config, pathAndQuery, init = {}) {
  const endpoint = `${config.supabaseUrl.replace(/\/$/, '')}/rest/v1/${pathAndQuery}`;
  const fetchImpl = config.fetchImpl || fetch;
  const response = await fetchImpl(endpoint, init);
  const textBody = await response.text();
  let data = null;
  if (textBody) {
    try { data = JSON.parse(textBody); } catch { data = textBody; }
  }
  if (!response.ok) throw new Error(`Supabase HTTP ${response.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}

export async function fetchNextReadyJob(config) {
  // Skip synthetic smoke-test rows by default. The user's debugging workflow needs
  // reports to distinguish old/synthetic events from the latest real Kakao action.
  const table = encodeURIComponent(config.table);
  const parts = [
    'status=eq.ready_for_ai_worker',
    'room_key=not.eq.supabase-smoke-test',
    'preview_text=not.ilike.*smoke%20test*',
    'order=created_at.desc',
    'limit=1'
  ];
  const rows = await supabaseFetch(config, `${table}?${parts.join('&')}`, { headers: supabaseHeaders(config) });
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

export async function claimJob(config, job) {
  const patch = { status: 'processing_by_ai_worker', claimed_at: new Date().toISOString() };
  const query = `${encodeURIComponent(config.table)}?id=eq.${encodeURIComponent(job.id)}&status=eq.ready_for_ai_worker`;
  const rows = await supabaseFetch(config, query, {
    method: 'PATCH',
    headers: supabaseHeaders(config, 'return=representation'),
    body: JSON.stringify(patch)
  });
  if (!Array.isArray(rows) || rows.length !== 1) throw new Error(`Could not claim job ${job.id}; it may already be claimed.`);
  return rows[0];
}

export async function updateJob(config, jobId, patch) {
  const query = `${encodeURIComponent(config.table)}?id=eq.${encodeURIComponent(jobId)}`;
  const rows = await supabaseFetch(config, query, {
    method: 'PATCH',
    headers: supabaseHeaders(config, 'return=representation'),
    body: JSON.stringify(patch)
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

export async function appendToSheet(config, payload) {
  if (!payload) return null;
  const fetchImpl = config.fetchImpl || fetch;
  let response;
  if (payload.action === 'run' && payload.func === 'insertAndCheckRequest') {
    const url = new URL(config.gasApiUrl);
    url.searchParams.set('key', config.sheetApiKey);
    url.searchParams.set('action', 'run');
    url.searchParams.set('func', 'insertAndCheckRequest');
    url.searchParams.set('args', JSON.stringify(payload.args || {}));
    response = await fetchImpl(url);
  } else {
    response = await fetchImpl(`${config.gasApiUrl}?key=${encodeURIComponent(config.sheetApiKey)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...payload, key: config.sheetApiKey })
    });
  }
  const textBody = await response.text();
  let data;
  try { data = JSON.parse(textBody); } catch { data = { raw: textBody }; }
  if (!response.ok) throw new Error(`GAS Sheets request failed: ${response.status} ${JSON.stringify(data)}`);
  if (data?.error || data?.success === false) {
    const error = text(data.error || data.message || data.raw || 'GAS Sheets request rejected');
    const errorType = classifyGasSheetError(error);
    return {
      success: false,
      error,
      error_type: errorType,
      recoverable: false,
      status: response.status,
      data,
      request: {
        action: payload.action || null,
        func: payload.func || null,
        args: payload.args || null
      }
    };
  }
  if (payload.action === 'run' && payload.func === 'insertAndCheckRequest') {
    return {
      ...data,
      success: true,
      duplicate: data?.duplicate === true,
      reqID: extractSheetRequestId(data),
      results: normalizeAvailabilityResultRows(data),
      message: data?.message || null,
      status: response.status,
      request: {
        action: payload.action || null,
        func: payload.func || null,
        args: payload.args || null
      },
      data
    };
  }
  return data;
}

export async function ensureConfirmRequestDiscountApplied(config = {}, sheetResult = null, sheetPayload = null, customerDbLookup = null) {
  const discountType = normalizeCustomerDbDiscountType(customerDbLookup?.discountType || sheetPayload?.args?.할인유형 || '');
  if (!discountType) return { skipped: true, reason: 'missing_discount_type' };
  if (!sheetResult || sheetResult.success !== true) return { skipped: true, reason: 'sheet_insert_not_successful' };
  if (sheetResult.duplicate === true) return { skipped: true, reason: 'duplicate_request_not_patched' };
  const reqID = extractSheetRequestId(sheetResult);
  if (!reqID) return { skipped: true, reason: 'missing_req_id' };

  const fetchImpl = config.fetchImpl || fetch;
  const searchUrl = buildGasReadUrl(config.gasApiUrl || DEFAULT_GAS_API_URL, config.sheetApiKey || DEFAULT_SHEET_API_KEY, {
    action: 'search',
    sheet: '확인요청',
    col: 'A',
    query: reqID
  });
  const searchData = await fetchReadOnlyJson(searchUrl, { fetchImpl, timeoutMs: 30000 });
  const first = (Array.isArray(searchData?.results) ? searchData.results : [])
    .find((entry) => String(entry?.data?.[0] || '').trim().toUpperCase() === reqID.toUpperCase());
  const row = Number(first?.row || 0);
  if (!row) return { skipped: true, reason: 'req_row_not_found', reqID };
  const current = normalizeCustomerDbDiscountType(first?.data?.[12] || '') || '일반';
  if (current === discountType) return { skipped: true, reason: 'already_applied', reqID, row, discountType };

  const updateUrl = buildGasReadUrl(config.gasApiUrl || DEFAULT_GAS_API_URL, config.sheetApiKey || DEFAULT_SHEET_API_KEY, {
    action: 'update',
    sheet: '확인요청',
    cell: `M${row}`,
    value: discountType
  });
  const updateData = await fetchReadOnlyJson(updateUrl, { fetchImpl, timeoutMs: 30000 });
  if (updateData?.error || updateData?.success === false) {
    throw new Error(`Confirm request discount patch rejected: ${JSON.stringify(updateData).slice(0, 500)}`);
  }
  return { updated: true, reqID, row, before: current, discountType, data: updateData };
}

function classifyGasSheetError(message) {
  const value = text(message);
  if (/중복 요청|이미 예약 등록|duplicate/i.test(value)) return 'duplicate_request';
  if (/NO_CONTACT|연락처.*(필요|없|불가|불가능)|예약 등록.*연락처/i.test(value)) return 'no_contact';
  if (/데이터 확인 규칙|validation|invalid/i.test(value)) return 'sheet_validation';
  return 'gas_rejected';
}

function formatSheetRequestSummary(payload = {}) {
  const args = payload && typeof payload === 'object' && payload.args && typeof payload.args === 'object'
    ? payload.args
    : {};
  const equipment = Array.isArray(args.장비)
    ? args.장비.map((item) => `${text(item.이름).trim()} x${item.수량 || 1}`).filter(Boolean).join(', ')
    : '';
  const period = [args.반출일, args.반출시간, '~', args.반납일, args.반납시간]
    .map((value) => text(value).trim())
    .filter(Boolean)
    .join(' ');
  return [
    args.예약자명 ? `예약자: ${args.예약자명}` : '',
    period ? `기간: ${period}` : '',
    equipment ? `장비: ${equipment}` : ''
  ].filter(Boolean).join('\n');
}

function sheetPayloadCustomerName(sheetPayload = {}) {
  return text(sheetPayload?.args?.예약자명 || sheetPayload?.args?.customer_name || '').trim();
}

function sheetPayloadEquipmentLabel(sheetPayload = {}) {
  const equipment = Array.isArray(sheetPayload?.args?.장비) ? sheetPayload.args.장비 : [];
  return equipment
    .map((item) => {
      const name = text(item?.이름 || item?.name || item?.item).trim();
      if (!name) return '';
      const qty = item?.수량 || item?.quantity || item?.qty || 1;
      return `${name} x${qty}`;
    })
    .filter(Boolean)
    .join(', ');
}

export function extractSheetRequestId(sheetResult = {}) {
  return text(
    sheetResult?.reqID
    || sheetResult?.reqId
    || sheetResult?.requestId
    || sheetResult?.request_id
    || sheetResult?.data?.reqID
    || sheetResult?.data?.reqId
    || sheetResult?.duplicateRequest?.reqID
    || sheetResult?.data?.duplicateRequest?.reqID
    || ''
  ).trim();
}

export function normalizeAvailabilityResultRows(sheetResult = {}) {
  const sourceRows = Array.isArray(sheetResult)
    ? sheetResult
    : Array.isArray(sheetResult?.results)
      ? sheetResult.results
      : Array.isArray(sheetResult?.data?.results)
        ? sheetResult.data.results
        : [];
  return sourceRows
    .map((row = {}) => ({
      equipment: text(row.장비명 || row.equipment || row.equipment_name || row.item || row.name).trim(),
      quantity: text(row.수량 || row.quantity || row.qty).trim(),
      result: text(row.결과 || row.result || row.status).trim(),
      detail: text(row.상세 || row.detail || row.message || row.memo).trim()
    }))
    .filter((row) => row.equipment || row.result || row.detail);
}

export function extractConfirmRequestIds(value = '') {
  const raw = typeof value === 'string' ? value : JSON.stringify(value || {});
  return Array.from(new Set((raw.match(/RQ-\d{6}-\d{3}/gi) || []).map((id) => id.toUpperCase())));
}

export function classifyAvailabilityRows(rows = []) {
  const decisiveRows = rows.filter((row) => {
    const result = text(row.result).trim();
    const detail = text(row.detail).trim();
    const combined = `${result} ${detail}`.normalize('NFKC');
    if (/(?:기본\s*구성|세트\s*동봉품|개별\s*재고\s*미관리)/i.test(combined)) return false;
    if (/^세트$/i.test(result) && !/(?:✅|❌|⚠️|가용\s*\d|사용\s*중|부족|불가)/.test(detail)) return false;
    return Boolean(result);
  });
  if (!decisiveRows.length) return 'unknown';
  const combined = decisiveRows.map((row) => `${row.result} ${row.detail}`).join(' ').normalize('NFKC');
  if (/(❌|가용\s*0|가용0|사용\s*중|전량\s*사용|불가)/.test(combined)) return 'unavailable';
  if (/(⚠️|부족|겹침|모델\s*선택|확인\s*필요)/.test(combined)) return 'warning';
  if (decisiveRows.every((row) => /(✅|가용\s*[1-9]\d*)/.test(`${row.result} ${row.detail}`))) return 'available';
  return 'unknown';
}

function formatAvailabilityResultLines(rows = []) {
  return rows
    .map((row) => {
      const name = row.equipment || '장비명 미확인';
      const quantity = row.quantity ? ` x${row.quantity}` : '';
      const result = row.result || '결과 없음';
      const detail = row.detail ? ` - ${row.detail}` : '';
      return `${name}${quantity}: ${result}${detail}`;
    })
    .slice(0, 10);
}

export function buildSheetAvailabilityReport(sheetResult = null, sheetPayload = null) {
  const rows = normalizeAvailabilityResultRows(sheetResult || {});
  const reqID = extractSheetRequestId(sheetResult || {});
  if (!rows.length && !reqID) return null;

  const status = classifyAvailabilityRows(rows);
  const lines = formatAvailabilityResultLines(rows);
  const headline = lines.length ? lines.join(' / ') : '가용확인 결과 없음';
  const reqLabel = reqID ? `확인요청 ${reqID}` : '확인요청';
  const duplicateNote = sheetResult?.duplicate ? '기존 중복 RQ에서 읽은 결과입니다. ' : '';
  const summary = `${duplicateNote}${reqLabel} 가용확인 결과: ${headline}`;

  let recommendedAction = `${reqLabel} 결과가 비어 있거나 판독되지 않았습니다. 같은 조건으로 가용확인을 다시 실행하거나 시트 I/J열을 확인한 뒤 고객에게 안내하세요.`;
  if (status === 'available') {
    recommendedAction = `${reqLabel} 결과가 가용입니다. 고객에게 가능 안내 후 예약 진행 여부를 확인하세요.`;
  } else if (status === 'warning') {
    recommendedAction = `${reqLabel} 결과에 경고가 있습니다. 상세 결과를 기준으로 부족/겹침/모델 선택 필요 여부를 확인하고, 가능 단정 없이 대안 또는 추가확인을 안내하세요.`;
  } else if (status === 'unavailable') {
    recommendedAction = `${reqLabel} 결과가 가용 불가 또는 가용0입니다. 고객에게 가능하다고 안내하지 말고 대체 일정/대체 장비를 확인하세요.`;
  }

  return {
    reqID,
    status,
    rows,
    lines,
    summary,
    recommendedAction,
    // Facts and safety actions are deterministic; customer-facing prose belongs to Hermes.
    suggestedReplyDraft: '',
    payload: {
      reqID,
      status,
      duplicate: sheetResult?.duplicate === true,
      results: rows
    }
  };
}

export function buildHermesPostActionPrompt({
  job = {},
  initialDecision = {},
  sheetResult = null,
  sheetPayload = null
} = {}) {
  const report = buildSheetAvailabilityReport(sheetResult, sheetPayload);
  if (!report) throw new Error('A concrete sheet availability result is required for post-action reasoning');

  return `POST-ACTION HERMES AI REASONING PASS

The first Hermes pass understood the Kakao conversation and the outer worker executed the requested 확인요청 read/write. The authoritative result is now available. Interpret it as an AI agent and produce the final customer reply decision and operational follow-up.

BOUNDARY:
- The outer code may transport, validate, execute, and verify structured decisions. It must not author customer-facing prose or mechanically infer business meaning from keywords.
- You own the semantic interpretation of the complete result rows, the appropriate response, tone, priority, route, and stable taskKey.
- Do not write to Sheets, send Kakao, click UI, or mutate anything in this pass. Set "should_write_to_sheet": false. The outer worker alone executes a later approved auto_send.
- Preserve the initial decision's verified customer identity, visible Kakao evidence, sender order, and safety_checks unless the authoritative result directly changes a conclusion.
- Do not claim that a booking is confirmed or completed. A 가용 result proves availability only.
- For an unequivocal available result, you may choose replyMode="auto_send" only with safetyClass="authoritative_availability_answer", grounding="authoritative_sheet", requiresRag=false, high confidence, and wording limited to the verified availability plus the next question.
- For warning, unavailable, unknown, contradictory, or incomplete results, use draft_only or no_reply and create an explicit schedule follow-up. Do not soften the facts into a false availability claim.
- Use exact equipment names and all result rows. Do not drop an item, merge different items, or substitute a catalog guess.

Return a complete decision object, not a patch. Print FINAL_JSON and exactly one fenced JSON object shaped like this:
{
  "should_write_to_sheet": false,
  "reason": string,
  "confidence": "low" | "medium" | "high",
  "classification": "reservation" | "price" | "faq" | "ignore" | "already_answered" | "unclear",
  "kill_switch_observed": "active" | "paused" | "price_paused" | "not_checked",
  "customer": { "name": string, "source": string, "chat_status": string | null },
  "safety_checks": {
    "kakao_conversation_opened": boolean,
    "did_not_classify_from_preview_only": boolean,
    "latest_customer_message_after_last_staff_reply": boolean
  },
  "visible_messages_used": [{ "sender": string, "message": string, "time": string | null }],
  "follow_up_items": [{
    "type": "reply_needed" | "schedule_check" | "reservation_review" | "sheet_duplicate_check" | "completed_log",
    "route": "schedule" | "other",
    "taskKey": string,
    "priority": "urgent" | "high" | "normal" | "low",
    "status": "open" | "done" | "dismissed",
    "title": string,
    "customer_name": string,
    "summary": string,
    "recommended_action": string,
    "suggested_reply_draft": string,
    "evidence": [string],
    "blocking_reason": string | null,
    "due_hint": "now" | "today" | "tomorrow" | "this_week" | null
  }],
  "sheet_row_candidate": {},
  "suggested_human_review_action": string,
  "suggested_reply_draft": string,
  "reply_decision": {
    "replyMode": "auto_send" | "draft_only" | "no_reply",
    "text": string,
    "confidence": "high" | "medium" | "low" | "no_match",
    "reason": string,
    "shouldCreateTask": boolean,
    "safetyClass": "authoritative_availability_answer" | "sensitive_commitment" | "no_send",
    "grounding": "authoritative_sheet" | "visible_conversation" | "none",
    "requiresRag": false,
    "attachmentKeys": [],
    "alreadyDelivered": false
  }
}

JOB CONTEXT:
${JSON.stringify(buildCompactJobForPrompt(job), null, 2)}

INITIAL HERMES DECISION:
${JSON.stringify(initialDecision, null, 2)}

EXECUTED SHEET REQUEST:
${JSON.stringify(sheetPayload?.args || null, null, 2)}

AUTHORITATIVE SHEET RESULT:
${JSON.stringify({
    reqID: report.reqID,
    status: report.status,
    duplicate: report.payload.duplicate,
    results: report.rows
  }, null, 2)}

Interpret those facts now. End with FINAL_JSON and one valid JSON object only.`;
}

export function validateAiPostActionDecisionContract(decision = {}, report = {}) {
  const base = validateAiDecisionContract(decision);
  const errors = [...(base.errors || [])];
  if (decision?.should_write_to_sheet !== false) {
    errors.push('post-action should_write_to_sheet must be false');
  }

  const reply = decisionReply(decision);
  const mode = text(reply.replyMode || reply.reply_mode).trim();
  const followUps = Array.isArray(decision?.follow_up_items) ? decision.follow_up_items : [];
  if (mode !== 'auto_send' && !followUps.some((item) => text(item?.route || item?.follow_up_route).trim() === 'schedule')) {
    errors.push('post-action non-auto-send result requires an explicit schedule follow-up');
  }
  if (mode === 'auto_send') {
    const safetyClass = replySafetyClass(decision);
    const grounding = replyGrounding(decision);
    const status = text(report?.status || report?.payload?.status).trim();
    if (safetyClass !== 'authoritative_availability_answer') {
      errors.push('post-action auto_send requires authoritative_availability_answer');
    }
    if (status !== 'available') {
      errors.push('post-action auto_send requires an available authoritative result');
    }
    if (grounding !== 'authoritative_sheet') {
      errors.push('post-action auto_send requires authoritative_sheet grounding');
    }
    if (replyRequiresRag(decision) !== false) {
      errors.push('post-action availability answer requires requiresRag=false');
    }
    const replyText = text(reply.text).normalize('NFKC');
    if (/(예약|대여)\s*(?:확정|완료)|(?:확정|예약)\s*(?:됐|되었습니다|완료)/.test(replyText)) {
      errors.push('post-action availability answer must not claim booking confirmation');
    }
    if (decision?.safety_checks?.kakao_conversation_opened !== true
      || decision?.safety_checks?.did_not_classify_from_preview_only !== true
      || decision?.safety_checks?.latest_customer_message_after_last_staff_reply !== true) {
      errors.push('post-action auto_send requires preserved verified Kakao safety checks');
    }
  }
  return { valid: errors.length === 0, errors };
}

export async function runHermesPostActionDecision({
  config = {},
  job = {},
  initialDecision = {},
  sheetResult = null,
  sheetPayload = null
} = {}, options = {}) {
  const report = buildSheetAvailabilityReport(sheetResult, sheetPayload);
  if (!report) {
    return { skipped: true, reason: 'no_authoritative_sheet_result', decision: initialDecision, report: null };
  }
  const prompt = buildHermesPostActionPrompt({ job, initialDecision, sheetResult, sheetPayload });
  const hermesResult = await runHermesDecision(prompt, config, {
    runHermesImpl: options.runHermesImpl,
    validateDecisionImpl: (candidate) => validateAiPostActionDecisionContract(candidate, report)
  });
  return {
    ...hermesResult,
    skipped: false,
    prompt,
    report,
    decision: {
      ...hermesResult.decision,
      post_action_reconciled: true,
      authoritative_sheet_result: report.payload
    }
  };
}

export function suppressDecisionForUnreconciledSheetResult(decision = {}, report = {}) {
  return {
    ...decision,
    post_action_reconciled: false,
    authoritative_sheet_result: report?.payload || null,
    suggested_reply_draft: '',
    reply_decision: {
      ...decisionReply(decision),
      replyMode: 'no_reply',
      text: '',
      confidence: 'no_match',
      reason: 'Authoritative sheet result arrived but the required post-action Hermes reasoning did not complete.',
      shouldCreateTask: true,
      safetyClass: 'no_send',
      grounding: 'authoritative_sheet',
      requiresRag: false,
      attachmentKeys: [],
      alreadyDelivered: false
    }
  };
}

function mapConfirmRequestSearchDataToSheetResult(data = {}, reqID = '') {
  const resultRows = (Array.isArray(data?.results) ? data.results : [])
    .map((entry) => Array.isArray(entry?.data) ? entry.data : [])
    .filter((row) => String(row[0] || '').trim().toUpperCase() === reqID)
    .filter((row) => row[5] || row[8] || row[9])
    .map((row) => ({
      장비명: row[5],
      수량: row[6],
      결과: row[8],
      상세: row[9]
    }));
  return {
    success: true,
    duplicate: true,
    reqID,
    results: normalizeAvailabilityResultRows(resultRows),
    source: 'existing_confirm_request_lookup',
    data
  };
}

export async function fetchExistingConfirmRequestResultForDecision(config = {}, decision = {}, followUpRows = []) {
  void followUpRows;
  const reqIDs = Array.from(new Set(
    (Array.isArray(decision?.existing_confirm_request_ids) ? decision.existing_confirm_request_ids : [])
      .map((id) => text(id).trim().toUpperCase())
      .filter((id) => /^RQ-\d{6}-\d{3}$/.test(id))
  ));
  if (!reqIDs.length) return null;

  const fetchImpl = config.fetchImpl || fetch;
  const gasApiUrl = config.gasApiUrl || DEFAULT_GAS_API_URL;
  const sheetApiKey = config.sheetApiKey || DEFAULT_SHEET_API_KEY;
  for (const reqID of reqIDs) {
    const url = buildGasReadUrl(gasApiUrl, sheetApiKey, {
      action: 'search',
      sheet: '확인요청',
      col: 'A',
      query: reqID
    });
    try {
      const data = await fetchReadOnlyJson(url, { fetchImpl, timeoutMs: 30000 });
      const mapped = mapConfirmRequestSearchDataToSheetResult(data, reqID);
      if (mapped.results.length || mapped.reqID) return mapped;
    } catch (error) {
      return {
        success: true,
        duplicate: true,
        reqID,
        results: [],
        source: 'existing_confirm_request_lookup',
        lookup_error: error.message
      };
    }
  }
  return null;
}

function isAvailabilityResultRelevantRow(row = {}) {
  return explicitFollowUpRoute(row) === 'schedule';
}

function buildAvailabilityResultFollowUpRow(decision = {}, job = {}, sheetPayload = null, report) {
  const roomKey = text(job.room_key || job.roomKey || job.payload?.roomKey || '').slice(0, 240);
  const customerName = text(
    sheetPayloadCustomerName(sheetPayload)
    || decision?.customer?.name
    || job.customer_name
    || job.customerName
    || '미확인 고객'
  ).slice(0, 120);
  const equipmentLabel = sheetPayloadEquipmentLabel(sheetPayload);
  const title = `${customerName} ${equipmentLabel || '예약'} 가용 확인 결과`;
  const evidence = [formatSheetRequestSummary(sheetPayload), ...report.lines].filter(Boolean).slice(0, 12);
  return {
    follow_up_key: buildStableFollowUpKey({
      roomKey,
      customerName,
      type: 'reservation_review',
      route: 'schedule',
      title,
      summary: report.summary,
      recommendedAction: report.recommendedAction,
      evidence
    }),
    source: 'kakao_ai_worker',
    job_id: isUuid(job.id || job.jobId) ? (job.id || job.jobId) : null,
    room_key: roomKey,
    customer_name: customerName,
    type: 'reservation_review',
    priority: report.status === 'available' ? 'high' : 'urgent',
    status: 'open',
    title,
    summary: report.summary,
    recommended_action: report.recommendedAction,
    suggested_reply_draft: report.suggestedReplyDraft,
    evidence,
    blocking_reason: report.status === 'available' ? null : report.recommendedAction,
    due_hint: 'now',
    decision_classification: text(decision?.classification || 'reservation'),
    decision_confidence: text(decision?.confidence || 'medium'),
    payload: {
      follow_up_route: 'schedule',
      sheet_availability: report.payload,
      sheet_request: sheetPayload?.args || null
    }
  };
}

export function enrichFollowUpRowsWithSheetAvailability(rows = [], sheetResult = null, sheetPayload = null, decision = {}, job = {}) {
  const report = buildSheetAvailabilityReport(sheetResult, sheetPayload);
  if (!report) return rows;
  const sourceRows = Array.isArray(rows) ? rows : [];
  const aiReconciled = decision?.post_action_reconciled === true;
  if (!sourceRows.length) {
    if (aiReconciled) return [];
    return [buildAvailabilityResultFollowUpRow(decision, job, sheetPayload, report)];
  }
  let enrichedAny = false;
  const enrichedRows = sourceRows.map((row) => {
    if (!isAvailabilityResultRelevantRow(row)) return row;
    enrichedAny = true;
    const evidence = Array.from(new Set([
      ...(Array.isArray(row.evidence) ? row.evidence.map(text).filter(Boolean) : []),
      report.reqID ? `확인요청 ${report.reqID}` : '',
      ...report.lines
    ].filter(Boolean))).slice(0, 12);
    const alreadyHasResult = new RegExp(report.reqID || '가용확인 결과').test(`${row.summary} ${row.recommended_action}`);
    return {
      ...row,
      priority: aiReconciled
        ? row.priority
        : (report.status === 'available' && row.priority !== 'urgent' ? (row.priority || 'high') : 'urgent'),
      summary: aiReconciled || alreadyHasResult
        ? row.summary
        : [row.summary, report.summary].map(text).filter(Boolean).join('\n'),
      recommended_action: aiReconciled ? row.recommended_action : report.recommendedAction,
      // The authoritative result arrived after the original AI turn. Never retain stale
      // prose or synthesize a replacement in code; a post-action Hermes pass owns it.
      suggested_reply_draft: aiReconciled ? row.suggested_reply_draft : '',
      evidence,
      blocking_reason: aiReconciled
        ? row.blocking_reason
        : (report.status === 'available' ? row.blocking_reason : (row.blocking_reason || report.recommendedAction)),
      payload: {
        ...(row.payload && typeof row.payload === 'object' ? row.payload : {}),
        follow_up_route: 'schedule',
        sheet_availability: report.payload
      }
    };
  });
  if (enrichedAny) return enrichedRows;
  if (aiReconciled) return enrichedRows;
  return [...enrichedRows, buildAvailabilityResultFollowUpRow(decision, job, sheetPayload, report)];
}

export function buildSheetFailureFollowUpRows(decision, job = {}, sheetResult = null, sheetPayload = null) {
  if (!sheetResult || sheetResult.success !== false) return [];
  if (sheetResult.error_type === 'duplicate_request') return [];
  const roomKey = text(job.room_key || job.roomKey || job.payload?.roomKey || '').slice(0, 240);
  const customerName = text(
    decision?.customer?.name
    || sheetPayload?.args?.예약자명
    || job.customer_name
    || job.customerName
    || '미확인 고객'
  ).slice(0, 120);
  const error = text(sheetResult.error).slice(0, 1000);
  const requestSummary = formatSheetRequestSummary(sheetPayload);
  const hash = createHash('sha256')
    .update([roomKey, customerName, sheetResult.error_type, error, requestSummary].join('|'))
    .digest('hex')
    .slice(0, 16);
  const isValidation = sheetResult.error_type === 'sheet_validation';
  const isNoContact = sheetResult.error_type === 'no_contact';
  return [{
    follow_up_key: [
      normalizeKeyPart(roomKey, 120),
      normalizeKeyPart(customerName, 80),
      'sheet_write_rejected',
      hash
    ].join(':'),
    source: 'kakao_ai_worker',
    job_id: isUuid(job.id || job.jobId) ? (job.id || job.jobId) : null,
    room_key: roomKey,
    customer_name: customerName,
    type: 'reservation_review',
    priority: isValidation ? 'urgent' : 'high',
    status: 'open',
    title: isNoContact ? `${customerName} 연락처 요청 필요` : `${customerName} 확인요청 시트 입력 확인 필요`,
    summary: `GAS가 확인요청 입력을 거절했습니다: ${error}`,
    recommended_action: isNoContact
      ? '확인요청은 연락처 없이도 생성되어야 합니다. 운영 GAS 배포 상태를 확인하고, 고객에게는 등록 전 필요한 연락처를 요청하세요.'
      : '날짜/시간/장비명/드롭다운 값을 확인한 뒤 확인요청을 수동 수정하거나 고객에게 필요한 정보를 다시 확인하세요.',
    suggested_reply_draft: '',
    evidence: [requestSummary, error].filter(Boolean).slice(0, 12),
    blocking_reason: error,
    due_hint: 'now',
    decision_classification: 'sheet_write_rejected',
    decision_confidence: 'blocked',
    payload: {
      follow_up_route: 'schedule',
      sheet_error_type: sheetResult.error_type,
      sheet_error: error,
      sheet_request: sheetPayload?.args || null,
      decision_classification: decision?.classification || null
    }
  }];
}

export function buildHermesArgs(prompt, config = {}) {
  const args = [];
  if (config.hermesProfile) args.push('--profile', config.hermesProfile);
  args.push('chat', '--yolo', '-Q', '-t', HERMES_WORKER_TOOLSETS, '-q', prompt);
  return args;
}

export function buildKakaoTabAppleScript() {
  return `
on run argv
  set targetUrl to item 1 of argv
  tell application "Google Chrome"
    if (count of windows) = 0 then
      make new window
    end if
    set foundTab to false
    repeat with w from 1 to count of windows
      repeat with t from 1 to count of tabs of window w
        set tabUrl to URL of tab t of window w
        set tabTitle to title of tab t of window w
        set isMainChatList to false
        if (tabUrl contains "business.kakao.com") and (tabUrl contains "/chats") then set isMainChatList to true
        if (tabUrl contains "center-pf.kakao.com") and (tabUrl contains "/chats") then set isMainChatList to true
        if (tabUrl contains "/chats/") then set isMainChatList to false
        if (tabTitle is "카카오비즈니스 파트너센터") then set isMainChatList to true
        if (tabTitle contains " - 빌리지 - 카카오비즈니스") then set isMainChatList to false
        if isMainChatList then
          set active tab index of window w to t
          set index of window w to 1
          set URL of tab t of window w to targetUrl
          set foundTab to true
          exit repeat
        end if
      end repeat
      if foundTab then exit repeat
    end repeat
    if foundTab is false then
      set newWindow to make new window
      set URL of active tab of newWindow to targetUrl
    end if
    activate
    delay 2
    if foundTab then
      return "focused_list"
    else
      return "opened_list"
    end if
  end tell
end run
`.trim();
}

function isKakaoMainListTarget(target = {}) {
  const targetUrl = String(target.url || '');
  const targetTitle = String(target.title || '');
  const isChatListUrl = /^https:\/\/(business|center-pf)\.kakao\.com\/_[^/]+\/chats(?:[?#]|$)/.test(targetUrl);
  const isMainTitle = targetTitle === '카카오비즈니스 파트너센터';
  const isConversationPopup = targetTitle.includes(' - 빌리지 - 카카오비즈니스');
  return target.type === 'page' && !isConversationPopup && (isChatListUrl || isMainTitle);
}

export function pickKakaoMainListTarget(targets = []) {
  return targets.find(isKakaoMainListTarget) || null;
}

async function devtoolsFetchText(baseUrl, pathname, { method = 'GET', fetchImpl = fetch, timeoutMs = 10000 } = {}) {
  const endpoint = `${String(baseUrl).replace(/\/+$/, '')}${pathname}`;
  const response = await fetchImpl(endpoint, {
    method,
    signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Chrome DevTools HTTP ${response.status}: ${body.slice(0, 500)}`);
  return body;
}

async function devtoolsFetchJson(baseUrl, pathname, options = {}) {
  const body = await devtoolsFetchText(baseUrl, pathname, options);
  return body ? JSON.parse(body) : null;
}

function timeoutPromise(ms, message) {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

async function devtoolsEvaluateOnTarget(target, expression, {
  timeoutMs = 15000,
  WebSocketImpl = globalThis.WebSocket
} = {}) {
  if (!target?.webSocketDebuggerUrl) throw new Error('DevTools target is missing webSocketDebuggerUrl');
  if (!WebSocketImpl) throw new Error('WebSocket is unavailable for Chrome DevTools fallback');
  const ws = new WebSocketImpl(target.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    try { ws.close?.(); } catch {}
  };

  const opened = new Promise((resolve, reject) => {
    if (typeof ws.addEventListener === 'function') {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
      ws.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        if (message.id && pending.has(message.id)) {
          pending.get(message.id)(message);
          pending.delete(message.id);
        }
      });
    } else {
      ws.on('open', resolve);
      ws.on('error', reject);
      ws.on('message', (data) => {
        const message = JSON.parse(String(data));
        if (message.id && pending.has(message.id)) {
          pending.get(message.id)(message);
          pending.delete(message.id);
        }
      });
    }
  });

  const call = async (method, params = {}) => {
    const id = ++nextId;
    ws.send(JSON.stringify({ id, method, params }));
    return Promise.race([
      new Promise((resolve) => pending.set(id, resolve)),
      timeoutPromise(timeoutMs, `Chrome DevTools ${method} timed out after ${timeoutMs}ms`)
    ]);
  };

  try {
    await Promise.race([
      opened,
      timeoutPromise(timeoutMs, `Chrome DevTools websocket open timed out after ${timeoutMs}ms`)
    ]);
    const response = await call('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    if (response.error) throw new Error(`Chrome DevTools Runtime.evaluate failed: ${response.error.message || JSON.stringify(response.error)}`);
    if (response.result?.exceptionDetails) {
      const detail = response.result.exceptionDetails.exception?.description
        || response.result.exceptionDetails.text
        || JSON.stringify(response.result.exceptionDetails);
      throw new Error(`Chrome DevTools Runtime.evaluate exception: ${String(detail).slice(0, 800)}`);
    }
    return response.result?.result?.value ?? null;
  } finally {
    cleanup();
  }
}

async function devtoolsCdpCallOnTarget(target, method, params = {}, {
  timeoutMs = 15000,
  WebSocketImpl = globalThis.WebSocket
} = {}) {
  if (!target?.webSocketDebuggerUrl) throw new Error('DevTools target is missing webSocketDebuggerUrl');
  if (!WebSocketImpl) throw new Error('WebSocket is unavailable for Chrome DevTools fallback');
  const ws = new WebSocketImpl(target.webSocketDebuggerUrl);
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    try { ws.close?.(); } catch {}
  };
  const opened = new Promise((resolve, reject) => {
    if (typeof ws.addEventListener === 'function') {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    } else {
      ws.on('open', resolve);
      ws.on('error', reject);
    }
  });
  try {
    await Promise.race([
      opened,
      timeoutPromise(timeoutMs, `Chrome DevTools websocket open timed out after ${timeoutMs}ms`)
    ]);
    const responsePromise = new Promise((resolve, reject) => {
      const onMessage = (eventOrData) => {
        const payload = typeof eventOrData?.data === 'string' ? eventOrData.data : String(eventOrData);
        const message = JSON.parse(payload);
        if (message.id === 1) resolve(message);
      };
      if (typeof ws.addEventListener === 'function') ws.addEventListener('message', onMessage);
      else ws.on('message', onMessage);
      try {
        ws.send(JSON.stringify({ id: 1, method, params }));
      } catch (error) {
        reject(error);
      }
    });
    const response = await Promise.race([
      responsePromise,
      timeoutPromise(timeoutMs, `Chrome DevTools ${method} timed out after ${timeoutMs}ms`)
    ]);
    if (response.error) throw new Error(`Chrome DevTools ${method} failed: ${response.error.message || JSON.stringify(response.error)}`);
    return response.result ?? {};
  } finally {
    cleanup();
  }
}

function buildKakaoRevealFileInputExpression() {
  return `(${async function kakaoRevealFileInput() {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const existing = [...document.querySelectorAll('input[type="file"]')];
    if (existing.length) return { inputCount: existing.length, clicked: false, window_title: document.title };
    const candidates = [...document.querySelectorAll('button, a, label, [role="button"]')];
    const uploadButton = candidates.find((element) => {
      const value = [
        element.innerText,
        element.textContent,
        element.getAttribute?.('aria-label'),
        element.getAttribute?.('title'),
        element.getAttribute?.('data-testid'),
        element.className
      ].join(' ').toLowerCase();
      return /(파일|사진|이미지|첨부|photo|image|file|attach|upload)/i.test(value);
    });
    if (!uploadButton) return { inputCount: 0, clicked: false, reason: 'upload_button_not_found', window_title: document.title };
    uploadButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    uploadButton.click?.();
    await sleep(300);
    return {
      inputCount: document.querySelectorAll('input[type="file"]').length,
      clicked: true,
      window_title: document.title
    };
  }.toString()})()`;
}

function buildKakaoSendPendingAttachmentsExpression(expectedCount = 0) {
  return `(${async function kakaoSendPendingAttachments(count) {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const inputs = [...document.querySelectorAll('input[type="file"]')];
    const selectedFileCount = inputs.reduce((sum, input) => sum + (input.files?.length || 0), 0);
    for (const input of inputs) {
      if (input.files?.length) {
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    await sleep(700);
    const buttons = [...document.querySelectorAll('button')].filter((button) => !button.disabled && button.getAttribute('aria-disabled') !== 'true');
    const sendButton = [...buttons].reverse().find((button) => (button.innerText || button.textContent || '').trim() === '전송')
      || [...buttons].reverse().find((button) => String(button.className || '').includes('btn_submit'));
    if (sendButton) {
      sendButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      sendButton.click?.();
      await sleep(1800);
    }
    return {
      selectedFileCount,
      expectedFileCount: count,
      sendClicked: Boolean(sendButton),
      window_title: document.title
    };
  }.toString()})(${JSON.stringify(expectedCount)})`;
}

export async function attachKakaoFilesViaDevtools(target, attachmentPaths = [], {
  timeoutMs = 20000,
  evaluateImpl = devtoolsEvaluateOnTarget,
  cdpCallImpl = devtoolsCdpCallOnTarget
} = {}) {
  if (!target?.webSocketDebuggerUrl) return { attached: false, reason: 'conversation_target_missing' };
  const files = normalizeKakaoAttachmentPaths(attachmentPaths);
  if (!files.length) return { attached: false, reason: 'no_attachment_paths', files: [] };
  const missing = files.filter((filePath) => !fs.existsSync(filePath));
  if (missing.length) return { attached: false, reason: 'attachment_file_missing', files, missing };

  let revealResult = null;
  try {
    revealResult = await evaluateImpl(target, buildKakaoRevealFileInputExpression(), { timeoutMs });
  } catch (error) {
    revealResult = { error: error.message.slice(0, 500) };
  }

  const findFileInput = async () => {
    const doc = await cdpCallImpl(target, 'DOM.getDocument', { depth: -1, pierce: true }, { timeoutMs });
    const rootNodeId = doc?.root?.nodeId;
    if (!rootNodeId) return 0;
    const query = await cdpCallImpl(target, 'DOM.querySelector', { nodeId: rootNodeId, selector: 'input[type="file"]' }, { timeoutMs });
    return Number(query?.nodeId || 0);
  };

  let nodeId = await findFileInput();
  if (!nodeId && !revealResult?.clicked) {
    revealResult = await evaluateImpl(target, buildKakaoRevealFileInputExpression(), { timeoutMs }).catch((error) => ({ error: error.message.slice(0, 500) }));
    nodeId = await findFileInput();
  }
  if (!nodeId) {
    return { attached: false, reason: 'file_input_not_found', files, revealResult };
  }

  await cdpCallImpl(target, 'DOM.setFileInputFiles', { nodeId, files }, { timeoutMs });
  const sendResult = await evaluateImpl(target, buildKakaoSendPendingAttachmentsExpression(files.length), { timeoutMs })
    .catch((error) => ({ sendClicked: false, error: error.message.slice(0, 500) }));
  const selectedFileCount = Number(sendResult?.selectedFileCount || 0);
  const attached = selectedFileCount >= files.length && sendResult?.sendClicked !== false;
  return {
    attached,
    reason: attached ? 'files_selected_and_send_clicked' : 'attachment_send_not_verified',
    files,
    fileCount: files.length,
    inputNodeId: nodeId,
    revealResult,
    sendResult
  };
}

async function devtoolsFetchTextWithFallbackMethod(baseUrl, pathname, options = {}) {
  try {
    return await devtoolsFetchText(baseUrl, pathname, { ...options, method: 'PUT' });
  } catch (error) {
    return devtoolsFetchText(baseUrl, pathname, { ...options, method: 'GET' });
  }
}

export async function ensureKakaoChannelManagerTabViaDevtools({
  url = DEFAULT_KAKAO_CHANNEL_MANAGER_URL,
  cdpBaseUrl,
  timeoutMs = 10000,
  fetchImpl = fetch
} = {}) {
  if (!cdpBaseUrl) throw new Error('KAKAO_REMOTE_DEBUGGING_PORT or KAKAO_DEVTOOLS_URL is required');
  const targets = await devtoolsFetchJson(cdpBaseUrl, '/json/list', { fetchImpl, timeoutMs });
  const existing = pickKakaoMainListTarget(Array.isArray(targets) ? targets : []);
  if (existing?.id) {
    return { status: 'ready_list_via_devtools', targetId: existing.id, url: existing.url || '' };
  }

  const newTargetBody = await devtoolsFetchTextWithFallbackMethod(
    cdpBaseUrl,
    `/json/new?${encodeURIComponent(url)}`,
    { fetchImpl, timeoutMs }
  );
  let newTarget = null;
  try { newTarget = newTargetBody ? JSON.parse(newTargetBody) : null; } catch {}
  if (newTarget?.id) {
    await devtoolsFetchTextWithFallbackMethod(cdpBaseUrl, `/json/activate/${encodeURIComponent(newTarget.id)}`, { fetchImpl, timeoutMs }).catch(() => '');
  }
  return { status: 'opened_list_via_devtools', targetId: newTarget?.id || null, url };
}

async function ensureKakaoChannelManagerTabViaAppleScript({ url, timeoutMs, spawnImpl }) {
  if (process.platform !== 'darwin') return { status: 'skipped_non_macos' };
  const child = spawnImpl('osascript', ['-e', buildKakaoTabAppleScript(), url], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      try { child.kill?.('SIGTERM'); } catch {}
      finish(reject, new Error(`Kakao Channel Manager tab focus timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code) => {
      if (code === 0) finish(resolve, { status: stdout.trim() || 'ok' });
      else finish(reject, new Error(`Kakao Channel Manager tab focus failed ${code}: ${stderr || stdout}`));
    });
  });
}

export async function ensureKakaoChannelManagerTab({
  url = DEFAULT_KAKAO_CHANNEL_MANAGER_URL,
  timeoutMs = 10000,
  spawnImpl = spawn,
  fetchImpl = fetch,
  cdpBaseUrl = kakaoDevtoolsBaseUrlFromEnv(),
  allowAppleScriptFallback = process.env.KAKAO_APPLESCRIPT_FALLBACK === '1'
} = {}) {
  if (cdpBaseUrl) {
    try {
      return await ensureKakaoChannelManagerTabViaDevtools({ url, cdpBaseUrl, timeoutMs, fetchImpl });
    } catch (error) {
      if (!allowAppleScriptFallback) {
        throw new Error(
          `Kakao Channel Manager tab focus via Chrome DevTools failed: ${error.message}. ` +
          'Restart with scripts/kakao-automation start so the isolated automation Chrome exposes its DevTools port.'
        );
      }
    }
  }
  return ensureKakaoChannelManagerTabViaAppleScript({ url, timeoutMs, spawnImpl });
}

export function buildCloseKakaoConversationWindowAppleScript() {
  return `
on run argv
  set targetTitle to item 1 of argv
  set customerHint to item 2 of argv
  tell application "Google Chrome"
    repeat with w from 1 to count of windows
      set windowTitle to title of window w
      set isKakaoCustomerPopup to (windowTitle contains " - 빌리지 - 카카오비즈니스")
      set exactMatch to (windowTitle is targetTitle)
      set relaxedMatch to ((customerHint is not "") and (windowTitle contains customerHint))
      if isKakaoCustomerPopup and (exactMatch or relaxedMatch) then
        close window w
        return "closed_conversation_window"
      end if
    end repeat
  end tell
  return "conversation_window_not_found"
end run
`.trim();
}

export async function closeKakaoConversationWindow(windowInfo = {}, {
  timeoutMs = 10000,
  spawnImpl = spawn,
  platform = process.platform,
  cuaDriverCommand = 'cua-driver'
} = {}) {
  if (platform === 'win32') {
    const title = text(windowInfo.title).trim();
    const pid = Number(windowInfo.pid);
    const windowId = Number(windowInfo.window_id);
    if (!title.includes(' - 빌리지 - 카카오비즈니스')) return { status: 'skipped_not_kakao_conversation_window' };
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(windowId) || windowId <= 0) {
      return { status: 'skipped_missing_kakao_conversation_window_id' };
    }
    await spawnText(cuaDriverCommand, [
      'call',
      'press_key',
      JSON.stringify({ pid, window_id: windowId, key: 'f4', modifiers: ['alt'] }),
      '--compact'
    ], { timeoutMs, spawnImpl });
    return { status: 'closed_conversation_window' };
  }
  if (platform !== 'darwin') return { status: 'skipped_non_macos' };
  const title = text(windowInfo.title).trim();
  if (!title || !title.includes(' - 빌리지 - 카카오비즈니스')) return { status: 'skipped_not_kakao_conversation_window' };
  const customerHint = title.split(' - 빌리지 - 카카오비즈니스')[0].replace(/^\(\d+\)\s*/, '').trim();
  const child = spawnImpl('osascript', ['-e', buildCloseKakaoConversationWindowAppleScript(), title, customerHint], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      try { child.kill?.('SIGTERM'); } catch {}
      finish(reject, new Error(`Kakao conversation window close timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code) => {
      if (code === 0) finish(resolve, { status: stdout.trim() || 'ok' });
      else finish(reject, new Error(`Kakao conversation window close failed ${code}: ${stderr || stdout}`));
    });
  });
}

export async function closeKakaoConversationTargetViaDevtools(targetInfo = {}, {
  cdpBaseUrl = kakaoDevtoolsBaseUrlFromEnv(),
  timeoutMs = 10000,
  fetchImpl = fetch
} = {}) {
  if (!targetInfo?.id || !cdpBaseUrl) return { status: 'skipped_missing_devtools_target' };
  const body = await devtoolsFetchTextWithFallbackMethod(cdpBaseUrl, `/json/close/${encodeURIComponent(targetInfo.id)}`, { fetchImpl, timeoutMs });
  return { status: 'closed_conversation_target', targetId: targetInfo.id, body: String(body || '').slice(0, 200) };
}

export async function openKakaoChannelManagerUrl({ url = DEFAULT_KAKAO_CHANNEL_MANAGER_URL, timeoutMs = 10000, execFileImpl = execFile } = {}) {
  if (process.platform !== 'darwin') return { status: 'skipped_non_macos' };
  await execFileText('open', ['-a', 'Google Chrome', url], { timeoutMs, execFileImpl });
  await new Promise((resolve) => setTimeout(resolve, 2000));
  return { status: 'opened_or_focused_list' };
}

function spawnText(command, args, { timeoutMs = 15000, maxBuffer = 5_000_000, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch {}
      finish(reject, new Error(`${command} ${args.join(' ')} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > maxBuffer) {
        try { child.kill('SIGTERM'); } catch {}
        finish(reject, new Error(`${command} output exceeded ${maxBuffer} bytes`));
      }
    });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code, signal) => {
      if (settled) return;
      if (code === 0) finish(resolve, stdout);
      else finish(reject, new Error(`${command} ${args.join(' ')} failed code=${code ?? signal}: ${stderr || stdout}`));
    });
  });
}

function execFileText(command, args, { timeoutMs = 15000, execFileImpl = execFile } = {}) {
  return new Promise((resolve, reject) => {
    execFileImpl(command, args, { timeout: timeoutMs, maxBuffer: 5_000_000 }, (error, stdout, stderr) => {
      if (error) {
        const detail = [
          `message=${error.message}`,
          error.code !== undefined ? `code=${error.code}` : '',
          error.signal ? `signal=${error.signal}` : '',
          stderr ? `stderr=${String(stderr).slice(0, 1000)}` : '',
          stdout ? `stdout=${String(stdout).slice(0, 1000)}` : ''
        ].filter(Boolean).join(' ');
        reject(new Error(`${command} ${args.join(' ')} failed: ${detail}`));
      } else {
        resolve(String(stdout));
      }
    });
  });
}

export async function getMacUserIdleSeconds({ timeoutMs = 1200, execFileImpl = execFile } = {}) {
  if (process.platform !== 'darwin') return null;
  const stdout = await execFileText('ioreg', ['-c', 'IOHIDSystem'], { timeoutMs, execFileImpl });
  return parseMacHidIdleSeconds(stdout);
}

export async function checkKakaoCuaFallbackAllowed({
  mode = process.env.KAKAO_WORKER_CONTROL_MODE,
  minIdleSeconds = numberFromEnv(process.env.KAKAO_CUA_MIN_IDLE_SECONDS, 0),
  timeoutMs = 1200,
  execFileImpl = execFile
} = {}) {
  const normalizedMode = normalizeKakaoWorkerControlMode(mode);
  if (normalizedMode === 'cua_first') {
    return { allowed: true, mode: normalizedMode, reason: 'cua_first_mode' };
  }
  if (normalizedMode === 'devtools_only') {
    return { allowed: false, mode: normalizedMode, reason: 'cua_disabled_by_control_mode' };
  }
  const minIdle = Math.max(0, numberFromEnv(minIdleSeconds, 0));
  if (minIdle <= 0) {
    return { allowed: true, mode: normalizedMode, reason: 'idle_guard_disabled' };
  }
  try {
    const userIdleSeconds = await getMacUserIdleSeconds({ timeoutMs, execFileImpl });
    if (!Number.isFinite(userIdleSeconds)) {
      return { allowed: false, mode: normalizedMode, reason: 'human_idle_unknown', minIdleSeconds: minIdle };
    }
    if (userIdleSeconds < minIdle) {
      return {
        allowed: false,
        mode: normalizedMode,
        reason: 'human_recently_active',
        userIdleSeconds: Math.round(userIdleSeconds * 10) / 10,
        minIdleSeconds: minIdle
      };
    }
    return {
      allowed: true,
      mode: normalizedMode,
      reason: 'human_idle_guard_passed',
      userIdleSeconds: Math.round(userIdleSeconds * 10) / 10,
      minIdleSeconds: minIdle
    };
  } catch (error) {
    return {
      allowed: false,
      mode: normalizedMode,
      reason: 'human_idle_check_failed',
      minIdleSeconds: minIdle,
      error: error.message.slice(0, 500)
    };
  }
}

function isVillageAutomationChromeWindowTitle(title = '') {
  const value = String(title || '');
  return value.includes('🤖 자동화 크롬');
}

function isVillageStaffChromeWindowTitle(title = '') {
  const value = String(title || '');
  return value.includes('💁🏻 직원용 크롬') || value.includes('직원용 크롬');
}

function isVillageStaffChromeWindowState(state = {}) {
  const value = `${state?.title || ''}\n${state?.window_title || ''}\n${state?.tree_markdown || ''}`;
  return isVillageStaffChromeWindowTitle(value);
}

function isVillageAutomationChromeWindowState(state = {}) {
  const value = `${state?.title || ''}\n${state?.window_title || ''}\n${state?.tree_markdown || ''}`;
  return isVillageAutomationChromeWindowTitle(value);
}

function rankKakaoMainListWindows(windows = []) {
  const candidates = windows.filter((w) => {
    const title = String(w.title || '');
    return String(w.app_name || '').includes('Chrome') &&
      title.includes('카카오비즈니스 파트너센터') &&
      !title.includes(' - 빌리지 - ') &&
      !isVillageStaffChromeWindowTitle(title);
  });
  candidates.sort((a, b) => {
    const aTitle = String(a.title || '');
    const bTitle = String(b.title || '');
    const aScore = (isVillageAutomationChromeWindowTitle(aTitle) ? 100000 : 0) +
      (a.is_on_screen ? 1000 : 0) +
      ((a.bounds?.width || 0) * (a.bounds?.height || 0));
    const bScore = (isVillageAutomationChromeWindowTitle(bTitle) ? 100000 : 0) +
      (b.is_on_screen ? 1000 : 0) +
      ((b.bounds?.width || 0) * (b.bounds?.height || 0));
    return bScore - aScore;
  });
  return candidates;
}

export function pickKakaoMainListWindow(windows = []) {
  return rankKakaoMainListWindows(windows)[0] || null;
}

export function findChatRowElementIndex(treeMarkdown = '', hints = []) {
  const safeHints = hints.map((h) => String(h || '').trim()).filter(Boolean);
  if (!safeHints.length) return null;
  const lines = String(treeMarkdown || '').split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.includes('AXLink')) continue;
    const block = lines.slice(i, i + 8).join('\n');
    if (!safeHints.some((hint) => block.includes(hint))) continue;
    if (line.includes('채팅') || line.includes('카카오')) continue;
    const match = line.match(/\[(\d+)\]\s+AXLink/);
    if (match) return Number(match[1]);
  }
  return null;
}

export function findKakaoChatSearchInputElementIndex(treeMarkdown = '') {
  const lines = String(treeMarkdown || '').split('\n');
  const inputLinePattern = /\[(\d+)\].*(AXTextField|AXSearchField|AXTextArea)/;
  const isBadInputBlock = (block) => /주소창|address|omnibox|URL|채팅 메시지 입력 폼|메시지 입력|채팅.*입력|내용 입력/i.test(block);
  const isLikelySearchBlock = (block) => /검색|Search|채팅방|친구|고객|이름/i.test(block);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!inputLinePattern.test(line)) continue;
    const block = lines.slice(Math.max(0, i - 6), i + 10).join('\n');
    if (isBadInputBlock(block)) continue;
    if (isLikelySearchBlock(block)) {
      const match = line.match(/\[(\d+)\]/);
      if (match) return Number(match[1]);
    }
  }

  const fallback = lines.find((line) =>
    inputLinePattern.test(line) &&
    /검색|Search/i.test(line) &&
    !/주소창|address|채팅 메시지 입력 폼|메시지 입력|내용 입력/i.test(line)
  );
  const match = fallback?.match(/\[(\d+)\]/);
  return match ? Number(match[1]) : null;
}

function normalizeKakaoChatSearchTerm(value = '') {
  const cleaned = text(value)
    .replace(/\s*-\s*빌리지\s*-\s*카카오비즈니스.*$/i, '')
    .replace(/^\(\d+\)\s*/, '')
    .replace(/^중요\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned || cleaned.length < 2) return '';
  if (/카카오비즈니스|파트너센터|채팅 목록|보낸 메시지 가이드/.test(cleaned)) return '';
  return cleaned.slice(0, 40);
}

function buildKakaoChatSearchTerms(hints = []) {
  const terms = hints
    .map(normalizeKakaoChatSearchTerm)
    .filter(Boolean)
    .sort((a, b) => a.length - b.length);
  return [...new Set(terms)].slice(0, 3);
}

async function typeKakaoChatSearchTerm({ win, searchInputIndex, searchTerm, cuaDriverCommand, timeoutMs, spawnImpl }) {
  await spawnText(cuaDriverCommand, [
    'call', 'press_key', JSON.stringify({ pid: win.pid, window_id: win.window_id, element_index: searchInputIndex, key: 'a', modifiers: ['cmd'] }), '--compact'
  ], { timeoutMs, spawnImpl });
  await spawnText(cuaDriverCommand, [
    'call', 'press_key', JSON.stringify({ pid: win.pid, window_id: win.window_id, element_index: searchInputIndex, key: 'delete' }), '--compact'
  ], { timeoutMs, spawnImpl });
  await spawnText(cuaDriverCommand, [
    'call', 'type_text', JSON.stringify({ pid: win.pid, window_id: win.window_id, element_index: searchInputIndex, text: searchTerm, delay_ms: 5 }), '--compact'
  ], { timeoutMs, spawnImpl });
}

async function findChatRowElementIndexViaSearch({ win, hints, initialTreeMarkdown, cuaDriverCommand, timeoutMs, spawnImpl }) {
  const searchInputIndex = findKakaoChatSearchInputElementIndex(initialTreeMarkdown);
  const searchTerms = buildKakaoChatSearchTerms(hints);
  if (!searchInputIndex || !searchTerms.length) return { elementIndex: null, searchInputIndex, searchTerms, searched: false };

  const tried = [];
  for (const searchTerm of searchTerms) {
    tried.push(searchTerm);
    await typeKakaoChatSearchTerm({ win, searchInputIndex, searchTerm, cuaDriverCommand, timeoutMs, spawnImpl });
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const searchStateText = await spawnText(cuaDriverCommand, [
      'call', 'get_window_state', JSON.stringify({ pid: win.pid, window_id: win.window_id, max_elements: 900 }), '--compact'
    ], { timeoutMs, spawnImpl });
    const searchState = JSON.parse(searchStateText);
    const elementIndex = findChatRowElementIndex(searchState.tree_markdown || '', [searchTerm, ...hints]);
    if (elementIndex) return { elementIndex, searchInputIndex, searchTerms, searched: true, searchTerm, tried };
  }
  return { elementIndex: null, searchInputIndex, searchTerms, searched: true, tried };
}

async function captureKakaoConversationEvidenceFromWindow(conversationWindow, hints, { timeoutMs, spawnImpl, cuaDriverCommand } = {}) {
  try {
    const openedState = await getKakaoWindowState({
      win: conversationWindow,
      cuaDriverCommand,
      timeoutMs,
      spawnImpl,
      maxElements: 900
    });
    return extractKakaoConversationEvidence(openedState.tree_markdown || '', {
      title: conversationWindow.title || openedState.title || openedState.window_title || '',
      hints,
      maxItems: 80
    });
  } catch (error) {
    return { source: 'live_kakao_ax_after_navigation', error: error.message.slice(0, 300) };
  }
}

function rankKakaoConversationWindows(windows = [], hints = []) {
  const candidates = windows.filter((w) => {
    const title = String(w.title || '');
    return String(w.app_name || '').includes('Chrome') &&
      title.includes(' - 빌리지 - 카카오비즈니스') &&
      hints.some((hint) => title.includes(hint)) &&
      !isVillageStaffChromeWindowTitle(title);
  });
  candidates.sort((a, b) => {
    const aTitle = String(a.title || '');
    const bTitle = String(b.title || '');
    return Number(isVillageAutomationChromeWindowTitle(bTitle)) - Number(isVillageAutomationChromeWindowTitle(aTitle)) ||
      Number(b.is_on_screen) - Number(a.is_on_screen);
  });
  return candidates;
}

export function pickKakaoConversationWindow(windows = [], hints = []) {
  return rankKakaoConversationWindows(windows, hints)[0] || null;
}

export function pickKakaoConversationTarget(targets = [], hints = []) {
  const safeHints = hints.map((hint) => String(hint || '').trim()).filter(Boolean);
  const candidates = (Array.isArray(targets) ? targets : []).filter((target) => {
    const title = String(target?.title || '');
    const url = String(target?.url || '');
    return target?.type === 'page' &&
      /^https:\/\/(business|center-pf)\.kakao\.com\/_[^/]+\/chats\/\d+/.test(url) &&
      title.includes(' - 빌리지 - 카카오비즈니스') &&
      (!safeHints.length || safeHints.some((hint) => title.includes(hint)));
  });
  candidates.sort((a, b) => {
    const aTitle = String(a.title || '');
    const bTitle = String(b.title || '');
    const aExact = safeHints.some((hint) => aTitle.startsWith(`${hint} -`)) ? 1 : 0;
    const bExact = safeHints.some((hint) => bTitle.startsWith(`${hint} -`)) ? 1 : 0;
    return bExact - aExact;
  });
  return candidates[0] || null;
}

export function extractKakaoConversationEvidence(treeMarkdown = '', { title = '', hints = [], maxItems = 80 } = {}) {
  const skipExact = new Set([
    '채팅방 레이어', '친구', '채팅 메시지 입력 폼', '보낸 메시지 가이드', '여기까지 읽었습니다.',
    '사진', '동영상', '파일', '이모티콘', '전송', '상담 완료하기', '채팅방 나가기'
  ]);
  const values = [];
  const regex = /AXStaticText = "([^"]*)"/g;
  let match;
  while ((match = regex.exec(String(treeMarkdown)))) {
    let value = match[1].replace(/\\n/g, ' ').trim();
    if (!value || skipExact.has(value)) continue;
    if (value.length > 500) value = `${value.slice(0, 500)}…`;
    values.push(value);
  }
  const tail = values.slice(-maxItems);
  const hintMatched = hints.some((hint) => String(title).includes(hint) || tail.some((value) => value.includes(hint)));
  return {
    source: 'live_kakao_ax_after_navigation',
    title,
    hint_matched: hintMatched,
    hints,
    visible_static_text_tail: tail,
    note: 'Live AX text captured after deterministic navigation. It is browser evidence for the AI to inspect, not a deterministic business classification.'
  };
}

function extractKakaoConversationEvidenceFromText(bodyText = '', { title = '', hints = [], maxItems = 80, source = 'live_kakao_dom_after_navigation' } = {}) {
  const values = String(bodyText || '')
    .split(/\n+/)
    .map((value) => value.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .filter((value) => !['채팅방 레이어', '친구', '채팅 메시지 입력 폼', '보낸 메시지 가이드', '전송'].includes(value));
  const tail = values.slice(-maxItems);
  const hintMatched = hints.some((hint) => String(title).includes(hint) || tail.some((value) => value.includes(hint)));
  return {
    source,
    title,
    hint_matched: hintMatched,
    hints,
    visible_static_text_tail: tail,
    note: 'Live DOM text captured after deterministic DevTools navigation. It is browser evidence for the AI to inspect, not a deterministic business classification.'
  };
}

function buildKakaoSearchAndOpenExpression(searchTerms = [], hints = [], { allowSearch = true } = {}) {
  return `(${async function kakaoSearchAndOpen(searchTermsArg, hintsArg, allowSearchArg) {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const input = document.querySelector('input[placeholder*="채팅방 이름"], input[name="keyword"], input.tf_g');
    const button = document.querySelector('button.btn_search, button[type="submit"]');
    const setInputValue = (element, value) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (setter) setter.call(element, value);
      else element.value = value;
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: value ? 'insertText' : 'deleteContentBackward', data: value || null }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    };
    const findRow = (terms) => {
      const safeTerms = terms.map(normalize).filter(Boolean);
      return [...document.querySelectorAll('a.link_chat, a, [role="link"]')]
        .find((row) => {
          const text = normalize(row.innerText || row.textContent || '');
          return text && safeTerms.some((term) => text.includes(term));
        });
    };
    const allTerms = [...new Set([...(searchTermsArg || []), ...(hintsArg || [])].map(normalize).filter(Boolean))];
    let row = findRow(allTerms);
    let usedSearchTerm = null;
    const tried = [];
    if (!row) {
      if (!allowSearchArg) return { ok: false, status: 'visible_chat_row_not_found_search_disabled', tried };
      if (!input) return { ok: false, status: 'chat_search_input_not_found' };
      for (const term of (searchTermsArg || [])) {
        const cleanTerm = normalize(term);
        if (!cleanTerm) continue;
        tried.push(cleanTerm);
        usedSearchTerm = cleanTerm;
        input.focus();
        setInputValue(input, cleanTerm);
        button?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
        await sleep(1200);
        row = findRow([cleanTerm, ...(hintsArg || [])]);
        if (row) break;
      }
    }
    if (!row) return { ok: false, status: 'chat_row_not_found_after_devtools_search', tried };
    const clickedText = normalize(row.innerText || row.textContent || '').slice(0, 500);
    row.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    row.click();
    await sleep(300);
    if (input && input.value) {
      setInputValue(input, '');
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    }
    await sleep(1500);
    return { ok: true, status: 'clicked_chat_row_via_devtools', searchTerm: usedSearchTerm, tried, clickedText };
  }.toString()})(${JSON.stringify(searchTerms)}, ${JSON.stringify(hints)}, ${JSON.stringify(Boolean(allowSearch))})`;
}

function buildKakaoConversationTextExpression() {
  return `(() => ({ title: document.title, href: location.href, text: document.body?.innerText || '' }))()`;
}

export async function openKakaoTargetChatViaDevtools(job, {
  cdpBaseUrl = kakaoDevtoolsBaseUrlFromEnv(),
  timeoutMs = 20000,
  fetchImpl = fetch,
  evaluateImpl = devtoolsEvaluateOnTarget,
  allowSearch = process.env.KAKAO_WORKER_SEARCH_TARGET_CHAT !== '0'
} = {}) {
  const hints = extractNavigationHints(job);
  if (!hints.length) return { status: 'no_navigation_hints' };
  if (!cdpBaseUrl) return { status: 'devtools_unavailable', reason: 'missing_cdp_base_url', hints };
  const targets = await devtoolsFetchJson(cdpBaseUrl, '/json/list', { fetchImpl, timeoutMs });
  const targetList = Array.isArray(targets) ? targets : [];
  const existingConversationTarget = pickKakaoConversationTarget(targetList, hints);
  if (existingConversationTarget) {
    const dom = await evaluateImpl(existingConversationTarget, buildKakaoConversationTextExpression(), { timeoutMs });
    return {
      status: 'opened_target_chat',
      already_open: true,
      via_devtools: true,
      hints,
      conversation_target: {
        id: existingConversationTarget.id,
        title: existingConversationTarget.title || dom?.title || '',
        url: existingConversationTarget.url || dom?.href || '',
        webSocketDebuggerUrl: existingConversationTarget.webSocketDebuggerUrl
      },
      conversation_evidence: extractKakaoConversationEvidenceFromText(dom?.text || '', {
        title: existingConversationTarget.title || dom?.title || '',
        hints,
        source: 'live_kakao_dom_existing_conversation'
      })
    };
  }

  const mainTarget = pickKakaoMainListTarget(targetList);
  if (!mainTarget) return { status: 'main_list_target_not_found', hints };
  const searchTerms = buildKakaoChatSearchTerms(hints);
  const openResult = await evaluateImpl(mainTarget, buildKakaoSearchAndOpenExpression(searchTerms, hints, { allowSearch }), { timeoutMs });
  if (!openResult?.ok) {
    return {
      status: openResult?.status || 'devtools_search_failed',
      hints,
      via_devtools: true,
      search: {
        searched: Boolean(allowSearch),
        disabled: !allowSearch,
        search_terms: searchTerms,
        tried: openResult?.tried || []
      }
    };
  }
  const targetsAfterOpen = await devtoolsFetchJson(cdpBaseUrl, '/json/list', { fetchImpl, timeoutMs });
  const conversationTarget = pickKakaoConversationTarget(Array.isArray(targetsAfterOpen) ? targetsAfterOpen : [], hints);
  if (!conversationTarget) {
    return {
      status: 'conversation_target_not_found_after_devtools_click',
      hints,
      via_devtools: true,
      search: {
        searched: Boolean(allowSearch),
        disabled: !allowSearch,
        search_term: openResult.searchTerm || null,
        search_terms: searchTerms,
        tried: openResult.tried || []
      },
      conversation_evidence: {
        source: 'live_kakao_dom_after_navigation',
        hint_matched: false,
        evidence_status: 'insufficient',
        note: 'Clicked the matching chat row through DevTools, but no Kakao customer conversation target was found.'
      }
    };
  }
  const dom = await evaluateImpl(conversationTarget, buildKakaoConversationTextExpression(), { timeoutMs });
  return {
    status: 'opened_target_chat',
    via_devtools: true,
    opened_by_devtools_search: true,
    hints,
    conversation_target: {
      id: conversationTarget.id,
      title: conversationTarget.title || dom?.title || '',
      url: conversationTarget.url || dom?.href || '',
      webSocketDebuggerUrl: conversationTarget.webSocketDebuggerUrl
    },
    search: {
      searched: Boolean(allowSearch),
      disabled: !allowSearch,
      search_term: openResult.searchTerm || null,
      search_terms: searchTerms,
      tried: openResult.tried || []
    },
    conversation_evidence: extractKakaoConversationEvidenceFromText(dom?.text || '', {
      title: conversationTarget.title || dom?.title || '',
      hints
    })
  };
}

export function canAutoSendCustomerAnswer(decision = {}, config = {}) {
  if (!config.autoSendEnabled) return { allowed: false, reason: 'auto_send_disabled' };
  const reply = decisionReply(decision);
  const mode = String(reply.replyMode || reply.reply_mode || '').trim();
  const confidence = String(reply.confidence || decision.confidence || '').trim();
  const textValue = text(reply.text || decision.suggested_reply_draft).trim();
  const killSwitch = String(decision.kill_switch_observed || '').trim();
  const classification = String(decision.classification || '').trim();
  const safetyClass = replySafetyClass(decision);
  const grounding = replyGrounding(decision);
  const requiresRag = replyRequiresRag(decision);
  const priceLikeClassifications = new Set(['price', 'price_review', 'quote_send']);
  const allowedSafetyClasses = new Set([
    'simple_ack',
    'contact_request',
    'reservation_intake_ack',
    'payment_receipt_ack',
    'current_policy_answer',
    'rag_grounded_answer',
    'authoritative_availability_answer',
    'staff_confirmed_reservation_acceptance',
    'live_quote_link_guidance'
  ]);
  if (killSwitch === 'paused') return { allowed: false, reason: 'kill_switch_paused' };
  if (killSwitch === 'price_paused' && priceLikeClassifications.has(classification)) return { allowed: false, reason: 'kill_switch_price_paused' };
  if (killSwitch !== 'active' && killSwitch !== 'price_paused') return { allowed: false, reason: `kill_switch_${killSwitch || 'unknown'}` };
  if (mode !== 'auto_send') return { allowed: false, reason: `replyMode_${mode || 'missing'}` };
  if (confidence !== 'high') return { allowed: false, reason: `confidence_${confidence || 'missing'}` };
  if (!safetyClass) return { allowed: false, reason: 'reply_safety_class_missing' };
  if (!allowedSafetyClasses.has(safetyClass)) return { allowed: false, reason: `reply_safety_class_${safetyClass}_not_auto_sendable` };
  if (!AI_REPLY_GROUNDING_CLASSES.has(grounding) || grounding === 'none') return { allowed: false, reason: 'reply_grounding_missing' };
  if (typeof requiresRag !== 'boolean') return { allowed: false, reason: 'reply_requires_rag_missing' };
  if (safetyClass === 'current_policy_answer' && grounding !== 'current_confirmed_policy') {
    return { allowed: false, reason: 'current_policy_grounding_mismatch' };
  }
  if (safetyClass === 'rag_grounded_answer' && (grounding !== 'retrieved_rag' || requiresRag !== true)) {
    return { allowed: false, reason: 'rag_grounding_mismatch' };
  }
  if (safetyClass === 'authoritative_availability_answer') {
    const authoritativeStatus = text(decision?.authoritative_sheet_result?.status).trim();
    if (grounding !== 'authoritative_sheet' || authoritativeStatus !== 'available' || requiresRag !== false) {
      return { allowed: false, reason: 'authoritative_availability_grounding_mismatch' };
    }
    if (/(예약|대여)\s*(?:확정|완료)|(?:확정|예약)\s*(?:됐|되었습니다|완료)|환불|파손|분실|[0-9,]+\s*(?:원|만원)|입금|계좌|금액/.test(textValue)) {
      return { allowed: false, reason: 'authoritative_availability_contains_unverified_commitment' };
    }
  }
  if (!textValue || textValue.length < 5) return { allowed: false, reason: 'reply_text_too_short' };
  if (textValue.length > 1000) return { allowed: false, reason: 'reply_text_too_long' };
  if (decision?.safety_checks?.kakao_conversation_opened !== true) return { allowed: false, reason: 'conversation_not_opened' };
  if (decision?.safety_checks?.did_not_classify_from_preview_only !== true) return { allowed: false, reason: 'preview_only' };
  if (decision?.safety_checks?.latest_customer_message_after_last_staff_reply !== true) return { allowed: false, reason: 'latest_turn_not_customer' };
  if (decision.owner_review_required === true || decision.ownerReviewRequired === true) return { allowed: false, reason: 'owner_review_required' };
  const sensitiveCommitmentPattern = /(refund|환불|분실|파손|손상|결제\s*취소|예약\s*확정|재고\s*가능|가능\s*확정|(?:대여|예약)?\s*가능(?:합니다|하세요|하십니다|해요|함)?|확정|[0-9,]+\s*(?:원|만원)|입금|계좌|금액)/i;
  if (sensitiveCommitmentPattern.test(textValue)) {
    const explicitSensitiveAllowance = new Set([
      'payment_receipt_ack',
      'authoritative_availability_answer',
      'staff_confirmed_reservation_acceptance',
      'live_quote_link_guidance'
    ]);
    if (!explicitSensitiveAllowance.has(safetyClass)) return { allowed: false, reason: 'sensitive_commitment_text' };
    if (safetyClass === 'payment_receipt_ack' && /(입금|결제).{0,16}(?:확인\s*(?:완료|됐|되었습니다)|완료)|(?:확인\s*(?:완료|됐|되었습니다)|완료).{0,16}(?:입금|결제)/.test(textValue)) {
      return { allowed: false, reason: 'payment_ack_claims_completed_verification' };
    }
    if (safetyClass === 'staff_confirmed_reservation_acceptance' && /(환불|파손|분실|[0-9,]+\s*(?:원|만원)|입금|계좌|금액)/.test(textValue)) {
      return { allowed: false, reason: 'reservation_acceptance_contains_unrelated_commitment' };
    }
    if (safetyClass === 'live_quote_link_guidance' && /(재고\s*가능|대여\s*가능|예약\s*확정|[0-9,]+\s*(?:원|만원)|입금|계좌)/.test(textValue)) {
      return { allowed: false, reason: 'quote_link_guidance_contains_commitment' };
    }
  }
  return { allowed: true, reason: safetyClass, text: textValue, replyMode: mode, confidence, safetyClass, grounding };
}

function isStaffSenderLabel(value = '') {
  return /(빌리지|김준영|최재형|직원|운영자|상담원|매니저|village)/i.test(text(value));
}

function latestCustomerMessageForRag(decision = {}, job = {}) {
  const cluster = text(decision.latest_customer_message_cluster).trim();
  if (cluster) return cluster;
  const messages = Array.isArray(decision.visible_messages_used) ? decision.visible_messages_used : [];
  const latest = [...messages].reverse().find((message) => text(message?.message) && !isStaffSenderLabel(message?.sender));
  return text(latest?.message || job.preview_text || job.previewText || job.payload?.previewText).trim();
}

export function mutablePolicyAutoReplyRisk(decision = {}, replyText = '') {
  const visibleMessages = Array.isArray(decision.visible_messages_used)
    ? decision.visible_messages_used.map((message) => message?.message)
    : [];
  const combined = [
    decision.latest_customer_message_cluster,
    decision.suggested_reply_draft,
    decision.reply_decision?.text,
    replyText,
    ...visibleMessages
  ].map(text).join(' ').normalize('NFKC');
  if (/(학생\s*할인|학생할인|학생가|비학생|할인율|몇\s*(?:프로|퍼센트)|\d+\s*%|가격|요금|견적|단가|할인|제휴|단골|사업자|프리랜서|보증금|환불|결제|계좌|입금|세금\s*계산|세금계산|거래\s*명세|거래명세|VAT|부가세)/i.test(combined)) {
    return { mutable: true, reason: 'mutable_policy_terms' };
  }
  return { mutable: false, reason: 'not_mutable_policy' };
}

function hasNearbyPolicyRate(value = '', labelPattern, rate) {
  const input = text(value).normalize('NFKC');
  const label = input.search(labelPattern);
  const rateMatch = input.search(new RegExp(`${rate}\\s*(?:%|퍼센트|프로)`));
  if (label < 0 || rateMatch < 0) return false;
  return Math.abs(label - rateMatch) <= 80;
}

function includesAny(value = '', patterns = []) {
  const input = text(value).normalize('NFKC');
  return patterns.some((pattern) => pattern.test(input));
}

export function currentConfirmedPolicyAutoReplySupport(decision = {}, replyText = '') {
  const visibleMessages = Array.isArray(decision.visible_messages_used)
    ? decision.visible_messages_used.map((message) => message?.message)
    : [];
  const combined = [
    decision.latest_customer_message_cluster,
    decision.suggested_reply_draft,
    decision.reply_decision?.text,
    replyText,
    ...visibleMessages
  ].map(text).join(' ').normalize('NFKC');
  const reply = text(replyText || decision.reply_decision?.text || decision.suggested_reply_draft).normalize('NFKC');
  const checks = [];

  if (/(학생\s*할인|학생할인|학생가)/.test(combined) && !/비학생/.test(combined)) {
    checks.push({
      topic: 'student_discount_rate',
      ok: hasNearbyPolicyRate(reply, /학생\s*(?:할인|가)?/, 30) || /30\s*(?:%|퍼센트|프로)[^.\n]{0,30}학생/.test(reply)
    });
  }
  if (/(개인\s*사업자|사업자|프리랜서|개사프)/.test(combined)) {
    checks.push({
      topic: 'business_freelancer_discount_rate',
      ok: hasNearbyPolicyRate(reply, /개인\s*사업자|사업자|프리랜서|개사프/, 20) || /20\s*(?:%|퍼센트|프로)[^.\n]{0,40}(?:개인\s*사업자|사업자|프리랜서|개사프)/.test(reply)
    });
  }
  if (/단골/.test(combined)) {
    checks.push({
      topic: 'regular_customer_discount_rate',
      ok: hasNearbyPolicyRate(reply, /단골/, 10) || /단골[^.\n]{0,60}(?:개인\s*사업자|프리랜서)[^.\n]{0,60}20\s*(?:%|퍼센트|프로)/.test(reply)
    });
  }
  if (/제휴/.test(combined)) {
    checks.push({
      topic: 'partner_discount_rate',
      ok: hasNearbyPolicyRate(reply, /제휴/, 20)
    });
  }
  if (/(장기\s*할인|장기할인|2일|3~5일|3-5일|6~9일|10~14일|15~19일|20일\s*(?:이상|\+)?)/.test(combined)) {
    checks.push({
      topic: 'long_term_discount_policy',
      ok: /(2일[^.\n]{0,20}10\s*(?:%|퍼센트|프로)|3\s*[~-]\s*5일[^.\n]{0,20}20\s*(?:%|퍼센트|프로)|6\s*[~-]\s*9일[^.\n]{0,20}35\s*(?:%|퍼센트|프로)|10\s*[~-]\s*14일[^.\n]{0,20}40\s*(?:%|퍼센트|프로)|15\s*[~-]\s*19일[^.\n]{0,20}45\s*(?:%|퍼센트|프로)|20일\s*(?:이상|\+)?[^.\n]{0,20}50\s*(?:%|퍼센트|프로)|장기\s*할인)/.test(reply)
    });
  }
  if (/(영업\s*시간|운영\s*시간|몇\s*시(?:부터|까지)|언제\s*(?:열|닫)|24\s*시간)/.test(combined)) {
    checks.push({
      topic: 'business_hours_policy',
      ok: /24\s*시간/.test(reply)
    });
  }
  if (/(대여\s*일수|6\s*시간|하루|1일\s*계산|(?:렌탈|대여)[^.\n]{0,30}24\s*시간)/.test(combined) && !/(영업\s*시간|운영\s*시간)/.test(combined)) {
    checks.push({
      topic: 'rental_day_policy',
      ok: /(24\s*시간[^.\n]{0,20}1일|6\s*시간[^.\n]{0,40}(?:같은\s*일수|\+1일|추가|초과))/.test(reply)
    });
  }
  if (/(VAT|vat|부가세|최종\s*금액|최종금액)/i.test(combined)) {
    checks.push({
      topic: 'vat_final_amount_policy',
      ok: /(VAT|vat|부가세|1\.1|10\s*%|10원\s*단위|올림)/i.test(reply)
    });
  }
  if (/(할인\s*계산|할인율\s*계산|곱셈|더하기|합산)/.test(combined)) {
    checks.push({
      topic: 'discount_multiplier_policy',
      ok: /(곱셈|곱해서|곱해|0\.7\s*\*\s*0\.8|더하지\s*않)/.test(reply)
    });
  }

  if (!checks.length) {
    const unconfirmedMutable = includesAny(combined, [
      /비학생/,
      /보증금/,
      /환불/,
      /취소/,
      /계좌/,
      /입금/,
      /결제/,
      /세금\s*계산|세금계산/,
      /거래\s*명세|거래명세/,
      /현금\s*영수|현금영수/,
      /주차/,
      /배송|퀵/,
      /연장/,
      /파손|분실/
    ]);
    return {
      applicable: false,
      allowed: false,
      reason: unconfirmedMutable ? 'policy_not_in_current_confirmed_set_use_rag' : 'not_current_confirmed_policy'
    };
  }

  const failed = checks.filter((check) => !check.ok).map((check) => check.topic);
  return {
    applicable: true,
    allowed: failed.length === 0,
    reason: failed.length ? 'current_policy_reply_mismatch' : 'current_confirmed_policy_match',
    topics: checks.map((check) => check.topic),
    failedTopics: failed
  };
}

export function autoReplyRequiresRagSupport(decision = {}, replyText = '') {
  void replyText;
  const safetyClass = replySafetyClass(decision);
  const requiresRag = replyRequiresRag(decision);
  if (!safetyClass) return { required: true, reason: 'reply_safety_class_missing' };
  if (safetyClass === 'current_policy_answer') return { required: true, reason: 'current_policy_answer' };
  if (safetyClass === 'rag_grounded_answer' || requiresRag === true) {
    return { required: true, reason: safetyClass === 'rag_grounded_answer' ? 'rag_grounded_answer' : 'ai_requires_rag' };
  }
  if (requiresRag !== false) return { required: true, reason: 'reply_requires_rag_missing' };
  return { required: false, reason: safetyClass };
}

export function buildAutoReplyRagQuestion({ decision = {}, job = {}, replyText = '' } = {}) {
  const customer = text(decision?.customer?.name || decision?.customer_name || job.customer_name || '').trim();
  const latestCustomer = latestCustomerMessageForRag(decision, job);
  const mutablePolicy = mutablePolicyAutoReplyRisk(decision, replyText);
  const visibleMessages = Array.isArray(decision.visible_messages_used)
    ? decision.visible_messages_used.slice(-6).map((message) => {
        const sender = text(message?.sender || 'unknown').slice(0, 40);
        const body = text(message?.message).replace(/\s+/g, ' ').slice(0, 240);
        return body ? `${sender}: ${body}` : '';
      }).filter(Boolean).join('\n')
    : '';
  return [
    '빌리지 카카오 자동응답 검증용 RAG 질문입니다.',
    '현재 재고/예약 가능 여부/스케줄 확정은 판단하지 말고, 과거 빌리지 대화/문서는 정책/절차/말투 예시로 확인해 주세요.',
    mutablePolicy.mutable ? '주의: 현재 확정 정책(학생30%, 개사프20%, 장기할인표, VAT/일수 계산)과 충돌하면 현재 확정 정책이 우선입니다. 확정 정책에 없는 보증금/환불/계좌/증빙 등은 RAG 근거로 판단하세요.' : '',
    customer ? `고객명: ${customer}` : '',
    `분류: ${text(decision.classification || 'unknown')}`,
    latestCustomer ? `최신 고객 메시지: ${latestCustomer}` : '',
    visibleMessages ? `최근 카카오 맥락:\n${visibleMessages}` : '',
    replyText ? `AI가 보내려는 답변 초안: ${replyText}` : '',
    '위 답변이 빌리지 정책/절차/말투와 맞는지, 더 빌리지답게 조정할 포인트가 있는지 짧게 알려주세요.'
  ].filter(Boolean).join('\n');
}

export async function evaluateAutoReplyRagSupport({ config = {}, decision = {}, job = {}, replyText = '', askImpl = askVillageAi } = {}) {
  const requirement = autoReplyRequiresRagSupport(decision, replyText);
  if (!requirement.required) return { required: false, allowed: true, reason: requirement.reason };
  const currentPolicy = requirement.reason === 'current_policy_answer'
    ? currentConfirmedPolicyAutoReplySupport(decision, replyText)
    : null;
  if (currentPolicy?.applicable) {
    return {
      required: true,
      allowed: currentPolicy.allowed,
      reason: currentPolicy.allowed ? 'current_confirmed_policy_match' : 'current_policy_mismatch_requires_review',
      requirement,
      currentPolicy
    };
  }
  if (requirement.reason === 'current_policy_answer') {
    return {
      required: true,
      allowed: false,
      reason: 'current_policy_not_authoritatively_verified',
      requirement,
      currentPolicy
    };
  }
  if (!config.villageAiUrl) return { required: true, allowed: false, reason: 'rag_not_configured', requirement };
  const question = buildAutoReplyRagQuestion({ decision, job, replyText });
  try {
    const result = await askImpl({ question, userRole: 'customer' }, config, { timeoutMs: config.ragTimeoutMs });
    const confidence = String(result.confidence || '').toLowerCase();
    const knowledgeSource = String(result.knowledgeSource || '').toLowerCase();
    const allowed = !result.error
      && confidence === 'high'
      && knowledgeSource === 'retrieved'
      && result.ownerReview !== true
      && Boolean(text(result.text));
    return {
      required: true,
      allowed,
      reason: allowed ? 'rag_high_confidence_retrieved' : 'rag_not_strong_enough_for_auto_send',
      requirement,
      question: question.slice(0, 1200),
      text: text(result.text).slice(0, 1600),
      confidence: result.confidence || null,
      ownerReview: result.ownerReview ?? null,
      knowledgeSource: result.knowledgeSource || null,
      usedSources: Array.isArray(result.usedSources) ? result.usedSources.slice(0, 5) : [],
      topSimilarity: result.topSimilarity ?? null,
      logId: result.logId || null,
      error: result.error || null
    };
  } catch (error) {
    return {
      required: true,
      allowed: false,
      reason: 'rag_lookup_error',
      requirement,
      question: question.slice(0, 1200),
      error: error.message.slice(0, 500)
    };
  }
}

export function findKakaoMessageInputElementIndex(treeMarkdown = '') {
  const lines = String(treeMarkdown).split('\n');
  const formLabelIndex = lines.findIndex((line) => /채팅 메시지 입력 폼|메시지 입력|채팅.*입력/.test(line));
  if (formLabelIndex >= 0) {
    const nearbyInput = lines
      .slice(formLabelIndex, formLabelIndex + 30)
      .find((line) => /\[(\d+)\]/.test(line) && /AXTextArea|AXTextField/.test(line) && !/주소창|검색창|address/i.test(line));
    const nearbyMatch = nearbyInput?.match(/\[(\d+)\]/);
    if (nearbyMatch) return Number(nearbyMatch[1]);
  }
  const preferred = lines.find((line) => /\[(\d+)\]/.test(line) && /AXTextArea|AXTextField/.test(line) && /채팅|메시지|입력|내용/.test(line) && !/주소창|검색창|address/i.test(line));
  const fallback = preferred || lines.find((line) => /\[(\d+)\]/.test(line) && /AXTextArea|AXTextField/.test(line) && !/주소창|검색창|address/i.test(line));
  const match = fallback?.match(/\[(\d+)\]/);
  return match ? Number(match[1]) : null;
}

export function findKakaoSendButtonElementIndex(treeMarkdown = '') {
  const line = String(treeMarkdown).split('\n')
    .find((item) => /\[(\d+)\]\s+AXButton/.test(item) && /전송/.test(item));
  const match = line?.match(/\[(\d+)\]/);
  return match ? Number(match[1]) : null;
}

function normalizeVerificationText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function kakaoConversationContainsMessage(treeMarkdown = '', message = '') {
  const expected = normalizeVerificationText(message);
  if (!expected) return false;
  const values = [];
  const regex = /AXStaticText = "([^"]*)"/g;
  let match;
  while ((match = regex.exec(String(treeMarkdown)))) values.push(normalizeVerificationText(match[1].replace(/\\n/g, ' ')));
  return values.some((value) => value === expected || value.includes(expected));
}

function buildKakaoSendMessageExpression(textToSend = '') {
  return `(${async function kakaoSendMessage(message) {
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const textarea = document.querySelector('textarea[placeholder*="메시지"], textarea.tf_g, textarea');
    if (!textarea) return { sent: false, reason: 'message_input_not_found', window_title: document.title };
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(textarea, message);
    else textarea.value = message;
    textarea.focus();
    textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: message }));
    textarea.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(150);
    const buttons = [...document.querySelectorAll('button')];
    const sendButton = buttons.find((button) => (button.innerText || button.textContent || '').trim() === '전송')
      || buttons.find((button) => String(button.className || '').includes('btn_submit'));
    if (!sendButton) return { sent: false, reason: 'send_button_not_found', window_title: document.title };
    sendButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    sendButton.click();
    await sleep(1200);
    const bodyText = document.body?.innerText || '';
    const sent = bodyText.replace(/\s+/g, ' ').includes(String(message).replace(/\s+/g, ' ').trim());
    return {
      sent,
      reason: sent ? 'sent_via_devtools_verified' : 'send_not_verified_in_conversation',
      window_title: document.title
    };
  }.toString()})(${JSON.stringify(textToSend)})`;
}

export async function sendKakaoMessageViaDevtools(textToSend, navigationContext = {}, {
  timeoutMs = 20000,
  evaluateImpl = devtoolsEvaluateOnTarget,
  cdpCallImpl = devtoolsCdpCallOnTarget,
  attachmentPaths = []
} = {}) {
  const target = navigationContext?.conversation_target;
  if (!target?.webSocketDebuggerUrl) return { sent: false, reason: 'conversation_target_missing' };
  const files = normalizeKakaoAttachmentPaths(attachmentPaths);
  const textValue = text(textToSend).trim();
  const result = textValue
    ? await evaluateImpl(target, buildKakaoSendMessageExpression(textValue), { timeoutMs })
    : { sent: true, reason: 'text_skipped', window_title: target.title || '' };
  const textSent = Boolean(result?.sent);
  let attachmentResult = null;
  if (textSent && files.length) {
    attachmentResult = await attachKakaoFilesViaDevtools(target, files, { timeoutMs, evaluateImpl, cdpCallImpl });
  } else if (files.length) {
    attachmentResult = { attached: false, reason: 'text_send_failed_attachments_skipped', files };
  }
  const attachmentOk = !files.length || attachmentResult?.attached === true;
  const sent = textSent && attachmentOk;
  return {
    sent,
    reason: sent
      ? (files.length ? 'sent_via_devtools_verified_with_attachments' : (result?.reason || 'devtools_send_unknown'))
      : (attachmentResult?.reason || result?.reason || 'devtools_send_unknown'),
    window_title: result?.window_title || target.title || '',
    via_devtools: true,
    ...(files.length ? { attachments: attachmentResult } : {})
  };
}

export function buildActivateGoogleChromeWindowAppleScript() {
  return `
on run argv
  set targetTitle to ""
  if (count of argv) > 0 then set targetTitle to item 1 of argv
  tell application "Google Chrome"
    activate
    if targetTitle is not equal to "" then
      repeat with w in windows
        try
          set tabTitle to title of active tab of w
          if tabTitle contains targetTitle or targetTitle contains tabTitle then
            set index of w to 1
            exit repeat
          end if
        end try
      end repeat
    end if
  end tell
end run
`.trim();
}

async function activateGoogleChromeForCua({ timeoutMs = 5000, spawnImpl = spawn, windowTitle = '' } = {}) {
  if (process.platform !== 'darwin') return { status: 'skipped_non_macos' };
  try {
    await spawnText('osascript', ['-e', buildActivateGoogleChromeWindowAppleScript(), windowTitle || ''], { timeoutMs, spawnImpl });
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { status: 'activated_chrome', windowTitle: windowTitle || '' };
  } catch (error) {
    return { status: 'activation_failed_non_fatal', windowTitle: windowTitle || '', error: error.message.slice(0, 300) };
  }
}

function isCuaFrontmostDisabledError(error) {
  const message = String(error?.message || error || '');
  return message.includes('AXEnabled = false') || message.includes('not frontmost') || message.includes('silent no-op');
}

async function getKakaoWindowState({ win, cuaDriverCommand, timeoutMs, spawnImpl, maxElements = 900 }) {
  const stateText = await spawnText(cuaDriverCommand, [
    'call', 'get_window_state', JSON.stringify({ pid: win.pid, window_id: win.window_id, max_elements: maxElements }), '--compact'
  ], { timeoutMs, spawnImpl, maxBuffer: 3_000_000 });
  return JSON.parse(stateText);
}

async function clickKakaoSendButton({ win, sendButtonIndex, cuaDriverCommand, timeoutMs, spawnImpl }) {
  try {
    await spawnText(cuaDriverCommand, [
      'call', 'click', JSON.stringify({ pid: win.pid, window_id: win.window_id, element_index: sendButtonIndex }), '--compact'
    ], { timeoutMs, spawnImpl });
    return { clicked: true, sendButtonIndex };
  } catch (error) {
    if (!isCuaFrontmostDisabledError(error)) throw error;
    await activateGoogleChromeForCua({ timeoutMs: Math.min(timeoutMs, 5000), spawnImpl, windowTitle: win.title || '' });
    const retryState = await getKakaoWindowState({ win, cuaDriverCommand, timeoutMs, spawnImpl, maxElements: 900 });
    const retrySendButtonIndex = findKakaoSendButtonElementIndex(retryState.tree_markdown || '') || sendButtonIndex;
    try {
      await spawnText(cuaDriverCommand, [
        'call', 'click', JSON.stringify({ pid: win.pid, window_id: win.window_id, element_index: retrySendButtonIndex }), '--compact'
      ], { timeoutMs, spawnImpl });
      return { clicked: true, sendButtonIndex: retrySendButtonIndex, retriedAfterFrontmostActivation: true };
    } catch (retryError) {
      if (!isCuaFrontmostDisabledError(retryError)) throw retryError;
      return { clicked: false, sendButtonIndex: retrySendButtonIndex, retriedAfterFrontmostActivation: true, disabledAfterRetry: true };
    }
  }
}

async function listCuaWindows({ cuaDriverCommand, timeoutMs, spawnImpl }) {
  const windowsText = await spawnText(cuaDriverCommand, ['call', 'list_windows', '--compact'], {
    timeoutMs,
    spawnImpl,
    maxBuffer: 3_000_000
  });
  return JSON.parse(windowsText).windows || [];
}

async function verifyKakaoAutomationCuaWindow(win, { cuaDriverCommand, timeoutMs, spawnImpl, maxElements = 700 } = {}) {
  if (!win?.pid || !win?.window_id) return { ok: false, reason: 'missing_window' };
  try {
    const state = await getKakaoWindowState({ win, cuaDriverCommand, timeoutMs, spawnImpl, maxElements });
    if (isVillageStaffChromeWindowState(state)) {
      return { ok: false, reason: 'staff_chrome_profile_rejected', win, state };
    }
    return {
      ok: true,
      win,
      state,
      automationProfileVerified: isVillageAutomationChromeWindowState(state)
    };
  } catch (error) {
    return { ok: false, reason: 'window_state_unavailable', error: error.message.slice(0, 500), win };
  }
}

async function pickVerifiedKakaoAutomationCuaWindow(candidates = [], options = {}) {
  let fallback = null;
  const rejected = [];
  for (const win of candidates) {
    const verified = await verifyKakaoAutomationCuaWindow(win, options);
    if (!verified.ok) {
      rejected.push({ window_id: win?.window_id, pid: win?.pid, title: win?.title || '', reason: verified.reason });
      continue;
    }
    if (verified.automationProfileVerified) return { ...verified, rejected };
    if (!fallback) fallback = verified;
  }
  return fallback ? { ...fallback, rejected } : { ok: false, reason: 'no_non_staff_kakao_window', rejected };
}

function pickMacOpenPanelWindow(windows = [], chromePid) {
  return windows.find((w) => w?.pid === chromePid && /^(열기|Open)$/.test(text(w.title).trim()))
    || windows.find((w) => /^(열기|Open)$/.test(text(w.title).trim()))
    || windows.find((w) => /Open and Save Panel/i.test(text(w.app_name || w.app)));
}

async function openKakaoFileChooserViaCua({ win, cuaDriverCommand, timeoutMs, spawnImpl }) {
  const bounds = win.bounds || {};
  const x = Math.max(18, Math.min(34, Number(bounds.width || 380) - 24));
  const y = Math.max(20, Number(bounds.height || 816) - 29);
  await spawnText(cuaDriverCommand, [
    'call', 'click', JSON.stringify({ pid: win.pid, window_id: win.window_id, x, y }), '--compact'
  ], { timeoutMs, spawnImpl });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 350 : 500));
    const windows = await listCuaWindows({ cuaDriverCommand, timeoutMs, spawnImpl });
    const panel = pickMacOpenPanelWindow(windows, win.pid);
    if (panel?.pid && panel?.window_id) return { panel, clickPoint: { x, y } };
  }
  return { panel: null, clickPoint: { x, y }, reason: 'open_panel_not_found' };
}

async function chooseFileInMacOpenPanelViaCua({ panel, filePath, cuaDriverCommand, timeoutMs, spawnImpl }) {
  await spawnText(cuaDriverCommand, [
    'call', 'hotkey', JSON.stringify({ pid: panel.pid, window_id: panel.window_id, keys: ['cmd', 'shift', 'g'] }), '--compact'
  ], { timeoutMs, spawnImpl });
  await new Promise((resolve) => setTimeout(resolve, 300));
  await spawnText(cuaDriverCommand, [
    'call', 'type_text', JSON.stringify({ pid: panel.pid, window_id: panel.window_id, text: filePath, delay_ms: 0 }), '--compact'
  ], { timeoutMs, spawnImpl });
  await spawnText(cuaDriverCommand, [
    'call', 'press_key', JSON.stringify({ pid: panel.pid, window_id: panel.window_id, key: 'return' }), '--compact'
  ], { timeoutMs, spawnImpl });
  await new Promise((resolve) => setTimeout(resolve, 500));
  await spawnText(cuaDriverCommand, [
    'call', 'press_key', JSON.stringify({ pid: panel.pid, window_id: panel.window_id, key: 'return' }), '--compact'
  ], { timeoutMs, spawnImpl });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  return { selected: true, filePath };
}

async function attachSingleKakaoFileViaCua({ win, filePath, cuaDriverCommand, timeoutMs, spawnImpl }) {
  const chooser = await openKakaoFileChooserViaCua({ win, cuaDriverCommand, timeoutMs, spawnImpl });
  if (!chooser.panel) return { attached: false, reason: chooser.reason || 'open_panel_not_found', filePath, clickPoint: chooser.clickPoint };
  await chooseFileInMacOpenPanelViaCua({ panel: chooser.panel, filePath, cuaDriverCommand, timeoutMs, spawnImpl });
  await activateGoogleChromeForCua({ timeoutMs: Math.min(timeoutMs, 5000), spawnImpl, windowTitle: win.title || '' });
  const readyState = await getKakaoWindowState({ win, cuaDriverCommand, timeoutMs, spawnImpl, maxElements: 900 });
  const sendButtonIndex = findKakaoSendButtonElementIndex(readyState.tree_markdown || '');
  let clickResult = null;
  if (sendButtonIndex) {
    clickResult = await clickKakaoSendButton({ win, sendButtonIndex, cuaDriverCommand, timeoutMs, spawnImpl });
  } else {
    await spawnText(cuaDriverCommand, [
      'call', 'press_key', JSON.stringify({ pid: win.pid, window_id: win.window_id, key: 'return' }), '--compact'
    ], { timeoutMs, spawnImpl });
  }
  await new Promise((resolve) => setTimeout(resolve, 1600));
  return {
    attached: Boolean(sendButtonIndex ? clickResult?.clicked !== false : true),
    reason: sendButtonIndex ? 'file_selected_and_send_clicked_via_cua' : 'file_selected_return_pressed_via_cua',
    filePath,
    panel: { pid: chooser.panel.pid, window_id: chooser.panel.window_id, title: chooser.panel.title || '' },
    sendButtonIndex: sendButtonIndex || null,
    clickPoint: chooser.clickPoint
  };
}

async function attachKakaoFilesViaCua(win, attachmentPaths = [], { cuaDriverCommand, timeoutMs, spawnImpl }) {
  const files = normalizeKakaoAttachmentPaths(attachmentPaths);
  if (!files.length) return { attached: false, reason: 'no_attachment_paths', files: [] };
  const missing = files.filter((filePath) => !fs.existsSync(filePath));
  if (missing.length) return { attached: false, reason: 'attachment_file_missing', files, missing };
  if (!win?.pid || !win?.window_id) return { attached: false, reason: 'conversation_window_missing', files };
  const results = [];
  for (const filePath of files) {
    const result = await attachSingleKakaoFileViaCua({ win, filePath, cuaDriverCommand, timeoutMs, spawnImpl });
    results.push(result);
    if (!result.attached) break;
  }
  const attached = results.length === files.length && results.every((result) => result.attached);
  return {
    attached,
    reason: attached ? 'files_selected_and_send_clicked_via_cua' : (results.find((result) => !result.attached)?.reason || 'attachment_send_not_verified'),
    files,
    fileCount: files.length,
    results
  };
}

export async function sendKakaoMessageViaChrome(textToSend, navigationContext = {}, {
  timeoutMs = 20000,
  spawnImpl = spawn,
  cuaDriverCommand = 'cua-driver',
  evaluateImpl = devtoolsEvaluateOnTarget,
  cdpCallImpl = devtoolsCdpCallOnTarget,
  attachmentPaths = [],
  requireAutomationChromeProfile = process.env.KAKAO_REQUIRE_AUTOMATION_CHROME_PROFILE === '1',
  controlMode = process.env.KAKAO_WORKER_CONTROL_MODE,
  cuaMinIdleSeconds = numberFromEnv(process.env.KAKAO_CUA_MIN_IDLE_SECONDS, 0),
  execFileImpl = execFile
} = {}) {
  const files = normalizeKakaoAttachmentPaths(attachmentPaths);
  if (navigationContext?.conversation_target?.webSocketDebuggerUrl) {
    return sendKakaoMessageViaDevtools(textToSend, navigationContext, { timeoutMs, evaluateImpl, cdpCallImpl, attachmentPaths: files });
  }
  const win = navigationContext?.conversation_window;
  if (!win?.pid || !win?.window_id) {
    return { sent: false, reason: 'conversation_window_missing' };
  }
  if (!cuaDriverCommand) return { sent: false, reason: 'cua_driver_unavailable' };
  const cuaPermission = await checkKakaoCuaFallbackAllowed({
    mode: controlMode,
    minIdleSeconds: cuaMinIdleSeconds,
    timeoutMs: Math.min(timeoutMs, 1200),
    execFileImpl
  });
  if (!cuaPermission.allowed) {
    return { sent: false, reason: 'cua_send_skipped_to_avoid_human_focus_conflict', cuaPermission };
  }
  await activateGoogleChromeForCua({ timeoutMs: Math.min(timeoutMs, 5000), spawnImpl, windowTitle: win.title || '' });
  const state = await getKakaoWindowState({ win, cuaDriverCommand, timeoutMs, spawnImpl, maxElements: 700 });
  if (requireAutomationChromeProfile && !String(state.tree_markdown || '').includes('🤖 자동화 크롬')) {
    return { sent: false, reason: 'automation_chrome_profile_required', window_title: win.title || state.title || '', required_profile: '🤖 자동화 크롬' };
  }
  const elementIndex = findKakaoMessageInputElementIndex(state.tree_markdown || '');
  if (!elementIndex) return { sent: false, reason: 'message_input_not_found', window_title: win.title || state.title || '' };
  await spawnText(cuaDriverCommand, [
    'call', 'type_text', JSON.stringify({ pid: win.pid, window_id: win.window_id, element_index: elementIndex, text: textToSend, delay_ms: 5 }), '--compact'
  ], { timeoutMs, spawnImpl });
  await activateGoogleChromeForCua({ timeoutMs: Math.min(timeoutMs, 5000), spawnImpl, windowTitle: win.title || state.title || '' });
  const readyState = await getKakaoWindowState({ win, cuaDriverCommand, timeoutMs, spawnImpl, maxElements: 900 });
  const sendButtonIndex = findKakaoSendButtonElementIndex(readyState.tree_markdown || '');
  let clickResult = null;
  if (sendButtonIndex) {
    clickResult = await clickKakaoSendButton({ win, sendButtonIndex, cuaDriverCommand, timeoutMs, spawnImpl });
  }
  if (!sendButtonIndex || clickResult?.disabledAfterRetry) {
    await spawnText(cuaDriverCommand, [
      'call', 'press_key', JSON.stringify({ pid: win.pid, window_id: win.window_id, element_index: elementIndex, key: 'return' }), '--compact'
    ], { timeoutMs, spawnImpl });
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
  await activateGoogleChromeForCua({ timeoutMs: Math.min(timeoutMs, 5000), spawnImpl, windowTitle: win.title || readyState.title || state.title || '' });
  const verifyState = await getKakaoWindowState({ win, cuaDriverCommand, timeoutMs, spawnImpl, maxElements: 900 });
  if (!kakaoConversationContainsMessage(verifyState.tree_markdown || '', textToSend)) {
    return {
      sent: false,
      reason: 'send_not_verified_in_conversation',
      window_title: win.title || verifyState.title || state.title || '',
      element_index: elementIndex,
      send_button_index: clickResult?.sendButtonIndex || sendButtonIndex || null,
      retried_after_frontmost_activation: Boolean(clickResult?.retriedAfterFrontmostActivation)
    };
  }
  let attachmentResult = null;
  if (files.length) {
    attachmentResult = await attachKakaoFilesViaCua(win, files, { cuaDriverCommand, timeoutMs, spawnImpl });
    if (!attachmentResult.attached) {
      return {
        sent: false,
        reason: attachmentResult.reason || 'attachment_send_not_verified',
        window_title: win.title || verifyState.title || state.title || '',
        element_index: elementIndex,
        send_button_index: clickResult?.sendButtonIndex || sendButtonIndex || null,
        retried_after_frontmost_activation: Boolean(clickResult?.retriedAfterFrontmostActivation),
        attachments: attachmentResult
      };
    }
  }
  return {
    sent: true,
    reason: files.length ? 'sent_via_chrome_verified_with_cua_attachments' : 'sent_via_chrome_verified',
    window_title: win.title || verifyState.title || state.title || '',
    element_index: elementIndex,
    send_button_index: clickResult?.sendButtonIndex || sendButtonIndex || null,
    retried_after_frontmost_activation: Boolean(clickResult?.retriedAfterFrontmostActivation),
    ...(files.length ? { attachments: attachmentResult } : {})
  };
}

function logAutoReply(config, entry) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  fs.mkdirSync(path.dirname(config.autoSendLogPath), { recursive: true });
  fs.appendFileSync(config.autoSendLogPath, `${line}\n`);
}

function normalizeAutoReplyText(value = '') {
  return text(value).replace(/\s+/g, ' ').trim();
}

export function buildAutoReplyDedupeKey({ decision = {}, job = {}, replyText = '' } = {}) {
  const stableRoomKey = normalizeAutoReplyText(job.room_key || job.roomKey || job.payload?.roomKey || '');
  const customer = normalizeAutoReplyText(decision?.customer?.name || decision?.customer_name || '');
  const customerEvidence = Array.isArray(decision?.visible_messages_used)
    ? [...decision.visible_messages_used].reverse().find((item) => String(item?.sender || '').includes(customer) || !String(item?.sender || '').includes('빌리지'))
    : null;
  const customerMessage = normalizeAutoReplyText(customerEvidence?.message || job.preview_text || job.previewText || job.payload?.previewText || '');
  const reply = normalizeAutoReplyText(replyText || decision?.reply_decision?.text || decision?.suggested_reply_draft || '');
  return [stableRoomKey || customer, customerMessage, reply].filter(Boolean).join('|').slice(0, 500);
}

export function hasRecentSentAutoReply(config, dedupeKey, { now = new Date(), windowMs = 30 * 60 * 1000 } = {}) {
  if (!dedupeKey || !config?.autoSendLogPath || !fs.existsSync(config.autoSendLogPath)) return false;
  const lines = fs.readFileSync(config.autoSendLogPath, 'utf8').trim().split('\n').filter(Boolean).slice(-300);
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.result?.sent !== true) continue;
    if (entry?.dedupeKey !== dedupeKey) continue;
    const sentAt = new Date(entry.at);
    if (Number.isFinite(sentAt.getTime()) && now.getTime() - sentAt.getTime() <= windowMs) return true;
  }
  return false;
}

function parseKakaoPreviewClockMinutes(value = '') {
  const matches = Array.from(String(value || '').matchAll(/(오전|오후)\s*(\d{1,2}):(\d{2})/g));
  const match = matches[matches.length - 1];
  if (!match) return null;
  let hour = Number(match[2]);
  const minute = Number(match[3]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (match[1] === '오전') {
    if (hour === 12) hour = 0;
  } else if (hour !== 12) {
    hour += 12;
  }
  return (hour * 60) + minute;
}

function kstClockParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul',
    hourCycle: 'h23',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).formatToParts(now);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
  return {
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute')
  };
}

function kstClockMinutes(now = new Date()) {
  const parts = kstClockParts(now);
  return (parts.hour * 60) + parts.minute;
}

function minutesSinceKakaoPreviewClock(value = '', now = new Date()) {
  const previewMinutes = parseKakaoPreviewClockMinutes(value);
  if (previewMinutes === null) return null;
  let diff = kstClockMinutes(now) - previewMinutes;
  if (diff < -1) diff += 1440;
  return diff;
}

function parseKakaoKoreanMonthDayLabels(value = '') {
  const matches = [...text(value).matchAll(/(\d{1,2})월\s*(\d{1,2})일/g)];
  return matches.map((match) => ({
    month: Number(match[1]),
    day: Number(match[2]),
    index: match.index ?? -1,
    text: match[0]
  })).filter((label) => Number.isFinite(label.month) && Number.isFinite(label.day));
}

function hasNonCurrentKakaoDateLabel(value = '', now = new Date()) {
  const labels = parseKakaoKoreanMonthDayLabels(value);
  if (!labels.length) return false;
  const current = kstClockParts(now);
  return labels.some((label) => label.month !== current.month || label.day !== current.day);
}

function dayOfYearForMonthDay(month, day, year) {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (!Number.isFinite(date.getTime())) return null;
  return Math.floor((date.getTime() - Date.UTC(year, 0, 1)) / 86400000) + 1;
}

function hasStaleKakaoDateLabel(value = '', now = new Date()) {
  const labels = parseKakaoKoreanMonthDayLabels(value);
  if (!labels.length) return false;
  const current = kstClockParts(now);
  const year = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', year: 'numeric' }).format(now));
  const currentOrdinal = dayOfYearForMonthDay(current.month, current.day, year);
  if (!currentOrdinal) return hasNonCurrentKakaoDateLabel(value, now);
  return labels.some((label) => {
    const labelOrdinal = dayOfYearForMonthDay(label.month, label.day, year);
    if (!labelOrdinal) return false;
    const diffDays = labelOrdinal - currentOrdinal;
    // Past Kakao list date labels are stale. Far-future labels around Jan/Dec are
    // normally previous-year history, not future rental dates.
    return diffDays < 0 || diffDays > 180;
  });
}

function parseIsoDate(value) {
  const raw = text(value).trim();
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isFinite(date.getTime()) ? date : null;
}

function freshestJobEventDate(job = {}, events = []) {
  const candidates = [
    job.lastEventAt,
    job.detectedAt,
    job.detected_at,
    job.receivedAt,
    job.firstEventAt,
    job.payload?.lastEventAt,
    job.payload?.detectedAt,
    job.payload?.receivedAt,
    job.payload?.firstEventAt,
    ...events.flatMap((event) => [event?.lastEventAt, event?.detectedAt, event?.receivedAt, event?.firstEventAt, event?.raw?.detectedAt, event?.raw?.receivedAt])
  ].map(parseIsoDate).filter(Boolean);
  if (!candidates.length) return null;
  return candidates.sort((a, b) => b.getTime() - a.getTime())[0];
}

export function isAutoSendEligibleLiveJob(job = {}, { now = new Date(), liveWindowMinutes = 20, eventFreshnessMinutes = 60 } = {}) {
  const preview = text(job.preview_text || job.previewText || job.payload?.previewText || '');
  const events = Array.isArray(job.events) ? job.events : (Array.isArray(job.payload?.events) ? job.payload.events : []);
  const reasons = events.map((event) => String(event?.reason || '')).filter(Boolean);
  const unreadCounts = [
    Number(job.unread_count ?? job.unreadCount ?? job.payload?.unreadCount ?? 0),
    ...events.map((event) => Number(event?.unread_count ?? event?.unreadCount ?? event?.raw?.unreadCount ?? event?.raw?.unread_count ?? 0))
  ];
  const hasUnread = unreadCounts.some((count) => Number.isFinite(count) && count > 0);
  const hasTopRowChanged = reasons.includes('top_row_changed');
  const hasUnreadBackstop = reasons.includes('top_rows_backstop') && hasUnread;
  if (!hasTopRowChanged && !hasUnreadBackstop) return { eligible: false, reason: 'not_top_row_live_event' };
  const eventDate = freshestJobEventDate(job, events);
  const eventAgeMinutes = eventDate ? ((now.getTime() - eventDate.getTime()) / 60000) : null;
  const referenceNow = eventDate && eventAgeMinutes >= -1 && eventAgeMinutes <= eventFreshnessMinutes ? eventDate : now;
  const ageMinutes = minutesSinceKakaoPreviewClock(preview, referenceNow);
  if (ageMinutes !== null) {
    if (ageMinutes < -1 || ageMinutes > liveWindowMinutes) return { eligible: false, reason: 'top_row_time_outside_live_window' };
    if (hasStaleKakaoDateLabel(preview, referenceNow)) return { eligible: false, reason: 'preview_has_old_date' };
    return { eligible: true, reason: hasUnread ? 'top_row_unread' : 'top_row_live_time_format' };
  }
  if (/\d{4}\.\d{1,2}\.\d{1,2}/.test(preview)) return { eligible: false, reason: 'preview_has_absolute_date' };
  if (hasNonCurrentKakaoDateLabel(preview, referenceNow)) return { eligible: false, reason: 'preview_has_old_date' };
  if (hasUnread) return { eligible: true, reason: 'top_row_unread' };
  if (parseKakaoKoreanMonthDayLabels(preview).length) return { eligible: true, reason: 'top_row_current_date_label' };
  return { eligible: false, reason: 'preview_not_live_time_format' };
}

async function maybeAutoSendReply({ config, decision, job, navigationContext }) {
  const liveGate = isAutoSendEligibleLiveJob(job);
  if (!liveGate.eligible) {
    const result = { attempted: false, sent: false, gate: { allowed: false, reason: liveGate.reason } };
    logAutoReply(config, { jobId: job.id || job.jobId || null, result, customer: decision?.customer?.name || '', classification: decision?.classification || '', preview: job.preview_text || job.previewText || '' });
    return result;
  }
  const documentGate = canAutoSendCustomerDocumentAssets(decision, config);
  const gate = documentGate.allowed ? documentGate : canAutoSendCustomerAnswer(decision, config);
  if (!gate.allowed) {
    const result = { attempted: false, sent: false, gate };
    logAutoReply(config, { jobId: job.id || job.jobId || null, result, customer: decision?.customer?.name || '', classification: decision?.classification || '' });
    return result;
  }
  const dedupeKey = buildAutoReplyDedupeKey({ decision, job, replyText: gate.text });
  if (hasRecentSentAutoReply(config, dedupeKey)) {
    const result = { attempted: false, sent: false, gate: { allowed: false, reason: 'duplicate_recent_auto_reply' } };
    logAutoReply(config, { jobId: job.id || job.jobId || null, result, customer: decision?.customer?.name || '', classification: decision?.classification || '', dedupeKey });
    return result;
  }
  const ragSupport = await evaluateAutoReplyRagSupport({ config, decision, job, replyText: gate.text });
  if (ragSupport.required && !ragSupport.allowed) {
    const result = {
      attempted: false,
      sent: false,
      gate: { allowed: false, reason: ragSupport.reason },
      ragSupport
    };
    logAutoReply(config, {
      jobId: job.id || job.jobId || null,
      result,
      customer: decision?.customer?.name || '',
      classification: decision?.classification || '',
      evidence: decision?.visible_messages_used || [],
      dedupeKey,
      ragSupport
    });
    return result;
  }
  let sendResult;
  try {
    sendResult = await sendKakaoMessageViaChrome(gate.text, navigationContext, {
      timeoutMs: config.autoSendTimeoutMs,
      cuaDriverCommand: config.cuaDriverCommand,
      attachmentPaths: gate.attachmentPaths || [],
      requireAutomationChromeProfile: config.requireAutomationChromeProfile,
      controlMode: config.workerControlMode,
      cuaMinIdleSeconds: config.cuaMinIdleSeconds
    });
  } catch (error) {
    sendResult = { sent: false, reason: 'send_error', error: error.message.slice(0, 500) };
  }
  const result = { attempted: true, sent: Boolean(sendResult.sent), gate, sendResult, text: gate.text, ragSupport };
  logAutoReply(config, { jobId: job.id || job.jobId || null, result, customer: decision?.customer?.name || '', classification: decision?.classification || '', evidence: decision?.visible_messages_used || [], dedupeKey, ragSupport });
  return result;
}

export async function openKakaoTargetChatFromList(job, {
  timeoutMs = 20000,
  spawnImpl = spawn,
  cuaDriverCommand = 'cua-driver',
  cdpBaseUrl = kakaoDevtoolsBaseUrlFromEnv(),
  fetchImpl = fetch,
  evaluateImpl = devtoolsEvaluateOnTarget,
  controlMode = process.env.KAKAO_WORKER_CONTROL_MODE,
  cuaMinIdleSeconds = numberFromEnv(process.env.KAKAO_CUA_MIN_IDLE_SECONDS, 0),
  execFileImpl = execFile,
  allowSearch = process.env.KAKAO_WORKER_SEARCH_TARGET_CHAT !== '0',
  preferDevtools = normalizeKakaoWorkerControlMode(controlMode) !== 'cua_first'
} = {}) {
  const hints = extractNavigationHints(job);
  if (!hints.length) return { status: 'no_navigation_hints' };
  let devtoolsFirst = null;
  if (preferDevtools) {
    devtoolsFirst = await openKakaoTargetChatViaDevtools(job, { timeoutMs, cdpBaseUrl, fetchImpl, evaluateImpl, allowSearch }).catch((error) => ({
      status: 'devtools_first_failed',
      error: error.message.slice(0, 500)
    }));
    if (devtoolsFirst?.status === 'opened_target_chat') return devtoolsFirst;
    if (!cuaDriverCommand) return { status: 'cua_driver_unavailable', hints, devtoolsFirst };
  }
  if (!cuaDriverCommand) return { status: 'cua_driver_unavailable', hints };
  const cuaPermission = await checkKakaoCuaFallbackAllowed({
    mode: controlMode,
    minIdleSeconds: cuaMinIdleSeconds,
    timeoutMs: Math.min(timeoutMs, 1200),
    execFileImpl
  });
  if (!cuaPermission.allowed) {
    return { status: 'cua_fallback_skipped_to_avoid_human_focus_conflict', hints, devtoolsFirst, cuaPermission };
  }
  const windowsText = await spawnText(cuaDriverCommand, ['call', 'list_windows', '--compact'], { timeoutMs, spawnImpl });
  const windows = JSON.parse(windowsText).windows || [];
  const existingConversationCandidates = rankKakaoConversationWindows(windows, hints);
  const visibleExistingConversationCandidates = existingConversationCandidates.filter((w) => w.is_on_screen !== false);
  const offscreenExistingConversationWindow = existingConversationCandidates.find((w) => w.is_on_screen === false) || null;
  const verifiedConversation = await pickVerifiedKakaoAutomationCuaWindow(visibleExistingConversationCandidates, {
    cuaDriverCommand,
    timeoutMs,
    spawnImpl,
    maxElements: 700
  });
  const existingConversationWindow = verifiedConversation.ok ? verifiedConversation.win : null;
  if (existingConversationWindow) {
    const conversationEvidence = extractKakaoConversationEvidence(verifiedConversation.state?.tree_markdown || '', {
      title: existingConversationWindow.title || verifiedConversation.state?.title || verifiedConversation.state?.window_title || '',
      hints,
      maxItems: 80
    });
    return {
      status: 'opened_target_chat',
      already_open: true,
      hints,
      pid: existingConversationWindow.pid,
      window_id: existingConversationWindow.window_id,
      conversation_window: { pid: existingConversationWindow.pid, window_id: existingConversationWindow.window_id, title: existingConversationWindow.title || '' },
      element_index: null,
      conversation_evidence: conversationEvidence
    };
  }
  if (offscreenExistingConversationWindow) {
    const devtoolsExisting = await openKakaoTargetChatViaDevtools(job, { timeoutMs, cdpBaseUrl, fetchImpl, evaluateImpl, allowSearch }).catch(() => null);
    if (devtoolsExisting?.status === 'opened_target_chat') return devtoolsExisting;
  }
  const verifiedMain = await pickVerifiedKakaoAutomationCuaWindow(rankKakaoMainListWindows(windows), {
    cuaDriverCommand,
    timeoutMs,
    spawnImpl,
    maxElements: 700
  });
  const win = verifiedMain.ok ? verifiedMain.win : null;
  if (!win) {
    return openKakaoTargetChatViaDevtools(job, { timeoutMs, cdpBaseUrl, fetchImpl, evaluateImpl, allowSearch }).catch((error) => ({
      status: 'main_list_window_not_found',
      hints,
      rejected_cua_windows: verifiedMain.rejected || [],
      devtoolsFallbackError: error.message.slice(0, 500)
    }));
  }
  const state = verifiedMain.state;
  let elementIndex = findChatRowElementIndex(state.tree_markdown || '', hints);
  let searchResult = null;
  if (!elementIndex && allowSearch) {
    searchResult = await findChatRowElementIndexViaSearch({
      win,
      hints,
      initialTreeMarkdown: state.tree_markdown || '',
      cuaDriverCommand,
      timeoutMs,
      spawnImpl
    });
    elementIndex = searchResult.elementIndex;
  } else if (!elementIndex) {
    searchResult = { searched: false, disabled: true, reason: 'search_disabled' };
  }
  if (!elementIndex) {
    const devtoolsFallback = await openKakaoTargetChatViaDevtools(job, { timeoutMs, cdpBaseUrl, fetchImpl, evaluateImpl, allowSearch }).catch((error) => ({
      status: 'devtools_fallback_failed',
      error: error.message.slice(0, 500)
    }));
    if (devtoolsFallback?.status === 'opened_target_chat') return devtoolsFallback;
    return {
      status: 'chat_row_not_found',
      hints,
      window_id: win.window_id,
      pid: win.pid,
      search: searchResult
        ? {
            searched: Boolean(searchResult.searched),
            disabled: Boolean(searchResult.disabled),
            search_input_found: Boolean(searchResult.searchInputIndex),
            reason: searchResult.reason || undefined,
            tried: searchResult.tried || [],
            search_terms: searchResult.searchTerms || []
          }
        : null,
      devtoolsFallback
    };
  }
  await spawnText(cuaDriverCommand, [
    'call', 'click', JSON.stringify({ pid: win.pid, window_id: win.window_id, element_index: elementIndex }), '--compact'
  ], { timeoutMs, spawnImpl });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  let conversationEvidence = null;
  let conversationWindow = null;
  try {
    const windowsAfterClickText = await spawnText(cuaDriverCommand, ['call', 'list_windows', '--compact'], { timeoutMs, spawnImpl });
    const windowsAfterClick = JSON.parse(windowsAfterClickText).windows || [];
    const verifiedAfterClick = await pickVerifiedKakaoAutomationCuaWindow(rankKakaoConversationWindows(windowsAfterClick, hints), {
      cuaDriverCommand,
      timeoutMs,
      spawnImpl,
      maxElements: 900
    });
    conversationWindow = verifiedAfterClick.ok ? verifiedAfterClick.win : null;
    if (!conversationWindow) {
      return {
        status: 'conversation_window_not_found_after_click',
        hints,
        pid: win.pid,
        window_id: win.window_id,
        conversation_window: null,
        element_index: elementIndex,
        rejected_cua_windows: verifiedAfterClick.rejected || [],
        conversation_evidence: {
          source: 'live_kakao_ax_after_navigation',
          hint_matched: false,
          evidence_status: 'insufficient',
          note: 'Clicked the matching chat row, but no individual Kakao customer conversation popup was found. AI must not classify this job as verified from the conversation screen.'
        }
      };
    }
    conversationEvidence = extractKakaoConversationEvidence(verifiedAfterClick.state?.tree_markdown || '', {
      title: conversationWindow.title || verifiedAfterClick.state?.title || verifiedAfterClick.state?.window_title || '',
      hints,
      maxItems: 80
    });
  } catch (error) {
    conversationEvidence = { source: 'live_kakao_ax_after_navigation', error: error.message.slice(0, 300) };
  }
  return {
    status: 'opened_target_chat',
    hints,
    pid: win.pid,
    window_id: win.window_id,
    conversation_window: conversationWindow ? { pid: conversationWindow.pid, window_id: conversationWindow.window_id, title: conversationWindow.title || '' } : null,
    element_index: elementIndex,
    search: searchResult
      ? {
          searched: Boolean(searchResult.searched),
          disabled: Boolean(searchResult.disabled),
          search_input_found: Boolean(searchResult.searchInputIndex),
          search_term: searchResult.searchTerm || null,
          reason: searchResult.reason || undefined,
          tried: searchResult.tried || [],
          search_terms: searchResult.searchTerms || []
        }
      : null,
    conversation_evidence: conversationEvidence
  };
}

function terminateChildTree(child, signal = 'SIGTERM') {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch {}
  }
}

export function runHermes(prompt, config, options = {}) {
  const spawnImpl = options.spawnImpl || spawn;
  const killTree = options.killTree || ((pid) => terminateChildTree({ pid }, 'SIGTERM'));
  const baseEnv = options.baseEnv || process.env;
  const timeoutMs = Number(config.hermesTimeoutMs || 180000);
  return new Promise((resolve, reject) => {
    const child = spawnImpl(config.hermesCommand, buildHermesArgs(prompt, config), {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: path.resolve(__dirname, '../..'),
      detached: true,
      env: {
        ...baseEnv,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8'
      }
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      const message = `Hermes subprocess timed out after ${timeoutMs}ms`;
      finish(reject, new Error(message));
      try { killTree(child.pid); } catch {}
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code, signal) => {
      if (code === 0) finish(resolve, stdout);
      else if (!settled) finish(reject, new Error(`Hermes exited ${code ?? signal}: ${stderr || stdout}`));
    });
  });
}

export function buildHermesFinalJsonRecoveryPrompt(originalPrompt, context = {}) {
  const validationErrors = Array.isArray(context.validationErrors) ? context.validationErrors : [];
  const priorDecision = context.priorDecision && typeof context.priorDecision === 'object'
    ? JSON.stringify(context.priorDecision, null, 2)
    : '';
  const contractContext = validationErrors.length
    ? `\nPRIOR DECISION CONTRACT VALIDATION ERRORS:\n${validationErrors.map((error) => `- ${error}`).join('\n')}\n\nPRIOR DECISION:\n${priorDecision}\n\nRepair the semantic decision yourself from the original evidence. Do not let outer code infer, default, merge, or rewrite business meaning.\n`
    : '';
  return `RECOVERY PASS: the prior attempt did not produce valid FINAL_JSON.

- Do the full reasoning required by the original task; do not guess or use a reduced mechanical shortcut.
- Reuse already available evidence and make any additional read-only checks needed for a grounded decision.
- Return FINAL_JSON even when a tool or API failed. Encode the gap in confidence, reason, and follow-up fields.
- Do not substitute an apology, progress report, or plain-text explanation for the required JSON object.
- Do not write to Sheets or send Kakao from this Hermes pass; the outer worker owns approved mutations.
${contractContext}

ORIGINAL FULL TASK:
${String(originalPrompt || '')}

END ORIGINAL FULL TASK.
RECOVERY OUTPUT OVERRIDE: Regardless of any earlier wording or failure, finish with FINAL_JSON and one valid JSON object only.`;
}

function hermesDecisionFailureKind(error, output = '') {
  const message = String(error?.message || '');
  if (/timed out|timeout/i.test(message)) return 'timeout';
  if (/exited|spawn|ENOENT/i.test(message)) return 'process_error';
  if (String(output || '').includes('OpenAI-compatible API call')) return 'api_error_output';
  return 'invalid_output';
}

export async function runHermesDecision(prompt, config, options = {}) {
  const runHermesImpl = options.runHermesImpl || runHermes;
  const validateDecisionImpl = options.validateDecisionImpl || validateAiDecisionContract;
  const configuredTimeout = Number(config.hermesTimeoutMs || 240000);
  const totalTimeout = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : 240000;
  const usableTimeout = Math.max(60000, totalTimeout - 30000);
  const recoveryTimeout = Math.min(120000, Math.max(45000, Math.floor(usableTimeout * 0.28)));
  const firstTimeout = Math.max(30000, usableTimeout - recoveryTimeout);

  let firstOutput = '';
  let firstError = null;
  let firstDecision = null;
  let firstValidationErrors = [];
  try {
    firstOutput = await runHermesImpl(prompt, { ...config, hermesTimeoutMs: firstTimeout });
    firstDecision = extractJsonObject(firstOutput);
    const validation = validateDecisionImpl(firstDecision);
    if (!validation?.valid) {
      firstValidationErrors = Array.isArray(validation?.errors) ? validation.errors : ['decision contract validation failed'];
      const error = new Error(`Hermes decision contract validation failed: ${firstValidationErrors.join('; ')}`);
      error.validationErrors = firstValidationErrors;
      throw error;
    }
    return { decision: firstDecision, hermesOutput: firstOutput, attempts: 1, recovered: false };
  } catch (error) {
    firstError = error;
  }

  const recoveryPrompt = buildHermesFinalJsonRecoveryPrompt(prompt, {
    validationErrors: firstValidationErrors,
    priorDecision: firstDecision
  });
  let recoveryOutput = '';
  try {
    recoveryOutput = await runHermesImpl(recoveryPrompt, { ...config, hermesTimeoutMs: recoveryTimeout });
    const decision = extractJsonObject(recoveryOutput);
    const validation = validateDecisionImpl(decision);
    if (!validation?.valid) {
      throw new Error(`Hermes decision contract validation failed: ${(validation?.errors || []).join('; ')}`);
    }
    return { decision, hermesOutput: recoveryOutput, attempts: 2, recovered: true };
  } catch (recoveryError) {
    const firstKind = hermesDecisionFailureKind(firstError, firstOutput);
    const recoveryKind = hermesDecisionFailureKind(recoveryError, recoveryOutput);
    throw new Error(`Hermes decision failed after 2 attempts (${firstKind}; ${recoveryKind})`);
  }
}

async function runAiAndMaybeWrite({ config, job, dryRun, fakeDecisionPath }) {
  let navigationContext = null;
  let kakaoTabEnsureResult = null;
  const result = {};
  try {
    if (!dryRun && config.ensureKakaoTab) {
      try {
        kakaoTabEnsureResult = await ensureKakaoChannelManagerTab({ url: config.kakaoChannelManagerUrl });
      } catch (error) {
        // A transient AppleScript/Chrome tab-index failure must not discard the job:
        // CUA navigation below can use a currently open Channel Manager list or an
        // already-open customer room without focusing or creating a tab.
        kakaoTabEnsureResult = {
          status: 'tab_ensure_failed_nonfatal',
          error: error.message.slice(0, 500)
        };
        console.warn(`[ai-worker] Kakao tab ensure failed; continuing with deterministic navigation: ${kakaoTabEnsureResult.error}`);
      }
      if (config.openTargetChat) {
        navigationContext = await openKakaoTargetChatFromList(job, {
          cuaDriverCommand: config.cuaDriverCommand,
          controlMode: config.workerControlMode,
          cuaMinIdleSeconds: config.cuaMinIdleSeconds,
          allowSearch: config.searchTargetChat
        }).catch((error) => ({
          status: 'navigation_failed',
          reason: error.message.slice(0, 500)
        }));
        if (kakaoTabEnsureResult?.status === 'tab_ensure_failed_nonfatal') {
          navigationContext = { ...navigationContext, tab_ensure: kakaoTabEnsureResult };
        }
      }
    }
    const lookupContext = await buildReadOnlyLookupContext(config, job);
    const ragContext = buildReadOnlyRagContext(config);
    const prompt = buildHermesPrompt(job, { gasApiUrl: config.gasApiUrl, lookupContext, navigationContext, ragContext });
    if (dryRun) {
      Object.assign(result, { status: 'dry_run', job: summarizeJob(job), lookupContext, ragContext, prompt });
      return result;
    }

    let decision;
    let hermesOutput = '';
    let hermesAttempts = 0;
    let hermesRecovered = false;
    if (fakeDecisionPath) {
      decision = JSON.parse(fs.readFileSync(fakeDecisionPath, 'utf8'));
    } else {
      const hermesDecision = await runHermesDecision(prompt, config);
      hermesOutput = hermesDecision.hermesOutput;
      decision = hermesDecision.decision;
      hermesAttempts = hermesDecision.attempts;
      hermesRecovered = hermesDecision.recovered;
    }

    let sheetPayload = buildSheetAppendPayload(decision, { apiKey: config.sheetApiKey });
    let customerDbDiscountLookup = null;
    if (sheetPayload) {
      try {
        const enriched = await enrichSheetPayloadWithCustomerDbDiscount(config, sheetPayload);
        sheetPayload = enriched.payload;
        customerDbDiscountLookup = enriched.lookup;
        if (customerDbDiscountLookup?.discountType) {
          decision = {
            ...decision,
            sheet_row_candidate: {
              ...(decision.sheet_row_candidate || {}),
              discount_type: customerDbDiscountLookup.discountType
            }
          };
        }
      } catch (error) {
        customerDbDiscountLookup = { matched: false, error: error.message.slice(0, 500) };
      }
    }
    const sheetResult = await appendToSheet(config, sheetPayload);
    let discountPatchResult = null;
    if (sheetPayload && customerDbDiscountLookup?.discountType) {
      try {
        discountPatchResult = await ensureConfirmRequestDiscountApplied(config, sheetResult, sheetPayload, customerDbDiscountLookup);
      } catch (error) {
        discountPatchResult = { updated: false, error: error.message.slice(0, 500) };
      }
    }
    const initialFollowUpRows = [
      ...buildFollowUpRows(decision, job),
      ...buildSheetFailureFollowUpRows(decision, job, sheetResult, sheetPayload)
    ];
    const existingRequestResult = sheetResult
      ? null
      : await fetchExistingConfirmRequestResultForDecision(config, decision, initialFollowUpRows);
    const authoritativeSheetResult = sheetResult?.success === false
      ? null
      : (sheetResult || existingRequestResult);
    const availabilityReport = buildSheetAvailabilityReport(authoritativeSheetResult, sheetPayload);
    let postActionResult = null;
    let postActionOutputTail = '';
    if (availabilityReport) {
      if (fakeDecisionPath) {
        decision = suppressDecisionForUnreconciledSheetResult(decision, availabilityReport);
        postActionResult = {
          skipped: true,
          reason: 'fake_decision_path_has_no_post_action_ai',
          report: availabilityReport.payload
        };
      } else {
        try {
          const reconciliation = await runHermesPostActionDecision({
            config,
            job,
            initialDecision: decision,
            sheetResult: authoritativeSheetResult,
            sheetPayload
          });
          decision = reconciliation.decision;
          hermesAttempts += Number(reconciliation.attempts || 0);
          hermesRecovered = hermesRecovered || reconciliation.recovered === true;
          postActionOutputTail = text(reconciliation.hermesOutput).slice(-4000);
          postActionResult = {
            skipped: false,
            attempts: reconciliation.attempts,
            recovered: reconciliation.recovered,
            report: availabilityReport.payload
          };
        } catch (error) {
          decision = suppressDecisionForUnreconciledSheetResult(decision, availabilityReport);
          postActionResult = {
            skipped: false,
            error: error.message.slice(0, 1000),
            report: availabilityReport.payload
          };
        }
      }
    }
    const autoReplyResult = sheetResult?.success === false
      ? (sheetResult.error_type === 'no_contact'
          ? await maybeAutoSendReply({ config, decision, job, navigationContext })
          : { attempted: false, sent: false, reason: 'sheet_write_rejected_no_auto_send', sheetErrorType: sheetResult.error_type })
      : await maybeAutoSendReply({ config, decision, job, navigationContext });
    const baseFollowUpRows = [
      ...buildFollowUpRows(decision, job),
      ...buildSheetFailureFollowUpRows(decision, job, sheetResult, sheetPayload)
    ];
    const availabilityAwareRows = enrichFollowUpRowsWithSheetAvailability(
      baseFollowUpRows,
      authoritativeSheetResult,
      sheetPayload,
      decision,
      job
    );
    const followUpRows = filterFollowUpRowsAfterAutoReply(availabilityAwareRows, autoReplyResult);
    let followUpResult;
    if (config.followUpRowsEnabled === false) {
      followUpResult = { inserted: 0, skipped: true, reason: 'kakao_follow_up_rows_disabled', rows: followUpRows };
    } else {
      try {
        followUpResult = await upsertFollowUpRows(config, followUpRows);
      } catch (error) {
        followUpResult = { inserted: 0, error: error.message, rows: followUpRows };
      }
    }
    const slackDeliveryResult = config.followUpRowsEnabled === false
      ? { skipped: true, reason: 'kakao_follow_up_rows_disabled', results: [] }
      : await deliverSlackFollowUpRows(config, followUpResult.rows || []);
    Object.assign(result, { status: 'ai_completed', decision, sheetResult, customerDbDiscountLookup, discountPatchResult, existingRequestResult, postActionResult, followUpResult, slackDeliveryResult, autoReplyResult, hermesAttempts, hermesRecovered, hermesOutputTail: hermesOutput.slice(-4000), postActionOutputTail });
    return result;
	  } finally {
	    if (!dryRun && navigationContext?.conversation_window) {
	      try {
	        result.closeResult = await closeKakaoConversationWindow(navigationContext.conversation_window, { cuaDriverCommand: config.cuaDriverCommand });
	        if (result.closeResult?.status && result.closeResult.status !== 'closed_conversation_window') {
	          console.warn(`[ai-worker] Kakao conversation cleanup: ${result.closeResult.status}`);
	        }
	      } catch (error) {
	        result.closeResult = { status: 'cleanup_failed', error: error.message.slice(0, 500) };
	        console.warn(`[ai-worker] Kakao conversation cleanup failed: ${error.message}`);
	      }
	    } else if (!dryRun && navigationContext?.opened_by_devtools_search && navigationContext?.conversation_target?.id) {
	      try {
	        result.closeResult = await closeKakaoConversationTargetViaDevtools(navigationContext.conversation_target);
	      } catch (error) {
	        result.closeResult = { status: 'devtools_cleanup_failed', error: error.message.slice(0, 500) };
	        console.warn(`[ai-worker] Kakao DevTools conversation cleanup failed: ${error.message}`);
	      }
	    }
	  }
}

function summarizeJob(job) {
  return {
    id: job.id || job.jobId || null,
    preview_text: job.preview_text || job.previewText || '',
    room_key: job.room_key || job.roomKey || ''
  };
}

async function readStdinJson() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const textBody = Buffer.concat(chunks).toString('utf8').trim();
  if (!textBody) throw new Error('No stdin JSON received');
  return JSON.parse(textBody);
}

export async function processRagLookup(stdinPayload, options = {}) {
  loadEnvFile(path.resolve(process.env.HOME || '', '.hermes/.env'));
  loadEnvFile(path.resolve(__dirname, '../kakao-dom-bridge/.env'));
  loadEnvFile(path.resolve(__dirname, '.env'));
  const config = {
    villageAiUrl: process.env.VILLAGE_AI_URL || '',
    villageAiKakaoSkillSecret: process.env.VILLAGE_AI_KAKAO_SKILL_SECRET || process.env.KAKAO_SKILL_SECRET || '',
    ragTimeoutMs: Number(process.env.VILLAGE_AI_RAG_TIMEOUT_MS || 30000) || 30000
  };
  return askVillageAi(stdinPayload, config, options);
}

export async function processProvidedJob(stdinJob, { dryRun = false, fakeDecisionPath = '' } = {}) {
  loadEnvFile(path.resolve(process.env.HOME || '', '.hermes/.env'));
  loadEnvFile(path.resolve(__dirname, '../kakao-dom-bridge/.env'));
  loadEnvFile(path.resolve(__dirname, '.env'));
  const config = requireConfig();
  return runAiAndMaybeWrite({ config, job: stdinJob, dryRun, fakeDecisionPath });
}

export async function processManualSend({ customerName = '', roomTitle = '', text: replyText = '', followUpId = '', attachmentPaths = [], customerDocumentAssets = false } = {}) {
  loadEnvFile(path.resolve(process.env.HOME || '', '.hermes/.env'));
  loadEnvFile(path.resolve(__dirname, '../kakao-dom-bridge/.env'));
  loadEnvFile(path.resolve(__dirname, '.env'));
  const config = requireConfig();
  const cleanText = text(replyText).trim();
  const cleanCustomer = text(customerName).trim();
  const cleanRoomTitle = text(roomTitle).trim();
  const manualAttachmentPaths = [
    ...normalizeKakaoAttachmentPaths(attachmentPaths),
    ...(customerDocumentAssets ? config.customerDocumentAssetPaths : [])
  ];
  if (!cleanText || cleanText.length < 2) throw new Error('manual send text is required');
  if (!cleanCustomer && !cleanRoomTitle) throw new Error('manual send customerName or roomTitle is required');

  const hints = [cleanCustomer, cleanRoomTitle].filter(Boolean);
  let navigationContext = null;
  await ensureKakaoChannelManagerTab({ url: config.kakaoChannelManagerUrl });
  navigationContext = await openKakaoTargetChatViaDevtools({
    customer_name: cleanCustomer,
    room_title: cleanRoomTitle,
    preview_text: [cleanCustomer || cleanRoomTitle, cleanText].filter(Boolean).join(' '),
    payload: { customerName: cleanCustomer, roomTitle: cleanRoomTitle }
  }, { timeoutMs: config.autoSendTimeoutMs, allowSearch: true }).catch((error) => ({
    status: 'devtools_manual_send_navigation_failed',
    reason: error.message.slice(0, 500)
  }));

  if (navigationContext?.status !== 'opened_target_chat') {
    const cuaPermission = await checkKakaoCuaFallbackAllowed({
      mode: config.workerControlMode,
      minIdleSeconds: config.cuaMinIdleSeconds,
      timeoutMs: Math.min(config.autoSendTimeoutMs, 1200)
    });
    if (!cuaPermission.allowed) {
      navigationContext = {
        status: 'cua_fallback_skipped_to_avoid_human_focus_conflict',
        hints,
        devtoolsFallback: navigationContext,
        cuaPermission
      };
    } else {
      const windowsText = await spawnText(config.cuaDriverCommand, ['call', 'list_windows', '--compact'], {
        timeoutMs: config.autoSendTimeoutMs,
        maxBuffer: 3_000_000
      });
      const windows = JSON.parse(windowsText).windows || [];
      const conversationWindow = pickKakaoConversationWindow(windows, hints);
      if (conversationWindow && conversationWindow.is_on_screen !== false) {
        navigationContext = {
          status: 'existing_target_chat',
          hints,
          devtoolsFallback: navigationContext,
          conversation_window: {
            pid: conversationWindow.pid,
            window_id: conversationWindow.window_id,
            title: conversationWindow.title || ''
          }
        };
      } else if (conversationWindow?.is_on_screen === false) {
        navigationContext = await openKakaoTargetChatViaDevtools({
          customer_name: cleanCustomer,
          room_title: cleanRoomTitle,
          preview_text: [cleanCustomer || cleanRoomTitle, cleanText].filter(Boolean).join(' '),
          payload: { customerName: cleanCustomer, roomTitle: cleanRoomTitle }
        }, { timeoutMs: config.autoSendTimeoutMs, allowSearch: true });
      } else {
        navigationContext = await openKakaoTargetChatFromList({
          customer_name: cleanCustomer,
          room_title: cleanRoomTitle,
          preview_text: [cleanCustomer || cleanRoomTitle, cleanText].filter(Boolean).join(' '),
          payload: { customerName: cleanCustomer, roomTitle: cleanRoomTitle }
        }, {
          timeoutMs: config.autoSendTimeoutMs,
          cuaDriverCommand: config.cuaDriverCommand,
          controlMode: config.workerControlMode,
          cuaMinIdleSeconds: config.cuaMinIdleSeconds,
          allowSearch: true
        });
      }
    }
  }

  let sendResult;
  let closeResult = null;
  try {
    sendResult = await sendKakaoMessageViaChrome(cleanText, navigationContext, {
      timeoutMs: config.autoSendTimeoutMs,
      cuaDriverCommand: config.cuaDriverCommand,
      attachmentPaths: manualAttachmentPaths,
      requireAutomationChromeProfile: config.requireAutomationChromeProfile,
      controlMode: config.workerControlMode,
      cuaMinIdleSeconds: config.cuaMinIdleSeconds
    });
  } finally {
    if (navigationContext?.opened_by_devtools_search && navigationContext?.conversation_target?.id) {
      closeResult = await closeKakaoConversationTargetViaDevtools(navigationContext.conversation_target).catch((error) => ({
        status: 'devtools_cleanup_failed',
        error: error.message.slice(0, 500)
      }));
    }
  }
  const result = {
    attempted: true,
    sent: Boolean(sendResult?.sent),
    reason: sendResult?.reason || 'send_failed_without_result',
    sendResult,
    closeResult,
    customerName: cleanCustomer,
    followUpId: text(followUpId).trim() || null
  };
  logAutoReply(config, {
    jobId: `manual-${Date.now()}`,
    result,
    customer: cleanCustomer,
    classification: 'manual_dashboard_reply',
    text: cleanText,
    manual: true,
    followUpId: result.followUpId
  });
  return result;
}

export async function processOneJob({ dryRun = false, claim = true, fakeDecisionPath = '' } = {}) {
  loadEnvFile(path.resolve(process.env.HOME || '', '.hermes/.env'));
  loadEnvFile(path.resolve(__dirname, '../kakao-dom-bridge/.env'));
  loadEnvFile(path.resolve(__dirname, '.env'));
  const config = requireConfig();
  const job = await fetchNextReadyJob(config);
  if (!job) return { status: 'no_job' };

  const workingJob = claim && !dryRun ? await claimJob(config, job) : job;
  try {
    const aiResult = await runAiAndMaybeWrite({ config, job: workingJob, dryRun, fakeDecisionPath });
    if (dryRun) return aiResult;

    const statusPatch = mapDecisionToStatusPatch(aiResult.decision, { sheetResult: aiResult.sheetResult });
    const previousPayload = workingJob.payload && typeof workingJob.payload === 'object' ? workingJob.payload : {};
    await updateJob(config, workingJob.id, {
      ...statusPatch,
      completed_at: new Date().toISOString(),
      payload: {
        ...previousPayload,
        ai_worker_result: {
          decision: aiResult.decision,
          sheet_result: aiResult.sheetResult,
          follow_up_result: aiResult.followUpResult,
          auto_reply_result: aiResult.autoReplyResult,
          hermes_output_tail: aiResult.hermesOutputTail
        }
      }
    });
    return { status: 'processed', jobId: workingJob.id, decision: aiResult.decision, sheetResult: aiResult.sheetResult, followUpResult: aiResult.followUpResult, autoReplyResult: aiResult.autoReplyResult };
  } catch (error) {
    if (!dryRun && workingJob.id) {
      await updateJob(config, workingJob.id, {
        status: 'ai_worker_error',
        error_message: error.message.slice(0, 1000),
        completed_at: new Date().toISOString()
      }).catch(() => null);
    }
    throw error;
  }
}

function parseArgs(argv) {
  const args = new Set(argv);
  const valueAfter = (flag) => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? argv[idx + 1] : '';
  };
  return {
    dryRun: args.has('--dry-run') || process.env.AI_WORKER_DRY_RUN === '1',
    ragLookup: args.has('--rag-lookup'),
    manualSend: args.has('--manual-send'),
    once: args.has('--once'),
    noClaim: args.has('--no-claim'),
    stdinJob: args.has('--stdin-job'),
    fakeDecisionPath: valueAfter('--fake-decision')
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const result = args.ragLookup
    ? await processRagLookup(await readStdinJson())
    : args.manualSend
      ? await processManualSend(await readStdinJson())
      : args.stdinJob
        ? await processProvidedJob(await readStdinJson(), {
            dryRun: args.dryRun,
            fakeDecisionPath: args.fakeDecisionPath
          })
        : await processOneJob({
            dryRun: args.dryRun,
            claim: !args.noClaim,
            fakeDecisionPath: args.fakeDecisionPath
          });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] === __filename) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
