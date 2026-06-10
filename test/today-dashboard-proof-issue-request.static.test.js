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
  /gasMutation\("updateTradeProof", \{ tid: tradeId, field: "issueStatus", value: "발행요청" \}\)/.test(store),
  'requestProofIssue must route through the GAS 발행요청 path, not direct 발행완료 writes'
);
assert(
  /issueStatus: result\.issueStatus \|\| "발행완료"/.test(store) &&
    /issueStatus: "전송실패"/.test(store),
  'requestProofIssue must reflect success and failure statuses back into the card'
);

console.log('today-dashboard proof issue request static checks passed');
