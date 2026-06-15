const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'toss-front-plugin/village-front/app.js'), 'utf8');

assert(
  app.includes('village-amount-button') && app.includes('금액 직접 결제'),
  'idle screen must offer a direct amount payment path for walk-in card payments'
);
assert(
  app.includes('showManualAmountInput') &&
    /renderInputPage\(\{\s*type: 'number'/.test(app),
  'direct amount payment must use the Toss number input template'
);
assert(
  app.includes('function chargeManualAmount(amount)') &&
    app.includes('function doManualCharge(amount)'),
  'direct amount payment must have its own charge flow'
);

const manualCharge = app.match(/async function doManualCharge\(amount\) \{[\s\S]*?\n\}/);
assert(manualCharge, 'manual amount charge function must exist');
assert(
  !manualCharge[0].includes('confirmPaid'),
  'manual amount payments must not call the reservation/sheet confirm endpoint'
);

console.log('toss-front manual amount static checks passed');
