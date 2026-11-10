'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { auditBank } = require('../scripts/hermes/village-bank-payment-audit/scripts/audit.cjs');

const config = { SUPABASE_URL: 'https://test.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'test-key' };
const target = { id: 'original', amount: 254961, payer_name: '김입금 090003 모바일',
  raw: { remark1: '김입금', remark2: '090003', remark3: '모바일' }, remaining_amount: 254961 };

test('bank audit matches the primary sender on the Korean transfer date, not the concatenated memo', async () => {
  const result = await auditBank({
    config, payer: '김입금', date: '2026-11-10', amount: 254961,
    fetchImpl: async (url, options) => {
      assert.equal(url.searchParams.get('source'), 'eq.bank');
      assert.equal(url.searchParams.get('and'), '(occurred_at.gte.2026-11-09T15:00:00.000Z,occurred_at.lt.2026-11-10T15:00:00.000Z)');
      assert.equal(options.headers['Accept-Profile'], 'village');
      return Response.json([target, { ...target, id: 'another', raw: { remark1: '김입금자' } },
        { ...target, id: 'different-amount', amount: 1000 }]);
    },
  });
  assert.equal(result.matchCount, 1);
  assert.equal(result.receipts[0].receiptId, 'original');
  assert.equal(result.receipts[0].payer, '김입금');
  assert.equal(Object.hasOwn(result.receipts[0], 'raw'), false);
});

test('bank service errors cannot turn into a no-match result', async () => {
  await assert.rejects(auditBank({ config, payer: '김입금', date: '2026-11-10',
    fetchImpl: async () => new Response('', { status: 503 }) }), /조회 실패/);
});
