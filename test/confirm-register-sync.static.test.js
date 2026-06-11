const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const backend = read('checkAvailability.js');
const supaSync = read('supabaseSync.js');
const storeTs = read('apps/today-dashboard/lib/data/store.ts');
const syncTs = read('apps/today-dashboard/lib/data/sync.ts');
const confirmView = read('apps/today-dashboard/components/ConfirmView.tsx');
const confirmRoute = read('apps/today-dashboard/app/api/confirm/route.ts');

// ── 스크립트 쓰기도 Supabase로 동기화: onEdit만으로는 등록 건이 누락된다 ──
assert(
  /function supaMarkTradeDirty_\(tid\)/.test(supaSync),
  'supabaseSync must expose a script-callable dirty marker (onEdit does not fire for script writes)'
);
const markCalls = (backend.match(/supaMarkTradeDirty_\(거래ID\)/g) || []).length;
assert(
  markCalls >= 4,
  `register/add/remove/change-dates must all mark the trade dirty for Supabase (found ${markCalls})`
);

// ── registerAsync 경쟁 수정: 단일 속성 덮어쓰기 금지, 큐 + 실행 시점 행 재탐색 ──
assert(
  backend.includes('_pendingRegisterQueue') &&
    !backend.includes('JSON.stringify({ reqID: reqID, row: targetRow })'),
  'scheduleRegister must queue reqIDs instead of overwriting a single property with a stale row number'
);

// ── 앱: 등록 직후 90초 폴링을 기다리지 않고 신규 거래 즉시 반영 ──
assert(
  /export async function pollSheetChangesNow/.test(storeTs),
  'store must expose pollSheetChangesNow for immediate sheet refresh'
);
assert(
  confirmView.includes('pollSheetChangesNow'),
  'ConfirmView must trigger an immediate poll after successful registration'
);

// ── 앱: 검색 복구가 스토어에 없는 신규 거래도 합류시킨다 ──
assert(
  /repairDashboardSearchResults[\s\S]*hasUnknown[\s\S]*pollTimelineChanges/.test(syncTs),
  'search repair must materialize sheet-only trades instead of skipping unknown tradeIds'
);

// ── 등록 응답 타임아웃 UX: 실패 단정 금지 + 함수 수명 연장 ──
assert(
  confirmRoute.includes('maxDuration') && confirmRoute.includes('110_000'),
  'confirm route must allow long-running registration before aborting'
);
assert(
  confirmView.includes('등록 자체는 계속 진행 중일 수 있으니') || confirmView.includes('계속 진행 중일 수 있'),
  'ConfirmView must explain that registration may still be in progress on timeout'
);

console.log('confirm-register-sync.static.test.js OK');
