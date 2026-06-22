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

// ── 프론트: 현장추가가 스케줄상세(시트)에 기록되도록 onsiteAddon 호출 ──
assert(
  /export async function addOnsiteItems\(/.test(store),
  'addOnsiteItems must be async so it can write the on-site addition to the sheet'
);
assert(
  /gasMutation\("onsiteAddon"/.test(store),
  'addOnsiteItems must call the GAS onsiteAddon action to append rows to 스케줄상세'
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
  /filter\(\(e\) => !e\.isComponent\)/.test(store),
  'only set headers/standalone items are sent — backend re-expands set components from 세트마스터'
);
assert(
  /out\.addedItems/.test(store) && /a\.scheduleId/.test(store),
  'addOnsiteItems must reconcile the real sheet scheduleId returned by the backend (no leftover ONS- ids)'
);
assert(
  /if \(!writeBackEnabled\)[\s\S]*?addOnsiteItemsLocal/.test(store),
  'addOnsiteItems must fall back to local-only add when write-back is disabled'
);
assert(
  store.includes('throw new Error') && /가용|반영되지 않/.test(store),
  'a backend rejection (e.g. availability conflict) must surface as an error, not a silent no-op'
);

// 시트에 기록된 현장추가도 실 scheduleID라 삭제 시 스케줄상세 행도 제거되어야 함
assert(
  /if \(item && new RegExp\(`\^\$\{tradeId\}-\\\\d\+\$`\)\.test\(scheduleId\)\) \{[\s\S]*removeEquipmentAndRegenerateContract\(tradeId,\s*item\)/.test(store) &&
    /gasMutation\("removeEquip",\s*\{[\s\S]*directRegenerate:\s*true/.test(store),
  'removeItem must delete real-id rows (incl. sheet-recorded on-site) from 스케줄상세 and refresh contract data'
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
  /dashboardAddEquipments\(tid, entries, \{ dryRun: options\.dryRun, rawNames: options\.rawNames \}\)/.test(logic),
  'dashboardRecordOnsiteAddon must pass rawNames through to dashboardAddEquipments'
);
assert(
  /rawNames: params\.rawNames \|\| postBody\.rawNames/.test(api),
  'sheetAPI onsiteAddon case must forward rawNames from the request'
);

console.log('today-dashboard onsite sheet write-back static checks passed');
