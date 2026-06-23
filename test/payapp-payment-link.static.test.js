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
const gasProxy = read('apps/today-dashboard/app/api/gas/route.ts');

assert(
  /case "sendPayAppPaymentLink":/.test(api) &&
    /case "getPayAppPaymentRequest":/.test(api) &&
    /case "sendPayAppTestPaymentLink":/.test(api) &&
    /requestPayAppPaymentLink\(/.test(api) &&
    /getPayAppPaymentRequest\(/.test(api) &&
    /requestPayAppTestPaymentLink\(/.test(api) &&
    /case "setupPayAppUserId":/.test(api) &&
    /case "setupPayAppPaymentTypes":/.test(api) &&
    /case "diagPayAppConfig":/.test(api),
  'sheetAPI must expose PayApp send/test/setup/payment-type diagnostic actions'
);

assert(
  /function requestPayAppPaymentLink\(tid\)/.test(ca) &&
    /function getPayAppPaymentRequest\(tid\)/.test(ca) &&
    /function requestPayAppTestPaymentLink\(args\)/.test(ca) &&
    /function setupPayAppUserId\(userid\)/.test(ca) &&
    /function setupPayAppPaymentTypes\(openpaytype\)/.test(ca) &&
    /function diagPayAppConfig\(\)/.test(ca) &&
    /function sendPayAppPaymentRequest_\(request\)/.test(ca) &&
    /function normalizePayAppOpenpaytype_\(value\)/.test(ca) &&
    ca.includes('https://api.payapp.kr/oapi/apiLoad.html') &&
    ca.includes("cmd: 'payrequest'") &&
    ca.includes('PAYAPP_USERID') &&
    ca.includes('PAYAPP_OPENPAYTYPE') &&
    ca.includes('PAYAPP_FEEDBACK_URL') &&
    ca.includes('actualAmount') &&
    ca.includes('recvphone') &&
    ca.includes('payurl') &&
    ca.includes('mul_no') &&
    /PAYAPP_REQ_/.test(ca),
  'GAS must build, send, and expose PayApp payrequests from trade and test data'
);

assert(
  /price:\s*String\(amount\)/.test(ca) &&
    /getTradeExtrasForIds_\(\[tid\],\s*null,\s*\{\s*forceFresh:\s*true\s*\}\)/.test(ca) &&
    /거래내역에서 거래ID를 찾지 못했습니다/.test(ca) &&
    /tradeRowFound:\s*false/.test(ca) &&
    /extra\.tradeRowFound\s*=\s*true/.test(ca) &&
    /var1:\s*tid/.test(ca) &&
    /VILLAGE 렌탈 결제/.test(ca) &&
    /PAYAPP-TEST-/.test(ca) &&
    /VILLAGE 테스트 결제/.test(ca) &&
    /PAYAPP_TEST_REQ_/.test(ca) &&
    /kakaopay,naverpay,tosspay,card/.test(ca) &&
    /openpaytype:\s*openpaytype/.test(ca),
  'PayApp request must use trade data and keep a safe test-only path'
);

assert(
  /결제링크 발송/.test(dashboard) &&
    /결제링크 확인/.test(dashboard) &&
    /runTradeOpsAction\(this,[\s\S]{0,140}sendPayAppPaymentLink/.test(dashboard) &&
    /runPayAppPaymentRequestLookup\(this,[\s\S]{0,140}getPayAppPaymentRequest/.test(dashboard) &&
    /formatPayAppPaymentRequestResult/.test(dashboard) &&
    /buildPayAppConfirmText\(tradeId\)/.test(dashboard) &&
    /결제링크 발송 실패/.test(dashboard) &&
    /결제링크 발송 완료/.test(dashboard),
  'classic dashboard must confirm PayApp payment-link details before sending'
);

assert(
  /결제링크 발송/.test(docsDashboard) &&
    /결제링크 확인/.test(docsDashboard) &&
    /runTradeOpsAction\(this,[\s\S]{0,140}sendPayAppPaymentLink/.test(docsDashboard) &&
    /runPayAppPaymentRequestLookup\(this,[\s\S]{0,140}getPayAppPaymentRequest/.test(docsDashboard) &&
    /formatPayAppPaymentRequestResult/.test(docsDashboard) &&
    /buildPayAppConfirmText\(tradeId\)/.test(docsDashboard) &&
    /결제링크 발송 실패/.test(docsDashboard) &&
    /결제링크 발송 완료/.test(docsDashboard),
  'GitHub Pages dashboard must confirm PayApp payment-link details before sending'
);

assert(
  /export async function sendPayAppPaymentLink\(tradeId: string\)/.test(store) &&
    /gasMutation\("sendPayAppPaymentLink",\s*\{ tid: tradeId \}\)/.test(store) &&
    /export async function getPayAppPaymentRequest\(tradeId: string\)/.test(store) &&
    /gasRead\("getPayAppPaymentRequest",\s*\{ tid: tradeId \}\)/.test(store),
  'Next store must expose PayApp payment-link send and lookup actions'
);

assert(
  /const WRITE_ACTIONS = new Set\(\[[\s\S]*"sendPayAppPaymentLink"/.test(gasProxy) &&
    /const READ_ACTIONS = new Set\(\[[\s\S]*"getPayAppPaymentRequest"/.test(gasProxy),
  'Next GAS proxy must allow PayApp payment-link write and lookup actions'
);

assert(
  /sendPayAppPaymentLink/.test(controls) &&
    /getPayAppPaymentRequest/.test(controls) &&
    /결제링크 발송/.test(controls) &&
    /결제링크 확인/.test(controls) &&
    /formatPayAppPaymentRequestResult/.test(controls) &&
    /payurl/.test(controls) &&
    /mulNo/.test(controls) &&
    /buildPayAppConfirmMessage\(trade\)/.test(controls) &&
    /window\.confirm\(buildPayAppConfirmMessage\(trade\)\)/.test(controls) &&
    /결제링크 발송 실패/.test(controls),
  'Next payment controls must confirm PayApp payment-link details before sending'
);

console.log('payapp-payment-link static checks OK');
