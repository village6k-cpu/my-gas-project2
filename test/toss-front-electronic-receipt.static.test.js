const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const plugin = read('toss-front-plugin/village-front/app.js');
const confirmRoute = read('apps/today-dashboard/app/api/lookup/confirm/route.ts');
const store = read('apps/today-dashboard/lib/data/store.ts');
const paymentControls = read('apps/today-dashboard/components/PaymentControls.tsx');

assert(
  /sendReceipt:\s*Boolean\(trade\.receiptPhone && payment\.officialReceiptUrl\)/.test(plugin) &&
    /officialReceiptUrl:\s*payment\.officialReceiptUrl/.test(plugin),
  'Toss Front must only request receipt delivery when a Toss official receipt URL exists'
);

assert(
  /r\.officialReceiptUrl[\s\S]{0,140}r\.receiptUrl[\s\S]{0,140}r\.receipt && r\.receipt\.url/.test(plugin),
  'Toss Front must capture a future official receipt URL from the SDK response without inventing one'
);

assert(
  !/action:\s*"sendElectronicReceipt"/.test(confirmRoute) &&
    /Toss 공식 영수증 URL이 없어 전자영수증을 발송하지 않았습니다/.test(confirmRoute),
  '/api/lookup/confirm must not call the old Popbill summary receipt path'
);

assert(
  /sdk\.payment\.getPayment\s*\?\s*await sdk\.payment\.getPayment\(\{\s*paymentKey:\s*pending\.paymentKey\s*\}\)/.test(plugin) &&
    !/getPaymentByKey/.test(plugin),
  'Toss Front pending recovery must use the documented getPayment API'
);

assert(
  /export async function sendElectronicReceipt\(tradeId: string/.test(store) &&
    /Toss 공식 영수증 URL이 없어 전자영수증을 발송할 수 없습니다/.test(store) &&
    !/gasMutation\("sendElectronicReceipt"/.test(store),
  'today-dashboard store must reject sends without an official Toss receipt URL'
);

assert(
  paymentControls.includes('sendElectronicReceipt') &&
    paymentControls.includes('공식영수증 링크 없음') &&
    paymentControls.includes('officialReceiptUrl') &&
    /isCardPaymentComplete/.test(paymentControls) &&
    /sendElectronicReceipt\(trade\.tradeId/.test(paymentControls),
  'PaymentControls must block manual sends until an official Toss receipt URL is available'
);

console.log('toss-front electronic receipt static checks passed');
