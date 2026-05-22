const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const backend = read('checkAvailability.js');

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
    /if \(cachedData && !forceFresh\)[\s\S]{0,260}renderTimelineData\(cachedData/,
    `${file} must render cached timeline data immediately on repeat visits`
  );

  assert.match(
    html,
    /function renderTimelineData\(data/,
    `${file} must centralize timeline response parsing so cache and network paths match`
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

assert.doesNotMatch(
  backend,
  /const data\s*=\s*schedSheet\.getRange\(2,\s*1,\s*schedSheet\.getLastRow\(\) - 1,\s*12\)\.getValues\(\)/,
  'buildTimelineData_ must not bypass the bounded timeline row reader'
);

console.log('timeline performance static checks passed');
