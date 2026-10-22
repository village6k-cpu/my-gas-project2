'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../supabaseSync.js'), 'utf8');

function run(options = {}) {
  const values = { SUPA_TOKEN: 'old-expired-token', SUPA_TOKEN_EXP: '1' };
  const calls = [];
  const c = { Date, Logger: { log() {} },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: key => values[key],
      setProperty(key, value) {
        calls.push(key);
        if (key === options.failKey) {
          if (options.rawError !== undefined) throw options.rawError;
          throw new Error(options.error || 'You have exceeded the property storage quota. Please remove some properties and try again.');
        }
        values[key] = value;
      }
    }) },
    UrlFetchApp: { fetch(url, args) {
      assert.equal(url, 'https://example.invalid/auth/v1/token?grant_type=password');
      assert.equal(args.method, 'post');
      return { getResponseCode: () => options.status || 200,
        getContentText: () => JSON.stringify({ access_token: 'fresh-valid-token', expires_in: 3600 }) };
    } }
  };
  vm.runInNewContext(source, c);
  const invoke = () => c.supaToken_({ url: 'https://example.invalid', apikey: 'fixture', botEmail: 'fixture', botPassword: 'fixture' });
  return { invoke, calls, values };
}

test('fresh successful login remains usable when the optional token cache is full without extending the old token expiry', () => {
  const h = run({ failKey: 'SUPA_TOKEN' });
  assert.equal(h.invoke(), 'fresh-valid-token');
  assert.deepEqual(h.calls, ['SUPA_TOKEN']);
  assert.equal(h.values.SUPA_TOKEN, 'old-expired-token');
  assert.equal(h.values.SUPA_TOKEN_EXP, '1');
});

test('expiry cache quota preserves the fresh token result and does not claim a cached lifetime', () => {
  const h = run({ failKey: 'SUPA_TOKEN_EXP' });
  assert.equal(h.invoke(), 'fresh-valid-token');
  assert.equal(h.values.SUPA_TOKEN, 'fresh-valid-token');
  assert.equal(h.values.SUPA_TOKEN_EXP, '1');
});

test('unrelated property failures remain visible and failed login never creates a usable token', () => {
  const h = run({ failKey: 'SUPA_TOKEN', error: 'permission unavailable' });
  assert.throws(h.invoke, /permission unavailable/);
  const denied = run({ status: 401 });
  assert.equal(denied.invoke(), null);
  assert.equal(denied.calls.length, 0);
});

test('normal login still persists both token and expiry for subsequent calls', () => {
  const h = run();
  assert.equal(h.invoke(), 'fresh-valid-token');
  assert.equal(h.invoke(), 'fresh-valid-token');
  assert.deepEqual(h.calls, ['SUPA_TOKEN', 'SUPA_TOKEN_EXP']);
});

const koreanQuota = '속성 저장용량 한도를 초과했습니다. 일부 속성을 삭제하고 다시 시도해 보세요.';
for (const failKey of ['SUPA_TOKEN', 'SUPA_TOKEN_EXP']) {
  for (const form of ['message', 'string', 'string-fallback']) test('observed Korean storage quota preserves fresh login and write order: ' + failKey + '/' + form, () => {
    const failure = form === 'message' ? { error: koreanQuota }
      : { rawError: form === 'string' ? koreanQuota : { message: '', toString: () => 'Exception: ' + koreanQuota } };
    const h = run({ failKey, ...failure });
    assert.equal(h.invoke(), 'fresh-valid-token');assert.equal(h.values.SUPA_TOKEN_EXP, '1');
    assert.deepEqual(h.calls, failKey === 'SUPA_TOKEN' ? ['SUPA_TOKEN'] : ['SUPA_TOKEN', 'SUPA_TOKEN_EXP']);
    assert.equal(h.values.SUPA_TOKEN, failKey === 'SUPA_TOKEN' ? 'old-expired-token' : 'fresh-valid-token');
  });
}

test('English thrown string is classified without broadening to unrelated quotas or argument size errors', () => {
  const h = run({ failKey: 'SUPA_TOKEN', rawError: 'You have exceeded the property storage quota.' });
  assert.equal(h.invoke(), 'fresh-valid-token');
  for (const error of ['Argument too large', 'LIMIT_EXCEEDED', 'Service invoked too many times: PropertiesService', 'Drive storage quota exceeded', '속성 읽기 권한이 없습니다', '일일 속성 호출 한도를 초과했습니다']) {
    assert.throws(run({ failKey: 'SUPA_TOKEN', error }).invoke, value => value.message === error);
  }
});
