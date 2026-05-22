const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const backend = read('checkAvailability.js');
const sheetApi = read('sheetAPI.js');

['docs/timeline.html', 'timelineMobile.html'].forEach((file) => {
  const html = read(file);

  assert.match(
    html,
    /var TIMELINE_CACHE_PREFIX\s*=\s*['"]timelineCache_v/,
    `${file} must keep a local timeline cache prefix`
  );

  assert.match(
    html,
    /function readTimelineLocalCache\(requestKey\)/,
    `${file} must read cached timeline data before waiting for GAS`
  );

  assert.match(
    html,
    /function writeTimelineLocalCache\(requestKey,\s*data\)/,
    `${file} must write successful timeline responses to local cache`
  );

  assert.match(
    html,
    /if \(cachedData\)[\s\S]{0,260}renderTimelineData\(cachedData[\s\S]{0,260}showLoading\(false\)/,
    `${file} must render cached timeline data and clear the startup loading overlay immediately`
  );

  assert.doesNotMatch(
    html,
    /if \(!opts\.silent\) showLoading\(false\)/,
    `${file} must clear a visible loading overlay even when a silent refresh wins the latest request`
  );

  assert.match(
    html,
    /if \(cachedData\)[\s\S]{0,260}renderTimelineData\(cachedData\)[\s\S]{0,120}showLoading\(false\)/,
    `${file} must clear the loading overlay as soon as cached timeline data renders`
  );

  assert.doesNotMatch(
    html,
    /if \(!opts\.silent\) showLoading\(false\)/,
    `${file} must always clear the loading overlay after timeline fetch settles`
  );

  assert.match(
    html,
    /function renderTimelineData\(data/,
    `${file} must centralize timeline response parsing so cache and network paths match`
  );

  assert.match(
    html,
    /function expandTimelineResponse\(data\)[\s\S]{0,260}data\.compact/,
    `${file} must expand compact timeline payloads before rendering`
  );

  assert.match(
    html,
    /action=timeline[\s\S]{0,220}&compact=2/,
    `${file} must request compact v2 timeline payloads from the API`
  );

  assert.match(
    html,
    /var TIMELINE_FETCH_TIMEOUT_MS\s*=\s*15000;/,
    `${file} must cap timeline loading so the spinner cannot stay forever`
  );

  assert.match(
    html,
    /setTimeout\(function\(\)[\s\S]{0,220}timelineAbortController\.abort\(\)/,
    `${file} must abort a stuck timeline fetch`
  );

  assert.match(
    html,
    /데이터 로드 시간 초과/,
    `${file} must tell the operator when timeline loading times out`
  );

  assert.doesNotMatch(
    html,
    /(\/\/ ── Init ──|\/\/ ━━━ 시작 ━━━)[\s\S]{0,180}loadEquip(?:Names|List)\(\);/,
    `${file} must not load the full equipment list during timeline startup`
  );

  assert.doesNotMatch(
    html,
    /loadData\(true\)/,
    `${file} must not show a blocking forced timeline reload during normal add/delete/refresh flows`
  );

  assert.match(
    html,
    /function openAddModal\([\s\S]{0,900}loadEquip(?:Names|List)\(\)\.then/,
    `${file} must load the equipment list lazily when the add-equipment modal opens`
  );
});

{
  const html = read('timelineMobile.html');

  assert.match(
    html,
    /var INITIAL_TIMELINE_DATA = null;/,
    'timelineMobile.html must accept GAS-inlined initial timeline data'
  );

  assert.match(
    html,
    /INITIAL_TIMELINE_DATA && INITIAL_TIMELINE_KEY === requestKey[\s\S]{0,260}writeTimelineLocalCache\(requestKey,\s*cachedData\)/,
    'timelineMobile.html must render and cache GAS-inlined initial data before fetching'
  );

  assert.match(
    html,
    /if \(usedInitialData && !forceFresh\)[\s\S]{0,160}return Promise\.resolve\(cachedData\)/,
    'timelineMobile.html must skip the duplicate first fetch when GAS already inlined timeline data'
  );
}

{
  const html = read('docs/timeline.html');

  assert.match(
    html,
    /function loadEquipNames\(\)[\s\S]{0,220}return Promise\.resolve\(equipNames\)/,
    'docs/timeline.html loadEquipNames must return a resolved promise when the equipment list is already cached'
  );

  assert.match(
    html,
    /return fetch\(API_URL \+ "\?key=village2026&action=read&sheet="[\s\S]{0,900}return equipNames;/,
    'docs/timeline.html loadEquipNames must return the fetch promise for lazy modal setup'
  );

  assert.match(
    html,
    /function openTimelineContract\(item\)[\s\S]{0,900}action=timelineContract/,
    'docs/timeline.html must fetch contract links lazily instead of loading every link in the timeline payload'
  );
}

['timeline.html'].forEach((file) => {
  const html = read(file);

  assert.match(
    html,
    /var TIMELINE_CACHE_PREFIX\s*=\s*['"]timelineCache_v/,
    `${file} must keep a local timeline cache prefix`
  );

  assert.match(
    html,
    /google\.script\.run[\s\S]{0,220}\.getTimelineData\(\{[\s\S]{0,160}from:/,
    `${file} must request a bounded timeline range instead of loading all schedule rows`
  );

  assert.match(
    html,
    /function expandTimelineResponse\(data\)[\s\S]{0,260}data\.compact/,
    `${file} must expand compact timeline payloads before rendering`
  );

  assert.match(
    html,
    /\.getTimelineData\(\{[\s\S]{0,220}compact:\s*2/,
    `${file} must request compact v2 timeline payloads through google.script.run`
  );

  assert.match(
    html,
    /var TIMELINE_FETCH_TIMEOUT_MS\s*=\s*15000;/,
    `${file} must cap GAS-served timeline loading so the spinner cannot stay forever`
  );

  assert.match(
    html,
    /if \(cachedData\)[\s\S]{0,220}renderTimelineData\(cachedData\)[\s\S]{0,120}showLoading\(false\)/,
    `${file} must clear the GAS-served loading overlay as soon as cached timeline data renders`
  );
});

assert.match(
  backend,
  /function readTimelineScheduleRows_\([\s\S]*getTimelineScheduleRowsForCache_\(schedSheet,\s*lastRow\)[\s\S]*checkoutKey[\s\S]*checkinKey/,
  'getTimelineData must keep range filtering inside the cached bounded row reader'
);

assert.match(
  backend,
  /function getTimelineScheduleRowsForCache_\(schedSheet,\s*lastRow\)[\s\S]*scheduleRows_v2_[\s\S]*getTimelineCacheText_\(cacheKey\)[\s\S]*putTimelineCacheText_\(cacheKey,\s*JSON\.stringify\(normalized\),\s*300\)/,
  'timeline schedule rows must be normalized once and reused through script cache'
);

assert.match(
  backend,
  /function normalizeTimelineScheduleRow_\(row\)[\s\S]*normalizeTimelineDateKey_\(row\[5\]\)[\s\S]*normalizeTimelineTimeValue_\(row\[6\]\)[\s\S]*normalizeTimelineDateKey_\(row\[7\]\)/,
  'timeline schedule row cache must normalize date/time values before JSON caching'
);

assert.match(
  backend,
  /function dashboardAddEquipments\([\s\S]*scheduleContractRegen\(tid\)[\s\S]{0,180}invalidateTimelineCache\(\)/,
  'timeline schedule row cache must be invalidated after dashboard equipment additions'
);

assert.match(
  backend,
  /function dashboardRemoveEquipment\([\s\S]*scheduleContractRegen\(tid\)[\s\S]{0,180}invalidateTimelineCache\(\)/,
  'timeline schedule row cache must be invalidated after dashboard equipment removals'
);

assert.match(
  backend,
  /var scheduleRows\s*=\s*readTimelineScheduleRows_\(schedSheet,\s*fromKey,\s*toKey\)/,
  'buildTimelineData_ must use the bounded timeline row reader'
);

assert.match(
  backend,
  /function compactTimelineItem_\(item,\s*options\)[\s\S]*var compactLevel[\s\S]*tid:\s*item\.거래ID[\s\S]*if \(compactLevel < 2\)[\s\S]*compact\.ret = item\.반납/,
  'timeline compact payload must keep v1 compatible fields while allowing slimmer v2 payloads'
);

assert.match(
  backend,
  /function compactTimelineItem_\(item,\s*options\)[\s\S]*else if \(item\.장비명 && item\.장비명 !== item\.세트명\)[\s\S]*compact\.eq = item\.장비명/,
  'timeline compact v2 must omit group-derived set/equipment names when the frontend can restore them'
);

assert.match(
  backend,
  /if \(options\.includeContractUrl !== false\)[\s\S]{0,180}getTradeExtrasForIds_\(timelineTradeIdList\)/,
  'timeline builds must skip contract-link reads when compact payloads do not include contract URLs'
);

assert.match(
  backend,
  /return finishTimelineBuild_\(\{\s*compact:\s*true,[\s\S]{0,260}compactLevel:\s*compactOptions\.compactLevel[\s\S]{0,260}items:\s*itemList\.map\(function\(item\)/,
  'getTimelineData must return compact timeline payloads at the requested compact level'
);

assert.match(
  backend,
  /function getTimelineContractLink\(tid\)[\s\S]{0,260}getTradeExtrasForIds_\(\[tid\]\)/,
  'timeline contract links must be available through a lazy single-trade lookup'
);

assert.match(
  sheetApi,
  /case "timeline"[\s\S]{0,520}compact:\s*params\.compact[\s\S]{0,160}all:\s*params\.all/,
  'sheetAPI timeline action must forward compact payload requests'
);

assert.match(
  sheetApi,
  /case "timeline"[\s\S]{0,760}profile:\s*params\.profile/,
  'sheetAPI timeline action must forward opt-in profile requests'
);

assert.match(
  backend,
  /function getTimelineData\(options\)[\s\S]{0,420}var profile = options\.profile/,
  'getTimelineData must support opt-in profiling for timeline bottleneck checks'
);

assert.match(
  backend,
  /if \(!profile\) \{[\s\S]{0,120}putTimelineCacheText_\(cacheKey,\s*JSON\.stringify\(result\),\s*300\)/,
  'timeline profile responses must not be written into the shared cache'
);

assert.match(
  backend,
  /function buildTimelineData_\(fromKey,\s*toKey,\s*options\)[\s\S]{0,1500}markTimelineBuildStep_\(['"]sheets_opened['"]\)/,
  'buildTimelineData_ must mark sheet-open timing when profile is enabled'
);

assert.match(
  backend,
  /markTimelineBuildStep_\(['"]schedule_rows['"],\s*\{[\s\S]{0,220}rowCount:\s*scheduleRows\.length[\s\S]{0,220}cacheHit:\s*scheduleRows\._cacheHit === true/,
  'buildTimelineData_ must report timeline schedule row count and cache hit in profile mode'
);

assert.match(
  backend,
  /if \(!fromKey && !toKey && !allowAllRange\)[\s\S]{0,180}getDefaultTimelineRange_\(\)/,
  'timeline API must avoid accidental all-range loads unless explicitly requested'
);

assert.match(
  backend,
  /function warmTimelineCache_\(\)[\s\S]*getDefaultTimelineRange_\(\)[\s\S]*getTimelineData\(\{ from:\s*range\.from,\s*to:\s*range\.to,\s*compact:\s*2 \}\)/,
  'dashboard warmer must keep the default compact v2 timeline range warm'
);

assert.match(
  backend,
  /function getInitialTimelineMobileRange_\(\)[\s\S]*- 2 \* 86400000[\s\S]*\+ 10 \* 86400000/,
  'timeline backend must know the GAS-served mobile initial fetch range'
);

assert.match(
  backend,
  /function warmTimelineCache_\(\)[\s\S]*getInitialTimelineMobileRange_\(\)[\s\S]*getTimelineData\(\{ from:\s*mobileRange\.from,\s*to:\s*mobileRange\.to,\s*compact:\s*2 \}\)/,
  'dashboard warmer must also warm the GAS-served mobile initial timeline range'
);

assert.match(
  sheetApi,
  /params\.page === "timeline"[\s\S]{0,620}getInitialTimelineMobileRange_\(\)[\s\S]{0,620}INITIAL_TIMELINE_DATA/,
  'GAS-served timeline page must inline initial timeline data'
);

assert.match(
  sheetApi,
  /case "timelineContract"[\s\S]{0,160}getTimelineContractLink/,
  'sheetAPI must expose the lazy timeline contract-link endpoint'
);

assert.match(
  sheetApi,
  /createTextOutput\(JSON\.stringify\(data\)\)/,
  'sheetAPI JSON responses must be minified to avoid wasting payload bytes'
);

assert.match(
  backend,
  /var stockMap\s*=\s*getTimelineStockMap_\(ss\)/,
  'buildTimelineData_ must use the cached timeline equipment stock map'
);

assert.match(
  backend,
  /function getTimelineStockMap_\(ss\)[\s\S]*getDashboardCachedJson_\("timeline_stock_map_v1",\s*300/,
  'timeline equipment stock lookup must use script cache'
);

assert.match(
  backend,
  /function getTimelineContractMapForIds_\(contractSheet,\s*tradeIds\)[\s\S]*getTimelineContractContactsForCache_\(contractSheet\)[\s\S]*contactMap\[tid\]/,
  'timeline contract lookup must reuse the cached 계약마스터 contact map'
);

assert.match(
  backend,
  /function getTimelineContractContactsForCache_\(contractSheet\)[\s\S]*contractContacts_v1_[\s\S]*getTimelineCacheText_\(cacheKey\)[\s\S]*getRange\(2,\s*1,\s*rowCount,\s*3\)\.getDisplayValues\(\)[\s\S]*putTimelineCacheText_\(cacheKey,\s*JSON\.stringify\(payload\),\s*300\)/,
  'timeline contract contacts must cache compact A:C data instead of scanning 계약마스터 every build'
);

assert.match(
  backend,
  /getTimelineContractMapForIds_\(contractSheet,\s*timelineTradeIdList\)/,
  'buildTimelineData_ must defer 계약마스터 reads until visible timeline trade IDs are known'
);

assert.match(
  backend,
  /markTimelineBuildStep_\(['"]contract_map['"],\s*\{[\s\S]{0,220}tradeCount:\s*timelineTradeIdList\.length[\s\S]{0,220}cacheHit:\s*contractMap\._cacheHit === true/,
  'timeline profile must report contract map cache hits'
);

const timelineBuildBody = backend.match(/function buildTimelineData_\([\s\S]*?\n}\n\nfunction getTimelineStockMap_/);
assert.ok(timelineBuildBody, 'buildTimelineData_ must exist before getTimelineStockMap_');
assert.doesNotMatch(
  timelineBuildBody[0],
  /equipSheet\.getRange\(2,\s*1,\s*equipSheet\.getLastRow\(\) - 1,\s*equipSheet\.getLastColumn\(\)\)\.getValues\(\)/,
  'buildTimelineData_ must not read all 장비마스터 columns on every timeline build'
);

assert.doesNotMatch(
  backend,
  /const data\s*=\s*schedSheet\.getRange\(2,\s*1,\s*schedSheet\.getLastRow\(\) - 1,\s*12\)\.getValues\(\)/,
  'buildTimelineData_ must not bypass the bounded timeline row reader'
);

console.log('timeline performance static checks passed');
