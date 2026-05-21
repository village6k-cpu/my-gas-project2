const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

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
});

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
});

console.log('timeline performance static checks passed');
