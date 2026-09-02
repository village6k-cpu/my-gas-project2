const MAX_COUNT = Number.MAX_SAFE_INTEGER;
const IMMEDIATE_DELIVERY_SLA_SECONDS = 5 * 60;
const HEALTH_AGGREGATE_INVALID = 'WORK_ORCHESTRATOR_HEALTH_AGGREGATE_INVALID';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function invalidAggregate() {
  const error = new Error('Work Orchestrator health aggregate is invalid');
  error.code = HEALTH_AGGREGATE_INVALID;
  return error;
}

function count(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_COUNT) throw invalidAggregate();
  return value;
}

function age(value, { required = false } = {}) {
  if (value === null && !required) return null;
  return count(value);
}

function canonicalTimestamp(value, { nullable = false } = {}) {
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || value.length > 40) throw invalidAggregate();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) throw invalidAggregate();
  return value;
}

function validateOldest(nowMs, total, timestamp, ageSeconds) {
  if (total === 0) {
    if (timestamp !== null || ageSeconds !== null) throw invalidAggregate();
    return;
  }
  const canonical = canonicalTimestamp(timestamp);
  const suppliedAge = age(ageSeconds, { required: true });
  const expectedAge = Math.floor((nowMs - Date.parse(canonical)) / 1000);
  if (expectedAge < 0 || suppliedAge !== expectedAge) throw invalidAggregate();
}

function stateCounts(value, keys) {
  if (!exactKeys(value, keys)) throw invalidAggregate();
  for (const key of keys.filter((entry) => entry.endsWith('_count'))) count(value[key]);
  return value;
}

function lease(value) {
  const keys = ['active_count', 'expired_count', 'oldest_expired_age_seconds'];
  stateCounts(value, keys);
  if (value.expired_count === 0) {
    if (value.oldest_expired_age_seconds !== null) throw invalidAggregate();
  } else {
    age(value.oldest_expired_age_seconds, { required: true });
  }
  return value;
}

export function validateWorkOrchestratorHealthAggregate(value, expectedNow) {
  const now = canonicalTimestamp(expectedNow);
  const nowMs = Date.parse(now);
  if (!exactKeys(value, [
    'measured_at', 'notifications', 'automation', 'work', 'digests',
    'cleanup', 'actions', 'leases'
  ])) throw invalidAggregate();
  if (canonicalTimestamp(value.measured_at) !== now) throw invalidAggregate();

  const notifications = value.notifications;
  const notificationKeys = [
    'undelivered_count', 'pending_count', 'delivering_count', 'failed_count',
    'oldest_undelivered_at', 'oldest_undelivered_age_seconds'
  ];
  if (!exactKeys(notifications, notificationKeys)) throw invalidAggregate();
  for (const key of ['undelivered_count', 'pending_count', 'delivering_count', 'failed_count']) {
    count(notifications[key]);
  }
  if (notifications.undelivered_count
    !== notifications.pending_count + notifications.delivering_count + notifications.failed_count) {
    throw invalidAggregate();
  }
  validateOldest(
    nowMs,
    notifications.undelivered_count,
    notifications.oldest_undelivered_at,
    notifications.oldest_undelivered_age_seconds
  );

  stateCounts(value.automation, [
    'not_attempted_count', 'running_count', 'succeeded_count', 'failed_count', 'needs_human_count'
  ]);

  const work = stateCounts(value.work, [
    'actionable_count', 'snoozed_count', 'overdue_count', 'p0_count',
    'unacknowledged_p0_count', 'unacknowledged_p0_missing_alert_count'
  ]);
  if (work.unacknowledged_p0_count > work.p0_count
    || work.unacknowledged_p0_missing_alert_count > work.unacknowledged_p0_count) throw invalidAggregate();

  const digestKeys = [
    'building_count', 'delivering_count', 'delivered_count', 'failed_count',
    'diverged_count', 'replaced_count', 'retired_count', 'last_success_at',
    'last_failure_at', 'latest_delivered_eligible_omitted_count'
  ];
  if (!exactKeys(value.digests, digestKeys)) throw invalidAggregate();
  for (const key of digestKeys.filter((key) => key.endsWith('_count'))) count(value.digests[key]);
  for (const key of ['last_success_at', 'last_failure_at']) {
    const timestamp = canonicalTimestamp(value.digests[key], { nullable: true });
    if (timestamp !== null && Date.parse(timestamp) > nowMs) throw invalidAggregate();
  }

  if (!exactKeys(value.cleanup, ['notice', 'digest'])) throw invalidAggregate();
  const notice = stateCounts(value.cleanup.notice, [
    'idle_count', 'pending_count', 'failed_count', 'blocked_p0_count',
    'deleted_count', 'backlog_count', 'oldest_backlog_age_seconds'
  ]);
  const digest = stateCounts(value.cleanup.digest, [
    'idle_count', 'deleting_count', 'failed_count', 'deleted_count',
    'already_absent_count', 'backlog_count', 'oldest_backlog_age_seconds'
  ]);
  for (const cleanup of [notice, digest]) {
    if (cleanup.backlog_count === 0) {
      if (cleanup.oldest_backlog_age_seconds !== null) throw invalidAggregate();
    } else {
      age(cleanup.oldest_backlog_age_seconds, { required: true });
    }
  }

  stateCounts(value.actions, ['stale_conflict_count']);
  if (!exactKeys(value.leases, ['digest', 'p0', 'notice_cleanup', 'digest_cleanup'])) {
    throw invalidAggregate();
  }
  lease(value.leases.digest);
  lease(value.leases.p0);
  lease(value.leases.notice_cleanup);
  lease(value.leases.digest_cleanup);

  return structuredClone(value);
}

function failed(measuredAt, reason) {
  return { ok: false, measuredAt, reasons: [reason], metrics: null };
}

export async function readWorkOrchestratorHealth({ store, now } = {}) {
  let measuredAt;
  try {
    measuredAt = canonicalTimestamp(now);
  } catch {
    return failed(null, 'health_clock_invalid');
  }
  if (!store || typeof store.readHealthAggregate !== 'function') {
    return failed(measuredAt, 'health_aggregate_unavailable');
  }

  let raw;
  try {
    raw = await store.readHealthAggregate({ now: measuredAt });
  } catch (error) {
    return failed(
      measuredAt,
      error?.code === HEALTH_AGGREGATE_INVALID
        ? 'health_aggregate_invalid'
        : 'health_aggregate_unavailable'
    );
  }

  let metrics;
  try {
    metrics = validateWorkOrchestratorHealthAggregate(raw, measuredAt);
  } catch {
    return failed(measuredAt, 'health_aggregate_invalid');
  }

  const reasons = [];
  if (metrics.notifications.oldest_undelivered_age_seconds !== null
    && metrics.notifications.oldest_undelivered_age_seconds > IMMEDIATE_DELIVERY_SLA_SECONDS) {
    reasons.push('immediate_delivery_sla_breached');
  }
  if (metrics.digests.latest_delivered_eligible_omitted_count > 0) {
    reasons.push('delivered_digest_eligible_omission');
  }
  if (metrics.work.unacknowledged_p0_missing_alert_count > 0) {
    reasons.push('unacknowledged_p0_missing_alert_state');
  }
  return { ok: reasons.length === 0, measuredAt, reasons, metrics };
}
