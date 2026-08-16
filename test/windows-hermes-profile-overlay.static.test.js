const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const adapterRoot = path.join(
  root,
  'scripts',
  'windows',
  'hermes-profile-overlay',
  'adapters'
);
const operationsSkillRoot = path.join(
  root,
  'scripts',
  'windows',
  'hermes-profile-overlay',
  'skills',
  'productivity',
  'village-operations'
);
const brainSkillRoot = path.join(
  root,
  'scripts',
  'windows',
  'hermes-profile-overlay',
  'skills',
  'village',
  'village-brain-first'
);
const confirmRequestSkillPath = path.join(
  root,
  'scripts',
  'windows',
  'hermes-profile-overlay',
  'skills',
  'productivity',
  'village-confirm-request',
  'SKILL.md'
);
const routingConfigScriptPath = path.join(
  root,
  'scripts',
  'windows',
  'configure-hermes-village-routing.py'
);
const startScript = fs.readFileSync(
  path.join(root, 'scripts', 'windows', 'start-kakao-staging.ps1'),
  'utf8'
);
const paritySyncScript = fs.readFileSync(
  path.join(root, 'scripts', 'windows', 'sync-hermes-profile-overlay.ps1'),
  'utf8'
);
const commonModule = fs.readFileSync(
  path.join(root, 'scripts', 'windows', 'KakaoStaging.Common.psm1'),
  'utf8'
);

test('native Village candidates preserve authority and Windows source boundaries', () => {
  const brain = fs.readFileSync(path.join(brainSkillRoot, 'SKILL.md'), 'utf8');
  const operations = fs.readFileSync(path.join(operationsSkillRoot, 'SKILL.md'), 'utf8');
  const brainWindows = fs.readFileSync(
    path.join(brainSkillRoot, 'references', 'windows-runtime-and-sources.md'),
    'utf8'
  );
  const operationsWindows = fs.readFileSync(
    path.join(operationsSkillRoot, 'references', 'windows-runtime-and-sources.md'),
    'utf8'
  );
  const rpa = fs.readFileSync(path.join(adapterRoot, 'rpa-automation-operations.md'), 'utf8');

  assert.match(brain, /^name:\s*village-history-evidence$/m);

  assert.match(brain, /Gary Tan's G-Brain is a separate optional system/i);
  assert.match(brain, /current reservations[\s\S]{0,300}live system\/API readback/i);
  assert.match(operations, /current user may authorize internal Village work/i);
  assert.match(operations, /internal write approval does not (?:approve|authorize) a customer-facing send/i);
  assert.match(operations, /different equipment groups[\s\S]{0,180}different pickup or return times/i);
  assert.match(operations, /existing partial request[\s\S]{0,180}update/i);
  assert.match(operations, /authoritative readback/i);
  assert.match(rpa, /profile/i);
  assert.match(rpa, /does not define the authorization policy/i);
  assert.match(rpa, /Do not load this profile-scoped skill into ordinary Slack business questions/i);
  for (const source of [brainWindows, operationsWindows]) {
    assert.match(source, /C:\/Village/);
    assert.match(source, /Git Bash/i);
    assert.match(source, /native[\s\S]{0,160}(?:node|python|powershell)/i);
    assert.match(source, /live|current/i);
  }
});

test('retired Village routing artifacts are not shipped in the candidate overlay', () => {
  assert.equal(
    fs.existsSync(path.join(root, 'scripts', 'windows', 'hermes-profile-overlay', 'skills', 'village', 'village-runtime-router', 'SKILL.md')),
    false
  );
  assert.equal(fs.existsSync(path.join(adapterRoot, 'village-operations.md')), false);
  assert.equal(fs.existsSync(path.join(adapterRoot, 'village-brain-first.md')), false);
});

test('confirmation-request runner is execution-only and preserves full AI reasoning', () => {
  const source = fs.readFileSync(confirmRequestSkillPath, 'utf8');

  assert.ok(Buffer.byteLength(source, 'utf8') <= 8_000, 'confirmation route must stay compact');
  assert.match(source, /^name:\s*village-confirm-request$/m);
  assert.match(source, /^platforms:\s*\[windows\]$/m);
  assert.match(source, /village-confirm-request\.js/);
  assert.match(source, /create-batch/i);
  assert.match(source, /\bupdate\b/i);
  assert.match(source, /existing partial/i);
  assert.match(source, /--help/i);
  assert.match(source, /do not fall back[\s\S]{0,220}(?:ad-hoc|raw)/i);
  assert.match(source, /execution|mutation/i);
  assert.match(source, /AI[\s\S]{0,220}reason/i);
  assert.match(source, /different return[\s\S]{0,220}split/i);
  assert.match(source, /broad[\s\S]{0,220}catalog/i);
  assert.match(source, /readback/i);
  assert.match(source, /customer-facing send|알림톡/i);
  assert.match(source, /final reservation|최종 예약 등록/i);
  assert.doesNotMatch(source, /do not load `village-operations`/i);
  assert.doesNotMatch(source, /post-task self-improvement|do not run self-improvement/i);
  assert.doesNotMatch(source, /curl .*script\.google/i);
});

test('offline routing configuration applies the current model contract', { skip: process.platform !== 'win32' }, () => {
  const source = fs.readFileSync(routingConfigScriptPath, 'utf8');
  const contract = JSON.parse(fs.readFileSync(
    path.join(root, 'scripts', 'windows', 'hermes-model-contract.json'),
    'utf8'
  )).root;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'village-routing-config-'));
  const configPath = path.join(tempRoot, 'config.yaml');

  fs.writeFileSync(configPath, [
    'model:',
    '  default: stale-model',
    '  provider: stale-provider',
    'agent:',
    '  reasoning_effort: low',
    '  gateway_wall_timeout: 30',
    'tool_loop_guardrails:',
    '  hard_stop_enabled: true',
    'slack:',
    '  channel_skill_bindings:',
    '    - id: C03F11EU0RE',
    '      skills: [village-runtime-router]',
    'terminal:',
    '  cwd: C:\\stale',
    ''
  ].join('\n'), 'utf8');

  try {
    const applied = spawnSync(
      'python.exe',
      [routingConfigScriptPath, '--config', configPath],
      { encoding: 'utf8' }
    );
    assert.equal(applied.status, 0, applied.stderr || applied.stdout);
    const result = JSON.parse(applied.stdout.trim());
    assert.equal(result.model, contract.model);
    assert.equal(result.provider, contract.provider);

    const checked = spawnSync(
      'python.exe',
      [routingConfigScriptPath, '--config', configPath, '--check'],
      { encoding: 'utf8' }
    );
    assert.equal(checked.status, 0, checked.stderr || checked.stdout);
    assert.equal(JSON.parse(checked.stdout.trim()).ok, true);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  for (const channelId of [
    'C03F11EU0RE', // inventory
    'C0B6WAR7R7H', // settlement
    'C0B6ZJZ2XU3', // general group where the slow turn happened
    'C0B769B394K', // schedule
    'C0B7AQN01BQ', // other inquiries
    'C0B7CLP4KDY', // documents
    'C0BB07SM3EH'  // business Heybilli
  ]) {
    assert.match(source, new RegExp(channelId));
  }
  assert.match(source, /gateway_wall_timeout[\s\S]{0,120}1800/i);
  assert.match(source, /hard_stop_enabled[\s\S]{0,120}False/i);
  assert.match(source, /channel_skill_bindings/);
  assert.match(source, /channel_prompts/);
  assert.match(source, /VILLAGE_WINDOWS_RUNTIME_ROUTER_V1/);
  assert.match(source, /remove_managed_bindings/);
  assert.match(source, /remove_managed_prompt/);
  assert.doesNotMatch(source, /desired_bindings/);
  assert.doesNotMatch(source, /desired_channel_prompt/);
  assert.match(source, /C:\\Village\\my-gas-project2-worktrees\\ax2-hermes-final/);
  assert.match(source, /terminal/);
  assert.match(source, /cwd/);
  assert.match(source, /atomic/i);
  assert.match(source, /backup/i);
  assert.match(source, /--check/);
  assert.doesNotMatch(source, /SLACK_(?:BOT|APP)_TOKEN|SUPABASE_SERVICE_ROLE_KEY/);
});

test('Windows support references match the Git Bash and native executable boundary', () => {
  for (const source of [
    fs.readFileSync(path.join(brainSkillRoot, 'references', 'windows-runtime-and-sources.md'), 'utf8'),
    fs.readFileSync(path.join(operationsSkillRoot, 'references', 'windows-runtime-and-sources.md'), 'utf8')
  ]) {
    assert.match(source, /C:\/Village/);
    assert.match(source, /Git Bash/i);
    assert.match(source, /native[\s\S]{0,80}(?:node|python|powershell)/i);
    assert.match(source, /C:\/Village/);
    assert.doesNotMatch(
      source,
      /\b(?:node|python(?:\.exe)?|powershell(?:\.exe)?|cmd(?:\.exe)?|rg(?:\.exe)?)\s+['"]\/c\//i,
      'support reference must not pass an MSYS /c path to a native Windows executable'
    );
  }
});

test('staging forces the safe Windows Brain path and role defaults', () => {
  assert.match(commonModule, /VILLAGE_ROLE\s*=\s*['"]mini['"]/);
  assert.match(commonModule, /VILLAGE_DISABLE_MINI_PUSH\s*=\s*['"]1['"]/);
  assert.match(
    commonModule,
    /VILLAGE_VAULT_ROOT\s*=\s*['"]C:\\Village\\VILLAGE_Brain['"]/
  );
});

test('Brain preflight remains before gateway start without importing a skill snapshot', () => {
  const brainPathIndex = startScript.indexOf("'brain-context-latest.md'");
  const brainLengthIndex = startScript.indexOf('$brainContextFile.Length -le 0');
  const gatewayStartIndex = startScript.indexOf('$gatewayProcess = Start-Process');
  assert.ok(brainPathIndex >= 0, 'start must preflight the compiled Brain context');
  assert.ok(brainLengthIndex >= 0, 'start must reject an empty Brain context');
  assert.ok(brainPathIndex < gatewayStartIndex, 'Brain preflight must precede gateway launch');
  assert.doesNotMatch(
    startScript,
    /sync-hermes-profile-overlay\.ps1|-ProfileScoped/,
    'a normal gateway/worker start must never replace the native Hermes skill tree'
  );
});

test('the active worker profile owns its learned skills across every bridge start', () => {
  const profileHomeIndex = startScript.indexOf('$workerProfileHome');
  const bridgeStartIndex = startScript.indexOf('$bridgeProcess = Start-Process');

  assert.ok(profileHomeIndex >= 0, 'start must resolve the active worker profile');
  assert.ok(profileHomeIndex < bridgeStartIndex, 'the worker profile must be resolved before bridge launch');
  assert.doesNotMatch(startScript, /sync-hermes-profile-overlay\.ps1|-ProfileScoped/);
  assert.match(paritySyncScript, /\[switch\]\$ProfileScoped/);
  assert.match(paritySyncScript, /manual migration|explicit recovery/i);
});

test('RPA profile deployment keeps a rollback copy until replacement succeeds', () => {
  assert.match(paritySyncScript, /\$rpaPrevious\s*=/);
  assert.match(
    paritySyncScript,
    /\[IO\.Directory\]::Move\(\$rpaDestination,\s*\$rpaPrevious\)/
  );
  assert.match(
    paritySyncScript,
    /catch\s*\{[\s\S]*?\[IO\.Directory\]::Move\(\$rpaPrevious,\s*\$rpaDestination\)[\s\S]*?throw/
  );
});
