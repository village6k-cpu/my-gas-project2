'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DOMAIN_SHEETS,
  buildSearchRequest,
  lookupVillage
} = require('../scripts/windows/village-live-query.js');

const config = {
  VILLAGE2_API_URL: 'https://script.google.com/macros/s/example/exec',
  VILLAGE2_API_KEY: 'synthetic-key'
};

test('domain routes cover Village operations broadly instead of one KPI', () => {
  assert.deepEqual(DOMAIN_SHEETS.inventory, ['장비마스터', '세트마스터']);
  assert.deepEqual(DOMAIN_SHEETS.schedule, ['스케줄상세', '확인요청', '계약마스터']);
  assert.deepEqual(DOMAIN_SHEETS.customer, ['고객DB']);
  assert.deepEqual(DOMAIN_SHEETS.finance, ['거래내역', '발행처DB']);
  assert.deepEqual(DOMAIN_SHEETS.documents, ['계약마스터', '확인요청', '발행처DB']);
});

test('search request is restricted to the read-only GAS search action', () => {
  const request = buildSearchRequest(config, {
    sheet: '장비마스터',
    query: 'LVM-170A'
  });
  const url = new URL(request.url);

  assert.equal(request.method, 'GET');
  assert.equal(url.origin, 'https://script.google.com');
  assert.equal(url.searchParams.get('action'), 'search');
  assert.equal(url.searchParams.get('sheet'), '장비마스터');
  assert.equal(url.searchParams.get('query'), 'LVM-170A');
  assert.equal(url.searchParams.has('write'), false);
  assert.equal(url.searchParams.has('append'), false);
  assert.equal(url.searchParams.has('update'), false);
});

test('search request rejects non-authoritative sheets and non-script hosts', () => {
  assert.throws(
    () => buildSearchRequest(config, { sheet: '임의시트', query: 'x' }),
    /not allowlisted/i
  );
  assert.throws(
    () => buildSearchRequest({ ...config, VILLAGE2_API_URL: 'https://example.com/' }, {
      sheet: '고객DB', query: 'x'
    }),
    /script\.google\.com/i
  );
});

test('one domain lookup searches its authoritative sheets concurrently and returns no credential', async () => {
  const requests = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    await gate;
    const parsed = new URL(url);
    return {
      ok: true,
      json: async () => ({
        sheet: parsed.searchParams.get('sheet'),
        headers: ['장비명', '보유수량'],
        count: 1,
        results: [{ row: 2, data: ['LVM-170A', 4] }]
      })
    };
  };

  const pending = lookupVillage({
    config,
    domain: 'inventory',
    query: 'LVM-170A',
    fetchImpl,
    timeoutMs: 1_000
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 2, 'both domain sheets should start before either resolves');
  release();
  const result = await pending;

  assert.equal(result.ok, true);
  assert.equal(result.domain, 'inventory');
  assert.equal(result.matches, 2);
  assert.deepEqual(result.sheets.map((item) => item.sheet), ['장비마스터', '세트마스터']);
  assert.doesNotMatch(JSON.stringify(result), /synthetic-key/);
});

test('lookup rejects unknown domains instead of falling back to broad drive search', async () => {
  await assert.rejects(
    () => lookupVillage({ config, domain: 'everything', query: 'x', fetchImpl: async () => {} }),
    /Unknown Village lookup domain/i
  );
});
