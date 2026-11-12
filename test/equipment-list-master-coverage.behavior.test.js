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

for (const prelocked of [false, true]) test('rental dropdowns preserve non-A data and serialize snapshot reads; prelocked=' + prelocked, () => {
  let locked=prelocked, acquisitions=0, releases=0; const events=[];
  const nonA={note:'KEEP',formula:'=1+2'};
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
    getLastRow() { assert.equal(locked,true); return 3; },
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
    clear() { throw Error('whole sheet clear forbidden'); },
    getLastRow() { return 4; },
    getRange(row,col,count,width) { assert.equal(locked,true); if(count) assert.deepEqual([col,width],[1,1]); return range; },
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
    LockService: {getScriptLock:()=>({hasLock:()=>locked,tryLock:()=>{acquisitions++;locked=true;return true;},releaseLock(){events.push("release");releases++;locked=false;}})},
    SpreadsheetApp: {
      flush(){events.push("flush");},
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
    ['장비/세트명', '세트A', '세트B', '']
  );
  assert.deepEqual(validations.filter(x=>x.sheet==='스케줄상세'||x.col===6).map(({sheet,col,count})=>({sheet,col,count})),
    [{sheet:'확인요청',col:6,count:29},{sheet:'스케줄상세',col:3,count:39},{sheet:'스케줄상세',col:4,count:39}]);
  assert.ok(removedCaches.includes('dashboardEquipNameList_v1'));
  assert.deepEqual(nonA,{note:'KEEP',formula:'=1+2'});
  assert.equal(acquisitions,prelocked?0:1);assert.equal(releases,prelocked?0:1);assert.equal(locked,prelocked);assert.deepEqual(events,prelocked?[]:["flush","release"]);
});

test('busy list writer never reads a stale snapshot or writes and does not release another lock',()=>{
 let reads=0,releases=0;
 const context={LockService:{getScriptLock:()=>({hasLock:()=>false,tryLock:()=>false,releaseLock:()=>releases++})},SpreadsheetApp:{getActiveSpreadsheet:()=>{reads++;throw Error('read forbidden');}}};
 assert.throws(()=>vm.runInNewContext(`${extractFunction('refreshEquipmentList')}\nrefreshEquipmentList(false);`,context),/갱신 중/);
 assert.equal(reads,0);assert.equal(releases,0);
});
test('list write failure releases owned lock for a safe rerun',()=>{
 let releases=0;
 const context={LockService:{getScriptLock:()=>({hasLock:()=>false,tryLock:()=>true,releaseLock:()=>releases++})},SpreadsheetApp:{flush(){},getActiveSpreadsheet:()=>{throw Error('sheet offline');}}};
 assert.throws(()=>vm.runInNewContext(`${extractFunction('refreshEquipmentList')}\nrefreshEquipmentList(false);`,context),/offline/);
 assert.equal(releases,1);
});

test('flush failure still releases owned list lock',()=>{
 const events=[];
 const context={LockService:{getScriptLock:()=>({hasLock:()=>false,tryLock:()=>true,releaseLock:()=>events.push('release')})},SpreadsheetApp:{getActiveSpreadsheet:()=>{throw Error('offline');},flush:()=>{events.push('flush');throw Error('flush failed');}}};
 assert.throws(()=>vm.runInNewContext(`${extractFunction('refreshEquipmentList')}\nrefreshEquipmentList(false);`,context),/flush failed/);
 assert.deepEqual(events,['flush','release']);
});
