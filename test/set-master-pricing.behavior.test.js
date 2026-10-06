'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.resolve(__dirname, '../checkAvailability.js'), 'utf8');
function fn(name) {
  const start = source.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('missing function ' + name);
  const end = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, end < 0 ? undefined : end);
}
function harness(rows) {
  const sheet = { getLastRow: () => rows.length + 1, getLastColumn: () => 7,
    getRange: () => ({ getValues: () => rows }) };
  const context = { getSetMasterRows_: () => rows,
    getDashboardCachedJson_: (_key, _ttl, factory) => factory() };
  vm.createContext(context);
  for (const name of ['parseSetMasterPrice_', 'requireSetMasterPrice_', 'buildDashboardSetLookup_', 'getDashboardEquipNameList_', 'findSetPrice']) {
    if (source.includes('function ' + name + '(')) vm.runInContext(fn(name), context);
  }
  return { context, sheet };
}
test('set-master rate is numeric, including comma text and an explicit zero', () => {
  const h = harness([['미니 매트박스', '업링', 1, '', '', 'Y', '10,000'], ['무료 상품', '', 1, '', '', '', 0]]);
  assert.equal(h.context.findSetPrice('미니 매트박스', h.sheet), 10000);
  assert.equal(h.context.findSetPrice('무료 상품', h.sheet), 0);
});
test('missing products and blank or malformed master rates cannot silently become free', () => {
  const h = harness([['빈 단가', '', 1, '', '', '', ''], ['오류 단가', '', 1, '', '', '', '10,00']]);
  for (const name of ['없는 상품', '빈 단가', '오류 단가']) assert.throws(() => h.context.findSetPrice(name, h.sheet), /세트마스터/);
});
test('catalog reads live A/G master values without using stale list or price caches', () => {
  const rows = [['미니 매트박스', '업링', 1, '', '', 'Y', 10000]];
  const h = harness(rows);
  h.context.getDashboardCachedJson_ = () => ({ prices: { '미니 매트박스': 0 }, items: {}, components: {} });
  const ss = { getSheetByName(name) { assert.equal(name, '세트마스터'); return h.sheet; } };
  assert.deepEqual(Array.from(h.context.getDashboardEquipNameList_(ss)), ['미니 매트박스']);
  assert.equal(h.context.buildDashboardSetLookup_(h.sheet).prices['미니 매트박스'], 10000);
  rows[0][6] = 12000;
  assert.equal(h.context.buildDashboardSetLookup_(h.sheet).prices['미니 매트박스'], 12000);
});
test('frontend suggestions contain A-column products, not B-column components; prices survive transport', () => {
  const ts = require('../apps/today-dashboard/node_modules/typescript');
  const frontend = fs.readFileSync(path.resolve(__dirname, '../apps/today-dashboard/lib/data/equipmentCatalog.ts'), 'utf8');
  const js = ts.transpileModule(frontend + '\nexport { buildItems, readCatalogPayload };', { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const context = { exports: {}, require: () => ({ categoryOf: () => null }), Date, Map, Set };
  vm.createContext(context); vm.runInContext(js, context);
  const result = context.exports.buildItems(context.exports.readCatalogPayload({ names: ['미니 매트박스'], items: {'미니 매트박스':true}, prices: {'미니 매트박스':10000}, components: {'미니 매트박스':[{name:'업링',qty:1}]} }));
  assert.deepEqual(Array.from(result.items, x => x.name), ['미니 매트박스']);
  assert.equal(result.items[0].unitPrice, 10000);
});

test('sheet dropdown product replacement resolves its new master rate while component substitution stays free', () => {
  const code=fs.readFileSync(path.resolve(__dirname,'../Code.js'),'utf8');
  const start=code.indexOf('function syncScheduleEditedProductPrice_('), end=code.indexOf('\nfunction ',start+1);
  let current=['이전 상품','미니 매트박스']; const writes=[];
  const sheet={getRange:(_row,col)=>({getValues:()=>[current],getValue:()=>'',setValue:value=>writes.push([col,value])})};
  const context={findSetPrice: name=>{assert.equal(name,'미니 매트박스'); return 10000;}};
  vm.createContext(context); vm.runInContext(code.slice(start,end),context);
  context.syncScheduleEditedProductPrice_({getSheetByName:()=>({})},sheet,2,'이전 상품');
  assert.deepEqual(writes,[[12,10000],[3,'미니 매트박스']]);
  writes.length=0; current=['세트 상품','교체 구성품'];
  context.syncScheduleEditedProductPrice_({},sheet,2,'이전 구성품');
  assert.equal(writes.length,0);
});
