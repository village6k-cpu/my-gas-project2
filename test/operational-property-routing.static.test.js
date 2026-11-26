const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');

function withoutFunction(source, name) {
  const start = source.indexOf('function ' + name + '(');
  assert.ok(start >= 0, name);
  const next = source.indexOf('\nfunction ', start + 1);
  return source.slice(0, start) + (next < 0 ? '' : source.slice(next));
}

test('production modules cannot bypass the shared operational storage router', () => {
  const nativeAccess = [], rawAccess = [];
  for (const file of fs.readdirSync(root).filter(name => name.endsWith('.js'))) {
    let source = fs.readFileSync(path.join(root, file), 'utf8');
    if (/PropertiesService\s*\.\s*getScriptProperties\s*\(/.test(source)) nativeAccess.push(file);
    if (['villagePropertyStore.js', 'operationalPropertyStorage.js'].includes(file)) continue;
    if (file === 'supabaseSync.js') {
      source = withoutFunction(source, 'auditScriptProperties');
      source = withoutFunction(source, 'probeScriptPropertiesCapacity');
    }
    if (/villageRawProperties_\s*\(/.test(source)) rawAccess.push(file);
  }
  assert.deepEqual(nativeAccess, ['villagePropertyStore.js']);
  assert.deepEqual(rawAccess, []);
});

test('document settings access remains restricted to the existing semantic storage pointers', () => {
  const files = fs.readdirSync(root).filter(name => name.endsWith('.js'))
    .filter(file => /PropertiesService\s*\.\s*get(?:User|Document)Properties\s*\(/.test(fs.readFileSync(path.join(root, file), 'utf8')));
  assert.deepEqual(files.sort(), ['inventorySemanticReview.js', 'inventorySemanticStorage.js']);
});
