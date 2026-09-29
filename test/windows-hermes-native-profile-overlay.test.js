const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const syncScript = path.join(root, 'scripts', 'windows', 'sync-hermes-profile-overlay.ps1');

function writeSkill(profileHome, relativeDirectory, name, body, references = []) {
  const directory = path.join(profileHome, 'skills', relativeDirectory);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} fixture\n---\n\n${body}\n`,
    'utf8'
  );
  for (const reference of references) {
    const target = path.join(directory, 'references', reference);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `# ${reference}\n\nNative learned evidence.\n`, 'utf8');
  }
}

function usageRecord(overrides = {}) {
  return {
    created_at: '2026-09-01T00:00:00.000000+00:00',
    created_by: null,
    agent_created: false,
    patch_count: 0,
    pinned: false,
    state: 'active',
    use_count: 0,
    view_count: 0,
    ...overrides
  };
}

test('profile overlay uses the live native catalog and preserves agent-managed learning without a Mac source', { skip: process.platform !== 'win32' }, () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'village-hermes-native-overlay-'));
  const profileHome = path.join(tempRoot, 'profile');
  const skillsRoot = path.join(profileHome, 'skills');
  fs.mkdirSync(skillsRoot, { recursive: true });

  try {
    writeSkill(
      profileHome,
      path.join('productivity', 'productivity-integrations'),
      'productivity-integrations',
      '# Productivity Integrations\n\nKeep the native package.'
    );
    writeSkill(
      profileHome,
      path.join('productivity', 'village-operations'),
      'village-operations',
      '# Stale Village Operations\n',
      ['stale-mac-reference.md']
    );
    writeSkill(
      profileHome,
      path.join('productivity', 'village-staff-kakao-reservation-register'),
      'village-staff-kakao-reservation-register',
      '# Broken learned registration skill\n\n[Missing contract](references/missing-contract.md)',
      ['stale-incident.md']
    );
    writeSkill(
      profileHome,
      path.join('productivity', 'village-pending-request-quote'),
      'village-pending-request-quote',
      '# Learned quote skill\n\n[Live learning](references/learned-live-case.md)',
      ['learned-live-case.md']
    );
    fs.writeFileSync(
      path.join(skillsRoot, '.usage.json'),
      JSON.stringify({
        'village-operations': usageRecord({ pinned: true, patch_count: 12 }),
        'village-staff-kakao-reservation-register': usageRecord({
          created_by: 'agent',
          agent_created: true,
          patch_count: 111,
          use_count: 476
        }),
        'village-pending-request-quote': usageRecord({
          created_by: 'agent',
          agent_created: true,
          patch_count: 56,
          use_count: 152
        })
      }, null, 2),
      'utf8'
    );

    const quote = (value) => value.replaceAll("'", "''");
    const command = `& '${quote(syncScript)}' -ProfileHome '${quote(profileHome)}' -Confirm:$false`;
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { encoding: 'utf8' }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const report = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(report.ok, true);
    assert.equal('macActive' in report, false, 'a completed migration must have no Mac runtime input');
    assert.equal(fs.existsSync(path.join(profileHome, '.no-bundled-skills')), false,
      'the overlay must not opt the profile out of native bundled skills');

    const operationsRoot = path.join(skillsRoot, 'productivity', 'village-operations');
    assert.equal(fs.existsSync(path.join(operationsRoot, 'references', 'stale-mac-reference.md')), false,
      'a reviewed owner package must replace its old directory instead of retaining stale references');

    const registrationRoot = path.join(
      skillsRoot,
      'productivity',
      'village-staff-kakao-reservation-register'
    );
    const registration = fs.readFileSync(path.join(registrationRoot, 'SKILL.md'), 'utf8');
    assert.match(registration, /commit-registration-live/);
    assert.doesNotMatch(registration, /missing-contract/);
    assert.equal(fs.existsSync(path.join(registrationRoot, 'references', 'stale-incident.md')), false);

    const quoteRoot = path.join(skillsRoot, 'productivity', 'village-pending-request-quote');
    assert.match(fs.readFileSync(path.join(quoteRoot, 'SKILL.md'), 'utf8'), /Learned quote skill/);
    assert.equal(fs.existsSync(path.join(quoteRoot, 'references', 'learned-live-case.md')), true);

    const usage = JSON.parse(fs.readFileSync(path.join(skillsRoot, '.usage.json'), 'utf8'));
    for (const name of [
      'village-staff-kakao-reservation-register',
      'village-pending-request-quote'
    ]) {
      assert.equal(usage[name].created_by, 'agent');
      assert.equal(usage[name].agent_created, true);
      assert.equal(usage[name].pinned, false);
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
