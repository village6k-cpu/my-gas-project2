const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'toss-front-plugin/village-front/app.js'), 'utf8');

assert(
  !app.includes('innerHTML') &&
    !app.includes('renderVillageIdle') &&
    !app.includes('unmountRendering'),
  'all screen transitions must stay inside the Toss Template API React lifecycle'
);

assert(
  /var showIdle = safe\(function \(\) \{[\s\S]*sdk\.template\.renderSelectPage/.test(app),
  'idle return must render the official Toss menu instead of replacing #app DOM'
);

console.log('toss-front idle root lifecycle static checks passed');
