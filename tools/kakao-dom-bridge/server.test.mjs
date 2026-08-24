import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.KAKAO_DOM_BRIDGE_NO_LISTEN = '1';
const {
  buildCorsHeaders,
  buildHealthConfig,
  buildGatewayHealthReadback,
  assertGatewayFailureNotificationDelivered,
  buildWorkerResultAudit,
  buildWorkerTreeKillInvocation,
  compactQueueAuditRecord,
  buildP0SlackEscalationClaim,
  buildP0SlackEscalationMessage,
  p0SlackEscalationBackoffMs,
  p0SlackEscalationDue,
  createKakaoPhaseScheduler,
  createGatewayConfirmationExecutor,
  createGatewayConfirmationValidator,
  createGatewayDocumentExecutor,
  resolveGatewayDocumentConfig,
  createGatewayApplicationFailureNotifier,
  createGatewayFailureNotificationCoordinator,
  createGatewayResultApplicationCoordinator,
  createAiJobDispatcher,
  configForHermesTransport,
  classifyInitialScanIngress,
  gatewayDispatchFailurePolicy,
  finalizeGatewayDispatchFailurePolicy,
  registerAcceptedRoomEvent,
  semanticRoomEventIdentity,
  hasUnreadCount,
  mergeQueuedRoomJobs,
  kakaoSendAllowedForTransport,
  mapWorkerPayloadToSupabaseStatus,
  normalizeEvent,
  roomKeyForDebounce,
  recoverFailedGatewayDispatch,
  resolveHermesTransport,
  resolveHermesMaxAttempts,
  shouldDetachWorkerProcess,
  shouldQueueTopRowEvent,
  shouldSkipSupabaseRowAsLowValue,
  shouldSkipWorkerForPreview
} = await import('./server.mjs');

test('Gateway initial unread scans become no-send startup catch-up work even when legacy scan processing is disabled', () => {
  for (const hermesTransport of ['gateway', 'gateway_no_send']) {
    const result = classifyInitialScanIngress({
      reason: 'initial_scan', roomKey: 'chat:recovery', unreadCount: 2,
      previewText: '중요 이상율 2 예약 양식'
    }, { processInitialScan: false, hermesTransport });
    assert.equal(result.action, 'queue');
    assert.equal(result.event.reason, 'startup_catchup');
    assert.equal(result.event.originalReason, 'initial_scan');
    assert.equal(result.event.recoveryOnly, true);
  }
});

test('initial scan ingress remains conservative for CLI and rows without a visible unread count', () => {
  assert.deepEqual(classifyInitialScanIngress({
    reason: 'initial_scan', roomKey: 'chat:cli', unreadCount: 1
  }, { processInitialScan: false, hermesTransport: 'cli' }), {
    action: 'ignore', reason: 'initial_scan_disabled'
  });
  assert.deepEqual(classifyInitialScanIngress({
    reason: 'initial_scan', roomKey: 'chat:read', unreadCount: 0
  }, { processInitialScan: true, hermesTransport: 'gateway' }), {
    action: 'ignore', reason: 'initial_scan_without_unread'
  });
  const ordinary = { reason: 'mutation', roomKey: 'chat:live', unreadCount: 1 };
  assert.deepEqual(classifyInitialScanIngress(ordinary, {
    processInitialScan: false, hermesTransport: 'gateway'
  }), { action: 'continue', event: ordinary });
});

test('missing Kakao conversation evidence gets exactly one durable retry before human review', () => {
  const error = new Error('conversation body not rendered');
  error.code = 'kakao_conversation_evidence_unavailable';
  assert.deepEqual(gatewayDispatchFailurePolicy(error, { recoveryAttempts: 0 }), {
    status: 'ai_worker_error',
    retryable: true,
    notifyHuman: false,
    errorType: 'kakao_conversation_evidence_unavailable'
  });
  assert.deepEqual(gatewayDispatchFailurePolicy(error, { recoveryAttempts: 1 }), {
    status: 'needs_human_review',
    retryable: false,
    notifyHuman: true,
    errorType: 'kakao_conversation_evidence_unavailable'
  });
  assert.deepEqual(gatewayDispatchFailurePolicy(new Error('invalid contract'), { recoveryAttempts: 0 }), {
    status: 'needs_human_review',
    retryable: false,
    notifyHuman: true,
    errorType: 'gateway_dispatch_failed'
  });
});

test('a retry that cannot be durably recorded is promoted to immediate human review', () => {
  const retry = {
    status: 'ai_worker_error', retryable: true, notifyHuman: false,
    errorType: 'kakao_conversation_evidence_unavailable'
  };
  assert.deepEqual(finalizeGatewayDispatchFailurePolicy(retry, { ok: true }), retry);
  assert.deepEqual(finalizeGatewayDispatchFailurePolicy(retry, { skipped: true }), {
    status: 'needs_human_review', retryable: false, notifyHuman: true,
    errorType: 'kakao_conversation_evidence_unavailable'
  });
  assert.deepEqual(finalizeGatewayDispatchFailurePolicy(retry, null), {
    status: 'needs_human_review', retryable: false, notifyHuman: true,
    errorType: 'kakao_conversation_evidence_unavailable'
  });
});

test('event ingress canonicalizes valid high-precision ISO timestamps for the strict Gateway contract', () => {
  const event = normalizeEvent({
    roomKey: 'chat:operator-recovery',
    reason: 'operator_recovery',
    detectedAt: '2026-08-23T00:54:20.1696859Z'
  });
  assert.equal(event.detectedAt, '2026-08-23T00:54:20.169Z');
  assert.equal(event.raw.detectedAt, '2026-08-23T00:54:20.1696859Z');
});

test('Hermes transport defaults only to CLI and rejects unknown values without activating Gateway', () => {
  assert.equal(resolveHermesTransport(undefined), 'cli');
  assert.equal(resolveHermesTransport(''), 'cli');
  assert.equal(resolveHermesTransport('cli'), 'cli');
  assert.equal(resolveHermesTransport('gateway'), 'gateway');
  assert.equal(resolveHermesTransport('gateway_no_send'), 'gateway_no_send');
  assert.throws(() => resolveHermesTransport('gateawy'), /Unsupported KAKAO_HERMES_TRANSPORT/);
});

test('Hermes Gateway max-attempt environment boundary defaults to two and rejects a third claim', () => {
  assert.equal(resolveHermesMaxAttempts(undefined), 2);
  assert.equal(resolveHermesMaxAttempts(''), 2);
  assert.equal(resolveHermesMaxAttempts('1'), 1);
  assert.equal(resolveHermesMaxAttempts('2'), 2);
  assert.throws(() => resolveHermesMaxAttempts('3'), /KAKAO_HERMES_MAX_ATTEMPTS/);
  assert.throws(() => resolveHermesMaxAttempts('1.5'), /KAKAO_HERMES_MAX_ATTEMPTS/);
});

test('AI job dispatcher preserves the exact legacy CLI path when transport is missing', async () => {
  const calls = [];
  const dispatcher = createAiJobDispatcher({
    transport: undefined,
    runLegacy: async (job, context) => {
      calls.push({ job, context });
      return { ok: true, legacy: true };
    },
    capture: async () => { throw new Error('Gateway capture must not run'); },
    buildTurn: async () => { throw new Error('Gateway turn builder must not run'); },
    channel: { enqueue: async () => { throw new Error('Gateway channel must not run'); } }
  });
  const job = { jobId: 'cli-job', roomKey: 'cli-room', roomRevision: 1 };
  const result = await dispatcher(job, { origin: 'test' });
  assert.deepEqual(result, { ok: true, legacy: true });
  assert.deepEqual(calls, [{ job, context: { origin: 'test' } }]);
});

test('Gateway dispatcher captures once and enqueues only seven plugin fields with local context kept durable', async () => {
  const calls = [];
  const enqueued = [];
  const job = {
    jobId: 'gateway-job', roomKey: 'gateway-room', roomRevision: 4,
    detectedAt: '2026-08-21T01:02:03.000Z', previewText: 'customer text'
  };
  const snapshot = {
    schema: 'kakao-room-snapshot/v1', jobId: job.jobId, roomKey: job.roomKey,
    roomRevision: job.roomRevision, capturedAt: '2026-08-21T01:02:04.000Z'
  };
  const internal = { snapshot, private_lookup: { secret: 'local only' } };
  const event = {
    schema: 'village-kakao-gateway-event/v1', job_id: job.jobId, room_key: job.roomKey,
    room_revision: job.roomRevision, prompt: 'native Hermes prompt',
    detected_at: job.detectedAt, raw: { safe: true }
  };
  const dispatcher = createAiJobDispatcher({
    transport: 'gateway',
    getConfig: () => ({ autoSendEnabled: true }),
    capture: async ({ config, job: capturedJob }) => {
      calls.push(['capture', config, capturedJob]);
      return { snapshot };
    },
    buildTurn: async ({ config, job: builtJob, capture }) => {
      calls.push(['build', config, builtJob, capture]);
      return { event, internal };
    },
    channel: {
      async enqueue(envelope, options) {
        enqueued.push({ envelope: structuredClone(envelope), options: structuredClone(options) });
        return { job_id: envelope.job_id, state: 'ready' };
      }
    },
    runLegacy: async () => { throw new Error('legacy Hermes child path must not run'); }
  });

  const result = await dispatcher(job, { origin: 'live_dom_event' });
  assert.equal(result.queued, true);
  assert.equal(calls.filter(([kind]) => kind === 'capture').length, 1);
  assert.equal(calls.filter(([kind]) => kind === 'build').length, 1);
  assert.deepEqual(Object.keys(enqueued[0].envelope).sort(), [
    'detected_at', 'job_id', 'prompt', 'raw', 'room_key', 'room_revision', 'schema'
  ]);
  assert.deepEqual(enqueued[0].envelope, event);
  assert.deepEqual(enqueued[0].options.localContext, { job, turn_internal: internal });
  assert.equal(JSON.stringify(enqueued[0].envelope).includes('local only'), false);
});

test('gateway_no_send still builds a native turn while forcing all runtime send and write gates off', async () => {
  assert.equal(kakaoSendAllowedForTransport('gateway_no_send'), false);
  assert.equal(kakaoSendAllowedForTransport('gateway'), true);
  assert.equal(kakaoSendAllowedForTransport('cli'), true);
  assert.deepEqual(
    configForHermesTransport({ autoSendEnabled: true, windowsWritesEnabled: true, marker: 'shared' }, 'gateway_no_send'),
    { autoSendEnabled: false, windowsWritesEnabled: false, marker: 'shared' }
  );
  let seenConfig = null;
  let legacyCalls = 0;
  const dispatcher = createAiJobDispatcher({
    transport: 'gateway_no_send',
    getConfig: () => ({ autoSendEnabled: true, windowsWritesEnabled: true, marker: 'preserved' }),
    capture: async ({ config, job }) => {
      seenConfig = config;
      return { snapshot: { schema: 'kakao-room-snapshot/v1', jobId: job.jobId, roomKey: job.roomKey, roomRevision: job.roomRevision } };
    },
    buildTurn: async ({ config, job }) => {
      assert.equal(config.autoSendEnabled, false);
      assert.equal(config.windowsWritesEnabled, false);
      return {
        event: {
          schema: 'village-kakao-gateway-event/v1', job_id: job.jobId, room_key: job.roomKey,
          room_revision: job.roomRevision, prompt: 'reason natively', detected_at: '2026-08-21T00:00:00.000Z', raw: {}
        },
        internal: { snapshot: {} }
      };
    },
    channel: { enqueue: async () => ({ state: 'ready' }) },
    runLegacy: async () => { legacyCalls += 1; }
  });
  const result = await dispatcher({ jobId: 'nosend-job', roomKey: 'nosend-room', roomRevision: 1 });
  assert.equal(result.queued, true);
  assert.equal(seenConfig.autoSendEnabled, false);
  assert.equal(seenConfig.windowsWritesEnabled, false);
  assert.equal(seenConfig.marker, 'preserved');
  assert.equal(legacyCalls, 0);
});

test('Gateway dispatcher surfaces an existing terminal failed job for human review instead of reporting queue success', async () => {
  const job = { jobId: 'already-failed', roomKey: 'failed-room', roomRevision: 2 };
  const dispatcher = createAiJobDispatcher({
    transport: 'gateway',
    getConfig: () => ({}),
    capture: async () => ({ snapshot: {} }),
    buildTurn: async () => ({
      event: {
        schema: 'village-kakao-gateway-event/v1', job_id: job.jobId, room_key: job.roomKey,
        room_revision: job.roomRevision, prompt: 'native', detected_at: '2026-08-21T00:00:00.000Z', raw: {}
      },
      internal: { snapshot: {} }
    }),
    channel: {
      enqueue: async () => ({
        job_id: job.jobId, state: 'failed', human_review_required: true,
        error: { type: 'lease_retry_exhausted' }
      })
    },
    runLegacy: async () => { throw new Error('legacy path must not run'); }
  });
  assert.deepEqual(await dispatcher(job), {
    ok: false, queued: false, transport: 'gateway', job_id: job.jobId,
    state: 'failed', human_review_required: true, error_type: 'lease_retry_exhausted'
  });

  let recoveryCalls = 0;
  assert.equal(await recoverFailedGatewayDispatch({
    result: await dispatcher(job),
    recover: async () => { recoveryCalls += 1; return [{ job_id: job.jobId, notified: true }]; }
  }), true);
  assert.equal(await recoverFailedGatewayDispatch({
    result: { ok: true, queued: false, state: 'completed' },
    recover: async () => { recoveryCalls += 1; }
  }), false);
  assert.equal(recoveryCalls, 1);
});

test('Gateway failure notification recovery is durable and retries notification without rerunning work', async () => {
  let delivered = false;
  let notificationCalls = 0;
  let workCalls = 0;
  const failedJob = {
    job_id: 'failed-job', room_key: 'failed-room', room_revision: 1,
    local_context: { job: { jobId: 'failed-job', roomKey: 'failed-room', roomRevision: 1 } },
    error: { type: 'lease_retry_exhausted' },
    failure_notification: { state: 'pending' }
  };
  const channel = {
    async listPendingFailureNotifications() { return delivered ? [] : [structuredClone(failedJob)]; },
    async markFailureNotified({ job_id, audit }) {
      assert.equal(job_id, failedJob.job_id);
      assert.deepEqual(audit, { follow_up_id: 'follow-up-1' });
      delivered = true;
    }
  };
  const first = createGatewayFailureNotificationCoordinator({
    channel,
    notify: async () => { notificationCalls += 1; throw new Error('temporary Slack outage'); }
  });
  assert.deepEqual(await first.recover(), [{ job_id: failedJob.job_id, notified: false, error: 'temporary Slack outage' }]);
  assert.equal(delivered, false);

  const restarted = createGatewayFailureNotificationCoordinator({
    channel,
    notify: async ({ durableJob }) => {
      notificationCalls += 1;
      assert.equal(durableJob.job_id, failedJob.job_id);
      return { follow_up_id: 'follow-up-1' };
    },
    runWork: async () => { workCalls += 1; }
  });
  assert.deepEqual(await restarted.recover(), [{ job_id: failedJob.job_id, notified: true }]);
  assert.equal(delivered, true);
  assert.equal(notificationCalls, 2);
  assert.equal(workCalls, 0);
  assert.deepEqual(await restarted.recover(), []);
});

test('Gateway failure notification keeps pending when enabled Slack returns a nested skipped error', async () => {
  const badDelivery = {
    inserted: 1,
    rows: [{ id: 'failure-card-1' }],
    slackDeliveryResult: {
      skipped: true,
      reason: 'two_channel_preflight_failed',
      error: 'Slack routing preflight failed',
      results: []
    }
  };
  assert.throws(
    () => assertGatewayFailureNotificationDelivered(badDelivery, { slackEnabled: true }),
    /gateway_failure_notification_slack_failed/
  );
  assert.doesNotThrow(() => assertGatewayFailureNotificationDelivered({
    inserted: 0, rows: [],
    slackDeliveryResult: { skipped: true, reason: 'no_rows', results: [] }
  }, { slackEnabled: true }));
  assert.doesNotThrow(() => assertGatewayFailureNotificationDelivered({
    inserted: 1, rows: [{ id: 'failure-card-disabled' }],
    slackDeliveryResult: { skipped: true, reason: 'disabled', results: [] }
  }, { slackEnabled: false }));

  let marks = 0;
  const channel = {
    async listPendingFailureNotifications() {
      return [{ job_id: 'nested-slack-failure', error: { type: 'lease_retry_exhausted' } }];
    },
    async markFailureNotified() { marks += 1; }
  };
  const coordinator = createGatewayFailureNotificationCoordinator({
    channel,
    notify: async () => {
      assertGatewayFailureNotificationDelivered(badDelivery, { slackEnabled: true });
      return badDelivery;
    }
  });
  const result = await coordinator.recover();
  assert.equal(result[0].notified, false);
  assert.match(result[0].error, /gateway_failure_notification_slack_failed/);
  assert.equal(marks, 0);
});

test('Gateway health readback requires a fresh consumer and exposes only safe aggregate fields', () => {
  const readback = buildGatewayHealthReadback({
    transport: 'gateway', gatewayConfigured: true,
    nowMs: Date.parse('2026-08-21T00:02:00.000Z'), consumerFreshnessMs: 180_000,
    status: {
      counts: { ready: 2, claimed: 1, retry_wait: 0, failed: 3, completed: 4, superseded: 1 },
      application_counts: { pending: 1, claimed: 0, applying: 0, applied: 0, finalized: 3, failed: 1 },
      failure_notification_counts: { pending: 2, delivered: 5 },
      unnotified_application_failures: 1,
      oldest_lease_age_ms: 75_000,
      last_completed_job_id: 'completed-job',
      last_consumer_id: 'gateway-consumer-1',
      last_consumer_seen_at: '2026-08-21T00:00:30.000Z',
      token: 'must-not-leak', prompt: 'must-not-leak', local_context: { secret: true }
    }
  });
  assert.deepEqual(readback, {
    transport: 'gateway', gatewayConfigured: true, gatewayReady: true,
    consumer: { id: 'gateway-consumer-1', last_seen_at: '2026-08-21T00:00:30.000Z', age_ms: 90_000, fresh: true },
    queue: { ready: 2, claimed: 1, retry: 0, failed: 3, oldest_claim_age_ms: 75_000, last_completed_job_id: 'completed-job' },
    application_counts: { pending: 1, claimed: 0, applying: 0, applied: 0, finalized: 3, failed: 1 },
    failure_notification_counts: { pending: 2, delivered: 5 },
    unnotified_application_failures: 1
  });
  assert.equal(JSON.stringify(readback).includes('must-not-leak'), false);
  const stale = buildGatewayHealthReadback({
    transport: 'gateway', gatewayConfigured: true,
    nowMs: Date.parse('2026-08-21T00:05:00.001Z'), consumerFreshnessMs: 180_000,
    status: {
      last_consumer_id: 'gateway-consumer-1', last_consumer_seen_at: '2026-08-21T00:00:30.000Z',
      oldest_lease_age_ms: null
    }
  });
  assert.equal(stale.gatewayReady, false);
  assert.equal(stale.consumer.fresh, false);
  assert.equal(stale.queue.oldest_claim_age_ms, null);
});

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

test('server document executor fences then sends the exact registered supply-only quote and returns a correlated receipt', async () => {
  const calls = [];
  let leaseChecks = 0;
  const executor = createGatewayDocumentExecutor({
    getConfig: () => ({ documentApiBaseUrl: 'https://docs.example/exec', documentApiKey: 'doc-key' }),
    executeRequest: async (request, options) => {
      calls.push({ request, options });
      return {
        ok: true, documentType: 'quote', tradeId: '260822-001', taxMode: 'supply_only',
        response: { status: 'OK', tradeID: '260822-001', taxMode: 'supply_only', pdfUrl: 'https://drive.example/quote.pdf' }
      };
    },
    randomUUID: () => 'document-receipt-1',
    now: () => new Date('2026-08-24T01:00:00.000Z')
  });

  const receipt = await executor({
    job_id: 'job-document', room_key: 'room-document', room_revision: 9,
    document_type: 'quote', trade_id: '260822-001', tax_mode: 'supply_only'
  }, { assertCurrentClaim: async () => { leaseChecks += 1; } });

  assert.equal(leaseChecks, 1);
  assert.deepEqual(calls, [{
    request: { document_type: 'quote', trade_id: '260822-001', tax_mode: 'supply_only' },
    options: { documentApiBaseUrl: 'https://docs.example/exec', documentApiKey: 'doc-key' }
  }]);
  assert.deepEqual(receipt, {
    schema: 'village-document-receipt/v1', receipt_id: 'document-receipt-1',
    job_id: 'job-document', room_key: 'room-document', room_revision: 9, status: 'ok',
    document_type: 'quote', trade_id: '260822-001', tax_mode: 'supply_only',
    authoritative_document_result: {
      status: 'OK', tradeID: '260822-001', taxMode: 'supply_only', pdfUrl: 'https://drive.example/quote.pdf'
    },
    created_at: '2026-08-24T01:00:00.000Z', error: null
  });
});

test('server document executor turns transport exceptions into a durable failed receipt', async () => {
  const executor = createGatewayDocumentExecutor({
    getConfig: () => ({ documentApiBaseUrl: 'https://docs.example/exec', documentApiKey: 'doc-key' }),
    executeRequest: async () => { throw new Error('network reset after request'); },
    randomUUID: () => 'document-receipt-failed-1',
    now: () => new Date('2026-08-24T01:01:00.000Z')
  });

  const receipt = await executor({
    job_id: 'job-document-failed', room_key: 'room-document', room_revision: 10,
    document_type: 'quote', trade_id: '260822-001', tax_mode: 'supply_only'
  }, { assertCurrentClaim: async () => {} });

  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.error.type, 'document_send_exception');
  assert.match(receipt.error.message, /network reset after request/);
});

test('gateway document config uses explicit overrides or the existing internal GAS credential', () => {
  assert.deepEqual(resolveGatewayDocumentConfig({
    documentApiBaseUrl: '', documentApiKey: ''
  }, { sheetApiKey: 'derived-internal-key' }), {
    documentApiBaseUrl: 'https://script.google.com/macros/s/AKfycbwX2V0SqRf23DCwaVojlc5YFXKTfMNLBt68edpGmCx8j0i9hkYdP_bXHKEGIcde2iS5EA/exec',
    documentApiKey: 'derived-internal-key'
  });
  assert.deepEqual(resolveGatewayDocumentConfig({
    documentApiBaseUrl: 'https://override.example/exec', documentApiKey: 'override-key'
  }, { sheetApiKey: 'derived-internal-key' }), {
    documentApiBaseUrl: 'https://override.example/exec', documentApiKey: 'override-key'
  });
});

test('server confirmation validator rejects invalid decisions before durable reservation wiring', async () => {
  const validator = createGatewayConfirmationValidator({
    validateDecision: (decision) => decision.sheet_row_candidate?.discount_type
      ? { valid: true, errors: [] }
      : { valid: false, errors: ['discount required'] }
  });
  assert.deepEqual(await validator({ decision: { sheet_row_candidate: { discount_type: '' } } }), {
    valid: false,
    errors: ['discount required']
  });
  assert.deepEqual(await validator({ decision: { sheet_row_candidate: { discount_type: '일반' } } }), {
    valid: true,
    errors: []
  });
  const serverSource = await readFile(new URL('./server.mjs', import.meta.url), 'utf8');
  assert.match(serverSource, /validateConfirmation:\s*gatewayConfirmationValidator/);
});

test('server confirmation validator rejects a claimed existing RQ that is absent from live GAS', async () => {
  const lookups = [];
  const validator = createGatewayConfirmationValidator({
    getConfig: () => ({ gasApiUrl: 'https://gas.example/exec', sheetApiKey: 'secret' }),
    fetchExistingRequest: async (_config, decision) => {
      lookups.push(structuredClone(decision.existing_confirm_request_ids));
      return null;
    }
  });
  const decision = {
    classification: 'already_answered',
    should_write_to_sheet: false,
    reservation_inquiry: { is_reservation_inquiry: true, already_registered: false },
    existing_confirm_request_ids: ['RQ-260823-001'],
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      latest_customer_message_after_last_staff_reply: true
    },
    sheet_row_candidate: {},
    follow_up_items: [{
      type: 'reservation_review',
      route: 'schedule',
      taskKey: 'reservation:kim-hyeji:2026-09-02:canon-rf-100-500',
      priority: 'high',
      status: 'open',
      title: 'Existing confirmation request review',
      customer_name: '김혜지',
      summary: 'Review the existing confirmation request result before replying.',
      recommended_action: 'Use the authoritative request result for owner review.',
      suggested_reply_draft: '',
      evidence: ['Hermes claimed RQ-260823-001 exists.'],
      blocking_reason: '',
      due_hint: 'now'
    }],
    reply_decision: {
      replyMode: 'no_reply',
      text: '',
      confidence: 'high',
      reason: 'Staff already replied; verify the claimed request before closing the turn.',
      shouldCreateTask: true,
      safetyClass: 'no_send',
      grounding: 'visible_conversation',
      requiresRag: false,
      attachmentKeys: [],
      alreadyDelivered: true
    }
  };

  assert.deepEqual(await validator({ decision }), {
    valid: false,
    errors: [
      'existing confirm request RQ-260823-001 was not found in the live sheet; if the reservation remains unregistered, correct the decision and write it'
    ]
  });
  assert.deepEqual(lookups, [['RQ-260823-001']]);

  const verified = createGatewayConfirmationValidator({
    getConfig: () => ({ gasApiUrl: 'https://gas.example/exec', sheetApiKey: 'secret' }),
    fetchExistingRequest: async () => ({ reqID: 'RQ-260823-001', results: [] })
  });
  assert.deepEqual(await verified({ decision }), { valid: true, errors: [] });

  const unavailable = createGatewayConfirmationValidator({
    getConfig: () => ({ gasApiUrl: 'https://gas.example/exec', sheetApiKey: 'secret' }),
    fetchExistingRequest: async () => ({
      reqID: 'RQ-260823-001',
      results: [],
      lookup_error: 'network timeout'
    })
  });
  assert.deepEqual(await unavailable({ decision }), {
    valid: false,
    errors: [
      'existing confirm request RQ-260823-001 could not be verified in the live sheet; retry the tool before finishing'
    ]
  });
});

test('server default confirmation validator matches the safe sheet payload boundary', () => {
  const validator = createGatewayConfirmationValidator();
  const decision = {
    classification: 'reservation',
    should_write_to_sheet: true,
    reservation_inquiry: {
      is_reservation_inquiry: true,
      already_registered: false,
      confirmed: true,
      equipment_requested: [{
        raw_text: 'FX3',
        normalized_guess: '소니 FX3 바디세트',
        exact_name_from_equipment_catalog: '소니 FX3 바디세트',
        exact_name_from_set_master: null,
        catalog_match_status: 'matched',
        quantity: 1,
        confidence: 'high'
      }]
    },
    sheet_row_candidate: {
      plan_complete: true,
      start_date: '2026-08-28',
      pickup_time: '15:00',
      end_date: '2026-08-29',
      return_time: '15:00',
      customer_name: '안재용',
      phone: '010-0000-0000',
      discount_type: '학생',
      equipment_write_mode: 'full_plan',
      equipment: [{ item: '소니 FX3 바디세트', quantity: 1 }]
    }
  };

  const missing = validator({ decision });
  assert.equal(missing.valid, false);
  assert.match(missing.errors.join('|'), /safety_checks|safe confirmation-request payload/);

  decision.safety_checks = {
    kakao_conversation_opened: true,
    did_not_classify_from_preview_only: true,
    latest_customer_message_after_last_staff_reply: true
  };
  assert.deepEqual(validator({ decision }), { valid: true, errors: [] });
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
    async failApplication() { throw new Error('unexpected failure'); },
    async listPendingApplicationFailureNotifications() { return []; },
    async markApplicationFailureNotified() {}
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
    async failApplication() {},
    async listPendingApplicationFailureNotifications() { return []; },
    async markApplicationFailureNotified() {}
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
    async recordApplicationApplied() {}, async finalizeApplication() {}, async failApplication() {},
    async listPendingApplicationFailureNotifications() { return []; },
    async markApplicationFailureNotified() {}
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
    async failApplication({ error }) {
      order.push('persist_failed_review');
      return structuredClone({
        ...durableJob,
        application: {
          state: 'failed', application_id: 'application-record-crash', error,
          failure_notification: { state: 'pending' }
        }
      });
    },
    async listPendingApplicationFailureNotifications() { return []; },
    async markApplicationFailureNotified() { order.push('persist_notified'); }
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
  assert.deepEqual(order, ['persist_applying', 'persist_applied', 'finalize_followup', 'audit', 'persist_failed_review', 'human_review', 'persist_notified']);
  assert.equal(order.includes('persist_finalized'), false);
});

test('Gateway result coordinator fails closed when required owner review persistence or Slack delivery fails', async () => {
  const cases = [
    {
      name: 'follow-up persistence error',
      finalization: {
        followUpResult: { inserted: 0, rows: [], error: 'Supabase owner card insert failed' },
        slackDeliveryResult: { skipped: true, reason: 'no_rows', results: [] }
      },
      error: /gateway_owner_review_persistence_failed/
    },
    {
      name: 'required owner-review row missing',
      finalization: {
        followUpResult: { inserted: 0, rows: [] },
        slackDeliveryResult: { skipped: true, reason: 'no_rows', results: [] }
      },
      error: /gateway_owner_review_not_persisted/
    },
    {
      name: 'Slack owner-card delivery error',
      finalization: {
        followUpResult: { inserted: 1, rows: [{ id: 'owner-card-1' }] },
        slackDeliveryResult: { skipped: false, results: [{ ok: false, rowId: 'owner-card-1', error: 'Slack offline' }] }
      },
      error: /gateway_owner_review_slack_failed/
    }
  ];

  for (const entry of cases) {
    const order = [];
    let failureMessage = '';
    const durableJob = {
      job_id: `job-${entry.name}`, room_key: `room-${entry.name}`, room_revision: 1,
      event: { job_id: `job-${entry.name}`, room_key: `room-${entry.name}`, room_revision: 1 },
      local_context: {
        job: { jobId: `job-${entry.name}`, roomKey: `room-${entry.name}`, roomRevision: 1 },
        turn_internal: { snapshot: {} }
      },
      result: { content: 'FINAL_JSON {}' }, tool_receipts: [], application: { state: 'pending' }
    };
    const channel = {
      async claimApplication() {
        return { claimed: true, application_id: `application-${entry.name}`, job: structuredClone({ ...durableJob, application: { state: 'claimed' } }) };
      },
      async beginApplication() { order.push('persist_applying'); },
      async recordApplicationApplied() { order.push('persist_applied'); },
      async finalizeApplication() { order.push('unexpected_finalized'); },
      async failApplication({ error }) {
        failureMessage = error.message;
        order.push('persist_failed_review');
        return structuredClone({
          ...durableJob,
          application: {
            state: 'failed', application_id: `application-${entry.name}`, error,
            failure_notification: { state: 'pending' }
          }
        });
      },
      async listPendingApplicationFailureNotifications() { return []; },
      async markApplicationFailureNotified() { order.push('persist_notified'); }
    };
    const prepared = {
      status: 'ai_prepared', snapshot: {},
      decision: { owner_review_required: true, reply_decision: { shouldCreateTask: true } },
      availabilityAwareRows: [{ type: 'schedule_check', payload: { follow_up_route: 'schedule' } }]
    };
    const coordinator = createGatewayResultApplicationCoordinator({
      channel, getConfig: () => ({}),
      prepare: async () => prepared,
      apply: async () => { order.push('apply'); return { prepared, autoReplyResult: { sent: false } }; },
      finalize: async () => { order.push('finalize'); return { ...prepared, status: 'ai_completed', ...entry.finalization }; },
      record: async () => { order.push('unexpected_audit'); },
      onFailure: async () => { order.push('human_review'); }
    });

    await coordinator.enqueue(durableJob);
    await coordinator.idle();
    assert.match(failureMessage, entry.error, entry.name);
    assert.deepEqual(order, ['persist_applying', 'apply', 'persist_applied', 'finalize', 'persist_failed_review', 'human_review', 'persist_notified'], entry.name);
  }
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
    async failApplication({ error }) {
      order.push('persist_failed_review');
      return structuredClone({
        ...durableJob,
        application: {
          state: 'failed', application_id: 'application-apply-crash', error,
          failure_notification: { state: 'pending' }
        }
      });
    },
    async listPendingApplicationFailureNotifications() { return []; },
    async markApplicationFailureNotified() { order.push('persist_notified'); }
  };
  const coordinator = createGatewayResultApplicationCoordinator({
    channel, getConfig: () => ({}),
    prepare: async () => ({ status: 'ai_prepared', snapshot: {} }),
    apply: async () => { applyCount += 1; order.push('apply'); throw new Error('uncertain DOM outcome'); },
    finalize: async () => { order.push('unexpected_finalize'); },
    record: async () => { order.push('unexpected_audit'); },
    onFailure: async ({ durableJob: failedJob }) => {
      order.push(`human_review:${failedJob.application.state}:${failedJob.application.error.type}`);
    }
  });

  assert.equal((await coordinator.enqueue(durableJob)).accepted, true);
  await coordinator.idle();
  assert.equal((await coordinator.enqueue(durableJob)).accepted, false);
  await coordinator.idle();
  assert.equal(applyCount, 1);
  assert.deepEqual(order, ['persist_applying', 'apply', 'persist_failed_review', 'human_review:failed:ambiguous_dom_apply_failure', 'persist_notified']);
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
    async failApplication() { state = 'failed'; },
    async listPendingApplicationFailureNotifications() { return []; },
    async markApplicationFailureNotified() {}
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

test('Gateway result coordinator notifies restarted application failures without replaying apply or finalize', async () => {
  const order = [];
  let notificationState = 'pending';
  const failedJob = {
    job_id: 'job-restart-failure', room_key: 'room-restart-failure', room_revision: 1,
    event: { job_id: 'job-restart-failure', room_key: 'room-restart-failure', room_revision: 1 },
    local_context: {
      job: { jobId: 'job-restart-failure', roomKey: 'room-restart-failure', roomRevision: 1 },
      turn_internal: { snapshot: {} }
    },
    application: {
      state: 'failed', application_id: 'application-restart-failure',
      error: { type: 'ambiguous_post_apply_restart', message: 'DOM outcome is ambiguous' },
      failure_notification: { state: 'pending' }
    }
  };
  const channel = {
    async claimApplication() { throw new Error('must not claim failed application'); },
    async beginApplication() { throw new Error('must not begin failed application'); },
    async recordApplicationApplied() { throw new Error('must not apply failed application'); },
    async finalizeApplication() { throw new Error('must not finalize failed application'); },
    async failApplication() { throw new Error('must not fail an already failed application again'); },
    async listPendingApplicationFailureNotifications() {
      return notificationState === 'pending' ? [structuredClone(failedJob)] : [];
    },
    async markApplicationFailureNotified({ job_id, application_id }) {
      order.push(`notified:${job_id}:${application_id}`);
      notificationState = 'delivered';
    }
  };
  const coordinator = createGatewayResultApplicationCoordinator({
    channel, getConfig: () => ({}),
    prepare: async () => { order.push('unexpected_prepare'); },
    apply: async () => { order.push('unexpected_apply'); },
    finalize: async () => { order.push('unexpected_finalize'); },
    onFailure: async ({ durableJob, error }) => {
      order.push(`human_review:${durableJob.job_id}:${error.message}`);
    }
  });

  const recovered = await coordinator.recoverApplicationFailureNotifications();
  const duplicate = await coordinator.recoverApplicationFailureNotifications();
  assert.deepEqual(recovered, [{ job_id: failedJob.job_id, notified: true }]);
  assert.deepEqual(duplicate, []);
  assert.deepEqual(order, [
    'human_review:job-restart-failure:DOM outcome is ambiguous',
    'notified:job-restart-failure:application-restart-failure'
  ]);
});

test('Gateway result coordinator leaves failure notification pending when human-review notification fails', async () => {
  let marked = 0;
  const durableJob = {
    job_id: 'job-notification-retry', room_key: 'room-notification-retry', room_revision: 1,
    event: { job_id: 'job-notification-retry', room_key: 'room-notification-retry', room_revision: 1 },
    local_context: { job: { jobId: 'job-notification-retry' }, turn_internal: { snapshot: {} } },
    result: { content: 'FINAL_JSON {}' }, application: { state: 'claimed' }
  };
  const failedJob = {
    ...durableJob,
    application: {
      state: 'failed', application_id: 'application-notification-retry',
      error: { type: 'gateway_application_failed', message: 'apply failed' },
      failure_notification: { state: 'pending' }
    }
  };
  const channel = {
    async claimApplication() { return { claimed: true, application_id: 'application-notification-retry', job: structuredClone(durableJob) }; },
    async beginApplication() {}, async recordApplicationApplied() {}, async finalizeApplication() {},
    async failApplication() { return structuredClone(failedJob); },
    async listPendingApplicationFailureNotifications() { return [structuredClone(failedJob)]; },
    async markApplicationFailureNotified() { marked += 1; }
  };
  const coordinator = createGatewayResultApplicationCoordinator({
    channel, getConfig: () => ({}),
    prepare: async () => { throw new Error('apply failed'); },
    onFailure: async () => { throw new Error('owner card unavailable'); }
  });

  await coordinator.enqueue(durableJob);
  await coordinator.idle();
  const retry = await coordinator.recoverApplicationFailureNotifications();
  assert.equal(marked, 0);
  assert.deepEqual(retry, [{ job_id: failedJob.job_id, notified: false, error: 'owner card unavailable' }]);
});

test('Gateway application recovery keeps nested Slack skipped errors pending without replaying DOM work', async () => {
  let marks = 0;
  let statusUpdates = 0;
  let domWork = 0;
  const durableJob = {
    job_id: 'application-nested-slack-error', room_key: 'application-nested-room', room_revision: 1,
    local_context: {
      job: { jobId: 'application-nested-slack-error', roomKey: 'application-nested-room', roomRevision: 1 }
    },
    application: {
      state: 'failed', application_id: 'application-nested-id',
      error: { type: 'ambiguous_post_apply_restart' },
      failure_notification: { state: 'pending' }
    }
  };
  const channel = {
    async listPendingApplicationFailureNotifications() { return [structuredClone(durableJob)]; },
    async markApplicationFailureNotified() { marks += 1; },
    async claimApplication() { domWork += 1; },
    async beginApplication() { domWork += 1; },
    async recordApplicationApplied() { domWork += 1; },
    async finalizeApplication() { domWork += 1; },
    async failApplication() { domWork += 1; }
  };
  const onFailure = createGatewayApplicationFailureNotifier({
    slackEnabled: true,
    createFollowUp: async () => ({
      inserted: 1,
      rows: [{ id: 'application-failure-card' }],
      slackDeliveryResult: {
        skipped: true,
        reason: 'two_channel_preflight_failed',
        error: 'Slack routing unavailable',
        results: []
      }
    }),
    updateStatus: async () => { statusUpdates += 1; }
  });
  const coordinator = createGatewayResultApplicationCoordinator({
    channel,
    getConfig: () => ({}),
    prepare: async () => { domWork += 1; },
    apply: async () => { domWork += 1; },
    finalize: async () => { domWork += 1; },
    onFailure
  });

  const recovered = await coordinator.recoverApplicationFailureNotifications();
  assert.deepEqual({
    notified: recovered[0].notified,
    error: recovered[0].error || '',
    marks,
    statusUpdates
  }, {
    notified: false,
    error: 'gateway_failure_notification_slack_failed: Slack routing unavailable',
    marks: 0,
    statusUpdates: 0
  });
  assert.equal(domWork, 0);
});

test('Gateway result coordinator audit elapsed time includes durable Hermes session and tool wait', async () => {
  const detectedAt = '2026-08-21T00:00:00.000Z';
  const localStart = Date.parse('2026-08-21T00:02:00.000Z');
  const finished = Date.parse('2026-08-21T00:02:05.000Z');
  const clock = [localStart, finished];
  let recorded = null;
  const durableJob = {
    job_id: 'job-total-elapsed', room_key: 'room-total-elapsed', room_revision: 1,
    created_at: '2026-08-21T00:00:03.000Z',
    event: {
      job_id: 'job-total-elapsed', room_key: 'room-total-elapsed', room_revision: 1,
      detected_at: detectedAt
    },
    local_context: {
      job: { jobId: 'job-total-elapsed', roomKey: 'room-total-elapsed', roomRevision: 1, detectedAt },
      turn_internal: { snapshot: {} }
    },
    result: { content: 'FINAL_JSON {}' }, tool_receipts: [], application: { state: 'pending' }
  };
  const channel = {
    async claimApplication() { return { claimed: true, application_id: 'application-total-elapsed', job: structuredClone(durableJob) }; },
    async beginApplication() {}, async recordApplicationApplied() {}, async finalizeApplication() {}, async failApplication() {},
    async listPendingApplicationFailureNotifications() { return []; }, async markApplicationFailureNotified() {}
  };
  const coordinator = createGatewayResultApplicationCoordinator({
    channel,
    getConfig: () => ({}),
    now: () => clock.shift(),
    prepare: async () => ({ status: 'ai_prepared', snapshot: {} }),
    apply: async ({ prepared }) => ({ prepared, autoReplyResult: { sent: false } }),
    finalize: async ({ applied }) => ({ ...applied.prepared, status: 'ai_completed' }),
    record: async (value) => { recorded = value; }
  });

  await coordinator.enqueue(durableJob);
  await coordinator.idle();
  assert.equal(recorded.elapsedMs, 125_000);
  assert.equal(recorded.localApplicationElapsedMs, 5_000);
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

test('room revisions continue after the durable Gateway revision when the bridge restarts', () => {
  const versions = new Map();
  const firstAfterRestart = registerAcceptedRoomEvent(
    versions,
    'chat:restarted',
    '김혜지 새 예약 요청',
    7
  );
  const duplicate = registerAcceptedRoomEvent(
    versions,
    'chat:restarted',
    '김혜지 새 예약 요청',
    7
  );
  const newer = registerAcceptedRoomEvent(
    versions,
    'chat:restarted',
    '김혜지 추가 메시지',
    7
  );

  assert.equal(firstAfterRestart.revision, 8);
  assert.equal(duplicate.revision, 8);
  assert.equal(duplicate.changed, false);
  assert.equal(newer.revision, 9);
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
  const revisionIndex = source.indexOf('const roomVersion = registerAcceptedRoomEvent(');
  const durableRevisionIndex = source.lastIndexOf('gatewayChannel.latestRoomRevision', revisionIndex);
  const supabaseIndex = source.indexOf("await writeSupabaseEvent(event, 'event')", revisionIndex);
  assert.ok(durableRevisionIndex >= 0 && durableRevisionIndex < revisionIndex, 'durable Gateway revision must seed the in-memory revision');
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
  assert.match(source, /documentExecutionConfigured:\s*Boolean\(/);
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
  assert.match(source, /hermesTransport:\s*resolveHermesTransport\(process\.env\.KAKAO_HERMES_TRANSPORT\)/);
  assert.match(source, /hermesBridgeToken:\s*String\(process\.env\.KAKAO_HERMES_BRIDGE_TOKEN\s*\|\|\s*''\)\.trim\(\)/);
  assert.match(source, /KAKAO_HERMES_LEASE_MS/);
  assert.match(source, /KAKAO_HERMES_MAX_ATTEMPTS/);
  assert.match(source, /createHermesGatewayHttpHandler/);
  assert.ok(source.indexOf('gatewayHttpHandler(req, res, url)') < source.indexOf("url.pathname === '/health'"));
});
