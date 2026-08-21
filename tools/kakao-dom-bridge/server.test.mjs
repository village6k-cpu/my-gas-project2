import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.KAKAO_DOM_BRIDGE_NO_LISTEN = '1';
const {
  buildCorsHeaders,
  buildHealthConfig,
  buildWorkerResultAudit,
  buildWorkerTreeKillInvocation,
  compactQueueAuditRecord,
  buildP0SlackEscalationClaim,
  buildP0SlackEscalationMessage,
  p0SlackEscalationBackoffMs,
  p0SlackEscalationDue,
  createKakaoPhaseScheduler,
  createGatewayConfirmationExecutor,
  createGatewayResultApplicationCoordinator,
  registerAcceptedRoomEvent,
  semanticRoomEventIdentity,
  hasUnreadCount,
  mergeQueuedRoomJobs,
  mapWorkerPayloadToSupabaseStatus,
  normalizeEvent,
  roomKeyForDebounce,
  shouldDetachWorkerProcess,
  shouldQueueTopRowEvent,
  shouldSkipSupabaseRowAsLowValue,
  shouldSkipWorkerForPreview
} = await import('./server.mjs');

test('server confirmation executor forwards the channel claim fence into the worker mutation boundary', async () => {
  let leaseChecks = 0;
  let operationArgs = null;
  const assertCurrentClaim = async () => { leaseChecks += 1; };
  const operationFence = {
    schema: 'village-tool-operation-reservation/v1', operation_id: 'operation-1',
    tool: 'confirmation_request', job_id: 'job-1', room_key: 'room-1', room_revision: 3,
    lease_id: 'lease-1', request_digest: 'digest-1', state: 'reserved',
    created_at: '2026-08-21T00:00:00.000Z', receipt_id: null, completed_at: null
  };
  const executor = createGatewayConfirmationExecutor({
    getConfig: () => ({ sheetApiKey: 'test-internal-key' }),
    executeOperation: async (args) => {
      operationArgs = args;
      await args.dependencies.assertCurrentClaim();
      return { status: 'ok' };
    }
  });

  const result = await executor({
    job_id: 'job-1', room_key: 'room-1', room_revision: 3,
    detected_at: '2026-08-21T00:00:00.000Z', decision: { should_write_to_sheet: true }
  }, { assertCurrentClaim, operationFence });

  assert.deepEqual(result, { status: 'ok' });
  assert.equal(leaseChecks, 1);
  assert.equal(operationArgs.job.jobId, 'job-1');
  assert.equal(operationArgs.job.roomKey, 'room-1');
  assert.equal(operationArgs.job.roomRevision, 3);
  assert.equal(operationArgs.dependencies.assertCurrentClaim, assertCurrentClaim);
  assert.equal(operationArgs.dependencies.operationFence, operationFence);
});

test('Gateway result coordinator serializes prepare, fresh DOM apply, finalize, and audit exactly once', async () => {
  const order = [];
  let applicationState = 'pending';
  const durableJob = {
    job_id: 'job-result-apply', room_key: 'room-result-apply', room_revision: 2,
    event: { schema: 'village-kakao-gateway-event/v1', job_id: 'job-result-apply', room_key: 'room-result-apply', room_revision: 2 },
    local_context: {
      job: { jobId: 'job-result-apply', roomKey: 'room-result-apply', roomRevision: 2 },
      turn_internal: { snapshot: { schema: 'kakao-room-snapshot/v1', jobId: 'job-result-apply', roomKey: 'room-result-apply', roomRevision: 2 } }
    },
    result: { content: 'FINAL_JSON {}' }, tool_receipts: [], application: { state: 'pending' }
  };
  const channel = {
    async claimApplication() {
      if (applicationState !== 'pending') return { claimed: false, job: structuredClone(durableJob) };
      applicationState = 'claimed';
      return { claimed: true, application_id: 'application-1', job: structuredClone({ ...durableJob, application: { state: 'claimed' } }) };
    },
    async beginApplication() { order.push('persist_applying'); applicationState = 'applying'; },
    async recordApplicationApplied() { order.push('persist_applied'); applicationState = 'applied'; },
    async finalizeApplication() { order.push('persist_finalized'); applicationState = 'finalized'; },
    async failApplication() { throw new Error('unexpected failure'); }
  };
  const coordinator = createGatewayResultApplicationCoordinator({
    channel,
    getConfig: () => ({ openTargetChat: false }),
    prepare: async () => { order.push('prepare'); return { status: 'ai_prepared', snapshot: durableJob.local_context.turn_internal.snapshot }; },
    apply: async () => { order.push('apply_fresh_dom'); return { prepared: { status: 'ai_prepared' }, autoReplyResult: { sent: false } }; },
    finalize: async () => { order.push('finalize_followup'); return { status: 'ai_completed', autoReplyResult: { sent: false } }; },
    record: async () => { order.push('audit'); }
  });

  const first = await coordinator.enqueue(durableJob);
  const duplicate = await coordinator.enqueue(durableJob);
  assert.equal(first.accepted, true);
  assert.equal(duplicate.accepted, false);
  await coordinator.idle();
  assert.deepEqual(order, ['prepare', 'persist_applying', 'apply_fresh_dom', 'persist_applied', 'finalize_followup', 'audit', 'persist_finalized']);
});

test('Gateway result coordinator keeps one application lane across rooms', async () => {
  const order = [];
  const states = new Map();
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const channel = {
    async claimApplication({ jobId }) {
      if (states.has(jobId)) return { claimed: false };
      states.set(jobId, 'applying');
      return {
        claimed: true, application_id: `application-${jobId}`,
        job: {
          job_id: jobId, room_key: `room-${jobId}`, room_revision: 1,
          event: { job_id: jobId, room_key: `room-${jobId}`, room_revision: 1 },
          local_context: { job: { jobId, roomKey: `room-${jobId}`, roomRevision: 1 }, turn_internal: { snapshot: {} } },
          result: { content: 'FINAL_JSON {}' }, tool_receipts: []
        }
      };
    },
    async beginApplication() {},
    async recordApplicationApplied({ job_id }) { states.set(job_id, 'applied'); },
    async finalizeApplication({ job_id }) { states.set(job_id, 'finalized'); },
    async failApplication() {}
  };
  const coordinator = createGatewayResultApplicationCoordinator({
    channel, getConfig: () => ({}),
    prepare: async ({ job }) => ({ status: 'ai_prepared', snapshot: {}, id: job.jobId }),
    apply: async ({ job, prepared }) => {
      order.push(`start:${job.jobId}`);
      if (job.jobId === 'one') await firstGate;
      order.push(`end:${job.jobId}`);
      return { prepared, autoReplyResult: { sent: false } };
    },
    finalize: async ({ applied }) => ({ ...applied.prepared, status: 'ai_completed' }),
    record: async () => {}
  });

  await coordinator.enqueue({ job_id: 'one' });
  await coordinator.enqueue({ job_id: 'two' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['start:one']);
  releaseFirst();
  await coordinator.idle();
  assert.deepEqual(order, ['start:one', 'end:one', 'start:two', 'end:two']);
});

test('Gateway result coordinator trusts only the receipt fenced by the durable channel operation', async () => {
  let receivedReceipts = null;
  const exact = {
    schema: 'village-confirmation-receipt/v1', receipt_id: 'receipt-exact',
    operation_id: 'operation-exact', lease_id: 'lease-exact', request_digest: 'digest-exact',
    job_id: 'job-receipt-provenance', room_key: 'room-receipt-provenance', room_revision: 1,
    status: 'ok', availability_report: [], authoritative_sheet_result: null,
    created_at: '2026-08-21T00:00:00.000Z', error: null
  };
  const fabricated = { ...exact, receipt_id: 'receipt-fabricated', operation_id: 'other-operation' };
  const durableJob = {
    job_id: exact.job_id, room_key: exact.room_key, room_revision: exact.room_revision,
    event: { job_id: exact.job_id, room_key: exact.room_key, room_revision: exact.room_revision },
    local_context: {
      job: { jobId: exact.job_id, roomKey: exact.room_key, roomRevision: exact.room_revision },
      turn_internal: { snapshot: {} }
    },
    result: { content: 'FINAL_JSON {}' },
    tool_operation: {
      schema: 'village-tool-operation-reservation/v1', state: 'completed',
      operation_id: exact.operation_id, receipt_id: exact.receipt_id,
      lease_id: exact.lease_id, request_digest: exact.request_digest,
      job_id: exact.job_id, room_key: exact.room_key, room_revision: exact.room_revision
    },
    tool_receipts: [fabricated, exact]
  };
  const channel = {
    async claimApplication() { return { claimed: true, application_id: 'application-provenance', job: structuredClone(durableJob) }; },
    async beginApplication() {},
    async recordApplicationApplied() {}, async finalizeApplication() {}, async failApplication() {}
  };
  const coordinator = createGatewayResultApplicationCoordinator({
    channel, getConfig: () => ({}),
    prepare: async ({ trustedToolReceipts }) => {
      receivedReceipts = trustedToolReceipts;
      return { status: 'ai_prepared', snapshot: {} };
    },
    apply: async ({ prepared }) => ({ prepared, autoReplyResult: { sent: false } }),
    finalize: async ({ applied }) => ({ ...applied.prepared, status: 'ai_completed' })
  });
  await coordinator.enqueue(durableJob);
  await coordinator.idle();
  assert.deepEqual(receivedReceipts, [exact]);
});

test('Gateway result coordinator records audit before terminal finalize and fails closed when recording crashes', async () => {
  const order = [];
  const durableJob = {
    job_id: 'job-record-crash', room_key: 'room-record-crash', room_revision: 1,
    event: { job_id: 'job-record-crash', room_key: 'room-record-crash', room_revision: 1 },
    local_context: {
      job: { jobId: 'job-record-crash', roomKey: 'room-record-crash', roomRevision: 1 },
      turn_internal: { snapshot: {} }
    },
    result: { content: 'FINAL_JSON {}' }, tool_receipts: []
  };
  const channel = {
    async claimApplication() { return { claimed: true, application_id: 'application-record-crash', job: structuredClone(durableJob) }; },
    async beginApplication() { order.push('persist_applying'); },
    async recordApplicationApplied() { order.push('persist_applied'); },
    async finalizeApplication() { order.push('persist_finalized'); },
    async failApplication() { order.push('persist_failed_review'); }
  };
  const coordinator = createGatewayResultApplicationCoordinator({
    channel, getConfig: () => ({}),
    prepare: async () => ({ status: 'ai_prepared', snapshot: {} }),
    apply: async ({ prepared }) => ({ prepared, autoReplyResult: { sent: false } }),
    finalize: async ({ applied }) => { order.push('finalize_followup'); return { ...applied.prepared, status: 'ai_completed' }; },
    record: async () => { order.push('audit'); throw new Error('offline audit failure'); },
    onFailure: async () => { order.push('human_review'); }
  });

  await coordinator.enqueue(durableJob);
  await coordinator.idle();
  assert.deepEqual(order, ['persist_applying', 'persist_applied', 'finalize_followup', 'audit', 'persist_failed_review', 'human_review']);
  assert.equal(order.includes('persist_finalized'), false);
});

test('Gateway result coordinator marks an apply-phase crash ambiguous and never replays DOM apply', async () => {
  const order = [];
  let claimed = false;
  let applyCount = 0;
  const durableJob = {
    job_id: 'job-apply-crash', room_key: 'room-apply-crash', room_revision: 1,
    event: { job_id: 'job-apply-crash', room_key: 'room-apply-crash', room_revision: 1 },
    local_context: {
      job: { jobId: 'job-apply-crash', roomKey: 'room-apply-crash', roomRevision: 1 },
      turn_internal: { snapshot: {} }
    },
    result: { content: 'FINAL_JSON {}' }, tool_receipts: [], application: { state: 'pending' }
  };
  const channel = {
    async claimApplication() {
      if (claimed) return { claimed: false, job: { ...durableJob, application: { state: 'failed' } } };
      claimed = true;
      return { claimed: true, application_id: 'application-apply-crash', job: structuredClone({ ...durableJob, application: { state: 'claimed' } }) };
    },
    async beginApplication() { order.push('persist_applying'); },
    async recordApplicationApplied() { order.push('unexpected_applied'); },
    async finalizeApplication() { order.push('unexpected_finalized'); },
    async failApplication() { order.push('persist_failed_review'); }
  };
  const coordinator = createGatewayResultApplicationCoordinator({
    channel, getConfig: () => ({}),
    prepare: async () => ({ status: 'ai_prepared', snapshot: {} }),
    apply: async () => { applyCount += 1; order.push('apply'); throw new Error('uncertain DOM outcome'); },
    finalize: async () => { order.push('unexpected_finalize'); },
    record: async () => { order.push('unexpected_audit'); },
    onFailure: async ({ durableJob: failedJob }) => {
      order.push(`human_review:${failedJob.application.state}`);
    }
  });

  assert.equal((await coordinator.enqueue(durableJob)).accepted, true);
  await coordinator.idle();
  assert.equal((await coordinator.enqueue(durableJob)).accepted, false);
  await coordinator.idle();
  assert.equal(applyCount, 1);
  assert.deepEqual(order, ['persist_applying', 'apply', 'persist_failed_review', 'human_review:applying']);
});

test('Gateway result coordinator recovers only durable pending applications after restart', async () => {
  const order = [];
  let state = 'pending';
  const durableJob = {
    job_id: 'job-startup-pending', room_key: 'room-startup-pending', room_revision: 1,
    event: { job_id: 'job-startup-pending', room_key: 'room-startup-pending', room_revision: 1 },
    local_context: {
      job: { jobId: 'job-startup-pending', roomKey: 'room-startup-pending', roomRevision: 1 },
      turn_internal: { snapshot: {} }
    },
    result: { content: 'FINAL_JSON {}' }, tool_receipts: [], application: { state: 'pending' }
  };
  const channel = {
    async listPendingApplications() { return [structuredClone(durableJob)]; },
    async claimApplication() {
      if (state !== 'pending') return { claimed: false };
      state = 'claimed';
      return { claimed: true, application_id: 'application-startup', job: structuredClone({ ...durableJob, application: { state: 'claimed' } }) };
    },
    async beginApplication() { state = 'applying'; order.push('apply_boundary'); },
    async recordApplicationApplied() { state = 'applied'; },
    async finalizeApplication() { state = 'finalized'; },
    async failApplication() { state = 'failed'; }
  };
  const coordinator = createGatewayResultApplicationCoordinator({
    channel, getConfig: () => ({}),
    prepare: async () => ({ status: 'ai_prepared', snapshot: {} }),
    apply: async ({ prepared }) => { order.push('apply'); return { prepared, autoReplyResult: { sent: false } }; },
    finalize: async ({ applied }) => ({ ...applied.prepared, status: 'ai_completed' })
  });

  const recovered = await coordinator.recoverPendingApplications();
  await coordinator.idle();
  assert.deepEqual(recovered, [{ accepted: true, application_id: 'application-startup' }]);
  assert.deepEqual(order, ['apply_boundary', 'apply']);
  assert.equal(state, 'finalized');
});

test('P0 Slack escalation repeats only after the durable interval and stops on closure', () => {
  const row = {
    id: 'p0-row',
    status: 'open',
    customer_name: '백남준',
    title: '대여 장비 이상 즉시 확인',
    payload: {
      alert_level: 'p0',
      alert_reason: '대여 중 장비 상태에 즉시 사람 판단 필요',
      slack_delivery: {
        status: 'delivered',
        channel_id: 'CINV',
        message_ts: '100.1',
        thread_ts: '100.1',
        delivered_at: '2026-08-18T00:00:00.000Z'
      }
    }
  };
  assert.equal(p0SlackEscalationDue(row, { nowMs: Date.parse('2026-08-18T00:02:59.000Z'), repeatMs: 180_000 }).due, false);
  assert.equal(p0SlackEscalationDue(row, { nowMs: Date.parse('2026-08-18T00:03:00.000Z'), repeatMs: 180_000 }).due, true);
  assert.equal(p0SlackEscalationDue({ ...row, status: 'done' }, { nowMs: Date.parse('2026-08-18T01:00:00.000Z') }).due, false);
});

test('P0 Slack escalation claim is durable and produces a deterministic Slack message id', () => {
  const row = {
    id: 'p0-row', status: 'open', customer_name: '백남준', title: '즉시 확인',
    payload: {
      alert_level: 'p0', alert_reason: '금액 또는 장비 사고',
      slack_delivery: { status: 'delivered', channel_id: 'CINV', message_ts: '100.1', thread_ts: '100.1', delivered_at: '2026-08-18T00:00:00.000Z' }
    }
  };
  const first = buildP0SlackEscalationClaim(row, { nowMs: Date.parse('2026-08-18T00:03:00.000Z'), repeatMs: 180_000 });
  const retry = buildP0SlackEscalationClaim(row, { nowMs: Date.parse('2026-08-18T00:03:00.000Z'), repeatMs: 180_000 });
  assert.equal(first.attempt, 1);
  assert.equal(first.clientMessageId, retry.clientMessageId);
  assert.match(first.clientMessageId, /^[0-9a-f-]{36}$/);
  const message = buildP0SlackEscalationMessage(row, first, { mentionUserIds: ['UOWNER'] });
  assert.match(message.text, /<!channel>/);
  assert.match(message.text, /<@UOWNER>/);
  assert.equal(message.thread_ts, '100.1');
  assert.equal(message.reply_broadcast, true);
  assert.equal(message.client_msg_id, first.clientMessageId);
});

test('P0 Slack escalation backs off exponentially and stops at the attempt cap', () => {
  const base = {
    id: 'p0-row', status: 'open', customer_name: '백남준', title: '즉시 확인',
    payload: {
      alert_level: 'p0', alert_reason: '금액 또는 장비 사고',
      slack_delivery: { status: 'delivered', channel_id: 'CINV', message_ts: '100.1', thread_ts: '100.1', delivered_at: '2026-08-18T00:00:00.000Z' }
    }
  };
  assert.equal(p0SlackEscalationBackoffMs(0, 600_000, 3_600_000), 600_000);
  assert.equal(p0SlackEscalationBackoffMs(1, 600_000, 3_600_000), 1_200_000);
  assert.equal(p0SlackEscalationBackoffMs(2, 600_000, 3_600_000), 2_400_000);
  assert.equal(p0SlackEscalationBackoffMs(6, 600_000, 3_600_000), 3_600_000);
  const afterFirst = {
    ...base,
    payload: { ...base.payload, critical_delivery: { status: 'delivered', attempt: 1, last_sent_at: '2026-08-18T00:10:00.000Z' } }
  };
  assert.equal(p0SlackEscalationDue(afterFirst, { nowMs: Date.parse('2026-08-18T00:29:59.000Z'), repeatMs: 600_000 }).due, false);
  assert.equal(p0SlackEscalationDue(afterFirst, { nowMs: Date.parse('2026-08-18T00:30:00.000Z'), repeatMs: 600_000 }).due, true);
  const exhausted = {
    ...base,
    payload: { ...base.payload, critical_delivery: { status: 'delivered', attempt: 159, last_sent_at: '2026-08-18T00:10:00.000Z' } }
  };
  assert.equal(p0SlackEscalationDue(exhausted, { nowMs: Date.parse('2026-08-19T00:00:00.000Z') }).reason, 'max_attempts');
  assert.equal(p0SlackEscalationDue(base, { nowMs: Date.parse('2026-08-19T00:00:00.000Z'), maxAttempts: 0 }).reason, 'disabled');
});

test('P0 escalation without an initial Slack card falls back to a standalone channel message', () => {
  const row = {
    id: 'p0-row-2', status: 'open', customer_name: '김손님', title: '즉시 확인',
    created_at: '2026-08-18T00:00:00.000Z', updated_at: '2026-08-18T00:00:00.000Z',
    payload: { alert_level: 'p0', alert_reason: '초기 카드 전달 실패' }
  };
  const due = p0SlackEscalationDue(row, { nowMs: Date.parse('2026-08-18T00:10:00.000Z'), repeatMs: 600_000 });
  assert.equal(due.due, true);
  const claim = buildP0SlackEscalationClaim(row, { nowMs: Date.parse('2026-08-18T00:10:00.000Z'), repeatMs: 600_000 });
  const message = buildP0SlackEscalationMessage(row, claim, { mentionUserIds: ['UOWNER'], fallbackChannelId: 'CFOLLOWUP' });
  assert.equal(message.channel, 'CFOLLOWUP');
  assert.equal(message.thread_ts, undefined);
  assert.equal(message.reply_broadcast, false);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('slow Hermes decisions release the DOM lane for another room and manual sends', async () => {
  const firstDecision = deferred();
  const events = [];
  let domActive = 0;
  let maxDomActive = 0;
  let decisionActive = 0;
  let maxDecisionActive = 0;
  const withDomProbe = async (label, value) => {
    domActive += 1;
    maxDomActive = Math.max(maxDomActive, domActive);
    events.push(`${label}:start`);
    await new Promise((resolve) => setImmediate(resolve));
    events.push(`${label}:end`);
    domActive -= 1;
    return value;
  };
  const scheduler = createKakaoPhaseScheduler({
    decisionConcurrency: 2,
    capture: async (job) => withDomProbe(`capture:${job.roomKey}`, { job }),
    decide: async (snapshot) => {
      decisionActive += 1;
      maxDecisionActive = Math.max(maxDecisionActive, decisionActive);
      try {
        if (snapshot.job.roomKey === 'A') await firstDecision.promise;
        return { snapshot };
      } finally {
        decisionActive -= 1;
      }
    },
    apply: async (prepared) => withDomProbe(`apply:${prepared.snapshot.job.roomKey}`, prepared),
    finalize: async (applied) => applied,
    manualSend: async (payload) => withDomProbe('manual', { sent: true, payload })
  });

  const roomA = scheduler.run({ roomKey: 'A' });
  await new Promise((resolve) => setImmediate(resolve));
  const roomB = scheduler.run({ roomKey: 'B' });
  const manual = scheduler.runManual({ text: 'staff reply' });

  const [roomBResult, manualResult] = await Promise.all([roomB, manual]);
  assert.equal(roomBResult.snapshot.job.roomKey, 'B');
  assert.equal(manualResult.sent, true);
  assert.equal(maxDomActive, 1, 'capture/apply/manual DOM work must stay serial');
  assert.equal(maxDecisionActive, 2, 'two rooms may think concurrently');
  assert.ok(!events.includes('apply:A:start'), 'room A is still thinking');
  assert.equal(typeof roomBResult.phaseTimings.captureQueueMs, 'number');
  assert.equal(typeof roomBResult.phaseTimings.decisionMs, 'number');
  assert.equal(typeof roomBResult.phaseTimings.applyMs, 'number');
  assert.equal(typeof roomBResult.phaseTimings.totalMs, 'number');

  firstDecision.resolve();
  await roomA;
});

test('phase scheduler propagates a bridge deadline into an active Hermes decision', async () => {
  const controller = new AbortController();
  const deadlineError = new Error('bridge deadline exceeded');
  const scheduler = createKakaoPhaseScheduler({
    capture: async (job) => ({ job }),
    decide: async (snapshot, job, options = {}) => {
      if (!options.signal) throw new Error('missing phase abort signal');
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    },
    apply: async (prepared) => prepared,
    finalize: async (applied) => applied,
    manualSend: async (payload) => payload
  });

  const run = scheduler.run({ roomKey: 'deadline-room' }, { signal: controller.signal });
  controller.abort(deadlineError);

  await assert.rejects(run, (error) => error === deadlineError);
});

test('phase scheduler enforces the configured end-to-end worker timeout', async () => {
  const scheduler = createKakaoPhaseScheduler({
    workerTimeoutMs: 20,
    capture: async (job) => ({ job }),
    decide: async (snapshot, job, options = {}) => {
      if (!options.signal) {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return { snapshot };
      }
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    },
    apply: async (prepared) => prepared,
    finalize: async (applied) => applied,
    manualSend: async (payload) => payload
  });

  await assert.rejects(
    scheduler.run({ roomKey: 'timed-room' }),
    /worker timed out after 20ms/
  );
});

test('worker result audit keeps phase timings and AI attempt counts without customer payload', () => {
  const audit = buildWorkerResultAudit({
    status: 'ai_completed',
    hermesAttempts: 3,
    hermesRecovered: true,
    timings: { lookupMs: 100, hermesMs: 2000, sheetAndReconciliationMs: 500, totalMs: 2600 },
    phaseTimings: { captureQueueMs: 4, captureMs: 50, decisionQueueMs: 8, decisionMs: 2600, applyQueueMs: 2, applyMs: 30, finalizeMs: 20, totalMs: 2714 },
    decision: { reason: 'private customer content' },
    snapshot: { navigation: { conversation_evidence: { visible_static_text_tail: 'private chat' } } }
  }, 2714);
  const record = compactQueueAuditRecord('worker-results.ndjson', {
    at: '2026-08-18T00:00:00.000Z',
    jobId: 'dom-test',
    result: { code: 0, signal: null, timedOut: false, stdout: 'private stdout', stderr: '', audit }
  });

  assert.deepEqual(record.result.audit, audit);
  assert.equal(record.result.audit.status, 'ai_completed');
  assert.equal(record.result.audit.phaseTimings.decisionMs, 2600);
  assert.doesNotMatch(JSON.stringify(record.result.audit), /private|customer|chat/);
});

test('room revisions ignore unread-badge duplicates and supersede older semantic turns', () => {
  const versions = new Map();
  const first = registerAcceptedRoomEvent(versions, 'chat:1', '홍길동 문의 오후 1:00');
  const duplicate = registerAcceptedRoomEvent(versions, 'chat:1', '홍길동 문의 오후 1:00');
  const newer = registerAcceptedRoomEvent(versions, 'chat:1', '홍길동 추가 문의 오후 1:01');

  assert.equal(first.revision, 1);
  assert.equal(duplicate.revision, 1);
  assert.equal(duplicate.changed, false);
  assert.equal(newer.revision, 2);
  assert.equal(newer.changed, true);
});

test('identical reply text at a later displayed time is a new room revision', () => {
  const earlier = semanticRoomEventIdentity({ previewText: '홍길동 네', displayTime: '오전 9:10' });
  const unreadMutation = semanticRoomEventIdentity({ previewText: '홍길동 2 네', displayTime: '오전 9:10' });
  const later = semanticRoomEventIdentity({ previewText: '홍길동 네', displayTime: '오전 9:25' });

  assert.equal(unreadMutation, earlier);
  assert.notEqual(later, earlier);
});

test('a superseded phase result stays superseded in the durable event row', () => {
  assert.deepEqual(mapWorkerPayloadToSupabaseStatus({
    status: 'superseded_by_newer_room_event',
    decision: { should_write_to_sheet: true },
    sheetResult: { success: true }
  }), {
    status: 'superseded_by_newer_room_event',
    error_message: null
  });
});

test('production queue uses the phase scheduler and publishes freshness before durable writes', async () => {
  const source = await readFile(new URL('./server.mjs', import.meta.url), 'utf8');
  assert.match(source, /CONFIG\.aiDomSplitEnabled\s*\?\s*run\(\)\s*:\s*workerChain\.then/);
  assert.match(source, /getKakaoPhaseScheduler\(\)\.runManual/);
  assert.match(source, /url\.pathname === '\/worker\/freshness'/);
  const revisionIndex = source.indexOf('registerAcceptedRoomEvent(state.roomVersions');
  const supabaseIndex = source.indexOf("await writeSupabaseEvent(event, 'event')", revisionIndex);
  assert.ok(revisionIndex >= 0 && supabaseIndex > revisionIndex, 'freshness revision must advance before Supabase latency');
  assert.match(source, /readBooleanEnvironment\(process\.env\.KAKAO_AI_DOM_SPLIT_ENABLED, false\)/);
  assert.match(source, /getKakaoPhaseScheduler\(\)\.runManual\(\{[\s\S]*?cleanupIdleKakaoConversationTabs\('worker_finished'/);
});

test('health config exposes the live safety contract used by supervised restarts', async () => {
  assert.deepEqual(buildHealthConfig({
    workerLive: true,
    autoSendEnabled: true,
    workerDryRun: false,
    windowsWritesEnabled: true,
    startupCatchupSupported: true
  }), {
    workerLive: true,
    autoSendEnabled: true,
    workerDryRun: false,
    windowsWritesEnabled: true,
    startupCatchupSupported: true
  });

  const source = await readFile(new URL('./server.mjs', import.meta.url), 'utf8');
  assert.match(source, /startupCatchupSupported:\s*true/);
  assert.doesNotMatch(
    source,
    /startupCatchupSupported:\s*process\.env\.PROCESS_INITIAL_SCAN/,
    'catch-up capability is independent from whether initial-scan events are currently processed'
  );
});

test('bridge-created failure cards forward configured Slack mention recipients', async () => {
  const source = await readFile(new URL('./server.mjs', import.meta.url), 'utf8');
  assert.match(
    source,
    /slackMentionUserIds:\s*String\(process\.env\.SLACK_CARD_MENTION_USER_IDS/
  );
});

test('stable Kakao chat identity survives normalization and debounce grouping', () => {
  const first = normalizeEvent({
    roomKey: 'chat:4978438284325090',
    customerName: '김정태',
    messagePreview: '첫 문의',
    displayTime: '오후 2:51',
    previewText: '중요 김정태 1 첫 문의 오후 2:51',
    eventHash: 'event-1'
  });
  const second = normalizeEvent({
    roomKey: 'chat:4978438284325090',
    customerName: '김정태',
    messagePreview: '추가 문의',
    displayTime: '오후 2:52',
    previewText: '중요 김정태 2 추가 문의 오후 2:52',
    eventHash: 'event-2'
  });

  assert.equal(first.customerName, '김정태');
  assert.equal(first.messagePreview, '첫 문의');
  assert.equal(first.displayTime, '오후 2:51');
  assert.equal(roomKeyForDebounce(first), 'chat:4978438284325090');
  assert.equal(roomKeyForDebounce(second), 'chat:4978438284325090');
});

test('queued jobs for one chat coalesce into the newest AI read instead of piling up', () => {
  const previous = {
    jobId: 'old-job',
    roomKey: 'chat:4978438284325090',
    firstEventAt: '2026-07-23T05:00:00.000Z',
    lastEventAt: '2026-07-23T05:01:00.000Z',
    previewText: '첫 문의',
    events: [{ eventHash: 'event-1', previewText: '첫 문의' }]
  };
  const latest = {
    jobId: 'new-job',
    roomKey: 'chat:4978438284325090',
    customerName: '김정태',
    firstEventAt: '2026-07-23T05:02:00.000Z',
    lastEventAt: '2026-07-23T05:03:00.000Z',
    previewText: '추가 문의',
    events: [{ eventHash: 'event-2', previewText: '추가 문의' }]
  };

  assert.deepEqual(mergeQueuedRoomJobs(previous, latest), {
    ...latest,
    firstEventAt: previous.firstEventAt,
    eventCount: 2,
    events: [...previous.events, ...latest.events]
  });
});

test('bridge queue replaces pending same-room work and cleans conversation tabs after every worker', async () => {
  const source = await readFile(new URL('./server.mjs', import.meta.url), 'utf8');
  assert.match(source, /const queuedWorkerSlotsByRoom = new Map\(\)/);
  assert.match(source, /superseded_by_newer_room_event/);
  assert.match(source, /cleanupIdleKakaoConversationTabs\('worker_finished', \{ allowQueued: true \}\)/);
});

test('stable job identity ignores a disappearing Kakao unread badge for the same message', async () => {
  const { semanticPreviewIdentity } = await import('./server.mjs');
  assert.equal(
    semanticPreviewIdentity('중요 김명선 2 여쭤볼라했는데 전원이 꺼져있어서 카톡으로 남겨드립니다! 오후 4:17'),
    semanticPreviewIdentity('중요 김명선 여쭤볼라했는데 전원이 꺼져있어서 카톡으로 남겨드립니다! 오후 4:17')
  );
});

test('CORS preflight permits Chrome private-network access to the loopback bridge', () => {
  assert.equal(buildCorsHeaders()['access-control-allow-private-network'], 'true');
});

test('Windows workers stay in the owned tree and timeout cleanup targets the whole tree', () => {
  assert.equal(shouldDetachWorkerProcess('win32'), false);
  assert.equal(shouldDetachWorkerProcess('linux'), true);
  assert.deepEqual(buildWorkerTreeKillInvocation(1234, 'SIGTERM', 'win32'), {
    command: 'taskkill.exe',
    args: ['/PID', '1234', '/T'],
    options: { shell: false, stdio: 'ignore', windowsHide: true }
  });
  assert.deepEqual(buildWorkerTreeKillInvocation(1234, 'SIGKILL', 'win32'), {
    command: 'taskkill.exe',
    args: ['/PID', '1234', '/T', '/F'],
    options: { shell: false, stdio: 'ignore', windowsHide: true }
  });
  assert.equal(buildWorkerTreeKillInvocation(1234, 'SIGTERM', 'linux'), null);
});

test('generic DOM unreadSignal does not turn a read top-row backstop into a worker job', () => {
  const staleOutgoingRow = {
    reason: 'top_rows_backstop',
    previewText: '중요 임우혁 네, 예약 정보 확인해보겠습니다! 오전 10:31',
    unreadCount: null,
    raw: { unreadSignal: true }
  };

  assert.equal(hasUnreadCount(staleOutgoingRow), false);
  assert.equal(shouldQueueTopRowEvent(staleOutgoingRow), false);
  assert.equal(shouldSkipSupabaseRowAsLowValue({
    status: 'ai_worker_error',
    preview_text: staleOutgoingRow.previewText,
    payload: {
      reason: 'top_rows_backstop',
      raw: { unreadSignal: true }
    }
  }), 'untrusted_backstop_row');
});

test('a counted unread top-row remains eligible for normal processing', () => {
  const unreadCustomerRow = {
    reason: 'top_rows_backstop',
    previewText: '중요 새고객 2 FX3 내일 대여 가능할까요? 오후 10:31',
    unreadCount: 2,
    raw: { unreadSignal: true }
  };

  assert.equal(hasUnreadCount(unreadCustomerRow), true);
  assert.equal(shouldQueueTopRowEvent(unreadCustomerRow), true);
  assert.equal(shouldSkipWorkerForPreview(unreadCustomerRow), '');
});

test('semantic-looking previews are never suppressed before Hermes sees the room', () => {
  const semanticPreviews = [
    '감사합니다',
    '빌리지님이 보냄 요청하신 통장 사본 전달드립니다',
    '입금했습니다',
    '네 가능합니다',
    '반납 완료했습니다'
  ];

  for (const previewText of semanticPreviews) {
    assert.equal(
      shouldSkipWorkerForPreview({
        reason: 'mutation',
        previewText,
        unreadCount: null
      }),
      '',
      `preview must reach Hermes: ${previewText}`
    );
  }
});

test('recovery only rejects untrusted historical rows, not message semantics', () => {
  for (const previewText of ['감사합니다', '입금했습니다', '운영자님이 보냄', '네 가능합니다']) {
    assert.equal(shouldSkipSupabaseRowAsLowValue({
      status: 'ai_worker_error',
      preview_text: previewText,
      payload: {
        reason: 'mutation',
        raw: { unreadSignal: false }
      }
    }), '');
  }
});

test('a meaningful live top-row change remains eligible without an unread counter', () => {
  const now = new Date();
  const hour = now.getHours() % 12 || 12;
  const minute = String(now.getMinutes()).padStart(2, '0');
  const period = now.getHours() < 12 ? '오전' : '오후';
  const liveCustomerRow = {
    reason: 'top_row_changed',
    previewText: `새고객 FX3 내일 대여 가능할까요? ${period} ${hour}:${minute}`,
    unreadCount: null,
    raw: { unreadSignal: false }
  };

  assert.equal(hasUnreadCount(liveCustomerRow), false);
  assert.equal(shouldQueueTopRowEvent(liveCustomerRow), true);
});

test('server keeps Gateway HTTP disabled by default and dispatches it before public routes', async () => {
  const source = await readFile(new URL('./server.mjs', import.meta.url), 'utf8');
  assert.match(source, /hermesTransport:\s*String\(process\.env\.KAKAO_HERMES_TRANSPORT\s*\|\|\s*'cli'\)\.trim\(\)\s*\|\|\s*'cli'/);
  assert.match(source, /hermesBridgeToken:\s*String\(process\.env\.KAKAO_HERMES_BRIDGE_TOKEN\s*\|\|\s*''\)\.trim\(\)/);
  assert.match(source, /KAKAO_HERMES_LEASE_MS/);
  assert.match(source, /KAKAO_HERMES_MAX_ATTEMPTS/);
  assert.match(source, /createHermesGatewayHttpHandler/);
  assert.ok(source.indexOf('gatewayHttpHandler(req, res, url)') < source.indexOf("url.pathname === '/health'"));
});
