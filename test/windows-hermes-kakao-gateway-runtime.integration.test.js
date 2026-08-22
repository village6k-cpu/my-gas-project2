const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const scripts = path.join(root, 'scripts', 'windows');
const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function psLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function run(command) {
  return spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    cwd: root,
    encoding: 'utf8'
  });
}

function parse(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim().split(/\r?\n/).filter(Boolean).at(-1));
}

test('kakaoworker Gateway task plan is profile-scoped, clean-lineage, and disabled by default', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kakao-gateway-task-'));
  const hermesHome = path.join(temp, 'hermes');
  const python = path.join(hermesHome, 'hermes-agent', 'venv', 'Scripts', 'python.exe');
  const envFile = path.join(temp, 'bridge.env');
  fs.mkdirSync(path.dirname(python), { recursive: true });
  fs.writeFileSync(python, 'fixture');
  fs.writeFileSync(envFile, 'VILLAGE_KAKAO_BRIDGE_TOKEN=fixture-only\n');

  const script = path.join(scripts, 'register-hermes-gateway-tasks.ps1');
  const base = `& ${psLiteral(script)} -HermesHome ${psLiteral(hermesHome)} ` +
    `-HermesPythonPath ${psLiteral(python)} -EnvFile ${psLiteral(envFile)} -PlanOnly`;
  const disabled = parse(run(base));
  const enabled = parse(run(`${base} -EnableKakaoworker`));

  assert.equal(disabled.kakaoworker.taskName, 'Hermes_Gateway_Kakaoworker_Native');
  assert.equal(disabled.kakaoworker.enabled, false);
  assert.equal(enabled.kakaoworker.enabled, true);
  assert.equal(disabled.kakaoworker.profile, 'kakaoworker');
  assert.equal(path.resolve(disabled.kakaoworker.pythonPath), path.resolve(python));
  assert.match(disabled.kakaoworker.actionScript, /start-hermes-kakaoworker-gateway\.ps1$/i);
  assert.deepEqual(disabled.kakaoworker.launchCommand, [
    python, '-m', 'hermes_cli.main', '--profile', 'kakaoworker', 'gateway', 'run'
  ]);
  assert.equal(path.resolve(disabled.kakaoworker.pidFile), path.resolve(path.join(hermesHome, 'profiles', 'kakaoworker', 'gateway.pid')));
  assert.equal(path.resolve(disabled.kakaoworker.pluginPath), path.resolve(path.join(hermesHome, 'profiles', 'kakaoworker', 'plugins', 'kakao_village')));
  assert.equal(disabled.root.taskName, 'Hermes_Gateway');
  assert.equal(disabled.root.mutated, false);
  assert.equal(disabled.kakaoworker.legacyTaskPreserved, 'Hermes_Gateway_Kakaoworker');
});

test('kakaoworker launcher requires an exact plugin receipt and never uses the incomplete .venv', () => {
  const source = fs.readFileSync(path.join(scripts, 'start-hermes-kakaoworker-gateway.ps1'), 'utf8');
  assert.match(source, /plugin-state[\\/]kakao_village\.json/i);
  assert.match(source, /manifestSha256/i);
  assert.match(source, /fileManifest/i);
  assert.match(source, /venv\\Scripts\\python\.exe/i);
  assert.doesNotMatch(source, /hermes-agent\\\.venv\\Scripts\\python\.exe/i);
  assert.match(source, /VILLAGE_KAKAO_BRIDGE_URL/);
  assert.match(source, /VILLAGE_KAKAO_BRIDGE_TOKEN/);
  assert.match(source, /--profile['"],?\s*['"]kakaoworker/i);
  assert.match(source, /gateway['"],?\s*['"]run/i);
});

test('no-send health requires Gateway transport, fresh consumer, and every send/write gate off', () => {
  const modulePath = path.join(scripts, 'KakaoLiveNoSend.Common.psm1');
  const result = parse(run(`
    Import-Module ${psLiteral(modulePath)} -Force
    $safe = [pscustomobject]@{
      ok = $true
      gateway = [pscustomobject]@{ gatewayReady = $true; consumer = [pscustomobject]@{ fresh = $true } }
      config = [pscustomobject]@{
        workerLive = $true; workerDryRun = $true; windowsWritesEnabled = $false
        autoSendEnabled = $false; slackCardDeliveryEnabled = $false
        slackActionPollEnabled = $false; hermesTransport = 'gateway_no_send'
      }
    }
    $stale = $safe | ConvertTo-Json -Depth 5 | ConvertFrom-Json
    $stale.gateway.consumer.fresh = $false
    $write = $safe | ConvertTo-Json -Depth 5 | ConvertFrom-Json
    $write.config.windowsWritesEnabled = $true
    [pscustomobject]@{
      safe = Test-KakaoLiveNoSendHealth -Health $safe
      stale = Test-KakaoLiveNoSendHealth -Health $stale
      write = Test-KakaoLiveNoSendHealth -Health $write
    } | ConvertTo-Json -Compress
  `));
  assert.deepEqual(result, { safe: true, stale: false, write: false });
});
