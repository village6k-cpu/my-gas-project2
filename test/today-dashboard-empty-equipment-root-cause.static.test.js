const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const syncPath = path.join(root, 'apps/today-dashboard/lib/data/sync.ts');
const storePath = path.join(root, 'apps/today-dashboard/lib/data/store.ts');
const remotePath = path.join(root, 'apps/today-dashboard/lib/data/remote.ts');
const mapperPath = path.join(root, 'apps/today-dashboard/lib/data/mappers.ts');

const syncSource = fs.readFileSync(syncPath, 'utf8');
const storeSource = fs.readFileSync(storePath, 'utf8');
const remoteSource = fs.readFileSync(remotePath, 'utf8');
const mapperSource = fs.readFileSync(mapperPath, 'utf8');

assert(
  syncSource.includes('export async function repairDashboardDetailsForEmptyEquipments'),
  'sync layer must expose a dashboard-detail repair path for trades cached with 0 equipment rows'
);
assert(
  syncSource.includes('action=dashboard&date=${date}'),
  'empty-equipment repair must use dashboard detail data, not timeline-only equipment snapshots'
);
assert(
  syncSource.includes('if (!emptyIds.size) return []'),
  'empty-equipment repair must skip GAS calls when there are no empty equipment trades'
);

assert(
  storeSource.includes('repairDashboardDetailsForEmptyEquipments'),
  'store load/poll path must call dashboard-detail repair so users do not wait on a manual seed sync'
);
assert(
  storeSource.includes('await repairEmptyEquipmentTrades'),
  'store must run an immediate empty-equipment repair after remote load and during polling'
);

assert(
  remoteSource.includes('if (!keepIds.length) return'),
  'persistTrade must not delete all schedule_items when a stale client state has an empty equipment list'
);
assert(
  !/let del = sb\\.from\\(\"schedule_items\"\\)\\.delete\\(\\)\\.eq\\(\"trade_id\", trade\\.tradeId\\);\\s*if \\(keepIds\\.length\\)[\\s\\S]*await del;/.test(remoteSource),
  'persistTrade must guard the prune/delete path instead of awaiting an unconditional delete builder'
);
assert(
  remoteSource.includes('uniqueScheduleRows'),
  'persistTrade must de-duplicate schedule item row ids before Supabase upsert'
);
assert(
  remoteSource.includes('seenScheduleIds'),
  'persistTrade must track duplicate schedule ids so one duplicated dashboard payload cannot fail the entire trade upsert'
);
assert(
  mapperSource.includes('dbScheduleId'),
  'itemToRow must scope non-trade-prefixed schedule ids before using them as the global schedule_items primary key'
);

console.log('today-dashboard empty equipment root-cause static checks passed');
