import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTradeCandidatesUrl,
  selectUniqueTradeCandidate,
  buildDocumentAction,
} from '../tools/village-doc-send/resolver.mjs';

test('builds my-gas-project2 tradeCandidates URL from parsed customer/date resolver', () => {
  const url = buildTradeCandidatesUrl({
    baseUrl: 'https://example.com/exec',
    apiKey: 'secret',
    resolver: { strategy: 'customer_date', customerName: '김태완', date: '2026-06-01' },
  });

  assert.equal(
    String(url),
    'https://example.com/exec?key=***&action=tradeCandidates&name=%EA%B9%80%ED%83%9C%EC%99%84&date=2026-06-01',
  );
});

test('selects exactly one candidate and refuses ambiguous candidates', () => {
  assert.deepEqual(
    selectUniqueTradeCandidate({ candidates: [{ tradeId: '260528-005', name: '김태완' }] }),
    { ok: true, tradeId: '260528-005', candidate: { tradeId: '260528-005', name: '김태완' } },
  );

  assert.deepEqual(selectUniqueTradeCandidate({ candidates: [] }), {
    ok: false,
    reason: 'not_found',
    candidates: [],
  });

  assert.deepEqual(selectUniqueTradeCandidate({ candidates: [{ tradeId: '1' }, { tradeId: '2' }] }), {
    ok: false,
    reason: 'ambiguous',
    candidates: [{ tradeId: '1' }, { tradeId: '2' }],
  });
});

test('maps resolved document intent to my-gas-project remote action', () => {
  assert.deepEqual(buildDocumentAction({ intent: 'send_quote', tradeId: '260528-005' }), {
    project: 'my-gas-project',
    method: 'POST',
    body: { action: 'sendEstimate', id: '260528-005' },
  });

  assert.deepEqual(buildDocumentAction({ intent: 'send_statement', tradeId: '260528-005' }), {
    project: 'my-gas-project',
    method: 'POST',
    body: { action: 'sendStatement', id: '260528-005' },
  });

  assert.deepEqual(buildDocumentAction({ intent: 'issue_proof', tradeId: '260528-005' }), {
    project: 'my-gas-project',
    method: 'POST',
    body: { action: 'issueProof', id: '260528-005' },
  });

  assert.deepEqual(buildDocumentAction({ intent: 'contract_link', tradeId: '260528-005' }), {
    project: 'my-gas-project',
    method: 'GET',
    query: { action: 'info', id: '260528-005' },
  });

  assert.deepEqual(buildDocumentAction({ intent: 'send_contract_link', tradeId: '260528-005' }), {
    project: 'my-gas-project',
    method: 'GET',
    query: { action: 'info', id: '260528-005' },
  });
});


