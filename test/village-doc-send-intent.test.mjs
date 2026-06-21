import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVillageDocumentCommand } from '../tools/village-doc-send/intent.mjs';

test('parses natural staff request by Korean date and customer, without requiring trade ID', () => {
  const parsed = parseVillageDocumentCommand('6월 1일 김태완 건 견적서 발송해줘', {
    now: new Date('2026-06-01T09:00:00+09:00'),
  });

  assert.equal(parsed.intent, 'send_quote');
  assert.equal(parsed.documentType, 'quote');
  assert.equal(parsed.shouldSend, true);
  assert.equal(parsed.tradeId, null);
  assert.equal(parsed.customerName, '김태완');
  assert.equal(parsed.date, '2026-06-01');
  assert.deepEqual(parsed.resolver, {
    strategy: 'customer_date',
    customerName: '김태완',
    date: '2026-06-01',
  });
});

test('parses 거래명세서 and 계약서 link requests from the same human style', () => {
  assert.deepEqual(
    parseVillageDocumentCommand('6월 1일 김태완 건 거래명세서 보내줘', { now: new Date('2026-06-01T09:00:00+09:00') }).resolver,
    { strategy: 'customer_date', customerName: '김태완', date: '2026-06-01' },
  );
  assert.equal(
    parseVillageDocumentCommand('6월 1일 김태완 계약서 링크 알려줘', { now: new Date('2026-06-01T09:00:00+09:00') }).intent,
    'contract_link',
  );
});

test('parses relative Korean dates for staff shortcuts', () => {
  const parsed = parseVillageDocumentCommand('김태완 내일 건 견적서 보내줘', {
    now: new Date('2026-06-01T09:00:00+09:00'),
  });

  assert.equal(parsed.intent, 'send_quote');
  assert.equal(parsed.customerName, '김태완');
  assert.equal(parsed.date, '2026-06-02');
  assert.deepEqual(parsed.resolver, {
    strategy: 'customer_date',
    customerName: '김태완',
    date: '2026-06-02',
  });
});

test('parses proof issue commands only when wording asks to issue/process', () => {
  const issue = parseVillageDocumentCommand('김태완 내일 증빙 발행해줘', {
    now: new Date('2026-06-01T09:00:00+09:00'),
  });
  assert.equal(issue.intent, 'issue_proof');
  assert.equal(issue.documentType, 'proof');
  assert.equal(issue.shouldSend, true);
  assert.deepEqual(issue.resolver, { strategy: 'customer_date', customerName: '김태완', date: '2026-06-02' });

  const preview = parseVillageDocumentCommand('김태완 내일 증빙 확인해줘', {
    now: new Date('2026-06-01T09:00:00+09:00'),
  });
  assert.equal(preview.intent, 'prepare_proof');
  assert.equal(preview.shouldSend, false);
});

test('does not send when user only asks to make or check a quote', () => {
  const parsed = parseVillageDocumentCommand('6월 1일 김태완 건 견적서 만들어줘', {
    now: new Date('2026-06-01T09:00:00+09:00'),
  });

  assert.equal(parsed.intent, 'prepare_quote');
  assert.equal(parsed.shouldSend, false);
});

test('marks payment update wording as out of scope for document-send channel', () => {
  const parsed = parseVillageDocumentCommand('김태완 오늘 결제수단 카드로 처리하고 견적서 발송', {
    now: new Date('2026-06-01T09:00:00+09:00'),
  });

  assert.equal(parsed.intent, 'send_quote');
  assert.equal(parsed.outOfScopePaymentUpdate, true);
});
