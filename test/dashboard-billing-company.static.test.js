const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const backend = read('checkAvailability.js');
const api = read('sheetAPI.js');

assert.match(
  backend,
  /billingCompany:\s*''/,
  'dashboard trade extras must initialize billingCompany'
);

assert.match(
  backend,
  /var\s+billingCompanyCol\s*=\s*7/,
  'dashboard trade extras must read 거래내역 G열 발행처 상호'
);

assert.match(
  backend,
  /result\[tid\]\.billingCompany\s*=\s*String\(row\[billingCompanyCol\s*-\s*1\]/,
  'dashboard trade extras must expose billingCompany from 거래내역'
);

assert.match(
  backend,
  /billingCompany:\s*extra\.billingCompany\s*\|\|\s*''/,
  'dashboard items must include billingCompany'
);

assert.match(
  backend,
  /billingCompanyOptions:\s*getTradeBillingCompanyOptions_\(\)/,
  'dashboard payloads must include billingCompanyOptions'
);

assert.match(
  backend,
  /function\s+updateTradeBillingCompany\(tid,\s*billingCompany\)/,
  'backend must expose updateTradeBillingCompany'
);

assert.match(
  backend,
  /function\s+validateTradeProofIssueReady_\(tid\)/,
  'backend must preflight tax invoice issue requests'
);

assert.match(
  backend,
  /proofType\s*===\s*["']세금계산서["'][\s\S]{0,180}!billingCompany/,
  'backend must require billingCompany before 세금계산서 발행요청'
);

assert.match(
  backend,
  /extra\.billingCompany/,
  'dashboard search matching must include billingCompany'
);

assert.match(
  api,
  /case\s+["']updateBillingCompany["'][\s\S]{0,220}updateTradeBillingCompany\(/,
  'sheetAPI must route action=updateBillingCompany'
);

['dashboard.html', 'docs/dashboard.html'].forEach((file) => {
  const html = read(file);

  assert.match(
    html,
    /\.billing-company-input/,
    `${file} must style the 발행처 상호 autocomplete input`
  );

  assert.match(
    html,
    /function\s+billingCompanyInputHtml\(item\)/,
    `${file} must render a 발행처 상호 autocomplete input`
  );

  assert.doesNotMatch(
    html,
    /<select class=["']billing-company-select/,
    `${file} must not render 발행처 상호 as a long select dropdown`
  );

  assert.match(
    html,
    /<datalist id=["']billingCompanyOptionsList["']/,
    `${file} must provide a shared 발행처 상호 datalist`
  );

  assert.match(
    html,
    /list=["']billingCompanyOptionsList["']/,
    `${file} 발행처 input must use the shared datalist`
  );

  assert.match(
    html,
    /function\s+renderBillingCompanyDatalist\(data\)/,
    `${file} must refresh 발행처 autocomplete options from dashboard data`
  );

  assert.match(
    html,
    /billingCompanyOptions/,
    `${file} must use dashboardData.billingCompanyOptions`
  );

  assert.match(
    html,
    /발행처 상호/,
    `${file} must label the empty business recipient option as 발행처 상호`
  );

  assert.match(
    html,
    /function\s+updateBillingCompany\(event,\s*input,\s*tradeId\)/,
    `${file} must save 발행처 상호 changes`
  );

  assert.match(
    html,
    /action:\s*['"]updateBillingCompany['"]/,
    `${file} must call action=updateBillingCompany`
  );

  assert.match(
    html,
    /function\s+syncBillingCompanyInMemory\(tid,\s*billingCompany\)/,
    `${file} must keep billingCompany in dashboard memory after save`
  );

  assert.match(
    html,
    /item\.billingCompany/,
    `${file} must include billingCompany in search and issue preflight`
  );

  assert.match(
    html,
    /세금계산서[\s\S]{0,240}발행처 상호/,
    `${file} must warn before 세금계산서 발행요청 without 발행처 상호`
  );
});

console.log('dashboard billing company static checks passed');
