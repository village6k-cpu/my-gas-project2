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
const estimateRoute = exists('apps/today-dashboard/app/api/my/estimate/route.ts')
  ? read('apps/today-dashboard/app/api/my/estimate/route.ts')
  : '';
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
  /function myPageScheduleSnapshot_\(ss, tradeId\)/.test(myPage) &&
    myPage.includes('getSheetByName("스케줄상세")') &&
    myPage.includes('getDisplayValues()') &&
    /scheduleView[\s\S]{0,180}checkoutAt/.test(myPage) &&
    /scheduleView[\s\S]{0,220}returnAt/.test(myPage),
  'my-page must prefer 스케줄상세 display date-times over 계약마스터 internal Date values'
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
assert(
  /case "myPageEstimate":/.test(sheetApi) &&
    /getMyReservationEstimatePdf\(params\.token \|\| postBody\.token \|\| ""\)/.test(sheetApi),
  'sheetAPI must expose a token-verified myPageEstimate action for the customer quote PDF'
);
assert(
  /function getMyReservationEstimatePdf\(token\)/.test(myPage) &&
    /myPageVerify_\(token\)/.test(myPage) &&
    /action:\s*"previewQuote"/.test(myPage) &&
    /pdfUrl/.test(myPage) &&
    !/myPageEstimateCacheKey_/.test(myPage) &&
    !/reuse:\s*"1"/.test(myPage),
  'myPage.js must create the customer-visible quote PDF through the token-verified previewQuote path without stale PDF reuse'
);
assert(
  /MYPAGE_VIEW_CACHE_SECONDS_/.test(myPage) &&
    /function myPageReservationCacheKey_/.test(myPage) &&
    /CacheService\.getScriptCache\(\)/.test(myPage) &&
    /myPageGetCachedJson_/.test(myPage) &&
    /myPagePutCachedJson_/.test(myPage),
  'myPage must cache token-verified reservation payloads briefly so customer refreshes are fast'
);
assert(
  /function myPageFindRowByExact_/.test(myPage) &&
    /createTextFinder\(String\(value\)\)/.test(myPage) &&
    /function myPageTradeScheduleView_/.test(myPage),
  'myPage trade lookups must use exact row lookup helpers instead of full-sheet scans'
);
{
  const tradeViewBody = myPage.slice(myPage.indexOf('function myPageTradeView_'), myPage.indexOf('function myPageTradeExists_'));
  assert(
    !/contractSheet\.getRange\(2,\s*1,\s*contractSheet\.getLastRow\(\) - 1,\s*12\)\.getValues\(\)/.test(tradeViewBody) &&
      !/schedSheet\.getRange\(2,\s*1,\s*schedSheet\.getLastRow\(\) - 1,\s*10\)\.getValues\(\)/.test(tradeViewBody),
    'myPage trade view must not read full 계약마스터/스케줄상세 ranges for one customer token'
  );
}
assert(
  !/function myPageContractPdfExportUrl_/.test(myPage) &&
    !/getTimelineContractLink\(tradeId\)/.test(myPage) &&
    !/\/spreadsheets\/d\/.*\/export\?format=pdf/.test(myPage) &&
    /action:\s*"previewQuote"/.test(myPage),
  'myPage estimate PDF must use the quote preview path only, never the generated contract document'
);
assert(
  !/contractUrl:\s*contractUrl/.test(myPage) &&
    !/contractUrl:\s*string/.test(page) &&
    !/trade\.contractUrl/.test(page),
  'my-page must never expose the Google Sheets contract URL to customers'
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
  /gasGet\(\{ action: "myPage", token \}\)/.test(estimateRoute) &&
    /action", "previewQuote"/.test(estimateRoute) &&
    /rejectNonQuotePdfUrl/.test(estimateRoute) &&
    !/isGoogleSheetPdfExportUrl/.test(estimateRoute) &&
    !/reuse", "1"/.test(estimateRoute) &&
    !/QUOTE_PDF_CACHE_MS/.test(estimateRoute) &&
    !/quotePdfCache/.test(estimateRoute) &&
    !/\/spreadsheets\/d\/[^/]+\/export/.test(estimateRoute) &&
    /NextResponse\.redirect\(pdfUrl/.test(estimateRoute) &&
    /TOKEN_RE/.test(estimateRoute) &&
    /rateLimited/.test(estimateRoute),
  'the customer quote route must validate the token, call previewQuote without stale PDF reuse, and never proxy contract sheet exports'
);
assert(
  page.includes('카카오톡 채널') && page.includes('연장 · 변경 · 취소'),
  'the my-page must guide customers to the KakaoTalk channel for changes'
);
assert(
  page.includes('/api/my/estimate') &&
    page.includes('견적서 PDF 확인') &&
    !page.includes('계약서 · 견적 확인'),
  'the my-page document button must open only the quote PDF route'
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
  /const myPageResponseCache = new Map/.test(route) &&
    /MY_PAGE_RESPONSE_CACHE_MS/.test(route) &&
    /myPageResponseCache\.get\(token\)/.test(route) &&
    /myPageResponseCache\.set\(token/.test(route),
  'the /api/my route must keep a short server-side token cache so repeated customer opens avoid slow GAS roundtrips'
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
assert(
  backend.includes('팝빌 승인 템플릿과 글자 단위 동일') &&
    backend.includes('예약 내용과 계약서를 언제든 확인하실 수 있어요.') &&
    !backend.includes('예약 내용과 견적서 PDF를 언제든 확인하실 수 있어요.'),
  'register-complete alimtalk copy must match the currently approved Popbill template wording'
);

// ── 라이브 검증 후속: 평문 ID 링크 생성 + 원격 1회 설정 ──
assert(
  /getMyPageLink[\s\S]{0,500}catch \(argErr\)/.test(sheetApi) &&
    sheetApi.includes('"setupMyPage"') &&
    /setupMyPage[\s\S]{0,500}JSON\.parse\(setupArgs\)/.test(sheetApi),
  'getMyPageLink must accept plain-string ids and setupMyPage must be callable via the run API'
);

console.log('my-reservation-page.static.test.js OK');
