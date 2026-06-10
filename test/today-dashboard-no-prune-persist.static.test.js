const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const remotePath = path.join(root, 'apps/today-dashboard/lib/data/remote.ts');
const storePath = path.join(root, 'apps/today-dashboard/lib/data/store.ts');

const remoteSource = fs.readFileSync(remotePath, 'utf8');
const storeSource = fs.readFileSync(storePath, 'utf8');

assert(
  remoteSource.includes('export async function deleteScheduleItem'),
  'schedule item deletion must be an explicit operation, not an implicit persistTrade prune'
);
assert(
  !remoteSource.includes('delete().eq("trade_id", trade.tradeId)'),
  'persistTrade must not delete schedule_items that are missing from a stale or partial client snapshot'
);
assert(
  !remoteSource.includes('del.not("schedule_id", "in"'),
  'persistTrade must not prune rows by keepIds; partial equipment snapshots are not authoritative'
);
assert(
  storeSource.includes('deleteScheduleItem'),
  'removeItem must call the explicit schedule item deletion helper'
);
assert(
  storeSource.includes('deleteScheduleItem(tradeId, scheduleId)'),
  'removeItem must delete only the selected schedule item instead of saving a pruned trade snapshot'
);

console.log('today-dashboard no-prune persist static checks passed');
