const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const checkAvailability = read('checkAvailability.js');
const sheetApi = read('sheetAPI.js');
const gasRoute = read('apps/today-dashboard/app/api/gas/route.ts');
const writeback = read('apps/today-dashboard/lib/data/writeback.ts');
const store = read('apps/today-dashboard/lib/data/store.ts');
const paymentControls = read('apps/today-dashboard/components/PaymentControls.tsx');

assert(
  checkAvailability.includes('📄 계약서 생성/재생성'),
  'Google Sheet menu must expose regeneration, not only creation'
);

assert(
  /case "regenerateContract":[\s\S]{0,600}regenerateContractById/.test(sheetApi),
  'sheetAPI must expose a first-class regenerateContract action'
);

assert(
  gasRoute.includes('"regenerateContract"'),
  'Next GAS proxy must whitelist the regenerateContract write action'
);

assert(
  /export async function gasMutation/.test(writeback) &&
    /gasFetch\(qs\.toString\(\)\)/.test(writeback) &&
    /throw new Error/.test(writeback),
  'writeback layer must provide a result-returning GAS mutation helper'
);

assert(
  /export async function regenerateContract\(tradeId: string\)/.test(store),
  'store must expose regenerateContract for UI use'
);

assert(
  /contractRegenPending: true/.test(store) &&
    /gasMutation\("regenerateContract", \{ tid: tradeId \}\)/.test(store) &&
    /contractUrl: url \|\| t\.contractUrl/.test(store) &&
    /contractRegenPending: false/.test(store),
  'regenerateContract must set pending, call GAS, apply the returned URL, and clear pending'
);

assert(
  paymentControls.includes('regenerateContract') &&
    paymentControls.includes('계약서 재생성') &&
    paymentControls.includes('재생성 중'),
  'PaymentControls must render a visible contract regeneration button'
);

['dashboard.html', 'docs/dashboard.html'].forEach((file) => {
  const html = read(file);
  assert(
    /계약서 재생성/.test(html) &&
      /startDashboardContractRegeneration/.test(html),
    `${file} must expose manual contract regeneration on the legacy schedule dashboard`
  );
});

console.log('today-dashboard contract regenerate action static checks passed');
