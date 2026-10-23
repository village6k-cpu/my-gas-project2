import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRecoveryCollector } from './recovery-collector.mjs';

async function fixture(options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'village-collector-test-'));
  const collector = createRecoveryCollector({ directory, ...options });
  await new Promise(resolve => collector.server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + collector.server.address().port;
  return { directory, collector, url, async close() {
    await new Promise(resolve => collector.server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }};
}
test('persists exact source before acknowledging; health explicitly says no business processing', async () => {
  const f = await fixture();
  try {
    const preflight = await fetch(f.url + '/events', { method: 'OPTIONS', headers: { Origin: 'https://business.kakao.com', 'Access-Control-Request-Private-Network': 'true' } });
    assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true');
    assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://business.kakao.com');
    const payload = { source: 'kakao_channel_manager_dom', eventHash: 'synthetic', previewText: '합성 테스트', reason: 'mutation' };
    const response = await fetch(f.url + '/events', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://business.kakao.com' }, body: JSON.stringify(payload) });
    assert.equal(response.status, 200);
    const ack = await response.json();
    assert.equal(ack.persisted, true);
    assert.equal(ack.processed, false);
    const lines = (await readFile(f.collector.journalPath, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]).event, payload);
    const health = await (await fetch(f.url + '/health')).json();
    assert.equal(health.mode, 'recovery_collect_only');
    assert.equal(health.businessAutomationReady, false);
    assert.equal(health.customerSendingEnabled, false);
    assert.equal(health.received, 1);
    assert.deepEqual((await readdir(f.directory)).sort(), [path.basename(f.collector.journalPath), 'recovery-collector.lock'].sort());
  } finally { await f.close(); }
});
test('all mutation/control routes and foreign origins fail closed', async () => {
  const f = await fixture();
  try {
    for (const route of ['/manual-send', '/maintenance/recover', '/hermes/claim', '/registered-change']) {
      const r = await fetch(f.url + route, { method: 'POST', body: '{}' });
      assert.equal(r.status, 503);
    }
    const foreign = await fetch(f.url + '/events', { method: 'POST', headers: { Origin: 'https://example.org' }, body: '{}' });
    assert.equal(foreign.status, 403);
    assert.equal((await readFile(f.collector.journalPath, 'utf8')).length, 0);
  } finally { await f.close(); }
});
test('low disk, full journal, malformed and oversized payloads are never acknowledged', async () => {
  for (const options of [{ availableBytes: () => 1 }, { maxJournalBytes: 1 }]) {
    const f = await fixture(options);
    try {
      const r = await fetch(f.url + '/events', { method: 'POST', body: '{"source":"synthetic"}' });
      assert.equal(r.status, 507);
      assert.equal((await r.json()).persisted, false);
      assert.equal((await (await fetch(f.url + '/health')).json()).ok, false);
      assert.equal((await readFile(f.collector.journalPath, 'utf8')).length, 0);
    } finally { await f.close(); }
  }
  const f = await fixture({ maxBodyBytes: 100 });
  try {
    for (const body of ['bad json', '[]', 'null', '"text"']) {
      assert.equal((await fetch(f.url + '/events', { method: 'POST', body })).status, 400);
    }
    assert.equal((await fetch(f.url + '/events', { method: 'POST', body: JSON.stringify({ value: 'x'.repeat(101) }) })).status, 413);
  } finally { await f.close(); }
});
test('an existing recovery ownership lock prevents a second collector; history is preserved', async () => {
  const f = await fixture();
  try {
    assert.throws(() => createRecoveryCollector({ directory: f.directory }), /EEXIST/);
    assert.equal((await readdir(f.directory)).length, 2);
  } finally { await f.close(); }
});

test('dedicated relay endpoint acknowledges the exact recovery owner', async () => {
  const f = await fixture(); try {
    const h = await (await fetch(f.url + '/health')).json();
    const r = await fetch(f.url + '/recovery-events', { method: 'POST', body: '{"source":"synthetic"}' });
    assert.equal(r.status, 200); assert.equal((await r.json()).runId, h.runId);
  } finally { await f.close(); }
});
