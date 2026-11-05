import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDurableIntake } from './durable-intake.mjs';

const example = () => ({ kind: 'job', job: { jobId: 'original-job-17', eventHash: 'original-event-9',
  roomKey: 'chat:1234567890', roomRevision: 3, detectedAt: '2026-11-05T01:00:00.000Z',
  events: [{ raw: { customerName: '합성 고객', text: '같은 일정에 인터컴 추가' } }] } });
function fixture(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'village-durable-intake-'));
  return { directory, open: extra => createDurableIntake({ directory, reserveBytes: 0, ...options, ...extra }),
    close: () => fs.rmSync(directory, { recursive: true, force: true }) };
}
function storageError(code) { return Object.assign(new Error(code), { code }); }
function frozen(value) {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); }
  return value;
}

test('accept fsyncs the complete original payload then atomically commits and fsyncs the directory before ACK', () => {
  const f = fixture(), calls = [];
  try {
    const io = {
      openSync(file, ...args) { const fd = fs.openSync(file, ...args); calls.push(['open', file, fd]); return fd; },
      fsyncSync(fd) { calls.push(['sync', fd]); fs.fsyncSync(fd); },
      renameSync(from, to) { calls.push(['rename', to]); fs.renameSync(from, to); }
    };
    const intake = f.open({ storage: io }), payload = frozen(example());
    const ack = intake.accept(payload);
    assert.match(ack.id, /^[0-9a-f]{64}$/);
    assert.equal(ack.duplicate, false);
    const rename = calls.findIndex(c => c[0] === 'rename');
    assert.ok(calls.slice(0, rename).some(c => c[0] === 'sync'));
    assert.equal(calls.at(-1)[0], 'sync');
    assert.deepEqual(intake.pending()[0].event, payload);
    assert.equal(intake.read(ack.id).event.job.jobId, 'original-job-17');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.directory, ack.id + '.event.json'))).event, payload);
  } finally { f.close(); }
});

test('canonical key order deduplicates without mutating input, resetting acceptance time or changing original job IDs', () => {
  const f = fixture();
  try {
    let time = '2026-11-05T01:00:00.000Z';
    const intake = f.open({ now: () => time }), original = frozen(example());
    const first = intake.accept(original), before = fs.readFileSync(path.join(f.directory, first.id + '.event.json'), 'utf8');
    time = '2026-11-06T01:00:00.000Z';
    const reordered = { job: { ...original.job }, kind: 'job' };
    const second = intake.accept(reordered);
    assert.equal(second.id, first.id); assert.equal(second.duplicate, true);
    assert.equal(fs.readFileSync(path.join(f.directory, first.id + '.event.json'), 'utf8'), before);
    assert.equal(intake.read(first.id).acceptedAt, '2026-11-05T01:00:00.000Z');
    const changed = intake.accept({ ...original, job: { ...original.job, roomRevision: 4 } });
    assert.notEqual(changed.id, first.id);
  } finally { f.close(); }
});

test('restart recovers accepted but unhanded-off work with exact payload and ID', () => {
  const f = fixture();
  try {
    const first = f.open().accept(example());
    const reopened = f.open();
    assert.equal(reopened.pending()[0].id, first.id);
    assert.deepEqual(reopened.pending()[0].event, example());
    assert.equal(reopened.accept(example()).duplicate, true);
  } finally { f.close(); }
});

test('handoff requires durable authority and persists a separate receipt without deleting source evidence', () => {
  const f = fixture();
  try {
    const intake = f.open(), ack = intake.accept(example());
    for (const proof of [null, {}, { durable: false }, { durable: 'true' }]) {
      assert.throws(() => intake.mark(ack.id, proof), { code: 'durable_intake_durable_handoff_required' });
      assert.equal(intake.pending().length, 1);
    }
    const proof = { durable: true, job_id: 'original-job-17', receipt: 'gateway-enqueue' };
    intake.mark(ack.id, frozen(proof));
    assert.equal(intake.pending().length, 0);
    assert.deepEqual(f.open().read(ack.id).proof, proof);
    assert.ok(fs.existsSync(path.join(f.directory, ack.id + '.event.json')));
    assert.deepEqual(intake.status(), { records: 1, pending: 0, handedOff: 1 });
  } finally { f.close(); }
});

test('repeated accepts and matching handoff receipts cannot resurrect handed-off work or replace its authority', () => {
  const f = fixture();
  try {
    const intake = f.open(), ack = intake.accept(example()), proof = { durable: true, target: 'job-A' };
    assert.equal(intake.mark(ack.id, proof).duplicate, false);
    assert.equal(intake.mark(ack.id, { target: 'job-A', durable: true }).duplicate, true);
    assert.throws(() => intake.mark(ack.id, { durable: true, target: 'job-B' }), { code: 'durable_intake_handoff_conflict' });
    assert.equal(intake.accept(example()).handedOff, true);
    assert.equal(f.open().pending().length, 0);
    assert.deepEqual(intake.read(ack.id).proof, proof);
  } finally { f.close(); }
});

test('a crash before event rename does not ACK and a retry commits the same event only once', () => {
  const f = fixture();
  try {
    const broken = f.open({ storage: { renameSync() { throw storageError('EIO'); } } });
    assert.throws(() => broken.accept(example()), { code: 'EIO' });
    assert.ok(fs.readdirSync(f.directory).some(file => file.endsWith('.tmp')));
    const reopened = f.open();
    assert.equal(reopened.pending().length, 0);
    const result = reopened.accept(example());
    assert.equal(reopened.pending().length, 1);
    assert.equal(reopened.accept(example()).id, result.id);
  } finally { f.close(); }
});

test('a crash after event rename but before directory fsync leaves recoverable input and retry re-syncs before ACK', () => {
  const f = fixture();
  try {
    const broken = f.open({ storage: { fsyncSync(fd) {
      if (fs.fstatSync(fd).isDirectory()) throw storageError('EIO');
      fs.fsyncSync(fd);
    } } });
    assert.throws(() => broken.accept(example()), { code: 'EIO' });
    const reopened = f.open(), record = reopened.pending()[0];
    assert.deepEqual(record.event, example());
    assert.equal(reopened.accept(example()).id, record.id);
    assert.equal(reopened.accept(example()).duplicate, true);
  } finally { f.close(); }
});

test('partial writes and ENOSPC cannot produce an acknowledged or replayable truncated event', () => {
  const f = fixture();
  try {
    let wrote = false;
    const broken = f.open({ storage: { writeSync(fd, bytes, offset, length) {
      if (wrote) throw storageError('ENOSPC');
      wrote = true; return fs.writeSync(fd, bytes, offset, Math.min(length, 7));
    } } });
    assert.throws(() => broken.accept(example()), { code: 'ENOSPC' });
    assert.equal(f.open().pending().length, 0);
    const reopened = f.open(), ack = reopened.accept(example());
    assert.deepEqual(reopened.read(ack.id).event, example());
  } finally { f.close(); }
});

test('failed file fsync never commits or ACKs an event', () => {
  const f = fixture();
  try {
    assert.throws(() => f.open({ storage: { fsyncSync() { throw storageError('EIO'); } } }).accept(example()), { code: 'EIO' });
    assert.equal(f.open().pending().length, 0);
  } finally { f.close(); }
});

test('failed handoff rename retains the source as pending across restart', () => {
  const f = fixture();
  try {
    const ack = f.open().accept(example());
    const broken = f.open({ storage: { renameSync() { throw storageError('EIO'); } } });
    assert.throws(() => broken.mark(ack.id, { durable: true, job_id: 'same-job' }), { code: 'EIO' });
    assert.deepEqual(f.open().pending()[0].event, example());
    assert.equal(f.open().pending()[0].id, ack.id);
  } finally { f.close(); }
});

test('uncertain handoff directory fsync preserves the complete receipt and source, never repeats a different job', () => {
  const f = fixture();
  try {
    const ack = f.open().accept(example());
    const broken = f.open({ storage: { fsyncSync(fd) {
      if (fs.fstatSync(fd).isDirectory()) throw storageError('EIO');
      fs.fsyncSync(fd);
    } } });
    const proof = { durable: true, job_id: 'original-job-17' };
    assert.throws(() => broken.mark(ack.id, proof), { code: 'EIO' });
    const reopened = f.open();
    assert.deepEqual(reopened.read(ack.id).proof, proof);
    assert.equal(reopened.mark(ack.id, proof).duplicate, true);
    assert.ok(fs.existsSync(path.join(f.directory, ack.id + '.event.json')));
  } finally { f.close(); }
});

test('corrupt or tampered committed source is never silently skipped at startup or during read', () => {
  for (const corrupt of ['{broken', JSON.stringify({ schema: 'village-durable-intake/v1', event: {} })]) {
    const f = fixture();
    try {
      const intake = f.open(), ack = intake.accept(example());
      fs.writeFileSync(path.join(f.directory, ack.id + '.event.json'), corrupt);
      assert.throws(() => intake.read(ack.id), { code: 'durable_intake_corrupt_record' });
      assert.throws(() => f.open(), { code: 'durable_intake_corrupt_record' });
    } finally { f.close(); }
  }
});

test('tampered handoff and orphan receipt fail closed instead of hiding unprocessed work', () => {
  const f = fixture();
  try {
    const intake = f.open(), ack = intake.accept(example());
    intake.mark(ack.id, { durable: true, job_id: 'original-job-17' });
    const file = path.join(f.directory, ack.id + '.handoff.json'), row = JSON.parse(fs.readFileSync(file));
    row.proof.job_id = 'different-job'; fs.writeFileSync(file, JSON.stringify(row));
    assert.throws(() => f.open(), { code: 'durable_intake_corrupt_handoff' });
    fs.unlinkSync(path.join(f.directory, ack.id + '.event.json'));
    assert.throws(() => f.open(), { code: 'durable_intake_orphan_handoff' });
  } finally { f.close(); }
});

test('low disk reserves block new input and handoff without removing pending work, then recover when space returns', () => {
  const f = fixture();
  try {
    let free = 1;
    const intake = f.open({ reserveBytes: 1024, storage: { statfsSync: () => ({ bavail: free, bsize: 1 }) } });
    assert.throws(() => intake.accept(example()), { code: 'durable_intake_disk_reserve' });
    assert.deepEqual(fs.readdirSync(f.directory), []);
    free = 1024 * 1024;
    const ack = intake.accept(example()); free = 1;
    assert.throws(() => intake.mark(ack.id, { durable: true }), { code: 'durable_intake_disk_reserve' });
    assert.equal(intake.pending().length, 1);
    free = 1024 * 1024; intake.mark(ack.id, { durable: true });
    assert.equal(intake.pending().length, 0);
  } finally { f.close(); }
});

test('invalid, non-JSON and oversized payloads, invalid IDs and unknown handoffs cannot alter the journal', () => {
  const f = fixture();
  try {
    const intake = f.open({ maxRecordBytes: 1024 }), circular = {}; circular.self = circular;
    for (const payload of [null, [], 1, { value: undefined }, { value: NaN }, { value: new Date() }, circular]) {
      assert.throws(() => intake.accept(payload));
    }
    assert.throws(() => intake.accept({ text: 'a'.repeat(2048) }), { code: 'durable_intake_record_too_large' });
    for (const id of ['../escape', 'not-a-sha256', '']) assert.throws(() => intake.read(id), { code: 'durable_intake_invalid_id' });
    assert.equal(intake.read('a'.repeat(64)), null);
    assert.throws(() => intake.mark('a'.repeat(64), { durable: true }), { code: 'durable_intake_unknown_id' });
    assert.deepEqual(fs.readdirSync(f.directory), []);
  } finally { f.close(); }
});

test('bounded oldest-first replay returns independent copies and includes job envelopes unchanged', () => {
  const f = fixture();
  try {
    let time = '2026-11-05T01:00:00Z';
    const intake = f.open({ now: () => time }), one = intake.accept(example());
    time = '2026-11-05T02:00:00Z';
    const two = intake.accept({ kind: 'event', event: { eventHash: 'original-hash', text: '두 번째' } });
    assert.equal(intake.pending({ limit: 1 })[0].id, one.id);
    const returned = intake.pending(); returned[0].event.job.jobId = 'caller-mutated';
    assert.equal(intake.read(one.id).event.job.jobId, 'original-job-17');
    intake.mark(one.id, { durable: true });
    assert.equal(intake.pending({ limit: 1 })[0].id, two.id);
    assert.throws(() => intake.pending({ limit: 0 }), { code: 'durable_intake_invalid_limit' });
    assert.deepEqual(intake.status(), { records: 2, pending: 1, handedOff: 1 });
  } finally { f.close(); }
});

test('a renamed but unacknowledged event remains visible to replay without requiring a process restart', () => {
  const f = fixture();
  try {
    let fail = true;
    const intake = f.open({ storage: { fsyncSync(fd) {
      if (fail && fs.fstatSync(fd).isDirectory()) throw storageError('EIO');
      fs.fsyncSync(fd);
    } } });
    assert.throws(() => intake.accept(example()), { code: 'EIO' });
    assert.deepEqual(intake.pending()[0].event, example());
    fail = false;
    assert.equal(intake.accept(example()).duplicate, true);
  } finally { f.close(); }
});

test('creation of a new journal directory persists its entry before any successful acceptance', () => {
  const f = fixture();
  try {
    const nested = path.join(f.directory, 'new', 'journal'), synced = [];
    const intake = createDurableIntake({ directory: nested, reserveBytes: 0, storage: {
      openSync(file, ...args) { const fd = fs.openSync(file, ...args); synced.push(['open', file, fd]); return fd; },
      fsyncSync(fd) { synced.push(['sync', fd]); fs.fsyncSync(fd); }
    } });
    const createdParentFds = synced.filter(x => x[0] === 'open').map(x => x[2]);
    assert.equal(createdParentFds.length, 2);
    for (const fd of createdParentFds) assert.ok(synced.some(x => x[0] === 'sync' && x[1] === fd));
    assert.equal(intake.accept(example()).duplicate, false);
  } finally { f.close(); }
});

test('unexpected loss of a pending committed file fails visibly instead of treating work as completed', () => {
  const f = fixture();
  try {
    const intake = f.open(), ack = intake.accept(example());
    fs.unlinkSync(path.join(f.directory, ack.id + '.event.json'));
    assert.throws(() => intake.pending(), { code: 'durable_intake_missing_record' });
  } finally { f.close(); }
});
