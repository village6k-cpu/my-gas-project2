const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

function fixture(t) {
  const tempBase = path.resolve(os.tmpdir());
  const dir = fs.mkdtempSync(path.join(tempBase, 'gas-ci-order-'));
  t.after(() => {
    assert.equal(path.dirname(path.resolve(dir)), tempBase);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const origin = path.join(dir, 'origin.git'), repo = path.join(dir, 'repo'), bin = path.join(dir, 'bin');
  fs.mkdirSync(repo); fs.mkdirSync(bin);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--bare', origin); git('init', '-b', 'main');
  git('config', 'user.name', 'CI fixture'); git('config', 'user.email', 'ci@example.invalid');
  fs.writeFileSync(path.join(repo, 'Code.js'), 'const fixture = true;\n');
  git('add', 'Code.js'); git('commit', '-m', 'initial');
  git('remote', 'add', 'origin', origin); git('push', 'origin', 'main');
  const initial = git('rev-parse', 'HEAD');
  git('commit', '--allow-empty', '-m', 'newer');
  const newer = git('rev-parse', 'HEAD');
  git('checkout', '--detach', initial);
  fs.mkdirSync(path.join(repo, 'scripts'));
  fs.copyFileSync(path.join(__dirname, '../scripts/ci-deploy-gas.sh'), path.join(repo, 'scripts/ci-deploy-gas.sh'));
  fs.writeFileSync(path.join(repo, '.clasp.json'), '{}');
  const calls = path.join(dir, 'clasp-calls.log');
  const stub = path.join(bin, 'clasp');
  fs.writeFileSync(stub, `#!/usr/bin/env node
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const command = process.argv[2];
fs.appendFileSync(process.env.TEST_CLASP_CALLS, command + '\\n');
if (command === 'pull') {
  fs.writeFileSync('Code.js', 'const fixture = true;\\n');
  if (process.env.TEST_ADVANCE_ON_PULL === '1')
    execFileSync('git', ['--git-dir', process.env.TEST_ORIGIN, 'update-ref', 'refs/heads/main', process.env.TEST_NEWER]);
} else if (command === 'push') console.log('Script is already up to date.');
else process.exitCode = 8;
`);
  fs.chmodSync(stub, 0o755);
  // Make the newer commit available in the bare fixture without advancing main.
  git('push', 'origin', `${newer}:refs/heads/fixture-newer`);
  return {
    advance: () => git('--git-dir', origin, 'update-ref', 'refs/heads/main', newer),
    run: (extra = {}) => spawnSync('bash', ['scripts/ci-deploy-gas.sh', 'fixture'], {
      cwd: repo, encoding: 'utf8', env: { ...process.env,
        PATH: bin + path.delimiter + process.env.PATH, GITHUB_ACTIONS: 'true', GITHUB_REF: 'refs/heads/main',
        TEST_CLASP_CALLS: calls, TEST_ORIGIN: origin, TEST_NEWER: newer, ...extra }
    }),
    calls: () => fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n') : []
  };
}

test('a queued older commit cannot touch GAS after main has advanced', (t) => {
  const f = fixture(t); f.advance(); const result = f.run();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(f.calls(), []);
});

test('main advancing during the remote read prevents a stale push', (t) => {
  const f = fixture(t); const result = f.run({ TEST_ADVANCE_ON_PULL: '1' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(f.calls(), ['pull']);
});

test('current main still runs drift verification and skips an unchanged deployment', (t) => {
  const f = fixture(t); const result = f.run();
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(f.calls(), ['pull', 'push']);
});

test('CI cannot deploy a feature branch even when called outside its workflow job', (t) => {
  const f = fixture(t); const result = f.run({ GITHUB_REF: 'refs/heads/codex/feature' });
  assert.notEqual(result.status, 0);
  assert.deepEqual(f.calls(), []);
});
