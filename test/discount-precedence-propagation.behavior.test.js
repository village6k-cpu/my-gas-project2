const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const backend = fs.readFileSync(path.resolve(__dirname, '..', 'checkAvailability.js'), 'utf8');
const supabase = fs.readFileSync(path.resolve(__dirname, '..', 'supabaseSync.js'), 'utf8');
const kakaoInput = fs.readFileSync(
  path.resolve(__dirname, '..', 'apps', 'today-dashboard', 'components', 'KakaoReservationInput.tsx'),
  'utf8'
);
const dashboardSync = fs.readFileSync(
  path.resolve(__dirname, '..', 'apps', 'today-dashboard', 'lib', 'data', 'sync.ts'),
  'utf8'
);

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
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

function loadResolver() {
  const context = {};
  vm.createContext(context);
  vm.runInContext(
    [
      extractFunction(backend, '_normalizeDiscountTypeOrBlank_'),
      extractFunction(backend, '_resolveConfirmRequestDiscount_'),
      'this.resolveDiscount = _resolveConfirmRequestDiscount_;',
    ].join('\n'),
    context
  );
  return context.resolveDiscount;
}

test('Kakao-derived discount wins, while an absent Kakao value falls back to customer DB', () => {
  const resolve = loadResolver();
  assert.equal(resolve('학생', '단골'), '학생');
  assert.equal(resolve('', '단골'), '단골');
  assert.equal(resolve(undefined, ''), '일반');
});

test('AI parser and input UI preserve an absent discount instead of inventing 일반', () => {
  assert.match(backend, /할인 언급이 없으면 반드시/);
  assert.doesNotMatch(backend, /그 외 → \"일반\"/);
  assert.match(kakaoInput, /useState<\(typeof DISCOUNTS\)\[number\] \| "">\(""\)/);
  assert.match(kakaoInput, /:\s*""\s*\);/);
  assert.match(kakaoInput, /<option value="">고객DB 자동<\/option>/);
});

test('confirmed discount reaches dashboard data and Supabase trade rows', () => {
  const contractMap = extractFunction(backend, 'getDashboardContractMapForIds_');
  const dashboard = extractFunction(backend, 'getDashboardData');
  const buildSupabase = extractFunction(supabase, 'buildSupabaseTrades_');

  assert.match(contractMap, /readDashboardScheduleRowsDisplay_\(contractSheet, rowsToRead, 11\)/);
  assert.match(contractMap, /discountType:\s*row\[10\]/);
  assert.match(dashboard, /discountType:\s*cust\.discountType\s*\|\|\s*''/);
  assert.match(buildSupabase, /discountType:\s*String\(mRows\[mi\]\[10\]/);
  assert.match(buildSupabase, /discount_type:\s*d\.discountType\s*\|\|\s*m\.discountType\s*\|\|\s*null/);
  assert.match(dashboardSync, /discountType:\s*it\.discountType\s*\|\|\s*base\.discountType/);
});
