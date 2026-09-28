import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const modulePath = fileURLToPath(
  new URL('../scripts/windows/HermesRootLiveness.Common.psm1', import.meta.url),
);

function resolveAction({
  pidRecordPresent,
  processAlive,
  processMatchesRoot,
  gatewayState = 'unknown',
  stateAgeSeconds = 999,
  activeAgents = 0,
}) {
  const escapedPath = modulePath.replaceAll("'", "''");
  const command = [
    "$ErrorActionPreference='Stop'",
    `Import-Module '${escapedPath}' -Force`,
    `$action=Resolve-HermesRootLivenessAction -PidRecordPresent $${pidRecordPresent} -ProcessAlive $${processAlive} -ProcessMatchesRoot $${processMatchesRoot} -GatewayState '${gatewayState}' -StateAgeSeconds ${stateAgeSeconds} -ActiveAgents ${activeAgents}`,
    '[Console]::Out.Write($action)',
  ].join('; ');
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command],
    { encoding: 'utf8', windowsHide: true },
  ).trim();
}

test('root liveness guard leaves the verified live gateway untouched', () => {
  assert.equal(resolveAction({
    pidRecordPresent: true,
    processAlive: true,
    processMatchesRoot: true,
    gatewayState: 'running',
    stateAgeSeconds: 600,
    activeAgents: 1,
  }), 'healthy');
});

test('root liveness guard blocks when a live PID does not belong to root Hermes', () => {
  assert.equal(resolveAction({
    pidRecordPresent: true,
    processAlive: true,
    processMatchesRoot: false,
    gatewayState: 'running',
    stateAgeSeconds: 5,
  }), 'blocked_process_mismatch');
});

test('root liveness guard defers a fresh startup instead of launching a duplicate', () => {
  assert.equal(resolveAction({
    pidRecordPresent: false,
    processAlive: false,
    processMatchesRoot: false,
    gatewayState: 'starting',
    stateAgeSeconds: 45,
  }), 'defer_startup');
});

test('root liveness guard starts only after the missing gateway is stale', () => {
  assert.equal(resolveAction({
    pidRecordPresent: false,
    processAlive: false,
    processMatchesRoot: false,
    gatewayState: 'running',
    stateAgeSeconds: 180,
  }), 'start');
});
