#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { loadEnvFile, upsertFollowUpRows } from '../ai-browser-worker/worker.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_AGENT_CHANNELS = [
  '스케쥴-agent',
  '서류발송-agent',
  '정산-agent',
  '재고관리-agent',
  '기타문의'
];

const ACTION_KEYWORDS = [
  /처리\s*필요/,
  /확인\s*필요/,
  /후속\s*(조치|처리|확인)?/,
  /미처리/,
  /대기\s*중/,
  /해야\s*(돼|됨|합니다|함)/,
  /부탁(?:드립니다|해|함|요)?/,
  /확인해(?:줘|주세요|주시면|야)/,
  /진행(?:해|해주세요|필요)/,
  /보내(?:줘|주세요|야)/,
  /발송(?:해|해주세요|필요)/,
  /등록(?:해|해주세요|필요)/,
  /예약(?:확인|등록|진행|가능)/,
  /입금|결제|미수|정산/,
  /견적서|계약서|세금계산서|현금영수증|거래명세서/,
  /파손|수리|미반납|분실/,
  /\bTODO\b/i,
  /\btask\b/i,
  /\baction\s*item\b/i
];

const RESOLVED_KEYWORDS = [
  /(^|\s)(완료|처리완료|해결|끝|닫음|종료)(\s|$|[.!?])/,
  /완료\s*(했|함|했습니다|처리)/,
  /처리\s*(했|함|했습니다|완료)/,
  /해결\s*(했|함|됐|되었습니다)/,
  /무시\s*(해도|처리|함|했습니다)/,
  /dismiss(?:ed)?/i,
  /resolved/i,
  /done/i,
  /✅|☑️|🟢/
];

function text(value = '') {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function cleanMultiline(value = '') {
  return String(value ?? '').replace(/\r/g, '').split('\n').map((line) => line.trim()).filter(Boolean).join('\n').trim();
}

function boolFromEnv(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'y', 'on'].includes(String(value).trim().toLowerCase());
}

function numberFromEnv(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function slackTsToMs(ts = '') {
  const n = Number(ts);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 1000);
}

function msToSlackOldest(ms) {
  return String(Math.max(0, ms / 1000));
}

function ageHoursFromTs(ts = '', nowMs = Date.now()) {
  const ms = slackTsToMs(ts);
  if (!ms) return 0;
  return Math.max(0, (nowMs - ms) / 36e5);
}

function compactHash(value = '', size = 12) {
  return createHash('sha1').update(String(value)).digest('hex').slice(0, size);
}

export function normalizeChannelRefs(value = '') {
  if (Array.isArray(value)) return value.map(String).map((v) => v.trim()).filter(Boolean);
  return String(value || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
}

function channelRefsFromConfig(config = {}) {
  const explicit = normalizeChannelRefs(config.channels || config.channelRefs || process.env.SLACK_BACKSTOP_CHANNELS);
  if (explicit.length) return explicit;
  return DEFAULT_AGENT_CHANNELS;
}

function isSlackId(value = '') {
  return /^[CGD][A-Z0-9]+$/.test(String(value).trim());
}

function normalizeSlackMentionText(value = '', botUserIds = []) {
  let out = String(value || '');
  for (const id of botUserIds) {
    out = out.replace(new RegExp(`<@${id}>`, 'g'), '헤이빌리');
  }
  return out
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/<@([A-Z0-9]+)>/g, '@$1')
    .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

function messagePlainText(message = {}, botUserIds = []) {
  const parts = [];
  if (message.text) parts.push(normalizeSlackMentionText(message.text, botUserIds));
  if (Array.isArray(message.attachments)) {
    for (const attachment of message.attachments) {
      for (const key of ['pretext', 'title', 'text', 'fallback']) {
        if (attachment?.[key]) parts.push(normalizeSlackMentionText(attachment[key], botUserIds));
      }
    }
  }
  if (Array.isArray(message.blocks)) {
    for (const block of message.blocks) {
      if (block?.text?.text) parts.push(normalizeSlackMentionText(block.text.text, botUserIds));
      if (Array.isArray(block?.fields)) {
        for (const field of block.fields) if (field?.text) parts.push(normalizeSlackMentionText(field.text, botUserIds));
      }
      if (Array.isArray(block?.elements)) {
        for (const el of block.elements) if (el?.text) parts.push(normalizeSlackMentionText(el.text, botUserIds));
      }
    }
  }
  return cleanMultiline(parts.join('\n'));
}

function isLikelyBotMessage(message = {}, botUserIds = []) {
  if (message.subtype === 'bot_message' || message.bot_id) return true;
  if (message.user && botUserIds.includes(message.user)) return true;
  return false;
}

function containsAny(textValue = '', patterns = []) {
  return patterns.some((pattern) => pattern.test(textValue));
}

function isPureSettlementNotification(body = '') {
  const value = text(body);
  if (!/^:(moneybag|credit_card):\s*\*(입금|매장\s*결제)/.test(value)) return false;
  return !/(확인\s*필요|처리\s*필요|미수|누락|오류|환불|취소|세금계산서|현금영수증|증빙|헤이빌리|heybilli|hey\s*billi)/i.test(value);
}

export function looksActionableSlackTask(message = {}, options = {}) {
  const body = messagePlainText(message, options.botUserIds || []);
  if (!body) return { actionable: false, reasons: [] };
  const lower = body.toLowerCase();
  const reasons = [];
  const mentionNames = options.mentionNames || ['헤이빌리', 'heybilli', 'hey billi', '빌리'];
  const mentionsHeybilli = mentionNames.some((name) => lower.includes(String(name).toLowerCase()));
  if (!mentionsHeybilli && isPureSettlementNotification(body)) return { actionable: false, reasons: ['pure_settlement_notification'], text: body };
  if (mentionsHeybilli) reasons.push('mentions_heybilli');
  if (containsAny(body, ACTION_KEYWORDS)) reasons.push('action_keyword');
  if (isLikelyBotMessage(message, options.botUserIds || []) && /\*(작업|요청|후속|확인|상태)\*|후속처리|확인 필요/.test(body)) {
    reasons.push('bot_task_card');
  }
  if (/^\s*[-*•]\s*\[[ x]?\]/m.test(body)) reasons.push('checklist');
  return { actionable: reasons.length > 0, reasons, text: body };
}

export function looksResolvedSlackThread(messages = [], options = {}) {
  const candidateTs = options.candidateTs || '';
  const afterCandidate = messages
    .filter((message) => !candidateTs || slackTsToMs(message.ts) > slackTsToMs(candidateTs))
    .sort((a, b) => slackTsToMs(a.ts) - slackTsToMs(b.ts));
  for (const message of afterCandidate) {
    const body = messagePlainText(message, options.botUserIds || []);
    if (!body) continue;
    if (containsAny(body, RESOLVED_KEYWORDS)) {
      return { resolved: true, reason: 'resolved_keyword', ts: message.ts, text: body.slice(0, 500) };
    }
    if (/상태[\s\S]{0,40}(완료|무시|dismissed|done)/i.test(body)) {
      return { resolved: true, reason: 'status_update', ts: message.ts, text: body.slice(0, 500) };
    }
  }
  return { resolved: false };
}

function inferTypeFromChannel(channelName = '', body = '') {
  const haystack = `${channelName} ${body}`;
  if (/정산|결제|입금|미수|카드|현금영수증/.test(haystack)) return 'payment_check';
  if (/서류|견적서|계약서|세금계산서|거래명세서|증빙/.test(haystack)) return 'contract_document';
  if (/스케|예약|일정|반출|반납|가용/.test(haystack)) return 'schedule_check';
  if (/재고|장비|파손|수리|분실|미반납/.test(haystack)) return 'damage_repair';
  return 'reply_needed';
}

function titleFromSlackText(body = '') {
  const firstLine = cleanMultiline(body).split('\n').find(Boolean) || body;
  return `Slack 미처리: ${text(firstLine).slice(0, 160) || '확인 필요'}`.slice(0, 220);
}

function permalinkFor(channelId = '', ts = '', teamDomain = '') {
  if (!teamDomain || !channelId || !ts) return '';
  return `https://${teamDomain}.slack.com/archives/${channelId}/p${String(ts).replace('.', '')}`;
}

export function buildSlackBackstopRow(candidate = {}, options = {}) {
  const message = candidate.message || {};
  const body = candidate.text || messagePlainText(message, options.botUserIds || []);
  const channelName = candidate.channel?.name || candidate.channelName || candidate.channel?.id || 'Slack';
  const channelId = candidate.channel?.id || candidate.channelId || '';
  const ts = message.ts || candidate.ts || '';
  const threadTs = message.thread_ts || candidate.threadTs || ts;
  const ageHours = Number.isFinite(candidate.ageHours) ? candidate.ageHours : ageHoursFromTs(ts, options.nowMs || Date.now());
  const stableRef = [channelId || channelName, threadTs || ts, compactHash(body)].join(':');
  const taskRef = String(threadTs || ts || compactHash(body, 8)).replace(/\D/g, '').slice(-10) || compactHash(body, 8);
  const priority = ageHours >= 24 ? 'high' : ageHours >= 6 ? 'normal' : 'low';
  const type = inferTypeFromChannel(channelName, body);
  const permalink = candidate.permalink || permalinkFor(channelId, ts, options.teamDomain || '');
  const evidence = [
    `Slack #${channelName} ${ts}`,
    body.slice(0, 900),
    permalink ? `원문: ${permalink}` : ''
  ].filter(Boolean);
  return {
    follow_up_key: `slack-backstop:${compactHash(stableRef, 24)}`,
    source: 'slack_backstop',
    job_id: null,
    room_key: `slack:${channelId || channelName}:${threadTs || ts || taskRef}`.slice(0, 240),
    customer_name: `#${channelName} · ${taskRef}`.slice(0, 120),
    type,
    priority,
    status: 'open',
    title: titleFromSlackText(body),
    summary: 'Slack에서 아직 완료 표시가 확인되지 않은 미처리 작업 후보입니다.',
    recommended_action: 'Slack 원문/스레드를 확인해서 처리하고, 처리 완료 댓글이나 완료 상태를 남기면 다음 스캔에서 후속조치판에 다시 뜨지 않습니다.',
    suggested_reply_draft: '',
    evidence,
    blocking_reason: null,
    due_hint: ageHours >= 24 ? '24h+' : ageHours >= 6 ? '6h+' : 'unresolved',
    decision_classification: 'slack_unresolved_backstop',
    decision_confidence: candidate.confidence || 'medium',
    payload: {
      slack_backstop: {
        channel_id: channelId,
        channel_name: channelName,
        message_ts: ts,
        thread_ts: threadTs,
        permalink: permalink || null,
        age_hours: Math.round(ageHours * 10) / 10,
        reasons: candidate.reasons || [],
        latest_reply_ts: candidate.latestReplyTs || null,
        scanned_at: new Date(options.nowMs || Date.now()).toISOString()
      },
      latest_customer_message_cluster: body.slice(0, 1500),
      visible_messages_used: [{ sender: message.user || message.username || message.bot_id || 'slack', message: body.slice(0, 1200), time: ts }]
    }
  };
}

export function collectSlackBackstopCandidates(channel = {}, historyMessages = [], threadMessagesByTs = {}, options = {}) {
  const nowMs = options.nowMs || Date.now();
  const minAgeMs = Math.max(0, options.minAgeHours ?? options.staleHours ?? 0) * 36e5;
  const candidates = [];
  for (const message of historyMessages) {
    if (!message?.ts) continue;
    const ageMs = nowMs - slackTsToMs(message.ts);
    if (ageMs < minAgeMs) continue;
    const action = looksActionableSlackTask(message, options);
    if (!action.actionable) continue;
    const threadTs = message.thread_ts || message.ts;
    const threadMessages = threadMessagesByTs[threadTs] || [message];
    const resolved = looksResolvedSlackThread(threadMessages, { ...options, candidateTs: message.ts });
    if (resolved.resolved) continue;
    const latestReplyTs = threadMessages.map((m) => m.ts).sort((a, b) => slackTsToMs(b) - slackTsToMs(a))[0] || message.ts;
    candidates.push({
      channel,
      message,
      text: action.text,
      reasons: action.reasons,
      ageHours: ageMs / 36e5,
      latestReplyTs,
      confidence: action.reasons.includes('mentions_heybilli') || action.reasons.includes('bot_task_card') ? 'high' : 'medium'
    });
  }
  return candidates;
}

async function slackApi(config = {}, method = '', payload = {}) {
  const token = config.slackBotToken || process.env.SLACK_BOT_TOKEN || '';
  if (!token) throw new Error('Missing SLACK_BOT_TOKEN');
  const fetchImpl = config.fetchImpl || fetch;
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(payload || {})) {
    if (value === undefined || value === null || value === '') continue;
    form.set(key, String(value));
  }
  const response = await fetchImpl(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/x-www-form-urlencoded; charset=utf-8'
    },
    body: form.toString()
  });
  const raw = await response.text();
  let data = {};
  try { data = raw ? JSON.parse(raw) : {}; } catch { data = { raw }; }
  if (!response.ok || data.ok === false) throw new Error(`Slack ${method} failed: ${data.error || raw}`);
  return data;
}

async function listSlackChannels(config = {}) {
  const channels = [];
  let cursor = '';
  do {
    const data = await slackApi(config, 'conversations.list', {
      types: config.channelTypes || 'public_channel,private_channel',
      exclude_archived: true,
      limit: 500,
      cursor
    });
    channels.push(...(Array.isArray(data.channels) ? data.channels : []));
    cursor = data.response_metadata?.next_cursor || '';
  } while (cursor);
  return channels;
}

async function resolveBackstopChannels(config = {}) {
  const refs = channelRefsFromConfig(config);
  const direct = refs.filter(isSlackId).map((id) => ({ id, name: id }));
  const names = refs.filter((ref) => !isSlackId(ref)).map((ref) => ref.replace(/^#/, ''));
  if (!names.length) return direct;
  const all = await listSlackChannels(config);
  const resolved = [...direct];
  for (const name of names) {
    const match = all.find((channel) => channel.name === name || channel.name_normalized === name);
    if (!match) throw new Error(`Slack channel not found: ${name}`);
    resolved.push({ id: match.id, name: match.name || name });
  }
  return resolved;
}

async function fetchChannelHistory(config = {}, channel = {}) {
  const limit = config.maxMessages || 200;
  const oldest = config.oldestTs
    ? String(config.oldestTs)
    : msToSlackOldest((config.nowMs || Date.now()) - Math.max(1, config.lookbackHours || 72) * 36e5);
  const data = await slackApi(config, 'conversations.history', {
    channel: channel.id,
    oldest,
    limit,
    inclusive: true
  });
  return Array.isArray(data.messages) ? data.messages : [];
}

async function fetchThreadMessages(config = {}, channel = {}, rootTs = '') {
  const data = await slackApi(config, 'conversations.replies', {
    channel: channel.id,
    ts: rootTs,
    limit: config.maxThreadMessages || 100
  });
  return Array.isArray(data.messages) ? data.messages : [];
}

async function permalinkForMessage(config = {}, channel = {}, ts = '') {
  try {
    const data = await slackApi(config, 'chat.getPermalink', { channel: channel.id, message_ts: ts });
    return data.permalink || '';
  } catch {
    return '';
  }
}

function supabaseHeaders(config = {}, prefer = '') {
  const headers = {
    apikey: config.serviceRoleKey,
    authorization: `Bearer ${config.serviceRoleKey}`,
    'content-type': 'application/json'
  };
  if (prefer) headers.prefer = prefer;
  return headers;
}

async function supabaseRest(config = {}, pathAndQuery = '', init = {}) {
  const endpoint = `${String(config.supabaseUrl || '').replace(/\/$/, '')}/rest/v1/${pathAndQuery}`;
  const response = await (config.supabaseFetchImpl || fetch)(endpoint, init);
  const raw = await response.text();
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { data = raw; }
  if (!response.ok) throw new Error(`Supabase HTTP ${response.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}

async function syncSlackBackstopOpenSet(config = {}, currentRows = [], scanErrors = []) {
  if (config.syncOpenSet === false) return { skipped: true, reason: 'disabled' };
  if (scanErrors.length) return { skipped: true, reason: 'scan_errors', scanErrors: scanErrors.length };
  const currentKeys = new Set(currentRows.map((row) => row.follow_up_key).filter(Boolean));
  const table = encodeURIComponent(config.followUpTable || process.env.SUPABASE_FOLLOW_UP_TABLE || 'ai_follow_up_items');
  const active = await supabaseRest(config, `${table}?select=id,follow_up_key,status,source&source=eq.slack_backstop&status=not.in.(done,dismissed)&limit=1000`, {
    headers: supabaseHeaders(config)
  });
  const staleIds = (Array.isArray(active) ? active : [])
    .filter((row) => row?.id && !currentKeys.has(row.follow_up_key))
    .map((row) => row.id);
  if (!staleIds.length) return { dismissed: 0 };
  const dismissed = await supabaseRest(config, `${table}?id=in.(${staleIds.map(encodeURIComponent).join(',')})`, {
    method: 'PATCH',
    headers: supabaseHeaders(config, 'return=representation'),
    body: JSON.stringify({
      status: 'dismissed',
      blocking_reason: 'Slack backstop no longer sees this thread/message as unresolved.'
    })
  });
  return { dismissed: Array.isArray(dismissed) ? dismissed.length : staleIds.length };
}

export async function runSlackFollowUpBackstop(config = {}) {
  const channels = config.resolvedChannels || await resolveBackstopChannels(config);
  const allCandidates = [];
  const scanErrors = [];
  for (const channel of channels) {
    const messages = await fetchChannelHistory(config, channel);
    const threadRoots = new Set(messages.map((message) => message.thread_ts || message.ts).filter(Boolean));
    const threadMessagesByTs = {};
    for (const threadTs of threadRoots) {
      const root = messages.find((message) => (message.thread_ts || message.ts) === threadTs && message.ts === threadTs);
      const replyCount = Number(root?.reply_count || 0);
      const needsReplies = replyCount > 0 || messages.some((message) => message.thread_ts === threadTs && message.ts !== threadTs);
      if (needsReplies) {
        try {
          threadMessagesByTs[threadTs] = await fetchThreadMessages(config, channel, threadTs);
        } catch (error) {
          scanErrors.push({ channel: channel.name || channel.id, threadTs, error: error.message });
          threadMessagesByTs[threadTs] = messages.filter((message) => (message.thread_ts || message.ts) === threadTs);
        }
      } else {
        threadMessagesByTs[threadTs] = messages.filter((message) => (message.thread_ts || message.ts) === threadTs);
      }
    }
    const candidates = collectSlackBackstopCandidates(channel, messages, threadMessagesByTs, config);
    for (const candidate of candidates) {
      candidate.permalink = await permalinkForMessage(config, channel, candidate.message.ts);
    }
    allCandidates.push(...candidates);
  }
  const rows = allCandidates.map((candidate) => buildSlackBackstopRow(candidate, config));
  if (config.write !== true) {
    return { status: 'dry_run', scannedChannels: channels.length, candidates: allCandidates.length, scanErrors, rows };
  }
  const supabaseConfig = {
    supabaseUrl: config.supabaseUrl || process.env.SUPABASE_URL || '',
    serviceRoleKey: config.serviceRoleKey || process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    followUpTable: config.followUpTable || process.env.SUPABASE_FOLLOW_UP_TABLE || 'ai_follow_up_items',
    fetchImpl: config.supabaseFetchImpl || config.fetchImpl
  };
  if (!supabaseConfig.supabaseUrl || !supabaseConfig.serviceRoleKey) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  const result = await upsertFollowUpRows(supabaseConfig, rows);
  const cleanup = await syncSlackBackstopOpenSet(supabaseConfig, rows, scanErrors);
  return { status: 'written', scannedChannels: channels.length, candidates: allCandidates.length, scanErrors, upsert: result, cleanup };
}

function parseArgs(argv = []) {
  const args = new Set(argv);
  const valueAfter = (flag, fallback = '') => {
    const idx = argv.indexOf(flag);
    return idx >= 0 ? argv[idx + 1] : fallback;
  };
  return {
    write: args.has('--write') || boolFromEnv(process.env.SLACK_BACKSTOP_WRITE_ENABLED, false),
    channels: valueAfter('--channels', process.env.SLACK_BACKSTOP_CHANNELS || ''),
    oldestTs: valueAfter('--oldest-ts', process.env.SLACK_BACKSTOP_OLDEST_TS || ''),
    lookbackHours: numberFromEnv(valueAfter('--lookback-hours', process.env.SLACK_BACKSTOP_LOOKBACK_HOURS), 72),
    minAgeHours: numberFromEnv(valueAfter('--min-age-hours', valueAfter('--stale-hours', process.env.SLACK_BACKSTOP_MIN_AGE_HOURS ?? process.env.SLACK_BACKSTOP_STALE_HOURS)), 0),
    maxMessages: numberFromEnv(valueAfter('--max-messages', process.env.SLACK_BACKSTOP_MAX_MESSAGES), 200),
    maxThreadMessages: numberFromEnv(valueAfter('--max-thread-messages', process.env.SLACK_BACKSTOP_MAX_THREAD_MESSAGES), 100),
    botUserIds: normalizeChannelRefs(process.env.SLACK_BACKSTOP_BOT_USER_IDS || process.env.SLACK_BOT_USER_IDS || ''),
    mentionNames: normalizeChannelRefs(process.env.SLACK_BACKSTOP_MENTION_NAMES || '헤이빌리,heybilli,hey billi,빌리')
  };
}

async function main() {
  const root = path.resolve(__dirname, '../..');
  loadEnvFile(path.resolve(process.env.HOME || '', '.hermes/.env'));
  loadEnvFile(path.resolve(root, 'tools/kakao-dom-bridge/.env'));
  loadEnvFile(path.resolve(__dirname, '.env'));
  const config = parseArgs(process.argv.slice(2));
  const result = await runSlackFollowUpBackstop(config);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] === __filename) {
  main().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
