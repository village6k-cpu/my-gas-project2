const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const claspignore = fs.readFileSync(path.join(root, '.claspignore'), 'utf8');

assert(
  /(^|\n)toss-front-plugin\/\*\*(\n|$)/.test(claspignore),
  'toss-front-plugin files must be ignored by clasp so plugin config/assets are not pushed into GAS'
);

console.log('toss-front clasp ignore checks passed');
