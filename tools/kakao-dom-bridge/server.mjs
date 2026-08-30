import http from 'node:http';
import os from 'node:os';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import dns from 'node:dns';
import { spawn, spawnSync } from 'node:child_process';
import { buildSlackFollowUpMessage, buildSlackRoutingConfig, deliverSlackFollowUpRows, processManualSend, upsertFollowUpRows } from '../ai-browser-worker/worker.mjs';
import {
  applyPreparedKakaoDecision,
  buildKakaoGatewayTurn,
  captureKakaoRoomSnapshot,
  executeVillageConfirmationRequest,
  fetchExistingConfirmRequestResultForDecision,
  finalizePreparedKakaoDecision,
  loadKakaoWorkerRuntimeConfig,
  prepareKakaoDecisionFromSnapshot,
  prepareKakaoGatewayDecision,
  validateVillageConfirmationExecutionDecision
} from '../ai-browser-worker/worker.mjs';
import { applyFollowUpCaseAction, validateFollowUpCaseAction } from '../ai-browser-worker/follow-up-case-lifecycle.mjs';
import { createHermesGatewayChannel } from './hermes-gateway-channel.mjs';
import { buildGatewayHealthReadback, createHermesGatewayHttpHandler } from './hermes-gateway-http.mjs';
import { executeVillageDocumentRequest } from '../village-doc-send/runner.mjs';
import { executeVillageRegisteredReservationChange } from '../ai-browser-worker/staff-confirmed-mutation.mjs';
import {
  canonicalSourceEventKey,
  loadWorkOrchestratorConfig,
  notificationReceiptInput
} from '../work-orchestrator-v2/contracts.mjs';
import { ensureImmediateNotification } from '../work-orchestrator-v2/immediate-notifications.mjs';
import { digestScheduleWindow, runDigestCycle } from '../work-orchestrator-v2/digest-runner.mjs';
import { processPendingWorkAction } from '../work-orchestrator-v2/work-actions.mjs';
import { recordShadowNotificationObligation } from '../work-orchestrator-v2/shadow-receipts.mjs';
import { createSlackClient } from '../work-orchestrator-v2/slack-client.mjs';
import { createWorkOrchestratorStore } from '../work-orchestrator-v2/supabase-store.mjs';

export { buildGatewayHealthReadback } from './hermes-gateway-http.mjs';

const DEFAULT_VILLAGE_DOCUMENT_API_URL = 'https://script.google.com/macros/s/AKfycbwX2V0SqRf23DCwaVojlc5YFXKTfMNLBt68edpGmCx8j0i9hkYdP_bXHKEGIcde2iS5EA/exec';

function loadSelectedEnvFile(filePath, keys = []) {
  const allowed = new Set(keys);
  if (!filePath || !fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || !allowed.has(match[1]) || process.env[match[1]]) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value;
  }
}

loadSelectedEnvFile(path.resolve(process.env.HOME || process.env.USERPROFILE || os.homedir() || '', '.hermes/.env'), ['SLACK_BOT_TOKEN']);

function readBooleanEnvironment(value, defaultValue = false) {
  if (value === undefined || value === null || String(value).trim() === '') return defaultValue;
  return ['1', 'true'].includes(String(value).trim().toLowerCase());
}

export function resolveHermesTransport(value) {
  const normalized = String(value ?? '').trim() || 'cli';
  if (!['cli', 'gateway', 'gateway_no_send'].includes(normalized)) {
    throw new Error(`Unsupported KAKAO_HERMES_TRANSPORT: ${normalized}`);
  }
  return normalized;
}

export function resolveHermesMaxAttempts(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return 2;
  const attempts = Number(raw);
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 2) {
    throw new Error('KAKAO_HERMES_MAX_ATTEMPTS must be either 1 or 2');
  }
  return attempts;
}

export function kakaoSendAllowedForTransport(value) {
  return resolveHermesTransport(value) !== 'gateway_no_send';
}

export function configForHermesTransport(config = {}, transport = 'cli') {
  return transport === 'gateway_no_send'
    ? { ...config, autoSendEnabled: false, windowsWritesEnabled: false }
    : config;
}

const WORK_ORCHESTRATOR_CONFIG = loadWorkOrchestratorConfig(process.env);

const CONFIG = {
  port: Number(process.env.PORT || 8787),
  debounceMs: Number(process.env.DEBOUNCE_MS || 90_000),
  maxWaitMs: Number(process.env.MAX_WAIT_MS || 300_000),
  startupMutationIgnoreMs: Number(process.env.STARTUP_MUTATION_IGNORE_MS || 4000),
  queueDir: path.resolve(process.env.QUEUE_DIR || './queue'),
  hermesTransport: resolveHermesTransport(process.env.KAKAO_HERMES_TRANSPORT),
  hermesBridgeToken: String(process.env.KAKAO_HERMES_BRIDGE_TOKEN || '').trim(),
  hermesLeaseMs: Number(process.env.KAKAO_HERMES_LEASE_MS || 300_000),
  hermesMaxAttempts: resolveHermesMaxAttempts(process.env.KAKAO_HERMES_MAX_ATTEMPTS),
  documentApiBaseUrl: String(process.env.VILLAGE_DOCUMENT_API_URL || '').trim(),
  documentApiKey: String(process.env.VILLAGE_DOCUMENT_API_KEY || process.env.VILLAGE_OPS_KEY || '').trim(),
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  supabaseTable: process.env.SUPABASE_TABLE || '',
  workOrchestrator: WORK_ORCHESTRATOR_CONFIG,
  processInitialScan: process.env.PROCESS_INITIAL_SCAN !== 'false',
  ignoreShiftedRows: process.env.IGNORE_SHIFTED_ROWS === 'true',
  workerCommand: process.env.VILLAGE_AI_WORKER_CMD || '',
  workerLive: process.env.AI_WORKER_LIVE === '1',
  autoSendEnabled: process.env.AI_WORKER_AUTO_SEND === '1',
  workerDryRun: process.env.AI_WORKER_DRY_RUN === '1',
  windowsWritesEnabled: process.env.VILLAGE_WINDOWS_WRITES_ENABLED === '1',
  // Capability flag: recovery/backstop support exists even when startup DOM
  // initial-scan events are intentionally ignored to prevent duplicate sends.
  startupCatchupSupported: true,
  topRowLiveWindowMinutes: Number(process.env.TOP_ROW_LIVE_WINDOW_MINUTES || 20),
  readBackstopLookbackHours: Number(process.env.READ_BACKSTOP_LOOKBACK_HOURS || 36),
  readBackstopLookbackDays: Number(process.env.READ_BACKSTOP_LOOKBACK_DAYS || 2),
  workerTimeoutMs: Number(process.env.WORKER_TIMEOUT_MS || process.env.HERMES_WORKER_TIMEOUT_MS || 240_000),
  aiDomSplitEnabled: readBooleanEnvironment(process.env.KAKAO_AI_DOM_SPLIT_ENABLED, false),
  aiDecisionConcurrency: Math.max(1, Number(process.env.KAKAO_AI_DECISION_CONCURRENCY || 2)),
  supabaseTimeoutMs: Number(process.env.SUPABASE_TIMEOUT_MS || 7000),
  followUpTable: process.env.SUPABASE_FOLLOW_UP_TABLE || 'ai_follow_up_items',
  supabaseRecoveryEnabled: process.env.SUPABASE_RECOVERY_ENABLED !== 'false',
  supabaseRecoveryIntervalMs: Number(process.env.SUPABASE_RECOVERY_INTERVAL_MS || 300_000),
  supabaseRecoveryBatchSize: Number(process.env.SUPABASE_RECOVERY_BATCH_SIZE || 2),
  supabaseRecoveryLookbackHours: Number(process.env.SUPABASE_RECOVERY_LOOKBACK_HOURS || 36),
  supabaseRecoveryErrorRetryMs: Number(process.env.SUPABASE_RECOVERY_ERROR_RETRY_MS || 900_000),
  supabaseRecoveryMaxAttempts: Number(process.env.SUPABASE_RECOVERY_MAX_ATTEMPTS || 2),
  slackActionPollEnabled: readBooleanEnvironment(process.env.SLACK_ACTION_POLL_ENABLED, true),
  slackActionPollIntervalMs: Number(process.env.SLACK_ACTION_POLL_INTERVAL_MS || 10_000),
  p0SlackEscalationEnabled: readBooleanEnvironment(process.env.P0_SLACK_ESCALATION_ENABLED, true),
  p0SlackEscalationIntervalMs: Math.max(15_000, Number(process.env.P0_SLACK_ESCALATION_INTERVAL_MS || 60_000)),
  // 재알림은 10분에서 시작해 회차마다 2배(상한 1시간) 백오프. 구 기본값
  // 3분 × 160회는 2026-08-19 야간 @channel 308연발 사고로 폐기.
  p0SlackEscalationRepeatMs: Math.max(60_000, Number(process.env.P0_SLACK_ESCALATION_REPEAT_MS || 600_000)),
  p0SlackEscalationMaxIntervalMs: Math.max(60_000, Number(process.env.P0_SLACK_ESCALATION_MAX_INTERVAL_MS || 3_600_000)),
  p0SlackEscalationClaimTtlMs: Math.max(30_000, Number(process.env.P0_SLACK_ESCALATION_CLAIM_TTL_MS || 120_000)),
  // 0 = 재알림 전면 비활성. 미설정·이상값은 3회.
  p0SlackEscalationMaxAttempts: (() => {
    const parsed = Number(process.env.P0_SLACK_ESCALATION_MAX_ATTEMPTS);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 3;
  })(),
  slackBotToken: process.env.SLACK_BOT_TOKEN || '',
  followUpRowsEnabled: process.env.AI_WORKER_FOLLOW_UP_ITEMS_ENABLED !== '0' && process.env.KAKAO_FOLLOW_UP_ITEMS_ENABLED !== '0',
  slackCardDeliveryEnabled: process.env.SLACK_AGENT_CARD_DELIVERY_ENABLED === '1',
  slackChannels: {
    schedule: process.env.SLACK_CHANNEL_SCHEDULE_AGENT || '스케쥴-agent',
    document: process.env.SLACK_CHANNEL_DOCUMENT_AGENT || '서류발송-agent',
    settlement: process.env.SLACK_CHANNEL_SETTLEMENT_AGENT || '정산-agent',
    inventory: process.env.SLACK_CHANNEL_INVENTORY_AGENT || '재고관리-agent',
    other: process.env.SLACK_CHANNEL_OTHER_AGENT || '기타문의'
  },
  manualSendDedupeWindowMs: Number(process.env.MANUAL_SEND_DEDUPE_WINDOW_MS || 10 * 60_000),
  kakaoDevtoolsUrl: (process.env.KAKAO_DEVTOOLS_URL || process.env.KAKAO_CDP_HTTP_URL || process.env.KAKAO_CDP_URL || '').replace(/\/+$/, ''),
  kakaoRemoteDebuggingPort: process.env.KAKAO_REMOTE_DEBUGGING_PORT || process.env.VILLAGE_KAKAO_REMOTE_DEBUGGING_PORT || '9223',
  kakaoTabCleanupEnabled: readBooleanEnvironment(process.env.KAKAO_TAB_CLEANUP_ENABLED, true),
  kakaoTabCleanupIntervalMs: Number(process.env.KAKAO_TAB_CLEANUP_INTERVAL_MS || 120_000),
  // The extension can emit a full DOM payload for every mutation. Keep queue
  // diagnostics bounded so observability cannot consume the host disk and
  // starve the watcher that it is meant to protect.
  queueLogMaxBytes: Math.max(1 * 1024 * 1024, Number(process.env.QUEUE_LOG_MAX_BYTES || 32 * 1024 * 1024)),
  queueLogArchiveCount: Math.max(1, Number(process.env.QUEUE_LOG_ARCHIVE_COUNT || 10)),
  dnsFallbackServers: String(process.env.DNS_FALLBACK_SERVERS || '168.126.63.1,168.126.63.2,1.1.1.1')
    .split(',')
    .map((server) => server.trim())
    .filter(Boolean)
};

export function buildHealthConfig(config = {}) {
  const health = {
    workerLive: Boolean(config.workerLive),
    autoSendEnabled: Boolean(config.autoSendEnabled),
    workerDryRun: Boolean(config.workerDryRun),
    windowsWritesEnabled: Boolean(config.windowsWritesEnabled),
    startupCatchupSupported: Boolean(config.startupCatchupSupported)
  };
  if (config.workOrchestrator) {
    health.workOrchestrator = {
      shadowWrites: Boolean(config.workOrchestrator.shadowWrites),
      immediateEnabled: Boolean(config.workOrchestrator.immediateEnabled),
      workItemsEnabled: Boolean(config.workOrchestrator.workItemsEnabled),
      digestEnabled: Boolean(config.workOrchestrator.digestEnabled),
      cleanupEnabled: Boolean(config.workOrchestrator.cleanupEnabled),
      storeConfigured: Boolean(config.workOrchestratorStoreConfigured),
      // True means shadow writes are disabled or the local store client was constructed; it does not prove Supabase connectivity.
      shadowReady: Boolean(config.workOrchestratorShadowReady),
      // This proves local values and clients were constructed only. Durable-store and Slack connectivity require separate readback.
      immediateLocalConfigReady: Boolean(config.workOrchestratorImmediateLocalConfigReady),
      ...(Object.hasOwn(config, 'workOrchestratorDigestLocalConfigReady')
        ? { digestLocalConfigReady: Boolean(config.workOrchestratorDigestLocalConfigReady) }
        : {}),
      ...(Object.hasOwn(config, 'workOrchestratorActionLocalConfigReady')
        ? { actionLocalConfigReady: Boolean(config.workOrchestratorActionLocalConfigReady) }
        : {})
    };
  }
  return health;
}

function genericShadowError(value) {
  if (value === 'shadow_receipt_store_failed') return 'shadow_receipt_store_failed';
  if (value === 'shadow_store_unavailable') return 'shadow_store_unavailable';
  return 'shadow_receipt_failed';
}

function safeShadowTimestamp(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

function safeShadowOutcome(value) {
  return ['created', 'duplicate', 'error', 'configuration_error'].includes(value)
    ? value
    : 'error';
}

export function buildWorkOrchestratorHealthState(value = {}) {
  const receipt = value.lastShadowReceipt;
  const backlogReadback = ['disabled', 'not_checked', 'ok', 'error'].includes(value.immediateBacklogReadback)
    ? value.immediateBacklogReadback
    : 'disabled';
  const hasOldestAge = value.oldestPendingNotificationAgeMs !== null
    && value.oldestPendingNotificationAgeMs !== undefined
    && value.oldestPendingNotificationAgeMs !== '';
  const oldestAge = Number(value.oldestPendingNotificationAgeMs);
  const health = {
    shadowClaims: Math.max(0, Number(value.shadowClaims || 0)),
    shadowDuplicates: Math.max(0, Number(value.shadowDuplicates || 0)),
    shadowErrors: Math.max(0, Number(value.shadowErrors || 0)),
    lastShadowReceipt: receipt && typeof receipt === 'object'
      ? {
          at: safeShadowTimestamp(receipt.at),
          outcome: safeShadowOutcome(receipt.outcome),
          ...(receipt.error ? { error: genericShadowError(receipt.error) } : {})
        }
      : null,
    immediateDelivered: Math.max(0, Number(value.immediateDelivered || 0)),
    immediateDuplicates: Math.max(0, Number(value.immediateDuplicates || 0)),
    immediateFailed: Math.max(0, Number(value.immediateFailed || 0)),
    oldestPendingNotificationAgeMs: hasOldestAge && Number.isFinite(oldestAge) && oldestAge >= 0 ? oldestAge : null,
    immediateBacklogReadback: backlogReadback
  };
  const hasWorkActionState = ['workActionPollRunning', 'lastWorkActionPoll']
    .some((key) => Object.hasOwn(value, key));
  const actionCount = (input) => Number.isSafeInteger(input) && input >= 0 && input <= 10 ? input : 0;
  const action = value.lastWorkActionPoll;
  const safeAction = hasWorkActionState && action && typeof action === 'object' && !Array.isArray(action)
    ? {
        status: ['ok', 'error', 'disabled', 'running'].includes(action.status) ? action.status : 'error',
        trigger: ['startup', 'interval', 'manual'].includes(action.trigger) ? action.trigger : 'manual',
        scanned: actionCount(action.scanned),
        applied: actionCount(action.applied),
        awaitingResolution: actionCount(action.awaitingResolution),
        conflicts: actionCount(action.conflicts),
        invalid: actionCount(action.invalid)
      }
    : null;
  const healthWithActions = hasWorkActionState
    ? { ...health, workActionPollRunning: value.workActionPollRunning === true, lastWorkActionPoll: safeAction }
    : health;
  const hasDigestState = [
    'digestRunning', 'lastDigestRun', 'lastDigestSuccessAt', 'lastDigestFailureAt',
    'nextScheduledAt', 'digestFailureCount', 'omittedEligibleCount'
  ].some((key) => Object.hasOwn(value, key));
  if (!hasDigestState) return healthWithActions;

  const count = (input, maximum) => {
    const numeric = input;
    return Number.isSafeInteger(numeric) && numeric >= 0 && numeric <= maximum ? numeric : 0;
  };
  const safeLastRun = (run) => {
    if (!run || typeof run !== 'object' || Array.isArray(run)) return null;
    const status = ['delivered', 'not_claimed', 'failed'].includes(run.status) ? run.status : 'failed';
    const trigger = ['startup', 'interval', 'manual'].includes(run.trigger) ? run.trigger : 'manual';
    const result = {
      at: safeShadowTimestamp(run.at),
      trigger,
      status,
      scheduledAt: safeShadowTimestamp(run.scheduledAt),
      selectedCount: count(run.selectedCount, 500),
      renderedCount: count(run.renderedCount, 500),
      omittedEligibleCount: count(run.omittedEligibleCount, 500),
      partCount: count(run.partCount, 50),
      deliveredPartCount: count(run.deliveredPartCount, 50),
      cleanupFailed: count(run.cleanupFailed, 500)
    };
    if (run.error) {
      result.error = ['digest_claim_failed', 'digest_build_failed', 'digest_delivery_failed',
        'digest_delivery_unconfirmed', 'digest_cycle_failed',
        'digest_omission_detected', 'digest_cleanup_failed'].includes(run.error)
        ? run.error
        : 'digest_cycle_failed';
    }
    return result;
  };
  return {
    ...healthWithActions,
    digestRunning: value.digestRunning === true,
    lastDigestRun: safeLastRun(value.lastDigestRun),
    lastDigestSuccessAt: safeShadowTimestamp(value.lastDigestSuccessAt) || null,
    lastDigestFailureAt: safeShadowTimestamp(value.lastDigestFailureAt) || null,
    nextScheduledAt: safeShadowTimestamp(value.nextScheduledAt) || null,
    digestFailureCount: count(value.digestFailureCount, Number.MAX_SAFE_INTEGER),
    omittedEligibleCount: count(value.omittedEligibleCount, 500)
  };
}

export function createWorkOrchestratorShadowRuntime({
  config = {},
  store = null,
  record = recordShadowNotificationObligation,
  now = () => new Date().toISOString()
} = {}) {
  const state = {
    shadowClaims: 0,
    shadowDuplicates: 0,
    shadowErrors: 0,
    lastShadowReceipt: null
  };
  const active = new Set();

  if (config.shadowWrites && !store) {
    state.shadowErrors = 1;
    state.lastShadowReceipt = {
      at: String(now()).slice(0, 40),
      outcome: 'configuration_error',
      error: 'shadow_store_unavailable'
    };
  }

  return {
    state,
    recordAccepted(event, roomVersion = {}) {
      if (roomVersion.changed !== true) return null;

      let claim;
      try {
        claim = Promise.resolve(record({ event, config, store }));
      } catch {
        claim = Promise.resolve({ skipped: false, created: false, error: 'shadow_receipt_failed' });
      }
      const observed = claim.then((result) => {
        if (result?.skipped === true) return result;
        const at = String(now()).slice(0, 40);
        if (result?.created === true) {
          state.shadowClaims += 1;
          state.lastShadowReceipt = { at, outcome: 'created' };
        } else if (!result?.error && result?.created === false) {
          state.shadowDuplicates += 1;
          state.lastShadowReceipt = { at, outcome: 'duplicate' };
        } else {
          state.shadowErrors += 1;
          state.lastShadowReceipt = {
            at,
            outcome: 'error',
            error: genericShadowError(result?.error)
          };
        }
        return result;
      }, () => {
        state.shadowErrors += 1;
        state.lastShadowReceipt = {
          at: String(now()).slice(0, 40),
          outcome: 'error',
          error: 'shadow_receipt_failed'
        };
      }).finally(() => active.delete(observed));
      active.add(observed);
      return observed;
    },
    settled() {
      return Promise.allSettled([...active]);
    }
  };
}

const IMMEDIATE_FAILURE_CODES = new Set([
  'attempts_exhausted',
  'claim_conflict',
  'clock_unavailable',
  'delivery_persistence_failed',
  'history_no_match',
  'history_unavailable',
  'post_rejected',
  'receipt_identity_invalid',
  'receipt_persistence_failed',
  'receipt_state_unavailable',
  'receipt_unavailable'
]);

function genericImmediateFailureCode(value) {
  return IMMEDIATE_FAILURE_CODES.has(value) ? value : 'immediate_notification_failed';
}

function immediateRuntimeDate(now) {
  const value = now();
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Immediate notification clock is invalid');
  return date;
}

const IMMEDIATE_ATTEMPT_FILENAME = 'immediate-notification-attempts.ndjson';
const IMMEDIATE_ATTEMPT_DIGEST = /^[0-9a-f]{64}$/;

function immediateAttemptDigest(sourceEventKey) {
  return sha256(`village-immediate-notification-attempt:${canonicalSourceEventKey(sourceEventKey)}`);
}

function createMemoryImmediateNotificationAttemptGuard(maxEntries = 10_000) {
  const entries = new Map();
  return {
    claim(sourceEventKey) {
      const digest = immediateAttemptDigest(sourceEventKey);
      if (entries.has(digest)) return false;
      entries.set(digest, true);
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
      return true;
    }
  };
}

export function createImmediateNotificationAttemptGuard({
  queueDir = CONFIG.queueDir,
  maxEntries = 10_000,
  fileSystem = fs
} = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 100_000) {
    throw new Error('Immediate notification attempt guard configuration is invalid');
  }
  const resolvedQueueDir = path.resolve(queueDir);
  const filePath = path.join(resolvedQueueDir, IMMEDIATE_ATTEMPT_FILENAME);
  const entries = new Map();

  const serialized = (source) => [...source.keys()]
    .map((digest) => `${JSON.stringify({ source_event_key_sha256: digest })}\n`)
    .join('');

  const atomicReplace = (nextEntries) => {
    fileSystem.mkdirSync(resolvedQueueDir, { recursive: true });
    const temporaryPath = path.join(
      resolvedQueueDir,
      `.${IMMEDIATE_ATTEMPT_FILENAME}.${process.pid}.${crypto.randomUUID()}.tmp`
    );
    let descriptor = null;
    try {
      descriptor = fileSystem.openSync(temporaryPath, 'wx');
      fileSystem.writeFileSync(descriptor, serialized(nextEntries), 'utf8');
      if (typeof fileSystem.fsyncSync === 'function') fileSystem.fsyncSync(descriptor);
      fileSystem.closeSync(descriptor);
      descriptor = null;
      fileSystem.renameSync(temporaryPath, filePath);
    } catch {
      if (descriptor !== null) {
        try { fileSystem.closeSync(descriptor); } catch {}
      }
      try { fileSystem.unlinkSync(temporaryPath); } catch {}
      throw new Error('Immediate notification attempt guard is unavailable');
    }
  };

  try {
    const lines = fileSystem.readFileSync(filePath, 'utf8').split(/\r?\n/);
    const loadedEntries = new Map();
    for (const [index, line] of lines.entries()) {
      if (line === '' && index === lines.length - 1) continue;
      if (!line) throw new Error('invalid attempt guard record');
      const record = JSON.parse(line);
      if (
        !record
        || typeof record !== 'object'
        || Array.isArray(record)
        || Object.keys(record).length !== 1
        || !IMMEDIATE_ATTEMPT_DIGEST.test(record.source_event_key_sha256)
      ) throw new Error('invalid attempt guard record');
      loadedEntries.delete(record.source_event_key_sha256);
      loadedEntries.set(record.source_event_key_sha256, true);
    }
    if (loadedEntries.size > maxEntries) {
      const boundedEntries = new Map([...loadedEntries.entries()].slice(-maxEntries));
      atomicReplace(boundedEntries);
      for (const [digest] of boundedEntries) entries.set(digest, true);
    } else {
      for (const [digest] of loadedEntries) entries.set(digest, true);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error('Immediate notification attempt guard is unavailable');
  }

  return {
    claim(sourceEventKey) {
      const digest = immediateAttemptDigest(sourceEventKey);
      if (entries.has(digest)) return false;
      if (entries.size >= maxEntries) {
        const nextEntries = new Map(entries);
        nextEntries.set(digest, true);
        while (nextEntries.size > maxEntries) nextEntries.delete(nextEntries.keys().next().value);
        atomicReplace(nextEntries);
        entries.clear();
        for (const [nextDigest] of nextEntries) entries.set(nextDigest, true);
        return true;
      }

      entries.set(digest, true);
      try {
        fileSystem.mkdirSync(resolvedQueueDir, { recursive: true });
        fileSystem.appendFileSync(
          filePath,
          `${JSON.stringify({ source_event_key_sha256: digest })}\n`,
          'utf8'
        );
      } catch {
        throw new Error('Immediate notification attempt guard is unavailable');
      }
      return true;
    }
  };
}

export function createWorkOrchestratorImmediateRuntime({
  config = {},
  store = null,
  slack = null,
  slackToken = '',
  ensure = ensureImmediateNotification,
  now = () => new Date(),
  state: sharedState = null,
  attemptGuard = null
} = {}) {
  const enabled = config.immediateEnabled === true;
  const inboxChannelId = String(config.inboxChannelId || '').trim();
  const storeReady = Boolean(
    store
    && typeof store.getNotificationByEventKey === 'function'
    && typeof store.getOldestPendingNotificationCreatedAt === 'function'
  );
  const slackReady = Boolean(
    slack
    && typeof slack.postMessage === 'function'
    && typeof slack.findMessageByClientId === 'function'
  );
  const localConfigReady = Boolean(
    enabled
    && storeReady
    && slackReady
    && String(slackToken || '').trim()
    && inboxChannelId
    && typeof ensure === 'function'
  );
  if (enabled && !localConfigReady) {
    throw new Error('Work Orchestrator immediate notification local configuration is missing');
  }
  const resolvedAttemptGuard = attemptGuard || createMemoryImmediateNotificationAttemptGuard();
  if (!resolvedAttemptGuard || typeof resolvedAttemptGuard.claim !== 'function') {
    throw new Error('Work Orchestrator immediate notification attempt guard is missing');
  }

  const runtimeState = sharedState && typeof sharedState === 'object' ? sharedState : {};
  runtimeState.shadowClaims = Math.max(0, Number(runtimeState.shadowClaims || 0));
  runtimeState.shadowDuplicates = Math.max(0, Number(runtimeState.shadowDuplicates || 0));
  runtimeState.shadowErrors = Math.max(0, Number(runtimeState.shadowErrors || 0));
  runtimeState.lastShadowReceipt = runtimeState.lastShadowReceipt || null;
  runtimeState.immediateDelivered = Math.max(0, Number(runtimeState.immediateDelivered || 0));
  runtimeState.immediateDuplicates = Math.max(0, Number(runtimeState.immediateDuplicates || 0));
  runtimeState.immediateFailed = Math.max(0, Number(runtimeState.immediateFailed || 0));
  runtimeState.oldestPendingNotificationAgeMs = null;
  runtimeState.immediateBacklogReadback = enabled ? 'not_checked' : 'disabled';

  const fail = (error) => {
    runtimeState.immediateFailed += 1;
    const wrapped = new Error('Immediate notification is unconfirmed');
    wrapped.code = genericImmediateFailureCode(error?.code);
    throw wrapped;
  };

  const deliverAccepted = async (event, roomVersion = {}) => {
    if (!enabled) return null;
    try {
      const sourceEventKey = notificationReceiptInput(event).sourceEventKey;
      const firstAttempt = resolvedAttemptGuard.claim(sourceEventKey);
      if (typeof firstAttempt !== 'boolean') {
        const guardError = new Error('Exact notification attempt guard result is invalid');
        guardError.code = 'delivery_persistence_failed';
        throw guardError;
      }
      if (!firstAttempt) {
        let existing;
        try {
          existing = await store.getNotificationByEventKey(sourceEventKey);
        } catch {
          const lookupError = new Error('Exact notification receipt lookup failed');
          lookupError.code = 'delivery_persistence_failed';
          throw lookupError;
        }
        if (!existing) {
          const missingReceipt = new Error('Exact notification receipt is unavailable');
          missingReceipt.code = 'receipt_unavailable';
          throw missingReceipt;
        }
      }

      const result = await ensure({
        event,
        config: {
          inboxChannelId,
          mentionUserIds: Array.isArray(config.mentionUserIds) ? config.mentionUserIds : []
        },
        store,
        slack,
        now
      });
      if (result?.status !== 'delivered') {
        const resultError = new Error('Immediate notification result is unconfirmed');
        resultError.code = 'delivery_persistence_failed';
        throw resultError;
      }
      const duplicate = result.delivery === null;
      if (duplicate) runtimeState.immediateDuplicates += 1;
      else runtimeState.immediateDelivered += 1;
      return {
        status: 'delivered',
        duplicate,
        reconciled: result.reconciled === true
      };
    } catch (error) {
      return fail(error);
    }
  };

  const refreshBacklogHealth = async () => {
    if (!enabled) {
      runtimeState.oldestPendingNotificationAgeMs = null;
      runtimeState.immediateBacklogReadback = 'disabled';
      return;
    }
    try {
      const createdAt = await store.getOldestPendingNotificationCreatedAt();
      if (createdAt === null) {
        runtimeState.oldestPendingNotificationAgeMs = null;
      } else {
        const createdAtMs = Date.parse(createdAt);
        if (!Number.isFinite(createdAtMs)) throw new Error('Immediate backlog response is invalid');
        runtimeState.oldestPendingNotificationAgeMs = Math.max(0, immediateRuntimeDate(now).getTime() - createdAtMs);
      }
      runtimeState.immediateBacklogReadback = 'ok';
    } catch {
      runtimeState.oldestPendingNotificationAgeMs = null;
      runtimeState.immediateBacklogReadback = 'error';
    }
  };

  return {
    enabled,
    localConfigReady,
    state: runtimeState,
    store,
    deliverAccepted,
    refreshBacklogHealth
  };
}

const DIGEST_STORE_METHODS = [
  'claimDigestRun', 'listActionableWork', 'prepareDigestParts', 'claimDigestPartDelivery',
  'markDigestPartDelivered', 'markDigestPartFailed', 'finalizeDigestRun', 'failDigestRun',
  'listDigestCleanupBacklog', 'claimDigestPartCleanup', 'recordDigestPartCleanup'
];

const WORK_ACTION_ROW_FIELDS = Object.freeze([
  'id', 'state', 'priority', 'actionable_at', 'snoozed_until', 'resolution_kind',
  'resolution_evidence', 'resolved_at', 'resolved_by', 'pending_action', 'version',
  'payload', 'updated_at'
]);
const WORK_ACTION_PATCH_FIELDS = new Set([
  'state', 'actionable_at', 'snoozed_until', 'payload', 'resolution_kind',
  'resolution_evidence', 'resolved_at', 'resolved_by', 'pending_action', 'version', 'updated_at'
]);
const WORK_ACTION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const WORK_ACTION_ACTIVE_STATES = new Set(['open', 'in_progress', 'snoozed']);
const WORK_ACTION_TRIGGERS = new Set(['startup', 'interval', 'manual']);
const WORK_ACTION_TIMESTAMP_FIELDS = new Set(['actionable_at', 'snoozed_until', 'resolved_at']);

function workActionRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function workActionExactKeys(value, allowed) {
  if (!workActionRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function workActionSameJson(left, right) {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => workActionSameJson(value, right[index]));
  }
  if (!workActionRecord(left) || !workActionRecord(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && workActionSameJson(left[key], right[key]));
}

function safeWorkActionTrigger(value) {
  return WORK_ACTION_TRIGGERS.has(value) ? value : 'manual';
}

function safeWorkActionPollResult(value, trigger) {
  const empty = {
    status: 'error', trigger: safeWorkActionTrigger(trigger), scanned: 0, applied: 0,
    awaitingResolution: 0, conflicts: 0, invalid: 0
  };
  if (!workActionRecord(value) || !['ok', 'error', 'disabled', 'running'].includes(value.status)
    || value.trigger !== empty.trigger) return empty;
  const result = { status: value.status, trigger: value.trigger };
  for (const key of ['scanned', 'applied', 'awaitingResolution', 'conflicts', 'invalid']) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0 || value[key] > 10) return empty;
    result[key] = value[key];
  }
  if (result.applied + result.awaitingResolution + result.conflicts + result.invalid > result.scanned) return empty;
  return result;
}

function validatePendingWorkActionRow(row) {
  if (!workActionExactKeys(row, WORK_ACTION_ROW_FIELDS)
    || typeof row.id !== 'string' || !WORK_ACTION_UUID.test(row.id)
    || !WORK_ACTION_ACTIVE_STATES.has(row.state)
    || !Number.isSafeInteger(row.version) || row.version < 2
    || !workActionRecord(row.pending_action) || row.pending_action.status !== 'pending') {
    throw new Error('Work Orchestrator action response invalid');
  }
  return row;
}

async function workActionFetchJson(url, init, fetchImpl) {
  try {
    const response = await fetchImpl(url, init);
    const text = await response.text();
    if (!response.ok) throw new Error('invalid');
    return JSON.parse(text);
  } catch {
    throw new Error('Work Orchestrator action request failed');
  }
}

function workActionHeaders(serviceRoleKey, prefer = null) {
  const headers = {
    apikey: serviceRoleKey,
    authorization: `Bearer ${serviceRoleKey}`,
    'content-type': 'application/json'
  };
  if (prefer) headers.prefer = prefer;
  return headers;
}

function workActionEndpoint(supabaseUrl) {
  const base = String(supabaseUrl || '').trim().replace(/\/$/, '');
  if (!/^https?:\/\/[^\s]+$/i.test(base)) throw new Error('Work Orchestrator action configuration invalid');
  return `${base}/rest/v1/work_items_v2`;
}

export async function listPendingWorkActionsV2({
  supabaseUrl,
  serviceRoleKey,
  limit = 3,
  fetchImpl = fetch
} = {}) {
  try {
    const key = String(serviceRoleKey || '').trim();
    if (!key || typeof fetchImpl !== 'function'
      || !Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new Error('invalid');
    const url = new URL(workActionEndpoint(supabaseUrl));
    url.searchParams.set('select', WORK_ACTION_ROW_FIELDS.join(','));
    url.searchParams.set('state', 'in.(open,in_progress,snoozed)');
    url.searchParams.set('pending_action->>status', 'eq.pending');
    url.searchParams.set('order', 'updated_at.asc');
    url.searchParams.set('limit', String(limit));
    const data = await workActionFetchJson(url.toString(), {
      method: 'GET', headers: workActionHeaders(key)
    }, fetchImpl);
    if (!Array.isArray(data) || data.length > limit) throw new Error('invalid');
    return data.map(validatePendingWorkActionRow);
  } catch {
    throw new Error('Work Orchestrator action request failed');
  }
}

function validateWorkActionPatch(row, transition) {
  if (!workActionRecord(transition) || transition.status !== 'ready'
    || transition.expectedVersion !== row.version || transition.expectedPendingStatus !== 'pending'
    || !workActionRecord(transition.patch)
    || !workActionExactKeys(transition.patch.pending_action, [])
    || transition.patch.version !== row.version + 1
    || typeof transition.patch.updated_at !== 'string'
    || !Number.isFinite(Date.parse(transition.patch.updated_at))) throw new Error('invalid');
  const keys = Object.keys(transition.patch);
  if (keys.some((key) => !WORK_ACTION_PATCH_FIELDS.has(key))
    || !keys.includes('pending_action') || !keys.includes('version') || !keys.includes('updated_at')) {
    throw new Error('invalid');
  }
  return transition.patch;
}

export async function applyPendingWorkActionPatchV2({
  supabaseUrl,
  serviceRoleKey,
  row,
  transition,
  fetchImpl = fetch
} = {}) {
  try {
    validatePendingWorkActionRow(row);
    const patch = validateWorkActionPatch(row, transition);
    const databasePatch = Object.fromEntries(
      Object.entries(patch).filter(([field]) => field !== 'updated_at')
    );
    const key = String(serviceRoleKey || '').trim();
    if (!key || typeof fetchImpl !== 'function') throw new Error('invalid');
    const url = new URL(workActionEndpoint(supabaseUrl));
    url.searchParams.set('select', WORK_ACTION_ROW_FIELDS.join(','));
    url.searchParams.set('id', `eq.${row.id}`);
    url.searchParams.set('version', `eq.${row.version}`);
    url.searchParams.set('state', 'in.(open,in_progress,snoozed)');
    url.searchParams.set('pending_action->>status', 'eq.pending');
    const data = await workActionFetchJson(url.toString(), {
      method: 'PATCH',
      headers: workActionHeaders(key, 'return=representation'),
      body: JSON.stringify(databasePatch)
    }, fetchImpl);
    if (!Array.isArray(data) || data.length > 1) throw new Error('invalid');
    if (data.length === 0) return { applied: false };
    const updated = validatePendingWorkActionRowAfterApply(data[0], row, databasePatch);
    if (!updated) throw new Error('invalid');
    return { applied: true };
  } catch {
    throw new Error('Work Orchestrator action request failed');
  }
}

function validatePendingWorkActionRowAfterApply(updated, row, patch) {
  if (!workActionExactKeys(updated, WORK_ACTION_ROW_FIELDS)
    || updated.id !== row.id || updated.version !== patch.version
    || !workActionExactKeys(updated.pending_action, [])
    || typeof updated.updated_at !== 'string' || !Number.isFinite(Date.parse(updated.updated_at))) return false;
  return Object.entries(patch).every(([key, value]) => {
    if (WORK_ACTION_TIMESTAMP_FIELDS.has(key) && value !== null) {
      return typeof updated[key] === 'string'
        && Number.isFinite(Date.parse(updated[key]))
        && Date.parse(updated[key]) === Date.parse(value);
    }
    return workActionSameJson(updated[key], value);
  });
}

export function createWorkOrchestratorActionPoller({
  config = {},
  storeReady = false,
  list = null,
  apply = null,
  now = () => new Date(),
  state: sharedState = null
} = {}) {
  const localState = sharedState && workActionRecord(sharedState) ? sharedState : {};
  const enabled = config.workItemsEnabled === true && storeReady === true
    && typeof list === 'function' && typeof apply === 'function';
  let running = false;

  const poll = async (reason = 'interval') => {
    const trigger = safeWorkActionTrigger(reason);
    const result = {
      status: enabled ? 'ok' : 'disabled', trigger, scanned: 0, applied: 0,
      awaitingResolution: 0, conflicts: 0, invalid: 0
    };
    if (!enabled) return result;
    if (running) return { ...result, status: 'running' };
    running = true;
    localState.workActionPollRunning = true;
    try {
      let changedAt;
      try {
        const supplied = typeof now === 'function' ? now() : now;
        const date = supplied instanceof Date ? new Date(supplied.getTime()) : new Date(supplied);
        if (Number.isNaN(date.getTime())) throw new Error('invalid');
        changedAt = date.toISOString();
      } catch {
        result.status = 'error';
        return result;
      }
      let rows;
      try {
        rows = await list({ limit: 10, now: changedAt });
        if (!Array.isArray(rows) || rows.length > 10) throw new Error('invalid');
      } catch {
        result.status = 'error';
        return result;
      }
      result.scanned = rows.length;
      for (const row of rows) {
        let transition;
        try {
          transition = processPendingWorkAction({ row, action: row?.pending_action, now: changedAt });
        } catch {
          result.invalid += 1;
          continue;
        }
        if (transition.status === 'awaiting_authoritative_resolution') {
          result.awaitingResolution += 1;
          continue;
        }
        try {
          const applied = await apply({ row, transition });
          if (!workActionExactKeys(applied, ['applied']) || typeof applied.applied !== 'boolean') throw new Error('invalid');
          if (applied.applied) result.applied += 1;
          else result.conflicts += 1;
        } catch {
          result.status = 'error';
        }
      }
      return result;
    } finally {
      running = false;
      localState.workActionPollRunning = false;
      localState.lastWorkActionPoll = safeWorkActionPollResult(result, trigger);
    }
  };

  return { enabled, localConfigReady: enabled, state: localState, poll };
}

export async function runSlackActionPollPair({
  reason = 'manual',
  legacy = null,
  workActions = null
} = {}) {
  const trigger = safeWorkActionTrigger(reason);
  const result = { legacy: null, workOrchestratorV2: null };
  try {
    result.legacy = typeof legacy === 'function' ? await legacy() : null;
  } catch {
    result.legacyError = true;
  }
  try {
    result.workOrchestratorV2 = workActions && typeof workActions.poll === 'function'
      ? safeWorkActionPollResult(await workActions.poll(trigger), trigger)
      : safeWorkActionPollResult({
          status: 'disabled', trigger, scanned: 0, applied: 0,
          awaitingResolution: 0, conflicts: 0, invalid: 0
        }, trigger);
  } catch {
    result.workOrchestratorV2 = safeWorkActionPollResult(null, trigger);
  }
  return result;
}

export function slackActionMaintenanceSucceeded(result = {}) {
  if (!workActionRecord(result) || result.legacyError === true) return false;
  const legacyErrors = Array.isArray(result.errors)
    ? result.errors
    : (Array.isArray(result.legacy?.errors) ? result.legacy.errors : []);
  return legacyErrors.length === 0
    && workActionRecord(result.workOrchestratorV2)
    && result.workOrchestratorV2.status !== 'error';
}

function digestRuntimeIso(now) {
  let value;
  try {
    value = typeof now === 'function' ? now() : now;
  } catch {
    throw new Error('Work Orchestrator digest clock is invalid');
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error('Work Orchestrator digest clock is invalid');
  return date.toISOString();
}

function digestRuntimeCount(value, maximum) {
  const numeric = value;
  if (!Number.isSafeInteger(numeric) || numeric < 0 || numeric > maximum) {
    throw new Error('Work Orchestrator digest result is invalid');
  }
  return numeric;
}

function safeDigestRuntimeResult(value, scheduledAt) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !['delivered', 'not_claimed', 'failed'].includes(value.status)) {
    throw new Error('Work Orchestrator digest result is invalid');
  }
  const selectedCount = digestRuntimeCount(value.selectedCount, 500);
  const renderedCount = digestRuntimeCount(value.renderedCount, 500);
  const partCount = digestRuntimeCount(value.partCount, 50);
  const deliveredPartCount = digestRuntimeCount(value.deliveredPartCount, 50);
  if (renderedCount > selectedCount || deliveredPartCount > partCount) {
    throw new Error('Work Orchestrator digest result is invalid');
  }
  const cleanup = value.cleanup;
  if (!cleanup || typeof cleanup !== 'object' || Array.isArray(cleanup)) {
    throw new Error('Work Orchestrator digest result is invalid');
  }
  const safeCleanup = {
    attempted: digestRuntimeCount(cleanup.attempted, 500),
    settled: digestRuntimeCount(cleanup.settled, 500),
    failed: digestRuntimeCount(cleanup.failed, 500)
  };
  const exactOmission = selectedCount - renderedCount;
  const resultScheduledAt = safeShadowTimestamp(value.scheduledAt);
  if (!resultScheduledAt || resultScheduledAt !== scheduledAt) {
    throw new Error('Work Orchestrator digest result is invalid');
  }
  const result = {
    status: value.status,
    scheduledAt: resultScheduledAt,
    runId: typeof value.runId === 'string' && /^[0-9a-f-]{36}$/i.test(value.runId) ? value.runId : null,
    selectedCount,
    renderedCount,
    omittedEligibleCount: exactOmission,
    partCount,
    deliveredPartCount,
    cleanup: safeCleanup
  };
  if (value.retryable === true) result.retryable = true;
  if (value.status === 'failed') {
    result.error = [
      'digest_claim_failed', 'digest_build_failed', 'digest_delivery_failed', 'digest_delivery_unconfirmed'
    ].includes(value.error)
      ? value.error
      : 'digest_cycle_failed';
  }
  return result;
}

export function createWorkOrchestratorDigestRuntime({
  config = {},
  store = null,
  slack = null,
  run = runDigestCycle,
  now = () => new Date(),
  leaseOwner = `bridge:digest:${process.pid}`,
  state: sharedState = null,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval
} = {}) {
  const enabled = config.digestEnabled === true;
  const channelId = String(config.digestChannelId || '').trim();
  const intervalMinutes = config.digestIntervalMinutes === undefined ? 180 : Number(config.digestIntervalMinutes);
  const cleanupEnabled = config.cleanupEnabled === true;
  const storeReady = Boolean(store && DIGEST_STORE_METHODS.every((method) => typeof store[method] === 'function'));
  const slackReady = Boolean(slack
    && typeof slack.postMessage === 'function'
    && typeof slack.findMessageByClientId === 'function'
    && (!cleanupEnabled || typeof slack.deleteMessage === 'function'));
  const localConfigReady = Boolean(enabled
    && storeReady
    && slackReady
    && /^[A-Z0-9][A-Z0-9_-]{0,79}$/.test(channelId)
    && Number.isSafeInteger(intervalMinutes)
    && intervalMinutes >= 60
    && intervalMinutes <= 7 * 24 * 60
    && typeof run === 'function'
    && typeof now === 'function'
    && typeof setIntervalImpl === 'function'
    && typeof clearIntervalImpl === 'function'
    && typeof leaseOwner === 'string'
    && leaseOwner.trim() === leaseOwner
    && leaseOwner.length > 0
    && leaseOwner.length <= 200);
  if (enabled && !localConfigReady) {
    throw new Error('Work Orchestrator digest local configuration is missing');
  }

  const runtimeState = sharedState && typeof sharedState === 'object' ? sharedState : {};
  runtimeState.digestRunning = false;
  runtimeState.lastDigestRun = runtimeState.lastDigestRun || null;
  runtimeState.lastDigestSuccessAt = runtimeState.lastDigestSuccessAt || null;
  runtimeState.lastDigestFailureAt = runtimeState.lastDigestFailureAt || null;
  runtimeState.nextScheduledAt = runtimeState.nextScheduledAt || null;
  runtimeState.digestFailureCount = Math.max(0, Number(runtimeState.digestFailureCount || 0));
  runtimeState.omittedEligibleCount = Math.max(0, Number(runtimeState.omittedEligibleCount || 0));

  let timer = null;
  let lastAttemptedScheduledAt = null;

  const recordFailure = (at, trigger, scheduledAt, error = 'digest_cycle_failed') => {
    const safeError = [
      'digest_claim_failed', 'digest_build_failed', 'digest_delivery_failed', 'digest_delivery_unconfirmed',
      'digest_omission_detected', 'digest_cleanup_failed'
    ].includes(error) ? error : 'digest_cycle_failed';
    runtimeState.digestFailureCount += 1;
    runtimeState.lastDigestFailureAt = at;
    runtimeState.lastDigestRun = {
      at,
      trigger,
      status: 'failed',
      scheduledAt,
      selectedCount: 0,
      renderedCount: 0,
      omittedEligibleCount: 0,
      partCount: 0,
      deliveredPartCount: 0,
      cleanupFailed: 0,
      error: safeError
    };
    runtimeState.omittedEligibleCount = 0;
    return {
      status: 'failed', scheduledAt, runId: null,
      selectedCount: 0, renderedCount: 0, omittedEligibleCount: 0,
      partCount: 0, deliveredPartCount: 0,
      cleanup: { attempted: 0, settled: 0, failed: 0 },
      error: safeError
    };
  };

  const runAt = async (trigger, { force = false } = {}) => {
    if (!enabled) return { status: 'disabled' };
    let at;
    let window;
    try {
      at = digestRuntimeIso(now);
      window = digestScheduleWindow(at, intervalMinutes);
    } catch {
      return recordFailure('', trigger, '', 'digest_cycle_failed');
    }
    runtimeState.nextScheduledAt = window.nextScheduledAt;
    const cleanupRetryDue = (Number(runtimeState.lastDigestRun?.cleanupFailed || 0) > 0
      || runtimeState.lastDigestRun?.retryable === true)
      && window.scheduledAt === lastAttemptedScheduledAt;
    const cleanupSweepDue = cleanupEnabled && window.scheduledAt === lastAttemptedScheduledAt;
    if (!force && !cleanupRetryDue && !cleanupSweepDue && lastAttemptedScheduledAt !== null
      && Date.parse(window.scheduledAt) <= Date.parse(lastAttemptedScheduledAt)) {
      return { status: 'not_due', scheduledAt: window.scheduledAt };
    }
    if (runtimeState.digestRunning) return { status: 'already_running', scheduledAt: window.scheduledAt };

    lastAttemptedScheduledAt = window.scheduledAt;
    runtimeState.digestRunning = true;
    try {
      let result;
      try {
        result = safeDigestRuntimeResult(await run({
          store,
          slack,
          config: {
            channelId,
            destinationKey: `slack:${channelId}`,
            intervalMinutes,
            leaseSeconds: 120,
            cleanupEnabled,
            cleanupLeaseSeconds: 120,
            cleanupBacklogLimit: 10,
            reconcileWindowSeconds: 300,
            ownerSlackIds: config.ownerSlackIds || {}
          },
          now: at,
          leaseOwner
        }), window.scheduledAt);
      } catch {
        return recordFailure(at, trigger, window.scheduledAt, 'digest_cycle_failed');
      }

      let error = result.error || null;
      if (result.status === 'delivered' && result.omittedEligibleCount !== 0) {
        result.status = 'failed';
        result.error = 'digest_omission_detected';
        error = result.error;
      } else if (result.cleanup.failed > 0) {
        error = 'digest_cleanup_failed';
      }
      runtimeState.omittedEligibleCount = result.omittedEligibleCount;
      runtimeState.lastDigestRun = {
        at,
        trigger,
        status: result.status,
        scheduledAt: result.scheduledAt,
        selectedCount: result.selectedCount,
        renderedCount: result.renderedCount,
        omittedEligibleCount: result.omittedEligibleCount,
        partCount: result.partCount,
        deliveredPartCount: result.deliveredPartCount,
        cleanupFailed: result.cleanup.failed,
        retryable: result.retryable === true,
        ...(error ? { error } : {})
      };
      if (result.status === 'delivered') runtimeState.lastDigestSuccessAt = at;
      if (result.status === 'failed' || result.cleanup.failed > 0) {
        runtimeState.digestFailureCount += 1;
        runtimeState.lastDigestFailureAt = at;
      }
      return result;
    } finally {
      runtimeState.digestRunning = false;
    }
  };

  return {
    enabled,
    localConfigReady,
    state: runtimeState,
    async start() {
      if (!enabled) return { status: 'disabled' };
      if (timer === null) timer = setIntervalImpl(() => runAt('interval'), 60_000);
      return runAt('startup');
    },
    stop() {
      if (timer !== null) clearIntervalImpl(timer);
      timer = null;
    },
    runNow(trigger = 'manual') {
      return runAt(['startup', 'interval', 'manual'].includes(trigger) ? trigger : 'manual', { force: trigger === 'manual' });
    },
    check() {
      return runAt('interval');
    }
  };
}

function safeMaintenanceDigestResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { status: 'failed', error: 'digest_cycle_failed' };
  }
  const result = {};
  if (['disabled', 'not_due', 'already_running', 'delivered', 'not_claimed', 'failed'].includes(value.status)) {
    result.status = value.status;
  } else {
    result.status = 'failed';
  }
  for (const key of ['scheduledAt', 'runId']) {
    if (typeof value[key] === 'string' && value[key].length <= 40) result[key] = value[key];
  }
  if (['startup', 'interval', 'manual'].includes(value.trigger)) result.trigger = value.trigger;
  if (value.retryable === true) result.retryable = true;
  for (const [key, maximum] of Object.entries({
    selectedCount: 500, renderedCount: 500, omittedEligibleCount: 500,
    partCount: 50, deliveredPartCount: 50
  })) {
    const numeric = Number(value[key]);
    if (Number.isSafeInteger(numeric) && numeric >= 0 && numeric <= maximum) result[key] = numeric;
  }
  if (value.cleanup && typeof value.cleanup === 'object' && !Array.isArray(value.cleanup)) {
    result.cleanup = {};
    for (const key of ['attempted', 'settled', 'failed']) {
      const numeric = value.cleanup[key];
      if (!Number.isSafeInteger(numeric) || numeric < 0 || numeric > 500) {
        return { status: 'failed', error: 'digest_cycle_failed' };
      }
      result.cleanup[key] = numeric;
    }
  }
  if (result.status === 'failed') {
    result.error = [
      'digest_claim_failed', 'digest_build_failed', 'digest_delivery_failed', 'digest_delivery_unconfirmed',
      'digest_omission_detected', 'digest_cleanup_failed'
    ].includes(value.error) ? value.error : 'digest_cycle_failed';
  }
  return result;
}

export async function handleWorkOrchestratorDigestMaintenance(runtime) {
  if (!runtime || typeof runtime.runNow !== 'function') {
    return { statusCode: 503, body: { ok: false, result: { status: 'failed', error: 'digest_cycle_failed' } } };
  }
  let result;
  try {
    result = safeMaintenanceDigestResult(await runtime.runNow('manual'));
  } catch {
    result = { status: 'failed', error: 'digest_cycle_failed' };
  }
  return {
    statusCode: result.status === 'failed' ? 502 : 200,
    body: { ok: result.status !== 'failed', result }
  };
}

const GATEWAY_EVENT_FIELDS = [
  'schema', 'job_id', 'room_key', 'room_revision', 'prompt', 'detected_at', 'raw'
].sort();

export function createAiJobDispatcher({
  transport,
  channel,
  getConfig = () => ({}),
  capture,
  buildTurn,
  runLegacy
} = {}) {
  const resolvedTransport = resolveHermesTransport(transport);
  if (typeof runLegacy !== 'function') throw new Error('Legacy AI job dispatcher is required');
  if (resolvedTransport === 'cli') {
    return async (job, context = {}) => runLegacy(job, context);
  }
  if (!channel || typeof channel.enqueue !== 'function') throw new Error('Hermes Gateway channel is required');
  if (typeof getConfig !== 'function' || typeof capture !== 'function' || typeof buildTurn !== 'function') {
    throw new Error('Hermes Gateway capture and turn dependencies are required');
  }

  return async function dispatchGatewayJob(job, context = {}) {
    const config = configForHermesTransport(await getConfig(), resolvedTransport);
    const captured = await capture({ config, job, context });
    const turn = await buildTurn({ config, job, capture: captured });
    if (!turn?.event || !turn?.internal) throw new Error('Hermes Gateway turn must contain event and internal evidence');
    const eventKeys = Object.keys(turn.event).sort();
    if (JSON.stringify(eventKeys) !== JSON.stringify(GATEWAY_EVENT_FIELDS)) {
      throw new Error('Hermes Gateway event must contain exactly the seven plugin fields');
    }
    const jobId = String(job?.jobId || job?.id || '').trim();
    const roomKey = String(job?.roomKey || job?.room_key || '').trim();
    const roomRevision = Number(job?.roomRevision ?? job?.room_revision);
    if (turn.event.job_id !== jobId || turn.event.room_key !== roomKey || turn.event.room_revision !== roomRevision) {
      throw new Error('Hermes Gateway event correlation mismatch');
    }
    const durableJob = await channel.enqueue(turn.event, {
      localContext: { job, turn_internal: turn.internal }
    });
    const durableState = durableJob?.state || 'ready';
    if (durableState === 'failed') {
      return {
        ok: false,
        queued: false,
        transport: resolvedTransport,
        job_id: durableJob?.job_id || turn.event.job_id,
        state: durableState,
        human_review_required: durableJob?.human_review_required === true,
        error_type: String(durableJob?.error?.type || 'gateway_job_failed').slice(0, 120)
      };
    }
    return {
      ok: true,
      queued: ['ready', 'claimed'].includes(durableState),
      transport: resolvedTransport,
      job_id: durableJob?.job_id || turn.event.job_id,
      state: durableState
    };
  };
}

export async function recoverFailedGatewayDispatch({ result, recover } = {}) {
  if (!(result?.ok === false && result?.state === 'failed')) return false;
  if (typeof recover !== 'function') throw new Error('Gateway failure recovery is required');
  await recover();
  return true;
}

function notificationAudit(result) {
  if (String(result?.follow_up_id || '').trim()) {
    return { follow_up_id: String(result.follow_up_id).trim().slice(0, 160) };
  }
  const slackDelivery = result?.slackDeliveryResult;
  const slackResults = Array.isArray(slackDelivery?.results) ? slackDelivery.results : [];
  return {
    inserted: Math.max(0, Number(result?.inserted || 0)),
    rows: Array.isArray(result?.rows) ? result.rows.length : 0,
    slack_delivered: slackDelivery?.skipped === true || slackResults.length === 0
      ? null
      : slackResults.every((entry) => entry?.ok !== false && !entry?.error && entry?.status !== 'error')
  };
}

export function assertGatewayFailureNotificationDelivered(result = {}, { slackEnabled = false } = {}) {
  if (result?.skipped === true || result?.error || result?.slackDeliveryError) {
    throw new Error(`gateway_failure_notification_not_delivered: ${String(
      result?.error || result?.slackDeliveryError || result?.reason || 'unknown'
    ).slice(0, 500)}`);
  }
  const rows = Array.isArray(result?.rows) ? result.rows : [];
  const delivery = result?.slackDeliveryResult;
  if (!delivery) {
    if (slackEnabled && rows.length > 0) {
      throw new Error('gateway_failure_notification_slack_failed: missing Slack delivery result');
    }
    return true;
  }
  const results = Array.isArray(delivery.results) ? delivery.results : [];
  const failed = results.find((entry) => entry?.ok === false || entry?.error || entry?.status === 'error');
  if (delivery.error || failed) {
    throw new Error(`gateway_failure_notification_slack_failed: ${String(
      delivery.error || failed?.error || failed?.status || delivery.reason || 'unknown'
    ).slice(0, 500)}`);
  }
  if (delivery.skipped === true) {
    const intentionalSkip = (!slackEnabled && delivery.reason === 'disabled')
      || (rows.length === 0 && delivery.reason === 'no_rows');
    if (!intentionalSkip) {
      throw new Error(`gateway_failure_notification_slack_failed: ${String(delivery.reason || 'unexpected_skip').slice(0, 500)}`);
    }
    return true;
  }
  if (slackEnabled && rows.length > 0 && results.length === 0) {
    throw new Error('gateway_failure_notification_slack_failed: missing Slack delivery evidence');
  }
  return true;
}

export function createGatewayApplicationFailureNotifier({
  slackEnabled = false,
  createFollowUp,
  updateStatus,
  now = () => new Date().toISOString()
} = {}) {
  if (typeof createFollowUp !== 'function') throw new Error('Gateway application failure follow-up creator is required');
  if (typeof updateStatus !== 'function') throw new Error('Gateway application failure status updater is required');
  return async ({ durableJob, error }) => {
    const job = durableJob?.local_context?.job || {
      jobId: durableJob?.job_id,
      roomKey: durableJob?.room_key,
      roomRevision: durableJob?.room_revision
    };
    const followUpResult = await createFollowUp({
      job,
      error,
      context: {
        origin: 'hermes_gateway_result_application',
        ambiguous_dom_apply: ['ambiguous_dom_apply_failure', 'ambiguous_post_apply_restart'].includes(
          durableJob?.application?.error?.type || error?.code
        )
      }
    });
    assertGatewayFailureNotificationDelivered(followUpResult, { slackEnabled });
    await updateStatus(durableJob.job_id, {
      status: 'needs_human_review',
      error_message: String(error?.message || error).slice(0, 1000),
      completed_at: now(),
      payload: { ...job, ai_worker_result: { failure_follow_up: followUpResult } }
    });
    return followUpResult;
  };
}

export function createGatewayFailureNotificationCoordinator({ channel, notify } = {}) {
  if (!channel
    || typeof channel.listPendingFailureNotifications !== 'function'
    || typeof channel.markFailureNotified !== 'function') {
    throw new Error('Gateway failure-notification channel is required');
  }
  if (typeof notify !== 'function') throw new Error('Gateway failure notifier is required');
  let recoveryTail = Promise.resolve();
  return {
    async recover() {
      const operation = recoveryTail.then(async () => {
        const pending = await channel.listPendingFailureNotifications();
        const results = [];
        for (const durableJob of pending) {
          try {
            const error = new Error(String(durableJob?.error?.message || durableJob?.error?.type || 'Hermes Gateway job failed'));
            error.code = String(durableJob?.error?.type || 'gateway_job_failed');
            const delivered = await notify({ durableJob, error });
            await channel.markFailureNotified({
              job_id: durableJob.job_id,
              audit: notificationAudit(delivered)
            });
            results.push({ job_id: durableJob.job_id, notified: true });
          } catch (error) {
            results.push({
              job_id: durableJob.job_id,
              notified: false,
              error: String(error?.message || error).slice(0, 1000)
            });
          }
        }
        return results;
      });
      recoveryTail = operation.catch(() => {});
      return operation;
    }
  };
}

const dnsFallbackResolver = new dns.Resolver();
if (CONFIG.dnsFallbackServers.length) {
  dnsFallbackResolver.setServers(CONFIG.dnsFallbackServers);
}

function lookupWithDnsFallback(hostname, options, callback) {
  dns.lookup(hostname, options, (lookupError, address, family) => {
    if (!lookupError) {
      callback(null, address, family);
      return;
    }
    dnsFallbackResolver.resolve4(hostname, (resolveError, addresses) => {
      if (resolveError || !addresses?.length) {
        callback(lookupError);
        return;
      }
      if (options?.all) {
        callback(null, addresses.map((resolvedAddress) => ({ address: resolvedAddress, family: 4 })));
        return;
      }
      callback(null, addresses[0], 4);
    });
  });
}

async function fetchWithDnsFallback(endpoint, init = {}) {
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || ['127.0.0.1', 'localhost'].includes(url.hostname)) {
    return fetch(endpoint, init);
  }
  const transport = url.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = transport.request(url, {
      method: init.method || 'GET',
      headers: init.headers || {},
      lookup: lookupWithDnsFallback
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          text: async () => body
        });
      });
    });
    req.on('error', reject);
    if (init.signal) {
      if (init.signal.aborted) req.destroy(init.signal.reason);
      init.signal.addEventListener('abort', () => req.destroy(init.signal.reason), { once: true });
    }
    if (init.body) req.write(init.body);
    req.end();
  });
}

const workOrchestratorCredentialsPresent = Boolean(
  CONFIG.supabaseUrl.trim() && CONFIG.supabaseServiceRoleKey.trim()
);
let workOrchestratorStore = null;
if (workOrchestratorCredentialsPresent) {
  try {
    workOrchestratorStore = createWorkOrchestratorStore({
      supabaseUrl: CONFIG.supabaseUrl,
      serviceRoleKey: CONFIG.supabaseServiceRoleKey
    });
  } catch {
    workOrchestratorStore = null;
  }
}
CONFIG.workOrchestratorStoreConfigured = Boolean(workOrchestratorStore);
CONFIG.workOrchestratorShadowReady = !CONFIG.workOrchestrator.shadowWrites || Boolean(workOrchestratorStore);
const workOrchestratorShadowRuntime = createWorkOrchestratorShadowRuntime({
  config: CONFIG.workOrchestrator,
  store: workOrchestratorStore
});
let workOrchestratorSlackClient = null;
if ((CONFIG.workOrchestrator.immediateEnabled || CONFIG.workOrchestrator.digestEnabled)
  && CONFIG.slackBotToken.trim()) {
  try {
    workOrchestratorSlackClient = createSlackClient({ token: CONFIG.slackBotToken });
  } catch {
    workOrchestratorSlackClient = null;
  }
}
const workOrchestratorImmediateAttemptGuard = CONFIG.workOrchestrator.immediateEnabled
  ? createImmediateNotificationAttemptGuard({ queueDir: CONFIG.queueDir })
  : null;
const workOrchestratorImmediateRuntime = createWorkOrchestratorImmediateRuntime({
  config: {
    ...CONFIG.workOrchestrator,
    mentionUserIds: String(process.env.SLACK_CARD_MENTION_USER_IDS || '')
      .split(/[\s,]+/)
      .filter(Boolean)
  },
  store: workOrchestratorStore,
  slack: workOrchestratorSlackClient,
  slackToken: CONFIG.slackBotToken,
  state: workOrchestratorShadowRuntime.state,
  attemptGuard: workOrchestratorImmediateAttemptGuard
});
CONFIG.workOrchestratorImmediateLocalConfigReady = workOrchestratorImmediateRuntime.localConfigReady;
const workOrchestratorDigestRuntime = createWorkOrchestratorDigestRuntime({
  config: CONFIG.workOrchestrator,
  store: workOrchestratorStore,
  slack: workOrchestratorSlackClient,
  state: workOrchestratorShadowRuntime.state,
  leaseOwner: `bridge:digest:${process.pid}`
});
CONFIG.workOrchestratorDigestLocalConfigReady = workOrchestratorDigestRuntime.localConfigReady;
const workOrchestratorActionPoller = createWorkOrchestratorActionPoller({
  config: CONFIG.workOrchestrator,
  storeReady: Boolean(workOrchestratorStore),
  list: workOrchestratorCredentialsPresent
    ? ({ limit }) => listPendingWorkActionsV2({
        supabaseUrl: CONFIG.supabaseUrl,
        serviceRoleKey: CONFIG.supabaseServiceRoleKey,
        limit
      })
    : null,
  apply: workOrchestratorCredentialsPresent
    ? ({ row, transition }) => applyPendingWorkActionPatchV2({
        supabaseUrl: CONFIG.supabaseUrl,
        serviceRoleKey: CONFIG.supabaseServiceRoleKey,
        row,
        transition
      })
    : null,
  state: workOrchestratorShadowRuntime.state
});
CONFIG.workOrchestratorActionLocalConfigReady = workOrchestratorActionPoller.localConfigReady;

const state = {
  startedAt: new Date().toISOString(),
  received: 0,
  debouncedJobs: 0,
  failedSupabaseWrites: 0,
  failedWorkerRuns: 0,
  workerRunning: false,
  activeWorkerRuns: 0,
  workerQueueLength: 0,
  currentJobId: null,
  workerStartedAt: null,
  lastWorkerError: null,
  recoveredJobs: 0,
  slackActionsHandled: 0,
  slackActionPollRunning: false,
  lastSlackActionPoll: null,
  p0SlackEscalationRunning: false,
  lastP0SlackEscalation: null,
  recoverySweepRunning: false,
  lastRecoverySweep: null,
  closedKakaoTabs: 0,
  tabCleanupRunning: false,
  lastTabCleanup: null,
  rooms: new Map(),
  roomVersions: new Map(),
  activeWorkerJobIds: new Set(),
  seenGroupingTexts: new Set(),
  lastContentScriptStartedAtMs: 0,
  workOrchestrator: workOrchestratorShadowRuntime.state
};

const gatewayTransportSelected = ['gateway', 'gateway_no_send'].includes(CONFIG.hermesTransport);
const gatewayTransportEnabled = gatewayTransportSelected && Boolean(CONFIG.hermesBridgeToken.trim());
const gatewayChannel = gatewayTransportEnabled
  ? createHermesGatewayChannel({
    directory: CONFIG.queueDir,
    leaseMs: CONFIG.hermesLeaseMs,
    maxAttempts: CONFIG.hermesMaxAttempts
  })
  : null;
export function createGatewayConfirmationExecutor({ getConfig, executeOperation = executeVillageConfirmationRequest } = {}) {
  if (typeof getConfig !== 'function') throw new Error('Gateway confirmation config loader is required');
  if (typeof executeOperation !== 'function') throw new Error('Gateway confirmation operation is required');
  return async (request, { assertCurrentClaim, operationFence } = {}) => executeOperation({
    config: getConfig(),
    job: {
      jobId: request.job_id,
      roomKey: request.room_key,
      roomRevision: request.room_revision,
      detectedAt: request.detected_at || ''
    },
    roomRevision: request.room_revision,
    decision: request.decision,
    dependencies: { assertCurrentClaim, operationFence }
  });
}

export function createGatewayRegisteredReservationChangeExecutor({
  getConfig,
  executeOperation = executeVillageRegisteredReservationChange,
  runRegisteredTradeCorrection,
  randomUUID = crypto.randomUUID,
  now
} = {}) {
  if (typeof getConfig !== 'function') throw new Error('Gateway registered reservation change config loader is required');
  if (typeof executeOperation !== 'function') throw new Error('Gateway registered reservation change operation is required');
  return async (request, { assertCurrentClaim, operationFence } = {}) => {
    const dependencies = {
      assertCurrentClaim,
      operationFence,
      ...(typeof runRegisteredTradeCorrection === 'function' ? { runRegisteredTradeCorrection } : {}),
      ...(typeof randomUUID === 'function' ? { randomUUID } : {}),
      ...(typeof now === 'function' ? { now } : {})
    };
    return executeOperation({
      config: resolveGatewayRegisteredReservationChangeConfig(getConfig()),
      job: {
        job_id: request.job_id,
        room_key: request.room_key,
        room_revision: request.room_revision
      },
      roomRevision: request.room_revision,
      mutation: request.mutation,
      dependencies
    });
  };
}

export function resolveGatewayRegisteredReservationChangeConfig(workerConfig = {}) {
  const gasApiUrl = String(workerConfig.gasApiUrl || '').trim();
  const sheetApiKey = String(workerConfig.sheetApiKey || '').trim();
  if (!gasApiUrl || !sheetApiKey) {
    throw new Error('Gateway registered reservation change configuration is incomplete');
  }
  return {
    VILLAGE2_API_URL: gasApiUrl,
    VILLAGE2_API_KEY: sheetApiKey
  };
}

export function createGatewayDocumentExecutor({
  getConfig,
  executeRequest = executeVillageDocumentRequest,
  randomUUID: uuid = crypto.randomUUID,
  now = () => new Date()
} = {}) {
  if (typeof getConfig !== 'function') throw new Error('Gateway document config loader is required');
  if (typeof executeRequest !== 'function') throw new Error('Gateway document operation is required');
  return async (request, { assertCurrentClaim } = {}) => {
    const checkClaim = typeof assertCurrentClaim === 'function' ? assertCurrentClaim : async () => {};
    await checkClaim();
    const config = getConfig();
    let result;
    try {
      result = await executeRequest({
        document_type: request.document_type,
        trade_id: request.trade_id,
        tax_mode: request.tax_mode
      }, {
        documentApiBaseUrl: config.documentApiBaseUrl,
        documentApiKey: config.documentApiKey
      });
    } catch (error) {
      result = {
        ok: false,
        reason: 'document_send_exception',
        response: { error: String(error?.message || error).slice(0, 1000) }
      };
    }
    const receiptId = String(uuid() || '').trim();
    if (!receiptId) throw new Error('document receipt id generation failed');
    const created = now();
    const createdAt = (created instanceof Date ? created : new Date(created)).toISOString();
    const success = result?.ok === true;
    return {
      schema: 'village-document-receipt/v1',
      receipt_id: receiptId,
      job_id: request.job_id,
      room_key: request.room_key,
      room_revision: request.room_revision,
      status: success ? 'ok' : 'failed',
      document_type: request.document_type,
      trade_id: request.trade_id,
      tax_mode: request.tax_mode,
      authoritative_document_result: success ? result.response : (result?.response || null),
      created_at: createdAt,
      error: success ? null : {
        type: String(result?.reason || 'document_send_failed'),
        message: String(result?.response?.error || result?.reason || 'document send failed').slice(0, 1000)
      }
    };
  };
}

export function resolveGatewayDocumentConfig(config = {}, workerConfig = {}) {
  return {
    documentApiBaseUrl: String(config.documentApiBaseUrl || DEFAULT_VILLAGE_DOCUMENT_API_URL).trim(),
    documentApiKey: String(config.documentApiKey || workerConfig.sheetApiKey || '').trim()
  };
}

export function createGatewayConfirmationValidator({
  validateDecision = validateVillageConfirmationExecutionDecision,
  getConfig = () => ({}),
  fetchExistingRequest = fetchExistingConfirmRequestResultForDecision
} = {}) {
  if (typeof validateDecision !== 'function') throw new Error('Gateway confirmation validator is required');
  if (typeof getConfig !== 'function') throw new Error('Gateway confirmation config loader is required');
  if (typeof fetchExistingRequest !== 'function') throw new Error('Gateway existing confirmation lookup is required');
  return (request = {}) => {
    const validation = validateDecision(request.decision);
    if (!validation?.valid) return validation;
    const decision = request?.decision && typeof request.decision === 'object' ? request.decision : {};
    const claimedRequestIds = Array.from(new Set(
      (Array.isArray(decision.existing_confirm_request_ids) ? decision.existing_confirm_request_ids : [])
        .map((value) => String(value || '').trim().toUpperCase())
        .filter((value) => /^RQ-\d{6}-\d{3}$/.test(value))
    ));
    if (decision.should_write_to_sheet !== false || !claimedRequestIds.length) return validation;
    return (async () => {
      const config = getConfig();
      for (const reqID of claimedRequestIds) {
        const existing = await fetchExistingRequest(config, {
          ...decision,
          existing_confirm_request_ids: [reqID]
        }, []);
        if (existing?.lookup_error) {
          return {
            valid: false,
            errors: [
              `existing confirm request ${reqID} could not be verified in the live sheet; retry the tool before finishing`
            ]
          };
        }
        if (String(existing?.reqID || '').trim().toUpperCase() !== reqID) {
          return {
            valid: false,
            errors: [
              `existing confirm request ${reqID} was not found in the live sheet; if the reservation remains unregistered, correct the decision and write it`
            ]
          };
        }
      }
      return validation;
    })();
  };
}

export function createGatewayResultApplicationCoordinator({
  channel,
  getConfig,
  now = Date.now,
  prepare = prepareKakaoGatewayDecision,
  apply = applyPreparedKakaoDecision,
  finalize = finalizePreparedKakaoDecision,
  record = async () => {},
  onFailure = async () => {}
} = {}) {
  if (!channel
    || typeof channel.claimApplication !== 'function'
    || typeof channel.beginApplication !== 'function'
    || typeof channel.recordApplicationApplied !== 'function'
    || typeof channel.finalizeApplication !== 'function'
    || typeof channel.failApplication !== 'function'
    || typeof channel.listPendingApplicationFailureNotifications !== 'function'
    || typeof channel.markApplicationFailureNotified !== 'function') {
    throw new Error('Gateway application channel is required');
  }
  if (typeof getConfig !== 'function') throw new Error('Gateway application config loader is required');
  if (typeof now !== 'function') throw new Error('Gateway application clock is required');
  let applicationTail = Promise.resolve();

  function currentTimeMs() {
    const value = now();
    const milliseconds = value instanceof Date ? value.getTime() : Number(value);
    if (!Number.isFinite(milliseconds)) throw new Error('Gateway application clock returned an invalid timestamp');
    return milliseconds;
  }

  function exactIsoTimestampMs(value) {
    if (typeof value !== 'string'
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) return null;
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }

  function totalElapsedBaselineMs(durableJob, job, localStartedAt) {
    const candidates = [
      durableJob?.event?.detected_at,
      durableJob?.event?.detectedAt,
      job?.detected_at,
      job?.detectedAt,
      durableJob?.created_at
    ].map(exactIsoTimestampMs).filter((value) => value !== null && value <= localStartedAt);
    return candidates.length ? Math.min(...candidates) : localStartedAt;
  }

  function assertGatewayFinalizationSucceeded(finalized = {}) {
    if (finalized?.superseded === true || finalized?.status === 'superseded_by_newer_room_event') return;
    const decision = finalized?.decision || {};
    const reply = decision?.reply_decision || {};
    const ownerReviewExpected = decision?.owner_review_required === true
      || decision?.ownerReviewRequired === true
      || reply?.shouldCreateTask === true
      || reply?.should_create_task === true;
    const followUp = finalized?.followUpResult || {};
    const persistedRows = Array.isArray(followUp.rows) ? followUp.rows : [];
    if (followUp.error) {
      throw new Error(`gateway_owner_review_persistence_failed: ${String(followUp.error).slice(0, 500)}`);
    }
    if (ownerReviewExpected && (followUp.skipped === true || persistedRows.length === 0)) {
      throw new Error('gateway_owner_review_not_persisted: required owner-review row is missing');
    }

    const slack = finalized?.slackDeliveryResult || {};
    if (slack.error) {
      throw new Error(`gateway_owner_review_slack_failed: ${String(slack.error).slice(0, 500)}`);
    }
    const failedSlackResult = (Array.isArray(slack.results) ? slack.results : []).find((result) => (
      result?.ok === false || Boolean(result?.error) || result?.status === 'error'
    ));
    if (failedSlackResult) {
      throw new Error(`gateway_owner_review_slack_failed: ${String(failedSlackResult.error || failedSlackResult.status || 'delivery failed').slice(0, 500)}`);
    }
    if (slack.skipped === true) {
      const reason = String(slack.reason || '').trim();
      const intentionalSkip = reason === 'disabled'
        || (reason === 'no_rows' && !ownerReviewExpected && persistedRows.length === 0)
        || (reason === 'automation_audit_rows' && !ownerReviewExpected);
      if (!intentionalSkip) {
        throw new Error(`gateway_owner_review_slack_failed: unexpected skip ${reason || 'unknown'}`);
      }
    }
  }

  function exactDurableToolReceipts(durableJob) {
    const operation = durableJob?.tool_operation;
    if (!operation || operation.state !== 'completed') return [];
    const expectedSchema = operation.tool === 'document_send'
      ? 'village-document-receipt/v1'
      : operation.tool === 'registered_reservation_change'
        ? 'village-registered-reservation-change-receipt/v1'
        : 'village-confirmation-receipt/v1';
    const exact = (Array.isArray(durableJob?.tool_receipts) ? durableJob.tool_receipts : []).find((receipt) => (
      receipt?.schema === expectedSchema
      && receipt.receipt_id === operation.receipt_id
      && receipt.operation_id === operation.operation_id
      && receipt.lease_id === operation.lease_id
      && receipt.request_digest === operation.request_digest
      && receipt.job_id === durableJob.job_id
      && receipt.room_key === durableJob.room_key
      && receipt.room_revision === durableJob.room_revision
    ));
    return exact ? [exact] : [];
  }

  async function runApplication(claimed) {
    const durableJob = claimed.job;
    const localContext = durableJob?.local_context;
    const job = localContext?.job;
    const internal = localContext?.turn_internal;
    const event = durableJob?.event;
    if (!job || !internal || !event) throw new Error('gateway_local_turn_context_missing');
    const localStartedAt = currentTimeMs();
    const elapsedBaselineAt = totalElapsedBaselineMs(durableJob, job, localStartedAt);
    const prepared = await prepare({
      config: getConfig(),
      job,
      turn: { event, internal },
      finalText: String(durableJob?.result?.content ?? durableJob?.result?.final_text ?? ''),
      trustedToolReceipts: exactDurableToolReceipts(durableJob)
    });
    await channel.beginApplication({
      job_id: durableJob.job_id,
      application_id: claimed.application_id
    });
    durableJob.application = { ...(durableJob.application || {}), state: 'applying' };
    const applied = await apply({ config: getConfig(), job, prepared });
    await channel.recordApplicationApplied({
      job_id: durableJob.job_id,
      application_id: claimed.application_id,
      audit: {
        auto_reply_attempted: applied?.autoReplyResult?.attempted === true,
        auto_reply_sent: applied?.autoReplyResult?.sent === true,
        snapshot_changed: applied?.snapshotChanged === true,
        superseded: applied?.superseded === true
      }
    });
    durableJob.application = { ...(durableJob.application || {}), state: 'applied' };
    const finalized = await finalize({ config: getConfig(), job, applied });
    assertGatewayFinalizationSucceeded(finalized);
    const finishedAt = currentTimeMs();
    const elapsedMs = Math.max(0, finishedAt - elapsedBaselineAt);
    const localApplicationElapsedMs = Math.max(0, finishedAt - localStartedAt);
    await record({ durableJob, job, finalized, elapsedMs, localApplicationElapsedMs });
    await channel.finalizeApplication({
      job_id: durableJob.job_id,
      application_id: claimed.application_id,
      audit: {
        status: String(finalized?.status || ''),
        follow_up_inserted: Number(finalized?.followUpResult?.inserted || 0),
        auto_reply_sent: finalized?.autoReplyResult?.sent === true
      }
    });
    return finalized;
  }

  function failureErrorForJob(job = {}) {
    const details = job?.application?.error;
    const message = String(details?.message || details?.type || 'Gateway application requires human review').slice(0, 1000);
    const error = new Error(message);
    if (details?.type) error.code = details.type;
    return error;
  }

  async function notifyApplicationFailure(failedJob, error, source) {
    await onFailure({ durableJob: failedJob, error });
    await channel.markApplicationFailureNotified({
      job_id: failedJob.job_id,
      application_id: failedJob.application.application_id,
      audit: {
        source,
        error_type: String(failedJob.application?.error?.type || error?.code || 'gateway_application_failed').slice(0, 120)
      }
    });
  }

  async function enqueueCompletedJob(completedJob = {}) {
    const jobId = String(completedJob?.job_id || '').trim();
    if (!jobId) throw new Error('Gateway completed job_id is required');
    const claimed = await channel.claimApplication({ jobId });
    if (!claimed?.claimed) return { accepted: false, reason: claimed?.job?.application?.state || 'not_pending' };
    const application = applicationTail.then(() => runApplication(claimed));
    applicationTail = application.catch(async (error) => {
      let failedJob = null;
      try {
        const failureType = claimed.job.application?.state === 'applying'
          ? 'ambiguous_dom_apply_failure'
          : 'gateway_application_failed';
        failedJob = await channel.failApplication({
          job_id: claimed.job.job_id,
          application_id: claimed.application_id,
          error: { type: failureType, message: String(error?.message || error).slice(0, 1000) }
        });
      } catch {}
      if (failedJob) {
        try { await notifyApplicationFailure(failedJob, error, 'runtime_failure'); } catch {}
      }
    });
    return { accepted: true, application_id: claimed.application_id };
  }

  return {
    enqueue: enqueueCompletedJob,
    async recoverPendingApplications() {
      if (typeof channel.listPendingApplications !== 'function') {
        throw new Error('Gateway application recovery channel is required');
      }
      const pending = await channel.listPendingApplications();
      const recovered = [];
      for (const job of pending) recovered.push(await enqueueCompletedJob(job));
      return recovered;
    },
    async recoverApplicationFailureNotifications() {
      const pending = await channel.listPendingApplicationFailureNotifications();
      const recovered = [];
      for (const job of pending) {
        const error = failureErrorForJob(job);
        try {
          await notifyApplicationFailure(job, error, 'startup_recovery');
          recovered.push({ job_id: job.job_id, notified: true });
        } catch (notificationError) {
          recovered.push({
            job_id: job.job_id,
            notified: false,
            error: String(notificationError?.message || notificationError).slice(0, 1000)
          });
        }
      }
      return recovered;
    },
    async idle() { await applicationTail; }
  };
}

const gatewayConfirmationExecutor = gatewayTransportEnabled
  ? createGatewayConfirmationExecutor({
      getConfig: () => getKakaoWorkerRuntimeConfigForTransport()
    })
  : null;
const gatewayConfirmationValidator = gatewayTransportEnabled
  ? createGatewayConfirmationValidator({
      getConfig: () => getKakaoWorkerRuntimeConfigForTransport()
    })
  : null;
const gatewayDocumentExecutor = gatewayTransportEnabled
  ? createGatewayDocumentExecutor({
      getConfig: () => resolveGatewayDocumentConfig(
        CONFIG,
        getKakaoWorkerRuntimeConfigForTransport()
      )
    })
  : null;
const gatewayRegisteredReservationChangeExecutor = gatewayTransportEnabled
  ? createGatewayRegisteredReservationChangeExecutor({
      getConfig: () => getKakaoWorkerRuntimeConfigForTransport()
    })
  : null;
const gatewayHttpHandler = createHermesGatewayHttpHandler({
  token: CONFIG.hermesBridgeToken,
  channel: gatewayChannel,
  transport: CONFIG.hermesTransport,
  consumerFreshnessMs: Math.max(60_000, CONFIG.hermesLeaseMs * 2),
  executeConfirmation: gatewayConfirmationExecutor,
  validateConfirmation: gatewayConfirmationValidator,
  executeDocument: gatewayDocumentExecutor,
  executeRegisteredReservationChange: gatewayRegisteredReservationChangeExecutor,
  recoverFailureNotifications: gatewayTransportEnabled
    ? () => getGatewayFailureNotificationCoordinator().recover()
    : null,
  enqueueResultApplication: gatewayTransportEnabled
    ? (completedJob) => getGatewayResultApplicationCoordinator().enqueue(completedJob)
    : null
});

function ensureQueueDir() {
  fs.mkdirSync(CONFIG.queueDir, { recursive: true });
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function nowIso() {
  return new Date().toISOString();
}

function timestampMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function deterministicP0SlackMessageId(rowId, attempt) {
  const chars = sha256(`village-p0-slack:${String(rowId || '')}:${Number(attempt || 0)}`).slice(0, 32).split('');
  chars[12] = '5';
  chars[16] = ['8', '9', 'a', 'b'][Number.parseInt(chars[16], 16) % 4];
  const hex = chars.join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function p0SlackEscalationBackoffMs(deliveredAttempts, repeatMs = 600_000, maxIntervalMs = 3_600_000) {
  const attempts = Math.max(0, Number(deliveredAttempts || 0));
  const base = Math.max(1, Number(repeatMs) || 600_000);
  const cap = Math.max(base, Number(maxIntervalMs) || base);
  return Math.min(base * 2 ** attempts, cap);
}

export function p0SlackEscalationDue(row = {}, {
  nowMs = Date.now(),
  repeatMs = 600_000,
  maxIntervalMs = 3_600_000,
  maxAttempts = 3
} = {}) {
  const payload = objectPayload(row.payload);
  if (String(payload.alert_level || payload.alertLevel || '').trim() !== 'p0') {
    return { due: false, reason: 'not_p0' };
  }
  if (['done', 'dismissed'].includes(String(row.status || '').trim())) {
    return { due: false, reason: 'closed' };
  }
  if (Number(maxAttempts) <= 0) return { due: false, reason: 'disabled' };
  const slackDelivery = objectPayload(payload.slack_delivery);
  const critical = objectPayload(payload.critical_delivery);
  const deliveredAttempts = Math.max(0, Number(critical.attempt || 0));
  if (deliveredAttempts >= maxAttempts) return { due: false, reason: 'max_attempts' };
  if (critical.status === 'claimed' && timestampMs(critical.claim_expires_at) > nowMs) {
    return { due: false, reason: 'claimed' };
  }
  const intervalMs = p0SlackEscalationBackoffMs(deliveredAttempts, repeatMs, maxIntervalMs);
  const explicitNextMs = timestampMs(critical.next_at);
  // 첫 카드 전달이 실패한 P0도 침묵시키지 않는다: 스레드가 없으면 행 시각 기준으로
  // 기한을 계산하고, 메시지는 폴백 채널로 단독 발송된다.
  const referenceMs = timestampMs(critical.last_sent_at || critical.last_attempt_at || slackDelivery.delivered_at || row.updated_at || row.created_at);
  const dueAtMs = explicitNextMs || (referenceMs ? referenceMs + intervalMs : nowMs);
  if (nowMs < dueAtMs) return { due: false, reason: 'interval', dueAtMs };
  return { due: true, reason: 'due', attempt: deliveredAttempts + 1, dueAtMs };
}

export function buildP0SlackEscalationClaim(row = {}, options = {}) {
  const nowMs = Number(options.nowMs ?? Date.now());
  const due = p0SlackEscalationDue(row, options);
  if (!due.due) throw new Error(`P0 Slack escalation is not due: ${due.reason}`);
  const attempt = due.attempt;
  return {
    attempt,
    claimId: `p0:${String(row.id || 'unknown')}:${attempt}`,
    claimedAt: new Date(nowMs).toISOString(),
    claimExpiresAt: new Date(nowMs + Number(options.claimTtlMs || 120_000)).toISOString(),
    clientMessageId: deterministicP0SlackMessageId(row.id, attempt)
  };
}

export function buildP0SlackEscalationMessage(row = {}, claim = {}, { mentionUserIds = [], fallbackChannelId = '' } = {}) {
  const payload = objectPayload(row.payload);
  const delivery = objectPayload(payload.slack_delivery);
  const mentions = Array.from(new Set((Array.isArray(mentionUserIds) ? mentionUserIds : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean)))
    .map((userId) => `<@${userId}>`);
  const attention = ['<!channel>', ...mentions].join(' ');
  const customer = String(row.customer_name || '고객').slice(0, 120);
  const title = String(row.title || '즉시 확인이 필요한 사건').slice(0, 240);
  const reason = String(payload.alert_reason || payload.alertReason || 'AI가 P0 즉시 확인으로 판단').slice(0, 1000);
  const channel = delivery.channel_id || String(fallbackChannelId || '').trim();
  const threadTs = delivery.channel_id ? (delivery.thread_ts || delivery.message_ts) : '';
  return {
    channel,
    ...(threadTs ? { thread_ts: threadTs } : {}),
    reply_broadcast: Boolean(threadTs),
    client_msg_id: claim.clientMessageId,
    text: `${attention} 🚨 P0 미확인 알림 ${claim.attempt}회 · ${customer} · ${title} · ${reason}`,
    unfurl_links: false,
    unfurl_media: false
  };
}

export function buildCorsHeaders() {
  return {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-private-network': 'true'
  };
}

function json(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, buildCorsHeaders());
  res.end(body);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const body = await readRequestBody(req);
  if (!body.trim()) return {};
  return JSON.parse(body);
}

function inferKakaoUnreadCountFromPreview(text = '') {
  const preview = String(text || '').replace(/\s+/g, ' ').trim();
  const match = /^중요\s+(.{1,90}?)\s+([1-9]\d?)\s+(\S.*)$/.exec(preview);
  if (!match) return null;
  const count = Number(match[2]);
  if (!Number.isFinite(count) || count <= 0 || count > 20) return null;
  const next = match[3] || '';
  if (/^(월|일|시|분|초|원|개|건|구|세트|set\b)/i.test(next)) return null;
  return count;
}

export function normalizeEvent(raw = {}) {
  const source = String(raw.source || 'kakao_channel_manager_dom');
  const roomKey = String(raw.roomKey || raw.room_key || raw.roomHint || raw.previewText || 'unknown-room');
  const previewText = String(raw.previewText || raw.preview_text || '').slice(0, 500);
  const customerName = String(raw.customerName || raw.customer_name || '').slice(0, 120);
  const messagePreview = String(raw.messagePreview || raw.message_preview || '').slice(0, 500);
  const displayTime = String(raw.displayTime || raw.display_time || '').slice(0, 80);
  const detectedAtInput = String(raw.detectedAt || raw.detected_at || nowIso());
  const detectedAtMs = Date.parse(detectedAtInput);
  const detectedAt = Number.isFinite(detectedAtMs) ? new Date(detectedAtMs).toISOString() : nowIso();
  const eventHash = String(raw.eventHash || raw.event_hash || sha256(JSON.stringify({ source, roomKey, previewText, detectedAt })));
  const unreadCount = raw.unreadCount ?? raw.unread_count ?? inferKakaoUnreadCountFromPreview(previewText);

  return {
    source,
    status: String(raw.status || 'pending_ai_review'),
    reason: String(raw.reason || 'dom_event'),
    detectedAt,
    receivedAt: nowIso(),
    url: String(raw.url || ''),
    title: String(raw.title || ''),
    roomKey,
    eventHash,
    previewText,
    customerName,
    messagePreview,
    displayTime,
    unreadCount,
    pageVisibility: raw.pageVisibility || raw.page_visibility || null,
    raw
  };
}

function isPageContainerPreview(text, roomKey) {
  const preview = String(text || '');
  if (/^attr:kakao(Wrap|Content)$/i.test(String(roomKey || ''))) return true;
  if (/^(전체 채팅목록|중요채팅 목록|차단친구 목록)$/.test(preview)) return true;
  const pageChromeSignals = [
    '채팅 목록 채팅 목록',
    '1:1 채팅사용 여부',
    '상담 완료하기',
    '채팅방 나가기',
    '친구차단'
  ];
  const isSettingsBlock = preview.includes('1:1 채팅사용 여부') && preview.includes('채팅설정');
  const importanceMarkers = (preview.match(/중요\s/g) || []).length;
  const looksLikeChatListContainer = preview.length > 120 && importanceMarkers >= 2;

  return pageChromeSignals.filter((needle) => preview.includes(needle)).length >= 2
    || isSettingsBlock
    || looksLikeChatListContainer;
}

function normalizePreviewForGrouping(text) {
  const cleaned = String(text || '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/^중요\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';

  // Group split Kakao bubbles by the visible room/customer label, not by the full
  // latest-message preview. This is plumbing for debounce only; AI still reads
  // the opened conversation and decides sender/intent.
  const tokens = cleaned.split(' ').filter(Boolean);
  const labelParts = [];
  for (const token of tokens) {
    if (/^\d+$/.test(token)) break; // unread count often follows the room label
    if (/^(오전|오후)$/.test(token)) break;
    if (/^\d{1,2}:\d{2}$/.test(token)) break;
    labelParts.push(token);
    if (labelParts.length >= 2) break; // allow short company/team labels without eating the message
  }
  const label = labelParts[0] || tokens[0] || cleaned.slice(0, 40);
  return `room-label:${label.slice(0, 80)}`;
}

export function roomKeyForDebounce(event = {}) {
  const supplied = String(event.roomKey || event.room_key || '').trim();
  if (/^(?:chat|attr):/.test(supplied)) return supplied;

  const customerName = String(event.customerName || event.customer_name || '').trim();
  if (customerName) return `customer:${sha256(customerName).slice(0, 16)}`;

  const groupingText = normalizePreviewForGrouping(event.previewText || event.preview_text || '');
  return groupingText ? `preview:${sha256(groupingText).slice(0, 16)}` : (supplied || 'unknown-room');
}

function cleanPreviewText(text) {
  return String(text || '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/^중요\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function shouldSkipWorkerForPreview(event = {}) {
  // Preview text is not authoritative conversation context. A trailing thanks,
  // an apparent outbound marker, or a short payment/return acknowledgement can
  // follow an unresolved request. Structural noise is filtered separately;
  // every real message preview must reach Hermes for semantic judgment.
  void event;
  return '';
}

function getSpatialTop(roomKey) {
  const match = /^dom:(\d+):/.exec(String(roomKey || ''));
  return match ? Number(match[1]) : null;
}

function isLikelyShiftedExistingRow(event) {
  if (!CONFIG.ignoreShiftedRows) return false;
  if (event.reason !== 'mutation') return false;
  const top = getSpatialTop(event.roomKey);
  if (top === null) return false;

  // Legacy noise filter. Disabled by default because Kakao's row coordinates are
  // too brittle: a real unread room can appear at top=46 and must not be dropped.
  // Prefer extra AI-reviewed jobs over missed customer inquiries.
  return top >= Number(process.env.CHAT_LIST_FIRST_ROW_MAX_TOP || 44);
}

function parseKoreanPreviewTimeMinutes(text) {
  const matches = Array.from(String(text || '').matchAll(/(오전|오후)\s*(\d{1,2}):(\d{2})/g));
  const match = matches[matches.length - 1];
  if (!match) return null;
  let hour = Number(match[2]);
  const minute = Number(match[3]);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  if (match[1] === '오전') {
    if (hour === 12) hour = 0;
  } else if (hour !== 12) {
    hour += 12;
  }
  return (hour * 60) + minute;
}

function minutesSincePreviewTime(text, now = new Date()) {
  const previewMinutes = parseKoreanPreviewTimeMinutes(text);
  if (previewMinutes === null) return null;
  const nowMinutes = (now.getHours() * 60) + now.getMinutes();
  let diff = nowMinutes - previewMinutes;
  if (diff < -1) diff += 1440;
  return diff;
}

function kstDateParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  const get = (type) => Number(parts.find((part) => part.type === type)?.value || 0);
  return { year: get('year'), month: get('month'), day: get('day') };
}

function dayNumber(year, month, day) {
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000);
}

function normalizeYear(year) {
  if (!year) return null;
  const value = Number(year);
  if (!Number.isFinite(value)) return null;
  return value < 100 ? 2000 + value : value;
}

function resolveDisplayMonthDay(month, day, now = new Date()) {
  const current = kstDateParts(now);
  let year = current.year;
  let diff = dayNumber(year, month, day) - dayNumber(current.year, current.month, current.day);
  if (diff > 180) year -= 1;
  if (diff < -180) year += 1;
  return { year, month, day };
}

function extractTrailingKakaoDisplayDate(text, now = new Date()) {
  const preview = String(text || '').trim();
  const korean = /(?:^|\s)(?:(\d{2,4})년\s*)?(\d{1,2})월\s*(\d{1,2})일\s*$/.exec(preview);
  if (korean) {
    const year = normalizeYear(korean[1]);
    const month = Number(korean[2]);
    const day = Number(korean[3]);
    if (!Number.isFinite(month) || !Number.isFinite(day)) return null;
    return year ? { year, month, day } : resolveDisplayMonthDay(month, day, now);
  }

  const dotted = /(?:^|\s)(\d{2,4})[./-]\s*(\d{1,2})[./-]\s*(\d{1,2})\s*$/.exec(preview);
  if (dotted) {
    const year = normalizeYear(dotted[1]);
    const month = Number(dotted[2]);
    const day = Number(dotted[3]);
    if (!year || !Number.isFinite(month) || !Number.isFinite(day)) return null;
    return { year, month, day };
  }

  return null;
}

function daysSinceDatedPreview(text, now = new Date()) {
  const date = extractTrailingKakaoDisplayDate(text, now);
  if (!date) return null;
  const today = kstDateParts(now);
  return dayNumber(today.year, today.month, today.day) - dayNumber(date.year, date.month, date.day);
}

export function hasUnreadCount(event = {}) {
  const inferred = inferKakaoUnreadCountFromPreview(event.previewText || event.raw?.previewText || '');
  const count = Number(event.unreadCount ?? event.unread_count ?? event.raw?.unreadCount ?? event.raw?.unread_count ?? inferred ?? 0);
  if (Number.isFinite(count) && count > 0) return true;

  // `unreadSignal` historically came from a broad DOM class match (`Badge`).
  // A boolean detached from a visible unread count is not trustworthy enough to
  // let a periodic top-row scan create a worker job or a human-review card.
  // Keep an explicit textual unread label as the safe fallback.
  const preview = String(event.previewText || '');
  return /안읽|읽지\s*않은|새\s*메시지|unread/i.test(preview);
}

export function classifyInitialScanIngress(event = {}, {
  processInitialScan = true,
  hermesTransport = 'cli'
} = {}) {
  if (event?.reason !== 'initial_scan') return { action: 'continue', event };
  if (!hasUnreadCount(event)) return { action: 'ignore', reason: 'initial_scan_without_unread' };
  const gatewayEnabled = ['gateway', 'gateway_no_send'].includes(resolveHermesTransport(hermesTransport));
  if (!gatewayEnabled && !processInitialScan) return { action: 'ignore', reason: 'initial_scan_disabled' };
  return {
    action: 'queue',
    event: {
      ...event,
      reason: 'startup_catchup',
      originalReason: 'initial_scan',
      recoveryOnly: true
    }
  };
}

function hasDatedPreview(text) {
  return daysSinceDatedPreview(text) !== null;
}

function isRecentDatedPreview(text, now = new Date()) {
  const days = daysSinceDatedPreview(text, now);
  return days !== null && days >= 0 && days <= CONFIG.readBackstopLookbackDays;
}

function isRecentClockPreview(text, now = new Date()) {
  const ageMinutes = minutesSincePreviewTime(text, now);
  return ageMinutes !== null
    && ageMinutes >= -1
    && ageMinutes <= CONFIG.readBackstopLookbackHours * 60;
}

function isRecentReadCatchupPreview(text, now = new Date()) {
  const preview = String(text || '');
  if (isActionChromePreview(preview)) return false;
  return isRecentClockPreview(preview, now) || isRecentDatedPreview(preview, now);
}

function isLiveTopRowPreview(text, now = new Date()) {
  const preview = String(text || '');
  if (isActionChromePreview(preview)) return false;
  if (/방금|몇\s*분\s*전/.test(preview)) return true;
  const ageMinutes = minutesSincePreviewTime(preview, now);
  return ageMinutes !== null
    && ageMinutes >= -1
    && ageMinutes <= CONFIG.topRowLiveWindowMinutes;
}

export function shouldQueueTopRowEvent(event) {
  if (isActionChromePreview(event.previewText)) return false;
  if (hasUnreadCount(event)) return !hasDatedPreview(event.previewText) || isRecentDatedPreview(event.previewText);
  if (event.reason === 'top_rows_backstop') return false;
  return event.reason === 'top_row_changed'
    && isLiveTopRowPreview(event.previewText);
}

function hasLivePreviewTime(text) {
  const preview = String(text || '');
  return /방금|몇\s*분\s*전/.test(preview) || parseKoreanPreviewTimeMinutes(preview) !== null;
}

function isStaleDatedMutation(event = {}) {
  return event.reason === 'mutation'
    && hasDatedPreview(event.previewText)
    && !isRecentDatedPreview(event.previewText)
    && !hasLivePreviewTime(event.previewText);
}

function isActionChromePreview(text) {
  const preview = String(text || '').trim();
  if (!preview) return true;
  const exactNoise = new Set([
    '저장하기',
    '보낸 메시지 가이드',
    '메모 내용 미리보기',
    '사이드 메뉴 열기',
    '중요 채팅방 해제',
    '채팅 메시지 입력 폼 전송',
    '카카오비즈니스 이용약관'
  ]);
  if (exactNoise.has(preview)) return true;
  if (/^(?:hellodesk\s+)?저장하기\s+(오전|오후)\s*\d{1,2}:?\d{2}$/.test(preview)) return true;
  if (/채널추가 요청 메시지|친구추가 요청 메시지|메시지 꾸미기|쿠폰 첨부|기본 메시지로 설정/.test(preview)) return true;
  // 알림톡/브랜드메시지 발송 지점에 파트너센터가 렌더링하는 placeholder. 이게 방의 마지막
  // 메시지라는 건 '고객이 아니라 알림톡이 마지막'이라는 뜻이므로 상담 감지 대상이 아니다
  // (2026-08-11 사례A: 이 placeholder가 실 답장처럼 수집·오인되는 오염 확인).
  if (preview.includes('알림톡/브랜드메시지는 관리자센터에서 확인할 수 없어요')) return true;
  return false;
}

function compactQueueAuditText(value, maxLength = 1200) {
  const text = String(value || '').trim();
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 1))}…` : text;
}

export function compactQueueAuditRecord(filename, object = {}) {
  // Queue files are audit/status streams, not the source of truth: the full
  // normalized event is already persisted in Supabase. Logging raw extension
  // DOM snapshots here used tens of GB per day and eventually made the bridge
  // unreliable. Keep the fields consumed by the watchdog and short evidence.
  const base = {
    at: object.at || '',
    receivedAt: object.receivedAt || '',
    detectedAt: object.detectedAt || '',
    status: object.status || '',
    reason: object.reason || '',
    jobId: object.jobId || '',
    roomKey: object.roomKey || object.room_key || '',
    customerName: object.customerName || object.customer_name || '',
    previewText: compactQueueAuditText(object.previewText || object.preview_text || '', 600)
  };
  if (filename === 'worker-results.ndjson') {
    const result = object.result || {};
    return {
      ...base,
      result: {
        code: result.code ?? null,
        signal: result.signal || null,
        timedOut: result.timedOut === true,
        ...(result.audit ? { audit: result.audit } : {}),
        stdoutTail: compactQueueAuditText(result.stdout, 1600),
        stderrTail: compactQueueAuditText(result.stderr, 1600)
      }
    };
  }
  if (filename === 'errors.ndjson') {
    const correlation = typeof object.eventCorrelationSha256 === 'string'
      && /^[0-9a-f]{64}$/.test(object.eventCorrelationSha256)
      ? { eventCorrelationSha256: object.eventCorrelationSha256 }
      : {};
    if (object.type === 'immediate_notification') {
      return {
        at: object.at || '',
        type: 'immediate_notification',
        ...correlation
      };
    }
    return {
      ...base,
      type: object.type || '',
      message: compactQueueAuditText(object.message || object.error || '', 1600),
      ...correlation
    };
  }
  return base;
}

function rotateQueueLogIfNeeded(filename, incomingBytes, queueDir = CONFIG.queueDir) {
  const filePath = path.join(queueDir, filename);
  try {
    const stat = fs.statSync(filePath);
    if (stat.size + incomingBytes <= CONFIG.queueLogMaxBytes) return;
    const archivePath = `${filePath}.${Date.now()}.${process.pid}`;
    fs.renameSync(filePath, archivePath);
    const prefix = `${filename}.`;
    const archives = fs.readdirSync(queueDir)
      .filter((entry) => entry.startsWith(prefix))
      .map((entry) => ({ entry, mtimeMs: fs.statSync(path.join(queueDir, entry)).mtimeMs }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    archives.slice(CONFIG.queueLogArchiveCount).forEach(({ entry }) => {
      try { fs.unlinkSync(path.join(queueDir, entry)); } catch (_) {}
    });
  } catch (error) {
    if (error?.code !== 'ENOENT') console.warn(`[kakao-dom-bridge] queue log rotation failed for ${filename}: ${error.message}`);
  }
}

function appendNdjson(filename, object, queueDir = CONFIG.queueDir) {
  fs.mkdirSync(queueDir, { recursive: true });
  const record = compactQueueAuditRecord(filename, object);
  const line = `${JSON.stringify(record)}\n`;
  rotateQueueLogIfNeeded(filename, Buffer.byteLength(line), queueDir);
  fs.appendFileSync(path.join(queueDir, filename), line, 'utf8');
}

export function createErrorsAuditAppender({ queueDir = CONFIG.queueDir } = {}) {
  const resolvedQueueDir = path.resolve(queueDir);
  return (object) => appendNdjson('errors.ndjson', object, resolvedQueueDir);
}

// Node 22+는 unhandledRejection 기본 동작이 프로세스 즉시 종료다. 이 브리지는 Supabase/Slack/
// CDP fetch 루프 덩어리라 자원 압박·네트워크 순단 시 abort 에러가 폭풍치는데, catch 밖의 거부
// 하나로 상주 브리지가 통째로 죽으면 안 된다 (2026-08-11 20:05 실측: abort 폭풍 10분 뒤 기록
// 없이 사망 → 워치독 치유 지연과 겹쳐 장시간 장애). 거부는 기록하고 계속 살고, 동기 예외는
// 기록 후 종료해 워치독이 깨끗한 상태로 재기동하게 한다.
process.on('unhandledRejection', (reason) => {
  try {
    appendNdjson('errors.ndjson', { at: nowIso(), type: 'process_unhandled_rejection', message: String(reason?.stack || reason).slice(0, 2000) });
  } catch {}
});
process.on('uncaughtException', (error) => {
  try {
    appendNdjson('errors.ndjson', { at: nowIso(), type: 'process_uncaught_exception', message: String(error?.stack || error).slice(0, 2000) });
  } catch {}
  process.exit(1);
});

function supabaseConfigured() {
  return Boolean(CONFIG.supabaseUrl && CONFIG.supabaseServiceRoleKey && CONFIG.supabaseTable);
}

function supabaseTableEndpoint() {
  return `${CONFIG.supabaseUrl.replace(/\/$/, '')}/rest/v1/${encodeURIComponent(CONFIG.supabaseTable)}`;
}

function supabaseFollowUpEndpoint() {
  return `${CONFIG.supabaseUrl.replace(/\/$/, '')}/rest/v1/${encodeURIComponent(CONFIG.followUpTable)}`;
}

function supabaseHeaders(prefer = '') {
  const headers = {
    apikey: CONFIG.supabaseServiceRoleKey,
    authorization: `Bearer ${CONFIG.supabaseServiceRoleKey}`,
    'content-type': 'application/json'
  };
  if (prefer) headers.prefer = prefer;
  return headers;
}

async function supabaseFetchWithTimeout(endpoint, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONFIG.supabaseTimeoutMs);
  const response = await fetchWithDnsFallback(endpoint, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer));
  const text = await response.text().catch(() => '');
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  return { response, text, data };
}

async function fetchSupabaseEventByHash(eventHash) {
  if (!supabaseConfigured() || !eventHash) return null;
  const url = new URL(supabaseTableEndpoint());
  url.searchParams.set('event_hash', `eq.${eventHash}`);
  url.searchParams.set('select', 'id,status,room_key,event_hash,created_at,updated_at,claimed_at,completed_at,error_message,payload');
  url.searchParams.set('limit', '1');
  const { response, text, data } = await supabaseFetchWithTimeout(url.toString(), {
    method: 'GET',
    headers: supabaseHeaders()
  });
  if (!response.ok) throw new Error(`Supabase lookup failed: ${response.status} ${text}`);
  return Array.isArray(data) && data.length ? data[0] : null;
}

async function fetchSupabaseRowsByStatuses(statuses = [], limit = 20) {
  if (!supabaseConfigured() || !statuses.length) return [];
  const url = new URL(supabaseTableEndpoint());
  const cutoff = new Date(Date.now() - CONFIG.supabaseRecoveryLookbackHours * 60 * 60_000).toISOString();
  url.searchParams.set('status', `in.(${statuses.join(',')})`);
  url.searchParams.set('created_at', `gte.${cutoff}`);
  url.searchParams.set('select', 'id,status,room_key,event_hash,preview_text,unread_count,detected_at,created_at,updated_at,claimed_at,completed_at,error_message,payload');
  url.searchParams.set('order', 'updated_at.desc');
  url.searchParams.set('limit', String(limit));
  const { response, text, data } = await supabaseFetchWithTimeout(url.toString(), {
    method: 'GET',
    headers: supabaseHeaders()
  });
  if (!response.ok) throw new Error(`Supabase recovery lookup failed: ${response.status} ${text}`);
  return Array.isArray(data) ? data : [];
}

async function updateSupabaseEventByHash(eventHash, patch) {
  if (!supabaseConfigured() || !eventHash || !patch) return { skipped: true };
  const url = new URL(supabaseTableEndpoint());
  url.searchParams.set('event_hash', `eq.${eventHash}`);
  const { response, text, data } = await supabaseFetchWithTimeout(url.toString(), {
    method: 'PATCH',
    headers: supabaseHeaders('return=representation'),
    body: JSON.stringify(patch)
  });
  if (!response.ok) throw new Error(`Supabase update failed: ${response.status} ${text}`);
  return { ok: true, row: Array.isArray(data) ? data[0] : data };
}

async function writeSupabaseEvent(eventOrJob, kind) {
  if (!supabaseConfigured()) return { skipped: true };

  const endpoint = supabaseTableEndpoint();
  const payload = {
    source: eventOrJob.source || 'kakao_channel_manager_dom',
    status: kind === 'job' ? 'ready_for_ai_worker' : 'pending_ai_review',
    room_key: eventOrJob.roomKey,
    event_hash: eventOrJob.eventHash || eventOrJob.jobId,
    preview_text: eventOrJob.previewText || '',
    unread_count: eventOrJob.unreadCount ?? null,
    detected_at: eventOrJob.detectedAt || nowIso(),
    payload: eventOrJob
  };

  const { response, text } = await supabaseFetchWithTimeout(endpoint, {
    method: 'POST',
    headers: supabaseHeaders('return=minimal'),
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    if (response.status === 409 && (text.includes('duplicate key value') || text.includes('23505') || text.includes('event_hash'))) {
      const existing = await fetchSupabaseEventByHash(payload.event_hash).catch((error) => ({ lookupError: error.message }));
      return { skipped: true, duplicate: true, existing };
    }
    throw new Error(`Supabase insert failed: ${response.status} ${text}`);
  }
  return { ok: true };
}

function isDuplicateProcessingStale(existing = {}, now = new Date()) {
  const reference = Date.parse(existing.claimed_at || existing.updated_at || existing.created_at || '');
  if (!Number.isFinite(reference)) return true;
  const staleMs = Math.max(CONFIG.workerTimeoutMs * 2, 10 * 60_000);
  return now.getTime() - reference > staleMs;
}

function shouldRunDuplicateJob(existing = {}) {
  const status = String(existing?.status || '');
  if (!status) return true;
  if (status === 'processing_by_ai_worker') return isDuplicateProcessingStale(existing);

  // Do not re-enqueue the same unread/backstop job on every DOM scan while the
  // durable recovery sweeper is responsible for ready/error rows. The previous
  // behaviour requeued duplicate ready_for_ai_worker rows indefinitely, which
  // kept the in-memory worker queue full and delayed real auto-replies.
  if (['ready_for_ai_worker', 'pending_ai_review'].includes(status)) {
    return rowAgeMs(existing, ['updated_at', 'created_at']) > Math.max(CONFIG.workerTimeoutMs * 2, 10 * 60_000);
  }
  if (status === 'ai_worker_error') {
    if (recoveryAttemptCount(existing) >= CONFIG.supabaseRecoveryMaxAttempts) return false;
    return rowAgeMs(existing) >= CONFIG.supabaseRecoveryErrorRetryMs;
  }
  if (status === 'ai_decision_ready_no_sheet_write') return false;
  return false;
}

function duplicateSkipReason(existing = {}) {
  const status = String(existing?.status || '');
  if (status === 'processing_by_ai_worker') return 'duplicate_supabase_job_in_progress';
  if (['ready_for_ai_worker', 'pending_ai_review'].includes(status)) return 'duplicate_supabase_job_waiting_for_recovery_sweeper';
  if (status === 'ai_worker_error') return 'duplicate_supabase_job_error_retry_cooldown';
  return 'duplicate_supabase_job_already_handled';
}

function parseWorkerStdoutJson(workerResult = {}) {
  const stdout = String(workerResult.stdout || '').trim();
  if (!stdout) return null;
  try {
    return JSON.parse(stdout);
  } catch {
    const start = stdout.indexOf('{');
    const end = stdout.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { return JSON.parse(stdout.slice(start, end + 1)); } catch {}
    }
  }
  return null;
}

export function mapWorkerPayloadToSupabaseStatus(workerPayload = {}) {
  if (workerPayload.status === 'superseded_by_newer_room_event' || workerPayload.superseded === true) {
    return { status: 'superseded_by_newer_room_event', error_message: null };
  }
  const decision = workerPayload.decision || {};
  const sheetResult = workerPayload.sheetResult || workerPayload.sheet_result || {};
  if (decision?.should_write_to_sheet === true && sheetResult?.success === true) {
    return { status: 'needs_human_review', error_message: null };
  }
  if (decision?.should_write_to_sheet === true && sheetResult?.success === false) {
    const errorMessage = String(sheetResult.error || 'GAS rejected sheet write').slice(0, 500);
    if (sheetResult.error_type === 'duplicate_request') {
      return { status: 'ai_skipped_needs_review', error_message: `GAS duplicate skipped: ${errorMessage}` };
    }
    return { status: 'needs_human_review', error_message: `GAS sheet write rejected: ${errorMessage}` };
  }
  if (decision?.should_write_to_sheet === true) {
    return { status: 'ai_decision_ready_no_sheet_write', error_message: 'AI wanted sheet write, but sheet append was not completed' };
  }
  return { status: 'ai_skipped_needs_review', error_message: String(decision?.reason || '').slice(0, 500) || null };
}

function buildWorkerResultPatch(job, workerResult) {
  const workerPayload = parseWorkerStdoutJson(workerResult);
  if (!workerPayload) {
    return {
      status: 'ai_worker_error',
      error_message: 'Worker completed but stdout result was not parseable',
      completed_at: nowIso(),
      payload: {
        ...job,
        ai_worker_result: {
          parse_error: true,
          stdout_tail: String(workerResult?.stdout || '').slice(-4000),
          stderr_tail: String(workerResult?.stderr || '').slice(-4000)
        }
      }
    };
  }

  const statusPatch = mapWorkerPayloadToSupabaseStatus(workerPayload);
  return {
    ...statusPatch,
    completed_at: nowIso(),
    payload: {
      ...job,
      ai_worker_result: {
        decision: workerPayload.decision || null,
        sheet_result: workerPayload.sheetResult || null,
        follow_up_result: workerPayload.followUpResult || null,
        auto_reply_result: workerPayload.autoReplyResult || null,
        close_result: workerPayload.closeResult || null,
        status: workerPayload.status || null
      }
    }
  };
}

function shouldEscalateCompletedWorkerSkip(job = {}, workerPayload = {}) {
  const decision = workerPayload.decision || {};
  const followUpResult = workerPayload.followUpResult || workerPayload.follow_up_result || {};
  const sheetResult = workerPayload.sheetResult || workerPayload.sheet_result || null;
  const insertedFollowUps = Number(followUpResult.inserted || 0);
  if (insertedFollowUps > 0 || (Array.isArray(followUpResult.rows) && followUpResult.rows.length > 0)) return false;
  if (decision.should_write_to_sheet === true || sheetResult?.success === true) return false;

  const reason = String(decision.reason || '').toLowerCase();
  const chatStatus = String(decision.customer?.chat_status || '').toLowerCase();

  // A completed worker can still silently drop a real reservation when the Kakao
  // room could not be opened and the worker correctly refuses preview-only
  // classification. Those cases must become a human-review card, not disappear.
  return /matching kakao conversation not|not opened|not visible|chat[_ -]?row[_ -]?not[_ -]?found|preview only|preview-only/.test(reason)
    || /not opened|not found|not visible|chat_row_not_found|preview/.test(chatStatus);
}

export function semanticPreviewIdentity(value = '') {
  return cleanPreviewText(value)
    .replace(/^(\S+)\s+\d+\s+/, '$1 ')
    .trim();
}

export function semanticRoomEventIdentity(event = {}) {
  const preview = semanticPreviewIdentity(event.previewText || event.preview_text || '');
  const displayTime = String(
    event.displayTime
    || event.display_time
    || event.raw?.displayTime
    || event.raw?.display_time
    || ''
  ).trim();
  return [preview, displayTime].filter(Boolean).join('\n');
}

export function registerAcceptedRoomEvent(versions, roomKey, semanticIdentity, durableRevision = 0) {
  if (!(versions instanceof Map)) throw new TypeError('versions must be a Map');
  const key = String(roomKey || '').trim();
  const identity = String(semanticIdentity || '').trim();
  if (!key || !identity) throw new Error('roomKey and semanticIdentity are required');
  const previous = versions.get(key) || { revision: 0, semanticIdentity: '' };
  if (previous.semanticIdentity === identity) {
    const synchronizedRevision = Math.max(Number(previous.revision || 0), Number(durableRevision || 0));
    if (synchronizedRevision !== previous.revision) {
      versions.set(key, { revision: synchronizedRevision, semanticIdentity: identity });
    }
    return { roomKey: key, revision: synchronizedRevision, changed: false };
  }
  const next = {
    revision: Math.max(Number(previous.revision || 0), Number(durableRevision || 0)) + 1,
    semanticIdentity: identity
  };
  versions.set(key, next);
  return { roomKey: key, revision: next.revision, changed: true };
}

function createSerialExecutor() {
  let tail = Promise.resolve();
  let queued = 0;
  let active = 0;
  return {
    run(task) {
      queued += 1;
      const execute = async () => {
        queued = Math.max(0, queued - 1);
        active += 1;
        try {
          return await task();
        } finally {
          active = Math.max(0, active - 1);
        }
      };
      const result = tail.then(execute, execute);
      tail = result.catch(() => {});
      return result;
    },
    status() { return { active, queued }; }
  };
}

function createBoundedExecutor(limit = 2) {
  const concurrency = Math.max(1, Number(limit || 1));
  const queue = [];
  let active = 0;
  const drain = () => {
    while (active < concurrency && queue.length) {
      const entry = queue.shift();
      active += 1;
      Promise.resolve()
        .then(entry.task)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          active = Math.max(0, active - 1);
          drain();
        });
    }
  };
  return {
    run(task) {
      return new Promise((resolve, reject) => {
        queue.push({ task, resolve, reject });
        drain();
      });
    },
    status() { return { active, queued: queue.length, concurrency }; }
  };
}

export function createKakaoPhaseScheduler({
  capture,
  decide,
  apply,
  finalize,
  manualSend,
  decisionConcurrency = 2,
  workerTimeoutMs = 0,
  now = Date.now
} = {}) {
  for (const [name, fn] of Object.entries({ capture, decide, apply, finalize, manualSend })) {
    if (typeof fn !== 'function') throw new TypeError(`${name} must be a function`);
  }
  const domLane = createSerialExecutor();
  const decisionLane = createBoundedExecutor(decisionConcurrency);
  return {
    async run(job, options = {}) {
      const controller = new AbortController();
      const externalSignal = options.signal || null;
      const propagateExternalAbort = () => {
        if (!controller.signal.aborted) {
          controller.abort(externalSignal?.reason || new Error('kakao_phase_aborted'));
        }
      };
      if (externalSignal?.aborted) propagateExternalAbort();
      else externalSignal?.addEventListener('abort', propagateExternalAbort, { once: true });
      const timeoutMs = Number(workerTimeoutMs);
      const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => controller.abort(new Error(`worker timed out after ${timeoutMs}ms`)), timeoutMs)
        : null;
      timer?.unref?.();
      const signal = controller.signal;
      const throwIfAborted = () => {
        if (!signal?.aborted) return;
        throw signal.reason instanceof Error
          ? signal.reason
          : new Error(String(signal.reason || 'kakao_phase_aborted'));
      };
      try {
        const totalStartedAt = now();
        const phaseTimings = {};
        throwIfAborted();
        const captureQueuedAt = now();
        const snapshot = await domLane.run(async () => {
          throwIfAborted();
          const startedAt = now();
          phaseTimings.captureQueueMs = startedAt - captureQueuedAt;
          try { return await capture(job, { signal }); }
          finally { phaseTimings.captureMs = now() - startedAt; }
        });
        throwIfAborted();
        const decisionQueuedAt = now();
        const prepared = await decisionLane.run(async () => {
          throwIfAborted();
          const startedAt = now();
          phaseTimings.decisionQueueMs = startedAt - decisionQueuedAt;
          try { return await decide(snapshot, job, { signal }); }
          finally { phaseTimings.decisionMs = now() - startedAt; }
        });
        throwIfAborted();
        const applyQueuedAt = now();
        const applied = await domLane.run(async () => {
          throwIfAborted();
          const startedAt = now();
          phaseTimings.applyQueueMs = startedAt - applyQueuedAt;
          try { return await apply(prepared, job, { signal }); }
          finally { phaseTimings.applyMs = now() - startedAt; }
        });
        throwIfAborted();
        const finalizeStartedAt = now();
        const finalized = await finalize(applied, job, { signal });
        phaseTimings.finalizeMs = now() - finalizeStartedAt;
        phaseTimings.totalMs = now() - totalStartedAt;
        return finalized && typeof finalized === 'object'
          ? { ...finalized, phaseTimings }
          : { value: finalized, phaseTimings };
      } finally {
        if (timer) clearTimeout(timer);
        externalSignal?.removeEventListener('abort', propagateExternalAbort);
      }
    },
    runManual(payload) {
      return domLane.run(() => manualSend(payload));
    },
    status() {
      return { dom: domLane.status(), decision: decisionLane.status() };
    }
  };
}

function pickFiniteTimingFields(value, names) {
  const result = {};
  for (const name of names) {
    const number = Number(value?.[name]);
    if (Number.isFinite(number) && number >= 0) result[name] = Math.round(number);
  }
  return result;
}

export function buildWorkerResultAudit(payload = {}, elapsedMs = 0) {
  const status = String(payload?.status || '').trim().slice(0, 80);
  const hermesAttempts = Math.max(0, Math.floor(Number(payload?.hermesAttempts || 0) || 0));
  return {
    status,
    elapsedMs: Math.max(0, Math.round(Number(elapsedMs) || 0)),
    hermesAttempts,
    hermesRecovered: payload?.hermesRecovered === true,
    timings: pickFiniteTimingFields(payload?.timings, [
      'lookupMs', 'hermesMs', 'sheetAndReconciliationMs', 'totalMs'
    ]),
    phaseTimings: pickFiniteTimingFields(payload?.phaseTimings, [
      'captureQueueMs', 'captureMs', 'decisionQueueMs', 'decisionMs',
      'applyQueueMs', 'applyMs', 'finalizeMs', 'totalMs'
    ])
  };
}

function buildStableJobId(roomKey, events = []) {
  // Mutation/backstop scans attach a fresh event hash and the unread badge may
  // disappear while the same customer message is being processed. Neither is a
  // new business turn. Key the durable job by the visible semantic preview so a
  // completed message cannot launch Hermes again and time out minutes later.
  const identities = [...new Set(events
    .map((event) => semanticRoomEventIdentity(event))
    .filter(Boolean))]
    .sort();
  return `dom-${sha256(`${roomKey}:${identities.join('|')}`).slice(0, 16)}`;
}

function buildAiFirstJob(roomKey, roomState) {
  const events = roomState.events.slice();
  const latest = events[events.length - 1] || {};
  const unreadCounts = events
    .map((event) => Number(event.unreadCount ?? event.unread_count ?? event.raw?.unreadCount ?? event.raw?.unread_count ?? 0))
    .filter((count) => Number.isFinite(count) && count > 0);
  return {
    jobId: buildStableJobId(roomKey, events),
    source: 'kakao_channel_manager_dom',
    reason: 'kakao_channel_manager_dom_event_debounced',
    status: 'ready_for_ai_worker',
    roomKey,
    roomRevision: Number(latest.roomRevision || latest.room_revision || 0),
    detectedAt: latest.detectedAt || nowIso(),
    firstEventAt: roomState.firstAt,
    lastEventAt: roomState.lastAt,
    eventCount: events.length,
    previewText: latest.previewText || '',
    customerName: latest.customerName || latest.customer_name || latest.raw?.customerName || latest.raw?.customer_name || '',
    messagePreview: latest.messagePreview || latest.message_preview || latest.raw?.messagePreview || latest.raw?.message_preview || '',
    displayTime: latest.displayTime || latest.display_time || latest.raw?.displayTime || latest.raw?.display_time || '',
    unreadCount: unreadCounts.length ? Math.max(...unreadCounts) : null,
    events,
    instructions: [
      '이 payload는 판단 결과가 아니라 새 상담 감지 알림이다.',
      '카카오 채널 관리자 브라우저 화면을 직접 열어서 해당 상담을 확인한다.',
      '코드/queue/RAG의 추론을 믿지 말고 화면 맥락을 우선한다.',
      'RAG는 필요할 때만 장기기억 도구로 사용한다.',
      '답장/시트 처리에 과도하게 보수적으로 굴지 말고, 현재 구현된 write 경로 안에서 적극적으로 처리한다.',
      '예약 확정, 금액 확정, 재고 가능 단정은 승인된 조회/확정 흐름 없이 실행하지 않는다.'
    ]
  };
}

function objectPayload(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function latestEventFromJob(job = {}) {
  const events = Array.isArray(job.events) ? job.events : [];
  return events[events.length - 1] || {};
}

function extractCustomerNameFromText(value) {
  const text = cleanPreviewText(value);
  if (!text) return '';
  const timeIndex = text.search(/(?:오전|오후)\s*\d{1,2}:?\d{2}|방금|몇\s*분\s*전|\d{4}\.\s*\d{1,2}\.\s*\d{1,2}/);
  const head = (timeIndex > 0 ? text.slice(0, timeIndex) : text.split(/\s+/)[0])
    .replace(/[|:>-]+$/g, '')
    .trim();
  if (!head || head.length > 40) return '';
  return head;
}

function customerNameForJob(job = {}) {
  const latest = latestEventFromJob(job);
  return String(
    job.customerName
    || job.customer_name
    || job.roomTitle
    || job.room_title
    || latest.customerName
    || latest.customer_name
    || latest.roomTitle
    || latest.room_title
    || extractCustomerNameFromText(job.previewText || latest.previewText || '')
    || '미확인 고객'
  ).slice(0, 120);
}

function previewForJob(job = {}) {
  const latest = latestEventFromJob(job);
  return String(job.previewText || job.preview_text || latest.previewText || latest.preview_text || '').slice(0, 1000);
}

function followUpConfig() {
  // buildSlackRoutingConfig가 빠지면 브리지 발송 카드가 2채널 라우팅을 무시하고
  // 레거시 agent 채널로 새어 나간다 (2026-08-08 기타문의/스케쥴-agent 유출 원인).
  return {
    ...buildSlackRoutingConfig(process.env),
    supabaseUrl: CONFIG.supabaseUrl,
    serviceRoleKey: CONFIG.supabaseServiceRoleKey,
    followUpTable: CONFIG.followUpTable,
    slackFollowUpEnabled: CONFIG.slackCardDeliveryEnabled,
    slackThreadFollowUpsEnabled: process.env.SLACK_FOLLOW_UP_THREAD_REPLIES !== '0',
    slackBotToken: CONFIG.slackBotToken,
    slackChannels: CONFIG.slackChannels,
    slackMentionUserIds: String(process.env.SLACK_CARD_MENTION_USER_IDS || '')
      .split(/[\s,]+/)
      .filter(Boolean),
    kakaoChannelManagerUrl: process.env.KAKAO_CHANNEL_MANAGER_URL || ''
  };
}

async function createWorkerFailureFollowUp(job = {}, error = new Error('worker failed'), context = {}) {
  if (!supabaseConfigured()) return { skipped: true, reason: 'supabase_not_configured' };
  const preview = previewForJob(job);
  const customerName = customerNameForJob(job);
  const jobId = String(job.jobId || job.eventHash || job.id || 'unknown-job');
  const roomKey = String(job.roomKey || job.room_key || '').slice(0, 240);
  const failureKind = context.timeout ? 'worker_timeout' : 'worker_error';
  const titleName = customerName && customerName !== '미확인 고객' ? customerName : '카카오 문의';
  const humanFailureClass = context.timeout ? 'reservation_review_timeout' : 'automation_error_review';
  const humanSummary = context.timeout
    ? '자동 처리 제한 시간을 넘겨 사람 확인으로 전환됐습니다. 카카오 원문과 확인요청/계약마스터를 대조해 누락 여부를 확인하세요.'
    : `자동 처리 중 오류가 발생해 사람 확인으로 전환됐습니다: ${String(error.message || error).slice(0, 300)}`;
  const row = {
    follow_up_key: `bridge-failure:${roomKey || 'unknown-room'}:${sha256(`${jobId}:${preview}:${failureKind}`).slice(0, 16)}`,
    source: 'kakao_dom_bridge',
    job_id: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(job.id || '')) ? job.id : null,
    room_key: roomKey,
    customer_name: customerName,
    type: 'reply_needed',
    priority: 'urgent',
    status: 'open',
    title: context.timeout ? `${titleName} 예약 후보 확인 필요` : `${titleName} 자동 처리 확인 필요`,
    summary: humanSummary,
    recommended_action: '카카오 채팅방을 직접 열어 원문을 확인하고, 확인요청/계약마스터에 이미 처리됐는지 대조하세요. 누락이면 확인요청 입력 또는 답변을 처리하세요.',
    suggested_reply_draft: '감독님, 확인 후 바로 안내드리겠습니다.',
    evidence: [preview, `jobId: ${jobId}`].filter(Boolean).slice(0, 12),
    blocking_reason: context.timeout ? '자동 처리 제한 시간 초과로 사람 확인 전환' : String(error.message || error).slice(0, 1000),
    due_hint: 'now',
    decision_classification: humanFailureClass,
    decision_confidence: 'blocked',
    payload: {
      card_kind: 'inquiry_case',
      failure_kind: failureKind,
      job_id: jobId,
      room_key: roomKey,
      preview_text: preview,
      technical_error: String(error.message || error).slice(0, 1000),
      recovery_context: context
    }
  };
  const upsertResult = await upsertFollowUpRows(followUpConfig(), [row]);
  if (CONFIG.slackCardDeliveryEnabled && upsertResult?.rows?.length) {
    try {
      const slackDeliveryResult = await deliverSlackFollowUpRows(followUpConfig(), upsertResult.rows);
      return { ...upsertResult, slackDeliveryResult };
    } catch (deliveryError) {
      appendNdjson('errors.ndjson', {
        at: nowIso(),
        type: 'worker_failure_followup_slack_delivery',
        message: deliveryError.message,
        jobId
      });
      return { ...upsertResult, slackDeliveryError: deliveryError.message };
    }
  }
  return upsertResult;
}

export function shouldDetachWorkerProcess(platform = process.platform) {
  return platform !== 'win32';
}

export function buildWorkerTreeKillInvocation(pid, signal = 'SIGTERM', platform = process.platform) {
  if (platform !== 'win32') return null;
  const args = ['/PID', String(pid), '/T'];
  if (signal === 'SIGKILL') args.push('/F');
  return {
    command: 'taskkill.exe',
    args,
    options: { shell: false, stdio: 'ignore', windowsHide: true }
  };
}

function killProcessTree(child, signal = 'SIGTERM') {
  if (!child?.pid) return;
  const windowsKill = buildWorkerTreeKillInvocation(child.pid, signal);
  if (windowsKill) {
    try {
      const result = spawnSync(windowsKill.command, windowsKill.args, windowsKill.options);
      // taskkill without /F exits non-zero for console apps ("can only be
      // terminated forcefully") — treating that as success made the graceful
      // pass a silent no-op. Only trust exit status 0.
      if (!result.error && result.status === 0) return;
    } catch {}
  }
  if (process.platform === 'win32') {
    // POSIX group kill (-pid) throws on Windows and would orphan the real
    // worker behind the cmd.exe shell wrapper; kill the direct child instead.
    try { child.kill(signal); } catch {}
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    try { child.kill(signal); } catch {}
  }
}

function appendLimited(current, chunk, limit = 20_000) {
  const next = current + chunk.toString();
  return next.length > limit ? next.slice(-limit) : next;
}

const WORKER_STDOUT_LIMIT = 2_000_000;
const WORKER_STDERR_LIMIT = 50_000;

function runWorker(job) {
  if (!CONFIG.workerCommand) return Promise.resolve({ skipped: true });

  return new Promise((resolve, reject) => {
    const child = spawn(CONFIG.workerCommand, {
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
      detached: shouldDetachWorkerProcess()
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      const error = new Error(`worker timed out after ${CONFIG.workerTimeoutMs}ms`);
      appendNdjson('errors.ndjson', { at: nowIso(), type: 'worker_timeout', message: error.message, jobId: job.jobId, job });
      killProcessTree(child, 'SIGTERM');
      setTimeout(() => killProcessTree(child, 'SIGKILL'), 3000).unref?.();
      finish(reject, error);
    }, CONFIG.workerTimeoutMs);

    child.stdout.on('data', (chunk) => { stdout = appendLimited(stdout, chunk, WORKER_STDOUT_LIMIT); });
    child.stderr.on('data', (chunk) => { stderr = appendLimited(stderr, chunk, WORKER_STDERR_LIMIT); });
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code, signal) => {
      const result = { code, signal, timedOut, stdout, stderr };
      appendNdjson('worker-results.ndjson', { at: nowIso(), jobId: job.jobId, result });
      if (code === 0) finish(resolve, result);
      else if (!settled) finish(reject, new Error(`worker exited ${code ?? signal}: ${stderr || stdout}`));
    });

    child.stdin.end(JSON.stringify(job));
  });
}

let workerChain = Promise.resolve();
let kakaoPhaseScheduler = null;
let kakaoWorkerRuntimeConfig = null;
let gatewayResultApplicationCoordinator = null;
let gatewayFailureNotificationCoordinator = null;
let aiJobDispatcher = null;

function getKakaoWorkerRuntimeConfigForTransport() {
  kakaoWorkerRuntimeConfig ||= loadKakaoWorkerRuntimeConfig();
  return configForHermesTransport(kakaoWorkerRuntimeConfig, CONFIG.hermesTransport);
}

async function notifyGatewayTerminalFailure({ durableJob, error }) {
  const job = durableJob?.local_context?.job || {
    jobId: durableJob?.job_id,
    roomKey: durableJob?.room_key,
    roomRevision: durableJob?.room_revision
  };
  const followUpResult = await createWorkerFailureFollowUp(job, error, {
    origin: 'hermes_gateway_terminal_failure',
    failed_at: nowIso(),
    gateway_error_type: String(durableJob?.error?.type || error?.code || 'gateway_job_failed').slice(0, 120)
  });
  assertGatewayFailureNotificationDelivered(followUpResult, {
    slackEnabled: CONFIG.slackCardDeliveryEnabled
  });
  await updateSupabaseEventByHash(durableJob.job_id, {
    status: 'needs_human_review',
    error_message: String(error?.message || error).slice(0, 1000),
    completed_at: nowIso(),
    payload: { ...job, ai_worker_result: { failure_follow_up: followUpResult } }
  });
  return followUpResult;
}

function getGatewayFailureNotificationCoordinator() {
  if (gatewayFailureNotificationCoordinator) return gatewayFailureNotificationCoordinator;
  gatewayFailureNotificationCoordinator = createGatewayFailureNotificationCoordinator({
    channel: gatewayChannel,
    notify: notifyGatewayTerminalFailure
  });
  return gatewayFailureNotificationCoordinator;
}

async function recordGatewayApplicationResult({ durableJob, job, finalized, elapsedMs, localApplicationElapsedMs }) {
  const audit = buildWorkerResultAudit(finalized, elapsedMs);
  audit.localApplicationElapsedMs = Math.max(0, Math.round(Number(localApplicationElapsedMs) || 0));
  const result = {
    code: 0,
    signal: null,
    timedOut: false,
    stdout: JSON.stringify(finalized),
    stderr: '',
    phased: true,
    gateway: true,
    elapsedMs,
    localApplicationElapsedMs,
    audit
  };
  appendNdjson('worker-results.ndjson', { at: nowIso(), jobId: durableJob.job_id, result });
  try {
    await updateSupabaseEventByHash(durableJob.job_id, buildWorkerResultPatch(job, result));
  } catch (error) {
    state.failedSupabaseWrites += 1;
    appendNdjson('errors.ndjson', { at: nowIso(), type: 'gateway_supabase_job_update', message: error.message, jobId: durableJob.job_id });
    throw error;
  }
}

function getGatewayResultApplicationCoordinator() {
  if (gatewayResultApplicationCoordinator) return gatewayResultApplicationCoordinator;
  gatewayResultApplicationCoordinator = createGatewayResultApplicationCoordinator({
    channel: gatewayChannel,
    getConfig: () => getKakaoWorkerRuntimeConfigForTransport(),
    record: recordGatewayApplicationResult,
    onFailure: createGatewayApplicationFailureNotifier({
      slackEnabled: CONFIG.slackCardDeliveryEnabled,
      createFollowUp: ({ job, error, context }) => createWorkerFailureFollowUp(job, error, context),
      updateStatus: updateSupabaseEventByHash,
      now: nowIso
    })
  });
  return gatewayResultApplicationCoordinator;
}

function getKakaoPhaseScheduler() {
  if (kakaoPhaseScheduler) return kakaoPhaseScheduler;
  kakaoWorkerRuntimeConfig = loadKakaoWorkerRuntimeConfig();
  kakaoPhaseScheduler = createKakaoPhaseScheduler({
    decisionConcurrency: CONFIG.aiDecisionConcurrency,
    workerTimeoutMs: CONFIG.workerTimeoutMs,
    capture: (job) => captureKakaoRoomSnapshot({ config: kakaoWorkerRuntimeConfig, job }),
    decide: (capture, job, { signal } = {}) => prepareKakaoDecisionFromSnapshot({
      config: kakaoWorkerRuntimeConfig,
      job,
      capture,
      signal
    }),
    apply: (prepared, job, { signal } = {}) => applyPreparedKakaoDecision({
      config: kakaoWorkerRuntimeConfig,
      job,
      prepared,
      signal
    }),
    finalize: (applied, job) => finalizePreparedKakaoDecision({ config: kakaoWorkerRuntimeConfig, job, applied }),
    manualSend: (payload) => (typeof payload?.execute === 'function' ? payload.execute() : processManualSend(payload))
  });
  return kakaoPhaseScheduler;
}

async function runPhasedWorker(job) {
  const startedAt = Date.now();
  const payload = await getKakaoPhaseScheduler().run(job);
  const elapsedMs = Date.now() - startedAt;
  const result = {
    code: 0,
    signal: null,
    timedOut: false,
    stdout: JSON.stringify(payload),
    stderr: '',
    phased: true,
    elapsedMs,
    audit: buildWorkerResultAudit(payload, elapsedMs)
  };
  appendNdjson('worker-results.ndjson', { at: nowIso(), jobId: job.jobId, result });
  return result;
}
const queuedWorkerSlotsByRoom = new Map();
const manualSendInFlight = new Map();
const manualSendRecent = new Map();

export function mergeQueuedRoomJobs(previous = {}, latest = {}) {
  const seen = new Set();
  const events = [];
  for (const event of [...(previous.events || []), ...(latest.events || [])]) {
    const identity = event?.eventHash || sha256(JSON.stringify(event || {}));
    if (seen.has(identity)) continue;
    seen.add(identity);
    events.push(event);
  }
  return {
    ...previous,
    ...latest,
    firstEventAt: previous.firstEventAt || latest.firstEventAt,
    eventCount: events.length,
    events
  };
}

function normalizeManualSendDedupeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function manualSendDedupeKey(payload = {}) {
  if (payload.allowDuplicate === true || payload.allow_duplicate === true) return '';
  const explicit = normalizeManualSendDedupeText(payload.idempotencyKey || payload.idempotency_key || '');
  if (explicit) return `explicit:${sha256(explicit)}`;
  const keyPayload = {
    customerName: normalizeManualSendDedupeText(payload.customerName || payload.customer_name || ''),
    roomTitle: normalizeManualSendDedupeText(payload.roomTitle || payload.room_title || ''),
    text: normalizeManualSendDedupeText(payload.text || ''),
    customerDocumentAssets: Boolean(payload.customerDocumentAssets || payload.customer_document_assets),
    attachmentPaths: Array.isArray(payload.attachmentPaths || payload.attachment_paths)
      ? (payload.attachmentPaths || payload.attachment_paths).map(normalizeManualSendDedupeText).sort()
      : []
  };
  if (!keyPayload.text || (!keyPayload.customerName && !keyPayload.roomTitle)) return '';
  return `auto:${sha256(JSON.stringify(keyPayload))}`;
}

function pruneManualSendRecent(nowMs = Date.now()) {
  const ttl = Math.max(0, Number(CONFIG.manualSendDedupeWindowMs || 0));
  for (const [key, entry] of manualSendRecent.entries()) {
    if (!entry || nowMs - Number(entry.atMs || 0) > ttl) manualSendRecent.delete(key);
  }
}

function recentManualSendResult(dedupeKey) {
  if (!dedupeKey || CONFIG.manualSendDedupeWindowMs <= 0) return null;
  const nowMs = Date.now();
  pruneManualSendRecent(nowMs);
  const entry = manualSendRecent.get(dedupeKey);
  if (!entry || nowMs - Number(entry.atMs || 0) > CONFIG.manualSendDedupeWindowMs) return null;
  return entry.result || null;
}

function rememberManualSendResult(dedupeKey, result) {
  if (!dedupeKey || CONFIG.manualSendDedupeWindowMs <= 0 || !result?.sent) return;
  manualSendRecent.set(dedupeKey, { atMs: Date.now(), result });
  pruneManualSendRecent();
}

function duplicateManualSendResult(result, reason) {
  return {
    ...(result || {}),
    attempted: true,
    sent: Boolean(result?.sent),
    reason: result?.sent ? reason : (result?.reason || reason),
    deduped: true,
    dedupeReason: reason
  };
}

function enqueueWorker(job) {
  if (!CONFIG.workerCommand && !CONFIG.aiDomSplitEnabled) return Promise.resolve({ skipped: true });
  const jobId = String(job?.jobId || '');
  if (jobId && state.activeWorkerJobIds.has(jobId)) {
    const result = { skipped: true, reason: 'local_duplicate_job_active', jobId };
    appendNdjson('worker-skipped.ndjson', { at: nowIso(), jobId, reason: result.reason, roomKey: job.roomKey || '' });
    console.info('[dom-bridge] worker skipped local duplicate job', jobId, job.roomKey || '');
    return Promise.resolve(result);
  }

  const roomKey = String(job?.roomKey || '');
  const existingSlot = roomKey ? queuedWorkerSlotsByRoom.get(roomKey) : null;
  if (existingSlot && !existingSlot.started) {
    const supersededJob = existingSlot.job;
    const supersededJobId = String(supersededJob?.jobId || '');
    if (supersededJobId) state.activeWorkerJobIds.delete(supersededJobId);
    existingSlot.external?.resolve({
      skipped: true,
      reason: 'superseded_by_newer_room_event',
      jobId: supersededJobId,
      supersededBy: jobId
    });
    existingSlot.job = mergeQueuedRoomJobs(supersededJob, job);
    if (jobId) state.activeWorkerJobIds.add(jobId);
    appendNdjson('worker-coalesced.ndjson', {
      at: nowIso(),
      roomKey,
      supersededJobId,
      replacementJobId: jobId,
      eventCount: existingSlot.job.eventCount
    });
    return new Promise((resolve, reject) => {
      existingSlot.external = { resolve, reject };
    });
  }

  if (jobId) state.activeWorkerJobIds.add(jobId);
  const slot = { job, roomKey, started: false, external: null };
  const externalPromise = new Promise((resolve, reject) => {
    slot.external = { resolve, reject };
  });
  if (roomKey) queuedWorkerSlotsByRoom.set(roomKey, slot);
  state.workerQueueLength += 1;
  const run = async () => {
    slot.started = true;
    if (roomKey && queuedWorkerSlotsByRoom.get(roomKey) === slot) queuedWorkerSlotsByRoom.delete(roomKey);
    const queuedJob = slot.job;
    const queuedJobId = String(queuedJob?.jobId || '');
    state.workerQueueLength = Math.max(0, state.workerQueueLength - 1);
    state.activeWorkerRuns += 1;
    state.workerRunning = state.activeWorkerRuns > 0;
    state.currentJobId = queuedJob.jobId;
    state.workerStartedAt = nowIso();
    console.info('[dom-bridge] worker start', queuedJob.jobId, 'queued:', state.workerQueueLength);
    try {
      const result = CONFIG.aiDomSplitEnabled
        ? await runPhasedWorker(queuedJob)
        : await runWorker(queuedJob);
      state.lastWorkerError = null;
      return result;
    } catch (error) {
      state.lastWorkerError = { at: nowIso(), jobId: queuedJob.jobId, message: error.message.slice(0, 1000) };
      throw error;
    } finally {
      if (queuedJobId) state.activeWorkerJobIds.delete(queuedJobId);
      state.activeWorkerRuns = Math.max(0, state.activeWorkerRuns - 1);
      state.workerRunning = state.activeWorkerRuns > 0;
      if (!state.workerRunning) {
        state.currentJobId = null;
        state.workerStartedAt = null;
      }
      console.info('[dom-bridge] worker done', queuedJob.jobId, 'queued:', state.workerQueueLength);
      if (CONFIG.aiDomSplitEnabled) {
        await getKakaoPhaseScheduler().runManual({
          execute: () => cleanupIdleKakaoConversationTabs('worker_finished', { allowQueued: true })
        });
      } else {
        await cleanupIdleKakaoConversationTabs('worker_finished', { allowQueued: true });
      }
    }
  };
  const execution = CONFIG.aiDomSplitEnabled ? run() : workerChain.then(run, run);
  if (!CONFIG.aiDomSplitEnabled) workerChain = execution.catch(() => {});
  execution.then(
    (result) => slot.external?.resolve(result),
    (error) => slot.external?.reject(error)
  );
  return externalPromise;
}

function enqueueManualSend(payload) {
  if (!kakaoSendAllowedForTransport(CONFIG.hermesTransport)) {
    return Promise.resolve({ attempted: false, sent: false, reason: 'writes_disabled' });
  }
  const jobId = `manual-send-${Date.now()}`;
  const dedupeKey = manualSendDedupeKey(payload);
  const recentResult = recentManualSendResult(dedupeKey);
  if (recentResult) {
    const result = duplicateManualSendResult(recentResult, 'duplicate_manual_send_suppressed_recent_success');
    appendNdjson('manual-send-dedupe.ndjson', {
      at: nowIso(),
      jobId,
      dedupeKey,
      action: result.dedupeReason,
      payload: { ...payload, text: '[redacted]' },
      sent: result.sent
    });
    console.info('[dom-bridge] manual send duplicate suppressed recent', jobId, payload.customerName || payload.roomTitle || '');
    return Promise.resolve(result);
  }

  const inFlight = dedupeKey ? manualSendInFlight.get(dedupeKey) : null;
  if (inFlight) {
    appendNdjson('manual-send-dedupe.ndjson', {
      at: nowIso(),
      jobId,
      dedupeKey,
      action: 'duplicate_manual_send_joined_inflight',
      payload: { ...payload, text: '[redacted]' }
    });
    console.info('[dom-bridge] manual send duplicate joined in-flight', jobId, payload.customerName || payload.roomTitle || '');
    return inFlight.then((result) => duplicateManualSendResult(result, 'duplicate_manual_send_suppressed_inflight'));
  }

  const run = async () => {
    state.activeWorkerRuns += 1;
    state.workerRunning = state.activeWorkerRuns > 0;
    state.currentJobId = jobId;
    state.workerStartedAt = nowIso();
    console.info('[dom-bridge] manual send start', jobId, payload.customerName || payload.roomTitle || '');
    try {
      const result = await processManualSend(payload);
      state.lastWorkerError = null;
      rememberManualSendResult(dedupeKey, result);
      appendNdjson('manual-sends.ndjson', { at: nowIso(), jobId, dedupeKey, payload: { ...payload, text: '[redacted]' }, result });
      return result;
    } catch (error) {
      state.lastWorkerError = { at: nowIso(), jobId, message: error.message.slice(0, 1000) };
      appendNdjson('errors.ndjson', { at: nowIso(), type: 'manual_send', message: error.message, dedupeKey, payload: { ...payload, text: '[redacted]' } });
      throw error;
    } finally {
      state.activeWorkerRuns = Math.max(0, state.activeWorkerRuns - 1);
      state.workerRunning = state.activeWorkerRuns > 0;
      if (!state.workerRunning) {
        state.currentJobId = null;
        state.workerStartedAt = null;
      }
      console.info('[dom-bridge] manual send done', jobId);
    }
  };
  const queued = CONFIG.aiDomSplitEnabled
    ? getKakaoPhaseScheduler().runManual({ execute: run })
    : workerChain.then(run, run);
  if (dedupeKey) {
    manualSendInFlight.set(dedupeKey, queued);
    queued.finally(() => {
      if (manualSendInFlight.get(dedupeKey) === queued) manualSendInFlight.delete(dedupeKey);
    }).catch(() => {});
  }
  if (!CONFIG.aiDomSplitEnabled) workerChain = queued.catch(() => {});
  return queued;
}

async function fetchPendingSlackActionRows(limit = 3) {
  if (!supabaseConfigured()) return [];
  const url = new URL(supabaseFollowUpEndpoint());
  url.searchParams.set('select', 'id,customer_name,room_key,title,status,suggested_reply_draft,payload,updated_at');
  url.searchParams.set('status', 'not.in.(done,dismissed)');
  url.searchParams.set('order', 'updated_at.asc');
  url.searchParams.set('limit', '200');
  const { response, text, data } = await supabaseFetchWithTimeout(url.toString(), {
    method: 'GET',
    headers: supabaseHeaders()
  });
  if (!response.ok) throw new Error(`Supabase Slack action lookup failed: ${response.status} ${text}`);
  return (Array.isArray(data) ? data : [])
    .filter((row) => row?.payload?.slack_action?.status === 'pending')
    .slice(0, limit);
}

async function fetchFollowUpRowById(id) {
  if (!supabaseConfigured() || !id) return null;
  const url = new URL(supabaseFollowUpEndpoint());
  url.searchParams.set('select', 'id,customer_name,room_key,title,status,suggested_reply_draft,payload,updated_at');
  url.searchParams.set('id', `eq.${id}`);
  url.searchParams.set('limit', '1');
  const { response, text, data } = await supabaseFetchWithTimeout(url.toString(), {
    method: 'GET',
    headers: supabaseHeaders()
  });
  if (!response.ok) throw new Error(`Supabase follow-up lookup failed: ${response.status} ${text}`);
  return Array.isArray(data) ? data[0] || null : null;
}

async function patchFollowUpRowById(id, patch) {
  if (!supabaseConfigured() || !id) return null;
  const url = new URL(supabaseFollowUpEndpoint());
  url.searchParams.set('id', `eq.${id}`);
  const { response, text, data } = await supabaseFetchWithTimeout(url.toString(), {
    method: 'PATCH',
    headers: supabaseHeaders('return=representation'),
    body: JSON.stringify(patch)
  });
  if (!response.ok) throw new Error(`Supabase follow-up patch failed: ${response.status} ${text}`);
  return Array.isArray(data) ? data[0] : data;
}

async function mergeFollowUpPayloadById(row, payloadPatch = {}, extraPatch = {}) {
  const currentPayload = row?.payload && typeof row.payload === 'object' ? row.payload : {};
  return patchFollowUpRowById(row.id, {
    ...extraPatch,
    payload: {
      ...currentPayload,
      ...payloadPatch
    }
  });
}

async function fetchOpenP0FollowUpRows(limit = 50) {
  if (!supabaseConfigured()) return [];
  const url = new URL(supabaseFollowUpEndpoint());
  url.searchParams.set('select', 'id,customer_name,room_key,title,status,payload,created_at,updated_at');
  url.searchParams.set('status', 'not.in.(done,dismissed)');
  url.searchParams.set('payload->>alert_level', 'eq.p0');
  url.searchParams.set('order', 'updated_at.asc');
  url.searchParams.set('limit', String(Math.max(1, limit)));
  const { response, text, data } = await supabaseFetchWithTimeout(url.toString(), {
    method: 'GET',
    headers: supabaseHeaders()
  });
  if (!response.ok) throw new Error(`Supabase P0 follow-up lookup failed: ${response.status} ${text}`);
  return (Array.isArray(data) ? data : []).filter((row) => (
    String(row?.payload?.alert_level || row?.payload?.alertLevel || '').trim() === 'p0'
  ));
}

async function compareAndSwapP0Delivery(row, criticalDelivery) {
  if (!supabaseConfigured() || !row?.id || !row?.updated_at) return [];
  const currentPayload = objectPayload(row.payload);
  const url = new URL(supabaseFollowUpEndpoint());
  url.searchParams.set('id', `eq.${row.id}`);
  url.searchParams.set('updated_at', `eq.${row.updated_at}`);
  url.searchParams.set('status', 'not.in.(done,dismissed)');
  const { response, text, data } = await supabaseFetchWithTimeout(url.toString(), {
    method: 'PATCH',
    headers: supabaseHeaders('return=representation'),
    body: JSON.stringify({
      payload: {
        ...currentPayload,
        critical_delivery: criticalDelivery
      }
    })
  });
  if (!response.ok) throw new Error(`Supabase P0 delivery compare-and-swap failed: ${response.status} ${text}`);
  return Array.isArray(data) ? data : [];
}

async function deliverDueP0SlackEscalation(row, nowMs = Date.now()) {
  const options = {
    nowMs,
    repeatMs: CONFIG.p0SlackEscalationRepeatMs,
    maxIntervalMs: CONFIG.p0SlackEscalationMaxIntervalMs,
    maxAttempts: CONFIG.p0SlackEscalationMaxAttempts,
    claimTtlMs: CONFIG.p0SlackEscalationClaimTtlMs
  };
  const due = p0SlackEscalationDue(row, options);
  if (!due.due) return { ok: false, skipped: true, reason: due.reason, id: row.id };
  const claim = buildP0SlackEscalationClaim(row, options);
  const priorCritical = objectPayload(row?.payload?.critical_delivery);
  const nextRetryAtIso = (fromMs, deliveredAttempts) => new Date(
    fromMs + p0SlackEscalationBackoffMs(deliveredAttempts, CONFIG.p0SlackEscalationRepeatMs, CONFIG.p0SlackEscalationMaxIntervalMs)
  ).toISOString();
  const claimedRows = await compareAndSwapP0Delivery(row, {
    ...priorCritical,
    status: 'claimed',
    claim_attempt: claim.attempt,
    claim_id: claim.claimId,
    claimed_at: claim.claimedAt,
    claim_expires_at: claim.claimExpiresAt,
    client_message_id: claim.clientMessageId,
    error: null
  });
  if (claimedRows.length !== 1) return { ok: false, skipped: true, reason: 'claim_conflict', id: row.id };
  const latest = await fetchFollowUpRowById(row.id);
  if (!latest || ['done', 'dismissed'].includes(String(latest.status || '').trim())) {
    return { ok: false, skipped: true, reason: 'closed_after_claim', id: row.id };
  }
  const activeRow = latest;
  const message = buildP0SlackEscalationMessage(activeRow, claim, {
    mentionUserIds: followUpConfig().slackMentionUserIds,
    fallbackChannelId: followUpConfig().slackFollowUpChannel
  });
  if (!message.channel) {
    await compareAndSwapP0Delivery(activeRow, {
      ...objectPayload(activeRow?.payload?.critical_delivery),
      status: 'skipped_no_channel',
      claim_attempt: null,
      claim_expires_at: null,
      next_at: nextRetryAtIso(nowMs, Math.max(0, claim.attempt - 1)),
      error: 'no_slack_channel_for_p0_escalation'
    }).catch(() => {});
    return { ok: false, skipped: true, reason: 'no_channel', id: row.id };
  }
  try {
    const posted = await slackApi('chat.postMessage', message);
    const deliveredAt = nowIso();
    const deliveredCritical = {
      status: 'delivered',
      attempt: claim.attempt,
      claim_attempt: null,
      claim_expires_at: null,
      last_sent_at: deliveredAt,
      next_at: nextRetryAtIso(Date.parse(deliveredAt), claim.attempt),
      client_message_id: claim.clientMessageId,
      message_ts: posted.ts || null,
      error: null
    };
    // 메시지는 이미 나갔다. delivered 기록이 유실되면 다음 스윕이 같은 회차를
    // 다시 발사하므로, 최신 행을 다시 읽어서라도 기록을 남긴다.
    let recorded = false;
    let recordRow = activeRow;
    for (let recordTry = 0; recordTry < 3 && !recorded && recordRow; recordTry += 1) {
      if (['done', 'dismissed'].includes(String(recordRow.status || '').trim())) {
        recorded = true;
        break;
      }
      try {
        const updated = await compareAndSwapP0Delivery(recordRow, {
          ...objectPayload(recordRow?.payload?.critical_delivery),
          ...deliveredCritical
        });
        recorded = updated.length === 1;
      } catch { /* 아래 재조회 후 재시도 */ }
      if (!recorded) recordRow = await fetchFollowUpRowById(row.id).catch(() => null);
    }
    if (!recorded) {
      appendNdjson('errors.ndjson', {
        at: nowIso(),
        type: 'p0_slack_escalation_record_failed',
        id: row.id,
        attempt: claim.attempt
      });
    }
    return { ok: true, id: row.id, attempt: claim.attempt, messageTs: posted.ts || null, recorded };
  } catch (error) {
    const attemptedAt = nowIso();
    await compareAndSwapP0Delivery(activeRow, {
      ...priorCritical,
      status: 'retry_pending',
      claim_attempt: claim.attempt,
      last_attempt_at: attemptedAt,
      next_at: nextRetryAtIso(Date.parse(attemptedAt), Math.max(0, claim.attempt - 1)),
      client_message_id: claim.clientMessageId,
      error: String(error.message || error).slice(0, 1000)
    }).catch(() => {});
    throw error;
  }
}

async function runP0SlackEscalationSweep(reason = 'interval') {
  if (!CONFIG.p0SlackEscalationEnabled || !supabaseConfigured() || !CONFIG.slackBotToken) {
    return { skipped: true, reason: 'disabled_or_unconfigured' };
  }
  if (state.p0SlackEscalationRunning) return { skipped: true, reason: 'already_running' };
  state.p0SlackEscalationRunning = true;
  const result = { startedAt: nowIso(), reason, scanned: 0, delivered: 0, skipped: 0, errors: [] };
  try {
    const rows = await fetchOpenP0FollowUpRows(50);
    result.scanned = rows.length;
    for (const row of rows) {
      try {
        const delivery = await deliverDueP0SlackEscalation(row);
        if (delivery.ok) result.delivered += 1;
        else result.skipped += 1;
      } catch (error) {
        result.errors.push({ id: row.id, error: String(error.message || error).slice(0, 1000) });
      }
    }
  } catch (error) {
    result.errors.push({ error: String(error.message || error).slice(0, 1000) });
    appendNdjson('errors.ndjson', { at: nowIso(), type: 'p0_slack_escalation_sweep', message: error.message });
  } finally {
    result.finishedAt = nowIso();
    state.lastP0SlackEscalation = result;
    state.p0SlackEscalationRunning = false;
  }
  return result;
}

async function patchFollowUpCaseRowByStateVersion(row, expectedStateVersion, payloadPatch = {}, extraPatch = {}) {
  if (!supabaseConfigured() || !row?.id || !Number.isInteger(expectedStateVersion)) return [];
  const currentPayload = row.payload && typeof row.payload === 'object' ? row.payload : {};
  const url = new URL(supabaseFollowUpEndpoint());
  url.searchParams.set('id', `eq.${row.id}`);
  url.searchParams.set('payload->>state_version', `eq.${expectedStateVersion}`);
  const { response, text, data } = await supabaseFetchWithTimeout(url.toString(), {
    method: 'PATCH',
    headers: supabaseHeaders('return=representation'),
    body: JSON.stringify({
      ...extraPatch,
      payload: {
        ...currentPayload,
        ...payloadPatch
      }
    })
  });
  if (!response.ok) throw new Error(`Supabase follow-up compare-and-swap failed: ${response.status} ${text}`);
  return Array.isArray(data) ? data : [];
}

function slackStatusFromActionId(actionId = '') {
  const match = String(actionId || '').match(/^village_followup_status_(.+)$/);
  if (!match) return '';
  const status = match[1];
  return ['open', 'in_progress', 'waiting_customer', 'waiting_internal', 'done', 'dismissed'].includes(status)
    ? status
    : '';
}

export function decodeSlackFollowUpActionValue(value) {
  const raw = typeof value === 'string' ? value.trim() : value;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const id = String(raw.id || '').trim();
    if (!id) throw new Error('canonical Slack action value requires id');
    if (!Number.isInteger(raw.state_version)) throw new Error('canonical Slack action value requires an integer state_version');
    return { id, stateVersion: raw.state_version, canonical: true };
  }
  const stringValue = String(raw || '').trim();
  if (!stringValue) throw new Error('followUpId is required');
  if (stringValue.startsWith('{')) {
    let parsed;
    try { parsed = JSON.parse(stringValue); } catch { throw new Error('canonical Slack action value must be valid JSON'); }
    return decodeSlackFollowUpActionValue(parsed);
  }
  return { id: stringValue, stateVersion: null, canonical: false };
}

function slackEscape(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function truncateSlack(value = '', max = 240) {
  const clean = slackEscape(value).trim();
  return clean.length > max ? `${clean.slice(0, Math.max(0, max - 1))}…` : clean;
}

function slackStatusLabel(status = '') {
  const labels = {
    open: '열림',
    in_progress: '진행중',
    waiting_customer: '고객 대기',
    waiting_internal: '내부 확인 대기',
    done: '완료',
    dismissed: '무시'
  };
  return labels[status] || status || '처리됨';
}

function slackResolutionLabel(resolution = {}) {
  if (resolution.kind === 'send_pending') return { icon: '📨', label: '카카오 전송 요청 접수', detail: '로컬 브릿지가 전송을 처리하는 중입니다.' };
  if (resolution.kind === 'send_done') return { icon: '✅', label: '카카오 전송 완료', detail: '카카오 발송 확인까지 완료했습니다.' };
  if (resolution.kind === 'send_error') return { icon: '⚠️', label: '카카오 전송 실패', detail: resolution.error || '전송 처리 중 오류가 발생했습니다.' };
  if (resolution.kind === 'status') {
    if (resolution.status === 'done') return { icon: '✅', label: '완료 처리됨', detail: '이 후속처리는 완료로 표시됐습니다.' };
    if (resolution.status === 'dismissed') return { icon: '🚫', label: '무시 처리됨', detail: '이 후속처리는 무시로 표시됐습니다.' };
    if (resolution.status === 'in_progress') return { icon: '🟡', label: '진행중으로 잡힘', detail: '누군가 이 건을 처리 중입니다.' };
    return { icon: '☑️', label: `${slackStatusLabel(resolution.status)} 상태로 변경됨`, detail: '버튼 입력이 반영됐습니다.' };
  }
  return { icon: '☑️', label: '버튼 입력 반영됨', detail: '이 카드의 버튼은 비활성화됐습니다.' };
}

function slackMessageRefForAction(row = {}, resolution = {}) {
  const payload = row?.payload && typeof row.payload === 'object' ? row.payload : {};
  const delivery = payload.slack_delivery && typeof payload.slack_delivery === 'object' ? payload.slack_delivery : {};
  const action = payload.slack_action && typeof payload.slack_action === 'object' ? payload.slack_action : {};
  return {
    channel: resolution.channelId || action.channel_id || delivery.channel_id || row.slack_channel_id || '',
    ts: resolution.messageTs || action.message_ts || delivery.message_ts || row.slack_message_ts || ''
  };
}

export function canonicalSlackMessageRef(row = {}, { channelId = '', messageTs = '' } = {}) {
  const delivery = row?.payload?.slack_delivery && typeof row.payload.slack_delivery === 'object'
    ? row.payload.slack_delivery
    : {};
  const channel = String(delivery.channel_id || '').trim();
  const ts = String(delivery.message_ts || '').trim();
  if (!channel || !ts) throw new Error('canonical case is missing stored Slack delivery identity');
  const suppliedChannel = String(channelId || '').trim();
  const suppliedTs = String(messageTs || '').trim();
  if (suppliedChannel && suppliedChannel !== channel) throw new Error('Slack action channel identity mismatch');
  if (suppliedTs && suppliedTs !== ts) throw new Error('Slack action timestamp identity mismatch');
  return { channel, ts };
}

function buildResolvedSlackFollowUpMessage(row = {}, resolution = {}) {
  const { icon, label, detail } = slackResolutionLabel(resolution);
  const customer = truncateSlack(row.customer_name || '고객명 미확인', 80);
  const title = truncateSlack(row.title || row.summary || '후속처리', 260);
  const requestedBy = resolution.requestedBy ? `<@${slackEscape(resolution.requestedBy)}>` : 'Slack 버튼';
  const requestedAt = resolution.requestedAt || nowIso();
  const lines = [
    `*상태*\n${icon} ${slackEscape(label)}`,
    detail ? `*메모*\n${truncateSlack(detail, 500)}` : '',
    `*작업*\n${title}`,
    `*처리*\n${requestedBy} · ${slackEscape(requestedAt)}`
  ].filter(Boolean);
  return {
    text: `${icon} ${row.customer_name || '후속처리'} ${label}`,
    blocks: [
      {
        type: 'header',
        text: { type: 'plain_text', text: `${icon} ${customer}`.slice(0, 150), emoji: true }
      },
      {
        type: 'section',
        text: { type: 'mrkdwn', text: lines.join('\n\n') }
      }
    ]
  };
}

async function slackApi(method, payload = {}) {
  if (!CONFIG.slackBotToken) throw new Error('Missing SLACK_BOT_TOKEN');
  const response = await fetchWithDnsFallback(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${CONFIG.slackBotToken}`,
      'content-type': 'application/json; charset=utf-8'
    },
    body: JSON.stringify(payload)
  });
  const body = await response.text();
  let data = null;
  try { data = body ? JSON.parse(body) : {}; } catch { data = { raw: body }; }
  if (!response.ok || data?.ok === false) throw new Error(`Slack ${method} failed: ${data?.error || body}`);
  return data;
}

async function updateSlackFollowUpCaseCard(row = {}, { resolution = null } = {}) {
  const { channel, ts } = canonicalSlackMessageRef(row);
  const phase = String(row?.payload?.phase || '');
  const pendingSend = row?.payload?.slack_action?.type === 'send'
    && row?.payload?.slack_action?.status === 'pending';
  const effectiveResolution = resolution || (pendingSend
    ? { kind: 'send_pending' }
    : phase === 'completed'
      ? { kind: 'status', status: 'done' }
      : phase === 'dismissed' ? { kind: 'status', status: 'dismissed' } : null);
  const message = effectiveResolution
    ? buildResolvedSlackFollowUpMessage(row, effectiveResolution)
    : buildSlackFollowUpMessage(row, { config: followUpConfig() });
  const result = await slackApi('chat.update', {
    channel,
    ts,
    text: message.text,
    blocks: message.blocks
  });
  return { ok: true, channel, ts, result };
}

async function tryUpdateSlackFollowUpCaseCard(row = {}, action = {}) {
  try {
    return await updateSlackFollowUpCaseCard(row, action);
  } catch (error) {
    appendNdjson('errors.ndjson', {
      at: nowIso(),
      type: 'slack_case_card_update',
      followUpId: row?.id || null,
      message: error.message
    });
    return { ok: false, error: error.message };
  }
}

async function replaceSlackFollowUpCard(row = {}, resolution = {}) {
  const ref = slackMessageRefForAction(row, resolution);
  if (!ref.channel || !ref.ts) return { skipped: true, reason: 'missing_slack_message_ref' };
  const message = buildResolvedSlackFollowUpMessage(row, resolution);
  const result = await slackApi('chat.update', {
    channel: ref.channel,
    ts: ref.ts,
    text: message.text,
    blocks: message.blocks
  });
  return { ok: true, channel: ref.channel, ts: ref.ts, result };
}

async function tryReplaceSlackFollowUpCard(row = {}, resolution = {}) {
  try {
    return await replaceSlackFollowUpCard(row, resolution);
  } catch (error) {
    appendNdjson('errors.ndjson', {
      at: nowIso(),
      type: 'slack_card_update',
      followUpId: row?.id || null,
      message: error.message
    });
    return { ok: false, error: error.message };
  }
}

export async function applyFollowUpCaseActionWithCompareAndSwap({
  row = {},
  actionId = '',
  expectedStateVersion,
  requestedAt = nowIso(),
  persist,
  deliver,
  persistDelivery
} = {}) {
  const transition = applyFollowUpCaseAction(row.payload, actionId, { expectedStateVersion });
  const existingDelivery = row?.payload?.slack_delivery && typeof row.payload.slack_delivery === 'object'
    ? row.payload.slack_delivery
    : {};
  transition.payload.slack_delivery = {
    ...existingDelivery,
    update_pending: true,
    update_status: 'pending',
    update_state_version: transition.payload.state_version,
    update_requested_at: requestedAt,
    update_error: null
  };
  const updatedRows = await persist({ row, expectedStateVersion, transition });
  if (!Array.isArray(updatedRows) || updatedRows.length !== 1) {
    return { ok: false, reason: 'case_transition_conflict', status: transition.rowStatus, updated: null };
  }
  let updated = updatedRows[0];
  const delivery = typeof deliver === 'function' ? await deliver(updated, transition) : null;
  if (delivery?.ok === false) {
    const failedDelivery = {
      ...(updated.payload?.slack_delivery || transition.payload.slack_delivery),
      update_pending: true,
      update_status: 'error',
      update_attempted_at: nowIso(),
      update_error: String(delivery.error || delivery.reason || 'Slack case update failed').slice(0, 1000)
    };
    try {
      if (typeof persistDelivery === 'function') updated = await persistDelivery({ row: updated, delivery: failedDelivery }) || updated;
    } catch {}
    return { ok: false, reason: 'slack_case_update_failed', status: transition.rowStatus, updated, delivery };
  }
  if (delivery?.ok === true) {
    const completedDelivery = {
      ...(updated.payload?.slack_delivery || transition.payload.slack_delivery),
      update_pending: false,
      update_status: 'delivered',
      update_attempted_at: nowIso(),
      update_error: null
    };
    if (typeof persistDelivery === 'function') updated = await persistDelivery({ row: updated, delivery: completedDelivery }) || updated;
  }
  return { ok: true, status: transition.rowStatus, updated, delivery };
}

export async function retryPendingSlackFollowUpCaseUpdate({ row = {}, deliver, persistDelivery } = {}) {
  const deliveryState = row?.payload?.slack_delivery && typeof row.payload.slack_delivery === 'object'
    ? row.payload.slack_delivery
    : {};
  if (deliveryState.update_pending !== true) {
    return { ok: false, skipped: true, reason: 'no_pending_slack_case_update', updated: row };
  }
  const ref = canonicalSlackMessageRef(row);
  const delivery = await deliver(row, ref);
  const nextDelivery = {
    ...deliveryState,
    update_pending: delivery?.ok !== true,
    update_status: delivery?.ok === true ? 'delivered' : 'error',
    update_attempted_at: nowIso(),
    update_error: delivery?.ok === true ? null : String(delivery?.error || delivery?.reason || 'Slack case update failed').slice(0, 1000)
  };
  let updated = row;
  if (typeof persistDelivery === 'function') updated = await persistDelivery({ row, delivery: nextDelivery }) || row;
  return delivery?.ok === true
    ? { ok: true, updated, delivery }
    : { ok: false, reason: 'slack_case_update_failed', updated, delivery };
}

export async function retrySlackFollowUpCaseUpdateById(id = '') {
  const row = await fetchFollowUpRowById(String(id || '').trim());
  if (!row) throw new Error(`follow-up item not found: ${id}`);
  if (row.payload?.card_kind !== 'follow_up_case') throw new Error('Slack case update retry requires follow_up_case');
  return retryPendingSlackFollowUpCaseUpdate({
    row,
    deliver: (candidate) => tryUpdateSlackFollowUpCaseCard(candidate),
    persistDelivery: ({ row: candidate, delivery }) => mergeFollowUpPayloadById(candidate, { slack_delivery: delivery })
  });
}

async function applySlackFollowUpActionRequest(body = {}) {
  const actionId = String(body.action_id || body.actionId || body.action || '').trim();
  if (!actionId) throw new Error('action_id is required');
  const rawFollowUpValue = body.value ?? body.followUpId ?? body.follow_up_id ?? body.id;
  const decodedValue = decodeSlackFollowUpActionValue(rawFollowUpValue);
  const followUpId = decodedValue.id;
  const suppliedStateVersion = body.state_version ?? body.stateVersion;
  if (decodedValue.canonical && suppliedStateVersion !== undefined && Number(suppliedStateVersion) !== decodedValue.stateVersion) {
    throw new Error('canonical Slack action state version mismatch');
  }
  const expectedStateVersion = decodedValue.canonical
    ? decodedValue.stateVersion
    : (Number.isInteger(Number(suppliedStateVersion)) ? Number(suppliedStateVersion) : null);
  const row = await fetchFollowUpRowById(followUpId);
  if (!row) throw new Error(`follow-up item not found: ${followUpId}`);

  const requestedAt = nowIso();
  const requestedBy = String(body.user_id || body.userId || body.user_name || body.userName || '').trim();
  const isCanonicalCase = row.payload?.card_kind === 'follow_up_case';
  const suppliedMessageRef = {
    channelId: body.channel_id || body.channelId || '',
    messageTs: body.message_ts || body.messageTs || ''
  };
  const canonicalRef = isCanonicalCase ? canonicalSlackMessageRef(row, suppliedMessageRef) : null;
  const baseSlackAction = {
    action_id: actionId,
    requested_at: requestedAt,
    requested_by: requestedBy || null,
    channel_id: canonicalRef?.channel || suppliedMessageRef.channelId || null,
    message_ts: canonicalRef?.ts || suppliedMessageRef.messageTs || null,
    source: 'slack_socket',
    error: null
  };

  if (isCanonicalCase) {
    if (!Number.isInteger(expectedStateVersion)) throw new Error('canonical case action requires an integer state_version');
    validateFollowUpCaseAction(row.payload, actionId, { expectedStateVersion });
    if (actionId === 'village_followup_edit_send') {
      return { ok: true, kind: 'edit', followUpId, status: row.status, updated: row };
    }
    const targetStatus = slackStatusFromActionId(actionId);
    const sendAction = ['village_followup_send', 'village_followup_edit_send_submit'].includes(actionId);
    const draftOverride = String(body.draftOverride || body.draft_override || '').trim();
    if (sendAction && !String(draftOverride || row.payload?.slack_draft_override || row.suggested_reply_draft || '').trim()) {
      throw new Error('canonical customer reply send requires a non-empty draft');
    }
    const actionType = sendAction ? 'send' : targetStatus ? 'status' : 'case_transition';
    const actionStatus = sendAction ? 'pending' : 'done';
    const resolution = sendAction
      ? { kind: 'send_pending', requestedBy, requestedAt }
      : actionId === 'village_followup_status_dismissed'
        ? { kind: 'status', status: 'dismissed', requestedBy, requestedAt }
        : actionId === 'village_followup_reply_not_needed'
          ? { kind: 'status', status: 'done', requestedBy, requestedAt }
          : null;
    const transitionResult = await applyFollowUpCaseActionWithCompareAndSwap({
      row,
      actionId,
      expectedStateVersion,
      requestedAt,
      persist: ({ transition }) => patchFollowUpCaseRowByStateVersion(row, expectedStateVersion, {
        ...transition.payload,
        ...(draftOverride ? { slack_draft_override: draftOverride } : {}),
        slack_action: {
          ...baseSlackAction,
          type: actionType,
          status: actionStatus,
          ...(targetStatus ? { target_status: targetStatus } : {}),
          ...(actionStatus === 'done' ? { handled_at: requestedAt } : {})
        }
      }, { status: transition.rowStatus }),
      deliver: (updated) => tryUpdateSlackFollowUpCaseCard(updated, { resolution }),
      persistDelivery: ({ row: updated, delivery }) => mergeFollowUpPayloadById(updated, { slack_delivery: delivery })
    });
    if (!transitionResult.ok) {
      return {
        ok: false,
        kind: actionType,
        followUpId,
        status: transitionResult.status,
        updated: transitionResult.updated,
        delivery: transitionResult.delivery || { ok: false, skipped: true, reason: transitionResult.reason },
        reason: transitionResult.reason
      };
    }
    appendNdjson('slack-actions.ndjson', { at: requestedAt, action: actionId, followUpId, status: transitionResult.status, requestedBy });
    return { ok: true, kind: actionType, followUpId, status: transitionResult.status, updated: transitionResult.updated, delivery: transitionResult.delivery };
  }

  const targetStatus = slackStatusFromActionId(actionId);
  if (targetStatus) {
    const updated = await mergeFollowUpPayloadById(row, {
      slack_action: {
        ...baseSlackAction,
        type: 'status',
        status: 'done',
        target_status: targetStatus,
        handled_at: requestedAt
      }
    }, { status: targetStatus });
    const slackMessageUpdate = await tryReplaceSlackFollowUpCard(updated || row, {
      kind: 'status',
      status: targetStatus,
      requestedBy,
      requestedAt,
      channelId: baseSlackAction.channel_id,
      messageTs: baseSlackAction.message_ts
    });
    appendNdjson('slack-actions.ndjson', { at: requestedAt, action: actionId, followUpId, targetStatus, requestedBy });
    return { ok: true, kind: 'status', followUpId, status: targetStatus, updated, slackMessageUpdate };
  }

  if (['village_followup_send', 'village_followup_edit_send_submit'].includes(actionId)) {
    const draftOverride = String(body.draftOverride || body.draft_override || '').trim();
    const payloadPatch = {
      slack_action: {
        ...(row.payload?.slack_action || {}),
        ...baseSlackAction,
        type: 'send',
        status: 'pending'
      }
    };
    if (draftOverride) payloadPatch.slack_draft_override = draftOverride;
    const updated = await mergeFollowUpPayloadById(row, payloadPatch, { status: 'in_progress' });
    const slackMessageUpdate = await tryReplaceSlackFollowUpCard(updated || row, {
      kind: 'send_pending',
      requestedBy,
      requestedAt,
      channelId: baseSlackAction.channel_id,
      messageTs: baseSlackAction.message_ts
    });
    appendNdjson('slack-actions.ndjson', { at: requestedAt, action: actionId, followUpId, requestedBy, hasDraftOverride: Boolean(draftOverride) });
    return { ok: true, kind: 'send', followUpId, updated, slackMessageUpdate };
  }

  throw new Error(`unsupported Slack follow-up action: ${actionId}`);
}

async function claimSlackActionRow(row) {
  if (row?.payload?.slack_action?.status !== 'pending') return null;
  return mergeFollowUpPayloadById(row, {
    slack_action: {
      ...(row.payload.slack_action || {}),
      status: 'processing',
      error: null
    }
  });
}

async function handlePendingSlackActionRow(row) {
  const claimed = await claimSlackActionRow(row);
  if (!claimed) return { skipped: true, reason: 'already_claimed', id: row.id };
  const actionType = String(claimed.payload?.slack_action?.type || row.payload?.slack_action?.type || '');
  if (actionType !== 'send') {
    await mergeFollowUpPayloadById(claimed, {
      slack_action: {
        ...(claimed.payload?.slack_action || {}),
        status: 'error',
        error: `unsupported slack action type: ${actionType}`,
        handled_at: nowIso()
      }
    });
    return { ok: false, id: row.id, error: `unsupported slack action type: ${actionType}` };
  }
  const replyText = String(claimed.payload?.slack_draft_override || claimed.suggested_reply_draft || '').trim();
  if (!replyText) {
    await mergeFollowUpPayloadById(claimed, {
      slack_action: {
        ...(claimed.payload?.slack_action || {}),
        status: 'error',
        error: 'empty reply draft',
        handled_at: nowIso()
      }
    });
    return { ok: false, id: row.id, error: 'empty reply draft' };
  }
  try {
    const sendResult = await enqueueManualSend({
      text: replyText,
      customerName: claimed.customer_name || '',
      roomTitle: claimed.customer_name ? `${claimed.customer_name} - 빌리지 - 카카오비즈니스 파트너센터` : '',
      followUpId: row.id
    });
    const payloadPatch = {
      slack_action: {
        ...(claimed.payload?.slack_action || {}),
        status: sendResult.sent ? 'done' : 'error',
        error: sendResult.sent ? null : String(sendResult.reason || 'manual send failed').slice(0, 1000),
        handled_at: nowIso()
      }
    };
    const patch = {};
    if (sendResult.sent) patch.status = 'done';
    const updated = await mergeFollowUpPayloadById(claimed, payloadPatch, patch);
    await tryReplaceSlackFollowUpCard(updated || claimed, {
      kind: sendResult.sent ? 'send_done' : 'send_error',
      error: sendResult.sent ? null : String(sendResult.reason || 'manual send failed').slice(0, 1000)
    });
    state.slackActionsHandled += sendResult.sent ? 1 : 0;
    return { ok: Boolean(sendResult.sent), id: row.id, result: sendResult };
  } catch (error) {
    const updated = await mergeFollowUpPayloadById(claimed, {
      slack_action: {
        ...(claimed.payload?.slack_action || {}),
        status: 'error',
        error: error.message.slice(0, 1000),
        handled_at: nowIso()
      }
    });
    await tryReplaceSlackFollowUpCard(updated || claimed, {
      kind: 'send_error',
      error: error.message.slice(0, 1000)
    });
    return { ok: false, id: row.id, error: error.message };
  }
}

async function runSlackActionPoll(reason = 'interval') {
  const legacyEnabled = CONFIG.slackActionPollEnabled && supabaseConfigured();
  if (!legacyEnabled && !workOrchestratorActionPoller.enabled) return { skipped: true };
  if (state.slackActionPollRunning) return { skipped: true, reason: 'already_running' };
  state.slackActionPollRunning = true;
  const startedAt = nowIso();
  const result = { startedAt, reason, scanned: 0, handled: 0, errors: [] };
  if (legacyEnabled) {
    try {
      const rows = await fetchPendingSlackActionRows(3);
      result.scanned = rows.length;
      for (const row of rows) {
        const handled = await handlePendingSlackActionRow(row);
        if (handled.ok) result.handled += 1;
        if (handled.error) result.errors.push({ id: row.id, error: handled.error });
      }
    } catch (error) {
      result.errors.push({ error: error.message });
      appendNdjson('errors.ndjson', { at: nowIso(), type: 'slack_action_poll', message: error.message });
    }
  }
  try {
    result.workOrchestratorV2 = safeWorkActionPollResult(
      await workOrchestratorActionPoller.poll(reason),
      safeWorkActionTrigger(reason)
    );
  } catch {
    result.workOrchestratorV2 = safeWorkActionPollResult(null, safeWorkActionTrigger(reason));
  }
  result.finishedAt = nowIso();
  state.lastSlackActionPoll = result;
  state.slackActionPollRunning = false;
  return result;
}

async function runWorkerAndRecord(job, context = {}) {
  try {
    const workerResult = await enqueueWorker(job);
    if (workerResult?.skipped && workerResult?.reason === 'superseded_by_newer_room_event') {
      await updateSupabaseEventByHash(job.jobId, {
        status: 'superseded_by_newer_room_event',
        completed_at: nowIso(),
        payload: {
          ...job,
          ai_worker_result: workerResult
        }
      }).catch((error) => {
        state.failedSupabaseWrites += 1;
        appendNdjson('errors.ndjson', { at: nowIso(), type: 'superseded_job_update', message: error.message, jobId: job.jobId });
      });
      return { ok: true, skipped: true, workerResult };
    }
    if (workerResult?.skipped && workerResult?.reason === 'local_duplicate_job_active') {
      return { ok: true, skipped: true, workerResult };
    }
    try {
      await updateSupabaseEventByHash(job.jobId, buildWorkerResultPatch(job, workerResult));
    } catch (error) {
      state.failedSupabaseWrites += 1;
      appendNdjson('errors.ndjson', { at: nowIso(), type: 'supabase_job_update', message: error.message, jobId: job.jobId });
      console.warn('[dom-bridge] supabase job update failed:', error.message);
    }

    const workerPayload = parseWorkerStdoutJson(workerResult);
    if (workerPayload && shouldEscalateCompletedWorkerSkip(job, workerPayload)) {
      try {
        const decisionReason = String(workerPayload.decision?.reason || 'worker completed without sheet/follow-up').slice(0, 500);
        const completionFollowUp = await createWorkerFailureFollowUp(job, new Error(`worker completed without human-review card: ${decisionReason}`), {
          ...context,
          completed_skip: true,
          completed_at: nowIso()
        });
        appendNdjson('worker-completion-followups.ndjson', { at: nowIso(), jobId: job.jobId, result: completionFollowUp });
      } catch (followUpError) {
        state.failedSupabaseWrites += 1;
        appendNdjson('errors.ndjson', { at: nowIso(), type: 'worker_completion_followup', message: followUpError.message, jobId: job.jobId });
      }
    }
    return { ok: true, workerResult };
  } catch (error) {
    state.failedWorkerRuns += 1;
    appendNdjson('errors.ndjson', { at: nowIso(), type: 'worker', message: error.message, job });
    let failureFollowUp = null;
    try {
      failureFollowUp = await createWorkerFailureFollowUp(job, error, {
        ...context,
        timeout: /timed out/i.test(error.message),
        failed_at: nowIso()
      });
      appendNdjson('worker-failure-followups.ndjson', { at: nowIso(), jobId: job.jobId, result: failureFollowUp });
    } catch (followUpError) {
      state.failedSupabaseWrites += 1;
      appendNdjson('errors.ndjson', { at: nowIso(), type: 'worker_failure_followup', message: followUpError.message, jobId: job.jobId });
    }
    await updateSupabaseEventByHash(job.jobId, {
      status: 'ai_worker_error',
      error_message: error.message.slice(0, 1000),
      completed_at: nowIso(),
      payload: {
        ...job,
        ai_worker_result: {
          error: error.message.slice(0, 1000),
          failure_follow_up: failureFollowUp
        }
      }
    }).catch((supabaseError) => {
      state.failedSupabaseWrites += 1;
      appendNdjson('errors.ndjson', { at: nowIso(), type: 'supabase_job_error_update', message: supabaseError.message, jobId: job.jobId });
    });
    console.warn('[dom-bridge] worker failed:', error.message);
    return { ok: false, error };
  }
}

function getAiJobDispatcher() {
  if (aiJobDispatcher) return aiJobDispatcher;
  aiJobDispatcher = createAiJobDispatcher({
    transport: CONFIG.hermesTransport,
    channel: gatewayChannel,
    getConfig: () => getKakaoWorkerRuntimeConfigForTransport(),
    capture: ({ config, job }) => captureKakaoRoomSnapshot({ config, job }),
    buildTurn: ({ config, job, capture }) => buildKakaoGatewayTurn({ config, job, capture }),
    runLegacy: runWorkerAndRecord
  });
  return aiJobDispatcher;
}

export function gatewayDispatchFailurePolicy(error, { recoveryAttempts = 0 } = {}) {
  const errorType = String(error?.code || '').trim() || 'gateway_dispatch_failed';
  const transientEvidenceFailure = errorType === 'kakao_conversation_evidence_unavailable';
  if (transientEvidenceFailure && Number(recoveryAttempts || 0) < 1) {
    return {
      status: 'ai_worker_error',
      retryable: true,
      notifyHuman: false,
      errorType
    };
  }
  return {
    status: 'needs_human_review',
    retryable: false,
    notifyHuman: true,
    errorType
  };
}

export function finalizeGatewayDispatchFailurePolicy(policy = {}, persistenceResult = null) {
  if (policy.retryable !== true || persistenceResult?.ok === true) return policy;
  return {
    status: 'needs_human_review',
    retryable: false,
    notifyHuman: true,
    errorType: policy.errorType || 'gateway_dispatch_failed'
  };
}

async function recordGatewayDispatchFailure(job, error, context = {}) {
  const initialPolicy = gatewayDispatchFailurePolicy(error, {
    recoveryAttempts: Number(job?.recoveryAttempt ?? job?.bridge_recovery?.attempts ?? 0) || 0
  });
  state.failedWorkerRuns += 1;
  appendNdjson('errors.ndjson', {
    at: nowIso(), type: 'gateway_dispatch', message: String(error?.message || error), job
  });
  let failureFollowUp = null;
  const buildStatusPatch = (policy) => ({
    status: policy.status,
    error_message: String(error?.message || error).slice(0, 1000),
    completed_at: nowIso(),
    payload: {
      ...job,
      ai_worker_result: {
        error: String(error?.message || error).slice(0, 1000),
        error_type: policy.errorType,
        retryable: policy.retryable,
        failure_follow_up: failureFollowUp
      }
    }
  });
  let retryPersistence = null;
  if (initialPolicy.retryable) {
    try {
      retryPersistence = await updateSupabaseEventByHash(job.jobId, buildStatusPatch(initialPolicy));
    } catch (supabaseError) {
      state.failedSupabaseWrites += 1;
      appendNdjson('errors.ndjson', {
        at: nowIso(), type: 'gateway_dispatch_supabase_retry_update', message: supabaseError.message, jobId: job.jobId
      });
    }
  }
  const policy = finalizeGatewayDispatchFailurePolicy(initialPolicy, retryPersistence);
  if (policy.notifyHuman) {
    try {
      failureFollowUp = await createWorkerFailureFollowUp(job, error, {
        ...context,
        origin: context.origin || 'hermes_gateway_dispatch',
        failed_at: nowIso()
      });
      appendNdjson('worker-failure-followups.ndjson', {
        at: nowIso(), jobId: job.jobId, result: failureFollowUp
      });
    } catch (followUpError) {
      state.failedSupabaseWrites += 1;
      appendNdjson('errors.ndjson', {
        at: nowIso(), type: 'gateway_dispatch_failure_followup', message: followUpError.message, jobId: job.jobId
      });
    }
  }
  if (!initialPolicy.retryable || policy.notifyHuman) {
    await updateSupabaseEventByHash(job.jobId, buildStatusPatch(policy)).catch((supabaseError) => {
      state.failedSupabaseWrites += 1;
      appendNdjson('errors.ndjson', {
        at: nowIso(), type: 'gateway_dispatch_supabase_update', message: supabaseError.message, jobId: job.jobId
      });
    });
  }
  return { ok: false, error, retryable: policy.retryable, status: policy.status };
}

async function dispatchAiJob(job, context = {}) {
  try {
    const result = await getAiJobDispatcher()(job, context);
    if (gatewayTransportEnabled && await recoverFailedGatewayDispatch({
      result,
      recover: () => getGatewayFailureNotificationCoordinator().recover()
    })) {
      return result;
    }
    if (gatewayTransportEnabled && result?.queued) {
      await updateSupabaseEventByHash(job.jobId, {
        status: 'processing_by_ai_worker',
        payload: {
          ...job,
          gateway_dispatch: {
            transport: CONFIG.hermesTransport,
            state: result.state,
            queued_at: nowIso()
          }
        }
      }).catch((error) => {
        state.failedSupabaseWrites += 1;
        appendNdjson('errors.ndjson', {
          at: nowIso(), type: 'gateway_dispatch_supabase_processing', message: error.message, jobId: job.jobId
        });
      });
    }
    return result;
  } catch (error) {
    if (!gatewayTransportSelected) throw error;
    return recordGatewayDispatchFailure(job, error, context);
  }
}

async function flushRoom(roomKey) {
  const roomState = state.rooms.get(roomKey);
  if (!roomState) return;
  state.rooms.delete(roomKey);
  if (roomState.timer) clearTimeout(roomState.timer);
  if (roomState.maxTimer) clearTimeout(roomState.maxTimer);

  const job = buildAiFirstJob(roomKey, roomState);
  state.debouncedJobs += 1;
  appendNdjson('jobs.ndjson', job);
  console.info('[dom-bridge] debounced job ready', job.jobId, roomKey, `${job.eventCount} events`);

  let supabaseResult = null;
  try {
    supabaseResult = await writeSupabaseEvent(job, 'job');
  } catch (error) {
    state.failedSupabaseWrites += 1;
    appendNdjson('errors.ndjson', { at: nowIso(), type: 'supabase_job', message: error.message, job });
    console.warn('[dom-bridge] supabase job insert failed:', error.message);
  }

  if (supabaseResult?.duplicate && !shouldRunDuplicateJob(supabaseResult.existing)) {
    const reason = duplicateSkipReason(supabaseResult.existing);
    appendNdjson('worker-skipped.ndjson', { at: nowIso(), jobId: job.jobId, reason, roomKey, existing: supabaseResult.existing });
    console.info('[dom-bridge] worker skipped duplicate job', job.jobId, roomKey, supabaseResult.existing?.status || 'unknown');
    return;
  } else if (supabaseResult?.duplicate) {
    appendNdjson('worker-replayed.ndjson', { at: nowIso(), jobId: job.jobId, reason: 'duplicate_supabase_job_requeued', roomKey, existing: supabaseResult.existing });
    console.info('[dom-bridge] worker requeued duplicate job', job.jobId, roomKey, supabaseResult.existing?.status || 'unknown');
  }

  await dispatchAiJob(job, { origin: 'live_dom_event' });
}

function recoveryAttemptCount(row = {}) {
  const payload = objectPayload(row.payload);
  const recovery = objectPayload(payload.bridge_recovery);
  return Number(recovery.attempts || payload.bridge_recovery_attempts || 0) || 0;
}

function recoveryEscalated(row = {}) {
  const payload = objectPayload(row.payload);
  const recovery = objectPayload(payload.bridge_recovery);
  return Boolean(recovery.escalated_at || payload.bridge_recovery_escalated_at);
}

function rowAgeMs(row = {}, fieldOrder = ['updated_at', 'completed_at', 'created_at']) {
  for (const field of fieldOrder) {
    const value = Date.parse(row[field] || '');
    if (Number.isFinite(value)) return Date.now() - value;
  }
  return Number.POSITIVE_INFINITY;
}

function shouldRecoverSupabaseRow(row = {}) {
  const status = String(row.status || '');
  // The attempt cap must hold for EVERY recoverable status: a failed replay can
  // leave the row in ready/processing states too, and an uncapped status turns
  // one failing job into a worker-monopolizing retry loop.
  if (recoveryAttemptCount(row) >= CONFIG.supabaseRecoveryMaxAttempts) return false;
  if (status === 'processing_by_ai_worker') return isDuplicateProcessingStale(row);
  if (status === 'ai_worker_error') {
    return rowAgeMs(row) >= CONFIG.supabaseRecoveryErrorRetryMs;
  }
  return ['ready_for_ai_worker', 'ai_decision_ready_no_sheet_write'].includes(status);
}

export function shouldSkipSupabaseRowAsLowValue(row = {}) {
  const payload = objectPayload(row.payload);
  const raw = objectPayload(payload.raw);
  const event = {
    reason: row.reason || payload.reason || raw.reason || '',
    previewText: row.preview_text || payload.previewText || raw.previewText || '',
    unreadCount: row.unread_count ?? payload.unreadCount ?? raw.unreadCount ?? null,
    unreadSignal: payload.unreadSignal ?? raw.unreadSignal,
    raw
  };
  // Historical backstop rows may have been stored before the Badge/unread fix.
  // Do not replay a row that would now be rejected at ingress.
  if (event.reason === 'top_rows_backstop' && !hasUnreadCount(event)) return 'untrusted_backstop_row';
  return '';
}

async function markSupabaseRowSkippedLowValue(row, reason) {
  const payload = objectPayload(row.payload);
  return updateSupabaseEventByHash(row.event_hash, {
    status: 'ai_skipped_needs_review',
    error_message: `Skipped before worker: ${reason}`,
    completed_at: nowIso(),
    payload: {
      ...payload,
      bridge_recovery: {
        ...objectPayload(payload.bridge_recovery),
        skipped_at: nowIso(),
        skipped_reason: reason
      }
    }
  });
}

function shouldEscalateExhaustedSupabaseRow(row = {}) {
  const status = String(row.status || '');
  return ['ai_worker_error', 'ready_for_ai_worker', 'ai_decision_ready_no_sheet_write', 'processing_by_ai_worker'].includes(status)
    && recoveryAttemptCount(row) >= CONFIG.supabaseRecoveryMaxAttempts
    && !recoveryEscalated(row);
}

function jobPriorityScore(row = {}) {
  const text = `${row.preview_text || ''} ${JSON.stringify(objectPayload(row.payload)).slice(0, 2000)}`;
  if (/(예약|대여|렌탈|반출|반납|가능|빌릴|빌리|장비|촬영|신청|확인요청)/.test(text)) return 0;
  if (/(가격|얼마|비용|견적|단가|요금|주소|위치|어디|영업|운영|절차|방법)/.test(text)) return 1;
  if (/(감사|고맙|넵|네|확인했습니다|알겠습니다)/.test(text)) return 8;
  return 4;
}

function buildJobFromSupabaseRow(row = {}, attempt = 0) {
  const payload = objectPayload(row.payload);
  const jobId = String(payload.jobId || payload.eventHash || row.event_hash || row.id || `supabase-${Date.now()}`);
  return {
    ...payload,
    id: row.id || payload.id,
    jobId,
    eventHash: row.event_hash || payload.eventHash || jobId,
    source: payload.source || 'kakao_channel_manager_dom',
    status: 'ready_for_ai_worker',
    roomKey: payload.roomKey || row.room_key || '',
    detectedAt: payload.detectedAt || row.detected_at || row.created_at || nowIso(),
    previewText: payload.previewText || row.preview_text || '',
    unreadCount: payload.unreadCount ?? row.unread_count ?? null,
    events: Array.isArray(payload.events) ? payload.events : [],
    replayedFromSupabase: true,
    recoveryAttempt: attempt,
    recoverySource: 'supabase_recovery_sweeper',
    // Carry the incremented counter on the job itself: failure paths rewrite the
    // Supabase payload from this object, and a stale/absent bridge_recovery here
    // resets the attempt count and turns one poison job into an endless retry
    // loop (2026-08-07 새벽 김동효 건 9회 재시도).
    bridge_recovery: {
      ...objectPayload(payload.bridge_recovery),
      attempts: attempt,
      last_replayed_at: nowIso(),
      last_replay_reason: 'supabase_recovery_sweeper'
    }
  };
}

async function fetchRecoverableSupabaseRows() {
  const scanLimit = Math.max(CONFIG.supabaseRecoveryBatchSize * 12, 24);
  const groups = await Promise.all([
    fetchSupabaseRowsByStatuses(['ready_for_ai_worker', 'ai_decision_ready_no_sheet_write'], scanLimit),
    fetchSupabaseRowsByStatuses(['processing_by_ai_worker'], scanLimit),
    fetchSupabaseRowsByStatuses(['ai_worker_error'], scanLimit)
  ]);
  const seen = new Set();
  return groups.flat()
    .filter((row) => {
      const key = row.id || row.event_hash;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => {
      const priority = jobPriorityScore(a) - jobPriorityScore(b);
      if (priority) return priority;
      return Date.parse(b.updated_at || b.created_at || 0) - Date.parse(a.updated_at || a.created_at || 0);
    });
}

async function markSupabaseRowClaimedForRecovery(row, attempt) {
  const payload = objectPayload(row.payload);
  const recovery = {
    ...objectPayload(payload.bridge_recovery),
    attempts: attempt,
    last_replayed_at: nowIso(),
    last_replay_reason: 'supabase_recovery_sweeper',
    row_id: row.id || null,
    previous_status: row.status || null
  };
  return updateSupabaseEventByHash(row.event_hash, {
    status: 'processing_by_ai_worker',
    claimed_at: nowIso(),
    error_message: null,
    payload: {
      ...payload,
      bridge_recovery: recovery
    }
  });
}

async function markSupabaseRowEscalated(row, followUpResult) {
  const payload = objectPayload(row.payload);
  const recovery = {
    ...objectPayload(payload.bridge_recovery),
    attempts: recoveryAttemptCount(row),
    escalated_at: nowIso(),
    escalated_reason: 'max_worker_recovery_attempts',
    follow_up_result: followUpResult || null
  };
  return updateSupabaseEventByHash(row.event_hash, {
    status: 'needs_human_review',
    error_message: 'AI worker failed repeatedly; escalated to follow-up dashboard',
    completed_at: nowIso(),
    payload: {
      ...payload,
      bridge_recovery: recovery
    }
  });
}

async function runSupabaseRecoverySweep(reason = 'interval') {
  if (!CONFIG.supabaseRecoveryEnabled || !supabaseConfigured() || (!CONFIG.workerCommand && !gatewayTransportEnabled)) return { skipped: true };
  if (state.recoverySweepRunning) return { skipped: true, reason: 'already_running' };
  state.recoverySweepRunning = true;
  const startedAt = nowIso();
  const result = { startedAt, reason, scanned: 0, replayed: 0, escalated: 0, skipped: 0, errors: [] };
  try {
    const rows = await fetchRecoverableSupabaseRows();
    result.scanned = rows.length;
    for (const row of rows) {
      if (result.replayed >= CONFIG.supabaseRecoveryBatchSize) break;
      const lowValueReason = shouldSkipSupabaseRowAsLowValue(row);
      if (lowValueReason) {
        try {
          await markSupabaseRowSkippedLowValue(row, lowValueReason);
          result.skipped += 1;
        } catch (error) {
          result.errors.push({ row: row.id || row.event_hash, message: error.message });
        }
        continue;
      }
      if (shouldEscalateExhaustedSupabaseRow(row)) {
        try {
          const job = buildJobFromSupabaseRow(row, recoveryAttemptCount(row));
          const followUpResult = await createWorkerFailureFollowUp(job, new Error(row.error_message || 'worker recovery attempts exhausted'), {
            origin: 'supabase_recovery_sweeper',
            exhausted: true
          });
          await markSupabaseRowEscalated(row, followUpResult);
          result.escalated += 1;
        } catch (error) {
          result.errors.push({ row: row.id || row.event_hash, message: error.message });
        }
        continue;
      }
      if (!shouldRecoverSupabaseRow(row)) {
        result.skipped += 1;
        continue;
      }
      const attempt = recoveryAttemptCount(row) + 1;
      const job = buildJobFromSupabaseRow(row, attempt);
      try {
        await markSupabaseRowClaimedForRecovery(row, attempt);
        appendNdjson('worker-replayed.ndjson', { at: nowIso(), jobId: job.jobId, reason: 'supabase_recovery_sweeper', attempt, rowId: row.id, previousStatus: row.status });
        const outcome = await dispatchAiJob(job, {
          origin: 'supabase_recovery_sweeper',
          attempt,
          previous_status: row.status
        });
        result.replayed += 1;
        if (outcome.ok) state.recoveredJobs += 1;
      } catch (error) {
        result.errors.push({ row: row.id || row.event_hash, message: error.message });
      }
    }
    return result;
  } catch (error) {
    result.errors.push({ message: error.message });
    appendNdjson('errors.ndjson', { at: nowIso(), type: 'supabase_recovery_sweep', message: error.message });
    return result;
  } finally {
    result.finishedAt = nowIso();
    state.lastRecoverySweep = result;
    state.recoverySweepRunning = false;
    appendNdjson('recovery-sweeps.ndjson', result);
  }
}

function scheduleDebouncedJob(event) {
  const groupingText = normalizePreviewForGrouping(event.previewText);
  const roomKey = roomKeyForDebounce(event);
  const groupedEvent = {
    ...event,
    originalRoomKey: event.roomKey,
    roomKey,
    groupingText
  };
  let roomState = state.rooms.get(roomKey);
  if (!roomState) {
    roomState = {
      firstAt: nowIso(),
      lastAt: nowIso(),
      events: [],
      timer: null,
      maxTimer: null,
      hashes: new Set()
    };
    state.rooms.set(roomKey, roomState);
    roomState.maxTimer = setTimeout(() => flushRoom(roomKey), CONFIG.maxWaitMs);
  }

  roomState.lastAt = nowIso();
  const eventIdentity = groupedEvent.eventHash || sha256(JSON.stringify(groupedEvent));

  const isNewEvent = !roomState.hashes.has(eventIdentity);
  if (isNewEvent) {
    roomState.events.push(groupedEvent);
    roomState.hashes.add(eventIdentity);
  }

  // Repeated backstop scans can post the same unread row every few seconds.
  // If every duplicate resets debounce, the room never flushes and the AI worker
  // never runs even though detection is alive. Only a genuinely new event should
  // extend the debounce window; duplicates keep the original timer.
  if (isNewEvent || !roomState.timer) {
    if (roomState.timer) clearTimeout(roomState.timer);
    roomState.timer = setTimeout(() => flushRoom(roomKey), CONFIG.debounceMs);
  }
}

function kakaoDevtoolsBaseUrl() {
  return CONFIG.kakaoDevtoolsUrl || `http://127.0.0.1:${CONFIG.kakaoRemoteDebuggingPort}`;
}

function isMainKakaoChatListUrl(url = '') {
  return /^https:\/\/(business|center-pf)\.kakao\.com\/_[^/]+\/chats(?:[?#]|$)/.test(String(url || ''));
}

function isKakaoConversationUrl(url = '') {
  const value = String(url || '');
  return /^https:\/\/(business|center-pf)\.kakao\.com\//.test(value) && !isMainKakaoChatListUrl(value);
}

async function fetchDevtools(pathname, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2000);
  try {
    return await fetch(`${kakaoDevtoolsBaseUrl()}${pathname}`, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function closeDevtoolsTab(tabId) {
  try {
    const response = await fetchDevtools(`/json/close/${encodeURIComponent(tabId)}`, { method: 'PUT' });
    if (response.ok) return true;
  } catch {}
  try {
    const response = await fetchDevtools(`/json/close/${encodeURIComponent(tabId)}`);
    return response.ok;
  } catch {
    return false;
  }
}

async function cleanupIdleKakaoConversationTabs(reason = 'interval', { allowQueued = false } = {}) {
  if (!CONFIG.kakaoTabCleanupEnabled) return { skipped: true };
  if (state.workerRunning || (!allowQueued && (state.workerQueueLength > 0 || state.rooms.size > 0))) {
    return { skipped: true, reason: 'worker_or_debounce_active' };
  }
  if (state.tabCleanupRunning) return { skipped: true, reason: 'already_running' };
  state.tabCleanupRunning = true;
  const result = { at: nowIso(), reason, closed: 0, targets: [], errors: [] };
  try {
    const response = await fetchDevtools('/json/list');
    if (!response.ok) throw new Error(`DevTools tab list failed: ${response.status}`);
    const tabs = await response.json();
    const targets = (Array.isArray(tabs) ? tabs : [])
      .filter((tab) => tab?.type === 'page' && tab.id && isKakaoConversationUrl(tab.url));
    result.targets = targets.map((tab) => ({ id: tab.id, title: tab.title || '', url: tab.url || '' }));
    for (const tab of targets) {
      if (await closeDevtoolsTab(tab.id)) result.closed += 1;
    }
    state.closedKakaoTabs += result.closed;
    return result;
  } catch (error) {
    result.errors.push(error.message);
    appendNdjson('errors.ndjson', { at: nowIso(), type: 'kakao_tab_cleanup', message: error.message });
    return result;
  } finally {
    result.finishedAt = nowIso();
    state.lastTabCleanup = result;
    state.tabCleanupRunning = false;
    if (result.closed || result.errors.length) appendNdjson('tab-cleanups.ndjson', result);
  }
}

export async function handleEvent(req, res, dependencies = {}) {
  const appendEvent = dependencies.appendNdjson || appendNdjson;
  const writeEvent = dependencies.writeSupabaseEvent || writeSupabaseEvent;
  const scheduleEvent = dependencies.scheduleDebouncedJob || scheduleDebouncedJob;
  const shadowRuntime = dependencies.shadowRuntime || workOrchestratorShadowRuntime;
  const immediateRuntime = dependencies.immediateRuntime || workOrchestratorImmediateRuntime;
  const body = await readRequestBody(req);
  const raw = JSON.parse(body || '{}');
  let event = normalizeEvent(raw);

  state.received += 1;
  appendEvent('events.ndjson', event);

  if (event.status === 'watcher_heartbeat' || event.reason === 'heartbeat' || event.reason === 'content_script_started') {
    if (event.reason === 'content_script_started') {
      state.lastContentScriptStartedAtMs = Date.now();
    }
    appendEvent('heartbeats.ndjson', event);
    return json(res, 202, { ok: true, heartbeat: true });
  }

  if (event.status === 'popup_bridge_test' || event.reason === 'popup_bridge_test') {
    appendEvent('diagnostics.ndjson', event);
    return json(res, 202, { ok: true, diagnostic: true });
  }

  if (event.status === 'dom_diagnostic' || event.reason === 'top_rows_snapshot') {
    appendEvent('diagnostics.ndjson', event);
    return json(res, 202, { ok: true, diagnostic: true, queuedForAi: false });
  }

  if ((event.reason === 'top_rows_backstop' || event.reason === 'top_row_changed') && !shouldQueueTopRowEvent(event)) {
    appendEvent('backstop-events.ndjson', {
      ...event,
      backstopReason: event.reason === 'top_rows_backstop' ? 'read_backstop_row' : 'non_live_top_row_change'
    });
    return json(res, 202, {
      ok: true,
      backstop: true,
      ignored: event.reason === 'top_rows_backstop' ? 'read_backstop_row' : 'non_live_top_row_change',
      queuedForAi: false
    });
  }

  if (isStaleDatedMutation(event)) {
    appendEvent('ignored-stale-dated-mutation-events.ndjson', event);
    return json(res, 202, { ok: true, ignored: 'stale_dated_mutation', queuedForAi: false });
  }

  if (
    event.reason === 'mutation'
    && state.lastContentScriptStartedAtMs
    && Date.now() - state.lastContentScriptStartedAtMs < CONFIG.startupMutationIgnoreMs
  ) {
    appendEvent('ignored-startup-mutation-events.ndjson', event);
    return json(res, 202, { ok: true, ignored: 'startup_mutation', queuedForAi: false });
  }

  const initialScanIngress = classifyInitialScanIngress(event, CONFIG);
  if (initialScanIngress.action === 'ignore') {
    appendEvent('initial-scans.ndjson', { ...event, ignored: initialScanIngress.reason });
    return json(res, 202, {
      ok: true,
      initialScan: true,
      ignored: initialScanIngress.reason,
      queuedForAi: false
    });
  }
  if (initialScanIngress.action === 'queue') {
    appendEvent('initial-scans.ndjson', initialScanIngress.event);
    event = initialScanIngress.event;
  }

  if (isPageContainerPreview(event.previewText, event.roomKey)) {
    appendEvent('ignored-container-events.ndjson', event);
    return json(res, 202, { ok: true, ignored: 'page_container', queuedForAi: false });
  }

  if (isActionChromePreview(event.previewText)) {
    appendEvent('ignored-chrome-events.ndjson', event);
    return json(res, 202, { ok: true, ignored: 'action_chrome', queuedForAi: false });
  }

  const skipWorkerReason = shouldSkipWorkerForPreview(event);
  if (skipWorkerReason) {
    appendEvent('ignored-low-value-events.ndjson', { ...event, ignored: skipWorkerReason });
    return json(res, 202, { ok: true, ignored: skipWorkerReason, queuedForAi: false });
  }

  if (isLikelyShiftedExistingRow(event)) {
    appendEvent('ignored-shifted-row-events.ndjson', event);
    return json(res, 202, { ok: true, ignored: 'shifted_existing_row', queuedForAi: false });
  }

  console.info('[dom-bridge] event received', event.roomKey, event.reason, event.previewText.slice(0, 80));

  const acceptedRoomKey = roomKeyForDebounce(event);
  const acceptedIdentity = semanticRoomEventIdentity(event) || String(event.eventHash || '').trim();
  const durableRoomRevision = gatewayChannel && typeof gatewayChannel.latestRoomRevision === 'function'
    ? await gatewayChannel.latestRoomRevision(acceptedRoomKey)
    : 0;
  const roomVersion = registerAcceptedRoomEvent(
    state.roomVersions,
    acceptedRoomKey,
    acceptedIdentity,
    durableRoomRevision
  );
  event.roomRevision = roomVersion.revision;
  dependencies.onRoomRevisionAccepted?.(event, roomVersion);

  if (roomVersion.changed) {
    try {
      const shadowObservation = shadowRuntime?.recordAccepted?.(event, roomVersion);
      if (shadowObservation && typeof shadowObservation.catch === 'function') {
        shadowObservation.catch(() => {});
      }
    } catch {
      // Shadow observation is never allowed to suppress the legacy event path.
    }
  }

  let immediateNotification = null;
  if (immediateRuntime?.enabled === true) {
    try {
      immediateNotification = await immediateRuntime.deliverAccepted(event, roomVersion);
      if (immediateNotification?.status !== 'delivered') {
        const unconfirmedResult = new Error('Immediate notification result is unconfirmed');
        unconfirmedResult.code = 'delivery_persistence_failed';
        throw unconfirmedResult;
      }
    } catch (error) {
      appendEvent('errors.ndjson', {
        at: nowIso(),
        type: 'immediate_notification',
        code: genericImmediateFailureCode(error?.code),
        eventCorrelationSha256: sha256(String(event.eventHash || '').slice(0, 500))
      });
      return json(res, 503, {
        ok: false,
        error: 'immediate_notification_unconfirmed',
        eventHash: event.eventHash
      });
    }
  }

  try {
    await writeEvent(event, 'event');
  } catch (error) {
    state.failedSupabaseWrites += 1;
    appendEvent('errors.ndjson', { at: nowIso(), type: 'supabase_event', message: error.message, event });
    console.warn('[dom-bridge] supabase event insert failed:', error.message);
  }

  scheduleEvent(event);
  return json(res, 202, {
    ok: true,
    roomKey: event.roomKey,
    eventHash: event.eventHash,
    ...(immediateNotification?.status === 'delivered'
      ? { immediateNotification }
      : {})
  });
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') {
      return json(res, 204, {});
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || '127.0.0.1'}`);

    if (await gatewayHttpHandler(req, res, url)) return;

    if (req.method === 'GET' && url.pathname === '/health') {
      await workOrchestratorImmediateRuntime.refreshBacklogHealth();
      const gatewayStatus = gatewayChannel ? await gatewayChannel.status() : {};
      const documentExecutionConfig = gatewayTransportEnabled
        ? resolveGatewayDocumentConfig(CONFIG, getKakaoWorkerRuntimeConfigForTransport())
        : {};
      const gatewayReadback = buildGatewayHealthReadback({
        transport: CONFIG.hermesTransport,
        gatewayConfigured: gatewayTransportEnabled,
        status: gatewayStatus,
        nowMs: Date.now(),
        consumerFreshnessMs: Math.max(60_000, CONFIG.hermesLeaseMs * 2)
      });
      return json(res, 200, {
        ok: true,
        gateway: gatewayReadback,
        config: {
          port: CONFIG.port,
          debounceMs: CONFIG.debounceMs,
          maxWaitMs: CONFIG.maxWaitMs,
          queueDir: CONFIG.queueDir,
          supabaseEnabled: Boolean(CONFIG.supabaseUrl && CONFIG.supabaseServiceRoleKey && CONFIG.supabaseTable),
          workerEnabled: Boolean(CONFIG.workerCommand),
          hermesTransport: CONFIG.hermesTransport,
          gatewayConfigured: gatewayTransportEnabled,
          documentExecutionConfigured: Boolean(
            documentExecutionConfig.documentApiBaseUrl && documentExecutionConfig.documentApiKey
          ),
          ...buildHealthConfig(configForHermesTransport(CONFIG, CONFIG.hermesTransport)),
          workerTimeoutMs: CONFIG.workerTimeoutMs,
          aiDomSplitEnabled: CONFIG.aiDomSplitEnabled,
          aiDecisionConcurrency: CONFIG.aiDecisionConcurrency,
          supabaseTimeoutMs: CONFIG.supabaseTimeoutMs,
          supabaseRecoveryEnabled: CONFIG.supabaseRecoveryEnabled,
          supabaseRecoveryIntervalMs: CONFIG.supabaseRecoveryIntervalMs,
          supabaseRecoveryBatchSize: CONFIG.supabaseRecoveryBatchSize,
          supabaseRecoveryLookbackHours: CONFIG.supabaseRecoveryLookbackHours,
          supabaseRecoveryErrorRetryMs: CONFIG.supabaseRecoveryErrorRetryMs,
          supabaseRecoveryMaxAttempts: CONFIG.supabaseRecoveryMaxAttempts,
          slackActionPollEnabled: CONFIG.slackActionPollEnabled,
          slackActionPollIntervalMs: CONFIG.slackActionPollIntervalMs,
          followUpRowsEnabled: CONFIG.followUpRowsEnabled,
          slackCardDeliveryEnabled: CONFIG.slackCardDeliveryEnabled,
          slackBotTokenPresent: Boolean(CONFIG.slackBotToken),
          p0SlackEscalationEnabled: CONFIG.p0SlackEscalationEnabled,
          p0SlackEscalationIntervalMs: CONFIG.p0SlackEscalationIntervalMs,
          p0SlackEscalationRepeatMs: CONFIG.p0SlackEscalationRepeatMs,
          p0SlackEscalationMaxIntervalMs: CONFIG.p0SlackEscalationMaxIntervalMs,
          p0SlackEscalationMaxAttempts: CONFIG.p0SlackEscalationMaxAttempts,
          slackChannels: CONFIG.slackChannels,
          kakaoTabCleanupEnabled: CONFIG.kakaoTabCleanupEnabled,
          kakaoTabCleanupIntervalMs: CONFIG.kakaoTabCleanupIntervalMs,
          processInitialScan: CONFIG.processInitialScan,
          ignoreShiftedRows: CONFIG.ignoreShiftedRows,
          topRowLiveWindowMinutes: CONFIG.topRowLiveWindowMinutes,
          readBackstopLookbackHours: CONFIG.readBackstopLookbackHours,
          readBackstopLookbackDays: CONFIG.readBackstopLookbackDays
        },
        state: {
          startedAt: state.startedAt,
          received: state.received,
          debouncedJobs: state.debouncedJobs,
          failedSupabaseWrites: state.failedSupabaseWrites,
          failedWorkerRuns: state.failedWorkerRuns,
          workerRunning: state.workerRunning,
          activeWorkerRuns: state.activeWorkerRuns,
          workerQueueLength: state.workerQueueLength,
          currentJobId: state.currentJobId,
          workerStartedAt: state.workerStartedAt,
          workerRunMs: state.workerStartedAt ? Date.now() - Date.parse(state.workerStartedAt) : 0,
          lastWorkerError: state.lastWorkerError,
          recoveredJobs: state.recoveredJobs,
          slackActionsHandled: state.slackActionsHandled,
          slackActionPollRunning: state.slackActionPollRunning,
          lastSlackActionPoll: state.lastSlackActionPoll,
          p0SlackEscalationRunning: state.p0SlackEscalationRunning,
          lastP0SlackEscalation: state.lastP0SlackEscalation,
          recoverySweepRunning: state.recoverySweepRunning,
          lastRecoverySweep: state.lastRecoverySweep,
          closedKakaoTabs: state.closedKakaoTabs,
          tabCleanupRunning: state.tabCleanupRunning,
          lastTabCleanup: state.lastTabCleanup,
          openRooms: state.rooms.size,
          phaseScheduler: kakaoPhaseScheduler?.status?.() || null,
          workOrchestrator: buildWorkOrchestratorHealthState(state.workOrchestrator)
        }
      });
    }

    if (req.method === 'GET' && url.pathname === '/worker/freshness') {
      const roomKey = String(url.searchParams.get('roomKey') || '').trim();
      const requestedRevision = Number(url.searchParams.get('revision') || 0);
      if (!roomKey || !Number.isFinite(requestedRevision) || requestedRevision <= 0) {
        return json(res, 400, { ok: false, error: 'roomKey and positive revision are required' });
      }
      const latestRevision = Number(state.roomVersions.get(roomKey)?.revision || 0);
      return json(res, 200, {
        ok: true,
        roomKey,
        requestedRevision,
        latestRevision,
        superseded: latestRevision > requestedRevision
      });
    }

    if (req.method === 'POST' && url.pathname === '/events') {
      return await handleEvent(req, res);
    }

    if (req.method === 'POST' && url.pathname === '/manual-send') {
      const body = await readJsonBody(req);
      const text = String(body.text || '').trim();
      const customerName = String(body.customerName || body.customer_name || '').trim();
      const roomTitle = String(body.roomTitle || body.room_title || '').trim();
      if (!text || text.length < 2) return json(res, 400, { ok: false, error: 'text is required' });
      if (!customerName && !roomTitle) return json(res, 400, { ok: false, error: 'customerName or roomTitle is required' });
      const result = await enqueueManualSend({
        text,
        customerName,
        roomTitle,
        followUpId: body.followUpId || body.follow_up_id || ''
      });
      return json(res, result.sent ? 200 : 502, { ok: Boolean(result.sent), result });
    }

    if (req.method === 'GET' && url.pathname === '/slack/follow-up') {
      const id = String(url.searchParams.get('id') || '').trim();
      if (!id) return json(res, 400, { ok: false, error: 'id is required' });
      const row = await fetchFollowUpRowById(id);
      return json(res, row ? 200 : 404, { ok: Boolean(row), row });
    }

    if (req.method === 'POST' && url.pathname === '/slack/actions') {
      const body = await readJsonBody(req);
      const result = await applySlackFollowUpActionRequest(body);
      return json(res, 200, result);
    }

    if (req.method === 'POST' && url.pathname === '/maintenance/recover') {
      const result = await runSupabaseRecoverySweep('manual');
      return json(res, 200, { ok: !result.errors?.length, result });
    }

    if (req.method === 'POST' && url.pathname === '/maintenance/slack-actions') {
      const result = await runSlackActionPoll('manual');
      return json(res, 200, { ok: slackActionMaintenanceSucceeded(result), result });
    }

    if (req.method === 'POST' && url.pathname === '/maintenance/p0-slack-escalation') {
      const result = await runP0SlackEscalationSweep('manual');
      return json(res, 200, { ok: !result.errors?.length, result });
    }

    if (req.method === 'POST' && url.pathname === '/maintenance/work-orchestrator-digest') {
      const result = await handleWorkOrchestratorDigestMaintenance(workOrchestratorDigestRuntime);
      return json(res, result.statusCode, result.body);
    }

    if (req.method === 'POST' && url.pathname === '/maintenance/slack-case-update') {
      const body = await readJsonBody(req);
      const id = String(body.id || body.followUpId || body.follow_up_id || '').trim();
      if (!id) return json(res, 400, { ok: false, error: 'id is required' });
      const result = await retrySlackFollowUpCaseUpdateById(id);
      return json(res, result.ok ? 200 : 502, result);
    }

    if (req.method === 'POST' && url.pathname === '/maintenance/cleanup-tabs') {
      const result = await cleanupIdleKakaoConversationTabs('manual');
      return json(res, 200, { ok: !result.errors?.length, result });
    }

    return json(res, 404, { ok: false, error: 'not found' });
  } catch (error) {
    appendNdjson('errors.ndjson', { at: nowIso(), type: 'request', message: error.message });
    return json(res, 500, { ok: false, error: error.message });
  }
});

if (process.env.KAKAO_DOM_BRIDGE_NO_LISTEN !== '1') {
  ensureQueueDir();
  server.listen(CONFIG.port, '127.0.0.1', () => {
    console.info(`[dom-bridge] listening on http://127.0.0.1:${CONFIG.port}`);
    console.info(`[dom-bridge] queue dir: ${CONFIG.queueDir}`);
    console.info(`[dom-bridge] supabase: ${CONFIG.supabaseUrl && CONFIG.supabaseTable ? 'enabled' : 'disabled'}`);
    console.info(`[dom-bridge] worker: ${CONFIG.workerCommand ? CONFIG.workerCommand : 'disabled'}`);
    if (gatewayTransportEnabled) {
      const coordinator = getGatewayResultApplicationCoordinator();
      (async () => {
        await coordinator.recoverPendingApplications();
        const notifications = await coordinator.recoverApplicationFailureNotifications();
        const terminalNotifications = await getGatewayFailureNotificationCoordinator().recover();
        const failed = [
          ...notifications.filter((entry) => entry.notified === false),
          ...terminalNotifications.filter((entry) => entry.notified === false)
        ];
        if (failed.length) throw new Error(`${failed.length} Gateway failure notification(s) remain pending`);
      })().catch((error) => {
        appendNdjson('errors.ndjson', { at: nowIso(), type: 'gateway_application_recovery', message: error.message });
      });
    }
    if (CONFIG.supabaseRecoveryEnabled) {
      setTimeout(() => runSupabaseRecoverySweep('startup'), 5000).unref?.();
      setInterval(() => runSupabaseRecoverySweep('interval'), CONFIG.supabaseRecoveryIntervalMs).unref?.();
    }
    if (CONFIG.slackActionPollEnabled || workOrchestratorActionPoller.enabled) {
      setTimeout(() => runSlackActionPoll('startup'), 7000).unref?.();
      setInterval(() => runSlackActionPoll('interval'), CONFIG.slackActionPollIntervalMs).unref?.();
    }
    if (CONFIG.p0SlackEscalationEnabled) {
      setTimeout(() => runP0SlackEscalationSweep('startup'), 9000).unref?.();
      setInterval(() => runP0SlackEscalationSweep('interval'), CONFIG.p0SlackEscalationIntervalMs).unref?.();
    }
    if (CONFIG.kakaoTabCleanupEnabled) {
      setTimeout(() => cleanupIdleKakaoConversationTabs('startup'), 10_000).unref?.();
      setInterval(() => cleanupIdleKakaoConversationTabs('interval'), CONFIG.kakaoTabCleanupIntervalMs).unref?.();
    }
    if (CONFIG.workOrchestrator.digestEnabled) {
      workOrchestratorDigestRuntime.start().catch(() => {});
    }
  });
}
