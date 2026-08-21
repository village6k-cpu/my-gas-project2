import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { customerClusterHash } from './follow-up-policy.mjs';
import * as workerModule from './worker.mjs';

import {
  buildBrainContext,
  buildHermesPrompt,
  calcRentalDaysForQuote,
  extractJsonObject,
  buildSheetAppendPayload,
  buildFollowUpRows,
  buildSheetFailureFollowUpRows,
  buildSheetAvailabilityReport,
  enrichFollowUpRowsWithSheetAvailability,
  buildHermesPostActionPrompt,
  validateAiPostActionDecisionContract,
  runHermesPostActionDecision,
  suppressDecisionForUnreconciledSheetResult,
  fetchExistingConfirmRequestResultForDecision,
  extractConfirmRequestIds,
  mapDecisionToStatusPatch,
  buildGasReadUrl,
  buildReadOnlyRagContext,
  parseVillageAiSse,
  askVillageAi,
  processRagLookup,
  requireConfig,
  buildReadOnlyLookupContext,
  buildHermesArgs,
  hermesDecisionTimeoutFromEnv,
  deriveVillageGasInternalKey,
  resolveHermesCommand,
  resolveCuaDriverCommand,
  normalizeKakaoWorkerControlMode,
  parseMacHidIdleSeconds,
  checkKakaoCuaFallbackAllowed,
  buildKakaoTabAppleScript,
  ensureKakaoChannelManagerTabViaDevtools,
  ensureKakaoChannelManagerTab,
  kakaoDevtoolsBaseUrlFromEnv,
  pickKakaoMainListTarget,
  pickKakaoMainListWindow,
  pickKakaoConversationWindow,
  pickKakaoConversationTarget,
  findChatRowElementIndex,
  findKakaoChatSearchInputElementIndex,
  extractKakaoConversationEvidence,
  classifyConservativeTerminalAcknowledgement,
  openKakaoTargetChatViaDevtools,
  openKakaoTargetChatFromList,
  extractNavigationHints,
  buildCompactJobForPrompt,
  canAutoSendCustomerAnswer,
  canAutoSendCustomerDocumentAssets,
  isCustomerDocumentAssetRequest,
  customerDocumentAssetsAlreadySent,
  normalizeConfirmRequestTimeForSheet,
  normalizeConfirmRequestWindowForSheet,
  mergeAdditionsOnlySheetPayloadWithExistingRequest,
  mutablePolicyAutoReplyRisk,
  currentConfirmedPolicyAutoReplySupport,
  loadCurrentConfirmedPolicyConfig,
  resetCurrentConfirmedPolicyConfigCache,
  autoReplyRequiresRagSupport,
  buildAutoReplyRagQuestion,
  evaluateAutoReplyRagSupport,
  isAutoSendEligibleLiveJob,
  buildAutoReplyDedupeKey,
  buildRoomReplyDedupeKey,
  hasRecentSentAutoReply,
  buildRecentBotSendsPromptText,
  isKakaoUiPlaceholderLine,
  filterFollowUpRowsAfterAutoReply,
  filterFollowUpRowsAgainstClosedHistory,
  mergeFollowUpRowsByTopic,
  upsertFollowUpRows,
  buildInquiryCaseRow,
  buildCanonicalFollowUpCases,
  upsertFollowUpCaseRows,
  upsertInquiryCaseRow,
  upsertManualFollowUpRows,
  routeFollowUpToSlack,
  buildSlackRoutingConfig,
  preflightTwoChannelSlackRouting,
  enrichFollowUpRowWithOperationalCalculations,
  buildSlackFollowUpMessage,
  isP0FollowUp,
  buildSlackFollowUpCaseMessage,
  buildSlackManualTaskMessage,
  buildSlackInquiryMessage,
  resolveSlackChannelId,
  claimInitialSlackDelivery,
  deliverSlackFollowUpRows,
  findKakaoMessageInputElementIndex,
  findKakaoSendButtonElementIndex,
  kakaoConversationContainsMessage,
  sendKakaoMessageViaChrome,
  sendKakaoMessageViaDevtools,
  shouldDetachHermesProcess,
  terminateChildTree,
  runHermes,
  createJobFreshnessGuard,
  createImmutableKakaoRoomSnapshot,
  applyPreparedKakaoDecision,
  finalizePreparedKakaoDecision,
  isJobSupersededByJobLog,
  buildHermesFinalJsonRecoveryPrompt,
  describeHermesDecisionFailure,
  runHermesDecision,
  createWorkerTimingRecorder,
  validateAiDecisionContract,
  appendToSheet,
  normalizeCustomerDbDiscountType,
  lookupCustomerDbDiscountForRequest,
  enrichSheetPayloadWithCustomerDbDiscount,
  ensureConfirmRequestDiscountApplied,
  normalizeConfirmRequestDateForSheet,
  buildCloseKakaoConversationWindowAppleScript,
  closeKakaoConversationWindow,
  closeKakaoConversationTargetViaDevtools,
  runCli
} from './worker.mjs';

test('worker derives the same internal GAS key from its existing service-role secret', () => {
  const secret = 'service-role-test-secret-123';
  const derived = deriveVillageGasInternalKey(secret);
  assert.equal(derived, '-PKxkeZbEpJ49suEszVienz5K7yh2Vgq-f4ddpigOgM');
  assert.notEqual(derived, secret);
  assert.throws(() => deriveVillageGasInternalKey('too-short'), /service role/i);
});

test('Kakao room snapshots are immutable and contain no live DOM handles', () => {
  const snapshot = createImmutableKakaoRoomSnapshot({
    job: { jobId: 'job-1', roomKey: 'chat:1', roomRevision: 3, previewText: '새 문의' },
    capturedAt: '2026-08-18T00:00:00.000Z',
    navigationContext: {
      status: 'opened_conversation',
      already_open: true,
      conversation_target: { id: 'target-secret', webSocketDebuggerUrl: 'ws://live-handle' },
      conversation_window: { pid: 1234, window_id: 99, element_index: 44 },
      search: { attempted: true, query: '고객명', element_index: 88 },
      conversation_evidence: {
        source: 'devtools',
        title: '고객명',
        hint_matched: true,
        hints: ['고객명'],
        visible_static_text_tail: '고객: 문의합니다',
        note: 'captured'
      }
    }
  });

  assert.equal(snapshot.schema, 'kakao-room-snapshot/v1');
  assert.equal(snapshot.roomRevision, 3);
  assert.equal(typeof snapshot.evidenceHash, 'string');
  assert.equal(snapshot.evidenceHash.length, 64);
  assert.equal(snapshot.navigation.conversation_evidence.title, '고객명');
  assert.equal(JSON.stringify(snapshot).includes('target-secret'), false);
  assert.equal(JSON.stringify(snapshot).includes('ws://'), false);
  assert.equal(JSON.stringify(snapshot).includes('element_index'), false);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.navigation.conversation_evidence), true);
  assert.throws(() => { snapshot.navigation.status = 'mutated'; }, TypeError);
});

test('buildKakaoGatewayTurn builds a bounded credential-safe native Hermes event from read-only evidence', async () => {
  const job = {
    jobId: 'gateway-job-1',
    roomKey: 'chat:gateway-1',
    roomRevision: 7,
    detectedAt: '2026-08-21T01:02:03.000Z',
    previewText: 'FX3 내일 가능할까요?'
  };
  const snapshot = createImmutableKakaoRoomSnapshot({
    job,
    capturedAt: '2026-08-21T01:02:04.000Z',
    navigationContext: {
      status: 'opened_target_chat',
      conversation_evidence: {
        source: 'devtools',
        title: '고객님',
        hint_matched: true,
        visible_static_text_tail: '고객: FX3 내일 가능할까요?'
      }
    }
  });
  const turn = await workerModule.buildKakaoGatewayTurn({
    config: {
      gasApiUrl: 'https://script.example/exec',
      sheetApiKey: 'internal-sheet-secret',
      bridgeUrl: '',
      jobLogPath: '',
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ data: [['active']] })
      })
    },
    job,
    capture: { snapshot }
  });

  assert.deepEqual(Object.keys(turn).sort(), ['event', 'internal']);
  assert.deepEqual(Object.keys(turn.event).sort(), ['detected_at', 'job_id', 'prompt', 'raw', 'room_key', 'room_revision', 'schema']);
  assert.equal(turn.event.schema, 'village-kakao-gateway-event/v1');
  assert.equal(turn.event.job_id, 'gateway-job-1');
  assert.equal(turn.event.room_key, 'chat:gateway-1');
  assert.equal(turn.event.room_revision, 7);
  assert.equal(turn.event.detected_at, '2026-08-21T01:02:03.000Z');
  assert.match(turn.event.prompt, /FINAL_JSON/);
  assert.match(turn.event.prompt, /AI-first Kakao rental-shop worker task/);
  assert.match(turn.event.prompt, /village_confirmation_request/);
  assert.equal(turn.internal.snapshot, snapshot);
  assert.equal(turn.internal.lookupContext.kill_switch.status, 'active');
  assert.deepEqual(turn.event.raw.evidence.lookup.kill_switch, { status: 'active', error: null });
  assert.ok(Buffer.byteLength(JSON.stringify(turn.event), 'utf8') <= 1_048_576);
  assert.equal(JSON.stringify(turn.event).includes('internal-sheet-secret'), false);
});

test('buildKakaoGatewayTurn never invokes Hermes, mutation, delivery, follow-up, or Slack dependencies', async () => {
  const job = {
    jobId: 'gateway-job-read-only',
    roomKey: 'chat:gateway-read-only',
    roomRevision: 3,
    detectedAt: '2026-08-21T01:02:03.000Z',
    previewText: '정책 문의'
  };
  const snapshot = createImmutableKakaoRoomSnapshot({ job, capturedAt: '2026-08-21T01:02:04.000Z' });
  const forbidden = [
    'runHermesDecision',
    'appendToSheet',
    'sendReply',
    'insertFollowUpRows',
    'deliverSlackFollowUpRows'
  ];
  const dependencies = Object.fromEntries(forbidden.map((name) => [name, async () => {
    throw new Error(`${name} must not be called while building a Gateway turn`);
  }]));

  const turn = await workerModule.buildKakaoGatewayTurn({
    config: {
      gasApiUrl: 'https://script.example/exec',
      sheetApiKey: 'internal-sheet-secret',
      bridgeUrl: '',
      jobLogPath: '',
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ data: [['paused']] }) })
    },
    job,
    capture: { snapshot },
    dependencies
  });

  assert.equal(turn.internal.lookupContext.kill_switch.status, 'paused');
});

test('buildKakaoGatewayTurn keeps adversarial internal lookup evidence out of the bounded plugin event', async () => {
  const job = {
    jobId: 'gateway-job-large-internal', roomKey: 'chat:gateway-large', roomRevision: 4,
    detectedAt: '2026-08-21T01:02:03.000Z', previewText: '정책 문의'
  };
  const snapshot = createImmutableKakaoRoomSnapshot({ job, capturedAt: '2026-08-21T01:02:04.000Z' });
  const oversizedSecret = `internal-lookup-secret-${'x'.repeat(1_100_000)}`;
  const lookupContext = {
    generated_at: '2026-08-21T01:02:05.000Z',
    job_preview_text: oversizedSecret,
    kill_switch: { status: 'active', error: null },
    lookup_policy: { mode: 'read_only', allowed_methods: ['GET'], forbidden_actions: ['write'] },
    lookup_tool: { command: 'read-only', stdin_schema: { queries: [{ domain: 'schedule', query: 'term', column: 'A' }] }, domains: ['schedule'], max_queries: 1, behavior: 'read only' },
    lookup_urls: { private_template: oversizedSecret },
    note: oversizedSecret
  };
  const turn = await workerModule.buildKakaoGatewayTurn({
    config: { bridgeUrl: '', jobLogPath: '' },
    job,
    capture: { snapshot },
    dependencies: { buildReadOnlyLookupContext: async () => lookupContext }
  });

  assert.equal(turn.internal.lookupContext, lookupContext);
  assert.equal(turn.internal.lookupContext.lookup_urls.private_template, oversizedSecret);
  assert.ok(Buffer.byteLength(JSON.stringify(turn.event), 'utf8') <= 1_048_576);
  assert.equal(JSON.stringify(turn.event).includes('internal-lookup-secret-'), false);
});

test('buildKakaoGatewayTurn rejects job coordinates that do not exactly match the immutable snapshot before reads', async () => {
  const snapshotJob = {
    jobId: 'snapshot-job', roomKey: 'chat:snapshot', roomRevision: 5,
    detectedAt: '2026-08-21T01:02:03.000Z', previewText: '문의'
  };
  const snapshot = createImmutableKakaoRoomSnapshot({ job: snapshotJob, capturedAt: '2026-08-21T01:02:04.000Z' });
  for (const [job, reason] of [
    [{ ...snapshotJob, jobId: 'other-job' }, 'job_id'],
    [{ ...snapshotJob, roomKey: 'chat:other' }, 'room_key'],
    [{ ...snapshotJob, roomRevision: 6 }, 'room_revision']
  ]) {
    let reads = 0;
    await assert.rejects(
      workerModule.buildKakaoGatewayTurn({
        config: { bridgeUrl: '', jobLogPath: '' },
        job,
        capture: { snapshot },
        dependencies: { buildReadOnlyLookupContext: async () => { reads += 1; return {}; } }
      }),
      new RegExp(`${reason}.*snapshot`, 'i')
    );
    assert.equal(reads, 0);
  }
});

test('buildKakaoGatewayTurn fails closed when prompt evidence would exceed the plugin body cap', async () => {
  const job = {
    jobId: 'gateway-job-over-cap', roomKey: 'chat:gateway-over-cap', roomRevision: 8,
    detectedAt: '2026-08-21T01:02:03.000Z', previewText: '문의'
  };
  const snapshot = createImmutableKakaoRoomSnapshot({ job, capturedAt: '2026-08-21T01:02:04.000Z' });
  await assert.rejects(
    workerModule.buildKakaoGatewayTurn({
      config: { bridgeUrl: '', jobLogPath: '' },
      job,
      capture: { snapshot },
      dependencies: {
        buildReadOnlyLookupContext: async () => ({ kill_switch: { status: 'active', error: null } }),
        buildHermesPrompt: () => `FINAL_JSON ${'x'.repeat(1_048_576)}`
      }
    }),
    /exceeds 1048576 byte limit/i
  );
});

test('buildKakaoGatewayTurn fails closed when non-ASCII event JSON exceeds the plugin ASCII body cap', async () => {
  const job = {
    jobId: 'gateway-job-ascii-cap', roomKey: 'chat:gateway-ascii-cap', roomRevision: 9,
    detectedAt: '2026-08-21T01:02:03.000Z', previewText: '문의'
  };
  const snapshot = createImmutableKakaoRoomSnapshot({ job, capturedAt: '2026-08-21T01:02:04.000Z' });
  await assert.rejects(
    workerModule.buildKakaoGatewayTurn({
      config: { bridgeUrl: '', jobLogPath: '' },
      job,
      capture: { snapshot },
      dependencies: {
        buildReadOnlyLookupContext: async () => ({ kill_switch: { status: 'active', error: null } }),
        buildHermesPrompt: () => `FINAL_JSON ${'가'.repeat(180_000)}`
      }
    }),
    /exceeds 1048576 byte limit/i
  );
});

test('Gateway extraction and legacy dry-run each perform one freshness check while legacy keeps the full lookup context', async () => {
  const job = {
    jobId: 'gateway-job-freshness', roomKey: 'chat:gateway-freshness', roomRevision: 6,
    detectedAt: '2026-08-21T01:02:03.000Z', previewText: '문의'
  };
  const snapshot = createImmutableKakaoRoomSnapshot({ job, capturedAt: '2026-08-21T01:02:04.000Z' });
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(String(url));
    if (String(url).includes('/worker/freshness')) return { ok: true, status: 200, text: async () => JSON.stringify({ current: true }) };
    return { ok: true, status: 200, text: async () => JSON.stringify({ data: [['active']] }) };
  };
  const config = {
    bridgeUrl: 'http://127.0.0.1:8787', jobLogPath: '', gasApiUrl: 'https://script.example/exec',
    sheetApiKey: 'legacy-internal-key', fetchImpl
  };

  await workerModule.buildKakaoGatewayTurn({ config, job, capture: { snapshot } });
  assert.equal(calls.filter((url) => url.includes('/worker/freshness')).length, 1);

  calls.length = 0;
  const prepared = await workerModule.prepareKakaoDecisionFromSnapshot({ config, job, capture: { snapshot }, dryRun: true });
  assert.equal(calls.filter((url) => url.includes('/worker/freshness')).length, 1);
  assert.match(prepared.lookupContext.lookup_urls.kill_switch_read, /legacy-internal-key/);
});

function gatewayDecisionFixture(overrides = {}) {
  const base = {
    classification: 'faq',
    confidence: 'high',
    should_write_to_sheet: false,
    kill_switch_observed: 'active',
    customer: { name: '테스트 고객' },
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      latest_customer_message_after_last_staff_reply: true
    },
    follow_up_items: [],
    suggested_reply_draft: '빌리지 운영시간은 오전 10시부터 오후 7시까지입니다.',
    reply_decision: {
      replyMode: 'auto_send',
      text: '빌리지 운영시간은 오전 10시부터 오후 7시까지입니다.',
      confidence: 'high',
      reason: '현재 확인된 운영 정책',
      shouldCreateTask: false,
      safetyClass: 'current_policy_answer',
      grounding: 'current_confirmed_policy',
      requiresRag: false,
      attachmentKeys: [],
      alreadyDelivered: false
    }
  };
  return {
    ...base,
    ...overrides,
    safety_checks: { ...base.safety_checks, ...(overrides.safety_checks || {}) },
    reply_decision: { ...base.reply_decision, ...(overrides.reply_decision || {}) }
  };
}

function gatewayTurnFixture() {
  const job = {
    jobId: 'gateway-final-job-1',
    roomKey: 'chat:gateway-final-1',
    roomRevision: 7,
    detectedAt: '2026-08-21T02:00:00.000Z',
    previewText: '문의합니다'
  };
  const snapshot = createImmutableKakaoRoomSnapshot({
    job,
    capturedAt: '2026-08-21T02:00:01.000Z',
    navigationContext: {
      status: 'opened_conversation',
      conversation_evidence: {
        source: 'devtools', title: '테스트 고객', hint_matched: true,
        visible_static_text_tail: '고객: 문의합니다'
      }
    }
  });
  return {
    job,
    turn: {
      event: {
        schema: 'village-kakao-gateway-event/v1', job_id: job.jobId,
        room_key: job.roomKey, room_revision: job.roomRevision,
        detected_at: job.detectedAt, prompt: 'FINAL_JSON', raw: {}
      },
      internal: {
        snapshot,
        lookupContext: { kill_switch: { status: 'active', error: null } },
        ragContext: null,
        brainContext: null
      }
    }
  };
}

function confirmationReceiptFixture(job, overrides = {}) {
  return {
    schema: 'village-confirmation-receipt/v1',
    receipt_id: 'receipt-gateway-final-1',
    job_id: job.jobId,
    room_key: job.roomKey,
    room_revision: job.roomRevision,
    status: 'ok',
    availability_report: [{ 장비명: '소니 FX3', 결과: '가능', 상세: '가용2' }],
    authoritative_sheet_result: {
      success: true,
      reqID: 'RQ-260821-001',
      results: [{ 장비명: '소니 FX3', 결과: '가능', 상세: '가용2' }]
    },
    created_at: '2026-08-21T02:00:02.000Z',
    error: null,
    ...overrides
  };
}

function scheduleDecisionFixture(overrides = {}) {
  return gatewayDecisionFixture({
    classification: 'reservation',
    owner_review_required: true,
    follow_up_items: [{
      type: 'schedule_check', route: 'schedule', taskKey: 'schedule:gateway-final-1',
      priority: 'high', status: 'open', title: '가용 확인 결과 검토',
      customer_name: '테스트 고객',
      summary: '소니 FX3 가용 결과를 확인했습니다.',
      recommended_action: '사장 확인 후 고객에게 안내',
      suggested_reply_draft: '요청 일정에 소니 FX3 사용이 가능합니다.',
      evidence: ['RQ-260821-001'], requiresHumanAction: true,
      actionFamily: 'inventory_check', businessKey: 'schedule:gateway-final-1', due_hint: 'now'
    }],
    authoritative_sheet_result: {
      status: 'available', reqID: 'RQ-260821-001',
      results: [{ 장비명: '소니 FX3', 결과: '가능', 상세: '가용2' }]
    },
    suggested_reply_draft: '요청 일정에 소니 FX3 사용이 가능합니다.',
    reply_decision: {
      replyMode: 'draft_only',
      text: '요청 일정에 소니 FX3 사용이 가능합니다.',
      confidence: 'high',
      reason: '확인요청 결과',
      shouldCreateTask: true,
      safetyClass: 'no_send',
      grounding: 'authoritative_sheet',
      requiresRag: false,
      attachmentKeys: [],
      alreadyDelivered: false
    },
    ...overrides
  });
}

test('prepareKakaoGatewayDecision leaves a valid FAQ eligible for existing auto-send gates without a tool receipt', async () => {
  const { job, turn } = gatewayTurnFixture();
  const decision = gatewayDecisionFixture();
  const prepared = await workerModule.prepareKakaoGatewayDecision({
    config: {}, job, turn, finalText: `FINAL_JSON\n${JSON.stringify(decision)}`, trustedToolReceipts: []
  });

  assert.equal(prepared.status, 'ai_prepared');
  assert.deepEqual(prepared.decision, decision);
  assert.equal(prepared.trustedToolReceipt, null);
  assert.deepEqual(prepared.availabilityAwareRows, []);
  assert.equal(canAutoSendCustomerAnswer(prepared.decision, { autoSendEnabled: true }).allowed, true);
});

test('trusted confirmation receipt always forces schedule owner review and attaches only receipt evidence', async () => {
  const { job, turn } = gatewayTurnFixture();
  const receipt = confirmationReceiptFixture(job);
  const decision = scheduleDecisionFixture({
    authoritative_sheet_result: { status: 'unavailable', source: 'fabricated-final-json' },
    owner_review_required: false,
    follow_up_items: [{
      ...scheduleDecisionFixture().follow_up_items[0],
      evidence: ['agent-fabricated-authority']
    }],
    reply_decision: { replyMode: 'auto_send', safetyClass: 'authoritative_availability_answer', shouldCreateTask: false }
  });
  const prepared = await workerModule.prepareKakaoGatewayDecision({
    config: {}, job, turn, finalText: `FINAL_JSON\n${JSON.stringify(decision)}`,
    trustedToolReceipts: [receipt],
    dependencies: {
      runHermesDecision: async () => { throw new Error('second Hermes call forbidden'); },
      runHermesPostActionDecision: async () => { throw new Error('post-action Hermes call forbidden'); }
    }
  });

  assert.equal(prepared.decision.reply_decision.replyMode, 'draft_only');
  assert.equal(prepared.decision.reply_decision.safetyClass, 'no_send');
  assert.equal(prepared.decision.reply_decision.grounding, 'authoritative_sheet');
  assert.equal(prepared.decision.reply_decision.requiresRag, false);
  assert.equal(prepared.decision.reply_decision.shouldCreateTask, true);
  assert.equal(prepared.decision.owner_review_required, true);
  assert.equal(prepared.decision.should_write_to_sheet, false);
  assert.deepEqual(prepared.decision.authoritative_sheet_result, receipt.authoritative_sheet_result);
  assert.equal(prepared.availabilityAwareRows.some((row) => row.payload?.follow_up_route === 'schedule'), true);
  assert.equal(prepared.availabilityAwareRows.some((row) => row.evidence?.includes('agent-fabricated-authority')), false);
  assert.equal(canAutoSendCustomerAnswer(prepared.decision, { autoSendEnabled: true }).allowed, false);
  assert.equal(prepared.gatewaySafetyFailures.includes('trusted_receipt_decision_contradiction'), true);
});

test('receipt-shaped text inside final JSON grants no authority', async () => {
  const { job, turn } = gatewayTurnFixture();
  const fabricated = confirmationReceiptFixture(job, { receipt_id: 'agent-fabricated' });
  const decision = gatewayDecisionFixture({ trusted_tool_receipts: [fabricated] });
  const prepared = await workerModule.prepareKakaoGatewayDecision({
    config: {}, job, turn, finalText: `FINAL_JSON\n${JSON.stringify(decision)}`, trustedToolReceipts: []
  });

  assert.equal(prepared.trustedToolReceipt, null);
  assert.equal(prepared.decision.reply_decision.replyMode, 'auto_send');
  assert.equal(prepared.decision.authoritative_sheet_result, undefined);
  assert.equal(prepared.decision.trusted_tool_receipts, undefined);
});

test('structured availability decision without a trusted receipt fails closed to schedule owner review', async () => {
  const { job, turn } = gatewayTurnFixture();
  const decision = scheduleDecisionFixture({
    owner_review_required: false,
    reply_decision: {
      replyMode: 'auto_send', safetyClass: 'authoritative_availability_answer',
      grounding: 'authoritative_sheet', requiresRag: false, shouldCreateTask: false
    }
  });
  const prepared = await workerModule.prepareKakaoGatewayDecision({
    config: {}, job, turn, finalText: `FINAL_JSON\n${JSON.stringify(decision)}`, trustedToolReceipts: []
  });

  assert.equal(prepared.decision.reply_decision.replyMode, 'draft_only');
  assert.equal(prepared.decision.reply_decision.safetyClass, 'no_send');
  assert.equal(prepared.decision.owner_review_required, true);
  assert.equal(prepared.decision.should_write_to_sheet, false);
  assert.equal(prepared.gatewaySafetyFailures.includes('authoritative_claim_without_trusted_receipt'), true);
  assert.equal(prepared.availabilityAwareRows.some((row) => row.payload?.follow_up_route === 'schedule'), true);
});

test('reservation-classified sheet-grounded commitment without a trusted receipt cannot bypass owner review', async () => {
  const { job, turn } = gatewayTurnFixture();
  const decision = gatewayDecisionFixture({
    classification: 'reservation',
    reservation_inquiry: { is_reservation_inquiry: true },
    reply_decision: {
      replyMode: 'auto_send', safetyClass: 'sensitive_commitment',
      grounding: 'authoritative_sheet', requiresRag: false,
      text: 'Hermes reservation commitment fixture'
    }
  });
  const prepared = await workerModule.prepareKakaoGatewayDecision({
    config: {}, job, turn, finalText: `FINAL_JSON\n${JSON.stringify(decision)}`, trustedToolReceipts: []
  });

  assert.equal(prepared.decision.reply_decision.replyMode, 'draft_only');
  assert.equal(prepared.decision.reply_decision.safetyClass, 'no_send');
  assert.equal(prepared.decision.owner_review_required, true);
  assert.equal(prepared.gatewaySafetyFailures.includes('authoritative_claim_without_trusted_receipt'), true);
});

test('malformed, invalid, and stale Gateway finals produce no-send human review work', async () => {
  const fixture = gatewayTurnFixture();
  const cases = [
    { name: 'malformed', finalText: 'FINAL_JSON not-json', job: fixture.job, turn: fixture.turn },
    { name: 'invalid', finalText: 'FINAL_JSON {}', job: fixture.job, turn: fixture.turn },
    {
      name: 'stale', finalText: `FINAL_JSON\n${JSON.stringify(gatewayDecisionFixture())}`,
      job: { ...fixture.job, roomRevision: fixture.job.roomRevision + 1 }, turn: fixture.turn
    }
  ];
  for (const entry of cases) {
    const prepared = await workerModule.prepareKakaoGatewayDecision({
      config: {}, job: entry.job, turn: entry.turn, finalText: entry.finalText, trustedToolReceipts: []
    });
    assert.equal(prepared.status, 'ai_prepared', entry.name);
    assert.equal(prepared.decision.reply_decision.replyMode, 'draft_only', entry.name);
    assert.equal(prepared.decision.reply_decision.safetyClass, 'no_send', entry.name);
    assert.equal(prepared.decision.owner_review_required, true, entry.name);
    assert.equal(prepared.availabilityAwareRows.length > 0, true, entry.name);
  }
});

test('failed trusted confirmation receipt remains authoritative evidence but cannot send', async () => {
  const { job, turn } = gatewayTurnFixture();
  const receipt = confirmationReceiptFixture(job, {
    status: 'failed', availability_report: [], authoritative_sheet_result: null,
    error: { type: 'gas_request_failed', message: 'offline fixture failure' }
  });
  const prepared = await workerModule.prepareKakaoGatewayDecision({
    config: {}, job, turn,
    finalText: `FINAL_JSON\n${JSON.stringify(scheduleDecisionFixture())}`,
    trustedToolReceipts: [receipt]
  });

  assert.equal(prepared.decision.reply_decision.replyMode, 'draft_only');
  assert.equal(prepared.decision.owner_review_required, true);
  assert.equal(prepared.gatewaySafetyFailures.includes('trusted_confirmation_failed'), true);
  assert.equal(prepared.sheetResult.success, false);
  assert.equal(prepared.availabilityAwareRows.some((row) => row.payload?.follow_up_route === 'schedule'), true);
});

test('trusted confirmation receipt creates schedule review even when Hermes marks the latest turn as staff', async () => {
  const { job, turn } = gatewayTurnFixture();
  const receipt = confirmationReceiptFixture(job);
  const decision = scheduleDecisionFixture({
    safety_checks: { latest_customer_message_after_last_staff_reply: false },
    authoritative_sheet_result: receipt.authoritative_sheet_result
  });
  const prepared = await workerModule.prepareKakaoGatewayDecision({
    config: {}, job, turn,
    finalText: `FINAL_JSON\n${JSON.stringify(decision)}`,
    trustedToolReceipts: [receipt]
  });

  assert.equal(prepared.decision.owner_review_required, true);
  assert.equal(prepared.availabilityAwareRows.some((row) => row.payload?.follow_up_route === 'schedule'), true);
});

test('applyPreparedKakaoDecision performs a fresh snapshot check immediately before any Gateway reply send', async () => {
  const { job, turn } = gatewayTurnFixture();
  const order = [];
  const applied = await applyPreparedKakaoDecision({
    config: { openTargetChat: true, bridgeUrl: '', jobLogPath: '' },
    job,
    prepared: {
      status: 'ai_prepared', snapshot: turn.internal.snapshot,
      decision: gatewayDecisionFixture(), sheetResult: null, availabilityAwareRows: []
    },
    dependencies: {
      openTargetChat: async () => { order.push('fresh_dom'); return turn.internal.snapshot.navigation; },
      sendReply: async () => { order.push('send'); return { attempted: true, sent: true }; },
      closeNavigation: async () => { order.push('close'); return { status: 'closed' }; }
    }
  });

  assert.equal(applied.autoReplyResult.sent, true);
  assert.deepEqual(order, ['fresh_dom', 'send', 'close']);
});

test('prepareKakaoDecisionFromSnapshot honors an already-aborted bridge deadline', async () => {
  const deadline = new AbortController();
  const deadlineError = new Error('bridge end-to-end deadline expired');
  deadline.abort(deadlineError);
  const job = { jobId: 'job-deadline', roomKey: 'chat:deadline', roomRevision: 1, previewText: '문의' };
  const snapshot = createImmutableKakaoRoomSnapshot({ job, capturedAt: '2026-08-20T00:00:00.000Z' });

  await assert.rejects(
    workerModule.prepareKakaoDecisionFromSnapshot({
      config: {},
      job,
      capture: { snapshot },
      dryRun: true,
      signal: deadline.signal
    }),
    (error) => error === deadlineError
  );
});

test('applyPreparedKakaoDecision fails closed when the bridge deadline is already aborted', async () => {
  const deadline = new AbortController();
  const deadlineError = new Error('bridge deadline expired before Kakao send');
  deadline.abort(deadlineError);
  const job = { jobId: 'job-apply-deadline', roomKey: 'chat:apply', roomRevision: 2, previewText: '문의' };
  const snapshot = createImmutableKakaoRoomSnapshot({ job, capturedAt: '2026-08-20T00:00:00.000Z' });
  let sendAttempted = false;

  await assert.rejects(
    applyPreparedKakaoDecision({
      config: { openTargetChat: false },
      job,
      prepared: { status: 'ai_prepared', snapshot, decision: {}, sheetResult: null },
      signal: deadline.signal,
      dependencies: {
        sendReply: async () => {
          sendAttempted = true;
          return { attempted: true, sent: true };
        }
      }
    }),
    (error) => error === deadlineError
  );
  assert.equal(sendAttempted, false);
});

test('worker handoff phase reporter writes an atomic per-job pre-mutation proof', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kakao-worker-phase-'));
  try {
    const reporter = workerModule.createWorkerHandoffPhaseReporter({
      config: { jobLogPath: path.join(temp, 'jobs.ndjson') },
      job: { jobId: 'dom-safe-handoff-1' },
      pid: 4242,
      now: () => new Date('2026-08-18T01:00:00.000Z')
    });

    reporter('initial_hermes_in_flight');

    const state = JSON.parse(fs.readFileSync(reporter.statePath, 'utf8'));
    assert.equal(state.schema, 'kakao-worker-handoff-phase/v1');
    assert.equal(state.jobId, 'dom-safe-handoff-1');
    assert.equal(state.workerPid, 4242);
    assert.equal(state.phase, 'initial_hermes_in_flight');
    assert.equal(state.recordedAt, '2026-08-18T01:00:00.000Z');
    assert.equal(fs.readdirSync(path.dirname(reporter.statePath)).some((name) => name.endsWith('.tmp')), false);

    const blocked = path.join(temp, 'not-a-directory');
    fs.writeFileSync(blocked, 'x');
    const unavailableReporter = workerModule.createWorkerHandoffPhaseReporter({
      config: { jobLogPath: path.join(blocked, 'jobs.ndjson') },
      job: { jobId: 'dom-safe-handoff-2' }
    });
    assert.doesNotThrow(() => unavailableReporter('initial_hermes_in_flight'));
    assert.equal(unavailableReporter('initial_hermes_in_flight'), null);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('apply phase rechecks the snapshot and passes Hermes prose through without reinterpretation', async () => {
  const job = {
    jobId: 'job-apply-1',
    roomKey: 'chat:apply',
    roomRevision: 4,
    detectedAt: '2026-08-18T00:00:00.000Z'
  };
  const navigationContext = {
    status: 'opened_conversation',
    conversation_evidence: {
      source: 'devtools',
      title: '고객명',
      hint_matched: true,
      hints: ['고객명'],
      visible_static_text_tail: '고객: 동일한 최신 문의'
    }
  };
  const snapshot = createImmutableKakaoRoomSnapshot({ job, navigationContext });
  const decision = { reply_decision: { text: 'Hermes가 작성한 원문 그대로' } };
  let sentDecision = null;
  const applied = await applyPreparedKakaoDecision({
    config: { openTargetChat: true, bridgeUrl: '', jobLogPath: '', freshnessPollMs: 1000 },
    job,
    prepared: { status: 'ai_prepared', snapshot, decision, sheetResult: null },
    dependencies: {
      openTargetChat: async () => navigationContext,
      sendReply: async ({ decision: incoming }) => {
        sentDecision = incoming;
        return { attempted: true, sent: true };
      },
      closeNavigation: async () => ({ status: 'closed' })
    }
  });

  assert.equal(applied.snapshotChanged, false);
  assert.equal(applied.autoReplyResult.sent, true);
  assert.equal(sentDecision, decision, 'plumbing must not rewrite or reconstruct Hermes output');
});

test('superseded prepared work never creates a stale card or customer reply', async () => {
  const result = await finalizePreparedKakaoDecision({
    config: {},
    job: { roomKey: 'chat:old' },
    applied: {
      superseded: true,
      prepared: {
        status: 'ai_prepared',
        snapshot: { schema: 'kakao-room-snapshot/v1' },
        decision: { should_write_to_sheet: false },
        availabilityAwareRows: [{ title: 'must not be delivered' }]
      },
      autoReplyResult: { attempted: false, sent: false, reason: 'superseded_by_newer_room_event' }
    }
  });

  assert.equal(result.status, 'superseded_by_newer_room_event');
  assert.equal(result.superseded, true);
  assert.equal(result.followUpResult.skipped, true);
  assert.deepEqual(result.followUpResult.rows, []);
});

test('buildCanonicalFollowUpCases suppresses inquiry duplication when human work exists', () => {
  const cases = buildCanonicalFollowUpCases(
    { customer: { name: 'Kim' }, latest_customer_message_cluster: 'Please send my payment receipt.', reply_decision: { text: 'We will confirm and update you.' } },
    { id: '00000000-0000-4000-8000-000000000001', room_key: 'chat:4979' },
    [{ room_key: 'chat:4979', customer_name: 'Kim', recommended_action: 'Reconcile payment', payload: { requires_human_action: true, action_family: 'payment_reconcile', business_key: 'trade:260729-001' } }]
  );

  assert.equal(cases.length, 1);
  assert.equal(cases[0].payload.card_kind, 'follow_up_case');
  assert.equal(cases[0].payload.owner_channel, 'follow_up');
  assert.equal(cases[0].payload.steps.length, 1);
  assert.notEqual(cases[0].type, 'customer_inquiry');
});

test('buildCanonicalFollowUpCases creates one inquiry case for reply-only work', () => {
  const cases = buildCanonicalFollowUpCases(
    { customer: { name: 'Park' }, latest_customer_message_cluster: 'Is it available?', reply_decision: { text: 'Yes, it is available.' } },
    { room_key: 'chat:a' },
    [{ room_key: 'chat:a', customer_name: 'Park', type: 'reply_needed', suggested_reply_draft: 'Yes, it is available.' }]
  );

  assert.equal(cases.length, 1);
  assert.equal(cases[0].payload.owner_channel, 'inquiry');
  assert.equal(cases[0].payload.phase, 'customer_reply');
});

test('staff outbound as the latest turn never becomes a canonical Slack inquiry card', () => {
  const decision = {
    customer: { name: 'Park' },
    latest_customer_message_cluster: 'The earlier customer question.',
    latest_staff_message: 'We already answered the customer.',
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      latest_customer_message_after_last_staff_reply: false
    },
    reply_decision: { replyMode: 'no_reply', text: '' }
  };

  assert.deepEqual(buildCanonicalFollowUpCases(decision, { room_key: 'chat:staff-latest' }, []), []);
});

test('staff-latest card suppression preserves an independent sheet failure alert', () => {
  const decision = {
    customer: { name: 'Park' },
    safety_checks: { latest_customer_message_after_last_staff_reply: false }
  };
  const rows = [{
    room_key: 'chat:staff-latest',
    customer_name: 'Park',
    type: 'reservation_review',
    summary: 'GAS rejected the write.',
    payload: { sheet_error_type: 'sheet_validation', requires_human_action: true }
  }];

  assert.equal(buildCanonicalFollowUpCases(decision, { room_key: 'chat:staff-latest' }, rows).length, 1);
});

test('draft_only intent requires a customer reply even when no usable draft exists', () => {
  const [followUpCase] = buildCanonicalFollowUpCases(
    {
      customer: { name: 'Lee' },
      latest_customer_message_cluster: 'Please issue the invoice and let me know.',
      reason: 'Invoice work must finish before replying.',
      reply_decision: { replyMode: 'draft_only', text: '' }
    },
    { room_key: 'chat:no-draft' },
    [{
      room_key: 'chat:no-draft', customer_name: 'Lee', recommended_action: 'Issue the invoice.',
      evidence: ['trade 260804-001'],
      payload: { requires_human_action: true, action_family: 'invoice_issue', business_key: 'trade:260804-001' }
    }]
  );

  assert.equal(followUpCase.suggested_reply_draft, '');
  assert.equal(followUpCase.payload.requires_reply, true);
  assert.equal(followUpCase.payload.reply_intent, 'draft_only');
  assert.equal(followUpCase.payload.latest_customer_message_cluster, 'Please issue the invoice and let me know.');
  assert.equal(followUpCase.payload.ai_judgment, 'Invoice work must finish before replying.');
  assert.deepEqual(followUpCase.payload.core_facts, ['trade 260804-001']);
});

test('explicit reply-required decision advances an internal case to reply without relying on draft text', () => {
  const [followUpCase] = buildCanonicalFollowUpCases(
    { customer: { name: 'Lee' }, reply_decision: { reply_required: true, text: '' } },
    { room_key: 'chat:reply-required' },
    [{
      room_key: 'chat:reply-required', customer_name: 'Lee', recommended_action: 'Finish internal work.',
      payload: { requires_human_action: true, action_family: 'document_approval', business_key: 'trade:2' }
    }]
  );

  assert.equal(followUpCase.payload.requires_reply, true);
  assert.equal(followUpCase.payload.reply_intent, 'reply_required');
});

test('upsertFollowUpCaseRows atomically insert-ignores then keeps incoming content and immutable delivery identity', async () => {
  const requests = [];
  const existing = {
    id: 'inquiry-existing',
    room_key: 'chat:4979',
    customer_name: 'Kim',
    type: 'customer_inquiry',
    status: 'open',
    summary: 'old customer request',
    recommended_action: 'old judgment',
    suggested_reply_draft: 'old draft',
    evidence: ['old fact'],
    payload: {
      card_kind: 'follow_up_case',
      case_id: 'case-existing',
      case_key: 'case:stable',
      owner_channel: 'inquiry',
      phase: 'customer_reply',
      state_version: 1,
      requires_reply: false,
      latest_customer_message_cluster: 'old customer request',
      ai_judgment: 'old judgment',
      core_facts: ['old fact'],
      steps: [{ step_key: 'done-step', action_family: 'document_approval', action: 'old completed action', status: 'done' }],
      slack_delivery: { status: 'delivered', channel_id: 'CINQUIRY', message_ts: '100.1' }
    }
  };
  const config = {
    supabaseUrl: 'https://supabase.example',
    serviceRoleKey: 'service-role',
    followUpTable: 'ai_follow_up_items',
      fetchImpl: async (url, init = {}) => {
        requests.push({ url: String(url), init });
        const body = init.body ? JSON.parse(init.body) : null;
        const data = init.method === 'POST'
          ? []
          : init.method === 'PATCH'
            ? [{ ...existing, ...body }]
            : [existing];
        return { ok: true, status: 200, text: async () => JSON.stringify(data) };
      }
  };

  const result = await upsertFollowUpCaseRows(config, [{
    follow_up_key: 'case:stable', room_key: 'chat:4979', customer_name: 'Kim', type: 'follow_up_case', status: 'open',
    summary: 'new customer request', recommended_action: 'new judgment', suggested_reply_draft: 'new draft', evidence: ['new fact'],
    payload: {
      card_kind: 'follow_up_case', case_id: 'temporary', case_key: 'case:stable', owner_channel: 'follow_up',
      phase: 'internal_action', requires_reply: true,
      latest_customer_message_cluster: 'new customer request', ai_judgment: 'new judgment', core_facts: ['new fact'],
      steps: [
        { step_key: 'done-step', action_family: 'document_approval', action: 'updated completed action', status: 'pending' },
        { step_key: 'payment:trade:260729-001', action_family: 'payment_reconcile', business_object_key: 'trade:260729-001', action: 'Confirm payment', status: 'pending' }
      ]
    }
  }]);

  const patchRequest = requests.find((request) => request.init.method === 'PATCH');
  assert.ok(patchRequest.url.includes('id=eq.inquiry-existing'));
  const postRequest = requests.find((request) => request.init.method === 'POST');
  assert.match(postRequest.url, /on_conflict=follow_up_key/);
  assert.match(String(postRequest.init.headers.prefer), /resolution=ignore-duplicates/);
  assert.equal(result.rows[0].payload.case_id, 'case-existing');
  assert.equal(result.rows[0].payload.owner_channel, 'inquiry');
  assert.equal(result.rows[0].payload.phase, 'internal_action');
  assert.equal(result.rows[0].summary, 'new customer request');
  assert.equal(result.rows[0].recommended_action, 'new judgment');
  assert.equal(result.rows[0].suggested_reply_draft, 'new draft');
  assert.deepEqual(result.rows[0].evidence, ['new fact']);
  assert.equal(result.rows[0].payload.latest_customer_message_cluster, 'new customer request');
  assert.equal(result.rows[0].payload.ai_judgment, 'new judgment');
  assert.equal(result.rows[0].payload.steps[0].status, 'done');
  assert.equal(result.rows[0].payload.state_version, 2);
  assert.equal(result.rows[0].payload.slack_delivery.channel_id, 'CINQUIRY');
  assert.equal(result.rows[0].payload.slack_delivery.message_ts, '100.1');
});

test('concurrent canonical case creation converges through the existing follow_up_key unique constraint', async () => {
  const requests = [];
  let stored = null;
  const config = {
    supabaseUrl: 'https://supabase.example', serviceRoleKey: 'service-role', followUpTable: 'ai_follow_up_items',
    fetchImpl: async (url, init = {}) => {
      requests.push({ url: String(url), init });
      const body = init.body ? JSON.parse(init.body) : null;
      if (init.method === 'POST') {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (!stored) {
          stored = { id: 'case-winner', ...body[0] };
          return { ok: true, status: 201, text: async () => JSON.stringify([stored]) };
        }
        return { ok: true, status: 201, text: async () => JSON.stringify([]) };
      }
      if (init.method === 'PATCH') {
        stored = { ...stored, ...body };
        return { ok: true, status: 200, text: async () => JSON.stringify([stored]) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify(stored ? [stored] : []) };
    }
  };
  const row = {
    follow_up_key: 'case:atomic', room_key: 'chat:atomic', customer_name: 'Kim', type: 'follow_up_case', status: 'open',
    payload: { card_kind: 'follow_up_case', case_id: 'logical-case', case_key: 'case:atomic', owner_channel: 'follow_up', phase: 'internal_action', state_version: 1, requires_reply: false, steps: [{ step_key: 'one', status: 'pending' }] }
  };

  const results = await Promise.all([
    upsertFollowUpCaseRows(config, [structuredClone(row)]),
    upsertFollowUpCaseRows(config, [structuredClone(row)])
  ]);

  assert.deepEqual(results.map((result) => result.rows[0].id), ['case-winner', 'case-winner']);
  assert.equal(requests.filter((request) => request.init.method === 'POST').length, 2);
  assert.equal(requests.some((request) => request.url.includes('room_key=eq.')), false);
});

test('upsertInquiryCaseRow creates a new case when no open case exists', async () => {
  const requests = [];
  const config = {
    supabaseUrl: 'https://supabase.example',
    serviceRoleKey: 'service-role',
    followUpTable: 'ai_follow_up_items',
    fetchImpl: async (url, init = {}) => {
      requests.push({ url: String(url), init });
      if (init.method === 'POST') {
        const rows = JSON.parse(init.body);
        return { ok: true, status: 201, text: async () => JSON.stringify([{ id: 'inquiry-new', ...rows[0] }]) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify([]) };
    }
  };

  const result = await upsertInquiryCaseRow(config, {
    room_key: 'chat:4979', customer_name: '윤영준', type: 'customer_inquiry', status: 'open',
    summary: '완료 후 새 문의', payload: { card_kind: 'inquiry_case' }
  });

  assert.equal(requests.filter((request) => request.init.method === 'POST').length, 1);
  assert.equal(result.inserted, true);
  assert.match(result.row.payload.case_id, /^[0-9a-f-]{36}$/i);
});

test('upsertManualFollowUpRows patches the same action and business object', async () => {
  const requests = [];
  const existing = {
    id: 'task-existing',
    follow_up_key: 'follow-up:case-1:business:trade:260729-001:invoice_issue',
    status: 'open',
    payload: {
      card_kind: 'follow_up_task', case_id: 'case-1', action_family: 'invoice_issue',
      slack_delivery: { status: 'delivered', channel_id: 'CFOLLOW', message_ts: '200.1' }
    }
  };
  const config = {
    supabaseUrl: 'https://supabase.example',
    serviceRoleKey: 'service-role',
    followUpTable: 'ai_follow_up_items',
    fetchImpl: async (url, init = {}) => {
      requests.push({ url: String(url), init });
      const body = init.body ? JSON.parse(init.body) : null;
      const data = init.method === 'PATCH' ? [{ ...existing, ...body }] : [existing];
      return { ok: true, status: 200, text: async () => JSON.stringify(data) };
    }
  };
  const incoming = {
    room_key: 'chat:4979', customer_name: '윤영준', type: 'tax_invoice', status: 'open',
    summary: '260729-001 세금계산서 발행',
    payload: {
      card_kind: 'follow_up_task', requires_human_action: true,
      action_family: 'invoice_issue', business_key: 'trade:260729-001'
    }
  };

  const result = await upsertManualFollowUpRows(config, [incoming], 'case-1');

  assert.equal(requests.some((request) => request.init.method === 'POST'), false);
  assert.equal(requests.filter((request) => request.init.method === 'PATCH').length, 1);
  assert.equal(result.rows[0].payload.slack_delivery.message_ts, '200.1');
});

test('validateAiDecisionContract rejects incomplete manual action metadata', () => {
  const decision = completeSheetDecision({
    follow_up_items: [{
      type: 'tax_invoice',
      route: 'document',
      taskKey: 'invoice',
      priority: 'high',
      status: 'open',
      title: '세금계산서 발행',
      customer_name: '윤영준',
      summary: '발행 필요',
      requiresHumanAction: true,
      actionFamily: 'none',
      businessKey: ''
    }]
  });

  const result = validateAiDecisionContract(decision);

  assert.equal(result.valid, false);
  assert.ok(result.errors.some((error) => error.includes('actionFamily')));
  assert.ok(result.errors.some((error) => error.includes('businessKey')));
});

test('validateAiDecisionContract accepts inquiry-only reservation review', () => {
  const decision = completeSheetDecision({
    follow_up_items: [{
      type: 'reservation_review',
      route: 'schedule',
      taskKey: 'availability',
      priority: 'normal',
      status: 'open',
      title: '예약 가능 결과 안내',
      customer_name: '윤영준',
      summary: '가용 결과를 고객에게 안내',
      requiresHumanAction: false,
      actionFamily: 'none',
      businessKey: ''
    }]
  });

  assert.equal(validateAiDecisionContract(decision).valid, true);
});

test('two-channel routing sends inquiry cases only to 카카오톡문의', () => {
  const route = routeFollowUpToSlack({
    type: 'customer_inquiry', payload: { card_kind: 'inquiry_case' }
  }, {
    twoChannelRoutingEnabled: true,
    slackInquiryChannel: '카카오톡문의',
    slackFollowUpChannel: '후속업무'
  });
  assert.equal(route.channel, '카카오톡문의');
});

test('two-channel routing sends manual tasks only to 후속업무', () => {
  const route = routeFollowUpToSlack({
    type: 'tax_invoice', payload: { card_kind: 'follow_up_task' }
  }, {
    twoChannelRoutingEnabled: true,
    slackInquiryChannel: '카카오톡문의',
    slackFollowUpChannel: '후속업무'
  });
  assert.equal(route.channel, '후속업무');
});

test('two-channel routing never leaks card-kind-less rows into legacy agent channels', () => {
  const config = {
    twoChannelRoutingEnabled: true,
    slackInquiryChannel: '카카오톡문의',
    slackFollowUpChannel: '후속업무',
    slackChannels: { other: '기타문의', schedule: '스케쥴-agent' }
  };
  const bridgeFailure = routeFollowUpToSlack({
    type: 'reply_needed',
    decision_classification: 'automation_error_review',
    payload: { failure_kind: 'worker_error' }
  }, config);
  assert.deepEqual(bridgeFailure, { route: 'inquiry', channel: '카카오톡문의' });

  const failureCard = buildSlackInquiryMessage({
    id: 'failure-1', customer_name: '남궁욱', type: 'reply_needed',
    decision_classification: 'automation_error_review',
    summary: '자동 처리 중 오류가 발생해 사람 확인으로 전환됐습니다.',
    payload: { card_kind: 'inquiry_case', failure_kind: 'worker_error' }
  }, { route: bridgeFailure, config });
  assert.match(failureCard.blocks[0].text.text, /자동처리 오류/);
  assert.match(JSON.stringify(failureCard.blocks), /village_followup_open_kakao_manager/);
});

test('buildCanonicalFollowUpCases stamps whether the AI actually auto-replied', () => {
  const decision = { customer: { name: '박민호' }, latest_customer_message_cluster: '9/12 A7S3 가능할까요?' };
  const job = { room_key: 'chat:auto-reply-stamp' };
  const sent = buildCanonicalFollowUpCases(decision, job, [], { autoReplySent: true });
  const notSent = buildCanonicalFollowUpCases(decision, job, []);

  assert.equal(sent[0].payload.auto_reply_sent, true);
  assert.equal(notSent[0].payload.auto_reply_sent, false);
});

test('canonical fixed-channel delivery ignores absent or disabled two-channel feature flags', () => {
  for (const twoChannelRoutingEnabled of [undefined, false]) {
    const config = {
      ...(twoChannelRoutingEnabled === undefined ? {} : { twoChannelRoutingEnabled }),
      slackInquiryChannel: 'INQUIRY',
      slackFollowUpChannel: 'FOLLOW_UP',
      slackChannels: { other: '기타문의' }
    };
    for (const [owner_channel, expectedChannel] of [['inquiry', 'INQUIRY'], ['follow_up', 'FOLLOW_UP']]) {
      const row = {
        id: `canonical-${owner_channel}`,
        type: 'reply_needed',
        customer_name: '김영준',
        payload: { card_kind: 'follow_up_case', owner_channel, phase: 'customer_reply', state_version: 1, steps: [] }
      };
      const route = routeFollowUpToSlack(row, config);
      const message = buildSlackFollowUpMessage(row, { config });

      assert.deepEqual(route, { route: owner_channel, channel: expectedChannel });
      assert.equal(message.channel, route.channel);
    }
  }
});

test('buildSlackRoutingConfig maps the exact two-channel environment contract', () => {
  assert.deepEqual(buildSlackRoutingConfig({
    SLACK_TWO_CHANNEL_ROUTING_ENABLED: '1',
    SLACK_CHANNEL_KAKAO_INQUIRY: '카카오톡문의',
    SLACK_CHANNEL_FOLLOW_UP: '후속업무'
  }), {
    twoChannelRoutingEnabled: true,
    slackInquiryChannel: '카카오톡문의',
    slackFollowUpChannel: '후속업무'
  });
});

test('two-channel preflight fails before posting when a destination is missing', async () => {
  const requests = [];
  const config = {
    twoChannelRoutingEnabled: true,
    slackBotToken: 'xoxb-test',
    slackInquiryChannel: '카카오톡문의',
    slackFollowUpChannel: '후속업무',
    slackFetchImpl: async (url, init = {}) => {
      requests.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          ok: true,
          channels: [{ id: 'CINQUIRY', name: '카카오톡문의' }],
          response_metadata: { next_cursor: '' }
        })
      };
    }
  };

  await assert.rejects(() => preflightTwoChannelSlackRouting(config), /후속업무/);
  assert.equal(requests.some((request) => /chat\.(?:postMessage|update)/.test(request.url)), false);
});

test('two-channel delivery batch fails closed before Slack or Supabase writes', async () => {
  const slackRequests = [];
  const supabaseRequests = [];
  const result = await deliverSlackFollowUpRows({
    slackFollowUpEnabled: true,
    twoChannelRoutingEnabled: true,
    slackBotToken: 'xoxb-test',
    slackInquiryChannel: '카카오톡문의',
    slackFollowUpChannel: '후속업무',
    slackFetchImpl: async (url, init = {}) => {
      slackRequests.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          ok: true,
          channels: [{ id: 'CINQUIRY', name: '카카오톡문의' }],
          response_metadata: { next_cursor: '' }
        })
      };
    },
    fetchImpl: async (url, init = {}) => {
      supabaseRequests.push({ url: String(url), init });
      throw new Error('Supabase must not be reached when routing preflight fails');
    }
  }, [{
    id: 'inquiry-1',
    room_key: 'chat:a',
    type: 'customer_inquiry',
    status: 'open',
    customer_name: '윤영준',
    summary: '현금영수증 요청',
    payload: { card_kind: 'inquiry_case', case_id: 'case-1' }
  }]);

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'two_channel_preflight_failed');
  assert.deepEqual(result.results, []);
  assert.equal(slackRequests.some((request) => /chat\.(?:postMessage|update)/.test(request.url)), false);
  assert.equal(supabaseRequests.length, 0);
});

test('Hermes decision timeout is not inherited from the longer outer bridge timeout', () => {
  assert.equal(hermesDecisionTimeoutFromEnv({ WORKER_TIMEOUT_MS: '540000' }), 240000);
  assert.equal(hermesDecisionTimeoutFromEnv({
    WORKER_TIMEOUT_MS: '540000',
    HERMES_WORKER_TIMEOUT_MS: '300000'
  }), 300000);
  assert.equal(hermesDecisionTimeoutFromEnv({ HERMES_WORKER_TIMEOUT_MS: 'invalid' }), 240000);
});

test('only a proven non-operational terminal acknowledgement closes before the heavy Hermes path', () => {
  const liveAck = {
    previewText: '중요 정인서 네 감사합니다 ! 오후 7:26',
    customerName: '정인서',
    events: [{ reason: 'mutation' }, { reason: 'top_row_changed' }]
  };
  const navigation = {
    status: 'opened_target_chat',
    conversation_evidence: {
      hint_matched: true,
      visible_static_text_tail: ['빌리지님', '안내드린 내용 확인 부탁드립니다', '정인서', '네 감사합니다 !']
    }
  };

  assert.equal(classifyConservativeTerminalAcknowledgement(liveAck, navigation).matched, true);
  assert.equal(classifyConservativeTerminalAcknowledgement(liveAck, {
    ...navigation,
    conversation_evidence: {
      hint_matched: true,
      visible_static_text_tail: ['FX3 8월 5일 예약', '빌리지님', '네, 확정 해드렸습니다', '정인서', '네 감사합니다 !']
    }
  }).matched, false);
  assert.equal(classifyConservativeTerminalAcknowledgement({
    ...liveAck,
    previewText: '중요 정인서 네 견적서도 부탁드립니다 오후 7:26'
  }, navigation).matched, false);
  assert.equal(classifyConservativeTerminalAcknowledgement(liveAck, {
    ...navigation,
    conversation_evidence: { hint_matched: true, visible_static_text_tail: [] }
  }).matched, false);
  assert.equal(classifyConservativeTerminalAcknowledgement({
    ...liveAck,
    events: [{ reason: 'startup_catchup' }]
  }, navigation).matched, false);
});

test('completed worker does not stay alive for an obsolete DevTools timeout', () => {
  const script = `
    import { timeoutPromise } from './worker.mjs';
    timeoutPromise(5000, 'obsolete timeout').catch(() => {});
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: path.dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, '$1')),
    timeout: 1000,
    encoding: 'utf8'
  });

  assert.equal(result.error?.code, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
});

test('worker CLI exits explicitly after a successful result despite lingering library handles', async () => {
  let exitCode = null;
  await runCli(async () => {}, {
    exitImpl(code) { exitCode = code; },
    errorWriter() { assert.fail('success path must not write an error'); }
  });
  assert.equal(exitCode, 0);
});

test('createWorkerTimingRecorder records named stages and total elapsed time', () => {
  const ticks = [1000, 1125, 1500, 1800];
  const timings = createWorkerTimingRecorder(() => ticks.shift());

  timings.mark('navigation');
  timings.mark('hermes');

  assert.deepEqual(timings.snapshot(), {
    navigationMs: 125,
    hermesMs: 375,
    totalMs: 800
  });
});

function completeSheetDecision(overrides = {}) {
  const base = {
    should_write_to_sheet: true,
    classification: 'reservation',
    confidence: 'high',
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      latest_customer_message_after_last_staff_reply: true
    },
    sheet_row_candidate: {
      plan_complete: true,
      start_date: '2026-07-24',
      pickup_time: '09:00',
      end_date: '2026-07-25',
      return_time: '18:00',
      equipment: [{ item: '소니 FX3 바디세트', quantity: 1 }],
      customer_name: '홍길동',
      phone: '010-1111-2222',
      discount_type: '일반',
      memo: '',
      extra_request: ''
    }
  };
  return {
    ...base,
    ...overrides,
    safety_checks: { ...base.safety_checks, ...(overrides.safety_checks || {}) },
    sheet_row_candidate: { ...base.sheet_row_candidate, ...(overrides.sheet_row_candidate || {}) }
  };
}

function confirmationFreshnessGuard({ stale = false, staleAfterChecks = stale ? 1 : Number.POSITIVE_INFINITY } = {}) {
  let checks = 0;
  return {
    signal: new AbortController().signal,
    async checkNow() { checks += 1; },
    throwIfSuperseded() {
      if (checks >= staleAfterChecks) throw new Error('superseded_by_newer_room_event:8');
    },
    stop() {},
    get checks() { return checks; }
  };
}

test('executeVillageConfirmationRequest reuses additions-only merge, customer discount enrichment, and authoritative availability', async () => {
  const decision = completeSheetDecision({
    existing_confirm_request_ids: ['RQ-260820-001'],
    reservation_inquiry: { is_reservation_inquiry: true, already_registered: false },
    sheet_row_candidate: {
      equipment_write_mode: 'additions_only',
      equipment: [{ item: 'C스탠드', quantity: 2 }]
    }
  });
  const freshnessGuard = confirmationFreshnessGuard();
  const appended = [];
  let leaseChecks = 0;
  let executionState = null;
  const forbidden = { hermes: 0, kakao: 0, followUp: 0, slack: 0, reconciliation: 0 };

  const receipt = await workerModule.executeVillageConfirmationRequest({
    config: { sheetApiKey: 'internal-key' },
    job: { jobId: 'job-confirm-1', roomKey: 'room-confirm-1', roomRevision: 7 },
    roomRevision: 7,
    decision,
    dependencies: {
      freshnessGuard,
      fetchExistingConfirmRequestResultForDecision: async () => ({
        success: true,
        duplicate: true,
        reqID: 'RQ-260820-001',
        topLevelEquipment: [{ 이름: '소니 FX3 바디세트', 수량: 1 }],
        results: []
      }),
      enrichSheetPayloadWithCustomerDbDiscount: async (_config, payload) => ({
        payload: { ...payload, args: { ...payload.args, 할인유형: '학생' } },
        lookup: { matched: true, discountType: '학생' }
      }),
      appendToSheet: async (_config, payload) => {
        assert.ok(freshnessGuard.checks >= 1, 'freshness must be checked immediately before the GAS mutation');
        assert.ok(leaseChecks >= 1, 'the current claim must be fenced immediately before the GAS mutation');
        appended.push(payload);
        return {
          success: true,
          duplicate: false,
          reqID: 'RQ-260821-101',
          results: [{ equipment: '소니 FX3 바디세트', quantity: '1', result: '✅ 가용1', detail: '보유1' }]
        };
      },
      ensureConfirmRequestDiscountApplied: async () => {
        assert.ok(leaseChecks >= 2, 'the current claim must be fenced again before the discount mutation');
        return { updated: true, discountType: '학생' };
      },
      assertCurrentClaim: async () => { leaseChecks += 1; },
      randomUUID: () => 'receipt-confirm-1',
      now: () => new Date('2026-08-21T04:05:06.000Z'),
      onExecutionState: (state) => { executionState = state; },
      runHermesDecision: async () => { forbidden.hermes += 1; },
      sendKakaoMessage: async () => { forbidden.kakao += 1; },
      upsertFollowUpRows: async () => { forbidden.followUp += 1; },
      deliverSlackFollowUpRows: async () => { forbidden.slack += 1; },
      runHermesPostActionDecision: async () => { forbidden.reconciliation += 1; }
    }
  });

  assert.equal(appended.length, 1);
  assert.equal(appended[0].args.입력모드, 'full_plan');
  assert.equal(appended[0].args.할인유형, '학생');
  assert.deepEqual(appended[0].args.장비, [
    { 이름: '소니 FX3 바디세트', 수량: 1 },
    { 이름: 'C스탠드', 수량: 2 }
  ]);
  assert.deepEqual(receipt, {
    schema: 'village-confirmation-receipt/v1',
    receipt_id: 'receipt-confirm-1',
    job_id: 'job-confirm-1',
    room_key: 'room-confirm-1',
    room_revision: 7,
    status: 'ok',
    availability_report: [{ equipment: '소니 FX3 바디세트', quantity: '1', result: '✅ 가용1', detail: '보유1' }],
    authoritative_sheet_result: {
      success: true,
      duplicate: false,
      reqID: 'RQ-260821-101',
      results: [{ equipment: '소니 FX3 바디세트', quantity: '1', result: '✅ 가용1', detail: '보유1' }]
    },
    created_at: '2026-08-21T04:05:06.000Z',
    error: null
  });
  assert.equal(executionState.sheetPayload.args.할인유형, '학생');
  assert.equal(executionState.customerDbDiscountLookup.discountType, '학생');
  assert.equal(leaseChecks, 2);
  assert.deepEqual(forbidden, { hermes: 0, kakao: 0, followUp: 0, slack: 0, reconciliation: 0 });
});

test('executeVillageConfirmationRequest returns a typed validation failure without mutating GAS', async () => {
  let appendCalls = 0;
  const receipt = await workerModule.executeVillageConfirmationRequest({
    config: { sheetApiKey: 'internal-key' },
    job: { jobId: 'job-invalid', roomKey: 'room-invalid', roomRevision: 7 },
    roomRevision: 7,
    decision: { should_write_to_sheet: true, sheet_row_candidate: {} },
    dependencies: {
      freshnessGuard: confirmationFreshnessGuard(),
      appendToSheet: async () => { appendCalls += 1; },
      randomUUID: () => 'receipt-invalid',
      now: () => new Date('2026-08-21T04:05:06.000Z')
    }
  });

  assert.equal(appendCalls, 0);
  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.authoritative_sheet_result, null);
  assert.deepEqual(receipt.availability_report, []);
  assert.equal(receipt.error.type, 'invalid_decision');
  assert.ok(receipt.error.validation_errors.length > 0);
});

test('executeVillageConfirmationRequest rejects stale correlation and stale freshness before mutation', async () => {
  const decision = completeSheetDecision();
  let appendCalls = 0;
  const appendToSheet = async () => { appendCalls += 1; };
  const common = {
    config: { sheetApiKey: 'internal-key' },
    job: { jobId: 'job-stale', roomKey: 'room-stale', roomRevision: 7 },
    decision,
    dependencies: { appendToSheet, randomUUID: () => 'receipt-stale', now: () => new Date('2026-08-21T04:05:06.000Z') }
  };

  await assert.rejects(
    workerModule.executeVillageConfirmationRequest({ ...common, roomRevision: 6, dependencies: { ...common.dependencies, freshnessGuard: confirmationFreshnessGuard() } }),
    /stale_room_revision/
  );
  await assert.rejects(
    workerModule.executeVillageConfirmationRequest({ ...common, roomRevision: 7, dependencies: { ...common.dependencies, freshnessGuard: confirmationFreshnessGuard({ stale: true }) } }),
    /superseded_by_newer_room_event/
  );
  assert.equal(appendCalls, 0);
});

test('executeVillageConfirmationRequest preserves missing-contact GAS rejection as a failed authoritative receipt', async () => {
  const decision = completeSheetDecision({ sheet_row_candidate: { phone: '' } });
  const receipt = await workerModule.executeVillageConfirmationRequest({
    config: { sheetApiKey: 'internal-key' },
    job: { jobId: 'job-no-contact', roomKey: 'room-no-contact', roomRevision: 7 },
    roomRevision: 7,
    decision,
    dependencies: {
      freshnessGuard: confirmationFreshnessGuard(),
      enrichSheetPayloadWithCustomerDbDiscount: async (_config, payload) => ({ payload, lookup: { matched: false } }),
      appendToSheet: async () => ({ success: false, error_type: 'no_contact', error: '연락처 필요' }),
      randomUUID: () => 'receipt-no-contact',
      now: () => new Date('2026-08-21T04:05:06.000Z')
    }
  });

  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.authoritative_sheet_result, null);
  assert.deepEqual(receipt.availability_report, []);
  assert.deepEqual(receipt.error, { type: 'no_contact', message: '연락처 필요' });
});

test('executeVillageConfirmationRequest converts a thrown GAS failure into a typed failed receipt', async () => {
  const receipt = await workerModule.executeVillageConfirmationRequest({
    config: { sheetApiKey: 'internal-key' },
    job: { jobId: 'job-gas-error', roomKey: 'room-gas-error', roomRevision: 7 },
    roomRevision: 7,
    decision: completeSheetDecision(),
    dependencies: {
      freshnessGuard: confirmationFreshnessGuard(),
      enrichSheetPayloadWithCustomerDbDiscount: async (_config, payload) => ({ payload, lookup: { matched: false } }),
      appendToSheet: async () => { throw new Error('GAS offline'); },
      randomUUID: () => 'receipt-gas-error',
      now: () => new Date('2026-08-21T04:05:06.000Z')
    }
  });

  assert.equal(receipt.status, 'failed');
  assert.equal(receipt.authoritative_sheet_result, null);
  assert.deepEqual(receipt.availability_report, []);
  assert.deepEqual(receipt.error, { type: 'gas_request_failed', message: 'GAS offline' });
});

test('executeVillageConfirmationRequest returns a persistable partial receipt when freshness changes after the primary write', async () => {
  const freshnessGuard = confirmationFreshnessGuard({ staleAfterChecks: 2 });
  let appendCalls = 0;
  let discountCalls = 0;
  const receipt = await workerModule.executeVillageConfirmationRequest({
    config: { sheetApiKey: 'internal-key' },
    job: { jobId: 'job-stale-after-write', roomKey: 'room-stale-after-write', roomRevision: 7 },
    roomRevision: 7,
    decision: completeSheetDecision(),
    dependencies: {
      freshnessGuard,
      assertCurrentClaim: async () => {},
      enrichSheetPayloadWithCustomerDbDiscount: async (_config, payload) => ({
        payload: { ...payload, args: { ...payload.args, 할인유형: '학생' } },
        lookup: { matched: true, discountType: '학생' }
      }),
      appendToSheet: async () => {
        appendCalls += 1;
        return {
          success: true,
          reqID: 'RQ-260821-201',
          results: [{ equipment: '소니 FX3 바디세트', quantity: '1', result: '✅ 가용1', detail: '보유1' }]
        };
      },
      ensureConfirmRequestDiscountApplied: async () => { discountCalls += 1; },
      randomUUID: () => 'receipt-stale-after-write',
      now: () => new Date('2026-08-21T05:00:00.000Z')
    }
  });

  assert.equal(appendCalls, 1);
  assert.equal(discountCalls, 0);
  assert.equal(receipt.status, 'partial_success');
  assert.equal(receipt.authoritative_sheet_result.reqID, 'RQ-260821-201');
  assert.equal(receipt.availability_report.length, 1);
  assert.equal(receipt.error.type, 'stale_after_primary_write');
});

test('executeVillageConfirmationRequest preserves GAS partial-success evidence and executed payload', async () => {
  const receipt = await workerModule.executeVillageConfirmationRequest({
    config: { sheetApiKey: 'internal-key' },
    job: { jobId: 'job-partial', roomKey: 'room-partial', roomRevision: 7 },
    roomRevision: 7,
    decision: completeSheetDecision(),
    dependencies: {
      freshnessGuard: confirmationFreshnessGuard(),
      assertCurrentClaim: async () => {},
      enrichSheetPayloadWithCustomerDbDiscount: async (_config, payload) => ({ payload, lookup: { matched: false } }),
      appendToSheet: async () => ({
        success: false,
        partial_success: true,
        error_type: 'set_component_selection_failed',
        error: '세트 구성 선택 반영 실패',
        reqID: 'RQ-260821-202',
        results: [{ equipment: '소니 FX3 바디세트', quantity: '1', result: '⚠️ 모델 선택 필요', detail: 'F열 확인' }]
      }),
      randomUUID: () => 'receipt-partial',
      now: () => new Date('2026-08-21T05:01:00.000Z')
    }
  });

  assert.equal(receipt.status, 'partial_success');
  assert.equal(receipt.authoritative_sheet_result.reqID, 'RQ-260821-202');
  assert.equal(receipt.authoritative_sheet_result.partial_success, true);
  assert.equal(receipt.authoritative_sheet_result.executed_payload.func, 'insertAndCheckRequest');
  assert.equal(receipt.authoritative_sheet_result.executed_payload.args.예약자명, '홍길동');
  assert.deepEqual(receipt.availability_report, [
    { equipment: '소니 FX3 바디세트', quantity: '1', result: '⚠️ 모델 선택 필요', detail: 'F열 확인' }
  ]);
  assert.deepEqual(receipt.error, { type: 'set_component_selection_failed', message: '세트 구성 선택 반영 실패' });
});

test('executeVillageConfirmationRequest reports discount patch failure without replaying or erasing the primary write', async () => {
  let appendCalls = 0;
  let discountCalls = 0;
  const receipt = await workerModule.executeVillageConfirmationRequest({
    config: { sheetApiKey: 'internal-key' },
    job: { jobId: 'job-discount-failure', roomKey: 'room-discount-failure', roomRevision: 7 },
    roomRevision: 7,
    decision: completeSheetDecision(),
    dependencies: {
      freshnessGuard: confirmationFreshnessGuard(),
      assertCurrentClaim: async () => {},
      enrichSheetPayloadWithCustomerDbDiscount: async (_config, payload) => ({
        payload: { ...payload, args: { ...payload.args, 할인유형: '학생' } },
        lookup: { matched: true, discountType: '학생' }
      }),
      appendToSheet: async () => {
        appendCalls += 1;
        return {
          success: true,
          reqID: 'RQ-260821-203',
          results: [{ equipment: '소니 FX3 바디세트', quantity: '1', result: '✅ 가용1', detail: '보유1' }]
        };
      },
      ensureConfirmRequestDiscountApplied: async () => {
        discountCalls += 1;
        throw new Error('할인 M열 반영 실패');
      },
      randomUUID: () => 'receipt-discount-failure',
      now: () => new Date('2026-08-21T05:02:00.000Z')
    }
  });

  assert.equal(appendCalls, 1);
  assert.equal(discountCalls, 1);
  assert.equal(receipt.status, 'partial_success');
  assert.equal(receipt.authoritative_sheet_result.reqID, 'RQ-260821-203');
  assert.equal(receipt.error.type, 'discount_patch_failed');
  assert.match(receipt.error.message, /할인 M열 반영 실패/);
});

test('executeVillageConfirmationRequest treats a non-applied required discount patch as partial success', async () => {
  const receipt = await workerModule.executeVillageConfirmationRequest({
    config: { sheetApiKey: 'internal-key' },
    job: { jobId: 'job-discount-not-applied', roomKey: 'room-discount-not-applied', roomRevision: 7 },
    roomRevision: 7,
    decision: completeSheetDecision(),
    dependencies: {
      freshnessGuard: confirmationFreshnessGuard(),
      assertCurrentClaim: async () => {},
      enrichSheetPayloadWithCustomerDbDiscount: async (_config, payload) => ({
        payload: { ...payload, args: { ...payload.args, 할인유형: '학생' } },
        lookup: { matched: true, discountType: '학생' }
      }),
      appendToSheet: async () => ({ success: true, reqID: 'RQ-260821-204', results: [] }),
      ensureConfirmRequestDiscountApplied: async () => ({ skipped: true, reason: 'req_row_not_found', reqID: 'RQ-260821-204' }),
      randomUUID: () => 'receipt-discount-not-applied',
      now: () => new Date('2026-08-21T05:03:00.000Z')
    }
  });

  assert.equal(receipt.status, 'partial_success');
  assert.equal(receipt.authoritative_sheet_result.reqID, 'RQ-260821-204');
  assert.deepEqual(receipt.error, {
    type: 'discount_patch_failed',
    message: 'Discount patch was not applied: req_row_not_found'
  });
});

function completePostActionDecision(overrides = {}) {
  const base = {
    should_write_to_sheet: false,
    classification: 'reservation',
    confidence: 'high',
    reason: '확인요청의 실제 가용 결과를 반영함',
    kill_switch_observed: 'active',
    customer: { name: '홍길동', source: 'Kakao Channel Manager', chat_status: 'open' },
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      latest_customer_message_after_last_staff_reply: true
    },
    visible_messages_used: [{ sender: '홍길동', message: '예약 가능할까요?', time: '오후 1:00' }],
    follow_up_items: [{
      type: 'reservation_review',
      route: 'schedule',
      taskKey: 'rq_260724_001_availability',
      priority: 'high',
      status: 'open',
      title: '홍길동 예약 가용 결과',
      customer_name: '홍길동',
      summary: '확인요청 결과 해당 장비가 가용입니다.',
      recommended_action: '고객 의사를 확인해 예약을 진행합니다.',
      suggested_reply_draft: '확인해보니 요청하신 일정에 장비 대여가 가능합니다. 예약 진행해드릴까요?',
      evidence: ['RQ-260724-001 ✅ 가용1'],
      blocking_reason: null,
      due_hint: 'now'
    }],
    suggested_reply_draft: '확인해보니 요청하신 일정에 장비 대여가 가능합니다. 예약 진행해드릴까요?',
    owner_review_required: true,
    reply_decision: {
      replyMode: 'draft_only',
      text: '확인해보니 요청하신 일정에 장비 대여가 가능합니다. 예약 진행해드릴까요?',
      confidence: 'high',
      reason: '실제 확인요청 결과가 가용임',
      shouldCreateTask: true,
      safetyClass: 'no_send',
      grounding: 'authoritative_sheet',
      requiresRag: false,
      attachmentKeys: [],
      alreadyDelivered: false
    }
  };
  return {
    ...base,
    ...overrides,
    customer: { ...base.customer, ...(overrides.customer || {}) },
    safety_checks: { ...base.safety_checks, ...(overrides.safety_checks || {}) },
    reply_decision: { ...base.reply_decision, ...(overrides.reply_decision || {}) }
  };
}

test('buildHermesPrompt keeps code as plumbing and requires AI-visible Kakao verification', () => {
  const job = {
    id: 'job-1',
    room_key: 'preview:abc',
    preview_text: '중요 최재형 6 Supabase 실전 테스트 예약문의 오전 8:54',
    payload: { instructions: ['카카오 화면을 직접 확인한다.'] }
  };

  const prompt = buildHermesPrompt(job, { gasApiUrl: 'https://example.test/exec' });

  assert.match(prompt, /AI-first/);
  assert.match(prompt, /카카오.*화면.*직접/s);
  assert.match(prompt, /DevTools\/CDP.*bridge API/is);
  assert.doesNotMatch(prompt, /computer_use/i);
  assert.match(prompt, /코드.*판단.*금지/s);
  assert.match(prompt, /Google Sheets.*API/s);
  assert.match(prompt, /FINAL_JSON/);
  assert.match(prompt, /job-1/);
});

test('quote calculation and confirmed-policy prompt use the owner-confirmed 3-hour grace', () => {
  assert.equal(
    calcRentalDaysForQuote('2026-08-18', '09:00', '2026-08-19', '12:00'),
    1
  );
  assert.equal(
    calcRentalDaysForQuote('2026-08-18', '09:00', '2026-08-19', '12:01'),
    2
  );

  const prompt = buildHermesPrompt({ id: 'job-rental-grace', preview_text: '대여 기간 견적' });
  assert.match(prompt, /\+3시간 동일/);
  assert.match(prompt, /3시간 초과 \+1일/);
  assert.doesNotMatch(prompt, /\+6시간|6시간 초과/);
});

test('buildHermesPrompt bounds routine work before the global timeout without sacrificing evidence', () => {
  const prompt = buildHermesPrompt({ id: 'job-tool-budget', preview_text: '예약 문의' });
  assert.doesNotMatch(prompt, /No artificial low tool\/UI cap/i);
  assert.match(prompt, /bounded tool budget/i);
  assert.match(prompt, /finish FINAL_JSON before exhausting/i);
  assert.match(prompt, /Batch read-only lookups only when query breadth\/detail are preserved/is);
});

test('buildHermesPrompt applies the owner-confirmed conservative whole-hour request boundary', () => {
  const prompt = buildHermesPrompt({ id: 'job-minute-time', preview_text: '12시 30분 반출 요청' });
  assert.match(prompt, /반출[^\n]{0,80}내림/);
  assert.match(prompt, /반납[^\n]{0,80}올림/);
  assert.match(prompt, /정시 HH:00/);
  assert.match(prompt, /27일 24:00[^\n]{0,120}28일 00:00/);
  assert.doesNotMatch(prompt, /outer code.*never floor or round/is);
});

test('buildHermesPrompt allows read-only vision when DOM or AX evidence is insufficient', () => {
  const prompt = buildHermesPrompt({ id: 'job-vision-fallback', preview_text: '사진 속 장비 문의' });
  assert.doesNotMatch(prompt, /do not request image\/vision capture/i);
  assert.doesNotMatch(prompt, /forces capture mode="ax".*max_elements=80/i);
  assert.match(prompt, /read-only image\/vision capture/i);
  assert.match(prompt, /already-open automation Kakao target/i);
  assert.match(prompt, /Never type or send as part of evidence capture/i);
});

test('buildHermesPrompt always finalizes structured output after evidence or tool failure', () => {
  const prompt = buildHermesPrompt({ id: 'job-finalize', preview_text: '예약 확인' });
  assert.match(prompt, /Once sufficient, return FINAL_JSON immediately/i);
  assert.match(prompt, /Tool\/API failures are evidence gaps/i);
  assert.match(prompt, /encode uncertainty in confidence\/reason\/follow-up/i);
});

test('buildCompactJobForPrompt strips bulky raw payload while preserving latest evidence', () => {
  const compact = buildCompactJobForPrompt({
    id: 'job-compact',
    status: 'processing_by_ai_worker',
    room_key: 'preview:abc',
    event_hash: 'dom-123',
    preview_text: '최재형 테스트 FX6 오후 2:29',
    unread_count: 1,
    detected_at: '2026-05-25T05:29:52Z',
    payload: {
      events: [{ previewText: '최재형 테스트 FX6 오후 2:29' }],
      huge: 'x'.repeat(20000)
    }
  });

  assert.deepEqual(Object.keys(compact).sort(), [
    'detected_at', 'event_hash', 'id', 'navigation_hints', 'preview_text', 'room_key', 'source', 'status', 'unread_count'
  ].sort());
  assert.equal(compact.id, 'job-compact');
  assert.equal(compact.preview_text, '최재형 테스트 FX6 오후 2:29');
  assert.deepEqual(compact.navigation_hints, ['최재형']);
  assert.equal(JSON.stringify(compact).includes('xxxxx'), false);
});

test('extractNavigationHints derives customer hint only for chat navigation', () => {
  assert.deepEqual(
    extractNavigationHints({ preview_text: '중요 정재하 2 견적서 먼저 주시면 입금드릴게요! 오후 7:16' }),
    ['정재하']
  );
  assert.deepEqual(
    extractNavigationHints({ customer_name: '오예린', preview_text: '중요 오예린 4 반납했습니다 오후 6:36' }),
    ['오예린']
  );
});

test('buildHermesPrompt uses compact job evidence instead of embedding full raw payload', () => {
  const prompt = buildHermesPrompt({
    id: 'job-big',
    room_key: 'preview:big',
    preview_text: 'FX6 문의',
    payload: { huge: 'x'.repeat(20000) }
  });

  assert.match(prompt, /JOB EVIDENCE FROM SUPABASE/);
  assert.doesNotMatch(prompt, /JOB FROM SUPABASE/);
  assert.equal(prompt.includes('x'.repeat(1000)), false);
  // 2026-08-11: RECENT_BOT_SENDS/사장 수동응대 정책 추가로 기본 프롬프트가 ~19.0KB로 성장.
  // payload 미포함 검증은 위의 x.repeat(1000) assert가 담당하므로 상한은 여유를 두고 20000.
  assert.ok(prompt.length < 20000, `prompt too large: ${prompt.length}`);
});

test('buildHermesPrompt uses navigation hints without letting code judge business meaning', () => {
  const prompt = buildHermesPrompt({ id: 'job-nav', preview_text: '중요 정재하 2 견적서 먼저 주시면 입금드릴게요! 오후 7:16' });

  assert.match(prompt, /navigation_hints/);
  assert.match(prompt, /정재하/);
  assert.match(prompt, /navigation evidence, not business classification evidence/);
  assert.match(prompt, /채팅 목록|chat list/);
  assert.match(prompt, /never type into the message compose box/);
});

test('buildHermesPrompt exposes village-ai RAG only as optional read-only reference memory', () => {
  const ragContext = buildReadOnlyRagContext({ villageAiUrl: 'https://village-ai.example', askApiSecret: 'secret-value' });
  assert.equal(ragContext.enabled, true);
  assert.equal(ragContext.provider, 'village-ai');
  assert.equal(ragContext.tool.command, 'node tools/ai-browser-worker/worker.mjs --rag-lookup');
  assert.equal(ragContext.tool.env.village_ai_url, 'VILLAGE_AI_URL');
  assert.equal(ragContext.tool.env.secret_env, 'ASK_API_SECRET');
  assert.equal(JSON.stringify(ragContext).includes('secret-value'), false);
  const prompt = buildHermesPrompt({ id: 'job-rag', preview_text: '중요 홍길동 FX3 가격 문의' }, { ragContext });
  assert.match(prompt, /READ-ONLY VILLAGE-AI RAG TOOL/);
  assert.match(prompt, /long-term reference memory/);
  assert.match(prompt, /must not replace current Kakao screen evidence/);
  assert.match(prompt, /question string itself/);
  assert.match(prompt, /RAG 답변을 그대로 복붙하지 말고/);
  assert.match(prompt, /auto_send.*call RAG/s);
  assert.match(prompt, /CURRENT_CONFIRMED_POLICY/);
  assert.match(prompt, /학생 30%/);
  assert.match(prompt, /current-policy match or high-confidence retrieved support/);
  assert.match(prompt, /"rag_usage"/);
  assert.doesNotMatch(prompt, /secret-value/);
});

test('buildReadOnlyRagContext disables gracefully when VILLAGE_AI_URL is absent', () => {
  const ragContext = buildReadOnlyRagContext({});
  assert.equal(ragContext.enabled, false);
  assert.equal(ragContext.tool, null);
  assert.match(ragContext.unavailable_reason, /VILLAGE_AI_URL/);
});

test('buildReadOnlyRagContext reports the Kakao fallback secret contract without exposing it', () => {
  const ragContext = buildReadOnlyRagContext({
    villageAiUrl: 'https://village-ai.example',
    villageAiKakaoSkillSecret: 'kakao-secret-value'
  });
  assert.equal(ragContext.tool.env.secret_env, 'VILLAGE_AI_KAKAO_SKILL_SECRET');
  assert.equal(JSON.stringify(ragContext).includes('kakao-secret-value'), false);
});

test('parseVillageAiSse accumulates text and meta events from village-ai ask stream', () => {
  const parsed = parseVillageAiSse([
    'data: {"type":"text","text":"안녕하세요"}',
    '',
    'data: {"type":"text","text":". 가능 여부 확인해드릴게요"}',
    '',
    'data: {"type":"meta","confidence":"high","ownerReview":true,"knowledgeSource":"retrieved","usedSources":["faq"],"topSimilarity":0.82,"logId":"log-1"}',
    '',
    'data: {"type":"done"}',
    ''
  ].join('\n'));
  assert.equal(parsed.text, '안녕하세요. 가능 여부 확인해드릴게요');
  assert.equal(parsed.confidence, 'high');
  assert.equal(parsed.ownerReview, true);
  assert.equal(parsed.knowledgeSource, 'retrieved');
  assert.deepEqual(parsed.usedSources, ['faq']);
  assert.equal(parsed.topSimilarity, 0.82);
  assert.equal(parsed.logId, 'log-1');
  assert.equal(parsed.done, true);
});

test('askVillageAi uses the /api/ask x-ask-api-secret contract without exposing secret', async () => {
  let captured;
  const responseBody = 'data: {"type":"text","text":"참고 답변"}\n\ndata: {"type":"meta","confidence":"low","knowledgeSource":"general","logId":"log-2"}\n\ndata: {"type":"done"}\n\n';
  const result = await askVillageAi({ question: '카카오 맥락 포함 질문', userRole: 'customer' }, {
    villageAiUrl: 'https://village-ai.example/',
    askApiSecret: 'secret-value'
  }, {
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return { ok: true, status: 200, text: async () => responseBody };
    }
  });
  assert.equal(captured.url, 'https://village-ai.example/api/ask');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.headers['x-ask-api-secret'], 'secret-value');
  assert.equal(captured.options.headers['x-kakao-skill-secret'], undefined);
  assert.equal(JSON.parse(captured.options.body).question, '카카오 맥락 포함 질문');
  assert.equal(result.text, '참고 답변');
  assert.equal(result.confidence, 'low');
  assert.equal(result.knowledgeSource, 'general');
  assert.equal(JSON.stringify(result).includes('secret-value'), false);
});

test('askVillageAi falls back to the configured Kakao skill secret contract', async () => {
  let captured;
  await askVillageAi({ question: 'historical policy question', userRole: 'customer' }, {
    villageAiUrl: 'https://village-ai.example/',
    villageAiKakaoSkillSecret: 'kakao-secret-value'
  }, {
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return { ok: true, status: 200, text: async () => 'data: {"type":"done"}\n\n' };
    }
  });
  assert.equal(captured.options.headers['x-ask-api-secret'], undefined);
  assert.equal(captured.options.headers['x-kakao-skill-secret'], 'kakao-secret-value');
});

test('processRagLookup loads the ask contract from HERMES_HOME without exposing it', async () => {
  const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'village-hermes-rag-'));
  const previous = {
    hermesHome: process.env.HERMES_HOME,
    villageAiUrl: process.env.VILLAGE_AI_URL,
    askApiSecret: process.env.ASK_API_SECRET
  };
  fs.writeFileSync(path.join(hermesHome, '.env'), [
    'VILLAGE_AI_URL=https://village-ai.example',
    'ASK_API_SECRET=secret-value'
  ].join('\n'));
  process.env.HERMES_HOME = hermesHome;
  delete process.env.VILLAGE_AI_URL;
  delete process.env.ASK_API_SECRET;

  let captured;
  try {
    const result = await processRagLookup({ question: 'historical policy question' }, {
      fetchImpl: async (url, options) => {
        captured = { url, options };
        return { ok: true, status: 200, text: async () => 'data: {"type":"done"}\n\n' };
      }
    });
    assert.equal(captured.url, 'https://village-ai.example/api/ask');
    assert.equal(captured.options.headers['x-ask-api-secret'], 'secret-value');
    assert.equal(JSON.stringify(result).includes('secret-value'), false);
  } finally {
    if (previous.hermesHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previous.hermesHome;
    if (previous.villageAiUrl === undefined) delete process.env.VILLAGE_AI_URL;
    else process.env.VILLAGE_AI_URL = previous.villageAiUrl;
    if (previous.askApiSecret === undefined) delete process.env.ASK_API_SECRET;
    else process.env.ASK_API_SECRET = previous.askApiSecret;
    fs.rmSync(hermesHome, { recursive: true, force: true });
  }
});

test('processRagLookup loads the Kakao fallback contract from HERMES_HOME', async () => {
  const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'village-hermes-rag-kakao-'));
  const previous = {
    hermesHome: process.env.HERMES_HOME,
    villageAiUrl: process.env.VILLAGE_AI_URL,
    askApiSecret: process.env.ASK_API_SECRET,
    kakaoSecret: process.env.VILLAGE_AI_KAKAO_SKILL_SECRET
  };
  fs.writeFileSync(path.join(hermesHome, '.env'), [
    'VILLAGE_AI_URL=https://village-ai.example',
    'VILLAGE_AI_KAKAO_SKILL_SECRET=kakao-secret-value'
  ].join('\n'));
  process.env.HERMES_HOME = hermesHome;
  delete process.env.VILLAGE_AI_URL;
  delete process.env.ASK_API_SECRET;
  delete process.env.VILLAGE_AI_KAKAO_SKILL_SECRET;

  let captured;
  try {
    await processRagLookup({ question: 'historical policy question' }, {
      fetchImpl: async (url, options) => {
        captured = { url, options };
        return { ok: true, status: 200, text: async () => 'data: {"type":"done"}\n\n' };
      }
    });
    assert.equal(captured.options.headers['x-ask-api-secret'], undefined);
    assert.equal(captured.options.headers['x-kakao-skill-secret'], 'kakao-secret-value');
  } finally {
    if (previous.hermesHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previous.hermesHome;
    if (previous.villageAiUrl === undefined) delete process.env.VILLAGE_AI_URL;
    else process.env.VILLAGE_AI_URL = previous.villageAiUrl;
    if (previous.askApiSecret === undefined) delete process.env.ASK_API_SECRET;
    else process.env.ASK_API_SECRET = previous.askApiSecret;
    if (previous.kakaoSecret === undefined) delete process.env.VILLAGE_AI_KAKAO_SKILL_SECRET;
    else process.env.VILLAGE_AI_KAKAO_SKILL_SECRET = previous.kakaoSecret;
    fs.rmSync(hermesHome, { recursive: true, force: true });
  }
});

test('normal stdin worker config loads only RAG settings from HERMES_HOME', () => {
  const hermesHome = fs.mkdtempSync(path.join(os.tmpdir(), 'village-hermes-worker-rag-'));
  const keys = [
    'HERMES_HOME',
    'SUPABASE_URL',
    'SUPABASE_SERVICE_ROLE_KEY',
    'VILLAGE_AI_URL',
    'ASK_API_SECRET',
    'VILLAGE_AI_KAKAO_SKILL_SECRET',
    'VILLAGE_AI_RAG_TIMEOUT_MS',
    'UNRELATED_HERMES_SECRET'
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  fs.writeFileSync(path.join(hermesHome, '.env'), [
    'VILLAGE_AI_URL=https://village-ai.example',
    'VILLAGE_AI_KAKAO_SKILL_SECRET=kakao-secret-value',
    'VILLAGE_AI_RAG_TIMEOUT_MS=12345',
    'UNRELATED_HERMES_SECRET=must-not-load'
  ].join('\n'));
  process.env.HERMES_HOME = hermesHome;
  process.env.SUPABASE_URL = 'https://supabase.example';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-value';
  delete process.env.VILLAGE_AI_URL;
  delete process.env.ASK_API_SECRET;
  delete process.env.VILLAGE_AI_KAKAO_SKILL_SECRET;
  delete process.env.VILLAGE_AI_RAG_TIMEOUT_MS;
  delete process.env.UNRELATED_HERMES_SECRET;

  try {
    const config = requireConfig();
    assert.equal(config.villageAiUrl, 'https://village-ai.example');
    assert.equal(config.askApiSecret, '');
    assert.equal(config.villageAiKakaoSkillSecret, 'kakao-secret-value');
    assert.equal(config.ragTimeoutMs, 12345);
    assert.equal(process.env.UNRELATED_HERMES_SECRET, undefined);
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    fs.rmSync(hermesHome, { recursive: true, force: true });
  }
});

test('buildHermesPrompt imports Claude Coworker policy while allowing aggressive reply drafting', () => {
  const prompt = buildHermesPrompt({ id: 'job-2', preview_text: 'FX3 내일 가능할까요?' });

  assert.match(prompt, /미리보기만 보고 분류하지 마라/);
  assert.match(prompt, /최근 24시간/s);
  assert.match(prompt, /직원.*이미 답변/s);
  assert.match(prompt, /킬 스위치/s);
  assert.match(prompt, /paused.*price_paused.*active/s);
  assert.match(prompt, /reply_decision\.replyMode="auto_send"/);
  assert.match(prompt, /suggested_reply_draft/s);
});

test('buildHermesPrompt prefers sheet writes for reservation-format requests', () => {
  const prompt = buildHermesPrompt({ id: 'job-3', preview_text: 'a7s3 2대 견적' });

  assert.match(prompt, /장비명은 AI가 최대한 추론\/정규화해서.*F열 item/s);
  assert.match(prompt, /정확 매칭이 불완전하면.*best normalized guess/s);
  assert.match(prompt, /정규화가 애매해도.*확인요청 입력은 막지 않는다/s);
  assert.match(prompt, /Q\/R에는 원문\/추론\/가용확인 후 안내/s);
  assert.match(prompt, /FX3.*A7S3.*FX6/s);
  assert.match(prompt, /할인유형: 고객DB I열이 카톡보다 우선/s);
  assert.match(prompt, /학생.*개인사업자\/프리랜서.*단골.*제휴.*일반/s);
  assert.match(prompt, /계약마스터.*스케줄상세.*확인요청/s);
  assert.match(prompt, /예약형식.*should_write_to_sheet=true/s);
  assert.match(prompt, /불확실한 장비명.*입력 차단 사유가 아니라/s);
  assert.match(prompt, /연락처.*고객DB.*확인요청 생성은 막지 말고/s);
  assert.match(prompt, /missing phone is NOT a sheet-write blocker/s);
});

test('buildHermesPrompt treats read catch-up rows as possible missed reservations', () => {
  const prompt = buildHermesPrompt({ id: 'job-read', preview_text: '중요 최민석 감사합니다. 견적서 부탁드리겠습니다 5월 29일' });

  assert.match(prompt, /read-catchup\/backstop/);
  assert.match(prompt, /마지막 버블.*네네\/감사합니다\/견적서 부탁/s);
  assert.match(prompt, /예약형식 메시지가 있으면.*확인요청\/계약\/스케줄 등록 여부를 확인/s);
  assert.match(prompt, /자동화가 만든 것이라고 추정하거나 보고하지 마라/s);
  assert.match(prompt, /기존 RQ 발견으로 중복 입력 방지/s);
  assert.match(prompt, /직원의 예약 답변.*기존 RQ.*증거가 아니다/s);
});

test('buildGasReadUrl creates read-only GAS URLs with encoded parameters', () => {
  const url = buildGasReadUrl('https://script.example/exec', 'secret key', {
    action: 'search',
    sheet: '세트마스터',
    col: 1,
    query: 'FX6 바디세트'
  });

  assert.equal(
    url,
    'https://script.example/exec?key=secret+key&action=search&sheet=%EC%84%B8%ED%8A%B8%EB%A7%88%EC%8A%A4%ED%84%B0&col=1&query=FX6+%EB%B0%94%EB%94%94%EC%84%B8%ED%8A%B8'
  );
});

test('customer DB discount normalization supports Village 2.0 segment values', () => {
  assert.equal(normalizeCustomerDbDiscountType('학생30%'), '학생');
  assert.equal(normalizeCustomerDbDiscountType('개인사업자/프리랜서20%'), '개인사업자/프리랜서');
  assert.equal(normalizeCustomerDbDiscountType('단골10%'), '단골');
  assert.equal(normalizeCustomerDbDiscountType('제휴업체20%'), '제휴');
  assert.equal(normalizeCustomerDbDiscountType(''), '');
});

test('enrichSheetPayloadWithCustomerDbDiscount overrides Kakao/general discount from Village 2.0 DB', async () => {
  const gviz = '/*O_o*/\ngoogle.visualization.Query.setResponse({"table":{"rows":['
    + '{"c":[{"v":"010-1111-2222"},{"v":"김학생"},{"v":"학생30%"}]},'
    + '{"c":[{"v":"010-3333-4444"},{"v":"박단골"},{"v":"단골10%"}]}'
    + ']}});';
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => gviz });
  const payload = {
    action: 'run',
    func: 'insertAndCheckRequest',
    args: {
      예약자명: '박단골',
      연락처: '010-3333-4444',
      할인유형: '일반',
      장비: [{ 이름: 'FX3', 수량: 1 }]
    }
  };

  const result = await enrichSheetPayloadWithCustomerDbDiscount({ fetchImpl }, payload);

  assert.equal(result.lookup.discountType, '단골');
  assert.equal(result.lookup.matchedBy, 'phone');
  assert.equal(result.payload.args.할인유형, '단골');
});

test('ensureConfirmRequestDiscountApplied patches M column when GAS normalized DB discount away', async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(String(url));
    if (String(url).includes('action=search')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ results: [{ row: 12, data: ['RQ-260710-001', '', '', '', '', 'FX3', '1', '', '', '', '박단골', '010-3333-4444', '일반'] }] }) };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, sheet: '확인요청', cell: 'M12', value: '단골' }) };
  };

  const result = await ensureConfirmRequestDiscountApplied(
    { gasApiUrl: 'https://script.example/exec', sheetApiKey: 'secret', fetchImpl },
    { success: true, reqID: 'RQ-260710-001', duplicate: false },
    { args: { 할인유형: '단골' } },
    { discountType: '단골' }
  );

  assert.equal(result.updated, true);
  assert.match(requests[1], /action=update/);
  assert.match(requests[1], /cell=M12/);
  assert.match(requests[1], /value=%EB%8B%A8%EA%B3%A8/);
});

test('buildReadOnlyLookupContext fetches kill switch and exposes read-only lookup templates', async () => {
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(url);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ data: [['price_paused']] })
    };
  };

  const context = await buildReadOnlyLookupContext(
    { gasApiUrl: 'https://script.example/exec', sheetApiKey: 'secret' },
    { preview_text: 'FX6 내일 가능할까요?' },
    { fetchImpl }
  );

  assert.equal(context.kill_switch.status, 'price_paused');
  assert.match(requested[0], /action=read/);
  assert.match(requested[0], /sheet=%EC%84%A4%EC%A0%95/);
  assert.equal(context.lookup_policy.mode, 'read_only');
  assert.match(context.lookup_urls.set_master_search_template, /action=search/);
  assert.match(context.lookup_urls.customer_db_by_name_search_template, /sheet=%EA%B3%A0%EA%B0%9DDB/);
  assert.match(context.lookup_urls.customer_db_by_name_search_template, /col=2/);
  assert.match(context.lookup_urls.village2_customer_db_discount_gviz, /SELECT\+A%2CB%2CI/);
  assert.match(context.lookup_urls.request_recent_with_results_gviz, /SELECT\+A%2CB%2CC%2CD%2CE%2CF%2CG%2CI%2CJ%2CK%2CL%2CM%2CN%2CO%2CP%2CQ%2CR/);
  assert.match(context.lookup_urls.request_by_req_id_gviz_template, /AI_REQ_ID/);
  assert.match(context.lookup_urls.request_by_req_id_gviz_template, /N%2CO%2CP/);
  assert.match(context.lookup_urls.contract_master_recent_gviz, /%EA%B3%84%EC%95%BD%EB%A7%88%EC%8A%A4%ED%84%B0/);
});

test('buildReadOnlyLookupContext reads kill switch from GAS header-only read responses', async () => {
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ sheet: '설정', rowCount: 0, headers: ['active'], data: [] })
  });

  const context = await buildReadOnlyLookupContext(
    { gasApiUrl: 'https://script.example/exec', sheetApiKey: 'secret' },
    {},
    { fetchImpl }
  );

  assert.equal(context.kill_switch.status, 'active');
});

test('buildHermesPrompt gives AI one bounded batch read tool without exposing raw GAS URLs', () => {
  const prompt = buildHermesPrompt(
    { id: 'job-4', preview_text: 'FX6' },
    {
      lookupContext: {
        kill_switch: { status: 'active' },
        lookup_policy: { mode: 'read_only' },
        lookup_tool: {
          command: 'node.exe scripts/windows/village-live-query.js batch',
          domains: ['schedule', 'inventory', 'customer']
        },
        lookup_urls: { unsafe_prompt_leak: 'https://script.google.com/macros/s/example/exec?key=secret' }
      }
    }
  );

  assert.match(prompt, /READ-ONLY VILLAGE LIVE LOOKUP/);
  assert.match(prompt, /village-live-query\.js batch/);
  assert.match(prompt, /AI.*queries.*interpret/s);
  assert.match(prompt, /one batch/i);
  assert.match(prompt, /write\/insert\/register\/send APIs.*금지/s);
  assert.doesNotMatch(prompt, /script\.google\.com\/macros/);
  assert.doesNotMatch(prompt, /unsafe_prompt_leak|key=secret/);
});

test('buildHermesPrompt requires existing RQ availability result before follow-up reporting', () => {
  const prompt = buildHermesPrompt({ id: 'job-rq', preview_text: '최재원 AX-700 가능 문의' });

  assert.match(prompt, /확인요청에 이미 RQ.*I열\(결과\).*J열\(상세\)/s);
  assert.match(prompt, /L열 연락처.*O열 등록상태.*연락처 입력 필요/s);
  assert.match(prompt, /연락처 즉시 요청 → 연락처 입력 → 가용 재확인 → 등록/);
  assert.match(prompt, /사람에게 "RQ 결과를 검토하라"고만 떠넘기지 마라/);
  assert.match(prompt, /결과가 ✅ 가용일 때만.*예약 가능/s);
  assert.match(prompt, /follow-up must report the availability result itself/s);
});

test('buildHermesArgs preserves the Mac-parity reasoning budget without exposing computer_use', () => {
  const args = buildHermesArgs('prompt text');
  assert.deepEqual(args.slice(0, 10), [
    'chat',
    '--yolo',
    '--max-turns',
    '90',
    '-Q',
    '-t',
    'terminal,file,web,skills,memory,session_search,vision',
    '-q',
    'prompt text'
  ]);
  assert.ok(args.includes('terminal,file,web,skills,memory,session_search,vision'));
  assert.equal(args.join(' ').includes('computer_use'), false);
  assert.ok(args.includes('--yolo'));
  assert.ok(buildHermesArgs('prompt text', { hermesMaxTurns: 18 }).includes('18'));
  assert.ok(buildHermesArgs('prompt text', { hermesMaxTurns: 90 }).includes('90'));
});

test('buildHermesArgs uses the native Hermes skill preload flag for the Kakao worker', () => {
  const args = buildHermesArgs('prompt text', {
    hermesSkills: 'village-operations,village-confirm-request'
  });
  const skillFlag = args.indexOf('-s');

  assert.ok(skillFlag > 0);
  assert.equal(args[skillFlag + 1], 'village-operations,village-confirm-request');
});

test('resolveHermesCommand finds hermes in launchctl-safe fallback dirs', () => {
  const resolved = resolveHermesCommand('hermes', {
    PATH: '/usr/bin:/bin',
    HOME: '/Users/village6k'
  });
  assert.match(resolved, /(^hermes$|\/hermes$)/);
});

test('resolveCuaDriverCommand finds cua-driver in launchctl-safe fallback dirs or returns empty', () => {
  const resolved = resolveCuaDriverCommand('cua-driver', {
    PATH: '/usr/bin:/bin',
    HOME: '/Users/village6k'
  });
  assert.match(resolved, /(^$|\/cua-driver$)/);
});

test('normalizeKakaoWorkerControlMode supports non-stealing DevTools modes', () => {
  assert.equal(normalizeKakaoWorkerControlMode(''), 'devtools_first');
  assert.equal(normalizeKakaoWorkerControlMode('devtools_only'), 'devtools_only');
  assert.equal(normalizeKakaoWorkerControlMode('no_cua'), 'devtools_only');
  assert.equal(normalizeKakaoWorkerControlMode('cua_first'), 'cua_first');
});

test('parseMacHidIdleSeconds converts macOS idle nanoseconds', () => {
  assert.equal(parseMacHidIdleSeconds('    "HIDIdleTime" = 2500000000'), 2.5);
  assert.equal(parseMacHidIdleSeconds('no idle field'), null);
});

test('checkKakaoCuaFallbackAllowed gates CUA by mode before touching the screen', async () => {
  assert.deepEqual(
    await checkKakaoCuaFallbackAllowed({ mode: 'devtools_only', minIdleSeconds: 120 }),
    { allowed: false, mode: 'devtools_only', reason: 'cua_disabled_by_control_mode' }
  );
  assert.deepEqual(
    await checkKakaoCuaFallbackAllowed({ mode: 'cua_first', minIdleSeconds: 120 }),
    { allowed: true, mode: 'cua_first', reason: 'cua_first_mode' }
  );
  assert.deepEqual(
    await checkKakaoCuaFallbackAllowed({ mode: 'devtools_first', minIdleSeconds: 0 }),
    { allowed: true, mode: 'devtools_first', reason: 'idle_guard_disabled' }
  );
});

test('buildKakaoTabAppleScript focuses existing Kakao Channel Manager tabs or opens one', () => {
  const script = buildKakaoTabAppleScript();
  assert.match(script, /business\.kakao\.com/);
  assert.match(script, /center-pf\.kakao\.com/);
  assert.match(script, /tabUrl contains "\/chats\/"/);
  assert.match(script, / - 빌리지 - 카카오비즈니스/);
  assert.match(script, /set URL of tab t of window w to targetUrl/);
  assert.match(script, /set URL of active tab of newWindow to targetUrl/);
  assert.doesNotMatch(script, /make new window with properties/);
  assert.match(script, /active tab index/);
  assert.match(script, /activate/);
  assert.match(script, /targetUrl/);
});

test('kakaoDevtoolsBaseUrlFromEnv resolves explicit URL and port envs', () => {
  assert.equal(kakaoDevtoolsBaseUrlFromEnv({ KAKAO_DEVTOOLS_URL: 'http://127.0.0.1:9444/' }), 'http://127.0.0.1:9444');
  assert.equal(kakaoDevtoolsBaseUrlFromEnv({ KAKAO_REMOTE_DEBUGGING_PORT: '9223' }), 'http://127.0.0.1:9223');
  assert.equal(kakaoDevtoolsBaseUrlFromEnv({}), '');
});

test('pickKakaoMainListTarget selects list tab and avoids customer popup', () => {
  const target = pickKakaoMainListTarget([
    { id: 'popup', type: 'page', url: 'https://business.kakao.com/_x/chats', title: '최재형 - 빌리지 - 카카오비즈니스 파트너센터' },
    { id: 'conversation-url', type: 'page', url: 'https://business.kakao.com/_x/chats/4925785461840981', title: 'Loading...' },
    { id: 'main', type: 'page', url: 'https://center-pf.kakao.com/_x/chats', title: '카카오비즈니스 파트너센터' }
  ]);
  assert.equal(target.id, 'main');
});

test('ensureKakaoChannelManagerTabViaDevtools reuses automation profile tab without activating it', async () => {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, method: init.method || 'GET' });
    if (url === 'http://127.0.0.1:9223/json/list') {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify([
          { id: 'main-tab', type: 'page', url: 'https://center-pf.kakao.com/_x/chats', title: '카카오비즈니스 파트너센터' }
        ])
      };
    }
    throw new Error(`unexpected request ${url}`);
  };

  const result = await ensureKakaoChannelManagerTabViaDevtools({
    cdpBaseUrl: 'http://127.0.0.1:9223',
    fetchImpl
  });

  assert.deepEqual(result, {
    status: 'ready_list_via_devtools',
    targetId: 'main-tab',
    url: 'https://center-pf.kakao.com/_x/chats'
  });
  assert.deepEqual(requests.map((request) => request.method), ['GET']);
});

test('ensureKakaoChannelManagerTab invokes osascript with target chat URL when CDP is not configured', { skip: process.platform !== 'darwin' }, async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 222;
  let command;
  let args;
  const spawnImpl = (cmd, argv) => {
    command = cmd;
    args = argv;
    return child;
  };

  const resultPromise = ensureKakaoChannelManagerTab({
    url: 'https://business.kakao.com/test/chats',
    timeoutMs: 1000,
    spawnImpl,
    cdpBaseUrl: ''
  });
  child.stdout.write('focused_list\n');
  child.emit('close', 0);

  assert.deepEqual(await resultPromise, { status: 'focused_list' });
  assert.equal(command, 'osascript');
  assert.equal(args[0], '-e');
  assert.match(args[1], /Google Chrome/);
  assert.equal(args[2], 'https://business.kakao.com/test/chats');
});

test('pickKakaoMainListWindow avoids individual Kakao chat popup windows', () => {
  const win = pickKakaoMainListWindow([
    { app_name: 'Google Chrome', title: '여찬영 - 빌리지 - 카카오비즈니스 파트너센터', is_on_screen: true, bounds: { width: 380, height: 816 } },
    { app_name: 'Google Chrome', title: '카카오비즈니스 파트너센터', is_on_screen: true, bounds: { width: 1280, height: 1050 }, pid: 2, window_id: 20 }
  ]);
  assert.equal(win.pid, 2);
});

test('pickKakaoMainListWindow prefers automation Chrome and excludes staff Chrome', () => {
  const win = pickKakaoMainListWindow([
    { app_name: 'Google Chrome', title: '카카오비즈니스 파트너센터 - Chrome - BILL. (💁🏻 직원용 크롬)', is_on_screen: true, bounds: { width: 1600, height: 1200 }, pid: 1, window_id: 10 },
    { app_name: 'Google Chrome', title: '카카오비즈니스 파트너센터 - Chrome - 수이 (🤖 자동화 크롬)', is_on_screen: false, bounds: { width: 800, height: 600 }, pid: 2, window_id: 20 }
  ]);
  assert.equal(win.pid, 2);
  assert.equal(win.window_id, 20);
});

test('pickKakaoConversationWindow selects individual Kakao popup matching navigation hint', () => {
  const win = pickKakaoConversationWindow([
    { app_name: 'Google Chrome', title: '카카오비즈니스 파트너센터', pid: 1, window_id: 10 },
    { app_name: 'Google Chrome', title: '박재인 - 빌리지 - 카카오비즈니스 파트너센터', is_on_screen: true, pid: 3, window_id: 30 }
  ], ['박재인']);
  assert.equal(win.pid, 3);
  assert.equal(win.window_id, 30);
});

test('pickKakaoConversationWindow excludes staff Chrome popups and prefers automation Chrome', () => {
  const win = pickKakaoConversationWindow([
    { app_name: 'Google Chrome', title: '박재인 - 빌리지 - 카카오비즈니스 파트너센터 - Chrome - BILL. (💁🏻 직원용 크롬)', is_on_screen: true, pid: 1, window_id: 10 },
    { app_name: 'Google Chrome', title: '박재인 - 빌리지 - 카카오비즈니스 파트너센터 - Chrome - 수이 (🤖 자동화 크롬)', is_on_screen: false, pid: 2, window_id: 20 }
  ], ['박재인']);
  assert.equal(win.pid, 2);
  assert.equal(win.window_id, 20);
});

test('pickKakaoConversationTarget selects DevTools customer chat target by hint', () => {
  const target = pickKakaoConversationTarget([
    { type: 'page', title: '카카오비즈니스 파트너센터', url: 'https://business.kakao.com/_xhPMls/chats', id: 'list' },
    { type: 'page', title: '박재인 - 빌리지 - 카카오비즈니스 파트너센터', url: 'https://business.kakao.com/_xhPMls/chats/123', id: 'chat' }
  ], ['박재인']);
  assert.equal(target.id, 'chat');
});

test('pickKakaoMainListTarget accepts the Kakao chat-list trailing slash', () => {
  const target = pickKakaoMainListTarget([
    { type: 'page', title: 'Kakao channel manager', url: 'https://business.kakao.com/_xhPMls/chats/', id: 'only-tab' }
  ]);
  assert.equal(target?.id, 'only-tab');
});

test('same-target Kakao navigation is marked unsafe to close', async () => {
  let listCalls = 0;
  const fetchImpl = async () => {
    listCalls += 1;
    const targets = listCalls === 1
      ? [{ type: 'page', id: 'only-tab', title: 'Kakao channel manager', url: 'https://business.kakao.com/_xhPMls/chats/', webSocketDebuggerUrl: 'ws://only-tab' }]
      : [{ type: 'page', id: 'only-tab', title: 'Customer - Kakao', url: 'https://business.kakao.com/_xhPMls/chats/123', webSocketDebuggerUrl: 'ws://only-tab' }];
    return { ok: true, status: 200, text: async () => JSON.stringify(targets) };
  };
  const result = await openKakaoTargetChatViaDevtools({
    room_key: 'chat:123', customer_name: 'Customer', preview_text: 'Customer reservation request'
  }, {
    cdpBaseUrl: 'http://127.0.0.1:9223',
    fetchImpl,
    evaluateImpl: async (target) => target.url.endsWith('/chats/')
      ? { ok: true, status: 'clicked_chat_row_via_devtools', searchTerm: 'Customer', tried: ['Customer'] }
      : { title: target.title, href: target.url, text: 'Customer reservation request' }
  });

  assert.equal(result.status, 'opened_target_chat');
  assert.equal(result.conversation_target.id, 'only-tab');
  assert.equal(result.conversation_target.close_safe, false);
});

test('openKakaoTargetChatViaDevtools selects the exact room target when the popup title omits the customer hint', async () => {
  const targets = [
    { type: 'page', id: 'list', title: '카카오비즈니스 파트너센터', url: 'https://business.kakao.com/_xhPMls/chats', webSocketDebuggerUrl: 'ws://list' },
    { type: 'page', id: 'chat', title: '카카오비즈니스 파트너센터', url: 'https://business.kakao.com/_xhPMls/chats/4977448429395319', webSocketDebuggerUrl: 'ws://chat' }
  ];
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(targets) });
  const evaluateImpl = async (target) => ({
    title: target.title,
    href: target.url,
    text: '채팅방\n한강희\n죄송합니다 사장님 감사드립니다\n채팅 메시지 입력 폼'
  });

  const result = await openKakaoTargetChatViaDevtools({
    room_key: 'chat:4977448429395319',
    customer_name: '한강희',
    preview_text: '한강희 죄송합니다 사장님 감사드립니다'
  }, { cdpBaseUrl: 'http://127.0.0.1:9223', fetchImpl, evaluateImpl });

  assert.equal(result.status, 'opened_target_chat');
  assert.equal(result.already_open, true);
  assert.equal(result.conversation_target.id, 'chat');
  assert.equal(result.conversation_evidence.hint_matched, true);
});

test('findChatRowElementIndex finds AXLink row from navigation hint', () => {
  const tree = `
- [170] AXButton "중요"
- [171] AXLink (정진우 네, 장비 준비돼 있는 거 반출 하시면 됩니다 오후 8:20) actions=[AXShowMenu, AXScrollToVisible]
- [172] AXStaticText = "정진우"
`;
  assert.equal(findChatRowElementIndex(tree, ['정진우']), 171);
});

test('findChatRowElementIndex also matches hints rendered in AXLink child text', () => {
  const tree = `
- [170] AXButton "중요"
- [171] AXLink actions=[AXShowMenu, AXScrollToVisible]
  - [172] AXStaticText = "정진우"
  - [173] AXStaticText = "네, 장비 준비돼 있는 거 반출 하시면 됩니다"
  - [174] AXStaticText = "오후 8:20"
`;
  assert.equal(findChatRowElementIndex(tree, ['정진우']), 171);
});

test('findKakaoChatSearchInputElementIndex finds chat search field and ignores message composer', () => {
  const tree = `
- [11] AXTextField "주소창"
- [100] AXStaticText = "채팅방 검색"
- [101] AXTextField "고객 이름 또는 채팅방 검색"
- [500] AXStaticText = "채팅 메시지 입력 폼"
- [501] AXTextArea "메시지 입력"
`;
  assert.equal(findKakaoChatSearchInputElementIndex(tree), 101);
});

test('extractKakaoConversationEvidence returns compact live AX text tail without classifying', () => {
  const tree = `
- [11] AXStaticText = "박재인"
- [12] AXStaticText = "친구"
- [459] AXStaticText = "80메모리, 배터리 1개 추가 반출"
- [500] AXStaticText = "내일 촬영 종료 후 함께 반납하겠습니다."
- [501] AXStaticText = "감사합니다!"
- [510] AXStaticText = "채팅 메시지 입력 폼"
`;
  const evidence = extractKakaoConversationEvidence(tree, { title: '박재인 - 빌리지 - 카카오비즈니스 파트너센터', hints: ['박재인'], maxItems: 4 });
  assert.equal(evidence.source, 'live_kakao_ax_after_navigation');
  assert.equal(evidence.hint_matched, true);
  assert.deepEqual(evidence.visible_static_text_tail, ['박재인', '80메모리, 배터리 1개 추가 반출', '내일 촬영 종료 후 함께 반납하겠습니다.', '감사합니다!']);
  assert.match(evidence.note, /not a deterministic business classification/);
});

test('openKakaoTargetChatFromList clicks matching AXLink row only for navigation', async () => {
  const calls = [];
  let listCalls = 0;
  const spawnImpl = (cmd, args) => {
    calls.push({ cmd, args });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      if (args.includes('list_windows')) {
        listCalls += 1;
        const windows = listCalls === 1
          ? [{ app_name: 'Google Chrome', title: '카카오비즈니스 파트너센터', is_on_screen: true, bounds: { width: 1280, height: 1050 }, pid: 7, window_id: 70 }]
          : [
              { app_name: 'Google Chrome', title: '카카오비즈니스 파트너센터', is_on_screen: true, bounds: { width: 1280, height: 1050 }, pid: 7, window_id: 70 },
              { app_name: 'Google Chrome', title: '정진우 - 빌리지 - 카카오비즈니스 파트너센터', is_on_screen: true, pid: 8, window_id: 80 }
            ];
        child.stdout.write(JSON.stringify({ windows }));
        child.emit('close', 0);
      } else if (args.includes('get_window_state')) {
        child.stdout.write(JSON.stringify({ tree_markdown: '- [171] AXLink (정진우 네, 장비 준비돼 있는 거 반출 하시면 됩니다 오후 8:20)\n- [22] AXStaticText = "정진우"' }));
        child.emit('close', 0);
      } else if (args.includes('click')) {
        child.stdout.write(JSON.stringify({ ok: true }));
        child.emit('close', 0);
      } else {
        child.stderr.write('unexpected');
        child.emit('close', 1);
      }
    });
    return child;
  };
  const result = await openKakaoTargetChatFromList({ preview_text: '중요 정진우 네, 장비 준비돼 있는 거 반출 하시면 됩니다 오후 8:20' }, { spawnImpl });
  assert.equal(result.status, 'opened_target_chat');
  assert.equal(result.element_index, 171);
  assert.equal(result.conversation_window.window_id, 80);
  assert.ok(calls.some((c) => c.args.includes('click')));
});

test('openKakaoTargetChatFromList rejects staff-profile Kakao windows before clicking/searching', async () => {
  const calls = [];
  let listCalls = 0;
  const spawnImpl = (cmd, args) => {
    calls.push({ cmd, args });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      if (args.includes('list_windows')) {
        listCalls += 1;
        const windows = listCalls === 1
          ? [
              { app_name: 'Google Chrome', title: '카카오비즈니스 파트너센터', is_on_screen: true, bounds: { width: 1280, height: 1050 }, pid: 7, window_id: 70 },
              { app_name: 'Google Chrome', title: '카카오비즈니스 파트너센터', is_on_screen: true, bounds: { width: 1280, height: 1050 }, pid: 7, window_id: 71 }
            ]
          : [
              { app_name: 'Google Chrome', title: '김자동 - 빌리지 - 카카오비즈니스 파트너센터', is_on_screen: true, pid: 7, window_id: 80 },
              { app_name: 'Google Chrome', title: '김자동 - 빌리지 - 카카오비즈니스 파트너센터', is_on_screen: true, pid: 7, window_id: 81 }
            ];
        child.stdout.write(JSON.stringify({ windows }));
        child.emit('close', 0);
      } else if (args.includes('get_window_state')) {
        const payload = JSON.parse(args[args.findIndex((arg) => String(arg).startsWith('{'))]);
        const treeByWindow = {
          70: 'AXWindow "카카오비즈니스 파트너센터 - Chrome - BILL. (💁🏻 직원용 크롬)"\n- [171] AXLink (김자동 문의 오후 8:20)',
          71: 'AXWindow "카카오비즈니스 파트너센터 - Chrome - 수이 (🤖 자동화 크롬)"\n- [171] AXLink (김자동 문의 오후 8:20)',
          80: 'AXWindow "김자동 - 빌리지 - 카카오비즈니스 파트너센터 - Chrome - BILL. (💁🏻 직원용 크롬)"\n- [22] AXStaticText = "김자동"',
          81: 'AXWindow "김자동 - 빌리지 - 카카오비즈니스 파트너센터 - Chrome - 수이 (🤖 자동화 크롬)"\n- [22] AXStaticText = "김자동"\n- [23] AXStaticText = "문의"'
        };
        child.stdout.write(JSON.stringify({ tree_markdown: treeByWindow[payload.window_id] || '' }));
        child.emit('close', 0);
      } else if (args.includes('click')) {
        child.stdout.write(JSON.stringify({ ok: true }));
        child.emit('close', 0);
      } else {
        child.stderr.write('unexpected');
        child.emit('close', 1);
      }
    });
    return child;
  };

  const result = await openKakaoTargetChatFromList({ customer_name: '김자동', preview_text: '김자동 문의 오후 8:20' }, { spawnImpl });
  assert.equal(result.status, 'opened_target_chat');
  assert.equal(result.window_id, 71);
  assert.equal(result.conversation_window.window_id, 81);
  const clickCall = calls.find((c) => c.args.includes('click'));
  assert.ok(clickCall);
  assert.match(clickCall.args.join(' '), /"window_id":71/);
});

test('openKakaoTargetChatFromList uses an already-open matching conversation before searching the list', async () => {
  const calls = [];
  const spawnImpl = (cmd, args) => {
    calls.push({ cmd, args });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      if (args.includes('list_windows')) {
        child.stdout.write(JSON.stringify({
          windows: [
            { app_name: 'Google Chrome', title: '카카오비즈니스 파트너센터', is_on_screen: true, bounds: { width: 1280, height: 1050 }, pid: 7, window_id: 70 },
            { app_name: 'Google Chrome', title: '정진우 - 빌리지 - 카카오비즈니스 파트너센터', is_on_screen: true, pid: 8, window_id: 80 }
          ]
        }));
        child.emit('close', 0);
      } else if (args.includes('get_window_state')) {
        child.stdout.write(JSON.stringify({ tree_markdown: '- [22] AXStaticText = "정진우"\n- [23] AXStaticText = "네, 장비 준비돼 있는 거 반출 하시면 됩니다"' }));
        child.emit('close', 0);
      } else {
        child.stderr.write('unexpected');
        child.emit('close', 1);
      }
    });
    return child;
  };

  const result = await openKakaoTargetChatFromList({ preview_text: '중요 정진우 네, 장비 준비돼 있는 거 반출 하시면 됩니다 오후 8:20' }, { spawnImpl });
  assert.equal(result.status, 'opened_target_chat');
  assert.equal(result.already_open, true);
  assert.equal(result.conversation_window.window_id, 80);
  assert.equal(result.conversation_evidence.hint_matched, true);
  assert.equal(calls.some((c) => c.args.includes('click')), false);
});

test('openKakaoTargetChatFromList uses DevTools when matching conversation is on another macOS Space', async () => {
  const spawnImpl = (_cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      if (args.includes('list_windows')) {
        child.stdout.write(JSON.stringify({
          windows: [
            { app_name: 'Google Chrome', title: '카카오비즈니스 파트너센터', is_on_screen: false, pid: 7, window_id: 70 },
            { app_name: 'Google Chrome', title: '오래된고객 - 빌리지 - 카카오비즈니스 파트너센터', is_on_screen: false, pid: 8, window_id: 80 }
          ]
        }));
        child.emit('close', 0);
      } else {
        child.stderr.write('unexpected');
        child.emit('close', 1);
      }
    });
    return child;
  };
  let listCalls = 0;
  const fetchImpl = async () => {
    listCalls += 1;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify([
        { type: 'page', id: 'chat', title: '오래된고객 - 빌리지 - 카카오비즈니스 파트너센터', url: 'https://business.kakao.com/_xhPMls/chats/123', webSocketDebuggerUrl: 'ws://chat' }
      ])
    };
  };
  const result = await openKakaoTargetChatFromList({
    customer_name: '오래된고객',
    preview_text: '오래된고객 문의'
  }, {
    spawnImpl,
    cdpBaseUrl: 'http://fake-devtools',
    fetchImpl,
    evaluateImpl: async () => ({ title: '오래된고객 - 빌리지 - 카카오비즈니스 파트너센터', text: '오래된고객\n문의 내용' })
  });
  assert.equal(result.status, 'opened_target_chat');
  assert.equal(result.via_devtools, true);
  assert.equal(result.conversation_target.id, 'chat');
  assert.equal(listCalls, 1);
});

test('openKakaoTargetChatFromList searches by customer name when target row is not visible', async () => {
  const calls = [];
  let listCalls = 0;
  let stateCalls = 0;
  const spawnImpl = (cmd, args) => {
    calls.push({ cmd, args });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      if (args.includes('list_windows')) {
        listCalls += 1;
        const windows = listCalls === 1
          ? [{ app_name: 'Google Chrome', title: '카카오비즈니스 파트너센터', is_on_screen: true, bounds: { width: 1280, height: 1050 }, pid: 7, window_id: 70 }]
          : [
              { app_name: 'Google Chrome', title: '카카오비즈니스 파트너센터', is_on_screen: true, bounds: { width: 1280, height: 1050 }, pid: 7, window_id: 70 },
              { app_name: 'Google Chrome', title: '오래된고객 - 빌리지 - 카카오비즈니스 파트너센터', is_on_screen: true, pid: 8, window_id: 80 }
            ];
        child.stdout.write(JSON.stringify({ windows }));
        child.emit('close', 0);
      } else if (args.includes('get_window_state')) {
        stateCalls += 1;
        const tree = stateCalls === 1
          ? '- [100] AXStaticText = "채팅방 검색"\n- [101] AXTextField "고객 이름 또는 채팅방 검색"\n- [171] AXLink (최근고객 네 오후 8:20)'
          : '- [101] AXTextField "고객 이름 또는 채팅방 검색"\n- [222] AXLink (오래된고객 지난 문의 이어서 확인 부탁드립니다 오후 1:10)\n- [223] AXStaticText = "오래된고객"';
        child.stdout.write(JSON.stringify({ tree_markdown: tree }));
        child.emit('close', 0);
      } else if (args.includes('press_key') || args.includes('type_text') || args.includes('click')) {
        child.stdout.write(JSON.stringify({ ok: true }));
        child.emit('close', 0);
      } else {
        child.stderr.write('unexpected');
        child.emit('close', 1);
      }
    });
    return child;
  };

  const result = await openKakaoTargetChatFromList({
    customer_name: '오래된고객',
    preview_text: '오래된고객 지난 문의 이어서 확인 부탁드립니다'
  }, { spawnImpl });

  assert.equal(result.status, 'opened_target_chat');
  assert.equal(result.element_index, 222);
  assert.equal(result.search.searched, true);
  assert.equal(result.search.search_term, '오래된고객');
  assert.equal(result.conversation_window.window_id, 80);
  assert.ok(calls.some((c) => c.args.includes('type_text') && c.args.join(' ').includes('오래된고객')));
});

test('openKakaoTargetChatFromList skips Kakao search typing when search fallback is disabled', async () => {
  const calls = [];
  const spawnImpl = (cmd, args) => {
    calls.push({ cmd, args });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      if (args.includes('list_windows')) {
        child.stdout.write(JSON.stringify({
          windows: [{ app_name: 'Google Chrome', title: '카카오비즈니스 파트너센터', is_on_screen: true, bounds: { width: 1280, height: 1050 }, pid: 7, window_id: 70 }]
        }));
        child.emit('close', 0);
      } else if (args.includes('get_window_state')) {
        child.stdout.write(JSON.stringify({
          tree_markdown: '- [100] AXStaticText = "채팅방 검색"\n- [101] AXTextField "고객 이름 또는 채팅방 검색"\n- [171] AXLink (최근고객 네 오후 8:20)'
        }));
        child.emit('close', 0);
      } else {
        child.stderr.write('unexpected');
        child.emit('close', 1);
      }
    });
    return child;
  };

  const result = await openKakaoTargetChatFromList({
    customer_name: '오래된고객',
    preview_text: '오래된고객 지난 문의 이어서 확인 부탁드립니다'
  }, {
    spawnImpl,
    controlMode: 'cua_first',
    cdpBaseUrl: '',
    allowSearch: false
  });

  assert.equal(result.status, 'chat_row_not_found');
  assert.equal(result.search.disabled, true);
  assert.equal(result.search.reason, 'search_disabled');
  assert.ok(!calls.some((c) => c.args.includes('type_text')));
});

test('openKakaoTargetChatViaDevtools searches list DOM when CUA cannot see off-space Chrome body', async () => {
  const evalCalls = [];
  let listCalls = 0;
  const fetchImpl = async (url) => {
    listCalls += 1;
    const targets = listCalls === 1
      ? [{ type: 'page', id: 'list', title: '카카오비즈니스 파트너센터', url: 'https://business.kakao.com/_xhPMls/chats', webSocketDebuggerUrl: 'ws://list' }]
      : [
          { type: 'page', id: 'list', title: '카카오비즈니스 파트너센터', url: 'https://business.kakao.com/_xhPMls/chats', webSocketDebuggerUrl: 'ws://list' },
          { type: 'page', id: 'chat', title: '오래된고객 - 빌리지 - 카카오비즈니스 파트너센터', url: 'https://business.kakao.com/_xhPMls/chats/123', webSocketDebuggerUrl: 'ws://chat' }
        ];
    return { ok: true, status: 200, text: async () => JSON.stringify(targets) };
  };
  const evaluateImpl = async (target, expression) => {
    evalCalls.push({ target, expression });
    if (target.id === 'list') return { ok: true, status: 'clicked_chat_row_via_devtools', searchTerm: '오래된고객', tried: ['오래된고객'] };
    return { title: target.title, href: target.url, text: '채팅방 레이어\n오래된고객\n지난 문의 이어서 확인 부탁드립니다\n채팅 메시지 입력 폼' };
  };

  const result = await openKakaoTargetChatViaDevtools({
    customer_name: '오래된고객',
    preview_text: '오래된고객 지난 문의 이어서 확인 부탁드립니다'
  }, { cdpBaseUrl: 'http://127.0.0.1:9223', fetchImpl, evaluateImpl });

  assert.equal(result.status, 'opened_target_chat');
  assert.equal(result.via_devtools, true);
  assert.equal(result.opened_by_devtools_search, true);
  assert.equal(result.conversation_target.id, 'chat');
  assert.equal(result.search.search_term, '오래된고객');
  assert.equal(result.conversation_evidence.hint_matched, true);
  assert.ok(evalCalls[0].expression.includes('input[placeholder*="채팅방 이름"]'));
});

test('openKakaoTargetChatViaDevtools can avoid visible Kakao search fallback', async () => {
  let listCalls = 0;
  const fetchImpl = async () => {
    listCalls += 1;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify([
        { type: 'page', id: 'list', title: '카카오비즈니스 파트너센터', url: 'https://business.kakao.com/_xhPMls/chats', webSocketDebuggerUrl: 'ws://list' }
      ])
    };
  };
  const evaluateImpl = async (target, expression) => {
    assert.equal(target.id, 'list');
    assert.match(expression, /allowSearchArg/);
    assert.match(expression, /false\)$/);
    return { ok: false, status: 'visible_chat_row_not_found_search_disabled', tried: [] };
  };

  const result = await openKakaoTargetChatViaDevtools({
    customer_name: '오래된고객',
    preview_text: '오래된고객 지난 문의 이어서 확인 부탁드립니다'
  }, {
    cdpBaseUrl: 'http://127.0.0.1:9223',
    fetchImpl,
    evaluateImpl,
    allowSearch: false
  });

  assert.equal(result.status, 'visible_chat_row_not_found_search_disabled');
  assert.equal(result.search.searched, false);
  assert.equal(result.search.disabled, true);
  assert.equal(listCalls, 1);
});

test('openKakaoTargetChatFromList does not claim verified chat when popup is missing', async () => {
  const spawnImpl = (cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      if (args.includes('list_windows')) {
        child.stdout.write(JSON.stringify({ windows: [{ app_name: 'Google Chrome', title: '카카오비즈니스 파트너센터', is_on_screen: true, bounds: { width: 1280, height: 1050 }, pid: 7, window_id: 70 }] }));
        child.emit('close', 0);
      } else if (args.includes('get_window_state')) {
        child.stdout.write(JSON.stringify({ tree_markdown: '- [171] AXLink (정진우 네, 장비 준비돼 있는 거 반출 하시면 됩니다 오후 8:20)' }));
        child.emit('close', 0);
      } else if (args.includes('click')) {
        child.stdout.write(JSON.stringify({ ok: true }));
        child.emit('close', 0);
      } else {
        child.stderr.write('unexpected');
        child.emit('close', 1);
      }
    });
    return child;
  };

  const result = await openKakaoTargetChatFromList({ preview_text: '중요 정진우 네, 장비 준비돼 있는 거 반출 하시면 됩니다 오후 8:20' }, { spawnImpl });
  assert.equal(result.status, 'conversation_window_not_found_after_click');
  assert.equal(result.conversation_window, null);
  assert.equal(result.conversation_evidence.hint_matched, false);
});

test('runHermes rejects quickly and terminates child process tree on timeout', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 12345;
  let killedPid = null;
  const spawnImpl = () => child;
  const killTree = (pid) => {
    killedPid = pid;
    child.emit('close', null, 'SIGTERM');
  };

  await assert.rejects(
    runHermes('prompt text', { hermesCommand: 'fake-hermes', hermesTimeoutMs: 25 }, { spawnImpl, killTree }),
    /timed out after 25ms/
  );
  assert.equal(killedPid, 12345);
});

test('runHermes aborts and terminates a stale same-room decision before timeout', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 12355;
  let killedPid = null;
  const controller = new AbortController();
  const resultPromise = runHermes(
    'prompt text',
    { hermesCommand: 'fake-hermes', hermesTimeoutMs: 25 },
    {
      spawnImpl: () => child,
      killTree(pid) { killedPid = pid; },
      signal: controller.signal
    }
  );

  controller.abort(new Error('superseded_by_newer_room_event'));

  await assert.rejects(resultPromise, /superseded_by_newer_room_event/);
  assert.equal(killedPid, 12355);
});

test('job freshness guard aborts when the bridge reports a newer room revision', async () => {
  const guard = createJobFreshnessGuard({
    bridgeUrl: 'http://127.0.0.1:8787',
    roomKey: 'chat:test-room',
    roomRevision: 4,
    pollIntervalMs: 60_000,
    fetchImpl: async () => ({
      ok: true,
      async json() {
        return { ok: true, superseded: true, latestRevision: 5 };
      }
    })
  });

  await guard.checkNow();

  assert.equal(guard.signal.aborted, true);
  assert.match(String(guard.signal.reason?.message || guard.signal.reason), /superseded_by_newer_room_event/);
  guard.stop();
});

test('job log fallback detects a newer accepted job for the same room', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'village-job-freshness-'));
  const jobLogPath = path.join(dir, 'jobs.ndjson');
  fs.writeFileSync(jobLogPath, [
    JSON.stringify({ detectedAt: '2026-07-31T08:00:00.000Z', roomKey: 'chat:test-room', jobId: 'old-job' }),
    JSON.stringify({ detectedAt: '2026-07-31T08:01:00.000Z', roomKey: 'chat:other-room', jobId: 'other-job' }),
    JSON.stringify({ detectedAt: '2026-07-31T08:02:00.000Z', roomKey: 'chat:test-room', jobId: 'old-job' }),
    JSON.stringify({ detectedAt: '2026-07-31T08:03:00.000Z', roomKey: 'chat:test-room', jobId: 'new-job' })
  ].join('\n'));

  assert.equal(await isJobSupersededByJobLog({
    jobLogPath,
    roomKey: 'chat:test-room',
    jobId: 'old-job',
    detectedAt: '2026-07-31T08:00:00.000Z'
  }), true);
  assert.equal(await isJobSupersededByJobLog({
    jobLogPath,
    roomKey: 'chat:test-room',
    jobId: 'new-job',
    detectedAt: '2026-07-31T08:03:00.000Z'
  }), false);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('Windows Hermes stays inside the worker process tree so outer timeouts cannot orphan recovery agents', () => {
  assert.equal(shouldDetachHermesProcess('win32'), false);
  assert.equal(shouldDetachHermesProcess('linux'), true);
});

test('terminateChildTree uses Windows taskkill for the exact Hermes process tree', () => {
  const calls = [];
  let fallbackKilled = false;
  const child = {
    pid: 43210,
    kill() {
      fallbackKilled = true;
    }
  };

  terminateChildTree(child, 'SIGTERM', {
    platform: 'win32',
    spawnSyncImpl(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, error: null };
    },
    processKillImpl() {
      throw new Error('POSIX process groups are unavailable on Windows');
    }
  });

  assert.deepEqual(calls, [{
    command: 'taskkill.exe',
    args: ['/PID', '43210', '/T', '/F'],
    options: { windowsHide: true, stdio: 'ignore' }
  }]);
  assert.equal(fallbackKilled, false);
});

test('runHermes returns stdout before timeout when Hermes exits normally', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 12346;
  const spawnImpl = () => child;

  const resultPromise = runHermes('prompt text', { hermesCommand: 'fake-hermes', hermesTimeoutMs: 1000 }, { spawnImpl });
  child.stdout.write('FINAL_JSON\n```json\n{}\n```');
  child.emit('close', 0);

  assert.equal(await resultPromise, 'FINAL_JSON\n```json\n{}\n```');
});

test('runHermes returns a complete accepted decision without waiting for a hung CLI process to close', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 12349;
  let killedPid = null;
  const output = 'FINAL_JSON\n{"classification":"faq","should_write_to_sheet":false}';

  const resultPromise = runHermes(
    'prompt text',
    { hermesCommand: 'fake-hermes', hermesTimeoutMs: 1000 },
    {
      spawnImpl: () => child,
      killTree(pid) { killedPid = pid; },
      acceptOutput(value) { return value === output; }
    }
  );
  child.stdout.write(output);

  assert.equal(await resultPromise, output);
  assert.equal(killedPid, 12349);
});

test('runHermes can invoke the Windows canonical Python module without the hanging console launcher', async () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 12348;
  let seenCommand = null;
  let seenArgs = null;
  let stdinPayload = '';
  child.stdin.on('data', (chunk) => { stdinPayload += chunk.toString(); });
  const spawnImpl = (command, args) => {
    seenCommand = command;
    seenArgs = args;
    return child;
  };

  const resultPromise = runHermes(
    'prompt text',
    {
      hermesCommand: 'C:\\Hermes\\venv\\Scripts\\python.exe',
      hermesPythonModule: true,
      hermesProfile: 'kakaoworker',
      hermesTimeoutMs: 1000
    },
    { spawnImpl, platform: 'win32' }
  );
  child.stdout.write('OK');
  child.emit('close', 0);

  assert.equal(await resultPromise, 'OK');
  assert.equal(seenCommand, 'C:\\Hermes\\venv\\Scripts\\python.exe');
  assert.equal(seenArgs.length, 1);
  assert.match(seenArgs[0], /hermes-stdin-runner\.py$/);
  assert.doesNotMatch(seenArgs.join(' '), /prompt text/);
  const payload = JSON.parse(stdinPayload);
  assert.deepEqual(payload.argv.slice(0, 4), ['--profile', 'kakaoworker', 'chat', '--yolo']);
  assert.equal(payload.query, 'prompt text');
});

test('the Windows stdin transport helper is versioned beside the worker', () => {
  const helperPath = new URL('./hermes-stdin-runner.py', import.meta.url);
  assert.equal(fs.existsSync(helperPath), true, 'runtime promotion must include hermes-stdin-runner.py');
});

test('runHermes does not force AX-only capture or truncate computer_use evidence', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 12347;
  let seenOptions = null;
  const spawnImpl = (_cmd, _args, options) => {
    seenOptions = options;
    return child;
  };

  const resultPromise = runHermes(
    'prompt text',
    { hermesCommand: 'fake-hermes', hermesTimeoutMs: 1000 },
    { spawnImpl, baseEnv: { PATH: 'test-path' } }
  );
  child.stdout.write('OK');
  child.emit('close', 0);

  assert.equal(await resultPromise, 'OK');
  assert.equal(seenOptions.env.PATH, 'test-path');
  assert.equal(seenOptions.env.HERMES_COMPUTER_USE_DEFAULT_CAPTURE_MODE, undefined);
  assert.equal(seenOptions.env.HERMES_COMPUTER_USE_FORCE_CAPTURE_MODE, undefined);
  assert.equal(seenOptions.env.HERMES_COMPUTER_USE_DEFAULT_MAX_ELEMENTS, undefined);
});

test('runHermes forces UTF-8 for nested Python subprocess output on Windows', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.pid = 12347;
  let seenOptions;
  const spawnImpl = (_command, _args, options) => {
    seenOptions = options;
    return child;
  };

  const resultPromise = runHermes('prompt text', { hermesCommand: 'fake-hermes', hermesTimeoutMs: 1000 }, { spawnImpl });
  child.stdout.write('OK');
  child.emit('close', 0);

  assert.equal(await resultPromise, 'OK');
  assert.equal(seenOptions.env.PYTHONUTF8, '1');
  assert.equal(seenOptions.env.PYTHONIOENCODING, 'utf-8');
});

test('buildHermesFinalJsonRecoveryPrompt preserves the full task and mandates structured completion', () => {
  const recovery = buildHermesFinalJsonRecoveryPrompt('ORIGINAL FULL TASK');
  assert.match(recovery, /RECOVERY PASS/i);
  assert.match(recovery, /ORIGINAL FULL TASK/);
  assert.match(recovery, /Do the full reasoning/i);
  assert.match(recovery, /Return FINAL_JSON even when a tool or API failed/i);
  assert.match(recovery, /Do not substitute an apology, progress report, or plain-text explanation/i);
  assert.match(recovery, /RECOVERY OUTPUT OVERRIDE:[\s\S]*finish with FINAL_JSON and one valid JSON object only/i);
});

test('recovery prompt preserves a bulky prior decision now that Windows uses stdin transport', () => {
  const originalPrompt = `ORIGINAL:${'x'.repeat(26_000)}`;
  const recovery = buildHermesFinalJsonRecoveryPrompt(originalPrompt, {
    validationErrors: ['reply_decision.text is required'],
    priorDecision: { reason: 'y'.repeat(7_000) }
  });

  assert.ok(recovery.length > 30_000, `recovery prompt was only ${recovery.length} characters`);
  assert.doesNotMatch(recovery, /prior decision omitted/i);
  assert.match(recovery, /reply_decision\.text is required/);
  assert.match(recovery, /ORIGINAL:/);
  assert.match(recovery, /y{100}/);
});

test('runHermesDecision gives a fast invalid completion the unused wall-clock budget for recovery', async () => {
  const validOutput = `FINAL_JSON\n\`\`\`json\n{"classification":"reservation_inquiry","should_write_to_sheet":false}\n\`\`\``;
  const outputs = ['I could not finish the task.', validOutput];
  const calls = [];
  const runHermesImpl = async (prompt, config) => {
    calls.push({ prompt, config });
    return outputs.shift();
  };

  const result = await runHermesDecision(
    'ORIGINAL TASK',
    { hermesCommand: 'fake-hermes', hermesTimeoutMs: 420000 },
    {
      runHermesImpl,
      nowImpl: (() => {
        const values = [1_000, 101_000];
        return () => values.shift() ?? 101_000;
      })()
    }
  );

  assert.equal(result.attempts, 2);
  assert.equal(result.recovered, true);
  assert.equal(result.decision.classification, 'reservation_inquiry');
  assert.equal(result.hermesOutput, validOutput);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].prompt, 'ORIGINAL TASK');
  assert.match(calls[1].prompt, /RECOVERY PASS/);
  assert.match(calls[1].prompt, /ORIGINAL TASK/);
  assert.match(calls[1].prompt, /preserve all valid fields and repair only/i);
  assert.doesNotMatch(calls[1].prompt, /at most 10 tool calls/i);
  assert.equal(calls[0].config.hermesTimeoutMs, 280800);
  assert.equal(calls[1].config.hermesTimeoutMs, 290000);
  assert.equal(calls[1].config.hermesMaxTurns, 6);
  assert.ok(100000 + calls[1].config.hermesTimeoutMs <= 390000);
});

test('Hermes failure diagnostics expose actionable signals without output or secret text', () => {
  const diagnostic = describeHermesDecisionFailure(
    new Error('Hermes exited 1: HTTP 429 rate limit for sk-sensitive-value'),
    'customer-private-output'
  );
  const rendered = JSON.stringify(diagnostic);

  assert.equal(diagnostic.kind, 'process_error');
  assert.equal(diagnostic.exitCode, 1);
  assert.equal(diagnostic.httpStatus, 429);
  assert.deepEqual(diagnostic.signals, ['rate_limited']);
  assert.equal(diagnostic.outputChars, 'customer-private-output'.length);
  assert.doesNotMatch(rendered, /sensitive-value|customer-private-output/);
});

test('Hermes failure diagnostics retain a safe Windows spawn error code', () => {
  const error = new Error('spawn EINVAL');
  error.code = 'EINVAL';
  const diagnostic = describeHermesDecisionFailure(error, '');

  assert.equal(diagnostic.kind, 'process_error');
  assert.equal(diagnostic.errorCode, 'EINVAL');
  assert.deepEqual(diagnostic.signals, ['spawn_invalid_argument']);
});

test('runHermesDecision does not retry a valid first completion', async () => {
  let calls = 0;
  const result = await runHermesDecision(
    'ORIGINAL TASK',
    { hermesCommand: 'fake-hermes', hermesTimeoutMs: 420000 },
    {
      runHermesImpl: async () => {
        calls += 1;
        return 'FINAL_JSON\n{"classification":"faq","should_write_to_sheet":false}';
      }
    }
  );
  assert.equal(calls, 1);
  assert.equal(result.attempts, 1);
  assert.equal(result.recovered, false);
  assert.equal(result.decision.classification, 'faq');
});

test('runHermesDecision uses its reserved recovery budget after a read-only first-attempt timeout', async () => {
  const calls = [];
  const validOutput = 'FINAL_JSON\n{"classification":"faq","should_write_to_sheet":false}';
  const result = await runHermesDecision('ORIGINAL TASK', { hermesTimeoutMs: 420000 }, {
    runHermesImpl: async (prompt, config) => {
      calls.push({ prompt, config });
      if (calls.length === 1) throw new Error('Hermes timed out');
      return validOutput;
    },
    nowImpl: (() => {
      const values = [1_000, 281_000];
      return () => values.shift() ?? 281_000;
    })()
  });

  assert.equal(calls.length, 2);
  assert.match(calls[1].prompt, /RECOVERY PASS/);
  assert.equal(calls[1].config.hermesTimeoutMs, 110000);
  assert.equal(result.attempts, 2);
  assert.equal(result.recovered, true);
  assert.equal(result.decision.classification, 'faq');
});

test('runHermesDecision asks Hermes to repair a semantically incomplete action contract', async () => {
  const invalid = {
    should_write_to_sheet: true,
    classification: 'reservation',
    sheet_row_candidate: {
      equipment: [{ item: 'FX3', quantity: 1 }]
    }
  };
  const repaired = completeSheetDecision();
  const outputs = [
    `FINAL_JSON\n${JSON.stringify(invalid)}`,
    `FINAL_JSON\n${JSON.stringify(repaired)}`
  ];
  const prompts = [];

  const result = await runHermesDecision('ORIGINAL TASK', {
    hermesCommand: 'fake-hermes',
    hermesTimeoutMs: 420000
  }, {
    runHermesImpl: async (prompt) => {
      prompts.push(prompt);
      return outputs.shift();
    }
  });

  assert.equal(result.attempts, 2);
  assert.equal(result.recovered, true);
  assert.equal(result.decision.sheet_row_candidate.plan_complete, true);
  assert.match(prompts[1], /decision contract validation/i);
  assert.match(prompts[1], /sheet_row_candidate\.plan_complete/);
  assert.match(prompts[1], /PRIOR DECISION/);
});

test('validateAiDecisionContract rejects missing AI semantics instead of reconstructing them in code', () => {
  const invalid = completeSheetDecision({
    sheet_row_candidate: {
      plan_complete: false,
      start_date: '내일',
      pickup_time: '12시 30분',
      discount_type: ''
    },
    follow_up_items: [{
      type: 'not_a_real_type',
      route: 'not_a_real_route',
      taskKey: '',
      priority: 'someday',
      status: 'maybe',
      title: '',
      customer_name: '',
      summary: ''
    }]
  });

  const validation = validateAiDecisionContract(invalid);

  assert.equal(validation.valid, false);
  assert.ok(validation.errors.includes('sheet_row_candidate.plan_complete must be true'));
  assert.ok(validation.errors.some((error) => error.includes('start_date')));
  assert.ok(validation.errors.some((error) => error.includes('pickup_time')));
  assert.ok(validation.errors.some((error) => error.includes('discount_type')));
  assert.ok(validation.errors.some((error) => error.includes('follow_up_items[0].type')));
  assert.ok(validation.errors.some((error) => error.includes('follow_up_items[0].route')));
  assert.ok(validation.errors.some((error) => error.includes('follow_up_items[0].taskKey')));
  assert.ok(validation.errors.some((error) => error.includes('follow_up_items[0].priority')));
  assert.ok(validation.errors.some((error) => error.includes('follow_up_items[0].status')));
  assert.ok(validation.errors.some((error) => error.includes('follow_up_items[0].title')));
  assert.ok(validation.errors.some((error) => error.includes('follow_up_items[0].customer_name')));
  assert.ok(validation.errors.some((error) => error.includes('follow_up_items[0].summary')));
});

test('already_answered unregistered reservation stays valid when an actionable schedule follow-up preserves the work', () => {
  const preservedUnregistered = validateAiDecisionContract({
    should_write_to_sheet: false,
    classification: 'already_answered',
    safety_checks: { latest_customer_message_after_last_staff_reply: false },
    reservation_inquiry: { is_reservation_inquiry: true, already_registered: false },
    existing_confirm_request_ids: [],
    follow_up_items: [{
      type: 'reservation_review',
      route: 'schedule',
      taskKey: 'reservation:customer:2026-07-31:item',
      priority: 'urgent',
      status: 'open',
      title: 'Unregistered staff-confirmed reservation review',
      customer_name: 'Customer',
      summary: 'Staff answered, but no request, contract, or schedule record exists.',
      recommended_action: 'Resolve the missing time and exact equipment, then create the confirmation request.',
      suggested_reply_draft: '',
      evidence: ['No authoritative registration record was found.'],
      blocking_reason: 'Exact time and equipment model remain unresolved.',
      due_hint: 'now'
    }],
    reply_decision: {
      replyMode: 'no_reply',
      text: '',
      confidence: 'high',
      reason: 'Staff already replied; preserve the missing registration as an internal follow-up.',
      shouldCreateTask: true,
      safetyClass: 'no_send',
      grounding: 'visible_conversation',
      requiresRag: false,
      attachmentKeys: [],
      alreadyDelivered: true
    }
  });
  const silentlyDropped = validateAiDecisionContract({
    should_write_to_sheet: false,
    classification: 'already_answered',
    reservation_inquiry: { is_reservation_inquiry: true, already_registered: false },
    existing_confirm_request_ids: [],
    follow_up_items: [],
    reply_decision: {
      replyMode: 'no_reply',
      shouldCreateTask: false,
      safetyClass: 'no_send',
      grounding: 'visible_conversation',
      requiresRag: false,
      attachmentKeys: [],
      alreadyDelivered: true
    }
  });
  const nonReservation = validateAiDecisionContract({
    should_write_to_sheet: false,
    classification: 'already_answered',
    reservation_inquiry: { is_reservation_inquiry: false }
  });

  assert.equal(preservedUnregistered.valid, true);
  assert.equal(silentlyDropped.valid, false);
  assert.ok(silentlyDropped.errors.some((error) => error.includes('actionable schedule follow-up')));
  assert.equal(nonReservation.valid, true);
});

test('buildHermesPrompt asks for concise human staff tone instead of a fixed warm AI persona', () => {
  const prompt = buildHermesPrompt({ id: 'tone-contract', preview_text: '가격 알려주세요' });

  assert.doesNotMatch(prompt, /감정노동으로 대신 커버|말투는 항상 친절 모드/);
  assert.match(prompt, /실제 직원이 카카오톡에서 바로 답하는 듯/);
  assert.match(prompt, /불필요한 인사·재확인·마무리 문구/);
});

test('already_answered registered reservation accepts authoritative contract and schedule evidence without an RQ id', () => {
  const registeredWithoutRequest = validateAiDecisionContract({
    should_write_to_sheet: false,
    classification: 'already_answered',
    reservation_inquiry: {
      is_reservation_inquiry: true,
      already_registered: true
    },
    safety_checks: {
      duplicate_checked_contract_master: true,
      duplicate_checked_schedule_detail: true,
      duplicate_checked_request_sheet: true
    },
    existing_confirm_request_ids: [],
    follow_up_items: [],
    reply_decision: {
      replyMode: 'no_reply',
      shouldCreateTask: false,
      safetyClass: 'no_send',
      grounding: 'authoritative_sheet',
      requiresRag: false,
      attachmentKeys: [],
      alreadyDelivered: true
    }
  });
  const staffClaimWithoutSheetEvidence = validateAiDecisionContract({
    should_write_to_sheet: false,
    classification: 'already_answered',
    reservation_inquiry: {
      is_reservation_inquiry: true,
      already_registered: true
    },
    safety_checks: {
      duplicate_checked_contract_master: false,
      duplicate_checked_schedule_detail: false
    },
    existing_confirm_request_ids: []
  });

  assert.equal(registeredWithoutRequest.valid, true);
  assert.equal(staffClaimWithoutSheetEvidence.valid, false);
  assert.ok(staffClaimWithoutSheetEvidence.errors.some((error) => error.includes('authoritative contract and schedule checks')));
});

test('extractJsonObject reads fenced FINAL_JSON object', () => {
  const text = `설명\n\nFINAL_JSON\n\`\`\`json\n{"should_write_to_sheet":false,"reason":"테스트"}\n\`\`\``;
  assert.deepEqual(extractJsonObject(text), {
    should_write_to_sheet: false,
    reason: '테스트'
  });
});

test('extractJsonObject ignores trailing diagnostics after the FINAL_JSON object', () => {
  const text = `FINAL_JSON
\`\`\`json
{"should_write_to_sheet":false,"reason":"정상 판단"}
{"diagnostic":"late tool output"}
\`\`\``;
  assert.deepEqual(extractJsonObject(text), {
    should_write_to_sheet: false,
    reason: '정상 판단'
  });
});

test('buildHermesPrompt requires sender separation and customer turn clustering', () => {
  const prompt = buildHermesPrompt({ id: 'job-sender', preview_text: '중요 홍길동 안녕하세요 오후 1:00' });
  assert.match(prompt, /SENDER AND TURN-TAKING POLICY/);
  assert.match(prompt, /staff\/outbound.*customer\/inbound/s);
  assert.match(prompt, /latest customer\/inbound message or a cluster/s);
  assert.match(prompt, /안녕하세요.*27일날.*fx3 가능한가요/s);
  assert.match(prompt, /latest_customer_message_after_last_staff_reply/);
  assert.match(prompt, /staff-confirmed-unregistered case/);
  assert.match(prompt, /reservation_inquiry\.confirmed=true/);
  assert.match(prompt, /conversation_turns/);
});

test('buildHermesPrompt requires additions-only equipment for an existing booking', () => {
  const prompt = buildHermesPrompt({ id: 'job-addon', preview_text: '기존 예약에 렌즈 하나 추가해주세요' });
  assert.match(prompt, /equipment_write_mode/);
  assert.match(prompt, /additions_only/);
  assert.match(prompt, /do not repeat existing equipment/i);
  assert.match(prompt, /existing booking with newly added or increased equipment is not a duplicate/i);
  assert.doesNotMatch(prompt, /never concatenated or delta-only/i);
});

test('buildHermesPrompt treats a requested set option as a component selection, not separate equipment', () => {
  const prompt = buildHermesPrompt({ id: 'job-set-option', preview_text: '600X는 젬볼로 부탁드립니다' });
  assert.match(prompt, /set_component_selections/);
  assert.match(prompt, /600X.*젬볼.*소프트박스.*젬볼 90/s);
  assert.match(prompt, /never add.*top-level equipment/i);
});

test('existing booking writes reject a repeated full plan and accept only the added equipment', () => {
  const repeated = completeSheetDecision({
    reservation_inquiry: {
      is_reservation_inquiry: true,
      already_registered: true
    },
    sheet_row_candidate: {
      equipment_write_mode: 'full_plan',
      equipment: [
        { item: '소니 FX3 바디세트', quantity: 1 },
        { item: '소니 GM 24-70mm II', quantity: 1 }
      ]
    }
  });
  const addition = completeSheetDecision({
    reservation_inquiry: {
      is_reservation_inquiry: true,
      already_registered: true
    },
    sheet_row_candidate: {
      equipment_write_mode: 'additions_only',
      equipment: [{ item: '소니 GM 24-70mm II', quantity: 1 }]
    }
  });

  const repeatedValidation = validateAiDecisionContract(repeated);
  assert.equal(repeatedValidation.valid, false);
  assert.ok(repeatedValidation.errors.some((error) => error.includes('additions_only')));
  assert.equal(validateAiDecisionContract(addition).valid, true);

  const payload = buildSheetAppendPayload(addition, { apiKey: 'secret' });
  assert.deepEqual(payload.args.장비, [{ 이름: '소니 GM 24-70mm II', 수량: 1 }]);
});

test('set component choice is not written as another top-level equipment item', () => {
  const decision = completeSheetDecision({
    sheet_row_candidate: {
      equipment: [{ item: '어퓨쳐 600X', quantity: 2 }],
      set_component_selections: [{
        set_item: '어퓨쳐 600X',
        component_item: '소프트박스',
        selected_item: '젬볼 90'
      }]
    }
  });

  const validation = validateAiDecisionContract(decision);
  assert.equal(validation.valid, true);
  const payload = buildSheetAppendPayload(decision, { apiKey: 'secret' });
  assert.deepEqual(payload.args.장비, [{ 이름: '어퓨쳐 600X', 수량: 2 }]);
  assert.deepEqual(payload.setComponentSelections, [{
    setItem: '어퓨쳐 600X',
    componentItem: '소프트박스',
    selectedItem: '젬볼 90'
  }]);
});

test('set component choice is rejected when it is also repeated as top-level equipment', () => {
  const decision = completeSheetDecision({
    sheet_row_candidate: {
      equipment: [
        { item: '어퓨쳐 600X', quantity: 2 },
        { item: '젬볼', quantity: 2 }
      ],
      set_component_selections: [{
        set_item: '어퓨쳐 600X',
        component_item: '소프트박스',
        selected_item: '젬볼 90'
      }]
    }
  });

  const validation = validateAiDecisionContract(decision);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.includes('must not also be top-level equipment')));
  assert.equal(buildSheetAppendPayload(decision, { apiKey: 'secret' }), null);
});

test('appendToSheet applies an exact set component selection and returns refreshed availability', async () => {
  const payload = {
    key: 'secret',
    action: 'run',
    func: 'insertAndCheckRequest',
    args: {
      반출일: '2026-07-30',
      반출시간: '19:00',
      반납일: '2026-07-31',
      반납시간: '19:00',
      예약자명: '테스트고객',
      장비: [{ 이름: '어퓨쳐 600X', 수량: 2 }]
    },
    setComponentSelections: [{
      setItem: '어퓨쳐 600X',
      componentItem: '소프트박스',
      selectedItem: '젬볼 90'
    }]
  };
  const calls = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(String(url));
    calls.push(parsed);
    if (parsed.searchParams.get('func') === 'insertAndCheckRequest') {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          success: true,
          reqID: 'RQ-260729-999',
          results: [{ 장비명: '소프트박스', 수량: 2, 결과: '⚠️ 모델 선택 필요', 상세: 'F열 선택 필요' }]
        })
      };
    }
    if (parsed.searchParams.get('func') === 'updateRequestItem') {
      return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'OK', reChecked: true }) };
    }
    if (parsed.searchParams.get('action') === 'search') {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          results: [{ data: ['RQ-260729-999', '', '', '', '', '젬볼 90', 2, '확인', '✅ 가용2', '예약 가능', '', '', '', '', '', '', '[세트]어퓨쳐 600X'] }]
        })
      };
    }
    throw new Error(`unexpected URL ${parsed}`);
  };

  const result = await appendToSheet({
    gasApiUrl: 'https://gas.example/exec',
    sheetApiKey: 'secret',
    fetchImpl
  }, payload);

  assert.equal(calls.length, 3);
  const updateArgs = JSON.parse(calls[1].searchParams.get('args'));
  assert.deepEqual(updateArgs, {
    reqID: 'RQ-260729-999',
    장비명: '소프트박스',
    비고: '[세트]어퓨쳐 600X',
    새이름: '젬볼 90'
  });
  assert.deepEqual(result.results, [{
    equipment: '젬볼 90',
    quantity: '2',
    result: '✅ 가용2',
    detail: '예약 가능'
  }]);
});

test('buildSheetAppendPayload refuses writes when latest actionable message is not customer after staff reply', () => {
  const decision = {
    should_write_to_sheet: true,
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      exact_equipment_name_verified_from_set_master: true,
      duplicate_checked_contract_master: true,
      duplicate_checked_schedule_detail: true,
      duplicate_checked_request_sheet: true,
      latest_customer_message_after_last_staff_reply: false,
      no_auto_reply_sent: true
    },
    sheet_row_candidate: { item: '소니 FX3 바디세트', customer_name: '홍길동' }
  };
  assert.equal(buildSheetAppendPayload(decision, { apiKey: 'secret' }), null);
});

test('buildSheetAppendPayload allows staff-confirmed unregistered reservations without a new customer turn', () => {
  const decision = {
    should_write_to_sheet: true,
    classification: 'reservation',
    customer: { name: '문치호' },
    reservation_inquiry: {
      is_reservation_inquiry: true,
      confirmed: true,
      already_registered: false,
      rental_start: '2026-06-06',
      pickup_time: '09:00',
      rental_end: '2026-06-07',
      return_time: '18:00',
      discount_type: '일반',
      equipment_requested: [
        { raw_text: 'FX3 바디세트', exact_name_from_set_master: '소니 FX3 바디세트', quantity: 1 }
      ]
    },
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      exact_equipment_name_verified_from_set_master: true,
      duplicate_checked_contract_master: true,
      duplicate_checked_schedule_detail: true,
      duplicate_checked_request_sheet: true,
      latest_customer_message_after_last_staff_reply: false,
      no_auto_reply_sent: true
    },
    sheet_row_candidate: {
      plan_complete: true,
      customer_name: '문치호',
      phone: '010-1111-2222',
      start_date: '2026-06-06',
      pickup_time: '09:00',
      end_date: '2026-06-07',
      return_time: '18:00',
      discount_type: '일반',
      equipment: [{ item: '소니 FX3 바디세트', quantity: 1 }],
      memo: '재형님 카톡 확정 후 시트 미입력'
    }
  };

  const payload = buildSheetAppendPayload(decision, { apiKey: 'secret' });

  assert.equal(payload.func, 'insertAndCheckRequest');
  assert.deepEqual(payload.args.장비, [{ 이름: '소니 FX3 바디세트', 수량: 1 }]);
  assert.equal(payload.args.예약자명, '문치호');
  assert.equal(payload.args.비고, '');
});

test('buildSheetAppendPayload returns null when AI says not to write', () => {
  const decision = {
    should_write_to_sheet: false,
    sheet_row_candidate: { customer_name: '최재형' }
  };
  assert.equal(buildSheetAppendPayload(decision, { apiKey: 'k' }), null);
});

test('buildSheetAppendPayload allows confirmation-request writes without a phone', () => {
  const decision = {
    should_write_to_sheet: true,
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      exact_equipment_name_verified_from_set_master: true,
      duplicate_checked_contract_master: true,
      duplicate_checked_schedule_detail: true,
      duplicate_checked_request_sheet: true,
      latest_customer_message_after_last_staff_reply: true,
      no_auto_reply_sent: true
    },
    customer: { name: '찬승' },
    sheet_row_candidate: {
      plan_complete: true,
      start_date: '2026-06-27',
      pickup_time: '23:00',
      end_date: '2026-06-29',
      return_time: '23:00',
      equipment: [{ item: '소니 BURANO 베이직세트', quantity: 1 }],
      customer_name: '찬승',
      phone: '',
      discount_type: '일반',
      memo: '카카오 닉네임만 있고 예약자명/연락처 없음'
    }
  };

  const payload = buildSheetAppendPayload(decision, { apiKey: 'k' });
  assert.equal(payload.func, 'insertAndCheckRequest');
  assert.equal(payload.args.예약자명, '찬승');
  assert.equal(payload.args.연락처, '');
  assert.deepEqual(payload.args.장비, [{ 이름: '소니 BURANO 베이직세트', 수량: 1 }]);
});

test('buildSheetAppendPayload maps AI-decided fields into insertAndCheckRequest payload', () => {
  const decision = {
    should_write_to_sheet: true,
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      exact_equipment_name_verified_from_set_master: true,
      duplicate_checked_contract_master: true,
      duplicate_checked_schedule_detail: true,
      duplicate_checked_request_sheet: true,
      latest_customer_message_after_last_staff_reply: true,
      no_auto_reply_sent: true
    },
    sheet_row_candidate: {
      plan_complete: true,
      start_date: '2026-06-01',
      pickup_time: '10:00',
      end_date: '2026-06-02',
      return_time: '18:00',
      equipment: [
        { item: '소니 FX6 바디세트', quantity: 1 },
        { item: '소니 GM 24-70mm II', quantity: 2 }
      ],
      customer_name: '홍길동',
      phone: '010-0000-0000',
      discount_type: '학생',
      memo: 'AI 검토 필요',
      extra_request: '렌즈 포함'
    }
  };

  const payload = buildSheetAppendPayload(decision, { apiKey: 'secret' });

  assert.equal(payload.key, 'secret');
  assert.equal(payload.action, 'run');
  assert.equal(payload.func, 'insertAndCheckRequest');
  assert.deepEqual(payload.args, {
    반출일: '2026-06-01',
    반출시간: '10:00',
    반납일: '2026-06-02',
    반납시간: '18:00',
    예약자명: '홍길동',
    연락처: '010-0000-0000',
    할인유형: '학생',
    비고: '',
    추가요청: '렌즈 포함',
    입력모드: 'full_plan',
    장비명원문보존: true,
    장비: [
      { 이름: '소니 FX6 바디세트', 수량: 1 },
      { 이름: '소니 GM 24-70mm II', 수량: 2 }
    ]
  });
  assert.equal(JSON.stringify(payload).includes('AI-'), false);
});

test('buildSheetAppendPayload preserves the complete AI equipment plan and never replaces it from another field', () => {
  const decision = completeSheetDecision({
    reservation_inquiry: {
      equipment_requested: [
        { raw_text: 'FX3', normalized_guess: '소니 FX3 바디세트', quantity: 2 },
        { raw_text: '2470', normalized_guess: '소니 GM 24-70mm II', quantity: 2 }
      ]
    },
    sheet_row_candidate: {
      equipment: [{ item: '셔틀러에이스 M (75볼)', quantity: 1 }]
    }
  });

  const payload = buildSheetAppendPayload(decision, { apiKey: 'secret' });

  assert.deepEqual(payload.args.장비, [{ 이름: '셔틀러에이스 M (75볼)', 수량: 1 }]);
  assert.equal(payload.args.장비명원문보존, true);
});

test('buildSheetAppendPayload never re-extracts customer identity from raw Kakao text', () => {
  const decision = completeSheetDecision({
    latest_customer_message_cluster: '예약자명 김기계 / 010-9999-8888',
    customer: { name: '카카오프로필' },
    sheet_row_candidate: {
      customer_name: 'AI가 맥락으로 확정한 예약자',
      phone: '010-1234-5678'
    }
  });

  const payload = buildSheetAppendPayload(decision, { apiKey: 'secret' });

  assert.equal(payload.args.예약자명, 'AI가 맥락으로 확정한 예약자');
  assert.equal(payload.args.연락처, '010-1234-5678');
});

test('buildSheetAppendPayload does not leak AI reasons or review actions into confirmation request memo fields', () => {
  const decision = {
    should_write_to_sheet: true,
    reason: '카카오 실제 대화에서 예약형식이라 판단했고 가용확인 후 고객 안내 필요',
    suggested_human_review_action: '확인요청 가용확인 결과를 확인한 뒤 고객에게 안내하세요',
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      exact_equipment_name_verified_from_set_master: true,
      duplicate_checked_contract_master: true,
      duplicate_checked_schedule_detail: true,
      duplicate_checked_request_sheet: true,
      latest_customer_message_after_last_staff_reply: true,
      no_auto_reply_sent: true
    },
    sheet_row_candidate: {
      plan_complete: true,
      start_date: '2026-06-01',
      pickup_time: '10:00',
      end_date: '2026-06-02',
      return_time: '18:00',
      equipment: [{ item: '소니 FX3 바디세트', quantity: 1 }],
      customer_name: '홍길동',
      phone: '010-0000-0000',
      discount_type: '일반',
      memo: '카카오 예약형식 메시지에서 접수. 고객 원문 장비명: FX3',
      extra_request: '가용확인 후 고객 안내 필요'
    }
  };

  const payload = buildSheetAppendPayload(decision, { apiKey: 'secret' });

  assert.equal(payload.args.비고, '');
  assert.equal(payload.args.추가요청, '');
});

test('buildSheetAppendPayload floors pickup minutes and ceils return minutes conservatively', () => {
  const decision = {
    should_write_to_sheet: true,
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      exact_equipment_name_verified_from_set_master: true,
      duplicate_checked_contract_master: true,
      duplicate_checked_schedule_detail: true,
      duplicate_checked_request_sheet: true,
      latest_customer_message_after_last_staff_reply: true,
      no_auto_reply_sent: true
    },
    sheet_row_candidate: {
      plan_complete: true,
      start_date: '2026-06-01',
      pickup_time: '12:59',
      end_date: '2026-06-02',
      return_time: '18:01',
      equipment: [{ item: '소니 FX3 바디세트', quantity: 1 }],
      customer_name: '홍길동',
      phone: '010-2222-3333',
      discount_type: '일반'
    }
  };

  const payload = buildSheetAppendPayload(decision, { apiKey: 'secret' });

  assert.equal(normalizeConfirmRequestTimeForSheet('7시30분'), '07:30');
  assert.equal(payload.args.반출시간, '12:00');
  assert.equal(payload.args.반납시간, '19:00');
});

test('confirmation request normalization rolls Village 24:00 into the next date', () => {
  assert.deepEqual(normalizeConfirmRequestWindowForSheet({
    start_date: '2026-08-26',
    pickup_time: '07:30',
    end_date: '2026-08-27',
    return_time: '24:00'
  }), {
    start_date: '2026-08-26',
    pickup_time: '07:00',
    end_date: '2026-08-28',
    return_time: '00:00'
  });
});

test('confirmation request return rounding rolls 23-minute returns into the next date', () => {
  assert.deepEqual(normalizeConfirmRequestWindowForSheet({
    start_date: '2026-06-01',
    pickup_time: '12:30',
    end_date: '2026-06-02',
    return_time: '23:01'
  }), {
    start_date: '2026-06-01',
    pickup_time: '12:00',
    end_date: '2026-06-03',
    return_time: '00:00'
  });
});

test('buildSheetAppendPayload rejects unresolved relative dates while the boundary owns rounding', () => {
  const now = new Date('2026-06-06T07:54:00+09:00');
  const decision = {
    should_write_to_sheet: true,
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      exact_equipment_name_verified_from_set_master: true,
      duplicate_checked_contract_master: true,
      duplicate_checked_schedule_detail: true,
      duplicate_checked_request_sheet: true,
      latest_customer_message_after_last_staff_reply: true,
      no_auto_reply_sent: true
    },
    sheet_row_candidate: {
      start_date: '오늘',
      pickup_time: '10시',
      end_date: '6월 6일',
      return_time: '24시',
      equipment: [{ item: '소니 A7S3 바디세트', quantity: 1 }],
      customer_name: '이규직',
      phone: '01022500612'
    }
  };

  const payload = buildSheetAppendPayload(decision, { apiKey: 'secret', now });

  assert.equal(normalizeConfirmRequestDateForSheet('오늘', { now }), '2026-06-06');
  assert.equal(normalizeConfirmRequestTimeForSheet('24시'), '00:00');
  assert.equal(payload, null);
});

test('additions-only pending RQ writes merge the authoritative full plan instead of replacing it', () => {
  const decision = completeSheetDecision({
    existing_confirm_request_ids: ['RQ-260818-005'],
    reservation_inquiry: { already_registered: false },
    sheet_row_candidate: {
      equipment_write_mode: 'additions_only',
      equipment: [
        { item: 'C스탠드', quantity: 2 },
        { item: '로닌 링그립', quantity: 1 }
      ]
    }
  });
  const payload = buildSheetAppendPayload(decision, { apiKey: 'secret' });
  const existingRequestResult = {
    reqID: 'RQ-260818-005',
    topLevelEquipment: [
      { 이름: '소니 FX6 바디세트', 수량: 1 },
      { 이름: 'C스탠드', 수량: 1 }
    ]
  };

  const merged = mergeAdditionsOnlySheetPayloadWithExistingRequest(payload, decision, existingRequestResult);

  assert.equal(merged.ok, true);
  assert.equal(merged.payload.args.입력모드, 'full_plan');
  assert.deepEqual(merged.payload.args.장비, [
    { 이름: '소니 FX6 바디세트', 수량: 1 },
    { 이름: 'C스탠드', 수량: 3 },
    { 이름: '로닌 링그립', 수량: 1 }
  ]);
});

test('additions-only pending RQ writes fail closed without an authoritative full plan', () => {
  const decision = completeSheetDecision({
    existing_confirm_request_ids: ['RQ-260818-005'],
    reservation_inquiry: { already_registered: false },
    sheet_row_candidate: {
      equipment_write_mode: 'additions_only',
      equipment: [{ item: '로닌 링그립', quantity: 1 }]
    }
  });
  const payload = buildSheetAppendPayload(decision, { apiKey: 'secret' });

  const merged = mergeAdditionsOnlySheetPayloadWithExistingRequest(payload, decision, null);

  assert.equal(merged.ok, false);
  assert.equal(merged.payload, null);
});

test('additions-only registered booking keeps the AI delta but crosses GAS as a standalone full plan', () => {
  const decision = completeSheetDecision({
    reservation_inquiry: { already_registered: true },
    sheet_row_candidate: {
      equipment_write_mode: 'additions_only',
      equipment: [{ item: '로닌 링그립', quantity: 1 }]
    }
  });
  const payload = buildSheetAppendPayload(decision, { apiKey: 'secret' });

  const merged = mergeAdditionsOnlySheetPayloadWithExistingRequest(payload, decision, null);

  assert.equal(merged.ok, true);
  assert.equal(merged.payload.args.입력모드, 'full_plan');
  assert.deepEqual(merged.payload.args.장비, [{ 이름: '로닌 링그립', 수량: 1 }]);
});

test('buildSheetAppendPayload allows reservation-format writes when non-blocking checks are incomplete', () => {
  const decision = {
    should_write_to_sheet: true,
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      exact_equipment_name_verified_from_set_master: false,
      duplicate_checked_contract_master: false,
      duplicate_checked_schedule_detail: false,
      duplicate_checked_request_sheet: false,
      latest_customer_message_after_last_staff_reply: true,
      no_auto_reply_sent: false
    },
    sheet_row_candidate: {
      plan_complete: true,
      start_date: '2026-06-01',
      pickup_time: '10:00',
      end_date: '2026-06-02',
      return_time: '18:00',
      equipment: [{ item: 'FX6', quantity: 1 }],
      customer_name: '홍길동',
      phone: '010-4444-5555',
      discount_type: '일반',
      memo: '장비명/중복 검증 필요'
    }
  };

  const payload = buildSheetAppendPayload(decision, { apiKey: 'secret' });
  assert.equal(payload.action, 'run');
  assert.equal(payload.func, 'insertAndCheckRequest');
  assert.deepEqual(payload.args.장비, [{ 이름: 'FX6', 수량: 1 }]);
  assert.equal(payload.args.예약자명, '홍길동');
  assert.equal(payload.args.비고, '');
});

test('buildSheetAppendPayload trusts an exact set-master name over the customer request phrase', () => {
  const decision = {
    should_write_to_sheet: true,
    customer: { name: '테스트고객' },
    reservation_inquiry: {
      is_reservation_inquiry: true,
      confirmed: true,
      already_registered: false,
      rental_start: '2026-07-16',
      pickup_time: '14:00',
      rental_end: '2026-07-17',
      return_time: '14:00',
      discount_type: '단골',
      equipment_requested: [
        {
          raw_text: '셔틀러 에이스 한대 추가',
          normalized_guess: '셔틀러에이스 M (75볼)',
          exact_name_from_set_master: '셔틀러에이스 M (75볼)',
          quantity: 1
        }
      ]
    },
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      exact_equipment_name_verified_from_set_master: true,
      latest_customer_message_after_last_staff_reply: true
    },
    sheet_row_candidate: {
      plan_complete: true,
      customer_name: '테스트고객',
      phone: '010-0000-0000',
      start_date: '2026-07-16',
      pickup_time: '14:00',
      end_date: '2026-07-17',
      return_time: '14:00',
      discount_type: '단골',
      equipment: [{ item: '셔틀러에이스 M (75볼)', quantity: 1 }]
    }
  };

  const payload = buildSheetAppendPayload(decision, { apiKey: 'secret' });

  assert.deepEqual(payload.args.장비, [{ 이름: '셔틀러에이스 M (75볼)', 수량: 1 }]);
});

test('buildSheetAppendPayload refuses to reconstruct a missing AI equipment plan from reservation fields', () => {
  const decision = {
    should_write_to_sheet: true,
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      latest_customer_message_after_last_staff_reply: true
    },
    customer: { name: '김성윤' },
    reservation_inquiry: {
      rental_start: '2026-05-28',
      rental_end: '2026-05-28',
      pickup_time: '07:00',
      return_time: '23:00',
      discount_type: '개인사업자/프리랜서',
      equipment_requested: [
        { raw_text: '셔틀러에이스 2개', normalized_guess: '셔틀러 에이스', quantity: 2 },
        { raw_text: 'a7s3 바디세트 2개', exact_name_from_set_master: '소니 A7S3 바디세트', quantity: 2 },
        { raw_text: '2470gm2 2개', exact_name_from_set_master: '소니 GM 24-70mm II', quantity: 2 }
      ]
    },
    sheet_row_candidate: {
      customer_name: '김성윤',
      phone: '010-7777-8888',
      item: '셔틀러 에이스 2개, 소니 A7S3 바디세트 2개, 소니 GM 24-70mm II 2개',
      memo: 'fallback should prefer structured reservation equipment'
    }
  };

  const payload = buildSheetAppendPayload(decision, { apiKey: 'secret' });
  assert.equal(payload, null);
});

test('buildSheetAppendPayload never swaps in a reservation list when AI marks a candidate plan complete', () => {
  const decision = {
    should_write_to_sheet: true,
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      latest_customer_message_after_last_staff_reply: true
    },
    customer: { name: '전찬영' },
    reservation_inquiry: {
      rental_start: '2026-06-23',
      rental_end: '2026-06-23',
      pickup_time: '11:00',
      return_time: '17:00',
      discount_type: '개인사업자/프리랜서',
      equipment_requested: [
        { raw_text: 'a7s3 2대', exact_name_from_set_master: '소니 A7S3 바디세트', quantity: 2 },
        { raw_text: '셔틀러에이스 3대', normalized_guess: '셔틀러에이스 M (75볼)', quantity: 3 },
        { raw_text: 'dji 무선마이크 1대', exact_name_from_set_master: 'DJI 마이크 미니2', quantity: 1 },
        { raw_text: '70-200 렌즈 2구', exact_name_from_set_master: '소니 GM 70-200mm II', quantity: 2 }
      ]
    },
    sheet_row_candidate: {
      plan_complete: true,
      customer_name: '전찬영',
      phone: '010-6317-4066',
      start_date: '2026-06-23',
      pickup_time: '11:00',
      end_date: '2026-06-23',
      return_time: '17:00',
      discount_type: '개인사업자/프리랜서',
      equipment: [{ item: '셔틀러에이스 M (75볼)', quantity: 1 }]
    }
  };

  const payload = buildSheetAppendPayload(decision, { apiKey: 'secret' });
  assert.deepEqual(payload.args.장비, [
    { 이름: '셔틀러에이스 M (75볼)', 수량: 1 }
  ]);
});

test('appendToSheet calls insertAndCheckRequest with the Claude coworker GET contract', async () => {
  const payload = {
    key: 'secret',
    action: 'run',
    func: 'insertAndCheckRequest',
    args: {
      반출일: '2026-06-01',
      반출시간: '10:00',
      반납일: '2026-06-02',
      반납시간: '18:00',
      예약자명: '홍길동',
      장비: [
        { 이름: '소니 FX6 바디세트', 수량: 1 },
        { 이름: '소니 GM 24-70mm II', 수량: 2 }
      ]
    }
  };
  let calledUrl;
  let calledInit;
  const fetchImpl = async (url, init) => {
    calledUrl = new URL(String(url));
    calledInit = init;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: true, reqID: 'RQ-260601-001', results: [] })
    };
  };

  const result = await appendToSheet({
    gasApiUrl: 'https://gas.example/exec',
    sheetApiKey: 'secret',
    fetchImpl
  }, payload);

  assert.equal(calledInit, undefined);
  assert.equal(calledUrl.origin + calledUrl.pathname, 'https://gas.example/exec');
  assert.equal(calledUrl.searchParams.get('key'), 'secret');
  assert.equal(calledUrl.searchParams.get('action'), 'run');
  assert.equal(calledUrl.searchParams.get('func'), 'insertAndCheckRequest');
  assert.deepEqual(JSON.parse(calledUrl.searchParams.get('args')), payload.args);
  assert.equal(result.reqID, 'RQ-260601-001');
});

test('appendToSheet returns structured GAS business errors instead of crashing the worker', async () => {
  const result = await appendToSheet({
    gasApiUrl: 'https://gas.example/exec',
    sheetApiKey: 'secret',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ error: '셀 B52에 입력한 데이터가 이 셀에 설정된 데이터 확인 규칙을 위반했습니다.' })
    })
  }, {
    action: 'run',
    func: 'insertAndCheckRequest',
    args: { 반출일: '2026-04-31', 예약자명: '박정민', 장비: [{ 이름: '어퓨쳐 600C', 수량: 2 }] }
  });

  assert.equal(result.success, false);
  assert.equal(result.error_type, 'sheet_validation');
  assert.equal(result.recoverable, false);
  assert.match(result.error, /데이터 확인 규칙/);
});

test('appendToSheet classifies missing contact rejections as no_contact', async () => {
  const result = await appendToSheet({
    gasApiUrl: 'https://gas.example/exec',
    sheetApiKey: 'secret',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ error: 'NO_CONTACT: 연락처가 없으면 예약 등록이 불가능합니다. 고객DB에서 연락처 없음 — 고객에게 연락처부터 요청하세요.' })
    })
  }, {
    action: 'run',
    func: 'insertAndCheckRequest',
    args: { 예약자명: '홍길동', 장비: [{ 이름: 'FX6', 수량: 1 }] }
  });

  assert.equal(result.success, false);
  assert.equal(result.error_type, 'no_contact');
  assert.match(result.error, /예약 등록이 불가능/);
});

test('appendToSheet preserves duplicate insertAndCheckRequest availability results', async () => {
  const result = await appendToSheet({
    gasApiUrl: 'https://gas.example/exec',
    sheetApiKey: 'secret',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        duplicate: true,
        reqID: 'RQ-260531-003',
        message: '중복 요청: 동일한 예약자/반출일시/장비 조합이 이미 존재합니다 (RQ-260531-003)',
        results: [
          { 장비명: '소니 캠 AX-700', 수량: '1', 결과: '✅ 가용1', 상세: '예약 가능' }
        ]
      })
    })
  }, {
    action: 'run',
    func: 'insertAndCheckRequest',
    args: { 반출일: '2026-05-30', 예약자명: '최재원', 장비: [{ 이름: '소니 캠 AX-700', 수량: 1 }] }
  });

  assert.equal(result.success, true);
  assert.equal(result.duplicate, true);
  assert.equal(result.reqID, 'RQ-260531-003');
  assert.deepEqual(result.results, [
    { equipment: '소니 캠 AX-700', quantity: '1', result: '✅ 가용1', detail: '예약 가능' }
  ]);
});

test('buildSheetAvailabilityReport turns GAS results into availability-based action text', () => {
  const report = buildSheetAvailabilityReport({
    reqID: 'RQ-260531-003',
    duplicate: true,
    results: [
      { 장비명: '소니 캠 AX-700', 수량: '1', 결과: '✅ 가용1', 상세: '예약 가능' }
    ]
  }, {
    args: {
      예약자명: '최재원',
      장비: [{ 이름: '소니 캠 AX-700', 수량: 1 }]
    }
  });

  assert.equal(report.status, 'available');
  assert.match(report.summary, /기존 중복 RQ/);
  assert.match(report.recommendedAction, /결과가 가용/);
  assert.equal(report.suggestedReplyDraft, '', 'deterministic sheet code must not author customer-facing prose');

  const blocked = buildSheetAvailabilityReport({
    reqID: 'RQ-260531-004',
    results: [
      { 장비명: '소니 캠 AX-700', 수량: '1', 결과: '⚠️ 겹침(가용0)', 상세: '동일 시간 예약 있음' }
    ]
  }, {
    args: {
      예약자명: '최재원',
      장비: [{ 이름: '소니 캠 AX-700', 수량: 1 }]
    }
  });

  assert.equal(blocked.status, 'unavailable');
  assert.match(blocked.recommendedAction, /가능하다고 안내하지 말고/);
  assert.equal(blocked.suggestedReplyDraft, '', 'unavailable results also require a fresh Hermes decision');

  const setAvailable = buildSheetAvailabilityReport({
    reqID: 'RQ-260723-001',
    results: [
      { 장비명: '아마란 F21C', 수량: '1', 결과: '세트', 상세: '✅ 본체 가용3 (보유3)' },
      { 장비명: '패널 / 발라스터 / 연장라인 / AC라인 / 프레임대', 수량: '1', 결과: 'ℹ️ 기본구성', 상세: '세트 동봉품(개별 재고 미관리)' },
      { 장비명: '루버 / 실크1 / 실크2', 수량: '1', 결과: 'ℹ️ 기본구성', 상세: '세트 동봉품(개별 재고 미관리)' },
      { 장비명: 'C스탠드', 수량: '1', 결과: '✅ 가용15', 상세: '보유20, 최대동시5' },
      { 장비명: 'V마운트 배터리', 수량: '1', 결과: '✅ 가용44', 상세: '보유56, 최대동시12' }
    ]
  });
  assert.equal(setAvailable.status, 'available', '동봉품 정보행은 세트 전체 가용 판정을 unknown으로 만들면 안 된다');

  const setUnavailable = buildSheetAvailabilityReport({
    reqID: 'RQ-260723-002',
    results: [
      { 장비명: '아마란 F21C', 수량: '1', 결과: '세트', 상세: '❌ 본체 가용0 (보유3, 사용중3)' },
      { 장비명: '패널 / 발라스터 / 연장라인 / AC라인 / 프레임대', 수량: '1', 결과: 'ℹ️ 기본구성', 상세: '세트 동봉품(개별 재고 미관리)' }
    ]
  });
  assert.equal(setUnavailable.status, 'unavailable', '세트 헤더의 본체 불가 근거는 무시하면 안 된다');
});

test('buildHermesPostActionPrompt delegates result interpretation and reply prose to Hermes', () => {
  const prompt = buildHermesPostActionPrompt({
    job: { id: 'job-post-action', room_key: 'preview:hong', preview_text: '예약 가능할까요?' },
    initialDecision: completeSheetDecision(),
    sheetResult: {
      reqID: 'RQ-260724-001',
      results: [{ 장비명: '소니 FX3 바디세트', 수량: '1', 결과: '✅ 가용1', 상세: '예약 가능' }]
    },
    sheetPayload: {
      args: { 예약자명: '홍길동', 장비: [{ 이름: '소니 FX3 바디세트', 수량: 1 }] }
    }
  });

  assert.match(prompt, /POST-ACTION HERMES AI REASONING PASS/i);
  assert.match(prompt, /RQ-260724-001/);
  assert.match(prompt, /소니 FX3 바디세트/);
  assert.match(prompt, /outer code.*must not author customer-facing prose/is);
  assert.match(prompt, /"should_write_to_sheet": false/);
  assert.match(prompt, /replyMode="draft_only"/);
  assert.match(prompt, /owner_review_required.*true/is);
  assert.doesNotMatch(prompt, /may choose replyMode="auto_send"/);
  assert.match(prompt, /FINAL_JSON/);
});

test('buildHermesPostActionPrompt carries forward facts without duplicating bulky first-pass evidence', () => {
  const bulkyEvidence = `BULKY_EVIDENCE_${'x'.repeat(50000)}`;
  const prompt = buildHermesPostActionPrompt({
    job: { id: 'job-compact', room_key: 'preview:hong', preview_text: '예약 가능할까요?' },
    initialDecision: completeSheetDecision({
      customer: { name: '홍길동' },
      visible_messages_used: [{ sender: '홍길동', message: '예약 가능할까요?', time: '오후 1:00' }],
      follow_up_items: [{
        type: 'schedule_check',
        route: 'schedule',
        taskKey: 'compact-task',
        priority: 'high',
        status: 'open',
        title: '가용 확인',
        customer_name: '홍길동',
        summary: '가용 확인 필요',
        recommended_action: '시트 결과 확인',
        suggested_reply_draft: '',
        evidence: [bulkyEvidence],
        blocking_reason: null,
        due_hint: 'now'
      }]
    }),
    sheetResult: {
      reqID: 'RQ-260724-001',
      results: [{ 장비명: '소니 FX3 바디세트', 수량: '1', 결과: '✅ 가용1', 상세: '예약 가능' }]
    },
    sheetPayload: { args: { 예약자명: '홍길동', 장비: [{ 이름: '소니 FX3 바디세트', 수량: 1 }] } }
  });

  assert.doesNotMatch(prompt, /BULKY_EVIDENCE_/);
  assert.match(prompt, /compact-task/);
  assert.match(prompt, /RQ-260724-001/);
  assert.ok(prompt.length < 20000, `post-action prompt unexpectedly large: ${prompt.length}`);
});

test('validateAiPostActionDecisionContract prevents code-side or unsafe availability shortcuts', () => {
  const availableReport = {
    status: 'available',
    payload: { reqID: 'RQ-260724-001', status: 'available', results: [{ result: '✅ 가용1' }] }
  };
  assert.equal(validateAiPostActionDecisionContract(completePostActionDecision(), availableReport).valid, true);

  const rewritesSheet = completePostActionDecision({ should_write_to_sheet: true });
  const rewriteValidation = validateAiPostActionDecisionContract(rewritesSheet, availableReport);
  assert.equal(rewriteValidation.valid, false);
  assert.ok(rewriteValidation.errors.some((error) => error.includes('should_write_to_sheet must be false')));

  for (const status of ['available', 'warning', 'unavailable', 'unknown']) {
    const forcedAutoSend = validateAiPostActionDecisionContract(
      completePostActionDecision({
        owner_review_required: false,
        reply_decision: {
          replyMode: 'auto_send',
          text: status === 'unknown'
            ? '요청 접수했습니다. 재고 확인 후 바로 안내드릴게요.'
            : '확인 결과를 안내드립니다.',
          safetyClass: status === 'unknown' ? 'simple_ack' : 'authoritative_availability_answer'
        }
      }),
      { status, payload: { status, results: [] } }
    );
    assert.equal(forcedAutoSend.valid, false, `${status} schedule result must require owner review`);
    assert.ok(forcedAutoSend.errors.some((error) => error.includes('owner review')));
  }

  const missingScheduleTask = validateAiPostActionDecisionContract(
    completePostActionDecision({
      follow_up_items: [],
      reply_decision: { shouldCreateTask: false }
    }),
    availableReport
  );
  assert.equal(missingScheduleTask.valid, false);
  assert.ok(missingScheduleTask.errors.some((error) => error.includes('schedule follow-up')));
});

test('runHermesPostActionDecision returns a typed AI reconciliation over authoritative sheet facts', async () => {
  const outputs = [`FINAL_JSON\n\`\`\`json\n${JSON.stringify(completePostActionDecision())}\n\`\`\``];
  const prompts = [];
  const result = await runHermesPostActionDecision({
    config: { hermesCommand: 'fake-hermes', hermesTimeoutMs: 240000 },
    job: { id: 'job-post-action', room_key: 'preview:hong' },
    initialDecision: completeSheetDecision(),
    sheetResult: {
      reqID: 'RQ-260724-001',
      results: [{ 장비명: '소니 FX3 바디세트', 수량: '1', 결과: '✅ 가용1', 상세: '예약 가능' }]
    },
    sheetPayload: { args: { 예약자명: '홍길동', 장비: [{ 이름: '소니 FX3 바디세트', 수량: 1 }] } }
  }, {
    runHermesImpl: async (prompt) => {
      prompts.push(prompt);
      return outputs.shift();
    }
  });

  assert.equal(result.skipped, false);
  assert.equal(result.attempts, 1);
  assert.equal(result.decision.post_action_reconciled, true);
  assert.equal(result.decision.authoritative_sheet_result.status, 'available');
  assert.equal(result.decision.reply_decision.replyMode, 'draft_only');
  assert.equal(result.decision.owner_review_required, true);
  assert.match(prompts[0], /RQ-260724-001/);
});

test('suppressDecisionForUnreconciledSheetResult fails closed instead of sending stale AI prose', () => {
  const decision = suppressDecisionForUnreconciledSheetResult(
    completePostActionDecision(),
    { payload: { reqID: 'RQ-260724-001', status: 'available', results: [{ result: '✅ 가용1' }] } }
  );

  assert.equal(decision.post_action_reconciled, false);
  assert.equal(decision.authoritative_sheet_result.status, 'available');
  assert.equal(decision.suggested_reply_draft, '');
  assert.equal(decision.reply_decision.replyMode, 'no_reply');
  assert.equal(decision.reply_decision.safetyClass, 'no_send');
  assert.equal(canAutoSendCustomerAnswer(decision, { autoSendEnabled: true }).allowed, false);
});

test('fetchExistingConfirmRequestResultForDecision reads RQ result rows from 확인요청 search', async () => {
  const requested = [];
  const result = await fetchExistingConfirmRequestResultForDecision({
    gasApiUrl: 'https://gas.example/exec',
    sheetApiKey: 'secret',
    fetchImpl: async (url) => {
      requested.push(new URL(String(url)));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          sheet: '확인요청',
          query: 'RQ-260531-003',
          headers: ['요청ID', '반출일', '반출시간', '반납일', '반납시간', '장비or세트명', '수량', '확인', '결과', '상세'],
          count: 2,
          results: [{
            row: 12,
            data: ['RQ-260531-003', '2026-05-30', '23:00', '2026-05-31', '23:00', '소니 캠 AX-700', '1', '', '✅ 가용1', '예약 가능']
          }, {
            row: 13,
            data: ['RQ-260531-003', '', '', '', '', '세트 기본 배터리', '2', '', 'ℹ️ 기본구성', '', '', '', '', '', '', '', '[세트]소니 캠 AX-700']
          }]
        })
      };
    }
  }, {
    reason: '기존 RQ 발견으로 중복 입력 방지: RQ-260531-003',
    existing_confirm_request_ids: ['RQ-260531-003']
  }, []);

  assert.equal(requested[0].searchParams.get('action'), 'search');
  assert.equal(requested[0].searchParams.get('sheet'), '확인요청');
  assert.equal(requested[0].searchParams.get('col'), 'A');
  assert.equal(requested[0].searchParams.get('query'), 'RQ-260531-003');
  assert.equal(result.reqID, 'RQ-260531-003');
  assert.equal(result.duplicate, true);
  assert.deepEqual(result.results, [
    { equipment: '소니 캠 AX-700', quantity: '1', result: '✅ 가용1', detail: '예약 가능' },
    { equipment: '세트 기본 배터리', quantity: '2', result: 'ℹ️ 기본구성', detail: '' }
  ]);
  assert.deepEqual(result.topLevelEquipment, [
    { 이름: '소니 캠 AX-700', 수량: 1 }
  ]);
});

test('fetchExistingConfirmRequestResultForDecision never infers RQ ids from prose', async () => {
  let fetches = 0;
  const result = await fetchExistingConfirmRequestResultForDecision({
    gasApiUrl: 'https://gas.example/exec',
    sheetApiKey: 'secret',
    fetchImpl: async () => {
      fetches += 1;
      throw new Error('must not fetch');
    }
  }, {
    reason: '기존 RQ-260531-003 발견',
    follow_up_items: [{ summary: 'RQ-260531-003 결과 확인' }]
  }, []);

  assert.equal(result, null);
  assert.equal(fetches, 0);
});

test('enrichFollowUpRowsWithSheetAvailability replaces inspect-RQ card with result-based report', () => {
  const rows = buildFollowUpRows({
    classification: 'reservation',
    confidence: 'high',
    customer: { name: '최재원' },
    follow_up_items: [{
      type: 'sheet_duplicate_check',
      route: 'schedule',
      priority: 'urgent',
      status: 'open',
      title: '최재원 AX-700 예약 가능 문의 응답 필요',
      customer_name: '최재원',
      summary: '확인요청 시트에는 이미 동일 고객/동일 반출일/동일 장비 RQ가 존재합니다.',
      recommended_action: '기존 확인요청 RQ의 확인 결과를 검토한 뒤 고객에게 가능 여부를 안내하세요.',
      suggested_reply_draft: '확인해보니 소니 캠 AX-700 해당 일정 예약 가능하십니다.',
      evidence: ['기존 RQ 발견']
    }]
  }, {
    id: '11111111-1111-4111-8111-111111111111',
    room_key: 'preview:choi'
  });

  const enriched = enrichFollowUpRowsWithSheetAvailability(rows, {
    reqID: 'RQ-260531-003',
    duplicate: true,
    results: [
      { 장비명: '소니 캠 AX-700', 수량: '1', 결과: '⚠️ 겹침(가용0)', 상세: '기존 예약과 겹침' }
    ]
  }, {
    args: {
      예약자명: '최재원',
      반출일: '2026-05-30',
      반출시간: '23:00',
      반납일: '2026-05-31',
      반납시간: '23:00',
      장비: [{ 이름: '소니 캠 AX-700', 수량: 1 }]
    }
  }, { classification: 'reservation', confidence: 'high', customer: { name: '최재원' } }, {
    id: '11111111-1111-4111-8111-111111111111',
    room_key: 'preview:choi'
  });

  assert.equal(enriched.length, 1);
  assert.equal(enriched[0].type, 'sheet_duplicate_check');
  assert.equal(enriched[0].payload.follow_up_route, 'schedule');
  assert.match(enriched[0].summary, /RQ-260531-003/);
  assert.match(enriched[0].recommended_action, /가능하다고 안내하지 말고/);
  assert.match(enriched[0].evidence.join('\n'), /⚠️ 겹침\(가용0\)/);
  assert.equal(enriched[0].suggested_reply_draft, '', 'stale AI prose must be cleared after authoritative availability changes');
});

test('enrichFollowUpRowsWithSheetAvailability handles duplicate RQ result without sheet payload', () => {
  const enriched = enrichFollowUpRowsWithSheetAvailability([], {
    reqID: 'RQ-260601-001',
    duplicate: true,
    results: [
      { 장비명: '소니 FX3 바디세트', 수량: '1', 결과: '✅ 가용1', 상세: '예약 가능' }
    ]
  }, null, { classification: 'reservation', confidence: 'high', customer: { name: '정민주' } }, {
    id: '22222222-2222-4222-8222-222222222222',
    room_key: 'preview:jung'
  });

  assert.equal(enriched.length, 1);
  assert.equal(enriched[0].customer_name, '정민주');
  assert.match(enriched[0].summary, /RQ-260601-001/);
  assert.match(enriched[0].evidence.join('\n'), /✅ 가용1/);
  assert.equal(enriched[0].payload.sheet_request, null);
  assert.equal(enriched[0].suggested_reply_draft, '', 'programmatic availability rows must not synthesize replies');
});

test('enrichFollowUpRowsWithSheetAvailability preserves post-action Hermes semantics while attaching facts', () => {
  const postDecision = {
    ...completePostActionDecision({
      follow_up_items: [{
        ...completePostActionDecision().follow_up_items[0],
        recommended_action: 'Hermes가 전체 결과를 보고 예약 진행 의사를 물으라고 판단했습니다.',
        suggested_reply_draft: '요청하신 전체 장비가 가능합니다. 이 일정으로 예약 진행해드릴까요?'
      }]
    }),
    post_action_reconciled: true,
    authoritative_sheet_result: { status: 'available' }
  };
  const rows = buildFollowUpRows(postDecision, { id: 'job-post', room_key: 'preview:hong' });
  const enriched = enrichFollowUpRowsWithSheetAvailability(rows, {
    reqID: 'RQ-260724-001',
    results: [{ 장비명: '소니 FX3 바디세트', 수량: '1', 결과: '✅ 가용1', 상세: '예약 가능' }]
  }, null, postDecision, { id: 'job-post', room_key: 'preview:hong' });

  assert.equal(enriched.length, 1);
  assert.equal(enriched[0].recommended_action, 'Hermes가 전체 결과를 보고 예약 진행 의사를 물으라고 판단했습니다.');
  assert.equal(enriched[0].suggested_reply_draft, '요청하신 전체 장비가 가능합니다. 이 일정으로 예약 진행해드릴까요?');
  assert.equal(enriched[0].payload.sheet_availability.status, 'available');
  assert.match(enriched[0].evidence.join('\n'), /✅ 가용1/);
});

test('extractConfirmRequestIds finds unique RQ ids in AI decisions and rows', () => {
  assert.deepEqual(extractConfirmRequestIds({
    reason: '기존 RQ-260531-003 발견',
    rows: [{ summary: '다시 RQ-260531-003 / 다른 RQ-260601-001' }]
  }), ['RQ-260531-003', 'RQ-260601-001']);
});

test('buildSheetFailureFollowUpRows creates actionable cards for validation errors and suppresses duplicates', () => {
  const decision = {
    classification: 'reservation',
    customer: { name: '박정민' }
  };
  const job = {
    id: '11111111-1111-4111-8111-111111111111',
    room_key: 'preview:park'
  };
  const sheetPayload = {
    args: {
      반출일: '2026-04-31',
      반출시간: '12:30',
      반납일: '2026-05-01',
      반납시간: '12:30',
      예약자명: '박정민',
      장비: [{ 이름: '어퓨쳐 600C', 수량: 2 }]
    }
  };
  const rows = buildSheetFailureFollowUpRows(decision, job, {
    success: false,
    error_type: 'sheet_validation',
    error: '셀 B52에 입력한 데이터가 이 셀에 설정된 데이터 확인 규칙을 위반했습니다.'
  }, sheetPayload);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'reservation_review');
  assert.equal(rows[0].priority, 'urgent');
  assert.equal(rows[0].decision_classification, 'sheet_write_rejected');
  assert.match(rows[0].summary, /GAS가 확인요청 입력을 거절/);
  assert.match(rows[0].evidence.join('\n'), /2026-04-31/);
  assert.equal(rows[0].suggested_reply_draft, '', 'deterministic failure plumbing must not author customer prose');

  assert.deepEqual(buildSheetFailureFollowUpRows(decision, job, {
    success: false,
    error_type: 'duplicate_request',
    error: '중복 요청: 동일 건이 이미 예약 등록되어 있습니다'
  }, sheetPayload), []);
});

test('buildFollowUpRows maps AI-decided follow-up items for remote dashboard', () => {
  const rows = buildFollowUpRows({
    classification: 'price',
    confidence: 'medium',
    customer: { name: '홍길동' },
    latest_customer_message_cluster: '견적서 받을 수 있을까요?',
    visible_messages_used: [
      { sender: '홍길동', message: '견적서 받을 수 있을까요?', time: '오후 3:10' }
    ],
    follow_up_items: [{
      type: 'quote_send',
      route: 'document',
      taskKey: 'fx3_quote_send',
      priority: 'high',
      status: 'open',
      title: 'FX3 견적서 발송',
      customer_name: '홍길동',
      summary: '고객이 FX3 견적서를 요청함',
      recommended_action: '스케줄과 가격 확인 후 견적서 발송',
      suggested_reply_draft: '감독님, 확인 후 견적서 보내드리겠습니다.',
      evidence: ['고객: 견적서 받을 수 있을까요?'],
      due_hint: 'today'
    }]
  }, { id: '11111111-1111-4111-8111-111111111111', room_key: 'room-label:홍길동' });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'quote_send');
  assert.equal(rows[0].priority, 'high');
  assert.equal(rows[0].customer_name, '홍길동');
  assert.equal(rows[0].job_id, '11111111-1111-4111-8111-111111111111');
  assert.equal(rows[0].decision_classification, 'price');
  assert.deepEqual(rows[0].evidence, ['고객: 견적서 받을 수 있을까요?']);
  assert.equal(rows[0].payload.latest_customer_message_cluster, '견적서 받을 수 있을까요?');
  assert.equal(rows[0].payload.visible_messages_used[0].message, '견적서 받을 수 있을까요?');
  assert.match(rows[0].follow_up_key, /^room-label:홍길동:홍길동:quote_send:/);
});

test('buildFollowUpRows drops AI follow-ups when the latest meaningful turn is staff outbound', () => {
  const rows = buildFollowUpRows({
    classification: 'faq',
    confidence: 'high',
    customer: { name: 'Customer' },
    latest_customer_message_cluster: 'An earlier customer question.',
    latest_staff_message: '렌즈 기스 사진까지 확인했고 고객에게 이미 답변했습니다.',
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      latest_customer_message_after_last_staff_reply: false
    },
    follow_up_items: [{
      type: 'reply_needed',
      route: 'other',
      taskKey: 'already_answered',
      priority: 'normal',
      status: 'open',
      title: 'Must not become a Slack card',
      summary: 'The latest message is staff outbound.'
    }]
  }, { room_key: 'chat:staff-latest' });

  assert.deepEqual(rows, []);
});

test('routeFollowUpToSlack maps follow-up types to the agent channels', () => {
  assert.deepEqual(routeFollowUpToSlack({ type: 'reservation_review' }), { route: 'schedule', channel: '스케쥴-agent' });
  assert.deepEqual(routeFollowUpToSlack({ type: 'quote_send' }), { route: 'document', channel: '서류발송-agent' });
  assert.deepEqual(routeFollowUpToSlack({ type: 'payment_check' }), { route: 'settlement', channel: '정산-agent' });
  assert.deepEqual(routeFollowUpToSlack({ type: 'reply_needed' }), { route: 'other', channel: '기타문의' });
  assert.deepEqual(routeFollowUpToSlack({ type: 'damage_repair' }), { route: 'inventory', channel: '재고관리-agent' });
});

test('routeFollowUpToSlack follows the explicit Hermes route and never scans prose to change it', () => {
  assert.deepEqual(routeFollowUpToSlack({
    type: 'reply_needed',
    summary: '견적서와 세금계산서라는 단어가 있지만 일반 문의입니다.',
    payload: { follow_up_route: 'other' }
  }), { route: 'other', channel: '기타문의' });
  assert.deepEqual(routeFollowUpToSlack({
    type: 'reply_needed',
    summary: '문서라는 단어가 반복됩니다. 견적서 견적서.',
    payload: { follow_up_route: 'schedule' }
  }), { route: 'schedule', channel: '스케쥴-agent' });
});

test('routeFollowUpToSlack keeps operational follow-ups out of document channel despite document words', () => {
  assert.deepEqual(routeFollowUpToSlack({
    type: 'damage_repair',
    title: '이기욱 파손 건 및 견적서 확인 후속',
    summary: '파손 확인과 견적서 금액 대조가 함께 필요합니다.'
  }), { route: 'inventory', channel: '재고관리-agent' });

  assert.deepEqual(routeFollowUpToSlack({
    type: 'completed_log',
    title: '박정우 6/10 예약 확정 건 확인요청 입력 필요',
    summary: '확인요청 입력 후 처리 완료 기록',
    payload: { follow_up_route: 'schedule' }
  }), { route: 'schedule', channel: '스케쥴-agent' });

  assert.deepEqual(routeFollowUpToSlack({
    type: 'completed_log',
    title: '이기욱 파손 건 및 견적서 확인 후속',
    summary: '파손 확인 후 완료 기록',
    payload: { follow_up_route: 'inventory' }
  }), { route: 'inventory', channel: '재고관리-agent' });

  assert.deepEqual(routeFollowUpToSlack({
    type: 'price_review',
    title: '박용배 견적 및 방문시간 답변 필요',
    summary: '고객이 방문 준비물과 금액을 물었습니다.'
  }), { route: 'other', channel: '기타문의' });
});

test('routeFollowUpToSlack routes an AI-explicit document card to the document channel', () => {
  assert.deepEqual(routeFollowUpToSlack({
    type: 'reply_needed',
    title: '하현준 사업자등록증·통장사본 전달 요청',
    summary: '고객이 사업자등록증과 통장사본 전달을 요청했습니다.',
    payload: { follow_up_route: 'document' }
  }), { route: 'document', channel: '서류발송-agent' });
});

test('routeFollowUpToSlack sends an AI-explicit reservation reply card to schedule agent', () => {
  assert.deepEqual(routeFollowUpToSlack({
    type: 'reply_needed',
    title: '이기욱 예약 후보 확인 필요',
    summary: '고객이 6/3~6/4 장비 예약 진행을 요청했습니다.',
    payload: { follow_up_route: 'schedule' }
  }), { route: 'schedule', channel: '스케쥴-agent' });
});

test('routeFollowUpToSlack keeps 확인요청 누락 recovery cards in schedule agent', () => {
  assert.deepEqual(routeFollowUpToSlack({
    type: 'reply_needed',
    title: 'ᄀ김준우 1 넵 그럼 예약부탁드립니다 자동 처리 확인 필요',
    summary: "채팅목록에는 '넵 그럼 예약부탁드립니다'가 보이나 실제 채팅방 맥락을 열어 확인하지 못했습니다.",
    recommended_action: '카카오 채팅방을 직접 열어 원문을 확인하고, 확인요청/계약마스터에 이미 처리됐는지 대조하세요. 누락이면 확인요청 입력 또는 답변을 처리하세요.',
    payload: { follow_up_route: 'schedule' }
  }), { route: 'schedule', channel: '스케쥴-agent' });
});

test('routeFollowUpToSlack keeps target Kakao mismatch diagnostics out of settlement despite payment preview text', () => {
  assert.deepEqual(routeFollowUpToSlack({
    type: 'reply_needed',
    title: '대상 카카오 대화 확인 불가',
    summary: "고객 요청: 헉 저는 최근에 메모리 빌린적이 없습니다. 잡 프리뷰는 '입금드릴게요!! 오전09:34'였지만 현재 열린 카카오 대화는 김나영 채팅이며 해당 메시지가 보이지 않았습니다.",
    recommended_action: '짧게 답변',
    evidence: [
      '고객: 헉 저는 최근에 메모리 빌린적이 없습니다',
      '직원: 죄송합니다. 감독님! 동명이인이어서 잘못 연락 드렸습니다!'
    ]
  }), { route: 'other', channel: '기타문의' });
});

test('routeFollowUpToSlack keeps reservation cards in schedule route even when evidence mentions 계약마스터', () => {
  assert.deepEqual(routeFollowUpToSlack({
    type: 'reservation_review',
    title: '김정혜 DJI 무선마이크 당일 예약 확인요청 입력 및 18시 수령 안내',
    summary: '확인요청 RQ-260609-004 가용확인 결과: DJI 마이크 미니2 x1: 세트',
    recommended_action: '기존 RQ 기준으로 처리하고 내부 등록/가용확인 상태를 확인하세요.',
    evidence: [
      '카카오 화면: 고객이 DJI 무선마이크 예약 정보를 제공',
      '계약마스터 조회: 거래ID 260609-005, 김정혜, 예약 상태',
      '스케줄상세 조회: 거래ID 260609-005, DJI 마이크 미니2, 상태 대기'
    ]
  }), { route: 'schedule', channel: '스케쥴-agent' });
});

test('buildSlackFollowUpMessage includes action buttons and deduplicated automation-style summary', () => {
  const message = buildSlackFollowUpMessage({
    id: 'follow-1',
    type: 'reservation_review',
    priority: 'urgent',
    status: 'open',
    title: '최재원 AX-700 예약 가능 문의',
    customer_name: '최재원',
    summary: '고객이 5/30 23:00~5/31 23:00 AX-700 가능 여부를 문의했습니다.',
    recommended_action: '확인요청 결과가 ✅ 가용이면 가능 안내 후 예약 진행 여부를 확인하세요.',
    suggested_reply_draft: '확인해보니 해당 일정 예약 가능하십니다.',
    evidence: ['확인요청 RQ-260531-003: ✅ 가용1'],
    payload: {
      sheet_request: {
        반출일: '2026-05-30',
        반출시간: '23:00',
        반납일: '2026-05-31',
        반납시간: '23:00',
        장비: [{ 이름: '소니 캠 AX-700', 수량: 1 }]
      },
      sheet_availability: {
        reqID: 'RQ-260531-003',
        status: 'available',
        duplicate: true,
        results: [{ equipment: '소니 캠 AX-700', quantity: '1', result: '✅ 가용1', detail: '예약 가능' }]
      },
      visible_messages_used: [
        { sender: '최재원', message: '소니 캠 AX-700 5월30일 밤부터 31일 밤까지 가능할까요?', time: '오후 5:01' },
        { sender: '빌리지님', message: '확인해보겠습니다.', time: '오후 5:02' }
      ]
    }
  });

  assert.equal(message.channel, '스케쥴-agent');
  assert.match(JSON.stringify(message.blocks), /village_followup_send/);
  assert.match(JSON.stringify(message.blocks), /village_followup_edit_send/);
  assert.match(JSON.stringify(message.blocks), /village_followup_status_done/);
  assert.match(JSON.stringify(message.blocks), /처리 요약/);
  assert.match(JSON.stringify(message.blocks), /⚠️ 현재 상태/);
  assert.match(JSON.stringify(message.blocks), /🧩 처리 내용/);
  assert.match(JSON.stringify(message.blocks), /🎒 장비 \/ 📅 기간/);
  assert.match(JSON.stringify(message.blocks), /➡️ 내가 할 일/);
  assert.match(JSON.stringify(message.blocks), /고객 요청/);
  assert.doesNotMatch(JSON.stringify(message.blocks), /근거/);
  assert.doesNotMatch(JSON.stringify(message.blocks), /추천 조치/);
  assert.doesNotMatch(JSON.stringify(message.blocks), /라우팅/);
  assert.doesNotMatch(JSON.stringify(message.blocks), /Agent 호출/);
  assert.doesNotMatch(JSON.stringify(message.blocks), /헤이빌리/);
  assert.match(JSON.stringify(message.blocks), /RQ-260531-003/);
  assert.match(JSON.stringify(message.blocks), /소니 캠 AX-700 x1: ✅ 가용1/);
  assert.match(JSON.stringify(message.blocks), /가능 안내 후 예약 진행 여부 확인/);
  assert.equal((JSON.stringify(message.blocks).match(/최재원/g) || []).length, 1);
  assert.equal((JSON.stringify(message.blocks).match(/예약 후보 확인/g) || []).length, 1);
  assert.equal((JSON.stringify(message.blocks).match(/RQ-260531-003/g) || []).length, 1);
  assert.doesNotMatch(JSON.stringify(message.blocks), /버튼 동작/);
  assert.doesNotMatch(JSON.stringify(message.blocks), /현재 초안으로 카카오 발송 요청/);
  assert.doesNotMatch(JSON.stringify(message.blocks), /대시보드/);
  assert.doesNotMatch(JSON.stringify(message.blocks), /\\n  /);
});

test('manual task card leads with one concrete action and never mentions or sends to a customer', () => {
  const message = buildSlackManualTaskMessage({
    id: 'manual-1',
    type: 'tax_invoice',
    customer_name: '윤영준',
    title: '260729-001 세금계산서 발행',
    summary: '고객이 사업자번호 2973501207로 세금계산서를 요청했습니다.',
    recommended_action: '사업자번호 2973501207로 세금계산서를 발행하세요.',
    suggested_reply_draft: '발행해드리겠습니다.',
    evidence: ['거래 260729-001 · VAT 포함 84,700원', '오늘 15시 방문 예정', 'Agent 호출 17회'],
    payload: {
      card_kind: 'follow_up_task',
      requires_human_action: true,
      action_family: 'invoice_issue',
      business_object_key: 'trade:260729-001'
    }
  }, {
    route: { route: 'follow_up', channel: 'C0BMNJY7H8D' },
    config: { slackMentionUserIds: ['U03EB8L0QDR'] }
  });

  const rendered = JSON.stringify(message.blocks);
  const sections = message.blocks.filter((block) => block.type === 'section');
  const metadata = message.blocks.find((block) => block.type === 'context');
  assert.equal(message.channel, 'C0BMNJY7H8D');
  assert.match(metadata.elements[0].text, /고객.*윤영준/);
  assert.match(metadata.elements[0].text, /대상.*260729-001/);
  assert.match(sections[0].text.text, /내가 할 일/);
  assert.match(sections[0].text.text, /2973501207로 세금계산서를 발행하세요/);
  assert.match(rendered, /세금계산서/);
  assert.match(rendered, /84,700원/);
  assert.match(rendered, /village_followup_status_in_progress/);
  assert.match(rendered, /village_followup_status_done/);
  assert.match(rendered, /village_followup_status_dismissed/);
  assert.doesNotMatch(rendered, /발행해드리겠습니다|village_followup_send|village_followup_edit_send/);
  assert.doesNotMatch(rendered, /처리 요약|현재 상태|처리 내용|권장 조치|Agent 호출/);
  assert.doesNotMatch(rendered, /<@U03EB8L0QDR>/);
  assert.doesNotMatch(message.text, /<@U03EB8L0QDR>/);
  assert.ok(message.text.length <= 40);
});

test('manual task card escapes action and fact text exactly once', () => {
  const message = buildSlackManualTaskMessage({
    id: 'manual-escape-1',
    recommended_action: 'Review A & B <today>',
    evidence: ['Fact A & B <today>'],
    payload: {
      requires_human_action: true,
      action_family: 'invoice_issue'
    }
  }, {
    route: { route: 'follow_up', channel: 'C0BMNJY7H8D' }
  });

  const rendered = JSON.stringify(message.blocks);
  assert.match(rendered, /Review A &amp; B &lt;today&gt;/);
  assert.match(rendered, /Fact A &amp; B &lt;today&gt;/);
  assert.doesNotMatch(rendered, /&amp;amp;|&amp;lt;|&amp;gt;/);
});

test('manual task card uses 업무 대상 확인 when no business object or customer is available', () => {
  const message = buildSlackManualTaskMessage({}, {
    route: { route: 'follow_up', channel: 'C0BMNJY7H8D' }
  });

  assert.equal(message.blocks[0].text.text, '업무 확인 · 업무 대상 확인');
  assert.match(message.text, /업무 대상 확인/);
});

test('manual task card preserves safe non-trade business object targets', () => {
  const cases = [
    ['request:RQ-260804-001', '요청 RQ-260804-001'],
    ['equipment:sony-fx3', '장비 sony-fx3'],
    ['task:quote-review', '업무 quote-review']
  ];

  for (const [businessObjectKey, expectedTarget] of cases) {
    const message = buildSlackManualTaskMessage({
      id: `manual-${businessObjectKey}`,
      customer_name: '윤영준',
      recommended_action: '대상을 확인하세요.',
      payload: {
        requires_human_action: true,
        action_family: 'inventory_check',
        business_object_key: businessObjectKey
      }
    }, { route: { route: 'follow_up', channel: 'C0BMNJY7H8D' } });

    const metadata = message.blocks.find((block) => block.type === 'context');
    assert.match(message.blocks[0].text.text, new RegExp(expectedTarget));
    assert.match(metadata.elements[0].text, new RegExp(expectedTarget));
    assert.match(message.text, new RegExp(expectedTarget));
  }
});

test('manual task plain-text header keeps customer ampersands readable while fallback escapes them', () => {
  const message = buildSlackManualTaskMessage({
    id: 'manual-plain-text-customer',
    customer_name: 'A & B',
    recommended_action: '업무를 확인하세요.',
    payload: { requires_human_action: true, action_family: 'document_approval' }
  }, { route: { route: 'follow_up', channel: 'C0BMNJY7H8D' } });

  assert.match(message.blocks[0].text.text, /A & B/);
  assert.match(message.text, /A &amp; B/);
  assert.doesNotMatch(message.blocks[0].text.text, /&amp;/);
  assert.doesNotMatch(message.text, /&amp;amp;/);
});

test('manual task fallback escapes customer-derived Slack mentions without changing its plain-text header', () => {
  const message = buildSlackManualTaskMessage({
    customer_name: '<@U03EB8L0QDR>',
    payload: { requires_human_action: true, action_family: 'document_approval' }
  }, { route: { route: 'follow_up', channel: 'C0BMNJY7H8D' } });

  assert.match(message.blocks[0].text.text, /<@U03EB8L0QDR>/);
  assert.doesNotMatch(message.blocks[0].text.text, /&lt;/);
  assert.doesNotMatch(message.text, /<@/);
  assert.match(message.text, /&lt;@U03EB8L0QDR&gt;/);
  assert.doesNotMatch(message.text, /&amp;amp;|&amp;lt;|&amp;gt;/);
  assert.ok(message.text.length <= 40);
});

test('inquiry card is a minimal Kakao pointer with an auto-reply check only', () => {
  const latest = '오늘 입금확인증 보내주시면 감사하겠습니다.';
  const draft = '입금확인증 요청을 확인해 접수하겠습니다.';
  const base = {
    id: 'inquiry-1', type: 'customer_inquiry', customer_name: '김영준',
    summary: latest,
    recommended_action: '직원 처리가 필요한 요청입니다. 다음 문장은 표시하지 않습니다.',
    suggested_reply_draft: draft,
    evidence: ['거래 260729-001 · VAT 포함 84,700원', 'worker.mjs:5800']
  };
  const options = {
    route: { route: 'inquiry', channel: 'C0BMRVDP2Q2' },
    config: { slackFollowUpChannel: 'C0BMNJY7H8D', slackMentionUserIds: ['U03EB8L0QDR'] }
  };
  const unanswered = buildSlackInquiryMessage({
    ...base,
    payload: { card_kind: 'inquiry_case', latest_customer_message_cluster: latest }
  }, options);
  const autoReplied = buildSlackInquiryMessage({
    ...base,
    payload: { card_kind: 'inquiry_case', latest_customer_message_cluster: latest, auto_reply_sent: true }
  }, options);

  const rendered = JSON.stringify(unanswered.blocks);
  assert.match(rendered, /카톡 채널 관리자에서 확인하세요/);
  assert.match(rendered, /📩 AI 응답 없음/);
  assert.match(JSON.stringify(autoReplied.blocks), /✅ AI 자동응답 보냄/);
  assert.doesNotMatch(rendered, /오늘 입금확인증 보내주시면 감사하겠습니다\./);
  assert.doesNotMatch(rendered, /AI 판단|직원 처리가 필요한 요청입니다|거래 260729-001/);
  assert.doesNotMatch(rendered, /입금확인증 요청을 확인해 접수하겠습니다\./);
  assert.doesNotMatch(rendered, /village_followup_send|village_followup_edit_send|답변 초안|답변 작성/);
  assert.match(rendered, /village_followup_status_done/);
  assert.match(rendered, /village_followup_open_kakao_manager/);
  assert.match(rendered, /business\.kakao\.com/);
  assert.doesNotMatch(rendered, /village_followup_open_manual_channel/);
  assert.doesNotMatch(rendered, /worker\.mjs|처리 요약|<@U03EB8L0QDR>/);
  assert.equal(unanswered.channel, 'C0BMRVDP2Q2');
  assert.match(autoReplied.text, /AI 응답됨/);
  assert.ok(unanswered.text.length <= 40);
});

test('inquiry fallback never replays the latest customer message or raw mentions', () => {
  const message = buildSlackInquiryMessage({
    customer_name: '고객',
    payload: {
      card_kind: 'inquiry_case',
      latest_customer_message_cluster: '<@U03EB8L0QDR> 확인 부탁드립니다.'
    }
  }, { route: { route: 'inquiry', channel: 'C0BMRVDP2Q2' } });

  assert.match(message.blocks[0].text.text, /고객/);
  assert.doesNotMatch(message.blocks[0].text.text, /&amp;/);
  assert.doesNotMatch(message.text, /<@|U03EB8L0QDR|확인 부탁드립니다/);
  assert.match(message.text, /카톡 확인/);
  assert.ok(message.text.length <= 40);
});

test('inquiry cards never render drafts or reply controls regardless of draft shape', () => {
  const rows = [
    {
      id: 'inquiry-empty', customer_name: '김정희', recommended_action: '답변 검토가 필요',
      payload: { card_kind: 'inquiry_case', latest_customer_message_cluster: '일정 확인 부탁드립니다.' }
    },
    {
      id: 'inquiry-failure', customer_name: '고객명 확인 필요', suggested_reply_draft: '잠시만 기다려주세요.',
      payload: { card_kind: 'inquiry_case', failure_kind: 'worker_error', latest_customer_message_cluster: '확인 필요' }
    },
    {
      id: 'inquiry-long', customer_name: '박정수',
      suggested_reply_draft: '첫째 줄\n둘째 줄\n보이면 안 되는 셋째 줄',
      payload: { card_kind: 'inquiry_case', latest_customer_message_cluster: '확인 부탁드립니다.' }
    }
  ];
  for (const row of rows) {
    const message = buildSlackInquiryMessage(row, { route: { route: 'inquiry', channel: 'C0BMRVDP2Q2' } });
    const rendered = JSON.stringify(message.blocks);
    assert.doesNotMatch(rendered, /잠시만 기다려주세요|첫째 줄|둘째 줄|보이면 안 되는 셋째 줄/);
    assert.doesNotMatch(rendered, /village_followup_send|village_followup_edit_send|답변 초안|답변 작성/);
    const actions = message.blocks.find((block) => block.type === 'actions');
    assert.deepEqual(
      actions.elements.map((element) => element.action_id),
      ['village_followup_status_done', 'village_followup_open_kakao_manager']
    );
  }
});

test('production inquiry constructor never replays customer text or evidence on the minimal card', () => {
  const latest = '현금영수증 부탁드립니다.';
  const row = buildInquiryCaseRow({
    customer: { name: 'A & B' },
    latest_customer_message_cluster: latest,
    recommended_action: '직원 처리가 필요합니다.'
  }, { room_key: 'chat:inquiry-evidence' }, [{
    customer_name: 'A & B',
    recommended_action: '직원 처리가 필요합니다.',
    evidence: [`고객: ${latest}`, `A & B: ${latest}`, '거래 260804-001 · 84,700원']
  }]);

  const message = buildSlackInquiryMessage(row, {
    route: { route: 'inquiry', channel: 'C0BMRVDP2Q2' }
  });
  const rendered = JSON.stringify(message.blocks);

  assert.doesNotMatch(rendered, /현금영수증 부탁드립니다\.|거래 260804-001/);
  assert.match(rendered, /카톡 채널 관리자에서 확인하세요/);
  assert.match(message.blocks[0].text.text, /A & B/);
  assert.doesNotMatch(message.blocks[0].text.text, /&amp;/);
  assert.match(message.text, /A &amp; B/);
  assert.doesNotMatch(message.text, /&amp;amp;/);
});

test('buildSlackFollowUpMessage delegates two-channel cards and honors configured mentions', () => {
  const inquiry = buildSlackFollowUpMessage({
    id: 'inquiry-1', customer_name: '윤영준', type: 'customer_inquiry',
    payload: { card_kind: 'inquiry_case', latest_customer_message_cluster: '현금영수증 부탁드립니다.' }
  }, {
    route: { route: 'inquiry', channel: 'CINQUIRY' },
    config: { slackMentionUserIds: ['U03EB8L0QDR'] }
  });
  const manual = buildSlackFollowUpMessage({
    id: 'manual-1', customer_name: '윤영준', type: 'tax_invoice', recommended_action: '세금계산서를 발행하세요.',
    payload: { card_kind: 'follow_up_task', requires_human_action: true, action_family: 'invoice_issue' }
  }, {
    route: { route: 'follow_up', channel: 'CFOLLOWUP' },
    config: { slackMentionUserIds: ['U03EB8L0QDR'] }
  });

  assert.match(JSON.stringify(inquiry.blocks), /카톡 채널 관리자에서 확인하세요/);
  assert.match(JSON.stringify(manual.blocks), /내가 할 일/);
  assert.match(JSON.stringify(inquiry.blocks), /<@U03EB8L0QDR>/);
  assert.match(inquiry.text, /<@U03EB8L0QDR>/);
  assert.match(JSON.stringify(manual.blocks), /<@U03EB8L0QDR>/);
  assert.match(manual.text, /<@U03EB8L0QDR>/);
});

test('follow-up case renders the current internal step without reply controls', () => {
  const row = {
    id: 'case-1', customer_name: '김영준', suggested_reply_draft: '완료되었습니다.',
    payload: {
      card_kind: 'follow_up_case', owner_channel: 'follow_up', phase: 'internal_action', state_version: 7,
      steps: [
        { step_key: 'invoice', action_family: 'invoice_issue', action: '세금계산서를 발행하세요.', status: 'pending' },
        { step_key: 'reply', action_family: 'reservation_change', action: '예약을 수정하세요.', status: 'pending' }
      ]
    }
  };
  const message = buildSlackFollowUpCaseMessage(row, { config: { slackFollowUpChannel: '후속업무', slackInquiryChannel: '카카오톡문의' } });
  const rendered = JSON.stringify(message);
  const actions = message.blocks.find((block) => block.type === 'actions').elements;

  assert.equal(message.channel, '후속업무');
  assert.match(rendered, /1\/2/);
  assert.match(rendered, /세금계산서를 발행하세요/);
  assert.match(rendered, /village_followup_step_done/);
  assert.doesNotMatch(rendered, /village_followup_send|village_followup_edit_send/);
  assert.deepEqual(JSON.parse(actions.find((element) => element.action_id === 'village_followup_step_done').value), { id: 'case-1', state_version: 7 });
  assert.doesNotMatch(rendered, /<@/);
});

test('follow-up case becomes a minimal Kakao pointer after internal steps complete', () => {
  const row = {
    id: 'case-1', customer_name: '김영준', suggested_reply_draft: '발행이 완료되었습니다.',
    payload: {
      card_kind: 'follow_up_case', owner_channel: 'follow_up', phase: 'customer_reply', state_version: 8,
      steps: [{ step_key: 'invoice', action_family: 'invoice_issue', action: '발행', status: 'done' }]
    }
  };
  const message = buildSlackFollowUpCaseMessage(row, { config: { slackFollowUpChannel: '후속업무', slackInquiryChannel: '카카오톡문의' } });
  const rendered = JSON.stringify(message);
  const actions = message.blocks.find((block) => block.type === 'actions').elements;

  assert.equal(message.channel, '후속업무');
  assert.match(rendered, /카톡 채널 관리자에서 확인하세요/);
  assert.doesNotMatch(rendered, /발행이 완료되었습니다|village_followup_send|village_followup_edit_send|답변 초안/);
  assert.match(rendered, /village_followup_reply_not_needed/);
  assert.match(rendered, /village_followup_open_kakao_manager/);
  assert.doesNotMatch(rendered, /village_followup_status_done/);
  assert.deepEqual(JSON.parse(actions.find((element) => element.action_id === 'village_followup_reply_not_needed').value), { id: 'case-1', state_version: 8 });
  assert.doesNotMatch(rendered, /<@/);
});

test('every canonical card button carries the case id and state version', () => {
  const config = { slackFollowUpChannel: '후속업무', slackInquiryChannel: '카카오톡문의' };
  const internal = buildSlackFollowUpCaseMessage({
    id: 'case-buttons', customer_name: 'Kim',
    payload: {
      card_kind: 'follow_up_case', owner_channel: 'follow_up', phase: 'internal_action', state_version: 11,
      steps: [{ step_key: 'one', action: 'Do work', status: 'pending' }]
    }
  }, { config });
  const reply = buildSlackFollowUpCaseMessage({
    id: 'case-buttons', customer_name: 'Kim', suggested_reply_draft: 'Reply now.',
    payload: {
      card_kind: 'follow_up_case', owner_channel: 'follow_up', phase: 'customer_reply', state_version: 11,
      steps: [{ step_key: 'one', action: 'Do work', status: 'done' }]
    }
  }, { config });
  const buttons = [...internal.blocks, ...reply.blocks]
    .filter((block) => block.type === 'actions')
    .flatMap((block) => block.elements);

  assert.deepEqual(buttons.map((button) => button.action_id).sort(), [
    'village_followup_open_kakao_manager',
    'village_followup_reply_not_needed',
    'village_followup_status_dismissed',
    'village_followup_status_in_progress',
    'village_followup_step_done'
  ]);
  for (const button of buttons) {
    assert.deepEqual(JSON.parse(button.value), { id: 'case-buttons', state_version: 11 });
  }
});

test('reply phase without a draft stays a minimal Kakao pointer', () => {
  const message = buildSlackFollowUpCaseMessage({
    id: 'case-no-draft', customer_name: 'Lee', suggested_reply_draft: '',
    recommended_action: 'Issue the invoice before replying.', evidence: ['trade 260804-001'],
    payload: {
      card_kind: 'follow_up_case', owner_channel: 'follow_up', phase: 'customer_reply', state_version: 4,
      latest_customer_message_cluster: 'Please issue the invoice and let me know.',
      ai_judgment: 'Invoice completed; a customer reply is still required.',
      core_facts: ['invoice 260804-001', 'issued today'],
      steps: [{ step_key: 'invoice', action: 'Issue invoice 260804-001', status: 'done' }]
    }
  }, { config: { slackFollowUpChannel: '후속업무', slackInquiryChannel: '카카오톡문의' } });
  const rendered = JSON.stringify(message);

  assert.doesNotMatch(rendered, /Please issue the invoice and let me know/);
  assert.doesNotMatch(rendered, /Invoice completed; a customer reply is still required/);
  assert.doesNotMatch(rendered, /invoice 260804-001|Issue invoice 260804-001/);
  assert.match(rendered, /카톡 채널 관리자에서 확인하세요/);
  assert.match(rendered, /📩 AI 응답 없음/);
  assert.match(rendered, /village_followup_open_kakao_manager/);
  assert.doesNotMatch(rendered, /답변 작성|"text":"수정"/);
  assert.doesNotMatch(rendered, /village_followup_send|village_followup_edit_send/);
});

test('follow-up case keeps late internal work on the original inquiry-channel card', () => {
  const row = {
    id: 'case-late', customer_name: '홍길동',
    payload: {
      card_kind: 'follow_up_case', owner_channel: 'inquiry', phase: 'internal_action', state_version: 2,
      steps: [{ step_key: 'invoice', action_family: 'invoice_issue', action: '세금계산서를 발행하세요.', status: 'pending' }]
    }
  };
  const message = buildSlackFollowUpCaseMessage(row, { config: { slackFollowUpChannel: '후속업무', slackInquiryChannel: '카카오톡문의' } });

  assert.equal(message.channel, '카카오톡문의');
  assert.match(JSON.stringify(message.blocks), /후속업무 발생/);
});

test('reply-only case stays in the inquiry channel and honors configured mentions', () => {
  const row = {
    id: 'case-reply', customer_name: '홍길동', suggested_reply_draft: '확인 후 안내드리겠습니다.',
    payload: { card_kind: 'follow_up_case', owner_channel: 'inquiry', phase: 'customer_reply', state_version: 3, steps: [] }
  };
  const message = buildSlackFollowUpMessage(row, {
    config: { twoChannelRoutingEnabled: true, slackFollowUpChannel: '후속업무', slackInquiryChannel: '카카오톡문의', slackMentionUserIds: ['U123'] }
  });
  const rendered = JSON.stringify(message);

  assert.equal(message.channel, '카카오톡문의');
  assert.doesNotMatch(rendered, /확인 후 안내드리겠습니다|village_followup_send|village_followup_edit_send/);
  assert.match(rendered, /village_followup_reply_not_needed/);
  assert.match(rendered, /village_followup_open_kakao_manager/);
  assert.match(rendered, /<@U123>/);
  assert.match(message.text, /<@U123>/);
});

test('Slack follow-up notification mentions the owner and names the task without staff message replay', () => {
  const message = buildSlackFollowUpMessage({
    id: 'follow-mobile-1',
    type: 'reservation_review',
    priority: 'urgent',
    customer_name: '홍길동',
    title: '홍길동 예약 변경 확인',
    summary: '예약 장비 변경 요청을 확인해야 합니다.',
    recommended_action: '변경 장비의 가용성을 확인하고 고객에게 결과 안내',
    suggested_reply_draft: '변경 가능 여부 확인 후 안내드리겠습니다.',
    payload: {
      visible_messages_used: [
        { sender: '홍길동', message: 'FX3를 다른 기체로 바꿀 수 있을까요?', time: '오전 8:00' },
        { sender: '빌리지님', message: '네네 바꿔드리겠습니다.', time: '오전 8:01' }
      ]
    }
  }, {
    config: { slackMentionUserIds: ['U03EB8L0QDR'] }
  });
  const blocks = JSON.stringify(message.blocks);

  assert.equal(message.text, '<@U03EB8L0QDR> 홍길동 · 예약 · 장비 가용 확인 후 안내');
  assert.match(blocks, /<@U03EB8L0QDR>/);
  assert.ok(message.text.length <= 40);
  assert.equal((blocks.match(/FX3를 다른 기체로 바꿀 수 있을까요\?/g) || []).length, 1);
  assert.doesNotMatch(blocks, /네네 바꿔드리겠습니다/);
  assert.match(blocks, /고객 요청/);
  assert.match(blocks, /내가 할 일/);
});

test('Slack failure card hides internal errors and does not offer a customer send button', () => {
  const message = buildSlackFollowUpMessage({
    id: 'follow-failure-1',
    type: 'reply_needed',
    priority: 'urgent',
    customer_name: '고객명 확인 필요',
    title: '카카오 자동처리 확인 필요',
    summary: 'worker exited 1: Error: Hermes decision failed after 2 attempts at file:///worker.mjs:5800',
    recommended_action: '카카오에서 고객명과 마지막 요청을 확인하고 처리 여부 결정',
    suggested_reply_draft: '감독님, 확인 후 바로 안내드리겠습니다.',
    payload: { failure_kind: 'worker_error' }
  });
  const rendered = JSON.stringify(message);

  assert.doesNotMatch(rendered, /worker exited|Hermes decision|file:\/\/\//);
  assert.doesNotMatch(rendered, /감독님, 확인 후 바로 안내드리겠습니다/);
  assert.doesNotMatch(rendered, /village_followup_send|village_followup_edit_send/);
  assert.match(rendered, /카카오에서 고객명과 마지막 요청을 확인하고 처리 여부 결정/);
});

test('buildSlackFollowUpMessage keeps warning availability cards actionable', () => {
  const message = buildSlackFollowUpMessage({
    id: 'follow-lee',
    type: 'reservation_review',
    priority: 'urgent',
    status: 'open',
    title: '이기욱 INSIDE FILM 예약 가용 확인 결과',
    customer_name: '이기욱 INSIDE FILM',
    summary: '기존 중복 RQ에서 읽은 결과입니다.',
    recommended_action: '확인요청 RQ-260601-010 결과에 경고가 있습니다.',
    suggested_reply_draft: '감독님, 확인 후 바로 안내드리겠습니다.',
    payload: {
      sheet_request: {
        반출일: '2026-06-03',
        반출시간: '05:30',
        반납일: '2026-06-04',
        반납시간: '05:30',
        장비: [{ 이름: 'Fx3 소니 GM 렌즈 세트', 수량: 1 }]
      },
      sheet_availability: {
        reqID: 'RQ-260601-010',
        status: 'warning',
        duplicate: true,
        results: [
          { equipment: 'Fx3 소니 GM 렌즈 세트', quantity: '1', result: '⚠️ 겹침', detail: '일부 구성 확인 필요' },
          { equipment: '솔리드컴 C1 PRO 7구', quantity: '1', result: '✅ 가용1', detail: '대체 가능' }
        ]
      }
    }
  });
  const blocks = JSON.stringify(message.blocks);

  assert.match(blocks, /요청/);
  assert.match(blocks, /RQ-260601-010/);
  assert.match(blocks, /기존 중복/);
  assert.match(blocks, /기존 확인요청에서 읽은 가용확인 결과입니다/);
  assert.match(blocks, /Fx3 소니 GM 렌즈 세트 x1: ⚠️ 겹침/);
  assert.match(blocks, /경고\/부족 항목 확인 후 대안 또는 추가확인 안내/);
  assert.doesNotMatch(blocks, /가용 결과 확인 후 답변/);
  assert.doesNotMatch(blocks, /Agent 호출/);
  assert.doesNotMatch(blocks, /헤이빌리/);
  assert.equal((blocks.match(/RQ-260601-010/g) || []).length, 1);
  assert.doesNotMatch(blocks, /\\n\\n•/);
});

test('enrichFollowUpRowWithOperationalCalculations calculates contract and RQ document amounts', async () => {
  const gvizBody = `/*O_o*/\ngoogle.visualization.Query.setResponse({"version":"0.6","status":"ok","table":{"cols":[{"label":"요청ID"},{"label":"반출일"},{"label":"반출시간"},{"label":"반납일"},{"label":"반납시간"},{"label":"장비or세트명"},{"label":"수량"},{"label":"결과"},{"label":"상세"},{"label":"예약자명"},{"label":"연락처"},{"label":"할인유형"},{"label":"비고"},{"label":"추가요청"}],"rows":[{"c":[{"v":"RQ-260531-007"},{"v":"Date(2026,5,1)","f":"2026. 6. 1"},{"v":"Date(1899,11,30,8,0,0)","f":"8:00"},{"v":"Date(2026,5,3)","f":"2026. 6. 3"},{"v":"Date(1899,11,30,23,59,0)","f":"23:59"},{"v":"V마운트 셋업"},{"v":3,"f":"3"},{"v":"❓ 미등록 장비"},{"v":"장비마스터/세트마스터에 없음"},{"v":"최민석"},{"v":"010-4506-6615"},{"v":"일반"},{"v":"마운드미디어"},{"v":"V마운트 확인"}]},{"c":[{"v":"RQ-260531-007"},null,null,null,null,{"v":"V마운트 배터리"},{"v":10,"f":"10"},{"v":"✅ 가용40"},{"v":"보유56"},null,null,null,null,null]},{"c":[{"v":"RQ-260531-007"},null,null,null,null,{"v":"V마운트 배터리 충전기"},{"v":1,"f":"1"},{"v":"✅ 가용6"},{"v":"보유10"},null,null,null,null,null]}]}});`;
  const config = {
    gasApiUrl: 'https://gas.example/exec',
    sheetApiKey: 'key',
    fetchImpl: async (url) => {
      const u = new URL(String(url));
      if (u.hostname === 'docs.google.com') {
        return { ok: true, status: 200, text: async () => gvizBody };
      }
      const sheet = u.searchParams.get('sheet');
      const query = u.searchParams.get('query');
      if (sheet === '계약마스터' && query === '260530-003') {
        return { ok: true, status: 200, text: async () => JSON.stringify({ results: [{ data: ['260530-003', '최민석', '010-4506-6615', '', '', '', '', '', 3, '예약', '제휴', ''] }] }) };
      }
      if (sheet === '스케줄상세' && query === '260530-003') {
        return { ok: true, status: 200, text: async () => JSON.stringify({ results: [
          { data: ['260530-003-01', '260530-003', '소니 A7S3 바디세트', '소니 A7S3 바디세트', 1, '2026-06-01', '8:00', '2026-06-03', '23:00', '대기', '', 40000, '최민석'] },
          { data: ['260530-003-02', '260530-003', '소니 A7S3 바디세트', '소니 A7S3 바디(케이지)', 1, '2026-06-01', '8:00', '2026-06-03', '23:00', '대기', '', 0, '최민석'] },
          { data: ['260530-003-07', '260530-003', '소니 GM 70-200mm II', '소니 GM 70-200mm II', 1, '2026-06-01', '8:00', '2026-06-03', '23:00', '대기', '', 30000, '최민석'] },
          { data: ['260530-003-08', '260530-003', '셔틀러에이스 M (75볼)', '셔틀러에이스 M (75볼)', 1, '2026-06-01', '8:00', '2026-06-03', '23:00', '대기', '', 10000, '최민석'] }
        ] }) };
      }
      if (sheet === '세트마스터') {
        const price = query === 'V마운트 배터리' || query === 'V마운트 배터리 충전기' ? 5000 : 0;
        return { ok: true, status: 200, text: async () => JSON.stringify({ results: price ? [{ data: [query, '', '', '', '', '', price] }] : [] }) };
      }
      throw new Error(`unexpected URL ${url}`);
    }
  };

  const row = await enrichFollowUpRowWithOperationalCalculations(config, {
    id: 'follow-doc',
    type: 'contract_document',
    title: '최민석 2건 계약서 파일 발송 요청',
    customer_name: '최민석',
    summary: '계약마스터 260530-003 및 확인요청 RQ-260531-007 관련 서류 요청',
    recommended_action: '계약서 파일 2건을 발송하세요.',
    evidence: ['계약마스터 조회: 260530-003', '확인요청 조회: RQ-260531-007']
  });

  assert.match(row.recommended_action, /135,170원/);
  assert.match(row.recommended_action, /145,200원/);
  assert.match(row.recommended_action, /V마운트 셋업 x3/);
  assert.equal(row.payload.operational_calculation.totalVatIncluded, 280370);
});

test('enrichFollowUpRowWithOperationalCalculations does not price expanded components as another parent set', async () => {
  const gvizBody = `/*O_o*/\ngoogle.visualization.Query.setResponse({"version":"0.6","status":"ok","table":{"cols":[{"label":"요청ID"},{"label":"반출일"},{"label":"반출시간"},{"label":"반납일"},{"label":"반납시간"},{"label":"장비or세트명"},{"label":"수량"},{"label":"결과"},{"label":"상세"},{"label":"예약자명"},{"label":"연락처"},{"label":"할인유형"},{"label":"비고"},{"label":"추가요청"}],"rows":[{"c":[{"v":"RQ-260608-003"},{"v":"Date(2026,5,12)","f":"2026. 6. 12"},{"v":"Date(1899,11,30,9,0,0)","f":"9:00"},{"v":"Date(2026,5,12)","f":"2026. 6. 12"},{"v":"Date(1899,11,30,19,0,0)","f":"19:00"},{"v":"메모리*1 / 배터리*2 / 앞캡 / 렌즈 후드"},{"v":1,"f":"1"},{"v":"❓ 미등록 장비"},{"v":"장비마스터/세트마스터에 없음"},{"v":"조아현"},{"v":"010-6559-6771"},{"v":"일반"},null,null]},{"c":[{"v":"RQ-260608-003"},null,null,null,null,{"v":"소니 Z90"},{"v":1,"f":"1"},{"v":"✅ 가용1"},{"v":"세트"},null,null,null,null,null]}]}});`;
  const config = {
    gasApiUrl: 'https://gas.example/exec',
    sheetApiKey: 'key',
    fetchImpl: async (url) => {
      const u = new URL(String(url));
      if (u.hostname === 'docs.google.com') {
        return { ok: true, status: 200, text: async () => gvizBody };
      }
      const sheet = u.searchParams.get('sheet');
      const query = u.searchParams.get('query');
      if (sheet === '세트마스터' && query === '소니 Z90') {
        return { ok: true, status: 200, text: async () => JSON.stringify({ results: [{ data: ['소니 Z90', '메모리*1 / 배터리*2 / 앞캡 / 렌즈 후드', 1, '', '', 'Y', 50000] }] }) };
      }
      if (sheet === '세트마스터' && query === '메모리*1 / 배터리*2 / 앞캡 / 렌즈 후드') {
        return { ok: true, status: 200, text: async () => JSON.stringify({ results: [{ data: ['소니 Z90', '메모리*1 / 배터리*2 / 앞캡 / 렌즈 후드', 1, '', '', 'Y', 50000] }] }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ results: [] }) };
    }
  };

  const row = await enrichFollowUpRowWithOperationalCalculations(config, {
    id: 'follow-z90',
    type: 'tax_invoice',
    title: '조아현 세금계산서 요청',
    customer_name: '조아현',
    summary: '확인요청 RQ-260608-003 관련 서류 요청',
    recommended_action: '금액 확인',
    evidence: ['확인요청 조회: RQ-260608-003']
  });

  assert.match(row.recommended_action, /VAT 포함 55,000원/);
  assert.doesNotMatch(row.recommended_action, /110,000원|110,010원/);
  assert.equal(row.payload.operational_calculation.totalVatIncluded, 55000);
  assert.deepEqual(row.payload.operational_calculation.unresolved, ['메모리*1 / 배터리*2 / 앞캡 / 렌즈 후드 x1']);
});

test('contract calculation exposes every zero-priced standalone item instead of presenting a partial total as complete', async () => {
  const config = {
    gasApiUrl: 'https://gas.example/exec',
    sheetApiKey: 'key',
    fetchImpl: async (url) => {
      const u = new URL(String(url));
      const sheet = u.searchParams.get('sheet');
      const query = u.searchParams.get('query');
      if (sheet === '계약마스터' && query === '260815-001') {
        return { ok: true, status: 200, text: async () => JSON.stringify({ results: [{ data: ['260815-001', '표영현', '', '', '', '', '', '', 1, '예약', '일반', ''] }] }) };
      }
      if (sheet === '스케줄상세' && query === '260815-001') {
        return { ok: true, status: 200, text: async () => JSON.stringify({ results: [
          { data: ['260815-001-01', '260815-001', '소니 GM 100-400mm', '소니 GM 100-400mm', 1, '2026-08-16', '13:00', '2026-08-16', '23:00', '대기', '', 30000, '표영현'] },
          { data: ['260815-001-02', '260815-001', '소니 GM 단렌즈(14)', '소니 GM 단렌즈(14)', 1, '2026-08-16', '13:00', '2026-08-16', '23:00', '대기', '', 0, '표영현'] },
          { data: ['260815-001-03', '260815-001', '사다리', '사다리', 1, '2026-08-16', '13:00', '2026-08-16', '23:00', '대기', '', 0, '표영현'] },
          { data: ['260815-001-04', '260815-001', '소니 GM 단렌즈(50) 별칭', '소니 GM 단렌즈(50)', 1, '2026-08-16', '13:00', '2026-08-16', '23:00', '대기', '', 0, '표영현'] }
        ] }) };
      }
      throw new Error(`unexpected URL ${url}`);
    }
  };

  const row = await enrichFollowUpRowWithOperationalCalculations(config, {
    id: 'follow-incomplete-price',
    type: 'price_review',
    customer_name: '표영현',
    summary: '거래 260815-001 총 금액 확인',
    recommended_action: '금액을 확인하세요.',
    evidence: ['계약마스터 260815-001']
  });

  assert.deepEqual(row.payload.operational_calculation.unresolved, [
    '소니 GM 단렌즈(14) x1',
    '사다리 x1',
    '소니 GM 단렌즈(50) x1'
  ]);
  assert.match(row.recommended_action, /미계산\/확인 필요/);
});

test('resolveSlackChannelId searches Slack channel names and caches the id', async () => {
  let calls = 0;
  const config = {
    slackBotToken: 'xoxb-test',
    slackFetchImpl: async (url, init) => {
      calls += 1;
      assert.match(String(url), /conversations\.list/);
      assert.equal(init.headers.authorization, 'Bearer xoxb-test');
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          ok: true,
          channels: [{ id: 'C123SCHEDULE', name: '스케쥴-agent' }]
        })
      };
    }
  };

  assert.equal(await resolveSlackChannelId('스케쥴-agent', config), 'C123SCHEDULE');
  assert.equal(await resolveSlackChannelId('스케쥴-agent', config), 'C123SCHEDULE');
  assert.equal(calls, 1);
});

test('resolveSlackChannelId resolves the document-send agent channel name', async () => {
  const config = {
    slackBotToken: 'xoxb-test',
    slackFetchImpl: async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        ok: true,
        channels: [{ id: 'C123DOCS', name: '서류발송-agent' }]
      })
    })
  };

  assert.equal(await resolveSlackChannelId('서류발송-agent', config), 'C123DOCS');
});

test('deliverSlackFollowUpRows suppresses Daily audit automation report rows', async () => {
  const requests = [];
  const result = await deliverSlackFollowUpRows({
    slackFollowUpEnabled: true,
    slackBotToken: 'xoxb-test',
    slackFetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true }) };
    },
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return { ok: true, status: 200, text: async () => JSON.stringify([]) };
    }
  }, [{
    id: 'daily-audit-1',
    source: 'daily_audit',
    type: 'ops_issue',
    status: 'open',
    title: 'Daily audit worker timeout/skipped 이력 점검 필요',
    customer_name: '시스템',
    payload: { daily_audit_20260607: true }
  }]);

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'automation_audit_rows');
  assert.equal(requests.length, 0);
});


test('deliverSlackFollowUpRows delivers real DOM watcher task rows even when audit metadata exists', async () => {
  const requests = [];
  const config = {
    slackFollowUpEnabled: true,
    slackBotToken: 'xoxb-test',
    supabaseUrl: 'https://supabase.example',
    serviceRoleKey: 'service-role',
    followUpTable: 'ai_follow_up_items',
    slackFetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).includes('conversations.list')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true, channels: [{ id: 'C123SCHEDULE', name: '스케쥴-agent' }] })
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, channel: 'C123SCHEDULE', ts: '171111.000200', message: { thread_ts: '171111.000200' } })
      };
    },
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        text: async () => init?.method === 'PATCH'
          ? JSON.stringify([{ id: 'follow-real-task', payload: { slack_delivery: { status: 'delivered' } } }])
          : JSON.stringify([{ payload: { daily_audit_20260608: { seen: true } } }])
      };
    }
  };

  const result = await deliverSlackFollowUpRows(config, [{
    id: 'follow-real-task',
    source: 'kakao_dom_bridge',
    type: 'reservation_review',
    status: 'open',
    priority: 'high',
    title: '최승식 예약 변경 확인 필요',
    customer_name: '최승식',
    summary: 'DOM watcher 실시간 고객 태스크',
    payload: { daily_audit_20260608: { discovered_by: 'audit' } }
  }]);

  assert.equal(result.skipped, false);
  assert.equal(result.results[0].ok, true);
  assert.ok(requests.some((r) => r.url.includes('chat.postMessage')));
});


test('deliverSlackFollowUpRows posts new rows once and writes delivery metadata', async () => {
  const requests = [];
  const config = {
    slackFollowUpEnabled: true,
    slackBotToken: 'xoxb-test',
    supabaseUrl: 'https://supabase.example',
    serviceRoleKey: 'service-role',
    followUpTable: 'ai_follow_up_items',
    slackFetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).includes('conversations.list')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true, channels: [{ id: 'C123SCHEDULE', name: '스케쥴-agent' }] })
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, channel: 'C123SCHEDULE', ts: '171111.000100', message: { thread_ts: '171111.000100' } })
      };
    },
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      assert.match(String(url), /ai_follow_up_items\?/);
      assert.match(String(url), /id=eq\.follow-1/);
      return {
        ok: true,
        status: 200,
        text: async () => init?.method === 'PATCH'
          ? JSON.stringify([{ id: 'follow-1', payload: { slack_delivery: { status: 'delivered' } } }])
          : JSON.stringify([{ payload: {} }])
      };
    }
  };

  const result = await deliverSlackFollowUpRows(config, [{
    id: 'follow-1',
    type: 'reservation_review',
    status: 'open',
    priority: 'high',
    title: '예약 확인',
    customer_name: '홍길동',
    summary: '요약'
  }]);

  assert.equal(result.skipped, false);
  assert.equal(result.results[0].ok, true);
  assert.ok(requests.some((r) => r.url.includes('chat.postMessage')));
  const patch = requests.find((r) => {
    if (!r.url.includes('supabase.example') || r.init?.method !== 'PATCH') return false;
    return Boolean(JSON.parse(r.init.body).payload?.slack_delivery?.message_ts);
  });
  assert.equal(JSON.parse(patch.init.body).payload.slack_delivery.message_ts, '171111.000100');
});

function followUpCaseDeliveryHarness({ failUpdate = false } = {}) {
  const requests = [];
  const delivery = { status: 'delivered', channel_id: 'CFOLLOW', message_ts: '200.1' };
  const config = {
    slackFollowUpEnabled: true,
    slackBotToken: 'xoxb-test',
    slackFollowUpChannel: 'CFOLLOW',
    slackInquiryChannel: 'CINQUIRY',
    supabaseUrl: 'https://supabase.example',
    serviceRoleKey: 'service-role',
    followUpTable: 'ai_follow_up_items',
    slackFetchImpl: async (url, init = {}) => {
      requests.push({ url: String(url), init });
      if (failUpdate && String(url).includes('chat.update')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: false, error: 'update_failed' }) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, channel: 'CFOLLOW', ts: '200.1' }) };
    },
    fetchImpl: async (url, init = {}) => {
      requests.push({ url: String(url), init });
      const body = init.body ? JSON.parse(init.body) : null;
      const data = init.method === 'PATCH'
        ? [{ id: 'case-1', payload: body.payload }]
        : [{ payload: { slack_delivery: delivery } }];
      return { ok: true, status: 200, text: async () => JSON.stringify(data) };
    }
  };
  const row = {
    id: 'case-1', status: 'in_progress', customer_name: '?ㅼ쁺중', suggested_reply_draft: '?꾨즺되었습니다.',
    payload: {
      card_kind: 'follow_up_case', owner_channel: 'follow_up', phase: 'customer_reply', steps: [],
      slack_delivery: delivery
    }
  };
  return { requests, config, row };
}

test('follow-up case lifecycle updates the original Slack message without posting a replacement', async () => {
  const { requests, config, row } = followUpCaseDeliveryHarness();
  await deliverSlackFollowUpRows(config, [row]);
  assert.equal(requests.filter((request) => request.url.includes('chat.update')).length, 1);
  assert.equal(requests.some((request) => request.url.includes('chat.postMessage')), false);
});

test('failed chat.update never falls back to chat.postMessage', async () => {
  const { requests, config, row } = followUpCaseDeliveryHarness({ failUpdate: true });
  const result = await deliverSlackFollowUpRows(config, [row]);
  assert.equal(result.results[0].ok, false);
  assert.equal(requests.some((request) => request.url.includes('chat.postMessage')), false);
  const patch = requests.find((request) => request.url.includes('supabase.example') && request.init?.method === 'PATCH');
  const delivery = JSON.parse(patch.init.body).payload.slack_delivery;
  assert.equal(delivery.channel_id, 'CFOLLOW');
  assert.equal(delivery.message_ts, '200.1');
});

test('concurrent initial delivery claims allow only one processor to own chat.postMessage', async () => {
  let persisted = {
    id: 'case-claim',
    payload: { card_kind: 'follow_up_case', state_version: 1 }
  };
  const persist = async ({ delivery }) => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (persisted.payload.slack_delivery?.initial_claim_id) return [];
    persisted = { ...persisted, payload: { ...persisted.payload, slack_delivery: delivery } };
    return [persisted];
  };

  const claims = await Promise.all([
    claimInitialSlackDelivery({ row: persisted, channelId: 'C1', channelName: '후속업무', claimId: 'claim-a', claimedAt: '2026-08-04T00:00:00.000Z', persist }),
    claimInitialSlackDelivery({ row: persisted, channelId: 'C1', channelName: '후속업무', claimId: 'claim-b', claimedAt: '2026-08-04T00:00:00.000Z', persist })
  ]);

  assert.equal(claims.filter((claim) => claim.ok).length, 1);
  assert.equal(claims.filter((claim) => claim.reason === 'initial_delivery_claim_conflict').length, 1);
  assert.match(persisted.payload.slack_delivery.initial_claim_id, /^claim-[ab]$/);
  assert.equal(persisted.payload.slack_delivery.reconciliation_required, true);
});

test('post success followed by metadata failure is recovered by update and never posts twice', async () => {
  const requests = [];
  let failDeliveredMetadataOnce = true;
  let stored = {
    id: 'case-ambiguous', status: 'open', type: 'follow_up_case', customer_name: 'Kim', suggested_reply_draft: 'Reply.',
    payload: {
      card_kind: 'follow_up_case', owner_channel: 'follow_up', phase: 'customer_reply', state_version: 1,
      requires_reply: true, steps: []
    }
  };
  const config = {
    slackFollowUpEnabled: true,
    slackThreadFollowUpsEnabled: false,
    slackBotToken: 'xoxb-test',
    slackFollowUpChannel: 'CFOLLOW',
    slackInquiryChannel: 'CINQUIRY',
    supabaseUrl: 'https://supabase.example',
    serviceRoleKey: 'service-role',
    followUpTable: 'ai_follow_up_items',
    slackFetchImpl: async (url, init = {}) => {
      requests.push({ url: String(url), init });
      if (String(url).includes('chat.postMessage')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, channel: 'CFOLLOW', ts: '300.1' }) };
      }
      if (String(url).includes('chat.update')) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, channel: 'CFOLLOW', ts: '300.1' }) };
      }
      throw new Error(`unexpected Slack request: ${url}`);
    },
    fetchImpl: async (url, init = {}) => {
      requests.push({ url: String(url), init });
      const body = init.body ? JSON.parse(init.body) : null;
      if (init.method === 'PATCH') {
        const nextDelivery = body?.payload?.slack_delivery;
        if (nextDelivery?.status === 'initial_post_claimed' && stored.payload.slack_delivery?.initial_claim_id) {
          return { ok: true, status: 200, text: async () => JSON.stringify([]) };
        }
        if (nextDelivery?.status === 'delivered' && failDeliveredMetadataOnce) {
          failDeliveredMetadataOnce = false;
          return { ok: false, status: 500, text: async () => 'metadata write failed' };
        }
        stored = { ...stored, ...body, payload: { ...stored.payload, ...(body.payload || {}) } };
        return { ok: true, status: 200, text: async () => JSON.stringify([stored]) };
      }
      return { ok: true, status: 200, text: async () => JSON.stringify([{ id: stored.id, payload: stored.payload }]) };
    }
  };

  const first = await deliverSlackFollowUpRows(config, [stored]);
  assert.equal(first.results[0].ok, false);
  assert.equal(requests.filter((request) => request.url.includes('chat.postMessage')).length, 1);
  assert.equal(stored.payload.slack_delivery.reconciliation_required, true);
  assert.equal(stored.payload.slack_delivery.recovery_message_ts, '300.1');

  const second = await deliverSlackFollowUpRows(config, [stored]);
  assert.equal(second.results[0].ok, true);
  assert.equal(requests.filter((request) => request.url.includes('chat.postMessage')).length, 1);
  assert.equal(requests.filter((request) => request.url.includes('chat.update')).length, 1);
  assert.equal(stored.payload.slack_delivery.status, 'delivered');
  assert.equal(stored.payload.slack_delivery.message_ts, '300.1');
});

test('deliverSlackFollowUpRows posts same-conversation follow-ups as thread replies when enabled', async () => {
  const requests = [];
  const config = {
    slackFollowUpEnabled: true,
    slackThreadFollowUpsEnabled: true,
    slackBotToken: 'xoxb-test',
    supabaseUrl: 'https://supabase.example',
    serviceRoleKey: 'service-role',
    followUpTable: 'ai_follow_up_items',
    slackFetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).includes('conversations.list')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true, channels: [{ id: 'C123SCHEDULE', name: '스케쥴-agent' }] })
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, channel: 'C123SCHEDULE', ts: '171111.000300', message: { thread_ts: '171111.000100' } })
      };
    },
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      const href = String(url);
      if (href.includes('select=id%2Croom_key') || href.includes('select=id,room_key')) {
        return { ok: true, status: 200, text: async () => JSON.stringify([{
          id: 'parent-1',
          room_key: 'kakao:park',
          customer_name: '박정우',
          type: 'reservation_review',
          status: 'open',
          payload: { slack_delivery: { status: 'delivered', channel_id: 'C123SCHEDULE', message_ts: '171111.000100', thread_ts: '171111.000100' } }
        }]) };
      }
      return {
        ok: true,
        status: 200,
        text: async () => init?.method === 'PATCH'
          ? JSON.stringify([{ id: 'child-1', payload: { slack_delivery: { status: 'delivered', is_thread_reply: true } } }])
          : JSON.stringify([{ payload: {} }])
      };
    }
  };

  const result = await deliverSlackFollowUpRows(config, [{
    id: 'child-1',
    room_key: 'kakao:park',
    type: 'completed_log',
    status: 'open',
    priority: 'normal',
    title: '박정우 6/10 예약 확정 건 확인요청 입력 필요',
    customer_name: '박정우',
    summary: '확인요청 입력 후속',
    payload: { follow_up_route: 'schedule', follow_up_task_key: 'reservation_2026_06_10' }
  }]);

  assert.equal(result.results[0].ok, true);
  const post = requests.find((r) => r.url.includes('chat.postMessage'));
  const body = JSON.parse(post.init.body);
  assert.equal(body.thread_ts, '171111.000100');
  const patch = requests.find((r) => {
    if (!r.url.includes('supabase.example') || r.init?.method !== 'PATCH') return false;
    return Boolean(JSON.parse(r.init.body).payload?.slack_delivery?.message_ts);
  });
  const payload = JSON.parse(patch.init.body).payload.slack_delivery;
  assert.equal(payload.is_thread_reply, true);
  assert.equal(payload.parent_follow_up_id, 'parent-1');
});

test('urgent equipment incidents are posted at channel level instead of being buried in an old thread', async () => {
  const requests = [];
  const config = {
    slackFollowUpEnabled: true,
    slackThreadFollowUpsEnabled: true,
    slackBotToken: 'xoxb-test',
    supabaseUrl: 'https://supabase.example',
    serviceRoleKey: 'service-role',
    followUpTable: 'ai_follow_up_items',
    slackChannels: { inventory: '재고관리-agent' },
    slackFetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).includes('conversations.list')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ok: true, channels: [{ id: 'CINVENTORY', name: '재고관리-agent' }] })
        };
      }
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, channel: 'CINVENTORY', ts: '171111.000400' })
      };
    },
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      const href = String(url);
      if (href.includes('select=id%2Croom_key') || href.includes('select=id,room_key')) {
        return { ok: true, status: 200, text: async () => JSON.stringify([{
          id: 'older-incident',
          room_key: 'kakao:baek',
          customer_name: '백남준',
          type: 'damage_repair',
          status: 'open',
          payload: { slack_delivery: { status: 'delivered', channel_id: 'CINVENTORY', message_ts: '171111.000100', thread_ts: '171111.000100' } }
        }]) };
      }
      const body = init?.body ? JSON.parse(init.body) : null;
      return {
        ok: true,
        status: 200,
        text: async () => init?.method === 'PATCH'
          ? JSON.stringify([{ id: 'urgent-incident', payload: body?.payload || {} }])
          : JSON.stringify([{ payload: {} }])
      };
    }
  };

  const result = await deliverSlackFollowUpRows(config, [{
    id: 'urgent-incident',
    room_key: 'kakao:baek',
    type: 'damage_repair',
    status: 'open',
    priority: 'urgent',
    title: '백남준 대여 중 렌즈 기스 긴급 확인',
    customer_name: '백남준',
    summary: '2470 렌즈에 기스가 보인다고 고객이 알림',
    recommended_action: '즉시 대화와 장비 상태를 확인하세요.',
    payload: {
      alert_level: 'p0',
      alert_reason: '대여 중 장비 상태에 즉시 사람 판단 필요',
      follow_up_route: 'inventory',
      requires_human_action: true,
      action_family: 'inventory_check'
    }
  }]);

  assert.equal(result.results[0].ok, true);
  const post = requests.find((request) => request.url.includes('chat.postMessage'));
  const body = JSON.parse(post.init.body);
  assert.equal(body.thread_ts, undefined);
  assert.equal(body.reply_broadcast, undefined);
});

function inquiryRefreshHarness(deliveryPatch = {}, cluster = '새 고객 메시지') {
  const requests = [];
  const delivery = {
    status: 'delivered',
    channel_id: 'CINQUIRY',
    message_ts: '171111.000100',
    thread_ts: '171111.000100',
    ...deliveryPatch
  };
  const config = {
    slackFollowUpEnabled: true,
    slackBotToken: 'xoxb-test',
    supabaseUrl: 'https://supabase.example',
    serviceRoleKey: 'service-role',
    followUpTable: 'ai_follow_up_items',
    slackFetchImpl: async (url, init = {}) => {
      requests.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, channel: 'CINQUIRY', ts: '171111.000100' })
      };
    },
    fetchImpl: async (url, init = {}) => {
      requests.push({ url: String(url), init });
      const body = init.body ? JSON.parse(init.body) : null;
      return {
        ok: true,
        status: 200,
        text: async () => init?.method === 'PATCH'
          ? JSON.stringify([{ id: 'inquiry-1', payload: body.payload }])
          : JSON.stringify([{ payload: { slack_delivery: delivery } }])
      };
    }
  };
  const row = {
    id: 'inquiry-1',
    room_key: 'chat:a',
    type: 'customer_inquiry',
    status: 'open',
    priority: 'normal',
    title: '윤영준 카카오톡 문의',
    customer_name: '윤영준',
    summary: cluster,
    suggested_reply_draft: '확인했습니다.',
    payload: {
      card_kind: 'inquiry_case',
      case_id: 'case-1',
      latest_customer_message_cluster: cluster,
      slack_delivery: delivery
    }
  };
  return { requests, config, row };
}

test('legacy delivered inquiry seeds content hashes without a broadcast', async () => {
  const { requests, config, row } = inquiryRefreshHarness();

  const result = await deliverSlackFollowUpRows(config, [row]);

  assert.equal(result.results[0].updatedSlack, true);
  assert.ok(requests.some((r) => r.url.includes('chat.update')));
  assert.equal(requests.some((r) => r.url.includes('chat.postMessage')), false);
  const patch = requests.find((r) => {
    if (!r.url.includes('supabase.example') || r.init?.method !== 'PATCH') return false;
    return Boolean(JSON.parse(r.init.body).payload?.slack_delivery?.message_ts);
  });
  const stored = JSON.parse(patch.init.body).payload.slack_delivery;
  assert.match(stored.last_rendered_content_hash, /^[a-f0-9]{64}$/);
  assert.match(stored.last_broadcast_customer_cluster_hash, /^[a-f0-9]{64}$/);
});

test('reprocessing the same customer cluster does not broadcast', async () => {
  const cluster = '현금영수증 부탁드립니다';
  const { requests, config, row } = inquiryRefreshHarness({
    last_rendered_content_hash: 'old-render',
    last_broadcast_customer_cluster_hash: customerClusterHash(cluster)
  }, cluster);

  await deliverSlackFollowUpRows(config, [row]);

  assert.ok(requests.some((r) => r.url.includes('chat.update')));
  assert.equal(requests.some((r) => r.url.includes('chat.postMessage')), false);
});

test('a new customer cluster updates the inquiry card AND broadcasts a channel-visible bell', async () => {
  const cluster = '이쪽으로 현금영수증 해주시면 감사하겠습니다.';
  const { requests, config, row } = inquiryRefreshHarness({
    last_rendered_content_hash: 'old-render',
    last_broadcast_customer_cluster_hash: customerClusterHash('이전 메시지')
  }, cluster);

  const result = await deliverSlackFollowUpRows(config, [row]);

  assert.equal(requests.filter((request) => request.url.includes('chat.update')).length, 1);
  const bells = requests.filter((request) => request.url.includes('chat.postMessage'));
  assert.equal(bells.length, 1);
  const bellBody = JSON.parse(bells[0].init.body);
  assert.equal(bellBody.reply_broadcast, true);
  assert.ok(String(bellBody.text).includes('갱신'));
  assert.equal(result.results[0].customerUpdateNotified, true);
  const patch = requests.find((request) => request.url.includes('supabase.example') && request.init?.method === 'PATCH');
  const stored = JSON.parse(patch.init.body).payload.slack_delivery;
  assert.match(stored.last_rendered_content_hash, /^[a-f0-9]{64}$/);
  assert.equal(stored.last_broadcast_customer_cluster_hash, customerClusterHash(cluster));
});

test('a newly delivered inquiry stores initial content hashes without an extra broadcast', async () => {
  const requests = [];
  const config = {
    slackFollowUpEnabled: true,
    slackBotToken: 'xoxb-test',
    slackChannels: { other: 'CINQUIRY' },
    supabaseUrl: 'https://supabase.example',
    serviceRoleKey: 'service-role',
    followUpTable: 'ai_follow_up_items',
    slackFetchImpl: async (url, init = {}) => {
      requests.push({ url: String(url), init });
      return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, channel: 'CINQUIRY', ts: '200.1' }) };
    },
    fetchImpl: async (url, init = {}) => {
      requests.push({ url: String(url), init });
      const body = init.body ? JSON.parse(init.body) : null;
      const data = init.method === 'PATCH'
        ? [{ id: 'new-inquiry', payload: body.payload }]
        : [{ payload: {} }];
      return { ok: true, status: 200, text: async () => JSON.stringify(data) };
    }
  };
  const row = {
    id: 'new-inquiry', room_key: 'chat:a', customer_name: '윤영준', type: 'customer_inquiry', status: 'open',
    summary: '첫 문의', payload: { card_kind: 'inquiry_case', latest_customer_message_cluster: '첫 문의' }
  };

  await deliverSlackFollowUpRows(config, [row]);

  assert.equal(requests.filter((request) => request.url.includes('chat.postMessage')).length, 1);
  const patch = requests.find((request) => {
    if (!request.url.includes('supabase.example') || request.init.method !== 'PATCH') return false;
    return Boolean(JSON.parse(request.init.body).payload?.slack_delivery?.last_rendered_content_hash);
  });
  const stored = JSON.parse(patch.init.body).payload.slack_delivery;
  assert.match(stored.last_rendered_content_hash, /^[a-f0-9]{64}$/);
  assert.equal(stored.last_broadcast_customer_cluster_hash, customerClusterHash('첫 문의'));
});


test('upsertFollowUpRows preserves distinct Hermes tasks in the same conversation', async () => {
  const requests = [];
  const existing = {
    id: 'existing-1',
    follow_up_key: 'preview:min:최민석:contract_document:payment_docs',
    room_key: 'preview:min',
    customer_name: '최민석',
    type: 'contract_document',
    status: 'open',
    priority: 'high',
    title: '최민석 계약서 파일 발송 요청',
    summary: '고객이 계약서 파일 발송을 요청했습니다.',
    recommended_action: '계약서를 확인하세요.',
    evidence: ['최신 고객 메시지: 계약서 보내주세요'],
    payload: {
      follow_up_route: 'document',
      follow_up_task_key: 'payment_documents',
      slack_delivery: { status: 'delivered', channel_id: 'C123DOC', message_ts: '171111.000100' }
    }
  };
  const config = {
    supabaseUrl: 'https://supabase.example',
    serviceRoleKey: 'service-role',
    followUpTable: 'ai_follow_up_items',
    fetchImpl: async (url, init = {}) => {
      requests.push({ url: String(url), init });
      if (String(url).includes('status=in.(done,dismissed)')) {
        return { ok: true, status: 200, text: async () => JSON.stringify([]) };
      }
      if (String(url).includes('status=not.in.(done,dismissed)')) {
        return { ok: true, status: 200, text: async () => JSON.stringify([existing]) };
      }
      if (init.method === 'POST') {
        const rows = JSON.parse(init.body);
        return { ok: true, status: 201, text: async () => JSON.stringify(rows.map((row, index) => ({ id: `new-${index}`, ...row }))) };
      }
      throw new Error(`unexpected request ${init.method || 'GET'} ${url}`);
    }
  };

  const result = await upsertFollowUpRows(config, [{
    follow_up_key: 'preview:min:최민석:payment_check:payment_check',
    room_key: 'preview:min',
    customer_name: '최민석',
    type: 'payment_check',
    status: 'open',
    priority: 'high',
    title: '최민석 V마운트 카드결제 확인',
    summary: '고객이 V마운트는 카드결제하겠다고 전달했습니다.',
    recommended_action: '카드결제 상태를 확인하세요.',
    evidence: ['카카오 최신 고객 메시지: 사장님 V마운트는 카드결제할게용'],
    payload: {
      follow_up_route: 'settlement',
      follow_up_task_key: 'v_mount_card_payment',
      latest_customer_message_cluster: '사장님 V마운트는 카드결제할게용'
    }
  }]);

  assert.equal(result.mergedActive, 0);
  assert.equal(result.rows[0].id, 'new-0');
  assert.equal(result.rows[0].type, 'payment_check');
  assert.ok(requests.some((r) => r.init?.method === 'POST'));
  assert.ok(!requests.some((r) => r.init?.method === 'PATCH'));
});

test('upsertFollowUpRows reuses one delivered card when Hermes changes the task key for the same active task', async () => {
  const requests = [];
  const existing = {
    id: 'existing-delivered-card',
    follow_up_key: 'chat:duplicate:customer:schedule_check:first-key',
    room_key: 'chat:duplicate',
    customer_name: '중복고객',
    type: 'schedule_check',
    status: 'open',
    priority: 'normal',
    title: '예약 확인',
    summary: '기존 예약 확인 카드',
    recommended_action: '예약을 확인하세요.',
    evidence: ['기존 증거'],
    payload: {
      follow_up_route: 'schedule',
      follow_up_task_key: 'reservation:customer:20260731',
      slack_delivery: {
        status: 'delivered',
        channel_id: 'C123SCHEDULE',
        message_ts: '171111.000100'
      }
    }
  };
  const config = {
    supabaseUrl: 'https://supabase.example',
    serviceRoleKey: 'service-role',
    followUpTable: 'ai_follow_up_items',
    fetchImpl: async (url, init = {}) => {
      requests.push({ url: String(url), init });
      if (String(url).includes('status=in.(done,dismissed)')) {
        return { ok: true, status: 200, text: async () => JSON.stringify([]) };
      }
      if (String(url).includes('status=not.in.(done,dismissed)')) {
        return { ok: true, status: 200, text: async () => JSON.stringify([existing]) };
      }
      if (init.method === 'PATCH') {
        const patch = JSON.parse(init.body);
        return { ok: true, status: 200, text: async () => JSON.stringify([{ ...existing, ...patch }]) };
      }
      if (init.method === 'POST') {
        return { ok: true, status: 201, text: async () => JSON.stringify([{ id: 'duplicate-card' }]) };
      }
      throw new Error(`unexpected request ${init.method || 'GET'} ${url}`);
    }
  };

  const result = await upsertFollowUpRows(config, [{
    follow_up_key: 'chat:duplicate:customer:schedule_check:second-key',
    room_key: 'chat:duplicate',
    customer_name: '중복고객',
    type: 'schedule_check',
    status: 'open',
    priority: 'urgent',
    title: '예약 재확인',
    summary: '같은 예약을 다시 확인한 결과',
    recommended_action: '최신 결과만 확인하세요.',
    evidence: ['최신 증거'],
    payload: {
      follow_up_route: 'schedule',
      follow_up_task_key: 'schedule-rq-260728-001-review'
    }
  }]);

  assert.equal(result.mergedActive, 1);
  assert.equal(result.rows[0].id, 'existing-delivered-card');
  assert.equal(result.rows[0].payload.slack_delivery.message_ts, '171111.000100');
  assert.ok(requests.some((request) => request.init?.method === 'PATCH'));
  assert.ok(!requests.some((request) => request.init?.method === 'POST'));
});

test('upsertFollowUpRows inserts one card for task-key variants produced in the same batch', async () => {
  const requests = [];
  const config = {
    supabaseUrl: 'https://supabase.example',
    serviceRoleKey: 'service-role',
    followUpTable: 'ai_follow_up_items',
    fetchImpl: async (url, init = {}) => {
      requests.push({ url: String(url), init });
      if (String(url).includes('status=in.(done,dismissed)')) {
        return { ok: true, status: 200, text: async () => JSON.stringify([]) };
      }
      if (String(url).includes('status=not.in.(done,dismissed)')) {
        return { ok: true, status: 200, text: async () => JSON.stringify([]) };
      }
      if (init.method === 'POST') {
        const rows = JSON.parse(init.body);
        return { ok: true, status: 201, text: async () => JSON.stringify(rows.map((row) => ({ id: 'one-card', ...row }))) };
      }
      throw new Error(`unexpected request ${init.method || 'GET'} ${url}`);
    }
  };
  const common = {
    room_key: 'chat:same-batch',
    customer_name: '배치고객',
    type: 'reservation_review',
    status: 'open',
    priority: 'high',
    recommended_action: '예약을 확인하세요.',
    payload: { follow_up_route: 'schedule' }
  };

  const result = await upsertFollowUpRows(config, [{
    ...common,
    follow_up_key: 'same-batch:first',
    title: '예약 구성 확인',
    summary: '첫 번째 표현',
    payload: { ...common.payload, follow_up_task_key: 'reservation:first-key' }
  }, {
    ...common,
    follow_up_key: 'same-batch:second',
    title: '예약 장비 재확인',
    summary: '같은 업무의 두 번째 표현',
    payload: { ...common.payload, follow_up_task_key: 'schedule:second-key' }
  }]);

  const post = requests.find((request) => request.init?.method === 'POST');
  assert.equal(JSON.parse(post.init.body).length, 1);
  assert.equal(result.rows.length, 1);
  assert.equal(result.merged, 1);
});

test('upsertFollowUpRows prefers the already delivered card over a newer undelivered duplicate', async () => {
  const requests = [];
  const common = {
    room_key: 'chat:prefer-delivered',
    customer_name: '전달고객',
    type: 'schedule_check',
    status: 'open',
    priority: 'high',
    payload: { follow_up_route: 'schedule' }
  };
  const undelivered = {
    ...common,
    id: 'newer-undelivered-row',
    updated_at: '2026-07-28T01:00:00.000Z',
    payload: { ...common.payload, follow_up_task_key: 'newer-key' }
  };
  const delivered = {
    ...common,
    id: 'older-delivered-card',
    updated_at: '2026-07-28T00:00:00.000Z',
    payload: {
      ...common.payload,
      follow_up_task_key: 'older-key',
      slack_delivery: {
        status: 'delivered',
        channel_id: 'C123SCHEDULE',
        message_ts: '171111.000200'
      }
    }
  };
  const config = {
    supabaseUrl: 'https://supabase.example',
    serviceRoleKey: 'service-role',
    followUpTable: 'ai_follow_up_items',
    fetchImpl: async (url, init = {}) => {
      requests.push({ url: String(url), init });
      if (String(url).includes('status=in.(done,dismissed)')) {
        return { ok: true, status: 200, text: async () => JSON.stringify([]) };
      }
      if (String(url).includes('status=not.in.(done,dismissed)')) {
        return { ok: true, status: 200, text: async () => JSON.stringify([undelivered, delivered]) };
      }
      if (init.method === 'PATCH') {
        const patch = JSON.parse(init.body);
        const target = String(url).includes('older-delivered-card') ? delivered : undelivered;
        return { ok: true, status: 200, text: async () => JSON.stringify([{ ...target, ...patch }]) };
      }
      throw new Error(`unexpected request ${init.method || 'GET'} ${url}`);
    }
  };

  const result = await upsertFollowUpRows(config, [{
    ...common,
    follow_up_key: 'prefer-delivered:third-key',
    title: '같은 일정 재확인',
    summary: '기존 카드에서 갱신해야 하는 내용',
    recommended_action: '기존 카드만 확인하세요.',
    evidence: ['새 증거'],
    payload: { ...common.payload, follow_up_task_key: 'third-key' }
  }]);

  assert.equal(result.rows[0].id, 'older-delivered-card');
  assert.equal(result.rows[0].payload.slack_delivery.message_ts, '171111.000200');
  assert.ok(requests.some((request) => request.init?.method === 'PATCH' && String(request.url).includes('older-delivered-card')));
});

test('upsertFollowUpRows merges same room when customer name has message or company suffix', async () => {
  const requests = [];
  const existing = {
    id: 'existing-lee',
    follow_up_key: 'preview:lee:이기욱:reservation_review:2026-06-03',
    room_key: 'preview:lee',
    customer_name: '이기욱',
    type: 'reservation_review',
    status: 'open',
    priority: 'high',
    title: '이기욱 예약 확인요청 입력 완료',
    summary: '기존 RQ 입력 완료',
    recommended_action: 'RQ를 확인하세요.',
    evidence: ['기존 메시지'],
    payload: { follow_up_route: 'schedule', follow_up_task_key: 'reservation_2026_06_03' }
  };
  const config = {
    supabaseUrl: 'https://supabase.example',
    serviceRoleKey: 'service-role',
    followUpTable: 'ai_follow_up_items',
    fetchImpl: async (url, init = {}) => {
      requests.push({ url: String(url), init });
      if (String(url).includes('status=in.(done,dismissed)')) {
        return { ok: true, status: 200, text: async () => JSON.stringify([]) };
      }
      if (String(url).includes('status=not.in.(done,dismissed)')) {
        return { ok: true, status: 200, text: async () => JSON.stringify([existing]) };
      }
      if (init.method === 'PATCH') {
        const patch = JSON.parse(init.body);
        return { ok: true, status: 200, text: async () => JSON.stringify([{ ...existing, ...patch }]) };
      }
      throw new Error(`unexpected request ${init.method || 'GET'} ${url}`);
    }
  };

  const result = await upsertFollowUpRows(config, [{
    follow_up_key: 'preview:lee:이기욱 inside film:reservation_review:2026-06-03',
    room_key: 'preview:lee',
    customer_name: '이기욱 INSIDE FILM 넵 그럴게 부탁드리겠습니다 !',
    type: 'reservation_review',
    status: 'open',
    priority: 'high',
    title: '이기욱 INSIDE FILM 예약 가용 확인 결과',
    summary: '고객이 6/3~6/4 장비 예약 진행을 요청했습니다.',
    recommended_action: '기존 RQ와 대조하세요.',
    evidence: ['최신 고객 메시지: 넵 그럴게 부탁드리겠습니다 !'],
    payload: { follow_up_route: 'schedule', follow_up_task_key: 'reservation_2026_06_03' }
  }]);

  assert.equal(result.mergedActive, 1);
  assert.equal(result.rows[0].id, 'existing-lee');
  assert.match(result.rows[0].summary, /6\/3~6\/4/);
  assert.ok(!requests.some((r) => r.init?.method === 'POST'));
});

test('filterFollowUpRowsAfterAutoReply suppresses reply card after successful auto-send', () => {
  const rows = [
    { type: 'reply_needed', title: '위치 문의 답변' },
    { type: 'price_review', title: '가격 확인' }
  ];

  assert.deepEqual(filterFollowUpRowsAfterAutoReply(rows, { sent: true }), [
    { type: 'price_review', title: '가격 확인' }
  ]);
  assert.equal(filterFollowUpRowsAfterAutoReply(rows, { sent: false }).length, 2);
});

test('buildFollowUpRows keeps local DOM job ids out of UUID job_id column', () => {
  const rows = buildFollowUpRows({
    classification: 'faq',
    confidence: 'high',
    customer: { name: '한이솔' },
    follow_up_items: [{
      type: 'contract_document',
      route: 'document',
      taskKey: 'payment_documents_370000',
      title: '거래명세서 발급 요청',
      summary: '고객이 거래명세서 금액을 알려줌'
    }]
  }, { jobId: 'dom-072d40c56a4cabdf', roomKey: 'preview:21d6b164a492d90e' });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].job_id, null);
  assert.match(rows[0].follow_up_key, /^preview:21d6b164a492d90e:한이솔:contract_document:/);
});

test('buildFollowUpRows preserves Hermes follow-ups even when conversation discovery failed', () => {
  const rows = buildFollowUpRows({
    classification: 'unclear',
    confidence: 'high',
    reason: 'matching Kakao conversation not visible within budget',
    safety_checks: {
      kakao_conversation_opened: false
    },
    customer: { name: 'hellodesk' },
    follow_up_items: [{
      type: 'reply_needed',
      route: 'other',
      taskKey: 'manual_chat_discovery',
      priority: 'high',
      status: 'open',
      title: 'Kakao 대화방 수동 확인 필요',
      customer_name: 'hellodesk',
      summary: '작업 증거의 navigation hint는 hellodesk였으나 Kakao Channel Manager 현재 채팅 목록/검색에서 해당 대화방을 확인하지 못했습니다.',
      recommended_action: '카카오 채널 관리자에서 hellodesk 대화방을 수동으로 찾으세요.',
      blocking_reason: 'matching Kakao conversation not visible within budget'
    }]
  }, { jobId: 'dom-no-match', roomKey: 'preview:03e2dc74d0122490' });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].payload.follow_up_task_key, 'manual_chat_discovery');
});

test('staff-latest turns keep only P0 follow-up rows and never leak inquiry cards', () => {
  const staffLatest = {
    classification: 'reservation',
    confidence: 'high',
    customer: { name: '한결' },
    safety_checks: { kakao_conversation_opened: true, latest_customer_message_after_last_staff_reply: false },
    follow_up_items: [
      { type: 'reply_needed', route: 'other', taskKey: 'ack', title: '확인 답장', summary: '사장이 이미 답한 건' },
      { type: 'incident', route: 'schedule', taskKey: 'damage', title: '장비 파손 즉시 확인', summary: '파손 신고', alert_level: 'p0', alert_reason: '대여 중 파손' }
    ]
  };
  const rows = buildFollowUpRows(staffLatest, { roomKey: 'chat:staff-latest' });
  assert.equal(rows.length, 1, 'P0 항목은 사장이 마지막으로 말한 대화에서도 살아남아야 한다');
  assert.equal(rows[0].title, '장비 파손 즉시 확인');
  assert.equal(buildCanonicalFollowUpCases(staffLatest, { room_key: 'chat:staff-latest' }, []).length, 0);

  // 대화를 열고도 판정 필드를 빼먹은 결정은 fail-closed로 잠근다.
  const omitted = { ...staffLatest, safety_checks: { kakao_conversation_opened: true } };
  assert.equal(buildCanonicalFollowUpCases(omitted, { room_key: 'chat:omitted' }, []).length, 0);
  const verdict = validateAiDecisionContract(omitted);
  assert.equal(verdict.valid, false);
  assert.match(verdict.errors.join('|'), /latest_customer_message_after_last_staff_reply/);
});

test('buildFollowUpRows uses a stable semantic key for same customer task across repeated jobs', () => {
  const first = buildFollowUpRows({
    classification: 'faq',
    confidence: 'high',
    customer: { name: '정시온' },
    follow_up_items: [{
      type: 'contract_document',
      route: 'document',
      taskKey: 'payment_documents_370000',
      priority: 'high',
      title: '정시온 고객 37만원 결제 서류 준비',
      summary: '고객이 오늘 37만원 결제 관련 서류 수령 가능 여부를 문의했습니다.',
      recommended_action: '부가세 포함 37만원 기준으로 필요한 결제/계약/정산 서류를 준비해 전달하세요.',
      evidence: ['37만원 결제 관련 서류 문의']
    }]
  }, { jobId: 'dom-first', roomKey: 'preview:jung-si-on' });
  const second = buildFollowUpRows({
    classification: 'faq',
    confidence: 'high',
    customer: { name: '정시온' },
    follow_up_items: [{
      type: 'contract_document',
      route: 'document',
      taskKey: 'payment_documents_370000',
      priority: 'high',
      title: '정시온 37만원 결제 서류 전달 요청',
      summary: '고객이 전화로 안내받았던 37만원 결제 관련 서류를 요청했습니다. 이전 대화상 계약서 PDF 맥락이 있습니다.',
      recommended_action: '기존 260502-004 정시온 계약/견적/결제 내역을 확인한 뒤 고객에게 필요한 결제 서류 또는 정산서를 전달하세요.',
      evidence: ['37만원 결제 관련 서류 요청']
    }]
  }, { jobId: 'dom-second', roomKey: 'preview:jung-si-on' });

  assert.equal(first[0].follow_up_key, second[0].follow_up_key);
  assert.match(first[0].follow_up_key, /^preview:jung-si-on:정시온:contract_document:/);
});

test('buildFollowUpRows uses the AI taskKey for repeated FAQ follow-ups without amounts or dates', () => {
  const first = buildFollowUpRows({
    classification: 'price',
    confidence: 'high',
    customer: { name: '최재형' },
    follow_up_items: [{
      type: 'price_review',
      route: 'other',
      taskKey: 'student_discount_policy',
      title: '학생 할인율 문의 답변 검토',
      summary: '고객이 학생 할인율이 몇 퍼센트인지 문의했습니다.'
    }]
  }, { jobId: 'dom-first', roomKey: 'preview:choi' });
  const second = buildFollowUpRows({
    classification: 'price',
    confidence: 'high',
    customer: { name: '최재형' },
    follow_up_items: [{
      type: 'price_review',
      route: 'other',
      taskKey: 'student_discount_policy',
      title: '최재형님 학생할인 비율 문의 확인',
      summary: '고객이 학생할인이 몇 프로인지 문의했습니다.'
    }]
  }, { jobId: 'dom-second', roomKey: 'preview:choi' });

  assert.equal(first[0].follow_up_key, second[0].follow_up_key);
  assert.match(first[0].follow_up_key, /discount_policy/);
});

test('filterFollowUpRowsAgainstClosedHistory suppresses already dismissed topic tasks', () => {
  const rows = buildFollowUpRows({
    classification: 'price',
    confidence: 'high',
    customer: { name: '최재형' },
    follow_up_items: [
      {
        type: 'price_review',
        route: 'other',
        taskKey: 'student_discount_policy',
        title: '최재형님 학생 할인율 문의 답변 확인',
        summary: '고객이 위치 안내를 받은 뒤 학생 할인율이 몇 프로인지 문의했습니다.'
      },
      {
        type: 'reply_needed',
        route: 'other',
        taskKey: 'student_discount_policy',
        title: '최재형 고객 할인 문의 답장 필요',
        summary: '최신 고객 메시지가 직원 답변 이후 발생한 할인 문의입니다.'
      }
    ]
  }, { jobId: 'dom-second', roomKey: 'preview:choi' });
  const history = [{
    customer_name: '최재형',
    type: 'reply_needed',
    payload: { follow_up_route: 'other', follow_up_task_key: 'student_discount_policy' },
    status: 'dismissed',
    title: '학생 할인 문의 답장 필요',
    summary: '직원 답변 이후 고객이 새 할인 문의를 남겼습니다.'
  }];

  assert.equal(rows.length, 2);
  assert.deepEqual(filterFollowUpRowsAgainstClosedHistory(rows, history), []);
});

test('mergeFollowUpRowsByTopic preserves distinct AI-declared operational tasks', () => {
  const rows = buildFollowUpRows({
    classification: 'reservation',
    confidence: 'medium',
    customer: { name: '박재인' },
    follow_up_items: [
      {
        type: 'reply_needed',
        route: 'other',
        taskKey: 'return_ack',
        title: '반납 및 다음 회차 메모 확인 답장',
        summary: '고객의 반납 완료 및 다음 회차 일정 공유에 대해 짧은 확인 답장이 유용합니다.',
        recommended_action: '확인 답장을 보내세요.',
        suggested_reply_draft: '확인했습니다. 체크해두겠습니다.'
      },
      {
        type: 'damage_repair',
        route: 'inventory',
        taskKey: 'sony_battery_warning',
        title: '경고 메시지 뜬 소니 배터리 확인 필요',
        summary: '고객이 애플박스 위에 둔 소니 배터리가 경고 메시지 발생 배터리라고 설명했습니다.',
        recommended_action: '배터리 상태를 확인하세요.'
      },
      {
        type: 'schedule_check',
        route: 'schedule',
        taskKey: 'next_rental_2026_06_01',
        title: '다음 회차 6/1-6/2 및 5/31 밤 픽업 메모 확인',
        summary: '고객이 다음 회차 일정과 픽업 예정 시간을 전달했습니다.',
        recommended_action: '다음 회차 일정을 확인하세요.'
      }
    ]
  }, { jobId: 'dom-park', roomKey: 'preview:park' });

  const merged = mergeFollowUpRowsByTopic(rows);
  assert.equal(rows.length, 3);
  assert.equal(merged.length, 3);
});

test('buildFollowUpRows keeps one stable key for one reservation split by secondary topics', () => {
  const discount = buildFollowUpRows({
    classification: 'reservation',
    confidence: 'medium',
    customer: { name: '홍지수' },
    follow_up_items: [{
      type: 'reservation_review',
      route: 'schedule',
      taskKey: 'reservation_2026_06_06_burano_movi',
      priority: 'high',
      title: '홍지수님 6/6-6/7 브라노 풀세트 및 모비 문의 확인',
      summary: '고객이 6월 6-7일 브라노 풀세트 대여 가능 여부, 비학생 학생가 가능 여부, 모비 보유 여부를 문의함.',
      recommended_action: '기존 확인요청 건을 기준으로 재고 확인 및 가격 검토를 진행하세요.'
    }]
  }, { jobId: 'dom-hong-a', roomKey: 'preview:hong' });
  const operations = buildFollowUpRows({
    classification: 'reservation',
    confidence: 'medium',
    customer: { name: '홍지수' },
    follow_up_items: [{
      type: 'reservation_review',
      route: 'schedule',
      taskKey: 'reservation_2026_06_06_burano_movi',
      priority: 'high',
      title: '홍지수님 6/6-6/7 브라노 풀세트 + 모비 대여 가능 여부 및 학생가 문의',
      summary: '고객이 2026년 6월 6-7일 브라노 풀세트 대여 가능 여부와 비학생 학생가 적용 가능 여부를 문의했습니다.',
      recommended_action: '반출/반납 시간과 연락처를 요청하고 모비 보유 여부를 직원 확인 후 안내하세요.'
    }]
  }, { jobId: 'dom-hong-b', roomKey: 'preview:hong' });

  assert.equal(discount[0].follow_up_key, operations[0].follow_up_key);
  assert.match(discount[0].follow_up_key, /reservation_review/);
});

test('buildFollowUpTopicKey merges only when Hermes gives both cards the same route and taskKey', () => {
  const rows = buildFollowUpRows({
    classification: 'faq',
    confidence: 'medium',
    customer: { name: '이유찬' },
    follow_up_items: [
      {
        type: 'schedule_check',
        route: 'schedule',
        taskKey: 'intercom_availability',
        title: '인터컴 대여 가능 여부 배터리 상태 확인',
        summary: '고객이 인터콤 대여 가능 여부를 문의했고, 직원이 복귀 후 배터리 상태 확인이 필요하다고 답변한 상태입니다.'
      },
      {
        type: 'reply_needed',
        route: 'schedule',
        taskKey: 'intercom_availability',
        title: '인터콤 대여 가능 여부 문의 답변',
        summary: '고객이 인터콤도 대여 가능한지 문의했습니다.'
      }
    ]
  }, { jobId: 'dom-lee', roomKey: 'preview:lee' });

  const merged = mergeFollowUpRowsByTopic(rows);
  assert.notEqual(rows[0].follow_up_key, rows[1].follow_up_key);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].type, 'schedule_check');
});

test('mergeFollowUpRowsByTopic normalizes customer aliases with issue suffixes', () => {
  const rows = [
    {
      follow_up_key: 'a',
      customer_name: '한시우',
      type: 'damage_repair',
      payload: { follow_up_route: 'inventory', follow_up_task_key: 'missing_damaged_60x' },
      priority: 'normal',
      title: '한시우 미반납/파손 관련 반납 예정 확인',
      summary: '고객이 미반납 물품을 확인 후 가져다 드리겠다고 답변함.'
    },
    {
      follow_up_key: 'b',
      customer_name: '한시우/60x 파손',
      type: 'damage_repair',
      payload: { follow_up_route: 'inventory', follow_up_task_key: 'missing_damaged_60x' },
      priority: 'normal',
      title: '한시우 미반납/파손 관련 반납 확인 필요',
      summary: '고객이 미반납/확인 대상 물품을 확인 후 가져다 드리겠다고 답변함.'
    }
  ];

  assert.equal(mergeFollowUpRowsByTopic(rows).length, 1);
});

test('closeKakaoConversationWindow targets only the opened Kakao customer popup', { skip: process.platform !== 'darwin' }, async () => {
  const script = buildCloseKakaoConversationWindowAppleScript();
  assert.match(script, /close window w/);
  assert.match(script, / - 빌리지 - 카카오비즈니스/);

  let command;
  let args;
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const spawnImpl = (cmd, nextArgs) => {
    command = cmd;
    args = nextArgs;
    return child;
  };

  const resultPromise = closeKakaoConversationWindow({ title: '정시온 - 빌리지 - 카카오비즈니스 파트너센터' }, { spawnImpl, timeoutMs: 1000 });
  child.stdout.write('closed_conversation_window\n');
  child.emit('close', 0);

  assert.deepEqual(await resultPromise, { status: 'closed_conversation_window' });
  assert.equal(command, 'osascript');
  assert.equal(args[0], '-e');
  assert.equal(args[2], '정시온 - 빌리지 - 카카오비즈니스 파트너센터');
  assert.equal(args[3], '정시온');
});

test('closeKakaoConversationWindow closes only the supplied Windows customer popup through CUA', async () => {
  const calls = [];
  const spawnImpl = (cmd, args) => {
    calls.push({ cmd, args });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      child.stdout.write(JSON.stringify({ ok: true }));
      child.emit('close', 0);
    });
    return child;
  };

  const result = await closeKakaoConversationWindow({
    pid: 8123,
    window_id: 4567,
    title: '정시온 - 빌리지 - 카카오비즈니스 파트너센터'
  }, { platform: 'win32', cuaDriverCommand: 'cua-driver', spawnImpl, timeoutMs: 1000 });

  assert.deepEqual(result, { status: 'closed_conversation_window' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'cua-driver');
  assert.equal(calls[0].args[0], 'call');
  assert.equal(calls[0].args[1], 'press_key');
  assert.deepEqual(JSON.parse(calls[0].args[2]), {
    pid: 8123,
    window_id: 4567,
    key: 'f4',
    modifiers: ['alt']
  });
});

test('closeKakaoConversationTargetViaDevtools closes only the target id', async () => {
  let requestedUrl = '';
  const result = await closeKakaoConversationTargetViaDevtools({ id: 'target-1' }, {
    cdpBaseUrl: 'http://127.0.0.1:9223',
    fetchImpl: async (url) => {
      requestedUrl = String(url);
      return { ok: true, status: 200, text: async () => 'Target is closing' };
    }
  });

  assert.equal(result.status, 'closed_conversation_target');
  assert.match(requestedUrl, /\/json\/close\/target-1$/);
});

test('canAutoSendCustomerAnswer only allows high-confidence AI-approved safe replies', () => {
  const baseDecision = {
    confidence: 'high',
    kill_switch_observed: 'active',
    suggested_reply_draft: '네, 확인 후 안내드리겠습니다.',
    reply_decision: {
      replyMode: 'auto_send',
      confidence: 'high',
      text: '네, 확인 후 안내드리겠습니다.',
      safetyClass: 'simple_ack',
      grounding: 'visible_conversation',
      requiresRag: false
    },
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      latest_customer_message_after_last_staff_reply: true
    }
  };

  assert.equal(canAutoSendCustomerAnswer(baseDecision, { autoSendEnabled: false }).allowed, false);
  assert.deepEqual(canAutoSendCustomerAnswer(baseDecision, { autoSendEnabled: true }), {
    allowed: true,
    reason: 'simple_ack',
    text: '네, 확인 후 안내드리겠습니다.',
    replyMode: 'auto_send',
    confidence: 'high',
    safetyClass: 'simple_ack',
    grounding: 'visible_conversation'
  });
  const authoritativeAvailability = {
    ...completePostActionDecision(),
    post_action_reconciled: true,
    authoritative_sheet_result: { status: 'available', reqID: 'RQ-260724-001' }
  };
  for (const status of ['available', 'warning', 'unavailable', 'unknown']) {
    const forcedAutoSend = {
      ...authoritativeAvailability,
      owner_review_required: false,
      authoritative_sheet_result: { status, reqID: 'RQ-260724-001' },
      reply_decision: {
        ...authoritativeAvailability.reply_decision,
        replyMode: 'auto_send',
        safetyClass: status === 'unknown' ? 'simple_ack' : 'authoritative_availability_answer'
      }
    };
    assert.deepEqual(canAutoSendCustomerAnswer(forcedAutoSend, { autoSendEnabled: true }), {
      allowed: false,
      reason: 'schedule_result_requires_owner_review'
    });
  }
  assert.equal(canAutoSendCustomerAnswer({ ...baseDecision, reply_decision: { ...baseDecision.reply_decision, replyMode: 'draft_only' } }, { autoSendEnabled: true }).allowed, false);
  assert.equal(canAutoSendCustomerAnswer({ ...baseDecision, confidence: 'medium', reply_decision: { ...baseDecision.reply_decision, confidence: 'medium' } }, { autoSendEnabled: true }).allowed, false);
  assert.equal(canAutoSendCustomerAnswer({ ...baseDecision, suggested_reply_draft: '예약 확정됐습니다', reply_decision: { ...baseDecision.reply_decision, text: '예약 확정됐습니다' } }, { autoSendEnabled: true }).allowed, false);
  assert.equal(canAutoSendCustomerAnswer({ ...baseDecision, classification: 'price' }, { autoSendEnabled: true }).allowed, true);
  assert.equal(canAutoSendCustomerAnswer({ ...baseDecision, classification: 'reservation_review' }, { autoSendEnabled: true }).allowed, true);
  assert.equal(canAutoSendCustomerAnswer({ ...baseDecision, classification: 'reservation' }, { autoSendEnabled: true }).allowed, true);
  assert.equal(canAutoSendCustomerAnswer({
    ...baseDecision,
    classification: 'reservation',
    reply_decision: {
      ...baseDecision.reply_decision,
      text: '재학증명서 확인했습니다! 6월 2일 19시 30분에 방문해 주시면 됩니다. 감사합니다.'
    }
  }, { autoSendEnabled: true }).allowed, true);
  assert.equal(canAutoSendCustomerAnswer({ ...baseDecision, owner_review_required: true }, { autoSendEnabled: true }).allowed, false);
  assert.equal(canAutoSendCustomerAnswer({ ...baseDecision, reply_decision: { ...baseDecision.reply_decision, text: '네 대여 가능합니다.' } }, { autoSendEnabled: true }).allowed, false);
  assert.equal(canAutoSendCustomerAnswer({ ...baseDecision, classification: 'reservation', reply_decision: { ...baseDecision.reply_decision, text: '네 예약 가능합니다.' } }, { autoSendEnabled: true }).allowed, false);
  assert.deepEqual(canAutoSendCustomerAnswer({
    ...baseDecision,
    classification: 'reservation',
    latest_customer_message_cluster: '그럼 이렇게 부탁드립니다',
    latest_staff_message: '네 감독님, 해당 구성 예약 가능합니다.',
    visible_messages_used: [
      { sender: '빌리지님', message: '네 감독님, 해당 구성 예약 가능합니다.', time: '오후 1:00' },
      { sender: '김채현', message: '그럼 이렇게 부탁드립니다', time: '오후 1:01' }
    ],
    reply_decision: {
      ...baseDecision.reply_decision,
      text: '네 감독님, 말씀 주신 구성으로 예약 확정해드렸습니다.',
      safetyClass: 'staff_confirmed_reservation_acceptance',
      grounding: 'staff_confirmation'
    }
  }, { autoSendEnabled: true }), {
    allowed: true,
    reason: 'staff_confirmed_reservation_acceptance',
    text: '네 감독님, 말씀 주신 구성으로 예약 확정해드렸습니다.',
    replyMode: 'auto_send',
    confidence: 'high',
    safetyClass: 'staff_confirmed_reservation_acceptance',
    grounding: 'staff_confirmation'
  });
  assert.equal(canAutoSendCustomerAnswer({ ...baseDecision, classification: 'faq', kill_switch_observed: 'price_paused' }, { autoSendEnabled: true }).allowed, true);
  assert.equal(canAutoSendCustomerAnswer({ ...baseDecision, classification: 'price', kill_switch_observed: 'price_paused' }, { autoSendEnabled: true }).reason, 'kill_switch_price_paused');
});

test('screenshot-like schedule warning is owner-only while an ordinary FAQ remains auto-sendable', () => {
  const scheduleWarning = {
    ...completePostActionDecision(),
    post_action_reconciled: true,
    authoritative_sheet_result: {
      status: 'warning',
      reqID: 'RQ-260820-009',
      results: [{ result: '⚠️ 겹침(가용0)', detail: '백상원 반납8/22 11:40(40분겹침)' }]
    },
    owner_review_required: false,
    reply_decision: {
      ...completePostActionDecision().reply_decision,
      replyMode: 'auto_send',
      safetyClass: 'authoritative_availability_answer',
      text: '8/22 11:00~23:00 기준으로 다시 확인했습니다. 일부 구성은 일정이 겹칩니다.'
    }
  };
  assert.deepEqual(canAutoSendCustomerAnswer(scheduleWarning, { autoSendEnabled: true }), {
    allowed: false,
    reason: 'schedule_result_requires_owner_review'
  });

  const ordinaryFaq = {
    classification: 'faq',
    confidence: 'high',
    kill_switch_observed: 'active',
    reply_decision: {
      replyMode: 'auto_send',
      confidence: 'high',
      text: '네, 신분증은 방문하실 때 지참해주시면 됩니다.',
      safetyClass: 'simple_ack',
      grounding: 'visible_conversation',
      requiresRag: false
    },
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      latest_customer_message_after_last_staff_reply: true
    }
  };
  assert.equal(canAutoSendCustomerAnswer(ordinaryFaq, { autoSendEnabled: true }).allowed, true);
});

function equipmentIncidentDecision(overrides = {}) {
  return {
    confidence: 'high',
    kill_switch_observed: 'active',
    classification: 'already_answered',
    customer: { name: '백남준' },
    latest_customer_message_cluster: '2470렌즈가 살짝 기스가 있는 것 같은데 교체가 어렵다면 그냥 쓰겠습니다.',
    visible_messages_used: [
      { sender: '백남준', message: '2470렌즈가 살짝 기스가 있는 것 같은데 지금 변경은 어렵겠죠?', time: '오후 11:31' },
      { sender: '백남준', message: '기다리기 어려워서 그냥 이거 사용할게요.', time: '오전 12:01' }
    ],
    follow_up_items: [{
      type: 'completed_log',
      route: 'inventory',
      taskKey: 'lens_condition_2470',
      requiresHumanAction: false,
      actionFamily: 'none',
      businessKey: '',
      priority: 'normal',
      status: 'done',
      title: '백남준 2470 렌즈 상태 안내',
      customer_name: '백남준',
      summary: '고객이 현재 장비를 그대로 사용',
      recommended_action: '',
      evidence: ['고객이 렌즈 기스 사진을 보냄'],
      alertLevel: 'p0',
      alertReason: '대여 중 장비 이상은 즉시 사람 판단이 필요함'
    }],
    reply_decision: {
      replyMode: 'auto_send',
      confidence: 'high',
      text: '2470은 지금 상태 그대로 가져가시면 됩니다.',
      safetyClass: 'simple_ack',
      grounding: 'visible_conversation',
      requiresRag: false
    },
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      latest_customer_message_after_last_staff_reply: true
    },
    ...overrides
  };
}

test('equipment incident context cannot be auto-sent as a payment acknowledgement', () => {
  const decision = equipmentIncidentDecision({
    classification: 'price',
    follow_up_items: [{
      type: 'damage_repair',
      route: 'inventory',
      taskKey: 'lens_condition_2470',
      requiresHumanAction: true,
      actionFamily: 'inventory_check',
      businessKey: 'equipment:2470',
      priority: 'urgent',
      status: 'open',
      title: '백남준 2470 렌즈 기스 확인',
      summary: '고객이 렌즈 기스 사진을 보냄',
      recommended_action: '즉시 상태 확인',
      alertLevel: 'p0',
      alertReason: '대여 중 장비 상태에 즉시 사람 판단 필요'
    }],
    reply_decision: {
      replyMode: 'auto_send',
      confidence: 'high',
      text: '결제하시고 오시는 길 확인했습니다. 2470 기스 사진도 봤어요. 여분이 있으면 교체해 드릴게요.',
      safetyClass: 'payment_receipt_ack',
      grounding: 'visible_conversation',
      requiresRag: false
    }
  });

  assert.deepEqual(canAutoSendCustomerAnswer(decision, { autoSendEnabled: true }), {
    allowed: false,
    reason: 'customer_equipment_incident_requires_human'
  });
});

test('equipment incident context cannot be auto-sent as a simple acknowledgement authorizing continued use', () => {
  assert.deepEqual(canAutoSendCustomerAnswer(equipmentIncidentDecision(), { autoSendEnabled: true }), {
    allowed: false,
    reason: 'customer_equipment_incident_requires_human'
  });
});

test('an explicit AI p0 decision reopens its own follow-up for urgent human review', () => {
  const rows = buildFollowUpRows(equipmentIncidentDecision(), {
    id: 'dom-baek-incident',
    room_key: 'kakao:baek',
    customer_name: '백남준'
  });
  const alert = rows.find((row) => row.payload?.alert_level === 'p0');

  assert.ok(alert);
  assert.equal(alert.type, 'completed_log');
  assert.equal(alert.priority, 'urgent');
  assert.equal(alert.status, 'open');
  assert.equal(alert.payload.requires_human_action, true);
});

test('urgent equipment incident Slack cards notify the whole channel and configured owner', () => {
  const message = buildSlackFollowUpMessage({
    id: 'urgent-alert-card',
    type: 'damage_repair',
    priority: 'urgent',
    status: 'open',
    customer_name: '백남준',
    title: '백남준 대여 중 렌즈 기스 긴급 확인',
    summary: '2470 렌즈 기스 사진 접수',
    recommended_action: '즉시 대화와 장비 상태를 확인하세요.',
    payload: {
      alert_level: 'p0',
      alert_reason: '대여 중 장비 이상',
      follow_up_route: 'inventory',
      requires_human_action: true,
      action_family: 'inventory_check'
    }
  }, {
    config: {
      slackMentionUserIds: ['UOWNER'],
      slackChannels: { inventory: '재고관리-agent' }
    }
  });

  assert.match(message.text, /<!channel>/);
  assert.match(message.text, /<@UOWNER>/);
});

test('only the AI explicit p0 field triggers escalation; urgent words and damage type do not', () => {
  const ordinary = {
    type: 'damage_repair',
    priority: 'urgent',
    title: '파손 긴급 확인',
    payload: { alert_level: 'none', incident_safety_alert: true }
  };
  assert.equal(isP0FollowUp(ordinary), false);
  assert.doesNotMatch(buildSlackFollowUpMessage(ordinary, { config: {} }).text, /<!channel>/);

  const explicit = {
    ...ordinary,
    payload: { alert_level: 'p0', alert_reason: 'AI가 즉시 기상 알림이 필요하다고 판단' }
  };
  assert.equal(isP0FollowUp(explicit), true);
  assert.match(buildSlackFollowUpMessage(explicit, { config: {} }).text, /<!channel>/);
});

test('follow-up topic merging cannot erase an AI explicit p0 alert', () => {
  const base = {
    customer_name: '백남준',
    room_key: 'kakao:baek',
    type: 'damage_repair',
    priority: 'urgent',
    status: 'open',
    title: '장비 상태 확인',
    summary: '같은 장비 상태 건',
    recommended_action: '확인',
    evidence: [],
    payload: { follow_up_route: 'inventory', follow_up_task_key: 'lens-2470', alert_level: 'none' }
  };
  const merged = mergeFollowUpRowsByTopic([
    base,
    {
      ...base,
      payload: {
        ...base.payload,
        alert_level: 'p0',
        alert_reason: '대여 중 장비 상태에 즉시 사람 판단 필요'
      }
    }
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].payload.alert_level, 'p0');
  assert.equal(merged[0].payload.alert_reason, '대여 중 장비 상태에 즉시 사람 판단 필요');
});

test('AI decision validation rejects an invalid p0 level and requires a p0 reason', () => {
  const base = equipmentIncidentDecision();
  const invalidLevel = structuredClone(base);
  invalidLevel.follow_up_items[0].alertLevel = 'urgent';
  assert.ok(validateAiDecisionContract(invalidLevel).errors.some((error) => error.includes('alertLevel')));

  const missingReason = structuredClone(base);
  missingReason.follow_up_items[0].alertReason = '';
  assert.ok(validateAiDecisionContract(missingReason).errors.some((error) => error.includes('alertReason')));
});

test('canAutoSendCustomerAnswer gates by grounding instead of topic category', () => {
  const baseDecision = {
    confidence: 'high',
    kill_switch_observed: 'active',
    reply_decision: {
      replyMode: 'auto_send',
      confidence: 'high',
      text: '네, 확인 후 안내드리겠습니다.',
      safetyClass: 'simple_ack',
      grounding: 'visible_conversation',
      requiresRag: false
    },
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      latest_customer_message_after_last_staff_reply: true
    }
  };
  const groundedPriceQuote = {
    ...baseDecision,
    classification: 'price',
    reply_decision: {
      ...baseDecision.reply_decision,
      text: 'FX3 2일 대여 기준 정가에서 학생할인 30%와 장기할인 10%를 적용해 총 110,000원입니다. VAT 포함 금액입니다.',
      safetyClass: 'sensitive_commitment',
      grounding: 'authoritative_sheet',
      requiresRag: false
    }
  };
  const priceGate = canAutoSendCustomerAnswer(groundedPriceQuote, { autoSendEnabled: true }, {
    priceVerification: { complete: true, totalVatIncluded: 110000 }
  });
  assert.equal(priceGate.allowed, true);
  assert.equal(priceGate.safetyClass, 'sensitive_commitment');
  assert.equal(canAutoSendCustomerAnswer({ ...groundedPriceQuote, kill_switch_observed: 'price_paused' }, { autoSendEnabled: true }).reason, 'kill_switch_price_paused');
  assert.equal(canAutoSendCustomerAnswer({
    ...groundedPriceQuote,
    reply_decision: { ...groundedPriceQuote.reply_decision, grounding: 'visible_conversation' }
  }, { autoSendEnabled: true }).reason, 'sensitive_commitment_grounding_mismatch');
  assert.equal(canAutoSendCustomerAnswer({
    ...groundedPriceQuote,
    reply_decision: { ...groundedPriceQuote.reply_decision, grounding: 'none' }
  }, { autoSendEnabled: true }).reason, 'reply_grounding_missing');
  assert.equal(canAutoSendCustomerAnswer({
    ...groundedPriceQuote,
    reply_decision: { ...groundedPriceQuote.reply_decision, text: '총 110,000원이고 예약 확정됐습니다.' }
  }, { autoSendEnabled: true }).reason, 'sensitive_commitment_contains_reservation_confirmation');
  assert.equal(canAutoSendCustomerAnswer({
    ...baseDecision,
    classification: 'faq',
    reply_decision: {
      ...baseDecision.reply_decision,
      text: '환불 규정은 대여 시작 전날까지 취소하시면 전액 환불입니다.',
      safetyClass: 'current_policy_answer',
      grounding: 'current_confirmed_policy',
      requiresRag: false
    }
  }, { autoSendEnabled: true }).allowed, true);
  assert.equal(canAutoSendCustomerAnswer({
    ...baseDecision,
    classification: 'faq',
    reply_decision: {
      ...baseDecision.reply_decision,
      text: '파손 시 수리비는 실비 기준으로 청구되고 있습니다.',
      safetyClass: 'rag_grounded_answer',
      grounding: 'retrieved_rag',
      requiresRag: true
    }
  }, { autoSendEnabled: true }).allowed, true);
  assert.equal(canAutoSendCustomerAnswer({
    ...baseDecision,
    reply_decision: { ...baseDecision.reply_decision, safetyClass: 'no_send' }
  }, { autoSendEnabled: true }).reason, 'reply_safety_class_no_send_not_auto_sendable');
  assert.equal(canAutoSendCustomerAnswer({
    ...baseDecision,
    reply_decision: { ...baseDecision.reply_decision, safetyClass: 'document_handoff' }
  }, { autoSendEnabled: true }).reason, 'reply_safety_class_document_handoff_not_auto_sendable');
});

test('numeric price commitments require a complete outer sheet calculation and an exact total match', () => {
  const decision = {
    confidence: 'high',
    kill_switch_observed: 'active',
    classification: 'price',
    reply_decision: {
      replyMode: 'auto_send',
      confidence: 'high',
      text: '총 결제 금액은 33,000원입니다.',
      safetyClass: 'sensitive_commitment',
      grounding: 'authoritative_sheet',
      requiresRag: false
    },
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      latest_customer_message_after_last_staff_reply: true
    }
  };

  assert.equal(
    canAutoSendCustomerAnswer(decision, { autoSendEnabled: true }).reason,
    'authoritative_price_verification_required'
  );
  assert.equal(
    canAutoSendCustomerAnswer(decision, { autoSendEnabled: true }, {
      priceVerification: { complete: false, totalVatIncluded: 33000, unresolved: ['단렌즈 x1'] }
    }).reason,
    'authoritative_price_verification_incomplete'
  );
  assert.equal(
    canAutoSendCustomerAnswer(decision, { autoSendEnabled: true }, {
      priceVerification: { complete: true, totalVatIncluded: 55000 }
    }).reason,
    'authoritative_price_total_mismatch'
  );
  assert.equal(
    canAutoSendCustomerAnswer(decision, { autoSendEnabled: true }, {
      priceVerification: { complete: true, totalVatIncluded: 33000 }
    }).allowed,
    true
  );
});

test('the live auto-send path re-reads the referenced trade and blocks a partial price before Kakao send', async (t) => {
  assert.equal(typeof workerModule.maybeAutoSendReply, 'function');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmp-price-verification-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const config = {
    autoSendEnabled: true,
    autoSendLogPath: path.join(tmpDir, 'auto-replies.ndjson'),
    gasApiUrl: 'https://gas.example/exec',
    sheetApiKey: 'key',
    fetchImpl: async (url) => {
      const u = new URL(String(url));
      const sheet = u.searchParams.get('sheet');
      const query = u.searchParams.get('query');
      if (sheet === '계약마스터' && query === '260815-001') {
        return { ok: true, status: 200, text: async () => JSON.stringify({ results: [{ data: ['260815-001', '표영현', '', '', '', '', '', '', 1, '예약', '일반', ''] }] }) };
      }
      if (sheet === '스케줄상세' && query === '260815-001') {
        return { ok: true, status: 200, text: async () => JSON.stringify({ results: [
          { data: ['260815-001-01', '260815-001', '소니 GM 100-400mm', '소니 GM 100-400mm', 1, '2026-08-16', '13:00', '2026-08-16', '23:00', '대기', '', 30000, '표영현'] },
          { data: ['260815-001-02', '260815-001', '소니 GM 단렌즈(14)', '소니 GM 단렌즈(14)', 1, '2026-08-16', '13:00', '2026-08-16', '23:00', '대기', '', 0, '표영현'] },
          { data: ['260815-001-03', '260815-001', '사다리', '사다리', 1, '2026-08-16', '13:00', '2026-08-16', '23:00', '대기', '', 0, '표영현'] }
        ] }) };
      }
      throw new Error(`unexpected URL ${url}`);
    }
  };
  const decision = {
    confidence: 'high',
    kill_switch_observed: 'active',
    classification: 'price',
    customer: { name: '표영현' },
    latest_customer_message_cluster: '어제 예약건 총 금액이 얼마인가요?',
    follow_up_items: [{
      type: 'price_review',
      route: 'settlement',
      taskKey: 'trade_total_260815_001',
      requiresHumanAction: false,
      actionFamily: 'none',
      businessKey: 'trade:260815-001',
      priority: 'normal',
      status: 'done',
      title: '표영현 예약 금액 안내',
      summary: '거래 260815-001 총 금액',
      recommended_action: '',
      evidence: ['계약마스터 260815-001', '스케줄상세 조회']
    }],
    reply_decision: {
      replyMode: 'auto_send',
      confidence: 'high',
      text: '총 결제 금액은 33,000원입니다.',
      safetyClass: 'sensitive_commitment',
      grounding: 'authoritative_sheet',
      requiresRag: false
    },
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      latest_customer_message_after_last_staff_reply: true
    }
  };
  const job = {
    id: 'dom-live-price',
    room_key: 'kakao:pyo',
    preview_text: '표영현 금액 문의',
    unread_count: 1,
    events: [{ reason: 'top_rows_backstop', unread_count: 1 }]
  };

  const result = await workerModule.maybeAutoSendReply({ config, decision, job, navigationContext: {} });

  assert.equal(result.attempted, false);
  assert.equal(result.gate.reason, 'authoritative_price_verification_incomplete');
  assert.deepEqual(result.priceVerification.unresolved, [
    '소니 GM 단렌즈(14) x1',
    '사다리 x1'
  ]);
});

test('validateAiDecisionContract allows sheet-grounded sensitive_commitment auto_send and rejects ungrounded', () => {
  const buildDecision = (grounding) => ({
    reply_decision: {
      replyMode: 'auto_send',
      confidence: 'high',
      text: '총 110,000원입니다.',
      safetyClass: 'sensitive_commitment',
      grounding,
      requiresRag: false
    }
  });
  const grounded = validateAiDecisionContract(buildDecision('authoritative_sheet'));
  assert.ok(!grounded.errors.some((entry) => entry.includes('sensitive_commitment')));
  const ungrounded = validateAiDecisionContract(buildDecision('visible_conversation'));
  assert.ok(ungrounded.errors.some((entry) => entry.includes('sensitive_commitment requires authoritative_sheet grounding')));
  const noSend = validateAiDecisionContract({
    reply_decision: {
      replyMode: 'auto_send',
      confidence: 'high',
      text: '안내드립니다.',
      safetyClass: 'no_send',
      grounding: 'visible_conversation',
      requiresRag: false
    }
  });
  assert.ok(noSend.errors.some((entry) => entry.includes('no_send cannot use auto_send')));
});

test('validateAiDecisionContract fails provider error payloads instead of treating them as decisions', () => {
  const authError = validateAiDecisionContract({
    error: 'invalid_grant',
    error_description: 'Refresh token has been revoked',
    kill_switch_observed: 'active'
  });
  assert.equal(authError.valid, false);
  assert.ok(authError.errors.some((entry) => entry.includes('provider/tool error payload')));
  assert.ok(authError.errors.some((entry) => entry.includes('invalid_grant')));
  const empty = validateAiDecisionContract({});
  assert.equal(empty.valid, false);
  assert.ok(empty.errors.some((entry) => entry.includes('decision is empty')));
  const legitimateNoOp = validateAiDecisionContract({
    should_write_to_sheet: false,
    classification: 'ignore',
    reason: '광고 메시지'
  });
  assert.equal(legitimateNoOp.valid, true);
});

test('buildHermesPrompt scopes auto-send by grounding, not topic whitelist', () => {
  const prompt = buildHermesPrompt({ id: 'job-owner-mode', preview_text: '가격 문의' }, { gasApiUrl: 'https://example.test/exec' });
  assert.ok(prompt.includes('자동발송 범위는 주제(카테고리)가 아니라 근거로 정한다'));
  assert.ok(!prompt.includes('가격/환불/파손/세금 draft_only'));
  assert.ok(prompt.includes('파손·분실 배상 다툼, 환불 분쟁, 법적 문제'));
  assert.ok(prompt.includes('grounding="authoritative_sheet"'));
  assert.ok(prompt.includes('price_paused면 가격 자동발송 금지'));
});

test('buildBrainContext exposes Village Brain files only when present on disk', () => {
  const config = { brainContextPath: 'C:\\brain\\ctx.md', brainCustomerProfilesPath: 'C:\\brain\\profiles.jsonl' };
  assert.deepEqual(buildBrainContext(config, { existsImpl: () => true }), {
    enabled: true,
    contextPath: 'C:\\brain\\ctx.md',
    customerProfilesPath: 'C:\\brain\\profiles.jsonl'
  });
  assert.equal(buildBrainContext(config, { existsImpl: () => false }), null);
  const onlyContext = buildBrainContext(config, { existsImpl: (candidate) => candidate === 'C:\\brain\\ctx.md' });
  assert.equal(onlyContext.contextPath, 'C:\\brain\\ctx.md');
  assert.equal(onlyContext.customerProfilesPath, null);
  assert.equal(buildBrainContext({}, { existsImpl: () => true }), null);
});

test('buildHermesPrompt wires Village Brain owner context as advisory read-only knowledge', () => {
  const prompt = buildHermesPrompt({ id: 'job-brain', preview_text: '단골 문의' }, {
    brainContext: {
      enabled: true,
      contextPath: 'C:\\Village\\VILLAGE_Brain\\Ops\\brain-context-latest.md',
      customerProfilesPath: 'C:\\Village\\VILLAGE_Brain\\Ops\\customer-profiles.jsonl'
    }
  });
  assert.ok(prompt.includes('VILLAGE BRAIN OWNER CONTEXT'));
  assert.equal(prompt.includes('G-BRAIN OWNER CONTEXT'), false);
  assert.ok(prompt.includes('brain-context-latest.md'));
  assert.ok(prompt.includes('customer-profiles.jsonl'));
  assert.ok(prompt.includes('할인유형은 여전히 고객DB I열이 우선'));
  assert.ok(prompt.includes('auto_send grounding으로 선언할 수 없다'));
  const withoutBrain = buildHermesPrompt({ id: 'job-brain-none', preview_text: '문의' });
  assert.equal(withoutBrain.includes('VILLAGE BRAIN OWNER CONTEXT'), false);
});

test('closeKakaoConversationTargetViaDevtools never closes the sole main tab after same-target navigation', async () => {
  let fetchCalls = 0;
  const result = await closeKakaoConversationTargetViaDevtools({ id: 'only-tab', close_safe: false }, {
    cdpBaseUrl: 'http://127.0.0.1:9223',
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('must not close');
    }
  });

  assert.deepEqual(result, { status: 'skipped_unsafe_main_target', targetId: 'only-tab' });
  assert.equal(fetchCalls, 0);
});

test('reply prose cannot grant auto-send without an explicit Hermes safety and grounding class', () => {
  const base = {
    classification: 'reservation',
    confidence: 'high',
    kill_switch_observed: 'active',
    reply_decision: {
      replyMode: 'auto_send',
      confidence: 'high',
      text: '네, 문의 내용 확인 후 안내드리겠습니다.'
    },
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      latest_customer_message_after_last_staff_reply: true
    }
  };

  assert.equal(canAutoSendCustomerAnswer(base, { autoSendEnabled: true }).reason, 'reply_safety_class_missing');
  assert.deepEqual(canAutoSendCustomerAnswer({
    ...base,
    reply_decision: {
      ...base.reply_decision,
      safetyClass: 'simple_ack',
      grounding: 'visible_conversation',
      requiresRag: false
    }
  }, { autoSendEnabled: true }), {
    allowed: true,
    reason: 'simple_ack',
    text: '네, 문의 내용 확인 후 안내드리겠습니다.',
    replyMode: 'auto_send',
    confidence: 'high',
    safetyClass: 'simple_ack',
    grounding: 'visible_conversation'
  });
});

test('safe payment receipt acknowledgements can auto-send without confirming payment', () => {
  const decision = {
    classification: 'payment_check',
    confidence: 'high',
    kill_switch_observed: 'active',
    latest_customer_message_cluster: '김경은 이름으로 입금 했습니다. 확인 부탁드립니다!',
    visible_messages_used: [
      { sender: '민경', message: '김경은 이름으로 입금 했습니다. 확인 부탁드립니다!', time: '오후 4:14' }
    ],
    reply_decision: {
      replyMode: 'auto_send',
      confidence: 'high',
      text: '네, 입금 내역 확인해보겠습니다!',
      safetyClass: 'payment_receipt_ack',
      grounding: 'visible_conversation',
      requiresRag: false
    },
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      latest_customer_message_after_last_staff_reply: true
    }
  };

  assert.deepEqual(canAutoSendCustomerAnswer(decision, { autoSendEnabled: true }), {
    allowed: true,
    reason: 'payment_receipt_ack',
    text: '네, 입금 내역 확인해보겠습니다!',
    replyMode: 'auto_send',
    confidence: 'high',
    safetyClass: 'payment_receipt_ack',
    grounding: 'visible_conversation'
  });
  assert.deepEqual(autoReplyRequiresRagSupport(decision, decision.reply_decision.text), {
    required: false,
    reason: 'payment_receipt_ack'
  });
  assert.equal(canAutoSendCustomerAnswer({
    ...decision,
    reply_decision: { ...decision.reply_decision, text: '네, 입금 확인 완료됐습니다!' }
  }, { autoSendEnabled: true }).allowed, false);
});

test('staff-confirmed reservation acceptance skips mutable-policy RAG gate', () => {
  const decision = {
    classification: 'reservation',
    confidence: 'high',
    kill_switch_observed: 'active',
    latest_customer_message_cluster: '넵! 예약잡아주시면 감사드리겠습니다~',
    latest_staff_message: '넵, 감독님 가능하십니다! 예약 잡아드릴까요?',
    visible_messages_used: [
      { sender: '성치훈', message: '성치훈 / 010-4772-4055 / 개인사업자 / 7월 1일 07:00 ~ 7월 2일 07:00', time: '오후 3:48' },
      { sender: '빌리지님', message: '넵, 감독님 가능하십니다! 예약 잡아드릴까요?', time: '오후 4:00' },
      { sender: '성치훈', message: '넵! 예약잡아주시면 감사드리겠습니다~', time: '오후 4:01' }
    ],
    reply_decision: {
      replyMode: 'auto_send',
      confidence: 'high',
      text: '넵 감독님, 예약 잡아드렸습니다!',
      safetyClass: 'staff_confirmed_reservation_acceptance',
      grounding: 'staff_confirmation',
      requiresRag: false
    },
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      latest_customer_message_after_last_staff_reply: true
    }
  };

  assert.equal(canAutoSendCustomerAnswer(decision, { autoSendEnabled: true }).reason, 'staff_confirmed_reservation_acceptance');
  assert.deepEqual(autoReplyRequiresRagSupport(decision, decision.reply_decision.text), {
    required: false,
    reason: 'staff_confirmed_reservation_acceptance'
  });
});

test('live quote re-request guidance can auto-send without treating it as a new quote task', () => {
  const reply = '감독님, 최초에 보내드린 내 예약 링크에서 최신 견적서를 확인하실 수 있습니다. 장비/일정이 수정되면 그 링크의 견적서도 최신 내용으로 다시 계산됩니다.';
  const decision = {
    classification: 'faq',
    confidence: 'high',
    kill_switch_observed: 'active',
    latest_customer_message_cluster: '장비 수정했는데 견적서 다시 보내주실 수 있나요?',
    visible_messages_used: [
      { sender: '고객', message: '장비 수정했는데 견적서 다시 보내주실 수 있나요?', time: '오후 2:00' }
    ],
    reply_decision: {
      replyMode: 'auto_send',
      confidence: 'high',
      text: reply,
      safetyClass: 'live_quote_link_guidance',
      grounding: 'current_confirmed_policy',
      requiresRag: false
    },
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      latest_customer_message_after_last_staff_reply: true
    }
  };

  assert.deepEqual(canAutoSendCustomerAnswer(decision, { autoSendEnabled: true }), {
    allowed: true,
    reason: 'live_quote_link_guidance',
    text: reply,
    replyMode: 'auto_send',
    confidence: 'high',
    safetyClass: 'live_quote_link_guidance',
    grounding: 'current_confirmed_policy'
  });
  assert.deepEqual(autoReplyRequiresRagSupport(decision, reply), {
    required: false,
    reason: 'live_quote_link_guidance'
  });
});

test('autoReplyRequiresRagSupport skips RAG for pre-approved bankbook/business-registration file handoff', () => {
  assert.deepEqual(autoReplyRequiresRagSupport({
    classification: 'faq',
    latest_customer_message_cluster: '통장 사본이랑 사업자등록증 보내주세요',
    reply_decision: {
      safetyClass: 'document_handoff',
      grounding: 'visible_conversation',
      requiresRag: false,
      attachmentKeys: ['village_bankbook_copy', 'village_business_registration'],
      alreadyDelivered: false
    }
  }, '요청하신 통장 사본과 사업자등록증 전달드립니다.'), {
    required: false,
    reason: 'document_handoff'
  });
});

test('RAG requirement comes from Hermes grounding metadata, not keywords or classification', () => {
  assert.deepEqual(autoReplyRequiresRagSupport({
    classification: 'faq',
    reply_decision: {
      safetyClass: 'simple_ack',
      grounding: 'visible_conversation',
      requiresRag: false
    }
  }, '주소를 확인해 보겠습니다.'), {
    required: false,
    reason: 'simple_ack'
  });
  assert.deepEqual(autoReplyRequiresRagSupport({
    classification: 'reservation',
    reply_decision: {
      safetyClass: 'rag_grounded_answer',
      grounding: 'retrieved_rag',
      requiresRag: true
    }
  }, '확인된 안내입니다.'), {
    required: true,
    reason: 'rag_grounded_answer'
  });
});

test('standard document auto-send only triggers from latest customer request, not old history', () => {
  const decision = {
    classification: 'faq',
    kill_switch_observed: 'active',
    latest_customer_message_cluster: '감사합니다! podong@dodam.media 으로 세금계산서 발행해주시면 입금진행하겠습니다',
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      latest_customer_message_after_last_staff_reply: true
    },
    visible_messages_used: [
      { sender: '김예지', message: '또, 빌리지렌탈샵의 사업자 / 통장사본도 부탁드립니다' },
      { sender: '빌리지님', message: '안녕하세요 빌리지입니다. 요청하신 통장 사본과 사업자등록증 보내드립니다.' },
      { sender: '김예지', message: '감사합니다! podong@dodam.media 으로 세금계산서 발행해주시면 입금진행하겠습니다' }
    ]
  };

  assert.equal(isCustomerDocumentAssetRequest(decision), false);
  assert.equal(canAutoSendCustomerDocumentAssets(decision, { autoSendEnabled: true }).reason, 'document_handoff_not_ai_planned');
});

test('standard document auto-send is blocked after a staff document delivery message', () => {
  const decision = {
    classification: 'faq',
    kill_switch_observed: 'active',
    latest_customer_message_cluster: '사업자등록증이랑 통장 사본 부탁드립니다',
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      latest_customer_message_after_last_staff_reply: true
    },
    visible_messages_used: [
      { sender: '김예지', message: '사업자등록증이랑 통장 사본 부탁드립니다' },
      { sender: '빌리지님', message: '요청하신 통장 사본과 사업자등록증 전달드립니다.' }
    ],
    reply_decision: {
      replyMode: 'auto_send',
      confidence: 'high',
      text: '요청하신 서류를 전달드립니다.',
      safetyClass: 'document_handoff',
      grounding: 'visible_conversation',
      requiresRag: false,
      attachmentKeys: ['village_bankbook_copy', 'village_business_registration'],
      alreadyDelivered: true
    }
  };

  assert.equal(customerDocumentAssetsAlreadySent(decision), true);
  assert.equal(canAutoSendCustomerDocumentAssets(decision, { autoSendEnabled: true }).reason, 'customer_document_assets_already_sent');
});

test('standard document auto-send does not treat customer tax-invoice business-registration upload as Village document request', () => {
  const decision = {
    classification: 'ignore',
    kill_switch_observed: 'active',
    latest_customer_message_cluster: '알티스트레이블 사업자등록증 (1) (1).pdf, ivan@rtstlabel.com, 여기로 세금계산서 발행해 주시면 감사하겠습니다!, 발행해주시고 말씀한번 해주시면 감사하겠습니다',
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      latest_customer_message_after_last_staff_reply: true
    },
    visible_messages_used: [
      { sender: '하현준', message: '세금계산서 발급받고 싶습니다. 사업자등록증좀 전달해주시면 감사하겠습니다' },
      { sender: '빌리지님', message: '세금계산서 발급하실 거면 저희가 아니라 감독님 사업자등록증 보내주셔야되는데 확인 되실까요?' },
      { sender: '하현준', message: '알티스트레이블 사업자등록증 (1) (1).pdf' },
      { sender: '하현준', message: 'ivan@rtstlabel.com' },
      { sender: '하현준', message: '여기로 세금계산서 발행해 주시면 감사하겠습니다!' },
      { sender: '하현준', message: '발행해주시고 말씀한번 해주시면 감사하겠습니다' }
    ]
  };

  assert.equal(isCustomerDocumentAssetRequest(decision), false);
  assert.equal(canAutoSendCustomerDocumentAssets(decision, { autoSendEnabled: true }).reason, 'document_handoff_not_ai_planned');
});

test('standard document auto-send allows explicit Village bankbook/business-registration request in latest turn', (t) => {
  const assetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'village-document-assets-'));
  const assetPaths = [
    path.join(assetDir, 'bankbook.jpeg'),
    path.join(assetDir, 'business-registration.jpeg')
  ];
  for (const assetPath of assetPaths) fs.writeFileSync(assetPath, 'fixture');
  t.after(() => fs.rmSync(assetDir, { recursive: true, force: true }));
  const decision = {
    classification: 'faq',
    kill_switch_observed: 'active',
    latest_customer_message_cluster: '빌리지렌탈샵의 사업자 / 통장사본도 부탁드립니다',
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      latest_customer_message_after_last_staff_reply: true
    },
    visible_messages_used: [
      { sender: '김예지', message: '빌리지렌탈샵의 사업자 / 통장사본도 부탁드립니다' }
    ],
    reply_decision: {
      replyMode: 'auto_send',
      confidence: 'high',
      text: '요청하신 통장 사본과 사업자등록증 전달드립니다.',
      safetyClass: 'document_handoff',
      grounding: 'visible_conversation',
      requiresRag: false,
      attachmentKeys: ['village_bankbook_copy', 'village_business_registration'],
      alreadyDelivered: false
    }
  };

  assert.equal(isCustomerDocumentAssetRequest(decision), true);
  assert.equal(canAutoSendCustomerDocumentAssets(decision, {
    autoSendEnabled: true,
    customerDocumentAssetPaths: assetPaths
  }).reason, 'document_handoff');
});

test('document attachments require explicit Hermes attachment intent and never trigger from prose alone', (t) => {
  const assetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'village-document-plan-'));
  const assetPaths = [path.join(assetDir, 'bankbook.jpeg'), path.join(assetDir, 'business.jpeg')];
  for (const assetPath of assetPaths) fs.writeFileSync(assetPath, 'fixture');
  t.after(() => fs.rmSync(assetDir, { recursive: true, force: true }));

  const proseOnly = {
    classification: 'faq',
    kill_switch_observed: 'active',
    latest_customer_message_cluster: '통장 사본과 사업자등록증 보내주세요',
    safety_checks: {
      kakao_conversation_opened: true,
      did_not_classify_from_preview_only: true,
      latest_customer_message_after_last_staff_reply: true
    }
  };
  assert.equal(isCustomerDocumentAssetRequest(proseOnly), false);
  assert.equal(canAutoSendCustomerDocumentAssets(proseOnly, {
    autoSendEnabled: true,
    customerDocumentAssetPaths: assetPaths
  }).allowed, false);

  const planned = {
    ...proseOnly,
    reply_decision: {
      replyMode: 'auto_send',
      confidence: 'high',
      text: '요청하신 두 서류를 전달드립니다.',
      safetyClass: 'document_handoff',
      grounding: 'visible_conversation',
      requiresRag: false,
      attachmentKeys: ['village_bankbook_copy', 'village_business_registration'],
      alreadyDelivered: false
    }
  };
  assert.equal(isCustomerDocumentAssetRequest(planned), true);
  assert.deepEqual(canAutoSendCustomerDocumentAssets(planned, {
    autoSendEnabled: true,
    customerDocumentAssetPaths: assetPaths
  }), {
    allowed: true,
    reason: 'document_handoff',
    text: '요청하신 두 서류를 전달드립니다.',
    replyMode: 'auto_send',
    confidence: 'high',
    attachmentPaths: assetPaths.map((assetPath) => path.resolve(assetPath)),
    safetyClass: 'document_handoff',
    grounding: 'visible_conversation'
  });
});

test('autoReplyRequiresRagSupport marks FAQ and policy/procedure replies for RAG verification', () => {
  assert.deepEqual(autoReplyRequiresRagSupport({
    classification: 'faq',
    reply_decision: { safetyClass: 'current_policy_answer', grounding: 'current_confirmed_policy', requiresRag: false }
  }, '네, 주소 안내드릴게요.'), {
    required: true,
    reason: 'current_policy_answer'
  });
  assert.deepEqual(autoReplyRequiresRagSupport({
    classification: 'reservation',
    reply_decision: { safetyClass: 'simple_ack', grounding: 'visible_conversation', requiresRag: false }
  }, '네, 확인했습니다.'), {
    required: false,
    reason: 'simple_ack'
  });
  assert.deepEqual(autoReplyRequiresRagSupport({
    classification: 'reservation',
    reply_decision: { safetyClass: 'current_policy_answer', grounding: 'current_confirmed_policy', requiresRag: false }
  }, '방문 수령 절차 안내드리겠습니다.'), {
    required: true,
    reason: 'current_policy_answer'
  });
});

test('autoReplyRequiresRagSupport marks mutable policy FAQ for current-policy or RAG verification', () => {
  assert.deepEqual(mutablePolicyAutoReplyRisk({
    latest_customer_message_cluster: '학생할인 몇 프로인가요?'
  }, '학생 할인은 30%입니다.'), {
    mutable: true,
    reason: 'mutable_policy_terms'
  });
  assert.deepEqual(autoReplyRequiresRagSupport({
    classification: 'faq',
    latest_customer_message_cluster: '비학생인데 학생가 적용 가능한가요?',
    reply_decision: { safetyClass: 'current_policy_answer', grounding: 'current_confirmed_policy', requiresRag: false }
  }, '학생가는 적용 어렵습니다.'), {
    required: true,
    reason: 'current_policy_answer'
  });
});

test('currentConfirmedPolicyAutoReplySupport allows owner-confirmed latest discount facts', () => {
  assert.deepEqual(currentConfirmedPolicyAutoReplySupport({
    latest_customer_message_cluster: '학생할인 몇 프로인가요?'
  }, '학생 할인은 30%입니다.'), {
    applicable: true,
    allowed: true,
    reason: 'current_confirmed_policy_match',
    topics: ['student_discount_rate'],
    failedTopics: []
  });
  assert.equal(currentConfirmedPolicyAutoReplySupport({
    latest_customer_message_cluster: '학생할인 몇 프로인가요?'
  }, '학생 할인은 40%입니다.').allowed, false);
  assert.equal(currentConfirmedPolicyAutoReplySupport({
    latest_customer_message_cluster: '보증금 있나요?'
  }, '보증금은 없습니다.').reason, 'policy_not_in_current_confirmed_set_use_rag');
  assert.deepEqual(currentConfirmedPolicyAutoReplySupport({
    latest_customer_message_cluster: '영업시간이 어떻게 되나요?'
  }, '저희는 24시간 운영하고 있습니다.'), {
    applicable: true,
    allowed: true,
    reason: 'current_confirmed_policy_match',
    topics: ['business_hours_policy'],
    failedTopics: []
  });
});

test('policy content lives in current-confirmed-policy.json and gates fail closed without it', () => {
  const config = loadCurrentConfirmedPolicyConfig();
  assert.ok(config, 'the policy config file must ship with the worker');
  assert.match(config.prompt.current_confirmed_policy, /학생 30%/);
  assert.ok(config.topics.some((topic) => topic.key === 'long_term_discount_policy'));
  // 확정 정책(+3시간)의 문구도 대여일수 검증에서 인정되어야 한다 (구 +6시간 문구만 인정하던 회귀 방지).
  assert.equal(currentConfirmedPolicyAutoReplySupport({
    latest_customer_message_cluster: '3시간 넘으면 하루 더 계산되나요?'
  }, '3시간 이내 초과는 같은 일수이고, 그 이상은 +1일로 계산됩니다.').allowed, true);

  // 설정 파일이 없으면 내장값으로 조용히 돌지 않고 정책 주제 auto_send를 전면 보류한다.
  resetCurrentConfirmedPolicyConfigCache();
  process.env.VILLAGE_POLICY_CONFIG_PATH = path.join(os.tmpdir(), 'no-such-policy-config.json');
  try {
    assert.deepEqual(currentConfirmedPolicyAutoReplySupport({
      latest_customer_message_cluster: '학생할인 몇 프로인가요?'
    }, '학생 할인은 30%입니다.'), {
      applicable: false,
      allowed: false,
      reason: 'policy_config_unavailable'
    });
    assert.deepEqual(mutablePolicyAutoReplyRisk({
      latest_customer_message_cluster: '학생할인 몇 프로인가요?'
    }, ''), { mutable: true, reason: 'policy_config_unavailable' });
  } finally {
    delete process.env.VILLAGE_POLICY_CONFIG_PATH;
    resetCurrentConfirmedPolicyConfigCache();
  }
});

test('set quotes are grounded by 세트마스터 alone — component ❓ rows never block pricing', () => {
  // 2026-08-17 567399b가 "모든 독립 품목의 단가" 문구를 넣으면서 세트 구성품(AC라인 등,
  // 단가 없는 포함 액세서리)까지 품목으로 세어 세트 견적 자동발송이 멈췄다(강소원 사례).
  // 청구 라인 정의를 프롬프트에 고정해 같은 회귀를 막는다.
  const prompt = buildHermesPrompt({ id: 'job-price' }, { ragContext: { enabled: true } });
  assert.match(prompt, /세트는 세트 전체가 청구 라인 1개/);
  assert.match(prompt, /가격 근거를 깨지 않는다/);
  assert.doesNotMatch(prompt, /모든 독립 품목의 단가/);
});

test('terminal acknowledgement is an advisory prompt hint, never a code-level skip', () => {
  const withHint = buildHermesPrompt({ id: 'job-hint' }, { terminalAckHint: { matched: true, reason: 'terminal_acknowledgement' } });
  assert.match(withHint, /TERMINAL_ACK_HINT/);
  assert.match(withHint, /운영 맥락이 남아 있거나 실질 질문이 보이면 이 힌트를 무시/);
  const withoutHint = buildHermesPrompt({ id: 'job-plain' }, {});
  assert.doesNotMatch(withoutHint, /TERMINAL_ACK_HINT/);
  // 조기 반환 경로가 다시 생기면 안 된다: 워커 소스에 스킵 상태가 존재하지 않아야 한다.
  const workerSource = fs.readFileSync(new URL('./worker.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(workerSource, /ai_skipped_terminal_acknowledgement/);
});

test('buildAutoReplyRagQuestion includes current Kakao context and proposed reply without asking current stock truth', () => {
  const question = buildAutoReplyRagQuestion({
    decision: {
      classification: 'faq',
      customer: { name: '박정병' },
      latest_customer_message_cluster: '혹시 코모도 x도 보유중이신가요?',
      visible_messages_used: [
        { sender: '박정병', message: '혹시 코모도 x도 보유중이신가요?' },
        { sender: '빌리지님', message: '확인해보겠습니다.' }
      ]
    },
    replyText: '안녕하세요 감독님! 코모도 X는 현재 보유 목록에서 확인이 안 됩니다.'
  });

  assert.match(question, /박정병/);
  assert.match(question, /혹시 코모도 x도 보유중/);
  assert.match(question, /AI가 보내려는 답변 초안/);
  assert.match(question, /현재 재고\/예약 가능 여부\/스케줄 확정은 판단하지 말고/);
});

test('buildAutoReplyRagQuestion tells RAG current confirmed policy wins over older history', () => {
  const question = buildAutoReplyRagQuestion({
    decision: {
      classification: 'faq',
      customer: { name: '최재형' },
      latest_customer_message_cluster: '학생 할인율이 몇 퍼센트인가요?'
    },
    replyText: '학생 할인은 30%입니다.'
  });

  assert.match(question, /현재 확정 정책/);
  assert.match(question, /학생30%/);
  assert.match(question, /확정 정책에 없는 보증금\/환불\/계좌\/증빙/);
});

test('evaluateAutoReplyRagSupport allows owner-confirmed current policy FAQ without RAG', async () => {
  let called = false;
  const supported = await evaluateAutoReplyRagSupport({
    config: {},
    decision: {
      classification: 'faq',
      customer: { name: '최필립' },
      latest_customer_message_cluster: '안녕하세요. 영업시간이 어떻게 되나요?',
      reply_decision: { safetyClass: 'current_policy_answer', grounding: 'current_confirmed_policy', requiresRag: false }
    },
    replyText: '안녕하세요! 빌리지는 24시간 운영합니다.',
    askImpl: async () => {
      called = true;
      throw new Error('RAG should not be called for current confirmed business hours');
    }
  });

  assert.equal(supported.allowed, true);
  assert.equal(supported.reason, 'current_confirmed_policy_match');
  assert.deepEqual(supported.currentPolicy.topics, ['business_hours_policy']);
  assert.equal(called, false);
});

test('evaluateAutoReplyRagSupport requires high-confidence retrieved RAG for FAQ auto-send', async () => {
  const base = {
    config: { villageAiUrl: 'https://village-ai.example', ragTimeoutMs: 1000 },
    decision: {
      classification: 'faq',
      customer: { name: '홍길동' },
      latest_customer_message_cluster: '위치가 어디인가요?',
      reply_decision: { safetyClass: 'rag_grounded_answer', grounding: 'retrieved_rag', requiresRag: true }
    },
    job: { preview_text: '홍길동 위치가 어디인가요? 오후 2:30' },
    replyText: '빌리지는 서울 마포구 동교로 23길 32, 2층입니다.'
  };
  const supported = await evaluateAutoReplyRagSupport({
    ...base,
    askImpl: async (payload) => ({
      text: `근거 있음: ${payload.question.slice(0, 20)}`,
      confidence: 'high',
      knowledgeSource: 'retrieved',
      ownerReview: false,
      usedSources: [{ id: 'source-1' }],
      logId: 'rag-1'
    })
  });
  const weak = await evaluateAutoReplyRagSupport({
    ...base,
    askImpl: async () => ({ text: '일반 답변', confidence: 'high', knowledgeSource: 'general', ownerReview: false })
  });

  assert.equal(supported.allowed, true);
  assert.equal(supported.reason, 'rag_high_confidence_retrieved');
  assert.equal(supported.logId, 'rag-1');
  assert.equal(weak.allowed, false);
  assert.equal(weak.reason, 'rag_not_strong_enough_for_auto_send');
});

test('evaluateAutoReplyRagSupport allows owner-confirmed current policy auto-send without RAG', async () => {
  let called = false;
  const supported = await evaluateAutoReplyRagSupport({
    config: { villageAiUrl: 'https://village-ai.example', ragTimeoutMs: 1000 },
    decision: {
      classification: 'faq',
      customer: { name: '최재형' },
      latest_customer_message_cluster: '학생 할인은 몇 프로예요?',
      reply_decision: { safetyClass: 'current_policy_answer', grounding: 'current_confirmed_policy', requiresRag: false }
    },
    replyText: '학생 할인은 30%입니다.',
    askImpl: async () => {
      called = true;
      return {
        text: '학생 할인은 과거에 30%로 안내했습니다.',
        confidence: 'high',
        knowledgeSource: 'retrieved',
        ownerReview: false
      };
    }
  });

  assert.equal(supported.allowed, true);
  assert.equal(supported.reason, 'current_confirmed_policy_match');
  assert.equal(called, false);
  assert.deepEqual(supported.currentPolicy.topics, ['student_discount_rate']);
});

test('evaluateAutoReplyRagSupport blocks current policy mismatch and uses RAG for unconfirmed policy FAQ', async () => {
  const mismatch = await evaluateAutoReplyRagSupport({
    config: { villageAiUrl: 'https://village-ai.example', ragTimeoutMs: 1000 },
    decision: {
      classification: 'faq',
      customer: { name: '최재형' },
      latest_customer_message_cluster: '학생 할인은 몇 프로예요?',
      reply_decision: { safetyClass: 'current_policy_answer', grounding: 'current_confirmed_policy', requiresRag: false }
    },
    replyText: '학생 할인은 40%입니다.',
    askImpl: async () => {
      throw new Error('RAG should not be called for current-policy mismatch');
    }
  });
  let called = false;
  const unknown = await evaluateAutoReplyRagSupport({
    config: { villageAiUrl: 'https://village-ai.example', ragTimeoutMs: 1000 },
    decision: {
      classification: 'faq',
      customer: { name: '홍길동' },
      latest_customer_message_cluster: '보증금 있나요?',
      reply_decision: { safetyClass: 'rag_grounded_answer', grounding: 'retrieved_rag', requiresRag: true }
    },
    replyText: '보증금 안내드리겠습니다.',
    askImpl: async () => {
      called = true;
      return {
        text: '보증금 정책 근거 있음',
        confidence: 'high',
        knowledgeSource: 'retrieved',
        ownerReview: false,
        logId: 'rag-deposit'
      };
    }
  });

  assert.equal(mismatch.allowed, false);
  assert.equal(mismatch.reason, 'current_policy_mismatch_requires_review');
  assert.equal(unknown.allowed, true);
  assert.equal(unknown.reason, 'rag_high_confidence_retrieved');
  assert.equal(unknown.logId, 'rag-deposit');
  assert.equal(called, true);
});

test('isAutoSendEligibleLiveJob allows unread same-day rows and blocks dated/backfill rows from auto-send', () => {
  const now = new Date('2026-06-02T06:50:00.000Z'); // 2026-06-02 15:50 KST
  assert.deepEqual(isAutoSendEligibleLiveJob({
    replayedFromSupabase: true,
    preview_text: '중요 홍길동 1 네 감사합니다 오후 3:45',
    unread_count: 1,
    events: [{ reason: 'top_row_changed', unreadCount: 1 }]
  }, { now }), {
    eligible: false,
    reason: 'supabase_recovery_never_auto_sends'
  });
  assert.deepEqual(isAutoSendEligibleLiveJob({
    preview_text: 'recent booking preview',
    events: [{ reason: 'startup_catchup' }]
  }, { now }), {
    eligible: false,
    reason: 'startup_catchup_never_auto_sends'
  });
  assert.deepEqual(isAutoSendEligibleLiveJob({
    preview_text: '중요 홍길동 네 감사합니다 오후 3:45',
    events: [{ reason: 'top_row_changed' }]
  }, { now }), {
    eligible: true,
    reason: 'top_row_live_time_format'
  });
  assert.deepEqual(isAutoSendEligibleLiveJob({
    preview_text: '중요 김찬위 차가 많이 막혀서 좀 늦을거 같습니다! 죄송합니다 오후 4:28',
    detectedAt: '2026-06-29T07:41:48.086Z',
    events: [{ reason: 'top_row_changed' }]
  }, { now: new Date('2026-06-29T07:49:35.920Z') }), {
    eligible: true,
    reason: 'top_row_live_time_format'
  });
  assert.deepEqual(isAutoSendEligibleLiveJob({
    preview_text: '중요 김찬위 차가 많이 막혀서 좀 늦을거 같습니다! 죄송합니다 오후 4:28',
    detectedAt: '2026-06-29T06:41:48.086Z',
    events: [{ reason: 'top_row_changed' }]
  }, { now: new Date('2026-06-29T07:49:35.920Z') }), {
    eligible: false,
    reason: 'top_row_time_outside_live_window'
  });
  assert.deepEqual(isAutoSendEligibleLiveJob({
    preview_text: '중요 성치훈 성치훈 / 개인사업자 / 7월 1일 07:00 ~ 7월 2일 07:00 감사합니다! 오후 3:48',
    events: [{ reason: 'top_row_changed' }]
  }, { now: new Date('2026-06-29T06:50:00.000Z') }), {
    eligible: true,
    reason: 'top_row_live_time_format'
  });
  assert.deepEqual(isAutoSendEligibleLiveJob({
    preview_text: '중요 홍길동 네 감사합니다 오후 3:45',
    events: [{ reason: 'top_row_changed' }]
  }, { now: new Date('2026-06-02T08:00:00.000Z') }), {
    eligible: false,
    reason: 'top_row_time_outside_live_window'
  });
  assert.equal(isAutoSendEligibleLiveJob({ preview_text: '중요 홍길동 네 감사합니다 오후 3:45', events: [{ reason: 'mutation' }] }, { now }).eligible, false);
  assert.equal(isAutoSendEligibleLiveJob({ payload: { previewText: '중요 홍길동 네 감사합니다 오후 3:45', events: [{ reason: 'top_row_changed' }] } }, { now }).eligible, true);
  assert.deepEqual(isAutoSendEligibleLiveJob({
    preview_text: '중요 홍길동 3 네 감사합니다 오후 3:45',
    unread_count: 3,
    events: [{ reason: 'top_rows_backstop' }]
  }, { now }), {
    eligible: true,
    reason: 'top_row_unread'
  });
  assert.deepEqual(isAutoSendEligibleLiveJob({
    preview_text: '중요 홍길동 네 감사합니다 오후 3:45',
    unread_count: null,
    events: [{ reason: 'top_rows_backstop', unreadCount: 3 }]
  }, { now }), {
    eligible: true,
    reason: 'top_row_unread'
  });
  assert.deepEqual(isAutoSendEligibleLiveJob({
    preview_text: '중요 홍길동 3 네 감사합니다 6월 2일',
    unread_count: 3,
    events: [{ reason: 'top_rows_backstop' }]
  }, { now }), {
    eligible: true,
    reason: 'top_row_unread'
  });
  assert.deepEqual(isAutoSendEligibleLiveJob({
    preview_text: '중요 홍길동 안녕하세요. 영업시간이 어떻게 되나요? 6월 2일',
    events: [{ reason: 'top_row_changed' }]
  }, { now }), {
    eligible: true,
    reason: 'top_row_current_date_label'
  });
  assert.equal(isAutoSendEligibleLiveJob({
    preview_text: '중요 홍길동 3 네 감사합니다 5월 26일',
    unread_count: 3,
    events: [{ reason: 'top_rows_backstop' }]
  }, { now }).eligible, false);
  assert.equal(isAutoSendEligibleLiveJob({ preview_text: '중요 홍길동 네 감사합니다 오후 3:45', events: [{ reason: 'top_rows_backstop' }] }, { now }).eligible, false);
  assert.equal(isAutoSendEligibleLiveJob({ preview_text: '중요 한시우/60x 파손 video 5월 25일', events: [{ reason: 'top_row_changed' }] }, { now }).eligible, false);
  assert.equal(isAutoSendEligibleLiveJob({ preview_text: '중요 배성문 1월 15일 건은 4만원입니다. 오후 3:45', events: [{ reason: 'top_row_changed' }] }, { now }).eligible, false);
});

test('auto reply dedupe key uses customer message and outgoing text', () => {
  const key = buildAutoReplyDedupeKey({
    job: { preview_text: '최재형 1 빌리지 위치가 어떻게 되나요? 오전 2:29' },
    decision: {
      customer: { name: '최재형' },
      visible_messages_used: [
        { sender: '빌리지님', message: '이전 답변' },
        { sender: '최재형', message: '빌리지 위치가 어떻게 되나요?' }
      ],
      reply_decision: { text: '빌리지는 서울 마포구 동교로 23길 32, 2층입니다.' }
    }
  });

  assert.match(key, /최재형/);
  assert.match(key, /빌리지 위치가 어떻게 되나요/);
  assert.match(key, /동교로 23길 32/);
});

test('auto reply dedupe key prefers stable room key over inconsistent customer label', () => {
  const first = buildAutoReplyDedupeKey({
    job: { roomKey: 'preview:cd489b98fab6669f', preview_text: '김예지2 감사합니다 오후 11:11' },
    decision: {
      customer: { name: '김예지2' },
      visible_messages_used: [{ sender: '김예지', message: '감사합니다! podong@dodam.media 으로 세금계산서 발행해주시면 입금진행하겠습니다' }],
      reply_decision: { text: '요청하신 통장 사본과 사업자등록증 전달드립니다.' }
    }
  });
  const second = buildAutoReplyDedupeKey({
    job: { room_key: 'preview:cd489b98fab6669f', preview_text: '김예지2 감사합니다 오후 11:11' },
    decision: {
      customer: { name: '김예지' },
      visible_messages_used: [{ sender: '김예지', message: '감사합니다! podong@dodam.media 으로 세금계산서 발행해주시면 입금진행하겠습니다' }],
      reply_decision: { text: '요청하신 통장 사본과 사업자등록증 전달드립니다.' }
    }
  });

  assert.equal(first, second);
  assert.match(first, /^preview:cd489b98fab6669f\|/);
});

test('hasRecentSentAutoReply blocks duplicate sent replies only inside window', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmp-auto-replies-'));
  const logPath = path.join(tmpDir, 'auto-replies.ndjson');
  const now = new Date('2026-05-26T17:40:00.000Z');
  const key = '최재형|빌리지 위치가 어떻게 되나요?|동교로 23길 32';
  fs.writeFileSync(logPath, [
    JSON.stringify({ at: '2026-05-26T17:20:00.000Z', dedupeKey: key, result: { sent: true } }),
    JSON.stringify({ at: '2026-05-26T16:00:00.000Z', dedupeKey: 'other', result: { sent: true } })
  ].join('\n'));

  assert.equal(hasRecentSentAutoReply({ autoSendLogPath: logPath }, key, { now, windowMs: 30 * 60 * 1000 }), true);
  assert.equal(hasRecentSentAutoReply({ autoSendLogPath: logPath }, key, { now, windowMs: 5 * 60 * 1000 }), false);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('findKakaoMessageInputElementIndex finds the Kakao message input field', () => {
  const tree = `
- [10] AXStaticText = "한이솔"
- [41] AXTextArea "채팅 메시지 입력 폼" value=""
- [42] AXButton "전송"
`;
  assert.equal(findKakaoMessageInputElementIndex(tree), 41);
  assert.equal(findKakaoSendButtonElementIndex(tree), 42);
  assert.equal(kakaoConversationContainsMessage('- [20] AXStaticText = "네 확인했습니다."', '네 확인했습니다.'), true);
});

test('findKakaoMessageInputElementIndex uses Kakao input form context instead of address bar', () => {
  const tree = `
- [4] AXGroup actions=[AXShowMenu]
  - [6] AXTextField = "business.kakao.com/_xhPMls/chats/4925133758027996" (주소창 및 검색창)
- [681] AXGroup
  - [682] AXGroup (채팅 메시지 입력 폼)
    - [684] AXStaticText = "채팅 메시지 입력 폼"
    - [685] AXTextArea actions=[AXShowMenu, AXScrollToVisible]
    - [693] AXGroup
      - [694] AXButton actions=[AXShowMenu, AXScrollToVisible]
  - [695] AXButton "전송" DISABLED actions=[AXShowMenu, AXScrollToVisible]
`;
  assert.equal(findKakaoMessageInputElementIndex(tree), 685);
  assert.equal(findKakaoSendButtonElementIndex(tree), 695);
});

test('sendKakaoMessageViaChrome clicks send button and verifies sent bubble', { skip: process.platform !== 'darwin' }, async () => {
  const calls = [];
  let stateCalls = 0;
  const spawnImpl = (cmd, args) => {
    calls.push({ cmd, args });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      if (cmd === 'osascript') {
        child.stdout.end('');
      } else if (args[1] === 'get_window_state') {
        stateCalls += 1;
        child.stdout.end(JSON.stringify({
          tree_markdown: stateCalls === 1
            ? '- [41] AXTextArea "채팅 메시지 입력 폼" value=""\n- [42] AXButton "전송"'
            : stateCalls === 2
              ? '- [41] AXTextArea "채팅 메시지 입력 폼" value="네 확인했습니다."\n- [42] AXButton "전송"'
              : '- [20] AXStaticText = "네 확인했습니다."\n- [41] AXTextArea "채팅 메시지 입력 폼" value=""'
        }));
      } else {
        child.stdout.end('{}');
      }
      child.emit('close', 0);
    });
    return child;
  };

  const result = await sendKakaoMessageViaChrome('네 확인했습니다.', {
    conversation_window: { pid: 123, window_id: 456, title: '고객 - 빌리지 - 카카오비즈니스 파트너센터' }
  }, { spawnImpl });

  assert.equal(result.sent, true);
  assert.equal(result.reason, 'sent_via_chrome_verified');
  assert.equal(calls[0].cmd, 'osascript');
  assert.equal(calls[1].args[1], 'get_window_state');
  assert.equal(calls[2].args[1], 'type_text');
  assert.match(calls[2].args[2], /네 확인했습니다/);
  assert.equal(calls[4].args[1], 'get_window_state');
  assert.equal(calls[5].args[1], 'click');
  assert.equal(calls[7].args[1], 'get_window_state');
});

test('sendKakaoMessageViaChrome falls back to DevTools target when AX window is unavailable', async () => {
  const evalCalls = [];
  const result = await sendKakaoMessageViaChrome('확인했습니다.', {
    conversation_target: {
      id: 'chat',
      title: '오래된고객 - 빌리지 - 카카오비즈니스 파트너센터',
      url: 'https://business.kakao.com/_xhPMls/chats/123',
      webSocketDebuggerUrl: 'ws://chat'
    }
  }, {
    evaluateImpl: async (target, expression) => {
      evalCalls.push({ target, expression });
      return { sent: true, reason: 'sent_via_devtools_verified', window_title: target.title };
    }
  });

  assert.equal(result.sent, true);
  assert.equal(result.reason, 'sent_via_devtools_verified');
  assert.equal(result.via_devtools, true);
  assert.ok(evalCalls[0].expression.includes('textarea[placeholder*="메시지"]'));
});

test('sendKakaoMessageViaDevtools refuses sent=true without a conversation target', async () => {
  assert.deepEqual(await sendKakaoMessageViaDevtools('확인했습니다.', {}), {
    sent: false,
    reason: 'conversation_target_missing'
  });
});

test('sendKakaoMessageViaDevtools attaches local files through Chrome DevTools after text send', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kakao-attach-'));
  const bankbookPath = path.join(dir, 'bankbook.jpeg');
  const businessPath = path.join(dir, 'business.jpeg');
  fs.writeFileSync(bankbookPath, 'bankbook');
  fs.writeFileSync(businessPath, 'business');
  const cdpCalls = [];
  const evalExpressions = [];

  const result = await sendKakaoMessageViaDevtools('요청하신 통장 사본과 사업자등록증 전달드립니다.', {
    conversation_target: {
      id: 'chat',
      title: '최재형 - 빌리지 - 카카오비즈니스 파트너센터',
      webSocketDebuggerUrl: 'ws://example.test/devtools/page/chat'
    }
  }, {
    attachmentPaths: [bankbookPath, businessPath],
    evaluateImpl: async (_target, expression) => {
      evalExpressions.push(expression);
      if (expression.includes('kakaoSendMessage')) {
        return { sent: true, reason: 'sent_via_devtools_verified', window_title: '최재형' };
      }
      return { sendClicked: true, selectedFileCount: 2, window_title: '최재형' };
    },
    cdpCallImpl: async (_target, method, params) => {
      cdpCalls.push({ method, params });
      if (method === 'DOM.getDocument') return { root: { nodeId: 1 } };
      if (method === 'DOM.querySelector') return { nodeId: 42 };
      if (method === 'DOM.setFileInputFiles') return {};
      return {};
    }
  });

  assert.equal(result.sent, true);
  assert.equal(result.attachments.attached, true);
  assert.deepEqual(cdpCalls.find((call) => call.method === 'DOM.setFileInputFiles').params.files, [bankbookPath, businessPath]);
  assert.equal(evalExpressions.some((expression) => expression.includes('kakaoSendPendingAttachments')), true);
});

test('sendKakaoMessageViaChrome reactivates target window and retries disabled send button', { skip: process.platform !== 'darwin' }, async () => {
  const calls = [];
  let stateCalls = 0;
  let clickCalls = 0;
  const spawnImpl = (cmd, args) => {
    calls.push({ cmd, args });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      if (cmd === 'osascript') {
        child.stdout.end('');
        child.emit('close', 0);
      } else if (args[1] === 'get_window_state') {
        stateCalls += 1;
        const tree = stateCalls >= 4
          ? '- [20] AXStaticText = "네 확인했습니다."\n- [41] AXTextArea "채팅 메시지 입력 폼" value=""'
          : '- [41] AXTextArea "채팅 메시지 입력 폼" value="네 확인했습니다."\n- [42] AXButton "전송"';
        child.stdout.end(JSON.stringify({ tree_markdown: tree }));
        child.emit('close', 0);
      } else if (args[1] === 'click') {
        clickCalls += 1;
        if (clickCalls === 1) {
          child.stderr.end('AXButton "전송" is disabled (AXEnabled = false)');
          child.emit('close', 1);
        } else {
          child.stdout.end('{}');
          child.emit('close', 0);
        }
      } else {
        child.stdout.end('{}');
        child.emit('close', 0);
      }
    });
    return child;
  };

  const result = await sendKakaoMessageViaChrome('네 확인했습니다.', {
    conversation_window: { pid: 123, window_id: 456, title: '고객 - 빌리지 - 카카오비즈니스 파트너센터' }
  }, { spawnImpl });

  assert.equal(result.sent, true);
  assert.equal(result.retried_after_frontmost_activation, true);
  assert.equal(clickCalls, 2);
  assert.ok(calls.filter((call) => call.cmd === 'osascript').length >= 3);
});

test('sendKakaoMessageViaChrome treats Chrome activation failure as non-fatal and verifies send', async () => {
  let stateCalls = 0;
  const spawnImpl = (cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      if (cmd === 'osascript') {
        child.stderr.end('not authorised to send Apple events');
        child.emit('close', 1);
      } else if (args[1] === 'get_window_state') {
        stateCalls += 1;
        child.stdout.end(JSON.stringify({
          tree_markdown: stateCalls >= 3
            ? '- [20] AXStaticText = "네 확인했습니다."\n- [41] AXTextArea "채팅 메시지 입력 폼" value=""'
            : '- [41] AXTextArea "채팅 메시지 입력 폼" value="네 확인했습니다."\n- [42] AXButton "전송"'
        }));
        child.emit('close', 0);
      } else {
        child.stdout.end('{}');
        child.emit('close', 0);
      }
    });
    return child;
  };

  const result = await sendKakaoMessageViaChrome('네 확인했습니다.', {
    conversation_window: { pid: 123, window_id: 456, title: '고객 - 빌리지 - 카카오비즈니스 파트너센터' }
  }, { spawnImpl });

  assert.equal(result.sent, true);
  assert.equal(result.reason, 'sent_via_chrome_verified');
});

test('sendKakaoMessageViaChrome refuses sent=true when Kakao bubble is not verified', async () => {
  const spawnImpl = (_cmd, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => {
      if (args[0] === '-e') {
        child.stdout.end('');
      } else if (args[1] === 'get_window_state') {
        child.stdout.end(JSON.stringify({
          tree_markdown: '- [41] AXTextArea "채팅 메시지 입력 폼" value=""\n- [42] AXButton "전송"'
        }));
      } else {
        child.stdout.end('{}');
      }
      child.emit('close', 0);
    });
    return child;
  };

  const result = await sendKakaoMessageViaChrome('네 확인했습니다.', {
    conversation_window: { pid: 123, window_id: 456, title: '고객 - 빌리지 - 카카오비즈니스 파트너센터' }
  }, { spawnImpl });

  assert.equal(result.sent, false);
  assert.equal(result.reason, 'send_not_verified_in_conversation');
});

test('mapDecisionToStatusPatch routes write and no-write decisions to review states', () => {
  assert.deepEqual(mapDecisionToStatusPatch({ should_write_to_sheet: true }, { sheetResult: { success: true } }), {
    status: 'needs_human_review',
    error_message: null
  });
  assert.deepEqual(mapDecisionToStatusPatch({ should_write_to_sheet: true }, {
    sheetResult: {
      success: false,
      error_type: 'sheet_validation',
      error: '셀 B52에 입력한 데이터가 이 셀에 설정된 데이터 확인 규칙을 위반했습니다.'
    }
  }), {
    status: 'needs_human_review',
    error_message: 'GAS sheet write rejected: 셀 B52에 입력한 데이터가 이 셀에 설정된 데이터 확인 규칙을 위반했습니다.'
  });
  assert.deepEqual(mapDecisionToStatusPatch({ should_write_to_sheet: true }, {
    sheetResult: {
      success: false,
      error_type: 'duplicate_request',
      error: '중복 요청: 동일 건이 이미 예약 등록되어 있습니다'
    }
  }), {
    status: 'ai_skipped_needs_review',
    error_message: 'GAS duplicate skipped: 중복 요청: 동일 건이 이미 예약 등록되어 있습니다'
  });
  assert.deepEqual(mapDecisionToStatusPatch({ should_write_to_sheet: false, reason: '정보부족' }), {
    status: 'ai_skipped_needs_review',
    error_message: '정보부족'
  });
});

test('kakao partner-center alimtalk placeholder is filtered out of conversation evidence', () => {
  const tree = `
- [11] AXStaticText = "김세원"
- [20] AXStaticText = "입금 완료했습니다"
- [21] AXStaticText = "보낸 메시지 가이드"
- [22] AXStaticText = "알림톡/브랜드메시지는 관리자센터에서 확인할 수 없어요."
- [23] AXStaticText = "알림톡/브랜드메시지는 관리자센터에서 확인할 수 없어요. 오전 10:32"
- [30] AXStaticText = "따로 전화해서 안내받았습니다"
`;
  const evidence = extractKakaoConversationEvidence(tree, { title: '김세원 - 빌리지', hints: ['김세원'], maxItems: 10 });
  assert.deepEqual(evidence.visible_static_text_tail, ['김세원', '입금 완료했습니다', '따로 전화해서 안내받았습니다']);
  assert.equal(isKakaoUiPlaceholderLine('알림톡/브랜드메시지는 관리자센터에서 확인할 수 없어요. 오후 08:54'), true);
  assert.equal(isKakaoUiPlaceholderLine('입금 확인했습니다'), false);
});

test('room reply dedupe key ignores the latest customer message so nagging loops collapse to one key', () => {
  const replyText = '반납 날짜와 시간을 한 번만 다시 알려주세요!';
  const first = buildRoomReplyDedupeKey({
    job: { room_key: 'chat:12345', preview_text: '임선 반출 변경 요청 오전 3:35' },
    decision: { customer: { name: '임선' } },
    replyText
  });
  const second = buildRoomReplyDedupeKey({
    job: { room_key: 'chat:12345', preview_text: '임선 아까 직원분께 확인 받았습니다 오전 4:08' },
    decision: { customer: { name: '임선' } },
    replyText
  });
  assert.equal(first, second);
  assert.equal(first.startsWith('chat:12345|'), true);
  assert.equal(buildRoomReplyDedupeKey({ job: { room_key: 'chat:12345' }, decision: {}, replyText: '' }), '');
});

test('hasRecentSentAutoReply supports the roomReplyKey field with a long window', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmp-room-replies-'));
  const logPath = path.join(tmpDir, 'auto-replies.ndjson');
  const now = new Date('2026-08-11T12:00:00.000Z');
  const roomKey = 'chat:12345|반납 날짜와 시간을 한 번만 다시 알려주세요!';
  const lines = [
    JSON.stringify({ at: '2026-08-11T02:00:00.000Z', dedupeKey: 'x|y|z', roomReplyKey: roomKey, result: { sent: true } }),
    JSON.stringify({ at: '2026-08-09T02:00:00.000Z', dedupeKey: 'a|b|c', roomReplyKey: roomKey, result: { sent: true } })
  ];
  fs.writeFileSync(logPath, lines.join(String.fromCharCode(10)));

  assert.equal(hasRecentSentAutoReply({ autoSendLogPath: logPath }, roomKey, { now, windowMs: 24 * 60 * 60 * 1000, keyField: 'roomReplyKey' }), true);
  assert.equal(hasRecentSentAutoReply({ autoSendLogPath: logPath }, roomKey, { now: new Date('2026-08-13T12:00:00.000Z'), windowMs: 24 * 60 * 60 * 1000, keyField: 'roomReplyKey' }), false);
  assert.equal(hasRecentSentAutoReply({ autoSendLogPath: logPath }, 'chat:12345|다른 답장', { now, windowMs: 24 * 60 * 60 * 1000, keyField: 'roomReplyKey' }), false);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('offline resolution reports count as terminal acknowledgements under the conservative guards', () => {
  const liveResolved = {
    previewText: '중요 임선 아 그부분 이야기해서 해결됐습니다 오전 9:44',
    customerName: '임선',
    events: [{ reason: 'mutation' }, { reason: 'top_row_changed' }]
  };
  const navigation = {
    status: 'opened_target_chat',
    conversation_evidence: {
      hint_matched: true,
      visible_static_text_tail: ['빌리지님', '전화로 안내드렸습니다', '임선', '아 그부분 이야기해서 해결됐습니다']
    }
  };
  assert.equal(classifyConservativeTerminalAcknowledgement(liveResolved, navigation).matched, true);

  // 운영 맥락(예약/입금/장비 등)이 화면에 남아 있으면 여전히 Hermes 판단으로 넘긴다.
  assert.equal(classifyConservativeTerminalAcknowledgement(liveResolved, {
    ...navigation,
    conversation_evidence: {
      hint_matched: true,
      visible_static_text_tail: ['빌리지님', '입금 확인 후 처리하겠습니다', '임선', '아 그부분 이야기해서 해결됐습니다']
    }
  }).matched, false);

  // 물음표가 있으면 실질 질문이므로 종결로 처리하지 않는다.
  assert.equal(classifyConservativeTerminalAcknowledgement({
    ...liveResolved,
    previewText: '중요 임선 해결됐을까요? 오전 9:45'
  }, navigation).matched, false);
});

test('buildRecentBotSendsPromptText lists only fresh sends for the same room or customer', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmp-recent-sends-'));
  const logPath = path.join(tmpDir, 'auto-replies.ndjson');
  const now = new Date('2026-08-11T12:00:00.000Z');
  const lines = [
    JSON.stringify({ at: '2026-08-11T03:43:00.000Z', customer: '임선', dedupeKey: 'chat:12345|반출 변경|반납 일시를 알려주세요', result: { sent: true, text: '반납 날짜와 시간을 한 번만 다시 알려주세요!' } }),
    JSON.stringify({ at: '2026-08-03T03:43:00.000Z', customer: '임선', dedupeKey: 'chat:12345|옛 메시지|옛 답장', result: { sent: true, text: '7일 밖의 옛 발송' } }),
    JSON.stringify({ at: '2026-08-11T04:00:00.000Z', customer: '박수정', dedupeKey: 'chat:99999|다른 방|다른 답장', result: { sent: true, text: '다른 방 발송' } }),
    JSON.stringify({ at: '2026-08-11T04:05:00.000Z', customer: '임선', dedupeKey: 'chat:77777|동명이인 방|다른 답장', result: { sent: true, text: '다른 방의 동명이인 발송' } }),
    JSON.stringify({ at: '2026-08-11T04:07:00.000Z', customer: '임선', dedupeKey: '임선|방키 없던 발송|답장', result: { sent: true, text: '방 키 없던 시절의 같은 고객 발송' } }),
    JSON.stringify({ at: '2026-08-11T04:10:00.000Z', customer: '임선', dedupeKey: 'chat:12345|차단|차단', result: { sent: false, text: '차단된 시도' } })
  ];
  fs.writeFileSync(logPath, lines.join(String.fromCharCode(10)));

  const block = buildRecentBotSendsPromptText({ autoSendLogPath: logPath }, { room_key: 'chat:12345', customerName: '임선' }, { now });
  assert.match(block, /RECENT_BOT_SENDS/);
  assert.match(block, /반납 날짜와 시간을 한 번만 다시 알려주세요!/);
  assert.doesNotMatch(block, /옛 발송/);
  assert.doesNotMatch(block, /다른 방 발송/);
  assert.doesNotMatch(block, /동명이인 발송/, '방 키를 아는 동명이인 발송은 다른 방에 주입되면 안 된다');
  assert.match(block, /방 키 없던 시절의 같은 고객 발송/, '방 키가 없던 발송은 이름 폴백으로 매칭한다');
  assert.doesNotMatch(block, /차단된 시도/);
  assert.equal(buildRecentBotSendsPromptText({ autoSendLogPath: logPath }, {}, { now }), '');
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('buildHermesPrompt embeds the recent bot sends block and the owner-manual policy lines', () => {
  const sendsBlock = ['', 'RECENT_BOT_SENDS (자동응대 봇이 이 방/고객에게 최근 7일 내 실제 발송한 메시지, 최신이 마지막):', '- [2026-08-11T03:43:00.000Z] 반납 날짜와 시간을 한 번만 다시 알려주세요!', ''].join(String.fromCharCode(10));
  const prompt = buildHermesPrompt({ id: 'job-1' }, { recentBotSends: sendsBlock });
  assert.match(prompt, /RECENT_BOT_SENDS/);
  assert.match(prompt, /사장\(사람\)의 수동 응대/);
  assert.match(prompt, /재확인 질문을 만들지 마라/);
  assert.match(prompt, /알림톡\/브랜드메시지는 관리자센터에서 확인할 수 없어요/);
});
