import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inquiryConversationKey,
  actionFamilyForFollowUp,
  businessObjectKeyForFollowUp,
  followUpTaskIdentity,
  customerClusterHash,
  renderedMessageHash
} from './follow-up-policy.mjs';

test('inquiry identity ignores price and payment type changes in one room', () => {
  const price = { room_key: 'chat:4979', customer_name: '윤영준', type: 'price_review' };
  const payment = { room_key: 'chat:4979', customer_name: '윤영준', type: 'payment_check' };
  assert.equal(inquiryConversationKey(price), inquiryConversationKey(payment));
});

test('inquiry identity keeps different rooms separate', () => {
  assert.notEqual(
    inquiryConversationKey({ room_key: 'chat:a', customer_name: '윤영준' }),
    inquiryConversationKey({ room_key: 'chat:b', customer_name: '윤영준' })
  );
});

test('type labels alone never create manual follow-up actions', () => {
  assert.equal(actionFamilyForFollowUp({ type: 'reply_needed' }), null);
  assert.equal(actionFamilyForFollowUp({ type: 'price_review' }), null);
  assert.equal(actionFamilyForFollowUp({ type: 'reservation_review' }), null);
  assert.equal(actionFamilyForFollowUp({ type: 'tax_invoice' }), null);
});

test('only explicit validated human actions become manual tasks', () => {
  assert.equal(actionFamilyForFollowUp({
    type: 'tax_invoice',
    payload: { requires_human_action: true, action_family: 'invoice_issue' }
  }), 'invoice_issue');
  assert.equal(actionFamilyForFollowUp({
    type: 'reservation_review',
    payload: { requires_human_action: false, action_family: 'reservation_change' }
  }), null);
});

test('business object prefers trade ID over divergent AI task keys', () => {
  const a = {
    summary: '거래 260729-001 현금영수증 요청',
    payload: { follow_up_task_key: 'cash-receipt:260729-001' }
  };
  const b = {
    recommended_action: '260729-001 금액 확인',
    payload: { follow_up_task_key: 'price:260729-001:vat' }
  };
  assert.equal(businessObjectKeyForFollowUp(a), 'trade:260729-001');
  assert.equal(businessObjectKeyForFollowUp(a), businessObjectKeyForFollowUp(b));
});

test('same action on same business object reuses one task identity', () => {
  const action = { requires_human_action: true, action_family: 'invoice_issue' };
  const a = { type: 'tax_invoice', summary: '260729-001 세금계산서 발행', payload: action };
  const b = { type: 'tax_invoice', evidence: ['거래ID 260729-001'], payload: action };
  assert.equal(followUpTaskIdentity(a, 'case-1'), followUpTaskIdentity(b, 'case-1'));
});

test('different actions on one transaction remain separate tasks', () => {
  const invoice = {
    type: 'tax_invoice',
    summary: '260729-001 세금계산서 발행',
    payload: { requires_human_action: true, action_family: 'invoice_issue' }
  };
  const reservation = {
    type: 'reservation_review',
    summary: '260729-001 예약 수정',
    payload: { requires_human_action: true, action_family: 'reservation_change' }
  };
  assert.notEqual(followUpTaskIdentity(invoice, 'case-1'), followUpTaskIdentity(reservation, 'case-1'));
});

test('customer and rendered hashes are deterministic and distinct', () => {
  assert.equal(customerClusterHash('새 메시지'), customerClusterHash('새 메시지'));
  assert.notEqual(customerClusterHash('새 메시지'), customerClusterHash('다른 메시지'));
  assert.equal(
    renderedMessageHash({ text: 'a', blocks: [{ type: 'section' }] }),
    renderedMessageHash({ text: 'a', blocks: [{ type: 'section' }] })
  );
});
