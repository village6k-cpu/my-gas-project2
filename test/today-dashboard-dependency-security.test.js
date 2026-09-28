const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const lock = JSON.parse(
  fs.readFileSync(
    path.join(repoRoot, 'apps', 'today-dashboard', 'package-lock.json'),
    'utf8',
  ),
);

function versionTuple(version) {
  const match = String(version || '').match(/^(\d+)\.(\d+)\.(\d+)/);
  assert.ok(match, `expected a stable semantic version, got ${version}`);
  return match.slice(1).map(Number);
}

function atLeast(version, minimum) {
  const actual = versionTuple(version);
  const required = versionTuple(minimum);
  for (let index = 0; index < 3; index += 1) {
    if (actual[index] !== required[index]) return actual[index] > required[index];
  }
  return true;
}

test('Today Dashboard lockfile stays above audited production vulnerability floors', () => {
  const packages = lock.packages || {};
  const nextVersion = packages['node_modules/next']?.version;
  const sharpVersion = packages['node_modules/sharp']?.version;
  const nanoidVersion = packages['node_modules/nanoid']?.version;

  assert.ok(atLeast(nextVersion, '15.5.24'), `Next.js ${nextVersion} is below 15.5.24`);
  assert.ok(atLeast(sharpVersion, '0.35.4'), `sharp ${sharpVersion} is below 0.35.4`);
  assert.ok(atLeast(nanoidVersion, '3.3.18'), `nanoid ${nanoidVersion} is below 3.3.18`);

  const postcssVersions = Object.entries(packages)
    .filter(([packagePath]) => /(^|\/)node_modules\/postcss$/.test(packagePath))
    .map(([, metadata]) => metadata.version);
  assert.ok(postcssVersions.length > 0, 'expected at least one locked postcss package');
  for (const version of postcssVersions) {
    assert.ok(atLeast(version, '8.5.23'), `postcss ${version} is below 8.5.23`);
  }
});
