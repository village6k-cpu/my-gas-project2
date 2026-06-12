const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const checkAvailability = read('checkAvailability.js');
const sheetApi = read('sheetAPI.js');
const gasRoute = read('apps/today-dashboard/app/api/gas/route.ts');
const store = read('apps/today-dashboard/lib/data/store.ts');
const paymentControls = read('apps/today-dashboard/components/PaymentControls.tsx');

assert(
  /function requestTradeStatement\(tid\)[\s\S]{0,160}callVillageOpsApi_\("sendStatement", tid\)/.test(checkAvailability),
  'GAS bridge must expose registered-trade statement sending through Village 2.0'
);

assert(
  /case "sendStatement":[\s\S]{0,260}requestTradeStatement/.test(sheetApi),
  'sheetAPI must route action=sendStatement to requestTradeStatement'
);

assert(
  gasRoute.includes('"sendStatement"'),
  'Next GAS proxy must whitelist sendStatement as a write action'
);

assert(
  /export async function sendStatement\(tradeId: string\)/.test(store) &&
    /gasMutation\("sendStatement", \{ tid: tradeId \}\)/.test(store),
  'today-dashboard store must expose a result-returning sendStatement mutation'
);

assert(
  paymentControls.includes('sendStatement') &&
    paymentControls.includes('거래명세서 발송') &&
    /sendStatement\(trade\.tradeId\)/.test(paymentControls),
  'PaymentControls must render and call a visible 거래명세서 발송 action'
);

['dashboard.html', 'docs/dashboard.html'].forEach((file) => {
  const html = read(file);
  assert(
    /거래명세서 발송/.test(html) &&
      /runTradeOpsAction\(this,[\s\S]{0,120}sendStatement/.test(html),
    `${file} must expose statement sending on the legacy schedule dashboard`
  );
  assert(
    /action === 'sendStatement'/.test(html) &&
      /거래명세서 발송 실패/.test(html),
    `${file} must report statement send success/failure with statement-specific labels`
  );
});

console.log('today-dashboard statement send static checks passed');
