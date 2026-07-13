const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const index = read('toss-front-plugin/village-front/index.html');
const app = read('toss-front-plugin/village-front/app.js');
const buildZip = read('toss-front-plugin/build-zip.sh');

assert(
  !index.includes('./idle.css') &&
    /<div id="app"><\/div>/.test(index),
  'front plugin must leave #app to the Toss Template API without custom idle HTML or CSS'
);

assert(
  /var showIdle = safe\(function \(\) \{[\s\S]*sdk\.template\.renderSelectPage\(\{/.test(app),
  'idle screen must be rendered through the official Toss Template API'
);

[
  'VILLAGE 셀프 결제',
  '전화번호로 결제',
  '금액 직접 결제',
  '영수증 재출력'
].forEach((label) => {
  assert(app.includes(label), `official idle menu must include: ${label}`);
});

assert(
  !app.includes('renderVillageIdle') &&
    !app.includes('village-idle__') &&
    !app.includes('innerHTML') &&
    !app.includes('installVillageIdleRecoveryGuard'),
  'front plugin must not mix custom DOM ownership with the Toss SDK React root'
);

assert(
  !buildZip.includes('idle.css') &&
    !buildZip.includes('village-idle-bg.png') &&
    !buildZip.includes('village-logo.png'),
  'upload ZIP must not bundle unused custom-screen CSS or image assets'
);

console.log('toss-front official idle template static checks passed');
