import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  buildWindowsStagingConfig,
  parseEnvText,
  redactWindowsStagingConfig,
  validateWindowsStagingConfig
} from '../scripts/windows/windows-runtime-config.mjs';

const testDirectory = dirname(fileURLToPath(import.meta.url));
const cliPath = join(testDirectory, '..', 'scripts', 'windows', 'windows-runtime-config.mjs');

const requiredValues = {
  SUPABASE_URL: 'https://example.invalid',
  SUPABASE_SERVICE_ROLE_KEY: 'synthetic-key',
  SUPABASE_TABLE: 'ai_processing_events_windows_staging',
  SUPABASE_FOLLOW_UP_TABLE: 'ai_follow_up_items_windows_staging',
  HERMES_WORKER_COMMAND: 'synthetic-command',
  HERMES_WORKER_PROFILE: 'kakaoworker',
  VILLAGE_AI_WORKER_CMD:
    '"C:\\Program Files\\nodejs\\node.exe" C:\\Village\\scripts\\windows\\windows-ai-worker.mjs',
  BLUEBUBBLES_SERVER_URL: 'https://bluebubbles.example.invalid',
  BLUEBUBBLES_PASSWORD: 'synthetic-password'
};

test('parseEnvText parses values after the first equals sign', () => {
  const raw = parseEnvText(
    'SUPABASE_URL=https://example.invalid\nSUPABASE_SERVICE_ROLE_KEY=secret=with=remainder\n'
  );

  assert.equal(raw.SUPABASE_SERVICE_ROLE_KEY, 'secret=with=remainder');
});

test('parseEnvText ignores blank and comment lines', () => {
  const raw = parseEnvText('\n# comment\n  # indented comment\nPORT=8787\n');

  assert.deepEqual(raw, { PORT: '8787' });
});

test('parseEnvText rejects malformed non-comment lines', () => {
  assert.throws(() => parseEnvText('PORT=8787\nMALFORMED\n'), /line 2/i);
});

test('buildWindowsStagingConfig applies write-safe staging defaults', () => {
  const staging = buildWindowsStagingConfig({
    AI_WORKER_LIVE: '1',
    AI_WORKER_AUTO_SEND: 'true',
    SLACK_ACTION_POLL_ENABLED: 'true',
    SLACK_AGENT_CARD_DELIVERY_ENABLED: 'true',
    KAKAO_TAB_CLEANUP_ENABLED: 'true'
  });

  assert.equal(staging.AI_WORKER_LIVE, '0');
  assert.equal(staging.AI_WORKER_AUTO_SEND, '0');
  assert.equal(staging.SLACK_ACTION_POLL_ENABLED, '0');
  assert.equal(staging.SLACK_AGENT_CARD_DELIVERY_ENABLED, '0');
  assert.equal(staging.KAKAO_TAB_CLEANUP_ENABLED, '1');
  assert.equal(staging.KAKAO_WORKER_CONTROL_MODE, 'devtools_first');
  assert.equal(staging.KAKAO_WORKER_SEARCH_TARGET_CHAT, '1');
  assert.equal(staging.KAKAO_APPLESCRIPT_FALLBACK, '0');
  assert.equal(staging.AI_WORKER_DRY_RUN, '1');
  assert.equal(staging.VILLAGE_WINDOWS_WRITES_ENABLED, '0');
  assert.equal(staging.KAKAO_REMOTE_DEBUGGING_PORT, '9223');
  assert.equal(staging.PORT, '8787');
});

test('buildWindowsStagingConfig forces the exact staging ports after conflicting input', () => {
  const staging = buildWindowsStagingConfig({
    PORT: '9999',
    KAKAO_REMOTE_DEBUGGING_PORT: '9333'
  });

  assert.equal(staging.PORT, '8787');
  assert.equal(staging.KAKAO_REMOTE_DEBUGGING_PORT, '9223');
});

test('buildWindowsStagingConfig does not treat a string false as write enablement', () => {
  const staging = buildWindowsStagingConfig(
    {
      PORT: '9999',
      AI_WORKER_LIVE: '1',
      AI_WORKER_AUTO_SEND: 'true'
    },
    { enableWrites: 'false' }
  );

  assert.equal(staging.AI_WORKER_LIVE, '0');
  assert.equal(staging.AI_WORKER_AUTO_SEND, '0');
  assert.equal(staging.PORT, '8787');
});

test('buildWindowsStagingConfig normalizes explicitly enabled write booleans to 1 or 0', () => {
  const staging = buildWindowsStagingConfig(
    {
      AI_WORKER_LIVE: '1',
      AI_WORKER_AUTO_SEND: 'true',
      SLACK_ACTION_POLL_ENABLED: true,
      SLACK_AGENT_CARD_DELIVERY_ENABLED: 'false',
      KAKAO_TAB_CLEANUP_ENABLED: '0',
      KAKAO_APPLESCRIPT_FALLBACK: false,
      AI_WORKER_DRY_RUN: 'false',
      VILLAGE_WINDOWS_WRITES_ENABLED: 'not-an-operator-setting'
    },
    { enableWrites: true }
  );

  assert.equal(staging.AI_WORKER_LIVE, '1');
  assert.equal(staging.AI_WORKER_AUTO_SEND, '1');
  assert.equal(staging.SLACK_ACTION_POLL_ENABLED, '1');
  assert.equal(staging.SLACK_AGENT_CARD_DELIVERY_ENABLED, '0');
  assert.equal(staging.KAKAO_TAB_CLEANUP_ENABLED, '0');
  assert.equal(staging.KAKAO_APPLESCRIPT_FALLBACK, '0');
  assert.equal(staging.AI_WORKER_DRY_RUN, '0');
  assert.equal(staging.VILLAGE_WINDOWS_WRITES_ENABLED, '1');
});

test('buildWindowsStagingConfig rejects invalid write-enabled booleans by setting name', () => {
  assert.throws(
    () =>
      buildWindowsStagingConfig(
        {
          AI_WORKER_LIVE: 'sometimes'
        },
        { enableWrites: true }
      ),
    /AI_WORKER_LIVE/
  );
});

test('validateWindowsStagingConfig requires base settings', () => {
  const validation = validateWindowsStagingConfig({});

  assert.equal(validation.valid, false);
  assert.deepEqual(validation.missing, [
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'SUPABASE_TABLE',
    'SUPABASE_FOLLOW_UP_TABLE',
    'HERMES_WORKER_COMMAND',
    'HERMES_WORKER_PROFILE',
    'VILLAGE_AI_WORKER_CMD',
    'BLUEBUBBLES_SERVER_URL',
    'BLUEBUBBLES_PASSWORD'
  ]);
  assert.deepEqual(validation.invalid, []);
});

test('validateWindowsStagingConfig enforces staging-only queue tables in safe mode', () => {
  const productionQueue = validateWindowsStagingConfig({
    ...requiredValues,
    SUPABASE_TABLE: 'ai_processing_events'
  });
  const writeEnabled = validateWindowsStagingConfig(
    {
      ...requiredValues,
      SUPABASE_TABLE: 'ai_processing_events'
    },
    { enableWrites: true }
  );

  assert.deepEqual(productionQueue.invalid, ['SUPABASE_TABLE']);
  assert.deepEqual(writeEnabled, { valid: true, missing: [], invalid: [] });
});

test('validateWindowsStagingConfig unconditionally requires an isolated follow-up table', () => {
  const { SUPABASE_FOLLOW_UP_TABLE: omitted, ...withoutFollowUpTable } = requiredValues;
  const missing = validateWindowsStagingConfig(withoutFollowUpTable);
  const production = validateWindowsStagingConfig({
    ...requiredValues,
    SUPABASE_FOLLOW_UP_TABLE: 'ai_follow_up_items'
  });
  const writeEnabled = validateWindowsStagingConfig(
    {
      ...requiredValues,
      SUPABASE_FOLLOW_UP_TABLE: 'ai_follow_up_items'
    },
    { enableWrites: true }
  );

  assert.equal(omitted, 'ai_follow_up_items_windows_staging');
  assert.deepEqual(missing.missing, ['SUPABASE_FOLLOW_UP_TABLE']);
  assert.deepEqual(production.invalid, ['SUPABASE_FOLLOW_UP_TABLE']);
  assert.deepEqual(writeEnabled, { valid: true, missing: [], invalid: [] });
});

test('validateWindowsStagingConfig requires the reviewed Windows worker wrapper', () => {
  const shell = validateWindowsStagingConfig({
    ...requiredValues,
    VILLAGE_AI_WORKER_CMD: 'bash tools/ai-browser-worker/run.sh'
  });
  const directWorker = validateWindowsStagingConfig({
    ...requiredValues,
    VILLAGE_AI_WORKER_CMD:
      '"C:\\Program Files\\nodejs\\node.exe" C:\\Village\\tools\\ai-browser-worker\\worker.mjs'
  });

  assert.deepEqual(shell.invalid, ['VILLAGE_AI_WORKER_CMD']);
  assert.deepEqual(directWorker.invalid, ['VILLAGE_AI_WORKER_CMD']);
  assert.deepEqual(validateWindowsStagingConfig(requiredValues), {
    valid: true,
    missing: [],
    invalid: []
  });
});

test('redactWindowsStagingConfig reveals only explicitly allowlisted operational settings', () => {
  const redacted = redactWindowsStagingConfig({
    SUPABASE_SERVICE_ROLE_KEY: 'secret',
    BLUEBUBBLES_PASSWORD: 'secret',
    SUPABASE_URL: 'https://example.invalid',
    HERMES_WORKER_COMMAND: 'secret-command',
    CONFIG_PATH: 'secret-path',
    ACCESS_TOKEN: '',
    BLUEBUBBLES_WEBHOOK_HOST: 'private-connector-host',
    CUSTOM_CONNECTOR_SETTING: 'unknown-connector-value',
    PORT: '8787'
  });

  assert.equal(redacted.SUPABASE_SERVICE_ROLE_KEY, '[set]');
  assert.equal(redacted.BLUEBUBBLES_PASSWORD, '[set]');
  assert.equal(redacted.SUPABASE_URL, '[set]');
  assert.equal(redacted.HERMES_WORKER_COMMAND, '[set]');
  assert.equal(redacted.CONFIG_PATH, '[set]');
  assert.equal(redacted.ACCESS_TOKEN, '[unset]');
  assert.equal(redacted.BLUEBUBBLES_WEBHOOK_HOST, '[set]');
  assert.equal(redacted.CUSTOM_CONNECTOR_SETTING, '[set]');
  assert.equal(redacted.PORT, '8787');
  assert.doesNotMatch(
    JSON.stringify(redacted),
    /secret|example\.invalid|private-connector-host|unknown-connector-value/
  );
});

test('CLI reads the explicit env path and prints only redacted JSON', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'windows-runtime-config-'));
  const envPath = join(directory, 'staging.env');

  try {
    await writeFile(
      envPath,
      Object.entries(requiredValues)
        .map(([name, value]) => `${name}=${value}`)
        .join('\n') + '\n',
      'utf8'
    );

    const result = spawnSync(process.execPath, [cliPath, '--env', envPath], {
      encoding: 'utf8'
    });
    const output = JSON.parse(result.stdout);

    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.equal(output.valid, true);
    assert.deepEqual(output.missing, []);
    assert.equal(output.SUPABASE_URL, '[set]');
    assert.equal(output.SUPABASE_SERVICE_ROLE_KEY, '[set]');
    assert.equal(output.HERMES_WORKER_COMMAND, '[set]');
    assert.equal(output.VILLAGE_AI_WORKER_CMD, '[set]');
    assert.doesNotMatch(result.stdout, /synthetic|example\.invalid/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI accepts only a reviewed lifecycle-supplied worker command override', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'windows-runtime-config-'));
  const envPath = join(directory, 'staging.env');
  const { VILLAGE_AI_WORKER_CMD: omitted, ...valuesWithoutWorkerCommand } = requiredValues;

  try {
    await writeFile(
      envPath,
      Object.entries(valuesWithoutWorkerCommand)
        .map(([name, value]) => `${name}=${value}`)
        .join('\n') + '\n',
      'utf8'
    );

    const reviewedCommand =
      '"C:\\Program Files\\nodejs\\node.exe" C:\\Village\\scripts\\windows\\windows-ai-worker.mjs';
    const reviewed = spawnSync(
      process.execPath,
      [cliPath, '--env', envPath, '--worker-command', reviewedCommand],
      { encoding: 'utf8' }
    );
    const unreviewed = spawnSync(
      process.execPath,
      [cliPath, '--env', envPath, '--worker-command', 'C:\\Village\\worker.cmd'],
      { encoding: 'utf8' }
    );

    assert.ok(omitted);
    assert.equal(reviewed.status, 0);
    assert.equal(JSON.parse(reviewed.stdout).valid, true);
    assert.equal(unreviewed.status, 2);
    assert.deepEqual(JSON.parse(unreviewed.stdout).invalid, ['VILLAGE_AI_WORKER_CMD']);
    assert.doesNotMatch(reviewed.stdout + unreviewed.stdout, /Program Files|Village\\worker/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI rejects invalid write-enabled booleans without echoing their values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'windows-runtime-config-'));
  const envPath = join(directory, 'staging.env');

  try {
    await writeFile(
      envPath,
      Object.entries({
        ...requiredValues,
        SUPABASE_TABLE: 'ai_processing_events',
        AI_WORKER_LIVE: 'definitely-not-a-boolean'
      })
        .map(([name, value]) => `${name}=${value}`)
        .join('\n') + '\n',
      'utf8'
    );

    const result = spawnSync(
      process.execPath,
      [cliPath, '--env', envPath, '--enable-writes'],
      { encoding: 'utf8' }
    );
    const output = JSON.parse(result.stdout);

    assert.equal(result.status, 2);
    assert.equal(output.valid, false);
    assert.deepEqual(output.invalid, ['AI_WORKER_LIVE']);
    assert.doesNotMatch(result.stdout + result.stderr, /definitely-not-a-boolean/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI exits 2 when required settings are missing', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'windows-runtime-config-'));
  const envPath = join(directory, 'staging.env');

  try {
    await writeFile(envPath, 'PORT=8787\n', 'utf8');

    const result = spawnSync(process.execPath, [cliPath, '--env', envPath], {
      encoding: 'utf8'
    });
    const output = JSON.parse(result.stdout);

    assert.equal(result.status, 2);
    assert.equal(output.valid, false);
    assert.ok(output.missing.includes('SUPABASE_URL'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('CLI exits 1 for unexpected argument errors without leaking the raw argument', () => {
  const result = spawnSync(process.execPath, [cliPath, '--unexpected', 'secret-path'], {
    encoding: 'utf8'
  });
  const output = JSON.parse(result.stdout);

  assert.equal(result.status, 1);
  assert.equal(output.valid, false);
  assert.equal(output.error, 'unexpected error');
  assert.doesNotMatch(result.stdout + result.stderr, /secret-path/);
});

test('CLI exits 2 when --env has no operand', () => {
  const result = spawnSync(process.execPath, [cliPath, '--env'], {
    encoding: 'utf8'
  });
  const output = JSON.parse(result.stdout);

  assert.equal(result.status, 2);
  assert.equal(output.valid, false);
  assert.deepEqual(output.missing, ['--env']);
});

test('CLI exits 2 when another flag follows --env', () => {
  const result = spawnSync(process.execPath, [cliPath, '--env', '--enable-writes'], {
    encoding: 'utf8'
  });
  const output = JSON.parse(result.stdout);

  assert.equal(result.status, 2);
  assert.equal(output.valid, false);
  assert.deepEqual(output.missing, ['--env']);
});
