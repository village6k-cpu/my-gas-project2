import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..');
const scriptPath = path.join(repoRoot, 'scripts', 'windows', 'sync-kakao-hermes-plugin.ps1');
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function psLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function makeFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'kakao-hermes-plugin-sync-'));
  const sourceRepo = path.join(root, 'source');
  const source = path.join(sourceRepo, 'migration', 'hermes', 'plugins', 'kakao_village');
  const hermesHome = path.join(root, 'hermes');
  const profile = path.join(hermesHome, 'profiles', 'kakaoworker');
  mkdirSync(path.join(source, 'tests'), { recursive: true });
  mkdirSync(profile, { recursive: true });
  writeFileSync(path.join(source, 'plugin.yaml'), 'name: kakao_village\nkind: platform\nversion: 0.1.0\n');
  writeFileSync(path.join(source, '__init__.py'), 'def register(ctx):\n    return ctx\n');
  writeFileSync(path.join(source, 'adapter.py'), 'VALUE = "fixture"\n');
  writeFileSync(path.join(source, 'README.md'), '# fixture\n');
  writeFileSync(path.join(source, 'tests', 'not-shipped.py'), 'raise AssertionError("must not ship")\n');
  writeFileSync(path.join(profile, 'config.yaml'), [
    'plugins:',
    '  enabled:',
    '    - existing_plugin',
    'platforms:',
    '  slack:',
    '    enabled: true',
    ''
  ].join('\n'));
  git(sourceRepo, 'init');
  git(sourceRepo, 'config', 'user.email', 'fixture@example.invalid');
  git(sourceRepo, 'config', 'user.name', 'Fixture');
  git(sourceRepo, 'add', '.');
  git(sourceRepo, 'commit', '-m', 'fixture');
  return { root, sourceRepo, source, hermesHome, profile };
}

function runSync({ source, hermesHome, planOnly = false, expectOk = true }) {
  const command = [
    '&', psLiteral(scriptPath),
    '-SourcePluginPath', psLiteral(source),
    '-HermesHome', psLiteral(hermesHome),
    ...(planOnly ? ['-PlanOnly'] : [])
  ].join(' ');
  const result = spawnSync(powershell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command
  ], { cwd: repoRoot, encoding: 'utf8' });
  if (expectOk) {
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const line = result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
    return JSON.parse(line);
  }
  assert.notEqual(result.status, 0, 'unsafe source unexpectedly succeeded');
  return `${result.stdout}\n${result.stderr}`;
}

test('PlanOnly reports the exact reviewed manifest and merged config without creating plugin state', () => {
  const fixture = makeFixture();
  const result = runSync({ ...fixture, planOnly: true });
  const target = path.join(fixture.profile, 'plugins', 'kakao_village');

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'plan');
  assert.equal(result.changed, false);
  assert.equal(path.resolve(result.sourcePluginPath), path.resolve(fixture.source));
  assert.equal(path.resolve(result.targetPluginPath), path.resolve(target));
  assert.deepEqual(result.configPlan.pluginsEnabled, ['existing_plugin', 'kakao_village']);
  assert.equal(result.configPlan.platforms.kakao_village.enabled, true);
  assert.equal(result.configPlan.platforms.slack.enabled, true);
  assert.deepEqual(result.fileManifest.map((entry) => entry.relativePath).sort(), [
    'README.md', '__init__.py', 'adapter.py', 'plugin.yaml'
  ].sort());
  for (const entry of result.fileManifest) {
    const bytes = readFileSync(path.join(fixture.source, entry.relativePath));
    assert.equal(entry.bytes, bytes.length);
    assert.equal(entry.sha256, createHash('sha256').update(bytes).digest('hex').toUpperCase());
  }
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(path.join(fixture.profile, 'plugin-state', 'kakao_village.json')), false);
});

test('sync atomically installs only reviewed files, preserves config, and is idempotent', () => {
  const fixture = makeFixture();
  const first = runSync(fixture);
  const target = path.join(fixture.profile, 'plugins', 'kakao_village');
  const config = readFileSync(path.join(fixture.profile, 'config.yaml'), 'utf8');

  assert.equal(first.ok, true);
  assert.equal(first.mode, 'apply');
  assert.equal(first.changed, true);
  assert.equal(existsSync(path.join(target, 'adapter.py')), true);
  assert.equal(existsSync(path.join(target, 'tests', 'not-shipped.py')), false);
  assert.match(config, /existing_plugin/);
  assert.match(config, /kakao_village/);
  assert.match(config, /slack:[\s\S]*enabled:\s*true/);
  assert.match(config, /kakao_village:[\s\S]*enabled:\s*true/);

  const second = runSync(fixture);
  assert.equal(second.changed, false);
  assert.equal(second.manifestSha256, first.manifestSha256);
});

test('sync refuses dirty reviewed sources', () => {
  const fixture = makeFixture();
  writeFileSync(path.join(fixture.source, 'adapter.py'), 'VALUE = "dirty"\n');
  assert.match(runSync({ ...fixture, expectOk: false }), /dirty|tracked|source/i);
});

test('sync refuses missing descriptors, binaries, secrets, and source reparse escapes', () => {
  for (const unsafe of ['missing_descriptor', 'binary', 'secret', 'reparse']) {
    const fixture = makeFixture();
    if (unsafe === 'missing_descriptor') {
      execFileSync('git', ['rm', path.join('migration', 'hermes', 'plugins', 'kakao_village', 'plugin.yaml')], { cwd: fixture.sourceRepo });
      git(fixture.sourceRepo, 'commit', '-m', 'remove descriptor');
    } else if (unsafe === 'binary') {
      writeFileSync(path.join(fixture.source, 'payload.exe'), Buffer.from([0, 1, 2, 3]));
      git(fixture.sourceRepo, 'add', '.');
      git(fixture.sourceRepo, 'commit', '-m', 'binary');
    } else if (unsafe === 'secret') {
      writeFileSync(path.join(fixture.source, '.env'), 'TOKEN=should-never-ship\n');
      git(fixture.sourceRepo, 'add', '-f', '.');
      git(fixture.sourceRepo, 'commit', '-m', 'secret');
    } else {
      const outside = path.join(fixture.root, 'outside');
      mkdirSync(outside);
      symlinkSync(outside, path.join(fixture.source, 'escape'), 'junction');
    }
    assert.match(runSync({ ...fixture, expectOk: false }), /descriptor|binary|executable|secret|reparse|unsafe/i);
  }
});

test('sync refuses a target whose profile plugin parent escapes through a reparse point', () => {
  const fixture = makeFixture();
  const outside = path.join(fixture.root, 'outside-target');
  mkdirSync(outside);
  symlinkSync(outside, path.join(fixture.profile, 'plugins'), 'junction');
  assert.match(runSync({ ...fixture, expectOk: false }), /target|profile|reparse|escape/i);
  assert.equal(existsSync(path.join(outside, 'kakao_village')), false);
});

test('runtime contract and profile overlay keep plugin packaging explicit and separate from skills', () => {
  const contract = JSON.parse(readFileSync(path.join(repoRoot, 'scripts', 'windows', 'hermes-model-contract.json'), 'utf8'));
  const overlay = readFileSync(path.join(repoRoot, 'scripts', 'windows', 'sync-hermes-profile-overlay.ps1'), 'utf8');

  assert.deepEqual(contract.kakaoworker.platform_plugin, {
    name: 'kakao_village',
    source_repository: 'village-ai',
    source_relative_path: 'migration/hermes/plugins/kakao_village'
  });
  assert.match(overlay, /\[string\]\$KakaoPluginSourcePath/);
  assert.match(overlay, /sync-kakao-hermes-plugin\.ps1/);
  assert.match(overlay, /-SourcePluginPath\s+\$KakaoPluginSourcePath/);
  assert.match(overlay, /-HermesHome\s+\$pluginHermesHome/);
  assert.match(overlay, /if\s*\(\s*-not\s+\[string\]::IsNullOrWhiteSpace\(\$KakaoPluginSourcePath\)\s*\)/);
});
