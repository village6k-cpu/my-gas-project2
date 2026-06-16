const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'toss-front-plugin/village-front/app.js'), 'utf8');

assert(
  app.includes('function returnToIdle()') &&
    app.includes('function restoreVillageIdleIfEmpty()') &&
    app.includes('function installVillageIdleRecoveryGuard()'),
  'front plugin must have a deferred idle return path and a blank-idle recovery guard'
);

assert(
  app.includes('setTimeout(function () { showIdle(); }, 0)') &&
    app.includes('setTimeout(restoreVillageIdleIfEmpty, 120)') &&
    app.includes('setTimeout(restoreVillageIdleIfEmpty, 500)'),
  'returnToIdle must render after Toss template cleanup and re-check shortly after'
);

assert(
  app.includes("document.body.classList.contains('village-idle-page')") &&
    app.includes("!document.getElementById('village-phone-button')") &&
    app.includes('renderVillageIdle();') &&
    app.includes('setInterval(restoreVillageIdleIfEmpty, 750)'),
  'idle recovery guard must redraw the idle screen if only the background shell remains'
);

assert(
  app.includes("window.addEventListener('pageshow', restoreVillageIdleIfEmpty)") &&
    app.includes("window.addEventListener('popstate'") &&
    app.includes("document.addEventListener('visibilitychange'"),
  'idle recovery guard must handle browser/app back and foreground transitions'
);

assert(
  !/onBack:\s*function\s*\(\)\s*\{\s*showIdle\(\);\s*\}/.test(app) &&
    /onBack:\s*function\s*\(\)\s*\{\s*returnToIdle\(\);\s*\}/.test(app),
  'Toss template back callbacks must use deferred returnToIdle instead of immediate showIdle'
);

console.log('toss-front idle recovery static checks passed');
