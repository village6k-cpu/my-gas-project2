const assert = require('assert');
const fs = require('fs');
const path = require('path');
const app = fs.readFileSync(path.join(__dirname, '..', 'toss-front-plugin/village-front/app.js'), 'utf8');

assert(app.includes('function normalizePaymentResponse(response, amount)'));
assert(app.includes('function hasCancelDetails(record)'));
assert(/paymentMethod:\s*normalized\.paymentMethod/.test(app));
assert(/timestamp:\s*normalized\.timestamp/.test(app));
assert(/installment:\s*normalized\.installment/.test(app));
assert(/extraData:\s*normalized\.extraData/.test(app));
assert(/tax:\s*normalized\.tax/.test(app));
assert(/supplyValue:\s*normalized\.supplyValue/.test(app));

assert(app.includes('async function hydrateCancelRecord(record)'));
assert(app.includes('async function requestFullPaymentCancel(record)'));
assert(app.includes('async function markPaymentCancelled(record, cancelDetail)'));
assert(app.includes('async function syncCancelledReservation(record)'));
assert(app.includes('async function retryPendingCancelSyncs()'));
assert(app.includes('async function showCancelablePayments()'));
assert(/sdk\.payment\.requestPaymentCancel\(\{/.test(app));
assert(/sdk\.payment\.getPaymentCancel\(\{\s*paymentKey:/.test(app));
assert(/paymentMethod:\s*record\.paymentMethod/.test(app));
assert(/timestamp:\s*record\.timestamp/.test(app));
assert(/approvalNumber:\s*record\.approvalNumber/.test(app));
assert(/installment:\s*record\.installment\s*\|\|\s*0/.test(app));
assert(/timeoutMs:\s*60000/.test(app));
assert(/!record\.cancelledAt/.test(app));
assert(/\.slice\(0,\s*20\)/.test(app));
assert(app.includes('cancelledAt'));
assert(app.includes('cancelApprovalNumber'));
assert(app.includes('cancelSyncPending'));
assert(app.includes('cancelInFlight'));
assert(/record\.sourceType\s*===\s*['"]reservation['"]/.test(app));
assert(app.includes('/api/lookup/cancel'));
assert(/record\.cancelledAt\s*&&\s*record\.cancelSyncPending/.test(app));

console.log('toss-front payment cancel static checks passed');
