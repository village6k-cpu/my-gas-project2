import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDashboardSemanticKey,
  dedupeFollowUpItems,
  duplicateFollowUpIdsForItem,
  shouldHideLowValueActiveItem
} from './follow-ups.js';

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

test('dedupeFollowUpItems collapses quote cards with unstable preview room keys when amount anchors match', () => {
  const items = [
    {
      id: 'newer',
      room_key: 'preview:d5b8b726c6578bef',
      customer_name: '박정민',
      type: 'quote_send',
      status: 'open',
      title: '박정민 견적서 발송 확인',
      summary: "직원이 136,800원 안내 후 '견적서는 들어가서 보내줄게'라고 말한 상태입니다."
    },
    {
      id: 'older',
      room_key: 'preview:c5bb9c1fb31c4ef3',
      customer_name: '박정민',
      type: 'quote_send',
      status: 'open',
      title: '박정민님 견적서 발송 여부 확인',
      summary: '직원이 136,800원이라고 안내하면서 밖이라 견적서는 들어가서 보내겠다고 말했습니다.'
    }
  ];

  assert.notEqual(buildDashboardSemanticKey(items[0]), buildDashboardSemanticKey(items[1]));
  assert.deepEqual(dedupeFollowUpItems(items).map((item) => item.id), ['newer']);
});

test('dedupeFollowUpItems collapses reservation cards with unstable preview room keys when date anchors match', () => {
  const items = [
    {
      id: 'newer',
      room_key: 'preview:d5b8b726c6578bef',
      customer_name: '박정민',
      type: 'reservation_review',
      status: 'open',
      title: '박정민 예약 확인요청 등록 검토',
      summary: '600C 2개, 포그 머신, 바텐 추가 요청. 2026-05-31 12:30부터 2026-06-01 12:30까지.'
    },
    {
      id: 'older',
      room_key: 'preview:c5bb9c1fb31c4ef3',
      customer_name: '박정민',
      type: 'reservation_review',
      status: 'open',
      title: '박정민 5/31~6/1 기존 예약에 바텐 추가 요청 확인',
      summary: '고객이 기존 5/31 12:30~6/1 12:30 예약에 바텐을 추가하겠다고 했습니다.'
    }
  ];

  assert.notEqual(buildDashboardSemanticKey(items[0]), buildDashboardSemanticKey(items[1]));
  assert.deepEqual(dedupeFollowUpItems(items).map((item) => item.id), ['newer']);
});

test('dedupeFollowUpItems collapses return extension operation cards with unstable preview room keys', () => {
  const items = [
    {
      id: 'newer',
      room_key: 'preview:kim-new',
      customer_name: '김기환',
      type: 'return_extension',
      status: 'open',
      title: '김기환 반납일 변경 및 SDI/2구 차저 추가 대여 내역 확인',
      summary: '기존 계약에서 고객이 반납일을 6/1 14:00로 변경 가능한지 문의했고, 이후 SDI 2개와 2구 차저를 대여했다고 전달했습니다.'
    },
    {
      id: 'older',
      room_key: 'preview:kim-old',
      customer_name: '김기환',
      type: 'completed_log',
      status: 'open',
      title: '김기환 기존 예약 건 추가 대여/반납연장 확인 필요',
      summary: '고객이 SDI 2개와 2구 차저를 대여했다고 알리고 6/1 14:00 반납 연장 가능 여부도 확인 대기 상태입니다.'
    }
  ];

  assert.equal(buildDashboardSemanticKey(items[0]), buildDashboardSemanticKey(items[1]));
  assert.deepEqual(dedupeFollowUpItems(items).map((item) => item.id), ['newer']);
});

test('dedupeFollowUpItems collapses damage or missing-equipment cards across schedule and reply types', () => {
  const items = [
    {
      id: 'schedule',
      room_key: 'preview:lens',
      customer_name: '김진호',
      type: 'schedule_check',
      status: 'open',
      title: '김진호 FX3 24-70 변경/렌즈 누락 현장 확인',
      summary: '고객이 기존 6/1 02:00~6/2 02:00 예약에서 24-70 GM 렌즈가 없다고 문의했습니다.'
    },
    {
      id: 'reply',
      room_key: 'preview:lens',
      customer_name: '김진호',
      type: 'reply_needed',
      status: 'open',
      title: '김진호 FX3 24-70 변경/렌즈 누락 확인 필요',
      summary: '고객이 기존 6/1 02:00~6/2 02:00 예약 건에서 렌즈가 없다고 문의했습니다.'
    }
  ];

  assert.equal(buildDashboardSemanticKey(items[0]), buildDashboardSemanticKey(items[1]));
  assert.deepEqual(dedupeFollowUpItems(items).map((item) => item.id), ['schedule']);
});

test('dedupeFollowUpItems treats sheet duplicate checks as the same reservation task when dates match', () => {
  const items = [
    {
      id: 'duplicate',
      room_key: 'preview:moon',
      customer_name: '문시후',
      type: 'sheet_duplicate_check',
      status: 'open',
      title: '문시후 예약 기존 RQ 중복 확인 및 24-70 GM 누락 여부 확인',
      summary: '5/31 22:00 - 6/1 22:00, 소니 FX3 바디세트 + 24-70 GM 렌즈 예약 건입니다.'
    },
    {
      id: 'reservation',
      room_key: 'preview:moon',
      customer_name: '문시후',
      type: 'reservation_review',
      status: 'open',
      title: '문시후 예약 확인요청 입력 필요',
      summary: '고객이 FX3 바디세트와 24-70 GM 렌즈를 5/31 22:00부터 6/1 22:00까지 예약 요청했습니다.'
    }
  ];

  assert.equal(buildDashboardSemanticKey(items[0]), buildDashboardSemanticKey(items[1]));
  assert.deepEqual(dedupeFollowUpItems(items).map((item) => item.id), ['duplicate']);
});

test('dedupeFollowUpItems folds low-information Kakao read errors into the concrete customer task', () => {
  const items = [
    {
      id: 'diagnostic',
      customer_name: '안재도',
      type: 'reply_needed',
      status: 'open',
      priority: 'normal',
      title: '안재도 카카오 대화 내용 확인 필요',
      summary: '대상 채팅방 제목은 확인됐지만 실제 대화 말풍선 텍스트가 읽히지 않아 최신 고객 메시지와 직원 답변 여부를 판별하지 못했습니다.',
      evidence: ['AX capture exposed chat status button but did not expose readable chat bubble text']
    },
    {
      id: 'concrete',
      customer_name: '안재도',
      type: 'reservation_review',
      status: 'open',
      priority: 'high',
      title: '안재도 DJI 마이크 기존 예약 날짜변경 요청 확인',
      summary: '고객이 기존 5월28일 DJI 마이크 렌탈건을 6월4일 09:00~6월6일 09:00로 변경 가능한지 문의했습니다.'
    }
  ];

  const deduped = dedupeFollowUpItems(items);
  assert.deepEqual(deduped.map((item) => item.id), ['concrete']);
  assert.equal(deduped[0].priority, 'high');
  assert.deepEqual(deduped[0].evidence, ['AX capture exposed chat status button but did not expose readable chat bubble text']);
});

test('dedupeFollowUpItems collapses quote and document cards for the same payment-document request', () => {
  const items = [
    {
      id: 'document',
      room_key: 'preview:doc-a',
      customer_name: '박정병',
      type: 'contract_document',
      status: 'open',
      title: '박정병 견적서/세금계산서 요청 최신 메시지 화면 확인 필요',
      summary: '고객이 26일 장비 반출내역 견적서, 세금계산서 부탁 메시지를 보냈는지 화면 확인이 필요합니다.'
    },
    {
      id: 'quote',
      room_key: 'preview:doc-b',
      customer_name: '박정병',
      type: 'quote_send',
      status: 'open',
      title: '박정병 견적서 요청',
      summary: '고객이 반납 완료를 알린 뒤 견적서 전달을 요청했습니다.'
    }
  ];

  assert.notEqual(buildDashboardSemanticKey(items[0]), buildDashboardSemanticKey(items[1]));
  assert.deepEqual(dedupeFollowUpItems(items).map((item) => item.id), ['quote']);
});

test('dedupeFollowUpItems collapses repeated low-information diagnostics for one customer', () => {
  const items = [
    {
      id: 'mismatch',
      customer_name: '김태완',
      type: 'reservation_review',
      status: 'open',
      priority: 'normal',
      title: '대상 카카오 대화 불일치로 AI 처리 보류',
      summary: '작업 대상 preview_text와 현재 열린 대화가 일치하지 않아 자동 분류/시트 입력을 중단했습니다.'
    },
    {
      id: 'manual',
      customer_name: '김태완',
      type: 'reservation_review',
      status: 'open',
      priority: 'high',
      title: '김태완 예약 문의 대화 확인 필요',
      summary: '실제 카카오 채팅방 메시지 본문을 읽지 못해 AI-first 기준상 시트 입력 판단을 보류합니다.'
    }
  ];

  const deduped = dedupeFollowUpItems(items);
  assert.deepEqual(deduped.map((item) => item.id), ['mismatch']);
  assert.equal(deduped[0].priority, 'high');
});

test('duplicateFollowUpIdsForItem includes alternate-key duplicates and hidden diagnostics', () => {
  const concrete = {
    id: 'concrete',
    customer_name: '안재도',
    type: 'reservation_review',
    status: 'open',
    title: '안재도 DJI 마이크 기존 예약 날짜변경 요청 확인',
    summary: '고객이 기존 5월28일 DJI 마이크 렌탈건을 6월4일 09:00~6월6일 09:00로 변경 가능한지 문의했습니다.'
  };
  const diagnostic = {
    id: 'diagnostic',
    customer_name: '안재도',
    type: 'reply_needed',
    status: 'open',
    title: '안재도 카카오 대화 내용 확인 필요',
    summary: '실제 대화 말풍선 텍스트가 읽히지 않아 최신 고객 메시지와 직원 답변 여부를 판별하지 못했습니다.'
  };
  const other = {
    id: 'other',
    customer_name: '박정민',
    type: 'reservation_review',
    status: 'open',
    title: '박정민 예약 확인',
    summary: '다른 고객의 예약 확인입니다.'
  };

  assert.deepEqual(duplicateFollowUpIdsForItem(concrete, [diagnostic, other, concrete]), ['diagnostic', 'concrete']);
});

test('duplicateFollowUpIdsForItem uses payment-document alternate keys for status updates', () => {
  const document = {
    id: 'document',
    room_key: 'preview:doc-a',
    customer_name: '박정병',
    type: 'contract_document',
    status: 'open',
    title: '박정병 견적서/세금계산서 요청 최신 메시지 화면 확인 필요',
    summary: '고객이 26일 장비 반출내역 견적서, 세금계산서 부탁 메시지를 보냈는지 화면 확인이 필요합니다.'
  };
  const quote = {
    id: 'quote',
    room_key: 'preview:doc-b',
    customer_name: '박정병',
    type: 'quote_send',
    status: 'open',
    title: '박정병 견적서 요청',
    summary: '고객이 반납 완료를 알린 뒤 견적서 전달을 요청했습니다.'
  };

  assert.deepEqual(duplicateFollowUpIdsForItem(quote, [document, quote]), ['document', 'quote']);
});

test('shouldHideLowValueActiveItem hides simple return-complete logs but keeps recordable handoff notes', () => {
  assert.equal(shouldHideLowValueActiveItem({
    type: 'completed_log',
    priority: 'normal',
    status: 'open',
    title: '김형석 고객 반납 완료 알림',
    summary: '고객이 BMPCC 6K 풀세트 대여 건으로 보이는 장비 반납 완료를 알렸습니다.',
    recommended_action: '실제 반납/검수 상태는 내부 운영 절차에 따라 확인하고, 필요하면 간단히 수신 확인 답장을 보내면 됩니다.'
  }), true);

  assert.equal(shouldHideLowValueActiveItem({
    type: 'completed_log',
    priority: 'normal',
    status: 'open',
    title: '고창현 반출/현장반납 변경사항 기록 필요',
    summary: '고객이 현장 반납 품목과 특이사항을 전달했습니다.',
    recommended_action: '기존 예약/계약 건의 반출·반납 메모에 현장 반납 품목과 특이사항을 기록하세요.'
  }), false);
});
