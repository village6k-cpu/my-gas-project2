const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(
  path.resolve(__dirname, '..', 'checkAvailability.js'),
  'utf8'
);

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist in checkAvailability.js`);

  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`${name} function body is incomplete`);
}

function loadPlanner() {
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    [
      extractFunction('_normalizeDiscountTypeOrBlank_'),
      extractFunction('_confirmRequestPhoneKey_'),
      extractFunction('_planCustomerDbRegistrationWrite_'),
      'this.planCustomerDbWrite = _planCustomerDbRegistrationWrite_;',
    ].join('\n'),
    context
  );
  return context.planCustomerDbWrite;
}

function customerRow(phone, name, discount = '') {
  return [phone, name, '', '', '', '', '', '', discount];
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test('registration fills a blank customer DB discount from the confirmed reservation value', () => {
  const plan = loadPlanner();
  const rows = [customerRow('010-1111-2222', '기존고객')];

  assert.deepEqual(
    plain(plan(rows, '기존고객', '01011112222', '학생')),
    { action: 'update-discount', sheetRow: 2, discount: '학생' }
  );
});

test('registration accepts every supported confirmed discount type', () => {
  const plan = loadPlanner();
  const rows = [customerRow('010-1111-2222', '기존고객')];

  for (const discount of ['일반', '학생', '개인사업자/프리랜서', '단골', '제휴']) {
    assert.deepEqual(
      plain(plan(rows, '기존고객', '010-1111-2222', discount)),
      { action: 'update-discount', sheetRow: 2, discount }
    );
  }
});

test('registration never overwrites an existing customer DB discount', () => {
  const plan = loadPlanner();
  const rows = [customerRow('010-1111-2222', '기존고객', '단골')];

  assert.deepEqual(
    plain(plan(rows, '기존고객', '010-1111-2222', '학생')),
    { action: 'keep-existing', sheetRow: 2, discount: '단골' }
  );
});

test('registration creates a new customer with the confirmed discount', () => {
  const plan = loadPlanner();
  const rows = [customerRow('010-9999-0000', '동명이인')];

  assert.deepEqual(
    plain(plan(rows, '동명이인', '010-3333-4444', '제휴')),
    { action: 'append', discount: '제휴' }
  );
});

test('registration does not invent a discount when the reservation value is blank or invalid', () => {
  const plan = loadPlanner();
  const rows = [customerRow('010-1111-2222', '기존고객')];

  assert.deepEqual(
    plain(plan(rows, '기존고객', '010-1111-2222', '')),
    { action: 'keep-blank', sheetRow: 2, discount: '' }
  );
  assert.deepEqual(
    plain(plan([], '신규고객', '010-5555-6666', '임의할인')),
    { action: 'append', discount: '' }
  );
});

test('registerByReqID applies the plan to customer DB column I', () => {
  assert.match(
    source,
    /var 고객쓰기계획 = _planCustomerDbRegistrationWrite_\(고객data, 예약자명, 연락처, 할인유형\)/
  );
  assert.match(
    source,
    /고객쓰기계획\.action === "update-discount"[\s\S]{0,220}getRange\(고객쓰기계획\.sheetRow, 9\)\.setValue\(고객쓰기계획\.discount\)/
  );
  assert.match(
    source,
    /고객쓰기계획\.action === "append"[\s\S]{0,420}getRange\(고객newRow, 9\)\.setValue\(고객쓰기계획\.discount\)/
  );
});
