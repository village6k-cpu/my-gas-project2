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
        col: 1,
        query: '{AI_ENCODED_REQ_ID_OR_NAME}'
      }),
      contract_master_recent_gviz: buildGvizUrl('계약마스터', "SELECT A,B,E,G,J WHERE J='예약' ORDER BY A DESC LIMIT 80"),
      schedule_detail_by_trade_id_gviz_template: buildGvizUrl('스케줄상세', "SELECT B,C,D,E,F,H WHERE B='{AI_TRADE_ID}' LIMIT 50"),
      request_recent_gviz: buildGvizUrl('확인요청', "SELECT K,B,F WHERE K!='' ORDER BY A DESC LIMIT 50")
    },
    note: 'These URLs are read-only lookup aids. AI must decide what to query and how to interpret results. Do not use write/run/register/send actions.'
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
- 답장/시트 처리에 과도하게 보수적으로 굴지 않는다. 현재 코드 경로에서 카카오 실제 전송 함수가 없으면 suggested_reply_draft를 만들고, 전송 기능이 연결된 환경에서는 kill switch 정책에 맞춰 자동답장 후보로 취급한다.
- 예약 확정, 재고 가능 단정, 가격 확정은 화면/시트 근거 없이 단정하지 않는다. 하지만 고객이 예약형식에 맞게 정보를 준 경우 확인요청 시트 입력은 적극 수행한다.
- Google Sheets 입력은 API로 가능하다. 어떤 값을 넣을지는 AI가 판단하되, 예약형식이 충분하면 should_write_to_sheet=true를 기본값으로 둔다.

CLAUDE COWORKER POLICY TO CARRY FORWARD:
- 최근 1시간 내 새 메시지 후보라도 반드시 채팅방을 열고, 화면에서 보이는 메시지 + 가능하면 최근 24시간 맥락을 확인한다.
- 고객의 마지막 문의에 대해 직원(빌리지님/김준영님/최재형님)이 이미 답변했는지 확인한다. 직원이 이미 답변했으면 새 답장 초안은 만들지 말고, 미등록 예약 여부만 검토한다.
- 예약/가격/FAQ/무시를 AI가 분류한다. 미리보기 텍스트만으로 예약·가격·FAQ를 확정하지 않는다.
- 킬 스위치 상태는 paused / price_paused / active 중 하나다. paused면 실제 자동 발송은 중단하고 시트/대시보드 기록은 계속한다. price_paused면 가격 자동 응답만 중단한다.
- FAQ 고정 답변 후보: 주소=서울 마포구 동교로 23길 32, 2층 / 네이버 지도=https://naver.me/5mIWTFQ1 / 영업시간=24시간 운영 / 절차=장비명+기간 전달→가용확인→방문수령→반납.
- 가격 문의는 단가·할인 계산 초안을 만들고 follow_up_items에 quote_send/price_review를 남긴다.

SENDER AND TURN-TAKING POLICY:
- 반드시 각 visible message를 staff/outbound와 customer/inbound로 구분한다. 내/직원/채널 발화는 고객 요청으로 취급하면 안 된다.
- Staff/outbound labels include: 빌리지님, 김준영님, 최재형님, 운영자/상담원/매니저로 보이는 채널 측 발화, and any message visually on the business/outbound side.
- Customer/inbound is the chat customer/nickname side, determined from the Kakao room title, bubble side/labels, and surrounding message order. A nickname like hellodesk may be a customer if it is the room/customer side; do not assume from text alone.
- The actionable trigger is the latest customer/inbound message or a cluster of consecutive customer/inbound messages after the last staff/outbound reply. If the newest meaningful message is staff/outbound, classify already_answered or ignore and do not write a new reservation row.
- Customers often split one thought across several bubbles. Merge consecutive customer/inbound messages within the same recent turn before classification, e.g. "안녕하세요" + "27일날" + "fx3 가능한가요?" = one reservation/availability question.
- For Sheets append, safety_checks.latest_customer_message_after_last_staff_reply must be true. If sender order is unclear, set it false and should_write_to_sheet=false.

EQUIPMENT AND SHEET SAFETY POLICY:
- 장비명은 세트마스터 또는 목록 시트의 정확한 이름을 우선 사용한다. 다만 고객이 예약형식에 맞게 장비/일정/시간을 충분히 준 경우, exact name 검증이 완벽하지 않아도 확인요청 시트 입력을 막지 않는다. 이 경우 item에는 AI가 가장 그럴듯하게 정규화한 이름을 쓰고 memo에 원문/검증필요를 남긴다.
- 약어/속어는 검색 키워드 힌트다. 예: FX3 -> 세트마스터 검색 후 소니 FX3 바디세트 같은 정확한 이름 사용, A7S3 -> 세트마스터 검색 후 정확한 이름 사용, FX6/FX9/A7M4/A7C2도 동일. 검색 실패 시에도 예약형식이 충분하면 best-effort normalized_guess로 확인요청에 넣고 memo에 원문을 남긴다.
- 렌즈 힌트: 70-200 GM II -> 소니 GM 70-200mm II, 24-70 GM II -> 소니 GM 24-70mm II, 16-35 -> 소니 GM 16-35mm.
- 조명/기타 힌트: 600x -> 어퓨쳐 600X, 파보튜브 30xr -> 파보튜브 II 30XR, 시대/C대 -> C스탠드, 줌 F6/윈 F6 -> 줌 F6.
- 할인유형은 학생 / 개인사업자/프리랜서 / 일반 중 하나만 쓴다. 단골 또는 제휴는 절대 쓰지 말고 일반으로 둔다. 단골/제휴 여부는 GAS/고객DB가 판단한다.
- 중복 입력 방지: 가능하면 계약마스터, 스케줄상세, 확인요청 3단계를 확인한다. 그러나 고객 최신 메시지가 예약형식(장비 + 기간/날짜 + 수령/반납 시간 또는 그에 준하는 정보)에 맞으면 중복확인이 일부 불완전해도 should_write_to_sheet=true로 둔다. 명백히 이미 등록된 동일 예약을 찾은 경우에만 쓰지 않는다.
- 예약형식에 맞춰 들어온 건은 확인요청 시트 입력이 기본 동작이다. 불확실한 장비명/중복확인/전화번호 누락은 입력 차단 사유가 아니라 memo/extra_request에 남길 보완사항이다.

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
1. First prefer terminal-driven CUA for Kakao navigation because it can filter text and avoid huge model payloads. Allowed terminal commands are limited to read/navigation tools: "cua-driver call list_windows --compact", "cua-driver call get_window_state ... --compact", "cua-driver call page ... get_text/query_dom", and "cua-driver call click ..." on a Kakao chat-list row. CRITICAL: never print raw full AX/page output. Always pipe through Python filtering and print at most 2000 characters total, centered on navigation_hints/customer name and the chosen element_index/window_id. Do not use terminal to write Sheets or send Kakao messages.
2. Use this filtering pattern for CUA output instead of printing raw JSON/tree: run the cua-driver command to a /tmp file, then a short python script that extracts only Kakao main-list window_id/pid and lines containing the navigation hint plus +/- 300 chars. The terminal output should be <= 2000 chars.
3. If BROWSER NAVIGATION RESULT says opened_target_chat with hint_matched=true, start from its live AX conversation_evidence and do not re-open the chat list. Use computer_use or terminal CUA only if that evidence is insufficient/mismatched or you need a very small additional read-only capture.
4. Use computer_use read-only capture only if needed. The worker forces capture mode="ax" and max_elements=80 for speed; do not request image/vision capture in the autonomous worker. If AX text is insufficient after navigation attempts, return unclear instead of escalating to screenshot capture.
5. Use JOB EVIDENCE navigation_hints only to find/open the target Kakao chat. This is navigation evidence, not business classification evidence.
6. If the currently open conversation title/messages do not match the navigation_hints/preview_text, go back to the Kakao chat list or use the visible Kakao search/chat-list UI to find the matching customer/room. You may click/type only for navigation inside Kakao; never type into the message compose box and never send.
7. Read visible conversation content and recent context; separate staff/outbound vs customer/inbound before classifying. Merge consecutive customer bubbles in the latest customer turn; do not treat staff/outbound messages as customer requests.
8. If RAG is enabled and useful, call the village-ai helper only after reading the Kakao screen. Build the RAG question by briefly embedding the visible Kakao context and latest customer/inbound message cluster in the question string. Use RAG only for price/discount/components/procedure/FAQ, prior tone/policy reference, or ambiguous follow-up wording; never for current inventory availability, booking confirmation, Sheets/contract/schedule mutation, or duplicate checks.
9. RAG interpretation: confidence=high can inform a reply draft but still cannot assert inventory/booking; confidence=low is tone/policy hint only; no_match/empty/error means ignore RAG; ownerReview=true means extra human verification before any future auto-send; knowledgeSource=general is not firm village policy.
10. Decide whether this is reservation inquiry, price inquiry, FAQ, ignored message, or already-answered message.
11. For reservation-format customer requests, prefer should_write_to_sheet=true and fill sheet_row_candidate best-effort. Missing phone, imperfect exact equipment verification, or incomplete duplicate lookup should be written into memo/extra_request rather than blocking the 확인요청 row. Only set should_write_to_sheet=false when this is clearly not a reservation, the target Kakao conversation was not opened, the newest actionable message is staff/outbound, sender order is unclear, or an obvious duplicate/already-registered booking was found.
12. Create follow_up_items for every human action the owner should see next: reply_needed, quote_send, tax_invoice, schedule_check, reservation_review, price_review, payment_check, contract_document, return_extension, damage_repair, sheet_duplicate_check, completed_log. Use an empty array only when no human follow-up is needed.
13. If a reply is useful, produce suggested_reply_draft and a reply_needed/quote_send follow_up_item. If future Kakao-send plumbing is connected, this draft may be sent automatically according to kill switch policy; do not be over-conservative in drafting.
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
    "equipment_requested": [{ "raw_text": string, "normalized_guess": string | null, "exact_name_from_set_master": string | null, "confidence": "low" | "medium" | "high" }],
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
    "request_id": string,
    "customer_name": string,
    "item": string,
    "start_date": string,
    "end_date": string,
    "pickup_time": string,
    "return_time": string,
    "quantity": number | string | "",
    "phone": string,
    "discount_type": "학생" | "개인사업자/프리랜서" | "일반" | "",
    "memo": string,
    "extra_request": string
  },
  "suggested_human_review_action": string,
  "suggested_reply_draft": string
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

function hasRequiredSheetSafetyChecks(decision) {
  const checks = decision?.safety_checks || {};
  return REQUIRED_SHEET_SAFETY_CHECKS.every((key) => checks[key] === true);
}

export function buildSheetAppendPayload(decision, options = {}) {
  if (!decision || decision.should_write_to_sheet !== true) return null;
  if (!hasRequiredSheetSafetyChecks(decision)) return null;
  const row = decision.sheet_row_candidate || {};
  const requestId = text(row.request_id) || `AI-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`;
  const memo = text(row.memo || decision.reason);
  const extra = text(row.extra_request || decision.suggested_human_review_action || '');
  return {
    key: options.apiKey || DEFAULT_SHEET_API_KEY,
    action: 'append',
    sheet: '확인요청',
    values: [[
      requestId,
      text(row.start_date),
      text(row.pickup_time),
      text(row.end_date),
      text(row.return_time),
      text(row.item),
      row.quantity ?? '',
      '',
      'AI_REVIEW',
      memo,
      text(row.customer_name || decision.customer?.name),
      text(row.phone),
      text(row.discount_type || decision.reservation_inquiry?.discount_type),
      '',
      'AI-대기',
      '',
      'AI가 카카오 화면을 읽고 생성한 후보 행. 사람 검토 후 확인/등록 실행.',
      extra
    ]]
  };
}

export function buildFollowUpRows(decision, job = {}) {
  const items = Array.isArray(decision?.follow_up_items) ? decision.follow_up_items : [];
  const jobId = job.id || job.jobId || null;
  const roomKey = job.room_key || job.roomKey || job.payload?.roomKey || '';
  const fallbackCustomer = decision?.customer?.name || job.payload?.customerName || '';
  const allowedTypes = new Set([
    'reply_needed', 'quote_send', 'tax_invoice', 'schedule_check', 'reservation_review',
    'price_review', 'payment_check', 'contract_document', 'return_extension', 'damage_repair',
    'sheet_duplicate_check', 'completed_log'
  ]);
  const allowedPriorities = new Set(['urgent', 'high', 'normal', 'low']);
  const allowedStatuses = new Set(['open', 'done', 'dismissed']);

  return items
    .filter((item) => item && typeof item === 'object')
    .map((item, index) => {
      const type = allowedTypes.has(String(item.type)) ? String(item.type) : 'reply_needed';
      const priority = allowedPriorities.has(String(item.priority)) ? String(item.priority) : 'normal';
      const status = allowedStatuses.has(String(item.status)) ? String(item.status) : 'open';
      const title = text(item.title).slice(0, 240) || `${type} follow-up`;
      const customerName = text(item.customer_name || item.customerName || fallbackCustomer).slice(0, 120);
      const hash = createHash('sha256')
        .update(JSON.stringify({ jobId, roomKey, index, type, title, customerName }))
        .digest('hex')
        .slice(0, 24);
      return {
        follow_up_key: `${jobId || roomKey || 'job'}:${index}:${hash}`,
        source: 'kakao_ai_worker',
        job_id: jobId,
        room_key: roomKey,
        customer_name: customerName,
        type,
        priority,
        status,
        title,
        summary: text(item.summary).slice(0, 3000),
        recommended_action: text(item.recommended_action || item.recommendedAction).slice(0, 3000),
        suggested_reply_draft: text(item.suggested_reply_draft || item.suggestedReplyDraft).slice(0, 3000),
        evidence: Array.isArray(item.evidence) ? item.evidence.map((v) => text(v)).filter(Boolean).slice(0, 12) : [],
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
  const inserted = await supabaseFetch(config, `${table}?on_conflict=follow_up_key`, {
    method: 'POST',
    headers: supabaseHeaders(config, 'resolution=merge-duplicates,return=representation'),
    body: JSON.stringify(rows)
  });
  return { inserted: Array.isArray(inserted) ? inserted.length : rows.length, rows: inserted };
}

export function mapDecisionToStatusPatch(decision, context = {}) {
  if (decision?.should_write_to_sheet === true && context.sheetResult?.success === true) {
    return { status: 'needs_human_review', error_message: null };
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
    hermesCommand: process.env.HERMES_WORKER_COMMAND || 'hermes',
    hermesTimeoutMs: Number(process.env.HERMES_WORKER_TIMEOUT_MS || '180000'),
    ensureKakaoTab: process.env.KAKAO_WORKER_ENSURE_TAB !== '0',
    kakaoChannelManagerUrl: process.env.KAKAO_CHANNEL_MANAGER_URL || DEFAULT_KAKAO_CHANNEL_MANAGER_URL,
    openTargetChat: process.env.KAKAO_WORKER_OPEN_TARGET_CHAT !== '0',
    villageAiUrl: process.env.VILLAGE_AI_URL || '',
    villageAiKakaoSkillSecret: process.env.VILLAGE_AI_KAKAO_SKILL_SECRET || process.env.KAKAO_SKILL_SECRET || '',
    ragTimeoutMs: Number(process.env.VILLAGE_AI_RAG_TIMEOUT_MS || 30000) || 30000,
    followUpTable: process.env.SUPABASE_FOLLOW_UP_TABLE || 'ai_follow_up_items'
  };
  if (!config.supabaseUrl || !config.serviceRoleKey) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Load tools/kakao-dom-bridge/.env first.');
  }
  return config;
}

async function supabaseFetch(config, pathAndQuery, init = {}) {
  const endpoint = `${config.supabaseUrl.replace(/\/$/, '')}/rest/v1/${pathAndQuery}`;
  const response = await fetch(endpoint, init);
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
  const response = await fetch(`${config.gasApiUrl}?key=${encodeURIComponent(config.sheetApiKey)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...payload, key: config.sheetApiKey })
  });
  const textBody = await response.text();
  let data;
  try { data = JSON.parse(textBody); } catch { data = { raw: textBody }; }
  if (!response.ok || data?.error) throw new Error(`GAS Sheets append failed: ${response.status} ${JSON.stringify(data)}`);
  return data;
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
      make new window with properties {URL:targetUrl}
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

export async function ensureKakaoChannelManagerTab({ url = DEFAULT_KAKAO_CHANNEL_MANAGER_URL, timeoutMs = 10000, spawnImpl = spawn } = {}) {
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
  for (const line of treeMarkdown.split('\n')) {
    if (!line.includes('AXLink')) continue;
    if (!safeHints.some((hint) => line.includes(hint))) continue;
    if (line.includes('채팅') || line.includes('카카오')) continue;
    const match = line.match(/\[(\d+)\]\s+AXLink/);
    if (match) return Number(match[1]);
  }
  return null;
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

export async function openKakaoTargetChatFromList(job, { timeoutMs = 20000, spawnImpl = spawn } = {}) {
  const hints = extractNavigationHints(job);
  if (!hints.length) return { status: 'no_navigation_hints' };
  const windowsText = await spawnText('cua-driver', ['call', 'list_windows', '--compact'], { timeoutMs, spawnImpl });
  const windows = JSON.parse(windowsText).windows || [];
  const win = pickKakaoMainListWindow(windows);
  if (!win) return { status: 'main_list_window_not_found', hints };
  const stateText = await spawnText('cua-driver', [
    'call', 'get_window_state', JSON.stringify({ pid: win.pid, window_id: win.window_id, max_elements: 700 }), '--compact'
  ], { timeoutMs, spawnImpl });
  const state = JSON.parse(stateText);
  const elementIndex = findChatRowElementIndex(state.tree_markdown || '', hints);
  if (!elementIndex) return { status: 'chat_row_not_found', hints, window_id: win.window_id, pid: win.pid };
  await spawnText('cua-driver', [
    'call', 'click', JSON.stringify({ pid: win.pid, window_id: win.window_id, element_index: elementIndex }), '--compact'
  ], { timeoutMs, spawnImpl });
  await new Promise((resolve) => setTimeout(resolve, 1200));
  let conversationEvidence = null;
  let conversationWindow = null;
  try {
    const windowsAfterClickText = await spawnText('cua-driver', ['call', 'list_windows', '--compact'], { timeoutMs, spawnImpl });
    const windowsAfterClick = JSON.parse(windowsAfterClickText).windows || [];
    conversationWindow = pickKakaoConversationWindow(windowsAfterClick, hints) || win;
    const openedStateText = await spawnText('cua-driver', [
      'call', 'get_window_state', JSON.stringify({ pid: conversationWindow.pid, window_id: conversationWindow.window_id, max_elements: 520 }), '--compact'
    ], { timeoutMs, spawnImpl, maxBuffer: 3_000_000 });
    const openedState = JSON.parse(openedStateText);
    conversationEvidence = extractKakaoConversationEvidence(openedState.tree_markdown || '', {
      title: conversationWindow.title || openedState.title || openedState.window_title || '',
      hints,
      maxItems: 80
    });
  } catch (error) {
    conversationEvidence = { source: 'live_kakao_ax_after_navigation', error: error.message.slice(0, 300) };
  }
  return { status: 'opened_target_chat', hints, pid: win.pid, window_id: win.window_id, conversation_window: conversationWindow ? { pid: conversationWindow.pid, window_id: conversationWindow.window_id, title: conversationWindow.title || '' } : null, element_index: elementIndex, conversation_evidence: conversationEvidence };
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
  if (!dryRun && config.ensureKakaoTab) {
    await openKakaoChannelManagerUrl({ url: config.kakaoChannelManagerUrl });
    if (config.openTargetChat) {
      navigationContext = await openKakaoTargetChatFromList(job).catch((error) => ({
        status: 'navigation_failed',
        reason: error.message.slice(0, 500)
      }));
    }
  }
  const lookupContext = await buildReadOnlyLookupContext(config, job);
  const ragContext = buildReadOnlyRagContext(config);
  const prompt = buildHermesPrompt(job, { gasApiUrl: config.gasApiUrl, lookupContext, navigationContext, ragContext });
  if (dryRun) {
    return { status: 'dry_run', job: summarizeJob(job), lookupContext, ragContext, prompt };
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
  const followUpRows = buildFollowUpRows(decision, job);
  let followUpResult;
  try {
    followUpResult = await upsertFollowUpRows(config, followUpRows);
  } catch (error) {
    followUpResult = { inserted: 0, error: error.message, rows: followUpRows };
  }
  return { status: 'ai_completed', decision, sheetResult, followUpResult, hermesOutputTail: hermesOutput.slice(-4000) };
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
  loadEnvFile(path.resolve(__dirname, '../kakao-dom-bridge/.env'));
  loadEnvFile(path.resolve(__dirname, '.env'));
  const config = requireConfig();
  return runAiAndMaybeWrite({ config, job: stdinJob, dryRun, fakeDecisionPath });
}

export async function processOneJob({ dryRun = false, claim = true, fakeDecisionPath = '' } = {}) {
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
          hermes_output_tail: aiResult.hermesOutputTail
        }
      }
    });
    return { status: 'processed', jobId: workingJob.id, decision: aiResult.decision, sheetResult: aiResult.sheetResult, followUpResult: aiResult.followUpResult };
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
