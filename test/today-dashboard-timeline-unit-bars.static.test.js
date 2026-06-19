const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const timelineDomain = read('apps/today-dashboard/lib/domain/timeline.ts');
const timelineView = read('apps/today-dashboard/components/VillageTimeline.tsx');
const sync = read('apps/today-dashboard/lib/data/sync.ts');
const backend = read('checkAvailability.js');

assert(
  /unitIndex\?: number/.test(timelineDomain) &&
    /unitCount\?: number/.test(timelineDomain),
  'timeline items must carry per-unit metadata so qty N can render as N visible bars'
);

assert(
  /const unitCount = Math\.max\(1, Math\.floor\(Number\.isFinite\(rawQty\) \? rawQty : 1\)\)/.test(timelineDomain) &&
    /for \(let unitIndex = 1; unitIndex <= unitCount; unitIndex \+= 1\)/.test(timelineDomain) &&
    /id: `\$\{t\.tradeId\}__\$\{e\.scheduleId\}__u\$\{unitIndex\}`/.test(timelineDomain) &&
    /qty: 1/.test(timelineDomain),
  'buildItems must expand a qty-2 schedule row into two separate visual bars with unique ids'
);

assert(
  /function unitBadge\(it: TLItem\): string/.test(timelineView) &&
    /unitCount && it\.unitCount > 1/.test(timelineView) &&
    /unitBadge\(it\)/.test(timelineView),
  'timeline bars must label duplicated units instead of hiding qty behind one bar'
);

assert(
  /var barCount = Math\.max\(1, Math\.floor\(Number\(e\.수량\) \|\| 1\)\)/.test(backend) &&
    !/var barCount = e\.isSingleItem \? 1/.test(backend),
  'GAS timeline must also render single-equipment qty N as N bars'
);

assert(
  /seenRowKeys[\s\S]{0,800}if \(seenRowKeys\.has\(rowKey\)\) return;/.test(sync),
  'Supabase sync must still collapse visual duplicate bars back to one schedule row'
);

console.log('today-dashboard timeline unit bar checks passed');
