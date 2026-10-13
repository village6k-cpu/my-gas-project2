'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const modulePath = path.resolve(__dirname, '../scripts/windows/KakaoLive.Common.psm1').replaceAll("'", "''");

function probe(extra) {
  const command = `
    $ErrorActionPreference='Stop'
    Import-Module '${modulePath}' -Force
    $global:probeClock=[datetime]'2026-10-13T00:00:00Z'
    $global:probeCalls=0
    $global:observedTimeout=0
    $child=[pscustomobject]@{HasExited=$false}
    $clock={ $global:probeClock }
    $delay={param($milliseconds) $global:probeClock=$global:probeClock.AddMilliseconds($milliseconds)}
    ${extra}
  `;
  return JSON.parse(execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    encoding: 'utf8', windowsHide: true, timeout: 15_000
  }));
}

const windowsOnly = { skip: process.platform !== 'win32' };

test('bridge startup accepts a healthy response that takes longer than the old two-second timeout', windowsOnly, () => {
  const result = probe(`
    function global:Invoke-RestMethod {
      param($Uri, $TimeoutSec)
      $global:probeCalls++
      $global:observedTimeout=$TimeoutSec
      if($TimeoutSec -lt 5){
        $global:probeClock=$global:probeClock.AddSeconds($TimeoutSec)
        throw 'synthetic response timeout'
      }
      $global:probeClock=$global:probeClock.AddSeconds(5)
      return [pscustomobject]@{ok=$true}
    }
    $health=Wait-KakaoBridgeStartupHealth -Process $child -UtcNow $clock -Delay $delay
    [pscustomobject]@{healthy=($health.ok -eq $true);calls=$global:probeCalls;timeout=$global:observedTimeout} | ConvertTo-Json -Compress
  `);
  assert.equal(result.healthy, true);
  assert.equal(result.calls, 1);
  assert.ok(result.timeout >= 5 && result.timeout <= 10);
});

test('bridge startup tolerates cold initialization beyond twenty seconds before accepting readiness', windowsOnly, () => {
  const result = probe(`
    $read={param($timeout) $global:probeCalls++;if($global:probeCalls -lt 4){throw 'initializing'};[pscustomobject]@{ok=$true}}
    $delay={param($milliseconds) $global:probeClock=$global:probeClock.AddSeconds(12)}
    $health=Wait-KakaoBridgeStartupHealth -Process $child -UtcNow $clock -Delay $delay -ReadHealth $read
    [pscustomobject]@{healthy=($health.ok -eq $true);calls=$global:probeCalls} | ConvertTo-Json -Compress
  `);
  assert.deepEqual(result, { healthy: true, calls: 4 });
});

test('bridge startup stops probing at its bounded deadline when readiness never arrives', windowsOnly, () => {
  const result = probe(`
    $read={param($timeout) $global:probeCalls++;throw 'not ready'}
    $delay={param($milliseconds) $global:probeClock=$global:probeClock.AddSeconds(30);if($global:probeCalls -gt 10){throw 'unbounded probe loop'}}
    $health=Wait-KakaoBridgeStartupHealth -Process $child -UtcNow $clock -Delay $delay -ReadHealth $read
    [pscustomobject]@{empty=($null -eq $health);calls=$global:probeCalls} | ConvertTo-Json -Compress
  `);
  assert.deepEqual(result, { empty: true, calls: 3 });
});

test('bridge startup never probes a child that has already exited', windowsOnly, () => {
  const result = probe(`
    $child.HasExited=$true
    $read={param($timeout) $global:probeCalls++;[pscustomobject]@{ok=$true}}
    $health=Wait-KakaoBridgeStartupHealth -Process $child -UtcNow $clock -Delay $delay -ReadHealth $read
    [pscustomobject]@{empty=($null -eq $health);calls=$global:probeCalls} | ConvertTo-Json -Compress
  `);
  assert.deepEqual(result, { empty: true, calls: 0 });
});

test('bridge startup refuses another whole-second HTTP probe when less than one second remains', windowsOnly, () => {
  const result = probe(`
    $global:clockReads=0
    $clock={ $global:clockReads++;if($global:clockReads -gt 1){$global:probeClock.AddMilliseconds(500)}else{$global:probeClock} }
    $read={param($timeout) $global:probeCalls++;[pscustomobject]@{ok=$true}}
    $health=Wait-KakaoBridgeStartupHealth -Process $child -TimeoutSeconds 1 -UtcNow $clock -Delay $delay -ReadHealth $read
    [pscustomobject]@{empty=($null -eq $health);calls=$global:probeCalls} | ConvertTo-Json -Compress
  `);
  assert.deepEqual(result, { empty: true, calls: 0 });
});

test('bridge startup never accepts a response arriving beyond its deadline', windowsOnly, () => {
  const result = probe(`
    $read={param($timeout) $global:probeCalls++;$global:probeClock=$global:probeClock.AddSeconds(2);[pscustomobject]@{ok=$true}}
    $health=Wait-KakaoBridgeStartupHealth -Process $child -TimeoutSeconds 1 -UtcNow $clock -Delay $delay -ReadHealth $read
    [pscustomobject]@{empty=($null -eq $health);calls=$global:probeCalls} | ConvertTo-Json -Compress
  `);
  assert.deepEqual(result, { empty: true, calls: 1 });
});

test('bridge startup clamps the last polling delay to the remaining budget', windowsOnly, () => {
  const result = probe(`
    $global:lastDelay=0
    $read={param($timeout) $global:probeCalls++;$global:probeClock=$global:probeClock.AddMilliseconds(2900);throw 'not ready'}
    $delay={param($milliseconds) $global:lastDelay=$milliseconds;$global:probeClock=$global:probeClock.AddMilliseconds($milliseconds)}
    $health=Wait-KakaoBridgeStartupHealth -Process $child -TimeoutSeconds 3 -UtcNow $clock -Delay $delay -ReadHealth $read
    [pscustomobject]@{empty=($null -eq $health);delay=$global:lastDelay} | ConvertTo-Json -Compress
  `);
  assert.deepEqual(result, { empty: true, delay: 100 });
});
