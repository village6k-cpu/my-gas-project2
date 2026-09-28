import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const source = fs.readFileSync(path.resolve(
  import.meta.dirname,
  '..',
  'scripts',
  'windows',
  'install-runtime-liveness-guards.ps1',
), 'utf8');

test('installer deploys guards to a stable user-local path', () => {
  assert.match(source, /LOCALAPPDATA[\s\S]{0,120}Village[\\/]runtime-guards/i);
  for (const file of [
    'HermesRootLiveness.Common.psm1',
    'KakaoLivenessGuard.Common.psm1',
    'watch-hermes-root-liveness.ps1',
    'watch-kakao-production-guard.ps1',
  ]) {
    assert.match(source, new RegExp(file.replace('.', '\\.')));
  }
});

test('installer registers cheap guards and disables the destructive legacy watchdog', () => {
  assert.match(source, /Village-Hermes-Root-Liveness-Guard/);
  assert.match(source, /Village-Kakao-Production-Liveness-Guard/);
  assert.match(source, /RepetitionInterval\s+\(New-TimeSpan\s+-Minutes\s+1\)/i);
  assert.match(source, /RepetitionInterval\s+\(New-TimeSpan\s+-Minutes\s+5\)/i);
  assert.match(source, /MultipleInstances\s+IgnoreNew/i);
  assert.match(source, /StartWhenAvailable/i);
  assert.match(source, /Disable-ScheduledTask[\s\S]{0,120}Village-Kakao-Production-Watchdog/i);
  assert.doesNotMatch(source, /Unregister-ScheduledTask|Remove-ScheduledTask/i);
});

test('installer preserves hidden non-interactive PowerShell execution', () => {
  assert.match(source, /C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe/i);
  assert.match(source, /-NoProfile\s+-NonInteractive\s+-WindowStyle\s+Hidden\s+-ExecutionPolicy\s+Bypass/i);
});
