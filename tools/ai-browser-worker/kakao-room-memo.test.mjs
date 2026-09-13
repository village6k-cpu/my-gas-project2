import assert from 'node:assert/strict';
import vm from 'node:vm';
import test from 'node:test';
import { buildKakaoConversationTextExpression, createImmutableKakaoRoomSnapshot, isUsableKakaoConversationEvidence } from './worker.mjs';

function capture({ memo = '010-1234-5678', visible = true, listRow = false } = {}) {
  const tooltip = { textContent: memo };
  const button = {
    getBoundingClientRect: () => ({ width: visible ? 24 : 0, height: 24 }),
    ownerDocument: { defaultView: { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) } },
    closest: () => listRow ? {} : null,
    querySelector: () => tooltip,
  };
  const document = {
    title: '테스트 고객 - 빌리지',
    body: { innerText: '테스트 고객\n예약 부탁드립니다\n네 예약 잡아드리겠습니다' },
    querySelectorAll: (selector) => selector === 'button.btn_memo' ? [button] : [],
  };
  return vm.runInNewContext(buildKakaoConversationTextExpression(), {
    document, location: { href: 'https://business.kakao.com/space/1/channel/_test/chats/12345' },
  });
}

test('room memo omitted by innerText reaches the immutable AI evidence without becoming a message', () => {
  const dom = capture();
  assert.match(dom.text, /카카오 고객 메모/);
  assert.match(dom.text, /010-1234-5678/);
  assert.equal(dom.messages.length, 0);
  const snapshot = createImmutableKakaoRoomSnapshot({
    job: { jobId: 'memo-fixture', roomKey: 'chat:12345', roomRevision: 1 },
    navigationContext: { status: 'opened_target_chat', conversation_evidence: {
      title: dom.title, hint_matched: true, visible_static_text_tail: dom.text, messages: dom.messages,
    } },
  });
  assert.match(snapshot.navigation.conversation_evidence.visible_static_text_tail, /010-1234-5678/);
  assert.equal(snapshot.navigation.conversation_evidence.messages.length, 0);
});

test('hidden controls and chat-list rows cannot supply another room contact', () => {
  for (const options of [{ visible: false }, { listRow: true }]) {
    assert.doesNotMatch(capture(options).text, /010-1234-5678/);
  }
});

test('memo evidence is bounded independently of conversation messages', () => {
  const dom = capture({ memo: 'x'.repeat(5000) });
  assert.match(dom.text, /x{1000}/);
  assert.ok(dom.text.length < 1300);
  assert.equal(dom.messages.length, 0);
});

test('a contact memo alone does not prove the conversation finished loading', () => {
  const memoLine = capture().text.split('\n').at(-1);
  assert.equal(isUsableKakaoConversationEvidence({
    hint_matched: true, hints: ['테스트 고객'],
    visible_static_text_tail: ['채팅방 레이어', '테스트 고객', memoLine],
  }), false);
});
