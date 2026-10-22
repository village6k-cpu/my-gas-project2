'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../supabaseSync.js'), 'utf8');
const tid = '261023-001', sid = tid + '-01', sid2 = tid + '-02';
const row = (id = sid, state = 'taken') => ({ trade_id: tid, schedule_id: id, checkout_state: state });
const response = (rows, status = 200) => ({ getResponseCode: () => status, getContentText: () => JSON.stringify(rows) });
function harness(options = {}) {
  const calls = [];
  const c = { UrlFetchApp: {
    fetch(url, request) {
      calls.push({ url, method: request.method });
      if (request.method === 'patch') { if (options.patchThrow) throw Error('write response lost');return options.patch || response([row()]); }
      assert.equal(request.method, 'get');if (options.readThrow) throw Error('read unavailable');
      return typeof options.read === 'function' ? options.read(url) : options.read || response([row()]);
    },
    fetchAll(requests) {
      requests.forEach(request => calls.push({ url: request.url, method: request.method }));
      if (options.patchThrow) throw Error('batch response lost');
      return options.batch || requests.map(request => response([row(new URL(request.url).searchParams.get('schedule_id').slice(3))]));
    }
  } };
  vm.runInNewContext(source, c);
  c.SUPA_CFG_ = () => { if (options.configThrow) throw Error('config unavailable');return { url: 'https://example.invalid', apikey: 'test' }; };
  c.supaToken_ = () => 'test-token';
  return { c, calls };
}

for (const variant of ['trigger-preserved', 'missing-state', 'wrong-id', 'wrong-trade', 'duplicate', 'not-array']) {
  test('single PATCH never acknowledges an unverified target: ' + variant, () => {
    const rows = variant === 'trigger-preserved' ? [row(sid, 'pending')]
      : variant === 'missing-state' ? [{ trade_id: tid, schedule_id: sid }]
      : variant === 'wrong-id' ? [row(sid2)] : variant === 'wrong-trade' ? [{ ...row(), trade_id: 'other' }]
      : variant === 'duplicate' ? [row(), row()] : { 0: row(), length: 1 };
    const h = harness({ patch: response(rows), read: response([row(sid, 'pending')]) });
    const result = h.c.supaSetScheduleItemCheckoutState_(tid, sid, true);
    assert.equal(result.ok, false);assert.equal(result.outcomeUnknown, false);
    assert.equal(h.calls.filter(call => call.method === 'patch').length, 1);
    assert.match(h.calls[0].url, /select=.*checkout_state/);
  });
}

test('single malformed RETURNING may acknowledge only after exact canonical target readback', () => {
  const h = harness({ patch: response([{ schedule_id: sid }]), read: response([row()]) });
  const result = h.c.supaSetScheduleItemCheckoutState_(tid, sid, true);
  assert.equal(result.ok, true);assert.equal(result.confirmedAfterError, true);assert.equal(h.calls.length, 2);
});

for (const kind of ['wrong-id', 'wrong-trade', 'duplicate', 'missing-state', 'read-failed']) test('uncertain single write requires the exact canonical row: ' + kind, () => {
  const read = kind === 'wrong-id' ? response([row(sid2)]) : kind === 'wrong-trade' ? response([{ ...row(), trade_id: 'other' }])
    : kind === 'duplicate' ? response([row(), row()]) : kind === 'missing-state' ? response([{ trade_id: tid, schedule_id: sid }]) : response([row()], 503);
  const h = harness({ patchThrow: true, read });const result = h.c.supaSetScheduleItemCheckoutState_(tid, sid, true);
  assert.equal(result.ok, false);assert.equal(result.outcomeUnknown, true);assert.equal(h.calls.filter(call => call.method === 'patch').length, 1);
});

test('batch preserves a verified partial success while rejecting a trigger-preserved state', () => {
  const h = harness({ batch: [response([row()]), response([row(sid2, 'pending')])], read: response([row(sid2, 'pending')]) });
  const result = h.c.supaSetScheduleItemCheckoutStatesBatch_(tid, [{ scheduleId: sid, done: true }, { scheduleId: sid2, done: true }]);
  assert.equal(result.ok, false);assert.equal(result.results[0].ok, true);assert.equal(result.results[1].ok, false);assert.equal(result.results[1].outcomeUnknown, false);
  assert.equal(result.results[1].checked, undefined);assert.equal(h.calls.filter(call => call.method === 'patch').length, 2);
});

for (const kind of ['wrong-id', 'wrong-trade', 'duplicate', 'missing-state', 'not-array']) test('batch requires exact RETURNING and canonical identity: ' + kind, () => {
  const readRows = kind === 'wrong-id' ? [row(sid2)] : kind === 'wrong-trade' ? [{ ...row(), trade_id: 'other' }]
    : kind === 'duplicate' ? [row(), row()] : kind === 'missing-state' ? [{ trade_id: tid, schedule_id: sid }] : { 0: row(), length: 1 };
  const h = harness({ batch: [response(readRows)], read: response(readRows) });
  const result = h.c.supaSetScheduleItemCheckoutStatesBatch_(tid, [{ scheduleId: sid, done: true }]);
  assert.equal(result.ok, false);assert.equal(result.results[0].ok, false);assert.equal(result.results[0].outcomeUnknown, true);
});

test('batch accepts canonical readback after zero affected rows without a second PATCH', () => {
  const h = harness({ batch: [response([])], read: response([row(sid, 'pending')]) });
  const result = h.c.supaSetScheduleItemCheckoutStatesBatch_(tid, [{ scheduleId: sid, done: false }]);
  assert.equal(result.ok, true);assert.equal(result.results[0].checked, false);assert.equal(result.results[0].confirmedAfterError, true);
  assert.equal(h.calls.filter(call => call.method === 'patch').length, 1);
});

test('failed canonical HTTP status stays unknown even when its body resembles valid rows', () => {
  const h = harness({ batch: [response([])], read: response([row()], 503) });
  const result = h.c.supaSetScheduleItemCheckoutStatesBatch_(tid, [{ scheduleId: sid, done: true }]);
  assert.equal(result.ok, false);assert.equal(result.results[0].outcomeUnknown, true);
});

test('a failed batch read does not erase another item already proven by RETURNING', () => {
  const h = harness({ batch: [response([row()]), response([])], readThrow: true });
  const result = h.c.supaSetScheduleItemCheckoutStatesBatch_(tid, [{ scheduleId: sid, done: true }, { scheduleId: sid2, done: true }]);
  assert.equal(result.ok, false);assert.equal(result.results[0].ok, true);assert.equal(result.results[1].outcomeUnknown, true);
});

test('zero targets, duplicate targets and config failure can never produce a vacuous success', () => {
  for (const items of [[], [{ scheduleId: '', done: true }], [{ scheduleId: sid, done: true }, { scheduleId: sid, done: false }]]) {
    const h = harness();assert.equal(h.c.supaSetScheduleItemCheckoutStatesBatch_(tid, items).ok, false);assert.equal(h.calls.length, 0);
  }
  const h = harness({ configThrow: true });assert.equal(h.c.supaSetScheduleItemCheckoutStatesBatch_(tid, [{ scheduleId: sid, done: true }]).ok, false);assert.equal(h.calls.length, 0);
});

test('exact RETURNING confirms either single target without an unnecessary canonical read', () => {
  for (const done of [true, false]) {
    const h = harness({ patch: response([row(sid, done ? 'taken' : 'pending')]) });
    assert.equal(h.c.supaSetScheduleItemCheckoutState_(tid, sid, done).ok, true);
    assert.deepEqual(h.calls.map(call => call.method), ['patch']);
  }
});

test('a mixed check and uncheck batch retains each verified goal without an extra read', () => {
  const h = harness({ batch: [response([row()]), response([row(sid2, 'pending')])] });
  const result = h.c.supaSetScheduleItemCheckoutStatesBatch_(tid, [{ scheduleId: sid, done: true }, { scheduleId: sid2, done: false }]);
  assert.equal(result.ok, true);assert.equal(result.results[0].checked, true);assert.equal(result.results[1].checked, false);
  assert.deepEqual(h.calls.map(call => call.method), ['patch', 'patch']);
});

test('excluded is a known mismatch, never equivalent to an unchecked pending target', () => {
  const single = harness({ patch: response([row(sid, 'excluded')]), read: response([row(sid, 'excluded')]) });
  const result = single.c.supaSetScheduleItemCheckoutState_(tid, sid, false);
  assert.equal(result.ok, false);assert.equal(result.outcomeUnknown, false);
  const batch = harness({ batch: [response([row(sid, 'excluded')])], read: response([row(sid, 'excluded')]) });
  const batchResult = batch.c.supaSetScheduleItemCheckoutStatesBatch_(tid, [{ scheduleId: sid, done: false }]);
  assert.equal(batchResult.ok, false);assert.equal(batchResult.results[0].checked, undefined);assert.equal(batchResult.results[0].outcomeUnknown, false);
});

test('a lost fetchAll response reconciles each exact canonical target without replaying PATCH', () => {
  const h = harness({ patchThrow: true, read: url => response([row(new URL(url).searchParams.get('schedule_id').slice(3))]) });
  const result = h.c.supaSetScheduleItemCheckoutStatesBatch_(tid, [{ scheduleId: sid, done: true }, { scheduleId: sid2, done: true }]);
  assert.equal(result.ok, true);assert.ok(result.results.every(item => item.confirmedAfterError && item.checked === true));
  assert.deepEqual(h.calls.map(call => call.method), ['patch', 'patch', 'get', 'get']);
});
