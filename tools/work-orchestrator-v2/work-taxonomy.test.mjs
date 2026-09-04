import assert from 'node:assert/strict';
import test from 'node:test';

let taxonomy = {};
try {
  taxonomy = await import('./work-taxonomy.mjs');
} catch (error) {
  if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}

const EXPECTED = [
  ['reservation_review', 'schedule', '예약·스케줄', '예약 확인'],
  ['schedule_check', 'schedule', '예약·스케줄', '스케줄 확인'],
  ['schedule_register', 'schedule', '예약·스케줄', '스케줄 등록'],
  ['schedule_change', 'schedule', '예약·스케줄', '스케줄 변경'],
  ['return_extension', 'schedule', '예약·스케줄', '반납·연장'],
  ['quote_send', 'quote', '견적·가격', '견적서 발송'],
  ['price_review', 'quote', '견적·가격', '가격·할인 확인'],
  ['payment_check', 'settlement', '정산·서류', '입금·결제 확인'],
  ['tax_invoice', 'settlement', '정산·서류', '세금계산서 발행'],
  ['contract_document', 'settlement', '정산·서류', '계약·서류 처리'],
  ['reply_needed', 'customer', '고객 응대', '고객 답변 필요'],
  ['human_review', 'operations', '운영·예외', '기타 사람 확인'],
  ['damage_repair', 'operations', '운영·예외', '파손·수리'],
  ['sheet_duplicate_check', 'operations', '운영·예외', '중복 확인']
];

test('every reviewed owner work type has exactly one business category and Korean label', () => {
  assert.equal(Array.isArray(taxonomy.OWNER_WORK_DEFINITIONS), true);
  assert.deepEqual(
    taxonomy.OWNER_WORK_DEFINITIONS.map((entry) => [entry.type, entry.category, entry.categoryLabel, entry.typeLabel]),
    EXPECTED
  );
  assert.equal(new Set(taxonomy.OWNER_WORK_DEFINITIONS.map(({ type }) => type)).size, EXPECTED.length);
  assert.deepEqual(taxonomy.OWNER_WORK_TYPES, EXPECTED.map(([type]) => type));
});

test('technical and unknown types cannot become owner-visible categories', () => {
  assert.equal(typeof taxonomy.describeOwnerWorkType, 'function');
  assert.equal(typeof taxonomy.isOwnerWorkType, 'function');
  for (const type of ['completed_log', 'reservation_review_timeout', 'automation_error_review', 'unknown']) {
    assert.equal(taxonomy.describeOwnerWorkType(type), null);
    assert.equal(taxonomy.isOwnerWorkType(type), false);
  }
});

test('taxonomy descriptions are copies and cannot mutate the shared contract', () => {
  assert.equal(typeof taxonomy.describeOwnerWorkType, 'function');
  const first = taxonomy.describeOwnerWorkType('schedule_check');
  first.category = 'operations';
  assert.deepEqual(taxonomy.describeOwnerWorkType('schedule_check'), {
    type: 'schedule_check',
    category: 'schedule',
    categoryLabel: '예약·스케줄',
    typeLabel: '스케줄 확인'
  });
});
