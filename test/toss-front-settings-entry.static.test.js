const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const exists = (file) => fs.existsSync(path.join(root, file));

const app = read('toss-front-plugin/village-front/app.js');
const buildZip = read('toss-front-plugin/build-zip.sh');

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
    read('toss-front-plugin/village-front/settings.html').includes('sdk.app.getSerialNumber'),
  'front plugin must include a settings.html entry compatible with the official Toss template'
);

assert(
  buildZip.includes('settings.html'),
  'build zip must include settings.html so Toss settings entry can load it'
);

console.log('toss-front settings entry static checks passed');
