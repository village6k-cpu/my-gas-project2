import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { selectAutomationDisplay, createBackgroundTarget, keepKakaoRoomInOwnedPage, openBackgroundPage } from './background-browser.mjs';

const bounds = { left: 640, top: 1111, width: 1280, height: 769 };
function fixture(overrides = {}) {
  const calls = [];
  const send = async (method, params) => {
    calls.push({ method, params });
    if (overrides[method]) return overrides[method](params);
    if (method === 'Target.getTargets') return { targetInfos: [{ targetId: 'user-tab', type: 'page', url: 'about:blank' }] };
    if (method === 'Target.createTarget') return { targetId: 'owned' };
    if (method === 'Browser.getWindowForTarget') return { windowId: 8, bounds: { ...bounds, windowState: 'normal' } };
    if (method === 'Target.closeTarget') return { success: true };
    throw Error('Unexpected command: ' + method);
  };
  return { calls, send, readDisplay: async () => bounds };
}

test('only the live named portable display is selected; portrait and stale/default bounds are never substituted', () => {
  assert.deepEqual(selectAutomationDisplay([{ name: 'LG FULL HD', left: -1080, top: 0, width: 1080, height: 1920 }, { name: '16MR70', ...bounds }]), bounds);
  assert.throws(() => selectAutomationDisplay([{ name: 'LG FULL HD', ...bounds }]), /unavailable/);
  assert.throws(() => selectAutomationDisplay([{ name: '16MR70', ...bounds }, { name: '16MR70', ...bounds }]), /ambiguous/);
  assert.throws(() => selectAutomationDisplay([{ name: '16MR70', ...bounds, height: 0 }]), /invalid/);
});

test('creation is background-only at verified bounds, with no activation or change to an existing window', async () => {
  const f = fixture();
  assert.deepEqual(await createBackgroundTarget({ ...f, url: 'about:blank' }), { targetId: 'owned', windowId: 8, bounds });
  assert.deepEqual(f.calls, [
    { method: 'Target.getTargets', params: {} },
    { method: 'Browser.getWindowForTarget', params: { targetId: 'user-tab' } },
    { method: 'Target.createTarget', params: { url: 'about:blank', newWindow: false, background: true, focus: false } },
    { method: 'Browser.getWindowForTarget', params: { targetId: 'owned' } }
  ]);
});

test('missing display and unsupported background mode never fall back to foreground creation', async () => {
  const f = fixture();
  await assert.rejects(createBackgroundTarget({ ...f, url: 'about:blank', readDisplay: async () => { throw Error('display missing'); } }), /display missing/);
  assert.deepEqual(f.calls, []);
  const unsupported = fixture({ 'Target.createTarget': () => { throw Error('background unsupported'); } });
  await assert.rejects(createBackgroundTarget({ ...unsupported, url: 'about:blank' }), /unsupported/);
  assert.equal(unsupported.calls.filter(c => c.method === 'Target.createTarget').length, 1);
});

test('placement in a different window closes only the newly acknowledged tab', async () => {
  const f = fixture({ 'Browser.getWindowForTarget': ({ targetId }) => ({ windowId: targetId === 'owned' ? 4 : 8, bounds: { ...bounds, windowState: 'normal' } }) });
  await assert.rejects(createBackgroundTarget({ ...f, url: 'about:blank' }), /did not open in the dedicated/);
  assert.deepEqual(f.calls.at(-1), { method: 'Target.closeTarget', params: { targetId: 'owned' } });
});

test('a misplaced existing automation window is rejected before opening a tab', async () => {
  const f = fixture({
    'Browser.getWindowForTarget': () => ({
      windowId: 8, bounds: { ...bounds, left: -1080, top: 0, windowState: 'normal' }
    })
  });
  await assert.rejects(createBackgroundTarget({ ...f, url: 'about:blank' }), /outside 16MR70/);
  assert.ok(!f.calls.some(c => c.method === 'Target.createTarget'));
});

test('a response naming an existing user target never permits closing it', async () => {
  const f = fixture({ 'Target.createTarget': () => ({ targetId: 'user-tab', type: 'page', url: 'about:blank' }) });
  await assert.rejects(createBackgroundTarget({ ...f, url: 'about:blank' }), /ownership/);
  assert.ok(!f.calls.some(c => c.method === 'Target.closeTarget'));
});

test('Kakao popup and popup.focus remain inside the owned page without native focus or a new window', () => {
  const navigations = [];
  let nativeOpen = 0, nativeFocus = 0;
  const location = { origin: 'https://business.kakao.com', pathname: '/space/x/channel/y/chats', assign: url => navigations.push(url) };
  const window = { location, open: () => nativeOpen++, focus: () => nativeFocus++ };
  vm.runInNewContext(`(${keepKakaoRoomInOwnedPage.toString()})()`, { window, location });
  const popup = window.open('/space/x/channel/y/chats/123456789', 'chat', 'popup');
  assert.equal(popup, window);
  popup.focus();
  assert.deepEqual(navigations, ['/space/x/channel/y/chats/123456789']);
  assert.equal(nativeOpen, 0); assert.equal(nativeFocus, 0);
});

test('popup override does not alter other sites or a customer conversation', () => {
  for (const location of [{ origin: 'https://example.com', pathname: '/chats' }, { origin: 'https://business.kakao.com', pathname: '/space/x/channel/y/chats/123456789' }]) {
    const original = () => {};
    const window = { open: original, focus: original };
    vm.runInNewContext(`(${keepKakaoRoomInOwnedPage.toString()})()`, { window, location });
    assert.equal(window.open, original);
  }
});

test('Playwright attaches only the acknowledged background target, installs the Kakao override before navigation, and detaches sessions', async () => {
  const f = fixture(), pageCalls = [];
  const user = { name: 'user' };
  const page = { addInitScript: async fn => pageCalls.push(['init', fn]), goto: async url => pageCalls.push(['goto', url]) };
  let browserDetached = false, targetDetached = false, created = false;
  const send = async (...args) => { const result = await f.send(...args); if (args[0] === 'Target.createTarget') created = true; return result; };
  const browser = { newBrowserCDPSession: async () => ({ send, detach: async () => { browserDetached = true; } }) };
  const context = { pages: () => created ? [user, page] : [user], newCDPSession: async p => {
    assert.equal(p, page); return { send: async () => ({ targetInfo: { targetId: 'owned' } }), detach: async () => { targetDetached = true; } };
  } };
  assert.equal(await openBackgroundPage(browser, context, 'https://business.kakao.com/space/x/channel/y/chats', { readDisplay: f.readDisplay }), page);
  assert.equal(pageCalls[0][0], 'init'); assert.equal(pageCalls[1][0], 'goto');
  assert.ok(browserDetached && targetDetached);
});
