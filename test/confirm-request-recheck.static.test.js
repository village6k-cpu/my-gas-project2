const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'checkAvailability.js'), 'utf8');

assert.match(
  source,
  /function preparePendingConfirmRows_\(sheet,\s*triggerRow,\s*reqID\)/,
  'manual H-column confirmation must prepare only pending rows in the request group'
);

assert.match(
  source,
  /if \(row !== triggerRow && confirmVal\) continue;/,
  'manual recheck must skip already-confirmed rows and preserve their existing I/J results'
);

assert.match(
  source,
  /resultRanges\.push\("I" \+ row \+ ":J" \+ row\)/,
  'manual recheck should clear I/J only for the trigger row and H-blank pending rows'
);

assert.match(
  source,
  /if \(confirmRanges\.length\) sheet\.getRangeList\(confirmRanges\)\.setValue\("확인"\)/,
  'manual recheck should mark H-blank pending rows as confirmed before processing'
);

assert.match(
  source,
  /if \(aVal && hasProcessedRows_\(sheet,\s*row,\s*aVal\)\) \{[\s\S]{0,120}preparePendingConfirmRows_\(sheet,\s*row,\s*aVal\);[\s\S]{0,120}processByReqID\(sheet,\s*row\)/,
  'processed request groups should run the normal set-expansion path after preparing only pending rows'
);

assert.doesNotMatch(
  source,
  /function clearRequestAvailabilityResults_\(sheet,\s*reqID\)/,
  'manual recheck must not clear the entire request group anymore'
);

console.log('confirm request recheck static checks passed');
