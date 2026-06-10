const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const syncSource = read('apps/today-dashboard/lib/data/sync.ts');
const storeSource = read('apps/today-dashboard/lib/data/store.ts');
const todayViewSource = read('apps/today-dashboard/components/TodayView.tsx');

assert(
  syncSource.includes('export async function repairDashboardSearchResults'),
  'sync layer must expose a search-time dashboard repair for stale partial equipment caches'
);
assert(
  /action=dashboardSearch&q=\$\{encodeURIComponent\(query\)\}/.test(syncSource),
  'search repair must use GAS dashboardSearch so old-date search results can be repaired from the sheet master'
);
assert(
  /incomingEquipmentCount\(it\) > currentEquipmentCount\(base\)/.test(syncSource) &&
    /changed\.set\(tid, mergeDashboard\(base, it\)\)/.test(syncSource),
  'search repair must replace stale Supabase equipment lists when GAS has more equipment rows'
);
assert(
  syncSource.includes('export async function repairDashboardDateDetails') &&
    /action=dashboard&date=\$\{date\}/.test(syncSource),
  'sync layer must also repair stale partial equipment caches when a date is opened directly'
);
assert(
  storeSource.includes('repairDashboardSearchResults') &&
    /export async function repairSearchResults\(query: string\)/.test(storeSource),
  'store must expose a search repair action wired to the sync layer'
);
assert(
  storeSource.includes('repairDashboardDateDetails') &&
    /async function repairDayDetails\(date: string/.test(storeSource) &&
    /repairDayDetails\(date\)/.test(storeSource),
  'store loadDay path must trigger date-level dashboard repair for stale partial equipment caches'
);
assert(
  /const changed = await repairDashboardSearchResults\(state\.trades, q\)/.test(storeSource) &&
    /for \(const t of changed\) persistTrade\(t\)\.catch\(\(\) => \{\}\)/.test(storeSource),
  'search repair must update the local state and persist the richer dashboard detail back to Supabase'
);
assert(
  todayViewSource.includes('repairSearchResults') &&
    /setTimeout\(\(\) => repairSearchResults\(q\), 350\)/.test(todayViewSource),
  'Today search UI must trigger the repair while the user searches'
);

console.log('today-dashboard stale equipment repair static checks passed');
