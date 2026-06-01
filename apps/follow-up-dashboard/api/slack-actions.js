import crypto from 'node:crypto';

const VALID_STATUSES = new Set(['open', 'in_progress', 'waiting_customer', 'waiting_internal', 'done', 'dismissed']);

function json(res, status, payload) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(payload));
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) reject(new Error('request body too large'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

export function verifySlackSignature({ rawBody = '', timestamp = '', signature = '', signingSecret = '', nowMs = Date.now() } = {}) {
  if (!signingSecret) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(nowMs / 1000 - ts) > 60 * 5) return false;
  const base = `v0:${timestamp}:${rawBody}`;
  const digest = `v0=${crypto.createHmac('sha256', signingSecret).update(base).digest('hex')}`;
  const expected = Buffer.from(digest);
  const actual = Buffer.from(String(signature || ''));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export function parseSlackPayload(rawBody = '') {
  const params = new URLSearchParams(rawBody);
  const payload = params.get('payload');
  if (!payload) throw new Error('missing slack payload');
  return JSON.parse(payload);
}

async function supabaseFetch(pathAndQuery, init = {}) {
  const url = requireEnv('SUPABASE_URL').replace(/\/$/, '');
  const key = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const response = await fetch(`${url}/rest/v1/${pathAndQuery}`, {
    ...init,
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      ...(init.headers || {})
    }
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!response.ok) {
    const err = new Error(`Supabase ${response.status}`);
    err.detail = data;
    throw err;
  }
  return data;
}

function tableName() {
  return encodeURIComponent(process.env.SUPABASE_FOLLOW_UP_TABLE || 'ai_follow_up_items');
}

async function fetchFollowUp(id) {
  const rows = await supabaseFetch(`${tableName()}?select=*&id=eq.${encodeURIComponent(id)}&limit=1`);
  return Array.isArray(rows) ? rows[0] : null;
}

async function patchFollowUp(id, patch) {
  const rows = await supabaseFetch(`${tableName()}?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { prefer: 'return=representation' },
    body: JSON.stringify(patch)
  });
  return Array.isArray(rows) ? rows[0] : rows;
}

async function mergeFollowUpPayload(id, payloadPatch = {}, extraPatch = {}) {
  const current = await fetchFollowUp(id);
  if (!current) return null;
  const currentPayload = current.payload && typeof current.payload === 'object' ? current.payload : {};
  return patchFollowUp(id, {
    ...extraPatch,
    payload: {
      ...currentPayload,
      ...payloadPatch
    }
  });
}

export function parseActionIntent(action = {}) {
  const actionId = String(action.action_id || '');
  const followUpId = String(action.value || '').trim();
  if (!followUpId) return { kind: 'invalid', reason: 'missing_follow_up_id' };
  if (actionId === 'village_followup_send') return { kind: 'send', followUpId };
  if (actionId === 'village_followup_edit_send') return { kind: 'edit_send', followUpId };
  const statusMatch = actionId.match(/^village_followup_status_(.+)$/);
  if (statusMatch) {
    const status = statusMatch[1];
    if (VALID_STATUSES.has(status)) return { kind: 'status', followUpId, status };
  }
  return { kind: 'invalid', followUpId, reason: `unsupported action ${actionId}` };
}

export function buildEditSendModal(item = {}) {
  const initial = String(item.payload?.slack_draft_override || item.slack_draft_override || item.suggested_reply_draft || '').slice(0, 2900);
  return {
    type: 'modal',
    callback_id: 'village_followup_edit_send_submit',
    private_metadata: String(item.id || ''),
    title: { type: 'plain_text', text: '초안 수정' },
    submit: { type: 'plain_text', text: '전송 요청' },
    close: { type: 'plain_text', text: '취소' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${String(item.customer_name || '고객명 미확인')}* / ${String(item.title || '후속처리')}`
        }
      },
      {
        type: 'input',
        block_id: 'draft_block',
        label: { type: 'plain_text', text: '카카오 전송 문구' },
        element: {
          type: 'plain_text_input',
          action_id: 'draft_text',
          multiline: true,
          initial_value: initial || '확인 후 바로 안내드리겠습니다.'
        }
      }
    ]
  };
}

async function slackApi(method, payload = {}) {
  const token = requireEnv('SLACK_BOT_TOKEN');
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify(payload)
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok || data?.ok === false) throw new Error(`Slack ${method} failed: ${data?.error || text}`);
  return data;
}

async function markSendPending(followUpId, draftOverride = null) {
  const payloadPatch = {
    slack_action: {
      type: 'send',
      status: 'pending',
      requested_at: new Date().toISOString(),
      error: null
    }
  };
  if (draftOverride !== null) payloadPatch.slack_draft_override = draftOverride;
  return mergeFollowUpPayload(followUpId, payloadPatch, { status: 'in_progress' });
}

function viewSubmissionDraft(payload = {}) {
  const values = payload.view?.state?.values || {};
  for (const block of Object.values(values)) {
    if (block?.draft_text?.value !== undefined) return String(block.draft_text.value || '').trim();
  }
  return '';
}

async function handleBlockAction(payload) {
  const action = Array.isArray(payload.actions) ? payload.actions[0] : null;
  const intent = parseActionIntent(action);
  if (intent.kind === 'invalid') return { text: `처리할 수 없는 버튼입니다: ${intent.reason}` };

  if (intent.kind === 'status') {
    await patchFollowUp(intent.followUpId, {
      status: intent.status,
      completed_at: intent.status === 'open' ? null : undefined
    });
    return { text: `상태를 ${intent.status}로 변경했습니다.` };
  }

  if (intent.kind === 'send') {
    await markSendPending(intent.followUpId);
    return { text: '카카오 전송 요청을 접수했습니다. 로컬 브릿지가 처리합니다.' };
  }

  const item = await fetchFollowUp(intent.followUpId);
  if (!item) return { text: '후속처리 항목을 찾지 못했습니다.' };
  await slackApi('views.open', {
    trigger_id: payload.trigger_id,
    view: buildEditSendModal(item)
  });
  return { text: '수정 모달을 열었습니다.' };
}

async function handleViewSubmission(payload) {
  const followUpId = String(payload.view?.private_metadata || '').trim();
  const draft = viewSubmissionDraft(payload);
  if (!followUpId || !draft) {
    return { response_action: 'errors', errors: { draft_block: '전송 문구를 입력하세요.' } };
  }
  await markSendPending(followUpId, draft);
  return { response_action: 'clear' };
}

export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
    const rawBody = await readRawBody(req);
    const ok = verifySlackSignature({
      rawBody,
      timestamp: req.headers['x-slack-request-timestamp'],
      signature: req.headers['x-slack-signature'],
      signingSecret: requireEnv('SLACK_SIGNING_SECRET')
    });
    if (!ok) return json(res, 401, { error: 'invalid slack signature' });

    const payload = parseSlackPayload(rawBody);
    if (payload.type === 'view_submission') return json(res, 200, await handleViewSubmission(payload));
    if (payload.type === 'block_actions') return json(res, 200, await handleBlockAction(payload));
    return json(res, 200, { text: '지원하지 않는 Slack interaction입니다.' });
  } catch (error) {
    return json(res, 500, { error: error.message, detail: error.detail || null });
  }
}
