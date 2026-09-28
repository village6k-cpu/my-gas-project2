import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const modulePath = fileURLToPath(
  new URL('../scripts/windows/KakaoLivenessGuard.Common.psm1', import.meta.url),
);
const guardScript = fs.readFileSync(fileURLToPath(
  new URL('../scripts/windows/watch-kakao-production-guard.ps1', import.meta.url),
), 'utf8');

function resolveAction({
  chromeHealthy,
  bridgeHealthy,
  gatewayHealthy,
  watcherHealthy,
  consecutiveFailures,
}) {
  const escapedPath = modulePath.replaceAll("'", "''");
  const command = [
    "$ErrorActionPreference='Stop'",
    `Import-Module '${escapedPath}' -Force`,
    `$action=Resolve-KakaoLivenessGuardAction -ChromeHealthy $${chromeHealthy} -BridgeHealthy $${bridgeHealthy} -GatewayHealthy $${gatewayHealthy} -WatcherHealthy $${watcherHealthy} -ConsecutiveFailures ${consecutiveFailures}`,
    '[Console]::Out.Write($action)',
  ].join('; ');
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { encoding: 'utf8', windowsHide: true },
  ).trim();
}

test('Kakao liveness guard is silent when every live contract is healthy', () => {
  assert.equal(resolveAction({
    chromeHealthy: true,
    bridgeHealthy: true,
    gatewayHealthy: true,
    watcherHealthy: true,
    consecutiveFailures: 0,
  }), 'healthy');
});

test('Kakao liveness guard recovers only the bridge when Chrome watcher is healthy', () => {
  assert.equal(resolveAction({
    chromeHealthy: true,
    bridgeHealthy: false,
    gatewayHealthy: true,
    watcherHealthy: true,
    consecutiveFailures: 1,
  }), 'recover_bridge_only');
});

test('Kakao liveness guard defers a transient probe failure without restarting anything', () => {
  assert.equal(resolveAction({
    chromeHealthy: true,
    bridgeHealthy: true,
    gatewayHealthy: true,
    watcherHealthy: false,
    consecutiveFailures: 1,
  }), 'defer');
});

test('Kakao liveness guard escalates a repeated watcher failure to the live evaluator', () => {
  assert.equal(resolveAction({
    chromeHealthy: true,
    bridgeHealthy: true,
    gatewayHealthy: true,
    watcherHealthy: false,
    consecutiveFailures: 3,
  }), 'evaluate_live_runtime');
});

test('Kakao liveness guard escalates missing core components only after confirmation', () => {
  assert.equal(resolveAction({
    chromeHealthy: false,
    bridgeHealthy: false,
    gatewayHealthy: true,
    watcherHealthy: false,
    consecutiveFailures: 1,
  }), 'defer');
  assert.equal(resolveAction({
    chromeHealthy: false,
    bridgeHealthy: false,
    gatewayHealthy: true,
    watcherHealthy: false,
    consecutiveFailures: 2,
  }), 'run_full_watchdog');
});

test('Kakao liveness guard never assigns PowerShell reserved HOME', () => {
  assert.doesNotMatch(guardScript, /\$(?:home|HOME)\s*=/i);
});
