'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const gas = fs.readFileSync(path.join(__dirname, '..', 'checkAvailability.js'), 'utf8');
const tid = '261022-001', sid = tid + '-01';
function section(start, end) { return gas.slice(gas.indexOf(start), gas.indexOf(end, gas.indexOf(start))); }

function harness({ mirrorQuota = false, authorityUnavailable = false, fullQuota = false, commitQuota = false } = {}) {
  const values = new Map(), ledger = new Map([[sid, 'pending']]);
  let held = false, writes = 0, reads = 0;
  const props = {
    getProperty: (key) => values.get(key) ?? null,
    getProperties: () => Object.fromEntries(values),
    setProperty(key, value) {
      if (fullQuota || mirrorQuota && key.startsWith('itemCheck_')) throw new Error('You have exceeded property storage quota');
      if (commitQuota && key.startsWith('dashboardMutationLog_v2_') && String(value).includes('committed'))
        throw new Error('You have exceeded property storage quota');
      values.set(key, String(value));
    },
    deleteProperty: (key) => values.delete(key),
  };
  const lock = { tryLock() { if (held) return false; held = true; return true; }, releaseLock() { held = false; } };
  const context = {
    DASHBOARD_MUTATION_LOG_PREFIX_: 'dashboardMutationLog_v2_',
    DASHBOARD_MUTATION_LOG_TTL_MS_: 1800000,
    PropertiesService: { getScriptProperties: () => props },
    LockService: { getScriptLock: () => lock },
    CacheService: { getScriptCache: () => ({ get: () => '1', put() {} }) },
    Logger: { log() {} },
    cleanupRetiredDashboardPhotoIndexProperties_() {},
    dashboardTradeMutationLeaseError_: () => null,
    activeDashboardMutationLease_: (_props, key) => JSON.parse(props.getProperty(key) || 'null'),
    clearDashboardMutationLease_: (_props, key, token) => {
      if (JSON.parse(props.getProperty(key) || 'null')?.token === token) props.deleteProperty(key);
    },
    supaSetScheduleItemCheckoutState_: (_tid, id, checked) => {
      assert.equal(_tid, tid); writes++; ledger.set(id, checked ? 'taken' : 'pending');
      return { ok: true, scheduleId: id };
    },
    supaSetScheduleItemCheckoutStatesBatch_: (_tid, items) => ({
      ok: true,
      results: items.map((item) => {
        context.supaSetScheduleItemCheckoutState_(_tid, item.scheduleId, item.done);
        return { scheduleId: item.scheduleId, checked: item.done, ok: true };
      }),
    }),
    supaGetScheduleItemCheckoutStateMap_: (ids) => {
      reads++;
      assert.equal(held, false, 'authoritative network read must run after releasing ScriptLock');
      assert.deepEqual(Array.from(ids), [tid]);
      return authorityUnavailable ? { ok: false, error: 'offline', byScheduleId: {} }
        : { ok: true, byScheduleId: Object.fromEntries(ledger) };
    },
    trySetScriptProperty_: () => { throw Error('checkout must not use broad quota reclamation'); },
    tryDeleteScriptProperty_: (_props, key) => props.deleteProperty(key),
  };
  vm.runInNewContext(
    section('function normalizeDashboardMutationId_', 'function dashboardCompletionRevisionKey_') +
    section('function isScriptPropertiesQuotaError_', 'function reclaimDashboardScriptProperties_') +
    section('function toggleItemChecksBatch', 'function getEquipmentCheckMap_'), context);
  return { context, values, ledger, writes: () => writes, reads: () => reads };
}

test('a confirmed single checkout survives mirror quota and duplicate retry reads the canonical checked state', () => {
  const h = harness({ mirrorQuota: true });
  const first = h.context.toggleItemCheck(sid, 'checkout', true, { mutationId: 'checkout-one' });
  assert.equal(first.checked, true);
  assert.equal(first.error, undefined);
  assert.equal(first.cachePending, true);
  assert.equal(h.ledger.get(sid), 'taken');
  assert.equal(h.values.has('itemCheck_' + sid + '_checkout'), false);
  const replay = h.context.toggleItemCheck(sid, 'checkout', true, { mutationId: 'checkout-one' });
  assert.equal(replay.checked, true);
  assert.equal(replay.deduped, true);
  assert.equal(h.writes(), 1);
});

test('batch replay reads canonical state after missing mirrors without issuing another PATCH', () => {
  const h = harness({ mirrorQuota: true });
  const items = [{ scheduleId: sid, done: true, mutationId: 'batch-one' }];
  assert.equal(h.context.toggleItemChecksBatch(tid, items).success, true);
  const replay = h.context.toggleItemChecksBatch(tid, items);
  assert.equal(replay.success, true);
  assert.equal(replay.results[0].checked, true);
  assert.equal(h.writes(), 1);
});

for (const batch of [false, true]) test(`${batch ? 'batch' : 'single'} replay cannot report stale cache as canonical when readback is unavailable`, () => {
  const h = harness({ authorityUnavailable: true });
  const run = () => batch ? h.context.toggleItemChecksBatch(tid, [{ scheduleId: sid, done: true, mutationId: 'same' }])
    : h.context.toggleItemCheck(sid, 'checkout', true, { mutationId: 'same' });
  run();
  h.values.delete('itemCheck_' + sid + '_checkout');
  const replay = run();
  const result = batch ? replay.results[0] : replay;
  assert.equal(result.code, 'AUTHORITATIVE_READBACK_REQUIRED');
  assert.equal(result.outcomeUnknown, true);
  assert.equal(result.checked, undefined);
  assert.equal(h.writes(), 1);
});

test('a replay reports a newer canonical uncheck instead of a stale checked mirror', () => {
  const h = harness();
  h.context.toggleItemCheck(sid, 'checkout', true, { mutationId: 'old' });
  h.ledger.set(sid, 'pending');
  const replay = h.context.toggleItemCheck(sid, 'checkout', true, { mutationId: 'old' });
  assert.equal(replay.checked, false);
  assert.equal(h.writes(), 1);
});

test('a mixed batch rechecks only prior mutations and writes each new item once', () => {
  const h = harness({ mirrorQuota: true });
  h.context.toggleItemCheck(sid, 'checkout', true, { mutationId: 'prior' });
  h.ledger.set(sid, 'pending');
  const other = tid + '-02';
  h.ledger.set(other, 'pending');
  const result = h.context.toggleItemChecksBatch(tid, [
    { scheduleId: sid, done: true, mutationId: 'prior' },
    { scheduleId: other, done: true, mutationId: 'new' }
  ]);
  assert.equal(result.success, true);
  assert.equal(result.results[0].checked, false);
  assert.equal(result.results[0].deduped, true);
  assert.equal(result.results[1].checked, true);
  assert.equal(result.results[1].cachePending, true);
  assert.equal(h.writes(), 2);
  assert.equal(h.reads(), 1);
});

test('a disappeared canonical row is unknown, never inferred unchecked from an empty mirror', () => {
  const h = harness();
  h.context.toggleItemCheck(sid, 'checkout', true, { mutationId: 'prior' });
  h.ledger.delete(sid);
  const result = h.context.toggleItemCheck(sid, 'checkout', true, { mutationId: 'prior' });
  assert.equal(result.code, 'AUTHORITATIVE_READBACK_REQUIRED');
  assert.equal(result.checked, undefined);
  assert.equal(h.writes(), 1);
});

for (const batch of [false, true]) test(`${batch ? 'batch' : 'single'} still fails closed before a business write when durable preflight storage is full`, () => {
  const h = harness({ fullQuota: true });
  const run = () => batch ? h.context.toggleItemChecksBatch(tid, [{ scheduleId: sid, done: true, mutationId: 'full' }])
    : h.context.toggleItemCheck(sid, 'checkout', true, { mutationId: 'full' });
  assert.throws(run, /property storage quota/);
  assert.equal(h.writes(), 0);
  assert.equal(h.ledger.get(sid), 'pending');
});

for (const batch of [false, true]) {
  for (const canonical of ['same', 'changed', 'unavailable', 'missing']) {
    test(`${batch ? 'batch' : 'single'} pending completion marker retry is read-only when canonical state is ${canonical}`, () => {
      const h = harness({ commitQuota: true, authorityUnavailable: canonical === 'unavailable' });
      const run = () => batch ? h.context.toggleItemChecksBatch(tid, [{ scheduleId: sid, done: true, mutationId: 'pending' }])
        : h.context.toggleItemCheck(sid, 'checkout', true, { mutationId: 'pending' });
      const first = run();
      assert.equal(batch ? first.success : first.checked, true);
      const log = [...h.values].find(([key]) => key.startsWith('dashboardMutationLog_v2_'));
      assert.equal(JSON.parse(log[1])[0].state, 'pending');
      if (canonical === 'changed') h.ledger.set(sid, 'pending');
      if (canonical === 'missing') h.ledger.delete(sid);
      const replay = run(), result = batch ? replay.results[0] : replay;
      assert.equal(h.writes(), 1, 'a pending receipt never authorizes a second PATCH');
      assert.equal(JSON.parse(h.values.get(log[0]))[0].state, 'pending', 'do not invent a durable completion marker');
      if (canonical === 'same') {
        assert.equal(result.checked, true);
        assert.equal(result.reconciled, true);
        assert.equal(result.error, undefined);
      } else {
        assert.equal(result.checked, undefined);
        assert.equal(result.outcomeUnknown, true);
        assert.equal(result.code, canonical === 'changed' ? 'MUTATION_RECONCILIATION_REQUIRED' : 'AUTHORITATIVE_READBACK_REQUIRED');
        if (canonical === 'changed') {
          assert.equal(result.canonicalChecked, false);
          assert.equal(h.ledger.get(sid), 'pending', 'a later canonical state must not be reversed');
        }
      }
    });
  }
}

test('a mixed batch reconciles a pending receipt and applies only its new item', () => {
  const h = harness({ commitQuota: true }), other = tid + '-02';
  h.context.toggleItemCheck(sid, 'checkout', true, { mutationId: 'pending' });
  h.ledger.set(other, 'pending');
  const result = h.context.toggleItemChecksBatch(tid, [
    { scheduleId: sid, done: true, mutationId: 'pending' },
    { scheduleId: other, done: true, mutationId: 'fresh' }
  ]);
  assert.equal(result.success, true);
  assert.equal(result.results[0].reconciled, true);
  assert.equal(result.results[1].checked, true);
  assert.equal(h.writes(), 2);
});

test('pending uncheck requires canonical pending, not merely a false checked value for an excluded item', () => {
  const h = harness({ commitQuota: true });
  h.ledger.set(sid, 'taken');
  const run = () => h.context.toggleItemCheck(sid, 'checkout', false, { mutationId: 'uncheck' });
  run();
  const matched = run();
  assert.equal(matched.checked, false);
  assert.equal(matched.reconciled, true);
  h.ledger.set(sid, 'excluded');
  const excluded = run();
  assert.equal(excluded.code, 'MUTATION_RECONCILIATION_REQUIRED');
  assert.equal(excluded.checked, undefined);
  assert.equal(h.ledger.get(sid), 'excluded');
  assert.equal(h.writes(), 1);
});
