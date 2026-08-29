const MAX_TIMEOUT_MS = 60_000;
const MAX_RETRY_AFTER_SECONDS = 86_400;
const MAX_CURSOR_LENGTH = 2_000;
const MAX_HISTORY_PAGES = 10;
const SAFE_SLACK_CODE = /^[a-z0-9_]{1,64}$/;
const SAFE_SLACK_CHANNEL = /^[A-Z0-9][A-Z0-9_-]{0,79}$/;
const SLACK_TIMESTAMP = /^\d{1,16}\.\d{1,10}$/;
const INDETERMINATE_POST_CODES = new Set(['fatal_error', 'internal_error']);

export class SlackApiError extends Error {
  constructor(message, fields = {}) {
    super(message);
    Object.assign(this, fields);
  }
}

function safeCode(value) {
  return typeof value === 'string' && SAFE_SLACK_CODE.test(value) ? value : 'unknown';
}

function parseRetryAfter(value) {
  if (typeof value !== 'string' || !/^\d{1,5}$/.test(value)) return null;
  const seconds = Number(value);
  return seconds <= MAX_RETRY_AFTER_SECONDS ? seconds : null;
}

function normalizedPostResult(payload) {
  if (typeof payload.channel !== 'string' || !SAFE_SLACK_CHANNEL.test(payload.channel)) return null;
  if (typeof payload.ts !== 'string' || !SLACK_TIMESTAMP.test(payload.ts)) return null;
  const message = payload.message ?? {};
  if (Array.isArray(message) || typeof message !== 'object') return null;
  return { ok: true, channel: payload.channel, ts: payload.ts, message };
}

function requiredString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Slack ${name} is required`);
  return value;
}

function positiveFiniteNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`Slack ${name} must be a finite positive number`);
  return number;
}

function responseStatus(response) {
  return Number.isInteger(response?.status) ? response.status : null;
}

export function createSlackClient({ token, fetchImpl = fetch, timeoutMs = 7_000 } = {}) {
  requiredString(token, 'bot token');
  if (typeof fetchImpl !== 'function') throw new Error('Slack fetch implementation is required');
  const timeout = positiveFiniteNumber(timeoutMs, 'timeout');
  if (timeout > MAX_TIMEOUT_MS) throw new Error('Slack timeout exceeds the maximum');

  const errorFor = (method, fields) => {
    const code = safeCode(fields.code);
    return new SlackApiError(`Slack ${method} failed: ${code}`, {
      kind: fields.kind,
      status: fields.status ?? null,
      code,
      retryAfterSeconds: fields.retryAfterSeconds ?? null,
      ambiguous: fields.ambiguous === true
    });
  };

  const call = async (method, body) => {
    let response;
    try {
      response = await fetchImpl(`https://slack.com/api/${method}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json; charset=utf-8'
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout)
      });
    } catch {
      throw errorFor(method, {
        kind: 'transport',
        code: 'transport_failure',
        ambiguous: method === 'chat.postMessage'
      });
    }

    const status = responseStatus(response);
    const retryAfterSeconds = parseRetryAfter(response?.headers?.get?.('retry-after'));
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw errorFor(method, {
        kind: 'response',
        status,
        code: 'malformed_response',
        retryAfterSeconds,
        ambiguous: method === 'chat.postMessage' && status !== 429
      });
    }
    if (!payload || Array.isArray(payload) || typeof payload !== 'object' || typeof payload.ok !== 'boolean') {
      throw errorFor(method, {
        kind: 'response',
        status,
        code: 'malformed_response',
        retryAfterSeconds,
        ambiguous: method === 'chat.postMessage' && status !== 429
      });
    }
    if (response.ok && payload.ok === true) return payload;

    const code = safeCode(payload.error);
    throw errorFor(method, {
      kind: status === 429 ? 'rate_limit' : 'api',
      status,
      code,
      retryAfterSeconds,
      ambiguous: method === 'chat.postMessage'
        && (status >= 500 || INDETERMINATE_POST_CODES.has(code))
    });
  };

  return {
    async postMessage({ channel, text, blocks, clientMsgId } = {}) {
      requiredString(channel, 'channel');
      requiredString(clientMsgId, 'clientMsgId');
      const payload = await call('chat.postMessage', {
        channel,
        text,
        blocks,
        client_msg_id: clientMsgId,
        reply_broadcast: false,
        unfurl_links: false,
        unfurl_media: false
      });
      const result = normalizedPostResult(payload);
      if (!result) {
        throw errorFor('chat.postMessage', {
          kind: 'response',
          code: 'malformed_response',
          ambiguous: true
        });
      }
      return result;
    },

    async findMessageByClientId({ channel, clientMsgId, oldest, latest } = {}) {
      requiredString(channel, 'channel');
      requiredString(clientMsgId, 'clientMsgId');
      const oldestTime = positiveFiniteNumber(oldest, 'oldest');
      const latestTime = positiveFiniteNumber(latest, 'latest');
      if (latestTime < oldestTime) throw new Error('Slack latest must not be earlier than oldest');

      let cursor = '';
      for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
        const payload = await call('conversations.history', {
          channel,
          oldest: String(oldestTime),
          latest: String(latestTime),
          inclusive: true,
          limit: 200,
          cursor
        });
        if (!Array.isArray(payload.messages)) {
          throw errorFor('conversations.history', { kind: 'response', code: 'malformed_response' });
        }
        const match = payload.messages.find((message) => message?.client_msg_id === clientMsgId);
        if (match) return match;

        const nextCursor = payload.response_metadata?.next_cursor ?? '';
        if (typeof nextCursor !== 'string' || nextCursor.length > MAX_CURSOR_LENGTH) {
          throw errorFor('conversations.history', { kind: 'response', code: 'invalid_cursor' });
        }
        if (nextCursor === '') break;
        cursor = nextCursor;
      }
      return null;
    }
  };
}
