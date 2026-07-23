const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const store = read('apps/today-dashboard/lib/data/store.ts');
const sync = read('apps/today-dashboard/lib/data/sync.ts');
const logic = read('checkAvailability.js');
const api = read('sheetAPI.js');
const gasProxy = read('apps/today-dashboard/app/api/gas/route.ts');

// ── 프론트: 모든 실데이터 현장추가를 스케줄상세(시트)에 기록해 반출 기준선에서 빠지지 않게 함 ──
assert(
  /export async function addOnsiteItems\(/.test(store),
  'addOnsiteItems must stay async so every live on-site addition can be written to the sheet'
);
assert(
  /gasMutation\("onsiteAddon"/.test(store),
  'live on-site additions must call the GAS onsiteAddon action to append rows to 스케줄상세'
);
const onsiteStart = store.indexOf('export async function addOnsiteItems');
const onsiteEnd = store.indexOf('\nexport function setOnsiteSettlement', onsiteStart);
const onsiteFn = store.slice(onsiteStart, onsiteEnd);
assert(
  !/settlement !== "유상"/.test(onsiteFn) &&
    /if \(!isSupabase\)[\s\S]{0,180}addOnsiteItemsLocal/.test(onsiteFn) &&
    /if \(!writeBackEnabled\)[\s\S]{0,180}throw new Error/.test(onsiteFn) &&
    /if \(res\?\.skipped\)[\s\S]{0,180}throw new Error/.test(onsiteFn),
  'free/unsettled live additions must also use GAS-first persistence and fail closed when write-back is unavailable'
);
assert(
  /const WRITE_ACTIONS = new Set\(\[[\s\S]*"onsiteAddon"[\s\S]*\]\)/.test(gasProxy),
  'today-dashboard /api/gas proxy must allow onsiteAddon write-back action'
);
assert(
  store.includes('entries: JSON.stringify(payload)'),
  'on-site entries must be sent as a JSON string (GAS normalizeDashboardAddEntries_ parses it)'
);
assert(
  /rawNames:\s*true/.test(store),
  'on-site additions must set rawNames=true so free-input names are not fuzzy-matched into the wrong catalog item'
);
assert(
  /gasMutation\("onsiteAddon",\s*\{[\s\S]*directRegenerate:\s*false/.test(store),
  'on-site additions delegate contract regeneration to the background worker (freshness via contractRegenPending badge + polling merge)'
);
assert(
  /export async function addOnsiteItems\([\s\S]*const mutationResult = unwrapContractMutation\(res\)[\s\S]*amount: amount \?\? t\.amount[\s\S]*contractUrl: url \|\| t\.contractUrl \|\| null[\s\S]*contractRegenPending: !!mutationResult\.contractRegenPending && !url/.test(store),
  'addOnsiteItems must apply returned finalAmount/contractUrl to the local trade after sheet write-back'
);
assert(
  /filter\(\(e\) => !e\.isComponent\)/.test(store),
  'only set headers/standalone items are sent — backend re-expands set components from 세트마스터'
);
assert(
  /out\.addedItems/.test(store) && /a\.scheduleId/.test(store),
  'addOnsiteItems must reconcile the real sheet scheduleId returned by the backend (no leftover ONS- ids)'
);
assert(
  store.includes('throw new Error') && /가용|반영되지 않/.test(store),
  'a backend rejection (e.g. availability conflict) must surface as an error, not a silent no-op'
);

// 시트에 기록된 현장추가도 실 scheduleID라 삭제 시 스케줄상세 행도 제거되어야 함
assert(
  /if \(item && isSheetBackedScheduleId\(tradeId,\s*scheduleId\)\) \{[\s\S]*removeEquipmentAndRegenerateContract\(tradeId,\s*item\)/.test(store) &&
    /gasMutation\("removeEquip",\s*\{[\s\S]*directRegenerate:\s*false/.test(store),
  'removeItem must delete real-id rows (incl. sheet-recorded on-site) from 스케줄상세 and queue contract regeneration via the background worker'
);

// 시트 재동기화 후에도 현장추가는 '현장 추가' 구획에 묶이도록 onsite 보존
assert(
  /onsite: prev\?\.onsite/.test(sync),
  'mergeDashboard must preserve the onsite flag when a sheet-recorded on-site item refreshes'
);

// ── 백엔드: 자유입력 보존(rawNames) — 세트마스터만 참고, 장비마스터 강제 매칭/드롭 금지 ──
assert(
  /var rawNames = options\.rawNames/.test(logic),
  'dashboardAddEquipments must accept a rawNames option'
);
assert(
  /var nameList = rawNames \? \[\] : getDashboardEquipNameList_\(ss\)/.test(logic),
  'rawNames must skip 목록/장비마스터 fuzzy matching so free-input names are kept verbatim'
);
assert(
  /dashboardRecordOnsiteAddon\(tid, entries, options\)[\s\S]*dashboardAddEquipments\(tid, entries, \{[\s\S]*rawNames: options\.rawNames[\s\S]*directRegenerate: options\.directRegenerate \|\| options\.regenerateNow/.test(logic),
  'dashboardRecordOnsiteAddon must pass rawNames and directRegenerate through to dashboardAddEquipments'
);
assert(
  /function dashboardRecordOnsiteAddon[\s\S]{0,3000}dashboardAddEquipments\(tid, entries, \{[\s\S]{0,300}forceZeroPrice:\s*!isPaid/.test(logic) &&
    /price:\s*forceZeroPrice \? 0 :/.test(logic),
  'free/unsettled on-site additions must still enter the physical schedule but carry zero price'
);
assert(
  /rawNames: params\.rawNames \|\| postBody\.rawNames/.test(api),
  'sheetAPI onsiteAddon case must forward rawNames from the request'
);
assert(
  /case "onsiteAddon":[\s\S]*directRegenerate:[\s\S]*params\.directRegenerate \|\| postBody\.directRegenerate/.test(api),
  'sheetAPI onsiteAddon case must forward directRegenerate from the request'
);
assert(
  /function dashboardAddEquipments\(tid,\s*entries,\s*options\)[\s\S]*var directRegenerate[\s\S]*deleteAndRegenerateContract\(ss,\s*tid\)[\s\S]*finalAmount: contractResult && contractResult\.finalAmount/.test(logic),
  'dashboardAddEquipments must return the regenerated contract URL and finalAmount when directRegenerate is requested'
);

['dashboard.html', 'docs/dashboard.html'].forEach((file) => {
  const html = read(file);
  assert(
    /action=addEquips[\s\S]*directRegenerate=true/.test(html) &&
      /action:\s*'onsiteAddon'[\s\S]*directRegenerate:\s*true/.test(html),
    file + ' must request immediate regeneration for schedule and onsite additions'
  );
  assert(
    /function applyDashboardContractMutationResult\(tid,\s*res\)[\s\S]*item\.contractUrl = url/.test(html) &&
      /function applyDashboardContractMutationResult\(tid,\s*res\)[\s\S]*item\.actualAmount = amount/.test(html),
    file + ' must apply returned finalAmount and contractUrl to the visible dashboard state'
  );
});

console.log('today-dashboard onsite sheet write-back static checks passed');
