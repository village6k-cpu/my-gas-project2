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
  /function getDashboardSearchIndex_\(ss,\s*schedSheet,\s*contractSheet\)[\s\S]*putDashboardCacheJson_\(cache,\s*cacheKey,\s*index,\s*300\)/,
  'global search must cache the expensive all-reservation search index'
);

  assert.match(
    backend,
  /function getDashboardSearchResultCacheKey_\(query,\s*limit\)[\s\S]*dashboard_search_result_v3_/,
  'global search must cache repeated query results by normalized query and limit'
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
    /action=dashboardSearch&limit=[\s\S]{0,120}DASHBOARD_SEARCH_LIMIT/,
    `${file} must pass the smaller search result limit to the API`
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
