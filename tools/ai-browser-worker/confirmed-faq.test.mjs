import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHermesPrompt, loadCurrentConfirmedPolicyConfig, currentConfirmedPolicyAutoReplySupport, evaluateAutoReplyRagSupport, canAutoSendCustomerAnswer } from './worker.mjs';

const decision = (question) => ({ classification: 'faq', confidence: 'high',
  latest_customer_message_cluster: question, owner_review_required: false,
  reply_decision: { replyMode: 'auto_send', confidence: 'high', safetyClass: 'current_policy_answer', grounding: 'current_confirmed_policy', requiresRag: false },
  safety_checks: { kakao_conversation_opened: true, did_not_classify_from_preview_only: true, latest_customer_message_after_last_staff_reply: true } });

test('saved unanswered payment FAQ is verified without asking RAG or the owner', async () => {
  const result = await evaluateAutoReplyRagSupport({
    decision: decision('계좌랑 결제는 어떻게 되는 건가요? 현장에서 결제하는 건가요?'),
    replyText: '현금·계좌이체·카드로 결제하실 수 있고, 픽업 시 또는 반납 후 정산합니다.',
    askImpl: async () => { throw Error('no external policy lookup for confirmed FAQ'); }
  });
  assert.equal(result.allowed, true);
});

test('confirmed location FAQ ignores irrelevant old discount conversation', () => {
  const d = decision('매장 주소 알려주세요');
  d.visible_messages_used = [{ sender: '고객', message: '학생할인 3일 적용되나요?' }, { sender: '고객', message: '매장 주소 알려주세요' }];
  assert.equal(currentConfirmedPolicyAutoReplySupport(d, '서울 마포구 동교로 23길 32 엠페로빌딩 2층입니다. 지도: https://naver.me/FCAutZta').allowed, true);
});

test('every confirmed FAQ has provenance, reaches prompt, and passes both existing gates', async () => {
  const config = loadCurrentConfirmedPolicyConfig();
  assert.equal(config.faq_answers?.length, 12);
  const prompt = buildHermesPrompt({ job_id: 'confirmed-faq-test' }, { gatewayConfirmationToolAvailable: true });
  for (const faq of config.faq_answers) {
    assert.ok(faq.source && faq.question && faq.answer);
    assert.ok(prompt.includes(faq.answer), faq.key);
    const d = decision(faq.question);
    d.reply_decision.text = faq.answer;
    assert.equal(canAutoSendCustomerAnswer(d, { autoSendEnabled: true }).allowed, true, faq.key);
    const result = await evaluateAutoReplyRagSupport({ decision: d, replyText: faq.answer, askImpl: async () => { throw Error('unexpected RAG'); } });
    assert.equal(result.allowed, true, faq.key);
    assert.ok(result.currentPolicy.topics.includes(faq.key), faq.key);
    assert.equal(canAutoSendCustomerAnswer(d, { autoSendEnabled: false }).allowed, false);
    assert.equal(canAutoSendCustomerAnswer({ ...d, owner_review_required: true }, { autoSendEnabled: true }).allowed, false);
  }
  assert.ok(prompt.includes('follow_up_items=[]'));
  assert.ok(prompt.includes('실제 예약 변경·발행·수납·분쟁'));
});

test('canonical FAQ answer cannot authorize an unrelated answer or invented completed action', () => {
  const a = '현금·계좌이체·카드로 결제하실 수 있고, 픽업 시 또는 반납 후 정산합니다.';
  assert.equal(currentConfirmedPolicyAutoReplySupport(decision('카드 결제 되나요?'), a + '\n\n입금 확인 완료했습니다.').allowed, false);
  assert.equal(currentConfirmedPolicyAutoReplySupport(decision('카드 결제 되나요?'), a + ' 예약 확정했습니다.').allowed, false);
  assert.equal(currentConfirmedPolicyAutoReplySupport(decision('환불을 요청합니다'), a).allowed, false);
});

test('multiple confirmed FAQ answers can be combined without unlocking unknown content', () => {
  const faqs = loadCurrentConfirmedPolicyConfig().faq_answers;
  assert.ok(faqs);
  const address = faqs.find(x => x.key === 'shop_location_faq');
  const deposit = faqs.find(x => x.key === 'deposit_prepayment_faq');
  const d = decision('주소가 어디고 보증금도 있나요?');
  const result = currentConfirmedPolicyAutoReplySupport(d, address.answer + '\n\n' + deposit.answer);
  assert.equal(result.allowed, true);
  assert.deepEqual(result.topics, [address.key, deposit.key]);
});

test('student proof asks for either document and quick first-use exception is not invented', () => {
  const faqs = loadCurrentConfirmedPolicyConfig().faq_answers;
  assert.ok(faqs);
  const student = faqs.find(x => x.key === 'student_proof_faq');
  assert.equal(currentConfirmedPolicyAutoReplySupport(decision('학생할인 받으려면 학생증, 재학증명서 둘다 챙겨가면 되나요?'), student.answer).allowed, true);
  assert.match(student.answer, /또는.*하나/);
  const quick = faqs.find(x => x.key === 'quick_pickup_faq');
  assert.match(quick.answer, /법인도 최초 거래는/);
  assert.equal(currentConfirmedPolicyAutoReplySupport(decision('법인 첫 거래인데 퀵 수령 되나요?'), '법인은 첫 거래부터 퀵 수령 가능합니다.').allowed, false);
});
