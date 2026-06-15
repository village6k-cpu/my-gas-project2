const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const backend = fs.readFileSync(path.join(root, 'checkAvailability.js'), 'utf8');

assert(
  /function autoClearRequests\([\s\S]*?sheet\.getRange\(row, 13, 1, 6\)\.clearContent\(\)/.test(backend),
  'autoClearRequests must clear M~R, not M~Q, so registered 확인요청 rows do not leave orphan 추가요청 text in R열'
);

assert(
  /function autoClearRequests\([\s\S]*?sheet\.getRange\(row, 13, 1, 6\)\.setBackground\(null\)/.test(backend),
  'autoClearRequests must reset formatting through R열 when clearing a registered request row'
);

assert(
  /function doClearRequests\([\s\S]*?sheet\.getRange\(2, 13, lastRow - 1, 6\)\.clearContent\(\)/.test(backend),
  'manual 확인요청 초기화 must clear M~R while preserving only L열 formulas'
);

assert(
  /function doClearRequests\([\s\S]*?sheet\.getRange\(2, 13, lastRow - 1, 6\)\.setBackground\(null\)/.test(backend),
  'manual 확인요청 초기화 must reset formatting through R열'
);

console.log('confirm-request-clear-r-column.static.test.js OK');
