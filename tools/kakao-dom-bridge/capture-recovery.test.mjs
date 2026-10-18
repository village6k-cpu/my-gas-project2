import test from 'node:test';
import assert from 'node:assert/strict';
process.env.KAKAO_DOM_BRIDGE_NO_LISTEN = '1';
const { routeWorkerFailureFollowUp, assertGatewayFailureNotificationDelivered, createAiJobDispatcher, compactQueueAuditRecord } = await import('./server.mjs');
const api = await import('./server.mjs');

test('capture retry lookup cannot age out unfinished jobs or replay unmarked historical failures', () => {
  assert.equal(typeof api.buildCaptureRecoveryQuery, 'function');
  const query = api.buildCaptureRecoveryQuery('https://example.invalid/rest/v1/ai_processing_events', 24).searchParams;
  assert.equal(query.has('created_at'), false);
  assert.equal(query.get('payload->capture_retry->>state'), 'eq.pending');
  assert.equal(query.get('payload->capture_retry->>version'), 'eq.1');
  assert.equal(query.get('order'), 'updated_at.asc');
});

test('proven pre-enqueue capture failures remain retryable beyond the old attempt cap', () => {
  const error = Object.assign(Error('body unavailable'), { code: 'kakao_conversation_evidence_unavailable',
    captureDiagnostic: { stage: 'before_gateway_enqueue' } });
  for (const recoveryAttempts of [0, 1, 2, 10]) {
    const policy = api.gatewayDispatchFailurePolicy(error, { recoveryAttempts });
    assert.equal(policy.retryable, true);
    assert.equal(policy.status, 'ai_worker_error');
    if (recoveryAttempts > 0) assert.equal(policy.notifyHuman, true, 'escalation must not cancel automatic recovery');
  }
});

test('capture retry survives restart and old age, but respects backoff and excludes uncertain execution', () => {
  assert.equal(typeof api.shouldRecoverSupabaseRow, 'function');
  const now = Date.now();
  const row = { status: 'ai_worker_error', created_at: '2026-08-01T00:00:00Z', updated_at: new Date(now - 3600000).toISOString(),
    payload: { capture_retry: { version: 1, stage: 'before_gateway_enqueue', state: 'pending', next_attempt_at: new Date(now - 1000).toISOString() },
      bridge_recovery: { attempts: 10 } } };
  assert.equal(api.shouldRecoverSupabaseRow(JSON.parse(JSON.stringify(row))), true);
  const waiting = structuredClone(row); waiting.payload.capture_retry.next_attempt_at = new Date(now + 60000).toISOString();
  assert.equal(api.shouldRecoverSupabaseRow(waiting), false);
  const uncertain = structuredClone(row); uncertain.payload.gateway_dispatch = { queued_at: '2026-10-18T00:00:00Z' };
  assert.equal(api.shouldRecoverSupabaseRow(uncertain), false);
  const historical = structuredClone(row); delete historical.payload.capture_retry;
  assert.equal(api.shouldRecoverSupabaseRow(historical), false);
});

test('a captured job already durably enqueued is returned without re-reading or executing it', async () => {
  const job = { jobId: 'dom-existing', roomKey: 'chat:123', roomRevision: 1 };
  const dispatch = createAiJobDispatcher({ transport: 'gateway',
    channel: { async get(id) { assert.equal(id, job.jobId); return { job_id: id, room_key: job.roomKey, room_revision: 1, state: 'completed' }; },
      enqueue() { assert.fail('must not enqueue completed job'); } },
    capture: async () => assert.fail('completed job must not be recaptured'),
    buildTurn: async () => assert.fail('completed job must not be reinterpreted'), runLegacy() {} });
  const result = await dispatch(job);
  assert.equal(result.state, 'completed'); assert.equal(result.queued, false);
});

test('pre-enqueue capture failure preserves bounded navigation diagnostics without retaining conversation text', async () => {
  const dispatch = createAiJobDispatcher({ transport: 'gateway',
    channel: { enqueue() { assert.fail('unreadable evidence must not reach execution'); } },
    capture: async () => ({ snapshot: { navigation: { status: 'conversation_evidence_unavailable',
      evidence_attempts: 40, conversation_evidence: { hint_matched: false, messages: [], visible_static_text_tail: 'private message' } } } }),
    buildTurn: async () => { throw Object.assign(Error('missing body'), { code: 'kakao_conversation_evidence_unavailable' }); },
    runLegacy: async () => assert.fail('no legacy replay')
  });
  await assert.rejects(dispatch({ jobId: 'dom-capture', roomKey: 'chat:123' }), error => {
    assert.equal(error.captureDiagnostic.navigationStatus, 'conversation_evidence_unavailable');
    assert.equal(error.captureDiagnostic.hintMatched, false);
    assert.equal(error.captureDiagnostic.evidenceAttempts, 40);
    const audit = compactQueueAuditRecord('errors.ndjson', { type: 'gateway_dispatch', job: {jobId:'dom-capture'}, captureDiagnostic: error.captureDiagnostic });
    assert.equal(audit.jobId, 'dom-capture');
    assert.equal(audit.captureDiagnostic.evidenceAttempts, 40);
    assert.doesNotMatch(JSON.stringify(audit), /private message/);
    return true;
  });
});

test('unreadable customer conversation creates a durable reconciliation case after legacy cutover', async () => {
  const error = Object.assign(new Error('private browser diagnostic'), { code: 'kakao_conversation_evidence_unavailable' });
  const stored = [];
  const result = await routeWorkerFailureFollowUp({
    job: { jobId: 'capture-job', eventHash: 'capture-job', roomKey: 'chat:123', customerName: '테스트 고객', previewText: 'private preview' },
    error, workItemsEnabled: true, legacyEnabled: false,
    workStore: { async upsertWorkItem(candidate) {
      stored.push(candidate);
      return { applied: true, row: { id: 'case-1', ...candidate } };
    } },
    now: '2026-10-18T00:00:00.000Z'
  });
  assert.equal(stored.length, 1);
  assert.equal(stored[0].work_type, 'human_review');
  assert.equal(stored[0].priority, 'p0');
  assert.equal(stored[0].room_key, 'chat:123');
  assert.ok(stored[0].source_event_keys.includes('capture-job'));
  assert.match(stored[0].summary, /누락/);
  assert.doesNotMatch(JSON.stringify(stored), /private preview|private browser diagnostic/);
  assert.equal(result.workOrchestratorV2.row.id, 'case-1');
  assert.doesNotThrow(() => assertGatewayFailureNotificationDelivered(result));
});

test('empty follow-up routing is not proof of a human handoff', () => {
  assert.throws(() => assertGatewayFailureNotificationDelivered({ skipped: false, rows: [], inserted: 0,
    workOrchestratorV2: { skipped: true, reason: 'operational_only' } }), /not_delivered/);
});

test('failed reconciliation persistence must stay a failure instead of claiming handoff', async () => {
  await assert.rejects(routeWorkerFailureFollowUp({
    job: { jobId: 'capture-job', eventHash: 'capture-job', roomKey: 'chat:123' },
    error: Object.assign(new Error('unavailable'), { code: 'kakao_conversation_evidence_unavailable' }),
    workItemsEnabled: true, workStore: { async upsertWorkItem() { return { applied: false }; } }
  }), /not.*applied/);
});
