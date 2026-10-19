'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const gas = fs.readFileSync(path.join(__dirname, '../checkAvailability.js'), 'utf8');
function fn(name) {
  const start = gas.indexOf('function ' + name + '(');
  const end = gas.indexOf('\nfunction ', start + 1);
  return start < 0 ? '' : gas.slice(start, end < 0 ? undefined : end);
}

test('the actual registration price stage preserves confirmed unknown equipment and flags the missing price', () => {
  const register = gas.indexOf('function registerByReqID(');
  const start = gas.indexOf('  // 모든 유상 상품의 단가', register);
  const end = gas.indexOf('\n  if (hasTransferredConfirmedLock)', start);
  assert.ok(start > register && end > start);
  const rows = [
    ['RQ-X', '', '', '', '', 'Known camera', 3, '', '세트', '', '', '', '', '', '', '', ''],
    ['RQ-X', '', '', '', '', 'Approved unknown lens', 1, '', '❓ 미등록 장비', '', '', '', '', '', '', '', '']
  ];
  const lookup = {items: {'Known camera': true}, prices: {'Known camera': 50000}};
  const context = { reqID: 'RQ-X', mergeTargetScheduleRows: [], allData: rows, mergeSchedulePlan: {writeSourceIndexes: [0, 1]}, setSheet: {},
    buildDashboardSetLookup_: () => lookup,
    findSetPrice: name => context.requireSetMasterPrice_(name, lookup) };
  vm.createContext(context);
  vm.runInContext(fn('setMasterProductKey_') + '\n' + fn('getSetMasterProductAliases_') + '\n' + fn('resolveSetMasterProduct_') + '\n' + fn('resolveSetMasterComponents_') + '\n' + fn('rentalLightingFixtureNames_') + '\n' + fn('rentalAccessoryKind_') + '\n' + fn('resolveRentalAccessoryPrice_') + '\n' + fn('requireSetMasterPrice_') + '\n' + fn('resolveStaffApprovedRegistrationPrice_') +
    '\nfunction stage(approved){var directRegisterApproved=approved;' +
    gas.slice(start, end) + '\nreturn {prices:registrationPrices,notes:registrationPriceNotes};}', context);
  const result = context.stage(true);
  assert.equal(result.prices[0], 50000);
  assert.equal(result.prices[1], '');
  assert.match(result.notes[1], /\[단가확인필요\]/);
  assert.throws(() => context.stage(false), /세트마스터/);
});

test('unresolved prices cannot produce a customer contract or copy a Drive template', () => {
  const source = fs.readFileSync(path.join(__dirname, '../generatecontract.js'), 'utf8');
  const start = source.indexOf('function generateContractFile(');
  const end = source.indexOf('\nfunction ', start + 1);
  let driveCopies = 0;
  const contract = ['261013-099', 'Test customer', '01000000000', '', '2026-10-14', '12:00', '2026-10-14', '19:00', 1, '예약', '일반', ''];
  const schedule = ['261013-099-01', '261013-099', 'Approved unknown lens', 'Approved unknown lens', 1,
    '2026-10-14', '12:00', '2026-10-14', '19:00', '대기', '[단가확인필요]', ''];
  const sheet = values => ({getLastRow: () => 2, getRange: () => ({getValues: () => [values], getDisplayValues: () => [values]})});
  const context = {PropertiesService: {getScriptProperties: () => ({getProperty: name => name === 'CONTRACT_TEMPLATE_ID' ? 'test-template' : ''})},
    DriveApp: {getFileById: () => {driveCopies++; throw new Error('unexpected Drive template access');}}};
  vm.createContext(context);
  vm.runInContext(fn('hasPendingSchedulePrice_') + '\n' + source.slice(start, end), context);
  const ss = {getSheetByName: name => sheet(name === '계약마스터' ? contract : schedule)};
  assert.throws(() => context.generateContractFile(ss, '261013-099'), /단가확인필요/);
  assert.equal(driveCopies, 0);
});
