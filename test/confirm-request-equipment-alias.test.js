const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'checkAvailability.js'), 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function loadMatcher() {
  const names = [
    'normalizeEquipAliasForMatch_',
    'isUnsafeFuzzyEquipInput_',
    'levenshtein',
    'fuzzyMatchEquipName'
  ];
  const context = {};
  vm.runInNewContext(`${names.map(extractFunction).join('\n')}\nthis.match = fuzzyMatchEquipName;`, context);
  return context.match;
}

test('operational English and spoken aliases resolve to the exact set-master names', () => {
  const match = loadMatcher();
  const names = [
    '홀리랜드 솔리드컴 4S',
    '솔리드컴 SE 4S',
    '소니 A7S3 풀세트',
    '소니 A7S3 바디세트'
  ];

  assert.equal(match('solid 4s', names), '홀리랜드 솔리드컴 4S');
  assert.equal(match('알파세븐 바디세트', names), '소니 A7S3 바디세트');
});

test('an existing near-exact catalog name stays grounded and never jumps categories', () => {
  const match = loadMatcher();
  const names = [
    '시그마 아트 18-35mm',
    'H&Y VND-CPL 67-82mm 가변 ND'
  ];

  assert.equal(match('시그마 아트 18-35', names), '시그마 아트 18-35mm');
});
