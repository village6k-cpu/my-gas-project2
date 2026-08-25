import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

let launcher = {};
try {
  launcher = await import('./mac-agent-launcher.mjs');
} catch {
  // RED phase: the production module does not exist yet.
}

const install = options => typeof launcher.installMacAgentLaunchAgent === 'function'
  ? launcher.installMacAgentLaunchAgent(options)
  : Promise.reject(new Error('install function missing'));

test('the persistent service plist exposes no token and starts only the pinned MacAgent entrypoint', () => {
  const runId = '4c5280bb-606a-45ad-a9f7-c23c970ef5e7';
  const plist = typeof launcher.makeMacAgentLaunchAgentPlist === 'function'
    ? launcher.makeMacAgentLaunchAgentPlist({
        nodePath: '/opt/node',
        entrypointPath: '/repo/mac-agent-service-entrypoint.mjs',
        runnerPath: '/repo/socket-mode-runner.mjs',
        envFile: '/Users/test/Application Support/mac-agent.env',
        readyPath: '/Users/test/Application Support/runtime-ready.json',
        workingDirectory: '/repo',
        stdoutPath: '/Users/test/Logs/mac-agent.out.log',
        stderrPath: '/Users/test/Logs/mac-agent.err.log',
        runId,
        allowTestOverrides: true,
      })
    : '';

  assert.match(plist, /<key>Label<\/key>\s*<string>com\.village\.mac-agent<\/string>/);
  assert.match(plist, /<string>\/opt\/node<\/string>/);
  assert.match(plist, /<string>\/repo\/mac-agent-service-entrypoint\.mjs<\/string>/);
  assert.match(plist, /<string>--env-file=\/Users\/test\/Application Support\/mac-agent\.env<\/string>/);
  assert.match(plist, /<string>--ready-file=\/Users\/test\/Application Support\/runtime-ready\.json<\/string>/);
  assert.match(plist, new RegExp(`<string>--run-id=${runId}<\\/string>`));
  assert.doesNotMatch(plist, /<string>\/repo\/socket-mode-runner\.mjs<\/string>/);
  assert.ok(
    plist.indexOf('/repo/mac-agent-service-entrypoint.mjs')
      < plist.indexOf('--env-file=/Users/test/Application Support/mac-agent.env'),
  );
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key>\s*<integer>30<\/integer>/);
  assert.match(plist, /<key>LimitLoadToSessionType<\/key>\s*<string>Aqua<\/string>/);
  assert.match(plist, /<key>Umask<\/key>\s*<integer>63<\/integer>/);
  assert.doesNotMatch(plist, /xapp-|xoxb-|LOCAL_CUA_SLACK_(?:APP|BOT)_TOKEN/);
});

function validEnvironment(ledgerDir) {
  return [
    'LOCAL_CUA_SLACK_APP_TOKEN=xapp-test-token-0123456789',
    'LOCAL_CUA_SLACK_BOT_TOKEN=xoxb-test-token-0123456789',
    'LOCAL_CUA_SLACK_TEAM_ID=T0123456789',
    'LOCAL_CUA_SLACK_CHANNEL_ID=C0123456789',
    'LOCAL_CUA_SLACK_APP_ID=A0123456789',
    'LOCAL_CUA_SLACK_BOT_USER_ID=U0123456789',
    'LOCAL_CUA_SLACK_ALLOWED_USER_ID=U9876543210',
    `LOCAL_CUA_LEDGER_DIR=${ledgerDir}`,
    '',
  ].join('\n');
}

async function testPaths(root) {
  const appRoot = join(root, 'village-local-cua-clerk');
  const ledgerDir = join(appRoot, 'ledger');
  const envFile = join(appRoot, 'slack.env');
  const plistPath = join(root, 'LaunchAgents', 'com.village.mac-agent.plist');
  const logsDir = join(root, 'Logs', 'MacAgent');
  await mkdir(ledgerDir, { recursive: true, mode: 0o700 });
  await chmod(appRoot, 0o700);
  await chmod(ledgerDir, 0o700);
  await writeFile(envFile, validEnvironment(ledgerDir), { mode: 0o600 });
  return {
    nodePath: process.execPath,
    entrypointPath: fileURLToPath(new URL('./mac-agent-service-entrypoint.mjs', import.meta.url)),
    runnerPath: fileURLToPath(new URL('./socket-mode-runner.mjs', import.meta.url)),
    envFile,
    readyPath: join(appRoot, 'runtime-ready.json'),
    workingDirectory: dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
    stdoutPath: join(logsDir, 'stdout.log'),
    stderrPath: join(logsDir, 'stderr.log'),
    plistPath,
  };
}

test('install writes a private plist and bootstraps only the exact MacAgent label', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mac-agent-launcher-test-'));
  try {
    const paths = await testPaths(root);
    const uid = process.getuid();
    const calls = [];
    let bootstrapped = false;
    let preBootstrapPrints = 0;
    const commandRunner = async (file, args) => {
      calls.push([file, args]);
      if (file === '/bin/launchctl' && args[0] === 'bootout') {
        throw Object.assign(new Error('not loaded'), { code: 3 });
      }
      if (file === '/bin/launchctl' && args[0] === 'print' && !bootstrapped) {
        preBootstrapPrints += 1;
        if (preBootstrapPrints >= 3) {
          throw Object.assign(new Error('not found'), { code: 113 });
        }
        return;
      }
      if (file === '/bin/launchctl' && args[0] === 'bootstrap') {
        bootstrapped = true;
        const plist = await readFile(paths.plistPath, 'utf8');
        const runId = plist.match(/<string>--run-id=([^<]+)<\/string>/)?.[1];
        assert.match(runId ?? '', /^[0-9a-f-]{36}$/);
        await writeFile(paths.readyPath, `${JSON.stringify({
          schemaVersion: 'mac-agent-runtime-ready/v1',
          runId,
          status: 'PASS',
          evidence: {
            authenticated: true,
            teamMatched: true,
            botUserMatched: true,
            botIdentityPresent: true,
          },
        })}\n`, { mode: 0o600 });
      }
    };

    const result = await install({
      paths,
      uid,
      commandRunner,
      allowTestOverrides: true,
    });

    assert.deepEqual(result, {
      label: 'com.village.mac-agent',
      serviceTarget: `gui/${uid}/com.village.mac-agent`,
      status: 'RUNNING',
    });
    const plist = await readFile(paths.plistPath, 'utf8');
    assert.match(plist, /<string>com\.village\.mac-agent<\/string>/);
    assert.doesNotMatch(plist, /xapp-|xoxb-/);
    assert.equal((await lstat(paths.plistPath)).mode & 0o777, 0o600);
    assert.equal((await lstat(paths.readyPath)).mode & 0o777, 0o600);
    assert.deepEqual(calls, [
      ['/usr/bin/plutil', ['-lint', paths.plistPath]],
      ['/bin/launchctl', ['bootout', `gui/${uid}/com.village.mac-agent`]],
      ['/bin/launchctl', ['print', `gui/${uid}/com.village.mac-agent`]],
      ['/bin/launchctl', ['print', `gui/${uid}/com.village.mac-agent`]],
      ['/bin/launchctl', ['print', `gui/${uid}/com.village.mac-agent`]],
      ['/bin/launchctl', ['bootstrap', `gui/${uid}`, paths.plistPath]],
      ['/bin/launchctl', ['print', `gui/${uid}/com.village.mac-agent`]],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('install rejects a registered service that never proves runtime readiness and boots out only its exact label', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mac-agent-launcher-test-'));
  try {
    const paths = await testPaths(root);
    const calls = [];
    let bootstrapped = false;
    const commandRunner = async (file, args) => {
      calls.push([file, args]);
      if (file === '/bin/launchctl' && args[0] === 'bootout' && !bootstrapped) {
        throw Object.assign(new Error('not loaded'), { code: 3 });
      }
      if (file === '/bin/launchctl' && args[0] === 'print' && !bootstrapped) {
        throw Object.assign(new Error('not found'), { code: 113 });
      }
      if (file === '/bin/launchctl' && args[0] === 'bootstrap') bootstrapped = true;
    };

    await assert.rejects(
      () => install({
        paths,
        uid: process.getuid(),
        commandRunner,
        readinessTimeoutMs: 20,
        readinessPollMs: 1,
        allowTestOverrides: true,
      }),
      /runtime readiness/,
    );
    const bootouts = calls.filter(([file, args]) => file === '/bin/launchctl' && args[0] === 'bootout');
    assert.deepEqual(bootouts, [
      ['/bin/launchctl', ['bootout', `gui/${process.getuid()}/com.village.mac-agent`]],
      ['/bin/launchctl', ['bootout', `gui/${process.getuid()}/com.village.mac-agent`]],
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('install rejects broad or symlinked secret files before running launchctl', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mac-agent-launcher-test-'));
  try {
    const paths = await testPaths(root);
    const calls = [];
    await chmod(paths.envFile, 0o644);
    await assert.rejects(
      () => install({
        paths,
        uid: process.getuid(),
        commandRunner: async (...args) => calls.push(args),
        allowTestOverrides: true,
      }),
      /private regular file/,
    );
    assert.equal(calls.length, 0);

    const realEnv = `${paths.envFile}.real`;
    await chmod(paths.envFile, 0o600);
    await writeFile(realEnv, await readFile(paths.envFile), { mode: 0o600 });
    await rm(paths.envFile);
    await symlink(realEnv, paths.envFile);
    await assert.rejects(
      () => install({
        paths,
        uid: process.getuid(),
        commandRunner: async (...args) => calls.push(args),
        allowTestOverrides: true,
      }),
      /private regular file/,
    );
    assert.equal(calls.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
