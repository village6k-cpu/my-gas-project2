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
  /function mutateTrade\([\s\S]*markLocalMutation\(tradeId\)[\s\S]*set\(\{ trades \}\)/.test(storeSource),
  'trade mutations must mark that trade before applying optimistic checked state'
);
assert(
  /async function flushRealtimeChanges\(\)[\s\S]*const blockedIds[\s\S]*const safeIds[\s\S]*versionAtFetch\[id\] = tradeMutationSeq\[id\][\s\S]*staleIds[\s\S]*realtimeTradeIds\.add\(id\)/.test(storeSource),
  'realtime flush must isolate busy trades and requeue only stale trade snapshots'
);
assert(
  /function hasTradeSyncPending\(tradeId: string\)[\s\S]*pendingPersistTrades\.has\(tradeId\) \|\| hasTradePending\(tradeId\)/.test(storeSource) &&
    /const versionAtPoll = \{ \.\.\.tradeMutationSeq \}[\s\S]*pollTimelineChanges\(\s*state\.trades[\s\S]*!hasTradeSyncPending\(trade\.tradeId\)[\s\S]*tradeMutationSeq\[trade\.tradeId\][\s\S]*mergeTradeChanges\(state\.trades, applicable\)/.test(storeSource),
  'timeline polling must gate each trade on both user writes and pending convergence writes, then reject in-flight stale versions'
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
