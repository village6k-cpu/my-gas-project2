const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const harnessPath = path.join(
  root,
  'scripts',
  'windows',
  'test-hermes-native-skill-lifecycle.ps1'
);

function readHarness() {
  assert.ok(fs.existsSync(harnessPath), `missing lifecycle harness: ${harnessPath}`);
  return fs.readFileSync(harnessPath, 'utf8');
}

function runHarness(profileHome, extraArgs = []) {
  return spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      harnessPath,
      '-ProfileHome',
      profileHome,
      ...extraArgs
    ],
    { encoding: 'utf8' }
  );
}

test('native lifecycle harness is fail-closed around live Hermes profiles', () => {
  const source = readHarness();

  assert.match(source, /SupportsShouldProcess\s*=\s*\$true/i);
  assert.match(source, /\[string\]\s*\$ProfileHome/i);
  assert.match(source, /Assert-IsolatedProfileHome/i);
  assert.match(source, /native-lifecycle-/i);
  assert.match(source, /kakaoworker/i);
  assert.match(source, /\.lifecycle-test-profile/i);
  assert.match(source, /Resolve\([^)]*\)|GetFullPath/i);
  assert.doesNotMatch(
    source,
    /\[string\]\s*\$Home\b/i,
    'PowerShell treats $Home as the read-only $HOME automatic variable'
  );

  assert.doesNotMatch(source, /--all-unmanaged/i);
  assert.doesNotMatch(source, /sync-hermes-profile-overlay\.ps1/i);

  for (const [name, value] of [
    ['AI_WORKER_LIVE', '0'],
    ['AI_WORKER_AUTO_SEND', '0'],
    ['AI_WORKER_DRY_RUN', '1'],
    ['VILLAGE_WINDOWS_WRITES_ENABLED', '0']
  ]) {
    assert.match(
      source,
      new RegExp(`${name}[^\\r\\n]{0,100}['\"]${value}['\"]`, 'i'),
      `${name} must be forced to ${value} inside the isolated process`
    );
  }

  assert.match(source, /before-manifest\.json/i);
  assert.match(source, /after-manifest\.json/i);
  assert.match(source, /Get-FileHash[^\r\n]*SHA256|Get-FileManifest/i);
  assert.match(source, /\[switch\]\s*\$Cleanup/i);
  assert.match(source, /Remove-Item[^\r\n]*\$resolvedProfileHome/i);
});

test('native lifecycle harness preserves owner-managed contracts and focused agent learning', () => {
  const source = readHarness();

  assert.match(source, /profile\s+create/i);
  assert.match(source, /--no-skills/i);
  assert.match(source, /village-operations/i);
  assert.match(source, /village-history-evidence/i);
  assert.doesNotMatch(source, /curator\s+adopt[^\r\n]*village-operations/i);
  assert.doesNotMatch(source, /curator\s+adopt[^\r\n]*village-history-evidence/i);
  assert.match(source, /curator\s+run[^\r\n]*--dry-run[^\r\n]*--consolidate/i);
  assert.match(source, /curator\s+backup[^\r\n]*--reason/i);
  assert.match(source, /curator\s+rollback[^\r\n]*--id[^\r\n]*--yes/i);
  assert.match(source, /start-kakao-staging\.ps1/i);
  assert.match(source, /restart-kakao-staging\.ps1/i);
  assert.match(source, /watch-kakao-production\.ps1/i);
  assert.match(source, /skill_manage/i);
  assert.match(source, /skill_view/i);
  assert.match(source, /native-lifecycle-marker/i);
  assert.match(source, /village-operations[^\r\n]{0,160}(?:user|owner)-managed/i);
  assert.match(source, /created_by/i);
  assert.match(source, /HERMES_HOME/i);
  assert.match(source, /ToBase64String/i, 'multiline python must survive Windows native argv quoting');
});

test('restart rediscovery uses native skill_view instead of truncated skills-list labels', () => {
  const source = readHarness();

  assert.match(source, /function\s+Assert-NativeSkillRediscovery/i);
  assert.match(source, /_skill_view_with_bump/i);
  assert.match(source, /restart-learning-proof\.json/i);
  assert.match(source, /restartMarkerPresent/i);
  assert.doesNotMatch(source, /\$catalogAfterRestart\s+-notmatch/i);
  assert.doesNotMatch(source, /\$catalogAfterRollback\s+-notmatch/i);
});

test('WhatIf resolves only a new isolated child and refuses live paths', { skip: process.platform !== 'win32' }, () => {
  const profilesRoot = path.join(process.env.LOCALAPPDATA, 'hermes', 'profiles');
  const candidate = path.join(
    profilesRoot,
    `native-lifecycle-static-${process.pid}-${Date.now()}`
  );

  const preview = runHarness(candidate, ['-WhatIf']);
  assert.equal(preview.status, 0, preview.stderr || preview.stdout);
  assert.match(preview.stdout, /WHATIF|What if|preview/i);
  assert.match(preview.stdout, /native-lifecycle-static/i);
  assert.equal(fs.existsSync(candidate), false, '-WhatIf must not create the profile');

  for (const forbidden of [
    path.join(process.env.LOCALAPPDATA, 'hermes'),
    path.join(profilesRoot, 'kakaoworker')
  ]) {
    const rejected = runHarness(forbidden, ['-WhatIf']);
    assert.notEqual(rejected.status, 0, `live path unexpectedly accepted: ${forbidden}`);
    assert.match(
      `${rejected.stdout}\n${rejected.stderr}`,
      /refus|isolated|native-lifecycle/i
    );
  }
});

test('WhatIf can preview a full kakaoworker-shaped isolated lifecycle', { skip: process.platform !== 'win32' }, () => {
  const profilesRoot = path.join(process.env.LOCALAPPDATA, 'hermes', 'profiles');
  const candidate = path.join(
    profilesRoot,
    `native-lifecycle-worker-${process.pid}-${Date.now()}`
  );

  const preview = runHarness(candidate, [
    '-ProfileShape',
    'kakaoworker',
    '-WorkerRepo',
    root,
    '-WhatIf'
  ]);
  assert.equal(preview.status, 0, preview.stderr || preview.stdout);
  assert.match(preview.stdout, /profileShape=kakaoworker/i);
  assert.match(preview.stdout.replaceAll('\\', '/'), /workerProfileHome=.*profiles\/kakaoworker/i);
  assert.match(preview.stdout.replaceAll('\\', '/'), /workerRepo=.*my-gas-project2/i);
  assert.equal(fs.existsSync(candidate), false, '-WhatIf must not create the worker-shaped profile');
});
