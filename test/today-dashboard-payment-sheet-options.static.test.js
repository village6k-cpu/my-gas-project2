const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const controls = read('apps/today-dashboard/components/PaymentControls.tsx');
const store = read('apps/today-dashboard/lib/data/store.ts');
const backend = read('checkAvailability.js');

assert.match(
  backend,
  /paymentOptions:\s*getTradePaymentOptions_\(\)[\s\S]*proofTypeOptions:\s*getTradeProofTypeOptions_\(\)[\s\S]*depositStatusOptions:\s*getTradeDepositStatusOptions_\(\)/,
  'GAS dashboard payload must expose the sheet-derived payment/proof/deposit dropdown options'
);

assert.match(
  controls,
  /gasRead\("dashboard"/,
  'Next payment controls must load dropdown options from the GAS dashboard payload'
);

assert.match(
  controls,
  /paymentOptions:\s*readOptions\(data\.paymentOptions,\s*FALLBACK_PAYMENT_OPTIONS\)/,
  'Next 결제수단 dropdown must use sheet-derived paymentOptions with GAS fallback'
);

assert.match(
  controls,
  /proofTypeOptions:\s*readOptions\(data\.proofTypeOptions,\s*FALLBACK_PROOF_TYPE_OPTIONS\)/,
  'Next 증빙 dropdown must use sheet-derived proofTypeOptions with GAS fallback'
);

assert.match(
  controls,
  /depositStatusOptions:\s*readOptions\(data\.depositStatusOptions,\s*FALLBACK_DEPOSIT_STATUS_OPTIONS\)/,
  'Next 입금상태 dropdown must use sheet-derived depositStatusOptions with GAS fallback'
);

assert.match(
  controls,
  /billingCompanyOptions:\s*readOptions\(data\.billingCompanyOptions,\s*\[\]\)/,
  'Next 발행처 dropdown must use sheet-derived billingCompanyOptions'
);

assert.match(
  controls,
  /<Select label="발행처"[\s\S]{0,180}options=\{withCurrentOption\(options\.billingCompanyOptions,\s*trade\.billingCompany\)\}/,
  'Next 발행처 control must render as the same real Select dropdown used by the other payment controls'
);

assert.doesNotMatch(
  controls,
  /<datalist|list=\{billingDatalistId\}|billing-known-/,
  'Next 발행처 control must not rely on datalist autocomplete'
);

assert.doesNotMatch(
  controls,
  /const PAY = \[/,
  'Next 결제수단 options must not be hardcoded in PaymentControls'
);

assert.match(
  controls,
  /function withCurrentOption\(options: string\[\], value\?: string\)/,
  'dropdowns must keep the current sheet value visible even if it is missing from the latest validation list'
);

assert.match(
  store,
  /export async function setPaymentMethod\(tradeId: string, method: string\)[\s\S]*gasMutation\("updatePayment",\s*\{ tid: tradeId, method \}\)/,
  'setPaymentMethod must await updatePayment so card-payment side effects can be applied locally'
);

assert.match(
  store,
  /sideEffects\.columns\.K[\s\S]*proofType[\s\S]*sideEffects\.columns\.L[\s\S]*issueStatus[\s\S]*sideEffects\.columns\.M[\s\S]*depositStatus/,
  'card-payment side effects from GAS must update proofType, issueStatus, and depositStatus in the Next store'
);

assert.match(
  store,
  /export async function setBillingCompany\(tradeId: string,\s*billingCompany: string\)[\s\S]*gasMutation\("updateBillingCompany",\s*\{ tid: tradeId,\s*billingCompany \}\)/,
  'setBillingCompany must await updateBillingCompany so GAS validation errors are not silently ignored'
);

console.log('today-dashboard payment sheet option parity checks passed');
