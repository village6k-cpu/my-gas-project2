'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DEFAULT_ENV_FILE, parseEnv } = require('./village-live-read.js');

const DEFAULT_PROJECT_ROOT = 'C:\\Village\\my-gas-project2';
const DEFAULT_DEPLOYMENT_ID = 'AKfycbyRff4-lLXmne-iPIEf87x4-CH_5wb-Uv5dCGymELLrpiKluhg2gDdLdVP4Y0MmxnnT';
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

function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, filePath);
}

function readReceipt(hermesHome, kind, id) {
  if (!/^[a-f0-9-]{16,64}$/i.test(String(id || ''))) throw new Error(`${kind} id is invalid`);
  const filePath = path.join(receiptDirectory(hermesHome), `${kind}-${id}.json`);
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return { filePath, value };
}

function sanitizedTestEnvironment() {
  const env = { ...process.env, VILLAGE_PROMOTION_VALIDATION: '1' };
  for (const name of Object.keys(env)) {
    if (/KEY|TOKEN|SECRET|PASSWORD|COOKIE|CREDENTIAL/i.test(name)) delete env[name];
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
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'village-capability-test-'));
  try {
    run(node, [
      '--permission',
      `--allow-fs-read=${root}`,
      `--allow-fs-write=${tempRoot}`,
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

function assertRemoteGasMatchesHead(root, dependencies = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'village-gas-remote-'));
  try {
    fs.copyFileSync(path.join(root, '.clasp.json'), path.join(temporary, '.clasp.json'));
    run(claspCommand(dependencies), claspArgs(['pull'], dependencies), {
      cwd: temporary,
      label: 'clasp remote drift preflight',
      timeout: 300_000
    });
    for (const entry of fs.readdirSync(temporary, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name === '.clasp.json') continue;
      const head = spawnSync('git', ['show', `HEAD:${entry.name}`], {
        cwd: root,
        encoding: null,
        windowsHide: true,
        shell: false
      });
      if (head.status !== 0 || !Buffer.from(head.stdout || []).equals(fs.readFileSync(path.join(temporary, entry.name)))) {
        throw new Error(`Remote GAS drift must be reconciled before promotion: ${entry.name}`);
      }
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function assertOnlyDeclaredGasChanges(receipt) {
  const declared = new Set(receipt.manifest.gasFiles);
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
  assertOnlyDeclaredGasChanges(receipt);
  assertRemoteGasMatchesHead(root, dependencies);
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

function installRuntime(receipt, hermesHome) {
  const destination = path.join(hermesHome, 'scripts', 'village');
  const parent = path.dirname(destination);
  fs.mkdirSync(parent, { recursive: true });
  const operationId = crypto.randomUUID();
  const staging = path.join(parent, `.village-promotion-${operationId}.tmp`);
  const backup = path.join(parent, `.village-promotion-${operationId}.bak`);
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
  return { destination, backup: movedOld ? backup : null };
}

async function promoteCandidate(request, dependencies = {}) {
  const hermesHome = requireHermesHome(dependencies.hermesHome);
  const { value: receipt } = readReceipt(hermesHome, 'validation', request.validationId);
  if (receipt.capability !== String(request.capability || '').trim()) throw new Error('Validation receipt capability mismatch');
  verifyReceiptFiles(receipt);
  (dependencies.deployGas || deployGas)(receipt, request, dependencies);
  const runtime = (dependencies.installRuntime || installRuntime)(receipt, hermesHome);
  const promotionId = crypto.randomUUID();
  const promotion = {
    kind: 'promotion',
    promotionId,
    validationId: receipt.validationId,
    capability: receipt.capability,
    candidateRoot: receipt.candidateRoot,
    manifest: receipt.manifest,
    hashes: receipt.hashes,
    runtime,
    promotedAt: new Date().toISOString(),
    serverDeployed: true,
    confirmed: false
  };
  writeJsonAtomic(path.join(receiptDirectory(hermesHome), `promotion-${promotionId}.json`), promotion);
  return { ok: true, promoted: true, promotionId, capability: receipt.capability, serverDeployed: true, runtimeInstalled: true };
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

async function confirmRegistration(request, dependencies = {}) {
  const hermesHome = requireHermesHome(dependencies.hermesHome);
  const { filePath, value: promotion } = readReceipt(hermesHome, 'promotion', request.promotionId);
  const capability = String(request.capability || '').trim();
  if (promotion.capability !== capability) throw new Error('Promotion receipt capability mismatch');
  const runtime = installedCatalog(hermesHome, dependencies);
  const live = await liveCatalog(dependencies);
  const runtimeConfirmed = Array.isArray(runtime.capabilities) && runtime.capabilities.some((item) => item.id === capability);
  const liveCatalogConfirmed = Array.isArray(live.capabilities) && live.capabilities.some((item) => item.id === capability);
  if (!runtimeConfirmed || !liveCatalogConfirmed) {
    return { ok: false, confirmed: false, status: 'REGISTRATION_NOT_CONFIRMED', capability, runtimeConfirmed, liveCatalogConfirmed, retrySafe: true };
  }
  promotion.confirmed = true;
  promotion.confirmedAt = new Date().toISOString();
  writeJsonAtomic(filePath, promotion);
  if (promotion.runtime?.backup) fs.rmSync(promotion.runtime.backup, { recursive: true, force: true });
  return { ok: true, confirmed: true, capability, runtimeConfirmed: true, liveCatalogConfirmed: true, resumeOriginalRequest: true };
}

module.exports = {
  FIXED_TESTS,
  confirmRegistration,
  normalizeManifest,
  promoteCandidate,
  validateCandidate
};
