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
const DEFAULT_KAKAO_CHANNEL_MANAGER_URL = 'https://business.kakao.com/_xhPMls/chats?t_src=business_partnercenter&t_ch=lnb&t_obj=%EB%82%B4%EC%B1%84%ED%8C%85_%ED%81%B4%EB%A6%AD';
const DEFAULT_KAKAO_REMOTE_DEBUGGING_PORT = '9223';
const DEFAULT_SLACK_CHANNELS = {
  schedule: '스케쥴-agent',
  document: '서류발송-agent',
  settlement: '정산-agent',
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
        'price, discount, included components, pickup/return procedure, and FAQ policy reference',
        'similar past Kakao conversations and village reply tone examples',
        'follow-up questions such as 그거/이거/같이/아까 말한 것 where recent Kakao context must be summarized into the question',
        'homepage or village historical policy grounding before drafting a reply'
      ],
      forbidden_uses: [
        'do not replace Kakao screen evidence',
        'do not replace Sheets/GAS duplicate checks',
        'do not use for current inventory availability, actual booking confirmation, or schedule/contract mutations',
        'do not send Kakao messages or write Sheets from RAG tool output',
        'do not copy-paste RAG text verbatim into the final reply draft'
      ],
      interpretation_rules: {
        high: 'Use actively as reply/policy reference, but never assert current inventory or final booking from RAG alone.',
        low: 'Use only for tone/policy hints; be cautious.',
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
    note: 'RAG 답변을 그대로 복붙하지 말고, 카카오 화면의 실제 대화 순서와 최신 고객 메시지를 1차 진실로 보고 RAG는 가격/정책/말투 참고자료로만 합성한다.'
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
      request_search_template: buildGasReadUrl(gasApiUrl, sheetApiKey, {
        action: 'search',
        sheet: '확인요청',
        col: 'A',
        query: '{AI_ENCODED_REQ_ID_OR_NAME}'
      }),
      contract_master_recent_gviz: buildGvizUrl('계약마스터', "SELECT A,B,E,G,J WHERE J='예약' ORDER BY A DESC LIMIT 80"),
      schedule_detail_by_trade_id_gviz_template: buildGvizUrl('스케줄상세', "SELECT B,C,D,E,F,H WHERE B='{AI_TRADE_ID}' LIMIT 50"),
      request_recent_gviz: buildGvizUrl('확인요청', "SELECT K,B,F WHERE K!='' ORDER BY A DESC LIMIT 50"),
      request_recent_with_results_gviz: buildGvizUrl('확인요청', "SELECT A,B,C,D,E,F,G,I,J,K,L,M,Q,R WHERE A!='' ORDER BY A DESC LIMIT 80"),
      request_by_req_id_gviz_template: buildGvizUrl('확인요청', "SELECT A,B,C,D,E,F,G,I,J,K,L,M,Q,R WHERE A='{AI_REQ_ID}' LIMIT 30"),
      request_by_customer_gviz_template: buildGvizUrl('확인요청', "SELECT A,B,C,D,E,F,G,I,J,K,L,M,Q,R WHERE K='{AI_CUSTOMER_NAME}' ORDER BY A DESC LIMIT 30"),
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
    note: 'These URLs are read-only lookup aids. 확인요청 columns: A=reqID, B-E period, F equipment, G qty, I result, J detail, K customer, L phone, M discount, Q memo, R extra. 계약마스터 columns include A tradeID, B customer, C phone, E-H period, J status, K discount. 스케줄상세 L is unit price. AI must decide what to query and how to interpret results. Do not use write/run/register/send actions.'
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
    ? `\nREAD-ONLY VILLAGE-AI RAG TOOL:\n${options.ragContext.enabled ? 'enabled' : 'disabled'}; command: node tools/ai-browser-worker/worker.mjs --rag-lookup; input: {question,userRole:"customer",context?}; output: {text,confidence,ownerReview,knowledgeSource,usedSources,topSimilarity,logId,error}.\nUse RAG only after reading Kakao screen as long-term reference memory, and only for price/discount/components/procedure/FAQ, past tone/policy, or ambiguous follow-up wording. Put short visible Kakao context inside the question string itself. RAG must not replace current Kakao screen evidence or Sheets/GAS duplicate checks. Never use RAG for current inventory, booking confirmation, Sheets/contract/schedule mutation, or duplicate checks. confidence=high informs draft but cannot assert availability; low/no_match/error means weak/ignore; ownerReview=true means extra human review. RAG 답변을 그대로 복붙하지 말고 현재 Kakao 대화와 합성한다.\n`
    : '';
  return `AI-first Kakao rental-shop worker task.

CRITICAL RULES:
- This is AI-first. 코드의 역할은 queue/claim/API 호출 같은 plumbing뿐이다.
- 코드가 고객 의도, 예약 여부, 날짜/시간/장비를 최종 판단하면 안 된다. 코드 판단 금지: AI가 화면과 맥락을 보고 판단하고, 코드는 queue/claim/API write만 수행한다.
- 카카오 Channel Manager Chrome 화면을 computer_use로 직접 확인하고, 화면에서 보이는 대화 맥락을 우선한다.
- 미리보기만 보고 분류하지 마라. 채팅방을 열어 실제 대화 맥락을 확인해야 한다.
- Use at most 5 UI navigation actions total. If the matching conversation is not found within that budget, stop and return classification="unclear" / should_write_to_sheet=false with reason="matching Kakao conversation not visible within budget".
- 답장/시트 처리에 과도하게 보수적으로 굴지 않는다. 전송 기능이 켜진 환경에서는 AI가 reply_decision.replyMode="auto_send"로 명시하고 confidence가 high이며 kill switch가 active일 때만 간단한 답변을 자동발송 후보로 둔다. 전송 기능이 꺼진 환경에서는 suggested_reply_draft/follow_up_items만 만든다.
- 자동발송 후보는 간단/확실한 FAQ, 절차 안내, 수령/반납 안내, 이미 확인된 단순 후속 답변, 예약 접수 acknowledgement 정도로 제한한다. 재고 가능 단정, 예약 확정, 가격/할인 최종 확정, 결제/환불, 분실/파손, 법적/세금 민감 답변은 auto_send가 아니라 draft_only/task로 둔다.
- 예약 확정, 재고 가능 단정, 가격 확정은 화면/시트 근거 없이 단정하지 않는다. 하지만 고객이 예약형식에 맞게 정보를 준 경우 확인요청 시트 입력은 적극 수행한다.
- Google Sheets 입력은 API로 가능하다. 어떤 값을 넣을지는 AI가 판단하되, 예약형식이 충분하면 should_write_to_sheet=true를 기본값으로 둔다.

CLAUDE COWORKER POLICY TO CARRY FORWARD:
- 최근 1시간 내 새 메시지 후보라도 반드시 채팅방을 열고, 화면에서 보이는 메시지 + 가능하면 최근 24시간 맥락을 확인한다.
- 고객의 마지막 문의에 대해 직원(빌리지님/김준영님/최재형님)이 이미 답변했는지 확인한다. 직원이 이미 답변했으면 새 답장 초안은 만들지 말고, 미등록 예약 여부만 검토한다.
- read-catchup/backstop job일 수 있다. 마지막 버블이 "네네/감사합니다/견적서 부탁"이어도 같은 최근 고객 턴 앞쪽 예약형식 메시지가 있으면 확인요청/계약/스케줄 등록 여부를 확인한다.
- 확인요청에 이미 RQ가 있으면 중복 입력 금지. 단, 그 RQ가 자동화가 만든 것이라고 추정하거나 보고하지 마라. 수동 입력일 수 있다.
- 확인요청에 이미 RQ가 있으면 중복 입력은 금지하되, 반드시 그 RQ의 I열(결과)과 J열(상세)을 읽어서 가용확인 결과 기준으로 follow_up_items.summary/recommended_action/suggested_reply_draft를 만든다. 사람에게 "RQ 결과를 검토하라"고만 떠넘기지 마라.
- 기존 RQ 결과가 비어 있거나 읽히지 않으면 "가용확인 결과 없음/재확인 필요"로 보고한다. 결과가 ✅ 가용일 때만 고객 답변 초안에 예약 가능하다고 쓴다. ⚠️/❌/가용0/결과없음이면 가능 단정 금지.
- 예약/가격/FAQ/무시를 AI가 분류한다. 미리보기 텍스트만으로 예약·가격·FAQ를 확정하지 않는다.
- 킬 스위치 상태는 paused / price_paused / active 중 하나다. paused면 실제 자동 발송은 중단하고 시트/처리판 기록은 계속한다. price_paused면 가격 자동 응답만 중단한다.
- FAQ 고정 답변 후보: 주소=서울 마포구 동교로 23길 32, 2층 / 네이버 지도=https://naver.me/5mIWTFQ1 / 영업시간=24시간 운영 / 절차=장비명+기간 전달→가용확인→방문수령→반납.
- 가격 문의는 세트마스터 단가, 고객할인, 장기할인으로 초안/follow_up을 만든다. price_paused면 가격 자동발송 금지.
- 계약서/견적서/세금계산서/거래명세서 등 서류 요청은 금액 계산을 생략하지 않는다. 거래ID가 보이면 계약마스터+스케줄상세를 읽고, 스케줄상세 L열 단가가 있는 대표/단품 행 기준으로 정가=수량×대여일수×단가를 계산한다.
- 서류 요청 금액 산식은 계약서 생성 로직과 맞춘다: 대여일수는 24시간=1일, 6시간 이내 초과는 같은 일수, 그 이상은 +1일. 결제금액은 정가 × 고객/제휴/단골 할인 배율 × 장기할인 배율, VAT 포함 최종금액은 할인후 금액×1.1을 10원 단위 올림으로 계산한다.
- 서류 요청에서 확인요청 RQ만 있고 아직 계약 등록 전이면 확인요청 결과와 세트마스터 단가로 계산 가능한 항목은 반드시 부분 계산하고, 미등록/단가불명 항목은 "미계산/확인 필요"로 따로 표시한다. 사람에게 "금액 확인"이라고만 떠넘기지 않는다.
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
- 단, 정규화가 애매하거나 실패했다고 확인요청 시트 입력 자체를 막지 않는다. 확인요청은 최종 등록이 아니라 사람이 보고 수정하는 대기열이다. 정말 정규화할 수 없을 때만 고객 원문을 item에 넣고, memo/extra_request에 원문과 검증필요를 남긴다.
- 약어/속어는 검색 키워드 힌트다. 예: FX3, A7S3, FX6, FX9, A7M4, A7C2, 2470gm2 등. AI는 가능한 한 장비명을 추론/정규화해야 하며, 원문 그대로 쓰는 것은 정규화 실패 시 fallback이다.
- 렌즈 힌트: 70-200 GM II -> 소니 GM 70-200mm II, 24-70 GM II -> 소니 GM 24-70mm II, 16-35 -> 소니 GM 16-35mm.
- 조명/기타 힌트: 600x -> 어퓨쳐 600X, 파보튜브 30xr -> 파보튜브 II 30XR, 시대/C대 -> C스탠드, 줌 F6/윈 F6 -> 줌 F6.
- 할인유형은 학생 / 개인사업자/프리랜서 / 일반 중 하나만 쓴다. 단골 또는 제휴는 절대 쓰지 말고 일반으로 둔다. 단골/제휴 여부는 GAS/고객DB가 판단한다.
- 중복 입력 방지: 가능하면 계약마스터, 스케줄상세, 확인요청 3단계를 확인한다. 예약형식이면 일부 확인이 불완전해도 쓰고 memo에 남긴다. 직원 확정 후 미등록 예약도 쓴다.
- 예약형식에 맞춰 들어온 건은 확인요청 시트 입력이 기본 동작이다. 불확실한 장비명/중복확인/전화번호 누락은 입력 차단 사유가 아니라 memo/extra_request에 남길 보완사항이다.
- read-catchup에서 기존 RQ를 발견하면 should_write_to_sheet=false는 중복 방지일 뿐이다. reason에는 "기존 RQ 발견으로 중복 입력 방지"라고 쓰고 자동화 처리 결과라고 단정하지 않는다.
- read-catchup에서 기존 RQ를 발견한 경우에도 확인요청 I/J 결과를 읽은 뒤, 그 결과가 ✅/⚠️/❌/미확인 중 무엇인지 후속카드에 명시한다.

JOB EVIDENCE FROM SUPABASE:
${JSON.stringify(buildCompactJobForPrompt(job), null, 2)}
${navigationContextText}
${lookupContextText}${ragContextText}
SHEETS TOOL AVAILABLE VIA GAS API:
- URL: ${gasApiUrl}
- Target sheet for reservation inquiry candidates: 확인요청
- Outer worker writes to 확인요청 when your FINAL_JSON says should_write_to_sheet=true. Be 적극적: if the latest customer turn is a reservation-format request with enough fields for a review row, set should_write_to_sheet=true.
- Do not call write/insert/register/send APIs yourself in this Hermes prompt. Return the final decision JSON only; outer worker will write when appropriate.

TASK:
1. First use the supplied BROWSER NAVIGATION RESULT / live DevTools DOM evidence. It is captured from the isolated automation Chrome and is designed to avoid taking over the human mouse, keyboard, frontmost app, or macOS Space.
2. Keep automation quality first: use terminal-driven CUA when DevTools evidence is insufficient/mismatched or visible UI truth is materially better. Keep CUA scope small and read/navigation-oriented: "cua-driver call list_windows --compact", "cua-driver call get_window_state ... --compact", and "cua-driver call page ... get_text/query_dom". Do not use terminal CUA to write Sheets or send Kakao messages.
3. If you use CUA output, never print raw full AX/page output. Always pipe through Python filtering and print at most 2000 characters total, centered on navigation_hints/customer name and the chosen window_id.
4. If BROWSER NAVIGATION RESULT says opened_target_chat with hint_matched=true, start from its live conversation_evidence and do not re-open the chat list.
4. Use computer_use read-only capture only if needed. The worker forces capture mode="ax" and max_elements=80 for speed; do not request image/vision capture in the autonomous worker. If AX text is insufficient after navigation attempts, return unclear instead of escalating to screenshot capture.
5. Use JOB EVIDENCE navigation_hints only to find/open the target Kakao chat. This is navigation evidence, not business classification evidence.
6. If the currently open conversation title/messages do not match the navigation_hints/preview_text, go back to the Kakao chat list or use the visible Kakao search/chat-list UI to find the matching customer/room. You may click/type only for navigation inside Kakao; never type into the message compose box and never send.
7. Read visible conversation content and recent context; separate staff/outbound vs customer/inbound before classifying. Merge consecutive customer bubbles in the latest customer turn; do not treat staff/outbound messages as customer requests.
8. If RAG is enabled and useful, call the village-ai helper only after reading the Kakao screen. Build the RAG question by briefly embedding the visible Kakao context and latest customer/inbound message cluster in the question string. Use RAG only for price/discount/components/procedure/FAQ, prior tone/policy reference, or ambiguous follow-up wording; never for current inventory availability, booking confirmation, Sheets/contract/schedule mutation, or duplicate checks.
9. RAG interpretation: confidence=high can inform a reply draft but still cannot assert inventory/booking; confidence=low is tone/policy hint only; no_match/empty/error means ignore RAG; ownerReview=true means extra human verification before any future auto-send; knowledgeSource=general is not firm village policy.
10. Decide whether this is reservation inquiry, price inquiry, FAQ, ignored message, or already-answered message.
11. For reservation-format requests, prefer should_write_to_sheet=true. Missing phone/equipment/duplicate lookup goes to memo/extra_request. Set false only for non-reservation, unopened/mismatched chat, unclear sender order, or obvious duplicate/already-registered booking. If newest actionable message is staff/outbound, write only for staff-confirmed-unregistered; otherwise no write.
11-1. Never invent or fill a request_id for 확인요청. The outer worker calls GAS insertAndCheckRequest, and GAS must generate the real RQ-YYMMDD-NNN request ID.
11-2. For multiple equipment items, put each item into sheet_row_candidate.equipment as a separate object. Do not concatenate multiple equipment names into one item string. One equipment object becomes one 확인요청 row under the same GAS-generated request ID.
11-3. If you find an existing matching RQ, read its 확인요청 result/detail (I/J) before writing follow_up_items. The follow-up must report the availability result itself, not ask the owner to inspect the RQ. If I/J is blank or unavailable, say so and ask for recheck.
12. Create at most one follow_up_item per latest customer message cluster. Do not split one customer turn into separate reply_needed/schedule_check/damage_repair/completed_log cards. Choose the single primary type and put the rest as a concise checklist inside recommended_action/evidence.
13. If a reply is useful, put suggested_reply_draft on that single follow_up_item instead of creating an extra reply_needed card. Also fill reply_decision. Set reply_decision.replyMode="auto_send" only for simple, high-confidence replies that are safe to send now under the kill-switch policy. Otherwise use draft_only or no_reply.
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
    "discount_type": "학생" | "개인사업자/프리랜서" | "일반" | null,
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
  "follow_up_items": [
    {
      "type": "reply_needed" | "quote_send" | "tax_invoice" | "schedule_check" | "reservation_review" | "price_review" | "payment_check" | "contract_document" | "return_extension" | "damage_repair" | "sheet_duplicate_check" | "completed_log",
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
    "customer_name": string,
    "equipment": [{ "item": string, "quantity": number | string | "" }],
    "start_date": string,
    "end_date": string,
    "pickup_time": string,
    "return_time": string,
    "phone": string,
    "discount_type": "학생" | "개인사업자/프리랜서" | "일반" | "",
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
    "shouldCreateTask": boolean
  }
}`;
}
export function extractJsonObject(text) {
  const input = String(text || '');
  const afterMarker = input.includes('FINAL_JSON') ? input.slice(input.lastIndexOf('FINAL_JSON') + 'FINAL_JSON'.length) : input;
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(afterMarker);
  const candidate = fence ? fence[1] : afterMarker;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('No JSON object found in Hermes output');
  return JSON.parse(candidate.slice(start, end + 1));
}

function text(value) {
  return value === null || value === undefined ? '' : String(value);
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
  const rawItems = Array.isArray(row.equipment) ? row.equipment
    : Array.isArray(row.items) ? row.items
      : Array.isArray(row.장비) ? row.장비
        : [];
  const fromCandidate = rawItems.map((item) => ({
    item: text(item.item || item.name || item.이름 || item.equipment || item.raw_text),
    quantity: item.quantity ?? item.qty ?? item.수량 ?? ''
  }));
  const fromReservation = Array.isArray(decision.reservation_inquiry?.equipment_requested)
    ? decision.reservation_inquiry.equipment_requested.map((item) => ({
      item: text(item.exact_name_from_set_master || item.normalized_guess || item.raw_text),
      quantity: item.quantity ?? item.qty ?? item.수량 ?? ''
    }))
    : [];
  const items = (fromCandidate.length ? fromCandidate : fromReservation)
    .map((item) => ({
      item: text(item.item).trim(),
      quantity: item.quantity === null || item.quantity === undefined || item.quantity === '' ? 1 : item.quantity
    }))
    .filter((item) => item.item);
  if (items.length) return items;
  const fallbackItem = text(row.item || row.장비명 || row.equipment_name).trim();
  if (!fallbackItem) return [];
  return [{ item: fallbackItem, quantity: row.quantity ?? row.qty ?? row.수량 ?? 1 }];
}

export function buildSheetAppendPayload(decision, options = {}) {
  if (!decision || decision.should_write_to_sheet !== true) return null;
  if (!hasRequiredSheetSafetyChecks(decision)) return null;
  const row = decision.sheet_row_candidate || {};
  const equipment = normalizeSheetEquipmentItems(decision);
  if (!equipment.length) return null;
  const memo = text(row.memo || decision.reason);
  const extra = text(row.extra_request || decision.suggested_human_review_action || '');
  const args = {
    반출일: text(row.start_date || decision.reservation_inquiry?.rental_start),
    반출시간: text(row.pickup_time || decision.reservation_inquiry?.pickup_time),
    반납일: text(row.end_date || decision.reservation_inquiry?.rental_end),
    반납시간: text(row.return_time || decision.reservation_inquiry?.return_time),
    예약자명: text(row.customer_name || decision.customer?.name),
    연락처: text(row.phone || decision.customer?.phone),
    할인유형: text(row.discount_type || decision.reservation_inquiry?.discount_type || '일반') || '일반',
    비고: memo,
    추가요청: extra,
    장비: equipment.map((item) => ({ 이름: item.item, 수량: item.quantity || 1 }))
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

function extractSemanticAnchors(value) {
  const input = text(value).normalize('NFKC');
  const anchors = [];
  const amountMatches = input.match(/\d+(?:\.\d+)?\s*(?:만원|원)/g) || [];
  anchors.push(...amountMatches.map((v) => v.replace(/\s+/g, '')));
  if (/(반납|다음\s*회차|메모리|배터리|픽업|라오와|장비\s*반납|확인\s*후\s*가져다|가져다\s*드리)/.test(input)) {
    anchors.push('operations_update');
  }
  const keywordGroups = [
    ['payment_docs', /(결제|계약|견적|정산|서류|거래명세|세금계산|계산서)/],
    ['discount_policy', /(학생\s*할인|학생할인|할인율|몇\s*프로|몇\s*퍼센트|할인)/],
    ['reservation_review', /(예약|반출|반납|대여|촬영|일정)/],
    ['damage_repair', /(미반납|누락|분실|파손|손상|수리|고장|회수|경고\s*메시지|배터리)/],
    ['payment_check', /(입금|결제|미수|환불)/]
  ];
  for (const [label, regex] of keywordGroups) {
    if (regex.test(input)) anchors.push(label);
  }
  if (!anchors.includes('discount_policy') && !anchors.includes('operations_update') && /(위치|주소|어디|찾아가|오시는\s*길)/.test(input)) anchors.push('location_faq');
  if (anchors.includes('operations_update')) {
    return [...new Set(anchors.filter((anchor) => !['payment_docs', 'reservation_review', 'location_faq', 'damage_repair'].includes(anchor)))].slice(0, 8);
  }
  if (anchors.includes('discount_policy')) {
    return [...new Set(anchors.filter((anchor) => !['payment_docs', 'reservation_review', 'location_faq'].includes(anchor)))].slice(0, 8);
  }
  if (anchors.includes('damage_repair')) {
    return [...new Set(anchors.filter((anchor) => !['payment_docs', 'reservation_review'].includes(anchor)))].slice(0, 8);
  }
  return [...new Set(anchors)].slice(0, 8);
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

function isReservationFollowUpTopic(row = {}, combined = followUpCombinedText(row)) {
  const type = String(row.type || row.follow_up_type || '');
  if (type === 'reservation_review') return true;
  if (!['reply_needed', 'schedule_check'].includes(type)) return false;
  return /(예약\s*(?:가능|진행|요청|의사|접수)|대여\s*가능|렌탈\s*가능|대여\s*할\s*수|대여\s*할수|렌탈\s*할\s*수|장비\s*예약)/.test(combined);
}

function stableFollowUpType(row = {}, combined = followUpCombinedText(row)) {
  return isReservationFollowUpTopic(row, combined) ? 'reservation_review' : normalizeKeyPart(row.type, 60);
}

function stableFollowUpAnchors(row = {}, combined = followUpCombinedText(row)) {
  if (isReservationFollowUpTopic(row, combined)) {
    return [...new Set([...extractDateConcreteAnchors(combined), 'reservation_review'])];
  }
  return extractSemanticAnchors(combined);
}

export function buildFollowUpSemanticKey(row = {}) {
  const customer = normalizeCustomerForTask(row.customer_name || row.customerName);
  const type = normalizeKeyPart(row.type, 60);
  const combined = followUpCombinedText(row);
  const concreteAnchors = extractConcreteAnchors(combined);
  const topicAnchors = extractSemanticAnchors(combined);
  if (!concreteAnchors.length && !topicAnchors.length) {
    return `exact:${normalizeKeyPart(row.follow_up_key || row.id || row.title || '', 200)}`;
  }
  return ['semantic', customer, type, ...new Set(concreteAnchors), ...new Set(topicAnchors)]
    .map((v) => normalizeKeyPart(v, 120))
    .join(':');
}

export function buildFollowUpTopicKey(row = {}) {
  const customer = normalizeCustomerForTask(row.customer_name || row.customerName);
  const combined = followUpCombinedText(row);
  const concreteAnchors = extractConcreteAnchors(combined);
  const topicAnchors = extractSemanticAnchors(combined);
  if (isReservationFollowUpTopic(row, combined)) {
    return ['topic', customer, 'reservation_review', ...new Set(extractDateConcreteAnchors(combined))]
      .map((v) => normalizeKeyPart(v, 120))
      .join(':');
  }
  const topicPriority = ['operations_update', 'discount_policy', 'location_faq', 'damage_repair', 'payment_check', 'payment_docs', 'reservation_review'];
  const topic = topicPriority.find((value) => topicAnchors.includes(value));
  if (!topic) return buildFollowUpSemanticKey(row);
  const parts = ['topic', customer, topic];
  if (topic === 'reservation_review' || topic === 'payment_docs' || topic === 'payment_check') {
    parts.push(...new Set(concreteAnchors));
  }
  return parts.map((v) => normalizeKeyPart(v, 120)).join(':');
}

export function mergeFollowUpRowsByTopic(rows = []) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = buildFollowUpTopicKey(row);
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

function buildStableFollowUpKey({ roomKey, customerName, type, title, summary, recommendedAction, evidence }) {
  const combined = [title, summary, recommendedAction, Array.isArray(evidence) ? evidence.join(' ') : ''].join(' ');
  const rowForKey = { customer_name: customerName, type, title, summary, recommended_action: recommendedAction, evidence };
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

function shouldSuppressFollowUpItem(decision, item) {
  const reason = text(decision?.reason).toLowerCase();
  const blockingReason = text(item?.blocking_reason || item?.blockingReason).toLowerCase();
  const title = text(item?.title);
  const opened = decision?.safety_checks?.kakao_conversation_opened === true;
  const noVisibleConversation = !opened && (
    /matching kakao conversation not visible|chat_row_not_found|대화방을.*확인하지 못|대화방을.*열어.*확인하지 못/.test(reason)
    || /matching kakao conversation not visible|chat_row_not_found|대화방.*수동 확인/.test(blockingReason)
    || /Kakao 대화방 수동 확인 필요/.test(title)
  );
  return noVisibleConversation;
}

export function buildFollowUpRows(decision, job = {}) {
  const items = Array.isArray(decision?.follow_up_items) ? decision.follow_up_items : [];
  const rawJobId = text(job.id || job.jobId || '');
  const jobId = isUuid(rawJobId) ? rawJobId : null;
  const roomKey = text(job.room_key || job.roomKey || job.payload?.roomKey || '').slice(0, 240);
  const fallbackCustomer = text(decision?.customer?.name || job.customer_name || '');
  const allowedTypes = new Set(['reply_needed', 'quote_send', 'tax_invoice', 'schedule_check', 'reservation_review', 'price_review', 'payment_check', 'contract_document', 'return_extension', 'damage_repair', 'sheet_duplicate_check', 'completed_log']);
  const allowedPriorities = new Set(['urgent', 'high', 'normal', 'low']);
  const allowedStatuses = new Set(['open', 'done', 'dismissed']);
  return items
    .filter((item) => item && typeof item === 'object')
    .filter((item) => !shouldSuppressFollowUpItem(decision, item))
    .map((item) => {
      const type = allowedTypes.has(String(item.type)) ? String(item.type) : 'reply_needed';
      const priority = allowedPriorities.has(String(item.priority)) ? String(item.priority) : 'normal';
      const status = allowedStatuses.has(String(item.status)) ? String(item.status) : 'open';
      const title = text(item.title).slice(0, 240) || `${type} follow-up`;
      const customerName = text(item.customer_name || item.customerName || fallbackCustomer).slice(0, 120);
      const summary = text(item.summary).slice(0, 3000);
      const recommendedAction = text(item.recommended_action || item.recommendedAction).slice(0, 3000);
      const suggestedReplyDraft = text(item.suggested_reply_draft || item.suggestedReplyDraft).slice(0, 3000);
      const evidence = Array.isArray(item.evidence) ? item.evidence.map((v) => text(v)).filter(Boolean).slice(0, 12) : [];
      return {
        follow_up_key: buildStableFollowUpKey({ roomKey, customerName, type, title, summary, recommendedAction, evidence }),
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
        payload: item
      };
    });
}

export async function upsertFollowUpRows(config, rows) {
  if (!rows.length) return { inserted: 0, rows: [] };
  const table = encodeURIComponent(config.followUpTable || 'ai_follow_up_items');
  const mergedRows = mergeFollowUpRowsByTopic(rows);
  const filteredRows = await filterFollowUpRowsWithClosedHistory(config, mergedRows);
  if (!filteredRows.length) return { inserted: 0, rows: [], skippedClosed: rows.length };
  const inserted = await supabaseFetch(config, `${table}?on_conflict=follow_up_key`, {
    method: 'POST',
    headers: supabaseHeaders(config, 'resolution=merge-duplicates,return=representation'),
    body: JSON.stringify(filteredRows)
  });
  return { inserted: Array.isArray(inserted) ? inserted.length : filteredRows.length, rows: inserted, merged: rows.length - mergedRows.length, skippedClosed: mergedRows.length - filteredRows.length };
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
  const finalVatIncluded = Math.ceil((discountedAmount * 1.1) / 10) * 10;
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
  const chosen = exactStandalone || exact[0] || rows.find((row) => parseNumber(row[6], 0) > 0);
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
  const type = String(row.type || '');
  let route = 'other';
  if (['reservation_review', 'schedule_check', 'sheet_duplicate_check'].includes(type)) route = 'schedule';
  if (['quote_send', 'tax_invoice', 'contract_document', 'price_review'].includes(type)) route = 'document';
  if (['payment_check'].includes(type)) route = 'settlement';
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
    const chunks = splitLongMobileLine(line, 56);
    lines.push(`🧾 ${escapeSlackText(chunks[0] || line)}`);
    for (const chunk of chunks.slice(1, 4)) {
      lines.push(`   ${escapeSlackText(chunk)}`);
    }
    lines.push('');
  }
  if (calc.totalVatIncluded) {
    lines.push(`💰 합계 VAT 포함 ${formatMoney(calc.totalVatIncluded)}`);
  }
  return lines.filter((line, index, arr) => line || arr[index - 1]).join('\n').trim();
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
  const original = mobileBulletsForSlack(row.recommended_action, { limit: calc?.lines?.length ? 2 : 5, maxLine: 54, icon: '▫️' });
  if (original) lines.push(original);
  return lines.join('\n\n') || mobileBulletsForSlack(row.recommended_action, { limit: 5, maxLine: 54, icon: '▫️' });
}

export function buildSlackFollowUpMessage(row = {}, options = {}) {
  const route = options.route || routeFollowUpToSlack(row, options.config || {});
  const typeLabel = slackTypeLabel(row.type);
  const priorityLabel = row.priority === 'urgent' ? '긴급' : row.priority === 'high' ? '중요' : row.priority || 'normal';
  const title = truncateSlackText(row.title || `${typeLabel} 후속처리`, 140);
  const customer = truncateSlackText(row.customer_name || '고객명 미확인', 120);
  const draft = text(row.suggested_reply_draft || '').trim();
  const evidence = Array.isArray(row.evidence) ? row.evidence.map(text).filter(Boolean).slice(0, 5) : [];
  const calculationBlock = formatSlackCalculationBlock(row);
  const recommendationBlock = formatSlackRecommendation(row);
  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: title.slice(0, 150), emoji: true }
    },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*고객*\n${customer}` },
        { type: 'mrkdwn', text: `*분류*\n${truncateSlackText(typeLabel, 80)}` },
        { type: 'mrkdwn', text: `*우선순위*\n${truncateSlackText(priorityLabel, 80)}` },
        { type: 'mrkdwn', text: `*라우팅*\n#${truncateSlackText(route.channel, 80)}` }
      ]
    }
  ];
  if (row.summary) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*👀 요약*\n${mobileBulletsForSlack(row.summary, { limit: 7, maxLine: 52, icon: '•' }) || truncateSlackText(row.summary, 1000)}` } });
  }
  if (calculationBlock) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*🧮 계산*\n${truncateSlackText(calculationBlock, 1800)}` } });
  }
  if (recommendationBlock) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*➡️ 추천 조치*\n${truncateSlackText(recommendationBlock, 1800)}` } });
  }
  if (draft) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*💬 답변 초안*\n${codeBlockForSlack(draft, 1800)}` } });
  }
  if (evidence.length) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*📌 근거*\n${evidence.map((item) => `• ${escapeSlackText(splitLongMobileLine(item, 58).slice(0, 3).join('\n  '))}`).join('\n\n')}`
      }
    });
  }
  blocks.push({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: '*🔘 버튼 동작*\n• 전송: 현재 초안으로 카카오 발송 요청\n\n• 수정 후 전송: 문구 수정창을 연 뒤 발송 요청\n\n• 진행중/완료/무시: 처리판 상태만 변경'
    }
  });
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

export async function postSlackFollowUpRow(config = {}, row = {}) {
  if (!row?.id) return { skipped: true, reason: 'missing_follow_up_id' };
  if (row.status && ['done', 'dismissed'].includes(row.status)) return { skipped: true, reason: 'closed_follow_up' };
  if (
    row.slack_message_ts
    || row.slack_delivery_status === 'delivered'
    || row.payload?.slack_delivery?.status === 'delivered'
  ) return { skipped: true, reason: 'already_delivered', rowId: row.id };
  const enrichedRow = await enrichFollowUpRowWithOperationalCalculations(config, row);
  const route = routeFollowUpToSlack(enrichedRow, config);
  const channelId = await resolveSlackChannelId(route.channel, config);
  const message = buildSlackFollowUpMessage(enrichedRow, { route, config });
  const posted = await slackApi(config, 'chat.postMessage', {
    channel: channelId,
    text: message.text,
    blocks: message.blocks,
    unfurl_links: false,
    unfurl_media: false
  });
  const updated = await mergeFollowUpPayload(config, row.id, {
    slack_delivery: {
      status: 'delivered',
      channel_name: route.channel,
      channel_id: posted.channel || channelId,
      message_ts: posted.ts || null,
      thread_ts: posted.message?.thread_ts || posted.ts || null,
      delivered_at: new Date().toISOString(),
      error: null
    }
  }, {
    summary: enrichedRow.summary,
    recommended_action: enrichedRow.recommended_action,
    evidence: enrichedRow.evidence
  });
  return { ok: true, rowId: row.id, route, channelId, ts: posted.ts, updated };
}

export async function deliverSlackFollowUpRows(config = {}, rows = []) {
  if (!config.slackFollowUpEnabled) return { skipped: true, reason: 'disabled', results: [] };
  if (!rows.length) return { skipped: true, reason: 'no_rows', results: [] };
  const results = [];
  for (const row of rows) {
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
    hermesTimeoutMs: Number(process.env.HERMES_WORKER_TIMEOUT_MS || process.env.WORKER_TIMEOUT_MS || '240000'),
    ensureKakaoTab: process.env.KAKAO_WORKER_ENSURE_TAB !== '0',
    kakaoChannelManagerUrl: process.env.KAKAO_CHANNEL_MANAGER_URL || DEFAULT_KAKAO_CHANNEL_MANAGER_URL,
    openTargetChat: process.env.KAKAO_WORKER_OPEN_TARGET_CHAT !== '0',
    cuaDriverCommand: resolveCuaDriverCommand(process.env.CUA_DRIVER_COMMAND || 'cua-driver'),
    workerControlMode: normalizeKakaoWorkerControlMode(process.env.KAKAO_WORKER_CONTROL_MODE),
    cuaMinIdleSeconds: Math.max(0, numberFromEnv(process.env.KAKAO_CUA_MIN_IDLE_SECONDS, 0)),
    villageAiUrl: process.env.VILLAGE_AI_URL || '',
    villageAiKakaoSkillSecret: process.env.VILLAGE_AI_KAKAO_SKILL_SECRET || process.env.KAKAO_SKILL_SECRET || '',
    ragTimeoutMs: Number(process.env.VILLAGE_AI_RAG_TIMEOUT_MS || 30000) || 30000,
    followUpTable: process.env.SUPABASE_FOLLOW_UP_TABLE || 'ai_follow_up_items',
    autoSendEnabled: process.env.AI_WORKER_AUTO_SEND === '1',
    autoSendLogPath: process.env.AI_WORKER_AUTO_SEND_LOG || path.resolve(__dirname, '../kakao-dom-bridge/queue/auto-replies.ndjson'),
    autoSendTimeoutMs: Number(process.env.AI_WORKER_AUTO_SEND_TIMEOUT_MS || 20000) || 20000,
    slackFollowUpEnabled: process.env.SLACK_FOLLOW_UP_ENABLED === '1',
    slackBotToken: process.env.SLACK_BOT_TOKEN || '',
    slackChannels: {
      schedule: process.env.SLACK_CHANNEL_SCHEDULE_AGENT || DEFAULT_SLACK_CHANNELS.schedule,
      document: process.env.SLACK_CHANNEL_DOCUMENT_AGENT || DEFAULT_SLACK_CHANNELS.document,
      settlement: process.env.SLACK_CHANNEL_SETTLEMENT_AGENT || DEFAULT_SLACK_CHANNELS.settlement,
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

function classifyGasSheetError(message) {
  const value = text(message);
  if (/중복 요청|이미 예약 등록|duplicate/i.test(value)) return 'duplicate_request';
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
    return result && !/^세트$/i.test(result);
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
  const equipmentLabel = sheetPayloadEquipmentLabel(sheetPayload);
  const duplicateNote = sheetResult?.duplicate ? '기존 중복 RQ에서 읽은 결과입니다. ' : '';
  const summary = `${duplicateNote}${reqLabel} 가용확인 결과: ${headline}`;

  let recommendedAction = `${reqLabel} 결과가 비어 있거나 판독되지 않았습니다. 같은 조건으로 가용확인을 다시 실행하거나 시트 I/J열을 확인한 뒤 고객에게 안내하세요.`;
  let suggestedReplyDraft = '감독님, 확인 후 바로 안내드리겠습니다.';
  if (status === 'available') {
    recommendedAction = `${reqLabel} 결과가 가용입니다. 고객에게 가능 안내 후 예약 진행 여부를 확인하세요.`;
    suggestedReplyDraft = `확인해보니${equipmentLabel ? ` ${equipmentLabel}` : ''} 해당 일정 예약 가능하십니다. 예약 진행 원하시면 말씀해주세요!`;
  } else if (status === 'warning') {
    recommendedAction = `${reqLabel} 결과에 경고가 있습니다. 상세 결과를 기준으로 부족/겹침/모델 선택 필요 여부를 확인하고, 가능 단정 없이 대안 또는 추가확인을 안내하세요.`;
    suggestedReplyDraft = '확인해보니 해당 일정은 일부 장비 확인이 필요합니다. 가능한 구성 확인해서 바로 안내드리겠습니다.';
  } else if (status === 'unavailable') {
    recommendedAction = `${reqLabel} 결과가 가용 불가 또는 가용0입니다. 고객에게 가능하다고 안내하지 말고 대체 일정/대체 장비를 확인하세요.`;
    suggestedReplyDraft = '확인해보니 요청하신 일정은 현재 바로 확정 안내가 어렵습니다. 대체 일정이나 대체 장비를 확인해서 안내드리겠습니다.';
  }

  return {
    reqID,
    status,
    rows,
    lines,
    summary,
    recommendedAction,
    suggestedReplyDraft,
    payload: {
      reqID,
      status,
      duplicate: sheetResult?.duplicate === true,
      results: rows
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
  const reqIDs = extractConfirmRequestIds({
    reason: decision?.reason,
    follow_up_items: decision?.follow_up_items,
    followUpRows
  });
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
  const combined = followUpCombinedText(row);
  const type = String(row.type || '');
  return type === 'reservation_review'
    || type === 'schedule_check'
    || type === 'sheet_duplicate_check'
    || (type === 'reply_needed' && /(예약|가용|가능|대여|렌탈|반출|반납)/.test(combined));
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
      sheet_availability: report.payload,
      sheet_request: sheetPayload?.args || null
    }
  };
}

export function enrichFollowUpRowsWithSheetAvailability(rows = [], sheetResult = null, sheetPayload = null, decision = {}, job = {}) {
  const report = buildSheetAvailabilityReport(sheetResult, sheetPayload);
  if (!report) return rows;
  const sourceRows = Array.isArray(rows) ? rows : [];
  if (!sourceRows.length) {
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
      type: 'reservation_review',
      priority: report.status === 'available' && row.priority !== 'urgent' ? (row.priority || 'high') : 'urgent',
      summary: alreadyHasResult ? row.summary : [row.summary, report.summary].map(text).filter(Boolean).join('\n'),
      recommended_action: report.recommendedAction,
      suggested_reply_draft: report.suggestedReplyDraft || row.suggested_reply_draft,
      evidence,
      blocking_reason: report.status === 'available' ? row.blocking_reason : (row.blocking_reason || report.recommendedAction),
      payload: {
        ...(row.payload && typeof row.payload === 'object' ? row.payload : {}),
        sheet_availability: report.payload
      }
    };
  });
  if (enrichedAny) return enrichedRows;
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
    title: `${customerName} 확인요청 시트 입력 확인 필요`,
    summary: `GAS가 확인요청 입력을 거절했습니다: ${error}`,
    recommended_action: '날짜/시간/장비명/드롭다운 값을 확인한 뒤 확인요청을 수동 수정하거나 고객에게 필요한 정보를 다시 확인하세요.',
    suggested_reply_draft: '감독님, 확인 후 바로 안내드리겠습니다.',
    evidence: [requestSummary, error].filter(Boolean).slice(0, 12),
    blocking_reason: error,
    due_hint: 'now',
    decision_classification: 'sheet_write_rejected',
    decision_confidence: 'blocked',
    payload: {
      sheet_error_type: sheetResult.error_type,
      sheet_error: error,
      sheet_request: sheetPayload?.args || null,
      decision_classification: decision?.classification || null
    }
  }];
}

export function buildHermesArgs(prompt) {
  return ['chat', '--yolo', '-Q', '-t', 'terminal,computer_use,vision', '-q', prompt];
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
    await devtoolsFetchTextWithFallbackMethod(cdpBaseUrl, `/json/activate/${encodeURIComponent(existing.id)}`, { fetchImpl, timeoutMs });
    return { status: 'focused_list_via_devtools', targetId: existing.id, url: existing.url || '' };
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

export async function closeKakaoConversationWindow(windowInfo = {}, { timeoutMs = 10000, spawnImpl = spawn } = {}) {
  if (process.platform !== 'darwin') return { status: 'skipped_non_macos' };
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

export function pickKakaoMainListWindow(windows = []) {
  const candidates = windows.filter((w) =>
    String(w.app_name || '').includes('Chrome') &&
    String(w.title || '').includes('카카오비즈니스 파트너센터') &&
    !String(w.title || '').includes(' - 빌리지 - ')
  );
  candidates.sort((a, b) => {
    const aScore = (a.is_on_screen ? 1000 : 0) + ((a.bounds?.width || 0) * (a.bounds?.height || 0));
    const bScore = (b.is_on_screen ? 1000 : 0) + ((b.bounds?.width || 0) * (b.bounds?.height || 0));
    return bScore - aScore;
  });
  return candidates[0] || null;
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

export function pickKakaoConversationWindow(windows = [], hints = []) {
  const candidates = windows.filter((w) => {
    const title = String(w.title || '');
    return String(w.app_name || '').includes('Chrome') &&
      title.includes(' - 빌리지 - 카카오비즈니스') &&
      hints.some((hint) => title.includes(hint));
  });
  candidates.sort((a, b) => Number(b.is_on_screen) - Number(a.is_on_screen));
  return candidates[0] || null;
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

function buildKakaoSearchAndOpenExpression(searchTerms = [], hints = []) {
  return `(${async function kakaoSearchAndOpen(searchTermsArg, hintsArg) {
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
  }.toString()})(${JSON.stringify(searchTerms)}, ${JSON.stringify(hints)})`;
}

function buildKakaoConversationTextExpression() {
  return `(() => ({ title: document.title, href: location.href, text: document.body?.innerText || '' }))()`;
}

export async function openKakaoTargetChatViaDevtools(job, {
  cdpBaseUrl = kakaoDevtoolsBaseUrlFromEnv(),
  timeoutMs = 20000,
  fetchImpl = fetch,
  evaluateImpl = devtoolsEvaluateOnTarget
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
  const openResult = await evaluateImpl(mainTarget, buildKakaoSearchAndOpenExpression(searchTerms, hints), { timeoutMs });
  if (!openResult?.ok) {
    return {
      status: openResult?.status || 'devtools_search_failed',
      hints,
      via_devtools: true,
      search: {
        searched: true,
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
        searched: true,
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
      searched: true,
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
  const reply = decision.reply_decision && typeof decision.reply_decision === 'object' ? decision.reply_decision : {};
  const mode = String(reply.replyMode || reply.reply_mode || '').trim();
  const confidence = String(reply.confidence || decision.confidence || '').trim();
  const textValue = text(reply.text || decision.suggested_reply_draft).trim();
  const killSwitch = String(decision.kill_switch_observed || '').trim();
  const classification = String(decision.classification || '').trim();
  const priceLikeClassifications = new Set(['price', 'price_review', 'quote_send']);
  if (killSwitch === 'paused') return { allowed: false, reason: 'kill_switch_paused' };
  if (killSwitch === 'price_paused' && priceLikeClassifications.has(classification)) return { allowed: false, reason: 'kill_switch_price_paused' };
  if (killSwitch !== 'active' && killSwitch !== 'price_paused') return { allowed: false, reason: `kill_switch_${killSwitch || 'unknown'}` };
  if (mode !== 'auto_send') return { allowed: false, reason: `replyMode_${mode || 'missing'}` };
  if (confidence !== 'high') return { allowed: false, reason: `confidence_${confidence || 'missing'}` };
  if (!textValue || textValue.length < 5) return { allowed: false, reason: 'reply_text_too_short' };
  if (textValue.length > 1000) return { allowed: false, reason: 'reply_text_too_long' };
  if (decision?.safety_checks?.kakao_conversation_opened !== true) return { allowed: false, reason: 'conversation_not_opened' };
  if (decision?.safety_checks?.did_not_classify_from_preview_only !== true) return { allowed: false, reason: 'preview_only' };
  if (decision?.safety_checks?.latest_customer_message_after_last_staff_reply !== true) return { allowed: false, reason: 'latest_turn_not_customer' };
  const blockedClassifications = new Set(['price', 'reservation', 'reservation_request', 'reservation_review', 'payment', 'payment_check', 'schedule_check', 'damage_repair']);
  if (blockedClassifications.has(classification)) return { allowed: false, reason: `classification_${classification}_requires_review` };
  if (decision.owner_review_required === true || decision.ownerReviewRequired === true) return { allowed: false, reason: 'owner_review_required' };
  const blocked = ['refund', '환불', '분실', '파손', '손상', '결제 취소', '예약 확정', '재고 가능', '가능 확정', '가능합니다', '대여 가능', '예약 가능', '확정', '만원', ' 원', '입금', '계좌', '금액'];
  if (blocked.some((word) => textValue.includes(word))) return { allowed: false, reason: 'sensitive_commitment_text' };
  return { allowed: true, reason: 'allowed', text: textValue, replyMode: mode, confidence };
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
  evaluateImpl = devtoolsEvaluateOnTarget
} = {}) {
  const target = navigationContext?.conversation_target;
  if (!target?.webSocketDebuggerUrl) return { sent: false, reason: 'conversation_target_missing' };
  const result = await evaluateImpl(target, buildKakaoSendMessageExpression(textToSend), { timeoutMs });
  return {
    sent: Boolean(result?.sent),
    reason: result?.reason || 'devtools_send_unknown',
    window_title: result?.window_title || target.title || '',
    via_devtools: true
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

export async function sendKakaoMessageViaChrome(textToSend, navigationContext = {}, {
  timeoutMs = 20000,
  spawnImpl = spawn,
  cuaDriverCommand = 'cua-driver',
  evaluateImpl = devtoolsEvaluateOnTarget,
  controlMode = process.env.KAKAO_WORKER_CONTROL_MODE,
  cuaMinIdleSeconds = numberFromEnv(process.env.KAKAO_CUA_MIN_IDLE_SECONDS, 0),
  execFileImpl = execFile
} = {}) {
  if (navigationContext?.conversation_target?.webSocketDebuggerUrl) {
    return sendKakaoMessageViaDevtools(textToSend, navigationContext, { timeoutMs, evaluateImpl });
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
  return {
    sent: true,
    reason: 'sent_via_chrome_verified',
    window_title: win.title || verifyState.title || state.title || '',
    element_index: elementIndex,
    send_button_index: clickResult?.sendButtonIndex || sendButtonIndex || null,
    retried_after_frontmost_activation: Boolean(clickResult?.retriedAfterFrontmostActivation)
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
  const customer = normalizeAutoReplyText(decision?.customer?.name || decision?.customer_name || '');
  const customerEvidence = Array.isArray(decision?.visible_messages_used)
    ? [...decision.visible_messages_used].reverse().find((item) => String(item?.sender || '').includes(customer) || !String(item?.sender || '').includes('빌리지'))
    : null;
  const customerMessage = normalizeAutoReplyText(customerEvidence?.message || job.preview_text || job.previewText || job.payload?.previewText || '');
  const reply = normalizeAutoReplyText(replyText || decision?.reply_decision?.text || decision?.suggested_reply_draft || '');
  return [customer, customerMessage, reply].filter(Boolean).join('|').slice(0, 500);
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

export function isAutoSendEligibleLiveJob(job = {}) {
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
  if (/\d{1,2}월\s*\d{1,2}일/.test(preview)) return { eligible: false, reason: 'preview_has_old_date' };
  if (/\d{4}\.\d{1,2}\.\d{1,2}/.test(preview)) return { eligible: false, reason: 'preview_has_absolute_date' };
  if (hasUnread) return { eligible: true, reason: 'top_row_unread' };
  if (!/(오전|오후)\s*\d{1,2}:\d{2}/.test(preview)) return { eligible: false, reason: 'preview_not_live_time_format' };
  return { eligible: true, reason: 'top_row_live_time_format' };
}

async function maybeAutoSendReply({ config, decision, job, navigationContext }) {
  const liveGate = isAutoSendEligibleLiveJob(job);
  if (!liveGate.eligible) {
    const result = { attempted: false, sent: false, gate: { allowed: false, reason: liveGate.reason } };
    logAutoReply(config, { jobId: job.id || job.jobId || null, result, customer: decision?.customer?.name || '', classification: decision?.classification || '', preview: job.preview_text || job.previewText || '' });
    return result;
  }
  const gate = canAutoSendCustomerAnswer(decision, config);
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
  let sendResult;
  try {
    sendResult = await sendKakaoMessageViaChrome(gate.text, navigationContext, {
      timeoutMs: config.autoSendTimeoutMs,
      cuaDriverCommand: config.cuaDriverCommand,
      controlMode: config.workerControlMode,
      cuaMinIdleSeconds: config.cuaMinIdleSeconds
    });
  } catch (error) {
    sendResult = { sent: false, reason: 'send_error', error: error.message.slice(0, 500) };
  }
  const result = { attempted: true, sent: Boolean(sendResult.sent), gate, sendResult, text: gate.text };
  logAutoReply(config, { jobId: job.id || job.jobId || null, result, customer: decision?.customer?.name || '', classification: decision?.classification || '', evidence: decision?.visible_messages_used || [], dedupeKey });
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
  preferDevtools = normalizeKakaoWorkerControlMode(controlMode) !== 'cua_first'
} = {}) {
  const hints = extractNavigationHints(job);
  if (!hints.length) return { status: 'no_navigation_hints' };
  let devtoolsFirst = null;
  if (preferDevtools) {
    devtoolsFirst = await openKakaoTargetChatViaDevtools(job, { timeoutMs, cdpBaseUrl, fetchImpl, evaluateImpl }).catch((error) => ({
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
  const existingConversationWindow = pickKakaoConversationWindow(windows, hints);
  if (existingConversationWindow && existingConversationWindow.is_on_screen !== false) {
    const conversationEvidence = await captureKakaoConversationEvidenceFromWindow(existingConversationWindow, hints, {
      timeoutMs,
      spawnImpl,
      cuaDriverCommand
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
  if (existingConversationWindow?.is_on_screen === false) {
    const devtoolsExisting = await openKakaoTargetChatViaDevtools(job, { timeoutMs, cdpBaseUrl, fetchImpl, evaluateImpl }).catch(() => null);
    if (devtoolsExisting?.status === 'opened_target_chat') return devtoolsExisting;
  }
  const win = pickKakaoMainListWindow(windows);
  if (!win) {
    return openKakaoTargetChatViaDevtools(job, { timeoutMs, cdpBaseUrl, fetchImpl, evaluateImpl }).catch((error) => ({
      status: 'main_list_window_not_found',
      hints,
      devtoolsFallbackError: error.message.slice(0, 500)
    }));
  }
  const stateText = await spawnText(cuaDriverCommand, [
    'call', 'get_window_state', JSON.stringify({ pid: win.pid, window_id: win.window_id, max_elements: 700 }), '--compact'
  ], { timeoutMs, spawnImpl });
  const state = JSON.parse(stateText);
  let elementIndex = findChatRowElementIndex(state.tree_markdown || '', hints);
  let searchResult = null;
  if (!elementIndex) {
    searchResult = await findChatRowElementIndexViaSearch({
      win,
      hints,
      initialTreeMarkdown: state.tree_markdown || '',
      cuaDriverCommand,
      timeoutMs,
      spawnImpl
    });
    elementIndex = searchResult.elementIndex;
  }
  if (!elementIndex) {
    const devtoolsFallback = await openKakaoTargetChatViaDevtools(job, { timeoutMs, cdpBaseUrl, fetchImpl, evaluateImpl }).catch((error) => ({
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
            search_input_found: Boolean(searchResult.searchInputIndex),
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
    conversationWindow = pickKakaoConversationWindow(windowsAfterClick, hints);
    if (!conversationWindow) {
      return {
        status: 'conversation_window_not_found_after_click',
        hints,
        pid: win.pid,
        window_id: win.window_id,
        conversation_window: null,
        element_index: elementIndex,
        conversation_evidence: {
          source: 'live_kakao_ax_after_navigation',
          hint_matched: false,
          evidence_status: 'insufficient',
          note: 'Clicked the matching chat row, but no individual Kakao customer conversation popup was found. AI must not classify this job as verified from the conversation screen.'
        }
      };
    }
    conversationEvidence = await captureKakaoConversationEvidenceFromWindow(conversationWindow, hints, {
      timeoutMs,
      spawnImpl,
      cuaDriverCommand
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
          search_input_found: Boolean(searchResult.searchInputIndex),
          search_term: searchResult.searchTerm || null,
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
  const timeoutMs = Number(config.hermesTimeoutMs || 180000);
  return new Promise((resolve, reject) => {
    const child = spawnImpl(config.hermesCommand, buildHermesArgs(prompt), {
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: path.resolve(__dirname, '../..'),
      detached: true,
      env: {
        ...process.env,
        HERMES_COMPUTER_USE_DEFAULT_CAPTURE_MODE: process.env.HERMES_COMPUTER_USE_DEFAULT_CAPTURE_MODE || 'ax',
        HERMES_COMPUTER_USE_FORCE_CAPTURE_MODE: process.env.HERMES_COMPUTER_USE_FORCE_CAPTURE_MODE || 'ax',
        HERMES_COMPUTER_USE_DEFAULT_MAX_ELEMENTS: process.env.HERMES_COMPUTER_USE_DEFAULT_MAX_ELEMENTS || '80'
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

async function runAiAndMaybeWrite({ config, job, dryRun, fakeDecisionPath }) {
  let navigationContext = null;
  const result = {};
  try {
    if (!dryRun && config.ensureKakaoTab) {
      await ensureKakaoChannelManagerTab({ url: config.kakaoChannelManagerUrl });
      if (config.openTargetChat) {
        navigationContext = await openKakaoTargetChatFromList(job, {
          cuaDriverCommand: config.cuaDriverCommand,
          controlMode: config.workerControlMode,
          cuaMinIdleSeconds: config.cuaMinIdleSeconds
        }).catch((error) => ({
          status: 'navigation_failed',
          reason: error.message.slice(0, 500)
        }));
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
    if (fakeDecisionPath) {
      decision = JSON.parse(fs.readFileSync(fakeDecisionPath, 'utf8'));
    } else {
      hermesOutput = await runHermes(prompt, config);
      decision = extractJsonObject(hermesOutput);
    }

    const sheetPayload = buildSheetAppendPayload(decision, { apiKey: config.sheetApiKey });
    const sheetResult = await appendToSheet(config, sheetPayload);
    const autoReplyResult = sheetResult?.success === false
      ? { attempted: false, sent: false, reason: 'sheet_write_rejected_no_auto_send', sheetErrorType: sheetResult.error_type }
      : await maybeAutoSendReply({ config, decision, job, navigationContext });
    const baseFollowUpRows = [
      ...buildFollowUpRows(decision, job),
      ...buildSheetFailureFollowUpRows(decision, job, sheetResult, sheetPayload)
    ];
    const existingRequestResult = sheetResult
      ? null
      : await fetchExistingConfirmRequestResultForDecision(config, decision, baseFollowUpRows);
    const availabilityAwareRows = enrichFollowUpRowsWithSheetAvailability(
      baseFollowUpRows,
      sheetResult || existingRequestResult,
      sheetPayload,
      decision,
      job
    );
    const followUpRows = filterFollowUpRowsAfterAutoReply(availabilityAwareRows, autoReplyResult);
    let followUpResult;
    try {
      followUpResult = await upsertFollowUpRows(config, followUpRows);
    } catch (error) {
      followUpResult = { inserted: 0, error: error.message, rows: followUpRows };
    }
    const slackDeliveryResult = await deliverSlackFollowUpRows(config, followUpResult.rows || []);
    Object.assign(result, { status: 'ai_completed', decision, sheetResult, existingRequestResult, followUpResult, slackDeliveryResult, autoReplyResult, hermesOutputTail: hermesOutput.slice(-4000) });
    return result;
	  } finally {
	    if (!dryRun && navigationContext?.conversation_window) {
	      try {
	        result.closeResult = await closeKakaoConversationWindow(navigationContext.conversation_window);
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

export async function processManualSend({ customerName = '', roomTitle = '', text: replyText = '', followUpId = '' } = {}) {
  loadEnvFile(path.resolve(process.env.HOME || '', '.hermes/.env'));
  loadEnvFile(path.resolve(__dirname, '../kakao-dom-bridge/.env'));
  loadEnvFile(path.resolve(__dirname, '.env'));
  const config = requireConfig();
  const cleanText = text(replyText).trim();
  const cleanCustomer = text(customerName).trim();
  const cleanRoomTitle = text(roomTitle).trim();
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
  }, { timeoutMs: config.autoSendTimeoutMs }).catch((error) => ({
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
        }, { timeoutMs: config.autoSendTimeoutMs });
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
          cuaMinIdleSeconds: config.cuaMinIdleSeconds
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
