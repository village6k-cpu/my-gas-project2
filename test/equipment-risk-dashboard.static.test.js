const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const backend = read('checkAvailability.js');
const api = read('sheetAPI.js');

[
  "var CARD_CAUTIONS_API_BASE_URL_ = 'https://village-ai-six.vercel.app';",
  "var CARD_CAUTIONS_API_PATH_ = '/api/cautions';",
  'var CARD_CAUTIONS_API_LIMIT_ = 5;',
  'function fetchCardCautions(phase, itemNames)',
  'function fetchCardCautionsBatch_(requests)',
  'function attachDashboardCardCautions_(checkoutList, checkinList)',
  'UrlFetchApp.fetchAll(fetchRequests)',
  'cardCautions: []',
  'cardCautionsHiddenCount: 0'
].forEach((contract) => {
  assert.ok(
    backend.indexOf(contract) !== -1,
    `checkAvailability.js must include card caution contract: ${contract}`
  );
});

[
  'EQUIPMENT_RISK_RULE_SHEET_NAME',
  'function getEquipmentRiskRules_()',
  'function readEquipmentRiskRules_()',
  'function matchEquipmentRiskRulesForEquipments_',
  'function attachEquipmentRiskWarnings_',
  'function evaluateEquipmentRiskGuidanceStates_',
  'markEquipmentRiskSearchEvaluationSkipped_(result)',
  'options.evaluateRisk',
  'params.riskEval'
].forEach((removed) => {
  assert.ok(
    backend.indexOf(removed) === -1 && api.indexOf(removed) === -1,
    `old direct equipment-risk matching/evaluation contract must be removed: ${removed}`
  );
});

const fetchCalls = [];
const fetchAllCalls = [];
const response = (status, body) => ({
  getResponseCode: () => status,
  getContentText: () => JSON.stringify(body)
});

const gasContext = {
  console,
  Logger: { log() {} },
  UrlFetchApp: {
    fetch(url, options) {
      fetchCalls.push({ url, options });
      return response(200, {
        phase: 'checkout',
        cautions: [
          { id: 'caution-required-1', text: '필수 1', equipment: 'FX3', severity: 3 },
          { text: '중요 2', equipment: 'FX3', severity: 2 },
          { text: '권장 3', equipment: 'FX3', severity: 1 },
          { text: '권장 4', equipment: 'FX3', severity: 1 },
          { text: '권장 5', equipment: 'FX3', severity: 1 },
          { text: '권장 6', equipment: 'FX3', severity: 1 }
        ],
        hidden_count: 2,
        total_matched: 8
      });
    },
    fetchAll(requests) {
      fetchAllCalls.push(requests);
      return requests.map((request) => {
        const payload = JSON.parse(request.payload);
        if (payload.phase === 'return') {
          return response(200, {
            phase: 'return',
            cautions: [
              { id: 'caution-return-1', text: '반납 렌즈 마운트 확인', equipment: 'FX3', severity: 1 }
            ],
            hidden_count: 0,
            total_matched: 1
          });
        }
        return response(200, {
          phase: 'checkout',
          cautions: [
            { id: 'caution-checkout-1', text: 'SDI 단자 확인', equipment: 'FX3', severity: 3 },
            { text: '케이지 나사 확인', equipment: 'FX3', severity: 2 }
          ],
          hidden_count: 4,
          total_matched: 6
        });
      });
    }
  }
};

vm.createContext(gasContext);
vm.runInContext(backend, gasContext);

const single = gasContext.fetchCardCautions('checkout', ['FX3', 'FX3', '']);
assert.strictEqual(fetchCalls.length, 1, 'single helper must call /api/cautions once');
assert.strictEqual(fetchCalls[0].url, 'https://village-ai-six.vercel.app/api/cautions');
assert.deepStrictEqual(JSON.parse(fetchCalls[0].options.payload), {
  phase: 'checkout',
  items: ['FX3'],
  limit: 5
});
assert.strictEqual(single.cautions.length, 6, 'single helper must render the server cautions array as-is');
assert.strictEqual(single.hidden_count, 2, 'single helper must preserve server hidden_count exactly');
assert.strictEqual(single.cautions[0].id, 'caution-required-1', 'single helper must preserve mined caution id');

const checkoutItem = {
  tradeId: '260701-001',
  equipments: [
    { name: '소니 A7S3 바디세트' },
    { name: '소니 A7S3 바디(케이지)' },
    { name: '소니 CF-A 160' },
    { name: 'NP-FZ100' },
    { name: 'NP-FZ100 충전기' },
    { name: '' }
  ]
};
const returnItem = {
  tradeId: '260701-002',
  equipments: [{ name: 'FX3' }]
};
gasContext.attachDashboardCardCautions_([checkoutItem], [returnItem]);

assert.strictEqual(fetchAllCalls.length, 1, 'dashboard attachment must batch card caution requests with fetchAll');
assert.strictEqual(fetchAllCalls[0].length, 2, 'checkout and return cards must be requested in one batch');
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(fetchAllCalls[0].map((request) => JSON.parse(request.payload)))),
  [
    { phase: 'checkout', items: ['소니 A7S3 바디세트', '소니 A7S3 바디(케이지)', '소니 CF-A 160'], limit: 5 },
    { phase: 'return', items: ['FX3'], limit: 5 }
  ],
  'batch payload must call once per card while omitting duplicate-prone battery/charger components when other equipment exists'
);
assert.deepStrictEqual(
  JSON.parse(JSON.stringify(checkoutItem.cardCautions.map((caution) => caution.severity))),
  [3, 2],
  'checkout cautions must keep server severity order'
);
assert.strictEqual(checkoutItem.cardCautionsHiddenCount, 4);
assert.strictEqual(checkoutItem.cardCautions[0].id, 'caution-checkout-1', 'dashboard card cautions must preserve mined caution id');
assert.strictEqual(returnItem.cardCautions[0].text, '반납 렌즈 마운트 확인');
assert.strictEqual(returnItem.cardCautions[0].id, 'caution-return-1', 'return card cautions must preserve mined caution id');
assert.strictEqual(returnItem.cardCautionsPhase, 'return');

const batteryOnlyItem = {
  tradeId: '260701-003',
  equipments: [{ name: 'NP-FZ100' }, { name: 'NP-FZ100 충전기' }]
};
fetchAllCalls.length = 0;
gasContext.attachDashboardCardCautions_([batteryOnlyItem], []);
assert.deepStrictEqual(
  JSON.parse(fetchAllCalls[0][0].payload),
  { phase: 'checkout', items: ['NP-FZ100', 'NP-FZ100 충전기'], limit: 5 },
  'battery-only cards must still request their own cautions'
);

[
  'includeCautions: params.includeCautions || postBody.includeCautions',
  'getDashboardData(params.date || postBody.date || null, skipCache, {\n          profile: params.profile || postBody.profile\n        })'
].forEach((contract) => {
  assert.ok(api.indexOf(contract) !== -1, `sheetAPI.js must include contract: ${contract}`);
});

['dashboard.html', 'docs/dashboard.html'].forEach((file) => {
  const html = read(file);

  [
    'function cardCautionSummaryHtml(item, cardType)',
    'function cardCautionsPanelHtml(item, cardType)',
    'function cardCautionSeverityLabel(severity)',
    'cardCautionSummaryHtml(item, cardType)',
    'cardCautionsPanelHtml(item, cardType)',
    "var label = '주의 ' + cautions.length;",
    '.card-caution-row.severity-3 .card-caution-meta',
    '.card-caution-row.severity-3 .card-caution-text',
    'class="card-caution-more"',
    '외 ',
    'hiddenCount + \'건 ▸</button>\'',
    '&includeCautions=1'
  ].forEach((contract) => {
    assert.ok(html.indexOf(contract) !== -1, `${file} must include caution UI contract: ${contract}`);
  });

  [
    'function riskWarningSummaryHtml(item, cardType)',
    'function equipmentRiskPanelHtml(item, cardType)',
    'function sendEquipmentRiskGuidance(btn)',
    'function recordEquipmentRiskEvent(btn, eventType)',
    "dashboardApiPayload('equipmentRiskSend'",
    "dashboardApiPayload('equipmentRiskEvent'",
    '.risk-warning-badge',
    '.equipment-risk-actions'
  ].forEach((removed) => {
    assert.ok(html.indexOf(removed) === -1, `${file} must remove old risk UI contract: ${removed}`);
  });

  assert.ok(
    html.indexOf("var label = '주의 ' + cautions.length + (hiddenCount > 0 ? '+' + hiddenCount : '');") === -1,
    `${file} must not include hidden_count in the visible caution badge`
  );
  assert.ok(
    html.indexOf('}).slice(0, 5);') === -1,
    `${file} must render the already-capped server cautions without local slicing`
  );
  assert.ok(
    html.indexOf("var DASHBOARD_CACHE_PREFIX = 'dashCache_v6_';") !== -1,
    `${file} must bump localStorage dashboard cache prefix to invalidate old caution payloads`
  );
});
