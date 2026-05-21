const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const backend = read('checkAvailability.js');

assert.match(
  backend,
  /depositStatus:\s*''/,
  'dashboard trade extras must initialize depositStatus'
);

assert.match(
  backend,
  /var\s+depositCol\s*=\s*13/,
  'dashboard trade extras must read 거래내역 M열 입금 상태'
);

assert.match(
  backend,
  /result\[tid\]\.depositStatus\s*=\s*String\(row\[depositCol\s*-\s*1\]/,
  'dashboard trade extras must expose depositStatus from 거래내역'
);

assert.match(
  backend,
  /depositStatus:\s*extra\.depositStatus\s*\|\|\s*''/,
  'dashboard items must include depositStatus'
);

assert.match(
  backend,
  /extra\.depositStatus/,
  'dashboard search matching must include depositStatus'
);

['dashboard.html', 'docs/dashboard.html'].forEach((file) => {
  const html = read(file);

  assert.match(
    html,
    /data-tab=["']attention["']/,
    `${file} must expose a 확인필요 tab`
  );

  assert.match(
    html,
    /id=["']attentionSection["']/,
    `${file} must render an attention-only section`
  );

  assert.match(
    html,
    /id=["']tabAttention["']/,
    `${file} must show the attention item count`
  );

  assert.match(
    html,
    /function isReturnStatusAbnormal\(item\)/,
    `${file} must classify non-normal return statuses`
  );

  assert.match(
    html,
    /function isPaymentPending\(item\)/,
    `${file} must classify unpaid items`
  );

  assert.match(
    html,
    /function buildDashboardAttentionItems\(/,
    `${file} must collect abnormal return and unpaid items`
  );

  assert.match(
    html,
    /function getDashboardSectionConfig\(tab\)[\s\S]*tab === ['"]attention['"][\s\S]*items = view\.attention/,
    `${file} must keep the attention collection in the prepared dashboard view`
  );

  assert.match(
    html,
    /renderList\(tab \+ ['"]Section['"],\s*config\.items/,
    `${file} must render the active attention tab from the prepared collection`
  );

  assert.match(
    html,
    /attention-reason-badge/,
    `${file} must show why each attention card is included`
  );
});

console.log('dashboard attention filter static checks passed');
