import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

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
  workerTimeoutMs: Number(process.env.WORKER_TIMEOUT_MS || process.env.HERMES_WORKER_TIMEOUT_MS || 240_000),
  supabaseTimeoutMs: Number(process.env.SUPABASE_TIMEOUT_MS || 7000)
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

function appendNdjson(filename, object) {
  ensureQueueDir();
  fs.appendFileSync(path.join(CONFIG.queueDir, filename), `${JSON.stringify(object)}\n`, 'utf8');
}

async function writeSupabaseEvent(eventOrJob, kind) {
  if (!CONFIG.supabaseUrl || !CONFIG.supabaseServiceRoleKey || !CONFIG.supabaseTable) return { skipped: true };

  const endpoint = `${CONFIG.supabaseUrl.replace(/\/$/, '')}/rest/v1/${encodeURIComponent(CONFIG.supabaseTable)}`;
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.supabaseTimeoutMs);
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      apikey: CONFIG.supabaseServiceRoleKey,
      authorization: `Bearer ${CONFIG.supabaseServiceRoleKey}`,
      'content-type': 'application/json',
      prefer: 'return=minimal'
    },
    body: JSON.stringify(payload),
    signal: controller.signal
  }).finally(() => clearTimeout(timer));

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Supabase insert failed: ${response.status} ${text}`);
  }
  return { ok: true };
}

function buildAiFirstJob(roomKey, roomState) {
  const events = roomState.events.slice();
  const latest = events[events.length - 1] || {};
  return {
    jobId: `dom-${sha256(`${roomKey}:${roomState.firstAt}:${roomState.lastAt}`).slice(0, 16)}`,
    source: 'kakao_channel_manager_dom',
    reason: 'kakao_channel_manager_dom_event_debounced',
    status: 'ready_for_ai_worker',
    roomKey,
    detectedAt: latest.detectedAt || nowIso(),
    firstEventAt: roomState.firstAt,
    lastEventAt: roomState.lastAt,
    eventCount: events.length,
    previewText: latest.previewText || '',
    unreadCount: latest.unreadCount ?? null,
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

  try {
    await writeSupabaseEvent(job, 'job');
  } catch (error) {
    state.failedSupabaseWrites += 1;
    appendNdjson('errors.ndjson', { at: nowIso(), type: 'supabase_job', message: error.message, job });
    console.warn('[dom-bridge] supabase job insert failed:', error.message);
  }

  try {
    await enqueueWorker(job);
  } catch (error) {
    state.failedWorkerRuns += 1;
    appendNdjson('errors.ndjson', { at: nowIso(), type: 'worker', message: error.message, job });
    console.warn('[dom-bridge] worker failed:', error.message);
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
          workerTimeoutMs: CONFIG.workerTimeoutMs,
          supabaseTimeoutMs: CONFIG.supabaseTimeoutMs,
          processInitialScan: CONFIG.processInitialScan,
          ignoreShiftedRows: CONFIG.ignoreShiftedRows
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
          openRooms: state.rooms.size
        }
      });
    }

    if (req.method === 'POST' && url.pathname === '/events') {
      return await handleEvent(req, res);
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
});
