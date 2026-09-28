import path from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_VISIBLE_TEXT = 16_000;
const MAX_MESSAGE_TEXT = 2_000;
const MAX_MESSAGES = 80;

function cleanText(value) {
  return String(value ?? '').trim();
}

function boundedText(value, limit) {
  const normalized = cleanText(value);
  return normalized.length > limit ? normalized.slice(-limit) : normalized;
}

function compactEvidence(evidence = {}) {
  return {
    source: cleanText(evidence.source),
    hintMatched: evidence.hint_matched === true,
    title: cleanText(evidence.title),
    visibleText: boundedText(evidence.visible_static_text_tail, MAX_VISIBLE_TEXT),
    messages: (Array.isArray(evidence.messages) ? evidence.messages : [])
      .slice(-MAX_MESSAGES)
      .map((message) => ({
        messageId: cleanText(message?.message_id),
        role: ['customer', 'staff', 'unknown'].includes(message?.role) ? message.role : 'unknown',
        order: Number(message?.order),
        text: boundedText(message?.text, MAX_MESSAGE_TEXT)
      }))
  };
}

async function loadDefaultDependencies() {
  process.env.KAKAO_REMOTE_DEBUGGING_PORT ||= '9223';
  process.env.KAKAO_DEVTOOLS_URL ||= 'http://127.0.0.1:9223';
  const worker = await import('../../tools/ai-browser-worker/worker.mjs');
  return {
    ensureList: worker.ensureKakaoChannelManagerTab,
    openChat: worker.openKakaoTargetChatViaDevtools
  };
}

export async function inspectKakaoRoom(input = {}, dependencies = {}) {
  const customerName = cleanText(input.customerName);
  const roomTitle = cleanText(input.roomTitle);
  if (!customerName && !roomTitle) throw new Error('customerName or roomTitle is required');

  const defaults = dependencies.ensureList && dependencies.openChat
    ? null
    : await loadDefaultDependencies();
  const ensureList = dependencies.ensureList || defaults.ensureList;
  const openChat = dependencies.openChat || defaults.openChat;

  await ensureList({ timeoutMs: 20_000 });
  const queryText = customerName || roomTitle;
  const navigation = await openChat({
    customer_name: customerName,
    room_title: roomTitle,
    preview_text: queryText,
    payload: { customerName, roomTitle }
  }, { timeoutMs: 30_000, allowSearch: true });

  const query = { customerName, roomTitle };
  const evidence = navigation?.conversation_evidence || {};
  if (navigation?.status !== 'opened_target_chat' || evidence.hint_matched !== true) {
    return {
      ok: false,
      status: cleanText(navigation?.status) || 'conversation_evidence_unavailable',
      query,
      reason: 'live_kakao_room_not_verified'
    };
  }

  return {
    ok: true,
    status: navigation.status,
    query,
    openedBySearch: navigation.opened_by_devtools_search === true,
    alreadyOpen: navigation.already_open === true,
    target: {
      id: cleanText(navigation.target?.id),
      title: cleanText(navigation.target?.title),
      url: cleanText(navigation.target?.url)
    },
    evidence: compactEvidence(evidence)
  };
}

function valueAfter(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? cleanText(args[index + 1]) : '';
}

async function runCli() {
  const args = process.argv.slice(2);
  const customerName = valueAfter(args, '--customer') || (!args[0]?.startsWith('--') ? cleanText(args[0]) : '');
  const roomTitle = valueAfter(args, '--room');
  const result = await inspectKakaoRoom({ customerName, roomTitle });
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 2;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runCli().catch((error) => {
    process.stdout.write(`${JSON.stringify({ ok: false, status: 'error', error: cleanText(error?.message || error) })}\n`);
    process.exitCode = 1;
  });
}
