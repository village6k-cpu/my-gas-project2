const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const checklistPath = path.join(root, 'apps/today-dashboard/components/HandoverChecklist.tsx');
const source = fs.readFileSync(checklistPath, 'utf8');

assert(
  source.includes('function sameSetName'),
  'handover checklist must compare set names before deciding whether to show a separate set header'
);
assert(
  source.includes('function singleControllableSetItem'),
  'single-row sets must be detected so their set header becomes the controllable equipment row'
);
assert(
  /const singleSetItem = singleControllableSetItem\(g\)/.test(source),
  'set rendering must compute the single controllable set row for each set group'
);
assert(
  /singleSetItem \? \([\s\S]*<LooseList key=\{g\.key\}>[\s\S]*<CheckoutRow[\s\S]*e=\{singleSetItem\}[\s\S]*setBadge/.test(source),
  'single-row sets must render as one checkout row with checkbox, exclude, quantity, and memo controls'
);
assert(
  /: \([\s\S]*<SetBox key=\{g\.key\} name=\{g\.setName\}>[\s\S]*g\.rows\.map/.test(source),
  'multi-row sets must still render as a grouped set box with component rows'
);
assert(
  /function CheckoutRow\([\s\S]*setBadge = false/.test(source),
  'checkout rows must accept a setBadge flag so standalone set equipment is labelled without duplicating the name'
);
assert(
  source.includes('setBadge && <span') && source.includes('>세트</span>'),
  'standalone set rows must show a compact set badge inside the single equipment row'
);

console.log('today-dashboard set header controls static checks passed');
