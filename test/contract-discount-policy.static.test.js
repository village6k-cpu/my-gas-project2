const assert = require('assert');
const fs = require('fs');
const path = require('path');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'generatecontract.js'), 'utf8');

assert.match(
  source,
  /function getDiscountMultiplierFormula_\(\)[\s\S]{0,700}\.join\("\*"\)/,
  'contract discount policy must multiply discount factors instead of summing discount rates'
);

assert.match(
  source,
  /ws\.getRange\("H46"\)\.setFormula\("=J42\*\(" \+ discountMultiplier \+ "\)"\)/,
  'H46 payment amount must apply the multiplicative discount multiplier'
);

assert.doesNotMatch(
  source,
  /getDiscountSumFormula_/,
  'additive discount helper must not remain'
);

assert.doesNotMatch(
  source,
  /MIN\(1,\s*["']?\s*\+\s*discountSum|1-MIN\(1,/,
  'contract payment formula must not cap a summed discount rate'
);

assert.doesNotMatch(
  source,
  /parseManualFinalPaymentAmount_|manualFinalAmount|setValue\(manualFinalAmount\)/,
  'manual final-payment overrides must not bypass multiplicative discount calculation'
);

assert.match(
  source,
  /학생30%.*장기20%[\s\S]{0,260}0\.7\s*[×x*]\s*0\.8|0\.7\s*[×x*]\s*0\.8[\s\S]{0,260}학생30%.*장기20%/,
  'source comments must document that student 30% plus long-term 20% is multiplicative'
);

console.log('contract discount policy static checks passed');
