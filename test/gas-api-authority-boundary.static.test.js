const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function setEntries(source, name, quote = '"') {
  const marker = `const ${name} = new Set([`;
  const from = source.indexOf(marker);
  assert.ok(from >= 0, `${name} definition must exist`);
  const to = source.indexOf(']);', from);
  const pattern = quote === '"' ? /"([^"\r\n]+)"/g : /'([^'\r\n]+)'/g;
  return new Set([...source.slice(from, to).matchAll(pattern)].map((match) => match[1]));
}

test('scan is declared as a write capability because it confirms and registers requests', () => {
  const api = read('sheetAPI.js');
  assert.match(
    api,
    /id:\s*"confirmation_request\.scan"[^\r\n]+action:\s*"scan"[^\r\n]+policy:\s*"internal_write"[^\r\n]+verification:\s*"authoritative_server_ack"/,
  );
  assert.match(api, /case "scan":[\s\S]{0,120}requireVillagePost_\(e, "scan"\)[\s\S]{0,120}doScanAll\(\)/);
});

test('the authenticated app proxy treats scan as an uncached write and never as a read', () => {
  const today = read('apps/today-dashboard/app/api/gas/route.ts');
  const followUp = read('apps/follow-up-dashboard/api/gas-proxy.js');

  const todayReads = setEntries(today, 'READ_ACTIONS');
  const todayWrites = setEntries(today, 'WRITE_ACTIONS');

  assert.equal(todayReads.has('scan'), false);
  assert.equal(todayWrites.has('scan'), true);
  assert.match(followUp, /410[\s\S]*retired/);
  assert.doesNotMatch(followUp, /READ_ACTIONS|WRITE_ACTIONS|fetch\(/);
});

test('authenticated confirmation API exposes scan only through POST', () => {
  const route = read('apps/today-dashboard/app/api/confirm/route.ts');
  const getBody = route.slice(route.indexOf('export async function GET'), route.indexOf('export async function POST'));
  const postBody = route.slice(route.indexOf('export async function POST'));
  assert.doesNotMatch(getBody, /action\s*!==\s*"scan"/);
  assert.match(postBody, /action\s*===\s*"scan"/);
});

test('customer send approval is present in the capability policy registry', () => {
  const api = read('sheetAPI.js');
  assert.match(
    api,
    /id:\s*"customer\.send_confirmation"[^\r\n]+action:\s*"발송승인"[^\r\n]+policy:\s*"customer_send"[^\r\n]+verification:\s*"authoritative_server_ack"/,
  );
});

test('authenticated Today Dashboard routes use the derived internal GAS key', () => {
  for (const file of [
    'apps/today-dashboard/app/api/gas/route.ts',
    'apps/today-dashboard/app/api/confirm/route.ts',
    'apps/today-dashboard/app/api/operations/route.ts',
  ]) {
    const source = read(file);
    assert.match(source, /getVillageGasInternalKey/);
    assert.doesNotMatch(source, /process\.env\.GAS_API_KEY\s*\?\?\s*["']village2026["']/);
  }
});

test('public customer helper uses the public key only for token reads and the internal key for writes', () => {
  const source = read('apps/today-dashboard/lib/server/gasPublic.ts');
  const getBody = source.slice(source.indexOf('export async function gasGet'), source.indexOf('export async function gasPost'));
  const postBody = source.slice(source.indexOf('export async function gasPost'));
  assert.match(getBody, /VILLAGE_PUBLIC_API_KEY/);
  assert.match(postBody, /getVillageGasInternalKey/);
  assert.doesNotMatch(postBody, /key:\s*VILLAGE_PUBLIC_API_KEY/);
});

test('inventory mirror derives its GAS key from the server-side service-role secret', () => {
  const source = read('apps/today-dashboard/lib/server/inventoryAuditMirrorCore.mjs');
  assert.match(source, /deriveVillageGasInternalKey/);
  assert.match(source, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.doesNotMatch(source, /const gasKey = String\(env\.GAS_API_KEY/);
});

test('agent documentation never teaches public-key mutations', () => {
  const guide = read('AGENT_GUIDE.md');
  assert.match(guide, /public catalog read/i);
  assert.match(guide, /server-side internal credential/i);
  assert.doesNotMatch(guide, /key=village2026&action=(?:run|write|append|update|등록|발송승인)/);

  for (const file of ['AGENTS.md', 'CLAUDE.md']) {
    const source = read(file);
    assert.match(source, /public/i);
    assert.match(source, /목록.*세트마스터/);
    assert.match(source, /internal.*write/i);
  }
});
