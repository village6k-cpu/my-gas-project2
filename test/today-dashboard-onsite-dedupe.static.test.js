const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const mapper = read('apps/today-dashboard/lib/data/mappers.ts');
const remote = read('apps/today-dashboard/lib/data/remote.ts');
const store = read('apps/today-dashboard/lib/data/store.ts');

assert(
  /export function canonicalOnsiteScheduleId/.test(mapper),
  'mappers must expose canonicalOnsiteScheduleId for ONS-* ids'
);

assert(
  /r\.onsite[\s\S]{0,120}canonicalOnsiteScheduleId/.test(mapper),
  'itemFromRow must canonicalize onsite schedule ids when loading Supabase rows'
);

assert(
  /e\.onsite[\s\S]{0,160}canonicalOnsiteScheduleId/.test(mapper) &&
    /dbScheduleId/.test(mapper),
  'itemToRow must canonicalize onsite ids before creating the global Supabase primary key'
);

assert(
  /export function dedupeOnsiteItems/.test(mapper),
  'mappers must expose a dedupe pass for legacy ONS rows that only differ by trade prefix or __n suffix'
);

assert(
  /dedupeOnsiteItems\(normalizeItems/.test(remote),
  'fetchAllTrades must dedupe onsite items before putting them into app state'
);

assert(
  /row\.onsite[\s\S]{0,260}return null/.test(remote) &&
    /filter\(\(row\): row is any => !!row\)/.test(remote),
  'persistTrade must skip duplicate onsite rows instead of writing __2 duplicate rows back to Supabase'
);

assert(
  /deleteScheduleItemVariants/.test(remote) &&
    /schedule_id[\s\S]{0,80}like/.test(remote),
  'deleteScheduleItem must remove legacy onsite variants such as ONS-1, trade-ONS-1, and trade-ONS-1__2'
);

assert(
  /function nextOnsiteScheduleId/.test(store) &&
    /equipments\.reduce\(\(max, e\)/.test(store) &&
    /return `ONS-\$\{next\}`/.test(store),
  'store must generate onsite ids from existing trade equipment, not from a page-global counter that resets on reload'
);

assert(
  /findMergeableOnsiteItem/.test(store) &&
    /qty:\s*target\.qty \+ en\.qty/.test(store),
  'adding the same loose onsite item again should raise its quantity instead of creating another visual row'
);

console.log('today-dashboard onsite dedupe static checks passed');
