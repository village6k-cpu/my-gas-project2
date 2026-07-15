const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const routes = [
  'apps/today-dashboard/app/api/lookup/route.ts',
  'apps/today-dashboard/app/api/lookup/confirm/route.ts',
  'apps/today-dashboard/app/api/lookup/cancel/route.ts',
  'apps/today-dashboard/app/api/lookup/receipts/route.ts',
];

function assertCorsContract(file) {
  const source = read(file);

  assert(
    source.includes('LOOKUP_CORS_HEADERS'),
    `${file} must centralize lookup CORS headers`
  );
  assert(
    /Access-Control-Allow-Origin/.test(source) &&
      /Access-Control-Allow-Methods/.test(source) &&
      /Access-Control-Allow-Headers/.test(source),
    `${file} must return CORS headers for Toss Front plugin browser requests`
  );
  assert(
    /x-lookup-token/.test(source),
    `${file} must allow the x-lookup-token request header used by the plugin`
  );
  assert(
    /export async function OPTIONS\(\)/.test(source),
    `${file} must answer preflight OPTIONS requests`
  );

  const nextJsonCalls = source.match(/NextResponse\.json/g) ?? [];
  assert.strictEqual(
    nextJsonCalls.length,
    1,
    `${file} must route all JSON responses through one CORS-wrapped helper`
  );
}

routes.forEach(assertCorsContract);

const cancelRoute = read('apps/today-dashboard/app/api/lookup/cancel/route.ts');
assert(cancelRoute.includes('x-lookup-token'));
assert(/export async function OPTIONS\(\)/.test(cancelRoute));
assert(cancelRoute.includes('action: "updateTradeProof"'));
assert(cancelRoute.includes('field: "depositStatus"'));
assert(cancelRoute.includes('value: "환불"'));
assert(/paymentKey[^\n]*typeof paymentKey !== "string"[^\n]*!paymentKey\.trim\(\)/.test(cancelRoute));
assert(/status:\s*503/.test(cancelRoute));
assert(/status:\s*401/.test(cancelRoute));
assert(/status:\s*400/.test(cancelRoute));
assert(/status:\s*502/.test(cancelRoute));
assert(cancelRoute.includes('depositStatus: "환불"'));

console.log('toss-front lookup CORS static checks passed');
