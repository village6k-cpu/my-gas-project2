'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '..', 'supabaseSync.js'), 'utf8');

function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} must exist`);
  if (name === 'supaApplyReturnedTradeHistoricalCorrection_') {
    const end = source.indexOf('\n/**\n * 반출완료 서버 권한 저장.', start);
    assert.ok(end > start, `${name} end marker must exist`);
    return source.slice(start, end);
  }
  const brace = source.indexOf('{', start);
  let depth = 0;
  let quote = '';
  let escaped = false;
  for (let i = brace; i < source.length; i += 1) {
    const char = source[i];
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`${name} closing brace not found`);
}

function harness({ baseline, existingAddedRows = [] } = {}) {
  const requests = [];
  const removals = [];
  const context = {
    Date, JSON, Object, Array, String, Number, Math, encodeURIComponent,
    SUPA_CFG_: () => ({ url: 'https://example.supabase.co', apikey: 'redacted' }),
    supaToken_: () => 'redacted-token',
    supaGetCheckoutBaselineState_: () => baseline || {
      ok: true,
      tradeFound: true,
      returnDone: true,
      contractStatus: '반납완료',
      started: true,
      items: [{ schedule_id: '260813-005-99', taken_qty: 1 }],
    },
    supaMarkScheduleItemsRemoved_: (tid, ids) => {
      removals.push({ tid, ids: Array.from(ids) });
      return { ok: true, scheduleIds: Array.from(ids) };
    },
    UrlFetchApp: {
      fetch(url, options) {
        requests.push({ url, options });
        if (String(options.method || 'get').toLowerCase() === 'get') {
          return { getResponseCode: () => 200, getContentText: () => JSON.stringify(existingAddedRows) };
        }
        const payload = JSON.parse(options.payload);
        return { getResponseCode: () => 201, getContentText: () => JSON.stringify(payload) };
      },
    },
  };
  vm.runInNewContext(`${extractFunction('supaApplyReturnedTradeHistoricalCorrection_')}\nthis.applyHistorical = supaApplyReturnedTradeHistoricalCorrection_;`, context);
  return { context, requests, removals };
}

const tradeId = '260813-005';
const removedId = `${tradeId}-01`;
const addedItem = {
  scheduleId: `${tradeId}-12`, setName: '', name: 'BURANO 8K', qty: 1, isComponent: false,
};

test('returned historical projection inserts only an excluded untaken audit row and removes only the exact old id', () => {
  const { context, requests, removals } = harness();
  const result = context.applyHistorical(tradeId, [removedId], [addedItem]);

  assert.equal(result.ok, true);
  assert.deepEqual(removals, [{ tid: tradeId, ids: [removedId] }]);
  assert.equal(requests.length, 2, 'one absence read and one exact insert are required');
  const inserted = JSON.parse(requests[1].options.payload)[0];
  assert.deepEqual(Object.keys(inserted).sort(), [
    'checkout_state', 'is_component', 'is_set_header', 'name', 'onsite', 'qty',
    'removed_at', 'schedule_id', 'set_name', 'sort', 'trade_id',
  ]);
  assert.equal(inserted.schedule_id, addedItem.scheduleId);
  assert.equal(inserted.checkout_state, 'excluded');
  assert.equal(inserted.removed_at, null);
  assert.equal(Object.hasOwn(inserted, 'taken_qty'), false, 'historical document correction must not invent a physical checkout baseline');
});

test('returned historical projection also supports an exact add-only documentation correction', () => {
  const { context, requests, removals } = harness();
  const result = context.applyHistorical(tradeId, [], [addedItem]);

  assert.equal(result.ok, true);
  assert.equal(requests.length, 2);
  assert.deepEqual(removals, []);
  assert.deepEqual(Array.from(result.addedScheduleIds), [addedItem.scheduleId]);
  assert.deepEqual(Array.from(result.removedScheduleIds), []);
});

test('returned historical projection rejects a protected removed id before every Supabase write', () => {
  const { context, requests, removals } = harness({
    baseline: {
      ok: true,
      tradeFound: true,
      returnDone: true,
      contractStatus: '반납완료',
      started: true,
      items: [{ schedule_id: removedId, taken_qty: 1 }],
    },
  });
  const result = context.applyHistorical(tradeId, [removedId], [addedItem]);

  assert.equal(result.ok, false);
  assert.match(result.error, /불변 반출 기준선|taken_qty/);
  assert.deepEqual(requests, []);
  assert.deepEqual(removals, []);
});

test('returned historical projection rejects authority failure and added-id collisions without writes', () => {
  const unavailable = harness({ baseline: { ok: false, error: 'authority unavailable', items: [] } });
  assert.equal(unavailable.context.applyHistorical(tradeId, [removedId], [addedItem]).ok, false);
  assert.deepEqual(unavailable.requests, []);
  assert.deepEqual(unavailable.removals, []);

  const collision = harness({ existingAddedRows: [{ schedule_id: addedItem.scheduleId, taken_qty: null }] });
  const collisionResult = collision.context.applyHistorical(tradeId, [removedId], [addedItem]);
  assert.equal(collisionResult.ok, false);
  assert.match(collisionResult.error, /이미 존재|충돌/);
  assert.equal(collision.requests.length, 1);
  assert.deepEqual(collision.removals, []);
});
