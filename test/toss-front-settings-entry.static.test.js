const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const exists = (file) => fs.existsSync(path.join(root, file));

const app = read('toss-front-plugin/village-front/app.js');
const buildZip = read('toss-front-plugin/build-zip.sh');
const settings = read('toss-front-plugin/village-front/settings.html');

function extractBalancedBlock(source, marker) {
  const markerIndex = source.indexOf(marker);
  assert(markerIndex >= 0, `missing source marker: ${marker}`);

  const blockStart = source.indexOf('{', markerIndex + marker.length - 1);
  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let i = blockStart; i < source.length; i += 1) {
    const ch = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '{') depth += 1;
    if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(blockStart, i + 1);
    }
  }

  assert.fail(`unterminated source block: ${marker}`);
}

assert(
  app.includes('function openTossFrontSettings') &&
    app.includes('sdk.app.openSetting') &&
    /navbarButton:\s*\{\s*label:\s*'설정',[\s\S]*openTossFrontSettings/.test(app),
  'official idle menu must expose Toss settings through its navbar button'
);

assert(
  !app.includes('installTossSettingsHotzone') &&
    !app.includes('village-settings-hotzone') &&
    !app.includes('settingsTapCount'),
  'front plugin must not depend on a custom invisible settings hotzone'
);

assert(
  exists('toss-front-plugin/village-front/settings.html') &&
    /window\.VILLAGE_PAGE_MODE\s*=\s*['"]settings['"]/.test(settings) &&
    settings.includes('./app.js') &&
    !settings.includes('<style>'),
  'settings.html must only bootstrap the shared Template UI in settings mode'
);

assert(
  /VILLAGE_PAGE_MODE\s*===\s*['"]settings['"]/.test(app) &&
    app.includes('function showStaffSettings') &&
    app.includes('최근 결제 취소'),
  'shared app must route settings mode to the staff cancellation menu'
);

const showIdle = extractBalancedBlock(app, 'var showIdle = safe(function ()');
assert(
  !showIdle.includes('결제 취소'),
  'customer idle menu must not expose cancellation'
);

assert(
  buildZip.includes('settings.html'),
  'build zip must include settings.html so Toss settings entry can load it'
);

console.log('toss-front settings entry static checks passed');
