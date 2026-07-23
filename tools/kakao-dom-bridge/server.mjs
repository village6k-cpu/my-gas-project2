import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns';
import { spawn, spawnSync } from 'node:child_process';
import { deliverSlackFollowUpRows, processManualSend, upsertFollowUpRows } from '../ai-browser-worker/worker.mjs';

function loadSelectedEnvFile(filePath, keys = []) {
  const allowed = new Set(keys);
  if (!filePath || !fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || !allowed.has(match[1]) || process.env[match[1]]) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

loadSelectedEnvFile(path.resolve(process.env.HOME || '', '.hermes/.env'), ['SLACK_BOT_TOKEN']);

function readBooleanEnvironment(value, defaultValue = false) {
  if (value === undefined || value === null || String(value).trim() === '') return defaultValue;
  return ['1', 'true'].includes(String(value).trim().toLowerCase());
}

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
  slackActionPollEnabled: readBooleanEnvironment(process.env.SLACK_ACTION_POLL_ENABLED, true),
  slackActionPollIntervalMs: Number(process.env.SLACK_ACTION_POLL_INTERVAL_MS || 10_000),
  slackBotToken: process.env.SLACK_BOT_TOKEN || '',
  followUpRowsEnabled: process.env.AI_WORKER_FOLLOW_UP_ITEMS_ENABLED !== '0' && process.env.KAKAO_FOLLOW_UP_ITEMS_ENABLED !== '0',
  slackCardDeliveryEnabled: process.env.SLACK_AGENT_CARD_DELIVERY_ENABLED === '1',
  slackChannels: {
    schedule: process.env.SLACK_CHANNEL_SCHEDULE_AGENT || '스케쥴-agent',
    document: process.env.SLACK_CHANNEL_DOCUMENT_AGENT || '서류발송-agent',
    settlement: process.env.SLACK_CHANNEL_SETTLEMENT_AGENT || '정산-agent',
    inventory: process.env.SLACK_CHANNEL_INVENTORY_AGENT || '재고관리-agent',
    other: process.env.SLACK_CHANNEL_OTHER_AGENT || '기타문의'
  },
  manualSendDedupeWindowMs: Number(process.env.MANUAL_SEND_DEDUPE_WINDOW_MS || 10 * 60_000),
  kakaoDevtoolsUrl: (process.env.KAKAO_DEVTOOLS_URL || process.env.KAKAO_CDP_HTTP_URL || process.env.KAKAO_CDP_URL || '').replace(/\/+$/, ''),
  kakaoRemoteDebuggingPort: process.env.KAKAO_REMOTE_DEBUGGING_PORT || process.env.VILLAGE_KAKAO_REMOTE_DEBUGGING_PORT || '9223',
  kakaoTabCleanupEnabled: readBooleanEnvironment(process.env.KAKAO_TAB_CLEANUP_ENABLED, true),
  kakaoTabCleanupIntervalMs: Number(process.env.KAKAO_TAB_CLEANUP_INTERVAL_MS || 120_000),
  // The extension can emit a full DOM payload for every mutation. Keep queue
  // diagnostics bounded so observability cannot consume the host disk and
  // starve the watcher that it is meant to protect.
  queueLogMaxBytes: Math.max(1 * 1024 * 1024, Number(process.env.QUEUE_LOG_MAX_BYTES || 32 * 1024 * 1024)),
  queueLogArchiveCount: Math.max(1, Number(process.env.QUEUE_LOG_ARCHIVE_COUNT || 10)),
  dnsFallbackServers: String(process.env.DNS_FALLBACK_SERVERS || '168.126.63.1,168.126.63.2,1.1.1.1')
    .split(',')
    .map((server) => server.trim())
    .filter(Boolean)
};

const dnsFallbackResolver = new dns.Resolver();
if (CONFIG.dnsFallbackServers.length) {
  dnsFallbackResolver.setServers(CONFIG.dnsFallbackServers);
}

function lookupWithDnsFallback(hostname, options, callback) {
  dns.lookup(hostname, options, (lookupError, address, family) => {
    if (!lookupError) {
      callback(null, address, family);
      return;
    }
    dnsFallbackResolver.resolve4(hostname, (resolveError, addresses) => {
      if (resolveError || !addresses?.length) {
        callback(lookupError);
        return;
      }
      if (options?.all) {
        callback(null, addresses.map((resolvedAddress) => ({ address: resolvedAddress, family: 4 })));
        return;
      }
      callback(null, addresses[0], 4);
    });
  });
}

async function fetchWithDnsFallback(endpoint, init = {}) {
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || ['127.0.0.1', 'localhost'].includes(url.hostname)) {
    return fetch(endpoint, init);
  }
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(url, {
      method: init.method || 'GET',
      headers: init.headers || {},
      lookup: lookupWithDnsFallback
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          text: async () => body
        });
      });
    });
    req.on('error', reject);
    if (init.signal) {
      if (init.signal.aborted) req.destroy(init.signal.reason);
      init.signal.addEventListener('abort', () => req.destroy(init.signal.reason), { once: true });
    }
    if (init.body) req.write(init.body);
    req.end();
  });
}

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
  activeWorkerJobIds: new Set(),
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

export function buildCorsHeaders() {
  return {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-private-network': 'true'
  };
}

function json(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, buildCorsHeaders());
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

function inferKakaoUnreadCountFromPreview(text = '') {
  const preview = String(text || '').replace(/\s+/g, ' ').trim();
  const match = /^중요\s+(.{1,90}?)\s+([1-9]\d?)\s+(\S.*)$/.exec(preview);
  if (!match) return null;
  const count = Number(match[2]);
  if (!Number.isFinite(count) || count <= 0 || count > 20) return null;
  const next = match[3] || '';
  if (/^(월|일|시|분|초|원|개|건|구|세트|set\b)/i.test(next)) return null;
  return count;
}

export function normalizeEvent(raw = {}) {
  const source = String(raw.source || 'kakao_channel_manager_dom');
  const roomKey = String(raw.roomKey || raw.room_key || raw.roomHint || raw.previewText || 'unknown-room');
  const previewText = String(raw.previewText || raw.preview_text || '').slice(0, 500);
  const customerName = String(raw.customerName || raw.customer_name || '').slice(0, 120);
  const messagePreview = String(raw.messagePreview || raw.message_preview || '').slice(0, 500);
  const displayTime = String(raw.displayTime || raw.display_time || '').slice(0, 80);
  const detectedAt = String(raw.detectedAt || raw.detected_at || nowIso());
  const eventHash = String(raw.eventHash || raw.event_hash || sha256(JSON.stringify({ source, roomKey, previewText, detectedAt })));
  const unreadCount = raw.unreadCount ?? raw.unread_count ?? inferKakaoUnreadCountFromPreview(previewText);

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
    customerName,
    messagePreview,
    displayTime,
    unreadCount,
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

export function roomKeyForDebounce(event = {}) {
  const supplied = String(event.roomKey || event.room_key || '').trim();
  if (/^(?:chat|attr):/.test(supplied)) return supplied;

  const customerName = String(event.customerName || event.customer_name || '').trim();
  if (customerName) return `customer:${sha256(customerName).slice(0, 16)}`;

  const groupingText = normalizePreviewForGrouping(event.previewText || event.preview_text || '');
  return groupingText ? `preview:${sha256(groupingText).slice(0, 16)}` : (supplied || 'unknown-room');
}

function cleanPreviewText(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/^중요\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function shouldSkipWorkerForPreview(event = {}) {
  // Preview text is not authoritative conversation context. A trailing thanks,
  // an apparent outbound marker, or a short payment/return acknowledgement can
  // follow an unresolved request. Structural noise is filtered separately;
  // every real message preview must reach Hermes for semantic judgment.
  void event;
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

export function hasUnreadCount(event = {}) {
  const inferred = inferKakaoUnreadCountFromPreview(event.previewText || event.raw?.previewText || '');
  const count = Number(event.unreadCount ?? event.unread_count ?? event.raw?.unreadCount ?? event.raw?.unread_count ?? inferred ?? 0);
  if (Number.isFinite(count) && count > 0) return true;

  // `unreadSignal` historically came from a broad DOM class match (`Badge`).
  // A boolean detached from a visible unread count is not trustworthy enough to
  // let a periodic top-row scan create a worker job or a human-review card.
  // Keep an explicit textual unread label as the safe fallback.
  const preview = String(event.previewText || '');
  return /안읽|읽지\s*않은|새\s*메시지|unread/i.test(preview);
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

export function shouldQueueTopRowEvent(event) {
  if (isActionChromePreview(event.previewText)) return false;
  if (hasUnreadCount(event)) return !hasDatedPreview(event.previewText) || isRecentDatedPreview(event.previewText);
  if (event.reason === 'top_rows_backstop') return false;
  return event.reason === 'top_row_changed'
    && isLiveTopRowPreview(event.previewText);
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

function compactQueueAuditText(value, maxLength = 1200) {
  const text = String(value || '').trim();
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

function compactQueueAuditRecord(filename, object = {}) {
  // Queue files are audit/status streams, not the source of truth: the full
  // normalized event is already persisted in Supabase. Logging raw extension
  // DOM snapshots here used tens of GB per day and eventually made the bridge
  // unreliable. Keep the fields consumed by the watchdog and short evidence.
  const base = {
    at: object.at || '',
    receivedAt: object.receivedAt || '',
    detectedAt: object.detectedAt || '',
    status: object.status || '',
    reason: object.reason || '',
    jobId: object.jobId || '',
    roomKey: object.roomKey || object.room_key || '',
    customerName: object.customerName || object.customer_name || '',
    previewText: compactQueueAuditText(object.previewText || object.preview_text || '', 600)
  };
  if (filename === 'worker-results.ndjson') {
    const result = object.result || {};
    return {
      ...base,
      result: {
        code: result.code ?? null,
        signal: result.signal || null,
        timedOut: result.timedOut === true,
        stdoutTail: compactQueueAuditText(result.stdout, 1600),
        stderrTail: compactQueueAuditText(result.stderr, 1600)
      }
    };
  }
  if (filename === 'errors.ndjson') {
    return {
      ...base,
      type: object.type || '',
      message: compactQueueAuditText(object.message || object.error || '', 1600)
    };
  }
  return base;
}

function rotateQueueLogIfNeeded(filename, incomingBytes) {
  const filePath = path.join(CONFIG.queueDir, filename);
  try {
    const stat = fs.statSync(filePath);
    if (stat.size + incomingBytes <= CONFIG.queueLogMaxBytes) return;
    const archivePath = `${filePath}.${Date.now()}.${process.pid}`;
    fs.renameSync(filePath, archivePath);
    const prefix = `${filename}.`;
    const archives = fs.readdirSync(CONFIG.queueDir)
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => ({ entry, mtimeMs: fs.statSync(path.join(CONFIG.queueDir, entry)).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    archives.slice(CONFIG.queueLogArchiveCount).forEach(({ entry }) => {
      try { fs.unlinkSync(path.join(CONFIG.queueDir, entry)); } catch (_) {}
    });
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn(`[kakao-dom-bridge] queue log rotation failed for ${filename}: ${error.message}`);
  }
}

function appendNdjson(filename, object) {
  ensureQueueDir();
  const record = compactQueueAuditRecord(filename, object);
  const line = `${JSON.stringify(record)}\n`;
  rotateQueueLogIfNeeded(filename, Buffer.byteLength(line));
  fs.appendFileSync(path.join(CONFIG.queueDir, filename), line, 'utf8');
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
  const response = await fetchWithDnsFallback(endpoint, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
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

  // Do not re-enqueue the same unread/backstop job on every DOM scan while the
  // durable recovery sweeper is responsible for ready/error rows. The previous
  // behaviour requeued duplicate ready_for_ai_worker rows indefinitely, which
  // kept the in-memory worker queue full and delayed real auto-replies.
  if (['ready_for_ai_worker', 'pending_ai_review'].includes(status)) {
    return rowAgeMs(existing, ['updated_at', 'created_at']) > Math.max(CONFIG.workerTimeoutMs * 2, 10 * 60_000);
  }
  if (status === 'ai_worker_error') {
    if (recoveryAttemptCount(existing) >= CONFIG.supabaseRecoveryMaxAttempts) return false;
    return rowAgeMs(existing) >= CONFIG.supabaseRecoveryErrorRetryMs;
  }
  if (status === 'ai_decision_ready_no_sheet_write') return false;
  return false;
}

function duplicateSkipReason(existing = {}) {
  const status = String(existing?.status || '');
  if (status === 'processing_by_ai_worker') return 'duplicate_supabase_job_in_progress';
  if (['ready_for_ai_worker', 'pending_ai_review'].includes(status)) return 'duplicate_supabase_job_waiting_for_recovery_sweeper';
  if (status === 'ai_worker_error') return 'duplicate_supabase_job_error_retry_cooldown';
  return 'duplicate_supabase_job_already_handled';
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

function shouldEscalateCompletedWorkerSkip(job = {}, workerPayload = {}) {
  const decision = workerPayload.decision || {};
  const followUpResult = workerPayload.followUpResult || workerPayload.follow_up_result || {};
  const sheetResult = workerPayload.sheetResult || workerPayload.sheet_result || null;
  const insertedFollowUps = Number(followUpResult.inserted || 0);
  if (insertedFollowUps > 0 || (Array.isArray(followUpResult.rows) && followUpResult.rows.length > 0)) return false;
  if (decision.should_write_to_sheet === true || sheetResult?.success === true) return false;

  const reason = String(decision.reason || '').toLowerCase();
  const chatStatus = String(decision.customer?.chat_status || '').toLowerCase();

  // A completed worker can still silently drop a real reservation when the Kakao
  // room could not be opened and the worker correctly refuses preview-only
  // classification. Those cases must become a human-review card, not disappear.
  return /matching kakao conversation not|not opened|not visible|chat[_ -]?row[_ -]?not[_ -]?found|preview only|preview-only/.test(reason)
    || /not opened|not found|not visible|chat_row_not_found|preview/.test(chatStatus);
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
    customerName: latest.customerName || latest.customer_name || latest.raw?.customerName || latest.raw?.customer_name || '',
    messagePreview: latest.messagePreview || latest.message_preview || latest.raw?.messagePreview || latest.raw?.message_preview || '',
    displayTime: latest.displayTime || latest.display_time || latest.raw?.displayTime || latest.raw?.display_time || '',
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
    followUpTable: CONFIG.followUpTable,
    slackFollowUpEnabled: CONFIG.slackCardDeliveryEnabled,
    slackThreadFollowUpsEnabled: process.env.SLACK_FOLLOW_UP_THREAD_REPLIES !== '0',
    slackBotToken: CONFIG.slackBotToken,
    slackChannels: CONFIG.slackChannels
  };
}

async function createWorkerFailureFollowUp(job = {}, error = new Error('worker failed'), context = {}) {
  if (!supabaseConfigured()) return { skipped: true, reason: 'supabase_not_configured' };
  const preview = previewForJob(job);
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
  const upsertResult = await upsertFollowUpRows(followUpConfig(), [row]);
  if (CONFIG.slackCardDeliveryEnabled && upsertResult?.rows?.length) {
    try {
      const slackDeliveryResult = await deliverSlackFollowUpRows(followUpConfig(), upsertResult.rows);
      return { ...upsertResult, slackDeliveryResult };
    } catch (deliveryError) {
      appendNdjson('errors.ndjson', {
        at: nowIso(),
        type: 'worker_failure_followup_slack_delivery',
        message: deliveryError.message,
        jobId
      });
      return { ...upsertResult, slackDeliveryError: deliveryError.message };
    }
  }
  return upsertResult;
}

export function shouldDetachWorkerProcess(platform = process.platform) {
  return platform !== 'win32';
}

export function buildWorkerTreeKillInvocation(pid, signal = 'SIGTERM', platform = process.platform) {
  if (platform !== 'win32') return null;
  const args = ['/PID', String(pid), '/T'];
  if (signal === 'SIGKILL') args.push('/F');
  return {
    command: 'taskkill.exe',
    args,
    options: { shell: false, stdio: 'ignore', windowsHide: true }
  };
}

function killProcessTree(child, signal = 'SIGTERM') {
  if (!child?.pid) return;
  const windowsKill = buildWorkerTreeKillInvocation(child.pid, signal);
  if (windowsKill) {
    try {
      const result = spawnSync(windowsKill.command, windowsKill.args, windowsKill.options);
      if (!result.error) return;
    } catch {}
  }
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

const WORKER_STDOUT_LIMIT = 2_000_000;
const WORKER_STDERR_LIMIT = 50_000;

function runWorker(job) {
  if (!CONFIG.workerCommand) return Promise.resolve({ skipped: true });

  return new Promise((resolve, reject) => {
    const child = spawn(CONFIG.workerCommand, {
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
      detached: shouldDetachWorkerProcess()
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

    child.stdout.on('data', (chunk) => { stdout = appendLimited(stdout, chunk, WORKER_STDOUT_LIMIT); });
    child.stderr.on('data', (chunk) => { stderr = appendLimited(stderr, chunk, WORKER_STDERR_LIMIT); });
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
const queuedWorkerSlotsByRoom = new Map();
const manualSendInFlight = new Map();
const manualSendRecent = new Map();

export function mergeQueuedRoomJobs(previous = {}, latest = {}) {
  const seen = new Set();
  const events = [];
  for (const event of [...(previous.events || []), ...(latest.events || [])]) {
    const identity = event?.eventHash || sha256(JSON.stringify(event || {}));
    if (seen.has(identity)) continue;
    seen.add(identity);
    events.push(event);
  }
  return {
    ...previous,
    ...latest,
    firstEventAt: previous.firstEventAt || latest.firstEventAt,
    eventCount: events.length,
    events
  };
}

function normalizeManualSendDedupeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function manualSendDedupeKey(payload = {}) {
  if (payload.allowDuplicate === true || payload.allow_duplicate === true) return '';
  const explicit = normalizeManualSendDedupeText(payload.idempotencyKey || payload.idempotency_key || '');
  if (explicit) return `explicit:${sha256(explicit)}`;
  const keyPayload = {
    customerName: normalizeManualSendDedupeText(payload.customerName || payload.customer_name || ''),
    roomTitle: normalizeManualSendDedupeText(payload.roomTitle || payload.room_title || ''),
    text: normalizeManualSendDedupeText(payload.text || ''),
    customerDocumentAssets: Boolean(payload.customerDocumentAssets || payload.customer_document_assets),
    attachmentPaths: Array.isArray(payload.attachmentPaths || payload.attachment_paths)
      ? (payload.attachmentPaths || payload.attachment_paths).map(normalizeManualSendDedupeText).sort()
      : []
  };
  if (!keyPayload.text || (!keyPayload.customerName && !keyPayload.roomTitle)) return '';
  return `auto:${sha256(JSON.stringify(keyPayload))}`;
}

function pruneManualSendRecent(nowMs = Date.now()) {
  const ttl = Math.max(0, Number(CONFIG.manualSendDedupeWindowMs || 0));
  for (const [key, entry] of manualSendRecent.entries()) {
    if (!entry || nowMs - Number(entry.atMs || 0) > ttl) manualSendRecent.delete(key);
  }
}

function recentManualSendResult(dedupeKey) {
  if (!dedupeKey || CONFIG.manualSendDedupeWindowMs <= 0) return null;
  const nowMs = Date.now();
  pruneManualSendRecent(nowMs);
  const entry = manualSendRecent.get(dedupeKey);
  if (!entry || nowMs - Number(entry.atMs || 0) > CONFIG.manualSendDedupeWindowMs) return null;
  return entry.result || null;
}

function rememberManualSendResult(dedupeKey, result) {
  if (!dedupeKey || CONFIG.manualSendDedupeWindowMs <= 0 || !result?.sent) return;
  manualSendRecent.set(dedupeKey, { atMs: Date.now(), result });
  pruneManualSendRecent();
}

function duplicateManualSendResult(result, reason) {
  return {
    ...(result || {}),
    attempted: true,
    sent: Boolean(result?.sent),
    reason: result?.sent ? reason : (result?.reason || reason),
    deduped: true,
    dedupeReason: reason
  };
}

function enqueueWorker(job) {
  if (!CONFIG.workerCommand) return Promise.resolve({ skipped: true });
  const jobId = String(job?.jobId || '');
  if (jobId && state.activeWorkerJobIds.has(jobId)) {
    const result = { skipped: true, reason: 'local_duplicate_job_active', jobId };
    appendNdjson('worker-skipped.ndjson', { at: nowIso(), jobId, reason: result.reason, roomKey: job.roomKey || '' });
    console.info('[dom-bridge] worker skipped local duplicate job', jobId, job.roomKey || '');
    return Promise.resolve(result);
  }

  const roomKey = String(job?.roomKey || '');
  const existingSlot = roomKey ? queuedWorkerSlotsByRoom.get(roomKey) : null;
  if (existingSlot && !existingSlot.started) {
    const supersededJob = existingSlot.job;
    const supersededJobId = String(supersededJob?.jobId || '');
    if (supersededJobId) state.activeWorkerJobIds.delete(supersededJobId);
    existingSlot.external?.resolve({
      skipped: true,
      reason: 'superseded_by_newer_room_event',
      jobId: supersededJobId,
      supersededBy: jobId
    });
    existingSlot.job = mergeQueuedRoomJobs(supersededJob, job);
    if (jobId) state.activeWorkerJobIds.add(jobId);
    appendNdjson('worker-coalesced.ndjson', {
      at: nowIso(),
      roomKey,
      supersededJobId,
      replacementJobId: jobId,
      eventCount: existingSlot.job.eventCount
    });
    return new Promise((resolve, reject) => {
      existingSlot.external = { resolve, reject };
    });
  }

  if (jobId) state.activeWorkerJobIds.add(jobId);
  const slot = { job, roomKey, started: false, external: null };
  const externalPromise = new Promise((resolve, reject) => {
    slot.external = { resolve, reject };
  });
  if (roomKey) queuedWorkerSlotsByRoom.set(roomKey, slot);
  state.workerQueueLength += 1;
  const run = async () => {
    slot.started = true;
    if (roomKey && queuedWorkerSlotsByRoom.get(roomKey) === slot) queuedWorkerSlotsByRoom.delete(roomKey);
    const queuedJob = slot.job;
    const queuedJobId = String(queuedJob?.jobId || '');
    state.workerQueueLength = Math.max(0, state.workerQueueLength - 1);
    state.workerRunning = true;
    state.currentJobId = queuedJob.jobId;
    state.workerStartedAt = nowIso();
    console.info('[dom-bridge] worker start', queuedJob.jobId, 'queued:', state.workerQueueLength);
    try {
      const result = await runWorker(queuedJob);
      state.lastWorkerError = null;
      return result;
    } catch (error) {
      state.lastWorkerError = { at: nowIso(), jobId: queuedJob.jobId, message: error.message.slice(0, 1000) };
      throw error;
    } finally {
      if (queuedJobId) state.activeWorkerJobIds.delete(queuedJobId);
      state.workerRunning = false;
      state.currentJobId = null;
      state.workerStartedAt = null;
      console.info('[dom-bridge] worker done', queuedJob.jobId, 'queued:', state.workerQueueLength);
      await cleanupIdleKakaoConversationTabs('worker_finished', { allowQueued: true });
    }
  };
  const execution = workerChain.then(run, run);
  workerChain = execution.catch(() => {});
  execution.then(
    (result) => slot.external?.resolve(result),
    (error) => slot.external?.reject(error)
  );
  return externalPromise;
}

function enqueueManualSend(payload) {
  const jobId = `manual-send-${Date.now()}`;
  const dedupeKey = manualSendDedupeKey(payload);
  const recentResult = recentManualSendResult(dedupeKey);
  if (recentResult) {
    const result = duplicateManualSendResult(recentResult, 'duplicate_manual_send_suppressed_recent_success');
    appendNdjson('manual-send-dedupe.ndjson', {
      at: nowIso(),
      jobId,
      dedupeKey,
      action: result.dedupeReason,
      payload: { ...payload, text: '[redacted]' },
      sent: result.sent
    });
    console.info('[dom-bridge] manual send duplicate suppressed recent', jobId, payload.customerName || payload.roomTitle || '');
    return Promise.resolve(result);
  }

  const inFlight = dedupeKey ? manualSendInFlight.get(dedupeKey) : null;
  if (inFlight) {
    appendNdjson('manual-send-dedupe.ndjson', {
      at: nowIso(),
      jobId,
      dedupeKey,
      action: 'duplicate_manual_send_joined_inflight',
      payload: { ...payload, text: '[redacted]' }
    });
    console.info('[dom-bridge] manual send duplicate joined in-flight', jobId, payload.customerName || payload.roomTitle || '');
    return inFlight.then((result) => duplicateManualSendResult(result, 'duplicate_manual_send_suppressed_inflight'));
  }

  const run = async () => {
    state.workerRunning = true;
    state.currentJobId = jobId;
    state.workerStartedAt = nowIso();
    console.info('[dom-bridge] manual send start', jobId, payload.customerName || payload.roomTitle || '');
    try {
      const result = await processManualSend(payload);
      state.lastWorkerError = null;
      rememberManualSendResult(dedupeKey, result);
      appendNdjson('manual-sends.ndjson', { at: nowIso(), jobId, dedupeKey, payload: { ...payload, text: '[redacted]' }, result });
      return result;
    } catch (error) {
      state.lastWorkerError = { at: nowIso(), jobId, message: error.message.slice(0, 1000) };
      appendNdjson('errors.ndjson', { at: nowIso(), type: 'manual_send', message: error.message, dedupeKey, payload: { ...payload, text: '[redacted]' } });
      throw error;
    } finally {
      state.workerRunning = false;
      state.currentJobId = null;
      state.workerStartedAt = null;
      console.info('[dom-bridge] manual send done', jobId);
    }
  };
  const queued = workerChain.then(run, run);
  if (dedupeKey) {
    manualSendInFlight.set(dedupeKey, queued);
    queued.finally(() => {
      if (manualSendInFlight.get(dedupeKey) === queued) manualSendInFlight.delete(dedupeKey);
    }).catch(() => {});
  }
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

function slackEscape(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function truncateSlack(value = '', max = 240) {
  const clean = slackEscape(value).trim();
  return clean.length > max ? `${clean.slice(0, Math.max(0, max - 1))}…` : clean;
}

function slackStatusLabel(status = '') {
  const labels = {
    open: '열림',
    in_progress: '진행중',
    waiting_customer: '고객 대기',
    waiting_internal: '내부 확인 대기',
    done: '완료',
    dismissed: '무시'
  };
  return labels[status] || status || '처리됨';
}

function slackResolutionLabel(resolution = {}) {
  if (resolution.kind === 'send_pending') return { icon: '📨', label: '카카오 전송 요청 접수', detail: '로컬 브릿지가 전송을 처리하는 중입니다.' };
  if (resolution.kind === 'send_done') return { icon: '✅', label: '카카오 전송 완료', detail: '카카오 발송 확인까지 완료했습니다.' };
  if (resolution.kind === 'send_error') return { icon: '⚠️', label: '카카오 전송 실패', detail: resolution.error || '전송 처리 중 오류가 발생했습니다.' };
  if (resolution.kind === 'status') {
    if (resolution.status === 'done') return { icon: '✅', label: '완료 처리됨', detail: '이 후속처리는 완료로 표시됐습니다.' };
    if (resolution.status === 'dismissed') return { icon: '🚫', label: '무시 처리됨', detail: '이 후속처리는 무시로 표시됐습니다.' };
    if (resolution.status === 'in_progress') return { icon: '🟡', label: '진행중으로 잡힘', detail: '누군가 이 건을 처리 중입니다.' };
    return { icon: '☑️', label: `${slackStatusLabel(resolution.status)} 상태로 변경됨`, detail: '버튼 입력이 반영됐습니다.' };
  }
  return { icon: '☑️', label: '버튼 입력 반영됨', detail: '이 카드의 버튼은 비활성화됐습니다.' };
}

function slackMessageRefForAction(row = {}, resolution = {}) {
  const payload = row?.payload && typeof row.payload === 'object' ? row.payload : {};
  const delivery = payload.slack_delivery && typeof payload.slack_delivery === 'object' ? payload.slack_delivery : {};
  const action = payload.slack_action && typeof payload.slack_action === 'object' ? payload.slack_action : {};
  return {
    channel: resolution.channelId || action.channel_id || delivery.channel_id || row.slack_channel_id || '',
    ts: resolution.messageTs || action.message_ts || delivery.message_ts || row.slack_message_ts || ''
  };
}

function buildResolvedSlackFollowUpMessage(row = {}, resolution = {}) {
  const { icon, label, detail } = slackResolutionLabel(resolution);
  const customer = truncateSlack(row.customer_name || '고객명 미확인', 80);
  const title = truncateSlack(row.title || row.summary || '후속처리', 260);
  const requestedBy = resolution.requestedBy ? `<@${slackEscape(resolution.requestedBy)}>` : 'Slack 버튼';
  const requestedAt = resolution.requestedAt || nowIso();
  const lines = [
    `*상태*\n${icon} ${slackEscape(label)}`,
    detail ? `*메모*\n${truncateSlack(detail, 500)}` : '',
    `*작업*\n${title}`,
    `*처리*\n${requestedBy} · ${slackEscape(requestedAt)}`
  ].filter(Boolean);
  return {
    text: `${icon} ${row.customer_name || '후속처리'} ${label}`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `${icon} ${customer}`.slice(0, 150), emoji: true }
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: lines.join('\n\n') }
      }
    ]
  };
}

async function slackApi(method, payload = {}) {
  if (!CONFIG.slackBotToken) throw new Error('Missing SLACK_BOT_TOKEN');
  const response = await fetchWithDnsFallback(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${CONFIG.slackBotToken}`,
      'content-type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify(payload)
  });
  const body = await response.text();
  let data = null;
  try { data = body ? JSON.parse(body) : {}; } catch { data = { raw: body }; }
  if (!response.ok || data?.ok === false) throw new Error(`Slack ${method} failed: ${data?.error || body}`);
  return data;
}

async function replaceSlackFollowUpCard(row = {}, resolution = {}) {
  const ref = slackMessageRefForAction(row, resolution);
  if (!ref.channel || !ref.ts) return { skipped: true, reason: 'missing_slack_message_ref' };
  const message = buildResolvedSlackFollowUpMessage(row, resolution);
  const result = await slackApi('chat.update', {
    channel: ref.channel,
    ts: ref.ts,
    text: message.text,
    blocks: message.blocks
  });
  return { ok: true, channel: ref.channel, ts: ref.ts, result };
}

async function tryReplaceSlackFollowUpCard(row = {}, resolution = {}) {
  try {
    return await replaceSlackFollowUpCard(row, resolution);
  } catch (error) {
    appendNdjson('errors.ndjson', {
      at: nowIso(),
      type: 'slack_card_update',
      followUpId: row?.id || null,
      message: error.message
    });
    return { ok: false, error: error.message };
  }
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
    const slackMessageUpdate = await tryReplaceSlackFollowUpCard(updated || row, {
      kind: 'status',
      status: targetStatus,
      requestedBy,
      requestedAt,
      channelId: baseSlackAction.channel_id,
      messageTs: baseSlackAction.message_ts
    });
    appendNdjson('slack-actions.ndjson', { at: requestedAt, action: actionId, followUpId, targetStatus, requestedBy });
    return { ok: true, kind: 'status', followUpId, status: targetStatus, updated, slackMessageUpdate };
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
    const slackMessageUpdate = await tryReplaceSlackFollowUpCard(updated || row, {
      kind: 'send_pending',
      requestedBy,
      requestedAt,
      channelId: baseSlackAction.channel_id,
      messageTs: baseSlackAction.message_ts
    });
    appendNdjson('slack-actions.ndjson', { at: requestedAt, action: actionId, followUpId, requestedBy, hasDraftOverride: Boolean(draftOverride) });
    return { ok: true, kind: 'send', followUpId, updated, slackMessageUpdate };
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
    const updated = await mergeFollowUpPayloadById(claimed, payloadPatch, patch);
    await tryReplaceSlackFollowUpCard(updated || claimed, {
      kind: sendResult.sent ? 'send_done' : 'send_error',
      error: sendResult.sent ? null : String(sendResult.reason || 'manual send failed').slice(0, 1000)
    });
    state.slackActionsHandled += sendResult.sent ? 1 : 0;
    return { ok: Boolean(sendResult.sent), id: row.id, result: sendResult };
  } catch (error) {
    const updated = await mergeFollowUpPayloadById(claimed, {
      slack_action: {
        ...(claimed.payload?.slack_action || {}),
        status: 'error',
        error: error.message.slice(0, 1000),
        handled_at: nowIso()
      }
    });
    await tryReplaceSlackFollowUpCard(updated || claimed, {
      kind: 'send_error',
      error: error.message.slice(0, 1000)
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
    if (workerResult?.skipped && workerResult?.reason === 'superseded_by_newer_room_event') {
      await updateSupabaseEventByHash(job.jobId, {
        status: 'superseded_by_newer_room_event',
        completed_at: nowIso(),
        payload: {
          ...job,
          ai_worker_result: workerResult
        }
      }).catch((error) => {
        state.failedSupabaseWrites += 1;
        appendNdjson('errors.ndjson', { at: nowIso(), type: 'superseded_job_update', message: error.message, jobId: job.jobId });
      });
      return { ok: true, skipped: true, workerResult };
    }
    if (workerResult?.skipped && workerResult?.reason === 'local_duplicate_job_active') {
      return { ok: true, skipped: true, workerResult };
    }
    try {
      await updateSupabaseEventByHash(job.jobId, buildWorkerResultPatch(job, workerResult));
    } catch (error) {
      state.failedSupabaseWrites += 1;
      appendNdjson('errors.ndjson', { at: nowIso(), type: 'supabase_job_update', message: error.message, jobId: job.jobId });
      console.warn('[dom-bridge] supabase job update failed:', error.message);
    }

    const workerPayload = parseWorkerStdoutJson(workerResult);
    if (workerPayload && shouldEscalateCompletedWorkerSkip(job, workerPayload)) {
      try {
        const decisionReason = String(workerPayload.decision?.reason || 'worker completed without sheet/follow-up').slice(0, 500);
        const completionFollowUp = await createWorkerFailureFollowUp(job, new Error(`worker completed without human-review card: ${decisionReason}`), {
          ...context,
          completed_skip: true,
          completed_at: nowIso()
        });
        appendNdjson('worker-completion-followups.ndjson', { at: nowIso(), jobId: job.jobId, result: completionFollowUp });
      } catch (followUpError) {
        state.failedSupabaseWrites += 1;
        appendNdjson('errors.ndjson', { at: nowIso(), type: 'worker_completion_followup', message: followUpError.message, jobId: job.jobId });
      }
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

export function shouldSkipSupabaseRowAsLowValue(row = {}) {
  const payload = objectPayload(row.payload);
  const raw = objectPayload(payload.raw);
  const event = {
    reason: row.reason || payload.reason || raw.reason || '',
    previewText: row.preview_text || payload.previewText || raw.previewText || '',
    unreadCount: row.unread_count ?? payload.unreadCount ?? raw.unreadCount ?? null,
    unreadSignal: payload.unreadSignal ?? raw.unreadSignal,
    raw
  };
  // Historical backstop rows may have been stored before the Badge/unread fix.
  // Do not replay a row that would now be rejected at ingress.
  if (event.reason === 'top_rows_backstop' && !hasUnreadCount(event)) return 'untrusted_backstop_row';
  return '';
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
  const roomKey = roomKeyForDebounce(event);
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

  const isNewEvent = !roomState.hashes.has(eventIdentity);
  if (isNewEvent) {
    roomState.events.push(groupedEvent);
    roomState.hashes.add(eventIdentity);
  }

  // Repeated backstop scans can post the same unread row every few seconds.
  // If every duplicate resets debounce, the room never flushes and the AI worker
  // never runs even though detection is alive. Only a genuinely new event should
  // extend the debounce window; duplicates keep the original timer.
  if (isNewEvent || !roomState.timer) {
    if (roomState.timer) clearTimeout(roomState.timer);
    roomState.timer = setTimeout(() => flushRoom(roomKey), CONFIG.debounceMs);
  }
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

async function cleanupIdleKakaoConversationTabs(reason = 'interval', { allowQueued = false } = {}) {
  if (!CONFIG.kakaoTabCleanupEnabled) return { skipped: true };
  if (state.workerRunning || (!allowQueued && (state.workerQueueLength > 0 || state.rooms.size > 0))) {
    return { skipped: true, reason: 'worker_or_debounce_active' };
  }
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
          followUpRowsEnabled: CONFIG.followUpRowsEnabled,
          slackCardDeliveryEnabled: CONFIG.slackCardDeliveryEnabled,
          slackBotTokenPresent: Boolean(CONFIG.slackBotToken),
          slackChannels: CONFIG.slackChannels,
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

if (process.env.KAKAO_DOM_BRIDGE_NO_LISTEN !== '1') {
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
}
