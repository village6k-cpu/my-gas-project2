import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHermesPrompt, currentConfirmedPolicyAutoReplySupport, evaluateAutoReplyRagSupport } from './worker.mjs';

const reply = '단순 계좌이체 시에는 VAT를 별도로 추가 청구하지 않습니다. 세금계산서 또는 현금영수증 발행 시에는 VAT 10%가 추가됩니다.';

for (const question of [
  '계좌이체시에도 vat 붙나요?',
  '계좌 이체로 해도 부가세 있나요?',
  '무통장 입금도 부가가치세 내나요?',
  '현금영수증 발행하면 부가세가 추가돼요?',
  '세금 계산서 받으면 VAT 별도인가요?',
  '부가세는 계좌이체도 동일한가요?',
]) {
  test(`payment VAT FAQ is authoritative without RAG: ${question}`, async () => {
    const decision = { classification: 'faq', latest_customer_message_cluster: question,
      reply_decision: { safetyClass: 'current_policy_answer', grounding: 'current_confirmed_policy', requiresRag: false } };
    const result = await evaluateAutoReplyRagSupport({ decision, replyText: reply,
      askImpl: async () => { throw new Error('confirmed payment FAQ must not query RAG'); } });
    assert.equal(result.allowed, true);
    assert.ok(result.currentPolicy.topics.includes('bank_transfer_vat_collection_faq'));
    assert.equal(currentConfirmedPolicyAutoReplySupport(decision, '계좌이체도 무조건 VAT 10%가 붙습니다.').allowed, false);
  });
}

test('payment VAT FAQ rejects omitted conditions, tax-exempt claims and unsolicited amount changes', () => {
  for (const response of [
    '계좌이체는 VAT가 없습니다.',
    '계좌이체는 면세입니다.',
    '현금영수증을 발행해도 VAT 추가는 없습니다.',
    reply + ' 기존 견적은 10% 빼고 입금해주세요.',
    reply + ' 세금계산서 발행 완료했습니다.',
  ]) {
    assert.equal(currentConfirmedPolicyAutoReplySupport({ latest_customer_message_cluster: '계좌이체에도 VAT 붙나요?' }, response).allowed, false);
  }
});

test('worker prompt includes the immediate FAQ instruction and preserves separate invoice authority', () => {
  const prompt = buildHermesPrompt({ job_id: 'payment-policy-test' }, { gatewayConfirmationToolAvailable: true });
  assert.ok(prompt.includes(reply));
  assert.ok(prompt.includes('대표 재확인이나 RAG 조회 없이 classification=faq, replyMode=auto_send'));
  assert.ok(prompt.includes('원장·수납·증빙 상태를 바꾸지 않는다'));
  assert.ok(prompt.includes('면세라는 뜻으로 설명하지 않는다'));
});

test('unrelated payment actions do not become confirmed FAQ permission', () => {
  for (const [question, response] of [
    ['계좌번호 알려주세요', '계좌번호는 123입니다.'],
    ['입금했는데 확인됐나요?', '입금 확인되었습니다.'],
    ['현금영수증 발행해주세요', '현금영수증 발행 완료했습니다.'],
  ]) {
    assert.equal(currentConfirmedPolicyAutoReplySupport({ latest_customer_message_cluster: question }, response).allowed, false);
  }
});

test('ordinary VAT-inclusive quote text is not mistaken for the payment FAQ', () => {
  const result = currentConfirmedPolicyAutoReplySupport({ latest_customer_message_cluster: '계좌이체 견적 금액 알려주세요' }, '계좌이체 금액은 VAT 포함 110,000원입니다.');
  assert.ok(!result.topics?.includes('bank_transfer_vat_collection_faq'));
});
