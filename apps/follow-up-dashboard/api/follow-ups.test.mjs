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

test('dedupeFollowUpItems collapses repeated FAQ topic cards without amounts or dates', () => {
  const items = [
    { id: 'newer', follow_up_key: 'legacy-newer', customer_name: '최재형', type: 'price_review', status: 'open', title: '최재형님 학생 할인율 문의 답변 확인', summary: '고객이 위치 안내를 받은 뒤 학생 할인율이 몇 프로인지 문의했습니다.' },
    { id: 'older', follow_up_key: 'legacy-older', customer_name: '최재형', type: 'price_review', status: 'open', title: '학생할인 비율 문의 답변 필요', summary: '고객이 학생할인이 몇 프로인지 문의했습니다.' }
  ];

  assert.equal(buildDashboardSemanticKey(items[0]), buildDashboardSemanticKey(items[1]));
  assert.deepEqual(dedupeFollowUpItems(items).map((item) => item.id), ['newer']);
});

test('dedupeFollowUpItems collapses one operational update split across categories', () => {
  const items = [
    { id: 'reply', follow_up_key: 'reply', customer_name: '박재인', type: 'reply_needed', status: 'open', title: '반납 및 다음 회차 메모 확인 답장', summary: '고객의 반납 완료 및 다음 회차 일정 공유에 대해 짧은 확인 답장이 유용합니다.' },
    { id: 'battery', follow_up_key: 'battery', customer_name: '박재인', type: 'damage_repair', status: 'open', title: '경고 메시지 뜬 소니 배터리 확인 필요', summary: '고객이 애플박스 위에 둔 소니 배터리가 경고 메시지 발생 배터리라고 설명했습니다.' },
    { id: 'schedule', follow_up_key: 'schedule', customer_name: '박재인', type: 'schedule_check', status: 'open', title: '다음 회차 6/1-6/2 및 5/31 밤 픽업 메모 확인', summary: '고객이 다음 회차 일정과 픽업 예정 시간을 전달했습니다.' }
  ];

  assert.equal(buildDashboardSemanticKey(items[0]), buildDashboardSemanticKey(items[1]));
  assert.equal(buildDashboardSemanticKey(items[1]), buildDashboardSemanticKey(items[2]));
  assert.deepEqual(dedupeFollowUpItems(items).map((item) => item.id), ['reply']);
});

test('dedupeFollowUpItems normalizes customer aliases with issue suffixes', () => {
  const items = [
    { id: 'base', follow_up_key: 'base', customer_name: '한시우', type: 'damage_repair', status: 'open', title: '한시우 미반납/파손 관련 반납 예정 확인', summary: '고객이 미반납 물품을 확인 후 가져다 드리겠다고 답변함.' },
    { id: 'suffix', follow_up_key: 'suffix', customer_name: '한시우/60x 파손', type: 'damage_repair', status: 'open', title: '한시우 미반납/파손 관련 반납 확인 필요', summary: '고객이 미반납/확인 대상 물품을 확인 후 가져다 드리겠다고 답변함.' }
  ];

  assert.equal(buildDashboardSemanticKey(items[0]), buildDashboardSemanticKey(items[1]));
  assert.deepEqual(dedupeFollowUpItems(items).map((item) => item.id), ['base']);
});
