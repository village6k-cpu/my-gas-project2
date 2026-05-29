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
  /function getDashboardSearchIndex_\(ss,\s*schedSheet,\s*contractSheet\)[\s\S]*dashboard_search_index_v9_[\s\S]*putDashboardCacheJson_\(cache,\s*cacheKey,\s*index,\s*300\)/,
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

assert.match(
  backend,
  /var DASHBOARD_SEARCH_CLIENT_INDEX_COLUMNS_[\s\S]*\['tid',\s*'n',\s*'tel',\s*'co',\s*'cs',\s*'st',\s*'od',\s*'ot',\s*'rd',\s*'rt',\s*'eq',\s*'x'\]/,
  'global search client index must define packed columns for a smaller browser payload'
);

assert.match(
  backend,
  /function packDashboardSearchClientText_\(text,\s*tokenState\)[\s\S]*hasOwnProperty\.call\(tokenState\.lookup,\s*token\)[\s\S]*tokenState\.tokens\.push\(token\)/,
  'global search client index must dedupe repeated search text tokens into a shared dictionary'
);

assert.match(
  backend,
  /function getDashboardSearchClientIndex_\(\)[\s\S]*packed:\s*true[\s\S]*tokenized:\s*true[\s\S]*textColumn:\s*DASHBOARD_SEARCH_CLIENT_INDEX_TEXT_COLUMN_[\s\S]*tokens:\s*tokenState\.tokens[\s\S]*packDashboardSearchClientEntry_\(entry,\s*tokenState\)/,
  'global search must expose a packed browser-side index for instant results'
);

assert.match(
  backend,
  /function getDashboardSearchIndex_\(ss,\s*schedSheet,\s*contractSheet\)[\s\S]*eq:\s*buildDashboardSearchSummaryEquipments_\(group\.equipments\)/,
  'global search index must ship compact equipment summaries so opened date groups show equipment immediately'
);

assert.match(
  backend,
  /function buildDashboardSearchSummaryEquipments_\(equipments\)[\s\S]*return\s+\[[\s\S]*eq\.scheduleId[\s\S]*eq\.name[\s\S]*eq\.qty[\s\S]*eq\.setName/,
  'global search index equipment summaries must stay compact arrays'
);

assert.match(
  backend,
  /function expandDashboardSearchSummaryEquipments_\(items\)[\s\S]*Array\.isArray\(item\)[\s\S]*scheduleId:\s*item\[0\][\s\S]*name:\s*item\[1\]/,
  'server summary results must expand compact equipment arrays before rendering'
);

assert.match(
  backend,
  /function compactDashboardSearchTextParts_\(parts\)[\s\S]*seen\[token\][\s\S]*out\.push\(token\)/,
  'global search index text must dedupe repeated normalized tokens'
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

const searchDataBody = backend.match(/function getDashboardSearchData\(query,\s*options\)[\s\S]*?\n}\n\nfunction getDashboardSearchCandidateGroupLabel_/);
assert.ok(searchDataBody, 'getDashboardSearchData body must be discoverable');
assert.doesNotMatch(
  searchDataBody[0],
  /getDashboardSearchResultCacheKey_|resultCacheKey|getDashboardCacheJson_\(cache,\s*resultCacheKey\)|putDashboardCacheJson_\(cache,\s*resultCacheKey/,
  'global search must not cache final query results because stale result-cache entries can show the wrong customer for a new query'
);

assert.match(
  backend,
  /function getDashboardSearchCandidateScore_\(entry,\s*terms\)[\s\S]*normalizeDashboardSearchText_\(entry\.n[\s\S]*getDashboardSearchEntryEquipmentText_\(entry\)[\s\S]*name\.indexOf\(term\) === 0[\s\S]*haystack\.indexOf\(term\) >= 0/,
  'global search must rank customer-name matches ahead of broad equipment/status text matches'
);

assert.match(
  searchDataBody[0],
  /var searchScore\s*=\s*getDashboardSearchCandidateScore_\(entry,\s*terms\)[\s\S]*searchScore:\s*searchScore[\s\S]*candidates\.sort\(function\(a,\s*b\)[\s\S]*a\.searchScore[\s\S]*compareDashboardSearchCandidates_\(a,\s*b\)/,
  'global search must apply relevance scoring before date/time sorting'
);

assert.match(
  backend,
  /summaryMode:\s*true/,
  'global search must support a lightweight summary response for initial typing'
);

assert.match(
  backend,
  /var detailGroup\s*=\s*String\(options\.detailGroup/,
  'global search must accept a specific group for lazy detail loading'
);

assert.match(
  backend,
  /detailVisible\s*=\s*visible\.filter\([\s\S]*getDashboardSearchCandidateGroupLabel_\(candidate\)\s*===\s*detailGroup/,
  'global search detail loading must build full cards only for the opened search group'
);

assert.match(
  backend,
  /partialDetailMode:\s*!!detailGroup/,
  'global search detail responses must identify partial group-detail payloads'
);

assert.match(
  backend,
  /var includeSearchRiskWarnings\s*=\s*options\.includeRiskWarnings === true/,
  'global search must keep equipment-risk warning expansion opt-in for fast search details'
);

assert.match(
  backend,
  /includeSearchRiskWarnings \? setSheet : null/,
  'global search must skip set-component risk expansion unless risk warnings are explicitly requested'
);

assert.match(
  backend,
  /function buildDashboardSearchItem_\([^\)]*options\)[\s\S]*includeRiskWarnings[\s\S]*riskWarnings:\s*includeRiskWarnings/,
  'search card building must be able to omit expensive risk warning decoration'
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

assert.match(
  api,
  /detailGroup:\s*params\.detailGroup\s*\|\|\s*postBody\.detailGroup/,
  'sheetAPI must pass dashboardSearch detailGroup through to the backend'
);

assert.match(
  api,
  /case\s+["']dashboardSearchIndex["'][\s\S]{0,120}getDashboardSearchClientIndex_\(\)/,
  'sheetAPI must expose action=dashboardSearchIndex for browser-side instant search'
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
    /var DASHBOARD_SEARCH_DEBOUNCE_MS\s*=\s*220;/,
    `${file} must keep server search debounce short while local index handles instant results`
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
    /action=dashboardSearchIndex/,
    `${file} must prefetch a compact global search index for instant search results`
  );

  assert.match(
    html,
    /var DASHBOARD_SEARCH_INDEX_LOCAL_KEY\s*=\s*['"]dashboardSearchIndex_v7['"]/,
    `${file} must invalidate search-index caches that omitted equipment summaries`
  );

  assert.match(
    html,
    /var DASHBOARD_SEARCH_INDEX_PACKED_COLUMNS\s*=\s*\['tid',\s*'n',\s*'tel',\s*'co',\s*'cs',\s*'st',\s*'od',\s*'ot',\s*'rd',\s*'rt',\s*'eq',\s*'x'\]/,
    `${file} must know how to decode packed dashboard search index rows`
  );

  assert.match(
    html,
    /function expandPackedDashboardSearchIndexEntries\(data\)[\s\S]*var tokens\s*=\s*Array\.isArray\(data\.tokens\)[\s\S]*data\.tokenized[\s\S]*tokens\[tokenIndex\][\s\S]*join\(' '\)/,
    `${file} must expand tokenized packed search rows before local filtering`
  );

  assert.match(
    html,
    /entries:\s*expandPackedDashboardSearchIndexEntries\(data\)/,
    `${file} must keep the in-memory search index as decoded objects`
  );

  assert.match(
    html,
    /data:\s*persistedDashboardSearchIndexPayload\(data\)/,
    `${file} must persist the compact packed index payload instead of re-expanding it into localStorage`
  );

  assert.match(
    html,
    /function expandLocalDashboardSearchEquipments\(items\)[\s\S]*Array\.isArray\(item\)[\s\S]*scheduleId:\s*item\[0\][\s\S]*name:\s*item\[1\]/,
    `${file} must expand compact equipment arrays from the local search index`
  );

  assert.match(
    html,
    /equipments:\s*expandLocalDashboardSearchEquipments\(entry\.eq\)/,
    `${file} must render local search equipment summaries after compact payload decoding`
  );

  assert.match(
    html,
    /function renderDashboardSearchFromLocalIndex\(query\)/,
    `${file} must render search results from the local index before GAS responds`
  );

  assert.match(
    html,
    /function getDashboardSearchEntryScore\(entry,\s*terms\)[\s\S]*normalizeDashboardSearchIndexText\(entry\.n[\s\S]*getDashboardSearchEntryEquipmentText\(entry\)[\s\S]*name\.indexOf\(term\) === 0[\s\S]*haystack\.indexOf\(term\) >= 0/,
    `${file} must rank local customer-name matches ahead of broad equipment/status text matches`
  );

  assert.match(
    html,
    /var searchScore\s*=\s*getDashboardSearchEntryScore\(entry,\s*terms\)[\s\S]*searchScore:\s*searchScore[\s\S]*candidates\.sort\(function\(a,\s*b\)[\s\S]*a\.searchScore[\s\S]*return compareDashboardLocalSearchCandidates\(a,\s*b\)/,
    `${file} must apply local relevance scoring before date/time sorting`
  );

  assert.match(
    html,
    /renderDashboardSearchFromLocalIndex\(dashboardSearchQuery\)/,
    `${file} must try local instant search on every search input`
  );

  assert.match(
    html,
    /function clearDashboardSearchCaches\(\)[\s\S]*dashboardSearchIndexCache\s*=\s*null[\s\S]*localStorage\.removeItem\(DASHBOARD_SEARCH_INDEX_LOCAL_KEY\)/,
    `${file} refresh must be able to drop stale local global-search index data`
  );

  assert.match(
    html,
    /function refreshDashboardSearchResults\(\)[\s\S]*clearDashboardSearchCaches\(\)[\s\S]*loadDashboardSearchIndex\(true\)[\s\S]*loadDashboardGlobalSearch\(query,\s*\{ forceFresh:\s*true \}\)/,
    `${file} refresh while searching must fetch a fresh search index and fresh server summary`
  );

  assert.match(
    html,
    /function refreshData\(\)[\s\S]*if \(dashboardSearchQuery\) \{[\s\S]*refreshDashboardSearchResults\(\);[\s\S]*return;[\s\S]*\}[\s\S]*loadData\(true\)/,
    `${file} refresh must reload active global-search results instead of re-rendering stale search data`
  );

  assert.match(
    html,
    /function loadDashboardSearchDetails\(openGroupId\)/,
    `${file} must lazy-load full global search cards when a result group is opened`
  );

  assert.match(
    html,
    /var dashboardSearchDetailedGroups\s*=\s*\{\};/,
    `${file} must track which summary search groups already have full details`
  );

  assert.match(
    html,
    /detailGroup=' \+ encodeURIComponent\(groupLabel\)/,
    `${file} must request details only for the opened search group`
  );

  assert.match(
    html,
    /function mergeDashboardSearchDetails\(groupId,\s*detailData\)/,
    `${file} must merge partial search detail payloads into the existing summary results`
  );

  assert.match(
    html,
    /dashboardSearchCollapsedGroups\[groupId\]\s*=\s*false;[\s\S]{0,120}renderDashboardGlobalSearch\(dashboardGlobalSearchData\)[\s\S]{0,120}loadDashboardSearchDetails\(groupId\)/,
    `${file} must open summary search groups immediately while details load in the background`
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
    /function resetDashboardSearchCollapsedGroups\(data,\s*previousGroups\)/,
    `${file} must initialize global search groups as collapsed`
  );

  assert.match(
    html,
    /dashboardSearchCollapsedGroups\[groupId\]\s*=\s*previousGroups && previousGroups\[groupId\] === false \? false : true/,
    `${file} must collapse global search groups by default`
  );

  assert.match(
    html,
    /if \(options\.globalSearch && isCollapsed\) \{[\s\S]{0,180}return;/,
    `${file} must skip rendering collapsed search cards until the group is opened`
  );
});

console.log('dashboard global search static checks passed');
