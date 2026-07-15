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
