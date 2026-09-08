const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'checkAvailability.js'), 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`missing function ${name}`);
  const brace = source.indexOf('{', start);
  let depth = 0;
  for (let index = brace; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

test('rental dropdowns use only the set-master product names and refresh their cached list', () => {
  let writtenNames = [];
  const validations = [];
  const removedCaches = [];
  const range = {
    getValues() { return []; },
    setValue() { return this; },
    setFontWeight() { return this; },
    setValues(values) { writtenNames = values.map((row) => row[0]); return this; },
    setDataValidation() { return this; }
  };
  const setSheet = {
    getLastRow() { return 3; },
    getRange() { return { getValues: () => [['세트B'], ['세트A']] }; }
  };
  const equipmentSheet = {
    getLastRow() { return 4; },
    getRange(row, column, rowCount, columnCount) {
      assert.deepEqual([row, column, rowCount, columnCount], [2, 4, 3, 1]);
      return { getValues: () => [['장비B'], ['세트A'], ['장비A']] };
    }
  };
  const listSheet = {
    clear() {},
    getRange() { return range; },
    hideSheet() {}
  };
  const sheets = {
    '세트마스터': setSheet,
    '장비마스터': equipmentSheet,
    '목록': listSheet,
    '확인요청': { getMaxRows: () => 30, getRange: (row,col,count,width) => ({setDataValidation(rule) {validations.push({sheet:'확인요청',row,col,count,width,rule});}}) },
    '스케줄상세': { getMaxRows: () => 40, getRange: (row,col,count,width) => ({setDataValidation(rule) {validations.push({sheet:'스케줄상세',row,col,count,width,rule});}}) }
  };
  const context = {
    SpreadsheetApp: {
      getActiveSpreadsheet() {
        return {
          getSheetByName: (name) => sheets[name] ?? null,
          insertSheet() { throw new Error('list sheet should already exist'); },
          moveActiveSheet() {},
          getNumSheets() { return 3; },
        };
      },
      newDataValidation() {
        return {
          requireValueInRange() { return this; },
          requireValueInList() { return this; },
          setAllowInvalid() { return this; },
          setHelpText() { return this; },
          build() { return {}; }
        };
      }
    },
    PropertiesService: {
      getScriptProperties() {
        return { getProperty: () => null, setProperty() {} };
      }
    },
    Utilities: {
      DigestAlgorithm: { MD5: 'MD5' },
      computeDigest: () => [1],
      base64Encode: () => 'hash'
    },
    CacheService: { getScriptCache: () => ({ remove: key => removedCaches.push(key) }) }
  };

  vm.runInNewContext(`${extractFunction('refreshEquipmentList')}\nrefreshEquipmentList(false);`, context);

  assert.deepEqual(
    JSON.parse(JSON.stringify(writtenNames)),
    ['세트A', '세트B']
  );
  assert.deepEqual(validations.filter(x=>x.sheet==='스케줄상세'||x.col===6).map(({sheet,col,count})=>({sheet,col,count})),
    [{sheet:'확인요청',col:6,count:29},{sheet:'스케줄상세',col:3,count:39},{sheet:'스케줄상세',col:4,count:39}]);
  assert.ok(removedCaches.includes('dashboardEquipNameList_v1'));
});
