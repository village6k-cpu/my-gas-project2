const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const ca = read('checkAvailability.js');
const api = read('sheetAPI.js');
const dashboard = read('dashboard.html');
const docsDashboard = read('docs/dashboard.html');
const store = read('apps/today-dashboard/lib/data/store.ts');
const controls = read('apps/today-dashboard/components/PaymentControls.tsx');

assert(
  /case "sendPayAppPaymentLink":/.test(api) &&
    /requestPayAppPaymentLink\(/.test(api) &&
    /case "setupPayAppUserId":/.test(api) &&
    /case "diagPayAppConfig":/.test(api),
  'sheetAPI must expose PayApp send/setup/diagnostic actions'
);

assert(
  /function requestPayAppPaymentLink\(tid\)/.test(ca) &&
    /function setupPayAppUserId\(userid\)/.test(ca) &&
    /function diagPayAppConfig\(\)/.test(ca) &&
    ca.includes('https://api.payapp.kr/oapi/apiLoad.html') &&
    ca.includes("cmd: 'payrequest'") &&
    ca.includes('PAYAPP_USERID') &&
    ca.includes('PAYAPP_OPENPAYTYPE') &&
    ca.includes('PAYAPP_FEEDBACK_URL') &&
    ca.includes('actualAmount') &&
    ca.includes('recvphone') &&
    ca.includes('payurl') &&
    ca.includes('mul_no'),
  'GAS must build and send a PayApp payrequest from trade data'
);

assert(
  /price:\s*String\(amount\)/.test(ca) &&
    /var1:\s*tid/.test(ca) &&
    /VILLAGE 렌탈 결제/.test(ca),
  'PayApp request must use the trade amount, trade id, and a consistent good name'
);

assert(
  /결제링크 발송/.test(dashboard) &&
    /runTradeOpsAction\(this,[\s\S]{0,140}sendPayAppPaymentLink/.test(dashboard) &&
    /결제링크 발송 실패/.test(dashboard) &&
    /결제링크 발송 완료/.test(dashboard),
  'classic dashboard must show a one-click PayApp payment link button and labels'
);

assert(
  /결제링크 발송/.test(docsDashboard) &&
    /runTradeOpsAction\(this,[\s\S]{0,140}sendPayAppPaymentLink/.test(docsDashboard) &&
    /결제링크 발송 실패/.test(docsDashboard) &&
    /결제링크 발송 완료/.test(docsDashboard),
  'GitHub Pages dashboard must show the PayApp payment link button and labels'
);

assert(
  /export async function sendPayAppPaymentLink\(tradeId: string\)/.test(store) &&
    /gasMutation\("sendPayAppPaymentLink",\s*\{ tid: tradeId \}\)/.test(store),
  'Next store must expose a PayApp payment-link mutation'
);

assert(
  /sendPayAppPaymentLink/.test(controls) &&
    /결제링크 발송/.test(controls) &&
    /결제링크 발송 실패/.test(controls),
  'Next payment controls must include a PayApp payment-link button'
);

console.log('payapp-payment-link static checks OK');
