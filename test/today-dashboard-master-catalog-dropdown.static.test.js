const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const checklist = read('apps/today-dashboard/components/HandoverChecklist.tsx');
const returnChecklist = read('apps/today-dashboard/components/ReturnChecklist.tsx');
const kakaoInput = read('apps/today-dashboard/components/KakaoReservationInput.tsx');
const catalogData = fs.existsSync(path.join(root, 'apps/today-dashboard/lib/data/equipmentCatalog.ts'))
  ? read('apps/today-dashboard/lib/data/equipmentCatalog.ts')
  : '';
const gasRoute = read('apps/today-dashboard/app/api/gas/route.ts');
const sheetApi = read('sheetAPI.js');
const gasBackend = read('checkAvailability.js');
const domainCatalog = read('apps/today-dashboard/lib/domain/catalog.ts');
const seedData = read('apps/today-dashboard/lib/data/seed.ts');

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
  !/searchEquipmentCatalog\(catalog\.items, trimmed, 1\)\[0\]/.test(kakaoInput) &&
    /catalogExactKey\(trimmed\)/.test(kakaoInput) &&
    /return \{ name: trimmed, warn: true \}/.test(kakaoInput),
  'Kakao reservation equipment parsing must not auto-replace short free input like SDI with the first catalog suggestion'
);
assert(
  !/if \(matches\[0\] && !exact\) select\(matches\[0\]\)/.test(checklist) &&
    !/if \(matches\[0\] && !exact\) select\(matches\[0\]\)/.test(returnChecklist) &&
    /if \(exactMatch\) select\(exactMatch\);[\s\S]*else save\(\);/.test(checklist) &&
    /if \(exactMatch\) select\(exactMatch\);[\s\S]*else save\(\);/.test(returnChecklist),
  'handover/return equipment name editors must save typed free input on Enter instead of selecting the first fuzzy match'
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
assert(
  /function isUnsafeFuzzyEquipInput_\(inputLower\)[\s\S]*sdi: true[\s\S]*hdmi: true[\s\S]*렌즈: true/.test(gasBackend) &&
    /if \(isUnsafeFuzzyEquipInput_\(inputLower\)\) return input/.test(gasBackend),
  'GAS fuzzy equipment matching must not auto-canonicalize broad short tokens like SDI into a specific device'
);
assert(
  /var rawNames = options\.rawNames;[\s\S]*rawNames = !\(rawNames === false/.test(gasBackend) &&
    /var nameList = rawNames \? \[\] : getDashboardEquipNameList_\(ss\)/.test(gasBackend),
  'dashboard add-equipment must preserve typed names by default and require an explicit rawNames=false to use fuzzy matching'
);
assert(
  !domainCatalog.includes('"소니 A1 바디"') &&
    !seedData.includes('"소니 A1 바디"'),
  'non-master prototype equipment such as 소니 A1 바디 must not remain in app catalog or demo seed data'
);

console.log('today-dashboard sheet-master catalog dropdown static checks passed');
