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
  /confirmRows\.forEach\(function\(row\) \{[\s\S]{0,80}sheet\.getRange\(row,\s*8\)\.setValue\("확인"\);[\s\S]{0,20}\}\);/,
  'manual recheck should mark H-blank pending rows as confirmed before processing'
);

assert.match(
  source,
  /if \(aVal\) \{[\s\S]{0,80}preparePendingConfirmRows_\(sheet,\s*row,\s*aVal\);[\s\S]{0,80}processByReqID\(sheet,\s*row\)/,
  'all request groups should prepare the trigger row and H-blank rows before running the normal set-expansion path'
);

assert.match(
  source,
  /const setComponents = getSetComponents\(ri\.장비명,\s*setSheet\);[\s\S]{0,220}if \(!hasExisting\) \{[\s\S]{0,120}expandSetRows\(sheet,\s*ri\.row,\s*triggerReqID,\s*setComponents,\s*ri\.수량\);[\s\S]{0,80}expandedRows = true;/,
  'manual recheck must still use the normal set expansion path when a pending set row has no existing components'
);

assert.match(
  source,
  /if \(fResult === "세트" \|\| \(setMasterNames\.has\(fEquip\) && fQTag\.indexOf\("\[세트\]"\) !== 0\)\) \{[\s\S]{0,100}sheet\.getRange\(fRow,\s*6\)\.setBackground\("#D9EAD3"\)\.setFontWeight\("bold"\);/,
  'manual recheck must keep set header and set-master rows green in column F'
);

assert.match(
  source,
  /if \(isFirstRow\) \{[\s\S]{0,220}if \(fResult === "세트" \|\| \(setMasterNames\.has\(fEquip\) && fQTag\.indexOf\("\[세트\]"\) !== 0\)\) \{[\s\S]{0,100}sheet\.getRange\(fRow,\s*6\)\.setBackground\("#D9EAD3"\)\.setFontWeight\("bold"\);/,
  'manual recheck must keep the top/main set row green in column F even when the row itself uses the blue request-group background'
);

assert.doesNotMatch(
  source,
  /if \(aVal && hasProcessedRows_\(sheet,\s*row,\s*aVal\)\)/,
  'manual recheck must not depend on other rows already having results'
);

assert.doesNotMatch(
  source,
  /function clearRequestAvailabilityResults_\(sheet,\s*reqID\)/,
  'manual recheck must not clear the entire request group anymore'
);

console.log('confirm request recheck static checks passed');
