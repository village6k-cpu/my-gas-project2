import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { processManualSend, upsertFollowUpRows } from '../ai-browser-worker/worker.mjs';

const CONFIG = {
  port: Number(process.env.PORT || 8787),
  debounceMs: Number(process.env.DEBOUNCE_MS || 90_000),
  maxWaitMs: Number(process.env.MAX_WAIT_MS || 300_000),
  startupMutationIgnoreMs: Number(process.env.STARTUP_MUTATION_IGNORE_MS || 4000),
  queueDir: path.resolve(process.env.QUEUE_DIR || './queue'),
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  supabaseTable: process.env.SUPABASE_TABLE || '',
  processInitialScan: process.env.PROCESS_INITIAL_SCAN !== 'false',
  ignoreShiftedRows: process.env.IGNORE_SHIFTED_ROWS === 'true',
  workerCommand: process.env.VILLAGE_AI_WORKER_CMD || '',
  workerLive: process.env.AI_WORKER_LIVE === '1',
  autoSendEnabled: process.env.AI_WORKER_AUTO_SEND === '1',
  topRowLiveWindowMinutes: Number(process.env.TOP_ROW_LIVE_WINDOW_MINUTES || 20),
  readBackstopLookbackHours: Number(process.env.READ_BACKSTOP_LOOKBACK_HOURS || 36),
  readBackstopLookbackDays: Number(process.env.READ_BACKSTOP_LOOKBACK_DAYS || 2),
  workerTimeoutMs: Number(process.env.WORKER_TIMEOUT_MS || process.env.HERMES_WORKER_TIMEOUT_MS || 240_000),
  supabaseTimeoutMs: Number(process.env.SUPABASE_TIMEOUT_MS || 7000),
  followUpTable: process.env.SUPABASE_FOLLOW_UP_TABLE || 'ai_follow_up_items',
  supabaseRecoveryEnabled: process.env.SUPABASE_RECOVERY_ENABLED !== 'false',
  supabaseRecoveryIntervalMs: Number(process.env.SUPABASE_RECOVERY_INTERVAL_MS || 300_000),
  supabaseRecoveryBatchSize: Number(process.env.SUPABASE_RECOVERY_BATCH_SIZE || 2),
  supabaseRecoveryLookbackHours: Number(process.env.SUPABASE_RECOVERY_LOOKBACK_HOURS || 36),
  supabaseRecoveryErrorRetryMs: Number(process.env.SUPABASE_RECOVERY_ERROR_RETRY_MS || 900_000),
  supabaseRecoveryMaxAttempts: Number(process.env.SUPABASE_RECOVERY_MAX_ATTEMPTS || 2),
  slackActionPollEnabled: process.env.SLACK_ACTION_POLL_ENABLED !== 'false',
  slackActionPollIntervalMs: Number(process.env.SLACK_ACTION_POLL_INTERVAL_MS || 10_000),
  kakaoDevtoolsUrl: (process.env.KAKAO_DEVTOOLS_URL || process.env.KAKAO_CDP_HTTP_URL || process.env.KAKAO_CDP_URL || '').replace(/\/+$/, ''),
  kakaoRemoteDebuggingPort: process.env.KAKAO_REMOTE_DEBUGGING_PORT || process.env.VILLAGE_KAKAO_REMOTE_DEBUGGING_PORT || '9223',
  kakaoTabCleanupEnabled: process.env.KAKAO_TAB_CLEANUP_ENABLED !== 'false',
  kakaoTabCleanupIntervalMs: Number(process.env.KAKAO_TAB_CLEANUP_INTERVAL_MS || 120_000)
};

const state = {
  startedAt: new Date().toISOString(),
  received: 0,
  debouncedJobs: 0,
  failedSupabaseWrites: 0,
  failedWorkerRuns: 0,
  workerRunning: false,
  workerQueueLength: 0,
  currentJobId: null,
  workerStartedAt: null,
  lastWorkerError: null,
  recoveredJobs: 0,
  slackActionsHandled: 0,
  slackActionPollRunning: false,
  lastSlackActionPoll: null,
  recoverySweepRunning: false,
  lastRecoverySweep: null,
  closedKakaoTabs: 0,
  tabCleanupRunning: false,
  lastTabCleanup: null,
  rooms: new Map(),
  seenGroupingTexts: new Set(),
  lastContentScriptStartedAtMs: 0
};

function ensureQueueDir() {
  fs.mkdirSync(CONFIG.queueDir, { recursive: true });
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function json(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type'
  });
  res.end(body);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const body = await readRequestBody(req);
  if (!body.trim()) return {};
  return JSON.parse(body);
}

function normalizeEvent(raw) {
  const source = String(raw.source || 'kakao_channel_manager_dom');
  const roomKey = String(raw.roomKey || raw.room_key || raw.roomHint || raw.previewText || 'unknown-room');
  const previewText = String(raw.previewText || raw.preview_text || '').slice(0, 500);
  const detectedAt = String(raw.detectedAt || raw.detected_at || nowIso());
  const eventHash = String(raw.eventHash || raw.event_hash || sha256(JSON.stringify({ source, roomKey, previewText, detectedAt })));

  return {
    source,
    status: String(raw.status || 'pending_ai_review'),
    reason: String(raw.reason || 'dom_event'),
    detectedAt,
    receivedAt: nowIso(),
    url: String(raw.url || ''),
    title: String(raw.title || ''),
    roomKey,
    eventHash,
    previewText,
    unreadCount: raw.unreadCount ?? raw.unread_count ?? null,
    pageVisibility: raw.pageVisibility || raw.page_visibility || null,
    raw
  };
}

function isPageContainerPreview(text, roomKey) {
  const preview = String(text || '');
  if (/^attr:kakao(Wrap|Content)$/i.test(String(roomKey || ''))) return true;
  if (/^(전체 채팅목록|중요채팅 목록|차단친구 목록)$/.test(preview)) return true;
  const pageChromeSignals = [
    '채팅 목록 채팅 목록',
    '1:1 채팅사용 여부',
    '상담 완료하기',
    '채팅방 나가기',
    '친구차단'
  ];
  const isSettingsBlock = preview.includes('1:1 채팅사용 여부') && preview.includes('채팅설정');
  const importanceMarkers = (preview.match(/중요\s/g) || []).length;
  const looksLikeChatListContainer = preview.length > 120 && importanceMarkers >= 2;

  return pageChromeSignals.filter((needle) => preview.includes(needle)).length >= 2
    || isSettingsBlock
    || looksLikeChatListContainer;
}

function normalizePreviewForGrouping(text) {
  const cleaned = String(text || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/^중요\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';

  // Group split Kakao bubbles by the visible room/customer label, not by the full
  // latest-message preview. This is plumbing for debounce only; AI still reads
  // the opened conversation and decides sender/intent.
  const tokens = cleaned.split(' ').filter(Boolean);
  const labelParts = [];
  for (const token of tokens) {
    if (/^\d+$/.test(token)) break; // unread count often follows the room label
    if (/^(오전|오후)$/.test(token)) break;
    if (/^\d{1,2}:\d{2}$/.test(token)) break;
    labelParts.push(token);
    if (labelParts.length >= 2) break; // allow short company/team labels without eating the message
  }
  const label = labelParts[0] || tokens[0] || cleaned.slice(0, 40);
  return `room-label:${label.slice(0, 80)}`;
}

function cleanPreviewText(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/^중요\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isStaffOrOutboundPreview(text) {
  const preview = cleanPreviewText(text);
  if (!preview) return true;
  return /(빌리지님|김준영님|최재형님|운영자|상담원|매니저)님?이?\s*보냄|보낸 메시지 가이드/.test(preview)
    || /^저장하기(?:\s|$)/.test(preview)
    || /알림톡\/친구톡 메시지는 관리자센터에서 확인할 수 없습니다/.test(preview);
}

function hasActionableBusinessSignal(text) {
  const preview = cleanPreviewText(text);
  return /(예약|신청|가능|문의|대여|렌탈|반출|반납|변경|추가|취소|연장|가격|비용|견적|얼마|요금|세금계산|계산서|거래명세|입금|결제|환불|위치|주소|영업|운영|절차|방법|파손|분실|누락|고장|수리|장비|카메라|렌즈|조명|배터리|충전기|삼각대|짐벌|마이크|송수신기|FX3|FX6|FX9|A7S3|A7M4|로닌|어퓨처|어퓨쳐|소니|DJI|SDR|V마운트|브이마운트)/i.test(preview);
}

function isLowValueTerminalPreview(text) {
  const preview = cleanPreviewText(text);
  if (!preview) return true;
  if (isStaffOrOutboundPreview(preview)) return true;
  const withoutClock = preview
    .replace(/\b\d+\b/g, ' ')
    .replace(/(?:오전|오후)\s*\d{1,2}:?\d{2}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^(?:네|넵|예|옙|알겠습니다|확인했습니다|감사합니다|감사 합니다|고맙습니다|넵 감사합니다|네 감사합니다|네 알겠습니다)[!.~\s]*$/.test(withoutClock)) return true;
  if (/(반납\s*완료|반납완료|반납완려|반납\s*했습니다|반납했습니다|잘\s*썼|잘썼|보냈습니다|입금했습니다|입금완료|확인\s*감사)/.test(preview) && !hasActionableBusinessSignal(preview.replace(/반납|입금|확인/g, ''))) return true;
  if (/^(?:[^ ]+\s+)?(?:네|넵)\s*(?:가능합니다|가능하십니다|잡아드리겠습니다|잡아드릴게요|준비해놓을게요|문제없습니다|확인해보겠습니다|무인반납입니다)/.test(withoutClock)) return true;
  return false;
}

function isThanksOnlyTerminalPreview(text) {
  const preview = cleanPreviewText(text);
  if (!preview) return true;
  const withoutClock = preview
    .replace(/\b\d+\b/g, ' ')
    .replace(/(?:오전|오후)\s*\d{1,2}:?\d{2}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return /^(?:[가-힣A-Za-z0-9_.-]{1,24}\s+)?(?:감사합니다|감사\s*합니다|감사|고맙습니다|고마워요|넵\s*감사합니다|네\s*감사합니다)[!.~ㅠㅜ\s]*$/.test(withoutClock);
}

function shouldSkipWorkerForPreview(event = {}) {
  const preview = event.previewText || '';
  if (isStaffOrOutboundPreview(preview)) return 'staff_or_outbound_preview';
  if (isThanksOnlyTerminalPreview(preview)) return 'thanks_only_terminal_preview';
  if (isLowValueTerminalPreview(preview) && !hasUnreadCount(event)) return 'low_value_terminal_preview';
  return '';
}

function getSpatialTop(roomKey) {
  const match = /^dom:(\d+):/.exec(String(roomKey || ''));
  return match ? Number(match[1]) : null;
}

function isLikelyShiftedExistingRow(event) {
  if (!CONFIG.ignoreShiftedRows) return false;
  if (event.reason !== 'mutation') return false;
  const top = getSpatialTop(event.roomKey);
  if (top === null) return false;

  // Legacy noise filter. Disabled by default because Kakao's row coordinates are
  // too brittle: a real unread room can appear at top=46 and must not be dropped.
  // Prefer extra AI-reviewed jobs over missed customer inquiries.
  return top >= Number(process.env.CHAT_LIST_FIRST_ROW_MAX_TOP || 44);
}

function parseKoreanPreviewTimeMinutes(text) {
  const matches = Array.from(String(text || '').matchAll(/(오전|오후)\s*(\d{1,2}):(\d{2})/g));
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

function minutesSincePreviewTime(text, now = new Date()) {
  const previewMinutes = parseKoreanPreviewTimeMinutes(text);
  if (previewMinutes === null) return null;
  const nowMinutes = (now.getHours() * 60) + now.getMinutes();
  let diff = nowMinutes - previewMinutes;
  if (diff < -1) diff += 1440;
  return diff;
}

function kstDateParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
  return { year: get('year'), month: get('month'), day: get('day') };
}

function dayNumber(year, month, day) {
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function normalizeYear(year) {
  if (!year) return null;
  const value = Number(year);
  if (!Number.isFinite(value)) return null;
  return value < 100 ? 2000 + value : value;
}

function resolveDisplayMonthDay(month, day, now = new Date()) {
  const current = kstDateParts(now);
  let year = current.year;
  let diff = dayNumber(year, month, day) - dayNumber(current.year, current.month, current.day);
  if (diff > 180) year -= 1;
  if (diff < -180) year += 1;
  return { year, month, day };
}

function extractTrailingKakaoDisplayDate(text, now = new Date()) {
  const preview = String(text || '').trim();
  const korean = /(?:^|\s)(?:(\d{2,4})년\s*)?(\d{1,2})월\s*(\d{1,2})일\s*$/.exec(preview);
  if (korean) {
    const year = normalizeYear(korean[1]);
    const month = Number(korean[2]);
    const day = Number(korean[3]);
    if (!Number.isFinite(month) || !Number.isFinite(day)) return null;
    return year ? { year, month, day } : resolveDisplayMonthDay(month, day, now);
  }

  const dotted = /(?:^|\s)(\d{2,4})[./-]\s*(\d{1,2})[./-]\s*(\d{1,2})\s*$/.exec(preview);
  if (dotted) {
    const year = normalizeYear(dotted[1]);
    const month = Number(dotted[2]);
    const day = Number(dotted[3]);
    if (!year || !Number.isFinite(month) || !Number.isFinite(day)) return null;
    return { year, month, day };
  }

  return null;
}

function daysSinceDatedPreview(text, now = new Date()) {
  const date = extractTrailingKakaoDisplayDate(text, now);
  if (!date) return null;
  const today = kstDateParts(now);
  return dayNumber(today.year, today.month, today.day) - dayNumber(date.year, date.month, date.day);
}

function hasUnreadCount(event = {}) {
  if (event.raw?.unreadSignal === true || event.unreadSignal === true) return true;
  const count = Number(event.unreadCount ?? event.unread_count ?? event.raw?.unreadCount ?? event.raw?.unread_count ?? 0);
  if (!Number.isFinite(count) || count <= 0) return false;
  if (event.reason === 'top_rows_backstop' || event.reason === 'top_row_changed') return true;
  const preview = String(event.previewText || '');
  const explicitlyUnread = /안읽|읽지\s*않은|새\s*메시지|unread/i.test(preview);
  return explicitlyUnread;
}

function hasDatedPreview(text) {
  return daysSinceDatedPreview(text) !== null;
}

function isRecentDatedPreview(text, now = new Date()) {
  const days = daysSinceDatedPreview(text, now);
  return days !== null && days >= 0 && days <= CONFIG.readBackstopLookbackDays;
}

function isRecentClockPreview(text, now = new Date()) {
  const ageMinutes = minutesSincePreviewTime(text, now);
  return ageMinutes !== null
    && ageMinutes >= -1
    && ageMinutes <= CONFIG.readBackstopLookbackHours * 60;
}

function isRecentReadCatchupPreview(text, now = new Date()) {
  const preview = String(text || '');
  if (isActionChromePreview(preview)) return false;
  return isRecentClockPreview(preview, now) || isRecentDatedPreview(preview, now);
}

function isLiveTopRowPreview(text, now = new Date()) {
  const preview = String(text || '');
  if (isActionChromePreview(preview)) return false;
  if (/방금|몇\s*분\s*전/.test(preview)) return true;
  const ageMinutes = minutesSincePreviewTime(preview, now);
  return ageMinutes !== null
    && ageMinutes >= -1
    && ageMinutes <= CONFIG.topRowLiveWindowMinutes;
}

function shouldQueueTopRowEvent(event) {
  if (isActionChromePreview(event.previewText)) return false;
  if (hasUnreadCount(event)) return !hasDatedPreview(event.previewText) || isRecentDatedPreview(event.previewText);
  return (event.reason === 'top_row_changed' || event.reason === 'top_rows_backstop')
    && (isLiveTopRowPreview(event.previewText) || isRecentReadCatchupPreview(event.previewText));
}

function hasLivePreviewTime(text) {
  const preview = String(text || '');
  return /방금|몇\s*분\s*전/.test(preview) || parseKoreanPreviewTimeMinutes(preview) !== null;
}

function isStaleDatedMutation(event = {}) {
  return event.reason === 'mutation'
    && hasDatedPreview(event.previewText)
    && !isRecentDatedPreview(event.previewText)
    && !hasLivePreviewTime(event.previewText);
}

function isActionChromePreview(text) {
  const preview = String(text || '').trim();
  if (!preview) return true;
  const exactNoise = new Set([
    '저장하기',
    '보낸 메시지 가이드',
    '메모 내용 미리보기',
    '사이드 메뉴 열기',
    '중요 채팅방 해제',
    '채팅 메시지 입력 폼 전송',
    '카카오비즈니스 이용약관'
  ]);
  if (exactNoise.has(preview)) return true;
  if (/^(?:hellodesk\s+)?저장하기\s+(오전|오후)\s*\d{1,2}:?\d{2}$/.test(preview)) return true;
  if (/채널추가 요청 메시지|친구추가 요청 메시지|메시지 꾸미기|쿠폰 첨부|기본 메시지로 설정/.test(preview)) return true;
  return false;
}

function appendNdjson(filename, object) {
  ensureQueueDir();
  fs.appendFileSync(path.join(CONFIG.queueDir, filename), `${JSON.stringify(object)}\n`, 'utf8');
}

function supabaseConfigured() {
  return Boolean(CONFIG.supabaseUrl && CONFIG.supabaseServiceRoleKey && CONFIG.supabaseTable);
}

function supabaseTableEndpoint() {
  return `${CONFIG.supabaseUrl.replace(/\/$/, '')}/rest/v1/${encodeURIComponent(CONFIG.supabaseTable)}`;
}

function supabaseFollowUpEndpoint() {
  return `${CONFIG.supabaseUrl.replace(/\/$/, '')}/rest/v1/${encodeURIComponent(CONFIG.followUpTable)}`;
}

function supabaseHeaders(prefer = '') {
  const headers = {
    apikey: CONFIG.supabaseServiceRoleKey,
    authorization: `Bearer ${CONFIG.supabaseServiceRoleKey}`,
    'content-type': 'application/json'
  };
  if (prefer) headers.prefer = prefer;
  return headers;
}

async function supabaseFetchWithTimeout(endpoint, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.supabaseTimeoutMs);
  const response = await fetch(endpoint, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
  const text = await response.text().catch(() => '');
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  return { response, text, data };
}

async function fetchSupabaseEventByHash(eventHash) {
  if (!supabaseConfigured() || !eventHash) return null;
  const url = new URL(supabaseTableEndpoint());
  url.searchParams.set('event_hash', `eq.${eventHash}`);
  url.searchParams.set('select', 'id,status,room_key,event_hash,created_at,updated_at,claimed_at,completed_at,error_message,payload');
  url.searchParams.set('limit', '1');
  const { response, text, data } = await supabaseFetchWithTimeout(url.toString(), {
    method: 'GET',
    headers: supabaseHeaders()
  });
  if (!response.ok) throw new Error(`Supabase lookup failed: ${response.status} ${text}`);
  return Array.isArray(data) && data.length ? data[0] : null;
}

async function fetchSupabaseRowsByStatuses(statuses = [], limit = 20) {
  if (!supabaseConfigured() || !statuses.length) return [];
  const url = new URL(supabaseTableEndpoint());
  const cutoff = new Date(Date.now() - CONFIG.supabaseRecoveryLookbackHours * 60 * 60_000).toISOString();
  url.searchParams.set('status', `in.(${statuses.join(',')})`);
  url.searchParams.set('created_at', `gte.${cutoff}`);
  url.searchParams.set('select', 'id,status,room_key,event_hash,preview_text,unread_count,detected_at,created_at,updated_at,claimed_at,completed_at,error_message,payload');
  url.searchParams.set('order', 'updated_at.desc');
  url.searchParams.set('limit', String(limit));
  const { response, text, data } = await supabaseFetchWithTimeout(url.toString(), {
    method: 'GET',
    headers: supabaseHeaders()
  });
  if (!response.ok) throw new Error(`Supabase recovery lookup failed: ${response.status} ${text}`);
  return Array.isArray(data) ? data : [];
}

async function updateSupabaseEventByHash(eventHash, patch) {
  if (!supabaseConfigured() || !eventHash || !patch) return { skipped: true };
  const url = new URL(supabaseTableEndpoint());
  url.searchParams.set('event_hash', `eq.${eventHash}`);
  const { response, text, data } = await supabaseFetchWithTimeout(url.toString(), {
    method: 'PATCH',
    headers: supabaseHeaders('return=representation'),
    body: JSON.stringify(patch)
  });
  if (!response.ok) throw new Error(`Supabase update failed: ${response.status} ${text}`);
  return { ok: true, row: Array.isArray(data) ? data[0] : data };
}

async function writeSupabaseEvent(eventOrJob, kind) {
  if (!supabaseConfigured()) return { skipped: true };

  const endpoint = supabaseTableEndpoint();
  const payload = {
    source: eventOrJob.source || 'kakao_channel_manager_dom',
    status: kind === 'job' ? 'ready_for_ai_worker' : 'pending_ai_review',
    room_key: eventOrJob.roomKey,
    event_hash: eventOrJob.eventHash || eventOrJob.jobId,
    preview_text: eventOrJob.previewText || '',
    unread_count: eventOrJob.unreadCount ?? null,
    detected_at: eventOrJob.detectedAt || nowIso(),
    payload: eventOrJob
  };

  const { response, text } = await supabaseFetchWithTimeout(endpoint, {
    method: 'POST',
    headers: supabaseHeaders('return=minimal'),
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    if (response.status === 409 && (text.includes('duplicate key value') || text.includes('23505') || text.includes('event_hash'))) {
      const existing = await fetchSupabaseEventByHash(payload.event_hash).catch((error) => ({ lookupError: error.message }));
      return { skipped: true, duplicate: true, existing };
    }
    throw new Error(`Supabase insert failed: ${response.status} ${text}`);
  }
  return { ok: true };
}

function isDuplicateProcessingStale(existing = {}, now = new Date()) {
  const reference = Date.parse(existing.claimed_at || existing.updated_at || existing.created_at || '');
  if (!Number.isFinite(reference)) return true;
  const staleMs = Math.max(CONFIG.workerTimeoutMs * 2, 10 * 60_000);
  return now.getTime() - reference > staleMs;
}

function shouldRunDuplicateJob(existing = {}) {
  const status = String(existing?.status || '');
  if (!status) return true;
  if (status === 'processing_by_ai_worker') return isDuplicateProcessingStale(existing);
  if (['ready_for_ai_worker', 'ai_worker_error', 'ai_decision_ready_no_sheet_write', 'pending_ai_review'].includes(status)) {
    return true;
  }
  return false;
}

function duplicateSkipReason(existing = {}) {
  return existing?.status === 'processing_by_ai_worker'
    ? 'duplicate_supabase_job_in_progress'
    : 'duplicate_supabase_job_already_handled';
}

function parseWorkerStdoutJson(workerResult = {}) {
  const stdout = String(workerResult.stdout || '').trim();
  if (!stdout) return null;
  try {
    return JSON.parse(stdout);
  } catch {
    const start = stdout.indexOf('{');
    const end = stdout.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(stdout.slice(start, end + 1)); } catch {}
    }
  }
  return null;
}

function mapWorkerPayloadToSupabaseStatus(workerPayload = {}) {
  const decision = workerPayload.decision || {};
  const sheetResult = workerPayload.sheetResult || workerPayload.sheet_result || {};
  if (decision?.should_write_to_sheet === true && sheetResult?.success === true) {
    return { status: 'needs_human_review', error_message: null };
  }
  if (decision?.should_write_to_sheet === true && sheetResult?.success === false) {
    const errorMessage = String(sheetResult.error || 'GAS rejected sheet write').slice(0, 500);
    if (sheetResult.error_type === 'duplicate_request') {
      return { status: 'ai_skipped_needs_review', error_message: `GAS duplicate skipped: ${errorMessage}` };
    }
    return { status: 'needs_human_review', error_message: `GAS sheet write rejected: ${errorMessage}` };
  }
  if (decision?.should_write_to_sheet === true) {
    return { status: 'ai_decision_ready_no_sheet_write', error_message: 'AI wanted sheet write, but sheet append was not completed' };
  }
  return { status: 'ai_skipped_needs_review', error_message: String(decision?.reason || '').slice(0, 500) || null };
}

function buildWorkerResultPatch(job, workerResult) {
  const workerPayload = parseWorkerStdoutJson(workerResult);
  if (!workerPayload) {
    return {
      status: 'ai_worker_error',
      error_message: 'Worker completed but stdout result was not parseable',
      completed_at: nowIso(),
      payload: {
        ...job,
        ai_worker_result: {
          parse_error: true,
          stdout_tail: String(workerResult?.stdout || '').slice(-4000),
          stderr_tail: String(workerResult?.stderr || '').slice(-4000)
        }
      }
    };
  }

  const statusPatch = mapWorkerPayloadToSupabaseStatus(workerPayload);
  return {
    ...statusPatch,
    completed_at: nowIso(),
    payload: {
      ...job,
      ai_worker_result: {
        decision: workerPayload.decision || null,
        sheet_result: workerPayload.sheetResult || null,
        follow_up_result: workerPayload.followUpResult || null,
        auto_reply_result: workerPayload.autoReplyResult || null,
        close_result: workerPayload.closeResult || null,
        status: workerPayload.status || null
      }
    }
  };
}

function buildStableJobId(roomKey, events = []) {
  const identities = events
    .map((event) => event.eventHash || sha256(JSON.stringify({
      reason: event.reason || '',
      previewText: event.previewText || '',
      unreadCount: event.unreadCount ?? null
    })))
    .sort();
  return `dom-${sha256(`${roomKey}:${identities.join('|')}`).slice(0, 16)}`;
}

function buildAiFirstJob(roomKey, roomState) {
  const events = roomState.events.slice();
  const latest = events[events.length - 1] || {};
  const unreadCounts = events
    .map((event) => Number(event.unreadCount ?? event.unread_count ?? event.raw?.unreadCount ?? event.raw?.unread_count ?? 0))
    .filter((count) => Number.isFinite(count) && count > 0);
  return {
    jobId: buildStableJobId(roomKey, events),
    source: 'kakao_channel_manager_dom',
    reason: 'kakao_channel_manager_dom_event_debounced',
    status: 'ready_for_ai_worker',
    roomKey,
    detectedAt: latest.detectedAt || nowIso(),
    firstEventAt: roomState.firstAt,
    lastEventAt: roomState.lastAt,
    eventCount: events.length,
    previewText: latest.previewText || '',
    unreadCount: unreadCounts.length ? Math.max(...unreadCounts) : null,
    events,
    instructions: [
      '이 payload는 판단 결과가 아니라 새 상담 감지 알림이다.',
      '카카오 채널 관리자 브라우저 화면을 직접 열어서 해당 상담을 확인한다.',
      '코드/queue/RAG의 추론을 믿지 말고 화면 맥락을 우선한다.',
      'RAG는 필요할 때만 장기기억 도구로 사용한다.',
      '답장/시트 처리에 과도하게 보수적으로 굴지 말고, 현재 구현된 write 경로 안에서 적극적으로 처리한다.',
      '예약 확정, 금액 확정, 재고 가능 단정은 승인된 조회/확정 흐름 없이 실행하지 않는다.'
    ]
  };
}

function objectPayload(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function latestEventFromJob(job = {}) {
  const events = Array.isArray(job.events) ? job.events : [];
  return events[events.length - 1] || {};
}

function extractCustomerNameFromText(value) {
  const text = cleanPreviewText(value);
  if (!text) return '';
  const timeIndex = text.search(/(?:오전|오후)\s*\d{1,2}:?\d{2}|방금|몇\s*분\s*전|\d{4}\.\s*\d{1,2}\.\s*\d{1,2}/);
  const head = (timeIndex > 0 ? text.slice(0, timeIndex) : text.split(/\s+/)[0])
    .replace(/[|:>-]+$/g, '')
    .trim();
  if (!head || head.length > 40) return '';
  return head;
}

function customerNameForJob(job = {}) {
  const latest = latestEventFromJob(job);
  return String(
    job.customerName
    || job.customer_name
    || job.roomTitle
    || job.room_title
    || latest.customerName
    || latest.customer_name
    || latest.roomTitle
    || latest.room_title
    || extractCustomerNameFromText(job.previewText || latest.previewText || '')
    || '미확인 고객'
  ).slice(0, 120);
}

function previewForJob(job = {}) {
  const latest = latestEventFromJob(job);
  return String(job.previewText || job.preview_text || latest.previewText || latest.preview_text || '').slice(0, 1000);
}

function followUpConfig() {
  return {
    supabaseUrl: CONFIG.supabaseUrl,
    serviceRoleKey: CONFIG.supabaseServiceRoleKey,
    followUpTable: CONFIG.followUpTable
  };
}

async function createWorkerFailureFollowUp(job = {}, error = new Error('worker failed'), context = {}) {
  if (!supabaseConfigured()) return { skipped: true, reason: 'supabase_not_configured' };
  const preview = previewForJob(job);
  if (isLowValueTerminalPreview(preview) || isStaffOrOutboundPreview(preview)) {
    return {
      skipped: true,
      reason: 'non_actionable_failure_preview',
      previewText: cleanPreviewText(preview).slice(0, 240)
    };
  }
  const customerName = customerNameForJob(job);
  const jobId = String(job.jobId || job.eventHash || job.id || 'unknown-job');
  const roomKey = String(job.roomKey || job.room_key || '').slice(0, 240);
  const failureKind = context.timeout ? 'worker_timeout' : 'worker_error';
  const titleName = customerName && customerName !== '미확인 고객' ? customerName : '카카오 문의';
  const humanFailureClass = context.timeout ? 'reservation_review_timeout' : 'automation_error_review';
  const humanSummary = context.timeout
    ? '자동 처리 제한 시간을 넘겨 사람 확인으로 전환됐습니다. 카카오 원문과 확인요청/계약마스터를 대조해 누락 여부를 확인하세요.'
    : `자동 처리 중 오류가 발생해 사람 확인으로 전환됐습니다: ${String(error.message || error).slice(0, 300)}`;
  const row = {
    follow_up_key: `bridge-failure:${roomKey || 'unknown-room'}:${sha256(`${jobId}:${preview}:${failureKind}`).slice(0, 16)}`,
    source: 'kakao_dom_bridge',
    job_id: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(job.id || '')) ? job.id : null,
    room_key: roomKey,
    customer_name: customerName,
    type: 'reply_needed',
    priority: 'urgent',
    status: 'open',
    title: context.timeout ? `${titleName} 예약 후보 확인 필요` : `${titleName} 자동 처리 확인 필요`,
    summary: humanSummary,
    recommended_action: '카카오 채팅방을 직접 열어 원문을 확인하고, 확인요청/계약마스터에 이미 처리됐는지 대조하세요. 누락이면 확인요청 입력 또는 답변을 처리하세요.',
    suggested_reply_draft: '감독님, 확인 후 바로 안내드리겠습니다.',
    evidence: [preview, `jobId: ${jobId}`].filter(Boolean).slice(0, 12),
    blocking_reason: context.timeout ? '자동 처리 제한 시간 초과로 사람 확인 전환' : String(error.message || error).slice(0, 1000),
    due_hint: 'now',
    decision_classification: humanFailureClass,
    decision_confidence: 'blocked',
    payload: {
      failure_kind: failureKind,
      job_id: jobId,
      room_key: roomKey,
      preview_text: preview,
      technical_error: String(error.message || error).slice(0, 1000),
      recovery_context: context
    }
  };
  return upsertFollowUpRows(followUpConfig(), [row]);
}

function killProcessTree(child, signal = 'SIGTERM') {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch {}
  }
}

function appendLimited(current, chunk, limit = 20_000) {
  const next = current + chunk.toString();
  return next.length > limit ? next.slice(-limit) : next;
}

function runWorker(job) {
  if (!CONFIG.workerCommand) return Promise.resolve({ skipped: true });

  return new Promise((resolve, reject) => {
    const child = spawn(CONFIG.workerCommand, {
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
      detached: true
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      const error = new Error(`worker timed out after ${CONFIG.workerTimeoutMs}ms`);
      appendNdjson('errors.ndjson', { at: nowIso(), type: 'worker_timeout', message: error.message, jobId: job.jobId, job });
      killProcessTree(child, 'SIGTERM');
      setTimeout(() => killProcessTree(child, 'SIGKILL'), 3000).unref?.();
      finish(reject, error);
    }, CONFIG.workerTimeoutMs);

    child.stdout.on('data', (chunk) => { stdout = appendLimited(stdout, chunk); });
    child.stderr.on('data', (chunk) => { stderr = appendLimited(stderr, chunk); });
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code, signal) => {
      const result = { code, signal, timedOut, stdout, stderr };
      appendNdjson('worker-results.ndjson', { at: nowIso(), jobId: job.jobId, result });
      if (code === 0) finish(resolve, result);
      else if (!settled) finish(reject, new Error(`worker exited ${code ?? signal}: ${stderr || stdout}`));
    });

    child.stdin.end(JSON.stringify(job));
  });
}

let workerChain = Promise.resolve();

function enqueueWorker(job) {
  if (!CONFIG.workerCommand) return Promise.resolve({ skipped: true });
  state.workerQueueLength += 1;
  const run = async () => {
    state.workerQueueLength = Math.max(0, state.workerQueueLength - 1);
    state.workerRunning = true;
    state.currentJobId = job.jobId;
    state.workerStartedAt = nowIso();
    console.info('[dom-bridge] worker start', job.jobId, 'queued:', state.workerQueueLength);
    try {
      const result = await runWorker(job);
      state.lastWorkerError = null;
      return result;
    } catch (error) {
      state.lastWorkerError = { at: nowIso(), jobId: job.jobId, message: error.message.slice(0, 1000) };
      throw error;
    } finally {
      state.workerRunning = false;
      state.currentJobId = null;
      state.workerStartedAt = null;
      console.info('[dom-bridge] worker done', job.jobId, 'queued:', state.workerQueueLength);
    }
  };
  const queued = workerChain.then(run, run);
  workerChain = queued.catch(() => {});
  return queued;
}

function enqueueManualSend(payload) {
  const jobId = `manual-send-${Date.now()}`;
  const run = async () => {
    state.workerRunning = true;
    state.currentJobId = jobId;
    state.workerStartedAt = nowIso();
    console.info('[dom-bridge] manual send start', jobId, payload.customerName || payload.roomTitle || '');
    try {
      const result = await processManualSend(payload);
      state.lastWorkerError = null;
      appendNdjson('manual-sends.ndjson', { at: nowIso(), jobId, payload: { ...payload, text: '[redacted]' }, result });
      return result;
    } catch (error) {
      state.lastWorkerError = { at: nowIso(), jobId, message: error.message.slice(0, 1000) };
      appendNdjson('errors.ndjson', { at: nowIso(), type: 'manual_send', message: error.message, payload: { ...payload, text: '[redacted]' } });
      throw error;
    } finally {
      state.workerRunning = false;
      state.currentJobId = null;
      state.workerStartedAt = null;
      console.info('[dom-bridge] manual send done', jobId);
    }
  };
  const queued = workerChain.then(run, run);
  workerChain = queued.catch(() => {});
  return queued;
}

async function fetchPendingSlackActionRows(limit = 3) {
  if (!supabaseConfigured()) return [];
  const url = new URL(supabaseFollowUpEndpoint());
  url.searchParams.set('select', 'id,customer_name,room_key,title,status,suggested_reply_draft,payload,updated_at');
  url.searchParams.set('status', 'not.in.(done,dismissed)');
  url.searchParams.set('order', 'updated_at.asc');
  url.searchParams.set('limit', '200');
  const { response, text, data } = await supabaseFetchWithTimeout(url.toString(), {
    method: 'GET',
    headers: supabaseHeaders()
  });
  if (!response.ok) throw new Error(`Supabase Slack action lookup failed: ${response.status} ${text}`);
  return (Array.isArray(data) ? data : [])
    .filter((row) => row?.payload?.slack_action?.status === 'pending')
    .slice(0, limit);
}

async function fetchFollowUpRowById(id) {
  if (!supabaseConfigured() || !id) return null;
  const url = new URL(supabaseFollowUpEndpoint());
  url.searchParams.set('select', 'id,customer_name,room_key,title,status,suggested_reply_draft,payload,updated_at');
  url.searchParams.set('id', `eq.${id}`);
  url.searchParams.set('limit', '1');
  const { response, text, data } = await supabaseFetchWithTimeout(url.toString(), {
    method: 'GET',
    headers: supabaseHeaders()
  });
  if (!response.ok) throw new Error(`Supabase follow-up lookup failed: ${response.status} ${text}`);
  return Array.isArray(data) ? data[0] || null : null;
}

async function patchFollowUpRowById(id, patch) {
  if (!supabaseConfigured() || !id) return null;
  const url = new URL(supabaseFollowUpEndpoint());
  url.searchParams.set('id', `eq.${id}`);
  const { response, text, data } = await supabaseFetchWithTimeout(url.toString(), {
    method: 'PATCH',
    headers: supabaseHeaders('return=representation'),
    body: JSON.stringify(patch)
  });
  if (!response.ok) throw new Error(`Supabase follow-up patch failed: ${response.status} ${text}`);
  return Array.isArray(data) ? data[0] : data;
}

async function mergeFollowUpPayloadById(row, payloadPatch = {}, extraPatch = {}) {
  const currentPayload = row?.payload && typeof row.payload === 'object' ? row.payload : {};
  return patchFollowUpRowById(row.id, {
    ...extraPatch,
    payload: {
      ...currentPayload,
      ...payloadPatch
    }
  });
}

function slackStatusFromActionId(actionId = '') {
  const match = String(actionId || '').match(/^village_followup_status_(.+)$/);
  if (!match) return '';
  const status = match[1];
  return ['open', 'in_progress', 'waiting_customer', 'waiting_internal', 'done', 'dismissed'].includes(status)
    ? status
    : '';
}

async function applySlackFollowUpActionRequest(body = {}) {
  const actionId = String(body.action_id || body.actionId || body.action || '').trim();
  const followUpId = String(body.followUpId || body.follow_up_id || body.value || body.id || '').trim();
  if (!actionId) throw new Error('action_id is required');
  if (!followUpId) throw new Error('followUpId is required');
  const row = await fetchFollowUpRowById(followUpId);
  if (!row) throw new Error(`follow-up item not found: ${followUpId}`);

  const requestedAt = nowIso();
  const requestedBy = String(body.user_id || body.userId || body.user_name || body.userName || '').trim();
  const baseSlackAction = {
    action_id: actionId,
    requested_at: requestedAt,
    requested_by: requestedBy || null,
    channel_id: body.channel_id || body.channelId || null,
    message_ts: body.message_ts || body.messageTs || null,
    source: 'slack_socket',
    error: null
  };

  const targetStatus = slackStatusFromActionId(actionId);
  if (targetStatus) {
    const updated = await mergeFollowUpPayloadById(row, {
      slack_action: {
        ...baseSlackAction,
        type: 'status',
        status: 'done',
        target_status: targetStatus,
        handled_at: requestedAt
      }
    }, { status: targetStatus });
    appendNdjson('slack-actions.ndjson', { at: requestedAt, action: actionId, followUpId, targetStatus, requestedBy });
    return { ok: true, kind: 'status', followUpId, status: targetStatus, updated };
  }

  if (['village_followup_send', 'village_followup_edit_send_submit'].includes(actionId)) {
    const draftOverride = String(body.draftOverride || body.draft_override || '').trim();
    const payloadPatch = {
      slack_action: {
        ...(row.payload?.slack_action || {}),
        ...baseSlackAction,
        type: 'send',
        status: 'pending'
      }
    };
    if (draftOverride) payloadPatch.slack_draft_override = draftOverride;
    const updated = await mergeFollowUpPayloadById(row, payloadPatch, { status: 'in_progress' });
    appendNdjson('slack-actions.ndjson', { at: requestedAt, action: actionId, followUpId, requestedBy, hasDraftOverride: Boolean(draftOverride) });
    return { ok: true, kind: 'send', followUpId, updated };
  }

  throw new Error(`unsupported Slack follow-up action: ${actionId}`);
}

async function claimSlackActionRow(row) {
  if (row?.payload?.slack_action?.status !== 'pending') return null;
  return mergeFollowUpPayloadById(row, {
    slack_action: {
      ...(row.payload.slack_action || {}),
      status: 'processing',
      error: null
    }
  });
}

async function handlePendingSlackActionRow(row) {
  const claimed = await claimSlackActionRow(row);
  if (!claimed) return { skipped: true, reason: 'already_claimed', id: row.id };
  const actionType = String(claimed.payload?.slack_action?.type || row.payload?.slack_action?.type || '');
  if (actionType !== 'send') {
    await mergeFollowUpPayloadById(claimed, {
      slack_action: {
        ...(claimed.payload?.slack_action || {}),
        status: 'error',
        error: `unsupported slack action type: ${actionType}`,
        handled_at: nowIso()
      }
    });
    return { ok: false, id: row.id, error: `unsupported slack action type: ${actionType}` };
  }
  const replyText = String(claimed.payload?.slack_draft_override || claimed.suggested_reply_draft || '').trim();
  if (!replyText) {
    await mergeFollowUpPayloadById(claimed, {
      slack_action: {
        ...(claimed.payload?.slack_action || {}),
        status: 'error',
        error: 'empty reply draft',
        handled_at: nowIso()
      }
    });
    return { ok: false, id: row.id, error: 'empty reply draft' };
  }
  try {
    const sendResult = await enqueueManualSend({
      text: replyText,
      customerName: claimed.customer_name || '',
      roomTitle: claimed.customer_name ? `${claimed.customer_name} - 빌리지 - 카카오비즈니스 파트너센터` : '',
      followUpId: row.id
    });
    const payloadPatch = {
      slack_action: {
        ...(claimed.payload?.slack_action || {}),
        status: sendResult.sent ? 'done' : 'error',
        error: sendResult.sent ? null : String(sendResult.reason || 'manual send failed').slice(0, 1000),
        handled_at: nowIso()
      }
    };
    const patch = {};
    if (sendResult.sent) patch.status = 'done';
    await mergeFollowUpPayloadById(claimed, payloadPatch, patch);
    state.slackActionsHandled += sendResult.sent ? 1 : 0;
    return { ok: Boolean(sendResult.sent), id: row.id, result: sendResult };
  } catch (error) {
    await mergeFollowUpPayloadById(claimed, {
      slack_action: {
        ...(claimed.payload?.slack_action || {}),
        status: 'error',
        error: error.message.slice(0, 1000),
        handled_at: nowIso()
      }
    });
    return { ok: false, id: row.id, error: error.message };
  }
}

async function runSlackActionPoll(reason = 'interval') {
  if (!CONFIG.slackActionPollEnabled || !supabaseConfigured()) return { skipped: true };
  if (state.slackActionPollRunning) return { skipped: true, reason: 'already_running' };
  state.slackActionPollRunning = true;
  const startedAt = nowIso();
  const result = { startedAt, reason, scanned: 0, handled: 0, errors: [] };
  try {
    const rows = await fetchPendingSlackActionRows(3);
    result.scanned = rows.length;
    for (const row of rows) {
      const handled = await handlePendingSlackActionRow(row);
      if (handled.ok) result.handled += 1;
      if (handled.error) result.errors.push({ id: row.id, error: handled.error });
    }
  } catch (error) {
    result.errors.push({ error: error.message });
    appendNdjson('errors.ndjson', { at: nowIso(), type: 'slack_action_poll', message: error.message });
  } finally {
    result.finishedAt = nowIso();
    state.lastSlackActionPoll = result;
    state.slackActionPollRunning = false;
  }
  return result;
}

async function runWorkerAndRecord(job, context = {}) {
  try {
    const workerResult = await enqueueWorker(job);
    try {
      await updateSupabaseEventByHash(job.jobId, buildWorkerResultPatch(job, workerResult));
    } catch (error) {
      state.failedSupabaseWrites += 1;
      appendNdjson('errors.ndjson', { at: nowIso(), type: 'supabase_job_update', message: error.message, jobId: job.jobId });
      console.warn('[dom-bridge] supabase job update failed:', error.message);
    }
    return { ok: true, workerResult };
  } catch (error) {
    state.failedWorkerRuns += 1;
    appendNdjson('errors.ndjson', { at: nowIso(), type: 'worker', message: error.message, job });
    let failureFollowUp = null;
    try {
      failureFollowUp = await createWorkerFailureFollowUp(job, error, {
        ...context,
        timeout: /timed out/i.test(error.message),
        failed_at: nowIso()
      });
      appendNdjson('worker-failure-followups.ndjson', { at: nowIso(), jobId: job.jobId, result: failureFollowUp });
    } catch (followUpError) {
      state.failedSupabaseWrites += 1;
      appendNdjson('errors.ndjson', { at: nowIso(), type: 'worker_failure_followup', message: followUpError.message, jobId: job.jobId });
    }
    await updateSupabaseEventByHash(job.jobId, {
      status: 'ai_worker_error',
      error_message: error.message.slice(0, 1000),
      completed_at: nowIso(),
      payload: {
        ...job,
        ai_worker_result: {
          error: error.message.slice(0, 1000),
          failure_follow_up: failureFollowUp
        }
      }
    }).catch((supabaseError) => {
      state.failedSupabaseWrites += 1;
      appendNdjson('errors.ndjson', { at: nowIso(), type: 'supabase_job_error_update', message: supabaseError.message, jobId: job.jobId });
    });
    console.warn('[dom-bridge] worker failed:', error.message);
    return { ok: false, error };
  }
}

async function flushRoom(roomKey) {
  const roomState = state.rooms.get(roomKey);
  if (!roomState) return;
  state.rooms.delete(roomKey);
  if (roomState.timer) clearTimeout(roomState.timer);
  if (roomState.maxTimer) clearTimeout(roomState.maxTimer);

  const job = buildAiFirstJob(roomKey, roomState);
  state.debouncedJobs += 1;
  appendNdjson('jobs.ndjson', job);
  console.info('[dom-bridge] debounced job ready', job.jobId, roomKey, `${job.eventCount} events`);

  let supabaseResult = null;
  try {
    supabaseResult = await writeSupabaseEvent(job, 'job');
  } catch (error) {
    state.failedSupabaseWrites += 1;
    appendNdjson('errors.ndjson', { at: nowIso(), type: 'supabase_job', message: error.message, job });
    console.warn('[dom-bridge] supabase job insert failed:', error.message);
  }

  if (supabaseResult?.duplicate && !shouldRunDuplicateJob(supabaseResult.existing)) {
    const reason = duplicateSkipReason(supabaseResult.existing);
    appendNdjson('worker-skipped.ndjson', { at: nowIso(), jobId: job.jobId, reason, roomKey, existing: supabaseResult.existing });
    console.info('[dom-bridge] worker skipped duplicate job', job.jobId, roomKey, supabaseResult.existing?.status || 'unknown');
    return;
  } else if (supabaseResult?.duplicate) {
    appendNdjson('worker-replayed.ndjson', { at: nowIso(), jobId: job.jobId, reason: 'duplicate_supabase_job_requeued', roomKey, existing: supabaseResult.existing });
    console.info('[dom-bridge] worker requeued duplicate job', job.jobId, roomKey, supabaseResult.existing?.status || 'unknown');
  }

  await runWorkerAndRecord(job, { origin: 'live_dom_event' });
}

function recoveryAttemptCount(row = {}) {
  const payload = objectPayload(row.payload);
  const recovery = objectPayload(payload.bridge_recovery);
  return Number(recovery.attempts || payload.bridge_recovery_attempts || 0) || 0;
}

function recoveryEscalated(row = {}) {
  const payload = objectPayload(row.payload);
  const recovery = objectPayload(payload.bridge_recovery);
  return Boolean(recovery.escalated_at || payload.bridge_recovery_escalated_at);
}

function rowAgeMs(row = {}, fieldOrder = ['updated_at', 'completed_at', 'created_at']) {
  for (const field of fieldOrder) {
    const value = Date.parse(row[field] || '');
    if (Number.isFinite(value)) return Date.now() - value;
  }
  return Number.POSITIVE_INFINITY;
}

function shouldRecoverSupabaseRow(row = {}) {
  const status = String(row.status || '');
  if (status === 'processing_by_ai_worker') return isDuplicateProcessingStale(row);
  if (status === 'ai_worker_error') {
    if (recoveryAttemptCount(row) >= CONFIG.supabaseRecoveryMaxAttempts) return false;
    return rowAgeMs(row) >= CONFIG.supabaseRecoveryErrorRetryMs;
  }
  return ['ready_for_ai_worker', 'ai_decision_ready_no_sheet_write'].includes(status);
}

function shouldSkipSupabaseRowAsLowValue(row = {}) {
  const event = {
    previewText: row.preview_text || objectPayload(row.payload).previewText || '',
    unreadCount: row.unread_count ?? objectPayload(row.payload).unreadCount ?? null,
    unreadSignal: objectPayload(row.payload).unreadSignal
  };
  return shouldSkipWorkerForPreview(event);
}

async function markSupabaseRowSkippedLowValue(row, reason) {
  const payload = objectPayload(row.payload);
  return updateSupabaseEventByHash(row.event_hash, {
    status: 'ai_skipped_needs_review',
    error_message: `Skipped before worker: ${reason}`,
    completed_at: nowIso(),
    payload: {
      ...payload,
      bridge_recovery: {
        ...objectPayload(payload.bridge_recovery),
        skipped_at: nowIso(),
        skipped_reason: reason
      }
    }
  });
}

function shouldEscalateExhaustedSupabaseRow(row = {}) {
  return row.status === 'ai_worker_error'
    && recoveryAttemptCount(row) >= CONFIG.supabaseRecoveryMaxAttempts
    && !recoveryEscalated(row);
}

function jobPriorityScore(row = {}) {
  const text = `${row.preview_text || ''} ${JSON.stringify(objectPayload(row.payload)).slice(0, 2000)}`;
  if (/(예약|대여|렌탈|반출|반납|가능|빌릴|빌리|장비|촬영|신청|확인요청)/.test(text)) return 0;
  if (/(가격|얼마|비용|견적|단가|요금|주소|위치|어디|영업|운영|절차|방법)/.test(text)) return 1;
  if (/(감사|고맙|넵|네|확인했습니다|알겠습니다)/.test(text)) return 8;
  return 4;
}

function buildJobFromSupabaseRow(row = {}, attempt = 0) {
  const payload = objectPayload(row.payload);
  const jobId = String(payload.jobId || payload.eventHash || row.event_hash || row.id || `supabase-${Date.now()}`);
  return {
    ...payload,
    id: row.id || payload.id,
    jobId,
    eventHash: row.event_hash || payload.eventHash || jobId,
    source: payload.source || 'kakao_channel_manager_dom',
    status: 'ready_for_ai_worker',
    roomKey: payload.roomKey || row.room_key || '',
    detectedAt: payload.detectedAt || row.detected_at || row.created_at || nowIso(),
    previewText: payload.previewText || row.preview_text || '',
    unreadCount: payload.unreadCount ?? row.unread_count ?? null,
    events: Array.isArray(payload.events) ? payload.events : [],
    replayedFromSupabase: true,
    recoveryAttempt: attempt,
    recoverySource: 'supabase_recovery_sweeper'
  };
}

async function fetchRecoverableSupabaseRows() {
  const scanLimit = Math.max(CONFIG.supabaseRecoveryBatchSize * 12, 24);
  const groups = await Promise.all([
    fetchSupabaseRowsByStatuses(['ready_for_ai_worker', 'ai_decision_ready_no_sheet_write'], scanLimit),
    fetchSupabaseRowsByStatuses(['processing_by_ai_worker'], scanLimit),
    fetchSupabaseRowsByStatuses(['ai_worker_error'], scanLimit)
  ]);
  const seen = new Set();
  return groups.flat()
    .filter((row) => {
      const key = row.id || row.event_hash;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => {
      const priority = jobPriorityScore(a) - jobPriorityScore(b);
      if (priority) return priority;
      return Date.parse(b.updated_at || b.created_at || 0) - Date.parse(a.updated_at || a.created_at || 0);
    });
}

async function markSupabaseRowClaimedForRecovery(row, attempt) {
  const payload = objectPayload(row.payload);
  const recovery = {
    ...objectPayload(payload.bridge_recovery),
    attempts: attempt,
    last_replayed_at: nowIso(),
    last_replay_reason: 'supabase_recovery_sweeper',
    row_id: row.id || null,
    previous_status: row.status || null
  };
  return updateSupabaseEventByHash(row.event_hash, {
    status: 'processing_by_ai_worker',
    claimed_at: nowIso(),
    error_message: null,
    payload: {
      ...payload,
      bridge_recovery: recovery
    }
  });
}

async function markSupabaseRowEscalated(row, followUpResult) {
  const payload = objectPayload(row.payload);
  const recovery = {
    ...objectPayload(payload.bridge_recovery),
    attempts: recoveryAttemptCount(row),
    escalated_at: nowIso(),
    escalated_reason: 'max_worker_recovery_attempts',
    follow_up_result: followUpResult || null
  };
  return updateSupabaseEventByHash(row.event_hash, {
    status: 'needs_human_review',
    error_message: 'AI worker failed repeatedly; escalated to follow-up dashboard',
    completed_at: nowIso(),
    payload: {
      ...payload,
      bridge_recovery: recovery
    }
  });
}

async function runSupabaseRecoverySweep(reason = 'interval') {
  if (!CONFIG.supabaseRecoveryEnabled || !supabaseConfigured() || !CONFIG.workerCommand) return { skipped: true };
  if (state.recoverySweepRunning) return { skipped: true, reason: 'already_running' };
  state.recoverySweepRunning = true;
  const startedAt = nowIso();
  const result = { startedAt, reason, scanned: 0, replayed: 0, escalated: 0, skipped: 0, errors: [] };
  try {
    const rows = await fetchRecoverableSupabaseRows();
    result.scanned = rows.length;
    for (const row of rows) {
      if (result.replayed >= CONFIG.supabaseRecoveryBatchSize) break;
      if (shouldEscalateExhaustedSupabaseRow(row)) {
        try {
          const job = buildJobFromSupabaseRow(row, recoveryAttemptCount(row));
          const followUpResult = await createWorkerFailureFollowUp(job, new Error(row.error_message || 'worker recovery attempts exhausted'), {
            origin: 'supabase_recovery_sweeper',
            exhausted: true
          });
          await markSupabaseRowEscalated(row, followUpResult);
          result.escalated += 1;
        } catch (error) {
          result.errors.push({ row: row.id || row.event_hash, message: error.message });
        }
        continue;
      }
      if (!shouldRecoverSupabaseRow(row)) {
        result.skipped += 1;
        continue;
      }
      const lowValueReason = shouldSkipSupabaseRowAsLowValue(row);
      if (lowValueReason) {
        try {
          await markSupabaseRowSkippedLowValue(row, lowValueReason);
          result.skipped += 1;
        } catch (error) {
          result.errors.push({ row: row.id || row.event_hash, message: error.message });
        }
        continue;
      }
      const attempt = recoveryAttemptCount(row) + 1;
      const job = buildJobFromSupabaseRow(row, attempt);
      try {
        await markSupabaseRowClaimedForRecovery(row, attempt);
        appendNdjson('worker-replayed.ndjson', { at: nowIso(), jobId: job.jobId, reason: 'supabase_recovery_sweeper', attempt, rowId: row.id, previousStatus: row.status });
        const outcome = await runWorkerAndRecord(job, {
          origin: 'supabase_recovery_sweeper',
          attempt,
          previous_status: row.status
        });
        result.replayed += 1;
        if (outcome.ok) state.recoveredJobs += 1;
      } catch (error) {
        result.errors.push({ row: row.id || row.event_hash, message: error.message });
      }
    }
    return result;
  } catch (error) {
    result.errors.push({ message: error.message });
    appendNdjson('errors.ndjson', { at: nowIso(), type: 'supabase_recovery_sweep', message: error.message });
    return result;
  } finally {
    result.finishedAt = nowIso();
    state.lastRecoverySweep = result;
    state.recoverySweepRunning = false;
    appendNdjson('recovery-sweeps.ndjson', result);
  }
}

function scheduleDebouncedJob(event) {
  const groupingText = normalizePreviewForGrouping(event.previewText);
  const roomKey = groupingText ? `preview:${sha256(groupingText).slice(0, 16)}` : (event.roomKey || 'unknown-room');
  const groupedEvent = {
    ...event,
    originalRoomKey: event.roomKey,
    roomKey,
    groupingText
  };
  let roomState = state.rooms.get(roomKey);
  if (!roomState) {
    roomState = {
      firstAt: nowIso(),
      lastAt: nowIso(),
      events: [],
      timer: null,
      maxTimer: null,
      hashes: new Set()
    };
    state.rooms.set(roomKey, roomState);
    roomState.maxTimer = setTimeout(() => flushRoom(roomKey), CONFIG.maxWaitMs);
  }

  roomState.lastAt = nowIso();
  const eventIdentity = groupedEvent.eventHash || sha256(JSON.stringify(groupedEvent));

  if (!roomState.hashes.has(eventIdentity)) {
    roomState.events.push(groupedEvent);
    roomState.hashes.add(eventIdentity);
  }

  if (roomState.timer) clearTimeout(roomState.timer);
  roomState.timer = setTimeout(() => flushRoom(roomKey), CONFIG.debounceMs);
}

function kakaoDevtoolsBaseUrl() {
  return CONFIG.kakaoDevtoolsUrl || `http://127.0.0.1:${CONFIG.kakaoRemoteDebuggingPort}`;
}

function isMainKakaoChatListUrl(url = '') {
  return /^https:\/\/(business|center-pf)\.kakao\.com\/_[^/]+\/chats(?:[?#]|$)/.test(String(url || ''));
}

function isKakaoConversationUrl(url = '') {
  const value = String(url || '');
  return /^https:\/\/(business|center-pf)\.kakao\.com\//.test(value) && !isMainKakaoChatListUrl(value);
}

async function fetchDevtools(pathname, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    return await fetch(`${kakaoDevtoolsBaseUrl()}${pathname}`, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function closeDevtoolsTab(tabId) {
  try {
    const response = await fetchDevtools(`/json/close/${encodeURIComponent(tabId)}`, { method: 'PUT' });
    if (response.ok) return true;
  } catch {}
  try {
    const response = await fetchDevtools(`/json/close/${encodeURIComponent(tabId)}`);
    return response.ok;
  } catch {
    return false;
  }
}

async function cleanupIdleKakaoConversationTabs(reason = 'interval') {
  if (!CONFIG.kakaoTabCleanupEnabled) return { skipped: true };
  if (state.workerRunning || state.workerQueueLength > 0 || state.rooms.size > 0) return { skipped: true, reason: 'worker_or_debounce_active' };
  if (state.tabCleanupRunning) return { skipped: true, reason: 'already_running' };
  state.tabCleanupRunning = true;
  const result = { at: nowIso(), reason, closed: 0, targets: [], errors: [] };
  try {
    const response = await fetchDevtools('/json/list');
    if (!response.ok) throw new Error(`DevTools tab list failed: ${response.status}`);
    const tabs = await response.json();
    const targets = (Array.isArray(tabs) ? tabs : [])
      .filter((tab) => tab?.type === 'page' && tab.id && isKakaoConversationUrl(tab.url));
    result.targets = targets.map((tab) => ({ id: tab.id, title: tab.title || '', url: tab.url || '' }));
    for (const tab of targets) {
      if (await closeDevtoolsTab(tab.id)) result.closed += 1;
    }
    state.closedKakaoTabs += result.closed;
    return result;
  } catch (error) {
    result.errors.push(error.message);
    appendNdjson('errors.ndjson', { at: nowIso(), type: 'kakao_tab_cleanup', message: error.message });
    return result;
  } finally {
    result.finishedAt = nowIso();
    state.lastTabCleanup = result;
    state.tabCleanupRunning = false;
    if (result.closed || result.errors.length) appendNdjson('tab-cleanups.ndjson', result);
  }
}

async function handleEvent(req, res) {
  const body = await readRequestBody(req);
  const raw = JSON.parse(body || '{}');
  const event = normalizeEvent(raw);

  state.received += 1;
  appendNdjson('events.ndjson', event);

  if (event.status === 'watcher_heartbeat' || event.reason === 'heartbeat' || event.reason === 'content_script_started') {
    if (event.reason === 'content_script_started') {
      state.lastContentScriptStartedAtMs = Date.now();
    }
    appendNdjson('heartbeats.ndjson', event);
    return json(res, 202, { ok: true, heartbeat: true });
  }

  if (event.status === 'popup_bridge_test' || event.reason === 'popup_bridge_test') {
    appendNdjson('diagnostics.ndjson', event);
    return json(res, 202, { ok: true, diagnostic: true });
  }

  if (event.status === 'dom_diagnostic' || event.reason === 'top_rows_snapshot') {
    appendNdjson('diagnostics.ndjson', event);
    return json(res, 202, { ok: true, diagnostic: true, queuedForAi: false });
  }

  if ((event.reason === 'top_rows_backstop' || event.reason === 'top_row_changed') && !shouldQueueTopRowEvent(event)) {
    appendNdjson('backstop-events.ndjson', {
      ...event,
      backstopReason: event.reason === 'top_rows_backstop' ? 'read_backstop_row' : 'non_live_top_row_change'
    });
    return json(res, 202, {
      ok: true,
      backstop: true,
      ignored: event.reason === 'top_rows_backstop' ? 'read_backstop_row' : 'non_live_top_row_change',
      queuedForAi: false
    });
  }

  if (isStaleDatedMutation(event)) {
    appendNdjson('ignored-stale-dated-mutation-events.ndjson', event);
    return json(res, 202, { ok: true, ignored: 'stale_dated_mutation', queuedForAi: false });
  }

  if (
    event.reason === 'mutation'
    && state.lastContentScriptStartedAtMs
    && Date.now() - state.lastContentScriptStartedAtMs < CONFIG.startupMutationIgnoreMs
  ) {
    appendNdjson('ignored-startup-mutation-events.ndjson', event);
    return json(res, 202, { ok: true, ignored: 'startup_mutation', queuedForAi: false });
  }

  if (event.reason === 'initial_scan' && !CONFIG.processInitialScan) {
    appendNdjson('initial-scans.ndjson', event);
    return json(res, 202, { ok: true, initialScan: true, queuedForAi: false });
  }

  if (isPageContainerPreview(event.previewText, event.roomKey)) {
    appendNdjson('ignored-container-events.ndjson', event);
    return json(res, 202, { ok: true, ignored: 'page_container', queuedForAi: false });
  }

  if (isActionChromePreview(event.previewText)) {
    appendNdjson('ignored-chrome-events.ndjson', event);
    return json(res, 202, { ok: true, ignored: 'action_chrome', queuedForAi: false });
  }

  const skipWorkerReason = shouldSkipWorkerForPreview(event);
  if (skipWorkerReason) {
    appendNdjson('ignored-low-value-events.ndjson', { ...event, ignored: skipWorkerReason });
    return json(res, 202, { ok: true, ignored: skipWorkerReason, queuedForAi: false });
  }

  if (isLikelyShiftedExistingRow(event)) {
    appendNdjson('ignored-shifted-row-events.ndjson', event);
    return json(res, 202, { ok: true, ignored: 'shifted_existing_row', queuedForAi: false });
  }

  console.info('[dom-bridge] event received', event.roomKey, event.reason, event.previewText.slice(0, 80));

  try {
    await writeSupabaseEvent(event, 'event');
  } catch (error) {
    state.failedSupabaseWrites += 1;
    appendNdjson('errors.ndjson', { at: nowIso(), type: 'supabase_event', message: error.message, event });
    console.warn('[dom-bridge] supabase event insert failed:', error.message);
  }

  scheduleDebouncedJob(event);
  return json(res, 202, { ok: true, roomKey: event.roomKey, eventHash: event.eventHash });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      return json(res, 204, {});
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

    if (req.method === 'GET' && url.pathname === '/health') {
      return json(res, 200, {
        ok: true,
        config: {
          port: CONFIG.port,
          debounceMs: CONFIG.debounceMs,
          maxWaitMs: CONFIG.maxWaitMs,
          queueDir: CONFIG.queueDir,
          supabaseEnabled: Boolean(CONFIG.supabaseUrl && CONFIG.supabaseServiceRoleKey && CONFIG.supabaseTable),
          workerEnabled: Boolean(CONFIG.workerCommand),
          workerLive: CONFIG.workerLive,
          autoSendEnabled: CONFIG.autoSendEnabled,
          workerTimeoutMs: CONFIG.workerTimeoutMs,
          supabaseTimeoutMs: CONFIG.supabaseTimeoutMs,
          supabaseRecoveryEnabled: CONFIG.supabaseRecoveryEnabled,
          supabaseRecoveryIntervalMs: CONFIG.supabaseRecoveryIntervalMs,
          supabaseRecoveryBatchSize: CONFIG.supabaseRecoveryBatchSize,
          supabaseRecoveryLookbackHours: CONFIG.supabaseRecoveryLookbackHours,
          supabaseRecoveryErrorRetryMs: CONFIG.supabaseRecoveryErrorRetryMs,
          supabaseRecoveryMaxAttempts: CONFIG.supabaseRecoveryMaxAttempts,
          slackActionPollEnabled: CONFIG.slackActionPollEnabled,
          slackActionPollIntervalMs: CONFIG.slackActionPollIntervalMs,
          kakaoTabCleanupEnabled: CONFIG.kakaoTabCleanupEnabled,
          kakaoTabCleanupIntervalMs: CONFIG.kakaoTabCleanupIntervalMs,
          processInitialScan: CONFIG.processInitialScan,
          ignoreShiftedRows: CONFIG.ignoreShiftedRows,
          topRowLiveWindowMinutes: CONFIG.topRowLiveWindowMinutes,
          readBackstopLookbackHours: CONFIG.readBackstopLookbackHours,
          readBackstopLookbackDays: CONFIG.readBackstopLookbackDays
        },
        state: {
          startedAt: state.startedAt,
          received: state.received,
          debouncedJobs: state.debouncedJobs,
          failedSupabaseWrites: state.failedSupabaseWrites,
          failedWorkerRuns: state.failedWorkerRuns,
          workerRunning: state.workerRunning,
          workerQueueLength: state.workerQueueLength,
          currentJobId: state.currentJobId,
          workerStartedAt: state.workerStartedAt,
          workerRunMs: state.workerStartedAt ? Date.now() - Date.parse(state.workerStartedAt) : 0,
          lastWorkerError: state.lastWorkerError,
          recoveredJobs: state.recoveredJobs,
          slackActionsHandled: state.slackActionsHandled,
          slackActionPollRunning: state.slackActionPollRunning,
          lastSlackActionPoll: state.lastSlackActionPoll,
          recoverySweepRunning: state.recoverySweepRunning,
          lastRecoverySweep: state.lastRecoverySweep,
          closedKakaoTabs: state.closedKakaoTabs,
          tabCleanupRunning: state.tabCleanupRunning,
          lastTabCleanup: state.lastTabCleanup,
          openRooms: state.rooms.size
        }
      });
    }

    if (req.method === 'POST' && url.pathname === '/events') {
      return await handleEvent(req, res);
    }

    if (req.method === 'POST' && url.pathname === '/manual-send') {
      const body = await readJsonBody(req);
      const text = String(body.text || '').trim();
      const customerName = String(body.customerName || body.customer_name || '').trim();
      const roomTitle = String(body.roomTitle || body.room_title || '').trim();
      if (!text || text.length < 2) return json(res, 400, { ok: false, error: 'text is required' });
      if (!customerName && !roomTitle) return json(res, 400, { ok: false, error: 'customerName or roomTitle is required' });
      const result = await enqueueManualSend({
        text,
        customerName,
        roomTitle,
        followUpId: body.followUpId || body.follow_up_id || ''
      });
      return json(res, result.sent ? 200 : 502, { ok: Boolean(result.sent), result });
    }

    if (req.method === 'GET' && url.pathname === '/slack/follow-up') {
      const id = String(url.searchParams.get('id') || '').trim();
      if (!id) return json(res, 400, { ok: false, error: 'id is required' });
      const row = await fetchFollowUpRowById(id);
      return json(res, row ? 200 : 404, { ok: Boolean(row), row });
    }

    if (req.method === 'POST' && url.pathname === '/slack/actions') {
      const body = await readJsonBody(req);
      const result = await applySlackFollowUpActionRequest(body);
      return json(res, 200, result);
    }

    if (req.method === 'POST' && url.pathname === '/maintenance/recover') {
      const result = await runSupabaseRecoverySweep('manual');
      return json(res, 200, { ok: !result.errors?.length, result });
    }

    if (req.method === 'POST' && url.pathname === '/maintenance/slack-actions') {
      const result = await runSlackActionPoll('manual');
      return json(res, 200, { ok: !result.errors?.length, result });
    }

    if (req.method === 'POST' && url.pathname === '/maintenance/cleanup-tabs') {
      const result = await cleanupIdleKakaoConversationTabs('manual');
      return json(res, 200, { ok: !result.errors?.length, result });
    }

    return json(res, 404, { ok: false, error: 'not found' });
  } catch (error) {
    appendNdjson('errors.ndjson', { at: nowIso(), type: 'request', message: error.message });
    return json(res, 500, { ok: false, error: error.message });
  }
});

ensureQueueDir();
server.listen(CONFIG.port, '127.0.0.1', () => {
  console.info(`[dom-bridge] listening on http://127.0.0.1:${CONFIG.port}`);
  console.info(`[dom-bridge] queue dir: ${CONFIG.queueDir}`);
  console.info(`[dom-bridge] supabase: ${CONFIG.supabaseUrl && CONFIG.supabaseTable ? 'enabled' : 'disabled'}`);
  console.info(`[dom-bridge] worker: ${CONFIG.workerCommand ? CONFIG.workerCommand : 'disabled'}`);
  if (CONFIG.supabaseRecoveryEnabled) {
    setTimeout(() => runSupabaseRecoverySweep('startup'), 5000).unref?.();
    setInterval(() => runSupabaseRecoverySweep('interval'), CONFIG.supabaseRecoveryIntervalMs).unref?.();
  }
  if (CONFIG.slackActionPollEnabled) {
    setTimeout(() => runSlackActionPoll('startup'), 7000).unref?.();
    setInterval(() => runSlackActionPoll('interval'), CONFIG.slackActionPollIntervalMs).unref?.();
  }
  if (CONFIG.kakaoTabCleanupEnabled) {
    setTimeout(() => cleanupIdleKakaoConversationTabs('startup'), 10_000).unref?.();
    setInterval(() => cleanupIdleKakaoConversationTabs('interval'), CONFIG.kakaoTabCleanupIntervalMs).unref?.();
  }
});
