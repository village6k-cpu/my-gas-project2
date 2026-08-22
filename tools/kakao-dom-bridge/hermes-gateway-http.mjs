import crypto from 'node:crypto';

const MAX_BODY_BYTES = 1_048_576;
const GATEWAY_TRANSPORTS = new Set(['gateway', 'gateway_no_send']);

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload)
  });
  res.end(payload);
}

function isLoopback(address) {
  const value = String(address || '').toLowerCase();
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1';
}

function hasBearerToken(header, token) {
  const match = /^Bearer ([^\s]+)$/.exec(String(header || ''));
  if (!match || !token) return false;
  const expected = crypto.createHash('sha256').update(token, 'utf8').digest();
  const supplied = crypto.createHash('sha256').update(match[1], 'utf8').digest();
  return crypto.timingSafeEqual(expected, supplied);
}

function requestError(status, error) {
  const value = new Error(error);
  value.status = status;
  return value;
}

async function readJsonBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > MAX_BODY_BYTES) throw requestError(413, 'request_too_large');
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString('utf8');
  if (!body.trim()) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw requestError(400, 'invalid_json');
  }
}

function requiredLeaseId(body) {
  const leaseId = String(body?.lease_id || '').trim();
  if (!leaseId) throw requestError(400, 'lease_id_required');
  return leaseId;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalJson(value[key])]));
  }
  return value;
}

export function confirmationRequestDigest(body = {}) {
  const payload = {
    schema: body.schema || 'village-confirmation-request/v1',
    job_id: body.job_id,
    room_key: body.room_key,
    room_revision: body.room_revision,
    decision: body.decision
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonicalJson(payload)), 'utf8').digest('hex');
}

function exactClaimForConfirmation(job, body, leaseId, nowMs) {
  const leaseExpiresAt = Number(job?.lease_expires_at_ms);
  return job
    && job.state === 'claimed'
    && String(job.job_id || '') === String(body?.job_id || '')
    && String(job.room_key || '') === String(body?.room_key || '')
    && Number(job.room_revision) === body?.room_revision
    && typeof body?.room_revision === 'number'
    && Number.isInteger(body.room_revision)
    && Number(body.room_revision) > 0
    && String(job.lease_id || '') === leaseId
    && Number.isFinite(leaseExpiresAt)
    && leaseExpiresAt > nowMs;
}

function durableOperationForRequest(job, body, leaseId, requestDigest) {
  if (!job
    || String(job.job_id || '') !== String(body?.job_id || '')
    || String(job.room_key || '') !== String(body?.room_key || '')
    || Number(job.room_revision) !== Number(body?.room_revision)) {
    return { reservation: null, receipt: null, conflict: false };
  }
  const reservation = job.tool_operation;
  if (!reservation) return { reservation: null, receipt: null, conflict: false };
  const matches = reservation.schema === 'village-tool-operation-reservation/v1'
    && reservation.tool === 'confirmation_request'
    && String(reservation.job_id || '') === String(body.job_id || '')
    && String(reservation.room_key || '') === String(body.room_key || '')
    && Number(reservation.room_revision) === Number(body.room_revision)
    && String(reservation.lease_id || '') === leaseId
    && String(reservation.request_digest || '') === requestDigest
    && String(reservation.operation_id || '').trim();
  if (!matches) return { reservation, receipt: null, conflict: true };
  const receipt = (Array.isArray(job.tool_receipts) ? job.tool_receipts : []).find((candidate) => (
    candidate?.schema === 'village-confirmation-receipt/v1'
    && String(candidate.job_id || '') === String(body.job_id || '')
    && String(candidate.room_key || '') === String(body.room_key || '')
    && Number(candidate.room_revision) === Number(body.room_revision)
    && String(candidate.lease_id || '') === leaseId
    && String(candidate.request_digest || '') === requestDigest
    && String(candidate.operation_id || '') === reservation.operation_id
  )) || null;
  return { reservation, receipt, conflict: false };
}

function unfencedReceiptConflict(job, body, leaseId) {
  return (Array.isArray(job?.tool_receipts) ? job.tool_receipts : []).some((receipt) => (
    receipt?.schema === 'village-confirmation-receipt/v1'
    && String(receipt.job_id || '') === String(body.job_id || '')
    && String(receipt.room_key || '') === String(body.room_key || '')
    && Number(receipt.room_revision) === Number(body.room_revision)
    && String(receipt.lease_id || '') === leaseId
  ));
}

function parseWaitMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw requestError(400, 'invalid_wait_ms');
  return Math.floor(parsed);
}

function channelErrorResponse(error) {
  const status = error?.status || ([
    'stale_lease', 'stale_room_revision', 'completion_conflict', 'receipt_conflict',
    'confirmation_operation_conflict', 'confirmation_operation_unresolved',
    'operation_fence_required', 'operation_fence_mismatch'
  ].includes(error?.code) ? 409 : 400);
  return { status, error: error?.status ? error.message : String(error?.code || 'invalid_request') };
}

function safeNonNegativeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

export function buildGatewayHealthReadback({
  transport = 'cli', gatewayConfigured = false, status = {}, nowMs = Date.now(), consumerFreshnessMs = 600_000
} = {}) {
  const currentMs = Number(nowMs);
  const freshnessMs = Math.max(1, Number(consumerFreshnessMs) || 600_000);
  const consumerId = String(status?.last_consumer_id || '').trim().slice(0, 128) || null;
  const seenAt = String(status?.last_consumer_seen_at || '').trim();
  const seenAtMs = Date.parse(seenAt);
  const consumerAgeMs = Number.isFinite(currentMs) && Number.isFinite(seenAtMs)
    ? Math.max(0, currentMs - seenAtMs)
    : null;
  const consumerFresh = Boolean(consumerId) && consumerAgeMs !== null && consumerAgeMs <= freshnessMs;
  const counts = status?.counts && typeof status.counts === 'object' ? status.counts : {};
  const applicationCounts = status?.application_counts && typeof status.application_counts === 'object'
    ? status.application_counts
    : {};
  const failureNotificationCounts = status?.failure_notification_counts && typeof status.failure_notification_counts === 'object'
    ? status.failure_notification_counts
    : {};
  const oldestClaimAge = status?.oldest_lease_age_ms === null || status?.oldest_lease_age_ms === undefined
    ? null
    : Number(status.oldest_lease_age_ms);
  return {
    transport: String(transport || 'cli'),
    gatewayConfigured: Boolean(gatewayConfigured),
    gatewayReady: Boolean(gatewayConfigured) && consumerFresh,
    consumer: {
      id: consumerId,
      last_seen_at: Number.isFinite(seenAtMs) ? seenAt : null,
      age_ms: consumerAgeMs,
      fresh: consumerFresh
    },
    queue: {
      ready: safeNonNegativeInteger(counts.ready),
      claimed: safeNonNegativeInteger(counts.claimed),
      retry: safeNonNegativeInteger(counts.retry_wait),
      failed: safeNonNegativeInteger(counts.failed),
      oldest_claim_age_ms: Number.isFinite(oldestClaimAge) && oldestClaimAge >= 0 ? oldestClaimAge : null,
      last_completed_job_id: String(status?.last_completed_job_id || '').trim().slice(0, 160) || null
    },
    application_counts: Object.fromEntries(
      ['pending', 'claimed', 'applying', 'applied', 'finalized', 'failed']
        .map((key) => [key, safeNonNegativeInteger(applicationCounts[key])])
    ),
    failure_notification_counts: Object.fromEntries(
      ['pending', 'delivered'].map((key) => [key, safeNonNegativeInteger(failureNotificationCounts[key])])
    ),
    unnotified_application_failures: safeNonNegativeInteger(status?.unnotified_application_failures)
  };
}

export function createHermesGatewayHttpHandler({
  token, channel, executeConfirmation, enqueueResultApplication, recoverFailureNotifications,
  transport = 'cli', now = Date.now, consumerFreshnessMs = 600_000
} = {}) {
  const gatewayConfigured = GATEWAY_TRANSPORTS.has(transport) && Boolean(String(token || '').trim()) && Boolean(channel);
  const confirmationInFlight = new Map();

  return async function handleHermesGatewayRequest(req, res, url) {
    if (!url.pathname.startsWith('/hermes/v1/')) return false;
    if (!gatewayConfigured) return false;
    if (!isLoopback(req.socket?.remoteAddress || req.connection?.remoteAddress)) {
      sendJson(res, 403, { error: 'loopback_required' });
      return true;
    }
    if (!hasBearerToken(req.headers?.authorization, token)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return true;
    }

    try {
      if (req.method === 'GET' && url.pathname === '/hermes/v1/events') {
        const consumerId = String(url.searchParams.get('consumer_id') || '').trim();
        if (!consumerId) throw requestError(400, 'consumer_id_required');
        const claimed = await channel.claim({ consumerId, waitMs: parseWaitMs(url.searchParams.get('wait_ms') || '0') });
        if (typeof recoverFailureNotifications === 'function') {
          await Promise.resolve(recoverFailureNotifications()).catch(() => {});
        }
        if (!claimed) {
          sendJson(res, 200, { event: null });
          return true;
        }
        sendJson(res, 200, {
          event: {
            ...(claimed.event || {}),
            job_id: claimed.job_id,
            room_key: claimed.room_key,
            room_revision: claimed.room_revision,
            lease_id: claimed.lease_id
          }
        });
        return true;
      }

      if (req.method === 'POST' && url.pathname === '/hermes/v1/results') {
        const body = await readJsonBody(req);
        requiredLeaseId(body);
        const completed = await channel.complete(body);
        if (typeof enqueueResultApplication === 'function') {
          try {
            await enqueueResultApplication(completed);
          } catch {
            throw requestError(503, 'result_application_enqueue_failed');
          }
        }
        sendJson(res, 200, { ok: true });
        return true;
      }

      if (req.method === 'POST' && url.pathname === '/hermes/v1/outcomes') {
        const body = await readJsonBody(req);
        requiredLeaseId(body);
        await channel.recordOutcome(body);
        if (typeof recoverFailureNotifications === 'function') {
          await Promise.resolve(recoverFailureNotifications()).catch(() => {});
        }
        sendJson(res, 200, { ok: true });
        return true;
      }

      if (req.method === 'POST' && url.pathname === '/hermes/v1/tools/confirmation-request') {
        const body = await readJsonBody(req);
        const leaseId = requiredLeaseId(body);
        if (transport === 'gateway_no_send') throw requestError(403, 'writes_disabled');
        if (typeof channel.get !== 'function' || typeof channel.reserveToolOperation !== 'function') {
          throw requestError(503, 'confirmation_fencing_unavailable');
        }
        const requestDigest = confirmationRequestDigest(body);
        const currentTime = () => {
          const value = now();
          const milliseconds = value instanceof Date ? value.getTime() : Number(value);
          if (!Number.isFinite(milliseconds)) throw requestError(503, 'confirmation_clock_unavailable');
          return milliseconds;
        };
        const assertCurrentClaim = async () => {
          const currentJob = await channel.get(body?.job_id);
          if (!exactClaimForConfirmation(currentJob, body, leaseId, currentTime())) throw requestError(409, 'stale_lease');
          return currentJob;
        };
        const claimKey = [body.job_id, body.room_key, body.room_revision, leaseId].map((value) => String(value)).join('\u0000');
        let inFlight = confirmationInFlight.get(claimKey);
        if (inFlight && inFlight.requestDigest !== requestDigest) {
          throw requestError(409, 'confirmation_request_conflict');
        }
        if (inFlight) {
          try {
            sendJson(res, 200, await inFlight.operation);
          } finally {
            if (confirmationInFlight.get(claimKey) === inFlight) confirmationInFlight.delete(claimKey);
          }
          return true;
        }
        const claimedJob = await channel.get(body?.job_id);
        inFlight = confirmationInFlight.get(claimKey);
        if (inFlight && inFlight.requestDigest !== requestDigest) {
          throw requestError(409, 'confirmation_request_conflict');
        }
        if (inFlight) {
          try {
            sendJson(res, 200, await inFlight.operation);
          } finally {
            if (confirmationInFlight.get(claimKey) === inFlight) confirmationInFlight.delete(claimKey);
          }
          return true;
        }
        const durable = durableOperationForRequest(claimedJob, body, leaseId, requestDigest);
        if (durable.conflict || (!durable.reservation && unfencedReceiptConflict(claimedJob, body, leaseId))) {
          throw requestError(409, 'confirmation_request_conflict');
        }
        if (durable.receipt) {
          sendJson(res, 200, durable.receipt);
          return true;
        }
        if (durable.reservation) throw requestError(409, 'confirmation_operation_unresolved');
        if (!exactClaimForConfirmation(claimedJob, body, leaseId, currentTime())) throw requestError(409, 'stale_lease');
        if (typeof executeConfirmation !== 'function') throw requestError(503, 'confirmation_unavailable');
        const operation = Promise.resolve().then(async () => {
            const reserved = await channel.reserveToolOperation({
              tool: 'confirmation_request',
              job_id: body.job_id,
              room_key: body.room_key,
              room_revision: body.room_revision,
              lease_id: leaseId,
              request_digest: requestDigest
            });
            if (!reserved?.created || !reserved?.reservation) {
              throw requestError(409, 'confirmation_operation_unresolved');
            }
            const operationFence = reserved.reservation;
            await assertCurrentClaim();
            const receipt = await executeConfirmation(body, { assertCurrentClaim, operationFence });
            if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw requestError(502, 'invalid_confirmation_receipt');
            if (String(receipt.job_id || '') !== String(body.job_id || '')
              || String(receipt.room_key || '') !== String(body.room_key || '')
              || Number(receipt.room_revision) !== Number(body.room_revision)) {
              throw requestError(502, 'confirmation_receipt_correlation_mismatch');
            }
            if (receipt.lease_id && receipt.lease_id !== leaseId) throw requestError(409, 'lease_id_mismatch');
            if (receipt.request_digest && receipt.request_digest !== requestDigest) {
              throw requestError(502, 'confirmation_receipt_request_mismatch');
            }
            if (receipt.operation_id && receipt.operation_id !== operationFence.operation_id) {
              throw requestError(502, 'confirmation_receipt_operation_mismatch');
            }
            const fencedReceipt = {
              ...receipt,
              lease_id: leaseId,
              request_digest: requestDigest,
              operation_id: operationFence.operation_id
            };
            await channel.recordToolReceipt(fencedReceipt);
            return fencedReceipt;
          });
        inFlight = { requestDigest, operation };
        confirmationInFlight.set(claimKey, inFlight);
        try {
          sendJson(res, 200, await inFlight.operation);
        } finally {
          if (confirmationInFlight.get(claimKey) === inFlight) confirmationInFlight.delete(claimKey);
        }
        return true;
      }

      if (req.method === 'GET' && url.pathname === '/hermes/v1/status') {
        const status = await channel.status();
        const current = now();
        const currentMs = current instanceof Date ? current.getTime() : Number(current);
        sendJson(res, 200, buildGatewayHealthReadback({
          transport, gatewayConfigured: true, status, nowMs: currentMs, consumerFreshnessMs
        }));
        return true;
      }
    } catch (error) {
      const response = channelErrorResponse(error);
      sendJson(res, response.status, { error: response.error });
      return true;
    }

    return false;
  };
}
