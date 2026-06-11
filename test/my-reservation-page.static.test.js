const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const exists = (file) => fs.existsSync(path.join(root, file));

const myPage = read('myPage.js');
const myPageCode = myPage.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const sheetApi = read('sheetAPI.js');
const authGate = read('apps/today-dashboard/components/AuthGate.tsx');
const page = read('apps/today-dashboard/app/my/page.tsx');
const route = read('apps/today-dashboard/app/api/my/route.ts');
const gasHelper = read('apps/today-dashboard/lib/server/gasPublic.ts');

// ── 가용성/견적 공개 기능은 존재하면 안 됨 (외부 오픈 금지) ──
assert(!exists('publicAvailability.js'), 'public availability module must not exist');
assert(!exists('apps/today-dashboard/app/availability'), 'public availability page must not exist');
assert(!exists('apps/today-dashboard/app/api/public'), 'public availability/reserve API routes must not exist');
assert(!sheetApi.includes('publicAvail'), 'sheetAPI must not expose a public availability action');

// ── GAS: 토큰 검증 + 민감정보 차단 ──
assert(
  /function getMyReservation\(token\)/.test(myPage) &&
    /computeHmacSha256Signature/.test(myPage) &&
    /function myPageVerify_/.test(myPage),
  'myPage.js must verify HMAC tokens before returning anything'
);
assert(
  /function myPageMaskName_/.test(myPage) && myPage.includes('myPageMaskName_(c[1])'),
  'customer names must be masked in my-page responses'
);
assert(
  !myPageCode.includes('연락처') && !/\bc\[2\]/.test(myPageCode),
  'my-page must never read or return the customer phone column'
);
assert(
  /case "myPage":/.test(sheetApi) && /case "myPageRequest":/.test(sheetApi) && sheetApi.includes('"getMyPageLink"'),
  'sheetAPI must expose myPage/myPageRequest actions and whitelist getMyPageLink'
);
// 고객요청은 전용 시트에만 기록 — 기존 시트 구조는 건드리지 않음
assert(
  myPage.includes('getSheetByName("고객요청")') &&
    !myPageCode.includes('확인요청").appendRow') &&
    !myPageCode.includes('스케줄상세").appendRow'),
  'customer requests must be appended only to the dedicated 고객요청 sheet'
);

// ── 앱: /my만 공개, 페이지는 /api/my만 사용 ──
assert(
  authGate.includes('PUBLIC_PATHS') && authGate.includes('"/my"') && !authGate.includes('"/availability"'),
  'AuthGate must allow only the /my public path'
);
assert(
  page.includes('/api/my') && !page.includes('/api/gas') && !page.includes('authFetch'),
  'my-page must only call the /api/my server route'
);
assert(
  route.includes('rateLimited') && route.includes('action: "myPage"') && route.includes('myPageRequest'),
  'the /api/my route must rate limit and proxy the GAS myPage actions'
);
assert(
  gasHelper.includes('GAS_API_KEY') && gasHelper.includes('rateLimited'),
  'GAS helper must keep the API key server-side'
);

console.log('my-reservation-page.static.test.js OK');
