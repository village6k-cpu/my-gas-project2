import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { openKakaoTargetChatViaDevtools, createImmutableKakaoRoomSnapshot, buildKakaoGatewayTurn } from './worker.mjs';

const target = { type: 'page', id: 'chat', title: '테스트 고객 - 빌리지 - 카카오비즈니스 파트너센터',
  url: 'https://business.kakao.com/_test/chats/123456', webSocketDebuggerUrl: 'ws://chat' };
const job = { jobId: 'capture-test', roomKey: 'chat:123456', roomRevision: 1,
  customerName: '테스트 고객', messagePreview: '예약을 잡아드렸습니다', detectedAt: '2026-10-20T12:00:00.000Z' };
const dom = (messages, suffix = '') => ({ title: target.title, text: ['테스트 고객', ...messages, suffix].join('\n'),
  messages: messages.map((text, i) => ({ message_id: `m${i}`, role: 'unknown', order: i + 1, text })) });
const options = (evaluateImpl) => ({ cdpBaseUrl: 'http://localhost:9223',
  fetchImpl: async () => ({ ok: true, text: async () => JSON.stringify([target]) }), evaluateImpl,
  evidenceMaxAttempts: 2, evidencePollMs: 0, refreshStaleConversation: false, sleepImpl: async () => {} });

test('capture refuses a populated but stale room missing the triggering message', async () => {
  const result = await openKakaoTargetChatViaDevtools(job, options(async () => dom(['네 감사합니다'])));
  assert.equal(result.status, 'conversation_evidence_unavailable');
  assert.equal(result.conversation_evidence.capture_integrity.reason, 'trigger_message_missing');
});

test('capture waits for the trigger to appear rather than accepting the old populated DOM', async () => {
  let reads = 0;
  const result = await openKakaoTargetChatViaDevtools(job, options(async () =>
    ++reads === 1 ? dom(['네 감사합니다']) : dom(['네 감사합니다', job.messagePreview])));
  assert.equal(reads, 2);
  assert.equal(result.status, 'opened_target_chat');
});

test('a disconnected room is unusable even when the latest message is present', async () => {
  const result = await openKakaoTargetChatViaDevtools(job, options(async () =>
    dom([job.messagePreview], '연결 끊김\n대화가 불가능한 상태입니다')));
  assert.equal(result.status, 'conversation_evidence_unavailable');
});

test('list text cannot substitute for a missing structured message', async () => {
  const result = await openKakaoTargetChatViaDevtools(job, options(async () =>
    dom(['이전 메시지'], job.messagePreview)));
  assert.equal(result.status, 'conversation_evidence_unavailable');
});

test('fresh capture preserves multiline and truncated previews without business keyword classification', async () => {
  const result = await openKakaoTargetChatViaDevtools({ ...job, messagePreview: '일반 문의 내용…' },
    options(async () => dom(['일반 문의\n내용 뒤에 추가 문장이 있습니다'])));
  assert.equal(result.status, 'opened_target_chat');
});

test('media preview labels are not required to appear as text messages', async () => {
  const result = await openKakaoTargetChatViaDevtools({ ...job, messagePreview: '사진 2장' },
    options(async () => dom(['직전 대화', '사진 내용은 AI가 별도로 확인'])));
  assert.equal(result.status, 'opened_target_chat');
});

test('Gateway rejects stale immutable snapshots before any lookup or model dispatch', async () => {
  const snapshot = createImmutableKakaoRoomSnapshot({ job, navigationContext: {
    status: 'opened_target_chat', conversation_evidence: { hint_matched: true,
      hints: ['테스트 고객'], visible_static_text_tail: ['이전 메시지'], messages: dom(['이전 메시지']).messages }
  } });
  await assert.rejects(buildKakaoGatewayTurn({ job, capture: { snapshot }, dependencies: {
    buildReadOnlyLookupContext() { assert.fail('stale capture must not reach lookup'); }
  } }), error => error.code === 'kakao_conversation_evidence_unavailable');
});

test('one safe refresh recovers a stale existing room before model handoff', async () => {
  let refreshed = false, refreshes = 0;
  const result = await openKakaoTargetChatViaDevtools(job, { ...options(async () =>
    dom(refreshed ? [job.messagePreview] : ['이전 메시지'])), refreshStaleConversation: true,
    refreshImpl: async () => { refreshes++; refreshed = true; return { refreshed: true }; }
  });
  assert.equal(refreshes, 1);
  assert.equal(result.status, 'opened_target_chat');
});

test('failed safe refresh leaves capture unavailable without looping', async () => {
  let refreshes = 0;
  const result = await openKakaoTargetChatViaDevtools(job, { ...options(async () => dom(['이전 메시지'])),
    refreshStaleConversation: true,
    refreshImpl: async () => { refreshes++; return { refreshed: false, reason: 'unsent_draft' }; }
  });
  assert.equal(refreshes, 1);
  assert.equal(result.status, 'conversation_evidence_unavailable');
});

test('real refresh guard preserves unsent text and file attachments', async () => {
  for (const kind of ['text', 'file']) {
    let reloads = 0;
    const result = await openKakaoTargetChatViaDevtools(job, { ...options(async (_target, expression) => {
      if (!expression.includes('function refreshConversation')) return dom(['이전 메시지']);
      const element = { matches: selector => kind === 'file' ? selector === 'input[type="file"]' : selector.includes('textarea'),
        value: kind === 'text' ? '직원이 작성 중인 답장' : '', files: kind === 'file' ? [{}] : [] };
      return vm.runInNewContext(expression, { document: { querySelectorAll: () => [element] },
        location: { reload() { reloads++; } }, setTimeout: fn => fn() });
    }), refreshStaleConversation: true });
    assert.equal(reloads, 0);
    assert.equal(result.status, 'conversation_evidence_unavailable');
  }
});

test('real refresh guard reloads only once when there is no draft', async () => {
  let reloads = 0;
  const result = await openKakaoTargetChatViaDevtools(job, { ...options(async (_target, expression) => {
    if (!expression.includes('function refreshConversation')) return dom(reloads ? [job.messagePreview] : ['이전 메시지']);
    return vm.runInNewContext(expression, { document: { querySelectorAll: () => [] },
      location: { reload() { reloads++; } }, setTimeout: fn => fn() });
  }), refreshStaleConversation: true });
  assert.equal(reloads, 1);
  assert.equal(result.status, 'opened_target_chat');
});
