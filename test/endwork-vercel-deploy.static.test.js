const assert = require('assert');
const fs = require('fs');
const path = require('path');

const script = fs.readFileSync(path.resolve(__dirname, '../scripts/endwork.sh'), 'utf8');

assert(
  script.includes('VERCEL_TODAY_PROJECT_ID="prj_saeOBufXl2hCBDurWbd4wWCQLYqF"'),
  'endwork must target the real today-dashboard Vercel project'
);
assert(
  /VERCEL_PROJECT_ID="\$VERCEL_TODAY_PROJECT_ID"[\s\\]*"\$VERCEL_BIN" --prod --yes/.test(script),
  'endwork must perform a non-interactive production deployment after the main push'
);
assert(
  /command -v vercel/.test(script) && /\$HOME\/\.hermes\/node\/bin\/vercel/.test(script),
  'endwork must support both a normal Vercel CLI install and the Hermes-managed binary'
);

console.log('endwork today-dashboard Vercel deployment checks passed');
