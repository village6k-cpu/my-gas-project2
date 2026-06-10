const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const checklist = read('apps/today-dashboard/components/HandoverChecklist.tsx');
const catalogData = fs.existsSync(path.join(root, 'apps/today-dashboard/lib/data/equipmentCatalog.ts'))
  ? read('apps/today-dashboard/lib/data/equipmentCatalog.ts')
  : '';
const gasRoute = read('apps/today-dashboard/app/api/gas/route.ts');
const sheetApi = read('sheetAPI.js');
const gasBackend = read('checkAvailability.js');

assert(
  catalogData.includes('action=dashboardEquipmentCatalog') &&
    catalogData.includes('useEquipmentCatalog') &&
    catalogData.includes('searchEquipmentCatalog'),
  'today dashboard dropdowns must load their catalog from the GAS sheet-master catalog API, not the prototype CATALOG array'
);
assert(
  !/import \{[^}]*searchCatalog/.test(checklist) &&
    checklist.includes('useEquipmentCatalog') &&
    checklist.includes('searchEquipmentCatalog(catalog.items, q'),
  'handover checklist dropdowns must search the sheet-master catalog state instead of the static prototype catalog'
);
assert(
  checklist.includes('자유입력 저장') && checklist.includes('자유입력 추가'),
  'sheet-master dropdowns must still allow explicit free-input fallback'
);
assert(
  gasRoute.includes('"dashboardEquipmentCatalog"'),
  'Next GAS proxy must whitelist the dashboardEquipmentCatalog read action'
);
assert(
  /case "dashboardEquipmentCatalog":[\s\S]*getDashboardEquipmentCatalog_/.test(sheetApi),
  'sheetAPI must expose dashboardEquipmentCatalog'
);
assert(
  /function getDashboardEquipmentCatalog_\(ss\)[\s\S]*getDashboardEquipNameList_\(ss\)[\s\S]*buildDashboardSetLookup_\(ss\.getSheetByName\("세트마스터"\)\)/.test(gasBackend),
  'GAS dashboardEquipmentCatalog must be based on 목록/세트마스터, not the app prototype catalog'
);

console.log('today-dashboard sheet-master catalog dropdown static checks passed');
