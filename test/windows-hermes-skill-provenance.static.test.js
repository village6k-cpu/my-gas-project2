const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const syncPath = path.join(root, 'scripts', 'windows', 'sync-hermes-profile-overlay.ps1');
const syncSource = fs.readFileSync(syncPath, 'utf8');

test('Git keeps canonical Hermes skill sources LF-stable on Windows', () => {
  const attributes = fs.readFileSync(path.join(root, '.gitattributes'), 'utf8');
  assert.match(attributes, /\*\.md\s+text\s+eol=lf/);
  assert.match(attributes, /\*\.json\s+text\s+eol=lf/);
});

test('overlay merges native metadata from the selected live profile', () => {
  assert.match(syncSource, /\$sourceUsagePath\s*=\s*Join-Path\s+\$skillsRoot\s+'\.usage\.json'/i);
  assert.match(syncSource, /\$sourceManifestPath\s*=\s*Join-Path\s+\$skillsRoot\s+'\.bundled_manifest'/i);
  assert.match(syncSource, /\$sourceHubDirectory\s*=\s*Join-Path\s+\$skillsRoot\s+'\.hub'/i);
  assert.match(syncSource, /Merge-UsageMetadata/);
  assert.match(syncSource, /Merge-BundledManifest/);
  assert.match(syncSource, /Merge-HubLockMetadata/);
});

test('focused agent skills retain Curator ownership while owner packages stay pinned', () => {
  assert.match(syncSource, /OwnerManagedNames\s+\$ownerManagedRuntimeNames/);
  assert.match(syncSource, /created_by/);
  assert.match(syncSource, /agent_created/);
  assert.match(syncSource, /pinned/);
  assert.match(syncSource, /\$ownerManagedSkillNames\s*=\s*@\([\s\S]*?'village-operations'/i);
  assert.doesNotMatch(
    syncSource.match(/\$ownerManagedSkillNames\s*=\s*@\(([\s\S]*?)\)\s*\r?\n\$overlaySkillsRoot/)?.[1] || '',
    /village-staff-kakao-reservation-register/i
  );
});
