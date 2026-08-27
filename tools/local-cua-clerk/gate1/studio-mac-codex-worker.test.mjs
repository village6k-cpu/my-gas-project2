import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

async function loadWorker() {
  try { return await import('./studio-mac-codex-worker.mjs'); }
  catch { return null; }
}

const TASK = Object.freeze({
  schemaVersion: 'gate1-studio-mac-task/v1',
  action: 'hometax_cash_receipt_issue',
  handoffId: 'hb-7af43b0c-4b65-4bb4-a04a-b249cc9cf360',
  authorization: 'owner_explicit',
  customerName: '박민경',
  transactionId: '260530-012',
  transactionDate: '2026-06-27',
  amountKrw: 464_310,
  purpose: 'income_deduction',
  phone: '010-4045-7379',
  item: '2026-06-27~29 렌탈',
});

const ISSUED = Object.freeze({
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

const NEEDS_USER = Object.freeze({
  schemaVersion: 'studio-mac-cua-result/v1',
  status: 'NEEDS_USER',
  resultCode: 'user_action_required',
  authorizationNumber: null,
  duplicateFound: false,
  readbackVerified: false,
  mutationObserved: false,
  need: 'studio_mac_locked',
  errorClass: null,
});

function fakeAppServer(finalResult = ISSUED, {
  completionResult = finalResult,
  closeOnEnd = true,
  closeOnSignal = true,
  commentaryText = null,
  finalPhase = 'final_answer',
  emitTurnStarted = true,
  silent = false,
  spawnfile = '/opt/codex',
  verificationEvidence = {
    chromePresent: true,
    accessibilityPresent: true,
    authorizationNumberVisible: true,
    amountKrwVisible: true,
  },
} = {}) {
  const sent = [];
  const signals = [];
  const child = new EventEmitter();
  Object.assign(child, {
    pid: 4321,
    spawnfile,
    exitCode: null,
    signalCode: null,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  const emit = message => queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify(message)}\n`));
  const turn = {
    id: 'turn-studio-mac',
    status: 'inProgress',
    items: [],
    error: null,
    startedAt: 1_000,
    completedAt: null,
    durationMs: null,
    itemsView: 'full',
  };
  const agentMessage = {
    id: 'agent-message-1',
    type: 'agentMessage',
    text: JSON.stringify(finalResult),
    ...(finalPhase === null ? {} : { phase: finalPhase }),
    memoryCitation: null,
  };
  const completedAgentMessage = {
    ...agentMessage,
    text: JSON.stringify(completionResult),
  };
  const commentaryMessage = commentaryText === null ? null : {
    id: 'agent-commentary-1',
    type: 'agentMessage',
    text: commentaryText,
    phase: 'commentary',
  };
  child.stdin = {
    write(line) {
      const message = JSON.parse(String(line));
      sent.push(message);
      if (silent) return true;
      if (message.method === 'initialize') emit({ id: message.id, result: { userAgent: 'test' } });
      if (message.method === 'thread/start') {
        const starts = sent.filter(candidate => candidate.method === 'thread/start').length;
        const startedThreadId = starts === 1 ? 'thread-studio-mac' : 'thread-studio-mac-readback';
        emit({ id: message.id, result: { thread: { id: startedThreadId } } });
        emit({
          emittedAtMs: 1,
          method: 'mcpServer/startupStatus/updated',
          params: {
            name: 'node_repl', status: 'ready', threadId: startedThreadId, error: null, failureReason: null,
          },
        });
      }
      if (message.method === 'thread/name/set') emit({ id: message.id, result: {} });
      if (message.method === 'turn/start') {
        emit({ id: message.id, result: { turn } });
        if (emitTurnStarted) emit({ method: 'turn/started', params: { threadId: 'thread-studio-mac', turn } });
        if (commentaryMessage) emit({
          method: 'item/completed',
          params: { completedAtMs: 1_001_000, threadId: 'thread-studio-mac', turnId: turn.id, item: commentaryMessage },
        });
        emit({
          method: 'item/completed',
          params: { completedAtMs: 1_002_000, threadId: 'thread-studio-mac', turnId: turn.id, item: agentMessage },
        });
        emit({
          method: 'turn/completed',
          params: {
            threadId: 'thread-studio-mac',
            turn: {
              ...turn,
              status: 'completed',
              completedAt: 1_002,
              durationMs: 2_000,
              items: [...(commentaryMessage ? [commentaryMessage] : []), completedAgentMessage],
            },
          },
        });
      }
      if (message.method === 'mcpServer/tool/call') {
        emit({
          id: message.id,
          result: {
            _meta: { source: 'node_repl' },
            content: [{ type: 'text', text: JSON.stringify(verificationEvidence) }],
            isError: false,
            structuredContent: null,
          },
        });
      }
      return true;
    },
    end() {
      if (!closeOnEnd) return;
      queueMicrotask(() => {
        child.exitCode = 0;
        child.emit('close', 0, null);
      });
    },
  };
  child.kill = signal => {
    signals.push(signal);
    if (closeOnSignal) {
      queueMicrotask(() => {
        child.signalCode = signal;
        child.emit('close', null, signal);
      });
    }
    return true;
  };
  return { child, sent, signals };
}

test('one authorized handoff creates one persisted Studio Mac Codex task and returns only the validated issuance result', async () => {
  const worker = await loadWorker();
  assert.equal(typeof worker?.runStudioMacCodexWorker, 'function');
  const fake = fakeAppServer();
  let spawnCall;

  const result = await worker.runStudioMacCodexWorker({
    task: TASK,
    requestId: '0123456789abcdef',
    codexPath: '/opt/codex',
    allowTestOverrides: true,
    spawnImpl(path, args, options) {
      spawnCall = { path, args, options };
      return fake.child;
    },
    identityReader: async () => 'studio-mac-child-1',
    timeoutMs: 1_000,
  });

  assert.deepEqual(result, ISSUED);
  assert.deepEqual(spawnCall, {
    path: '/opt/codex',
    args: ['app-server', '--stdio'],
    options: { stdio: ['pipe', 'pipe', 'pipe'] },
  });
  assert.deepEqual(fake.sent.map(message => message.method), [
    'initialize', 'initialized', 'thread/start', 'thread/name/set', 'turn/start', 'thread/start', 'mcpServer/tool/call',
  ]);
  assert.equal(fake.sent.some(message => Object.hasOwn(message, 'jsonrpc')), false);
  const [threadStart, readbackThreadStart] = fake.sent.filter(message => message.method === 'thread/start');
  assert.equal(threadStart.params.ephemeral, false);
  assert.equal(threadStart.params.approvalPolicy, 'never');
  assert.equal(threadStart.params.sandbox, 'read-only');
  assert.equal(threadStart.params.serviceName, 'village-local-studio-mac-hometax-cua');
  assert.match(threadStart.params.developerInstructions, /이 로컬 스튜디오맥/);
  assert.match(threadStart.params.developerInstructions, /cash_receipt_issued/);
  assert.match(threadStart.params.developerInstructions, /cash_receipt_already_issued/);
  assert.match(threadStart.params.developerInstructions, /user_action_required/);
  assert.match(threadStart.params.developerInstructions, /execution_blocked/);
  assert.doesNotMatch(threadStart.params.developerInstructions, /MacBook|맥북/i);
  const threadName = fake.sent.find(message => message.method === 'thread/name/set');
  assert.deepEqual(threadName.params, {
    threadId: 'thread-studio-mac',
    name: '맥에이전트 · 현금영수증 · 0123456789abcdef',
  });
  assert.equal(JSON.stringify(threadName).includes(TASK.customerName), false);
  assert.equal(JSON.stringify(threadName).includes(TASK.phone), false);
  assert.equal(readbackThreadStart.params.ephemeral, true);
  assert.equal(readbackThreadStart.params.approvalPolicy, 'never');
  assert.equal(readbackThreadStart.params.sandbox, 'read-only');
  assert.equal(readbackThreadStart.params.serviceName, 'village-local-studio-mac-hometax-readback');
  assert.match(readbackThreadStart.params.developerInstructions, /이 로컬 스튜디오맥/);

  const turnStart = fake.sent.find(message => message.method === 'turn/start');
  assert.equal(turnStart.params.threadId, 'thread-studio-mac');
  assert.equal(turnStart.params.clientUserMessageId, '0123456789abcdef');
  assert.deepEqual(turnStart.params.outputSchema.required, [
    'schemaVersion', 'status', 'resultCode', 'authorizationNumber', 'duplicateFound',
    'readbackVerified', 'mutationObserved', 'need', 'errorClass',
  ]);
  assert.equal(turnStart.params.outputSchema.additionalProperties, false);
  assert.deepEqual(JSON.parse(turnStart.params.input[0].text.split('\n').at(-1)), TASK);
  const verifier = fake.sent.find(message => message.method === 'mcpServer/tool/call');
  assert.equal(verifier.params.threadId, 'thread-studio-mac-readback');
  assert.notEqual(verifier.params.threadId, turnStart.params.threadId);
  assert.equal(verifier.params.server, 'node_repl');
  assert.equal(verifier.params.tool, 'js');
  assert.match(verifier.params.arguments.code, /Z56524383/);
  assert.match(verifier.params.arguments.code, /464310/);
  assert.match(verifier.params.arguments.code, /\[\^A-Za-z0-9-\]/);
  assert.match(verifier.params.arguments.code, /\[\^0-9A-Za-z\]/);
  assert.equal(verifier.params.arguments.code.includes(TASK.customerName), false);
  assert.equal(verifier.params.arguments.code.includes(TASK.phone), false);
  assert.equal(JSON.stringify(result).includes(TASK.customerName), false);
  assert.equal(JSON.stringify(result).includes(TASK.phone), false);
  assert.deepEqual(fake.signals, []);
});

test('the default worker launches the Codex binary bundled with this Studio Mac app', async () => {
  const worker = await loadWorker();
  const appCodexPath = '/Applications/ChatGPT.app/Contents/Resources/codex';
  const fake = fakeAppServer(NEEDS_USER, { spawnfile: appCodexPath });
  let launchedPath;

  await worker.runStudioMacCodexWorker({
    task: TASK,
    requestId: '0123456789abcdef',
    allowTestOverrides: true,
    spawnImpl(path) {
      launchedPath = path;
      return fake.child;
    },
    identityReader: async () => 'studio-mac-child-1',
    timeoutMs: 1_000,
  });

  assert.equal(launchedPath, appCodexPath);
});

test('the worker revalidates the exact Gate 1 task contract before any child can spawn', async () => {
  const worker = await loadWorker();
  assert.equal(typeof worker?.validateStudioMacTask, 'function');
  assert.deepEqual(worker.validateStudioMacTask(TASK), TASK);

  for (const invalid of [
    { ...TASK, handoffId: 'HB_7AF43B0C_4B65' },
    { ...TASK, handoffId: 'hb-010-4045-7379' },
    { ...TASK, authorization: 'inferred' },
    { ...TASK, action: 'hometax_lookup' },
    { ...TASK, unexpected: true },
  ]) {
    assert.throws(() => worker.validateStudioMacTask(invalid), /Studio Mac task/);
  }
});

test('the fixed result contract accepts only coherent, privacy-minimal terminal states', async () => {
  const worker = await loadWorker();
  assert.deepEqual(worker.validateStudioMacResult(ISSUED), ISSUED);
  assert.deepEqual(worker.validateStudioMacResult({
    schemaVersion: 'studio-mac-cua-result/v1',
    status: 'COMPLETED',
    resultCode: 'cash_receipt_already_issued',
    authorizationNumber: 'A123456789',
    duplicateFound: true,
    readbackVerified: true,
    mutationObserved: false,
    need: null,
    errorClass: null,
  }).resultCode, 'cash_receipt_already_issued');
  assert.deepEqual(worker.validateStudioMacResult({
    schemaVersion: 'studio-mac-cua-result/v1',
    status: 'NEEDS_USER',
    resultCode: 'user_action_required',
    authorizationNumber: null,
    duplicateFound: false,
    readbackVerified: false,
    mutationObserved: false,
    need: 'captcha_required',
    errorClass: null,
  }).need, 'captcha_required');

  for (const invalid of [
    { ...ISSUED, authorizationNumber: null },
    { ...ISSUED, readbackVerified: false },
    { ...ISSUED, mutationObserved: false },
    { ...ISSUED, duplicateFound: true },
    { ...ISSUED, customerName: TASK.customerName },
  ]) {
    assert.throws(() => worker.validateStudioMacResult(invalid), /Studio Mac result/);
  }
});

test('a final agent message is rejected unless the completed turn readback matches it exactly', async () => {
  const worker = await loadWorker();
  const fake = fakeAppServer(ISSUED, {
    completionResult: { ...ISSUED, authorizationNumber: 'A123456789' },
  });
  const result = await worker.runStudioMacCodexWorker({
    task: TASK,
    requestId: '0123456789abcdef',
    codexPath: '/opt/codex',
    allowTestOverrides: true,
    spawnImpl: () => fake.child,
    identityReader: async () => 'studio-mac-child-1',
    timeoutMs: 1_000,
  });

  assert.deepEqual(result, {
    schemaVersion: 'studio-mac-cua-result/v1',
    status: 'BLOCKED',
    resultCode: 'execution_blocked',
    authorizationNumber: null,
    duplicateFound: false,
    readbackVerified: false,
    mutationObserved: false,
    need: null,
    errorClass: 'malformed_result',
  });
});

test('timeout cleanup signals only the same pinned child after identity revalidation', async () => {
  const worker = await loadWorker();
  const fake = fakeAppServer(ISSUED, { silent: true, closeOnEnd: false });
  const identities = [];
  const result = await worker.runStudioMacCodexWorker({
    task: TASK,
    requestId: '0123456789abcdef',
    codexPath: '/opt/codex',
    allowTestOverrides: true,
    spawnImpl: () => fake.child,
    identityReader: async pid => {
      identities.push(pid);
      return 'studio-mac-child-1';
    },
    timeoutMs: 5,
    cleanupTimeoutMs: 30,
  });

  assert.equal(result.errorClass, 'timeout');
  assert.deepEqual(fake.signals, ['SIGTERM']);
  assert.deepEqual(identities, [4321, 4321]);
});

test('cleanup refuses to signal a PID whose exact process identity changed', async () => {
  const worker = await loadWorker();
  const fake = fakeAppServer(ISSUED, { silent: true, closeOnEnd: false });
  let reads = 0;
  const result = await worker.runStudioMacCodexWorker({
    task: TASK,
    requestId: '0123456789abcdef',
    codexPath: '/opt/codex',
    allowTestOverrides: true,
    spawnImpl: () => fake.child,
    identityReader: async () => (++reads === 1 ? 'studio-mac-child-1' : 'reused-pid'),
    timeoutMs: 5,
    cleanupTimeoutMs: 30,
  });

  assert.equal(result.errorClass, 'cleanup_incomplete');
  assert.deepEqual(fake.signals, []);
});

test('a COMPLETED claim is blocked when fixed Chrome readback cannot prove both approval and amount', async () => {
  const worker = await loadWorker();
  const fake = fakeAppServer(ISSUED, {
    verificationEvidence: {
      chromePresent: true,
      accessibilityPresent: true,
      authorizationNumberVisible: true,
      amountKrwVisible: false,
    },
  });
  const result = await worker.runStudioMacCodexWorker({
    task: TASK,
    requestId: '0123456789abcdef',
    codexPath: '/opt/codex',
    allowTestOverrides: true,
    spawnImpl: () => fake.child,
    identityReader: async () => 'studio-mac-child-1',
    timeoutMs: 1_000,
  });

  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.errorClass, 'outcome_unknown');
  assert.equal(result.authorizationNumber, null);
});

test('NEEDS_USER is returned without a financial readback call or a mutation claim', async () => {
  const worker = await loadWorker();
  const fake = fakeAppServer(NEEDS_USER);
  const result = await worker.runStudioMacCodexWorker({
    task: TASK,
    requestId: '0123456789abcdef',
    codexPath: '/opt/codex',
    allowTestOverrides: true,
    spawnImpl: () => fake.child,
    identityReader: async () => 'studio-mac-child-1',
    timeoutMs: 1_000,
  });

  assert.deepEqual(result, NEEDS_USER);
  assert.equal(fake.sent.some(message => message.method === 'mcpServer/tool/call'), false);
});

test('readback evidence with an unknown field fails the exact verifier schema closed', async () => {
  const worker = await loadWorker();
  const fake = fakeAppServer(ISSUED, {
    verificationEvidence: {
      chromePresent: true,
      accessibilityPresent: true,
      authorizationNumberVisible: true,
      amountKrwVisible: true,
      pageText: 'must never be accepted',
    },
  });
  const result = await worker.runStudioMacCodexWorker({
    task: TASK,
    requestId: '0123456789abcdef',
    codexPath: '/opt/codex',
    allowTestOverrides: true,
    spawnImpl: () => fake.child,
    identityReader: async () => 'studio-mac-child-1',
    timeoutMs: 1_000,
  });

  assert.equal(result.errorClass, 'outcome_unknown');
  assert.equal(JSON.stringify(result).includes('pageText'), false);
});

test('production mode rejects an unpinned binary and all injected process controls before spawning', async () => {
  const worker = await loadWorker();
  let spawned = 0;
  const spawnImpl = () => {
    spawned += 1;
    return fakeAppServer().child;
  };

  await assert.rejects(worker.runStudioMacCodexWorker({
    task: TASK,
    requestId: '0123456789abcdef',
    codexPath: '/opt/not-the-pinned-codex',
    spawnImpl,
  }), /not pinned/);
  await assert.rejects(worker.runStudioMacCodexWorker({
    task: TASK,
    requestId: '0123456789abcdef',
    codexPath: worker.STUDIO_MAC_CODEX_PATH,
    spawnImpl,
  }), /test-only/);
  assert.equal(spawned, 0);
});

test('commentary agent messages may precede one exact final JSON agent message', async () => {
  const worker = await loadWorker();
  const fake = fakeAppServer(ISSUED, { commentaryText: '홈택스 화면을 확인하고 있습니다.' });
  const result = await worker.runStudioMacCodexWorker({
    task: TASK,
    requestId: '0123456789abcdef',
    codexPath: '/opt/codex',
    allowTestOverrides: true,
    spawnImpl: () => fake.child,
    identityReader: async () => 'studio-mac-child-1',
    timeoutMs: 1_000,
  });

  assert.deepEqual(result, ISSUED);
  assert.equal(fake.sent.filter(message => message.method === 'mcpServer/tool/call').length, 1);
});

test('a correlated first item proves the turn started when turn/started was missed during the response race', async () => {
  const worker = await loadWorker();
  const fake = fakeAppServer(NEEDS_USER, { emitTurnStarted: false });
  const result = await worker.runStudioMacCodexWorker({
    task: TASK,
    requestId: '0123456789abcdef',
    codexPath: '/opt/codex',
    allowTestOverrides: true,
    spawnImpl: () => fake.child,
    identityReader: async () => 'studio-mac-child-1',
    timeoutMs: 1_000,
  });

  assert.deepEqual(result, NEEDS_USER);
});

test('a phase-less agent message cannot be promoted to the final financial result', async () => {
  const worker = await loadWorker();
  const fake = fakeAppServer(ISSUED, { finalPhase: null });
  const result = await worker.runStudioMacCodexWorker({
    task: TASK,
    requestId: '0123456789abcdef',
    codexPath: '/opt/codex',
    allowTestOverrides: true,
    spawnImpl: () => fake.child,
    identityReader: async () => 'studio-mac-child-1',
    timeoutMs: 1_000,
  });

  assert.equal(result.status, 'BLOCKED');
  assert.equal(result.errorClass, 'malformed_result');
  assert.equal(fake.sent.some(message => message.method === 'mcpServer/tool/call'), false);
});

test('cleanup treats a child that exits during identity readback as clean and never signals it', async () => {
  const worker = await loadWorker();
  const fake = fakeAppServer(ISSUED, { silent: true, closeOnEnd: false });
  let reads = 0;
  const result = await worker.runStudioMacCodexWorker({
    task: TASK,
    requestId: '0123456789abcdef',
    codexPath: '/opt/codex',
    allowTestOverrides: true,
    spawnImpl: () => fake.child,
    identityReader: async () => {
      reads += 1;
      if (reads === 2) fake.child.exitCode = 0;
      return 'studio-mac-child-1';
    },
    timeoutMs: 5,
    cleanupTimeoutMs: 30,
  });

  assert.equal(result.errorClass, 'timeout');
  assert.deepEqual(fake.signals, []);
});

test('a child that closes before identity capture is observed and never receives protocol work', async () => {
  const worker = await loadWorker();
  const fake = fakeAppServer(ISSUED, { silent: true, closeOnEnd: false });
  const result = await worker.runStudioMacCodexWorker({
    task: TASK,
    requestId: '0123456789abcdef',
    codexPath: '/opt/codex',
    allowTestOverrides: true,
    spawnImpl: () => {
      queueMicrotask(() => {
        fake.child.exitCode = 1;
        fake.child.emit('close', 1, null);
      });
      return fake.child;
    },
    identityReader: async () => {
      await new Promise(resolve => setTimeout(resolve, 1));
      return 'studio-mac-child-1';
    },
    timeoutMs: 50,
  });

  assert.equal(result.errorClass, 'command_failed');
  assert.deepEqual(fake.sent, []);
});
