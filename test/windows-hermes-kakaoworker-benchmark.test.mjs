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
