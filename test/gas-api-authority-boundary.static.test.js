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

test('every app proxy treats scan as an uncached write and never as a read', () => {
  const today = read('apps/today-dashboard/app/api/gas/route.ts');
  const followUp = read('apps/follow-up-dashboard/api/gas-proxy.js');

  const todayReads = setEntries(today, 'READ_ACTIONS');
  const todayWrites = setEntries(today, 'WRITE_ACTIONS');
  const followUpReads = setEntries(followUp, 'READ_ACTIONS', "'");
  const followUpWrites = setEntries(followUp, 'WRITE_ACTIONS', "'");

  assert.equal(todayReads.has('scan'), false);
  assert.equal(todayWrites.has('scan'), true);
  assert.equal(followUpReads.has('scan'), false);
  assert.equal(followUpWrites.has('scan'), true);
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
