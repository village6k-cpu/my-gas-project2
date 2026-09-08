import test from 'node:test';
import assert from 'node:assert/strict';
Object.assign(process.env, {
  KAKAO_DOM_BRIDGE_NO_LISTEN: '1', WORK_ORCHESTRATOR_V2_RUNTIME_MODE: 'legacy',
  WORK_ORCHESTRATOR_V2_SHADOW_WRITES: '0', WORK_ORCHESTRATOR_V2_IMMEDIATE_ENABLED: '0',
  WORK_ORCHESTRATOR_V2_WORK_ITEMS_ENABLED: '0', WORK_ORCHESTRATOR_V2_DIGEST_ENABLED: '0',
  WORK_ORCHESTRATOR_V2_CLEANUP_ENABLED: '0', WORK_ORCHESTRATOR_V2_P0_READBACK_ENABLED: '0',
  WORK_ORCHESTRATOR_V2_P0_CUTOVER_ENABLED: '0', AI_WORKER_FOLLOW_UP_ITEMS_ENABLED: '1',
  KAKAO_FOLLOW_UP_ITEMS_ENABLED: '1', SLACK_AGENT_CARD_DELIVERY_ENABLED: '1',
  P0_SLACK_ESCALATION_ENABLED: '1', SLACK_ACTION_POLL_ENABLED: '1'
});
const { createGatewayResultApplicationCoordinator } = await import('./server.mjs');

test('Gateway persists the actual reply outcome before refusing a false completed result', async () => {
  for (const [name, replyResult, expectedState, fails] of [
    ['host-read-missing', { attempted: false, sent: false, gate: { reason: 'kill_switch_not_checked' } }, 'blocked', true],
    ['unverified-send', { attempted: true, sent: true }, 'delivery_uncertain', true],
    ['operator-paused', { attempted: false, sent: false, gate: { reason: 'kill_switch_paused' } }, 'paused', false],
    ['verified-send', { attempted: true, sent: true, readbackReceipt: {
      id: `reply-readback-${'a'.repeat(64)}`, confirmedAt: '2026-09-08T11:00:00.000Z'
    } }, 'delivered', false]
  ]) {
    const order = [];
    let audit;
    const job = {
      job_id: name, room_key: 'chat:completion-test', room_revision: 1,
      event: {}, local_context: { job: { jobId: name, roomKey: 'chat:completion-test', roomRevision: 1 }, turn_internal: { snapshot: {} } },
      result: { content: '{}' }, application: { state: 'pending' }
    };
    const prepared = { status: 'ai_prepared', snapshot: {}, decision: {
      reply_decision: { replyMode: 'auto_send', text: '등록된 시간에 방문하시면 됩니다.', shouldCreateTask: false }, follow_up_items: []
    } };
    const channel = {
      async claimApplication() { return { claimed: true, application_id: name, job: structuredClone(job) }; },
      async beginApplication() { order.push('begin'); },
      async recordApplicationApplied({ audit: value }) { audit = value; order.push('persist_effect_result'); },
      async finalizeApplication() { order.push('finalized'); },
      async failApplication({ error }) {
        assert.match(error.message, /gateway_reply_execution_unresolved/);
        order.push('failed'); return { ...job, application: { application_id: name, error } };
      },
      async listPendingApplicationFailureNotifications() { return []; },
      async markApplicationFailureNotified() { order.push('failure_recorded'); }
    };
    const coordinator = createGatewayResultApplicationCoordinator({
      channel, getConfig: () => ({}), prepare: async () => prepared,
      apply: async () => ({ prepared, autoReplyResult: replyResult }),
      // Even a stale finalizer that blindly claims completed cannot bypass the
      // application coordinator's own intent/effect reconciliation.
      finalize: async () => ({ ...prepared, status: 'ai_completed', autoReplyResult: replyResult }),
      onFailure: async () => order.push('surface_unresolved')
    });
    await coordinator.enqueue(job);
    await coordinator.idle();
    assert.equal(audit.reply_execution.state, expectedState, name);
    assert.equal(order.includes('failed'), fails, name);
    assert.equal(order.includes('finalized'), !fails, name);
    if (fails) assert.deepEqual(order, ['begin', 'persist_effect_result', 'failed', 'surface_unresolved', 'failure_recorded']);
  }
});
