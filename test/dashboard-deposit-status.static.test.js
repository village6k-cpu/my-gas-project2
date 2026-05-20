const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const backend = read('checkAvailability.js');

assert.match(
  backend,
  /depositStatusOptions:\s*getTradeDepositStatusOptions_\(\)/,
  'dashboard payloads must include 입금상태 options'
);

assert.match(
  backend,
  /function\s+getTradeDepositStatusOptions_\(\)[\s\S]{0,180}getTradeColumnOptions_\(13,\s*\["미입금",\s*"입금완료",\s*"부분입금",\s*"환불"\]\)/,
  'backend must load 입금상태 options from 거래내역 M열 with safe fallbacks'
);

assert.match(
  backend,
  /field\s*!==\s*"proofType"[\s\S]{0,120}field\s*!==\s*"issueStatus"[\s\S]{0,120}field\s*!==\s*"depositStatus"/,
  'updateTradeProofField must accept depositStatus field'
);

assert.match(
  backend,
  /depositStatus:\s*\{\s*column:\s*13,\s*label:\s*"입금상태"\s*\}/,
  'depositStatus updates must write 거래내역 M열'
);

['dashboard.html', 'docs/dashboard.html'].forEach((file) => {
  const html = read(file);

  assert.match(
    html,
    /html\s*\+=\s*depositStatusSelectHtml\(item\)/,
    `${file} must render 입금상태 control on schedule cards`
  );

  assert.match(
    html,
    /function\s+depositStatusSelectHtml\(item\)[\s\S]{0,220}depositStatusOptions[\s\S]{0,160}입금상태/,
    `${file} must build an 입금상태 select from dashboardData.depositStatusOptions`
  );

  assert.match(
    html,
    /deposit-status-select/,
    `${file} must mark the 입금상태 select for styling and QA`
  );

  assert.match(
    html,
    /depositStatusSelectHtml\(item\)[\s\S]{0,220}tradeProofSelectHtml\(item,\s*'depositStatus'/,
    `${file} 입금상태 select must save through the depositStatus field`
  );

  assert.match(
    html,
    /if \(field === 'depositStatus'\) item\.depositStatus = value;/,
    `${file} must keep depositStatus in dashboard memory after save`
  );

  assert.match(
    html,
    /field === 'depositStatus'[\s\S]{0,180}입금상태 저장 실패/,
    `${file} must show an 입금상태-specific save error`
  );

  assert.match(
    html,
    /field === 'depositStatus'[\s\S]{0,260}renderDashboard\(dashboardData,\s*dashboardData\.date\s*\|\|\s*formatDate\(currentDate\)\)/,
    `${file} must refresh 확인필요 when 입금상태 changes`
  );

  assert.match(
    html,
    /depositChangedByPayment[\s\S]{0,900}res\.sideEffects\.columns\.M[\s\S]{0,900}activeDashboardTab === 'attention' \|\| depositChangedByPayment/,
    `${file} must refresh visible 입금상태 when 결제수단 side effects update M열`
  );
});

console.log('dashboard deposit status static checks passed');
