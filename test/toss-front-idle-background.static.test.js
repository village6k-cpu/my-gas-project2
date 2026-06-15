const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const exists = (file) => fs.existsSync(path.join(root, file));

const index = read('toss-front-plugin/village-front/index.html');
const app = read('toss-front-plugin/village-front/app.js');
const css = read('toss-front-plugin/village-front/idle.css');
const buildZip = read('toss-front-plugin/build-zip.sh');

assert(
  index.includes('./idle.css'),
  'front plugin index.html must load the custom idle-screen stylesheet'
);
assert(
  index.indexOf('<div id="app"') > -1 &&
    index.indexOf('<script src="./config.js"></script>') > index.indexOf('<div id="app"') &&
    index.indexOf('<script src="./app.js"></script>') > index.indexOf('<div id="app"'),
  'config/app scripts must run after the #app root exists because the custom idle screen writes to it'
);
assert(
  exists('toss-front-plugin/village-front/assets/village-idle-bg.png'),
  'front plugin must bundle the existing VILLAGE idle background image'
);
assert(
  exists('toss-front-plugin/village-front/assets/village-logo.png'),
  'front plugin must bundle a visible logo crop from the existing VILLAGE image'
);
assert(
  app.includes('function renderVillageIdle()') &&
    app.includes('village-phone-button') &&
    app.includes('village-reservation-button'),
  'idle screen must be rendered by our custom HTML buttons instead of Toss template text wrapping'
);
assert(
  !app.includes('village-idle__brand'),
  'idle screen must not render a separate VILLAGE heading because the brand appears in the background image'
);
assert(
  !/renderIdlePage\(/.test(app),
  'idle screen must not use Toss renderIdlePage because it wraps Korean text badly on the terminal'
);
assert(
  app.includes('예약 조회 · 셀프 결제') &&
    app.includes('<img class="village-idle__logo" src="./assets/village-logo.png" alt="VILLAGE" />') &&
    app.includes('전화번호 또는 예약번호로<br />미결제 예약을 확인하고<br />카드로 결제하세요.') &&
    app.includes('카드로 결제하세요.') &&
    app.includes('전화번호로 결제') &&
    app.includes('예약번호로 결제'),
  'custom idle screen must show the VILLAGE logo and keep the requested three-line copy and payment choices'
);
assert(
  !css.includes('body.village-idle-page > :not(#app):not(script):not(style):not(link)'),
  'idle screen CSS must not hide every element injected outside #app because Toss settings overlays may live there'
);
assert(
  app.includes('function hideTossDevAddressBadges') &&
    app.includes('function installTossDevAddressBadgeGuard') &&
    app.includes('MutationObserver') &&
    app.includes('data-village-hidden-dev-address') &&
    /\\d\{1,3\}\\\./.test(app) &&
    app.includes(':\\d{2,5}'),
  'idle screen must hide only the Toss dev IP:port badge with a targeted DOM guard'
);
assert(
  buildZip.includes('idle.css') &&
    buildZip.includes('assets/village-idle-bg.png') &&
    buildZip.includes('assets/village-logo.png'),
  'build zip must include the idle stylesheet, background image, and visible logo crop'
);

console.log('toss-front idle background static checks passed');
