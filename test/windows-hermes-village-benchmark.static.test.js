const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const runnerPath = path.join(
  root,
  'scripts',
  'windows',
  'measure-hermes-village-skill-latency.ps1'
);
const fixturePath = path.join(
  root,
  'test',
  'fixtures',
  'hermes-village-native-benchmark.json'
);
const invokerPath = path.join(
  root,
  'scripts',
  'windows',
  'hermes-village-benchmark-invoke.py'
);
const analyzerPath = path.join(
  root,
  'scripts',
  'windows',
  'hermes-village-benchmark-analyze.py'
);

function readRequired(file) {
  assert.ok(fs.existsSync(file), `missing benchmark artifact: ${file}`);
  return fs.readFileSync(file, 'utf8');
}

test('benchmark fixture is fixed, anonymous, and covers the eight required judgments', () => {
  const fixtures = JSON.parse(readRequired(fixturePath));
  assert.equal(fixtures.version, 1);
  assert.equal(fixtures.cases.length, 8);
  assert.deepEqual(
    fixtures.cases.map((entry) => entry.id),
    [
      'simple-unregistered-quote',
      'registered-quote-correction',
      'confirmation-equipment-alias',
      'confirmation-split-return-times',
      'schedule-equipment-addition',
      'return-memo-raw-text',
      'historical-policy-question',
      'ordinary-live-state-question'
    ]
  );

  const serialized = JSON.stringify(fixtures);
  assert.doesNotMatch(serialized, /01[016789]-?\d{3,4}-?\d{4}/);
  assert.doesNotMatch(serialized, /@/);
  for (const fixture of fixtures.cases) {
    assert.equal(typeof fixture.prompt, 'string');
    assert.ok(fixture.prompt.length > 80, `${fixture.id} prompt is too weak`);
    assert.equal(typeof fixture.expected, 'object');
    assert.equal(fixture.expected.write_or_send, false);
    assert.equal(typeof fixture.brainExpected, 'boolean');
    assert.ok(Array.isArray(fixture.requiredSkills));
    if (fixture.candidateRequiredSkills !== undefined) {
      assert.ok(Array.isArray(fixture.candidateRequiredSkills));
    }
  }
  assert.match(
    fixtures.cases[0].prompt,
    /VAT-included/i,
    'the quote fixture must make its total convention unambiguous'
  );
  assert.deepEqual(
    fixtures.cases.find((entry) => entry.id === 'historical-policy-question').expected.result.source,
    { $containsAll: ['policy'] }
  );
  assert.deepEqual(
    fixtures.cases.find((entry) => entry.id === 'ordinary-live-state-question').expected.result.source,
    { $containsAll: ['live', 'readback'] }
  );
});

test('benchmark runner is cold, comparable, observable, and fail-closed', () => {
  const source = readRequired(runnerPath);
  const invoker = readRequired(invokerPath);
  const analyzer = readRequired(analyzerPath);

  assert.match(source, /SupportsShouldProcess\s*=\s*\$true/i);
  assert.match(source, /native-lifecycle-bench-/i);
  assert.match(source, /legacy/i);
  assert.match(source, /candidate/i);
  assert.match(source, /Assert-IsolatedBenchmarkProfile/i);
  assert.match(source, /kakaoworker/i);
  assert.match(source, /hermes-model-contract\.json/i);
  assert.match(source, /\.kakaoworker/i);
  assert.match(source, /reasoning_effort/i);
  assert.match(invoker, /['"]-m['"][\s\S]*['"]hermes_cli\.main['"][\s\S]*['"]-z['"]/i);
  assert.match(invoker, /['"]--usage-file['"]/i);
  assert.match(invoker, /['"]--reasoning['"]/i);
  assert.match(invoker, /['"]-t['"][\s\S]{0,80}['"]skills['"]/i);
  assert.match(invoker, /['"]--ignore-rules['"]/i);
  assert.match(source, /state\.db/i);
  assert.match(source, /hermes-village-benchmark-invoke\.py/i);
  assert.match(source, /--prompt-file/i);
  assert.match(source, /Required operation label:/i);
  assert.match(source, /Required result keys:/i);
  assert.match(source, /Required status label:/i);
  assert.match(source, /minimum necessary skill set/i);
  assert.doesNotMatch(source, /every relevant Village skill/i);
  assert.match(source, /\$resultsArray\s*=\s*\[object\[\]\]\$results/i);
  assert.doesNotMatch(source, /results\s*=\s*@\(\$results\)/i);
  assert.match(invoker, /subprocess\.run\s*\(/i);
  assert.match(invoker, /\[\s*args\.hermes_python[\s\S]*['"]-m['"][\s\S]*['"]hermes_cli\.main['"]/i);
  assert.doesNotMatch(invoker, /shell\s*=\s*True/i);
  assert.match(
    analyzer,
    /json\.dumps\s*\(\s*session\s*,\s*ensure_ascii\s*=\s*True\s*\)/i,
    'analyzer JSON must remain safe on Windows CP949 stdout'
  );
  assert.match(analyzer, /\$containsAll/i);
  assert.match(analyzer, /if\s+key\s*!=\s*['"]brain_needed['"]/i);
  assert.match(analyzer, /village-history-evidence/i);
  assert.match(source, /candidateRequiredSkills/i);
  const protectedBlock = source.match(/\$protectedLivePaths\s*=\s*@\(([\s\S]*?)\r?\n\)/i);
  assert.ok(protectedBlock, 'benchmark must declare immutable live protection targets');
  assert.doesNotMatch(
    protectedBlock[1],
    /\.usage\.json/i,
    'concurrently mutable Hermes usage telemetry is not an immutable code target'
  );
  assert.match(source, /\$mutableLiveUsagePaths[\s\S]{0,500}\.usage\.json/i);
  assert.match(source, /mutableLiveUsageTelemetry/i);
  assert.match(
    source,
    /Get-Content\s+-LiteralPath\s+\$fixturesPath\s+-Raw\s+-Encoding\s+UTF8/i,
    'Windows PowerShell must decode the Korean fixture as UTF-8'
  );

  for (const [name, value] of [
    ['VILLAGE_WINDOWS_WRITES_ENABLED', '0'],
    ['AI_WORKER_LIVE', '0'],
    ['AI_WORKER_AUTO_SEND', '0'],
    ['AI_WORKER_DRY_RUN', '1']
  ]) {
    assert.match(
      source,
      new RegExp(`${name}[^\\r\\n]{0,100}['\"]${value}['\"]`, 'i'),
      `${name} must be forced to ${value}`
    );
  }

  for (const field of [
    'selectedSkills',
    'selectedReferences',
    'inputTokens',
    'modelCallCount',
    'toolCallCount',
    'modelLatencyMs',
    'toolLatencyMs',
    'wallLatencyMs',
    'correctnessAssertions',
    'attemptedMutationsOrSends'
  ]) {
    assert.match(source, new RegExp(field, 'i'), `missing result field ${field}`);
  }

  assert.doesNotMatch(source, /chat\.postMessage|hooks\.slack\.com|sheetAPI[^\r\n]*write|doPost\s*\(/i);
});

test('analyzer accepts semantic Village Brain source wording', { skip: process.platform !== 'win32' }, () => {
  const python = path.join(
    process.env.LOCALAPPDATA,
    'hermes',
    'hermes-agent',
    'venv',
    'Scripts',
    'python.exe'
  );
  const modulePath = analyzerPath.replaceAll('\\', '/');
  const program = [
    'import importlib.util',
    `spec = importlib.util.spec_from_file_location("benchmark_analyzer", ${JSON.stringify(modulePath)})`,
    'module = importlib.util.module_from_spec(spec)',
    'spec.loader.exec_module(module)',
    'expected = {"source": {"$containsAll": ["policy"]}}',
    'actual = {"source": "2025 policy note (Village Brain mock readback)"}',
    'checks = module.compare_subset(expected, actual, "$.result")',
    'assert len(checks) == 1 and checks[0]["passed"], checks'
  ].join('\n');
  const result = spawnSync(python, ['-c', program], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('benchmark WhatIf creates neither arm nor result directory', { skip: process.platform !== 'win32' }, () => {
  const runId = `static-${process.pid}-${Date.now()}`;
  const profilesRoot = path.join(process.env.LOCALAPPDATA, 'hermes', 'profiles');
  const benchmarkRoot = path.join(
    process.env.LOCALAPPDATA,
    'hermes',
    'benchmarks',
    `native-lifecycle-${runId}`
  );
  const legacy = path.join(profilesRoot, `native-lifecycle-bench-${runId}-legacy`);
  const candidate = path.join(profilesRoot, `native-lifecycle-bench-${runId}-candidate`);

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
      '-WhatIf'
    ],
    { encoding: 'utf8', timeout: 30_000 }
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /WHATIF|What if|preview/i);
  assert.match(result.stdout, /legacy/i);
  assert.match(result.stdout, /candidate/i);
  for (const target of [benchmarkRoot, legacy, candidate]) {
    assert.equal(fs.existsSync(target), false, `-WhatIf created ${target}`);
  }
});
