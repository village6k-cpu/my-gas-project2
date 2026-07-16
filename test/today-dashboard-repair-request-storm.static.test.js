const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const sync = read('apps/today-dashboard/lib/data/sync.ts');
const store = read('apps/today-dashboard/lib/data/store.ts');

assert(
  /function needsDashboardDetailRepair\(t: Trade\)[\s\S]{0,260}contractStatus === "취소"[\s\S]{0,180}contractStatus === "반납완료"/.test(sync),
  'automatic detail repair must skip cancelled and returned trades that legitimately have no active schedule/contract detail'
);

assert(
  /const merged = mergeDashboard\(base, it\)[\s\S]{0,420}filledEquipment[\s\S]{0,220}filledContract[\s\S]{0,220}if \(!filledEquipment && !filledContract\) continue/.test(sync),
  'detail repair must not persist a no-op response and trigger another realtime repair cycle'
);

assert(
  /let remoteLoadPromise: Promise<void> \| null = null/.test(store) &&
    /function loadRemote\(\): Promise<void>[\s\S]{0,220}if \(remoteLoadPromise\) return remoteLoadPromise/.test(store),
  'desktop/mobile remounts must share one initial remote load instead of duplicating every GAS repair request'
);

console.log('today-dashboard repair request-storm regression checks passed');
