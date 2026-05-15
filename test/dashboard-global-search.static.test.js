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
  'global search must scan schedule detail rows, not selected-date dashboard data'
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
});

console.log('dashboard global search static checks passed');
