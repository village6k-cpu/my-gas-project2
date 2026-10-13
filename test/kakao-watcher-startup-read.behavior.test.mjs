import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

test('real watcher startup offers read rows to bounded bridge reconciliation without requiring a new mutation', async () => {
  class Row {
    innerText = '중요 테스트 고객 장비 추가해드리겠습니다 오후 4:10';
    textContent = this.innerText;
    closest() { return this; }
    getBoundingClientRect() { return { top: 100, left: 0, width: 300, height: 60 }; }
    getAttribute(name) { return name === 'data-chat-id' ? 'fixture-room' : ''; }
    querySelector(selector) {
      if (selector.includes('.txt_name')) return { textContent: '테스트 고객' };
      if (selector === '.txt_info') return { textContent: '장비 추가해드리겠습니다' };
      if (selector === '.txt_date') return { textContent: '오후 4:10' };
      return null;
    }
  }
  const row = new Row();
  const events = [];
  const timers = [];
  const document = {
    title: '테스트 채팅 목록', visibilityState: 'visible',
    documentElement: { dataset: {} }, body: {},
    querySelectorAll(selector) { return selector.includes('list_board') ? [row] : []; }
  };
  const context = {
    document, Element: Row, console, Date,
    location: { hostname: 'business.kakao.com', pathname: '/_test/chats',
      href: 'https://business.kakao.com/_test/chats', origin: 'https://business.kakao.com' },
    navigator: { userAgent: 'test' },
    MutationObserver: class { observe() {} disconnect() {} },
    getComputedStyle() { return { visibility: 'visible', display: 'block' }; },
    addEventListener() {},
    setTimeout(callback, ms) { timers.push({ callback, ms }); return timers.length; },
    setInterval() { return 1; }, clearTimeout() {}, clearInterval() {},
    chrome: {
      storage: { sync: { get(defaults, callback) { callback(defaults); } }, onChanged: { addListener() {} } },
      runtime: { id: 'fixture-extension', async sendMessage(message) { events.push(message.event); return { ok: true }; } }
    }
  };
  context.window = context;
  const source = await readFile(new URL('../tools/kakao-dom-watcher-extension/content.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, context);
  await Promise.resolve();
  await Promise.resolve();
  const scan = timers.find(timer => timer.ms === 3000);
  assert.ok(scan, 'startup scan scheduled');
  scan.callback();
  await Promise.resolve();
  const offered = events.filter(event => event.reason === 'initial_scan');
  assert.equal(offered.length, 1, 'read staff reply must reach the bridge once at startup');
  assert.equal(offered[0].roomKey, 'chat:fixture-room');
  assert.equal(offered[0].unreadCount, null);
  assert.match(offered[0].previewText, /추가해드리겠습니다/);
});
