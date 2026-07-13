const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'toss-front-plugin/village-front/app.js'), 'utf8');

assert(
  app.includes('function returnToIdle()') &&
    app.includes('setTimeout(function () { showIdle(); }, 0)'),
  'front plugin must defer idle rendering until the current template callback finishes'
);

assert(
  !app.includes('restoreVillageIdleIfEmpty') &&
    !app.includes('installVillageIdleRecoveryGuard') &&
    !app.includes('setInterval(restoreVillageIdleIfEmpty'),
  'official Template idle must not use custom DOM repair timers'
);

assert(
  /onBack:\s*function\s*\(\)\s*\{\s*returnToIdle\(\);\s*\}/.test(app),
  'Toss template back callbacks must use deferred returnToIdle'
);

console.log('toss-front idle recovery static checks passed');
