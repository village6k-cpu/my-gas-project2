import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modulePath = path.join(root, 'scripts', 'windows', 'KakaoStaging.Common.psm1');

function ownedChromeArguments() {
  const script = [
    `Import-Module '${modulePath.replaceAll("'", "''")}' -Force`,
    "$arguments = Get-OwnedKakaoChromeArguments -DevToolsPort 9223 -ProfilePath 'C:\\Village Runtime\\chrome profile' -ExtensionPath 'C:\\Village Runtime\\watcher extension' -StartUrl 'https://business.kakao.com/example/chats'",
    '@($arguments) | ConvertTo-Json -Compress'
  ].join('; ');

  const output = execFileSync('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script
  ], { cwd: root, encoding: 'utf8' });

  return JSON.parse(output.trim());
}

test('owned minimized Chrome keeps DOM watcher timers running in the background', () => {
  const args = ownedChromeArguments();

  assert.ok(args.includes('--disable-background-timer-throttling'));
  assert.ok(args.includes('--disable-backgrounding-occluded-windows'));
  assert.ok(args.includes('--disable-renderer-backgrounding'));
});

test('owned Chrome uses a relaunch-stable profile path as its ownership marker', () => {
  for (const relativePath of [
    ['scripts', 'windows', 'KakaoStaging.Common.psm1'],
    ['scripts', 'windows', 'start-kakao-staging.ps1']
  ]) {
    const source = fs.readFileSync(path.join(root, ...relativePath), 'utf8');
    assert.match(source, /\$chromeCommandMarker\s*=\s*\$chromeProfilePath/);
    assert.doesNotMatch(
      source,
      /\$chromeCommandMarker\s*=\s*ConvertTo-WindowsCommandLineArgument\s+-Value\s+\$chromeProfileArgument/,
      'Chromium may normalize --user-data-dir quoting after a self-relaunch'
    );
  }
});
