const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const backend = fs.readFileSync(path.join(root, 'checkAvailability.js'), 'utf8');

assert(
  /function clearConfirmRequestRowPreservingFormulas_\(sheet, row\)/.test(backend) &&
    /var lFormula = sheet\.getRange\(row, 12\)\.getFormula\(\)/.test(backend) &&
    /sheet\.getRange\(row, 1, 1, 18\)\.clearContent\(\)/.test(backend) &&
    /if \(lFormula\) sheet\.getRange\(row, 12\)\.setFormula\(lFormula\)/.test(backend),
  'autoClearRequests must clear A~R including L열 phone values, then restore only an existing L열 formula'
);

assert(
  /function clearConfirmRequestRowPreservingFormulas_\(sheet, row\)[\s\S]*?sheet\.getRange\(row, 1, 1, 18\)\.setBackground\(null\)/.test(backend),
  'autoClearRequests must reset formatting through R열 when clearing a registered request row'
);

assert(
  /function doClearRequests\([\s\S]*?const lFormulas = sheet\.getRange\(2, 12, lastRow - 1, 1\)\.getFormulas\(\)/.test(backend) &&
    /sheet\.getRange\(2, 1, lastRow - 1, 18\)\.clearContent\(\)/.test(backend) &&
    /sheet\.getRange\(2, 12, lastRow - 1, 1\)\.setFormulas\(lFormulas\)/.test(backend),
  'manual 확인요청 초기화 must clear A~R including L열 phone values, then restore only L열 formulas'
);

assert(
  /function doClearRequests\([\s\S]*?sheet\.getRange\(2, 1, lastRow - 1, 18\)\.setBackground\(null\)/.test(backend),
  'manual 확인요청 초기화 must reset formatting through R열'
);

assert(
  !/L열\(12\) 수식 보존: A~K, M~R 삭제/.test(backend) &&
    !/sheet\.getRange\(row, 1, 1, 11\)\.clearContent\(\)[\s\S]*?sheet\.getRange\(row, 13, 1, 6\)\.clearContent\(\)/.test(backend),
  'old split-clear path skipped L열 entirely and left orphan phone numbers behind'
);

assert(
  /function isOrphanContactOnlyRequestRow_\(sheet, row, values\)/.test(backend) &&
    /var contact = String\(values\[11\] \|\| ""\)\.trim\(\)/.test(backend) &&
    /values\.slice\(0, 11\)\.every\(isBlankConfirmRequestCell_\)/.test(backend) &&
    /values\.slice\(12, 18\)\.every\(isBlankConfirmRequestCell_\)/.test(backend),
  'autoClearRequests must detect existing orphan rows where only L열 contact survived'
);

assert(
  /if \(isOrphanContactOnlyRequestRow_\(sheet, row, data\[i\]\)\) \{[\s\S]*?clearConfirmRequestRowPreservingFormulas_\(sheet, row\)/.test(backend),
  'autoClearRequests must clean already-orphaned contact-only rows, not only future registered reqID groups'
);

console.log('confirm-request-clear-r-column.static.test.js OK');
