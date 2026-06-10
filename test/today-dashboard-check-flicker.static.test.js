const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const storePath = path.join(root, 'apps/today-dashboard/lib/data/store.ts');
const storeSource = fs.readFileSync(storePath, 'utf8');

assert(
  storeSource.includes('let localMutationSeq'),
  'store must track local mutation sequence so stale remote refreshes cannot overwrite fresh checkbox clicks'
);
assert(
  storeSource.includes('function markLocalMutation'),
  'mutations must be explicitly marked before optimistic state is written'
);
assert(
  storeSource.includes('function canApplyRemoteSnapshot'),
  'remote fetch/poll results must be gated before applying to the visible store'
);
assert(
  /function mutateTrade\([\s\S]*markLocalMutation\(\)[\s\S]*set\(\{ trades \}\)/.test(storeSource),
  'trade mutations must mark a local mutation before applying optimistic checked state'
);
assert(
  /subscribeChanges\(\(\) => \{[\s\S]*const mutationSeqAtSchedule = localMutationSeq[\s\S]*setTimeout\(async \(\) => \{[\s\S]*if \(!canApplyRemoteSnapshot\(mutationSeqAtSchedule\)\) return;[\s\S]*fetchAllTrades\(\)[\s\S]*if \(!canApplyRemoteSnapshot\(mutationSeqAtSchedule\)\) return;[\s\S]*set\(\{ trades, notes \}\)/.test(storeSource),
  'delayed realtime refetch must re-check local mutation sequence before it overwrites the store'
);
assert(
  /const mutationSeqAtPoll = localMutationSeq[\s\S]*pollTimelineChanges\(state\.trades\)[\s\S]*if \(!canApplyRemoteSnapshot\(mutationSeqAtPoll\)\) return;[\s\S]*set\(\{ trades: mergeTradeChanges\(state\.trades, changed\) \}\)/.test(storeSource),
  'timeline polling must not apply stale results if a checkbox changed while the poll request was in flight'
);
assert(
  storeSource.includes('const pendingPersistTrades = new Set<string>()') &&
    storeSource.includes('const persistGenerations: Record<string, number> = {}'),
  'debounced trade persists must be tracked per trade so rapid checkbox clicks do not leak pending state'
);
assert(
  !storeSource.includes('let pendingPersist = 0'),
  'global pendingPersist counter must not be used because clearing debounced timers can leave it permanently positive'
);

console.log('today-dashboard checkbox flicker static checks passed');
