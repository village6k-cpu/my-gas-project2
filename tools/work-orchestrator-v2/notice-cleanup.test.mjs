import assert from 'node:assert/strict';
import test from 'node:test';

import { runNoticeCleanupSweep } from './notice-cleanup.mjs';

const NOW = '2026-08-31T06:00:00.000Z';
const RECEIPT_ID = '11111111-1111-4111-8111-111111111111';
const CLEANUP_TOKEN = '22222222-2222-4222-8222-222222222222';

function claimedReceipt(overrides = {}) {
  return {
    id: RECEIPT_ID,
    cleanup_state: 'pending',
    cleanup_attempts: 1,
    cleanup_token: CLEANUP_TOKEN,
    coordinate_status: 'valid',
    slack_channel_id: 'CNOTICE',
    slack_message_ts: '123.45',
    ...overrides
  };
}

function fakeStore(rows) {
  const calls = { claim: [], deleted: [], failed: [] };
  return {
    calls,
    async claimCleanupBatch(input) {
      calls.claim.push(input);
      return rows;
    },
    async markCleanupDeleted(input) {
      calls.deleted.push(input);
      return { applied: true, row: { id: input.id, cleanup_state: 'deleted' } };
    },
    async markCleanupFailed(input) {
      calls.failed.push(input);
      return { applied: true, row: { id: input.id, cleanup_state: 'failed' } };
    }
  };
}

function config(overrides = {}) {
  return {
    botUserId: 'UBOT',
    botId: 'BAPP',
    teamId: 'TTEAM',
    cleanupOwner: 'bridge:notice-cleanup',
    cleanupLeaseSeconds: 120,
    ...overrides
  };
}

function botIdentity(overrides = {}) {
  return { userId: 'UBOT', botId: 'BAPP', teamId: 'TTEAM', ...overrides };
}

test('ordinary notice stays untouched until a delivered digest snapshot contains its linked work outcome', async () => {
  const store = fakeStore([]);
  let deletes = 0;
  const result = await runNoticeCleanupSweep({
    store,
    slack: {
      async authTest() { return botIdentity(); },
      async deleteMessage() { deletes += 1; return { status: 'deleted' }; }
    },
    config: config(),
    now: NOW
  });

  assert.deepEqual(result, {
    claimed: 0, deleted: 0, alreadyAbsent: 0, failed: 0, blockedP0: 0, excluded: 0
  });
  assert.equal(deletes, 0);
  assert.deepEqual(store.calls.claim, [{
    now: NOW, cleanupOwner: 'bridge:notice-cleanup', leaseSeconds: 120, limit: 25
  }]);
});

test('auto-processed notice is deleted only after cleanup_after made it claimable', async () => {
  const beforeStore = fakeStore([]);
  const afterStore = fakeStore([claimedReceipt()]);
  const deletedCoordinates = [];
  const slack = {
    async authTest() { return botIdentity(); },
    async deleteMessage(coordinate) {
      deletedCoordinates.push(coordinate);
      return { status: 'deleted' };
    }
  };

  const before = await runNoticeCleanupSweep({ store: beforeStore, slack, config: config(), now: NOW });
  const after = await runNoticeCleanupSweep({ store: afterStore, slack, config: config(), now: NOW });

  assert.equal(before.deleted, 0);
  assert.equal(after.deleted, 1);
  assert.deepEqual(deletedCoordinates, [{ channel: 'CNOTICE', ts: '123.45' }]);
  assert.deepEqual(afterStore.calls.deleted, [{
    id: RECEIPT_ID,
    cleanupOwner: 'bridge:notice-cleanup',
    cleanupToken: CLEANUP_TOKEN,
    expectedCleanupAttempts: 1,
    alreadyAbsent: false
  }]);
});

test('unacknowledged P0 is counted as blocked and never reaches Slack deletion', async () => {
  const store = fakeStore([claimedReceipt({
    cleanup_state: 'blocked_p0', cleanup_attempts: 0, cleanup_token: null,
    slack_channel_id: null, slack_message_ts: null
  })]);
  let deletes = 0;
  const result = await runNoticeCleanupSweep({
    store,
    slack: {
      async authTest() { return botIdentity(); },
      async deleteMessage() { deletes += 1; return { status: 'deleted' }; }
    },
    config: config(),
    now: NOW
  });

  assert.equal(result.blockedP0, 1);
  assert.equal(result.claimed, 0);
  assert.equal(deletes, 0);
  assert.equal(store.calls.deleted.length, 0);
  assert.equal(store.calls.failed.length, 0);
});

test('missing coordinates become a failed audit without any broad Slack search', async () => {
  const store = fakeStore([claimedReceipt({
    coordinate_status: 'missing_coordinates', slack_channel_id: null, slack_message_ts: null
  })]);
  let deletes = 0;
  const slack = {
    async authTest() { return botIdentity(); },
    async deleteMessage() { deletes += 1; return { status: 'deleted' }; },
    async findMessageByClientId() { throw new Error('broad search must not run'); }
  };

  const result = await runNoticeCleanupSweep({ store, slack, config: config(), now: NOW });

  assert.equal(result.failed, 1);
  assert.equal(deletes, 0);
  assert.deepEqual(store.calls.failed, [{
    id: RECEIPT_ID,
    cleanupOwner: 'bridge:notice-cleanup',
    cleanupToken: CLEANUP_TOKEN,
    expectedCleanupAttempts: 1,
    error: 'missing_coordinates'
  }]);
});

test('auth.test must match the configured user, bot, and team before any exact delete', async () => {
  for (const mismatch of [
    { userId: 'UOTHER' },
    { botId: 'BOTHER' },
    { teamId: 'TOTHER' }
  ]) {
    const store = fakeStore([claimedReceipt()]);
    let deletes = 0;
    const result = await runNoticeCleanupSweep({
      store,
      slack: {
        async authTest() { return botIdentity(mismatch); },
        async deleteMessage() { deletes += 1; return { status: 'deleted' }; }
      },
      config: config(),
      now: NOW
    });

    assert.equal(result.excluded, 1);
    assert.equal(deletes, 0);
    assert.deepEqual(store.calls.failed, [{
      id: RECEIPT_ID,
      cleanupOwner: 'bridge:notice-cleanup',
      cleanupToken: CLEANUP_TOKEN,
      expectedCleanupAttempts: 1,
      error: 'bot_identity_mismatch'
    }]);
  }
});

test('cleanup config requires the complete content-free Slack bot identity', async () => {
  const secret = 'xoxb-review-secret';
  for (const missing of ['botUserId', 'botId', 'teamId']) {
    const input = config({ [missing]: undefined, token: secret });
    await assert.rejects(
      runNoticeCleanupSweep({
        store: fakeStore([]),
        slack: { async authTest() { return botIdentity(); }, async deleteMessage() {} },
        config: input,
        now: NOW
      }),
      (error) => error.message === 'notice cleanup input is invalid' && !error.message.includes(secret)
    );
  }
});

test('message_not_found settles the exact receipt as deleted and already absent', async () => {
  const store = fakeStore([claimedReceipt()]);
  const result = await runNoticeCleanupSweep({
    store,
    slack: {
      async authTest() { return botIdentity(); },
      async deleteMessage() { return { status: 'already_absent' }; }
    },
    config: config(),
    now: NOW
  });

  assert.equal(result.alreadyAbsent, 1);
  assert.equal(result.deleted, 0);
  assert.deepEqual(store.calls.deleted, [{
    id: RECEIPT_ID,
    cleanupOwner: 'bridge:notice-cleanup',
    cleanupToken: CLEANUP_TOKEN,
    expectedCleanupAttempts: 1,
    alreadyAbsent: true
  }]);
});

test('cant_delete_message remains failed and never falls back to another deletion surface', async () => {
  const store = fakeStore([claimedReceipt()]);
  let deletes = 0;
  const error = Object.assign(new Error('Slack chat.delete failed'), { code: 'cant_delete_message' });
  const result = await runNoticeCleanupSweep({
    store,
    slack: {
      async authTest() { return botIdentity(); },
      async deleteMessage() { deletes += 1; throw error; },
      async adminDeleteMessage() { throw new Error('admin fallback must not run'); },
      async findMessageByClientId() { throw new Error('search fallback must not run'); }
    },
    config: config(),
    now: NOW
  });

  assert.equal(result.failed, 1);
  assert.equal(deletes, 1);
  assert.deepEqual(store.calls.failed, [{
    id: RECEIPT_ID,
    cleanupOwner: 'bridge:notice-cleanup',
    cleanupToken: CLEANUP_TOKEN,
    expectedCleanupAttempts: 1,
    error: 'cant_delete_message'
  }]);
  assert.equal(store.calls.deleted.length, 0);
});
