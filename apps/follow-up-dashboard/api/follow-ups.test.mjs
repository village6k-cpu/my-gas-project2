import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDashboardSemanticKey, dedupeFollowUpItems } from './follow-ups.js';

test('dedupeFollowUpItems collapses repeated legacy cards for the same customer task', () => {
  const items = [
    {
      id: 'newer',
      follow_up_key: 'dom-second:0:legacy-hash',
      customer_name: '정시온',
      type: 'contract_document',
      status: 'open',
      title: '정시온 37만원 결제 서류 전달 요청',
      summary: '고객이 전화로 안내받았던 37만원 결제 관련 서류를 요청했습니다. 이전 대화상 계약서 PDF 맥락이 있습니다.',
      recommended_action: '기존 260502-004 정시온 계약/견적/결제 내역을 확인한 뒤 고객에게 필요한 결제 서류 또는 정산서를 전달하세요.',
      evidence: ['37만원 결제 관련 서류 요청']
    },
    {
      id: 'older',
      follow_up_key: 'dom-first:0:other-legacy-hash',
      customer_name: '정시온',
      type: 'contract_document',
      status: 'open',
      title: '정시온 고객 37만원 결제 서류 준비',
      summary: '고객이 오늘 37만원 결제 관련 서류 수령 가능 여부를 문의했습니다.',
      recommended_action: '부가세 포함 37만원 기준으로 필요한 결제/계약/정산 서류를 준비해 전달하세요.',
      evidence: ['37만원 결제 관련 서류 문의']
    }
  ];

  assert.equal(buildDashboardSemanticKey(items[0]), buildDashboardSemanticKey(items[1]));
  assert.deepEqual(dedupeFollowUpItems(items).map((item) => item.id), ['newer']);
});

test('dedupeFollowUpItems does not merge unrelated exact-key tasks without concrete anchors', () => {
  const items = [
    { id: 'a', follow_up_key: 'legacy-a', customer_name: '홍길동', type: 'reply_needed', status: 'open', title: '답변 필요', summary: '확인 요청' },
    { id: 'b', follow_up_key: 'legacy-b', customer_name: '홍길동', type: 'reply_needed', status: 'open', title: '답변 필요', summary: '확인 요청' }
  ];

  assert.deepEqual(dedupeFollowUpItems(items).map((item) => item.id), ['a', 'b']);
});
