const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

const checkAvailability = read('checkAvailability.js');
const code = read('Code.js');

assert.match(
  checkAvailability,
  /status\s*===\s*['"]취소['"][\s\S]{0,800}cancelContract\(ss,\s*tradeId,\s*row\)/,
  'updateDashboardContractStatus must route 취소 through cancelContract()'
);

assert.match(
  checkAvailability,
  /deleteProperty\(['"]returnDone_['"]\s*\+\s*tradeId\)[\s\S]{0,160}deleteProperty\(['"]returnPrevContractStatus_['"]\s*\+\s*tradeId\)/,
  '취소 status update should clear return-complete script state'
);

assert.match(
  code,
  /status\s*===\s*['"]취소['"][\s\S]{0,500}deleteProperty\(['"]returnDone_['"]\s*\+\s*tradeId\)[\s\S]{0,220}cancelContract\(ss,\s*tradeId,\s*row\)/,
  'manual 계약마스터 J열 취소 edits should clear return state and use cancelContract()'
);

['dashboard.html', 'docs/dashboard.html'].forEach((file) => {
  const html = read(file);

  assert.match(
    html,
    /cardActionHtml\(item,\s*cardType\)/,
    `${file} must pass cardType into cardActionHtml`
  );

  assert.match(
    html,
    /function cardActionHtml\(item,\s*cardType\)/,
    `${file} cardActionHtml must accept cardType`
  );

  assert.match(
    html,
    /cardType\s*===\s*['"]checkin['"][\s\S]{0,600}cancelDashboardTrade/,
    `${file} must render the cancel action for return/checkin cards`
  );

  assert.match(
    html,
    /function cancelDashboardTrade\(btn,\s*tid,\s*name\)/,
    `${file} must implement cancelDashboardTrade`
  );

  assert.match(
    html,
    /action:\s*['"]updateContractStatus['"][\s\S]{0,220}status:\s*['"]취소['"]/,
    `${file} cancel action must call updateContractStatus with 취소`
  );

  assert.match(
    html,
    /cancelDashboardTrade[\s\S]{0,1200}loadData\(true\)/,
    `${file} must refresh the dashboard after a successful cancel`
  );
});

console.log('dashboard cancel static checks passed');
