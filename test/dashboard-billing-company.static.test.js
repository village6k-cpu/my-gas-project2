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
  /extra\.billingCompany\s*=\s*String\(row\[columns\.billingCompanyCol\s*-\s*1\]/,
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

assert.doesNotMatch(
  backend,
  /발행처 목록에 없는 값입니다/,
  'backend must not reject directly typed 발행처 values'
);

assert.match(
  backend,
  /function\s+getTradeBillingCompanyHeaderCandidates_\(\)[\s\S]{0,180}상호명/,
  'billing company options must recognize 발행처DB 상호명 as the company-name column'
);

assert.match(
  backend,
  /_findHeaderCol_\(headers,\s*getTradeBillingCompanyHeaderCandidates_\(\)\)\s*\|\|\s*\(lastCol\s*>=\s*2\s*\?\s*2\s*:\s*1\)/,
  'billing company master fallback must use 발행처DB B열, not 사업자번호 A열'
);

assert.match(
  backend,
  /function\s+ensureTradeBillingCompanyValidation_\(\)[\s\S]*requireValueInRange\(sourceRange,\s*true\)[\s\S]*\.setAllowInvalid\(true\)[\s\S]*getRange\(2,\s*7,/,
  'backend must restore 거래내역 G열 발행처 dropdown from 발행처DB while allowing direct input'
);

assert.match(
  api,
  /"repairTradeBillingCompanyDropdown"/,
  'sheetAPI run allowlist must expose the 발행처 dropdown repair function'
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
    `${file} must not lock 발행처 상호 into a select-only dropdown`
  );

  assert.match(
    html,
    /class=["']billing-company-combo["'][\s\S]{0,320}<input class=["']billing-company-input["'][\s\S]{0,220}oninput=["']openBillingCompanyMenu\(this\)/,
    `${file} must allow 직접 입력 with a custom 발행처 autocomplete menu`
  );

  assert.doesNotMatch(
    html,
    /<datalist id=["']billingCompanyOptionsList["']/,
    `${file} must not rely on datalist for the 발행처 dropdown`
  );

  assert.doesNotMatch(
    html,
    /list=["']billingCompanyOptionsList["']/,
    `${file} 발행처 control must not use datalist autocomplete`
  );

  assert.match(
    html,
    /function\s+getBillingCompanyMatches\(query,\s*limit\)[\s\S]*dashboardData\.billingCompanyOptions/,
    `${file} must search 발행처DB options from dashboardData.billingCompanyOptions`
  );

  assert.match(
    html,
    /function\s+chooseBillingCompanyOption\(event,\s*button\)[\s\S]*updateBillingCompany/,
    `${file} must save a clicked 발행처 autocomplete option`
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
