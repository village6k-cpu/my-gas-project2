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
    /if \(cachedData\)[\s\S]{0,260}renderTimelineData\(cachedData/,
    `${file} must render cached timeline data immediately, even while a forced refresh runs in the background`
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
});

assert.match(
  backend,
  /function readTimelineScheduleRows_\([\s\S]*getRange\(2,\s*1,\s*lastRow - 1,\s*12\)\.getValues\(\)[\s\S]*checkoutKey[\s\S]*checkinKey/,
  'getTimelineData must keep range filtering inside a bounded row reader'
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
  /return \{\s*compact:\s*true,[\s\S]{0,260}compactLevel:\s*compactOptions\.compactLevel[\s\S]{0,260}items:\s*itemList\.map\(function\(item\)/,
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
  /function getTimelineContractMapForIds_\(contractSheet,\s*tradeIds\)[\s\S]*getRange\(2,\s*1,\s*rowCount,\s*1\)\.getDisplayValues\(\)[\s\S]*readDashboardScheduleRowsDisplay_\(contractSheet,\s*rowsToRead,\s*3\)/,
  'timeline contract lookup must scan IDs first and read only matched 계약마스터 rows'
);

assert.match(
  backend,
  /getTimelineContractMapForIds_\(contractSheet,\s*timelineTradeIdList\)/,
  'buildTimelineData_ must defer 계약마스터 reads until visible timeline trade IDs are known'
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
