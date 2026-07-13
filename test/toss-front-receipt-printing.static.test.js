const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const exists = (file) => fs.existsSync(path.join(root, file));

const app = read('toss-front-plugin/village-front/app.js');
const receiptsRoutePath = 'apps/today-dashboard/app/api/lookup/receipts/route.ts';

assert(
  exists(receiptsRoutePath),
  'receipt reprint API route must exist separately from payable lookup'
);
const receiptsRoute = read(receiptsRoutePath);

assert(
  app.includes('영수증 재출력') &&
    app.includes('async function lookupReceipts') &&
    app.includes('/api/lookup/receipts'),
  'front plugin must expose receipt lookup through its dedicated API'
);

assert(
  app.includes('rememberReceiptRecord') &&
    app.includes('RECEIPT_RECORDS_KEY') &&
    app.includes('attachStoredReceiptKeys'),
  'successful Toss paymentKeys must be kept locally for official reprints'
);

assert(
  /matches\.filter\(function \(m\) \{ return m && m\.paymentKey; \}\)/.test(app),
  'reservation receipt lookup must hide historical rows without a locally stored Toss paymentKey'
);

assert(
  /sdk\.printer\.printReceipt\(\{\s*paymentKey:\s*paymentKey/.test(app),
  'front plugin must use the official Toss printReceipt API'
);

assert(
  !/sdk\.printer\.print\(/.test(app) &&
    !app.includes('buildLegacyReceiptBytes') &&
    !app.includes('거래 영수증'),
  'front plugin must not generate unofficial raw receipts for rows without paymentKey'
);

assert(
  receiptsRoute.includes('LOOKUP_CORS_HEADERS') &&
    receiptsRoute.includes('x-lookup-token') &&
    /export async function OPTIONS\(\)/.test(receiptsRoute),
  'receipt lookup API must keep the Toss Front CORS and token contract'
);

assert(
  receiptsRoute.includes('new Set(["입금완료"])') &&
    !receiptsRoute.includes('"부분입금"'),
  'receipt lookup must exclude partial payments because the ledger has no paid-amount field'
);

assert(
  !receiptsRoute.includes('TOSS_FRONT_LOOKUP_START_DATE') &&
    !receiptsRoute.includes('isTerminalPayableTrade'),
  'receipt lookup must remain separate from payable-search cutoff logic'
);

console.log('toss-front official receipt printing static checks passed');
