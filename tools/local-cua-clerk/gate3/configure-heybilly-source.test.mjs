import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

async function loadConfigurator() {
  try { return await import('./configure-heybilly-source.mjs'); }
  catch { return null; }
}

test('the private MacAgent env gains only the fixed HeyBilly identity and is idempotent', async t => {
  const configurator = await loadConfigurator();
  assert.equal(typeof configurator?.configureHeyBillySource, 'function');
  const root = await mkdtemp(join(tmpdir(), 'mac-agent-config-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const appRoot = join(root, 'village-local-cua-clerk');
  const ledgerDir = join(appRoot, 'ledger');
  const envFile = join(appRoot, 'slack.env');
  await mkdir(ledgerDir, { recursive: true, mode: 0o700 });
  await chmod(appRoot, 0o700);
  await chmod(ledgerDir, 0o700);
  await writeFile(envFile, [
    'LOCAL_CUA_SLACK_APP_TOKEN="xapp-1-private-test-token"',
    'LOCAL_CUA_SLACK_BOT_TOKEN="xoxb-private-test-token"',
    'LOCAL_CUA_SLACK_TEAM_ID="T03EB8LSB18"',
    'LOCAL_CUA_SLACK_CHANNEL_ID="C0B7CLP4KDY"',
    'LOCAL_CUA_SLACK_APP_ID="A0LOCALCUA01"',
    'LOCAL_CUA_SLACK_BOT_USER_ID="U0LOCALCUA01"',
    'LOCAL_CUA_SLACK_ALLOWED_USER_ID="U03EB8L0QDR"',
    `LOCAL_CUA_LEDGER_DIR=${JSON.stringify(ledgerDir)}`,
    '',
  ].join('\n'), { mode: 0o600 });

  const input = {
    envFile,
    uid: process.getuid(),
    source: { userId: 'U0B66DNKXRU', botId: 'B0B68FQLVS6' },
    allowTestOverrides: true,
  };
  const first = await configurator.configureHeyBillySource(input);
  assert.deepEqual(first, { status: 'UPDATED' });
  const raw = await readFile(envFile, 'utf8');
  const parsed = parseEnv(raw);
  assert.equal(parsed.LOCAL_CUA_SLACK_HEYBILLY_USER_ID, 'U0B66DNKXRU');
  assert.equal(parsed.LOCAL_CUA_SLACK_HEYBILLY_BOT_ID, 'B0B68FQLVS6');
  assert.equal(parsed.LOCAL_CUA_SLACK_APP_TOKEN, 'xapp-1-private-test-token');
  assert.equal(parsed.LOCAL_CUA_SLACK_BOT_TOKEN, 'xoxb-private-test-token');
  assert.equal((await stat(envFile)).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(first).includes('token'), false);

  assert.deepEqual(await configurator.configureHeyBillySource(input), { status: 'UNCHANGED' });
  assert.equal(await readFile(envFile, 'utf8'), raw);
});

