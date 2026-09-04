export const OWNER_WORK_DEFINITIONS = Object.freeze([
  Object.freeze({ type: 'reservation_review', category: 'schedule', categoryLabel: '예약·스케줄', typeLabel: '예약 확인' }),
  Object.freeze({ type: 'schedule_check', category: 'schedule', categoryLabel: '예약·스케줄', typeLabel: '스케줄 확인' }),
  Object.freeze({ type: 'schedule_register', category: 'schedule', categoryLabel: '예약·스케줄', typeLabel: '스케줄 등록' }),
  Object.freeze({ type: 'schedule_change', category: 'schedule', categoryLabel: '예약·스케줄', typeLabel: '스케줄 변경' }),
  Object.freeze({ type: 'return_extension', category: 'schedule', categoryLabel: '예약·스케줄', typeLabel: '반납·연장' }),
  Object.freeze({ type: 'quote_send', category: 'quote', categoryLabel: '견적·가격', typeLabel: '견적서 발송' }),
  Object.freeze({ type: 'price_review', category: 'quote', categoryLabel: '견적·가격', typeLabel: '가격·할인 확인' }),
  Object.freeze({ type: 'payment_check', category: 'settlement', categoryLabel: '정산·서류', typeLabel: '입금·결제 확인' }),
  Object.freeze({ type: 'tax_invoice', category: 'settlement', categoryLabel: '정산·서류', typeLabel: '세금계산서 발행' }),
  Object.freeze({ type: 'contract_document', category: 'settlement', categoryLabel: '정산·서류', typeLabel: '계약·서류 처리' }),
  Object.freeze({ type: 'reply_needed', category: 'customer', categoryLabel: '고객 응대', typeLabel: '고객 답변 필요' }),
  Object.freeze({ type: 'human_review', category: 'operations', categoryLabel: '운영·예외', typeLabel: '기타 사람 확인' }),
  Object.freeze({ type: 'damage_repair', category: 'operations', categoryLabel: '운영·예외', typeLabel: '파손·수리' }),
  Object.freeze({ type: 'sheet_duplicate_check', category: 'operations', categoryLabel: '운영·예외', typeLabel: '중복 확인' })
]);

const DEFINITION_BY_TYPE = new Map(OWNER_WORK_DEFINITIONS.map((definition) => [definition.type, definition]));

export const OWNER_WORK_TYPES = Object.freeze(OWNER_WORK_DEFINITIONS.map(({ type }) => type));

export function describeOwnerWorkType(value) {
  const definition = typeof value === 'string' ? DEFINITION_BY_TYPE.get(value) : null;
  return definition ? { ...definition } : null;
}

export function isOwnerWorkType(value) {
  return typeof value === 'string' && DEFINITION_BY_TYPE.has(value);
}
