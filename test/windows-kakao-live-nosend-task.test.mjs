import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scripts = path.join(root, 'scripts', 'windows');

function psLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function runPowerShell(command) {
  return spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { encoding: 'utf8', cwd: root }
  );
}

function parseJson(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test('live/no-send health contract rejects every customer-send or approval-poller state', () => {
  const modulePath = path.join(scripts, 'KakaoLiveNoSend.Common.psm1');
  const result = runPowerShell(`
    Import-Module ${psLiteral(modulePath)} -Force
    $base = [pscustomobject]@{
      ok = $true
      gateway = [pscustomobject]@{ gatewayReady = $true; consumer = [pscustomobject]@{ fresh = $true } }
      config = [pscustomobject]@{
        workerLive = $true
        workerDryRun = $true
        windowsWritesEnabled = $false
        autoSendEnabled = $false
        slackCardDeliveryEnabled = $false
        slackActionPollEnabled = $false
        hermesTransport = 'gateway_no_send'
      }
    }
    $autoSend = $base | ConvertTo-Json -Depth 4 | ConvertFrom-Json
    $autoSend.config.autoSendEnabled = $true
    $poller = $base | ConvertTo-Json -Depth 4 | ConvertFrom-Json
    $poller.config.slackActionPollEnabled = $true
    $cards = $base | ConvertTo-Json -Depth 5 | ConvertFrom-Json
    $cards.config.slackCardDeliveryEnabled = $true
    [pscustomobject]@{
      safe = Test-KakaoLiveNoSendHealth -Health $base
      autoSend = Test-KakaoLiveNoSendHealth -Health $autoSend
      poller = Test-KakaoLiveNoSendHealth -Health $poller
      cards = Test-KakaoLiveNoSendHealth -Health $cards
    } | ConvertTo-Json -Compress
  `);

  assert.deepEqual(parseJson(result), {
    safe: true,
    autoSend: false,
    poller: false,
    cards: false
  });
});

test('no-send transition permits queued live work only behind an explicit switch and never while a worker runs', () => {
  const modulePath = path.join(scripts, 'KakaoLiveNoSend.Common.psm1');
  const result = runPowerShell(`
    Import-Module ${psLiteral(modulePath)} -Force
    $queuedLive = [pscustomobject]@{
      state = [pscustomobject]@{ workerRunning = $false; workerQueueLength = 13 }
      config = [pscustomobject]@{ autoSendEnabled = $true; slackActionPollEnabled = $true }
    }
    $running = $queuedLive | ConvertTo-Json -Depth 4 | ConvertFrom-Json
    $running.state.workerRunning = $true
    [pscustomobject]@{
      normal = Test-KakaoNoSendTransitionAllowed -Health $queuedLive -AllowLiveTransition:$false
      explicit = Test-KakaoNoSendTransitionAllowed -Health $queuedLive -AllowLiveTransition:$true
      running = Test-KakaoNoSendTransitionAllowed -Health $running -AllowLiveTransition:$true
    } | ConvertTo-Json -Compress
  `);

  assert.deepEqual(parseJson(result), {
    normal: false,
    explicit: true,
    running: false
  });
});

test('no-send transition forcibly disables customer send and approval polling', () => {
  const modulePath = path.join(scripts, 'KakaoLiveNoSend.Common.psm1');
  const result = runPowerShell(`
    Import-Module ${psLiteral(modulePath)} -Force
    $env:AI_WORKER_LIVE = '1'
    $env:AI_WORKER_AUTO_SEND = '1'
    $env:AI_WORKER_DRY_RUN = '1'
    $env:SLACK_ACTION_POLL_ENABLED = '1'
    $env:SLACK_AGENT_CARD_DELIVERY_ENABLED = '0'
    $env:VILLAGE_WINDOWS_WRITES_ENABLED = '0'
    $env:KAKAO_HERMES_TRANSPORT = 'cli'
    Set-KakaoLiveNoSendEnvironment
    [pscustomobject]@{
      workerLive = $env:AI_WORKER_LIVE
      autoSend = $env:AI_WORKER_AUTO_SEND
      dryRun = $env:AI_WORKER_DRY_RUN
      actionPoll = $env:SLACK_ACTION_POLL_ENABLED
      slackCards = $env:SLACK_AGENT_CARD_DELIVERY_ENABLED
      windowsWrites = $env:VILLAGE_WINDOWS_WRITES_ENABLED
      hermesTransport = $env:KAKAO_HERMES_TRANSPORT
    } | ConvertTo-Json -Compress
  `);

  assert.deepEqual(parseJson(result), {
    workerLive: '1',
    autoSend: '0',
    dryRun: '1',
    actionPoll: '0',
    slackCards: '0',
    windowsWrites: '0',
    hermesTransport: 'gateway_no_send'
  });
});

test('no-send restart preflight validates the same fail-closed runtime contract it applies', () => {
  const source = readFileSync(path.join(scripts, 'Restart-KakaoBridgeNoSend.ps1'), 'utf8');

  assert.match(source, /\$required\s*=\s*Get-KakaoLiveNoSendRuntimeContract/);
  assert.match(source, /Test-KakaoLiveNoSendHealth\s+-Health\s+\$post/);
  assert.doesNotMatch(source, /SLACK_AGENT_CARD_DELIVERY_ENABLED\s*=\s*'1'/);
  assert.doesNotMatch(source, /VILLAGE_WINDOWS_WRITES_ENABLED\s*=\s*'1'/);
});

test('live/no-send runtime repairs authentication and watcher without enabling full-live', () => {
  const modulePath = path.join(scripts, 'KakaoLiveNoSend.Common.psm1');
  const result = runPowerShell(`
    Import-Module ${psLiteral(modulePath)} -Force
    [pscustomobject]@{
      healthy = Get-KakaoLiveNoSendRecoveryAction -RuntimeState 'healthy'
      login = Get-KakaoLiveNoSendRecoveryAction -RuntimeState 'login_required'
      watcher = Get-KakaoLiveNoSendRecoveryAction -RuntimeState 'watcher_repair_required'
      challenge = Get-KakaoLiveNoSendRecoveryAction -RuntimeState 'second_factor_required'
      degraded = Get-KakaoLiveNoSendRecoveryAction -RuntimeState 'degraded'
    } | ConvertTo-Json -Compress
  `);

  assert.deepEqual(parseJson(result), {
    healthy: 'none',
    login: 'recover_login',
    watcher: 'repair_watcher_only',
    challenge: 'preserve_and_wait',
    degraded: 'preserve_and_wait'
  });

  const source = readFileSync(path.join(scripts, 'start-kakao-live-nosend.ps1'), 'utf8');
  assert.match(source, /Invoke-KakaoLoginRecovery/);
  assert.match(source, /Repair-KakaoWatcherRuntime/);
  assert.match(source, /Repair-KakaoWatcherRuntime\s+-Force/);
  assert.match(source, /autoSendEnabled\s*=\s*\$false/);
  assert.doesNotMatch(source, /Restart-KakaoBridgeLive/);
});

test('live/no-send startup plan promotes staging ownership without enabling customer sends', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'village-live-task-'));
  try {
    const envFile = path.join(temp, 'runtime.env');
    const chromePath = path.join(temp, 'chrome.exe');
    const nodePath = path.join(temp, 'node.exe');
    const hermesPythonPath = path.join(temp, 'python.exe');
    writeFileSync(envFile, 'AI_WORKER_AUTO_SEND=0\n');
    writeFileSync(chromePath, 'fixture');
    writeFileSync(nodePath, 'fixture');
    writeFileSync(hermesPythonPath, 'fixture');

    const startScript = path.join(scripts, 'start-kakao-live-nosend.ps1');
    const result = runPowerShell(`& ${psLiteral(startScript)} ` +
      `-EnvFile ${psLiteral(envFile)} -ChromePath ${psLiteral(chromePath)} ` +
      `-NodePath ${psLiteral(nodePath)} -HermesPythonPath ${psLiteral(hermesPythonPath)} -PlanOnly`);
    const plan = parseJson(result);

    assert.deepEqual(plan.runtime, {
      AI_WORKER_LIVE: '1',
      AI_WORKER_AUTO_SEND: '0',
      AI_WORKER_DRY_RUN: '1',
      SLACK_ACTION_POLL_ENABLED: '0',
      SLACK_AGENT_CARD_DELIVERY_ENABLED: '0',
      VILLAGE_WINDOWS_WRITES_ENABLED: '0',
      HERMES_WORKER_COMMAND_MODE: 'python_module',
      KAKAO_HERMES_TRANSPORT: 'gateway_no_send'
    });
    assert.deepEqual(plan.steps, [
      'accept-already-healthy-live-nosend',
      'stop-owned-remnants-if-unhealthy',
      'start-owned-staging-with-writes',
      'promote-bridge-to-live-nosend',
      'verify-kakaoworker-plugin-hash',
      'verify-gateway-consumer-heartbeat',
      'verify-live-nosend-health'
    ]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('full-live startup contract keeps customer replies and approval polling while cutting legacy cards to v2', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'village-full-live-task-'));
  try {
    const envFile = path.join(temp, 'runtime.env');
    const chromePath = path.join(temp, 'chrome.exe');
    const nodePath = path.join(temp, 'node.exe');
    const hermesPythonPath = path.join(temp, 'python.exe');
    writeFileSync(envFile, 'AI_WORKER_AUTO_SEND=1\nWORK_ORCHESTRATOR_V2_RUNTIME_MODE=v2\n');
    writeFileSync(chromePath, 'fixture');
    writeFileSync(nodePath, 'fixture');
    writeFileSync(hermesPythonPath, 'fixture');

    const modulePath = path.join(scripts, 'KakaoLive.Common.psm1');
    const health = parseJson(runPowerShell(`
      Import-Module ${psLiteral(modulePath)} -Force
      $env:WORK_ORCHESTRATOR_V2_RUNTIME_MODE = 'v2'
      $env:SLACK_ACTION_POLL_ENABLED = '0'
      $env:WORKER_CATCHUP_TIMEOUT_MS = '75000'
      $env:HERMES_HOME = 'C:\\Village\\MacMiniMirror\\restored\\.hermes'
      Set-KakaoLiveRuntimeEnvironment
      $value = [pscustomobject]@{ ok = $true; workOrchestrator = [pscustomobject]@{ ok = $true }; runtime = [pscustomobject]@{
        state = 'healthy'; cdpReady = $true; authenticated = $true; watcherReady = $true
      }; config = [pscustomobject]@{
        workerLive = $true; workerDryRun = $false; windowsWritesEnabled = $true
        autoSendEnabled = $true; slackCardDeliveryEnabled = $false; followUpRowsEnabled = $false
        slackActionPollEnabled = $false; p0SlackEscalationEnabled = $false; slackBotTokenPresent = $true
        supabaseRecoveryEnabled = $true; kakaoTabCleanupEnabled = $true; startupCatchupSupported = $true
        aiDomSplitEnabled = $true; aiDecisionConcurrency = 2
        workOrchestrator = [pscustomobject]@{ runtimeMode = 'v2'; shadowWrites = $false; immediateEnabled = $false; workItemsEnabled = $true; digestEnabled = $true; cleanupEnabled = $true; p0ReadbackEnabled = $true; p0CutoverEnabled = $true; storeConfigured = $true; immediateLocalConfigReady = $false; p0LocalConfigReady = $true; digestLocalConfigReady = $true; actionLocalConfigReady = $true; cleanupLocalConfigReady = $true }
      }}
      $legacy = [pscustomobject]@{ ok = $true; config = [pscustomobject]@{
        workerLive = $true; workerDryRun = $false; windowsWritesEnabled = $true
        autoSendEnabled = $true; slackCardDeliveryEnabled = $false; followUpRowsEnabled = $false
        slackActionPollEnabled = $true; p0SlackEscalationEnabled = $false
        supabaseRecoveryEnabled = $true; kakaoTabCleanupEnabled = $true
      }}
      [pscustomobject]@{
        contract = [pscustomobject](Get-KakaoLiveRuntimeContract)
        applied = [pscustomobject]@{
          actionPoll = $env:SLACK_ACTION_POLL_ENABLED
          catchupTimeout = $env:WORKER_CATCHUP_TIMEOUT_MS
          hermesHome = $env:HERMES_HOME
          hermesTransport = $env:KAKAO_HERMES_TRANSPORT
        }
        healthy = Test-KakaoLiveHealth -Health $value
        legacyHealthy = Test-KakaoLiveHealth -Health $legacy
        cdpDown = Test-KakaoLiveHealth -Health ([pscustomobject]@{
          ok = $true; runtime = [pscustomobject]@{ state = 'cdp_unavailable'; cdpReady = $false; authenticated = $true; watcherReady = $true }; config = $value.config
        })
        watcherDown = Test-KakaoLiveHealth -Health ([pscustomobject]@{
          ok = $true; runtime = [pscustomobject]@{ state = 'watcher_repair_required'; cdpReady = $true; authenticated = $true; watcherReady = $false }; config = $value.config
        })
      } | ConvertTo-Json -Depth 5 -Compress
    `));
    assert.equal(health.healthy, true);
    assert.equal(health.legacyHealthy, false);
    assert.equal(health.cdpDown, false);
    assert.equal(health.watcherDown, false);
    const canonicalHermesHome = path.join(process.env.LOCALAPPDATA, 'hermes');
    assert.deepEqual(health.applied, {
      actionPoll: '0',
      catchupTimeout: '300000',
      hermesHome: canonicalHermesHome,
      hermesTransport: 'cli'
    });
    assert.deepEqual(health.contract, {
      AI_WORKER_LIVE: '1',
      AI_WORKER_AUTO_SEND: '1',
      AI_WORKER_DRY_RUN: '0',
      SLACK_ACTION_POLL_ENABLED: '0',
      SLACK_AGENT_CARD_DELIVERY_ENABLED: '0',
      AI_WORKER_FOLLOW_UP_ITEMS_ENABLED: '0',
      KAKAO_FOLLOW_UP_ITEMS_ENABLED: '0',
      P0_SLACK_ESCALATION_ENABLED: '0',
      WORK_ORCHESTRATOR_V2_RUNTIME_MODE: 'v2',
      WORK_ORCHESTRATOR_V2_SHADOW_WRITES: '0',
      WORK_ORCHESTRATOR_V2_IMMEDIATE_ENABLED: '0',
      WORK_ORCHESTRATOR_V2_WORK_ITEMS_ENABLED: '1',
      WORK_ORCHESTRATOR_V2_DIGEST_ENABLED: '1',
      WORK_ORCHESTRATOR_V2_CLEANUP_ENABLED: '1',
      WORK_ORCHESTRATOR_V2_P0_READBACK_ENABLED: '1',
      WORK_ORCHESTRATOR_V2_P0_CUTOVER_ENABLED: '1',
      WORK_ORCHESTRATOR_V2_REPORT_ONLY_ENABLED: '1',
      WORK_ORCHESTRATOR_V2_HEYBILLI_ACTIONS_READY: '1',
      SLACK_DASHBOARD_URL: 'https://today-dashboard-ten.vercel.app/follow-ups',
      VILLAGE_WINDOWS_WRITES_ENABLED: '1',
      SUPABASE_RECOVERY_ENABLED: '1',
      KAKAO_TAB_CLEANUP_ENABLED: '1',
      HERMES_WORKER_COMMAND_MODE: 'python_module',
      HERMES_HOME: canonicalHermesHome,
      DEBOUNCE_MS: '15000',
      MAX_WAIT_MS: '45000',
      WORKER_SLOW_ALERT_MS: '30000',
      WORKER_TIMEOUT_MS: '300000',
      WORKER_CATCHUP_TIMEOUT_MS: '300000',
      HERMES_WORKER_TIMEOUT_MS: '240000',
      HERMES_WORKER_MAX_TURNS: '90',
      HERMES_WORKER_SKILLS: 'village-operations,village-confirm-request',
      KAKAO_AI_DOM_SPLIT_ENABLED: '1',
      KAKAO_AI_DECISION_CONCURRENCY: '2'
    });

    const startScript = path.join(scripts, 'start-kakao-live.ps1');
    const startSource = readFileSync(startScript, 'utf8');
    assert.match(startSource, /Repair-KakaoWatcherRuntime\s+-Force/);
    const plan = parseJson(runPowerShell(`& ${psLiteral(startScript)} ` +
      `-EnvFile ${psLiteral(envFile)} -ChromePath ${psLiteral(chromePath)} ` +
      `-NodePath ${psLiteral(nodePath)} -HermesPythonPath ${psLiteral(hermesPythonPath)} -PlanOnly`));
    assert.equal(plan.runtime.AI_WORKER_AUTO_SEND, '1');
    assert.equal(plan.runtime.SLACK_ACTION_POLL_ENABLED, '0');
    assert.deepEqual(plan.steps, [
      'accept-already-healthy-live',
      'classify-kakao-runtime-state',
      'preserve-authentication-pages',
      'repair-only-the-failed-layer',
      'verify-full-live-health'
    ]);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('busy live bridge restarts Chrome only for CDP loss and repairs watcher in place', () => {
  const modulePath = path.join(scripts, 'KakaoLive.Common.psm1');
  const result = runPowerShell(`
    Import-Module ${psLiteral(modulePath)} -Force
    [pscustomobject]@{
      cdpDown = Get-KakaoLiveRecoveryAction -BridgeContractHealthy $true -RuntimeState 'cdp_unavailable' -BridgeBusy $true
      watcherDown = Get-KakaoLiveRecoveryAction -BridgeContractHealthy $true -RuntimeState 'watcher_repair_required' -BridgeBusy $true
      bridgeBad = Get-KakaoLiveRecoveryAction -BridgeContractHealthy $false -RuntimeState 'healthy' -BridgeBusy $false
    } | ConvertTo-Json -Compress
  `);

  assert.deepEqual(parseJson(result), {
    cdpDown: 'restart_owned_chrome_only',
    watcherDown: 'repair_watcher_only',
    bridgeBad: 'restart_full_runtime'
  });
});

test('scheduled task plan defaults disabled and requires an explicit enable switch', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'village-live-register-'));
  try {
    const envFile = path.join(temp, 'runtime.env');
    const chromePath = path.join(temp, 'chrome.exe');
    const nodePath = path.join(temp, 'node.exe');
    const hermesPythonPath = path.join(temp, 'python.exe');
    writeFileSync(envFile, 'AI_WORKER_AUTO_SEND=0\n');
    writeFileSync(chromePath, 'fixture');
    writeFileSync(nodePath, 'fixture');
    writeFileSync(hermesPythonPath, 'fixture');

    const registerScript = path.join(scripts, 'register-kakao-live-nosend-task.ps1');
    const base = `& ${psLiteral(registerScript)} -EnvFile ${psLiteral(envFile)} ` +
      `-ChromePath ${psLiteral(chromePath)} -NodePath ${psLiteral(nodePath)} ` +
      `-HermesPythonPath ${psLiteral(hermesPythonPath)} -PlanOnly`;
    const disabled = parseJson(runPowerShell(base));
    const enabled = parseJson(runPowerShell(`${base} -Enable`));

    assert.equal(disabled.taskName, 'Village-Kakao-Live-NoSend-Start');
    assert.equal(disabled.enabled, false);
    assert.equal(enabled.enabled, true);
    assert.deepEqual(disabled.triggers, ['AtLogOn', 'Every2Minutes']);
    assert.equal(disabled.selfHealInterval, 'PT2M');
    assert.equal(disabled.conflictingTask, 'Village-Kakao-Live-Start');
    assert.equal(disabled.runLevel, 'Limited');
    assert.match(disabled.actionScript, /start-kakao-live-nosend\.ps1$/i);
    assert.equal(disabled.autoSendEnabled, false);
    assert.equal(disabled.hermesCommandMode, 'python_module');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test('full-live scheduled task plan is autosend, bounded, and conflicts with no-send recovery', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'village-full-live-register-'));
  try {
    const envFile = path.join(temp, 'runtime.env');
    const chromePath = path.join(temp, 'chrome.exe');
    const nodePath = path.join(temp, 'node.exe');
    const hermesPythonPath = path.join(temp, 'python.exe');
    writeFileSync(envFile, 'AI_WORKER_AUTO_SEND=1\n');
    writeFileSync(chromePath, 'fixture');
    writeFileSync(nodePath, 'fixture');
    writeFileSync(hermesPythonPath, 'fixture');

    const registerScript = path.join(scripts, 'register-kakao-live-task.ps1');
    const base = `& ${psLiteral(registerScript)} -EnvFile ${psLiteral(envFile)} ` +
      `-ChromePath ${psLiteral(chromePath)} -NodePath ${psLiteral(nodePath)} ` +
      `-HermesPythonPath ${psLiteral(hermesPythonPath)} -PlanOnly`;
    const disabled = parseJson(runPowerShell(base));
    const enabled = parseJson(runPowerShell(`${base} -Enable`));

    assert.equal(disabled.taskName, 'Village-Kakao-Live-Start');
    assert.equal(disabled.enabled, false);
    assert.equal(enabled.enabled, true);
    assert.deepEqual(disabled.triggers, ['AtLogOn', 'Every2Minutes']);
    assert.equal(disabled.selfHealInterval, 'PT2M');
    assert.equal(disabled.executionTimeLimit, 'PT2M');
    assert.equal(disabled.conflictingTask, 'Village-Kakao-Live-NoSend-Start');
    assert.equal(disabled.runLevel, 'Limited');
    assert.match(disabled.actionScript, /start-kakao-live\.ps1$/i);
    assert.equal(disabled.autoSendEnabled, true);
    assert.equal(disabled.hermesCommandMode, 'python_module');
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
