const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

['dashboard.html', 'docs/dashboard.html'].forEach((file) => {
  const html = read(file);

  assert.match(
    html,
    /function appendDashboardPhotoToStore\(tid,\s*phase,\s*photo\)/,
    `${file} must append uploaded photos to the local photo store immediately`
  );

  assert.match(
    html,
    /uploadedPhotos\.push\(\{ phase: phase, photo: res\.photo \}\)/,
    `${file} must keep upload responses instead of discarding returned photo metadata`
  );

  assert.match(
    html,
    /appendDashboardPhotoToStore\(tid,\s*entry\.phase,\s*entry\.photo\)/,
    `${file} must render successful uploads without re-fetching Drive/Sheets`
  );

  assert.match(
    html,
    /dashboardPhotoStore\[tid\][\s\S]{0,500}mergePhotoList_\(merged\.checkout,\s*storePhotos\.checkout\)/,
    `${file} gallery modal must read dashboardPhotoStore before falling back to dashboardData`
  );

  assert.doesNotMatch(
    html,
    /delete dashboardPhotoStore\[tid\];[\s\S]{0,260}fetchDashboardPhotosBatch\(\[tid\]\)/,
    `${file} upload success path must not discard local photos and re-fetch`
  );
});

console.log('dashboard photo static checks passed');
