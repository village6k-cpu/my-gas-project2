const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const syncScript = path.join(root, 'scripts', 'windows', 'sync-hermes-profile-overlay.ps1');
const workerContract = JSON.parse(fs.readFileSync(
  path.join(root, 'scripts', 'windows', 'hermes-model-contract.json'),
  'utf8'
)).kakaoworker;

function writeSkill(hermesHome, relativeDirectory, name, { platforms, body } = {}) {
  const directory = path.join(hermesHome, 'skills', relativeDirectory);
  fs.mkdirSync(directory, { recursive: true });
  const platformLine = platforms ? `platforms: [${platforms.join(', ')}]\n` : '';
  const skillBody = body ?? `# ${name}\n`;
  fs.writeFileSync(
    path.join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: provenance fixture ${name}\n${platformLine}---\n\n${skillBody}`,
    'utf8'
  );
}

function usageRecord(overrides = {}) {
  return {
    archived_at: null,
    created_at: '2026-06-01T00:00:00.000000+00:00',
    created_by: null,
    last_patched_at: null,
    last_used_at: null,
    last_viewed_at: null,
    patch_count: 0,
    pinned: false,
    state: 'active',
    use_count: 0,
    view_count: 0,
    ...overrides
  };
}

function hubRecord(identifier, installPath) {
  return {
    source: 'official',
    identifier,
    trust_level: 'builtin',
    scan_verdict: 'backfilled',
    content_hash: `sha256:${identifier.replaceAll('/', '-')}`,
    install_path: installPath,
    files: ['SKILL.md'],
    metadata: { backfilled_from: 'test' },
    installed_at: '2026-06-01T00:00:00.000000+00:00',
    updated_at: '2026-06-01T00:00:00.000000+00:00'
  };
}

function runSync(macHome, profileHome, { profileScoped = false } = {}) {
  const quote = (value) => value.replaceAll("'", "''");
  const scopeFlag = profileScoped ? ' -ProfileScoped' : '';
  const command = `& '${quote(syncScript)}' -ProfileHome '${quote(profileHome)}' -MacHermesHome '${quote(macHome)}'${scopeFlag} -Confirm:$false`;
  return spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { encoding: 'utf8' }
  );
}

function readManifest(file) {
  return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).sort();
}

test('sync preserves source ownership and merges usage history without granting curator ownership', { skip: process.platform !== 'win32' }, () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'village-hermes-provenance-'));
  const macHome = path.join(tempRoot, 'mac-home');
  const profileHome = path.join(tempRoot, 'windows-home');
  const macSkills = path.join(macHome, 'skills');
  const activeSkills = path.join(profileHome, 'skills');
  fs.mkdirSync(profileHome, { recursive: true });

  try {
    writeSkill(macHome, 'computer-use', 'computer-use');
    writeSkill(macHome, path.join('productivity', 'productivity-integrations'), 'productivity-integrations');
    writeSkill(macHome, path.join('software-development', 'workflows'), 'software-development-workflows');
    writeSkill(macHome, path.join('creative', 'mac-hub-skill'), 'mac-hub-skill');
    writeSkill(macHome, path.join('productivity', 'village-operations'), 'village-operations', { platforms: ['macos'] });
    writeSkill(macHome, path.join('village', 'village-brain-first'), 'village-brain-first', { platforms: ['macos'] });
    writeSkill(macHome, path.join('gaming', 'minecraft-modpack-server'), 'minecraft-modpack-server');

    fs.writeFileSync(
      path.join(macSkills, '.bundled_manifest'),
      [
        'computer-use:11111111111111111111111111111111',
        'productivity-integrations:22222222222222222222222222222222',
        'minecraft-modpack-server:33333333333333333333333333333333'
      ].join('\n') + '\n',
      'utf8'
    );
    fs.mkdirSync(path.join(macSkills, '.hub'), { recursive: true });
    fs.writeFileSync(
      path.join(macSkills, '.hub', 'lock.json'),
      JSON.stringify({
        version: 1,
        installed: {
          'mac-hub-skill': hubRecord('official/creative/mac-hub-skill', 'creative/mac-hub-skill'),
          'minecraft-modpack-server': hubRecord('official/gaming/minecraft-modpack-server', 'gaming/minecraft-modpack-server')
        }
      }, null, 2),
      'utf8'
    );
    fs.writeFileSync(
      path.join(macSkills, '.usage.json'),
      JSON.stringify({
        'computer-use': usageRecord({
          last_used_at: '2026-07-01T00:00:00.000000+00:00',
          last_viewed_at: '2026-07-01T00:00:00.000000+00:00',
          use_count: 9,
          view_count: 9
        }),
        'software-development-workflows': usageRecord({ use_count: 7, view_count: 7 }),
        'village-brain-first': usageRecord({ use_count: 61, view_count: 61, patch_count: 15 })
      }, null, 2),
      'utf8'
    );

    writeSkill(profileHome, path.join('local', 'windows-bundled-skill'), 'windows-bundled-skill');
    writeSkill(profileHome, path.join('local', 'windows-hub-skill'), 'windows-hub-skill');
    writeSkill(profileHome, path.join('learned', 'agent-learned-skill'), 'agent-learned-skill');
    fs.writeFileSync(
      path.join(activeSkills, '.bundled_manifest'),
      'windows-bundled-skill:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n',
      'utf8'
    );
    fs.mkdirSync(path.join(activeSkills, '.hub'), { recursive: true });
    fs.writeFileSync(
      path.join(activeSkills, '.hub', 'lock.json'),
      JSON.stringify({
        version: 1,
        installed: {
          'windows-hub-skill': hubRecord('local/windows-hub-skill', 'local/windows-hub-skill')
        }
      }, null, 2),
      'utf8'
    );
    fs.writeFileSync(
      path.join(activeSkills, '.usage.json'),
      JSON.stringify({
        'computer-use': usageRecord({
          last_patched_at: '2026-08-01T00:00:00.000000+00:00',
          last_used_at: '2026-08-01T00:00:00.000000+00:00',
          last_viewed_at: '2026-08-01T00:00:00.000000+00:00',
          patch_count: 3,
          use_count: 4,
          view_count: 4
        }),
        'agent-learned-skill': usageRecord({ created_by: 'agent', use_count: 2, view_count: 2 }),
        'village-brain-first': usageRecord({ use_count: 529, view_count: 529 })
      }, null, 2),
      'utf8'
    );
    fs.writeFileSync(path.join(activeSkills, '.curator_state'), '{"runs":0}\n', 'utf8');
    fs.writeFileSync(path.join(activeSkills, '.curator_suppressed'), 'suppressed-built-in\n', 'utf8');

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = runSync(macHome, profileHome);
      assert.equal(result.status, 0, result.stderr || result.stdout);
    }

    assert.deepEqual(readManifest(path.join(activeSkills, '.bundled_manifest')), [
      'computer-use:11111111111111111111111111111111',
      'productivity-integrations:22222222222222222222222222222222',
      'windows-bundled-skill:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    ]);

    const hub = JSON.parse(fs.readFileSync(path.join(activeSkills, '.hub', 'lock.json'), 'utf8'));
    assert.deepEqual(Object.keys(hub.installed).sort(), ['mac-hub-skill', 'windows-hub-skill']);
    assert.equal(hub.installed['minecraft-modpack-server'], undefined);

    const usage = JSON.parse(fs.readFileSync(path.join(activeSkills, '.usage.json'), 'utf8'));
    assert.equal(usage['computer-use'].use_count, 9, 'monotonic usage count must not go backwards');
    assert.equal(usage['computer-use'].patch_count, 3, 'later Windows patch history must survive');
    assert.equal(usage['computer-use'].last_used_at, '2026-08-01T00:00:00.000000+00:00');
    assert.equal(usage['software-development-workflows'].use_count, 7, 'Mac history missing from Windows must migrate');
    assert.equal(usage['agent-learned-skill'].created_by, 'agent', 'existing curator delegation must survive');
    assert.equal(usage['computer-use'].created_by, null, 'migration must not bulk-adopt ordinary skills');
    assert.equal(usage['village-history-evidence'].use_count, 529, 'renamed Brain usage must remain monotonic');
    assert.equal(usage['village-history-evidence'].patch_count, 15, 'renamed Brain patch history must survive');
    assert.equal(usage['village-history-evidence'].created_by, null, 'renaming must not adopt Village Brain');
    assert.equal(usage['village-brain-first'], undefined, 'obsolete Brain catalog key must be retired');

    assert.equal(fs.readFileSync(path.join(activeSkills, '.curator_state'), 'utf8'), '{"runs":0}\n');
    assert.equal(fs.readFileSync(path.join(activeSkills, '.curator_suppressed'), 'utf8'), 'suppressed-built-in\n');

    const macWorkerHome = path.join(macHome, 'profiles', 'kakaoworker');
    const macWorkerSkills = path.join(macWorkerHome, 'skills');
    writeSkill(macWorkerHome, path.join('devops', 'rpa-automation-operations'), 'rpa-automation-operations', { platforms: ['macos'] });
    fs.writeFileSync(
      path.join(macWorkerSkills, '.usage.json'),
      JSON.stringify({
        'computer-use': usageRecord({ use_count: 42, view_count: 42 })
      }, null, 2),
      'utf8'
    );
    fs.mkdirSync(path.join(macWorkerSkills, '.hub'), { recursive: true });
    fs.writeFileSync(
      path.join(macWorkerSkills, '.hub', 'lock.json'),
      JSON.stringify({
        version: 1,
        installed: {
          'mac-hub-skill': hubRecord('official/creative/mac-hub-skill', 'creative/mac-hub-skill')
        }
      }, null, 2),
      'utf8'
    );

    const workerHome = path.join(tempRoot, 'worker-home');
    fs.mkdirSync(workerHome, { recursive: true });
    writeSkill(workerHome, 'computer-use', 'computer-use', {
      body: '# Worker-specific computer use\n\nUse the worker-native tool interface.\n'
    });
    fs.writeFileSync(
      path.join(workerHome, 'skills', '.usage.json'),
      JSON.stringify({
        'computer-use': usageRecord({ patch_count: 3, use_count: 4, view_count: 4 })
      }, null, 2),
      'utf8'
    );
    fs.writeFileSync(
      path.join(workerHome, 'config.yaml'),
      `model:\n  default: ${workerContract.model}\n  provider: ${workerContract.provider}\n`
        + `agent:\n  reasoning_effort: ${workerContract.reasoning_effort}\n  max_turns: ${workerContract.max_turns}\n`
        + `  disabled_toolsets:\n${workerContract.disabled_toolsets.map((name) => `  - ${name}\n`).join('')}`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(workerHome, 'profile.yaml'),
      'name: kakaoworker\ndescription: worker provenance fixture\n',
      'utf8'
    );
    const workerResult = runSync(macHome, workerHome, { profileScoped: true });
    assert.equal(workerResult.status, 0, workerResult.stderr || workerResult.stdout);

    const workerSkills = path.join(workerHome, 'skills');
    const workerUsage = JSON.parse(fs.readFileSync(path.join(workerSkills, '.usage.json'), 'utf8'));
    assert.equal(workerUsage['computer-use'].use_count, 42, 'worker sync must use worker-scoped Mac usage history');
    assert.equal(workerUsage['computer-use'].patch_count, 3, 'worker-specific patch history must survive');
    assert.match(
      fs.readFileSync(path.join(workerSkills, 'computer-use', 'SKILL.md'), 'utf8'),
      /Worker-specific computer use/,
      'worker-owned skill instructions must not be overwritten by the root canonical package'
    );
    assert.deepEqual(readManifest(path.join(workerSkills, '.bundled_manifest')), [
      'computer-use:11111111111111111111111111111111',
      'productivity-integrations:22222222222222222222222222222222'
    ], 'worker sync must fall back to the root Mac manifest when the Mac worker has none');
    const workerHub = JSON.parse(fs.readFileSync(path.join(workerSkills, '.hub', 'lock.json'), 'utf8'));
    assert.deepEqual(Object.keys(workerHub.installed), ['mac-hub-skill']);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
