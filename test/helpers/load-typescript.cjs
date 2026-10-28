// Behavioral tests run the actual TypeScript modules, including relative dependencies.
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('../../apps/today-dashboard/node_modules/typescript');
const cache = new Map();
exports.load = function load(filename) {
  filename = path.resolve(filename);
  if (cache.has(filename)) return cache.get(filename).exports;
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  cache.set(filename, mod);
  mod.require = specifier => specifier.startsWith('.')
    ? load(path.resolve(path.dirname(filename), `${specifier}.ts`))
    : require(specifier);
  mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: filename,
  }).outputText, filename);
  return mod.exports;
};
