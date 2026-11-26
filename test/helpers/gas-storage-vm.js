// GAS loads shared storage definitions before invoking any module function.
// Isolated module tests use those same production definitions, with their existing service fakes.
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const storageSource = ['villagePropertyStore.js', 'operationalPropertyStorage.js']
  .map(name => fs.readFileSync(path.join(root, name), 'utf8')).join('\n');

function createContext(sandbox = {}, options) {
  const context = vm.createContext(sandbox, options);
  vm.runInContext(storageSource, context, { filename: 'shared-gas-storage.js' });
  return context;
}
function runInNewContext(code, sandbox = {}, options) {
  return vm.runInContext(code, createContext(sandbox), options);
}
module.exports = { ...vm, createContext, runInNewContext };
