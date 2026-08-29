import { assertNotificationTransition } from './contracts.mjs';

const REQUEST_ERROR_PREFIX = 'Work Orchestrator Supabase request failed';
const MAX_EVENT_KEY_LENGTH = 500;

function invalidInput() {
  return new Error('Work Orchestrator Supabase input is invalid');
}

function requiredText(value, maxLength) {
  if (typeof value !== 'string') throw invalidInput();
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) throw invalidInput();
  return normalized;
}

function optionalText(value, maxLength) {
  if (value === null || value === undefined) return null;
  return requiredText(value, maxLength);
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    throw invalidInput();
  }
}

function safeResponseCode(raw, serviceRoleKey) {
  try {
    const code = JSON.parse(raw)?.code;
    const normalizedCode = typeof code === 'string' ? code.toUpperCase() : '';
    if (
      /^(?:PGRST\d{3}|[0-9A-Z]{5})$/.test(normalizedCode)
      && !normalizedCode.includes(serviceRoleKey.toUpperCase())
    ) {
      return normalizedCode;
    }
  } catch {
    // A non-JSON response cannot safely contribute to an error message.
  }
  return 'unknown';
}

function normalizeReceipt(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalidInput();
  if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) throw invalidInput();

  const receivedAt = requiredText(input.receivedAt, 100);
  if (Number.isNaN(new Date(receivedAt).getTime())) throw invalidInput();

  return {
    source: requiredText(input.source, 100),
    sourceEventKey: requiredText(input.sourceEventKey, MAX_EVENT_KEY_LENGTH),
    sourceMessageId: optionalText(input.sourceMessageId, 500),
    clientMessageId: requiredText(input.clientMessageId, 100),
    roomKey: requiredText(input.roomKey, 500),
    receivedAt,
    payload: input.payload
  };
}

function normalizeTransition(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalidInput();
  if (!Array.isArray(input.fromStates) || input.fromStates.length === 0) throw invalidInput();
  const patch = input.patch === undefined ? {} : input.patch;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw invalidInput();

  return {
    id: requiredText(input.id, 200),
    fromStates: input.fromStates.map((state) => requiredText(state, 100)),
    toState: requiredText(input.toState, 100),
    patch
  };
}

function notificationEventKey(sourceEventKey) {
  return requiredText(sourceEventKey, MAX_EVENT_KEY_LENGTH);
}

export function toRpcReceipt(input) {
  try {
    const receipt = normalizeReceipt(input);
    return {
      p_source: receipt.source,
      p_source_event_key: receipt.sourceEventKey,
      p_source_message_id: receipt.sourceMessageId,
      p_room_key: receipt.roomKey,
      p_received_at: receipt.receivedAt,
      p_client_message_id: receipt.clientMessageId,
      p_payload: receipt.payload
    };
  } catch {
    throw invalidInput();
  }
}

export function createWorkOrchestratorStore({ supabaseUrl, serviceRoleKey, fetchImpl = fetch } = {}) {
  if (typeof supabaseUrl !== 'string' || !supabaseUrl.trim() || typeof serviceRoleKey !== 'string' || !serviceRoleKey.trim()) {
    throw new Error('Work Orchestrator Supabase configuration is missing');
  }
  if (typeof fetchImpl !== 'function') throw new Error('Work Orchestrator Supabase configuration is missing');

  let origin;
  try {
    const parsedUrl = new URL(supabaseUrl.trim());
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) throw new Error('invalid protocol');
    origin = supabaseUrl.trim().replace(/\/$/, '');
  } catch {
    throw new Error('Work Orchestrator Supabase configuration is missing');
  }

  const baseUrl = `${origin}/rest/v1/`;
  const request = async (pathAndQuery, init = {}) => {
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${pathAndQuery}`, {
        ...init,
        headers: {
          apikey: serviceRoleKey,
          authorization: `Bearer ${serviceRoleKey}`,
          accept: 'application/json',
          'content-type': 'application/json',
          prefer: init.prefer || 'return=representation',
          ...init.headers
        },
        signal: init.signal || AbortSignal.timeout(7000)
      });
    } catch {
      throw new Error(`${REQUEST_ERROR_PREFIX}: network error`);
    }

    let raw;
    try {
      raw = await response.text();
    } catch {
      throw new Error(`${REQUEST_ERROR_PREFIX}: response unreadable`);
    }

    let ok;
    let status;
    try {
      ok = response.ok;
      status = Number(response.status) || 0;
    } catch {
      throw new Error(`${REQUEST_ERROR_PREFIX}: response invalid`);
    }
    if (!ok) {
      throw new Error(`${REQUEST_ERROR_PREFIX}: HTTP ${status}, code ${safeResponseCode(raw, serviceRoleKey)}`);
    }

    let data = null;
    if (raw) {
      try {
        data = JSON.parse(raw);
      } catch {
        throw new Error(`${REQUEST_ERROR_PREFIX}: response invalid`);
      }
    }

    let contentRange = '';
    try {
      contentRange = response.headers?.get('content-range') || '';
    } catch {
      throw new Error(`${REQUEST_ERROR_PREFIX}: response metadata unreadable`);
    }
    const countMatch = contentRange.match(/\/(\d+)$/);
    return { data, count: countMatch ? Number(countMatch[1]) : null };
  };

  return {
    claimNotificationReceipt: async (input) => {
      const { data } = await request('rpc/claim_message_notification_receipt', {
        method: 'POST',
        body: safeJson(toRpcReceipt(input))
      });
      return data;
    },
    getNotificationByEventKey: async (sourceEventKey) => {
      const query = new URLSearchParams({
        select: '*',
        source_event_key: `eq.${notificationEventKey(sourceEventKey)}`,
        limit: '1'
      });
      const { data } = await request(`message_notification_receipts?${query}`);
      return Array.isArray(data) ? data[0] || null : null;
    },
    transitionNotification: async (input) => {
      let transition;
      try {
        transition = normalizeTransition(input);
        for (const fromState of transition.fromStates) {
          assertNotificationTransition(fromState, transition.toState);
        }
      } catch {
        throw new Error('Work Orchestrator Supabase transition input is invalid');
      }
      const query = new URLSearchParams({
        id: `eq.${transition.id}`,
        notification_state: `in.(${transition.fromStates.join(',')})`,
        select: '*'
      });
      let body;
      try {
        body = safeJson({ ...transition.patch, notification_state: transition.toState });
      } catch {
        throw new Error('Work Orchestrator Supabase transition input is invalid');
      }
      const { data } = await request(`message_notification_receipts?${query}`, { method: 'PATCH', body });
      const row = Array.isArray(data) ? data[0] || null : null;
      return { applied: Boolean(row), row };
    },
    counts: async () => {
      const count = async (table, filters) => {
        const query = new URLSearchParams({ select: 'id', ...filters });
        const result = await request(`${table}?${query}`, {
          method: 'HEAD',
          headers: { range: '0-0' },
          prefer: 'count=exact'
        });
        return result.count ?? 0;
      };
      const [pendingNotifications, activeWorkItems, unfinishedDigests] = await Promise.all([
        count('message_notification_receipts', { notification_state: 'in.(pending,delivering,failed,cleanup_pending)' }),
        count('work_items_v2', { state: 'in.(open,in_progress,snoozed)' }),
        count('digest_runs', { state: 'in.(building,failed)' })
      ]);
      return { pendingNotifications, activeWorkItems, unfinishedDigests };
    }
  };
}
