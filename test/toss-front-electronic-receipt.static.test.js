const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const plugin = read('toss-front-plugin/village-front/app.js');
const confirmRoute = read('apps/today-dashboard/app/api/lookup/confirm/route.ts');
const gasRoute = read('apps/today-dashboard/app/api/gas/route.ts');
const store = read('apps/today-dashboard/lib/data/store.ts');
const paymentControls = read('apps/today-dashboard/components/PaymentControls.tsx');
const gasBackend = read('checkAvailability.js');
const sheetApi = read('sheetAPI.js');

assert(
  /sendReceipt:\s*Boolean\(trade\.receiptPhone\)/.test(plugin) &&
    /receiptPhone:\s*trade\.receiptPhone/.test(plugin),
  'Toss Front confirm payload must request automatic electronic receipt delivery with the lookup phone'
);

assert(
  /payment\.receiptResult/.test(plugin) &&
    /payment\.receiptError/.test(plugin) &&
    /전자영수증/.test(plugin),
  'Toss Front success screen must show electronic receipt delivery status without blocking payment success'
);

assert(
  /action:\s*"sendElectronicReceipt"/.test(confirmRoute) &&
    /receiptError/.test(confirmRoute) &&
    /catch\s*\([^)]*\)\s*\{[\s\S]{0,260}receiptError/.test(confirmRoute),
  '/api/lookup/confirm must call sendElectronicReceipt after updatePayment and keep receipt failures separate'
);

assert(
  gasRoute.includes('"sendElectronicReceipt"'),
  'Next GAS proxy must whitelist sendElectronicReceipt as a write action'
);

assert(
  /export async function sendElectronicReceipt\(tradeId: string/.test(store) &&
    /gasMutation\("sendElectronicReceipt"/.test(store),
  'today-dashboard store must expose a result-returning sendElectronicReceipt mutation'
);

assert(
  paymentControls.includes('sendElectronicReceipt') &&
    paymentControls.includes('전자영수증 발송') &&
    /isCardPaymentComplete/.test(paymentControls) &&
    /sendElectronicReceipt\(trade\.tradeId/.test(paymentControls),
  'PaymentControls must show a visible electronic receipt send action for completed card payments'
);

assert(
  /function requestTradeElectronicReceipt\(tid,\s*opts\)/.test(gasBackend) &&
    /callVillageOpsApi_\("sendElectronicReceipt",\s*tid,\s*\{/.test(gasBackend) &&
    /approvalNumber:\s*opts\.approvalNumber/.test(gasBackend),
  'GAS bridge must expose electronic receipt sending through Village ops API'
);

assert(
  /case "sendElectronicReceipt":[\s\S]{0,360}requestTradeElectronicReceipt/.test(sheetApi),
  'sheetAPI must route action=sendElectronicReceipt to requestTradeElectronicReceipt'
);

console.log('toss-front electronic receipt static checks passed');
