import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const fixturePath = path.join(root, 'tools', 'kakao-dom-bridge', 'fixtures', 'hermes-gateway-replay.json');
const harnessPath = path.join(root, 'scripts', 'windows', 'test-kakao-hermes-gateway-nosend.ps1');
const runnerPath = path.join(root, 'scripts', 'windows', 'kakao-hermes-gateway-nosend-runner.py');
const hermesPython = path.join(
  process.env.LOCALAPPDATA ?? '',
  'hermes',
  'hermes-agent',
  'venv',
  'Scripts',
  'python.exe'
);
const pluginCandidates = [
  process.env.KAKAO_HERMES_PLUGIN_SOURCE,
  'C:\\Village\\village-ai-worktrees\\kakao-hermes-main-integration\\migration\\hermes\\plugins\\kakao_village',
  'C:\\Village\\village-ai\\migration\\hermes\\plugins\\kakao_village',
  path.join(process.env.LOCALAPPDATA ?? '', 'hermes', 'profiles', 'kakaoworker', 'plugins', 'kakao_village')
].filter(Boolean);

function pluginSource() {
  return pluginCandidates.find((candidate) => existsSync(path.join(candidate, 'plugin.yaml')));
}

function runHarness() {
  const source = pluginSource();
  assert.ok(source, 'reviewed Kakao plugin source is required for the offline replay');
  assert.ok(existsSync(hermesPython), `installed Hermes Python is missing: ${hermesPython}`);
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      harnessPath,
      '-PluginSourcePath',
      source,
      '-HermesPythonPath',
      hermesPython
    ],
    { cwd: root, encoding: 'utf8', timeout: 60_000 }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim());
}

function structuralEvidence(evidence) {
  return {
    schema: evidence.schema,
    profile: evidence.profile,
    plugin: evidence.plugin,
    loads: evidence.loads,
    concurrency: evidence.concurrency,
    sessions: evidence.sessions,
    turns: evidence.turns.map(({ elapsed_ms, ...turn }) => turn),
    confirmations: evidence.confirmations,
    outcomes: evidence.outcomes,
    safety: evidence.safety,
    process_roles: evidence.processes.map(({ role, command }) => ({ role, command }))
  };
}

test('sanitized replay covers FAQ, schedule, malformed, stale, retry, and terminal timeout cases', () => {
  assert.ok(existsSync(fixturePath), `missing replay fixture: ${fixturePath}`);
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  assert.equal(fixture.schema, 'village-kakao-hermes-replay/v1');
  assert.ok(fixture.events.length >= 9);
  const scenarios = fixture.events.map(({ raw }) => raw.scenario);
  assert.deepEqual(scenarios.slice(0, 3), ['faq', 'faq', 'faq_parallel_room']);
  assert.equal(fixture.events[1].raw.parallel_group, fixture.events[2].raw.parallel_group);
  for (const required of [
    'schedule_mixed_availability',
    'malformed_final',
    'stale_revision',
    'timeout_then_success',
    'timeout_terminal'
  ]) {
    assert.ok(scenarios.includes(required), `missing ${required}`);
  }
  assert.doesNotMatch(JSON.stringify(fixture), /010-\d{4}-\d{4}|조영래|최하늘|전찬영|권현재/);
});

test('offline harness is isolated, bounded, and cannot enable sends or writes', () => {
  for (const file of [harnessPath, runnerPath]) {
    assert.ok(existsSync(file), `missing offline harness file: ${file}`);
  }
  const source = readFileSync(harnessPath, 'utf8');
  for (const [name, value] of [
    ['AI_WORKER_LIVE', '0'],
    ['AI_WORKER_AUTO_SEND', '0'],
    ['AI_WORKER_DRY_RUN', '1'],
    ['VILLAGE_WINDOWS_WRITES_ENABLED', '0'],
    ['SLACK_AGENT_CARD_DELIVERY_ENABLED', '0']
  ]) {
    assert.match(source, new RegExp(`${name}[^\\r\\n]{0,100}['\"]${value}['\"]`, 'i'));
  }
  assert.match(source, /\$profileHome[^\r\n]+kakao-hermes-nosend/i);
  assert.match(source, /New-Item[^\r\n]+\$profileHome/i);
  assert.match(source, /WaitForExit\([^)]{1,20}\)/i, 'offline child must have a bounded wait');
  assert.match(source, /finally[\s\S]+Stop-Process[^\r\n]+owned/i);
  assert.doesNotMatch(source, /hermes-stdin-runner\.py|git\.exe|clasp|Restart-KakaoBridgeLive/i);
});

test('native offline replay proves session reuse, bounded retry, and owner-review no-send outcomes twice', { skip: process.platform !== 'win32' }, () => {
  const first = runHarness();
  const second = runHarness();

  assert.equal(first.schema, 'village-kakao-hermes-nosend-evidence/v1');
  assert.equal(first.profile.isolated, true);
  assert.equal(first.plugin.loaded_from_reviewed_source, true);
  assert.equal(first.plugin.manifest_sha256.length, 64);
  assert.deepEqual(first.loads, { plugin: 1, agent: 1 });
  assert.ok(first.concurrency.max_native_turns >= 2, 'different-room FAQ must overlap in the native loop');

  const roomA = first.sessions.filter(({ room_key }) => room_key === 'offline-room-a');
  assert.ok(roomA.length >= 2);
  assert.equal(new Set(roomA.map(({ session_key }) => session_key)).size, 1);
  const roomB = first.sessions.find(({ room_key }) => room_key === 'offline-room-b');
  assert.ok(roomB);
  assert.notEqual(roomA[0].session_key, roomB.session_key);

  const schedule = first.turns.find(({ scenario }) => scenario === 'schedule_mixed_availability');
  assert.deepEqual(
    {
      native_agent_runs: schedule.native_agent_runs,
      confirmation_tool_calls: schedule.confirmation_tool_calls,
      post_action_agent_runs: schedule.post_action_agent_runs,
      owner_review_required: schedule.owner_review_required
    },
    { native_agent_runs: 1, confirmation_tool_calls: 1, post_action_agent_runs: 0, owner_review_required: true }
  );
  assert.deepEqual(schedule.availability_statuses, ['available', 'warning', 'unavailable']);

  const retry = first.turns.filter(({ scenario }) => scenario === 'timeout_then_success');
  assert.equal(retry.length, 2);
  assert.deepEqual(retry.map(({ attempt }) => attempt), [1, 2]);
  assert.equal(new Set(retry.map(({ session_key }) => session_key)).size, 1);
  assert.equal(retry.at(-1).terminal, 'success');

  const exhausted = first.turns.filter(({ scenario }) => scenario === 'timeout_terminal');
  assert.equal(exhausted.length, 2);
  assert.deepEqual(exhausted.map(({ attempt }) => attempt), [1, 2]);
  assert.equal(exhausted.at(-1).terminal, 'human_review');

  for (const turn of first.turns.filter(({ scenario }) => scenario !== 'faq' && scenario !== 'faq_parallel_room')) {
    assert.equal(turn.owner_review_required, true, `${turn.scenario} must be owner-review`);
  }
  assert.deepEqual(first.safety, {
    kakao_send_count: 0,
    slack_send_count: 0,
    gas_write_count: 0,
    windows_write_count: 0,
    forbidden_processes_started: []
  });
  assert.equal(first.processes.some(({ command }) => /hermes-stdin-runner|git\.exe/i.test(command)), false);
  assert.deepEqual(structuralEvidence(first), structuralEvidence(second));
});
