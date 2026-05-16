const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'checkAvailability.js'), 'utf8');

assert.match(
  source,
  /function shouldProcessAdditionalRow_\(sheet,\s*triggerRow,\s*reqID\)/,
  'manual H-column confirmation must distinguish new added rows from existing edited rows'
);

assert.match(
  source,
  /function clearRequestAvailabilityResults_\(sheet,\s*reqID\)/,
  'manual recheck must clear stale I/J availability results before running the full request group'
);

assert.match(
  source,
  /if \(aVal && shouldProcessAdditionalRow_\(sheet,\s*row,\s*aVal\)\)[\s\S]{0,160}processAdditionalRow_\(sheet,\s*row,\s*aVal\)/,
  'only truly new rows in an already processed request should use the partial additional-row path'
);

assert.match(
  source,
  /else \{[\s\S]{0,120}if \(aVal\) clearRequestAvailabilityResults_\(sheet,\s*aVal\);[\s\S]{0,120}processByReqID\(sheet,\s*row\)/,
  'existing edited rows should clear stale results and re-run processByReqID for the whole request'
);

assert.match(
  source,
  /return !resultVal && !detailVal && qTag\.indexOf\("\[세트\]"\) !== 0;/,
  'additional-row detection must reject rows that already have result/detail data or are set components'
);

console.log('confirm request recheck static checks passed');
