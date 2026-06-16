const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const exists = (file) => fs.existsSync(path.join(root, file));

const app = read('toss-front-plugin/village-front/app.js');
const css = read('toss-front-plugin/village-front/idle.css');
const buildZip = read('toss-front-plugin/build-zip.sh');

assert(
  app.includes('function installTossSettingsHotzone') &&
    app.includes('function openTossFrontSettings') &&
    app.includes('sdk.app.openSetting') &&
    app.includes('village-settings-hotzone') &&
    app.includes('settingsTapCount') &&
    /settingsTapCount\s*>=\s*5/.test(app),
  'idle screen must provide an invisible five-tap settings hotzone that calls sdk.app.openSetting()'
);

assert(
  css.includes('.village-settings-hotzone') &&
    css.includes('position: fixed') &&
    css.includes('right: 0') &&
    css.includes('opacity: 0'),
  'settings hotzone must sit invisibly in the top-right corner of the idle screen'
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
