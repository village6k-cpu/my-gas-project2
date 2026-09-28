import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..');
const configureScript = path.join(
  repoRoot,
  'scripts',
  'windows',
  'configure-hermes-village-routing.py',
);
const contract = JSON.parse(fs.readFileSync(
  path.join(repoRoot, 'scripts', 'windows', 'hermes-model-contract.json'),
  'utf8',
));

function findHermesPython() {
  const candidates = [
    process.env.VILLAGE_HERMES_PYTHON,
    path.join(
      process.env.LOCALAPPDATA || '',
      'hermes',
      'hermes-agent',
      'venv',
      'Scripts',
      'python.exe',
    ),
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate));
}

test('root routing configuration preserves intelligence while bounding concurrency and surfacing long work', {
  skip: !findHermesPython(),
}, () => {
  const python = findHermesPython();
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-runtime-safety-'));
  const configPath = path.join(temporaryDirectory, 'config.yaml');
  fs.writeFileSync(configPath, [
    'model:',
    '  default: stale-model',
    '  provider: stale-provider',
    'agent:',
    '  reasoning_effort: low',
    '  gateway_wall_timeout: 60',
    'tool_loop_guardrails:',
    '  hard_stop_enabled: true',
    'delegation:',
    '  max_iterations: 50',
    '  max_concurrent_children: 3',
    'display:',
    '  platforms:',
    '    slack:',
    '      tool_progress: false',
    '      interim_assistant_messages: false',
    '      long_running_notifications: false',
    '      busy_ack_detail: false',
    '      busy_steer_ack_enabled: false',
    'slack: {}',
    'terminal:',
    '  cwd: C:\\stale',
    '',
  ].join('\n'), 'utf8');

  try {
    const configure = spawnSync(python, [configureScript, '--config', configPath], {
      encoding: 'utf8',
    });
    assert.equal(configure.status, 0, configure.stderr || configure.stdout);

    const inspectCode = [
      'import json, sys',
      'from ruamel.yaml import YAML',
      'cfg = YAML(typ="safe").load(open(sys.argv[1], encoding="utf-8"))',
      'print(json.dumps({',
      '  "model": cfg["model"],',
      '  "reasoning": cfg["agent"]["reasoning_effort"],',
      '  "delegation": cfg["delegation"],',
      '  "slack_display": cfg["display"]["platforms"]["slack"],',
      '}))',
    ].join('\n');
    const inspect = spawnSync(python, ['-c', inspectCode, configPath], {
      encoding: 'utf8',
    });
    assert.equal(inspect.status, 0, inspect.stderr || inspect.stdout);
    const actual = JSON.parse(inspect.stdout);

    assert.equal(actual.model.default, contract.root.model);
    assert.equal(actual.model.provider, contract.root.provider);
    assert.equal(actual.reasoning, contract.root.reasoning_effort);
    assert.equal(actual.delegation.max_iterations, 50, 'reasoning breadth must stay available');
    assert.equal(actual.delegation.max_concurrent_children, 1, '12 GB host must not run large child contexts concurrently');
    assert.equal(actual.slack_display.tool_progress, false, 'internal tool chatter stays hidden');
    assert.equal(actual.slack_display.interim_assistant_messages, false, 'internal interim text stays hidden');
    assert.equal(actual.slack_display.long_running_notifications, true, 'long tasks must emit a heartbeat');
    assert.equal(actual.slack_display.busy_ack_detail, true, 'follow-up messages must get concrete busy status');
    assert.equal(actual.slack_display.busy_steer_ack_enabled, true, 'accepted steering must be acknowledged');
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
