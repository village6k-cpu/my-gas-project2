const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'sheetAPI.js'), 'utf8');

function extractFunction(name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${name} must exist`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unterminated function ${name}`);
}

function loadAuthority(internalKey = 'internal-key-from-script-properties') {
  const context = {
    PropertiesService: {
      getScriptProperties() {
        return {
          getProperty(name) {
            return name === 'VILLAGE_API_WRITE_KEY_V1' ? internalKey : '';
          },
        };
      },
    },
  };
  vm.runInNewContext(
    [
      `var VILLAGE_PUBLIC_API_KEY = 'village2026';`,
      `var VILLAGE_INTERNAL_API_KEY_PROPERTY = 'VILLAGE_API_WRITE_KEY_V1';`,
      extractFunction('villageApiPrincipal_'),
      extractFunction('isVillagePublicApiRequestAllowed_'),
      'this.villageApiPrincipal_ = villageApiPrincipal_;',
      'this.isVillagePublicApiRequestAllowed_ = isVillagePublicApiRequestAllowed_;',
    ].join('\n'),
    context,
  );
  return context;
}

test('public GAS key is limited to tokenized customer reads and non-sensitive catalog sheets', () => {
  const authority = loadAuthority();
  const principal = authority.villageApiPrincipal_('village2026');
  assert.equal(principal, 'public');

  const allowed = (action, sheet = '') => authority.isVillagePublicApiRequestAllowed_(
    action,
    { sheet },
    { sheet },
  );
  assert.equal(allowed('myPage'), true);
  assert.equal(allowed('myPageEstimate'), true);
  assert.equal(allowed('read', '목록'), true);
  assert.equal(allowed('search', '세트마스터'), true);
  assert.equal(allowed('read', '고객DB'), false);
  assert.equal(allowed('search', '확인요청'), false);
  assert.equal(allowed('operations'), false);
  assert.equal(allowed('scan'), false);
  assert.equal(allowed('write', '목록'), false);
});

test('only the Script Properties internal key receives the full operations authority', () => {
  const authority = loadAuthority();
  assert.equal(authority.villageApiPrincipal_('internal-key-from-script-properties'), 'internal');
  assert.equal(authority.villageApiPrincipal_('wrong-key'), '');
  assert.equal(authority.villageApiPrincipal_(''), '');
});

test('legacy GAS page routes resolve only to authenticated Today Dashboard replacements', () => {
  const context = {};
  vm.runInNewContext(
    `${extractFunction('villageLegacyPageUrl_')}\nthis.villageLegacyPageUrl_ = villageLegacyPageUrl_;`,
    context,
  );
  assert.equal(context.villageLegacyPageUrl_('dashboard'), 'https://today-dashboard-ten.vercel.app/schedule');
  assert.equal(context.villageLegacyPageUrl_('timeline'), 'https://today-dashboard-ten.vercel.app/schedule');
  assert.equal(context.villageLegacyPageUrl_('manage'), 'https://today-dashboard-ten.vercel.app/confirm');
  assert.equal(context.villageLegacyPageUrl_('unknown'), '');
});

test('owner execution can configure only a valid derived internal key without echoing it', () => {
  const stored = new Map();
  const context = {
    PropertiesService: {
      getScriptProperties() {
        return {
          setProperty(name, value) { stored.set(name, value); },
        };
      },
    },
  };
  vm.runInNewContext(
    [
      `var VILLAGE_INTERNAL_API_KEY_PROPERTY = 'VILLAGE_API_WRITE_KEY_V1';`,
      extractFunction('configureVillageApiInternalKeyV1'),
      'this.configureVillageApiInternalKeyV1 = configureVillageApiInternalKeyV1;',
    ].join('\n'),
    context,
  );

  const key = '-PKxkeZbEpJ49suEszVienz5K7yh2Vgq-f4ddpigOgM';
  const result = context.configureVillageApiInternalKeyV1(key);
  assert.equal(stored.get('VILLAGE_API_WRITE_KEY_V1'), key);
  assert.equal(result.success, true);
  assert.equal(JSON.stringify(result).includes(key), false);
  assert.throws(() => context.configureVillageApiInternalKeyV1('village2026'), /invalid/i);
});
