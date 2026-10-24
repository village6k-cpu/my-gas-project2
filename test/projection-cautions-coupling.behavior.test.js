const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const root = process.env.VILLAGE_PROJECTION_TEST_ROOT || path.resolve(__dirname, '..');

// A correction invalidates the date cache before the dirty-trade worker runs.
// Reproduce that cold-cache boundary using the real dashboard and projection.
function projectAfterInvalidation() {
  const rows = [
    ['target-01', 'target', '', '카메라A', 1, '2026-10-23', '19:00', '2026-10-25', '22:00', '예약', '', 10000],
    ['other-01', 'other', '', '카메라B', 1, '2026-10-23', '20:00', '2026-10-25', '22:00', '예약', '', 10000]
  ];
  let cautionRequests = 0;
  const cache = { get: () => null, getAll: () => ({}), put() {}, putAll() {} };
  const sheet = { getLastRow: () => 3, getRange: () => ({ getValues: () => rows, getDisplayValues: () => rows }) };
  const context = {
    console, Logger: { log() {} }, Date, JSON, Math, Number, String, Object, Array,
    SpreadsheetApp: { DataValidationCriteria: {}, getActiveSpreadsheet: () => ({ getSheetByName: () => sheet }) },
    PropertiesService: { getScriptProperties: () => ({ getProperties: () => ({}) }) },
    CacheService: { getScriptCache: () => cache },
    Utilities: { formatDate: () => '2026-10-23', DigestAlgorithm: { MD5: 'md5' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (_, s) => crypto.createHash('md5').update(s).digest(), base64Encode: b => Buffer.from(b).toString('base64') },
    UrlFetchApp: { fetchAll: requests => {
      cautionRequests += requests.length;
      return requests.map(() => ({ getResponseCode: () => 200,
        getContentText: () => JSON.stringify({ cautions: [{ text: '기존 주의사항', severity: 2 }], total_matched: 1 }) }));
    } }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, 'checkAvailability.js'), 'utf8'), context);
  Object.assign(context, {
    getDashboardCacheJson_: () => null, putDashboardCacheJson_: () => {},
    findDashboardRowsByValue_: () => [2, 3], readDashboardScheduleRowsDisplay_: () => rows,
    getDashboardContractMapForIds_: () => ({ target: { name: '대상' }, other: { name: '다른 예약' } }),
    getTradeExtrasForIds_: () => ({ target: { actualAmount: 182160, contractUrl: 'https://example.invalid/contract' } }),
    getEquipmentCheckMapForIds_: () => ({}), getEquipmentCheckForTrade_: () => ({}),
    getDashboardCheckinItemDefault_: () => false, supaGetScheduleItemCheckoutStateMap_: () => ({ byScheduleId: {} }),
    getTradePaymentOptions_: () => [], getTradeProofTypeOptions_: () => [], getTradeIssueStatusOptions_: () => [],
    getTradeDepositStatusOptions_: () => [], getTradeBillingCompanyOptions_: () => [],
    getTimelineData: () => ({ groups: [], items: [{ tid: 'target', s: Date.parse('2026-10-23T10:00Z'), e: Date.parse('2026-10-25T13:00Z') }] })
  });
  const source = fs.readFileSync(path.join(root, 'supabaseSync.js'), 'utf8');
  const start = source.indexOf('function buildSupabaseTrades_');
  const end = source.indexOf('\n/** payload 키 구성이 같은 행끼리 묶어 upsert');
  assert.ok(start >= 0 && end > start);
  vm.runInContext(source.slice(start, end), context);
  const projected = context.buildSupabaseTrades_(['target']);
  const backgroundRequests = cautionRequests;
  const staff = context.getDashboardData('2026-10-23', true);
  return { projected, staff, backgroundRequests, staffRequests: cautionRequests - backgroundRequests };
}

test('one corrected trade does not fan out display HTTP across its pickup day', () => {
  const result = projectAfterInvalidation();
  assert.equal(result.backgroundRequests, 0);
  assert.equal(result.projected.trades.length, 1);
  assert.equal(result.projected.trades[0].amount, 182160);
  assert.equal(result.projected.items.length, 1);
  assert.equal(result.projected.items[0].schedule_id, 'target-01');
});

test('the same cold day still serves all staff cards and their cautions', () => {
  const result = projectAfterInvalidation();
  assert.equal(result.staffRequests, 2);
  assert.equal(result.staff.checkout.length, 2);
  assert.ok(result.staff.checkout.every(card => card.cardCautions[0].text === '기존 주의사항'));
});