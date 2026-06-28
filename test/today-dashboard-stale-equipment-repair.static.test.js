const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const syncSource = read('apps/today-dashboard/lib/data/sync.ts');
const storeSource = read('apps/today-dashboard/lib/data/store.ts');
const remoteSource = read('apps/today-dashboard/lib/data/remote.ts');
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
    /const merged = mergeDashboard\(base, it\)/.test(syncSource) &&
    /changed\.set\([\s\S]*tid,[\s\S]*merged/.test(syncSource),
  'search repair must replace stale Supabase equipment lists when GAS has more equipment rows'
);
assert(
  /function hasSheetBackedItemsMissingFromDashboard\(base: Trade, it: any\): boolean[\s\S]*!e\.onsite[\s\S]*!e\.offCatalog[\s\S]*!e\.synthetic[\s\S]*!incomingIds\.has\(e\.scheduleId\)/.test(syncSource),
  'sync repair must detect sheet-backed schedule items removed from GAS dashboard detail'
);
assert(
  /const sheetBackedDeleted = options\.authoritativeForMissingSheetBacked && hasSheetBackedItemsMissingFromDashboard\(base, it\)/.test(syncSource) &&
    /sheetBackedDeleted/.test(syncSource.match(/function shouldUseDashboardDetail[\s\S]*?\n}\n/)?.[0] ?? ''),
  'dashboard repair must refresh when authoritative GAS detail no longer returns a sheet-backed schedule item'
);
assert(
  /type DashboardDetailOptions = \{[\s\S]*authoritativeForMissingSheetBacked\?: boolean[\s\S]*\}/.test(syncSource),
  'sync repair must distinguish authoritative full-trade detail from partial date detail before pruning'
);
assert(
  /const PRUNE_MISSING_SHEET_BACKED = "__pruneMissingSheetBacked"/.test(syncSource) &&
    /function markPruneMissingSheetBacked\(trade: Trade\): DashboardRepairTrade[\s\S]*\[PRUNE_MISSING_SHEET_BACKED\]: true/.test(syncSource) &&
    /export function shouldPruneMissingSheetBacked\(trade: Trade\): boolean/.test(syncSource),
  'sync repair must mark authoritative deleted-equipment repairs so Supabase stale rows are pruned'
);
assert(
  syncSource.includes('export async function repairDashboardDateDetails') &&
    /action=dashboard&date=\$\{date\}&nocache=1/.test(syncSource),
  'date repair must bypass GAS dashboard cache so manual sheet deletes are read from the source sheet'
);
assert(
  /fetchDashboardSearchItemsForTradeIds\(missingSheetBackedTradeIds\(current, items\)\)/.test(syncSource) &&
    /repairFromDashboardItems\(current, authoritativeItems, \{ authoritativeForMissingSheetBacked: true \}\)/.test(syncSource),
  'date repair must confirm missing sheet-backed rows through full trade search detail before pruning Supabase'
);
assert(
  /export async function pollSheetChangesNow\(\): Promise<void>[\s\S]*state\.date && await repairDayDetails\(state\.date, mutationSeqAtPoll\)/.test(storeSource),
  'sheet polling must repair the open date details so manual sheet deletes disappear without a full reload'
);
assert(
  /export async function fetchGasTimelineTrades/.test(syncSource) &&
    /gasFallbackMode/.test(storeSource) &&
    /loadGasFallback/.test(storeSource) &&
    /withTimeout\(\s*Promise\.all\(\[fetchAllTrades\(\), fetchNotes\(\)\]\)/.test(storeSource),
  'dashboard must fall back to GAS source-of-truth when Supabase keyed reads hang'
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
    /for \(const t of changed\) persistTrade\(t, \{ pruneMissingSheetBacked: shouldPruneMissingSheetBacked\(t\) \}\)\.catch\(\(\) => \{\}\)/.test(storeSource),
  'search repair must update local state and prune stale Supabase schedule_items after authoritative GAS confirmation'
);
assert(
  /export async function persistTrade\(trade: Trade, options: PersistTradeOptions = \{\}\)/.test(remoteSource) &&
    /options\.pruneMissingSheetBacked[\s\S]*pruneMissingSheetBackedItems\(sb, trade\.tradeId, rows\)/.test(remoteSource),
  'persistTrade must support explicit stale sheet-backed schedule_items pruning'
);
assert(
  /async function pruneMissingSheetBackedItems\(sb: any, tradeId: string, rows: any\[\]\)[\s\S]*from\("schedule_items"\)[\s\S]*delete\(\)[\s\S]*eq\("trade_id", tradeId\)[\s\S]*eq\("onsite", false\)[\s\S]*eq\("off_catalog", false\)[\s\S]*not\("schedule_id", "in"/.test(remoteSource),
  'Supabase pruning must delete only stale sheet-backed rows while preserving onsite and off-catalog rows'
);
assert(
  todayViewSource.includes('repairSearchResults') &&
    /setTimeout\(\(\) => repairSearchResults\(q\), 350\)/.test(todayViewSource),
  'Today search UI must trigger the repair while the user searches'
);

console.log('today-dashboard stale equipment repair static checks passed');
