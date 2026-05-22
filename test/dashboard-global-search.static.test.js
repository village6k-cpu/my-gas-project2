const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const backend = read('checkAvailability.js');
const api = read('sheetAPI.js');

assert.match(
  backend,
  /function getDashboardSearchData\(query,\s*options\)/,
  'backend must expose getDashboardSearchData(query, options)'
);

assert.match(
  backend,
  /getRange\(2,\s*1,\s*schedSheet\.getLastRow\(\)\s*-\s*1,\s*12\)\.getDisplayValues\(\)/,
  'global search index must scan schedule detail rows, not selected-date dashboard data'
);

assert.match(
  backend,
  /function getDashboardSearchIndex_\(ss,\s*schedSheet,\s*contractSheet\)[\s\S]*dashboard_search_index_v5_[\s\S]*putDashboardCacheJson_\(cache,\s*cacheKey,\s*index,\s*300\)/,
  'global search must cache the expensive all-reservation search index'
);

assert.match(
  backend,
  /function getDashboardSearchIndex_\(ss,\s*schedSheet,\s*contractSheet\)[\s\S]*x:\s*buildDashboardSearchText_\(group,\s*cust,\s*extra,\s*checkInfo\)/,
  'global search index must keep a compact normalized text field'
);

assert.match(
  backend,
  /rs:\s*group\.rowNums\s*\|\|\s*\[\]/,
  'global search index must retain schedule row numbers so visible result cards avoid full sheet scans'
);

assert.doesNotMatch(
  backend,
  /group:\s*group,\s*\n\s*cust:\s*cust,\s*\n\s*searchText:/,
  'global search index must not cache full group/customer payloads for every reservation'
);

assert.match(
  backend,
  /function getDashboardSearchGroupsForIds_\(schedSheet,\s*tradeIds,\s*rowsByTid\)[\s\S]*readDashboardScheduleRowsDisplay_\(schedSheet,\s*rowNums,\s*12\)/,
  'global search must rebuild full schedule groups from visible trade rows only'
);

assert.match(
  backend,
  /function getDashboardSearchResultCacheKey_\(query,\s*limit,\s*summaryOnly\)[\s\S]*dashboard_search_result_v5_/,
  'global search must cache repeated query results by normalized query and limit'
);

assert.match(
  backend,
  /summaryMode:\s*true/,
  'global search must support a lightweight summary response for initial typing'
);

assert.match(
  backend,
  /function warmDashboardSearchIndex_\(\)[\s\S]*getDashboardSearchIndex_\(/,
  'dashboard warmer must prebuild the global search index'
);

assert.match(
  backend,
  /searchDate[\s\S]{0,240}searchPhaseLabel/,
  'search results must include date and phase labels for the UI'
);

assert.match(
  api,
  /case\s+["']dashboardSearch["'][\s\S]{0,260}getDashboardSearchData\(/,
  'sheetAPI must route action=dashboardSearch to getDashboardSearchData'
);

assert.match(
  api,
  /summary:\s*params\.summary\s*\|\|\s*postBody\.summary/,
  'sheetAPI must pass dashboardSearch summary mode through to the backend'
);

['dashboard.html', 'docs/dashboard.html'].forEach((file) => {
  const html = read(file);

  assert.match(
    html,
    /placeholder=["']이름,\s*연락처,\s*장비,\s*거래ID 전체 검색["']/,
    `${file} must advertise global search in the search input`
  );

  assert.match(
    html,
    /var dashboardGlobalSearchData\s*=\s*null/,
    `${file} must keep global search data separate from selected-date dashboard data`
  );

  assert.match(
    html,
    /action=dashboardSearch/,
    `${file} must call the dashboardSearch API while searching`
  );

  assert.match(
    html,
    /var DASHBOARD_SEARCH_DEBOUNCE_MS\s*=\s*360;/,
    `${file} must debounce global search enough to avoid stacked GAS calls while typing`
  );

  assert.match(
    html,
    /var DASHBOARD_SEARCH_LIMIT\s*=\s*40;/,
    `${file} must cap global search payload size for fast rendering`
  );

  assert.match(
    html,
    /action=dashboardSearch&summary=1&limit=[\s\S]{0,120}DASHBOARD_SEARCH_LIMIT/,
    `${file} must request lightweight global search summaries while typing`
  );

  assert.match(
    html,
    /function loadDashboardSearchDetails\(openGroupId\)/,
    `${file} must lazy-load full global search cards when a result group is opened`
  );

  assert.match(
    html,
    /function renderDashboardGlobalSearch\(/,
    `${file} must render global search results separately`
  );

  assert.match(
    html,
    /전체 예약에서 검색 중/,
    `${file} must label global search mode clearly`
  );

  assert.match(
    html,
    /search-date-badge/,
    `${file} must render a visible date badge on search result cards`
  );

  assert.match(
    html,
    /function toggleDashboardSearchGroup\(groupId\)/,
    `${file} must implement toggling for global search date groups`
  );

  assert.match(
    html,
    /search-group-toggle/,
    `${file} must render search group headers as toggle buttons`
  );

  assert.match(
    html,
    /time-group\.collapsed\s+\.time-group-body/,
    `${file} must hide collapsed search group bodies`
  );

  assert.match(
    html,
    /dashboardSearchCollapsedGroups/,
    `${file} must remember collapsed search groups while rendering`
  );

  assert.match(
    html,
    /function resetDashboardSearchCollapsedGroups\(data\)/,
    `${file} must initialize global search groups as collapsed`
  );

  assert.match(
    html,
    /dashboardSearchCollapsedGroups\[groupId\]\s*=\s*true/,
    `${file} must collapse global search groups by default`
  );

  assert.match(
    html,
    /if \(options\.globalSearch && isCollapsed\) \{[\s\S]{0,180}return;/,
    `${file} must skip rendering collapsed search cards until the group is opened`
  );
});

console.log('dashboard global search static checks passed');
