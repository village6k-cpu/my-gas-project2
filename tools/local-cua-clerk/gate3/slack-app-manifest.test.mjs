import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('the install manifest creates a distinct mention-only Socket Mode bot with the minimum scopes', async () => {
  const manifest = JSON.parse(await readFile(new URL('./slack-app-manifest.json', import.meta.url), 'utf8'));

  assert.equal(manifest._metadata.major_version, 1);
  assert.equal(manifest.display_information.name, '빌리지 세무·서류 담당');
  assert.equal(manifest.features.bot_user.display_name, '세무·서류 담당');
  assert.equal(manifest.features.bot_user.always_online, false);
  assert.deepEqual(manifest.oauth_config.scopes.bot, [
    'app_mentions:read',
    'channels:history',
    'chat:write',
  ]);
  assert.deepEqual(manifest.settings.event_subscriptions.bot_events, ['app_mention']);
  assert.equal(manifest.settings.socket_mode_enabled, true);
  assert.equal(manifest.settings.org_deploy_enabled, false);
  assert.equal(manifest.settings.token_rotation_enabled, false);
  assert.equal(manifest.features.slash_commands, undefined);
  assert.equal(manifest.oauth_config.redirect_urls, undefined);

  const serialized = JSON.stringify(manifest);
  for (const forbidden of [
    'admin.',
    'users:read',
    'files:write',
    'im:history',
    'groups:history',
    'channels:read',
    'commands',
    'incoming-webhook',
  ]) {
    assert.equal(serialized.includes(forbidden), false);
  }
});

test('the declared Node floor satisfies the locked Slack runtime dependency floor', async () => {
  const packageJson = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));
  const packageLock = JSON.parse(await readFile(new URL('./package-lock.json', import.meta.url), 'utf8'));

  assert.equal(packageJson.engines.node, '>=20.18.1');
  assert.equal(packageLock.packages[''].engines.node, '>=20.18.1');
  assert.equal(packageLock.packages['node_modules/undici'].engines.node, '>=20.18.1');
});
