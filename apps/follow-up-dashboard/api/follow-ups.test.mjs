import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDashboardSemanticKey, dedupeFollowUpItems, shouldHideLowValueActiveItem } from './follow-ups.js';

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

test('dedupeFollowUpItems collapses one reservation split by discount and operations anchors', () => {
  const items = [
    {
      id: 'newer',
      room_key: 'preview:hong',
      customer_name: '홍지수',
      type: 'reservation_review',
      status: 'open',
      priority: 'high',
      title: '홍지수님 6/6-6/7 브라노 풀세트 및 모비 문의 확인',
      summary: '고객이 6월 6-7일 브라노 풀세트 대여 가능 여부, 비학생 학생가 가능 여부, 모비 보유 여부를 문의함.',
      recommended_action: '기존 확인요청 건을 기준으로 재고 확인 및 가격 검토를 진행하세요.',
      evidence: ['학생가 문의', '모비 추가 문의']
    },
    {
      id: 'older',
      room_key: 'preview:hong',
      customer_name: '홍지수',
      type: 'reservation_review',
      status: 'open',
      priority: 'normal',
      title: '홍지수님 6/6-6/7 브라노 풀세트 + 모비 대여 가능 여부 및 학생가 문의',
      summary: '고객이 2026년 6월 6-7일 브라노 풀세트 대여 가능 여부와 비학생 학생가 적용 가능 여부를 문의했습니다.',
      recommended_action: '반출/반납 시간과 연락처를 요청하고 모비 보유 여부를 직원 확인 후 안내하세요.'
    }
  ];

  assert.equal(buildDashboardSemanticKey(items[0]), buildDashboardSemanticKey(items[1]));
  const deduped = dedupeFollowUpItems(items);
  assert.deepEqual(deduped.map((item) => item.id), ['newer']);
  assert.equal(deduped[0].priority, 'high');
});

test('dedupeFollowUpItems collapses one equipment availability topic across schedule and reply cards', () => {
  const items = [
    {
      id: 'schedule',
      room_key: 'preview:lee',
      customer_name: '이유찬',
      type: 'schedule_check',
      status: 'open',
      title: '인터컴 대여 가능 여부 배터리 상태 확인',
      summary: '고객이 인터콤 대여 가능 여부를 문의했고, 직원이 복귀 후 배터리 상태 확인이 필요하다고 답변한 상태입니다.'
    },
    {
      id: 'reply',
      room_key: 'preview:lee',
      customer_name: '이유찬',
      type: 'reply_needed',
      status: 'open',
      title: '인터콤 대여 가능 여부 문의 답변',
      summary: '고객이 인터콤도 대여 가능한지 문의했습니다.',
      suggested_reply_draft: '감독님, 인터콤 대여 가능 여부 확인해드리겠습니다.'
    }
  ];

  assert.equal(buildDashboardSemanticKey(items[0]), buildDashboardSemanticKey(items[1]));
  const deduped = dedupeFollowUpItems(items);
  assert.deepEqual(deduped.map((item) => item.id), ['schedule']);
  assert.equal(deduped[0].suggested_reply_draft, '감독님, 인터콤 대여 가능 여부 확인해드리겠습니다.');
});

test('dedupeFollowUpItems collapses one reservation split by payment document and operation wording', () => {
  const items = [
    {
      id: 'docs',
      room_key: 'preview:kim',
      customer_name: '김성윤',
      type: 'reservation_review',
      status: 'open',
      title: '김성윤 5/28 오전 7시 장비 예약 미등록 여부 확인',
      summary: '고객이 5/28 오전 7시 수령으로 장비 예약 가능 여부와 105,000원 금액을 문의했고 직원이 답변했습니다.',
      recommended_action: '확인요청/계약마스터에 이번 2026-05-28 건이 등록되어 있는지 검토하세요.'
    },
    {
      id: 'ops',
      room_key: 'preview:kim',
      customer_name: '김성윤',
      type: 'reservation_review',
      status: 'open',
      title: '김성윤 예약 가능 답변 완료 건 등록 여부 확인',
      summary: '고객이 5/28 오전 7시 수령 예약 가능 및 계좌이체 금액을 문의했고, 직원이 가능 및 105,000원을 답변했습니다.',
      recommended_action: '직원이 이미 답변했으므로 새 답장 초안은 만들지 않습니다.'
    }
  ];

  assert.equal(buildDashboardSemanticKey(items[0]), buildDashboardSemanticKey(items[1]));
  assert.deepEqual(dedupeFollowUpItems(items).map((item) => item.id), ['docs']);
});

test('shouldHideLowValueActiveItem hides thanks-only completed logs from the active queue', () => {
  assert.equal(shouldHideLowValueActiveItem({
    type: 'completed_log',
    priority: 'low',
    status: 'open',
    title: '김준기 고객 대여 완료 감사 메시지',
    summary: "고객이 '대표님 감사히 잘 썼습니다~!'라고 보냈습니다. 새 예약 요청이나 질문은 아닙니다.",
    recommended_action: '필요 시 감사 답장만 수동으로 보내면 됩니다.'
  }), true);

  assert.equal(shouldHideLowValueActiveItem({
    type: 'completed_log',
    priority: 'low',
    status: 'open',
    title: '입금 확인 필요',
    summary: '고객이 감사 인사와 함께 입금 확인을 요청했습니다.'
  }), false);
});

test('dedupeFollowUpItems collapses quote cards from the same Kakao room despite customer alias and secondary topic split', () => {
  const items = [
    {
      id: 'newer',
      room_key: 'preview:hyunha',
      customer_name: '현하',
      type: 'quote_send',
      status: 'open',
      title: '현하님 1200b 렌탈건 학교 제출용 견적서 요청',
      summary: '고객이 기존 5/22~5/23 Nanlux 1200b 렌탈건에 대해 학교 제출용 견적서를 요청했습니다.',
      recommended_action: '기존 예약/계약 내역에서 실제 대여 품목과 최종 금액을 확인한 뒤 학교 제출용 견적서를 발급해 전달하세요.'
    },
    {
      id: 'older',
      room_key: 'preview:hyunha',
      customer_name: '신현하',
      type: 'quote_send',
      status: 'open',
      title: '신현하님 1200B 렌탈 건 학교 제출용 견적서 요청',
      summary: '고객이 이미 진행된/등록된 NANLUX Evoke 1200B 렌탈 건에 대해 학교 제출용 견적서를 요청했습니다.',
      recommended_action: '계약마스터 거래ID 기준으로 견적서 발급 가능 여부와 금액을 확인한 뒤 견적서를 전달하세요. 가격/할인 최종 확정은 사람이 확인해야 합니다.'
    }
  ];

  assert.equal(buildDashboardSemanticKey(items[0]), buildDashboardSemanticKey(items[1]));
  assert.deepEqual(dedupeFollowUpItems(items).map((item) => item.id), ['newer']);
});
