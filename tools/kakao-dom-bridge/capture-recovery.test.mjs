import test from 'node:test';
import assert from 'node:assert/strict';
process.env.KAKAO_DOM_BRIDGE_NO_LISTEN = '1';
const { routeWorkerFailureFollowUp, assertGatewayFailureNotificationDelivered, createAiJobDispatcher, compactQueueAuditRecord } = await import('./server.mjs');

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
