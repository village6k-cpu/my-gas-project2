const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'apps/today-dashboard/components/HandoverChecklist.tsx'), 'utf8');
const status = fs.readFileSync(path.join(root, 'apps/today-dashboard/lib/domain/status.ts'), 'utf8');

// 세트 그룹화/판정 헬퍼는 status.ts 단일 소스 — 진행도 카운트와 렌더가 같은 규칙을 쓰도록 일원화
assert(
  /export function singleControllableSetItem\(/.test(status) && /export function realDeviceHeaders\(/.test(status),
  'set grouping helpers must live in status.ts as the single source for both rendering and progress count'
);
assert(
  /import \{[^}]*singleControllableSetItem[^}]*\} from "@\/lib\/domain\/status"/.test(source) &&
    /import \{[^}]*realDeviceHeaders[^}]*\} from "@\/lib\/domain\/status"/.test(source),
  'handover checklist must import the shared set helpers instead of redefining them locally'
);
assert(
  /const singleSetItem = singleControllableSetItem\(g\)/.test(source),
  'set rendering must compute the single controllable set row for each set group'
);
assert(
  /singleSetItem \? \([\s\S]*?<SetSingleList key=\{g\.key\}>[\s\S]*?<CheckoutRow[\s\S]*?e=\{singleSetItem\}[\s\S]*?setBadge setTone/.test(source),
  'single-row sets must render as one checkout row with set badge + tone (checkbox, exclude, quantity, memo)'
);
// 구성품이 있는 세트의 대표행(=실제 메인 장비)은 SetBox headerRow로 인터랙티브하게 노출
assert(
  /<SetBox[\s\S]*?headerRow=\{realDeviceHeaders\(g\)\.map\(\(header\)[\s\S]*?<CheckoutRow[\s\S]*?e=\{header\}[\s\S]*?setBadge setTone/.test(source),
  'all real-device set headers must render as interactive checkout rows via SetBox headerRow'
);
assert(
  /<SetBox[\s\S]*?name=\{g\.setName\}[\s\S]*?>[\s\S]*?g\.rows\.map/.test(source),
  'multi-row sets must still render as a grouped set box with component rows'
);
assert(
  /function CheckoutRow\([\s\S]*?setBadge = false/.test(source),
  'checkout rows must accept a setBadge flag so standalone set equipment is labelled'
);
assert(
  source.includes('setBadge && <span') && source.includes('>세트</span>'),
  'standalone/main set rows must show a compact set badge'
);

console.log('today-dashboard set header controls static checks passed');
