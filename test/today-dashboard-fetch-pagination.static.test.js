const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const remotePath = path.join(root, 'apps/today-dashboard/lib/data/remote.ts');
const remoteSource = fs.readFileSync(remotePath, 'utf8');

assert(
  remoteSource.includes('async function fetchRowsPaginated'),
  'remote data layer must use a shared paginated fetch helper for Supabase tables'
);
assert(
  remoteSource.includes('.range(from, from + PAGE_SIZE - 1)'),
  'paginated fetch helper must call range() so tables larger than PostgREST default limits are fully read'
);
assert(
  /fetchRowsPaginated<any>\(\s*sb,\s*"schedule_items"/.test(remoteSource),
  'fetchAllTrades must load schedule_items through the paginated helper'
);
assert(
  !remoteSource.includes('sb.from("schedule_items").select("*").order("sort", { ascending: true })'),
  'fetchAllTrades must not read schedule_items with a single capped select/order query'
);
assert(
  remoteSource.includes('{ column: "trade_id"') &&
    remoteSource.includes('{ column: "sort"') &&
    remoteSource.includes('{ column: "schedule_id"'),
  'schedule_items pagination must use deterministic ordering by trade_id, sort, and schedule_id'
);

console.log('today-dashboard fetch pagination static checks passed');
