const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const controls = read('apps/today-dashboard/components/PaymentControls.tsx');
const store = read('apps/today-dashboard/lib/data/store.ts');

assert(
  controls.includes('requestProofIssue'),
  'PaymentControls must call a real proof issue request instead of directly writing 발행완료'
);
assert(
  !/const ISSUE\s*=\s*\[[^\]]*["']발행완료["']/.test(controls),
  'invoice UI must not offer 발행완료 as a manually selectable issue status'
);
assert(
  controls.includes('계산서 발행요청') &&
    /window\.confirm\([\s\S]*실제 발행/.test(controls),
  'invoice UI must expose an explicit confirmed issue request action'
);
assert(
  /requestProofIssue\(trade\.tradeId\)/.test(controls),
  'confirmed invoice issue action must call requestProofIssue with the trade id'
);
assert(
  /export async function requestProofIssue\(tradeId: string\)/.test(store),
  'store must expose an async requestProofIssue mutation'
);
assert(
  /gasMutation\("updateTradeProof",\s*\{[\s\S]{0,220}tid:\s*tradeId,[\s\S]{0,220}field:\s*"issueStatus",[\s\S]{0,220}value:\s*"발행요청",[\s\S]{0,220}mutationId:\s*createLedgerMutationId\("proof-issue"\)/.test(store),
  'requestProofIssue must route through an idempotency-keyed GAS 발행요청 path, not direct 발행완료 writes'
);
assert(
  /issueStatus: result\.issueStatus \|\| "발행완료"/.test(store) &&
    /issueStatus: previous\.issueStatus/.test(store) &&
    store.includes('거래내역 확인 전에는 다시 발행하지 마세요'),
  'requestProofIssue must only mark confirmed success and retain the prior status when the outcome is unknown'
);
assert(
  /function isPositiveExternalActionResult_/.test(store) &&
    /result\.success === true \|\| String\(result\.status \|\| ""\)\.trim\(\)\.toUpperCase\(\) === "OK"/.test(store),
  'external sends must require explicit positive success evidence'
);

console.log('today-dashboard proof issue request static checks passed');
