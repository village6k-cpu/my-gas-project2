import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

process.env.KAKAO_DOM_BRIDGE_NO_LISTEN = '1';
const {
  buildCorsHeaders,
  buildHealthConfig,
  buildWorkerResultAudit,
  buildWorkerTreeKillInvocation,
  compactQueueAuditRecord,
  buildP0SlackEscalationClaim,
  buildP0SlackEscalationMessage,
  p0SlackEscalationBackoffMs,
  p0SlackEscalationDue,
  createKakaoPhaseScheduler,
  createGatewayConfirmationExecutor,
  registerAcceptedRoomEvent,
  semanticRoomEventIdentity,
  hasUnreadCount,
  mergeQueuedRoomJobs,
  mapWorkerPayloadToSupabaseStatus,
  normalizeEvent,
  roomKeyForDebounce,
  shouldDetachWorkerProcess,
  shouldQueueTopRowEvent,
  shouldSkipSupabaseRowAsLowValue,
  shouldSkipWorkerForPreview
} = await import('./server.mjs');

test('server confirmation executor forwards the channel claim fence into the worker mutation boundary', async () => {
  let leaseChecks = 0;
  let operationArgs = null;
  const assertCurrentClaim = async () => { leaseChecks += 1; };
  const operationFence = {
    schema: 'village-tool-operation-reservation/v1', operation_id: 'operation-1',
    tool: 'confirmation_request', job_id: 'job-1', room_key: 'room-1', room_revision: 3,
    lease_id: 'lease-1', request_digest: 'digest-1', state: 'reserved',
    created_at: '2026-08-21T00:00:00.000Z', receipt_id: null, completed_at: null
  };
  const executor = createGatewayConfirmationExecutor({
    getConfig: () => ({ sheetApiKey: 'test-internal-key' }),
    executeOperation: async (args) => {
      operationArgs = args;
      await args.dependencies.assertCurrentClaim();
      return { status: 'ok' };
    }
  });

  const result = await executor({
    job_id: 'job-1', room_key: 'room-1', room_revision: 3,
    detected_at: '2026-08-21T00:00:00.000Z', decision: { should_write_to_sheet: true }
  }, { assertCurrentClaim, operationFence });

  assert.deepEqual(result, { status: 'ok' });
  assert.equal(leaseChecks, 1);
  assert.equal(operationArgs.job.jobId, 'job-1');
  assert.equal(operationArgs.job.roomKey, 'room-1');
  assert.equal(operationArgs.job.roomRevision, 3);
  assert.equal(operationArgs.dependencies.assertCurrentClaim, assertCurrentClaim);
  assert.equal(operationArgs.dependencies.operationFence, operationFence);
});

test('P0 Slack escalation repeats only after the durable interval and stops on closure', () => {
  const row = {
    id: 'p0-row',
    status: 'open',
    customer_name: '백남준',
    title: '대여 장비 이상 즉시 확인',
    payload: {
      alert_level: 'p0',
      alert_reason: '대여 중 장비 상태에 즉시 사람 판단 필요',
      slack_delivery: {
        status: 'delivered',
        channel_id: 'CINV',
        message_ts: '100.1',
        thread_ts: '100.1',
        delivered_at: '2026-08-18T00:00:00.000Z'
      }
    }
  };
  assert.equal(p0SlackEscalationDue(row, { nowMs: Date.parse('2026-08-18T00:02:59.000Z'), repeatMs: 180_000 }).due, false);
  assert.equal(p0SlackEscalationDue(row, { nowMs: Date.parse('2026-08-18T00:03:00.000Z'), repeatMs: 180_000 }).due, true);
  assert.equal(p0SlackEscalationDue({ ...row, status: 'done' }, { nowMs: Date.parse('2026-08-18T01:00:00.000Z') }).due, false);
});

test('P0 Slack escalation claim is durable and produces a deterministic Slack message id', () => {
  const row = {
    id: 'p0-row', status: 'open', customer_name: '백남준', title: '즉시 확인',
    payload: {
      alert_level: 'p0', alert_reason: '금액 또는 장비 사고',
      slack_delivery: { status: 'delivered', channel_id: 'CINV', message_ts: '100.1', thread_ts: '100.1', delivered_at: '2026-08-18T00:00:00.000Z' }
    }
  };
  const first = buildP0SlackEscalationClaim(row, { nowMs: Date.parse('2026-08-18T00:03:00.000Z'), repeatMs: 180_000 });
  const retry = buildP0SlackEscalationClaim(row, { nowMs: Date.parse('2026-08-18T00:03:00.000Z'), repeatMs: 180_000 });
  assert.equal(first.attempt, 1);
  assert.equal(first.clientMessageId, retry.clientMessageId);
  assert.match(first.clientMessageId, /^[0-9a-f-]{36}$/);
  const message = buildP0SlackEscalationMessage(row, first, { mentionUserIds: ['UOWNER'] });
  assert.match(message.text, /<!channel>/);
  assert.match(message.text, /<@UOWNER>/);
  assert.equal(message.thread_ts, '100.1');
  assert.equal(message.reply_broadcast, true);
  assert.equal(message.client_msg_id, first.clientMessageId);
});

test('P0 Slack escalation backs off exponentially and stops at the attempt cap', () => {
  const base = {
    id: 'p0-row', status: 'open', customer_name: '백남준', title: '즉시 확인',
    payload: {
      alert_level: 'p0', alert_reason: '금액 또는 장비 사고',
      slack_delivery: { status: 'delivered', channel_id: 'CINV', message_ts: '100.1', thread_ts: '100.1', delivered_at: '2026-08-18T00:00:00.000Z' }
    }
  };
  assert.equal(p0SlackEscalationBackoffMs(0, 600_000, 3_600_000), 600_000);
  assert.equal(p0SlackEscalationBackoffMs(1, 600_000, 3_600_000), 1_200_000);
  assert.equal(p0SlackEscalationBackoffMs(2, 600_000, 3_600_000), 2_400_000);
  assert.equal(p0SlackEscalationBackoffMs(6, 600_000, 3_600_000), 3_600_000);
  const afterFirst = {
    ...base,
    payload: { ...base.payload, critical_delivery: { status: 'delivered', attempt: 1, last_sent_at: '2026-08-18T00:10:00.000Z' } }
  };
  assert.equal(p0SlackEscalationDue(afterFirst, { nowMs: Date.parse('2026-08-18T00:29:59.000Z'), repeatMs: 600_000 }).due, false);
  assert.equal(p0SlackEscalationDue(afterFirst, { nowMs: Date.parse('2026-08-18T00:30:00.000Z'), repeatMs: 600_000 }).due, true);
  const exhausted = {
    ...base,
    payload: { ...base.payload, critical_delivery: { status: 'delivered', attempt: 159, last_sent_at: '2026-08-18T00:10:00.000Z' } }
  };
  assert.equal(p0SlackEscalationDue(exhausted, { nowMs: Date.parse('2026-08-19T00:00:00.000Z') }).reason, 'max_attempts');
  assert.equal(p0SlackEscalationDue(base, { nowMs: Date.parse('2026-08-19T00:00:00.000Z'), maxAttempts: 0 }).reason, 'disabled');
});

test('P0 escalation without an initial Slack card falls back to a standalone channel message', () => {
  const row = {
    id: 'p0-row-2', status: 'open', customer_name: '김손님', title: '즉시 확인',
    created_at: '2026-08-18T00:00:00.000Z', updated_at: '2026-08-18T00:00:00.000Z',
    payload: { alert_level: 'p0', alert_reason: '초기 카드 전달 실패' }
  };
  const due = p0SlackEscalationDue(row, { nowMs: Date.parse('2026-08-18T00:10:00.000Z'), repeatMs: 600_000 });
  assert.equal(due.due, true);
  const claim = buildP0SlackEscalationClaim(row, { nowMs: Date.parse('2026-08-18T00:10:00.000Z'), repeatMs: 600_000 });
  const message = buildP0SlackEscalationMessage(row, claim, { mentionUserIds: ['UOWNER'], fallbackChannelId: 'CFOLLOWUP' });
  assert.equal(message.channel, 'CFOLLOWUP');
  assert.equal(message.thread_ts, undefined);
  assert.equal(message.reply_broadcast, false);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('slow Hermes decisions release the DOM lane for another room and manual sends', async () => {
  const firstDecision = deferred();
  const events = [];
  let domActive = 0;
  let maxDomActive = 0;
  let decisionActive = 0;
  let maxDecisionActive = 0;
  const withDomProbe = async (label, value) => {
    domActive += 1;
    maxDomActive = Math.max(maxDomActive, domActive);
    events.push(`${label}:start`);
    await new Promise((resolve) => setImmediate(resolve));
    events.push(`${label}:end`);
    domActive -= 1;
    return value;
  };
  const scheduler = createKakaoPhaseScheduler({
    decisionConcurrency: 2,
    capture: async (job) => withDomProbe(`capture:${job.roomKey}`, { job }),
    decide: async (snapshot) => {
      decisionActive += 1;
      maxDecisionActive = Math.max(maxDecisionActive, decisionActive);
      try {
        if (snapshot.job.roomKey === 'A') await firstDecision.promise;
        return { snapshot };
      } finally {
        decisionActive -= 1;
      }
    },
    apply: async (prepared) => withDomProbe(`apply:${prepared.snapshot.job.roomKey}`, prepared),
    finalize: async (applied) => applied,
    manualSend: async (payload) => withDomProbe('manual', { sent: true, payload })
  });

  const roomA = scheduler.run({ roomKey: 'A' });
  await new Promise((resolve) => setImmediate(resolve));
  const roomB = scheduler.run({ roomKey: 'B' });
  const manual = scheduler.runManual({ text: 'staff reply' });

  const [roomBResult, manualResult] = await Promise.all([roomB, manual]);
  assert.equal(roomBResult.snapshot.job.roomKey, 'B');
  assert.equal(manualResult.sent, true);
  assert.equal(maxDomActive, 1, 'capture/apply/manual DOM work must stay serial');
  assert.equal(maxDecisionActive, 2, 'two rooms may think concurrently');
  assert.ok(!events.includes('apply:A:start'), 'room A is still thinking');
  assert.equal(typeof roomBResult.phaseTimings.captureQueueMs, 'number');
  assert.equal(typeof roomBResult.phaseTimings.decisionMs, 'number');
  assert.equal(typeof roomBResult.phaseTimings.applyMs, 'number');
  assert.equal(typeof roomBResult.phaseTimings.totalMs, 'number');

  firstDecision.resolve();
  await roomA;
});

test('phase scheduler propagates a bridge deadline into an active Hermes decision', async () => {
  const controller = new AbortController();
  const deadlineError = new Error('bridge deadline exceeded');
  const scheduler = createKakaoPhaseScheduler({
    capture: async (job) => ({ job }),
    decide: async (snapshot, job, options = {}) => {
      if (!options.signal) throw new Error('missing phase abort signal');
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    },
    apply: async (prepared) => prepared,
    finalize: async (applied) => applied,
    manualSend: async (payload) => payload
  });

  const run = scheduler.run({ roomKey: 'deadline-room' }, { signal: controller.signal });
  controller.abort(deadlineError);

  await assert.rejects(run, (error) => error === deadlineError);
});

test('phase scheduler enforces the configured end-to-end worker timeout', async () => {
  const scheduler = createKakaoPhaseScheduler({
    workerTimeoutMs: 20,
    capture: async (job) => ({ job }),
    decide: async (snapshot, job, options = {}) => {
      if (!options.signal) {
        await new Promise((resolve) => setTimeout(resolve, 60));
        return { snapshot };
      }
      return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    },
    apply: async (prepared) => prepared,
    finalize: async (applied) => applied,
    manualSend: async (payload) => payload
  });

  await assert.rejects(
    scheduler.run({ roomKey: 'timed-room' }),
    /worker timed out after 20ms/
  );
});

test('worker result audit keeps phase timings and AI attempt counts without customer payload', () => {
  const audit = buildWorkerResultAudit({
    status: 'ai_completed',
    hermesAttempts: 3,
    hermesRecovered: true,
    timings: { lookupMs: 100, hermesMs: 2000, sheetAndReconciliationMs: 500, totalMs: 2600 },
    phaseTimings: { captureQueueMs: 4, captureMs: 50, decisionQueueMs: 8, decisionMs: 2600, applyQueueMs: 2, applyMs: 30, finalizeMs: 20, totalMs: 2714 },
    decision: { reason: 'private customer content' },
    snapshot: { navigation: { conversation_evidence: { visible_static_text_tail: 'private chat' } } }
  }, 2714);
  const record = compactQueueAuditRecord('worker-results.ndjson', {
    at: '2026-08-18T00:00:00.000Z',
    jobId: 'dom-test',
    result: { code: 0, signal: null, timedOut: false, stdout: 'private stdout', stderr: '', audit }
  });

  assert.deepEqual(record.result.audit, audit);
  assert.equal(record.result.audit.status, 'ai_completed');
  assert.equal(record.result.audit.phaseTimings.decisionMs, 2600);
  assert.doesNotMatch(JSON.stringify(record.result.audit), /private|customer|chat/);
});

test('room revisions ignore unread-badge duplicates and supersede older semantic turns', () => {
  const versions = new Map();
  const first = registerAcceptedRoomEvent(versions, 'chat:1', '홍길동 문의 오후 1:00');
  const duplicate = registerAcceptedRoomEvent(versions, 'chat:1', '홍길동 문의 오후 1:00');
  const newer = registerAcceptedRoomEvent(versions, 'chat:1', '홍길동 추가 문의 오후 1:01');

  assert.equal(first.revision, 1);
  assert.equal(duplicate.revision, 1);
  assert.equal(duplicate.changed, false);
  assert.equal(newer.revision, 2);
  assert.equal(newer.changed, true);
});

test('identical reply text at a later displayed time is a new room revision', () => {
  const earlier = semanticRoomEventIdentity({ previewText: '홍길동 네', displayTime: '오전 9:10' });
  const unreadMutation = semanticRoomEventIdentity({ previewText: '홍길동 2 네', displayTime: '오전 9:10' });
  const later = semanticRoomEventIdentity({ previewText: '홍길동 네', displayTime: '오전 9:25' });

  assert.equal(unreadMutation, earlier);
  assert.notEqual(later, earlier);
});

test('a superseded phase result stays superseded in the durable event row', () => {
  assert.deepEqual(mapWorkerPayloadToSupabaseStatus({
    status: 'superseded_by_newer_room_event',
    decision: { should_write_to_sheet: true },
    sheetResult: { success: true }
  }), {
    status: 'superseded_by_newer_room_event',
    error_message: null
  });
});

test('production queue uses the phase scheduler and publishes freshness before durable writes', async () => {
  const source = await readFile(new URL('./server.mjs', import.meta.url), 'utf8');
  assert.match(source, /CONFIG\.aiDomSplitEnabled\s*\?\s*run\(\)\s*:\s*workerChain\.then/);
  assert.match(source, /getKakaoPhaseScheduler\(\)\.runManual/);
  assert.match(source, /url\.pathname === '\/worker\/freshness'/);
  const revisionIndex = source.indexOf('registerAcceptedRoomEvent(state.roomVersions');
  const supabaseIndex = source.indexOf("await writeSupabaseEvent(event, 'event')", revisionIndex);
  assert.ok(revisionIndex >= 0 && supabaseIndex > revisionIndex, 'freshness revision must advance before Supabase latency');
  assert.match(source, /readBooleanEnvironment\(process\.env\.KAKAO_AI_DOM_SPLIT_ENABLED, false\)/);
  assert.match(source, /getKakaoPhaseScheduler\(\)\.runManual\(\{[\s\S]*?cleanupIdleKakaoConversationTabs\('worker_finished'/);
});

test('health config exposes the live safety contract used by supervised restarts', async () => {
  assert.deepEqual(buildHealthConfig({
    workerLive: true,
    autoSendEnabled: true,
    workerDryRun: false,
    windowsWritesEnabled: true,
    startupCatchupSupported: true
  }), {
    workerLive: true,
    autoSendEnabled: true,
    workerDryRun: false,
    windowsWritesEnabled: true,
    startupCatchupSupported: true
  });

  const source = await readFile(new URL('./server.mjs', import.meta.url), 'utf8');
  assert.match(source, /startupCatchupSupported:\s*true/);
  assert.doesNotMatch(
    source,
    /startupCatchupSupported:\s*process\.env\.PROCESS_INITIAL_SCAN/,
    'catch-up capability is independent from whether initial-scan events are currently processed'
  );
});

test('bridge-created failure cards forward configured Slack mention recipients', async () => {
  const source = await readFile(new URL('./server.mjs', import.meta.url), 'utf8');
  assert.match(
    source,
    /slackMentionUserIds:\s*String\(process\.env\.SLACK_CARD_MENTION_USER_IDS/
  );
});

test('stable Kakao chat identity survives normalization and debounce grouping', () => {
  const first = normalizeEvent({
    roomKey: 'chat:4978438284325090',
    customerName: '김정태',
    messagePreview: '첫 문의',
    displayTime: '오후 2:51',
    previewText: '중요 김정태 1 첫 문의 오후 2:51',
    eventHash: 'event-1'
  });
  const second = normalizeEvent({
    roomKey: 'chat:4978438284325090',
    customerName: '김정태',
    messagePreview: '추가 문의',
    displayTime: '오후 2:52',
    previewText: '중요 김정태 2 추가 문의 오후 2:52',
    eventHash: 'event-2'
  });

  assert.equal(first.customerName, '김정태');
  assert.equal(first.messagePreview, '첫 문의');
  assert.equal(first.displayTime, '오후 2:51');
  assert.equal(roomKeyForDebounce(first), 'chat:4978438284325090');
  assert.equal(roomKeyForDebounce(second), 'chat:4978438284325090');
});

test('queued jobs for one chat coalesce into the newest AI read instead of piling up', () => {
  const previous = {
    jobId: 'old-job',
    roomKey: 'chat:4978438284325090',
    firstEventAt: '2026-07-23T05:00:00.000Z',
    lastEventAt: '2026-07-23T05:01:00.000Z',
    previewText: '첫 문의',
    events: [{ eventHash: 'event-1', previewText: '첫 문의' }]
  };
  const latest = {
    jobId: 'new-job',
    roomKey: 'chat:4978438284325090',
    customerName: '김정태',
    firstEventAt: '2026-07-23T05:02:00.000Z',
    lastEventAt: '2026-07-23T05:03:00.000Z',
    previewText: '추가 문의',
    events: [{ eventHash: 'event-2', previewText: '추가 문의' }]
  };

  assert.deepEqual(mergeQueuedRoomJobs(previous, latest), {
    ...latest,
    firstEventAt: previous.firstEventAt,
    eventCount: 2,
    events: [...previous.events, ...latest.events]
  });
});

test('bridge queue replaces pending same-room work and cleans conversation tabs after every worker', async () => {
  const source = await readFile(new URL('./server.mjs', import.meta.url), 'utf8');
  assert.match(source, /const queuedWorkerSlotsByRoom = new Map\(\)/);
  assert.match(source, /superseded_by_newer_room_event/);
  assert.match(source, /cleanupIdleKakaoConversationTabs\('worker_finished', \{ allowQueued: true \}\)/);
});

test('stable job identity ignores a disappearing Kakao unread badge for the same message', async () => {
  const { semanticPreviewIdentity } = await import('./server.mjs');
  assert.equal(
    semanticPreviewIdentity('중요 김명선 2 여쭤볼라했는데 전원이 꺼져있어서 카톡으로 남겨드립니다! 오후 4:17'),
    semanticPreviewIdentity('중요 김명선 여쭤볼라했는데 전원이 꺼져있어서 카톡으로 남겨드립니다! 오후 4:17')
  );
});

test('CORS preflight permits Chrome private-network access to the loopback bridge', () => {
  assert.equal(buildCorsHeaders()['access-control-allow-private-network'], 'true');
});

test('Windows workers stay in the owned tree and timeout cleanup targets the whole tree', () => {
  assert.equal(shouldDetachWorkerProcess('win32'), false);
  assert.equal(shouldDetachWorkerProcess('linux'), true);
  assert.deepEqual(buildWorkerTreeKillInvocation(1234, 'SIGTERM', 'win32'), {
    command: 'taskkill.exe',
    args: ['/PID', '1234', '/T'],
    options: { shell: false, stdio: 'ignore', windowsHide: true }
  });
  assert.deepEqual(buildWorkerTreeKillInvocation(1234, 'SIGKILL', 'win32'), {
    command: 'taskkill.exe',
    args: ['/PID', '1234', '/T', '/F'],
    options: { shell: false, stdio: 'ignore', windowsHide: true }
  });
  assert.equal(buildWorkerTreeKillInvocation(1234, 'SIGTERM', 'linux'), null);
});

test('generic DOM unreadSignal does not turn a read top-row backstop into a worker job', () => {
  const staleOutgoingRow = {
    reason: 'top_rows_backstop',
    previewText: '중요 임우혁 네, 예약 정보 확인해보겠습니다! 오전 10:31',
    unreadCount: null,
    raw: { unreadSignal: true }
  };

  assert.equal(hasUnreadCount(staleOutgoingRow), false);
  assert.equal(shouldQueueTopRowEvent(staleOutgoingRow), false);
  assert.equal(shouldSkipSupabaseRowAsLowValue({
    status: 'ai_worker_error',
    preview_text: staleOutgoingRow.previewText,
    payload: {
      reason: 'top_rows_backstop',
      raw: { unreadSignal: true }
    }
  }), 'untrusted_backstop_row');
});

test('a counted unread top-row remains eligible for normal processing', () => {
  const unreadCustomerRow = {
    reason: 'top_rows_backstop',
    previewText: '중요 새고객 2 FX3 내일 대여 가능할까요? 오후 10:31',
    unreadCount: 2,
    raw: { unreadSignal: true }
  };

  assert.equal(hasUnreadCount(unreadCustomerRow), true);
  assert.equal(shouldQueueTopRowEvent(unreadCustomerRow), true);
  assert.equal(shouldSkipWorkerForPreview(unreadCustomerRow), '');
});

test('semantic-looking previews are never suppressed before Hermes sees the room', () => {
  const semanticPreviews = [
    '감사합니다',
    '빌리지님이 보냄 요청하신 통장 사본 전달드립니다',
    '입금했습니다',
    '네 가능합니다',
    '반납 완료했습니다'
  ];

  for (const previewText of semanticPreviews) {
    assert.equal(
      shouldSkipWorkerForPreview({
        reason: 'mutation',
        previewText,
        unreadCount: null
      }),
      '',
      `preview must reach Hermes: ${previewText}`
    );
  }
});

test('recovery only rejects untrusted historical rows, not message semantics', () => {
  for (const previewText of ['감사합니다', '입금했습니다', '운영자님이 보냄', '네 가능합니다']) {
    assert.equal(shouldSkipSupabaseRowAsLowValue({
      status: 'ai_worker_error',
      preview_text: previewText,
      payload: {
        reason: 'mutation',
        raw: { unreadSignal: false }
      }
    }), '');
  }
});

test('a meaningful live top-row change remains eligible without an unread counter', () => {
  const now = new Date();
  const hour = now.getHours() % 12 || 12;
  const minute = String(now.getMinutes()).padStart(2, '0');
  const period = now.getHours() < 12 ? '오전' : '오후';
  const liveCustomerRow = {
    reason: 'top_row_changed',
    previewText: `새고객 FX3 내일 대여 가능할까요? ${period} ${hour}:${minute}`,
    unreadCount: null,
    raw: { unreadSignal: false }
  };

  assert.equal(hasUnreadCount(liveCustomerRow), false);
  assert.equal(shouldQueueTopRowEvent(liveCustomerRow), true);
});

test('server keeps Gateway HTTP disabled by default and dispatches it before public routes', async () => {
  const source = await readFile(new URL('./server.mjs', import.meta.url), 'utf8');
  assert.match(source, /hermesTransport:\s*String\(process\.env\.KAKAO_HERMES_TRANSPORT\s*\|\|\s*'cli'\)\.trim\(\)\s*\|\|\s*'cli'/);
  assert.match(source, /hermesBridgeToken:\s*String\(process\.env\.KAKAO_HERMES_BRIDGE_TOKEN\s*\|\|\s*''\)\.trim\(\)/);
  assert.match(source, /KAKAO_HERMES_LEASE_MS/);
  assert.match(source, /KAKAO_HERMES_MAX_ATTEMPTS/);
  assert.match(source, /createHermesGatewayHttpHandler/);
  assert.ok(source.indexOf('gatewayHttpHandler(req, res, url)') < source.indexOf("url.pathname === '/health'"));
});
