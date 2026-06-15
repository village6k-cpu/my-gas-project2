const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const checkAvailability = read('checkAvailability.js');
const sheetApi = read('sheetAPI.js');

assert.match(
  checkAvailability,
  /function getContractStatusOptions_\(\)\s*{[\s\S]{0,120}return \["예약", "반출", "취소", "반납완료"\]/,
  'contract status dropdown options must match the allowed contract statuses'
);

assert.match(
  checkAvailability,
  /function getContractStatusValidationRule_[\s\S]{0,260}requireValueInList\(getContractStatusOptions_\(\), true\)[\s\S]{0,120}\.setAllowInvalid\(false\)/,
  'contract status validation must use a visible dropdown and reject invalid values'
);

assert.match(
  checkAvailability,
  /function formatContractSheet[\s\S]{0,2200}applyContractStatusValidation_\(sheet, fullRows\)/,
  'formatContractSheet must restore the contract status dropdown when formatting 계약마스터'
);

assert.match(
  checkAvailability,
  /function inspectContractStatusValidation\(\)/,
  'contract status validation inspection function must exist'
);

assert.match(
  checkAvailability,
  /function restoreContractStatusDropdown\(\)/,
  'contract status dropdown restore function must exist'
);

assert.match(
  sheetApi,
  /"formatContractSheet",[\s\S]{0,140}"inspectContractStatusValidation",[\s\S]{0,80}"restoreContractStatusDropdown"/,
  'contract status validation functions must be exposed through runFunction allowlist'
);

assert.match(
  sheetApi,
  /formatContractSheet: typeof formatContractSheet[\s\S]{0,220}inspectContractStatusValidation: typeof inspectContractStatusValidation[\s\S]{0,220}restoreContractStatusDropdown: typeof restoreContractStatusDropdown/,
  'contract status validation functions must be callable through runFunction globals'
);

console.log('contract status dropdown static checks passed');
