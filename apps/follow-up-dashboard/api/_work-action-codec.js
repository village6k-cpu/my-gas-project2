const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const UTC_MS = /^(?!0000)[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/;
const ACTION_TYPES = new Set(['progress', 'snooze', 'ack_p0', 'request_resolve', 'dismiss']);
const MAX_ENCODED_LENGTH = 1000;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value).sort();
  const allowed = [...expected].sort();
  return actual.length === allowed.length && actual.every((key, index) => key === allowed[index]);
}

function decodeBoundedJson(value, error) {
  try {
    if (typeof value !== 'string' || !value || value.length > MAX_ENCODED_LENGTH || !BASE64URL.test(value)) {
      throw error;
    }
    const bytes = Buffer.from(value, 'base64url');
    if (bytes.length > 750 || bytes.toString('base64url') !== value) throw error;
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw error;
  }
}

export function decodeWorkActionValue(value) {
  const invalid = new Error('invalid work action value');
  try {
    const decoded = decodeBoundedJson(value, invalid);
    if (!exactKeys(decoded, ['action', 'id', 'version'])
      || typeof decoded.id !== 'string' || !UUID.test(decoded.id)
      || !Number.isSafeInteger(decoded.version) || decoded.version < 1
      || !isRecord(decoded.action) || !ACTION_TYPES.has(decoded.action.type)) throw invalid;
    const actionKeys = decoded.action.type === 'snooze' ? ['snoozedUntil', 'type'] : ['type'];
    if (!exactKeys(decoded.action, actionKeys)) throw invalid;
    if (decoded.action.type === 'snooze') {
      const timestamp = decoded.action.snoozedUntil;
      const date = typeof timestamp === 'string' && timestamp.length <= 40 && UTC_MS.test(timestamp)
        ? new Date(timestamp)
        : null;
      if (!date || Number.isNaN(date.getTime()) || date.toISOString() !== timestamp) throw invalid;
    }
    return { id: decoded.id, version: decoded.version, action: { ...decoded.action } };
  } catch {
    throw invalid;
  }
}

export function decodeWorkActionContext(value) {
  const invalid = new Error('invalid work action context');
  try {
    const decoded = decodeBoundedJson(value, invalid);
    if (!exactKeys(decoded, ['id', 'version'])
      || typeof decoded.id !== 'string' || !UUID.test(decoded.id)
      || !Number.isSafeInteger(decoded.version) || decoded.version < 1) throw invalid;
    return { id: decoded.id.toLowerCase(), version: decoded.version };
  } catch {
    throw invalid;
  }
}
