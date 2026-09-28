import assert from 'node:assert/strict';
import test from 'node:test';

import { inspectKakaoRoom } from '../scripts/windows/village-kakao-room-inspect.mjs';

test('room inspection uses one bounded navigation call and returns live evidence', async () => {
  const calls = [];
  const result = await inspectKakaoRoom({ customerName: '희정' }, {
    ensureList: async (options) => {
      calls.push(['ensure', options]);
      return { status: 'existing_list' };
    },
    openChat: async (job, options) => {
      calls.push(['open', job, options]);
      return {
        status: 'opened_target_chat',
        already_open: false,
        opened_by_devtools_search: true,
        target: { id: 'target-1', title: '희정', url: 'https://center-pf.kakao.com/chats/123' },
        conversation_evidence: {
          source: 'live_kakao_dom_after_navigation',
          hint_matched: true,
          title: '희정',
          visible_static_text_tail: '학생할인 30프로에 소개할인 5프로 적용해주세요',
          messages: [{ message_id: 'm1', role: 'customer', order: 1, text: '학생할인 30프로에 소개할인 5프로 적용해주세요' }]
        }
      };
    }
  });

  assert.deepEqual(calls, [
    ['ensure', { timeoutMs: 20_000 }],
    ['open', {
      customer_name: '희정',
      room_title: '',
      preview_text: '희정',
      payload: { customerName: '희정', roomTitle: '' }
    }, { timeoutMs: 30_000, allowSearch: true }]
  ]);
  assert.deepEqual(result, {
    ok: true,
    status: 'opened_target_chat',
    query: { customerName: '희정', roomTitle: '' },
    openedBySearch: true,
    alreadyOpen: false,
    target: { id: 'target-1', title: '희정', url: 'https://center-pf.kakao.com/chats/123' },
    evidence: {
      source: 'live_kakao_dom_after_navigation',
      hintMatched: true,
      title: '희정',
      visibleText: '학생할인 30프로에 소개할인 5프로 적용해주세요',
      messages: [{ messageId: 'm1', role: 'customer', order: 1, text: '학생할인 30프로에 소개할인 5프로 적용해주세요' }]
    }
  });
});

test('room inspection fails closed when live evidence does not match the customer', async () => {
  const result = await inspectKakaoRoom({ customerName: '희정' }, {
    ensureList: async () => ({ status: 'existing_list' }),
    openChat: async () => ({
      status: 'conversation_evidence_unavailable',
      conversation_evidence: { hint_matched: false, visible_static_text_tail: '다른 고객' }
    })
  });

  assert.deepEqual(result, {
    ok: false,
    status: 'conversation_evidence_unavailable',
    query: { customerName: '희정', roomTitle: '' },
    reason: 'live_kakao_room_not_verified'
  });
});
