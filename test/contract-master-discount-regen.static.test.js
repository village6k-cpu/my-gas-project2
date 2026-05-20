const assert = require('assert');
const fs = require('fs');
const path = require('path');

const codeSource = fs.readFileSync(path.resolve(__dirname, '..', 'Code.js'), 'utf8');
const availabilitySource = fs.readFileSync(path.resolve(__dirname, '..', 'checkAvailability.js'), 'utf8');
const contractSource = fs.readFileSync(path.resolve(__dirname, '..', 'generatecontract.js'), 'utf8');

assert.match(
  codeSource,
  /sheet\.getName\(\)\s*===\s*"계약마스터"\s*&&\s*col\s*===\s*11\s*&&\s*row\s*>=\s*2/,
  'contract master K-column discount edits must be handled by onEditInstallable'
);

assert.match(
  codeSource,
  /할인유형[\s\S]{0,260}getNumRows[\s\S]{0,700}scheduleContractRegen\(discountTradeId\)/,
  'discount edits should support multi-row edits and schedule contract regeneration per transaction'
);

assert.match(
  availabilitySource,
  /if \(allData\[i\]\[12\]\) \{ 할인유형 = allData\[i\]\[12\]; \}/,
  '확인요청 M열 할인유형 must be read during registration'
);

assert.match(
  availabilitySource,
  /contractSheet\.getRange\(newContractRow,\s*1,\s*1,\s*12\)\.setValues\(\[\[[\s\S]{0,260}회차,\s*"예약",\s*할인유형\s*\|\|\s*"일반",\s*""/,
  'new contract rows must write 확인요청 할인유형 into 계약마스터 K열'
);

assert.match(
  contractSource,
  /할인유형:\s*String\(contractData\[i\]\[10\]\s*\|\|\s*""\)\.trim\(\)\s*\/\/ K열/,
  'contract regeneration must read 계약마스터 K열 할인유형'
);

assert.match(
  contractSource,
  /switch \(String\(contract\.할인유형 \|\| ""\)\.trim\(\)\)[\s\S]{0,420}case "학생":[\s\S]{0,220}case "개인사업자\/프리랜서":[\s\S]{0,220}case "단골":[\s\S]{0,220}case "제휴":/,
  'contract generation must map supported 할인유형 values into contract discount cells'
);

console.log('contract master discount regeneration static checks passed');
