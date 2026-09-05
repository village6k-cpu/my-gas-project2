import { createHash } from 'node:crypto';

import {
  buildDigestSlackMessage,
  buildReportDigestSnapshot
} from './digests.mjs';

const CHANNEL_ID = /^[A-Z0-9][A-Z0-9_-]{0,79}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLACK_TS = /^[0-9]{1,20}\.[0-9]{1,20}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PART_KINDS = new Set(['ordinary', 'daily_reminder']);
const DELIVERY_STATES = new Set(['planned', 'delivering', 'delivered', 'failed']);
const DELETE_FAILURE_CODES = new Set(['cant_delete_message', 'rate_limited', 'cleanup_unconfirmed', 'slack_api_error']);
const MAX_INTERVAL_MINUTES = 7 * 24 * 60;
const MAX_RECONCILE_WINDOW_SECONDS = 3_600;

function invalidInput() {
  return new Error('invalid digest runner input');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalIso(value) {
  if (typeof value !== 'string' || !value || value.length > 40) throw invalidInput();
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) throw invalidInput();
  return value;
}

function requiredText(value, maxLength) {
  if (typeof value !== 'string' || !value || value !== value.trim() || value.length > maxLength) {
    throw invalidInput();
  }
  return value;
}

function requiredHttpsUrl(value) {
  const text = requiredText(value, 2048);
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw invalidInput();
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password || parsed.hash) {
    throw invalidInput();
  }
  return parsed.href;
}

function boundedInteger(value, fallback, minimum, maximum) {
  const candidate = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) throw invalidInput();
  return candidate;
}

function normalizeConfig(value) {
  if (!isRecord(value)) throw invalidInput();
  const channelId = requiredText(value.channelId, 80);
  if (!CHANNEL_ID.test(channelId)) throw invalidInput();
  const intervalMinutes = boundedInteger(value.intervalMinutes, 180, 60, MAX_INTERVAL_MINUTES);
  const leaseSeconds = boundedInteger(value.leaseSeconds, 120, 1, 900);
  const cleanupLeaseSeconds = boundedInteger(value.cleanupLeaseSeconds, 120, 1, 900);
  const cleanupBacklogLimit = boundedInteger(value.cleanupBacklogLimit, 10, 1, 10);
  const reconcileWindowSeconds = boundedInteger(
    value.reconcileWindowSeconds, 300, 1, MAX_RECONCILE_WINDOW_SECONDS
  );
  if (value.cleanupEnabled !== undefined && typeof value.cleanupEnabled !== 'boolean') throw invalidInput();
  if (value.ownerSlackIds !== undefined && !isRecord(value.ownerSlackIds)) throw invalidInput();
  return {
    channelId,
    dashboardUrl: requiredHttpsUrl(value.dashboardUrl),
    destinationKey: value.destinationKey === undefined
      ? `slack:${channelId}`
      : requiredText(value.destinationKey, 500),
    intervalMinutes,
    leaseSeconds,
    cleanupEnabled: value.cleanupEnabled === true,
    cleanupLeaseSeconds,
    cleanupBacklogLimit,
    reconcileWindowSeconds,
    ownerSlackIds: value.ownerSlackIds || {}
  };
}

function requireMethod(value, method) {
  if (!value || typeof value[method] !== 'function') throw invalidInput();
}

function validateDependencies(store, slack, cleanupEnabled) {
  for (const method of [
    'claimDivergentDigestRun', 'claimDigestRun', 'listHeybilliOwnerWork', 'prepareDigestParts',
    'claimDigestPartDelivery', 'markDigestPartDelivered', 'markDigestPartFailed',
    'markDigestGenerationDiverged',
    'finalizeDigestRun', 'failDigestRun'
  ]) requireMethod(store, method);
  for (const method of ['postMessage', 'findMessageByClientId', 'deleteMessage']) requireMethod(slack, method);
  if (cleanupEnabled) {
    for (const method of [
      'listDigestCleanupBacklog', 'claimDigestPartCleanup', 'recordDigestPartCleanup'
    ]) requireMethod(store, method);
    requireMethod(slack, 'deleteMessage');
  }
}

export function digestScheduleWindow(now, intervalMinutes = 180) {
  const timestamp = canonicalIso(now);
  const interval = boundedInteger(intervalMinutes, 180, 60, MAX_INTERVAL_MINUTES);
  const intervalMs = interval * 60_000;
  const scheduledMs = Math.floor(Date.parse(timestamp) / intervalMs) * intervalMs;
  const scheduledAt = new Date(scheduledMs).toISOString();
  return {
    scheduledAt,
    windowStartedAt: new Date(scheduledMs - intervalMs).toISOString(),
    windowEndedAt: scheduledAt,
    nextScheduledAt: new Date(scheduledMs + intervalMs).toISOString()
  };
}

function canonicalJsonValue(value, seen) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalidInput();
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => canonicalJsonValue(entry, seen));
  if (!isRecord(value) || seen.has(value)) throw invalidInput();
  seen.add(value);
  const result = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) throw invalidInput();
    result[key] = canonicalJsonValue(value[key], seen);
  }
  seen.delete(value);
  return result;
}

/**
 * Hashes UTF-8 JSON for the exact Slack message body `{channel,text,blocks}`.
 * Object keys are sorted recursively and array order is preserved. The DB-issued
 * client message ID is transport identity and is intentionally not part of this
 * pre-persistence payload hash.
 */
export function canonicalDigestPayloadHash(payload) {
  if (!isRecord(payload)
    || Object.keys(payload).sort().join(',') !== 'blocks,channel,text'
    || typeof payload.channel !== 'string'
    || typeof payload.text !== 'string'
    || !Array.isArray(payload.blocks)) throw invalidInput();
  const canonical = JSON.stringify(canonicalJsonValue(payload, new Set()));
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function messageParts(rendered, channelId) {
  const source = [
    ...rendered.ordinaryParts.map((part) => ({ ...part, persistedKind: 'ordinary' })),
    ...rendered.dailyReminderParts.map((part) => ({ ...part, persistedKind: 'daily_reminder' }))
  ];
  return source.map((part) => {
    const payload = { channel: channelId, text: part.text, blocks: part.blocks };
    return {
      key: `${part.persistedKind}:${part.partNumber}`,
      payload,
      intent: {
        kind: part.persistedKind,
        partNumber: part.partNumber,
        partCount: part.partCount,
        itemIds: [...part.itemIds],
        payloadHash: canonicalDigestPayloadHash(payload)
      }
    };
  });
}

function validateClaim(value, expected) {
  if (!isRecord(value) || typeof value.claimed !== 'boolean' || !isRecord(value.row)) {
    throw new Error('digest_claim_invalid');
  }
  const row = value.row;
  if (typeof row.id !== 'string' || !UUID.test(row.id)
    || typeof row.scheduled_at !== 'string'
    || !Number.isFinite(Date.parse(row.scheduled_at))
    || Date.parse(row.scheduled_at) !== Date.parse(expected.scheduledAt)) throw new Error('digest_claim_invalid');
  if (value.claimed && (typeof row.lease_token !== 'string' || !UUID.test(row.lease_token))) {
    throw new Error('digest_claim_invalid');
  }
  return value;
}

function validateDivergentClaim(value, beforeScheduledAt) {
  if (!isRecord(value) || typeof value.claimed !== 'boolean' || typeof value.created !== 'boolean'
    || value.created && !value.claimed) throw new Error('digest_claim_invalid');
  if (value.row === null) {
    if (value.claimed || value.created || value.previous_digest !== null) {
      throw new Error('digest_claim_invalid');
    }
    return { claim: value, window: null };
  }
  if (!isRecord(value.row)) throw new Error('digest_claim_invalid');
  const row = value.row;
  const scheduledMs = Date.parse(String(row.scheduled_at || ''));
  const windowStartedMs = Date.parse(String(row.window_started_at || ''));
  const windowEndedMs = Date.parse(String(row.window_ended_at || ''));
  if (!Number.isFinite(scheduledMs) || !Number.isFinite(windowStartedMs)
    || !Number.isFinite(windowEndedMs) || scheduledMs >= Date.parse(beforeScheduledAt)
    || windowStartedMs > windowEndedMs || windowEndedMs !== scheduledMs) {
    throw new Error('digest_claim_invalid');
  }
  validateClaim(value, { scheduledAt: new Date(scheduledMs).toISOString() });
  return {
    claim: value,
    window: {
      scheduledAt: new Date(scheduledMs).toISOString(),
      windowStartedAt: new Date(windowStartedMs).toISOString(),
      windowEndedAt: new Date(windowEndedMs).toISOString()
    }
  };
}

function sameArray(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function validatePrepared(value, runId, localParts) {
  const mismatch = isRecord(value) && value.applied === false
    && value.created === false && value.reason === 'manifest_mismatch';
  if (!isRecord(value) || !Array.isArray(value.parts)
    || mismatch && value.parts.length > 50
    || !mismatch && (value.applied !== true || value.parts.length !== localParts.length)) {
    throw new Error('digest_manifest_invalid');
  }
  if (mismatch && (!isRecord(value.row) || value.row.id !== runId || value.row.state !== 'delivering')) {
    throw new Error('digest_manifest_invalid');
  }
  const localByKey = new Map(localParts.map((entry) => [entry.key, entry]));
  const seen = new Set();
  for (const part of value.parts) {
    if (!isRecord(part) || part.digest_run_id !== runId || !PART_KINDS.has(part.part_kind)
      || !Number.isSafeInteger(part.part_number) || !Number.isSafeInteger(part.part_count)
      || typeof part.id !== 'string' || !UUID.test(part.id)
      || typeof part.client_message_id !== 'string' || !UUID.test(part.client_message_id)
      || !DELIVERY_STATES.has(part.delivery_state)
      || !Number.isSafeInteger(part.delivery_attempts) || part.delivery_attempts < 0 || part.delivery_attempts > 3
      || typeof part.payload_hash !== 'string' || !SHA256.test(part.payload_hash)) {
      throw new Error('digest_manifest_invalid');
    }
    const key = `${part.part_kind}:${part.part_number}`;
    const local = localByKey.get(key);
    if (seen.has(key) || !mismatch && (!local || part.part_count !== local.intent.partCount
      || part.payload_hash !== local.intent.payloadHash || !sameArray(part.item_ids, local.intent.itemIds))) {
      throw new Error('digest_manifest_invalid');
    }
    seen.add(key);
  }
  if (!mismatch && seen.size !== localParts.length) throw new Error('digest_manifest_invalid');
  return { mismatch, parts: value.parts };
}

function validMessageCoordinate(value, channelId) {
  return isRecord(value)
    && (value.channel === undefined || value.channel === channelId)
    && typeof value.ts === 'string'
    && SLACK_TS.test(value.ts);
}

function reconciliationWindow(part, seconds) {
  const claimedMs = Date.parse(String(part.delivery_claimed_at || ''));
  if (!Number.isFinite(claimedMs)) throw new Error('delivery_unconfirmed');
  const claimedSeconds = claimedMs / 1000;
  return {
    oldest: Math.max(0.001, claimedSeconds - seconds),
    latest: Math.max(0.001, claimedSeconds + seconds)
  };
}

function historyIncomplete(error) {
  return error?.code === 'history_incomplete';
}

function digestHistoryIncomplete() {
  const error = new Error('digest_history_incomplete');
  error.code = 'digest_history_incomplete';
  return error;
}

function deliveryFailure(error, ambiguous, now) {
  if (ambiguous) return { code: 'delivery_unconfirmed', retryAt: null };
  if (error?.code === 'ratelimited' || error?.kind === 'rate_limit') {
    const seconds = error?.retryAfterSeconds;
    if (Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 86_400) {
      return {
        code: 'rate_limited',
        retryAt: new Date(Date.parse(now) + (seconds * 1000)).toISOString()
      };
    }
    return { code: 'slack_api_error', retryAt: null };
  }
  if (typeof error?.code === 'string' && /^[a-z0-9_]{1,64}$/.test(error.code)) {
    return { code: 'post_rejected', retryAt: null };
  }
  return { code: 'slack_api_error', retryAt: null };
}

async function reconcilePart(slack, part, channelId, reconcileWindowSeconds) {
  const found = await slack.findMessageByClientId({
    channel: channelId,
    clientMsgId: part.client_message_id,
    ...reconciliationWindow(part, reconcileWindowSeconds)
  });
  if (found === null) return null;
  if (!validMessageCoordinate(found, channelId) || found.client_msg_id !== part.client_message_id) {
    throw new Error('delivery_unconfirmed');
  }
  return found;
}

async function settleDelivered({ store, run, part, coordinate, config, now, leaseOwner }) {
  let result;
  try {
    result = await store.markDigestPartDelivered({
      id: run.id,
      partId: part.id,
      leaseOwner,
      leaseToken: run.lease_token,
      expectedDeliveryAttempts: part.delivery_attempts,
      channelId: config.channelId,
      messageTs: coordinate.ts,
      deliveredAt: now
    });
  } catch {
    const error = new Error('digest_delivery_unconfirmed');
    error.code = 'digest_delivery_unconfirmed';
    throw error;
  }
  if (!isRecord(result) || result.applied !== true) {
    const error = new Error('digest_delivery_unconfirmed');
    error.code = 'digest_delivery_unconfirmed';
    throw error;
  }
  return { ...part, delivery_state: 'delivered', slack_channel_id: config.channelId, slack_message_ts: coordinate.ts };
}

async function settleFailed({ store, run, part, code, retryAt, now, leaseOwner }) {
  try {
    await store.markDigestPartFailed({
      id: run.id,
      partId: part.id,
      leaseOwner,
      leaseToken: run.lease_token,
      expectedDeliveryAttempts: part.delivery_attempts,
      error: code,
      failedAt: now,
      retryAt
    });
  } catch {
    // A later lease holder reconciles the same stable client ID. Never expose the underlying error.
  }
}

async function deliverPart({ store, slack, run, persisted, local, config, now, leaseOwner }) {
  if (persisted.delivery_state === 'delivered') {
    if (persisted.slack_channel_id !== config.channelId || !SLACK_TS.test(String(persisted.slack_message_ts || ''))) {
      throw new Error('delivery_unconfirmed');
    }
    return persisted;
  }

  let part = persisted;
  let newlyClaimed = false;
  if (part.delivery_state === 'planned' || part.delivery_state === 'failed') {
    const claim = await store.claimDigestPartDelivery({
      id: run.id,
      partId: part.id,
      leaseOwner,
      leaseToken: run.lease_token
    });
    if (!isRecord(claim) || !isRecord(claim.row) || typeof claim.claimed !== 'boolean') {
      throw new Error('delivery_unconfirmed');
    }
    part = claim.row;
    if (part.id !== persisted.id || part.digest_run_id !== persisted.digest_run_id
      || part.part_kind !== persisted.part_kind || part.part_number !== persisted.part_number
      || part.payload_hash !== persisted.payload_hash
      || part.client_message_id !== persisted.client_message_id
      || !Number.isSafeInteger(part.delivery_attempts) || part.delivery_attempts < 1 || part.delivery_attempts > 3) {
      throw new Error('delivery_unconfirmed');
    }
    if (!claim.claimed) {
      if (part.delivery_state === 'delivered') {
        if (part.slack_channel_id !== config.channelId || !SLACK_TS.test(String(part.slack_message_ts || ''))) {
          throw new Error('delivery_unconfirmed');
        }
        return part;
      }
      if (part.delivery_state === 'failed' && part.delivery_error === 'rate_limited'
        && typeof part.delivery_retry_at === 'string'
        && Number.isFinite(Date.parse(part.delivery_retry_at))
        && Date.parse(part.delivery_retry_at) > Date.parse(now)) {
        const error = new Error('digest_delivery_deferred');
        error.code = 'digest_delivery_deferred';
        throw error;
      }
      if (part.delivery_state !== 'delivering') throw new Error('delivery_unconfirmed');
    } else {
      newlyClaimed = true;
    }
  }

  if (part.delivery_state === 'delivering' && newlyClaimed) {
    let coordinate = null;
    let postError = null;
    try {
      const posted = await slack.postMessage({
        channel: config.channelId,
        text: local.payload.text,
        blocks: local.payload.blocks,
        clientMsgId: part.client_message_id
      });
      if (!validMessageCoordinate(posted, config.channelId)) throw new Error('delivery_unconfirmed');
      coordinate = posted;
    } catch (error) {
      postError = error;
      if (error?.ambiguous === true) {
        try {
          const found = await reconcilePart(slack, part, config.channelId, config.reconcileWindowSeconds);
          if (found) coordinate = found;
        } catch (reconcileError) {
          if (historyIncomplete(reconcileError)) throw digestHistoryIncomplete();
          // The finite reconciliation attempt did not produce an exact coordinate.
        }
      }
    }
    if (coordinate) {
      return settleDelivered({ store, run, part, coordinate, config, now, leaseOwner });
    }
    {
      const failure = deliveryFailure(postError, postError?.ambiguous === true, now);
      await settleFailed({ store, run, part, ...failure, now, leaseOwner });
      throw new Error(failure.code);
    }
  }

  if (part.delivery_state === 'delivering') {
    let coordinate = null;
    try {
      const found = await reconcilePart(slack, part, config.channelId, config.reconcileWindowSeconds);
      if (found) coordinate = found;
    } catch (error) {
      if (historyIncomplete(error)) throw digestHistoryIncomplete();
      // Fall through to durable failure evidence; never repost an unreconciled in-flight attempt.
    }
    if (coordinate) {
      return settleDelivered({ store, run, part, coordinate, config, now, leaseOwner });
    }
    await settleFailed({
      store, run, part, code: 'delivery_unconfirmed', retryAt: null, now, leaseOwner
    });
    throw new Error('delivery_unconfirmed');
  }
  throw new Error('delivery_unconfirmed');
}

async function markRunFailed(store, run, leaseOwner, error) {
  if (!run?.id || !run?.lease_token) return;
  try {
    await store.failDigestRun({
      id: run.id,
      leaseOwner,
      leaseToken: run.lease_token,
      error
    });
  } catch {
    // Lease loss or a store failure is recoverable by the next bounded scheduled attempt.
  }
}

function cleanupFailureCode(error) {
  if (error?.code === 'cant_delete_message') return 'cant_delete_message';
  if (error?.code === 'ratelimited' || error?.kind === 'rate_limit') return 'rate_limited';
  if (error?.code === 'cleanup_unconfirmed') return 'cleanup_unconfirmed';
  return 'slack_api_error';
}

async function settleDivergentEvidence({ store, slack, run, persisted, config, now, leaseOwner }) {
  let part = persisted;
  if (part.delivery_state === 'delivering') {
    let found;
    try {
      found = await reconcilePart(slack, part, config.channelId, config.reconcileWindowSeconds);
    } catch (error) {
      if (historyIncomplete(error)) throw digestHistoryIncomplete();
      throw new Error('digest_generation_handoff_failed');
    }
    if (found === null) {
      return settleFailed({
        store, run, part, code: 'delivery_unconfirmed', retryAt: null, now, leaseOwner
      });
    }
    part = await settleDelivered({ store, run, part, coordinate: found, config, now, leaseOwner });
  }
  return part;
}

async function handoffDivergentGeneration({ store, slack, run, parts, config, now, leaseOwner }) {
  for (const persisted of parts) {
    await settleDivergentEvidence({ store, slack, run, persisted, config, now, leaseOwner });
  }
  const handedOff = await store.markDigestGenerationDiverged({
    id: run.id,
    leaseOwner,
    leaseToken: run.lease_token,
    error: 'digest_generation_diverged'
  });
  if (!isRecord(handedOff) || handedOff.applied !== true || !isRecord(handedOff.row)
    || handedOff.row.id !== run.id || handedOff.row.state !== 'diverged') {
    throw new Error('digest_generation_handoff_failed');
  }
  return handedOff.row;
}

const CLEANUP_BACKLOG_KEYS = [
  'successor_digest_id', 'previous_digest_id', 'previous_cleanup_state', 'parts'
].sort();
const CLEANUP_BACKLOG_PART_KEYS = [
  'previous_part_id', 'part_kind', 'part_number', 'part_count',
  'slack_channel_id', 'slack_message_ts', 'cleanup_state'
].sort();

function validateCleanupBacklogEntry(value) {
  if (!isRecord(value)
    || Object.keys(value).sort().join(',') !== CLEANUP_BACKLOG_KEYS.join(',')
    || typeof value.successor_digest_id !== 'string' || !UUID.test(value.successor_digest_id)
    || typeof value.previous_digest_id !== 'string' || !UUID.test(value.previous_digest_id)
    || value.successor_digest_id === value.previous_digest_id
    || !['idle', 'deleting', 'failed', 'deleted', 'already_absent'].includes(value.previous_cleanup_state)
    || !Array.isArray(value.parts) || value.parts.length < 1 || value.parts.length > 50) {
    throw new Error('cleanup_unconfirmed');
  }
  const seen = new Set();
  return value.parts.map((part) => {
    if (!isRecord(part)
      || Object.keys(part).sort().join(',') !== CLEANUP_BACKLOG_PART_KEYS.join(',')
      || typeof part.previous_part_id !== 'string' || !UUID.test(part.previous_part_id)
      || seen.has(part.previous_part_id)
      || !['idle', 'deleting', 'failed', 'deleted', 'already_absent'].includes(part.cleanup_state)
      || !PART_KINDS.has(part.part_kind) || !Number.isSafeInteger(part.part_number)
      || part.part_number < 1 || !Number.isSafeInteger(part.part_count)
      || part.part_count < part.part_number || part.part_count > 50
      || typeof part.slack_channel_id !== 'string' || !CHANNEL_ID.test(part.slack_channel_id)
      || typeof part.slack_message_ts !== 'string' || !SLACK_TS.test(part.slack_message_ts)) {
      throw new Error('cleanup_unconfirmed');
    }
    seen.add(part.previous_part_id);
    return {
      successor_digest_id: value.successor_digest_id,
      previous_digest_id: value.previous_digest_id,
      previous_cleanup_state: value.previous_cleanup_state,
      ...part
    };
  });
}

async function cleanupBacklog({ store, slack, config, leaseOwner }) {
  const result = { attempted: 0, settled: 0, failed: 0 };
  if (!config.cleanupEnabled) return result;
  let backlog;
  try {
    backlog = await store.listDigestCleanupBacklog({
      destinationKey: config.destinationKey,
      limit: config.cleanupBacklogLimit
    });
    if (!Array.isArray(backlog) || backlog.length > config.cleanupBacklogLimit) {
      throw new Error('cleanup_unconfirmed');
    }
  } catch {
    result.failed = 1;
    return result;
  }
  const seenTargets = new Set();
  const targets = [];
  for (const rawEntry of backlog) {
    try {
      targets.push(...validateCleanupBacklogEntry(rawEntry));
    } catch {
      result.failed += 1;
    }
  }
  for (const target of targets) {
    const targetKey = `${target.successor_digest_id}:${target.previous_part_id}`;
    if (seenTargets.has(targetKey)) continue;
    seenTargets.add(targetKey);
    let claim;
    try {
      claim = await store.claimDigestPartCleanup({
        id: target.successor_digest_id,
        previousDigestId: target.previous_digest_id,
        previousPartId: target.previous_part_id,
        cleanupOwner: leaseOwner,
        leaseSeconds: config.cleanupLeaseSeconds
      });
    } catch {
      result.failed += 1;
      continue;
    }
    if (!isRecord(claim) || typeof claim.claimed !== 'boolean') {
      result.failed += 1;
      continue;
    }
    if (!claim.claimed) {
      const cleanupState = claim.part?.cleanup_state;
      if (!['deleted', 'already_absent'].includes(cleanupState)) result.failed += 1;
      continue;
    }
    const part = claim.part;
    if (!isRecord(part) || part.id !== undefined && part.id !== target.previous_part_id
      || !Number.isSafeInteger(part.cleanup_attempts) || part.cleanup_attempts < 1
      || typeof part.cleanup_token !== 'string' || !UUID.test(part.cleanup_token)) {
      result.failed += 1;
      continue;
    }
    result.attempted += 1;
    let outcome;
    let errorCode = null;
    try {
      const deletion = await slack.deleteMessage({ channel: target.slack_channel_id, ts: target.slack_message_ts });
      if (!isRecord(deletion) || !['deleted', 'already_absent'].includes(deletion.status)) {
        const error = new Error('cleanup unconfirmed');
        error.code = 'cleanup_unconfirmed';
        throw error;
      }
      outcome = deletion.status;
    } catch (error) {
      outcome = 'failed';
      errorCode = cleanupFailureCode(error);
    }
    if (!DELETE_FAILURE_CODES.has(errorCode) && outcome === 'failed') errorCode = 'slack_api_error';
    try {
      const recorded = await store.recordDigestPartCleanup({
        id: target.successor_digest_id,
        previousDigestId: target.previous_digest_id,
        previousPartId: target.previous_part_id,
        cleanupOwner: leaseOwner,
        cleanupToken: part.cleanup_token,
        expectedCleanupAttempts: part.cleanup_attempts,
        outcome,
        ...(outcome === 'failed' ? { error: errorCode } : {})
      });
      if (!isRecord(recorded) || recorded.applied !== true) {
        result.failed += 1;
      } else if (outcome === 'failed') {
        result.failed += 1;
      } else {
        result.settled += 1;
      }
    } catch {
      result.failed += 1;
    }
  }
  return result;
}

function baseResult({ status, scheduledAt, runId, selectedCount = 0, renderedCount = 0,
  partCount = 0, deliveredPartCount = 0, cleanup = { attempted: 0, settled: 0, failed: 0 }, error,
  retryable = false }) {
  const result = {
    status,
    scheduledAt,
    runId,
    selectedCount,
    renderedCount,
    omittedEligibleCount: Math.max(0, selectedCount - renderedCount),
    partCount,
    deliveredPartCount,
    cleanup
  };
  if (error) result.error = error;
  if (retryable) result.retryable = true;
  return result;
}

async function runDigestWindow({ store, slack, config, timestamp, owner, window, preclaimed = null }) {
  const finish = async (input) => {
    const cleanup = await cleanupBacklog({ store, slack, config, leaseOwner: owner });
    return baseResult({
      ...input,
      cleanup,
      retryable: input.retryable === true || cleanup.failed > 0
    });
  };

  let claimed;
  try {
    claimed = preclaimed === null
      ? validateClaim(await store.claimDigestRun({
        destinationKey: config.destinationKey,
        scheduledAt: window.scheduledAt,
        windowStartedAt: window.windowStartedAt,
        windowEndedAt: window.windowEndedAt,
        leaseOwner: owner,
        leaseSeconds: config.leaseSeconds
      }), window)
      : validateClaim(preclaimed, window);
  } catch {
    return finish({
      status: 'failed', error: 'digest_claim_failed', scheduledAt: window.scheduledAt,
      runId: null
    });
  }

  if (!claimed.claimed) {
    const selectedCount = claimed.row.state === 'delivered' && Array.isArray(claimed.row.item_snapshot)
      ? claimed.row.item_snapshot.length
      : 0;
    return finish({
      status: 'not_claimed', scheduledAt: window.scheduledAt, runId: claimed.row.id,
      selectedCount, renderedCount: selectedCount,
      retryable: ['building', 'delivering', 'failed'].includes(claimed.row.state)
    });
  }

  const run = claimed.row;
  let selectedCount = 0;
  let renderedCount = 0;
  let localParts = [];
  let persistedParts = [];
  try {
    const report = await store.listHeybilliOwnerWork({
      now: window.scheduledAt,
      view: 'now',
      category: null,
      limit: 5,
      after: null
    });
    if (!isRecord(report) || !isRecord(report.summary) || !Array.isArray(report.items)
      || report.items.length > 5 || !Number.isSafeInteger(report.summary.now)
      || report.summary.now < report.items.length
      || !Number.isSafeInteger(report.omittedCount)
      || report.omittedCount !== report.summary.now - report.items.length) {
      throw new Error('digest_manifest_invalid');
    }
    const snapshot = buildReportDigestSnapshot(report.items, window.scheduledAt);
    const rendered = buildDigestSlackMessage(report.items, {
      now: window.scheduledAt,
      dashboardUrl: config.dashboardUrl,
      summary: report.summary
    });
    selectedCount = rendered.selectedCount;
    renderedCount = rendered.renderedCount;
    if (renderedCount !== report.items.length || selectedCount !== report.summary.now) {
      throw new Error('digest_manifest_invalid');
    }
    localParts = messageParts(rendered, config.channelId);
    const prepared = await store.prepareDigestParts({
      id: run.id,
      leaseOwner: owner,
      leaseToken: run.lease_token,
      itemSnapshot: snapshot,
      parts: localParts.map(({ intent }) => intent)
    });
    const validated = validatePrepared(prepared, run.id, localParts);
    persistedParts = validated.parts;
    if (validated.mismatch) {
      try {
        await handoffDivergentGeneration({
          store, slack, run, parts: persistedParts, config, now: timestamp, leaseOwner: owner
        });
      } catch (error) {
        const incomplete = error?.code === 'digest_history_incomplete';
        if (incomplete) await markRunFailed(store, run, owner, 'delivery_unconfirmed');
        return finish({
          status: 'failed',
          error: incomplete ? 'digest_history_incomplete' : 'digest_generation_handoff_failed',
          retryable: true,
          scheduledAt: window.scheduledAt, runId: run.id,
          selectedCount, renderedCount, partCount: persistedParts.length,
          deliveredPartCount: persistedParts.filter(({ delivery_state }) => delivery_state === 'delivered').length
        });
      }
      return finish({
        status: 'failed', error: 'digest_generation_diverged', retryable: true,
        scheduledAt: window.scheduledAt, runId: run.id,
        selectedCount, renderedCount, partCount: persistedParts.length,
        deliveredPartCount: persistedParts.filter(({ delivery_state }) => delivery_state === 'delivered').length
      });
    }
  } catch {
    await markRunFailed(store, run, owner, 'digest_build_failed');
    return finish({
      status: 'failed', error: 'digest_build_failed', scheduledAt: window.scheduledAt,
      runId: run.id, selectedCount, renderedCount,
      partCount: localParts.length, deliveredPartCount: 0
    });
  }

  const localByKey = new Map(localParts.map((entry) => [entry.key, entry]));
  const delivered = [];
  try {
    for (const persisted of persistedParts) {
      const local = localByKey.get(`${persisted.part_kind}:${persisted.part_number}`);
      delivered.push(await deliverPart({
        store, slack, run, persisted, local, config, now: timestamp, leaseOwner: owner
      }));
    }
    if (delivered.length !== persistedParts.length
      || delivered.some(({ delivery_state }) => delivery_state !== 'delivered')) {
      throw new Error('delivery_unconfirmed');
    }
    let finalized;
    try {
      finalized = await store.finalizeDigestRun({
        id: run.id,
        leaseOwner: owner,
        leaseToken: run.lease_token,
        deliveredAt: timestamp
      });
    } catch {
      const error = new Error('digest_delivery_unconfirmed');
      error.code = 'digest_delivery_unconfirmed';
      throw error;
    }
    if (!isRecord(finalized) || finalized.applied !== true) {
      const error = new Error('digest_delivery_unconfirmed');
      error.code = 'digest_delivery_unconfirmed';
      throw error;
    }
  } catch (error) {
    if (error?.code === 'digest_history_incomplete') {
      await markRunFailed(store, run, owner, 'delivery_unconfirmed');
      return finish({
        status: 'failed', error: 'digest_history_incomplete', retryable: true,
        scheduledAt: window.scheduledAt, runId: run.id, selectedCount, renderedCount,
        partCount: persistedParts.length,
        deliveredPartCount: delivered.filter(({ delivery_state }) => delivery_state === 'delivered').length
      });
    }
    if (error?.code === 'digest_delivery_unconfirmed') {
      return finish({
        status: 'failed', error: 'digest_delivery_unconfirmed', retryable: true,
        scheduledAt: window.scheduledAt, runId: run.id, selectedCount, renderedCount,
        partCount: persistedParts.length,
        deliveredPartCount: delivered.filter(({ delivery_state }) => delivery_state === 'delivered').length
      });
    }
    if (error?.code === 'digest_delivery_deferred') {
      return finish({
        status: 'failed', error: 'digest_delivery_failed', retryable: true,
        scheduledAt: window.scheduledAt, runId: run.id, selectedCount, renderedCount,
        partCount: persistedParts.length,
        deliveredPartCount: delivered.filter(({ delivery_state }) => delivery_state === 'delivered').length
      });
    }
    await markRunFailed(store, run, owner, 'digest_delivery_failed');
    return finish({
      status: 'failed', error: 'digest_delivery_failed', scheduledAt: window.scheduledAt,
      runId: run.id, selectedCount, renderedCount,
      partCount: persistedParts.length,
      deliveredPartCount: delivered.filter(({ delivery_state }) => delivery_state === 'delivered').length,
      retryable: true
    });
  }

  return finish({
    status: 'delivered', scheduledAt: window.scheduledAt, runId: run.id,
    selectedCount, renderedCount, partCount: persistedParts.length, deliveredPartCount: delivered.length
  });
}

export async function runDigestCycle({ store, slack, config: rawConfig, now, leaseOwner } = {}) {
  const timestamp = canonicalIso(now);
  const config = normalizeConfig(rawConfig);
  const owner = requiredText(leaseOwner, 200);
  validateDependencies(store, slack, config.cleanupEnabled);
  const currentWindow = digestScheduleWindow(timestamp, config.intervalMinutes);
  let recovery = null;
  let recoveryClaimFailed = false;
  try {
    recovery = validateDivergentClaim(await store.claimDivergentDigestRun({
      destinationKey: config.destinationKey,
      beforeScheduledAt: currentWindow.scheduledAt,
      leaseOwner: owner,
      leaseSeconds: config.leaseSeconds
    }), currentWindow.scheduledAt);
  } catch {
    recoveryClaimFailed = true;
  }

  let recoveryResult = null;
  if (recovery?.claim.claimed) {
    recoveryResult = await runDigestWindow({
      store, slack, config, timestamp, owner,
      window: recovery.window,
      preclaimed: recovery.claim
    });
  }
  const currentResult = await runDigestWindow({
    store, slack, config, timestamp, owner, window: currentWindow
  });

  if (recoveryResult && recoveryResult.status !== 'delivered') return recoveryResult;
  if (recoveryClaimFailed && currentResult.status === 'delivered') {
    return {
      ...currentResult,
      status: 'failed',
      error: 'digest_claim_failed',
      retryable: true
    };
  }
  if (recoveryResult
    || recoveryClaimFailed
    || recovery?.claim.row && !recovery.claim.claimed
      && ['building', 'delivering', 'failed'].includes(recovery.claim.row.state)) {
    return { ...currentResult, retryable: true };
  }
  return currentResult;
}
