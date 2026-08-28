import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function loadShell() {
  try { return await import('./heybilly-handoff-shell.mjs'); }
  catch { return null; }
}

const ROUTE = Object.freeze({ teamId: 'T03EB8LSB18', channelId: 'C0B7CLP4KDY' });
const ENVELOPE = Object.freeze({
  schemaVersion: 'gate2-heybilly-envelope/v1',
  source: 'slack_socket_mode',
  teamId: ROUTE.teamId,
  channelId: ROUTE.channelId,
  eventId: 'Ev0HEYBILLY0001',
  threadTs: '1787621371.680329',
  action: 'studio_mac_cua_handoff',
  taskType: 'hometax_cash_receipt_issue',
  handoffId: 'hb-7af43b0c-4b65-4bb4-a04a-b249cc9cf360',
});
const TASK = Object.freeze({
  schemaVersion: 'gate1-studio-mac-task/v1',
  action: 'hometax_cash_receipt_issue',
  handoffId: ENVELOPE.handoffId,
  authorization: 'owner_explicit',
  customerName: '박민경',
  transactionId: '260530-012',
  transactionDate: '2026-06-27',
  amountKrw: 464310,
  purpose: 'income_deduction',
  phone: '010-4045-7379',
  item: '2026-06-27 렌탈 (260530-012)',
});
const RESULT = Object.freeze({
  schemaVersion: 'studio-mac-cua-result/v1',
  status: 'COMPLETED',
  resultCode: 'cash_receipt_issued',
  authorizationNumber: 'Z56524383',
  duplicateFound: false,
  readbackVerified: true,
  mutationObserved: true,
  need: null,
  errorClass: null,
});
const NOW = '2026-08-25T04:00:00.000Z';
const REQUEST_ID = createHash('sha256')
  .update(`${ENVELOPE.teamId}\0heybilly\0${ENVELOPE.handoffId}`)
  .digest('hex')
  .slice(0, 16);

const GENERAL_ENVELOPE = Object.freeze({
  schemaVersion: 'gate2-heybilly-general-envelope/v1',
  source: 'slack_socket_mode',
  teamId: ROUTE.teamId,
  channelId: ROUTE.channelId,
  eventId: 'Ev0HEYBILLYGENERAL1',
  threadTs: '1787621371.680329',
  action: 'studio_mac_general_handoff',
  handoffId: 'hb-816f4136-c4a8-47c6-9e10-61710e79f05c',
});
const GENERAL_TASK = Object.freeze({
  schemaVersion: 'gate1-studio-mac-general-task/v1',
  action: 'general_local_cua',
  handoffId: GENERAL_ENVELOPE.handoffId,
  authorization: 'owner_explicit',
  instruction: 'Chrome에서 현재 열려 있는 문서의 발급 상태를 확인하고 결과만 보고해.',
});
const GENERAL_RESULT = Object.freeze({
  schemaVersion: 'studio-mac-general-result/v1',
  status: 'COMPLETED',
  summary: '발급 상태 확인을 완료했습니다.',
  mutationObserved: false,
  readbackVerified: true,
  need: null,
  errorClass: null,
});
const GENERAL_REQUEST_ID = createHash('sha256')
  .update(`${GENERAL_ENVELOPE.teamId}\0heybilly-general\0${GENERAL_ENVELOPE.handoffId}`)
  .digest('hex')
  .slice(0, 16);

async function tempLedger(t) {
  const path = await mkdtemp(join(tmpdir(), 'studio-mac-handoff-test-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function options({ ledgerDir, actionRunner, statusSink, envelope = ENVELOPE, task = TASK } = {}) {
  return {
    envelope,
    task,
    allowedRoute: ROUTE,
    ledgerDir,
    actionRunner,
    statusSink,
    allowTestOverrides: true,
    now: () => NOW,
    deliveryTimeoutMs: 100,
  };
}

test('one typed HeyBilly handoff is acknowledged, executed once on Studio Mac, and finalized in the same thread', async t => {
  const shell = await loadShell();
  assert.equal(typeof shell?.processHeyBillyHandoff, 'function');
  const ledgerDir = await tempLedger(t);
  const calls = [];
  const receipt = await shell.processHeyBillyHandoff(options({
    ledgerDir,
    actionRunner: async input => {
      calls.push({ type: 'run', input });
      return RESULT;
    },
    statusSink: async payload => {
      calls.push({ type: 'post', payload });
      return { delivered: true };
    },
  }));

  assert.deepEqual(calls.map(call => call.type), ['post', 'run', 'post']);
  assert.equal(calls[0].payload.phase, 'ACK');
  assert.equal(calls[0].payload.route.threadTs, ENVELOPE.threadTs);
  assert.deepEqual(calls[1].input, { requestId: REQUEST_ID, task: TASK });
  assert.equal(calls[2].payload.phase, 'FINAL');
  assert.deepEqual(calls[2].payload.result, {
    status: 'COMPLETED',
    resultCode: 'cash_receipt_issued',
    authorizationNumber: 'Z56524383',
  });
  assert.deepEqual(receipt, {
    schemaVersion: 'gate2-studio-mac-receipt/v1',
    status: 'PASS',
    requestId: REQUEST_ID,
  });

  const entries = (await readdir(ledgerDir)).sort();
  assert.deepEqual(entries, ['.studio-mac-task-digest.key', `${REQUEST_ID}.studio-mac.json`]);
  const path = join(ledgerDir, `${REQUEST_ID}.studio-mac.json`);
  const raw = await readFile(path, 'utf8');
  assert.equal(JSON.parse(raw).state, 'completed');
  assert.equal(raw.includes(TASK.customerName), false);
  assert.equal(raw.includes(TASK.phone), false);
  assert.equal(raw.includes(String(TASK.amountKrw)), false);
  assert.equal(raw.includes(TASK.item), false);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(ledgerDir, '.studio-mac-task-digest.key'))).mode & 0o777, 0o600);
});

test('one general HeyBilly handoff executes once on the shared Studio Mac queue without persisting its instruction or summary', async t => {
  const shell = await loadShell();
  assert.equal(typeof shell?.processGeneralHeyBillyHandoff, 'function');
  const ledgerDir = await tempLedger(t);
  const calls = [];
  const invoke = () => shell.processGeneralHeyBillyHandoff({
    envelope: GENERAL_ENVELOPE,
    task: GENERAL_TASK,
    allowedRoute: ROUTE,
    ledgerDir,
    actionRunner: async input => {
      calls.push({ type: 'run', input });
      return GENERAL_RESULT;
    },
    statusSink: async payload => {
      calls.push({ type: 'post', payload });
      return { delivered: true };
    },
    allowTestOverrides: true,
    now: () => NOW,
    deliveryTimeoutMs: 100,
  });

  const receipt = await invoke();
  assert.deepEqual(calls.map(call => call.type), ['post', 'run', 'post']);
  assert.equal(calls[0].payload.phase, 'ACK');
  assert.equal(calls[0].payload.route.threadTs, GENERAL_ENVELOPE.threadTs);
  assert.deepEqual(calls[1].input, { requestId: GENERAL_REQUEST_ID, task: GENERAL_TASK });
  assert.equal(calls[2].payload.phase, 'FINAL');
  assert.deepEqual(calls[2].payload.result, GENERAL_RESULT);
  assert.deepEqual(receipt, {
    schemaVersion: 'gate2-studio-mac-general-receipt/v1',
    status: 'PASS',
    requestId: GENERAL_REQUEST_ID,
  });

  const path = join(ledgerDir, `${GENERAL_REQUEST_ID}.studio-mac-general.json`);
  const raw = await readFile(path, 'utf8');
  const record = JSON.parse(raw);
  assert.equal(record.state, 'completed');
  assert.equal(record.result.readbackVerified, true);
  assert.equal(raw.includes(GENERAL_TASK.instruction), false);
  assert.equal(raw.includes(GENERAL_RESULT.summary), false);
  assert.equal((await stat(path)).mode & 0o777, 0o600);

  const beforeDuplicate = calls.length;
  assert.equal((await invoke()).status, 'DUPLICATE');
  assert.equal(calls.length, beforeDuplicate);
});

test('typed and general handoffs share one Studio Mac FIFO and never manipulate the desktop concurrently', async t => {
  const shell = await loadShell();
  const ledgerDir = await tempLedger(t);
  let active = 0;
  let maxConcurrent = 0;
  const releases = [];
  const starts = [];
  const blockingRunner = (label, result) => async () => {
    active += 1;
    maxConcurrent = Math.max(maxConcurrent, active);
    starts.push(label);
    await new Promise(resolve => { releases.push(resolve); });
    active -= 1;
    return result;
  };

  const typed = shell.processHeyBillyHandoff(options({
    ledgerDir,
    actionRunner: blockingRunner('typed', RESULT),
    statusSink: async () => ({ delivered: true }),
  }));
  const general = shell.processGeneralHeyBillyHandoff({
    envelope: GENERAL_ENVELOPE,
    task: GENERAL_TASK,
    allowedRoute: ROUTE,
    ledgerDir,
    actionRunner: blockingRunner('general', GENERAL_RESULT),
    statusSink: async () => ({ delivered: true }),
    allowTestOverrides: true,
    now: () => NOW,
    deliveryTimeoutMs: 100,
  });

  while (starts.length < 1) await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts.length, 1);
  assert.equal(maxConcurrent, 1);
  releases.shift()();
  while (starts.length < 2) await new Promise(resolve => setImmediate(resolve));
  assert.equal(maxConcurrent, 1);
  releases.shift()();
  assert.deepEqual((await Promise.all([typed, general])).map(value => value.status), ['PASS', 'PASS']);
  assert.equal(maxConcurrent, 1);
});

test('an unconfirmed general final is never retried or re-executed because its summary is not persisted', async t => {
  const shell = await loadShell();
  const ledgerDir = await tempLedger(t);
  let executions = 0;
  let posts = 0;
  const invoke = () => shell.processGeneralHeyBillyHandoff({
    envelope: GENERAL_ENVELOPE,
    task: GENERAL_TASK,
    allowedRoute: ROUTE,
    ledgerDir,
    actionRunner: async () => { executions += 1; return GENERAL_RESULT; },
    statusSink: async payload => {
      posts += 1;
      return { delivered: payload.phase === 'ACK' };
    },
    allowTestOverrides: true,
    now: () => NOW,
    deliveryTimeoutMs: 100,
  });

  const first = await invoke();
  const retry = await invoke();
  assert.equal(first.status, 'BLOCKED');
  assert.equal(first.errorClass, 'delivery_unknown');
  assert.equal(retry.status, 'BLOCKED');
  assert.equal(retry.errorClass, 'delivery_unknown');
  assert.equal(executions, 1);
  assert.equal(posts, 2);
});

test('a general ACK resume is bound to the original private instruction digest before posting or execution', async t => {
  const shell = await loadShell();
  const ledgerDir = await tempLedger(t);
  let posts = 0;
  let executions = 0;
  const base = task => shell.processGeneralHeyBillyHandoff({
    envelope: GENERAL_ENVELOPE,
    task,
    allowedRoute: ROUTE,
    ledgerDir,
    actionRunner: async () => { executions += 1; return GENERAL_RESULT; },
    statusSink: async () => { posts += 1; return { delivered: false }; },
    allowTestOverrides: true,
    now: () => NOW,
    deliveryTimeoutMs: 100,
  });

  assert.equal((await base(GENERAL_TASK)).errorClass, 'post_failed');
  const changed = await base({ ...GENERAL_TASK, instruction: '다른 브라우저 업무를 실행해.' });
  assert.equal(changed.status, 'BLOCKED');
  assert.equal(changed.errorClass, 'task_mismatch');
  assert.equal(posts, 1);
  assert.equal(executions, 0);
});

test('a general outcome-unknown result tells Slack that the desktop mutation state needs review', async t => {
  const shell = await loadShell();
  const ledgerDir = await tempLedger(t);
  const payloads = [];
  const receipt = await shell.processGeneralHeyBillyHandoff({
    envelope: GENERAL_ENVELOPE,
    task: GENERAL_TASK,
    allowedRoute: ROUTE,
    ledgerDir,
    actionRunner: async () => { throw new Error('not serialized'); },
    statusSink: async payload => { payloads.push(payload); return { delivered: true }; },
    allowTestOverrides: true,
    now: () => NOW,
    deliveryTimeoutMs: 100,
  });

  assert.equal(receipt.status, 'BLOCKED');
  assert.equal(receipt.errorClass, 'outcome_unknown');
  assert.deepEqual(payloads.map(payload => payload.phase), ['ACK', 'FINAL']);
  assert.equal(payloads[1].result.errorClass, 'outcome_unknown');
  assert.equal(payloads[1].result.summary, '작업 변경 여부를 확인해야 합니다.');
  assert.equal(payloads[1].result.readbackVerified, false);
});

test('an explicit ACK non-delivery retries only the ACK before the first execution', async t => {
  const shell = await loadShell();
  const ledgerDir = await tempLedger(t);
  const phases = [];
  let executions = 0;
  const deliveries = [false, true, true];
  const call = () => shell.processHeyBillyHandoff(options({
    ledgerDir,
    actionRunner: async () => { executions += 1; return RESULT; },
    statusSink: async payload => {
      phases.push(payload.phase);
      return { delivered: deliveries.shift() };
    },
  }));

  const first = await call();
  assert.equal(first.status, 'BLOCKED');
  assert.equal(first.errorClass, 'post_failed');
  assert.equal(executions, 0);

  const resumed = await call();
  assert.equal(resumed.status, 'PASS');
  assert.equal(executions, 1);
  assert.deepEqual(phases, ['ACK', 'ACK', 'FINAL']);
});

test('an ACK resume is bound to the original private task digest before posting or execution', async t => {
  const shell = await loadShell();
  const ledgerDir = await tempLedger(t);
  let posts = 0;
  let executions = 0;
  const first = await shell.processHeyBillyHandoff(options({
    ledgerDir,
    actionRunner: async () => { executions += 1; return RESULT; },
    statusSink: async () => { posts += 1; return { delivered: false }; },
  }));
  assert.equal(first.errorClass, 'post_failed');

  const changedTask = { ...TASK, amountKrw: TASK.amountKrw + 1 };
  const resumed = await shell.processHeyBillyHandoff(options({
    ledgerDir,
    task: changedTask,
    actionRunner: async () => { executions += 1; return RESULT; },
    statusSink: async () => { posts += 1; return { delivered: true }; },
  }));

  assert.equal(resumed.status, 'BLOCKED');
  assert.equal(resumed.errorClass, 'task_mismatch');
  assert.equal(posts, 1);
  assert.equal(executions, 0);
  const raw = await readFile(join(ledgerDir, `${REQUEST_ID}.studio-mac.json`), 'utf8');
  assert.equal(raw.includes(TASK.customerName), false);
  assert.equal(raw.includes(TASK.phone), false);
  assert.equal(raw.includes(String(TASK.amountKrw)), false);
});

test('concurrent ACK resumes have one atomic claim and never start two Studio Mac jobs', async t => {
  const shell = await loadShell();
  const ledgerDir = await tempLedger(t);
  let executions = 0;
  const initial = () => shell.processHeyBillyHandoff(options({
    ledgerDir,
    actionRunner: async () => { executions += 1; return RESULT; },
    statusSink: async () => ({ delivered: false }),
  }));
  assert.equal((await initial()).errorClass, 'post_failed');
  assert.equal(executions, 0);

  let ackCalls = 0;
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const resume = () => shell.processHeyBillyHandoff(options({
    ledgerDir,
    actionRunner: async () => { executions += 1; return RESULT; },
    statusSink: async payload => {
      if (payload.phase === 'ACK') {
        ackCalls += 1;
        if (ackCalls === 1) await wait;
      }
      return { delivered: true };
    },
  }));

  const first = resume();
  while (ackCalls === 0) await new Promise(resolve => setImmediate(resolve));
  const second = await resume();
  release();
  const firstResult = await first;

  assert.equal(ackCalls, 1);
  assert.equal(firstResult.status, 'PASS');
  assert.equal(second.status, 'BLOCKED');
  assert.equal(second.errorClass, 'in_progress');
  assert.equal(executions, 1);
});

test('an explicit final non-delivery retries only the final post and never executes twice', async t => {
  const shell = await loadShell();
  const ledgerDir = await tempLedger(t);
  const phases = [];
  let executions = 0;
  const deliveries = [true, false, true];
  const call = () => shell.processHeyBillyHandoff(options({
    ledgerDir,
    actionRunner: async () => { executions += 1; return RESULT; },
    statusSink: async payload => {
      phases.push(payload.phase);
      return { delivered: deliveries.shift() };
    },
  }));

  assert.equal((await call()).errorClass, 'post_failed');
  assert.equal(executions, 1);
  const resumed = await call();
  assert.equal(resumed.status, 'PASS');
  assert.equal(executions, 1);
  assert.deepEqual(phases, ['ACK', 'FINAL', 'FINAL']);
});

test('a retry observed after execution starts is fail-closed as needs_review and never starts a second CUA job', async t => {
  const shell = await loadShell();
  const ledgerDir = await tempLedger(t);
  let executions = 0;
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const call = () => shell.processHeyBillyHandoff(options({
    ledgerDir,
    actionRunner: async () => { executions += 1; return waiting; },
    statusSink: async () => ({ delivered: true }),
  }));

  const first = call();
  while (executions === 0) await new Promise(resolve => setImmediate(resolve));
  const retry = await call();
  assert.equal(retry.status, 'BLOCKED');
  assert.equal(retry.errorClass, 'needs_review');
  assert.equal(executions, 1);

  release(RESULT);
  assert.equal((await first).status, 'PASS');
});

test('a Studio Mac user-action result is finalized without being mistaken for successful issuance', async t => {
  const shell = await loadShell();
  const ledgerDir = await tempLedger(t);
  const phases = [];
  const needsUser = {
    schemaVersion: 'studio-mac-cua-result/v1',
    status: 'NEEDS_USER',
    resultCode: 'user_action_required',
    authorizationNumber: null,
    duplicateFound: false,
    readbackVerified: false,
    mutationObserved: false,
    need: 'captcha_required',
    errorClass: null,
  };
  const receipt = await shell.processHeyBillyHandoff(options({
    ledgerDir,
    actionRunner: async () => needsUser,
    statusSink: async payload => {
      phases.push(payload);
      return { delivered: true };
    },
  }));

  assert.equal(receipt.status, 'BLOCKED');
  assert.equal(receipt.errorClass, 'user_action_required');
  assert.deepEqual(phases.map(payload => payload.phase), ['ACK', 'FINAL']);
  assert.deepEqual(phases[1].result, {
    status: 'NEEDS_USER',
    resultCode: 'user_action_required',
    need: 'captcha_required',
  });
  const raw = await readFile(join(ledgerDir, `${REQUEST_ID}.studio-mac.json`), 'utf8');
  assert.equal(JSON.parse(raw).state, 'completed');
});

test('concurrent final-delivery resumes have one atomic claim and never post the same result twice', async t => {
  const shell = await loadShell();
  const ledgerDir = await tempLedger(t);
  let executions = 0;
  const firstDeliveries = [true, false];
  const initial = () => shell.processHeyBillyHandoff(options({
    ledgerDir,
    actionRunner: async () => { executions += 1; return RESULT; },
    statusSink: async () => ({ delivered: firstDeliveries.shift() }),
  }));
  assert.equal((await initial()).errorClass, 'post_failed');
  assert.equal(executions, 1);

  let finalCalls = 0;
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const resume = () => shell.processHeyBillyHandoff(options({
    ledgerDir,
    actionRunner: async () => { executions += 1; return RESULT; },
    statusSink: async payload => {
      assert.equal(payload.phase, 'FINAL');
      finalCalls += 1;
      if (finalCalls === 1) await wait;
      return { delivered: true };
    },
  }));

  const first = resume();
  while (finalCalls === 0) await new Promise(resolve => setImmediate(resolve));
  const second = await resume();
  release();
  const firstResult = await first;

  assert.equal(finalCalls, 1);
  assert.equal(firstResult.status, 'PASS');
  assert.equal(second.status, 'BLOCKED');
  assert.equal(second.errorClass, 'in_progress');
  assert.equal(executions, 1);
});
