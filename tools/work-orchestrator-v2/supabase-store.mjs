import { assertNotificationTransition } from './contracts.mjs';

const REQUEST_ERROR_PREFIX = 'Work Orchestrator Supabase request failed';
const MAX_EVENT_KEY_LENGTH = 500;
const MAX_DELIVERY_ATTEMPTS = 3;
const DELIVERY_FAILURE_CODES = new Set(['post_rejected', 'delivery_unconfirmed']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORK_PRIORITIES = new Set(['p0', 'urgent', 'normal', 'low']);
const AUTOMATION_STATES = new Set(['not_attempted', 'running', 'succeeded', 'failed', 'needs_human']);
const WORK_TYPES = new Set([
  'human_review', 'reply_needed', 'quote_send', 'tax_invoice', 'schedule_check',
  'reservation_review', 'price_review', 'payment_check', 'contract_document',
  'return_extension', 'damage_repair', 'sheet_duplicate_check',
  'reservation_review_timeout', 'automation_error_review'
]);
const WORK_PAYLOAD_TEXT_LIMITS = Object.freeze({
  action_family: 100,
  business_key: 500,
  business_object_key: 500,
  follow_up_route: 100,
  follow_up_task_key: 500,
  alert_level: 20,
  alert_reason: 1000,
  blocking_reason: 1000,
  due_hint: 100,
  recommended_action: 1200
});
const WORK_ACTIONS = new Set(['progress', 'snooze', 'ack_p0', 'request_resolve', 'dismiss']);
const DIGEST_INCLUSION_REASONS = new Set(['p0', 'overdue', 'urgent', 'carry_over', 'actionable', 'daily_reminder']);
const DIGEST_FAILURE_CODES = new Set(['digest_build_failed', 'digest_delivery_failed', 'delivery_unconfirmed']);
const ACTIONABLE_WORK_SELECT = [
  'id', 'work_key', 'room_key', 'title', 'summary', 'work_type', 'priority', 'state',
  'owner_id', 'actionable_at', 'due_at', 'snoozed_until', 'first_opened_at',
  'last_activity_at', 'digest_inclusion_count', 'consecutive_unhandled_digests',
  'last_digest_at', 'next_reminder_at', 'version', 'payload'
].join(',');

function invalidInput() {
  return new Error('Work Orchestrator Supabase input is invalid');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, allowed) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function exactText(value, maxLength) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > maxLength) {
    throw invalidInput();
  }
  return value;
}

function uuid(value) {
  const normalized = exactText(value, 36);
  if (!UUID.test(normalized)) throw invalidInput();
  return normalized;
}

function isoTimestamp(value, { nullable = false } = {}) {
  if ((value === null || value === undefined) && nullable) return null;
  const normalized = exactText(value, 40);
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== normalized) throw invalidInput();
  return normalized;
}

function positiveVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw invalidInput();
  return value;
}

function normalizeWorkPayload(payload) {
  if (!isRecord(payload) || payload.requires_human_action !== true) throw invalidInput();
  const allowed = new Set(['requires_human_action', ...Object.keys(WORK_PAYLOAD_TEXT_LIMITS)]);
  if (Object.keys(payload).some((key) => !allowed.has(key))) throw invalidInput();
  const result = { requires_human_action: true };
  for (const [key, limit] of Object.entries(WORK_PAYLOAD_TEXT_LIMITS)) {
    if (payload[key] === undefined) continue;
    result[key] = exactText(payload[key], limit);
  }
  return result;
}

function normalizeWorkCandidate(input) {
  if (!isRecord(input)) throw invalidInput();
  const sourceEventKeys = input.source_event_keys;
  if (!Array.isArray(sourceEventKeys) || sourceEventKeys.length > 100) throw invalidInput();
  const normalizedSourceKeys = sourceEventKeys.map((value) => exactText(value, 500));
  if (new Set(normalizedSourceKeys).size !== normalizedSourceKeys.length) throw invalidInput();
  const priority = exactText(input.priority, 20);
  const workType = exactText(input.work_type, 100);
  const automationState = exactText(input.automation_state, 50);
  if (!WORK_PRIORITIES.has(priority) || !WORK_TYPES.has(workType) || !AUTOMATION_STATES.has(automationState)) {
    throw invalidInput();
  }
  if (input.state !== 'open') throw invalidInput();

  if (typeof input.summary !== 'string' || input.summary.length > 2000) throw invalidInput();
  return {
    work_key: exactText(input.work_key, 500),
    source_event_keys: normalizedSourceKeys,
    room_key: exactText(input.room_key, 500),
    title: exactText(input.title, 300),
    summary: input.summary,
    work_type: workType,
    priority,
    state: 'open',
    owner_id: input.owner_id === null || input.owner_id === undefined ? null : exactText(input.owner_id, 200),
    actionable_at: isoTimestamp(input.actionable_at),
    due_at: isoTimestamp(input.due_at, { nullable: true }),
    snoozed_until: isoTimestamp(input.snoozed_until, { nullable: true }),
    first_opened_at: isoTimestamp(input.first_opened_at),
    last_activity_at: isoTimestamp(input.last_activity_at),
    automation_state: automationState,
    payload: normalizeWorkPayload(input.payload)
  };
}

function normalizeWorkAction(input) {
  if (!isRecord(input)) throw invalidInput();
  const type = exactText(input.type, 30);
  if (!WORK_ACTIONS.has(type)) throw invalidInput();
  const expected = type === 'snooze' ? ['snoozedUntil', 'type'] : ['type'];
  if (!exactKeys(input, expected)) throw invalidInput();
  if (type === 'snooze') return { type, snoozedUntil: isoTimestamp(input.snoozedUntil) };
  return { type };
}

function normalizeDigestSnapshot(input) {
  if (!Array.isArray(input) || input.length > 1000) throw invalidInput();
  const seen = new Set();
  return input.map((entry) => {
    if (!exactKeys(entry, ['id', 'version', 'inclusionReason', 'priority'])) throw invalidInput();
    const id = uuid(entry.id);
    if (seen.has(id)) throw invalidInput();
    seen.add(id);
    const inclusionReason = exactText(entry.inclusionReason, 30);
    const priority = exactText(entry.priority, 20);
    if (!DIGEST_INCLUSION_REASONS.has(inclusionReason) || !WORK_PRIORITIES.has(priority)) throw invalidInput();
    return { id, version: positiveVersion(entry.version), inclusionReason, priority };
  });
}

function rpcResult(data) {
  if (!isRecord(data)) throw new Error(`${REQUEST_ERROR_PREFIX}: response invalid`);
  return data;
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

function expectedDeliveryAttempts(value) {
  if (!Number.isInteger(value) || value < 0) throw invalidInput();
  return value;
}

function expectedTerminalDeliveryAttempts(value) {
  const attempts = expectedDeliveryAttempts(value);
  if (attempts < 1) throw invalidInput();
  return attempts;
}

function deliveredPatch(input = {}) {
  const deliveredAt = requiredText(input.deliveredAt, 100);
  if (Number.isNaN(new Date(deliveredAt).getTime())) throw invalidInput();
  return {
    slack_channel_id: requiredText(input.channelId, 500),
    slack_message_ts: requiredText(input.messageTs, 100),
    delivered_at: deliveredAt,
    last_delivery_error: null
  };
}

function failurePatch(input = {}) {
  if (!DELIVERY_FAILURE_CODES.has(input.failureCode)) throw invalidInput();
  return { last_delivery_error: input.failureCode };
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

  const transitionNotification = async (input, compare = {}) => {
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
      ...compare,
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
    getOldestPendingNotificationCreatedAt: async () => {
      const query = new URLSearchParams({
        select: 'created_at',
        notification_state: 'in.(pending,delivering,failed)',
        order: 'created_at.asc',
        limit: '1'
      });
      const { data } = await request(`message_notification_receipts?${query}`);
      const row = Array.isArray(data) ? data[0] || null : null;
      if (!row) return null;
      const createdAt = typeof row.created_at === 'string' ? row.created_at.trim() : '';
      if (!createdAt || Number.isNaN(Date.parse(createdAt))) {
        throw new Error(`${REQUEST_ERROR_PREFIX}: response invalid`);
      }
      return new Date(createdAt).toISOString();
    },
    transitionNotification,
    claimNotificationDelivery: async (input = {}) => {
      let id;
      let attempts;
      try {
        id = requiredText(input.id, 200);
        attempts = expectedDeliveryAttempts(input.expectedDeliveryAttempts);
      } catch {
        throw new Error('Work Orchestrator Supabase transition input is invalid');
      }
      if (attempts >= MAX_DELIVERY_ATTEMPTS) return { applied: false, row: null };
      return transitionNotification({
        id,
        fromStates: ['pending', 'failed'],
        toState: 'delivering',
        patch: {
          delivery_attempts: attempts + 1,
          last_delivery_error: null
        }
      }, {
        delivery_attempts: `eq.${attempts}`
      });
    },
    markNotificationDelivered: async (input = {}) => {
      let id;
      let attempts;
      let patch;
      try {
        id = requiredText(input.id, 200);
        attempts = expectedTerminalDeliveryAttempts(input.expectedDeliveryAttempts);
        patch = deliveredPatch(input);
      } catch {
        throw new Error('Work Orchestrator Supabase transition input is invalid');
      }
      return transitionNotification({
        id,
        fromStates: ['delivering'],
        toState: 'delivered',
        patch
      }, {
        delivery_attempts: `eq.${attempts}`
      });
    },
    markNotificationFailed: async (input = {}) => {
      let id;
      let attempts;
      let patch;
      try {
        id = requiredText(input.id, 200);
        attempts = expectedTerminalDeliveryAttempts(input.expectedDeliveryAttempts);
        patch = failurePatch(input);
      } catch {
        throw new Error('Work Orchestrator Supabase transition input is invalid');
      }
      return transitionNotification({
        id,
        fromStates: ['delivering'],
        toState: 'failed',
        patch
      }, {
        delivery_attempts: `eq.${attempts}`
      });
    },
    upsertWorkItem: async (input) => {
      let candidate;
      try {
        candidate = normalizeWorkCandidate(input);
      } catch {
        throw invalidInput();
      }
      const { data } = await request('rpc/upsert_work_item_v2', {
        method: 'POST',
        body: safeJson({ p_candidate: candidate })
      });
      return rpcResult(data);
    },
    requestWorkAction: async (input = {}) => {
      let body;
      try {
        body = {
          p_id: uuid(input.id),
          p_expected_version: positiveVersion(input.expectedVersion),
          p_action: normalizeWorkAction(input.action),
          p_requested_by: exactText(input.requestedBy, 200)
        };
      } catch {
        throw invalidInput();
      }
      const { data } = await request('rpc/request_work_item_action_v2', {
        method: 'POST', body: safeJson(body)
      });
      return rpcResult(data);
    },
    listActionableWork: async (input = {}) => {
      let now;
      let limit;
      try {
        now = isoTimestamp(input.now);
        if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 500) throw invalidInput();
        limit = input.limit;
      } catch {
        throw invalidInput();
      }
      const query = new URLSearchParams({
        select: ACTIONABLE_WORK_SELECT,
        state: 'in.(open,in_progress,snoozed)',
        or: `(actionable_at.lte.${now},priority.eq.p0)`,
        order: 'actionable_at.asc,first_opened_at.asc,id.asc',
        limit: String(limit)
      });
      const { data } = await request(`work_items_v2?${query}`);
      if (!Array.isArray(data)) throw new Error(`${REQUEST_ERROR_PREFIX}: response invalid`);
      return data;
    },
    claimDigestRun: async (input = {}) => {
      let body;
      try {
        const windowStartedAt = isoTimestamp(input.windowStartedAt);
        const windowEndedAt = isoTimestamp(input.windowEndedAt);
        if (Date.parse(windowStartedAt) > Date.parse(windowEndedAt)) throw invalidInput();
        if (!Number.isSafeInteger(input.leaseSeconds) || input.leaseSeconds < 1 || input.leaseSeconds > 900) {
          throw invalidInput();
        }
        body = {
          p_destination_key: exactText(input.destinationKey, 500),
          p_scheduled_at: isoTimestamp(input.scheduledAt),
          p_window_started_at: windowStartedAt,
          p_window_ended_at: windowEndedAt,
          p_lease_owner: exactText(input.leaseOwner, 200),
          p_lease_seconds: input.leaseSeconds
        };
      } catch {
        throw invalidInput();
      }
      const { data } = await request('rpc/claim_digest_run_v2', {
        method: 'POST', body: safeJson(body)
      });
      return rpcResult(data);
    },
    finalizeDigestRun: async (input = {}) => {
      let body;
      try {
        body = {
          p_id: uuid(input.id),
          p_lease_owner: exactText(input.leaseOwner, 200),
          p_item_snapshot: normalizeDigestSnapshot(input.itemSnapshot),
          p_slack_channel_id: exactText(input.channelId, 500),
          p_slack_message_ts: exactText(input.messageTs, 100),
          p_delivered_at: isoTimestamp(input.deliveredAt)
        };
      } catch {
        throw invalidInput();
      }
      const { data } = await request('rpc/finalize_digest_run_v2', {
        method: 'POST', body: safeJson(body)
      });
      return rpcResult(data);
    },
    failDigestRun: async (input = {}) => {
      let body;
      try {
        const error = exactText(input.error, 50);
        if (!DIGEST_FAILURE_CODES.has(error)) throw invalidInput();
        body = {
          p_id: uuid(input.id),
          p_lease_owner: exactText(input.leaseOwner, 200),
          p_error: error
        };
      } catch {
        throw invalidInput();
      }
      const { data } = await request('rpc/fail_digest_run_v2', {
        method: 'POST', body: safeJson(body)
      });
      return rpcResult(data);
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
