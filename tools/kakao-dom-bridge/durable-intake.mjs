// Durable local intake only. Business execution and receipt authority belong to the caller.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const ID = /^[0-9a-f]{64}$/;
const EVENT_FILE = /^([0-9a-f]{64})\.event\.json$/;
const HANDOFF_FILE = /^([0-9a-f]{64})\.handoff\.json$/;
const RESERVE_BYTES = 256 * 1024 * 1024;
const clone = value => JSON.parse(JSON.stringify(value));
const sha256 = value => createHash('sha256').update(value).digest('hex');

function failure(code, cause) {
  const error = new Error(code, cause ? { cause } : undefined);
  error.code = code;
  return error;
}

function canonical(value, depth = 0) {
  if (depth > 100) throw failure('durable_intake_payload_too_deep');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => canonical(item, depth + 1));
  if (value && typeof value === 'object'
    && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key], depth + 1)]));
  }
  throw failure('durable_intake_payload_must_be_json');
}

function payloadText(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw failure('durable_intake_payload_must_be_object');
  }
  return JSON.stringify(canonical(value));
}

/**
 * A single bridge owner may use this journal; its existing service lock owns process exclusion.
 * Immutable event files and separate handoff files preserve the input even when marking fails.
 * Temporary files are uncommitted and ignored after a crash. No record is silently evicted.
 */
export function createDurableIntake({
  directory, storage = {}, reserveBytes = RESERVE_BYTES, maxRecordBytes = 4 * 1024 * 1024,
  now = () => new Date().toISOString()
} = {}) {
  if (!directory || !path.isAbsolute(directory)) throw failure('durable_intake_absolute_directory_required');
  if (!Number.isSafeInteger(reserveBytes) || reserveBytes < 0
    || !Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1) {
    throw failure('durable_intake_invalid_limits');
  }
  const io = { ...fs, ...storage };
  const created = [];
  for (let cursor = directory; !io.existsSync(cursor); cursor = path.dirname(cursor)) created.push(cursor);
  io.mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Persist newly created directory entries too, not just the eventual event rename.
  for (const child of created.reverse()) {
    const fd = io.openSync(path.dirname(child), 'r');
    try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
  }
  if (!io.statSync(directory).isDirectory()) throw failure('durable_intake_directory_required');
  const eventPath = id => path.join(directory, id + '.event.json');
  const handoffPath = id => path.join(directory, id + '.handoff.json');
  const index = new Map();
  const validId = id => {
    if (typeof id !== 'string' || !ID.test(id)) throw failure('durable_intake_invalid_id');
    return id;
  };
  const syncDirectory = () => {
    const fd = io.openSync(directory, 'r');
    try { io.fsyncSync(fd); } finally { io.closeSync(fd); }
  };
  function readJson(file) {
    try { return JSON.parse(io.readFileSync(file, 'utf8')); }
    catch (error) { throw failure('durable_intake_corrupt_record', error); }
  }
  function readEvent(id) {
    const row = readJson(eventPath(validId(id)));
    let text;
    try { text = payloadText(row.event); }
    catch (error) { throw failure('durable_intake_corrupt_record', error); }
    if (row.schema !== 'village-durable-intake/v1' || row.id !== id || row.event_sha256 !== id
      || sha256(text) !== id || typeof row.accepted_at !== 'string' || !Number.isFinite(Date.parse(row.accepted_at))) {
      throw failure('durable_intake_corrupt_record');
    }
    return row;
  }
  function readHandoff(id) {
    if (!io.existsSync(handoffPath(id))) return null;
    const row = readJson(handoffPath(id));
    let text;
    try { text = payloadText(row.proof); }
    catch (error) { throw failure('durable_intake_corrupt_handoff', error); }
    if (row.schema !== 'village-durable-intake-handoff/v1' || row.id !== id
      || row.proof?.durable !== true || row.proof_sha256 !== sha256(text)
      || !Number.isFinite(Date.parse(row.handed_off_at))) throw failure('durable_intake_corrupt_handoff');
    return row;
  }
  function atomicWrite(file, object) {
    const bytes = Buffer.from(JSON.stringify(object) + '\n');
    if (bytes.length > maxRecordBytes) throw failure('durable_intake_record_too_large');
    const stat = io.statfsSync(directory);
    if (Number(stat.bavail) * Number(stat.bsize) - bytes.length < reserveBytes) {
      throw failure('durable_intake_disk_reserve');
    }
    const temporary = file + '.' + process.pid + '.' + randomUUID() + '.tmp';
    let fd;
    try {
      fd = io.openSync(temporary, 'wx', 0o600);
      let written = 0;
      while (written < bytes.length) {
        const count = io.writeSync(fd, bytes, written, bytes.length - written);
        if (!Number.isInteger(count) || count <= 0) throw failure('durable_intake_short_write');
        written += count;
      }
      io.fsyncSync(fd);
      io.closeSync(fd); fd = undefined;
      io.renameSync(temporary, file);
      syncDirectory();
    } catch (error) {
      if (fd !== undefined) { try { io.closeSync(fd); } catch {} }
      throw failure(error.code || 'durable_intake_write_failed', error);
    }
  }
  // Startup validates the full journal; successful handoffs do not hide damaged source evidence.
  const names = io.readdirSync(directory);
  const ids = new Set(names.map(name => EVENT_FILE.exec(name)?.[1]).filter(Boolean));
  for (const name of names) {
    const id = HANDOFF_FILE.exec(name)?.[1];
    if (id && !ids.has(id)) throw failure('durable_intake_orphan_handoff');
  }
  for (const id of ids) {
    const event = readEvent(id), handoff = readHandoff(id);
    index.set(id, { accepted_at: event.accepted_at, handedOff: Boolean(handoff) });
  }
  function read(id) {
    validId(id);
    if (!io.existsSync(eventPath(id))) return null;
    const record = readEvent(id), handoff = readHandoff(id);
    index.set(id, { accepted_at: record.accepted_at, handedOff: Boolean(handoff) });
    return { id, event: clone(record.event), acceptedAt: record.accepted_at,
      handedOff: Boolean(handoff), proof: handoff ? clone(handoff.proof) : null };
  }
  return {
    accept(event) {
      const serialized = payloadText(event), id = sha256(serialized);
      if (io.existsSync(eventPath(id))) {
        const existing = read(id);
        // A rename may have succeeded immediately before an earlier directory-fsync failure.
        // Re-sync before acknowledging the retry; do not rewrite or discard a handoff.
        syncDirectory();
        return { id, duplicate: true, handedOff: existing.handedOff };
      }
      const acceptedAt = now();
      if (typeof acceptedAt !== 'string' || !Number.isFinite(Date.parse(acceptedAt))) throw failure('durable_intake_invalid_clock');
      try {
        atomicWrite(eventPath(id), { schema: 'village-durable-intake/v1', id,
          event_sha256: id, accepted_at: acceptedAt, event: JSON.parse(serialized) });
      } catch (error) {
        // A completed rename followed by fsync failure is unacknowledged, but it
        // must still be visible to in-process replay if the watcher never retries.
        if (io.existsSync(eventPath(id))) read(id);
        throw error;
      }
      index.set(id, { accepted_at: acceptedAt, handedOff: false });
      return { id, duplicate: false, handedOff: false };
    },
    mark(id, proof) {
      validId(id);
      if (!proof || proof.durable !== true) throw failure('durable_intake_durable_handoff_required');
      const serialized = payloadText(proof), source = read(id);
      if (!source) throw failure('durable_intake_unknown_id');
      if (source.handedOff) {
        if (payloadText(source.proof) !== serialized) throw failure('durable_intake_handoff_conflict');
        syncDirectory();
        return { id, duplicate: true };
      }
      const handedOffAt = now();
      if (typeof handedOffAt !== 'string' || !Number.isFinite(Date.parse(handedOffAt))) throw failure('durable_intake_invalid_clock');
      atomicWrite(handoffPath(id), { schema: 'village-durable-intake-handoff/v1', id,
        proof_sha256: sha256(serialized), handed_off_at: handedOffAt, proof: JSON.parse(serialized) });
      index.set(id, { accepted_at: source.acceptedAt, handedOff: true });
      return { id, duplicate: false };
    },
    read,
    pending({ limit = Number.MAX_SAFE_INTEGER } = {}) {
      if (!Number.isSafeInteger(limit) || limit < 1) throw failure('durable_intake_invalid_limit');
      return [...index.entries()]
        .filter(([, row]) => !row.handedOff)
        .sort(([a, x], [b, y]) => x.accepted_at.localeCompare(y.accepted_at) || a.localeCompare(b))
        .slice(0, limit).map(([id]) => {
          const row = read(id);
          if (!row) throw failure('durable_intake_missing_record');
          return row;
        }).filter(row => !row.handedOff);
    },
    status() {
      const pending = [...index.values()].filter(row => !row.handedOff).length;
      return { records: index.size, pending, handedOff: index.size - pending };
    }
  };
}
