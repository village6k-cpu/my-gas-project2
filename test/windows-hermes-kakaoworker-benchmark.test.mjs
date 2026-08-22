import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const fixturePath = path.join(root, 'test', 'fixtures', 'hermes-kakaoworker-native-benchmark.json');
const helperPath = path.join(root, 'scripts', 'windows', 'hermes-kakaoworker-benchmark-prompt.mjs');
const runnerPath = path.join(root, 'scripts', 'windows', 'measure-hermes-village-skill-latency.ps1');
const invokePath = path.join(root, 'scripts', 'windows', 'hermes-village-benchmark-invoke.py');
const analyzePath = path.join(root, 'scripts', 'windows', 'hermes-village-benchmark-analyze.py');
const gatewayReplayPath = path.join(root, 'tools', 'kakao-dom-bridge', 'fixtures', 'hermes-gateway-replay.json');
const modelContractPath = path.join(root, 'scripts', 'windows', 'hermes-model-contract.json');
const recordedEvidencePath = path.join(root, 'docs', 'kakao-hermes-gateway-benchmark-evidence.json');
const benchmarkReportPath = path.join(root, 'docs', 'kakao-hermes-gateway-benchmark.md');
const hermesPython = path.join(process.env.LOCALAPPDATA ?? '', 'hermes', 'hermes-agent', 'venv', 'Scripts', 'python.exe');
const workerModulePath = path.join(root, 'tools', 'ai-browser-worker', 'worker.mjs');
const historySkillPath = path.join(
  root,
  'scripts',
  'windows',
  'hermes-profile-overlay',
  'skills',
  'village',
  'village-brain-first',
  'SKILL.md'
);

function readFixture() {
  assert.ok(fs.existsSync(fixturePath), `missing worker benchmark fixture: ${fixturePath}`);
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
}

test('worker benchmark fixtures cover four real prompt decisions without personal data', () => {
  const fixtures = readFixture();
  assert.equal(fixtures.version, 1);
  assert.deepEqual(
    fixtures.cases.map((entry) => entry.id),
    [
      'kakao-confirmation-complete',
      'kakao-registered-quote',
      'kakao-schedule-addition',
      'kakao-current-policy-faq'
    ]
  );
  const serialized = JSON.stringify(fixtures);
  assert.doesNotMatch(serialized, /01[016789]-?\d{3,4}-?\d{4}/);
  assert.doesNotMatch(serialized, /@/);
  for (const fixture of fixtures.cases) {
    assert.equal(typeof fixture.job, 'object');
    assert.equal(typeof fixture.options?.navigationContext, 'object');
    assert.equal(typeof fixture.expected, 'object');
    assert.equal(fixture.brainExpected, false);
    assert.ok(Array.isArray(fixture.requiredSkills));
  }
});

test('worker benchmark prompt is built by the real worker prompt function with a no-send guard', async () => {
  assert.ok(fs.existsSync(helperPath), `missing worker prompt helper: ${helperPath}`);
  const [{ buildKakaoworkerBenchmarkPrompt }, worker, fixtures] = await Promise.all([
    import(pathToFileURL(helperPath)),
    import(pathToFileURL(workerModulePath)),
    Promise.resolve(readFixture())
  ]);
  for (const fixture of fixtures.cases) {
    const prompt = buildKakaoworkerBenchmarkPrompt(worker.buildHermesPrompt, fixture);
    assert.match(prompt, /^ISOLATED NO-SEND KAKAOWORKER BENCHMARK/m);
    assert.match(prompt, /AI-first Kakao rental-shop worker task\./);
    assert.match(prompt, new RegExp(`Case ID: ${fixture.id}`));
    assert.match(prompt, /AI_WORKER_AUTO_SEND=0/);
    assert.match(prompt, /BROWSER NAVIGATION RESULT:/);
    assert.doesNotMatch(prompt, /Required operation label:/);
  }
});

test('history skill discovery metadata excludes current worker operations', () => {
  const source = fs.readFileSync(historySkillPath, 'utf8');
  const description = (source.match(/^description:\s*(.+)$/m)?.[1] ?? '')
    .trim()
    .replace(/^(['"])([\s\S]*)\1$/, '$2');
  assert.ok([...description].length <= 60);
  assert.match(description, /explicit.*history/i);
  assert.match(description, /never current operations/i);
});

test('worker benchmark WhatIf creates no profiles or results', { skip: process.platform !== 'win32' }, () => {
  const runId = `wk-${process.pid}-${String(Date.now()).slice(-8)}`;
  const profilesRoot = path.join(process.env.LOCALAPPDATA, 'hermes', 'profiles');
  const benchmarkRoot = path.join(
    process.env.LOCALAPPDATA,
    'hermes',
    'benchmarks',
    `native-lifecycle-${runId}`
  );
  const targets = [
    benchmarkRoot,
    path.join(profilesRoot, `native-lifecycle-bench-${runId}-legacy`),
    path.join(profilesRoot, `native-lifecycle-bench-${runId}-candidate`)
  ];
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      runnerPath,
      '-RunId',
      runId,
      '-BenchmarkMode',
      'kakaoworker',
      '-WorkerRepo',
      root,
      '-WhatIf'
    ],
    { encoding: 'utf8', timeout: 30_000 }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /WHATIF|What if|preview/i);
  assert.match(result.stdout, /kakaoworker/i);
  assert.match(
    result.stdout.replaceAll('\\', '/'),
    /modelContract=.*scripts\/windows\/hermes-model-contract\.json/i
  );
  for (const target of targets) {
    assert.equal(fs.existsSync(target), false, `-WhatIf created ${target}`);
  }
});

test('A/B benchmark plan has one warm-up plus 20 matched turns per transport', { skip: process.platform !== 'win32' }, () => {
  const tempRoot = fs.mkdtempSync(path.join(process.env.TEMP, 'kakao-gateway-benchmark-plan-'));
  const outputPath = path.join(tempRoot, 'plan.json');
  try {
    const result = spawnSync(
      hermesPython,
      [
        invokePath,
        '--ab-plan',
        '--replay-fixture', gatewayReplayPath,
        '--model-contract', modelContractPath,
        '--output-plan', outputPath,
        '--sample-count', '20',
        '--warmup-count', '1'
      ],
      { encoding: 'utf8', timeout: 30_000 }
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const plan = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.equal(plan.schema, 'village-kakao-hermes-benchmark-plan/v1');
    assert.deepEqual(plan.config, {
      provider: 'xai-oauth',
      model: 'grok-4.5',
      reasoning_effort: 'xhigh',
      max_turns: 90,
      disabled_toolsets: ['computer_use']
    });
    assert.deepEqual(plan.transports.map(({ name }) => name), ['baseline', 'gateway']);
    for (const transport of plan.transports) {
      assert.equal(transport.invocations.length, 21);
      assert.equal(transport.invocations.filter(({ measured }) => measured).length, 20);
      assert.equal(transport.invocations[0].measured, false);
    }
    assert.equal(plan.transports[0].process_model, 'one_shot_cli');
    assert.equal(plan.transports[1].process_model, 'persistent_native_gateway');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

function benchmarkInput({ measurementKind = 'provider_backed', sampleCount = 20, configOverride = {} } = {}) {
  const config = {
    provider: 'xai-oauth',
    model: 'grok-4.5',
    reasoning_effort: 'xhigh',
    max_turns: 90,
    disabled_toolsets: ['computer_use'],
    tools_signature: 'same-tools',
    skills_signature: 'same-skills',
    ...configOverride
  };
  return {
    schema: 'village-kakao-hermes-benchmark-evidence/v1',
    measurement_kind: measurementKind,
    baseline: {
      sample_count: 23,
      total_median_ms: 176_300,
      total_p95_ms: 246_300,
      config: { ...config }
    },
    gateway: {
      config: { ...config, ...(configOverride.gateway ?? {}) },
      samples: Array.from({ length: sampleCount }, (_, index) => ({
        total_ms: 82_000 + index * 1_000,
        agent_ms: 74_000 + index * 900,
        process_starts: 0,
        post_action_agent_runs: 0,
        session_reused: true,
        schedule: index % 2 === 0,
        owner_review_required: index % 2 === 0,
        send_count: 0,
        write_count: 0
      }))
    }
  };
}

function analyzeBenchmark(input) {
  const tempRoot = fs.mkdtempSync(path.join(process.env.TEMP, 'kakao-gateway-benchmark-analyze-'));
  const inputPath = path.join(tempRoot, 'evidence.json');
  fs.writeFileSync(inputPath, JSON.stringify(input));
  try {
    const result = spawnSync(hermesPython, [analyzePath, '--ab-evidence', inputPath], {
      encoding: 'utf8',
      timeout: 30_000
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

test('provider-backed matched benchmark emits every acceptance field and passes only all gates', { skip: process.platform !== 'win32' }, () => {
  const report = analyzeBenchmark(benchmarkInput());
  for (const field of [
    'sample_count',
    'baseline_total_median_ms',
    'baseline_total_p95_ms',
    'gateway_total_median_ms',
    'gateway_total_p95_ms',
    'gateway_agent_median_ms',
    'gateway_agent_p95_ms',
    'process_starts_per_request',
    'post_action_agent_runs_per_schedule',
    'session_reuse_rate',
    'schedule_owner_review_rate',
    'send_count',
    'write_count'
  ]) {
    assert.ok(Object.hasOwn(report, field), `missing ${field}`);
  }
  assert.equal(report.sample_count, 20);
  assert.equal(report.process_starts_per_request, 0);
  assert.equal(report.post_action_agent_runs_per_schedule, 0);
  assert.equal(report.session_reuse_rate, 1);
  assert.equal(report.schedule_owner_review_rate, 1);
  assert.equal(report.send_count, 0);
  assert.equal(report.write_count, 0);
  assert.equal(report.comparable_config, true);
  assert.equal(report.latency_status, 'pass');
  assert.equal(report.accepted, true);
});

test('offline timings, short runs, or config drift are BLOCKED even when raw latency looks fast', { skip: process.platform !== 'win32' }, () => {
  const offline = analyzeBenchmark(benchmarkInput({ measurementKind: 'offline_structural' }));
  assert.equal(offline.accepted, false);
  assert.equal(offline.latency_status, 'blocked');
  assert.ok(offline.blockers.includes('provider_backed_measurement_required'));

  const short = analyzeBenchmark(benchmarkInput({ sampleCount: 19 }));
  assert.equal(short.accepted, false);
  assert.ok(short.blockers.includes('gateway_sample_count_below_20'));

  const drifted = benchmarkInput();
  drifted.gateway.config.reasoning_effort = 'low';
  const drift = analyzeBenchmark(drifted);
  assert.equal(drift.accepted, false);
  assert.equal(drift.comparable_config, false);
  assert.ok(drift.blockers.includes('model_provider_reasoning_tools_or_skills_drift'));
});

test('checked-in benchmark report embeds the analyzer output and remains blocked', { skip: process.platform !== 'win32' }, () => {
  const evidence = JSON.parse(fs.readFileSync(recordedEvidencePath, 'utf8'));
  const generated = analyzeBenchmark(evidence);
  const report = fs.readFileSync(benchmarkReportPath, 'utf8');
  const embedded = report.match(/```json\s*([\s\S]*?)```/i)?.[1]?.trim();
  assert.ok(embedded, 'benchmark report has no embedded analyzer JSON');
  assert.deepEqual(JSON.parse(embedded), generated);
  assert.equal(generated.accepted, false);
  assert.equal(generated.latency_status, 'blocked');
});
