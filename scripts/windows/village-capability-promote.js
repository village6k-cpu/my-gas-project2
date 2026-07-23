'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DEFAULT_ENV_FILE, parseEnv } = require('./village-live-read.js');

const DEFAULT_PROJECT_ROOT = 'C:\\Village\\my-gas-project2';
const DEFAULT_DEPLOYMENT_ID = 'AKfycbyRff4-lLXmne-iPIEf87x4-CH_5wb-Uv5dCGymELLrpiKluhg2gDdLdVP4Y0MmxnnT';
const NETWORK_ISOLATION_PRELOAD = path.join(__dirname, 'village-network-isolation-preload.js');
const FIXED_TESTS = Object.freeze([
  'test/windows-village-operation-broker.test.js',
  'test/registered-village-capability-catalog.static.test.js'
]);

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function requireHermesHome(value = process.env.HERMES_HOME) {
  if (!value) throw new Error('HERMES_HOME is required for capability promotion');
  return path.resolve(value);
}

function requireCanonicalRoot(value, expected = process.env.VILLAGE_PROJECT_ROOT || DEFAULT_PROJECT_ROOT) {
  if (!value) throw new Error('candidateRoot is required');
  const root = path.resolve(value);
  if (!samePath(root, expected)) {
    throw new Error(`Capability promotion is restricted to the canonical main worktree: ${path.resolve(expected)}`);
  }
  if (!fs.existsSync(path.join(root, '.git'))) throw new Error(`Canonical project root is not a Git worktree: ${root}`);
  return root;
}

function normalizeRelativeList(values, { prefix, pattern, name }) {
  const result = [];
  for (const raw of Array.isArray(values) ? values : []) {
    const item = String(raw || '').replaceAll('\\', '/').replace(/^\.\//, '');
    if (!item || path.posix.isAbsolute(item) || item.split('/').includes('..')) {
      throw new Error(`${name} contains an unsafe path`);
    }
    if (prefix && !item.startsWith(prefix)) throw new Error(`${name} must stay under ${prefix}`);
    if (pattern && !pattern.test(item)) throw new Error(`${name} contains an unsupported file: ${item}`);
    if (!result.includes(item)) result.push(item);
  }
  return result;
}

function normalizeManifest(request) {
  const runtimeFiles = normalizeRelativeList(
    request.runtimeFiles || ['scripts/windows/village-operation-broker.js'],
    { prefix: 'scripts/windows/', pattern: /\.js$/i, name: 'runtimeFiles' }
  );
  const gasFiles = normalizeRelativeList(
    request.gasFiles || ['sheetAPI.js'],
    { pattern: /^[^/]+\.(?:js|gs)$/i, name: 'gasFiles' }
  );
  const testFiles = normalizeRelativeList(
    request.testFiles,
    { prefix: 'test/', pattern: /\.test\.js$/i, name: 'testFiles' }
  );
  if (!testFiles.length) throw new Error('validate_candidate requires at least one focused test file');
  return { runtimeFiles, gasFiles, testFiles };
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function assertFiles(root, relativeFiles) {
  const hashes = {};
  for (const relative of relativeFiles) {
    const absolute = path.join(root, ...relative.split('/'));
    if (!fs.statSync(absolute, { throwIfNoEntry: false })?.isFile()) {
      throw new Error(`Capability candidate file is missing: ${relative}`);
    }
    hashes[relative] = sha256(absolute);
  }
  return hashes;
}

function assertCapabilityDeclared(root, capability) {
  const escaped = String(capability || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (!escaped) throw new Error('capability is required');
  const broker = fs.readFileSync(path.join(root, 'scripts', 'windows', 'village-operation-broker.js'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'sheetAPI.js'), 'utf8');
  if (!new RegExp(`["']${escaped}["']\\s*:\\s*capability\\s*\\(`).test(broker)) {
    throw new Error(`Candidate broker does not register capability: ${capability}`);
  }
  if (!new RegExp(`id\\s*:\\s*["']${escaped}["']`).test(server)) {
    throw new Error(`Server catalog does not register capability: ${capability}`);
  }
}

function run(command, args, options = {}) {
  const completed = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env || process.env,
    encoding: 'utf8',
    windowsHide: true,
    input: options.input,
    timeout: options.timeout || 300_000,
    shell: false
  });
  if (completed.error) throw completed.error;
  if (completed.status !== 0) {
    const detail = String(completed.stderr || completed.stdout || '').trim().slice(-4000);
    throw new Error(`${options.label || command} failed: ${detail || `exit ${completed.status}`}`);
  }
  return completed;
}

function requireMainBranch(root) {
  const branch = run('git', ['branch', '--show-current'], { cwd: root, label: 'git branch check' }).stdout.trim();
  if (branch !== 'main') throw new Error(`Capability promotion requires branch main, got: ${branch || '(detached)'}`);
}

function receiptDirectory(hermesHome) {
  const directory = path.join(hermesHome, 'learning', 'village-capability-promotions');
  fs.mkdirSync(directory, { recursive: true });
  return directory;
}

function activePromotionPath(hermesHome) {
  return path.join(receiptDirectory(hermesHome), 'active-promotion.json');
}

function gasBaselinePath(hermesHome) {
  return path.join(receiptDirectory(hermesHome), 'gas-live-baseline.json');
}

function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filePath);
}

function writeJsonExclusiveAtomic(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx');
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    // The fully written temporary file is linked into place atomically. Unlike
    // open('wx') followed by an in-place write, a hard kill can never expose a
    // partial JSON claim at the shared path.
    fs.linkSync(temporary, filePath);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

function readReceipt(hermesHome, kind, id) {
  if (!/^[a-f0-9-]{16,64}$/i.test(String(id || ''))) throw new Error(`${kind} id is invalid`);
  const filePath = path.join(receiptDirectory(hermesHome), `${kind}-${id}.json`);
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return { filePath, value };
}

function readJsonIfExists(filePath) {
  if (!fs.statSync(filePath, { throwIfNoEntry: false })?.isFile()) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function finalizedPromotionStatus(status) {
  return ['confirmed', 'rolled_back', 'precheck_failed'].includes(status);
}

function recoverMalformedActivePromotion(hermesHome, filePath) {
  const directory = receiptDirectory(hermesHome);
  const candidates = [];
  for (const name of fs.readdirSync(directory)) {
    if (!/^promotion-[a-f0-9-]{16,64}\.json$/i.test(name)) continue;
    try {
      const value = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
      if (!value?.promotionId || !value?.capability || finalizedPromotionStatus(value.status)) continue;
      if (['prepared', 'blocked_by_active_promotion', 'precheck_failed'].includes(value.status)) continue;
      const stat = fs.statSync(path.join(directory, name));
      candidates.push({
        value,
        liveMutation: value.deployAttempted === true || value.serverDeployed === true,
        modifiedAt: stat.mtimeMs
      });
    } catch (_) {
      // An individual bad receipt is not allowed to hide another durable one.
    }
  }
  candidates.sort((left, right) => Number(right.liveMutation) - Number(left.liveMutation) || right.modifiedAt - left.modifiedAt);
  const recovered = candidates[0]?.value || null;
  const quarantine = `${filePath}.corrupt-${Date.now()}-${crypto.randomUUID()}`;
  try {
    fs.renameSync(filePath, quarantine);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (!recovered) return null;
  const descriptor = {
    kind: 'active-promotion',
    promotionId: recovered.promotionId,
    capability: recovered.capability,
    claimedAt: recovered.preparedAt || new Date().toISOString(),
    recoveredFromMalformedPointer: true
  };
  try {
    writeJsonExclusiveAtomic(filePath, descriptor);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  return readJsonIfExists(filePath);
}

function activePromotion(hermesHome) {
  const filePath = activePromotionPath(hermesHome);
  if (!fs.statSync(filePath, { throwIfNoEntry: false })?.isFile()) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return recoverMalformedActivePromotion(hermesHome, filePath);
  }
}

function recoverableActivePromotion(hermesHome) {
  const active = activePromotion(hermesHome);
  if (!active?.promotionId) return active;
  try {
    const { value } = readReceipt(hermesHome, 'promotion', active.promotionId);
    if (finalizedPromotionStatus(value.status)) {
      clearActivePromotion(hermesHome, active.promotionId);
      return null;
    }
  } catch (_) {
    // A claim without a readable receipt is retained for operator recovery.
  }
  return active;
}

function claimActivePromotion(hermesHome, promotion) {
  const filePath = activePromotionPath(hermesHome);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeJsonExclusiveAtomic(filePath, {
        kind: 'active-promotion',
        promotionId: promotion.promotionId,
        capability: promotion.capability,
        claimedAt: new Date().toISOString()
      });
      return filePath;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const active = activePromotion(hermesHome);
      let finalized = false;
      if (active?.promotionId) {
        try {
          const { value } = readReceipt(hermesHome, 'promotion', active.promotionId);
          finalized = finalizedPromotionStatus(value.status);
        } catch (_) {
          finalized = false;
        }
      }
      if (!finalized || attempt > 0) {
        throw new Error(`Another capability promotion is still active: ${active?.promotionId || 'unknown'}`);
      }
      fs.rmSync(filePath, { force: true });
    }
  }
  throw new Error('Unable to claim the capability promotion generation');
}

function clearActivePromotion(hermesHome, promotionId) {
  const filePath = activePromotionPath(hermesHome);
  const active = readJsonIfExists(filePath);
  if (!active) return;
  if (active.promotionId !== promotionId) {
    throw new Error(`Active promotion generation changed to ${active.promotionId || 'unknown'}`);
  }
  fs.rmSync(filePath, { force: true });
}

function sanitizedTestEnvironment() {
  const env = { ...process.env, VILLAGE_PROMOTION_VALIDATION: '1' };
  for (const name of Object.keys(env)) {
    if (
      /KEY|TOKEN|SECRET|PASSWORD|COOKIE|CREDENTIAL/i.test(name)
      || /^(?:NODE_OPTIONS|NODE_PATH)$/i.test(name)
    ) delete env[name];
  }
  return env;
}

async function validateCandidate(request, dependencies = {}) {
  const root = requireCanonicalRoot(request.candidateRoot, dependencies.expectedRoot);
  requireMainBranch(root);
  const capability = String(request.capability || '').trim();
  const manifest = normalizeManifest(request);
  assertCapabilityDeclared(root, capability);
  const allFiles = [...new Set([
    'scripts/windows/village-operation-broker.js',
    'sheetAPI.js',
    ...manifest.runtimeFiles,
    ...manifest.gasFiles,
    ...manifest.testFiles,
    ...FIXED_TESTS
  ])];
  const hashes = assertFiles(root, allFiles);
  const tests = [...new Set([...FIXED_TESTS, ...manifest.testFiles])];
  const node = dependencies.nodePath || process.execPath;
  if (!fs.statSync(NETWORK_ISOLATION_PRELOAD, { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`Capability validation network guard is missing: ${NETWORK_ISOLATION_PRELOAD}`);
  }
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'village-capability-test-'));
  try {
    run(node, [
      '--permission',
      `--allow-fs-read=${root}`,
      `--allow-fs-read=${NETWORK_ISOLATION_PRELOAD}`,
      `--allow-fs-write=${tempRoot}`,
      `--require=${NETWORK_ISOLATION_PRELOAD}`,
      '--test',
      ...tests
    ], {
      cwd: root,
      env: sanitizedTestEnvironment(),
      label: 'network-isolated capability tests'
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  const hermesHome = requireHermesHome(dependencies.hermesHome);
  const validationId = crypto.randomUUID();
  const receipt = {
    kind: 'validation',
    validationId,
    capability,
    candidateRoot: root,
    manifest,
    hashes,
    validatedAt: new Date().toISOString(),
    networkIsolatedTests: true
  };
  writeJsonAtomic(path.join(receiptDirectory(hermesHome), `validation-${validationId}.json`), receipt);
  return { ok: true, validated: true, validationId, capability, tests, networkIsolated: true };
}

function verifyReceiptFiles(receipt) {
  const current = assertFiles(receipt.candidateRoot, Object.keys(receipt.hashes));
  for (const [relative, expected] of Object.entries(receipt.hashes)) {
    if (current[relative] !== expected) throw new Error(`Validated capability file changed after testing: ${relative}`);
  }
}

function claspCommand(dependencies = {}) {
  if (dependencies.claspCommand) return dependencies.claspCommand;
  if (process.env.VILLAGE_CLASP_COMMAND) return process.env.VILLAGE_CLASP_COMMAND;
  return process.platform === 'win32' ? 'npx.cmd' : 'npx';
}

function claspArgs(args, dependencies = {}) {
  if (dependencies.claspCommand || process.env.VILLAGE_CLASP_COMMAND) return args;
  return ['--yes', '@google/clasp', ...args];
}

function snapshotManifest(directory) {
  const files = {};
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile()) {
        const relative = path.relative(directory, absolute).replaceAll('\\', '/');
        if (relative !== '.clasp.json') files[relative] = sha256(absolute);
      }
    }
  };
  visit(directory);
  return Object.fromEntries(Object.entries(files).sort(([left], [right]) => left.localeCompare(right)));
}

function manifestsEqual(left, right) {
  const leftEntries = Object.entries(left || {}).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right || {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

function pullRemoteGasSnapshot(root, destination, dependencies = {}) {
  fs.mkdirSync(destination, { recursive: true });
  try {
    fs.copyFileSync(path.join(root, '.clasp.json'), path.join(destination, '.clasp.json'));
    run(claspCommand(dependencies), claspArgs(['pull'], dependencies), {
      cwd: destination,
      label: dependencies.pullLabel || 'clasp remote snapshot',
      timeout: 300_000
    });
    return { directory: destination, manifest: snapshotManifest(destination) };
  } catch (error) {
    fs.rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

function assertRemoteSnapshotCurrent(root, snapshot, baselineFile) {
  const baseline = baselineFile ? readJsonIfExists(baselineFile) : null;
  if (baseline?.files) {
    if (!manifestsEqual(snapshot.manifest, baseline.files)) {
      throw new Error('Remote GAS drift must be reconciled before promotion: live source differs from the last confirmed promotion baseline');
    }
    return { source: 'confirmed_promotion_baseline', promotionId: baseline.promotionId || null };
  }
  for (const relative of Object.keys(snapshot.manifest)) {
    const head = spawnSync('git', ['show', `HEAD:${relative}`], {
      cwd: root,
      encoding: null,
      windowsHide: true,
      shell: false
    });
    const remoteFile = path.join(snapshot.directory, ...relative.split('/'));
    if (head.status !== 0 || !Buffer.from(head.stdout || []).equals(fs.readFileSync(remoteFile))) {
      throw new Error(`Remote GAS drift must be reconciled before promotion: ${relative}`);
    }
  }
  return { source: 'git_head' };
}

function captureRemoteGasSnapshot(root, backupDirectory, dependencies = {}) {
  const snapshot = pullRemoteGasSnapshot(root, backupDirectory, {
    ...dependencies,
    pullLabel: 'clasp remote drift preflight'
  });
  try {
    const basis = assertRemoteSnapshotCurrent(root, snapshot, dependencies.gasBaselineFile);
    if (basis.source === 'git_head') {
      for (const relative of dependencies.expectedHeadGasFiles || []) {
        const tracked = spawnSync('git', ['cat-file', '-e', `HEAD:${relative}`], {
          cwd: root,
          windowsHide: true,
          shell: false
        });
        if (tracked.status === 0 && !snapshot.manifest[relative]) {
          throw new Error(`Remote GAS drift must be reconciled before promotion: tracked file missing remotely: ${relative}`);
        }
      }
    }
    return { ...snapshot, basis };
  } catch (error) {
    fs.rmSync(backupDirectory, { recursive: true, force: true });
    throw error;
  }
}

function expectedDeployedGasManifest(validation, backupManifest) {
  const expected = { ...(backupManifest || {}) };
  for (const relative of validation.manifest.gasFiles) expected[relative] = validation.hashes[relative];
  return Object.fromEntries(Object.entries(expected).sort(([left], [right]) => left.localeCompare(right)));
}

function assertOnlyDeclaredGasChanges(receipt, dependencies = {}) {
  const declared = new Set(receipt.manifest.gasFiles);
  const baseline = dependencies.gasBaselineFile
    ? readJsonIfExists(dependencies.gasBaselineFile)
    : null;
  const completed = run('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd: receipt.candidateRoot,
    label: 'candidate change inventory'
  });
  const undeclared = [];
  for (const line of completed.stdout.split(/\r?\n/)) {
    if (!line) continue;
    const raw = line.slice(3).trim().replace(/^"|"$/g, '').replaceAll('\\', '/');
    const relative = raw.includes(' -> ') ? raw.split(' -> ').at(-1) : raw;
    if (!relative.includes('/') && /\.(?:js|gs|html|json)$/i.test(relative) && !declared.has(relative)) {
      const absolute = path.join(receipt.candidateRoot, relative);
      const confirmedHash = baseline?.files?.[relative];
      if (confirmedHash && fs.statSync(absolute, { throwIfNoEntry: false })?.isFile() && sha256(absolute) === confirmedHash) {
        continue;
      }
      undeclared.push(relative);
    }
  }
  if (undeclared.length) {
    throw new Error(`Undeclared GAS changes must be reconciled before promotion: ${undeclared.join(', ')}`);
  }
}

function deployGas(receipt, request, dependencies = {}) {
  const root = receipt.candidateRoot;
  requireMainBranch(root);
  assertOnlyDeclaredGasChanges(receipt, dependencies);
  const description = String(request.deploymentDescription || `Village capability ${receipt.capability}`).slice(0, 200);
  run(claspCommand(dependencies), claspArgs(['push', '-f'], dependencies), {
    cwd: root,
    label: 'clasp push',
    timeout: 300_000
  });
  run(claspCommand(dependencies), claspArgs([
    'deploy',
    '-i',
    String(request.deploymentId || process.env.VILLAGE_GAS_DEPLOYMENT_ID || DEFAULT_DEPLOYMENT_ID),
    '-d',
    description
  ], dependencies), {
    cwd: root,
    label: 'clasp deploy',
    timeout: 300_000
  });
}

function installRuntime(receipt, hermesHome, plan = {}) {
  const destination = plan.destination || path.join(hermesHome, 'scripts', 'village');
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true });
  const operationId = plan.operationId || crypto.randomUUID();
  const staging = plan.staging || path.join(parent, `.village-promotion-${operationId}.tmp`);
  const backup = plan.backup || path.join(parent, `.village-promotion-${operationId}.bak`);
  if (fs.existsSync(destination)) fs.cpSync(destination, staging, { recursive: true });
  else fs.mkdirSync(staging, { recursive: true });
  for (const relative of receipt.manifest.runtimeFiles) {
    fs.copyFileSync(path.join(receipt.candidateRoot, ...relative.split('/')), path.join(staging, path.basename(relative)));
  }
  let movedOld = false;
  try {
    if (fs.existsSync(destination)) {
      fs.renameSync(destination, backup);
      movedOld = true;
    }
    fs.renameSync(staging, destination);
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    if (movedOld && !fs.existsSync(destination)) fs.renameSync(backup, destination);
    throw error;
  }
  return { destination, backup, previousExisted: movedOld, installed: true };
}

async function promoteCandidate(request, dependencies = {}) {
  const hermesHome = requireHermesHome(dependencies.hermesHome);
  const { value: validation } = readReceipt(hermesHome, 'validation', request.validationId);
  if (validation.capability !== String(request.capability || '').trim()) throw new Error('Validation receipt capability mismatch');
  verifyReceiptFiles(validation);
  const promotionId = crypto.randomUUID();
  const promotionDirectory = receiptDirectory(hermesHome);
  const promotionPath = path.join(promotionDirectory, `promotion-${promotionId}.json`);
  const gasBackup = path.join(promotionDirectory, `promotion-${promotionId}-gas-backup`);
  const runtimeDestination = path.join(hermesHome, 'scripts', 'village');
  const runtimeParent = path.dirname(runtimeDestination);
  const runtime = {
    operationId: promotionId,
    destination: runtimeDestination,
    staging: path.join(runtimeParent, `.village-promotion-${promotionId}.tmp`),
    backup: path.join(runtimeParent, `.village-promotion-${promotionId}.bak`),
    previousExisted: fs.existsSync(runtimeDestination),
    installed: false
  };
  const promotion = {
    kind: 'promotion',
    promotionId,
    validationId: validation.validationId,
    capability: validation.capability,
    candidateRoot: validation.candidateRoot,
    manifest: validation.manifest,
    hashes: validation.hashes,
    gasBackup,
    deploymentId: String(request.deploymentId || process.env.VILLAGE_GAS_DEPLOYMENT_ID || DEFAULT_DEPLOYMENT_ID),
    runtime,
    previousGasBaseline: readJsonIfExists(gasBaselinePath(hermesHome)),
    preparedAt: new Date().toISOString(),
    status: 'prepared',
    deployAttempted: false,
    serverDeployed: false,
    confirmed: false
  };
  // The receipt exists before remote preflight. The exclusive active claim is
  // made only after the rollback snapshot is durable and before live mutation.
  writeJsonAtomic(promotionPath, promotion);
  const existingActive = recoverableActivePromotion(hermesHome);
  if (existingActive) {
    promotion.status = 'blocked_by_active_promotion';
    promotion.error = `Another capability promotion is still active: ${existingActive.promotionId || 'unknown'}`;
    writeJsonAtomic(promotionPath, promotion);
    return {
      ok: false,
      status: 'PROMOTION_RECOVERY_REQUIRED',
      promotionId: existingActive.promotionId || promotionId,
      capability: existingActive.capability || validation.capability,
      requestedCapability: validation.capability,
      recoveryRequired: true,
      error: promotion.error
    };
  }
  let deployAttempted = false;
  try {
    const captured = (dependencies.captureGasBackup || captureRemoteGasSnapshot)(
      validation.candidateRoot,
      gasBackup,
      {
        ...dependencies,
        gasBaselineFile: gasBaselinePath(hermesHome),
        expectedHeadGasFiles: validation.manifest.gasFiles
      }
    );
    promotion.gasBackupManifest = captured?.manifest || snapshotManifest(gasBackup);
    promotion.expectedDeployedGasManifest = expectedDeployedGasManifest(
      validation,
      promotion.gasBackupManifest
    );
    promotion.status = 'preflighted';
    writeJsonAtomic(promotionPath, promotion);
    try {
      claimActivePromotion(hermesHome, promotion);
    } catch (error) {
      const active = activePromotion(hermesHome);
      if (!active) throw error;
      promotion.status = 'blocked_by_active_promotion';
      promotion.error = String(error?.message || error).slice(0, 2000);
      writeJsonAtomic(promotionPath, promotion);
      fs.rmSync(gasBackup, { recursive: true, force: true });
      return {
        ok: false,
        status: 'PROMOTION_RECOVERY_REQUIRED',
        promotionId: active?.promotionId || promotionId,
        capability: active?.capability || validation.capability,
        requestedCapability: validation.capability,
        recoveryRequired: true,
        error: promotion.error
      };
    }
    verifyReceiptFiles(validation);
    promotion.deployAttempted = true;
    promotion.status = 'deploy_started';
    writeJsonAtomic(promotionPath, promotion);
    deployAttempted = true;
    (dependencies.deployGas || deployGas)(
      validation,
      { ...request, deploymentId: promotion.deploymentId },
      { ...dependencies, gasBaselineFile: gasBaselinePath(hermesHome) }
    );
    promotion.serverDeployed = true;
    promotion.status = 'server_deployed';
    writeJsonAtomic(promotionPath, promotion);
    const installed = (dependencies.installRuntime || installRuntime)(validation, hermesHome, runtime);
    promotion.runtime = { ...runtime, ...(installed || {}) };
    promotion.status = 'promoted';
    promotion.promotedAt = new Date().toISOString();
    writeJsonAtomic(promotionPath, promotion);
    return {
      ok: true,
      promoted: true,
      promotionId,
      capability: validation.capability,
      serverDeployed: true,
      runtimeInstalled: true
    };
  } catch (error) {
    if (!deployAttempted) {
      promotion.status = 'precheck_failed';
      promotion.recoveryRequired = false;
      promotion.error = String(error?.message || error).slice(0, 2000);
      promotion.failedAt = new Date().toISOString();
      writeJsonAtomic(promotionPath, promotion);
      const active = activePromotion(hermesHome);
      if (active?.promotionId === promotionId) clearActivePromotion(hermesHome, promotionId);
      fs.rmSync(gasBackup, { recursive: true, force: true });
      return {
        ok: false,
        status: 'PROMOTION_PRECHECK_FAILED',
        promotionId,
        capability: validation.capability,
        recoveryRequired: false,
        serverMayHaveChanged: false,
        error: promotion.error
      };
    }
    promotion.status = 'recovery_required';
    promotion.recoveryRequired = true;
    promotion.error = String(error?.message || error).slice(0, 2000);
    promotion.failedAt = new Date().toISOString();
    try {
      writeJsonAtomic(promotionPath, promotion);
    } catch (_) {
      // The pre-mutation receipt already contains deterministic backup paths.
    }
    return {
      ok: false,
      status: 'PROMOTION_RECOVERY_REQUIRED',
      promotionId,
      capability: validation.capability,
      recoveryRequired: true,
      serverMayHaveChanged: deployAttempted,
      error: promotion.error
    };
  }
}

function installedCatalog(hermesHome, dependencies = {}) {
  const broker = path.join(hermesHome, 'scripts', 'village', 'village-operation-broker.js');
  const completed = run(dependencies.nodePath || process.execPath, [broker], {
    cwd: hermesHome,
    input: JSON.stringify({ phase: 'catalog' }),
    label: 'installed broker catalog'
  });
  return JSON.parse(completed.stdout);
}

async function liveCatalog(dependencies = {}) {
  const config = dependencies.config || parseEnv(fs.readFileSync(dependencies.envFile || DEFAULT_ENV_FILE, 'utf8'));
  const url = new URL(config.VILLAGE2_API_URL);
  if (url.protocol !== 'https:' || url.hostname !== 'script.google.com' || !config.VILLAGE2_API_KEY) {
    throw new Error('Village live catalog configuration is invalid');
  }
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const response = await fetchImpl(url.toString(), {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ key: config.VILLAGE2_API_KEY, action: 'capabilities' }),
    redirect: 'follow',
    signal: AbortSignal.timeout(30_000)
  });
  if (!response?.ok) throw new Error(`Live capability catalog failed with HTTP ${response?.status ?? 'unknown'}`);
  return response.json();
}

function runtimeFilesMatchAt(promotion, destination) {
  if (!destination || !fs.statSync(destination, { throwIfNoEntry: false })?.isDirectory()) return false;
  for (const relative of promotion.manifest?.runtimeFiles || []) {
    const installed = path.join(destination, path.basename(relative));
    const expected = promotion.hashes?.[relative];
    if (!expected || !fs.statSync(installed, { throwIfNoEntry: false })?.isFile() || sha256(installed) !== expected) {
      return false;
    }
  }
  return true;
}

function runtimeMatchesPromotion(promotion) {
  return runtimeFilesMatchAt(promotion, promotion.runtime?.destination);
}

function restoreRuntime(promotion) {
  const runtime = promotion.runtime || {};
  const destination = runtime.destination;
  const backup = runtime.backup;
  if (!destination) return { restored: false, reason: 'no_runtime_plan' };
  const expectedForward = runtime.rollbackForward || (backup ? `${backup}.forward` : '');
  if (
    runtime.previousExisted === true &&
    expectedForward &&
    fs.existsSync(expectedForward) &&
    runtimeFilesMatchAt(promotion, expectedForward) &&
    backup &&
    fs.existsSync(backup) &&
    !fs.existsSync(destination)
  ) {
    fs.renameSync(backup, destination);
    return {
      restored: true,
      previousExisted: true,
      forward: expectedForward,
      recoveredFromMidSwap: true
    };
  }
  if (
    expectedForward &&
    fs.existsSync(expectedForward) &&
    runtimeFilesMatchAt(promotion, expectedForward) &&
    !runtimeMatchesPromotion(promotion)
  ) {
    const previousExisted = fs.existsSync(destination);
    if (runtime.previousExisted === true && !previousExisted) {
      return { restored: false, reason: 'previous_runtime_missing_after_filesystem_swap' };
    }
    if (runtime.previousExisted === false && previousExisted) {
      return { restored: false, reason: 'unexpected_runtime_after_new-install_rollback' };
    }
    return {
      restored: true,
      previousExisted,
      forward: expectedForward,
      recoveredFromFilesystem: true
    };
  }
  if (backup && fs.existsSync(backup)) {
    if (fs.existsSync(destination) && !runtimeMatchesPromotion(promotion)) {
      throw new Error('Installed runtime no longer matches this promotion generation');
    }
    const forward = runtime.rollbackForward || `${backup}.forward`;
    fs.rmSync(forward, { recursive: true, force: true });
    if (fs.existsSync(destination)) fs.renameSync(destination, forward);
    try {
      fs.renameSync(backup, destination);
    } catch (error) {
      if (!fs.existsSync(destination) && fs.existsSync(forward)) fs.renameSync(forward, destination);
      throw error;
    }
    return { restored: true, previousExisted: true, forward };
  }
  if (runtime.previousExisted === false && fs.existsSync(destination) && runtimeMatchesPromotion(promotion)) {
      const forward = runtime.rollbackForward || `${destination}.rollback-forward-${promotion.promotionId}`;
      fs.rmSync(forward, { recursive: true, force: true });
      fs.renameSync(destination, forward);
      return { restored: true, previousExisted: false, forward };
  }
  if (runtime.installed !== true) return { restored: true, noRuntimeMutation: true };
  return { restored: false, reason: 'runtime_was_not_swapped_or_was_already_restored' };
}

function reapplyRuntimeAfterFailedGas(promotion, runtimeResult) {
  const destination = promotion.runtime?.destination;
  const backup = promotion.runtime?.backup;
  const forward = runtimeResult?.forward;
  if (!destination || !forward || !fs.existsSync(forward)) {
    return { reapplied: false, reason: 'forward_runtime_snapshot_missing' };
  }
  if (runtimeResult.previousExisted === true && fs.existsSync(destination)) {
    if (!backup) return { reapplied: false, reason: 'runtime_backup_path_missing' };
    fs.rmSync(backup, { recursive: true, force: true });
    fs.renameSync(destination, backup);
  }
  if (fs.existsSync(destination)) fs.rmSync(destination, { recursive: true, force: true });
  fs.renameSync(forward, destination);
  return { reapplied: true };
}

function verifyGasRollbackGeneration(promotion, dependencies = {}) {
  const backup = promotion.gasBackup;
  if (!backup || !fs.statSync(backup, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error('Promotion GAS rollback snapshot is missing');
  }
  const backupManifest = snapshotManifest(backup);
  if (!manifestsEqual(backupManifest, promotion.gasBackupManifest)) {
    throw new Error('Promotion GAS rollback snapshot no longer matches its receipt');
  }
  const currentDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'village-gas-rollback-check-'));
  try {
    const current = pullRemoteGasSnapshot(promotion.candidateRoot, currentDirectory, {
      ...dependencies,
      pullLabel: 'rollback generation preflight'
    });
    const stillCurrent = manifestsEqual(current.manifest, promotion.expectedDeployedGasManifest);
    const alreadySourceRestored = manifestsEqual(current.manifest, promotion.gasBackupManifest);
    if (!stillCurrent && !alreadySourceRestored) {
      throw new Error('Live GAS no longer matches this promotion generation; refusing stale rollback');
    }
    return { verified: true, alreadySourceRestored };
  } finally {
    fs.rmSync(currentDirectory, { recursive: true, force: true });
  }
}

function restoreGas(promotion, request, dependencies = {}) {
  const backup = promotion.gasBackup;
  if (!dependencies.generationPreflightComplete) {
    verifyGasRollbackGeneration(promotion, dependencies);
  }
  run(claspCommand(dependencies), claspArgs(['push', '-f'], dependencies), {
    cwd: backup,
    label: 'rollback clasp push',
    timeout: 300_000
  });
  run(claspCommand(dependencies), claspArgs([
    'deploy',
    '-i',
    String(promotion.deploymentId || request.deploymentId || DEFAULT_DEPLOYMENT_ID),
    '-d',
    String(request.deploymentDescription || `Rollback Village capability ${promotion.capability}`).slice(0, 200)
  ], dependencies), {
    cwd: backup,
    label: 'rollback clasp deploy',
    timeout: 300_000
  });
  return { restored: true };
}

function restorePreviousGasBaseline(hermesHome, promotion) {
  const baselineFile = gasBaselinePath(hermesHome);
  if (promotion.previousGasBaseline) {
    writeJsonAtomic(baselineFile, promotion.previousGasBaseline);
    return { restored: true, previousPromotionId: promotion.previousGasBaseline.promotionId || null };
  }
  const current = readJsonIfExists(baselineFile);
  if (!current || current.promotionId === promotion.promotionId) fs.rmSync(baselineFile, { force: true });
  return { restored: true, previousPromotionId: null };
}

function confirmGasGeneration(promotion, dependencies = {}) {
  const currentDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'village-gas-confirmation-'));
  try {
    const current = pullRemoteGasSnapshot(promotion.candidateRoot, currentDirectory, {
      ...dependencies,
      pullLabel: 'promotion GAS generation confirmation'
    });
    const confirmed = manifestsEqual(current.manifest, promotion.expectedDeployedGasManifest);
    return { confirmed, reason: confirmed ? 'hashes_match' : 'hash_mismatch' };
  } finally {
    fs.rmSync(currentDirectory, { recursive: true, force: true });
  }
}

async function rollbackPromotion(request, dependencies = {}) {
  const hermesHome = requireHermesHome(dependencies.hermesHome);
  const { filePath, value: promotion } = readReceipt(hermesHome, 'promotion', request.promotionId);
  const capability = String(request.capability || '').trim();
  if (promotion.capability !== capability) throw new Error('Promotion receipt capability mismatch');
  if (promotion.status === 'rolled_back' && promotion.rolledBack === true) {
    return {
      ok: true,
      rolledBack: true,
      promotionId: promotion.promotionId,
      capability,
      runtime: promotion.rollback?.runtime,
      gas: promotion.rollback?.gas,
      idempotentReplay: true
    };
  }
  const active = activePromotion(hermesHome);
  if (!active || active.promotionId !== promotion.promotionId) {
    return {
      ok: false,
      status: 'STALE_PROMOTION',
      promotionId: promotion.promotionId,
      capability,
      recoveryRequired: false,
      activePromotionId: active?.promotionId || null
    };
  }
  if (['confirmed', 'rolled_back'].includes(promotion.status)) {
    return { ok: false, status: 'STALE_PROMOTION', promotionId: promotion.promotionId, capability, recoveryRequired: false };
  }
  if (promotion.deployAttempted !== true && promotion.serverDeployed !== true) {
    const runtime = { restored: true, noRuntimeMutation: true };
    const gas = { restored: true, noGasMutation: true };
    promotion.status = 'rolled_back';
    promotion.rolledBack = true;
    promotion.rolledBackAt = new Date().toISOString();
    promotion.rollback = { runtime, gas, baseline: restorePreviousGasBaseline(hermesHome, promotion) };
    writeJsonAtomic(filePath, promotion);
    clearActivePromotion(hermesHome, promotion.promotionId);
    if (promotion.gasBackup) fs.rmSync(promotion.gasBackup, { recursive: true, force: true });
    return { ok: true, rolledBack: true, promotionId: promotion.promotionId, capability, runtime, gas };
  }
  let runtime;
  let gasRestored = false;
  try {
    const gasPreflight = (dependencies.preflightGasRollback || verifyGasRollbackGeneration)(
      promotion,
      dependencies
    );
    if (gasPreflight?.verified !== true) throw new Error('GAS rollback generation preflight did not complete');
    runtime = promotion.rollback?.runtime;
    if (runtime?.restored !== true) {
      runtime = (dependencies.restoreRuntime || restoreRuntime)(promotion);
      if (runtime?.restored !== true) {
        throw new Error(`Runtime rollback did not complete: ${runtime?.reason || 'unknown'}`);
      }
      promotion.rollback = { ...(promotion.rollback || {}), runtime };
      promotion.status = 'rollback_runtime_restored';
      writeJsonAtomic(filePath, promotion);
    }
    const gas = (dependencies.restoreGas || restoreGas)(promotion, request, {
      ...dependencies,
      generationPreflightComplete: true
    });
    if (gas?.restored !== true) throw new Error('GAS rollback did not complete');
    gasRestored = true;
    promotion.status = 'rolled_back';
    promotion.rolledBack = true;
    promotion.rolledBackAt = new Date().toISOString();
    promotion.rollback = {
      runtime,
      gas,
      baseline: restorePreviousGasBaseline(hermesHome, promotion)
    };
    writeJsonAtomic(filePath, promotion);
    clearActivePromotion(hermesHome, promotion.promotionId);
    if (promotion.gasBackup) fs.rmSync(promotion.gasBackup, { recursive: true, force: true });
    if (runtime?.forward) fs.rmSync(runtime.forward, { recursive: true, force: true });
    return { ok: true, rolledBack: true, promotionId: promotion.promotionId, capability, runtime, gas };
  } catch (error) {
    if (runtime?.restored === true && !runtime.noRuntimeMutation && !gasRestored) {
      const compensation = reapplyRuntimeAfterFailedGas(promotion, runtime);
      promotion.rollback = {
        ...(promotion.rollback || {}),
        runtime: compensation.reapplied
          ? { restored: false, compensated: true }
          : runtime,
        runtimeCompensation: compensation,
      };
    }
    promotion.status = 'rollback_failed';
    promotion.recoveryRequired = true;
    promotion.rollbackError = String(error?.message || error).slice(0, 2000);
    try {
      writeJsonAtomic(filePath, promotion);
    } catch (_) {
      // Keep the original pre-mutation receipt and backup paths intact.
    }
    return {
      ok: false,
      status: 'ROLLBACK_FAILED',
      promotionId: promotion.promotionId,
      capability,
      recoveryRequired: true,
      error: promotion.rollbackError
    };
  }
}

async function confirmRegistration(request, dependencies = {}) {
  const hermesHome = requireHermesHome(dependencies.hermesHome);
  const { filePath, value: promotion } = readReceipt(hermesHome, 'promotion', request.promotionId);
  const capability = String(request.capability || '').trim();
  if (promotion.capability !== capability) throw new Error('Promotion receipt capability mismatch');
  if (promotion.status === 'confirmed' && promotion.confirmed === true) {
    return {
      ok: true,
      confirmed: true,
      promotionId: promotion.promotionId,
      capability,
      runtimeHashConfirmed: promotion.runtimeHashConfirmed === true,
      gasGenerationConfirmed: promotion.gasGenerationConfirmed === true,
      runtimeConfirmed: promotion.runtimeConfirmed === true,
      liveCatalogConfirmed: promotion.liveCatalogConfirmed === true,
      resumeOriginalRequest: true,
      idempotentReplay: true
    };
  }
  const active = activePromotion(hermesHome);
  if (!active || active.promotionId !== promotion.promotionId) {
    return {
      ok: false,
      confirmed: false,
      status: 'STALE_PROMOTION',
      promotionId: promotion.promotionId,
      capability,
      rollbackAvailable: false,
      activePromotionId: active?.promotionId || null
    };
  }
  const runtimeHashConfirmed = runtimeMatchesPromotion(promotion);
  const gasGeneration = (dependencies.confirmGasGeneration || confirmGasGeneration)(promotion, dependencies);
  const gasGenerationConfirmed = gasGeneration?.confirmed === true;
  const runtime = installedCatalog(hermesHome, dependencies);
  const live = await liveCatalog(dependencies);
  const runtimeConfirmed = Array.isArray(runtime.capabilities) && runtime.capabilities.some((item) => item.id === capability);
  const liveCatalogConfirmed = Array.isArray(live.capabilities) && live.capabilities.some((item) => item.id === capability);
  if (!runtimeHashConfirmed || !gasGenerationConfirmed || !runtimeConfirmed || !liveCatalogConfirmed) {
    promotion.status = 'confirmation_pending';
    promotion.runtimeHashConfirmed = runtimeHashConfirmed;
    promotion.gasGenerationConfirmed = gasGenerationConfirmed;
    promotion.runtimeConfirmed = runtimeConfirmed;
    promotion.liveCatalogConfirmed = liveCatalogConfirmed;
    writeJsonAtomic(filePath, promotion);
    return {
      ok: false,
      confirmed: false,
      status: 'REGISTRATION_NOT_CONFIRMED',
      promotionId: promotion.promotionId,
      capability,
      runtimeHashConfirmed,
      gasGenerationConfirmed,
      runtimeConfirmed,
      liveCatalogConfirmed,
      retrySafe: true,
      rollbackAvailable: true
    };
  }
  if (!promotion.expectedDeployedGasManifest || !Object.keys(promotion.expectedDeployedGasManifest).length) {
    throw new Error('Promotion receipt is missing the deployed GAS baseline manifest');
  }
  promotion.status = 'confirming';
  promotion.runtimeHashConfirmed = true;
  promotion.gasGenerationConfirmed = true;
  promotion.runtimeConfirmed = true;
  promotion.liveCatalogConfirmed = true;
  writeJsonAtomic(filePath, promotion);
  writeJsonAtomic(gasBaselinePath(hermesHome), {
    kind: 'gas-live-baseline',
    promotionId: promotion.promotionId,
    capability,
    confirmedAt: new Date().toISOString(),
    files: promotion.expectedDeployedGasManifest
  });
  promotion.confirmed = true;
  promotion.status = 'confirmed';
  promotion.confirmedAt = new Date().toISOString();
  writeJsonAtomic(filePath, promotion);
  clearActivePromotion(hermesHome, promotion.promotionId);
  if (promotion.runtime?.backup) fs.rmSync(promotion.runtime.backup, { recursive: true, force: true });
  if (promotion.gasBackup) fs.rmSync(promotion.gasBackup, { recursive: true, force: true });
  return {
    ok: true,
    confirmed: true,
    promotionId: promotion.promotionId,
    capability,
    runtimeHashConfirmed: true,
    gasGenerationConfirmed: true,
    runtimeConfirmed: true,
    liveCatalogConfirmed: true,
    resumeOriginalRequest: true
  };
}

module.exports = {
  FIXED_TESTS,
  assertOnlyDeclaredGasChanges,
  assertRemoteSnapshotCurrent,
  confirmRegistration,
  manifestsEqual,
  normalizeManifest,
  promoteCandidate,
  rollbackPromotion,
  snapshotManifest,
  validateCandidate
};
