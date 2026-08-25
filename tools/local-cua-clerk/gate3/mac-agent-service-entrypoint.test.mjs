import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

let serviceModule = {};
try {
  serviceModule = await import('./mac-agent-service-entrypoint.mjs');
} catch {
  // RED phase: the production module does not exist yet.
}

const startService = options => typeof serviceModule.startMacAgentService === 'function'
  ? serviceModule.startMacAgentService(options)
  : Promise.reject(new Error('service entrypoint missing'));

function validEnvironment(ledgerDir) {
  return [
    'LOCAL_CUA_SLACK_APP_TOKEN=xapp-file-token-0123456789',
    'LOCAL_CUA_SLACK_BOT_TOKEN=xoxb-file-token-0123456789',
    'LOCAL_CUA_SLACK_TEAM_ID=T0123456789',
    'LOCAL_CUA_SLACK_CHANNEL_ID=C0123456789',
    'LOCAL_CUA_SLACK_APP_ID=A0123456789',
    'LOCAL_CUA_SLACK_BOT_USER_ID=U0123456789',
    'LOCAL_CUA_SLACK_ALLOWED_USER_ID=U9876543210',
    `LOCAL_CUA_LEDGER_DIR=${ledgerDir}`,
    '',
  ].join('\n');
}

function passingIdentity() {
  return Object.freeze({
    schemaVersion: 'gate3-slack-identity/v1',
    status: 'PASS',
    evidence: Object.freeze({
      authenticated: true,
      teamMatched: true,
      botUserMatched: true,
      botIdentityPresent: true,
    }),
  });
}

test('every service start reloads the private file, ignores ambient Slack values, and removes readiness on stop', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mac-agent-service-test-'));
  const appRoot = join(root, 'village-local-cua-clerk');
  const ledgerDir = join(appRoot, 'ledger');
  const envFile = join(appRoot, 'slack.env');
  const readyFile = join(appRoot, 'runtime-ready.json');
  const runId = '4c5280bb-606a-45ad-a9f7-c23c970ef5e7';
  await mkdir(ledgerDir, { recursive: true, mode: 0o700 });
  await chmod(appRoot, 0o700);
  await chmod(ledgerDir, 0o700);
  await writeFile(envFile, validEnvironment(ledgerDir), { mode: 0o600 });
  const originalAmbient = process.env.LOCAL_CUA_SLACK_TEAM_ID;
  process.env.LOCAL_CUA_SLACK_TEAM_ID = 'TAMBIENT99';
  let receivedEnv;
  let stopCalls = 0;
  try {
    const service = await startService({
      envFile,
      readyFile,
      runId,
      uid: process.getuid(),
      connectorStarter: async ({ env }) => {
        receivedEnv = env;
        return {
          identity: passingIdentity(),
          stop: async () => { stopCalls += 1; },
        };
      },
      allowTestOverrides: true,
    });

    assert.equal(receivedEnv.LOCAL_CUA_SLACK_TEAM_ID, 'T0123456789');
    assert.notEqual(receivedEnv.LOCAL_CUA_SLACK_TEAM_ID, process.env.LOCAL_CUA_SLACK_TEAM_ID);
    const readinessText = await readFile(readyFile, 'utf8');
    assert.deepEqual(JSON.parse(readinessText), {
      schemaVersion: 'mac-agent-runtime-ready/v1',
      runId,
      status: 'PASS',
      evidence: {
        authenticated: true,
        teamMatched: true,
        botUserMatched: true,
        botIdentityPresent: true,
      },
    });
    assert.doesNotMatch(readinessText, /xapp-|xoxb-/);
    assert.equal((await lstat(readyFile)).mode & 0o777, 0o600);

    await service.stop();
    await service.stop();
    assert.equal(stopCalls, 1);
    await assert.rejects(() => lstat(readyFile), error => error?.code === 'ENOENT');
  } finally {
    if (originalAmbient === undefined) delete process.env.LOCAL_CUA_SLACK_TEAM_ID;
    else process.env.LOCAL_CUA_SLACK_TEAM_ID = originalAmbient;
    await rm(root, { recursive: true, force: true });
  }
});

test('service restart rejects a secret file that is no longer mode 0600 before starting Slack', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mac-agent-service-test-'));
  const appRoot = join(root, 'village-local-cua-clerk');
  const ledgerDir = join(appRoot, 'ledger');
  const envFile = join(appRoot, 'slack.env');
  const readyFile = join(appRoot, 'runtime-ready.json');
  await mkdir(ledgerDir, { recursive: true, mode: 0o700 });
  await chmod(appRoot, 0o700);
  await chmod(ledgerDir, 0o700);
  await writeFile(envFile, validEnvironment(ledgerDir), { mode: 0o600 });
  await chmod(envFile, 0o644);
  let starts = 0;
  try {
    await assert.rejects(
      () => startService({
        envFile,
        readyFile,
        runId: '4c5280bb-606a-45ad-a9f7-c23c970ef5e7',
        uid: process.getuid(),
        connectorStarter: async () => {
          starts += 1;
          return { identity: passingIdentity(), stop: async () => {} };
        },
        allowTestOverrides: true,
      }),
      /private regular file/,
    );
    assert.equal(starts, 0);
    await assert.rejects(() => lstat(readyFile), error => error?.code === 'ENOENT');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
