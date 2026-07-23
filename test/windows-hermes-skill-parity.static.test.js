const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const syncScript = path.join(root, 'scripts', 'windows', 'sync-hermes-profile-overlay.ps1');

function writeSkill(hermesHome, relativeDirectory, name, {
  platforms,
  body = `# ${name}\n\nPreserved Mac capability.\n`,
  references = []
} = {}) {
  const directory = path.join(hermesHome, 'skills', relativeDirectory);
  fs.mkdirSync(directory, { recursive: true });
  const platformLine = platforms ? `platforms: [${platforms.join(', ')}]\n` : '';
  fs.writeFileSync(
    path.join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: preserved ${name}\n${platformLine}---\n\n${body}`
  );
  for (const reference of references) {
    const target = path.join(directory, 'references', reference);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `# ${reference}\n\nPreserved reference.\n`);
  }
}

function readSkillNames(skillsRoot) {
  if (!fs.existsSync(skillsRoot)) return [];
  return fs.readdirSync(skillsRoot, { recursive: true })
    .filter((entry) => entry.endsWith('SKILL.md'))
    .map((entry) => fs.readFileSync(path.join(skillsRoot, entry), 'utf8'))
    .map((source) => /^name:\s*(.+)$/m.exec(source)?.[1]?.trim())
    .filter(Boolean)
    .sort();
}

test('sync rebuilds the Windows root from the curated Mac tree and keeps RPA profile-scoped', { skip: process.platform !== 'win32' }, () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'village-hermes-parity-'));
  const macHome = path.join(tempRoot, 'mac-home');
  const profileHome = path.join(tempRoot, 'windows-home');
  fs.mkdirSync(profileHome, { recursive: true });

  try {
    const longReference = path.join(
      'scripts',
      'powerpoint',
      'office',
      'schemas',
      'ISO-IEC29500-4_2016',
      `shared-${'document-properties-variant-types-'.repeat(4)}.xsd`
    );
    writeSkill(macHome, 'computer-use', 'computer-use');
    writeSkill(macHome, path.join('productivity', 'productivity-integrations'), 'productivity-integrations', {
      references: ['google-workspace.md', 'sheets-routing.md', longReference]
    });
    writeSkill(macHome, path.join('software-development', 'workflows'), 'software-development-workflows');
    writeSkill(macHome, path.join('productivity', 'village-operations'), 'village-operations', {
      platforms: ['macos'],
      body: '# Village Operations\n\n## Existing reservation equipment additions\n\nMac business rules stay intact.\n',
      references: ['schedule.md', 'payments.md']
    });
    writeSkill(macHome, path.join('village', 'village-brain-first'), 'village-brain-first', {
      platforms: ['macos'],
      body: '# Village Brain-First Protocol\n\n## Customer lookup\n\n## Tax chief-of-staff mode\n\n## Recording owner decisions\n\n## Live-system escalation\n',
      references: ['finance.md']
    });
    writeSkill(macHome, path.join('apple', 'apple-automation'), 'apple-automation');
    writeSkill(macHome, path.join('gaming', 'minecraft-modpack-server'), 'minecraft-modpack-server');
    writeSkill(macHome, path.join('mlops', 'inference', 'obliteratus'), 'obliteratus');

    const rpaHome = path.join(macHome, 'profiles', 'kakaoworker');
    writeSkill(rpaHome, path.join('devops', 'rpa-automation-operations'), 'rpa-automation-operations', {
      platforms: ['macos'],
      body: '# RPA Automation Operations\n\nKakao watcher health and recovery only.\n',
      references: ['watcher.md']
    });

    writeSkill(profileHome, path.join('legacy', 'google-workspace'), 'google-workspace');
    writeSkill(profileHome, path.join('000-windows', 'village-operations-windows'), 'village-operations-windows', { platforms: ['windows'] });
    writeSkill(profileHome, path.join('000-windows', 'rpa-automation-operations-windows'), 'rpa-automation-operations-windows', { platforms: ['windows'] });

    const command = `& '${syncScript.replaceAll("'", "''")}' -ProfileHome '${profileHome.replaceAll("'", "''")}' -MacHermesHome '${macHome.replaceAll("'", "''")}' -Confirm:$false`;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
        { encoding: 'utf8' }
      );
      assert.equal(result.status, 0, result.stderr || result.stdout);
      const report = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
      assert.equal(report.ok, true);
    }

    assert.deepEqual(readSkillNames(path.join(profileHome, 'skills')), [
      'computer-use',
      'productivity-integrations',
      'software-development-workflows',
      'village-brain-first',
      'village-confirm-request',
      'village-operations',
      'village-runtime-router'
    ]);
    assert.equal(
      fs.readFileSync(path.join(profileHome, '.no-bundled-skills'), 'utf8').trim(),
      'mac-parity-curated',
      'gateway startup must not re-seed the retired bundled skill set'
    );

    const operationsRoot = path.join(profileHome, 'skills', 'productivity', 'village-operations');
    const operations = fs.readFileSync(path.join(operationsRoot, 'SKILL.md'), 'utf8');
    assert.match(operations, /^name:\s*village-operations$/m);
    assert.match(
      operations,
      /^description:\s*"Primary Village action route for requested business operations:/m
    );
    assert.match(operations, /^platforms:\s*\[windows\]$/m);
    assert.match(operations, /Windows execution adapter/i);
    assert.match(operations, /Existing reservation equipment additions/i);
    assert.equal(fs.existsSync(path.join(operationsRoot, 'references', 'schedule.md')), true);
    assert.equal(fs.existsSync(path.join(operationsRoot, 'references', 'payments.md')), true);
    assert.equal(
      fs.existsSync(path.join(
        profileHome,
        'skills',
        'productivity',
        'productivity-integrations',
        'references',
        longReference
      )),
      true,
      'long-path support files must survive the parity copy'
    );

    const brainRoot = path.join(profileHome, 'skills', 'village', 'village-brain-first');
    const brain = fs.readFileSync(path.join(brainRoot, 'SKILL.md'), 'utf8');
    assert.match(brain, /^name:\s*village-brain-first$/m);
    assert.match(
      brain,
      /^description:\s*"Primary Village business intelligence route for every business question:/m
    );
    assert.match(brain, /^platforms:\s*\[windows\]$/m);
    assert.match(brain, /Customer lookup/i);
    assert.match(brain, /explicitly asks[\s\S]{0,300}village-operations/i);
    assert.equal(fs.existsSync(path.join(brainRoot, 'references', 'finance.md')), true);

    const routerRoot = path.join(profileHome, 'skills', 'village', 'village-runtime-router');
    const router = fs.readFileSync(path.join(routerRoot, 'SKILL.md'), 'utf8');
    assert.match(router, /^name:\s*village-runtime-router$/m);
    assert.match(router, /^platforms:\s*\[windows\]$/m);
    assert.ok(Buffer.byteLength(router, 'utf8') <= 8_000);

    const confirmRequestRoot = path.join(
      profileHome,
      'skills',
      'productivity',
      'village-confirm-request'
    );
    const confirmRequest = fs.readFileSync(path.join(confirmRequestRoot, 'SKILL.md'), 'utf8');
    assert.match(confirmRequest, /^name:\s*village-confirm-request$/m);
    assert.match(confirmRequest, /^platforms:\s*\[windows\]$/m);
    assert.match(confirmRequest, /village-confirm-request\.js/);

    const rpaRoot = path.join(
      profileHome,
      'profiles',
      'kakaoworker',
      'skills',
      'devops',
      'rpa-automation-operations'
    );
    assert.equal(fs.existsSync(path.join(rpaRoot, 'SKILL.md')), true);
    assert.equal(fs.existsSync(path.join(rpaRoot, 'references', 'watcher.md')), true);
    assert.equal(readSkillNames(path.join(profileHome, 'skills')).includes('rpa-automation-operations'), false);

    for (const excluded of [
      'apple-automation',
      'minecraft-modpack-server',
      'obliteratus',
      'google-workspace',
      'village-operations-windows',
      'rpa-automation-operations-windows'
    ]) {
      assert.equal(readSkillNames(path.join(profileHome, 'skills')).includes(excluded), false, `${excluded} must not remain active`);
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('profile-scoped sync replaces obsolete staging skills with the full AI-first worker profile', { skip: process.platform !== 'win32' }, () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'village-hermes-worker-profile-'));
  const macHome = path.join(tempRoot, 'mac-home');
  const workerProfile = path.join(tempRoot, 'windows-home', 'profiles', 'kakaoworker');
  fs.mkdirSync(workerProfile, { recursive: true });

  try {
    writeSkill(macHome, 'computer-use', 'computer-use');
    writeSkill(macHome, path.join('productivity', 'productivity-integrations'), 'productivity-integrations');
    writeSkill(macHome, path.join('productivity', 'village-operations'), 'village-operations', {
      platforms: ['macos'],
      body: '# Village Operations\n\nFull operational reasoning.\n'
    });
    writeSkill(macHome, path.join('village', 'village-brain-first'), 'village-brain-first', {
      platforms: ['macos'],
      body: '# Village Brain-First Protocol\n\nFull business intelligence.\n'
    });
    const rpaHome = path.join(macHome, 'profiles', 'kakaoworker');
    writeSkill(rpaHome, path.join('devops', 'rpa-automation-operations'), 'rpa-automation-operations', {
      platforms: ['macos'],
      body: '# RPA Automation Operations\n\nHealth and recovery.\n'
    });

    writeSkill(workerProfile, path.join('000-windows', 'village-operations-windows'), 'village-operations-windows', { platforms: ['windows'] });
    writeSkill(workerProfile, path.join('000-windows', 'village-brain-first'), 'village-brain-first', { platforms: ['windows'] });
    writeSkill(workerProfile, path.join('000-windows', 'rpa-automation-operations-windows'), 'rpa-automation-operations-windows', { platforms: ['windows'] });
    fs.writeFileSync(
      path.join(workerProfile, 'profile.yaml'),
      'name: kakaoworker\ndescription: Fast automation, not deep interactive reasoning.\ndescription_auto: false\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(workerProfile, 'config.yaml'),
      'model:\n  default: gpt-5.6-sol\nagent:\n  reasoning_effort: high\n  max_turns: 90\n',
      'utf8'
    );

    const command = `& '${syncScript.replaceAll("'", "''")}' -ProfileHome '${workerProfile.replaceAll("'", "''")}' -MacHermesHome '${macHome.replaceAll("'", "''")}' -ProfileScoped -Confirm:$false`;
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { encoding: 'utf8' }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const report = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(report.ok, true);
    assert.equal(report.scope, 'worker-profile');
    const names = readSkillNames(path.join(workerProfile, 'skills'));
    for (const required of [
      'computer-use',
      'productivity-integrations',
      'village-brain-first',
      'village-confirm-request',
      'village-operations',
      'village-runtime-router',
      'rpa-automation-operations'
    ]) {
      assert.equal(names.includes(required), true, `${required} must be active in the worker profile`);
    }
    for (const retired of ['village-operations-windows', 'rpa-automation-operations-windows']) {
      assert.equal(names.includes(retired), false, `${retired} must be removed from the worker profile`);
    }
    assert.equal(fs.existsSync(path.join(workerProfile, 'skills', '000-windows')), false);
    assert.equal(
      fs.existsSync(path.join(workerProfile, 'profiles', 'kakaoworker', 'skills')),
      false,
      'profile-scoped sync must never create a nested profiles/kakaoworker tree'
    );
    const identity = fs.readFileSync(path.join(workerProfile, 'profile.yaml'), 'utf8');
    assert.match(identity, /Full Hermes AI reasoning/i);
    assert.doesNotMatch(identity, /not deep interactive reasoning/i);
    const config = fs.readFileSync(path.join(workerProfile, 'config.yaml'), 'utf8');
    assert.match(config, /^\s{2}default:\s*gpt-5\.6-sol\s*$/m);
    assert.match(config, /^\s{2}reasoning_effort:\s*high\s*$/m);
    assert.match(config, /^\s{2}max_turns:\s*90\s*$/m);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('profile-scoped sync preserves Hermes self-improvement across repeated starts', { skip: process.platform !== 'win32' }, () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'village-hermes-learning-parity-'));
  const macHome = path.join(tempRoot, 'mac-home');
  const workerProfile = path.join(tempRoot, 'windows-home', 'profiles', 'kakaoworker');
  fs.mkdirSync(workerProfile, { recursive: true });

  try {
    writeSkill(macHome, 'computer-use', 'computer-use');
    writeSkill(macHome, path.join('productivity', 'productivity-integrations'), 'productivity-integrations');
    writeSkill(macHome, path.join('productivity', 'village-operations'), 'village-operations', {
      platforms: ['macos'],
      body: '# Village Operations\n\nFull operational reasoning.\n'
    });
    writeSkill(macHome, path.join('village', 'village-brain-first'), 'village-brain-first', {
      platforms: ['macos'],
      body: '# Village Brain-First Protocol\n\nFull business intelligence.\n'
    });
    const rpaHome = path.join(macHome, 'profiles', 'kakaoworker');
    writeSkill(rpaHome, path.join('devops', 'rpa-automation-operations'), 'rpa-automation-operations', {
      platforms: ['macos'],
      body: '# RPA Automation Operations\n\nHealth and recovery.\n'
    });
    fs.writeFileSync(
      path.join(workerProfile, 'profile.yaml'),
      'name: kakaoworker\ndescription: AI worker.\ndescription_auto: false\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(workerProfile, 'config.yaml'),
      'model:\n  default: gpt-5.6-sol\nagent:\n  reasoning_effort: high\n  max_turns: 90\n',
      'utf8'
    );

    const command = `& '${syncScript.replaceAll("'", "''")}' -ProfileHome '${workerProfile.replaceAll("'", "''")}' -MacHermesHome '${macHome.replaceAll("'", "''")}' -ProfileScoped -Confirm:$false`;
    const first = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { encoding: 'utf8' }
    );
    assert.equal(first.status, 0, first.stderr || first.stdout);

    const routerPath = path.join(workerProfile, 'skills', 'village', 'village-runtime-router', 'SKILL.md');
    fs.appendFileSync(routerPath, '\n## Learned rule\n\nSELF_IMPROVED_RULE_MUST_SURVIVE\n', 'utf8');
    writeSkill(workerProfile, path.join('learned', 'customer-alias-memory'), 'customer-alias-memory', {
      platforms: ['windows'],
      body: '# Customer Alias Memory\n\nAGENT_CREATED_SKILL_MUST_SURVIVE\n'
    });
    fs.writeFileSync(
      path.join(workerProfile, 'skills', '.usage.json'),
      JSON.stringify({
        'village-runtime-router': { patch_count: 1, last_patched_at: new Date().toISOString() },
        'customer-alias-memory': { created_by: 'agent', patch_count: 0 }
      }, null, 2),
      'utf8'
    );

    const second = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { encoding: 'utf8' }
    );
    assert.equal(second.status, 0, second.stderr || second.stdout);

    assert.match(fs.readFileSync(routerPath, 'utf8'), /SELF_IMPROVED_RULE_MUST_SURVIVE/);
    assert.match(
      fs.readFileSync(path.join(workerProfile, 'skills', 'learned', 'customer-alias-memory', 'SKILL.md'), 'utf8'),
      /AGENT_CREATED_SKILL_MUST_SURVIVE/
    );
    const usage = JSON.parse(fs.readFileSync(path.join(workerProfile, 'skills', '.usage.json'), 'utf8'));
    assert.equal(usage['village-runtime-router'].patch_count, 1);
    assert.equal(usage['customer-alias-memory'].created_by, 'agent');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
