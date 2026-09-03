const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLACK_CHANNEL = /^[A-Z0-9][A-Z0-9_-]{0,79}$/;
const SLACK_TIMESTAMP = /^\d{1,20}\.\d{1,20}$/;
const SLACK_USER = /^U[A-Z0-9]{1,79}$/;
const SLACK_BOT = /^B[A-Z0-9]{1,79}$/;
const SLACK_TEAM = /^T[A-Z0-9]{1,79}$/;
const FAILURE_CODES = new Set([
  'cant_delete_message', 'rate_limited', 'cleanup_unconfirmed', 'slack_api_error'
]);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactText(value, maximum) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximum || value !== value.trim()) {
    throw new Error('notice cleanup input is invalid');
  }
  return value;
}

function canonicalTimestamp(value) {
  const text = exactText(value, 40);
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== text) {
    throw new Error('notice cleanup input is invalid');
  }
  return text;
}

function validatedConfig(config) {
  if (!isRecord(config)) throw new Error('notice cleanup input is invalid');
  const botUserId = exactText(config.botUserId, 80);
  const botId = exactText(config.botId, 80);
  const teamId = exactText(config.teamId, 80);
  const cleanupOwner = exactText(config.cleanupOwner, 200);
  if (!SLACK_USER.test(botUserId) || !SLACK_BOT.test(botId) || !SLACK_TEAM.test(teamId)
    || !Number.isSafeInteger(config.cleanupLeaseSeconds)
    || config.cleanupLeaseSeconds < 1
    || config.cleanupLeaseSeconds > 900) {
    throw new Error('notice cleanup input is invalid');
  }
  return { botUserId, botId, teamId, cleanupOwner, cleanupLeaseSeconds: config.cleanupLeaseSeconds };
}

function claimedGeneration(row) {
  if (!isRecord(row) || typeof row.id !== 'string' || !UUID.test(row.id)
    || row.cleanup_state !== 'pending'
    || !Number.isSafeInteger(row.cleanup_attempts) || row.cleanup_attempts < 1
    || typeof row.cleanup_token !== 'string' || !UUID.test(row.cleanup_token)
    || !['valid', 'missing_coordinates'].includes(row.coordinate_status)) {
    return null;
  }
  return {
    id: row.id.toLowerCase(),
    cleanupToken: row.cleanup_token.toLowerCase(),
    expectedCleanupAttempts: row.cleanup_attempts,
    coordinateStatus: row.coordinate_status,
    channel: row.slack_channel_id,
    ts: row.slack_message_ts
  };
}

function cleanupFailureCode(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  return FAILURE_CODES.has(code) ? code : 'slack_api_error';
}

export async function runNoticeCleanupSweep({ store, slack, config, now } = {}) {
  if (!isRecord(store) || typeof store.claimCleanupBatch !== 'function'
    || typeof store.markCleanupDeleted !== 'function' || typeof store.markCleanupFailed !== 'function'
    || !isRecord(slack) || typeof slack.authTest !== 'function' || typeof slack.deleteMessage !== 'function') {
    throw new Error('notice cleanup input is invalid');
  }
  const when = canonicalTimestamp(now);
  const normalized = validatedConfig(config);
  const result = {
    claimed: 0, deleted: 0, alreadyAbsent: 0, failed: 0, blockedP0: 0, excluded: 0
  };

  let rows;
  try {
    rows = await store.claimCleanupBatch({
      now: when,
      cleanupOwner: normalized.cleanupOwner,
      leaseSeconds: normalized.cleanupLeaseSeconds,
      limit: 25
    });
  } catch {
    result.failed = 1;
    return result;
  }
  if (!Array.isArray(rows) || rows.length > 25) {
    result.failed = 1;
    return result;
  }

  const targets = [];
  for (const row of rows) {
    if (isRecord(row) && row.cleanup_state === 'blocked_p0') {
      result.blockedP0 += 1;
      continue;
    }
    const generation = claimedGeneration(row);
    if (generation === null) {
      result.failed += 1;
      continue;
    }
    result.claimed += 1;
    targets.push(generation);
  }
  if (targets.length === 0) return result;

  const markFailed = async (target, error) => {
    try {
      const recorded = await store.markCleanupFailed({
        id: target.id,
        cleanupOwner: normalized.cleanupOwner,
        cleanupToken: target.cleanupToken,
        expectedCleanupAttempts: target.expectedCleanupAttempts,
        error
      });
      return isRecord(recorded) && recorded.applied === true;
    } catch {
      return false;
    }
  };

  let identity;
  try {
    identity = await slack.authTest();
  } catch {
    for (const target of targets) {
      await markFailed(target, 'slack_api_error');
      result.failed += 1;
    }
    return result;
  }
  if (!isRecord(identity) || identity.userId !== normalized.botUserId
    || identity.botId !== normalized.botId || identity.teamId !== normalized.teamId) {
    for (const target of targets) {
      await markFailed(target, 'bot_identity_mismatch');
      result.excluded += 1;
    }
    return result;
  }

  for (const target of targets) {
    if (target.coordinateStatus !== 'valid'
      || typeof target.channel !== 'string' || !SLACK_CHANNEL.test(target.channel)
      || typeof target.ts !== 'string' || !SLACK_TIMESTAMP.test(target.ts)) {
      await markFailed(target, 'missing_coordinates');
      result.failed += 1;
      continue;
    }

    let deletion;
    try {
      deletion = await slack.deleteMessage({ channel: target.channel, ts: target.ts });
      if (!isRecord(deletion) || !['deleted', 'already_absent'].includes(deletion.status)) {
        const error = new Error('cleanup unconfirmed');
        error.code = 'cleanup_unconfirmed';
        throw error;
      }
    } catch (error) {
      await markFailed(target, cleanupFailureCode(error));
      result.failed += 1;
      continue;
    }

    try {
      const recorded = await store.markCleanupDeleted({
        id: target.id,
        cleanupOwner: normalized.cleanupOwner,
        cleanupToken: target.cleanupToken,
        expectedCleanupAttempts: target.expectedCleanupAttempts,
        alreadyAbsent: deletion.status === 'already_absent'
      });
      if (!isRecord(recorded) || recorded.applied !== true) {
        result.failed += 1;
      } else if (deletion.status === 'already_absent') {
        result.alreadyAbsent += 1;
      } else {
        result.deleted += 1;
      }
    } catch {
      result.failed += 1;
    }
  }
  return result;
}
