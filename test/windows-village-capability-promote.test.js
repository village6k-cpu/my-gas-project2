'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  confirmRegistration,
  promoteCandidate,
  validateCandidate
} = require('../scripts/windows/village-capability-promote.js');

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function git(root, args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'village-capability-source-'));
  const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'village-capability-hermes-'));
  git(root, ['init', '-b', 'main']);
  write(path.join(root, 'scripts/windows/village-operation-broker.js'), [
    "function capability() {}",
    "const CAPABILITIES = { 'new.operation': capability({}) };",
    'module.exports = { CAPABILITIES };'
  ].join('\n'));
  write(path.join(root, 'scripts/windows/new-operation.js'), 'module.exports = { ok: true };\n');
  write(path.join(root, 'sheetAPI.js'), 'const capabilities = [{ id: "new.operation" }];\n');
  for (const relative of [
    'test/windows-village-operation-broker.test.js',
    'test/registered-village-capability-catalog.static.test.js',
    'test/new-operation.test.js'
  ]) {
    write(path.join(root, relative), [
      "const test = require('node:test');",
      "const assert = require('node:assert/strict');",
      "test('offline candidate', () => assert.equal(1, 1));"
    ].join('\n'));
  }
  return { root, hermesHome };
}

test('candidate validation runs declared tests under the Node no-network permission model', async (t) => {
  const { root, hermesHome } = fixture();
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(hermesHome, { recursive: true, force: true });
  });
  const result = await validateCandidate({
    phase: 'validate_candidate',
    capability: 'new.operation',
    candidateRoot: root,
    runtimeFiles: [
      'scripts/windows/village-operation-broker.js',
      'scripts/windows/new-operation.js'
    ],
    gasFiles: ['sheetAPI.js'],
    testFiles: ['test/new-operation.test.js']
  }, { expectedRoot: root, hermesHome });

  assert.equal(result.ok, true);
  assert.equal(result.validated, true);
  assert.equal(result.networkIsolated, true);
  assert.match(result.validationId, /^[a-f0-9-]+$/i);
  assert.ok(fs.existsSync(path.join(
    hermesHome,
    'learning/village-capability-promotions',
    `validation-${result.validationId}.json`
  )));
});

test('promotion uses only an unchanged validation receipt and records the controlled install', async (t) => {
  const { root, hermesHome } = fixture();
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(hermesHome, { recursive: true, force: true });
  });
  const validated = await validateCandidate({
    capability: 'new.operation',
    candidateRoot: root,
    runtimeFiles: ['scripts/windows/village-operation-broker.js'],
    gasFiles: ['sheetAPI.js'],
    testFiles: ['test/new-operation.test.js']
  }, { expectedRoot: root, hermesHome });
  let deploys = 0;
  let installs = 0;
  const promoted = await promoteCandidate({
    capability: 'new.operation',
    validationId: validated.validationId,
    deploymentDescription: 'test promotion'
  }, {
    hermesHome,
    deployGas: () => { deploys += 1; },
    installRuntime: () => {
      installs += 1;
      return { destination: path.join(hermesHome, 'scripts/village'), backup: null };
    }
  });
  assert.equal(promoted.ok, true);
  assert.equal(deploys, 1);
  assert.equal(installs, 1);

  write(path.join(root, 'sheetAPI.js'), 'const capabilities = [];\n');
  await assert.rejects(
    () => promoteCandidate({
      capability: 'new.operation',
      validationId: validated.validationId
    }, { hermesHome, deployGas: () => {}, installRuntime: () => ({}) }),
    /changed after testing/
  );
});

test('confirmation requires both the freshly installed broker and the live server catalog', async (t) => {
  const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'village-capability-confirm-'));
  t.after(() => fs.rmSync(hermesHome, { recursive: true, force: true }));
  write(path.join(hermesHome, 'scripts/village/village-operation-broker.js'), [
    "const fs = require('node:fs');",
    "JSON.parse(fs.readFileSync(0, 'utf8'));",
    "process.stdout.write(JSON.stringify({ ok: true, capabilities: [{ id: 'new.operation' }] }));"
  ].join('\n'));
  const promotionId = crypto.randomUUID();
  write(path.join(
    hermesHome,
    'learning/village-capability-promotions',
    `promotion-${promotionId}.json`
  ), JSON.stringify({
    kind: 'promotion',
    promotionId,
    capability: 'new.operation',
    runtime: { destination: path.join(hermesHome, 'scripts/village'), backup: null },
    confirmed: false
  }));

  const missing = await confirmRegistration({ capability: 'new.operation', promotionId }, {
    hermesHome,
    config: {
      VILLAGE2_API_URL: 'https://script.google.com/macros/s/example/exec',
      VILLAGE2_API_KEY: 'test-key'
    },
    fetchImpl: async () => ({ ok: true, json: async () => ({ capabilities: [] }) })
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.runtimeConfirmed, true);
  assert.equal(missing.liveCatalogConfirmed, false);

  const confirmed = await confirmRegistration({ capability: 'new.operation', promotionId }, {
    hermesHome,
    config: {
      VILLAGE2_API_URL: 'https://script.google.com/macros/s/example/exec',
      VILLAGE2_API_KEY: 'test-key'
    },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ capabilities: [{ id: 'new.operation' }] })
    })
  });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.runtimeConfirmed, true);
  assert.equal(confirmed.liveCatalogConfirmed, true);
});
