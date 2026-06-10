const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const syncPath = path.join(root, 'apps/today-dashboard/lib/data/sync.ts');
const storePath = path.join(root, 'apps/today-dashboard/lib/data/store.ts');

const syncSource = fs.readFileSync(syncPath, 'utf8');
const storeSource = fs.readFileSync(storePath, 'utf8');

assert(
  syncSource.includes('needsDashboardDetailRepair'),
  'sync layer must identify trades that have equipment but are missing dashboard detail fields such as contractUrl'
);
assert(
  syncSource.includes('!t.contractUrl'),
  'dashboard detail repair must include trades with missing contract links'
);
assert(
  syncSource.includes('repairDashboardDetailsForIncompleteTrades'),
  'repair function name must describe incomplete dashboard details, not only empty equipment'
);
assert(
  !syncSource.includes('repairDashboardDetailsForEmptyEquipments'),
  'repair must no longer be limited to empty-equipment trades'
);
assert(
  storeSource.includes('repairDashboardDetailsForIncompleteTrades'),
  'store load/poll path must repair missing contract links from dashboard detail data'
);

console.log('today-dashboard contract detail repair static checks passed');
