import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const REQUIRED_SETTINGS = [
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_TABLE',
  'SUPABASE_FOLLOW_UP_TABLE',
  'HERMES_WORKER_COMMAND',
  'HERMES_WORKER_PROFILE',
  'VILLAGE_AI_WORKER_CMD',
  'BLUEBUBBLES_SERVER_URL',
  'BLUEBUBBLES_PASSWORD'
];

const BOOLEAN_SETTINGS = [
  'AI_WORKER_LIVE',
  'AI_WORKER_AUTO_SEND',
  'SLACK_ACTION_POLL_ENABLED',
  'SLACK_AGENT_CARD_DELIVERY_ENABLED',
  'KAKAO_TAB_CLEANUP_ENABLED',
  'KAKAO_WORKER_SEARCH_TARGET_CHAT',
  'KAKAO_APPLESCRIPT_FALLBACK',
  'AI_WORKER_DRY_RUN'
];

const SAFE_DEFAULTS = {
  PORT: '8787',
  KAKAO_REMOTE_DEBUGGING_PORT: '9223',
  AI_WORKER_LIVE: '0',
  AI_WORKER_AUTO_SEND: '0',
  SLACK_ACTION_POLL_ENABLED: '0',
  SLACK_AGENT_CARD_DELIVERY_ENABLED: '0',
  KAKAO_TAB_CLEANUP_ENABLED: '1',
  KAKAO_WORKER_CONTROL_MODE: 'devtools_first',
  KAKAO_WORKER_SEARCH_TARGET_CHAT: '1',
  KAKAO_APPLESCRIPT_FALLBACK: '0',
  AI_WORKER_DRY_RUN: '1',
  VILLAGE_WINDOWS_WRITES_ENABLED: '0'
};

const SAFE_OUTPUT_SETTING_NAMES = new Set([
  'PORT',
  'KAKAO_REMOTE_DEBUGGING_PORT',
  'AI_WORKER_LIVE',
  'AI_WORKER_AUTO_SEND',
  'SLACK_ACTION_POLL_ENABLED',
  'SLACK_AGENT_CARD_DELIVERY_ENABLED',
  'KAKAO_TAB_CLEANUP_ENABLED',
  'KAKAO_WORKER_CONTROL_MODE',
  'KAKAO_WORKER_SEARCH_TARGET_CHAT',
  'KAKAO_APPLESCRIPT_FALLBACK',
  'AI_WORKER_DRY_RUN',
  'VILLAGE_WINDOWS_WRITES_ENABLED'
]);

class InvalidBooleanSettingError extends Error {
  constructor(name) {
    super(`Invalid boolean setting: ${name}`);
    this.invalid = [name];
  }
}

export function parseEnvText(text) {
  const values = {};

  for (const [index, line] of String(text).split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;

    const separator = line.indexOf('=');
    const name = separator === -1 ? '' : line.slice(0, separator).trim();
    if (separator === -1 || name === '') {
      throw new Error(`Malformed env line ${index + 1}`);
    }

    values[name] = line.slice(separator + 1);
  }

  return values;
}

export function buildWindowsStagingConfig(values, { enableWrites = false } = {}) {
  const suppliedConfig = { ...SAFE_DEFAULTS, ...values };
  const config = enableWrites === true ? suppliedConfig : { ...suppliedConfig, ...SAFE_DEFAULTS };

  for (const name of BOOLEAN_SETTINGS) {
    const normalized = normalizeBooleanSetting(config[name]);
    if (normalized === null) throw new InvalidBooleanSettingError(name);
    config[name] = normalized;
  }
  config.VILLAGE_WINDOWS_WRITES_ENABLED = enableWrites === true ? '1' : '0';

  return config;
}

export function validateWindowsStagingConfig(config, { enableWrites = false } = {}) {
  const required = [...REQUIRED_SETTINGS];

  const missing = required.filter((name) => {
    const value = config[name];
    return value === undefined || value === null || String(value).trim() === '';
  });

  const invalid = [];
  if (
    !missing.includes('VILLAGE_AI_WORKER_CMD') &&
    !isWindowsNativeWorkerCommand(config.VILLAGE_AI_WORKER_CMD)
  ) {
    invalid.push('VILLAGE_AI_WORKER_CMD');
  }

  if (enableWrites !== true) {
    if (!missing.includes('SUPABASE_TABLE') && !isWindowsStagingTable(config.SUPABASE_TABLE)) {
      invalid.push('SUPABASE_TABLE');
    }
    if (
      !missing.includes('SUPABASE_FOLLOW_UP_TABLE') &&
      !isWindowsStagingTable(config.SUPABASE_FOLLOW_UP_TABLE)
    ) {
      invalid.push('SUPABASE_FOLLOW_UP_TABLE');
    }
  }

  return { valid: missing.length === 0 && invalid.length === 0, missing, invalid };
}

export function redactWindowsStagingConfig(config) {
  return Object.fromEntries(
    Object.entries(config).map(([name, value]) => [
      name,
      SAFE_OUTPUT_SETTING_NAMES.has(name) ? value : isSet(value) ? '[set]' : '[unset]'
    ])
  );
}

function normalizeBooleanSetting(value) {
  if (value === true) return '1';
  if (value === false) return '0';

  const normalized = String(value).trim().toLowerCase();
  if (normalized === '1' || normalized === 'true') return '1';
  if (normalized === '0' || normalized === 'false') return '0';
  return null;
}

function isWindowsStagingTable(value) {
  return /^[A-Za-z_][A-Za-z0-9_]*_windows_staging$/.test(String(value).trim());
}

function isWindowsNativeWorkerCommand(value) {
  const command = String(value).trim();
  const hasNativeLauncher = /^(?:"[A-Za-z]:\\[^"\r\n]+\.(?:exe|cmd)"|[A-Za-z]:\\\S+\.(?:exe|cmd)|[A-Za-z0-9_.-]+\.(?:exe|cmd))(?:\s|$)/i.test(
    command
  );
  const referencesReviewedWrapper = /(?:^|[\\/])scripts[\\/]windows[\\/]windows-ai-worker\.mjs"?(?:\s|$)/i.test(
    command
  );
  return hasNativeLauncher && referencesReviewedWrapper;
}

function isSet(value) {
  return value !== undefined && value !== null && String(value) !== '';
}

function parseArguments(args) {
  let envPath;
  let enableWrites = false;
  let workerCommand;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--enable-writes') {
      enableWrites = true;
      continue;
    }
    if (argument === '--env' && envPath === undefined) {
      const candidate = args[index + 1];
      if (!candidate || candidate.startsWith('--')) return { missingEnv: true };
      envPath = candidate;
      index += 1;
      continue;
    }
    if (argument === '--worker-command' && workerCommand === undefined) {
      const candidate = args[index + 1];
      if (!candidate || candidate.startsWith('--')) return { error: 'unexpected argument' };
      workerCommand = candidate;
      index += 1;
      continue;
    }
    return { error: 'unexpected argument' };
  }

  return { envPath, enableWrites, workerCommand };
}

async function runCli(args) {
  const options = parseArguments(args);
  if (options.error) {
    process.stdout.write(`${JSON.stringify({ valid: false, missing: [], error: 'unexpected error' })}\n`);
    return 1;
  }
  if (options.missingEnv || !options.envPath) {
    process.stdout.write(`${JSON.stringify({ valid: false, missing: ['--env'] })}\n`);
    return 2;
  }

  try {
    const values = parseEnvText(await readFile(options.envPath, 'utf8'));
    const config = buildWindowsStagingConfig(values, options);
    if (options.workerCommand !== undefined) {
      config.VILLAGE_AI_WORKER_CMD = options.workerCommand;
    }
    const validation = validateWindowsStagingConfig(config, options);
    const output = { ...redactWindowsStagingConfig(config), ...validation };
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return validation.valid ? 0 : 2;
  } catch (error) {
    if (error instanceof InvalidBooleanSettingError) {
      process.stdout.write(
        `${JSON.stringify({ valid: false, missing: [], invalid: error.invalid })}\n`
      );
      return 2;
    }
    if (error instanceof Error && /^Malformed env line \d+$/.test(error.message)) {
      process.stdout.write(
        `${JSON.stringify({ valid: false, missing: [], error: 'invalid env file' })}\n`
      );
      return 2;
    }
    process.stdout.write(`${JSON.stringify({ valid: false, missing: [], error: 'unexpected error' })}\n`);
    return 1;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = await runCli(process.argv.slice(2));
}
