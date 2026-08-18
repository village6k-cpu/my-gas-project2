const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

const redirects = new Map([
  ['docs/dashboard.html', 'https://today-dashboard-ten.vercel.app/schedule'],
  ['docs/timeline.html', 'https://today-dashboard-ten.vercel.app/schedule'],
  ['docs/manage.html', 'https://today-dashboard-ten.vercel.app/confirm'],
  ['docs/request.html', 'https://today-dashboard-ten.vercel.app/confirm'],
  ['apps/follow-up-dashboard/index.html', 'https://today-dashboard-ten.vercel.app/follow-ups'],
  ['apps/follow-up-dashboard/operations.html', 'https://today-dashboard-ten.vercel.app/operations'],
]);

test('every legacy operator page redirects before its body can call retired APIs', () => {
  for (const [file, replacement] of redirects) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const redirect = source.indexOf(`window.location.replace(${JSON.stringify(replacement)})`);
    const body = source.search(/<body(?:\s|>)/i);
    assert.notEqual(redirect, -1, `${file} must redirect to ${replacement}`);
    assert.ok(body === -1 || redirect < body, `${file} redirect must run before body code`);
    assert.doesNotMatch(source, /village2026|fetch\s*\(|XMLHttpRequest|\/api\/gas-proxy/i,
      `${file} must not retain the retired executable API client`);
  }
});

test('GAS page router no longer embeds unauthenticated schedule data', () => {
  const source = fs.readFileSync(path.join(root, 'sheetAPI.js'), 'utf8');
  const pageBranch = source.slice(source.indexOf('if (params.page)'), source.indexOf('return handleRequest(e);'));
  assert.match(pageBranch, /villageLegacyPageUrl_/);
  assert.doesNotMatch(pageBranch, /getDashboardData|getTimelineData|INITIAL_DATA|INITIAL_TIMELINE_DATA/);
});
