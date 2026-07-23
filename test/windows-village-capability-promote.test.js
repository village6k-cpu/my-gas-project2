'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

const {
  assertOnlyDeclaredGasChanges,
  assertRemoteSnapshotCurrent,
  confirmRegistration,
  promoteCandidate,
  rollbackPromotion,
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
  write(path.join(root, 'test/new-operation.test.js'), [
    "const test = require('node:test');",
    "const assert = require('node:assert/strict');",
    "const { spawnSync } = require('node:child_process');",
    "test('candidate validation cannot use the network', async () => {",
    "  await assert.rejects(() => fetch('https://example.com'), /network access is disabled/);",
    "  assert.throws(",
    "    () => spawnSync(process.execPath, ['-e', 'process.exit(0)']),",
    "    /Access to this API has been restricted|ERR_ACCESS_DENIED/",
    "  );",
    "});"
  ].join('\n'));
  return { root, hermesHome };
}

test('candidate validation runs declared tests with filesystem and network isolation', async (t) => {
  const { root, hermesHome } = fixture();
  const inheritedNodeOptions = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = '--allow-child-process';
  t.after(() => {
    if (inheritedNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = inheritedNodeOptions;
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

test('a confirmed GAS baseline permits the next learned capability even while main is intentionally dirty', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'village-capability-dirty-main-'));
  const snapshotDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'village-capability-live-snapshot-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(snapshotDirectory, { recursive: true, force: true });
  });
  git(root, ['init', '-b', 'main']);
  write(path.join(snapshotDirectory, 'sheetAPI.js'), 'const promotedButUncommitted = true;\n');
  const hash = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(snapshotDirectory, 'sheetAPI.js')))
    .digest('hex');
  const baselineFile = path.join(root, 'gas-live-baseline.json');
  write(baselineFile, JSON.stringify({
    kind: 'gas-live-baseline',
    promotionId: crypto.randomUUID(),
    files: { 'sheetAPI.js': hash }
  }));

  const result = assertRemoteSnapshotCurrent(root, {
    directory: snapshotDirectory,
    manifest: { 'sheetAPI.js': hash }
  }, baselineFile);
  assert.equal(result.source, 'confirmed_promotion_baseline');
});

test('already-confirmed dirty GAS files do not block a later focused promotion', (t) => {
  const { root, hermesHome } = fixture();
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(hermesHome, { recursive: true, force: true });
  });
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Village Test']);
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'base']);
  const priorFile = path.join(root, 'prior-promoted.gs');
  write(priorFile, 'function priorPromoted() { return true; }\n');
  const priorHash = crypto.createHash('sha256').update(fs.readFileSync(priorFile)).digest('hex');
  const baselineFile = path.join(hermesHome, 'gas-live-baseline.json');
  write(baselineFile, JSON.stringify({ files: { 'prior-promoted.gs': priorHash } }));
  const receipt = {
    candidateRoot: root,
    manifest: { gasFiles: ['sheetAPI.js'] }
  };

  assert.doesNotThrow(() => assertOnlyDeclaredGasChanges(receipt, { gasBaselineFile: baselineFile }));
  write(priorFile, 'function priorPromoted() { return false; }\n');
  assert.throws(
    () => assertOnlyDeclaredGasChanges(receipt, { gasBaselineFile: baselineFile }),
    /Undeclared GAS changes/
  );
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
    captureGasBackup: (_root, backup) => {
      write(path.join(backup, '.clasp.json'), '{}\n');
      write(path.join(backup, 'sheetAPI.js'), 'const capabilities = [];\n');
      return backup;
    },
    deployGas: () => { deploys += 1; },
    installRuntime: () => {
      installs += 1;
      return { destination: path.join(hermesHome, 'scripts/village'), backup: null };
    }
  });
  assert.equal(promoted.ok, true);
  assert.equal(deploys, 1);
  assert.equal(installs, 1);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(
      hermesHome,
      'learning/village-capability-promotions/active-promotion.json'
    ), 'utf8')).promotionId,
    promoted.promotionId
  );

  write(path.join(root, 'sheetAPI.js'), 'const capabilities = [];\n');
  await assert.rejects(
    () => promoteCandidate({
      capability: 'new.operation',
      validationId: validated.validationId
    }, { hermesHome, deployGas: () => {}, installRuntime: () => ({}) }),
    /changed after testing/
  );
});

test('a partial promotion keeps a pre-mutation receipt and can roll back both surfaces', async (t) => {
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

  let deployed = 0;
  const failed = await promoteCandidate({
    capability: 'new.operation',
    validationId: validated.validationId
  }, {
    hermesHome,
    captureGasBackup: (_root, backup) => {
      const promotionId = path.basename(backup).match(/^promotion-(.+)-gas-backup$/)?.[1];
      assert.ok(promotionId);
      assert.ok(fs.existsSync(path.join(
        hermesHome,
        'learning/village-capability-promotions',
        `promotion-${promotionId}.json`
      )), 'recovery receipt must exist before the remote preflight');
      assert.equal(fs.existsSync(path.join(
        hermesHome,
        'learning/village-capability-promotions/active-promotion.json'
      )), false, 'the active generation must be claimed only after its rollback snapshot is durable');
      write(path.join(backup, '.clasp.json'), '{}\n');
      write(path.join(backup, 'sheetAPI.js'), 'const capabilities = [];\n');
      return backup;
    },
    deployGas: () => { deployed += 1; },
    installRuntime: () => { throw new Error('synthetic runtime swap failure'); }
  });

  assert.equal(deployed, 1);
  assert.equal(failed.ok, false);
  assert.equal(failed.status, 'PROMOTION_RECOVERY_REQUIRED');
  assert.equal(failed.recoveryRequired, true);
  const receiptPath = path.join(
    hermesHome,
    'learning/village-capability-promotions',
    `promotion-${failed.promotionId}.json`
  );
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  assert.equal(receipt.status, 'recovery_required');
  assert.equal(receipt.serverDeployed, true);
  assert.ok(fs.existsSync(receipt.gasBackup));

  let runtimeRestores = 0;
  let gasRestores = 0;
  const rolledBack = await rollbackPromotion({
    capability: 'new.operation',
    promotionId: failed.promotionId
  }, {
    hermesHome,
    preflightGasRollback: () => ({ verified: true }),
    restoreRuntime: () => {
      runtimeRestores += 1;
      return { restored: true, noRuntimeMutation: true };
    },
    restoreGas: () => {
      gasRestores += 1;
      return { restored: true };
    }
  });
  assert.equal(rolledBack.ok, true);
  assert.equal(rolledBack.rolledBack, true);
  assert.equal(runtimeRestores, 1);
  assert.equal(gasRestores, 1);
  assert.equal(JSON.parse(fs.readFileSync(receiptPath, 'utf8')).status, 'rolled_back');
  assert.equal(fs.existsSync(path.join(
    hermesHome,
    'learning/village-capability-promotions/active-promotion.json'
  )), false);
});

test('a later promote discovers and returns the recoverable active generation', async (t) => {
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
  const directory = path.join(hermesHome, 'learning/village-capability-promotions');
  const interruptedId = crypto.randomUUID();
  const backup = path.join(directory, `promotion-${interruptedId}-gas-backup`);
  write(path.join(backup, '.clasp.json'), '{}\n');
  write(path.join(backup, 'sheetAPI.js'), 'const capabilities = [];\n');
  write(path.join(directory, `promotion-${interruptedId}.json`), JSON.stringify({
    kind: 'promotion',
    promotionId: interruptedId,
    capability: 'interrupted.operation',
    status: 'preflighted',
    gasBackup: backup,
    gasBackupManifest: {},
    runtime: { installed: false }
  }));
  write(path.join(directory, 'active-promotion.json'), JSON.stringify({
    kind: 'active-promotion',
    promotionId: interruptedId,
    capability: 'interrupted.operation'
  }));

  const result = await promoteCandidate({
    capability: 'new.operation',
    validationId: validated.validationId
  }, {
    hermesHome,
    captureGasBackup: (_candidateRoot, target) => {
      write(path.join(target, '.clasp.json'), '{}\n');
      write(path.join(target, 'sheetAPI.js'), 'const capabilities = [];\n');
      return target;
    },
    deployGas: () => { throw new Error('must not deploy while another generation is active'); }
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'PROMOTION_RECOVERY_REQUIRED');
  assert.equal(result.recoveryRequired, true);
  assert.equal(result.promotionId, interruptedId);
});

test('an existing active generation is returned before a later preflight can fail', async (t) => {
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
  const directory = path.join(hermesHome, 'learning/village-capability-promotions');
  const interruptedId = crypto.randomUUID();
  write(path.join(directory, `promotion-${interruptedId}.json`), JSON.stringify({
    kind: 'promotion', promotionId: interruptedId, capability: 'interrupted.operation', status: 'preflighted'
  }));
  write(path.join(directory, 'active-promotion.json'), JSON.stringify({
    kind: 'active-promotion', promotionId: interruptedId, capability: 'interrupted.operation'
  }));
  let captures = 0;

  const result = await promoteCandidate({
    capability: 'new.operation', validationId: validated.validationId
  }, {
    hermesHome,
    captureGasBackup: () => {
      captures += 1;
      throw new Error('later preflight must not run while recovery is active');
    }
  });

  assert.equal(result.status, 'PROMOTION_RECOVERY_REQUIRED');
  assert.equal(result.promotionId, interruptedId);
  assert.equal(result.capability, 'interrupted.operation');
  assert.equal(captures, 0);
});

test('a partial active pointer is repaired from its durable promotion receipt', async (t) => {
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
  const directory = path.join(hermesHome, 'learning/village-capability-promotions');
  const interruptedId = crypto.randomUUID();
  write(path.join(directory, `promotion-${interruptedId}.json`), JSON.stringify({
    kind: 'promotion', promotionId: interruptedId, capability: 'interrupted.operation', status: 'preflighted'
  }));
  write(path.join(directory, 'active-promotion.json'), '');

  const result = await promoteCandidate({
    capability: 'new.operation', validationId: validated.validationId
  }, {
    hermesHome,
    captureGasBackup: () => { throw new Error('must recover the interrupted generation first'); }
  });

  assert.equal(result.status, 'PROMOTION_RECOVERY_REQUIRED');
  assert.equal(result.promotionId, interruptedId);
  const repaired = JSON.parse(fs.readFileSync(path.join(directory, 'active-promotion.json'), 'utf8'));
  assert.equal(repaired.promotionId, interruptedId);
});

test('rollback refuses a stale generation before touching runtime or GAS', async (t) => {
  const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'village-capability-stale-'));
  t.after(() => fs.rmSync(hermesHome, { recursive: true, force: true }));
  const directory = path.join(hermesHome, 'learning/village-capability-promotions');
  const oldId = crypto.randomUUID();
  const currentId = crypto.randomUUID();
  write(path.join(directory, `promotion-${oldId}.json`), JSON.stringify({
    kind: 'promotion',
    promotionId: oldId,
    capability: 'new.operation',
    status: 'recovery_required',
    runtime: { destination: path.join(hermesHome, 'scripts/village'), backup: 'old-backup' },
    gasBackup: 'old-gas-backup'
  }));
  write(path.join(directory, 'active-promotion.json'), JSON.stringify({
    kind: 'active-promotion',
    promotionId: currentId,
    capability: 'newer.operation'
  }));
  let restores = 0;
  const result = await rollbackPromotion({ capability: 'new.operation', promotionId: oldId }, {
    hermesHome,
    restoreRuntime: () => { restores += 1; return { restored: true }; },
    restoreGas: () => { restores += 1; return { restored: true }; }
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'STALE_PROMOTION');
  assert.equal(restores, 0);
});

test('rollback cannot report success when runtime restoration did not happen', async (t) => {
  const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'village-capability-split-'));
  t.after(() => fs.rmSync(hermesHome, { recursive: true, force: true }));
  const directory = path.join(hermesHome, 'learning/village-capability-promotions');
  const promotionId = crypto.randomUUID();
  write(path.join(directory, `promotion-${promotionId}.json`), JSON.stringify({
    kind: 'promotion',
    promotionId,
    capability: 'new.operation',
    status: 'recovery_required',
    deployAttempted: true,
    runtime: { destination: path.join(hermesHome, 'scripts/village'), installed: true },
    gasBackup: 'gas-backup'
  }));
  write(path.join(directory, 'active-promotion.json'), JSON.stringify({
    kind: 'active-promotion',
    promotionId,
    capability: 'new.operation'
  }));
  let gasRestores = 0;
  const result = await rollbackPromotion({ capability: 'new.operation', promotionId }, {
    hermesHome,
    preflightGasRollback: () => ({ verified: true }),
    restoreRuntime: () => ({ restored: false, reason: 'missing_backup' }),
    restoreGas: () => { gasRestores += 1; return { restored: true }; }
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'ROLLBACK_FAILED');
  assert.equal(result.recoveryRequired, true);
  assert.equal(gasRestores, 0);
});

test('rollback verifies the GAS generation before changing the runtime', async (t) => {
  const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'village-capability-preflight-order-'));
  t.after(() => fs.rmSync(hermesHome, { recursive: true, force: true }));
  const directory = path.join(hermesHome, 'learning/village-capability-promotions');
  const promotionId = crypto.randomUUID();
  write(path.join(directory, `promotion-${promotionId}.json`), JSON.stringify({
    kind: 'promotion', promotionId, capability: 'new.operation', status: 'recovery_required', deployAttempted: true
  }));
  write(path.join(directory, 'active-promotion.json'), JSON.stringify({
    kind: 'active-promotion', promotionId, capability: 'new.operation'
  }));
  let runtimeRestores = 0;
  const result = await rollbackPromotion({ capability: 'new.operation', promotionId }, {
    hermesHome,
    preflightGasRollback: () => { throw new Error('live GAS belongs to another generation'); },
    restoreRuntime: () => { runtimeRestores += 1; return { restored: true }; },
    restoreGas: () => ({ restored: true })
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'ROLLBACK_FAILED');
  assert.equal(runtimeRestores, 0);
});

test('rollback resumes after the runtime filesystem swap completed before its journal write', async (t) => {
  const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'village-capability-runtime-journal-'));
  t.after(() => fs.rmSync(hermesHome, { recursive: true, force: true }));
  const directory = path.join(hermesHome, 'learning/village-capability-promotions');
  const destination = path.join(hermesHome, 'scripts/village');
  const backup = path.join(hermesHome, 'scripts/.village-promotion-journal.bak');
  const forward = `${backup}.forward`;
  const promotionId = crypto.randomUUID();
  const promotedSource = 'module.exports = { generation: "promoted" };\n';
  write(path.join(destination, 'village-operation-broker.js'), 'module.exports = { generation: "old" };\n');
  write(path.join(forward, 'village-operation-broker.js'), promotedSource);
  const promotedHash = crypto.createHash('sha256').update(Buffer.from(promotedSource)).digest('hex');
  write(path.join(directory, `promotion-${promotionId}.json`), JSON.stringify({
    kind: 'promotion',
    promotionId,
    capability: 'new.operation',
    status: 'recovery_required',
    deployAttempted: true,
    manifest: { runtimeFiles: ['scripts/windows/village-operation-broker.js'] },
    hashes: { 'scripts/windows/village-operation-broker.js': promotedHash },
    runtime: { destination, backup, previousExisted: true, installed: true },
    gasBackup: 'gas-backup'
  }));
  write(path.join(directory, 'active-promotion.json'), JSON.stringify({
    kind: 'active-promotion', promotionId, capability: 'new.operation'
  }));
  let gasRestores = 0;

  const result = await rollbackPromotion({ capability: 'new.operation', promotionId }, {
    hermesHome,
    preflightGasRollback: () => ({ verified: true }),
    restoreGas: () => { gasRestores += 1; return { restored: true }; }
  });

  assert.equal(result.ok, true);
  assert.equal(result.runtime.recoveredFromFilesystem, true);
  assert.equal(gasRestores, 1);
});

test('rollback repairs a crash between moving promoted runtime aside and restoring its backup', async (t) => {
  const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'village-capability-runtime-mid-swap-'));
  t.after(() => fs.rmSync(hermesHome, { recursive: true, force: true }));
  const directory = path.join(hermesHome, 'learning/village-capability-promotions');
  const destination = path.join(hermesHome, 'scripts/village');
  const backup = path.join(hermesHome, 'scripts/.village-promotion-mid-swap.bak');
  const forward = `${backup}.forward`;
  const promotionId = crypto.randomUUID();
  const promotedSource = 'module.exports = { generation: "promoted" };\n';
  const oldSource = 'module.exports = { generation: "old" };\n';
  write(path.join(backup, 'village-operation-broker.js'), oldSource);
  write(path.join(forward, 'village-operation-broker.js'), promotedSource);
  const promotedHash = crypto.createHash('sha256').update(Buffer.from(promotedSource)).digest('hex');
  write(path.join(directory, `promotion-${promotionId}.json`), JSON.stringify({
    kind: 'promotion',
    promotionId,
    capability: 'new.operation',
    status: 'recovery_required',
    deployAttempted: true,
    manifest: { runtimeFiles: ['scripts/windows/village-operation-broker.js'] },
    hashes: { 'scripts/windows/village-operation-broker.js': promotedHash },
    runtime: { destination, backup, previousExisted: true, installed: true },
    gasBackup: 'gas-backup'
  }));
  write(path.join(directory, 'active-promotion.json'), JSON.stringify({
    kind: 'active-promotion', promotionId, capability: 'new.operation'
  }));
  let gasRestores = 0;

  const result = await rollbackPromotion({ capability: 'new.operation', promotionId }, {
    hermesHome,
    preflightGasRollback: () => ({ verified: true }),
    restoreGas: () => { gasRestores += 1; return { restored: true }; }
  });

  assert.equal(result.ok, true);
  assert.equal(result.runtime.recoveredFromMidSwap, true);
  assert.equal(fs.readFileSync(path.join(destination, 'village-operation-broker.js'), 'utf8'), oldSource);
  assert.equal(gasRestores, 1);
});

test('finalized rollback and confirmation receipts replay success after response loss', async (t) => {
  const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'village-capability-final-replay-'));
  t.after(() => fs.rmSync(hermesHome, { recursive: true, force: true }));
  const directory = path.join(hermesHome, 'learning/village-capability-promotions');
  const rolledBackId = crypto.randomUUID();
  const confirmedId = crypto.randomUUID();
  write(path.join(directory, `promotion-${rolledBackId}.json`), JSON.stringify({
    kind: 'promotion', promotionId: rolledBackId, capability: 'rolled.operation', status: 'rolled_back', rolledBack: true
  }));
  write(path.join(directory, `promotion-${confirmedId}.json`), JSON.stringify({
    kind: 'promotion', promotionId: confirmedId, capability: 'confirmed.operation', status: 'confirmed', confirmed: true
  }));

  const rolledBack = await rollbackPromotion({ capability: 'rolled.operation', promotionId: rolledBackId }, { hermesHome });
  const confirmed = await confirmRegistration({ capability: 'confirmed.operation', promotionId: confirmedId }, { hermesHome });

  assert.equal(rolledBack.ok, true);
  assert.equal(rolledBack.rolledBack, true);
  assert.equal(rolledBack.idempotentReplay, true);
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.confirmed, true);
  assert.equal(confirmed.idempotentReplay, true);
});

test('confirmation requires both the freshly installed broker and the live server catalog', async (t) => {
  const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'village-capability-confirm-'));
  t.after(() => fs.rmSync(hermesHome, { recursive: true, force: true }));
  const installedBroker = [
    "const fs = require('node:fs');",
    "JSON.parse(fs.readFileSync(0, 'utf8'));",
    "process.stdout.write(JSON.stringify({ ok: true, capabilities: [{ id: 'new.operation' }] }));"
  ].join('\n');
  write(path.join(hermesHome, 'scripts/village/village-operation-broker.js'), installedBroker);
  const installedHash = crypto.createHash('sha256').update(Buffer.from(installedBroker)).digest('hex');
  const promotionId = crypto.randomUUID();
  write(path.join(
    hermesHome,
    'learning/village-capability-promotions',
    `promotion-${promotionId}.json`
  ), JSON.stringify({
    kind: 'promotion',
    promotionId,
    capability: 'new.operation',
    manifest: { runtimeFiles: ['scripts/windows/village-operation-broker.js'] },
    hashes: { 'scripts/windows/village-operation-broker.js': installedHash },
    runtime: { destination: path.join(hermesHome, 'scripts/village'), backup: null, installed: true },
    expectedDeployedGasManifest: { 'sheetAPI.js': 'deployed-hash' },
    confirmed: false
  }));
  write(path.join(
    hermesHome,
    'learning/village-capability-promotions/active-promotion.json'
  ), JSON.stringify({ kind: 'active-promotion', promotionId, capability: 'new.operation' }));

  const missing = await confirmRegistration({ capability: 'new.operation', promotionId }, {
    hermesHome,
    config: {
      VILLAGE2_API_URL: 'https://script.google.com/macros/s/example/exec',
      VILLAGE2_API_KEY: 'test-key'
    },
    confirmGasGeneration: () => ({ confirmed: true }),
    fetchImpl: async () => ({ ok: true, json: async () => ({ capabilities: [] }) })
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.runtimeConfirmed, true);
  assert.equal(missing.liveCatalogConfirmed, false);
  assert.equal(missing.promotionId, promotionId);
  assert.equal(missing.rollbackAvailable, true);

  const wrongGeneration = await confirmRegistration({ capability: 'new.operation', promotionId }, {
    hermesHome,
    config: {
      VILLAGE2_API_URL: 'https://script.google.com/macros/s/example/exec',
      VILLAGE2_API_KEY: 'test-key'
    },
    confirmGasGeneration: () => ({ confirmed: false, reason: 'hash_mismatch' }),
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ capabilities: [{ id: 'new.operation' }] })
    })
  });
  assert.equal(wrongGeneration.ok, false);
  assert.equal(wrongGeneration.gasGenerationConfirmed, false);
  assert.equal(wrongGeneration.rollbackAvailable, true);

  const confirmed = await confirmRegistration({ capability: 'new.operation', promotionId }, {
    hermesHome,
    config: {
      VILLAGE2_API_URL: 'https://script.google.com/macros/s/example/exec',
      VILLAGE2_API_KEY: 'test-key'
    },
    confirmGasGeneration: () => ({ confirmed: true }),
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ capabilities: [{ id: 'new.operation' }] })
    })
  });
  assert.equal(confirmed.ok, true);
  assert.equal(confirmed.runtimeConfirmed, true);
  assert.equal(confirmed.liveCatalogConfirmed, true);
  assert.equal(confirmed.runtimeHashConfirmed, true);
  assert.equal(confirmed.gasGenerationConfirmed, true);
  const baseline = JSON.parse(fs.readFileSync(path.join(
    hermesHome,
    'learning/village-capability-promotions/gas-live-baseline.json'
  ), 'utf8'));
  assert.equal(baseline.promotionId, promotionId);
  assert.deepEqual(baseline.files, { 'sheetAPI.js': 'deployed-hash' });
  assert.equal(fs.existsSync(path.join(
    hermesHome,
    'learning/village-capability-promotions/active-promotion.json'
  )), false);
});
