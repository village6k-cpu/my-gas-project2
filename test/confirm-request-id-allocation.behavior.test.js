const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'checkAvailability.js'), 'utf8');

class FakeRange {
  constructor(values) {
    this.values = values;
  }
  getValues() {
    return this.values;
  }
}

class FakeSheet {
  constructor(ids) {
    this.ids = ids;
  }
  getLastRow() {
    return this.ids.length + 1;
  }
  getRange(row, column, numRows, numColumns) {
    assert.equal(row, 2);
    assert.equal(column, 1);
    assert.equal(numColumns, 1);
    return new FakeRange(this.ids.slice(0, numRows).map((id) => [id]));
  }
}

const properties = new Map();
const scriptProperties = {
  getProperty(key) {
    return properties.has(key) ? properties.get(key) : null;
  },
  setProperty(key, value) {
    properties.set(key, String(value));
  }
};

const context = {
  console,
  PropertiesService: {
    getScriptProperties() {
      return scriptProperties;
    }
  }
};
vm.runInNewContext(source, context);

assert.equal(typeof context._reserveNextConfirmRequestId_, 'function');

const first = context._reserveNextConfirmRequestId_(
  new FakeSheet(['RQ-260818-008', 'RQ-260818-009']),
  '260818'
);
assert.equal(first, 'RQ-260818-010');
assert.equal(properties.get('CONFIRM_REQUEST_SEQUENCE_V1_260818'), '10');

// autoClearRequests가 당일 행을 전부 지워도 이미 쓴 번호는 다시 발급하지 않는다.
const afterClear = context._reserveNextConfirmRequestId_(new FakeSheet([]), '260818');
assert.equal(afterClear, 'RQ-260818-011');

// 속성값이 뒤처졌다면 현재 시트 최대값을 기준으로 따라잡는다.
properties.set('CONFIRM_REQUEST_SEQUENCE_V1_260819', '3');
const catchesUp = context._reserveNextConfirmRequestId_(
  new FakeSheet(['RQ-260819-012']),
  '260819'
);
assert.equal(catchesUp, 'RQ-260819-013');
assert.equal(properties.get('CONFIRM_REQUEST_SEQUENCE_V1_260819'), '13');

console.log('confirm request ID allocation behavior checks passed');
