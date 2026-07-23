import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  isAllowedBridgeUrl,
  postBridgeEvent
} from '../tools/kakao-dom-watcher-extension/background.js';

test('background proxy accepts only loopback event endpoints', () => {
  assert.equal(isAllowedBridgeUrl('http://127.0.0.1:8787/events'), true);
  assert.equal(isAllowedBridgeUrl('http://localhost:8787/events'), true);
  assert.equal(isAllowedBridgeUrl('https://127.0.0.1:8787/events'), false);
  assert.equal(isAllowedBridgeUrl('http://127.0.0.1:8787/manual-send'), false);
  assert.equal(isAllowedBridgeUrl('http://example.com/events'), false);
});

test('background proxy posts a bridge event without exposing a dynamic remote destination', async () => {
  const calls = [];
  const result = await postBridgeEvent(
    'http://127.0.0.1:8787/events',
    { reason: 'content_script_started' },
    async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 202 };
    }
  );

  assert.deepEqual(result, { ok: true, status: 202 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:8787/events');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
});

test('watcher extension routes bridge traffic through its background service worker', async () => {
  const manifest = JSON.parse(
    await readFile(new URL('../tools/kakao-dom-watcher-extension/manifest.json', import.meta.url), 'utf8')
  );
  const content = await readFile(
    new URL('../tools/kakao-dom-watcher-extension/content.js', import.meta.url),
    'utf8'
  );

  assert.deepEqual(manifest.background, {
    service_worker: 'background.js',
    type: 'module'
  });
  assert.match(content, /chrome\.runtime\.sendMessage/);
  assert.doesNotMatch(content, /fetch\(STATE\.config\.bridgeUrl/);
});

test('watcher observes only real main-list chat rows and uses Kakao stable chat identity', async () => {
  const content = await readFile(
    new URL('../tools/kakao-dom-watcher-extension/content.js', import.meta.url),
    'utf8'
  );

  assert.match(
    content,
    /if \(!isKakaoMainChatListPage\(\)\)[\s\S]*return;/,
    'individual customer conversation pages must never emit watcher jobs'
  );
  assert.match(
    content,
    /\.ReactVirtualized__List\.list_board > \.ReactVirtualized__Grid__innerScrollContainer > li/,
    'row discovery must be anchored to the Kakao virtualized chat list'
  );
  assert.match(
    content,
    /input\[id\^="chat-select-"\]/,
    'room identity must use the stable Kakao chat id already present in the row'
  );
  assert.match(
    content,
    /return `chat:\$\{chatId\}`/,
    'room keys must remain stable when preview text, time, unread count, or row position changes'
  );
  assert.match(
    content,
    /querySelector\?\.\('\.txt_name'\)/,
    'customer identity must come from the dedicated Kakao name element'
  );
  assert.match(
    content,
    /customerName,/,
    'structured customer identity must reach the bridge and Hermes worker'
  );
  assert.doesNotMatch(
    content,
    /\? `toprow:\$\{hashText\(topRowText\)/,
    'top-row events must not create a new room whenever the message preview changes'
  );
});

test('CDP fallback injects into the main list only and can reach the loopback bridge', async () => {
  const injector = await readFile(
    new URL('../tools/kakao-dom-bridge/inject-watcher-cdp.py', import.meta.url),
    'utf8'
  );

  assert.match(injector, /re\.fullmatch\(r"\/_\[\^\/\]\+\/chats\/\?", parsed\.path\)/);
  assert.match(injector, /runtime\.sendMessage/);
  assert.match(injector, /127\.0\.0\.1.*localhost/);
  assert.match(injector, /url\.pathname !== '\/events'/);
});
