const assert = require('node:assert/strict');
const fs = require('node:fs');
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
const routerSkillPath = path.join(
  root,
  'scripts',
  'windows',
  'hermes-profile-overlay',
  'skills',
  'village',
  'village-runtime-router',
  'SKILL.md'
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

test('Windows adapters preserve canonical routing and scope safety flags correctly', () => {
  const brain = fs.readFileSync(path.join(adapterRoot, 'village-brain-first.md'), 'utf8');
  const operations = fs.readFileSync(path.join(adapterRoot, 'village-operations.md'), 'utf8');
  const rpa = fs.readFileSync(path.join(adapterRoot, 'rpa-automation-operations.md'), 'utf8');

  assert.match(brain, /complete Mac `village-brain-first` protocol/i);
  assert.match(brain, /explicitly asks[\s\S]{0,240}village-operations/i);
  assert.match(brain, /not a blanket ban/i);
  assert.match(operations, /complete Mac `village-operations` playbook/i);
  assert.match(operations, /explicit owner request/i);
  assert.match(operations, /Internal write approval does not approve a customer-facing send/i);
  assert.match(operations, /not be interpreted as a global prohibition/i);
  assert.match(operations, /confirmation request[\s\S]{0,300}same reasoning/i);
  assert.match(operations, /different return[\s\S]{0,220}split/i);
  assert.match(operations, /broad[\s\S]{0,220}catalog/i);
  assert.match(rpa, /profile/i);
  assert.match(rpa, /does not define the authorization policy/i);
  assert.match(rpa, /Do not load this profile-scoped skill into ordinary Slack business questions/i);
  assert.match(rpa, /Git Bash/i);
  assert.match(rpa, /powershell\.exe\s+-NoProfile/i);
  for (const source of [brain, operations]) {
    assert.match(source, /VILLAGE_DASHBOARD_ENV/);
    assert.match(source, /VILLAGE_TAX_ENV/);
    assert.match(source, /HERMES_ENV/);
    assert.match(source, /VILLAGE_NAME_LINK_QUEUE/);
    assert.match(source, /bare `python3`/i);
  }
});

test('the compact Village router is broad, deterministic, and not sales-specific', () => {
  const source = fs.readFileSync(routerSkillPath, 'utf8');

  assert.ok(Buffer.byteLength(source, 'utf8') <= 8_000, 'router must stay small enough to auto-load');
  assert.match(source, /^name:\s*village-runtime-router$/m);
  assert.match(source, /^platforms:\s*\[windows\]$/m);
  assert.match(source, /reservations[\s\S]{0,240}inventory[\s\S]{0,240}receivables/i);
  assert.match(source, /read-only business fact/i);
  assert.match(source, /requested internal action/i);
  assert.match(source, /RPA health/i);
  assert.match(source, /unrelated|non-Village/i);
  assert.match(source, /C:\/Village\/VILLAGE_Brain\/Ops\/brain-context-latest\.md/i);
  assert.match(source, /Prefer[\s\S]{0,220}canonical[\s\S]{0,220}before slower/i);
  assert.match(source, /additional tools needed[\s\S]{0,180}instead of stopping early/i);
  assert.doesNotMatch(source, /do not use[\s\S]{0,200}Computer Use/i);
  assert.doesNotMatch(source, /do not run[\s\S]{0,200}global (?:file|filesystem) search/i);
  assert.match(source, /one primary route/i);
  assert.match(source, /village-operations[\s\S]{0,220}only/i);
  assert.match(source, /village-live-query\.js/);
  assert.match(source, /village-confirm-request/);
  assert.match(source, /village-confirm-request\.js/);
  assert.match(source, /inventory[\s\S]{0,220}schedule[\s\S]{0,220}customer[\s\S]{0,220}finance/i);
  assert.match(source, /Load `village-brain-first` only for a genuinely complex protocol/i);
  assert.doesNotMatch(source, /do not load `village-brain-first`/i);
  assert.doesNotMatch(source, /revenue-only|sales-only/i);
});

test('confirmation-request runner is execution-only and preserves full AI reasoning', () => {
  const source = fs.readFileSync(confirmRequestSkillPath, 'utf8');

  assert.ok(Buffer.byteLength(source, 'utf8') <= 8_000, 'confirmation route must stay compact');
  assert.match(source, /^name:\s*village-confirm-request$/m);
  assert.match(source, /^platforms:\s*\[windows\]$/m);
  assert.match(source, /village-confirm-request\.js/);
  assert.match(source, /create-batch/i);
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

test('offline routing configuration binds the compact router across Village business surfaces', () => {
  const source = fs.readFileSync(routingConfigScriptPath, 'utf8');
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
  assert.match(source, /village-runtime-router/);
  assert.match(source, /channel_skill_bindings/);
  assert.match(source, /channel_prompts/);
  assert.match(source, /VILLAGE_WINDOWS_RUNTIME_ROUTER_V1/);
  assert.match(source, /village-live-query\.js/);
  assert.match(source, /village-confirm-request\.js/);
  assert.match(source, /village-confirm-request/);
  assert.match(source, /New 확인요청[\s\S]{0,500}village-operations/i);
  assert.match(source, /different return[\s\S]{0,220}split/i);
  assert.match(source, /AI[\s\S]{0,260}(?:reason|judg)/i);
  assert.doesNotMatch(source, /load village-confirm-request only/i);
  assert.doesNotMatch(source, /Resolve aliases once/i);
  assert.doesNotMatch(source, /post-task self-improvement/i);
  assert.match(source, /existing session/i);
  assert.match(source, /C:\\Village\\my-gas-project2-worktrees\\ax2-hermes-final/);
  assert.match(source, /terminal/);
  assert.match(source, /cwd/);
  assert.match(source, /atomic/i);
  assert.match(source, /backup/i);
  assert.match(source, /--check/);
  assert.doesNotMatch(source, /SLACK_(?:BOT|APP)_TOKEN|SUPABASE_SERVICE_ROLE_KEY/);
});

test('Windows adapters match the Git Bash terminal and wrap PowerShell explicitly', () => {
  for (const name of ['village-brain-first.md', 'village-operations.md']) {
    const source = fs.readFileSync(path.join(adapterRoot, name), 'utf8');
    assert.match(source, /C:\\Village/);
    assert.match(source, /Git Bash/i);
    assert.match(source, /powershell\.exe\s+-NoProfile/i);
    assert.match(source, /authoritative Windows execution tree[\s\S]{0,160}ax2-hermes-final/i);
    assert.match(source, /terminal/i);
    assert.match(source, /search_files/);
    assert.match(source, /village-live-read\.js/);
    assert.match(source, /Google Workspace OAuth/i);
    assert.match(source, /Computer Use/i);
    assert.match(source, /not prerequisites?|not a prerequisite/i);
    assert.match(
      source,
      /native Windows executables[\s\S]{0,240}C:\/Village/i,
      `${name} must distinguish shell paths from native executable arguments`
    );
    assert.doesNotMatch(
      source,
      /\b(?:node|python(?:\.exe)?|powershell(?:\.exe)?|cmd(?:\.exe)?|rg(?:\.exe)?)\s+['"]\/c\//i,
      `${name} must not pass an MSYS /c path to a native Windows executable`
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

test('canonical parity sync and Brain preflight both run before gateway start', () => {
  const syncIndex = startScript.indexOf('sync-hermes-profile-overlay.ps1');
  const brainPathIndex = startScript.indexOf("'brain-context-latest.md'");
  const brainLengthIndex = startScript.indexOf('$brainContextFile.Length -le 0');
  const gatewayStartIndex = startScript.indexOf('$gatewayProcess = Start-Process');
  assert.ok(syncIndex >= 0, 'start must reference the parity sync script');
  assert.ok(brainPathIndex >= 0, 'start must preflight the compiled Brain context');
  assert.ok(brainLengthIndex >= 0, 'start must reject an empty Brain context');
  assert.ok(brainPathIndex < gatewayStartIndex, 'Brain preflight must precede gateway launch');
  assert.ok(syncIndex < gatewayStartIndex, 'parity sync must precede gateway launch');
});

test('the active worker profile is synchronized before every bridge start, even without a gateway', () => {
  const profileHomeIndex = startScript.indexOf('$workerProfileHome');
  const syncCallIndex = startScript.indexOf('-ProfileScoped');
  const bridgeStartIndex = startScript.indexOf('$bridgeProcess = Start-Process');
  const gatewayBlockIndex = startScript.indexOf('if ($IncludeGateway)');

  assert.ok(profileHomeIndex >= 0, 'start must resolve the active worker profile');
  assert.ok(syncCallIndex >= 0, 'start must invoke profile-scoped parity sync');
  assert.ok(syncCallIndex < bridgeStartIndex, 'profile sync must finish before the worker bridge starts');
  assert.ok(syncCallIndex < gatewayBlockIndex, 'profile sync must not be gated by IncludeGateway');
  assert.match(paritySyncScript, /\[switch\]\$ProfileScoped/);
  assert.match(paritySyncScript, /Full Hermes AI reasoning/i);
  assert.match(paritySyncScript, /gpt-5\.6-sol/);
  assert.match(paritySyncScript, /reasoning_effort[\s\S]{0,160}high/i);
  assert.match(paritySyncScript, /max_turns[\s\S]{0,160}90/i);
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
