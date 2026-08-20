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

function parseWaitMs(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw requestError(400, 'invalid_wait_ms');
  return Math.floor(parsed);
}

function channelErrorResponse(error) {
  const status = error?.status || (['stale_lease', 'stale_room_revision', 'completion_conflict', 'receipt_conflict'].includes(error?.code) ? 409 : 400);
  return { status, error: error?.status ? error.message : String(error?.code || 'invalid_request') };
}

export function createHermesGatewayHttpHandler({ token, channel, executeConfirmation, transport = 'cli' } = {}) {
  const gatewayConfigured = GATEWAY_TRANSPORTS.has(transport) && Boolean(String(token || '').trim()) && Boolean(channel);

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
        await channel.complete(body);
        sendJson(res, 200, { ok: true });
        return true;
      }

      if (req.method === 'POST' && url.pathname === '/hermes/v1/outcomes') {
        const body = await readJsonBody(req);
        requiredLeaseId(body);
        await channel.recordOutcome(body);
        sendJson(res, 200, { ok: true });
        return true;
      }

      if (req.method === 'POST' && url.pathname === '/hermes/v1/tools/confirmation-request') {
        const body = await readJsonBody(req);
        const leaseId = requiredLeaseId(body);
        if (typeof executeConfirmation !== 'function') throw requestError(503, 'confirmation_unavailable');
        const receipt = await executeConfirmation(body);
        if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw requestError(502, 'invalid_confirmation_receipt');
        if (receipt.lease_id && receipt.lease_id !== leaseId) throw requestError(409, 'lease_id_mismatch');
        const fencedReceipt = { ...receipt, lease_id: leaseId };
        await channel.recordToolReceipt(fencedReceipt);
        sendJson(res, 200, fencedReceipt);
        return true;
      }

      if (req.method === 'GET' && url.pathname === '/hermes/v1/status') {
        const status = await channel.status();
        const oldestLeaseAge = status?.oldest_lease_age_ms ?? status?.oldestLeaseAgeMs ?? null;
        sendJson(res, 200, {
          transport,
          gatewayConfigured: true,
          counts: status?.counts && typeof status.counts === 'object' ? status.counts : {},
          oldest_lease_age_ms: Number.isFinite(oldestLeaseAge) ? oldestLeaseAge : null
        });
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
