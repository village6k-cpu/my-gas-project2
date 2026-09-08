import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { maybeAutoSendReply, finalizePreparedKakaoDecision } from './worker.mjs';

// Same decision shape as the registered pickup-time incident: the AI has an
// authoritative answer and asks to send it, but echoes not_checked for control.
function pickupDecision(observed = 'not_checked') {
  return {
    classification: 'faq', confidence: 'high', kill_switch_observed: observed,
    customer: { name: '픽업 문의 고객' }, follow_up_items: [],
    latest_customer_message_cluster: '11일 22시에 대여하러 가면 될까요?',
    reply_decision: {
      replyMode: 'auto_send', text: '네 11일 22시에 맞춰 오시면 됩니다', confidence: 'high',
      safetyClass: 'staff_confirmed_reservation_acceptance', grounding: 'authoritative_sheet',
      requiresRag: false, shouldCreateTask: false
    },
    safety_checks: {
      kakao_conversation_opened: true, did_not_classify_from_preview_only: true,
      latest_customer_message_after_last_staff_reply: true
    }
  };
}

function fixture(t, status) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'reply-execution-contract-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const calls = [];
  const config = {
    autoSendEnabled: true, autoSendLogPath: path.join(directory, 'reply.ndjson'),
    gasApiUrl: 'https://gas.example/exec', sheetApiKey: 'test-internal',
    fetchImpl: async url => {
      const query = new URL(url).searchParams;
      assert.equal(query.get('action'), 'read');
      assert.equal(query.get('sheet'), '설정');
      assert.equal(query.get('range'), 'A1');
      calls.push('read_current_operator_control');
      if (status instanceof Error) throw status;
      return { ok: true, text: async () => JSON.stringify({ data: [[status]] }) };
    }
  };
  const job = {
    jobId: 'pickup-reply', sourceEventKey: 'pickup-reply', roomKey: 'chat:pickup',
    previewText: '픽업 문의', unread_count: 1,
    events: [{ reason: 'top_rows_backstop', unread_count: 1 }]
  };
  const dependencies = {
    assertFreshBeforeSend: async () => calls.push('freshness'),
    sendKakaoMessage: async text => {
      calls.push('send');
      return { sent: true, readback_confirmed: true, observed_reply_hash: createHash('sha256').update(text).digest('hex') };
    }
  };
  return { config, job, dependencies, calls, navigationContext: {} };
}

test('reply execution uses current host control instead of the model echo', async t => {
  for (const observed of ['not_checked', 'paused', '', 'active']) {
    const f = fixture(t, 'active');
    const decision = pickupDecision(observed);
    const result = await maybeAutoSendReply({ ...f, decision });
    assert.equal(result.sent, true, observed);
    assert.ok(result.readbackReceipt);
    assert.equal(decision.kill_switch_observed, observed, 'retain the original model audit');
    assert.deepEqual(f.calls, ['read_current_operator_control', 'freshness', 'send']);
  }
});

test('reply execution cannot use model active to bypass paused or unreadable host control', async t => {
  for (const [status, reason] of [
    ['paused', 'kill_switch_paused'], ['', 'kill_switch_not_checked'],
    ['invalid', 'kill_switch_not_checked'], [new Error('unavailable'), 'kill_switch_read_failed']
  ]) {
    const f = fixture(t, status);
    const result = await maybeAutoSendReply({ ...f, decision: pickupDecision('active') });
    assert.equal(result.sent, false);
    assert.equal(result.gate.reason, reason);
    assert.deepEqual(f.calls, ['read_current_operator_control']);
  }
});

test('reply execution permits pickup guidance under price pause but does not execute price guidance', async t => {
  const f = fixture(t, 'price_paused');
  assert.equal((await maybeAutoSendReply({ ...f, decision: pickupDecision() })).sent, true);
  const p = fixture(t, 'price_paused');
  const decision = pickupDecision('active');
  decision.classification = 'price';
  assert.equal((await maybeAutoSendReply({ ...p, decision })).gate.reason, 'kill_switch_price_paused');
  assert.equal(p.calls.includes('send'), false);
});

test('document delivery uses the same current operator control as text replies', async t => {
  for (const status of ['active', 'paused']) {
    const f = fixture(t, status);
    const asset = path.join(path.dirname(f.config.autoSendLogPath), 'document.txt');
    fs.writeFileSync(asset, 'test document');
    f.config.customerDocumentAssetPaths = [asset];
    const decision = pickupDecision();
    Object.assign(decision.reply_decision, {
      text: '요청하신 서류를 전달드립니다.', safetyClass: 'document_handoff',
      grounding: 'visible_conversation', attachmentKeys: ['village_bankbook_copy'], alreadyDelivered: false
    });
    const result = await maybeAutoSendReply({ ...f, decision });
    assert.equal(result.sent, status === 'active');
    assert.equal(f.calls[0], 'read_current_operator_control');
  }
});

test('operator lookup cannot hide a newer room revision or cause a duplicate send', async t => {
  const stale = fixture(t, 'active');
  stale.dependencies.assertFreshBeforeSend = async () => { throw new Error('superseded_by_newer_room_event'); };
  await assert.rejects(maybeAutoSendReply({ ...stale, decision: pickupDecision() }), /superseded_by_newer_room_event/);
  assert.equal(stale.calls.includes('send'), false);
  const live = fixture(t, 'active');
  const decision = pickupDecision();
  await maybeAutoSendReply({ ...live, decision });
  const again = await maybeAutoSendReply({ ...live, decision });
  assert.equal(again.sent, false);
  assert.equal(again.gate.reason, 'duplicate_recent_auto_reply');
  assert.equal(live.calls.filter(x => x === 'send').length, 1);
});

test('finalization does not call an unexecuted AI reply complete when the model requested zero tasks', async () => {
  const decision = pickupDecision();
  const result = await finalizePreparedKakaoDecision({
    config: { followUpRowsEnabled: false, workOrchestratorV2WorkItemsEnabled: false },
    job: { jobId: 'pickup-reply', roomKey: 'chat:pickup' },
    applied: {
      prepared: { status: 'ai_prepared', snapshot: {}, decision, availabilityAwareRows: [] },
      autoReplyResult: { attempted: false, sent: false, gate: { allowed: false, reason: 'kill_switch_not_checked' } }
    }
  });
  assert.equal(result.status, 'ai_reply_unresolved');
  assert.deepEqual(result.replyExecutionOutcome, { requested: true, state: 'blocked', reason: 'kill_switch_not_checked' });
  assert.equal(result.followUpResult.inserted, 0);
  assert.deepEqual(result.decision.follow_up_items, [], 'preserve the AI business-task decision');
});
