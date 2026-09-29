const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const syncPath = path.join(root, 'scripts', 'windows', 'sync-hermes-profile-overlay.ps1');
const syncSource = fs.readFileSync(syncPath, 'utf8');

test('profile overlay has no retired migration computer as an input', () => {
  for (const retiredInput of [
    /MacHermesHome/i,
    /MacMiniMirror/i,
    /mac-parity/i,
    /resolvedMac/i,
    /macSkillsRoot/i
  ]) {
    assert.doesNotMatch(syncSource, retiredInput);
  }
  assert.match(syncSource, /Get-ActiveSkillPackages\s+-SkillsRoot\s+\$skillsRoot/i);
  assert.match(syncSource, /selected live Windows profile/i);
  assert.match(syncSource, /Test-SkillReferenceIntegrity/);
});

test('profile overlay leaves native bundled skills and focused learning enabled', () => {
  assert.doesNotMatch(syncSource, /\.no-bundled-skills/);
  assert.doesNotMatch(syncSource, /creation_nudge_interval/);
  assert.match(syncSource, /preserving native agent-managed skills/i);
  assert.match(syncSource, /village-staff-kakao-reservation-register/);
  assert.doesNotMatch(
    syncSource.match(/\$ownerManagedSkillNames\s*=\s*@\(([\s\S]*?)\)\s*\r?\n\$overlaySkillsRoot/)?.[1] || '',
    /village-staff-kakao-reservation-register/i,
    'the learned registration skill must not be adopted as an owner-authored package'
  );
});

test('profile overlay atomically replaces only the selected profile skill tree', () => {
  assert.match(syncSource, /\[IO\.Directory\]::Move\(\$skillsRoot,\s*\$previousRoot\)/);
  assert.match(syncSource, /\[IO\.Directory\]::Move\(\$stagingRoot,\s*\$skillsRoot\)/);
  assert.match(
    syncSource,
    /catch\s*\{[\s\S]*?\[IO\.Directory\]::Move\(\$previousRoot,\s*\$skillsRoot\)[\s\S]*?throw/
  );
  assert.doesNotMatch(
    syncSource,
    /profiles\\kakaoworker\\skills\\devops\\rpa-automation-operations/,
    'a root overlay must never cross-deploy into another profile'
  );
});
