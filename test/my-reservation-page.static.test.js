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

// ── GAS: 토큰 검증 + 민감정보 차단 + 완전 읽기 전용 ──
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
  !/setValue|appendRow|insertSheet|insertRow|deleteRow/.test(myPageCode.replace(/setProperty\("MYPAGE_SECRET"[^)]*\)/, '')),
  'my-page backend must be read-only (no sheet writes)'
);
assert(
  /case "myPage":/.test(sheetApi) && sheetApi.includes('"getMyPageLink"'),
  'sheetAPI must expose the myPage action and whitelist getMyPageLink'
);

// ── 페이지에서 직접 요청 접수는 금지 — 카카오톡 안내만 ──
assert(
  !sheetApi.includes('myPageRequest') && !myPage.includes('submitMyPageRequest'),
  'the my-page must not accept change/extension/cancel submissions'
);
assert(
  !route.includes('export async function POST') && !page.includes('method: "POST"'),
  'the /api/my route and page must be read-only (no POST)'
);
assert(
  page.includes('카카오톡 채널') && page.includes('연장 · 변경 · 취소'),
  'the my-page must guide customers to the KakaoTalk channel for changes'
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
  route.includes('rateLimited') && route.includes('action: "myPage"'),
  'the /api/my route must rate limit and proxy the GAS myPage action'
);
assert(
  gasHelper.includes('GAS_API_KEY') && gasHelper.includes('rateLimited'),
  'GAS helper must keep the API key server-side'
);

// ── 등록완료 알림톡: 내 예약 링크 포함, 미설정 시 스킵, 거래당 1회, 등록 흐름 비차단 ──
const backend = read('checkAvailability.js');
assert(
  /function sendRegisterCompleteAlimtalk_/.test(backend) &&
    backend.includes("getProperty('POPBILL_TPL_REGISTER')") &&
    backend.includes('getMyPageLink(거래ID)') &&
    backend.includes("'REG_ALIM_SENT_' + 거래ID"),
  'register-complete alimtalk must include the my-page link, skip without a template, and dedupe per trade'
);
assert(
  /try \{\s*sendRegisterCompleteAlimtalk_\(거래ID, 예약자명, 연락처, 반출일, 반출시간, 반납일, 반납시간\);\s*\} catch/.test(backend),
  'registerByReqID must call the alimtalk inside try/catch so registration never fails on send errors'
);

console.log('my-reservation-page.static.test.js OK');
