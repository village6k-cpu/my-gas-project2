import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, open, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function loadShell() {
  try { return await import('./slack-intake-shell.mjs'); }
  catch { return null; }
}

const ROUTE = Object.freeze({ teamId: 'T_SYNTHETIC', channelId: 'C_SYNTHETIC' });
const ENVELOPE = Object.freeze({
  schemaVersion: 'gate2-slack-envelope/v1',
  source: 'synthetic_local',
  teamId: ROUTE.teamId,
  channelId: ROUTE.channelId,
  eventId: 'Ev_SYNTHETIC_0001',
  threadTs: '1787536800.000001',
  action: 'desktop_readiness',
});
const CHECKED_AT = '2026-08-24T12:00:00.000Z';
const REQUEST_ID = createHash('sha256')
  .update(`${ENVELOPE.teamId}\0${ENVELOPE.eventId}`)
  .digest('hex')
  .slice(0, 16);

const GATE1_PASS = Object.freeze({
  schemaVersion: 'gate1-desktop-cua/v1',
  status: 'PASS',
  checkedAt: CHECKED_AT,
  runId: '0123456789abcdef',
  evidence: {
    threadCreated: true,
    fixedActionDispatched: true,
    nodeReplCallCompleted: true,
    desktopThreadCuaAvailable: true,
    chromeWasRunning: true,
    chromeAccessibilityAvailable: true,
    screenshotAvailable: true,
    resultValidated: true,
    cleanupCompleted: true,
  },
});

const GATE1_BLOCKED = Object.freeze({
  schemaVersion: 'gate1-desktop-cua/v1',
  status: 'BLOCKED',
  checkedAt: CHECKED_AT,
  runId: 'fedcba9876543210',
  evidence: {
    threadCreated: true,
    fixedActionDispatched: true,
    nodeReplCallCompleted: true,
    desktopThreadCuaAvailable: false,
    chromeWasRunning: false,
    chromeAccessibilityAvailable: false,
    screenshotAvailable: false,
    resultValidated: true,
    cleanupCompleted: true,
  },
  errorClass: 'not_available',
});

const FIRST_PASS_EVIDENCE = Object.freeze({
  envelopeValidated: true,
  routeAuthorized: true,
  actionAllowed: true,
  claimCreated: true,
  executionStarted: true,
  executionCompleted: true,
  resultValidated: true,
  deliveryAttempted: true,
  resultPosted: true,
  resumedDelivery: false,
  duplicateSuppressed: false,
  ledgerFinalized: true,
});

async function tempLedger(t) {
  const path = await mkdtemp(join(tmpdir(), 'village-gate2-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

async function entriesOrEmpty(path) {
  try { return await readdir(path); }
  catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function callOptions({
  ledgerDir,
  actionRunner,
  resultSink,
  now = () => CHECKED_AT,
  envelope = ENVELOPE,
  deliveryTimeoutMs,
} = {}) {
  return {
    envelope,
    allowedRoute: ROUTE,
    ledgerDir,
    resultSink,
    actionRunner,
    allowTestOverrides: true,
    now,
    ...(deliveryTimeoutMs === undefined ? {} : { deliveryTimeoutMs }),
  };
}

test('strict Gate 2 receipt accepts only the redacted fixed contract', async () => {
  const shell = await loadShell();
  assert.equal(typeof shell?.validateSlackReceipt, 'function');
  assert.equal(typeof shell?.serializeSlackReceipt, 'function');
  const receipt = {
    schemaVersion: 'gate2-slack-receipt/v1',
    status: 'PASS',
    checkedAt: CHECKED_AT,
    employeeId: 'village-tax-document-clerk',
    requestId: REQUEST_ID,
    action: 'desktop_readiness',
    evidence: { ...FIRST_PASS_EVIDENCE },
  };
  assert.deepEqual(shell.validateSlackReceipt(receipt), receipt);
  assert.equal(shell.serializeSlackReceipt(receipt), `${JSON.stringify(receipt, null, 2)}\n`);
  assert.throws(() => shell.validateSlackReceipt({ ...receipt, messageText: 'private' }), /unknown or missing keys/);
  assert.throws(
    () => shell.validateSlackReceipt({ ...receipt, evidence: { ...receipt.evidence, credential: true } }),
    /unknown or missing keys/,
  );
  assert.throws(() => shell.validateSlackReceipt({ ...receipt, requestId: ENVELOPE.eventId }), /request identity/);
  assert.throws(() => shell.validateSlackReceipt({
    ...receipt,
    status: 'BLOCKED',
    errorClass: 'in_progress',
    evidence: Object.fromEntries(Object.keys(receipt.evidence).map(key => [key, false])),
  }), /BLOCKED/);
  assert.throws(() => shell.validateSlackReceipt({
    ...receipt,
    status: 'DUPLICATE',
    evidence: {
      ...Object.fromEntries(Object.keys(receipt.evidence).map(key => [key, false])),
      envelopeValidated: true,
      routeAuthorized: true,
      actionAllowed: true,
      resultValidated: true,
      duplicateSuppressed: true,
      ledgerFinalized: true,
    },
  }), /DUPLICATE/);
  assert.throws(() => shell.validateSlackReceipt({
    ...receipt,
    status: 'REJECTED',
    errorClass: 'invalid_envelope',
    evidence: {
      ...Object.fromEntries(Object.keys(receipt.evidence).map(key => [key, false])),
      routeAuthorized: true,
    },
  }), /invalid envelope/);
});

test('one valid synthetic event executes and posts once, then stores only a bounded redacted completion', async t => {
  const shell = await loadShell();
  assert.equal(typeof shell?.processSyntheticSlackEnvelope, 'function');
  const ledgerDir = await tempLedger(t);
  let executions = 0;
  let posts = 0;
  let delivery;
  const receipt = await shell.processSyntheticSlackEnvelope(callOptions({
    ledgerDir,
    actionRunner: async () => { executions += 1; return GATE1_PASS; },
    resultSink: async value => { posts += 1; delivery = value; return { delivered: true }; },
  }));

  assert.equal(receipt.status, 'PASS');
  assert.equal(receipt.requestId, REQUEST_ID);
  assert.deepEqual(receipt.evidence, FIRST_PASS_EVIDENCE);
  assert.equal(executions, 1);
  assert.equal(posts, 1);
  assert.deepEqual(delivery, {
    route: { teamId: ROUTE.teamId, channelId: ROUTE.channelId, threadTs: ENVELOPE.threadTs },
    result: {
      schemaVersion: 'gate2-slack-delivery/v1',
      employeeId: 'village-tax-document-clerk',
      requestId: REQUEST_ID,
      action: 'desktop_readiness',
      status: 'PASS',
    },
  });

  const recordPath = join(ledgerDir, `${REQUEST_ID}.json`);
  const raw = await readFile(recordPath, 'utf8');
  const record = JSON.parse(raw);
  assert.equal(record.state, 'completed');
  assert.equal(Buffer.byteLength(raw) <= 4096, true);
  assert.equal(raw.includes(ENVELOPE.eventId), false);
  assert.equal(raw.includes(GATE1_PASS.runId), false);
  assert.equal(raw.includes(ROUTE.channelId), false);
  assert.equal(JSON.stringify(receipt).includes(ENVELOPE.eventId), false);
  assert.equal(JSON.stringify(delivery).includes(ENVELOPE.eventId), false);
  assert.equal((await stat(recordPath)).mode & 0o777, 0o600);
  assert.equal((await stat(ledgerDir)).mode & 0o077, 0);
  assert.deepEqual((await entriesOrEmpty(ledgerDir)).sort(), [`${REQUEST_ID}.json`]);
});

test('a completed event is a durable duplicate and never executes or posts twice', async t => {
  const shell = await loadShell();
  const ledgerDir = await tempLedger(t);
  let executions = 0;
  let posts = 0;
  const options = callOptions({
    ledgerDir,
    actionRunner: async () => { executions += 1; return GATE1_PASS; },
    resultSink: async () => { posts += 1; return { delivered: true }; },
  });
  assert.equal((await shell.processSyntheticSlackEnvelope(options)).status, 'PASS');
  const duplicate = await shell.processSyntheticSlackEnvelope(options);
  assert.equal(duplicate.status, 'DUPLICATE');
  assert.equal(duplicate.errorClass, undefined);
  assert.equal(duplicate.evidence.duplicateSuppressed, true);
  assert.equal(duplicate.evidence.executionStarted, false);
  assert.equal(duplicate.evidence.deliveryAttempted, false);
  assert.equal(executions, 1);
  assert.equal(posts, 1);
});

test('invalid envelope, unauthorized route, and unknown action reject before disk or side effects', async t => {
  const shell = await loadShell();
  let executions = 0;
  let posts = 0;
  const actionRunner = async () => { executions += 1; return GATE1_PASS; };
  const resultSink = async () => { posts += 1; return { delivered: true }; };
  const cases = [
    [{ ...ENVELOPE, messageText: 'do something private' }, 'invalid_envelope'],
    [{ ...ENVELOPE, source: 'slack_live' }, 'invalid_envelope'],
    [{ ...ENVELOPE, teamId: 12 }, 'invalid_envelope'],
    [{ ...ENVELOPE, channelId: 'C_UNAUTHORIZED' }, 'unauthorized_route'],
    [{ ...ENVELOPE, action: 'arbitrary_prompt' }, 'action_not_allowed'],
  ];
  for (const [envelope, errorClass] of cases) {
    const parent = await tempLedger(t);
    const ledgerDir = join(parent, 'not-created');
    const receipt = await shell.processSyntheticSlackEnvelope(callOptions({
      ledgerDir, envelope, actionRunner, resultSink,
    }));
    assert.equal(receipt.status, 'REJECTED');
    assert.equal(receipt.errorClass, errorClass);
    assert.deepEqual(await entriesOrEmpty(ledgerDir), []);
  }
  assert.equal(executions, 0);
  assert.equal(posts, 0);
});

test('a concurrent repeat sees the atomic claim and reports in_progress without a second action', async t => {
  const shell = await loadShell();
  const ledgerDir = await tempLedger(t);
  let executions = 0;
  let release;
  let actionStarted;
  const started = new Promise(resolve => { actionStarted = resolve; });
  const actionDone = new Promise(resolve => { release = resolve; });
  const options = callOptions({
    ledgerDir,
    actionRunner: async () => {
      executions += 1;
      actionStarted();
      await actionDone;
      return GATE1_PASS;
    },
    resultSink: async () => ({ delivered: true }),
  });
  const firstPromise = shell.processSyntheticSlackEnvelope(options);
  await started;
  const repeated = await shell.processSyntheticSlackEnvelope(options);
  assert.equal(repeated.status, 'BLOCKED');
  assert.equal(repeated.errorClass, 'in_progress');
  assert.equal(repeated.evidence.executionStarted, false);
  assert.equal(executions, 1);
  release();
  assert.equal((await firstPromise).status, 'PASS');
});

test('malformed Gate 1 output is reduced to a safe posted failure with no raw retention', async t => {
  const shell = await loadShell();
  const ledgerDir = await tempLedger(t);
  const rawMarker = 'private-raw-gate1-marker';
  let delivered;
  const receipt = await shell.processSyntheticSlackEnvelope(callOptions({
    ledgerDir,
    actionRunner: async () => ({ ...GATE1_PASS, rawOutput: rawMarker }),
    resultSink: async value => { delivered = value; return { delivered: true }; },
  }));
  assert.equal(receipt.status, 'BLOCKED');
  assert.equal(receipt.errorClass, 'malformed_action_result');
  assert.equal(receipt.evidence.resultValidated, false);
  assert.equal(receipt.evidence.resultPosted, true);
  assert.equal(delivered.result.status, 'BLOCKED');
  assert.equal(delivered.result.errorClass, 'malformed_action_result');
  assert.equal(JSON.stringify(delivered).includes(rawMarker), false);
  assert.equal((await readFile(join(ledgerDir, `${REQUEST_ID}.json`), 'utf8')).includes(rawMarker), false);
});

test('a valid Gate 1 BLOCKED result is delivered once as action_blocked', async t => {
  const shell = await loadShell();
  const ledgerDir = await tempLedger(t);
  let posts = 0;
  const receipt = await shell.processSyntheticSlackEnvelope(callOptions({
    ledgerDir,
    actionRunner: async () => GATE1_BLOCKED,
    resultSink: async value => {
      posts += 1;
      assert.equal(value.result.status, 'BLOCKED');
      assert.equal(value.result.errorClass, 'action_blocked');
      assert.equal(JSON.stringify(value).includes(GATE1_BLOCKED.errorClass), false);
      return { delivered: true };
    },
  }));
  assert.equal(receipt.status, 'BLOCKED');
  assert.equal(receipt.errorClass, 'action_blocked');
  assert.equal(receipt.evidence.resultValidated, true);
  assert.equal(receipt.evidence.ledgerFinalized, true);
  assert.equal(posts, 1);
});

test('an action exception is posted as a redacted unvalidated failure', async t => {
  const shell = await loadShell();
  const ledgerDir = await tempLedger(t);
  const rawMarker = 'private-action-exception';
  let delivered;
  const receipt = await shell.processSyntheticSlackEnvelope(callOptions({
    ledgerDir,
    actionRunner: async () => { throw new Error(rawMarker); },
    resultSink: async value => { delivered = value; return { delivered: true }; },
  }));
  assert.equal(receipt.status, 'BLOCKED');
  assert.equal(receipt.errorClass, 'action_blocked');
  assert.equal(receipt.evidence.executionCompleted, true);
  assert.equal(receipt.evidence.resultValidated, false);
  assert.equal(receipt.evidence.resultPosted, true);
  assert.equal(JSON.stringify(delivered).includes(rawMarker), false);
  const raw = await readFile(join(ledgerDir, `${REQUEST_ID}.json`), 'utf8');
  assert.equal(raw.includes(rawMarker), false);
  assert.equal(JSON.parse(raw).resultValidated, false);
});

test('known non-delivery resumes posting without re-executing and then deduplicates', async t => {
  const shell = await loadShell();
  const ledgerDir = await tempLedger(t);
  let executions = 0;
  let posts = 0;
  const options = callOptions({
    ledgerDir,
    actionRunner: async () => { executions += 1; return GATE1_PASS; },
    resultSink: async () => { posts += 1; return { delivered: posts > 1 }; },
  });
  const first = await shell.processSyntheticSlackEnvelope(options);
  assert.equal(first.status, 'BLOCKED');
  assert.equal(first.errorClass, 'post_failed');
  assert.equal(first.evidence.ledgerFinalized, false);
  assert.equal(JSON.parse(await readFile(join(ledgerDir, `${REQUEST_ID}.json`), 'utf8')).state, 'result_ready');

  const resumed = await shell.processSyntheticSlackEnvelope(options);
  assert.equal(resumed.status, 'PASS');
  assert.equal(resumed.evidence.resumedDelivery, true);
  assert.equal(resumed.evidence.executionStarted, false);
  assert.equal(executions, 1);
  assert.equal(posts, 2);

  assert.equal((await shell.processSyntheticSlackEnvelope(options)).status, 'DUPLICATE');
  assert.equal(executions, 1);
  assert.equal(posts, 2);
});

test('delivery resume is bound to the original envelope digest and rejects a changed thread', async t => {
  const shell = await loadShell();
  const ledgerDir = await tempLedger(t);
  let executions = 0;
  const postedThreads = [];
  let delivered = false;
  const actionRunner = async () => { executions += 1; return GATE1_PASS; };
  const resultSink = async value => {
    postedThreads.push(value.route.threadTs);
    return { delivered };
  };
  const first = await shell.processSyntheticSlackEnvelope(callOptions({
    ledgerDir, actionRunner, resultSink,
  }));
  assert.equal(first.errorClass, 'post_failed');

  delivered = true;
  const changedEnvelope = { ...ENVELOPE, threadTs: '1787536800.000002' };
  const changed = await shell.processSyntheticSlackEnvelope(callOptions({
    ledgerDir, actionRunner, resultSink, envelope: changedEnvelope,
  }));
  assert.equal(changed.status, 'BLOCKED');
  assert.equal(changed.errorClass, 'envelope_mismatch');
  assert.equal(changed.evidence.executionStarted, false);
  assert.equal(changed.evidence.deliveryAttempted, false);
  assert.equal(executions, 1);
  assert.deepEqual(postedThreads, [ENVELOPE.threadTs]);

  const original = await shell.processSyntheticSlackEnvelope(callOptions({
    ledgerDir, actionRunner, resultSink,
  }));
  assert.equal(original.status, 'PASS');
  assert.equal(executions, 1);
  assert.deepEqual(postedThreads, [ENVELOPE.threadTs, ENVELOPE.threadTs]);
});

test('a corrupted ledger cannot pair unvalidated evidence with PASS before delivery', async t => {
  const shell = await loadShell();
  const ledgerDir = await tempLedger(t);
  let executions = 0;
  let posts = 0;
  let delivered = false;
  const options = callOptions({
    ledgerDir,
    actionRunner: async () => {
      executions += 1;
      return { ...GATE1_PASS, rawOutput: 'discarded' };
    },
    resultSink: async () => { posts += 1; return { delivered }; },
  });
  assert.equal((await shell.processSyntheticSlackEnvelope(options)).errorClass, 'post_failed');
  const recordPath = join(ledgerDir, `${REQUEST_ID}.json`);
  const corrupted = JSON.parse(await readFile(recordPath, 'utf8'));
  corrupted.outcome = { status: 'PASS' };
  await writeFile(recordPath, `${JSON.stringify(corrupted, null, 2)}\n`, { mode: 0o600 });

  delivered = true;
  const replay = await shell.processSyntheticSlackEnvelope(options);
  assert.equal(replay.status, 'BLOCKED');
  assert.equal(replay.errorClass, 'ledger_failed');
  assert.equal(replay.evidence.deliveryAttempted, false);
  assert.equal(executions, 1);
  assert.equal(posts, 1);
});

test('an ambiguous sink exception becomes delivery_unknown and is never automatically posted again', async t => {
  const shell = await loadShell();
  const ledgerDir = await tempLedger(t);
  const rawMarker = 'private-sink-exception';
  let executions = 0;
  let posts = 0;
  const options = callOptions({
    ledgerDir,
    actionRunner: async () => { executions += 1; return GATE1_PASS; },
    resultSink: async () => { posts += 1; throw new Error(rawMarker); },
  });
  const first = await shell.processSyntheticSlackEnvelope(options);
  assert.equal(first.status, 'BLOCKED');
  assert.equal(first.errorClass, 'delivery_unknown');
  assert.equal(first.evidence.resultPosted, false);
  assert.equal(first.evidence.ledgerFinalized, false);
  assert.equal(JSON.stringify(first).includes(rawMarker), false);

  const repeated = await shell.processSyntheticSlackEnvelope(options);
  assert.equal(repeated.status, 'BLOCKED');
  assert.equal(repeated.errorClass, 'delivery_unknown');
  assert.equal(repeated.evidence.deliveryAttempted, false);
  assert.equal(executions, 1);
  assert.equal(posts, 1);
  const files = await entriesOrEmpty(ledgerDir);
  assert.equal(files.includes(`${REQUEST_ID}.delivery.claim`), true);
  assert.equal((await readFile(join(ledgerDir, `${REQUEST_ID}.json`), 'utf8')).includes(rawMarker), false);
});

test('a stalled result sink is bounded and becomes delivery_unknown without an automatic retry', async t => {
  const shell = await loadShell();
  const ledgerDir = await tempLedger(t);
  let posts = 0;
  const options = callOptions({
    ledgerDir,
    actionRunner: async () => GATE1_PASS,
    resultSink: async () => {
      posts += 1;
      await new Promise(resolve => setTimeout(resolve, 100));
      return { delivered: true };
    },
    deliveryTimeoutMs: 15,
  });
  const startedAt = Date.now();
  const first = await shell.processSyntheticSlackEnvelope(options);
  assert.equal(Date.now() - startedAt < 80, true);
  assert.equal(first.status, 'BLOCKED');
  assert.equal(first.errorClass, 'delivery_unknown');
  assert.equal(first.evidence.deliveryAttempted, true);

  const repeated = await shell.processSyntheticSlackEnvelope(options);
  assert.equal(repeated.status, 'BLOCKED');
  assert.equal(repeated.errorClass, 'delivery_unknown');
  assert.equal(repeated.evidence.deliveryAttempted, false);
  assert.equal(posts, 1);
});

test('ledger setup failure is redacted and fails before action or delivery', async t => {
  const shell = await loadShell();
  const parent = await tempLedger(t);
  const ledgerDir = join(parent, 'ledger-is-a-file');
  const handle = await open(ledgerDir, 'wx', 0o600);
  await handle.close();
  let executions = 0;
  let posts = 0;
  const receipt = await shell.processSyntheticSlackEnvelope(callOptions({
    ledgerDir,
    actionRunner: async () => { executions += 1; return GATE1_PASS; },
    resultSink: async () => { posts += 1; return { delivered: true }; },
  }));
  assert.equal(receipt.status, 'BLOCKED');
  assert.equal(receipt.errorClass, 'ledger_failed');
  assert.equal(JSON.stringify(receipt).includes(ledgerDir), false);
  assert.equal(executions, 0);
  assert.equal(posts, 0);
});

test('an existing broad-permission ledger directory is rejected without changing its mode', async t => {
  const shell = await loadShell();
  const ledgerDir = await tempLedger(t);
  await chmod(ledgerDir, 0o755);
  let executions = 0;
  let posts = 0;

  const receipt = await shell.processSyntheticSlackEnvelope(callOptions({
    ledgerDir,
    actionRunner: async () => { executions += 1; return GATE1_PASS; },
    resultSink: async () => { posts += 1; return { delivered: true }; },
  }));

  assert.equal(receipt.status, 'BLOCKED');
  assert.equal(receipt.errorClass, 'ledger_failed');
  assert.equal(executions, 0);
  assert.equal(posts, 0);
  assert.equal((await stat(ledgerDir)).mode & 0o777, 0o755);
});

test('custom action execution is unavailable unless the explicit test seam is enabled', async t => {
  const shell = await loadShell();
  const ledgerDir = await tempLedger(t);
  await assert.rejects(
    shell.processSyntheticSlackEnvelope({
      envelope: ENVELOPE,
      allowedRoute: ROUTE,
      ledgerDir,
      actionRunner: async () => GATE1_PASS,
      resultSink: async () => ({ delivered: true }),
    }),
    /test override/,
  );
  assert.deepEqual(await entriesOrEmpty(ledgerDir), []);
});

test('allowed route configuration requires exact string identifiers', async t => {
  const shell = await loadShell();
  const ledgerDir = await tempLedger(t);
  await assert.rejects(
    shell.processSyntheticSlackEnvelope({
      ...callOptions({
        ledgerDir,
        actionRunner: async () => GATE1_PASS,
        resultSink: async () => ({ delivered: true }),
      }),
      allowedRoute: { teamId: 12, channelId: ROUTE.channelId },
    }),
    /invalid allowed route/,
  );
  assert.deepEqual(await entriesOrEmpty(ledgerDir), []);
});
