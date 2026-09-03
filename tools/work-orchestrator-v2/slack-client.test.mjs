import assert from 'node:assert/strict';
import test from 'node:test';

import { createSlackClient, SlackApiError } from './slack-client.mjs';

const token = 'xoxb-test-token-must-not-leak';

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

test('postMessage sends the deterministic client ID and safe Slack options', async () => {
  const requests = [];
  const client = createSlackClient({
    token,
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return jsonResponse(200, { ok: true, channel: 'CINBOX', ts: '100.1', message: {} });
    }
  });

  const input = { channel: 'CINBOX', text: 'New request', blocks: [{ type: 'section' }], clientMsgId: '7d6ea8b8-8b02-4e1d-95cb-e12f2cfbf516' };
  assert.deepEqual(await client.postMessage(input), { ok: true, channel: 'CINBOX', ts: '100.1', message: {} });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://slack.com/api/chat.postMessage');
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    channel: 'CINBOX',
    text: 'New request',
    blocks: [{ type: 'section' }],
    client_msg_id: input.clientMsgId,
    reply_broadcast: false,
    unfurl_links: false,
    unfurl_media: false
  });
});

test('postMessage rejects malformed successful result coordinates and messages after one call', async (t) => {
  const valid = { ok: true, channel: 'CINBOX', ts: '100.1', message: {} };
  const cases = [
    ['missing channel', { ...valid, channel: undefined }],
    ['missing ts', { ...valid, ts: undefined }],
    ['invalid ts', { ...valid, ts: 'not-a-slack-timestamp' }],
    ['array message', { ...valid, message: [] }],
    ['scalar message', { ...valid, message: 'not-an-object' }]
  ];

  for (const [name, payload] of cases) {
    await t.test(name, async () => {
      let calls = 0;
      const client = createSlackClient({
        token,
        fetchImpl: async () => {
          calls += 1;
          return jsonResponse(200, payload);
        }
      });
      await assert.rejects(
        () => client.postMessage({ channel: 'CINBOX', text: 'x', clientMsgId: `malformed-${name}` }),
        (error) => error instanceof SlackApiError
          && error.kind === 'response'
          && error.code === 'malformed_response'
          && error.ambiguous === true
          && !error.message.includes(token)
      );
      assert.equal(calls, 1);
    });
  }
});

test('postMessage treats a transport failure as ambiguous without leaking the token', async () => {
  const client = createSlackClient({ token, fetchImpl: async () => { throw new Error(`network failed for ${token}`); } });

  await assert.rejects(
    () => client.postMessage({ channel: 'CINBOX', text: 'x', clientMsgId: 'client-1' }),
    (error) => error instanceof SlackApiError
      && error.kind === 'transport'
      && error.ambiguous === true
      && !error.message.includes(token)
  );
});

test('postMessage treats HTTP 5xx as ambiguous and bounds the API error code', async () => {
  const client = createSlackClient({
    token,
    fetchImpl: async () => jsonResponse(503, { ok: false, error: 'internal_error<untrusted-body>' })
  });

  await assert.rejects(
    () => client.postMessage({ channel: 'CINBOX', text: 'x', clientMsgId: 'client-2' }),
    (error) => error.status === 503
      && error.ambiguous === true
      && error.code === 'unknown'
      && /^[A-Za-z0-9 _().:-]{1,120}$/.test(error.message)
  );
});

test('postMessage treats a malformed successful response as ambiguous', async () => {
  const client = createSlackClient({
    token,
    fetchImpl: async () => new Response('{not valid json', { status: 200, headers: { 'content-type': 'application/json' } })
  });

  await assert.rejects(
    () => client.postMessage({ channel: 'CINBOX', text: 'x', clientMsgId: 'client-3' }),
    (error) => error.kind === 'response' && error.code === 'malformed_response' && error.ambiguous === true
  );
});

test('postMessage treats Slack fatal and internal errors as ambiguous', async (t) => {
  for (const code of ['fatal_error', 'internal_error']) {
    await t.test(code, async () => {
      const client = createSlackClient({ token, fetchImpl: async () => jsonResponse(200, { ok: false, error: code }) });
      await assert.rejects(
        () => client.postMessage({ channel: 'CINBOX', text: 'x', clientMsgId: `client-${code}` }),
        (error) => error.code === code && error.ambiguous === true
      );
    });
  }
});

test('postMessage treats HTTP 429 as non-ambiguous and bounds Retry-After', async () => {
  const client = createSlackClient({
    token,
    fetchImpl: async () => jsonResponse(429, { ok: false, error: 'ratelimited' }, { 'retry-after': '12' })
  });

  await assert.rejects(
    () => client.postMessage({ channel: 'CINBOX', text: 'x', clientMsgId: 'client-429' }),
    (error) => error.kind === 'rate_limit'
      && error.status === 429
      && error.code === 'ratelimited'
      && error.retryAfterSeconds === 12
      && error.ambiguous === false
      && !error.message.includes(token)
  );
});

test('postMessage preserves Retry-After zero and rejects unsafe retry bounds', async (t) => {
  for (const [header, expected] of [['0', 0], ['-1', null], ['1.5', null], ['not-a-number', null], ['999999', null]]) {
    await t.test(`Retry-After ${header}`, async () => {
      const client = createSlackClient({
        token,
        fetchImpl: async () => jsonResponse(429, { ok: false, error: 'ratelimited' }, { 'retry-after': header })
      });
      await assert.rejects(
        () => client.postMessage({ channel: 'CINBOX', text: 'x', clientMsgId: `retry-after-${header}` }),
        (error) => error.retryAfterSeconds === expected && error.ambiguous === false
      );
    });
  }
});

test('postMessage keeps HTTP 429 non-ambiguous when Slack returns a malformed body', async () => {
  const client = createSlackClient({
    token,
    fetchImpl: async () => new Response('{not valid json', { status: 429, headers: { 'content-type': 'application/json' } })
  });

  await assert.rejects(
    () => client.postMessage({ channel: 'CINBOX', text: 'x', clientMsgId: 'client-429-malformed' }),
    (error) => error.status === 429 && error.code === 'malformed_response' && error.ambiguous === false
  );
});

test('postMessage rejects an explicit safe 4xx response without ambiguity', async () => {
  const client = createSlackClient({ token, fetchImpl: async () => jsonResponse(400, { ok: false, error: 'channel_not_found' }) });

  await assert.rejects(
    () => client.postMessage({ channel: 'CINBOX', text: 'x', clientMsgId: 'client-4xx' }),
    (error) => error.status === 400 && error.code === 'channel_not_found' && error.ambiguous === false
  );
});

test('findMessageByClientId searches exact IDs through bounded cursor pages', async () => {
  const bodies = [];
  const client = createSlackClient({
    token,
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      if (body.cursor === '') {
        return jsonResponse(200, {
          ok: true,
          messages: [{ client_msg_id: 'client-15-extra', ts: '100.0' }],
          response_metadata: { next_cursor: 'page-2' }
        });
      }
      return jsonResponse(200, {
        ok: true,
        messages: [{ client_msg_id: 'client-15', ts: '100.1' }],
        response_metadata: { next_cursor: '' }
      });
    }
  });

  const result = await client.findMessageByClientId({ channel: 'CINBOX', clientMsgId: 'client-15', oldest: 100, latest: 101 });
  assert.equal(result.ts, '100.1');
  assert.deepEqual(bodies.map(({ cursor, limit, oldest, latest, inclusive }) => ({ cursor, limit, oldest, latest, inclusive })), [
    { cursor: '', limit: 200, oldest: '100', latest: '101', inclusive: true },
    { cursor: 'page-2', limit: 200, oldest: '100', latest: '101', inclusive: true }
  ]);
});

test('client validates required identifiers and positive time bounds before fetching', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return jsonResponse(200, { ok: true, messages: [] }); };

  assert.throws(() => createSlackClient({ token, fetchImpl, timeoutMs: 0 }), /timeout/i);
  const client = createSlackClient({ token, fetchImpl });
  await assert.rejects(() => client.postMessage({ channel: '', text: 'x', clientMsgId: 'client-6' }), /channel/i);
  await assert.rejects(() => client.postMessage({ channel: 'CINBOX', text: 'x', clientMsgId: '' }), /clientMsgId/i);
  await assert.rejects(() => client.findMessageByClientId({ channel: 'CINBOX', clientMsgId: 'client-6', oldest: 0, latest: 1 }), /oldest/i);
  await assert.rejects(() => client.findMessageByClientId({ channel: 'CINBOX', clientMsgId: 'client-6', oldest: 1, latest: Number.POSITIVE_INFINITY }), /latest/i);
  assert.equal(calls, 0);
});

test('findMessageByClientId reports typed history_incomplete when a page-eleven match remains beyond the finite cap', async () => {
  let pages = 0;
  const boundedClient = createSlackClient({
    token,
    fetchImpl: async () => {
      pages += 1;
      return jsonResponse(200, {
        ok: true,
        messages: pages === 11 ? [{ client_msg_id: 'client-7', ts: '100.11' }] : [],
        response_metadata: { next_cursor: `cursor-${pages}` }
      });
    }
  });
  await assert.rejects(
    () => boundedClient.findMessageByClientId({ channel: 'CINBOX', clientMsgId: 'client-7', oldest: 1, latest: 2 }),
    (error) => error instanceof SlackApiError && error.code === 'history_incomplete'
      && error.kind === 'response' && error.ambiguous === false
  );
  assert.equal(pages, 10);
});

test('findMessageByClientId rejects an oversized next cursor', async () => {
  let cursorCalls = 0;
  const cursorClient = createSlackClient({
    token,
    fetchImpl: async () => {
      cursorCalls += 1;
      return jsonResponse(200, { ok: true, messages: [], response_metadata: { next_cursor: 'x'.repeat(2001) } });
    }
  });
  await assert.rejects(
    () => cursorClient.findMessageByClientId({ channel: 'CINBOX', clientMsgId: 'client-8', oldest: 1, latest: 2 }),
    (error) => error instanceof SlackApiError && error.code === 'invalid_cursor'
  );
  assert.equal(cursorCalls, 1);
});

test('updateMessage validates exact coordinates and sends a bounded update payload', async () => {
  const requests = [];
  const client = createSlackClient({
    token,
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return jsonResponse(200, { ok: true, channel: 'CFOCUS', ts: '123.45', message: { text: 'updated' } });
    }
  });
  assert.equal(typeof client.updateMessage, 'function');
  assert.deepEqual(await client.updateMessage({
    channel: 'CFOCUS', ts: '123.45', text: 'updated', blocks: [{ type: 'section' }]
  }), { ok: true, channel: 'CFOCUS', ts: '123.45', message: { text: 'updated' } });
  assert.deepEqual(requests, [{
    url: 'https://slack.com/api/chat.update',
    body: { channel: 'CFOCUS', ts: '123.45', text: 'updated', blocks: [{ type: 'section' }] }
  }]);
});

test('deleteMessage maps only exact success and message_not_found to terminal outcomes', async (t) => {
  await t.test('deleted', async () => {
    const client = createSlackClient({
      token,
      fetchImpl: async (_url, init) => {
        assert.deepEqual(JSON.parse(init.body), { channel: 'CFOCUS', ts: '123.45' });
        return jsonResponse(200, { ok: true, channel: 'CFOCUS', ts: '123.45' });
      }
    });
    assert.equal(typeof client.deleteMessage, 'function');
    assert.deepEqual(await client.deleteMessage({ channel: 'CFOCUS', ts: '123.45' }), { status: 'deleted' });
  });
  await t.test('already absent', async () => {
    const client = createSlackClient({
      token,
      fetchImpl: async () => jsonResponse(200, { ok: false, error: 'message_not_found' })
    });
    assert.deepEqual(await client.deleteMessage({ channel: 'CFOCUS', ts: '123.45' }), { status: 'already_absent' });
  });
  await t.test('cant delete remains an error', async () => {
    const client = createSlackClient({
      token,
      fetchImpl: async () => jsonResponse(200, { ok: false, error: 'cant_delete_message' })
    });
    await assert.rejects(
      client.deleteMessage({ channel: 'CFOCUS', ts: '123.45' }),
      (error) => error instanceof SlackApiError && error.code === 'cant_delete_message'
    );
  });
  await t.test('HTTP failure cannot impersonate absence', async () => {
    const client = createSlackClient({
      token,
      fetchImpl: async () => jsonResponse(503, { ok: false, error: 'message_not_found' })
    });
    await assert.rejects(
      client.deleteMessage({ channel: 'CFOCUS', ts: '123.45' }),
      (error) => error instanceof SlackApiError && error.status === 503 && error.code === 'message_not_found'
    );
  });
});

test('update and delete reject malformed or mismatched successful coordinates generically', async (t) => {
  for (const [name, method, payload] of [
    ['update mismatch', 'updateMessage', { ok: true, channel: 'COTHER', ts: '123.45', message: {} }],
    ['update malformed message', 'updateMessage', { ok: true, channel: 'CFOCUS', ts: '123.45', message: [] }],
    ['delete mismatch', 'deleteMessage', { ok: true, channel: 'CFOCUS', ts: '999.1' }],
    ['delete missing coordinate', 'deleteMessage', { ok: true }]
  ]) {
    await t.test(name, async () => {
      const client = createSlackClient({ token, fetchImpl: async () => jsonResponse(200, payload) });
      const input = method === 'updateMessage'
        ? { channel: 'CFOCUS', ts: '123.45', text: 'x', blocks: [] }
        : { channel: 'CFOCUS', ts: '123.45' };
      await assert.rejects(
        client[method](input),
        (error) => error instanceof SlackApiError
          && error.code === 'malformed_response'
          && !error.message.includes(token)
      );
    });
  }
});

test('update and delete validate strict channel, timestamp, text, and blocks before fetch', async () => {
  let calls = 0;
  const client = createSlackClient({
    token,
    fetchImpl: async () => {
      calls += 1;
      return jsonResponse(200, { ok: true, channel: 'CFOCUS', ts: '1.1', message: {} });
    }
  });
  await assert.rejects(client.updateMessage({ channel: 'bad channel', ts: '1.1', text: 'x', blocks: [] }), /channel/i);
  await assert.rejects(client.updateMessage({ channel: 'CFOCUS', ts: 'bad', text: 'x', blocks: [] }), /timestamp/i);
  await assert.rejects(client.updateMessage({ channel: 'CFOCUS', ts: '1.1', text: '', blocks: [] }), /text/i);
  await assert.rejects(client.updateMessage({ channel: 'CFOCUS', ts: '1.1', text: 'x', blocks: {} }), /blocks/i);
  await assert.rejects(client.deleteMessage({ channel: 'CFOCUS', ts: 'bad' }), /timestamp/i);
  assert.equal(calls, 0);
});

test('authTest returns only the exact configured-token bot identity', async () => {
  const requests = [];
  const client = createSlackClient({
    token,
    fetchImpl: async (url, init) => {
      requests.push({ url, body: JSON.parse(init.body) });
      return jsonResponse(200, { ok: true, user_id: 'UBOT123', bot_id: 'BBOT123', team_id: 'TTEAM123' });
    }
  });

  assert.deepEqual(await client.authTest(), {
    userId: 'UBOT123', botId: 'BBOT123', teamId: 'TTEAM123'
  });
  assert.deepEqual(requests, [{ url: 'https://slack.com/api/auth.test', body: {} }]);
});

test('authTest rejects malformed or human-token identities without leaking response fields', async (t) => {
  for (const [name, payload] of [
    ['missing bot id', { ok: true, user_id: 'U123', team_id: 'T123' }],
    ['malformed user id', { ok: true, user_id: 'bad user', bot_id: 'B123', team_id: 'T123' }],
    ['extra content does not repair identity', { ok: true, user_id: 'U123', bot_id: '', team_id: 'T123', user: token }]
  ]) {
    await t.test(name, async () => {
      const client = createSlackClient({ token, fetchImpl: async () => jsonResponse(200, payload) });
      await assert.rejects(
        client.authTest(),
        (error) => error instanceof SlackApiError
          && error.code === 'malformed_response'
          && !error.message.includes(token)
      );
    });
  }
});
