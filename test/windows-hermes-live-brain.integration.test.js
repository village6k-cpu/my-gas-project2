const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const hermesHome = process.env.VILLAGE_LIVE_HERMES_HOME;
const runLiveChecks = process.platform === 'win32' && Boolean(hermesHome);

// 모델 기대값은 scripts/windows/hermes-model-contract.json 단일 소스를 따른다.
const modelContract = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'scripts', 'windows', 'hermes-model-contract.json'),
  'utf8'
));
const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const expectedRootSkills = [
  'village-history-evidence',
  'village-operations',
  'productivity-integrations'
];
const forbiddenRootSkills = [
  'village-runtime-router',
  'village-operations-windows',
  'rpa-automation-operations-windows',
  'google-workspace'
];

function readSelectedEnv(filePath, names) {
  const selected = new Map(names.map((name) => [name, []]));
  for (const line of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match || !selected.has(match[1])) continue;
    selected.get(match[1]).push(match[2].replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, '$1$2'));
  }
  return selected;
}

test('live root Hermes has the no-send Village Brain environment', { skip: !runLiveChecks }, () => {
  const expected = new Map([
    ['AI_WORKER_LIVE', '0'],
    ['AI_WORKER_AUTO_SEND', '0'],
    ['VILLAGE_ROLE', 'mini'],
    ['VILLAGE_DISABLE_MINI_PUSH', '1'],
    ['VILLAGE_VAULT_ROOT', 'C:\\Village\\VILLAGE_Brain'],
    ['VILLAGE_DASHBOARD_ENV', 'C:/Village/village-ai/.env.dashboard'],
    ['VILLAGE_TAX_ENV', 'C:/Village/village-ai/.env.finance'],
    ['HERMES_ENV', 'C:/Users/ssper/AppData/Local/hermes/.env'],
    ['VILLAGE_NAME_LINK_QUEUE', 'C:/Village/VILLAGE_Brain/Ops/nameLinkQueue.json']
  ]);
  const actual = readSelectedEnv(path.join(hermesHome, '.env'), expected.keys());
  for (const [name, value] of expected) {
    assert.deepEqual(actual.get(name), [value], `${name} must appear exactly once with its safe value`);
  }

  const brainContext = path.join(expected.get('VILLAGE_VAULT_ROOT'), 'Ops', 'brain-context-latest.md');
  assert.ok(fs.statSync(brainContext).size > 0, 'compiled Brain context must exist and be non-empty');
});

test('live root Hermes has the canonical native skill packages and scoped RPA profile', { skip: !runLiveChecks }, () => {
  const paths = new Map([
    ['village-brain-first', path.join(hermesHome, 'skills', 'village', 'village-brain-first', 'SKILL.md')],
    ['village-operations', path.join(hermesHome, 'skills', 'productivity', 'village-operations', 'SKILL.md')],
    ['productivity-integrations', path.join(hermesHome, 'skills', 'productivity', 'productivity-integrations', 'SKILL.md')]
  ]);
  for (const [name, deployed] of paths) {
    assert.equal(fs.existsSync(deployed), true, `${name} must be deployed to the live root`);
  }
  for (const name of ['village-brain-first', 'village-operations']) {
    const content = fs.readFileSync(paths.get(name), 'utf8');
    assert.match(content, /platforms:\s*\[windows\]/i);
    assert.doesNotMatch(content, /<!-- WINDOWS_EXECUTION_ADAPTER -->/);
    assert.doesNotMatch(content, /\bvillage_operation\b/i);
  }
  assert.equal(
    fs.existsSync(path.join(hermesHome, 'skills', 'village', 'village-runtime-router', 'SKILL.md')),
    false,
    'the retired execution router must stay absent from the live root'
  );
  assert.equal(
    fs.existsSync(path.join(hermesHome, 'profiles', 'kakaoworker', 'skills', 'devops', 'rpa-automation-operations', 'SKILL.md')),
    true,
    'RPA must remain profile-scoped'
  );
  assert.equal(fs.readFileSync(path.join(hermesHome, '.no-bundled-skills'), 'utf8').trim(), 'mac-parity-curated');
});

test('live root Hermes keeps Mac-style model freedom without injected runtime routing', { skip: !runLiveChecks }, () => {
  const config = fs.readFileSync(path.join(hermesHome, 'config.yaml'), 'utf8');
  assert.match(config, new RegExp(`default:\\s*${escapeRegExp(modelContract.root.model)}`));
  assert.match(config, new RegExp(`provider:\\s*${escapeRegExp(modelContract.root.provider)}`));
  assert.match(config, new RegExp(`reasoning_effort:\\s*${escapeRegExp(modelContract.root.reasoning_effort)}`));
  assert.match(config, /gateway_wall_timeout:\s*1800/);
  assert.match(config, /hard_stop_enabled:\s*false/);
  assert.equal(
    /\$HOME\/village-ops|owner-journal-remote\.jsonl|\bappend\b/i.test(config),
    false,
    'channel prompt must not retain the Mac path or a Brain write exception'
  );
  assert.doesNotMatch(config, /VILLAGE_WINDOWS_RUNTIME_ROUTER_V1/);
  assert.doesNotMatch(config, /id:\s*C0B6ZJZ2XU3[\s\S]{0,160}village-runtime-router/);
});

test('live confirmation path preserves AI judgment and uses the runner only for verified writes', { skip: !runLiveChecks }, () => {
  const operations = fs.readFileSync(
    path.join(hermesHome, 'skills', 'productivity', 'village-operations', 'SKILL.md'),
    'utf8'
  );
  const runnerSkill = fs.readFileSync(
    path.join(hermesHome, 'skills', 'productivity', 'village-confirm-request', 'SKILL.md'),
    'utf8'
  );

  assert.equal(
    fs.existsSync(path.join(hermesHome, 'skills', 'village', 'village-runtime-router', 'SKILL.md')),
    false
  );
  assert.match(operations, /Hermes interprets the request and chooses[\s\S]{0,180}Deterministic code validates and executes/i);
  assert.match(operations, /Split[\s\S]{0,180}different pickup or return times/i);
  assert.match(operations, /focused `village-confirm-request` skill only after reasoning/i);
  assert.match(runnerSkill, /execution\/mutation boundary, not a substitute for AI reasoning/i);
  assert.match(runnerSkill, /create-batch/i);
  assert.match(runnerSkill, /Learning must not be disabled as a speed optimization/i);
  assert.doesNotMatch(runnerSkill, /Do not load `village-operations`/i);
  assert.doesNotMatch(runnerSkill, /Do not run self-improvement/i);
});

test('live Slack hides internal tool progress like the Mac gateway did', { skip: !runLiveChecks }, () => {
  const config = fs.readFileSync(path.join(hermesHome, 'config.yaml'), 'utf8');
  assert.match(
    config,
    /platforms:\s*[\s\S]*?slack:\s*[\s\S]*?tool_progress:\s*false[\s\S]*?interim_assistant_messages:\s*false/i
  );
  assert.doesNotMatch(config, /^\s{2}platform_overrides:\s*$/m);
});

test('Hermes resolves the canonical root skills without retired aliases', { skip: !runLiveChecks }, () => {
  const installedRoot = path.join(hermesHome, 'hermes-agent');
  const python = path.join(installedRoot, 'venv', 'Scripts', 'python.exe');
  const code = [
    'import json',
    'from tools.skills_tool import skill_view',
    `required=${JSON.stringify(expectedRootSkills)}`,
    `forbidden=${JSON.stringify(forbiddenRootSkills)}`,
    'good={name: json.loads(skill_view(name, preprocess=False)) for name in required}',
    'bad={name: json.loads(skill_view(name, preprocess=False)) for name in forbidden}',
    'assert all(row.get("success") is True for row in good.values()), good',
    'assert all(row.get("success") is not True for row in bad.values()), bad',
    'print(json.dumps({"required": {name: row.get("success") for name, row in good.items()}, "forbidden": {name: row.get("success") for name, row in bad.items()}}))'
  ].join('; ');
  const result = spawnSync(python, ['-c', code], {
    cwd: installedRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      HERMES_HOME: hermesHome,
      HERMES_PLATFORM: 'windows'
    }
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
