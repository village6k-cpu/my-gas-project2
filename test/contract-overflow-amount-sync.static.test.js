const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'generatecontract.js'), 'utf8');

assert.match(
  source,
  /function expandContractItemTableIfNeeded_\(ws,\s*rows,\s*requiredRowsPerSide\)[\s\S]*insertRowsBefore\(insertAt,\s*extraRows\)[\s\S]*restoreContractItemMergedCells_/,
  'contract generation must expand the item table instead of relying on a fixed row count'
);

assert.match(
  source,
  /Math\.ceil\(combinedItems\.length\s*\/\s*2\)/,
  'required item rows must be derived from the full item count'
);

assert.doesNotMatch(
  source,
  /combinedItems\.length\s*<\s*ITEMS_PER_SIDE\s*\*\s*2/,
  'additional request items must not be silently truncated at the old table capacity'
);

assert.match(
  source,
  /const finalAmount\s*=\s*readContractAmount_\(ws,\s*paymentRefs\.finalAmountCell\)[\s\S]*updateContractLink\(거래ID,\s*newUrl,\s*finalAmount\)/,
  'contract generation must pass the final contract amount to the linked trade row updater'
);

assert.match(
  source,
  /function updateContractLink\(거래ID,\s*contractUrl,\s*finalAmount\)[\s\S]*getRange\(i \+ 2,\s*9\)[\s\S]*setValue\(Number\(finalAmount\)\)/,
  'updateContractLink must sync the final contract amount into 거래내역 I열'
);

assert.match(
  source,
  /function getGeneratedContractSummary_\(fileId\)[\s\S]*findContractPaymentRefs_\(ws,\s*rows\)[\s\S]*itemRowsPerSide/,
  'contract summary must report dynamic item rows and dynamic payment cells'
);

console.log('contract overflow and amount sync static checks passed');
