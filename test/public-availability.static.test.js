const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const publicAvail = read('publicAvailability.js');
const sheetApi = read('sheetAPI.js');
const authGate = read('apps/today-dashboard/components/AuthGate.tsx');
const page = read('apps/today-dashboard/app/availability/page.tsx');
const availRoute = read('apps/today-dashboard/app/api/public/availability/route.ts');
const reserveRoute = read('apps/today-dashboard/app/api/public/reserve/route.ts');
const catalogRoute = read('apps/today-dashboard/app/api/public/catalog/route.ts');
const gasHelper = read('apps/today-dashboard/lib/server/gasPublic.ts');

// ── GAS: 읽기 전용 공개 가용성 체크 ──
assert(
  /function getPublicAvailability\(req\)/.test(publicAvail),
  'publicAvailability.js must define getPublicAvailability(req)'
);
assert(
  !/setValue|appendRow|insertRow|setBackground|deleteRow/.test(publicAvail),
  'public availability check must be read-only (no sheet writes)'
);
assert(
  publicAvail.includes('getScheduleData') &&
    publicAvail.includes('findEquipment') &&
    publicAvail.includes('getSetComponents') &&
    publicAvail.includes('findSetPrice') &&
    publicAvail.includes('calcRentalDays') &&
    publicAvail.includes('getLongTermDiscountRate'),
  'public availability must reuse existing availability/pricing helpers (single source of truth)'
);
const publicAvailCode = publicAvail.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
assert(
  !publicAvailCode.includes('contractName') && !publicAvailCode.includes('예약자명') && !publicAvailCode.includes('연락처'),
  'public availability response must not touch customer PII fields'
);
assert(
  /case "publicAvail":/.test(sheetApi) && /getPublicAvailability\(/.test(sheetApi),
  'sheetAPI must expose the publicAvail action'
);

// ── 앱: 공개 경로는 직원 로그인 게이트를 우회 ──
assert(
  authGate.includes('PUBLIC_PATHS') && authGate.includes('"/availability"') && authGate.includes('usePathname'),
  'AuthGate must allow the public /availability path without staff login'
);

// ── 앱: 고객 페이지는 공개 서버 라우트만 사용 (직원용 /api/gas 금지) ──
assert(
  page.includes('/api/public/availability') &&
    page.includes('/api/public/reserve') &&
    page.includes('/api/public/catalog') &&
    !page.includes('/api/gas') &&
    !page.includes('authFetch'),
  'public availability page must only call /api/public/* routes'
);

// ── 서버 라우트: 키는 서버에만, 레이트리밋/허니팟 보호 ──
assert(
  gasHelper.includes('GAS_API_KEY') && gasHelper.includes('rateLimited'),
  'public GAS helper must keep the API key server-side and provide rate limiting'
);
assert(
  availRoute.includes('rateLimited') && availRoute.includes('publicAvail'),
  'availability route must rate limit and call the read-only publicAvail action'
);
assert(
  reserveRoute.includes('rateLimited') &&
    reserveRoute.includes('insertAndCheckRequest') &&
    reserveRoute.includes('website') &&
    reserveRoute.includes('웹 견적페이지 접수'),
  'reserve route must rate limit, use the existing insertAndCheckRequest entry, honeypot, and tag the source'
);
assert(
  catalogRoute.includes('dashboardEquipmentCatalog') && catalogRoute.includes('names'),
  'catalog route must serve names only from the sheet-master catalog'
);
assert(
  !/단가|unitPrice|total|components/.test(catalogRoute.replace(/\/\/.*$/gm, '')) ||
    !catalogRoute.includes('catalog: raw'),
  'catalog route must not pass through prices/stock to the public'
);

console.log('public-availability.static.test.js OK');
