const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('Windows Heybilli gateway uses the runtime that can load Slack Socket Mode', {
  skip: process.platform !== 'win32'
}, () => {
  const hermesHome = path.join(process.env.LOCALAPPDATA || '', 'hermes');
  const agentHome = path.join(hermesHome, 'hermes-agent');
  const python = path.join(agentHome, 'venv', 'Scripts', 'python.exe');
  const incompletePython = path.join(agentHome, '.venv', 'Scripts', 'python.exe');
  const runtimeRoot = String.raw`C:\Village\hermes-agent-worktrees\village-hermes-clean-runtime`;
  const cmd = fs.readFileSync(path.join(hermesHome, 'gateway-service', 'Hermes_Gateway.cmd'), 'utf8');
  const vbs = fs.readFileSync(path.join(hermesHome, 'gateway-service', 'Hermes_Gateway.vbs'), 'utf8');

  for (const launcher of [cmd, vbs]) {
    assert.match(launcher, /hermes-agent\\venv\\Scripts\\python\.exe/i);
    assert.doesNotMatch(launcher, /hermes-agent\\\.venv\\Scripts\\python\.exe/i);
    assert.match(launcher, new RegExp(runtimeRoot.replace(/\\/g, '\\\\'), 'i'));
  }

  const probe = spawnSync(python, [
    '-c',
    'import json, hermes_cli, aiohttp, slack_sdk; from plugins.platforms.slack import adapter; from tools import file_tools; print(json.dumps({"slack": adapter.__file__, "files": file_tools.__file__}))'
  ], {
    encoding: 'utf8',
    cwd: runtimeRoot,
    env: {
      ...process.env,
      PYTHONPATH: [runtimeRoot, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter)
    }
  });
  assert.equal(probe.status, 0, probe.stderr || probe.stdout);
  const loaded = JSON.parse(probe.stdout.trim());
  assert.equal(path.resolve(loaded.slack).startsWith(path.resolve(runtimeRoot)), true, loaded.slack);
  assert.equal(path.resolve(loaded.files).startsWith(path.resolve(runtimeRoot)), true, loaded.files);

  if (fs.existsSync(incompletePython)) {
    const incompleteProbe = spawnSync(incompletePython, [
      '-c',
      'import aiohttp'
    ], { encoding: 'utf8', cwd: agentHome });
    assert.notEqual(
      incompleteProbe.status,
      0,
      'do not move the Slack gateway back to .venv until that environment has the required plugin dependencies'
    );
  }
});

test('root Slack gateway stays independent while Kakao gets a disabled-by-default native Gateway task', () => {
  const root = path.resolve(__dirname, '..');
  const register = fs.readFileSync(
    path.join(root, 'scripts', 'windows', 'register-hermes-gateway-tasks.ps1'),
    'utf8'
  );
  const restart = fs.readFileSync(
    path.join(root, 'scripts', 'windows', 'restart-hermes-gateway.ps1'),
    'utf8'
  );

  assert.match(register, /Register-ScheduledTask[\s\S]*Hermes_Gateway_Kakaoworker_Native/i);
  assert.match(register, /if\s*\(\$EnableKakaoworker\.IsPresent\)/i);
  assert.match(register, /Disable-ScheduledTask[\s\S]*Hermes_Gateway_Kakaoworker_Native/i);
  assert.match(register, /Register-ScheduledTask[\s\S]*-ErrorAction\s+Stop/i);
  assert.doesNotMatch(register, /RepetitionDuration\s+\(\[TimeSpan\]::MaxValue\)/i);
  assert.match(register, /-Target\s+root\s+-HealOnly/i);
  assert.match(restart, /if\s*\(\$Target\s+-eq\s+['"]all['"]\)\s*\{\s*\$targets\s*=\s*@\(['"]root['"]\)\s*\}/i);
  assert.match(restart, /profiles\\kakaoworker\\gateway\.pid/i);
  assert.match(restart, /--profile['"],?\s*['"]kakaoworker/i);
});

test('manual Kakao gateway restart uses the native task and validates it before stopping the live worker', () => {
  const root = path.resolve(__dirname, '..');
  const restart = fs.readFileSync(
    path.join(root, 'scripts', 'windows', 'restart-hermes-gateway.ps1'),
    'utf8'
  );
  const recoveryReference = fs.readFileSync(
    path.join(root, 'scripts', 'windows', 'hermes-profile-overlay', 'skills', 'productivity',
      'village-operations', 'references', 'gateway-self-restart-recovery.md'),
    'utf8'
  );

  assert.match(restart, /Task\s*=\s*['"]Hermes_Gateway_Kakaoworker_Native['"]/i);
  assert.doesNotMatch(restart, /Task\s*=\s*['"]Hermes_Gateway_Kakaoworker['"]/i);
  const preflightIndex = restart.indexOf('Test-GatewayScheduledTaskReady -TaskName $info.Task');
  const processScanIndex = restart.indexOf('Get-ProfileGatewayProcs -Match $info.Match');
  assert.ok(preflightIndex >= 0 && preflightIndex < processScanIndex,
    'scheduled task readiness must be proven before the live worker is stopped');
  assert.match(recoveryReference, /Hermes_Gateway_Kakaoworker_Native/);
  assert.doesNotMatch(recoveryReference, /Hermes_Gateway_Kakaoworker(?!_Native)/);
});
