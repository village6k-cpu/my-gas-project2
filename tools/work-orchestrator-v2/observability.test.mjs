import assert from 'node:assert/strict';
import test from 'node:test';

import { readWorkOrchestratorHealth } from './observability.mjs';

const NOW = '2026-09-02T12:00:00.000Z';

function aggregate(overrides = {}) {
  const value = {
    measured_at: NOW,
    notifications: {
      undelivered_count: 3,
      pending_count: 1,
      delivering_count: 1,
      failed_count: 1,
      oldest_undelivered_at: '2026-09-02T11:56:00.000Z',
      oldest_undelivered_age_seconds: 240
    },
    automation: {
      not_attempted_count: 1,
      running_count: 2,
      succeeded_count: 3,
      failed_count: 4,
      needs_human_count: 5
    },
    work: {
      actionable_count: 6,
      snoozed_count: 2,
      overdue_count: 3,
      p0_count: 2,
      unacknowledged_p0_count: 1,
      unacknowledged_p0_missing_alert_count: 0
    },
    digests: {
      building_count: 0,
      delivering_count: 0,
      delivered_count: 5,
      failed_count: 1,
      diverged_count: 0,
      replaced_count: 4,
      retired_count: 0,
      last_success_at: '2026-09-02T09:00:00.000Z',
      last_failure_at: '2026-09-01T09:00:00.000Z',
      latest_delivered_eligible_omitted_count: 0
    },
    cleanup: {
      notice: {
        idle_count: 1,
        pending_count: 2,
        failed_count: 3,
        blocked_p0_count: 4,
        deleted_count: 5,
        backlog_count: 6,
        oldest_backlog_age_seconds: 90
      },
      digest: {
        idle_count: 1,
        deleting_count: 2,
        failed_count: 3,
        deleted_count: 4,
        already_absent_count: 5,
        backlog_count: 6,
        oldest_backlog_age_seconds: 120
      }
    },
    actions: { stale_conflict_count: 2 },
    leases: {
      digest: { active_count: 1, expired_count: 0, oldest_expired_age_seconds: null },
      p0: { active_count: 2, expired_count: 1, oldest_expired_age_seconds: 30 },
      notice_cleanup: { active_count: 1, expired_count: 1, oldest_expired_age_seconds: 60 },
      digest_cleanup: { active_count: 0, expired_count: 2, oldest_expired_age_seconds: 90 }
    }
  };
  return { ...value, ...overrides };
}

test('readWorkOrchestratorHealth returns one strict content-free aggregate using only the supplied clock', async () => {
  const calls = [];
  const expected = aggregate();
  const health = await readWorkOrchestratorHealth({
    store: { readHealthAggregate: async (input) => (calls.push(input), expected) },
    now: NOW
  });

  assert.deepEqual(calls, [{ now: NOW }]);
  assert.deepEqual(health, {
    ok: true,
    measuredAt: NOW,
    reasons: [],
    metrics: expected
  });
  assert.doesNotMatch(
    JSON.stringify(health),
    /source_event_key|payload|slack_channel|message_ts|customer|secret|token|owner_id|room_key|\"id\"/i
  );
});

test('readWorkOrchestratorHealth alarms only after the fixed five-minute SLA and on both durable omissions', async () => {
  const atBoundary = aggregate({
    notifications: {
      ...aggregate().notifications,
      oldest_undelivered_at: '2026-09-02T11:55:00.000Z',
      oldest_undelivered_age_seconds: 300
    }
  });
  assert.equal((await readWorkOrchestratorHealth({
    store: { readHealthAggregate: async () => atBoundary }, now: NOW
  })).ok, true, 'an event at exactly five minutes has not exceeded the SLA');

  const breached = aggregate({
    notifications: {
      ...aggregate().notifications,
      oldest_undelivered_at: '2026-09-02T11:54:59.000Z',
      oldest_undelivered_age_seconds: 301
    },
    work: {
      ...aggregate().work,
      p0_count: 2,
      unacknowledged_p0_count: 2,
      unacknowledged_p0_missing_alert_count: 2
    },
    digests: {
      ...aggregate().digests,
      latest_delivered_eligible_omitted_count: 3
    }
  });
  const health = await readWorkOrchestratorHealth({
    store: { readHealthAggregate: async () => breached }, now: NOW
  });
  assert.equal(health.ok, false);
  assert.deepEqual(health.reasons, [
    'immediate_delivery_sla_breached',
    'delivered_digest_eligible_omission',
    'unacknowledged_p0_missing_alert_state'
  ]);
});

test('expired scheduler leases remain metrics and do not invent a separate health alarm', async () => {
  const value = aggregate({
    leases: {
      digest: { active_count: 0, expired_count: 9, oldest_expired_age_seconds: 600 },
      p0: { active_count: 0, expired_count: 8, oldest_expired_age_seconds: 500 },
      notice_cleanup: { active_count: 0, expired_count: 7, oldest_expired_age_seconds: 400 },
      digest_cleanup: { active_count: 0, expired_count: 6, oldest_expired_age_seconds: 300 }
    }
  });
  const health = await readWorkOrchestratorHealth({
    store: { readHealthAggregate: async () => value }, now: NOW
  });
  assert.equal(health.ok, true);
  assert.deepEqual(health.reasons, []);
  assert.equal(health.metrics.leases.digest.expired_count, 9);
});

test('unknown or malformed aggregate evidence fails closed without reflecting content', async () => {
  const privateValue = 'PRIVATE-CUSTOMER-CONTENT';
  for (const malformed of [
    { ...aggregate(), payload: privateValue },
    { ...aggregate(), notifications: { ...aggregate().notifications, pending_count: -1 } },
    { ...aggregate(), leases: { ...aggregate().leases, p0: { active_count: 0.5, expired_count: 0, oldest_expired_age_seconds: null } } },
    { ...aggregate(), measured_at: '2026-09-02T12:00:01.000Z' }
  ]) {
    const health = await readWorkOrchestratorHealth({
      store: { readHealthAggregate: async () => malformed }, now: NOW
    });
    assert.deepEqual(health, {
      ok: false,
      measuredAt: NOW,
      reasons: ['health_aggregate_invalid'],
      metrics: null
    });
    assert.doesNotMatch(JSON.stringify(health), new RegExp(privateValue, 'i'));
  }
});

test('invalid clock and unavailable aggregate fail closed with finite reasons and no ambient-time call', async () => {
  let calls = 0;
  const invalidClock = await readWorkOrchestratorHealth({
    store: { readHealthAggregate: async () => (calls += 1) },
    now: 'not-a-clock'
  });
  assert.equal(calls, 0);
  assert.deepEqual(invalidClock, {
    ok: false,
    measuredAt: null,
    reasons: ['health_clock_invalid'],
    metrics: null
  });

  for (const store of [null, {}, { readHealthAggregate: async () => { throw new Error('PRIVATE DB ERROR'); } }]) {
    const health = await readWorkOrchestratorHealth({ store, now: NOW });
    assert.deepEqual(health, {
      ok: false,
      measuredAt: NOW,
      reasons: ['health_aggregate_unavailable'],
      metrics: null
    });
    assert.doesNotMatch(JSON.stringify(health), /PRIVATE DB ERROR/);
  }
});
