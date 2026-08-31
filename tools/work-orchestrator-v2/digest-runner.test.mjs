import assert from 'node:assert/strict';
import test from 'node:test';

const runnerModule = await import('./digest-runner.mjs').catch(() => ({}));
const {
  canonicalDigestPayloadHash,
  digestScheduleWindow,
  runDigestCycle
} = runnerModule;

const NOW = '2026-08-29T06:25:00.000Z';
const SCHEDULED = '2026-08-29T06:00:00.000Z';
const RUN_ID = '10000000-0000-4000-8000-000000000001';
const PREVIOUS_ID = '10000000-0000-4000-8000-000000000002';

function uuid(number) {
  return `20000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
}

function workItem(number = 1, overrides = {}) {
  return {
    id: uuid(number),
    work_key: `work:${number}`,
    room_key: `room:${number}`,
    title: `Work ${number}`,
    summary: `Review item ${number}`,
    work_type: 'human_review',
    priority: 'normal',
    state: 'open',
    owner_id: null,
    actionable_at: '2026-08-29T00:00:00.000Z',
    due_at: null,
    snoozed_until: null,
    first_opened_at: '2026-08-28T00:00:00.000Z',
    last_activity_at: '2026-08-29T00:00:00.000Z',
    digest_inclusion_count: 0,
    consecutive_unhandled_digests: 0,
    last_digest_at: null,
    next_reminder_at: null,
    version: 1,
    payload: { requires_human_action: true },
    ...overrides
  };
}

function priorPart(number, overrides = {}) {
  return {
    id: `30000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
    part_kind: number === 1 ? 'ordinary' : 'daily_reminder',
    part_number: 1,
    part_count: 1,
    slack_channel_id: 'COLD',
    slack_message_ts: `100.${number}`,
    ...overrides
  };
}

function config(overrides = {}) {
  return {
    channelId: 'CFOCUS',
    destinationKey: 'slack:CFOCUS',
    intervalMinutes: 180,
    leaseSeconds: 120,
    cleanupEnabled: false,
    cleanupLeaseSeconds: 120,
    reconcileWindowSeconds: 300,
    ownerSlackIds: {},
    ...overrides
  };
}

class FakeStore {
  constructor({ items = [], previousParts = [], claim = true, eligibleCount = items.length } = {}) {
    this.items = structuredClone(items);
    this.eligibleCount = eligibleCount;
    this.previous = previousParts.length ? { id: PREVIOUS_ID, parts: structuredClone(previousParts) } : null;
    this.claimAvailable = claim;
    this.run = null;
    this.parts = [];
    this.calls = [];
    this.prepared = false;
    this.finalized = false;
    this.failures = [];
    this.cleanup = new Map();
    this.leaseGeneration = 0;
    this.digestGeneration = 1;
    this.retiredRuns = [];
    this.divergentRuns = [];
  }

  async claimDigestRun(input) {
    this.calls.push(['claimDigestRun', structuredClone(input)]);
    if (this.claimAvailable && this.run?.state === 'diverged') {
      this.divergentRuns.push({
        run: structuredClone(this.run),
        parts: structuredClone(this.parts),
        previous: structuredClone(this.previous)
      });
      this.digestGeneration += 1;
      this.run = null;
      this.parts = [];
      this.prepared = false;
      this.finalized = false;
    }
    if (!this.claimAvailable || this.run?.state === 'delivered') {
      return { claimed: false, created: false, row: this.run, previous_digest: this.previous };
    }
    this.claimAvailable = false;
    this.leaseGeneration += 1;
    const leaseToken = `40000000-0000-4000-8000-${String(this.leaseGeneration).padStart(12, '0')}`;
    if (!this.run) {
      const runId = this.digestGeneration === 1
        ? RUN_ID
        : `10000000-0000-4000-8000-${String(100 + this.digestGeneration).padStart(12, '0')}`;
      this.run = {
        id: runId,
        generation: this.digestGeneration,
        state: 'building',
        scheduled_at: input.scheduledAt,
        lease_token: leaseToken,
        item_snapshot: [],
        manifest_prepared_at: null
      };
    } else {
      this.run.state = this.parts.length ? 'delivering' : 'building';
      this.run.lease_token = leaseToken;
    }
    return { claimed: true, created: this.leaseGeneration === 1, row: structuredClone(this.run), previous_digest: structuredClone(this.previous) };
  }

  async listActionableWork(input) {
    this.calls.push(['listActionableWork', structuredClone(input)]);
    const rows = structuredClone(this.items);
    Object.defineProperty(rows, 'eligibleCount', { value: this.eligibleCount, enumerable: false });
    return rows;
  }

  async prepareDigestParts(input) {
    this.calls.push(['prepareDigestParts', structuredClone(input)]);
    if (!this.prepared) {
      this.prepared = true;
      this.run.item_snapshot = structuredClone(input.itemSnapshot);
      this.run.manifest_prepared_at = SCHEDULED;
      this.run.state = 'delivering';
      this.parts = input.parts.map((part, index) => {
        const identity = ((this.digestGeneration - 1) * 100) + index + 1;
        return {
        id: `50000000-0000-4000-8000-${String(identity).padStart(12, '0')}`,
        digest_run_id: this.run.id,
        part_kind: part.kind,
        part_number: part.partNumber,
        part_count: part.partCount,
        item_ids: [...part.itemIds],
        payload_hash: part.payloadHash,
        client_message_id: `60000000-0000-4000-8000-${String(identity).padStart(12, '0')}`,
        delivery_state: 'planned',
        delivery_attempts: 0,
        delivery_claimed_at: null,
        delivery_retry_at: null,
        slack_channel_id: null,
        slack_message_ts: null,
        delivered_at: null,
        cleanup_state: 'idle',
        cleanup_attempts: 0
      };
      });
      return { applied: true, created: true, row: structuredClone(this.run), parts: structuredClone(this.parts) };
    }
    const existingIntent = this.parts.map((part) => ({
      kind: part.part_kind,
      partNumber: part.part_number,
      partCount: part.part_count,
      itemIds: part.item_ids,
      payloadHash: part.payload_hash
    }));
    const requestedIntent = input.parts.map(({ kind, partNumber, partCount, itemIds, payloadHash }) => ({
      kind, partNumber, partCount, itemIds, payloadHash
    }));
    if (JSON.stringify(input.itemSnapshot) !== JSON.stringify(this.run.item_snapshot)
      || JSON.stringify(requestedIntent) !== JSON.stringify(existingIntent)) {
      return {
        applied: false,
        created: false,
        reason: 'manifest_mismatch',
        row: structuredClone(this.run),
        parts: structuredClone(this.parts)
      };
    }
    return { applied: true, created: false, row: structuredClone(this.run), parts: structuredClone(this.parts) };
  }

  async claimDigestPartDelivery(input) {
    this.calls.push(['claimDigestPartDelivery', structuredClone(input)]);
    const part = this.parts.find(({ id }) => id === input.partId);
    if (part.delivery_state === 'failed' && part.delivery_error === 'rate_limited'
      && Date.parse(part.delivery_retry_at) > Date.parse(this.claimNow || NOW)) {
      return { claimed: false, row: structuredClone(part) };
    }
    if (part.delivery_state === 'planned' || part.delivery_state === 'failed') {
      part.delivery_state = 'delivering';
      part.delivery_attempts += 1;
      part.delivery_claimed_at = SCHEDULED;
      part.delivery_retry_at = null;
      part.delivery_error = null;
      return { claimed: true, row: structuredClone(part) };
    }
    return { claimed: false, row: structuredClone(part) };
  }

  async markDigestPartDelivered(input) {
    this.calls.push(['markDigestPartDelivered', structuredClone(input)]);
    const part = this.parts.find(({ id }) => id === input.partId);
    if (part.delivery_state !== 'delivering' || part.delivery_attempts !== input.expectedDeliveryAttempts) {
      return { applied: false, row: null };
    }
    part.delivery_state = 'delivered';
    part.slack_channel_id = input.channelId;
    part.slack_message_ts = input.messageTs;
    part.delivered_at = input.deliveredAt;
    return { applied: true, row: structuredClone(part) };
  }

  async markDigestPartFailed(input) {
    this.calls.push(['markDigestPartFailed', structuredClone(input)]);
    const part = this.parts.find(({ id }) => id === input.partId);
    if (part.delivery_state !== 'delivering' || part.delivery_attempts !== input.expectedDeliveryAttempts) {
      return { applied: false, row: null };
    }
    part.delivery_state = 'failed';
    part.delivery_error = input.error;
    part.delivery_retry_at = input.retryAt;
    return { applied: true, row: structuredClone(part) };
  }

  async finalizeDigestRun(input) {
    this.calls.push(['finalizeDigestRun', structuredClone(input)]);
    if (this.parts.some(({ delivery_state }) => delivery_state !== 'delivered')) {
      return { applied: false, row: null, updated_count: 0 };
    }
    this.finalized = true;
    this.run.state = 'delivered';
    return { applied: true, row: structuredClone(this.run), updated_count: this.run.item_snapshot.length };
  }

  async failDigestRun(input) {
    this.calls.push(['failDigestRun', structuredClone(input)]);
    this.failures.push(input.error);
    this.run.state = 'failed';
    this.claimAvailable = true;
    return { applied: true, row: structuredClone(this.run) };
  }

  async markDigestGenerationDiverged(input) {
    this.calls.push(['markDigestGenerationDiverged', structuredClone(input)]);
    if (!this.run || this.run.id !== input.id || this.run.lease_token !== input.leaseToken
      || this.run.state !== 'delivering') return { applied: false, row: null };
    this.run.state = 'diverged';
    this.run.error = input.error;
    this.run.lease_token = null;
    this.claimAvailable = true;
    return { applied: true, row: structuredClone(this.run) };
  }

  cleanupTargetParts(previousDigestId) {
    if (this.previous?.id === previousDigestId) return this.previous.parts;
    return this.divergentRuns.find(({ run }) => run.id === previousDigestId)?.parts || [];
  }

  cleanupTargets() {
    if (!this.finalized || this.divergentRuns.length === 0) {
      return this.previous ? [{ ...this.previous }] : [];
    }
    const latest = this.divergentRuns.at(-1);
    return [
      {
        id: latest.run.id,
        parts: latest.parts.filter((part) => part.delivery_state === 'delivered')
      },
      ...(latest.previous ? [{ ...latest.previous }] : [])
    ];
  }

  async listDigestCleanupBacklog(input) {
    this.calls.push(['listDigestCleanupBacklog', structuredClone(input)]);
    if (!this.finalized) return [];
    return this.cleanupTargets().map((target) => {
      const parts = target.parts
        .filter((part) => !['deleted', 'already_absent'].includes(this.cleanup.get(part.id)?.state))
        .map((part) => ({
          previous_part_id: part.id,
          part_kind: part.part_kind,
          part_number: part.part_number,
          part_count: part.part_count,
          slack_channel_id: part.slack_channel_id,
          slack_message_ts: part.slack_message_ts,
          cleanup_state: this.cleanup.get(part.id)?.state || 'idle'
        }));
      return parts.length === 0 ? null : {
        successor_digest_id: this.run.id,
        previous_digest_id: target.id,
        previous_cleanup_state: parts.some(({ cleanup_state }) => cleanup_state === 'failed') ? 'failed' : 'idle',
        parts
      };
    }).filter(Boolean).slice(0, input.limit);
  }

  async claimDigestPartCleanup(input) {
    this.calls.push(['claimDigestPartCleanup', structuredClone(input)]);
    assert.equal(this.finalized, true, 'cleanup must happen after finalization');
    const current = this.cleanup.get(input.previousPartId);
    if (current?.state === 'deleted' || current?.state === 'already_absent') {
      return { claimed: false, row: { state: 'delivered' }, part: { cleanup_state: current.state } };
    }
    const attempt = (current?.attempt || 0) + 1;
    const value = { state: 'deleting', attempt, token: `70000000-0000-4000-8000-${String(attempt).padStart(12, '0')}` };
    this.cleanup.set(input.previousPartId, value);
    const target = this.cleanupTargetParts(input.previousDigestId)
      .find(({ id }) => id === input.previousPartId);
    return {
      claimed: true,
      row: { state: 'delivered' },
      part: {
        ...target,
        cleanup_state: 'deleting',
        cleanup_attempts: attempt,
        cleanup_token: value.token
      }
    };
  }

  async recordDigestPartCleanup(input) {
    this.calls.push(['recordDigestPartCleanup', structuredClone(input)]);
    const value = this.cleanup.get(input.previousPartId);
    if (!value || value.attempt !== input.expectedCleanupAttempts || value.token !== input.cleanupToken) {
      return { applied: false, row: null, part: null };
    }
    value.state = input.outcome;
    const allSettled = this.cleanupTargets().every((target) => target.parts.every((part) =>
      ['deleted', 'already_absent'].includes(this.cleanup.get(part.id)?.state)));
    if (allSettled && this.divergentRuns.length > 0) {
      for (const divergent of this.divergentRuns) divergent.run.state = 'retired';
      this.retiredRuns = this.divergentRuns.map((entry) => structuredClone(entry));
    }
    return { applied: true, row: { state: 'delivered' }, part: { cleanup_state: input.outcome } };
  }

  async claimDigestGenerationPartCleanup(input) {
    this.calls.push(['claimDigestGenerationPartCleanup', structuredClone(input)]);
    const part = this.parts.find(({ id }) => id === input.partId);
    const current = this.cleanup.get(part.id);
    if (['deleted', 'already_absent'].includes(current?.state)) {
      return { claimed: false, row: structuredClone(this.run), part: structuredClone(part) };
    }
    const attempt = (current?.attempt || 0) + 1;
    const token = `71000000-0000-4000-8000-${String(attempt).padStart(12, '0')}`;
    this.cleanup.set(part.id, { state: 'deleting', attempt, token });
    Object.assign(part, {
      cleanup_state: 'deleting', cleanup_attempts: attempt, cleanup_owner: input.cleanupOwner,
      cleanup_token: token
    });
    return { claimed: true, row: structuredClone(this.run), part: structuredClone(part) };
  }

  async recordDigestGenerationPartCleanup(input) {
    this.calls.push(['recordDigestGenerationPartCleanup', structuredClone(input)]);
    const part = this.parts.find(({ id }) => id === input.partId);
    const current = this.cleanup.get(part.id);
    if (!current || current.attempt !== input.expectedCleanupAttempts || current.token !== input.cleanupToken) {
      return { applied: false, row: null, part: null };
    }
    current.state = input.outcome;
    Object.assign(part, {
      cleanup_state: input.outcome, cleanup_owner: null, cleanup_token: null,
      cleanup_error: input.outcome === 'failed' ? input.error : null
    });
    return { applied: true, row: structuredClone(this.run), part: structuredClone(part) };
  }

  async retireDigestGeneration(input) {
    this.calls.push(['retireDigestGeneration', structuredClone(input)]);
    if (this.parts.some((part) => ['delivering', 'delivered'].includes(part.delivery_state)
      && !['deleted', 'already_absent'].includes(part.cleanup_state))) {
      return { applied: false, row: null };
    }
    this.run.state = 'retired';
    this.run.error = input.error;
    const retired = { run: structuredClone(this.run), parts: structuredClone(this.parts) };
    this.retiredRuns.push(retired);
    this.digestGeneration += 1;
    this.run = null;
    this.parts = [];
    this.prepared = false;
    this.claimAvailable = true;
    return { applied: true, row: retired.run };
  }

  allowReclaim() {
    this.claimAvailable = true;
  }
}

function slackFake({ post, find, remove } = {}) {
  const calls = [];
  return {
    calls,
    async postMessage(input) {
      calls.push(['postMessage', structuredClone(input)]);
      return post ? post(input, calls) : { ok: true, channel: input.channel, ts: `200.${calls.length}`, message: {} };
    },
    async findMessageByClientId(input) {
      calls.push(['findMessageByClientId', structuredClone(input)]);
      return find ? find(input, calls) : null;
    },
    async deleteMessage(input) {
      calls.push(['deleteMessage', structuredClone(input)]);
      return remove ? remove(input, calls) : { status: 'deleted' };
    }
  };
}

function seededDivergentStore() {
  const inheritedPrior = priorPart(1);
  const store = new FakeStore({
    items: Array.from({ length: 25 }, (_, index) => workItem(index + 1, {
      title: `Current work ${index + 1}`,
      version: 2
    })),
    previousParts: [inheritedPrior]
  });
  store.run = {
    id: RUN_ID,
    generation: 1,
    state: 'diverged',
    scheduled_at: SCHEDULED,
    lease_token: null,
    item_snapshot: [{ id: uuid(1), version: 1, inclusionReason: 'actionable', priority: 'normal' }],
    manifest_prepared_at: SCHEDULED,
    error: 'digest_generation_diverged'
  };
  store.parts = [{
    id: '50000000-0000-4000-8000-000000000001',
    digest_run_id: RUN_ID,
    part_kind: 'ordinary',
    part_number: 1,
    part_count: 2,
    item_ids: Array.from({ length: 24 }, (_, index) => uuid(index + 1)),
    payload_hash: 'a'.repeat(64),
    client_message_id: '60000000-0000-4000-8000-000000000001',
    delivery_state: 'delivered',
    delivery_attempts: 1,
    slack_channel_id: 'CFOCUS',
    slack_message_ts: '310.1',
    delivered_at: SCHEDULED,
    cleanup_state: 'idle',
    cleanup_attempts: 0
  }, {
    id: '50000000-0000-4000-8000-000000000002',
    digest_run_id: RUN_ID,
    part_kind: 'ordinary',
    part_number: 2,
    part_count: 2,
    item_ids: [uuid(25)],
    payload_hash: 'b'.repeat(64),
    client_message_id: '60000000-0000-4000-8000-000000000002',
    delivery_state: 'failed',
    delivery_attempts: 1,
    slack_channel_id: null,
    slack_message_ts: null,
    delivered_at: null,
    cleanup_state: 'idle',
    cleanup_attempts: 0
  }];
  store.prepared = true;
  store.claimAvailable = true;
  return { store, inheritedPrior };
}

test('schedule uses the latest exact epoch-aligned boundary and one preceding window', () => {
  assert.equal(typeof digestScheduleWindow, 'function');
  assert.deepEqual(digestScheduleWindow(NOW, 180), {
    scheduledAt: SCHEDULED,
    windowStartedAt: '2026-08-29T03:00:00.000Z',
    windowEndedAt: SCHEDULED,
    nextScheduledAt: '2026-08-29T09:00:00.000Z'
  });
});

test('canonical payload hash recursively sorts object keys while preserving array order', () => {
  assert.equal(typeof canonicalDigestPayloadHash, 'function');
  assert.equal(canonicalDigestPayloadHash({
    text: 't',
    blocks: [{ type: 'header', text: { type: 'plain_text', text: 'x' } }],
    channel: 'C1'
  }), '822ed353ef62e5b513beb1283e83e15b43e42db00128a268b897a6cf838a5357');
});

test('two concurrent runners race on one database claim and only one lists or posts', async () => {
  assert.equal(typeof runDigestCycle, 'function');
  const store = new FakeStore({ items: [workItem()] });
  const slack = slackFake();
  const results = await Promise.all([
    runDigestCycle({ store, slack, config: config(), now: NOW, leaseOwner: 'runner:a' }),
    runDigestCycle({ store, slack, config: config(), now: NOW, leaseOwner: 'runner:b' })
  ]);
  assert.deepEqual(results.map(({ status }) => status).sort(), ['delivered', 'not_claimed']);
  assert.equal(results.find(({ status }) => status === 'not_claimed').retryable, true);
  assert.equal(store.calls.filter(([name]) => name === 'listActionableWork').length, 1);
  assert.equal(slack.calls.filter(([name]) => name === 'postMessage').length, 1);
});

test('claim accepts an equivalent PostgreSQL timestamptz representation and sanitizes claim failures', async () => {
  const equivalent = new FakeStore({ items: [] });
  const originalClaim = equivalent.claimDigestRun.bind(equivalent);
  equivalent.claimDigestRun = async (input) => {
    const result = await originalClaim(input);
    result.row.scheduled_at = '2026-08-29T06:00:00+00:00';
    return result;
  };
  assert.equal((await runDigestCycle({
    store: equivalent, slack: slackFake(), config: config(), now: NOW, leaseOwner: 'runner:a'
  })).status, 'delivered');

  const privateValue = 'private-store-body-customer-token';
  const failing = new FakeStore();
  failing.claimDigestRun = async () => { throw new Error(privateValue); };
  const result = await runDigestCycle({
    store: failing, slack: slackFake(), config: config(), now: NOW, leaseOwner: 'runner:a'
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'digest_claim_failed');
  assert.doesNotMatch(JSON.stringify(result), new RegExp(privateValue));
});

test('zero eligible work persists an empty manifest and finalizes without Slack coordinates', async () => {
  const store = new FakeStore({ items: [] });
  const slack = slackFake();
  const result = await runDigestCycle({ store, slack, config: config(), now: NOW, leaseOwner: 'runner:a' });
  assert.deepEqual(result, {
    status: 'delivered', scheduledAt: SCHEDULED, runId: RUN_ID,
    selectedCount: 0, renderedCount: 0, omittedEligibleCount: 0,
    partCount: 0, deliveredPartCount: 0,
    cleanup: { attempted: 0, settled: 0, failed: 0 }
  });
  assert.deepEqual(store.calls.find(([name]) => name === 'prepareDigestParts')[1].parts, []);
  assert.equal(store.finalized, true);
  assert.equal(slack.calls.length, 0);
});

test('complete content-free manifest is persisted before first post and posts use only DB client IDs', async () => {
  const store = new FakeStore({ items: Array.from({ length: 25 }, (_, index) => workItem(index + 1)) });
  const slack = slackFake({
    post(input) {
      assert.equal(store.prepared, true);
      assert.equal(Object.hasOwn(input, 'title'), false);
      return { ok: true, channel: input.channel, ts: `201.${input.clientMsgId.endsWith('1') ? '1' : '2'}`, message: {} };
    }
  });
  const result = await runDigestCycle({ store, slack, config: config(), now: NOW, leaseOwner: 'runner:a' });
  const prepareIndex = store.calls.findIndex(([name]) => name === 'prepareDigestParts');
  const firstClaimIndex = store.calls.findIndex(([name]) => name === 'claimDigestPartDelivery');
  assert.ok(prepareIndex >= 0 && prepareIndex < firstClaimIndex);
  const manifest = store.calls[prepareIndex][1].parts;
  assert.equal(manifest.length, 2);
  assert.deepEqual(Object.keys(manifest[0]).sort(), ['itemIds', 'kind', 'partCount', 'partNumber', 'payloadHash']);
  assert.deepEqual(slack.calls.filter(([name]) => name === 'postMessage').map(([, value]) => value.clientMsgId), [
    '60000000-0000-4000-8000-000000000001',
    '60000000-0000-4000-8000-000000000002'
  ]);
  assert.equal(result.partCount, 2);
  assert.equal(result.omittedEligibleCount, 0);
});

test('authoritative eligible counts deliver 500 rows but fail 501 closed before manifest preparation', async (t) => {
  await t.test('500 is complete', async () => {
    const store = new FakeStore({
      items: Array.from({ length: 500 }, (_, index) => workItem(index + 1)),
      eligibleCount: 500
    });
    const slack = slackFake();
    const result = await runDigestCycle({ store, slack, config: config(), now: NOW, leaseOwner: 'runner:500' });

    assert.equal(result.status, 'delivered');
    assert.equal(result.selectedCount, 500);
    assert.equal(result.renderedCount, 500);
    assert.equal(result.omittedEligibleCount, 0);
    assert.equal(store.calls.find(([name]) => name === 'listActionableWork')[1].limit, 500);
    assert.equal(store.calls.filter(([name]) => name === 'prepareDigestParts').length, 1);
  });

  await t.test('501 is authoritative overflow', async () => {
    const store = new FakeStore({
      items: Array.from({ length: 500 }, (_, index) => workItem(index + 1)),
      eligibleCount: 501
    });
    const slack = slackFake();
    const result = await runDigestCycle({ store, slack, config: config(), now: NOW, leaseOwner: 'runner:501' });

    assert.equal(result.status, 'failed');
    assert.equal(result.error, 'digest_eligible_overflow');
    assert.equal(result.selectedCount, 501);
    assert.equal(result.renderedCount, 0);
    assert.equal(result.omittedEligibleCount, 501);
    assert.equal(result.retryable, true);
    assert.equal(store.calls.some(([name]) => name === 'prepareDigestParts'), false);
    assert.equal(store.calls.some(([name]) => name === 'finalizeDigestRun'), false);
    assert.equal(slack.calls.length, 0);
  });
});

test('history_incomplete keeps an ambiguous digest part delivering across reclaims and never authorizes repost', async () => {
  const store = new FakeStore({ items: [workItem()] });
  const incomplete = Object.assign(new Error('private page-eleven history body'), {
    code: 'history_incomplete', kind: 'response'
  });
  const firstSlack = slackFake({
    post() {
      const error = new Error('private ambiguous post body');
      error.ambiguous = true;
      throw error;
    },
    find() { throw incomplete; }
  });

  const first = await runDigestCycle({ store, slack: firstSlack, config: config(), now: NOW, leaseOwner: 'runner:a' });
  assert.equal(first.status, 'failed');
  assert.equal(first.error, 'digest_history_incomplete');
  assert.equal(store.parts[0].delivery_state, 'delivering');
  assert.equal(store.parts[0].delivery_attempts, 1);
  assert.equal(store.calls.some(([name]) => name === 'markDigestPartFailed'), false);

  store.allowReclaim();
  const reclaimedSlack = slackFake({ find() { throw incomplete; } });
  const second = await runDigestCycle({
    store, slack: reclaimedSlack, config: config(), now: NOW, leaseOwner: 'runner:b'
  });
  assert.equal(second.status, 'failed');
  assert.equal(second.error, 'digest_history_incomplete');
  assert.equal(reclaimedSlack.calls.filter(([name]) => name === 'postMessage').length, 0);
  assert.equal(reclaimedSlack.calls.filter(([name]) => name === 'findMessageByClientId').length, 1);
  assert.equal(store.parts[0].delivery_state, 'delivering');
  assert.equal(store.parts[0].delivery_attempts, 1);
});

test('mutated included work keeps the partial generation visible until a successor is durably finalized', async () => {
  const inheritedPrior = priorPart(1);
  const store = new FakeStore({
    items: Array.from({ length: 25 }, (_, index) => workItem(index + 1)),
    previousParts: [inheritedPrior]
  });
  const firstSlack = slackFake({
    post(input, calls) {
      const postNumber = calls.filter(([name]) => name === 'postMessage').length;
      if (postNumber === 2) {
        const error = new Error('definite channel rejection');
        error.code = 'channel_not_found';
        error.ambiguous = false;
        throw error;
      }
      return { ok: true, channel: input.channel, ts: '310.1', message: {} };
    }
  });
  const first = await runDigestCycle({ store, slack: firstSlack, config: config(), now: NOW, leaseOwner: 'runner:a' });
  assert.equal(first.status, 'failed');
  assert.equal(store.parts[0].delivery_state, 'delivered');
  assert.equal(store.parts[1].delivery_state, 'failed');
  const oldClientIds = store.parts.map((part) => part.client_message_id);
  const oldHashes = store.parts.map((part) => part.payload_hash);

  store.items[0] = { ...store.items[0], title: 'Work 1 changed after partial delivery', version: 2 };
  store.allowReclaim();
  const successorSlack = slackFake();
  const handoff = await runDigestCycle({
    store, slack: successorSlack, config: config({ cleanupEnabled: true }), now: NOW, leaseOwner: 'runner:b'
  });
  assert.equal(handoff.status, 'failed');
  assert.equal(handoff.error, 'digest_generation_diverged');
  assert.equal(handoff.retryable, true);
  assert.equal(successorSlack.calls.some(([name]) => name === 'deleteMessage'), false,
    'generation N remains visible while N+1 is not finalized');
  assert.equal(store.retiredRuns.length, 0, 'generation N is not terminally retired before N+1 delivery');
  assert.equal(store.run.state, 'diverged');
  assert.deepEqual(store.parts.map((part) => part.client_message_id), oldClientIds);
  assert.deepEqual(store.parts.map((part) => part.payload_hash), oldHashes);

  const converged = await runDigestCycle({
    store, slack: successorSlack, config: config({ cleanupEnabled: true }), now: NOW, leaseOwner: 'runner:c'
  });
  assert.equal(converged.status, 'delivered');
  assert.equal(store.run.generation, 2);
  assert.deepEqual(converged.cleanup, { attempted: 2, settled: 2, failed: 0 });
  assert.deepEqual(successorSlack.calls.filter(([name]) => name === 'deleteMessage').map(([, input]) => input), [
    { channel: 'CFOCUS', ts: '310.1' },
    { channel: 'COLD', ts: '100.1' }
  ]);
  assert.equal(store.retiredRuns.length, 1);
  assert.equal(store.retiredRuns[0].run.state, 'retired');
  assert.deepEqual(store.retiredRuns[0].parts.map((part) => part.client_message_id), oldClientIds);
  assert.deepEqual(store.retiredRuns[0].parts.map((part) => part.payload_hash), oldHashes);
  const successorClientIds = store.parts.map((part) => part.client_message_id);
  assert.ok(successorClientIds.every((id) => !oldClientIds.includes(id)));
  assert.notEqual(store.parts[0].payload_hash, oldHashes[0]);
  const finalizeIndex = store.calls.findIndex(([name]) => name === 'finalizeDigestRun');
  const cleanupIndex = store.calls.findIndex(([name]) => name === 'claimDigestPartCleanup');
  assert.ok(finalizeIndex >= 0 && finalizeIndex < cleanupIndex,
    'the successor is durably finalized before any old exact coordinate is claimed for cleanup');
});

test('successor post, settlement, and finalization failures leave every old exact coordinate untouched', async (t) => {
  for (const boundary of ['post', 'settlement', 'finalization']) {
    await t.test(boundary, async () => {
      const { store } = seededDivergentStore();
      if (boundary === 'settlement') {
        store.markDigestPartDelivered = async (input) => {
          store.calls.push(['markDigestPartDelivered', structuredClone(input)]);
          throw new Error('offline settlement transport failure');
        };
      }
      if (boundary === 'finalization') {
        store.finalizeDigestRun = async (input) => {
          store.calls.push(['finalizeDigestRun', structuredClone(input)]);
          throw new Error('offline finalization transport failure');
        };
      }
      const slack = slackFake({
        post(input) {
          if (boundary === 'post') {
            const error = new Error('offline post rejection');
            error.code = 'channel_not_found';
            error.ambiguous = false;
            throw error;
          }
          return { ok: true, channel: input.channel, ts: '320.1', message: {} };
        }
      });

      const result = await runDigestCycle({
        store, slack, config: config({ cleanupEnabled: true }), now: NOW,
        leaseOwner: `runner:${boundary}`
      });

      assert.equal(result.status, 'failed');
      assert.equal(slack.calls.some(([name]) => name === 'deleteMessage'), false);
      assert.equal(store.calls.some(([name]) => name === 'claimDigestPartCleanup'), false);
      assert.equal(store.divergentRuns[0].run.state, 'diverged');
      assert.equal(store.retiredRuns.length, 0);
      assert.deepEqual(
        store.divergentRuns[0].parts.filter(({ delivery_state }) => delivery_state === 'delivered')
          .map(({ slack_channel_id, slack_message_ts }) => ({ channel: slack_channel_id, ts: slack_message_ts })),
        [{ channel: 'CFOCUS', ts: '310.1' }]
      );
    });
  }
});

test('finalization retry never reposts the successor and only then cleans the full inherited chain', async () => {
  const { store } = seededDivergentStore();
  const finalize = store.finalizeDigestRun.bind(store);
  let failFinalization = true;
  store.finalizeDigestRun = async (input) => {
    if (failFinalization) {
      store.calls.push(['finalizeDigestRun', structuredClone(input)]);
      failFinalization = false;
      throw new Error('offline finalization transport failure');
    }
    return finalize(input);
  };
  const slack = slackFake();

  const failed = await runDigestCycle({
    store, slack, config: config({ cleanupEnabled: true }), now: NOW, leaseOwner: 'runner:finalize-a'
  });
  assert.equal(failed.error, 'digest_delivery_unconfirmed');
  const postsAfterFailure = slack.calls.filter(([name]) => name === 'postMessage').length;
  assert.equal(slack.calls.some(([name]) => name === 'deleteMessage'), false);

  store.allowReclaim();
  const recovered = await runDigestCycle({
    store, slack, config: config({ cleanupEnabled: true }), now: NOW, leaseOwner: 'runner:finalize-b'
  });
  assert.equal(recovered.status, 'delivered');
  assert.equal(slack.calls.filter(([name]) => name === 'postMessage').length, postsAfterFailure,
    'durably settled successor coordinates are never reposted');
  assert.deepEqual(slack.calls.filter(([name]) => name === 'deleteMessage').map(([, input]) => input), [
    { channel: 'CFOCUS', ts: '310.1' },
    { channel: 'COLD', ts: '100.1' }
  ]);
  assert.equal(store.divergentRuns[0].run.state, 'retired');
});

test('cleanup crash can settle inherited prior first without retiring the divergent authorization chain', async () => {
  const { store, inheritedPrior } = seededDivergentStore();
  const record = store.recordDigestPartCleanup.bind(store);
  const divergentPartId = store.parts[0].id;
  let crashBeforeDivergentRecord = true;
  store.recordDigestPartCleanup = async (input) => {
    if (input.previousPartId === divergentPartId && crashBeforeDivergentRecord) {
      crashBeforeDivergentRecord = false;
      store.calls.push(['recordDigestPartCleanup', structuredClone(input)]);
      throw new Error('offline crash after exact delete before durable record');
    }
    return record(input);
  };
  const deleted = new Set();
  const slack = slackFake({
    remove(input) {
      const identity = `${input.channel}:${input.ts}`;
      if (deleted.has(identity)) return { status: 'already_absent' };
      deleted.add(identity);
      return { status: 'deleted' };
    }
  });

  const first = await runDigestCycle({
    store, slack, config: config({ cleanupEnabled: true }), now: NOW, leaseOwner: 'runner:cleanup-a'
  });
  assert.equal(first.status, 'delivered');
  assert.deepEqual(first.cleanup, { attempted: 2, settled: 1, failed: 1 });
  assert.equal(store.cleanup.get(inheritedPrior.id).state, 'deleted',
    'out-of-order cleanup may settle the inherited prior first');
  assert.equal(store.divergentRuns[0].run.state, 'diverged',
    'N remains an authorized durable link until both N and inherited A converge');
  assert.equal(store.retiredRuns.length, 0);

  store.allowReclaim();
  const postsBeforeRecovery = slack.calls.filter(([name]) => name === 'postMessage').length;
  const recovered = await runDigestCycle({
    store, slack, config: config({ cleanupEnabled: true }), now: NOW, leaseOwner: 'runner:cleanup-b'
  });
  assert.equal(recovered.status, 'not_claimed');
  assert.deepEqual(recovered.cleanup, { attempted: 1, settled: 1, failed: 0 });
  assert.equal(slack.calls.filter(([name]) => name === 'postMessage').length, postsBeforeRecovery);
  assert.equal(store.divergentRuns[0].run.state, 'retired');
  assert.deepEqual([...deleted].sort(), ['CFOCUS:310.1', 'COLD:100.1']);
});

test('subset crash reclaims immutable client IDs, skips delivered parts, reconciles delivering, and completes all parts', async () => {
  const items = Array.from({ length: 25 }, (_, index) => workItem(index + 1));
  const store = new FakeStore({ items });
  let firstRunPosts = 0;
  const crashingSlack = slackFake({
    post(input) {
      firstRunPosts += 1;
      if (firstRunPosts === 2) {
        const error = new Error('private Slack failure');
        error.code = 'internal_error';
        error.ambiguous = true;
        throw error;
      }
      return { ok: true, channel: input.channel, ts: '202.1', message: {} };
    },
    find: () => null
  });
  const first = await runDigestCycle({ store, slack: crashingSlack, config: config(), now: NOW, leaseOwner: 'runner:a' });
  assert.equal(first.status, 'failed');
  assert.equal(store.parts[0].delivery_state, 'delivered');
  assert.equal(store.parts[1].delivery_state, 'failed');

  store.allowReclaim();
  const recoveredSlack = slackFake({ post: (input) => ({ ok: true, channel: input.channel, ts: '202.2', message: {} }) });
  const second = await runDigestCycle({ store, slack: recoveredSlack, config: config(), now: NOW, leaseOwner: 'runner:b' });
  assert.equal(second.status, 'delivered');
  assert.equal(recoveredSlack.calls.filter(([name]) => name === 'postMessage').length, 1);
  assert.equal(recoveredSlack.calls.find(([name]) => name === 'postMessage')[1].clientMsgId, '60000000-0000-4000-8000-000000000002');
  assert.equal(store.finalized, true);
});

test('an already delivering part and an ambiguous post reconcile by exact stored client ID in a bounded window', async () => {
  const store = new FakeStore({ items: [workItem()] });
  const initialSlack = slackFake({
    post() {
      const error = new Error('secret transport body');
      error.code = 'transport_failure';
      error.ambiguous = true;
      throw error;
    },
    find(input) {
      assert.equal(input.clientMsgId, '60000000-0000-4000-8000-000000000001');
      assert.ok(input.latest - input.oldest <= 900);
      return { client_msg_id: input.clientMsgId, ts: '203.1' };
    }
  });
  const result = await runDigestCycle({ store, slack: initialSlack, config: config(), now: NOW, leaseOwner: 'runner:a' });
  assert.equal(result.status, 'delivered');
  assert.deepEqual(initialSlack.calls.map(([name]) => name), ['postMessage', 'findMessageByClientId']);
  assert.equal(store.parts[0].slack_message_ts, '203.1');
});

test('post coordinate survives a delivered-settlement failure and the next lease reconciles without reposting', async () => {
  const privateValue = 'private-post-settlement-store-body';
  const store = new FakeStore({ items: [workItem()] });
  const markDelivered = store.markDigestPartDelivered.bind(store);
  let rejectSettlement = true;
  store.markDigestPartDelivered = async (input) => {
    if (rejectSettlement) throw new Error(privateValue);
    return markDelivered(input);
  };
  const slack = slackFake({
    post: (input) => ({ ok: true, channel: input.channel, ts: '203.2', message: {} }),
    find: (input) => ({ client_msg_id: input.clientMsgId, ts: '203.2' })
  });

  const first = await runDigestCycle({ store, slack, config: config(), now: NOW, leaseOwner: 'runner:a' });
  assert.equal(first.status, 'failed');
  assert.equal(first.error, 'digest_delivery_unconfirmed');
  assert.equal(first.retryable, true);
  assert.equal(store.parts[0].delivery_state, 'delivering');
  assert.deepEqual(store.failures, []);
  assert.doesNotMatch(JSON.stringify(first), new RegExp(privateValue));

  rejectSettlement = false;
  store.allowReclaim();
  const second = await runDigestCycle({ store, slack, config: config(), now: NOW, leaseOwner: 'runner:b' });
  assert.equal(second.status, 'delivered');
  assert.equal(store.parts[0].slack_message_ts, '203.2');
  assert.equal(slack.calls.filter(([name]) => name === 'postMessage').length, 1);
  assert.equal(slack.calls.filter(([name]) => name === 'findMessageByClientId').length, 1);
  assert.equal(
    slack.calls.find(([name]) => name === 'postMessage')[1].clientMsgId,
    slack.calls.find(([name]) => name === 'findMessageByClientId')[1].clientMsgId,
    'the reclaimed lease resumes the same DB-issued client ID'
  );
});

test('ambiguous-post reconciliation coordinate survives settlement failure and resumes without a second post', async () => {
  const privateValue = 'private-reconcile-settlement-store-body';
  const store = new FakeStore({ items: [workItem()] });
  const markDelivered = store.markDigestPartDelivered.bind(store);
  let rejectSettlement = true;
  store.markDigestPartDelivered = async (input) => {
    if (rejectSettlement) throw new Error(privateValue);
    return markDelivered(input);
  };
  const slack = slackFake({
    post() {
      const error = new Error('private-ambiguous-slack-body');
      error.ambiguous = true;
      throw error;
    },
    find: (input) => ({ client_msg_id: input.clientMsgId, ts: '203.3' })
  });

  const first = await runDigestCycle({ store, slack, config: config(), now: NOW, leaseOwner: 'runner:a' });
  assert.equal(first.error, 'digest_delivery_unconfirmed');
  assert.equal(first.retryable, true);
  assert.equal(store.parts[0].delivery_state, 'delivering');
  assert.deepEqual(store.failures, []);
  assert.doesNotMatch(JSON.stringify(first), new RegExp(privateValue));

  rejectSettlement = false;
  store.allowReclaim();
  const second = await runDigestCycle({ store, slack, config: config(), now: NOW, leaseOwner: 'runner:b' });
  assert.equal(second.status, 'delivered');
  assert.equal(store.parts[0].slack_message_ts, '203.3');
  assert.equal(slack.calls.filter(([name]) => name === 'postMessage').length, 1);
  assert.equal(slack.calls.filter(([name]) => name === 'findMessageByClientId').length, 2);
});

test('all durable part coordinates survive finalization transport failure without failing or reposting', async () => {
  const privateValue = 'private-finalize-store-body';
  const store = new FakeStore({ items: [workItem()] });
  const finalize = store.finalizeDigestRun.bind(store);
  let rejectFinalize = true;
  store.finalizeDigestRun = async (input) => {
    if (rejectFinalize) throw new Error(privateValue);
    return finalize(input);
  };
  const slack = slackFake();

  const first = await runDigestCycle({ store, slack, config: config(), now: NOW, leaseOwner: 'runner:a' });
  assert.equal(first.error, 'digest_delivery_unconfirmed');
  assert.equal(first.retryable, true);
  assert.equal(store.parts[0].delivery_state, 'delivered');
  assert.deepEqual(store.failures, []);
  assert.doesNotMatch(JSON.stringify(first), new RegExp(privateValue));

  rejectFinalize = false;
  store.allowReclaim();
  const second = await runDigestCycle({ store, slack, config: config(), now: NOW, leaseOwner: 'runner:b' });
  assert.equal(second.status, 'delivered');
  assert.equal(slack.calls.filter(([name]) => name === 'postMessage').length, 1);
});

test('a newly claimed part posts even when the store reuses the prepared row object identity', async () => {
  const store = new FakeStore({ items: [workItem()] });
  const prepare = store.prepareDigestParts.bind(store);
  store.prepareDigestParts = async (input) => {
    const result = await prepare(input);
    return { ...result, parts: store.parts };
  };
  store.claimDigestPartDelivery = async (input) => {
    const part = store.parts.find(({ id }) => id === input.partId);
    part.delivery_state = 'delivering';
    part.delivery_attempts += 1;
    part.delivery_claimed_at = SCHEDULED;
    return { claimed: true, row: part };
  };
  const slack = slackFake();
  const result = await runDigestCycle({ store, slack, config: config(), now: NOW, leaseOwner: 'runner:a' });
  assert.equal(result.status, 'delivered');
  assert.equal(slack.calls.filter(([name]) => name === 'postMessage').length, 1);
  assert.equal(slack.calls.some(([name]) => name === 'findMessageByClientId'), false);
});

test('ordinary plus daily-reminder coordinates all settle before finalization and counters', async () => {
  const due = workItem(1, { first_opened_at: '2026-08-20T00:00:00.000Z' });
  const store = new FakeStore({ items: [due] });
  let posts = 0;
  const slack = slackFake({
    post(input) {
      posts += 1;
      if (posts === 2) {
        const error = new Error('rejected');
        error.code = 'channel_not_found';
        error.ambiguous = false;
        throw error;
      }
      return { ok: true, channel: input.channel, ts: '204.1', message: {} };
    }
  });
  const result = await runDigestCycle({ store, slack, config: config(), now: NOW, leaseOwner: 'runner:a' });
  assert.equal(result.status, 'failed');
  assert.equal(store.parts.length, 2);
  assert.equal(store.finalized, false);
  assert.equal(store.calls.some(([name]) => name === 'finalizeDigestRun'), false);
  assert.deepEqual(store.failures, ['digest_delivery_failed']);
});

test('delivery failure preserves every previous coordinate and never starts cleanup', async () => {
  const previousParts = [priorPart(1), priorPart(2)];
  const store = new FakeStore({ items: [workItem()], previousParts });
  const slack = slackFake({
    post() {
      const error = new Error('private');
      error.code = 'ratelimited';
      error.retryAfterSeconds = 60;
      error.ambiguous = false;
      throw error;
    }
  });
  const result = await runDigestCycle({
    store, slack, config: config({ cleanupEnabled: true }), now: NOW, leaseOwner: 'runner:a'
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.retryable, true);
  assert.equal(slack.calls.filter(([name]) => name === 'postMessage').length, 1, 'one cycle never loops on 429');
  assert.equal(store.calls.filter(([name]) => name === 'claimDigestPartDelivery').length, 1);
  assert.equal(store.parts[0].delivery_error, 'rate_limited');
  assert.deepEqual(store.previous.parts, previousParts);
  assert.equal(store.calls.some(([name]) => name === 'claimDigestPartCleanup'), false);
  assert.equal(slack.calls.some(([name]) => name === 'deleteMessage'), false);
});

test('durable Retry-After defers minute retries without burning attempts and resumes the same client ID when due', async () => {
  const store = new FakeStore({ items: [workItem()] });
  store.claimNow = NOW;
  let posts = 0;
  const postedClientIds = [];
  const slack = slackFake({
    post(input) {
      posts += 1;
      postedClientIds.push(input.clientMsgId);
      if (posts === 1) {
        const error = new Error('private-rate-limit-detail');
        error.code = 'ratelimited';
        error.kind = 'rate_limit';
        error.retryAfterSeconds = 300;
        error.ambiguous = false;
        throw error;
      }
      return { ok: true, channel: input.channel, ts: '205.1', message: {} };
    }
  });

  const first = await runDigestCycle({
    store, slack, config: config(), now: NOW, leaseOwner: 'runner:rate-1'
  });
  assert.equal(first.retryable, true);
  assert.equal(store.parts[0].delivery_attempts, 1);
  assert.equal(store.parts[0].delivery_retry_at, '2026-08-29T06:30:00.000Z');
  assert.equal(store.calls.find(([name]) => name === 'markDigestPartFailed')[1].failedAt, NOW);

  store.claimNow = '2026-08-29T06:26:00.000Z';
  const deferred = await runDigestCycle({
    store, slack, config: config(), now: store.claimNow, leaseOwner: 'runner:rate-2'
  });
  assert.equal(deferred.retryable, true);
  assert.equal(store.parts[0].delivery_attempts, 1);
  assert.equal(posts, 1, 'a pre-due minute cycle neither posts nor burns an attempt');

  store.claimNow = '2026-08-29T06:30:00.000Z';
  store.claimAvailable = true; // the two-minute database run lease from 06:26 has expired
  const delivered = await runDigestCycle({
    store, slack, config: config(), now: store.claimNow, leaseOwner: 'runner:rate-3'
  });
  assert.equal(delivered.status, 'delivered');
  assert.equal(store.parts[0].delivery_attempts, 2);
  assert.equal(store.parts[0].delivery_retry_at, null);
  assert.deepEqual(postedClientIds, [
    '60000000-0000-4000-8000-000000000001',
    '60000000-0000-4000-8000-000000000001'
  ]);
});

test('after new finalization cleanup claims and deletes every exact prior part coordinate', async () => {
  const previousParts = [priorPart(1), priorPart(2)];
  const store = new FakeStore({ items: [workItem()], previousParts });
  const slack = slackFake();
  const result = await runDigestCycle({
    store, slack, config: config({ cleanupEnabled: true }), now: NOW, leaseOwner: 'runner:a'
  });
  assert.equal(result.status, 'delivered');
  assert.deepEqual(result.cleanup, { attempted: 2, settled: 2, failed: 0 });
  assert.deepEqual(slack.calls.filter(([name]) => name === 'deleteMessage').map(([, input]) => input), [
    { channel: 'COLD', ts: '100.1' },
    { channel: 'COLD', ts: '100.2' }
  ]);
  const finalizeIndex = store.calls.findIndex(([name]) => name === 'finalizeDigestRun');
  const cleanupIndex = store.calls.findIndex(([name]) => name === 'claimDigestPartCleanup');
  assert.ok(finalizeIndex >= 0 && finalizeIndex < cleanupIndex);
});

test('delete failures are recorded and retried without changing delivered new digest', async () => {
  const previousParts = [priorPart(1), priorPart(2)];
  const store = new FakeStore({ items: [workItem()], previousParts });
  let failedOnce = false;
  const slack = slackFake({
    remove(input) {
      if (input.ts === '100.2' && !failedOnce) {
        failedOnce = true;
        const error = new Error('private cant delete detail');
        error.code = 'cant_delete_message';
        throw error;
      }
      return { status: input.ts === '100.2' ? 'already_absent' : 'deleted' };
    }
  });
  const first = await runDigestCycle({
    store, slack, config: config({ cleanupEnabled: true }), now: NOW, leaseOwner: 'runner:a'
  });
  assert.equal(first.status, 'delivered');
  assert.deepEqual(first.cleanup, { attempted: 2, settled: 1, failed: 1 });
  assert.equal(store.cleanup.get(previousParts[1].id).state, 'failed');
  assert.equal(store.finalized, true);

  store.allowReclaim();
  const second = await runDigestCycle({
    store, slack, config: config({ cleanupEnabled: true }), now: NOW, leaseOwner: 'runner:b'
  });
  assert.equal(second.status, 'not_claimed');
  assert.deepEqual(second.cleanup, { attempted: 1, settled: 1, failed: 0 });
  assert.equal(store.cleanup.get(previousParts[1].id).state, 'already_absent');
});

test('durable backlog still cleans A through replaced B after C has already cleaned B', async () => {
  const aId = '91000000-0000-4000-8000-000000000001';
  const bId = '91000000-0000-4000-8000-000000000002';
  const cId = '91000000-0000-4000-8000-000000000003';
  const aPartId = '91000000-0000-4000-8000-000000000004';
  const bPartId = '91000000-0000-4000-8000-000000000005';
  const entries = [{
    successor_digest_id: cId,
    previous_digest_id: bId, previous_cleanup_state: 'idle',
    parts: [{
      previous_part_id: bPartId, part_kind: 'ordinary', part_number: 1, part_count: 1,
      slack_channel_id: 'CBACKLOG', slack_message_ts: '910.02', cleanup_state: 'idle'
    }]
  }, {
    successor_digest_id: bId,
    previous_digest_id: aId, previous_cleanup_state: 'failed',
    parts: [{
      previous_part_id: aPartId, part_kind: 'ordinary', part_number: 1, part_count: 1,
      slack_channel_id: 'CBACKLOG', slack_message_ts: '910.01', cleanup_state: 'failed'
    }]
  }];
  const cleanupState = new Map(entries.flatMap((entry) => entry.parts.map((part) => [part.previous_part_id, {
    state: part.cleanup_state, attempts: part.cleanup_state === 'failed' ? 1 : 0
  }])));
  const calls = [];
  const store = {
    async claimDigestRun(input) {
      return {
        claimed: false, created: false, previous_digest: null,
        row: { id: RUN_ID, state: 'delivered', scheduled_at: input.scheduledAt, item_snapshot: [] }
      };
    },
    async listDigestCleanupBacklog(input) {
      calls.push(['list', structuredClone(input)]);
      return entries.map((entry) => ({
        ...entry,
        parts: entry.parts.filter((part) => !['deleted', 'already_absent'].includes(
          cleanupState.get(part.previous_part_id).state
        ))
      })).filter((entry) => entry.parts.length > 0).slice(0, input.limit);
    },
    async claimDigestPartCleanup(input) {
      calls.push(['claim', structuredClone(input)]);
      const entry = entries.find((candidate) => candidate.successor_digest_id === input.id
        && candidate.previous_digest_id === input.previousDigestId
        && candidate.parts.some((part) => part.previous_part_id === input.previousPartId));
      assert.ok(entry, 'cleanup uses one exact durable successor link');
      const state = cleanupState.get(input.previousPartId);
      state.attempts += 1;
      state.state = 'deleting';
      state.token = `92000000-0000-4000-8000-${String(state.attempts).padStart(12, '0')}`;
      return {
        claimed: true, row: { state: input.id === bId ? 'replaced' : 'delivered' },
        part: { cleanup_state: 'deleting', cleanup_attempts: state.attempts, cleanup_token: state.token }
      };
    },
    async recordDigestPartCleanup(input) {
      calls.push(['record', structuredClone(input)]);
      const state = cleanupState.get(input.previousPartId);
      assert.equal(input.cleanupToken, state.token);
      assert.equal(input.expectedCleanupAttempts, state.attempts);
      state.state = input.outcome;
      return {
        applied: true, row: { state: input.id === bId ? 'replaced' : 'delivered' },
        part: { cleanup_state: input.outcome }
      };
    },
    async listActionableWork() { throw new Error('not called'); },
    async prepareDigestParts() { throw new Error('not called'); },
    async claimDigestPartDelivery() { throw new Error('not called'); },
    async markDigestPartDelivered() { throw new Error('not called'); },
    async markDigestPartFailed() { throw new Error('not called'); },
    async markDigestGenerationDiverged() { throw new Error('not called'); },
    async finalizeDigestRun() { throw new Error('not called'); },
    async failDigestRun() { throw new Error('not called'); }
  };
  let failedAOnce = false;
  const slack = slackFake({
    remove(input) {
      if (input.ts === '910.01' && !failedAOnce) {
        failedAOnce = true;
        const error = new Error('private deletion detail');
        error.code = 'cant_delete_message';
        throw error;
      }
      return { status: 'deleted' };
    }
  });

  const first = await runDigestCycle({
    store, slack, config: config({ cleanupEnabled: true }), now: NOW, leaseOwner: 'runner:c'
  });
  assert.equal(first.status, 'not_claimed');
  assert.deepEqual(first.cleanup, { attempted: 2, settled: 1, failed: 1 });
  assert.equal(cleanupState.get(bPartId).state, 'deleted', 'C cleans B first');
  assert.equal(cleanupState.get(aPartId).state, 'failed', 'B to A remains durable after its first failure');

  const second = await runDigestCycle({
    store, slack, config: config({ cleanupEnabled: true }), now: NOW, leaseOwner: 'runner:sweep'
  });
  assert.deepEqual(second.cleanup, { attempted: 1, settled: 1, failed: 0 });
  assert.equal(cleanupState.get(aPartId).state, 'deleted');
  assert.equal(calls.filter(([name]) => name === 'claim').at(-1)[1].id, bId);
  assert.deepEqual(slack.calls.filter(([name]) => name === 'deleteMessage').map(([, input]) => input.ts), [
    '910.02', '910.01', '910.01'
  ]);
});

test('shared-prior successors each reconcile aggregate state while one exact Slack delete stays single', async () => {
  const aId = '93000000-0000-4000-8000-000000000001';
  const bId = '93000000-0000-4000-8000-000000000002';
  const cId = '93000000-0000-4000-8000-000000000003';
  const partId = '93000000-0000-4000-8000-000000000004';
  const aggregate = new Map([[bId, 'idle'], [cId, 'idle']]);
  const part = { state: 'idle', attempts: 0, token: null };
  const calls = [];
  const store = {
    async claimDigestRun(input) {
      return {
        claimed: false, created: false, previous_digest: null,
        row: { id: RUN_ID, state: 'delivered', scheduled_at: input.scheduledAt, item_snapshot: [] }
      };
    },
    async listDigestCleanupBacklog() {
      return [bId, cId].filter((id) => !['deleted', 'already_absent'].includes(aggregate.get(id)))
        .map((id) => ({
          successor_digest_id: id,
          previous_digest_id: aId,
          previous_cleanup_state: aggregate.get(id),
          parts: [{
            previous_part_id: partId, part_kind: 'ordinary', part_number: 1, part_count: 1,
            slack_channel_id: 'CSHARED', slack_message_ts: '930.01', cleanup_state: part.state
          }]
        }));
    },
    async claimDigestPartCleanup(input) {
      calls.push(['claim', structuredClone(input)]);
      if (['deleted', 'already_absent'].includes(part.state)) {
        aggregate.set(input.id, part.state);
        return {
          claimed: false, row: { state: input.id === bId ? 'delivered' : 'replaced' },
          part: { cleanup_state: part.state, cleanup_attempts: part.attempts, cleanup_token: part.token }
        };
      }
      part.attempts += 1;
      part.state = 'deleting';
      part.token = '94000000-0000-4000-8000-000000000001';
      aggregate.set(input.id, 'deleting');
      return {
        claimed: true, row: { state: 'delivered' },
        part: { cleanup_state: 'deleting', cleanup_attempts: part.attempts, cleanup_token: part.token }
      };
    },
    async recordDigestPartCleanup(input) {
      calls.push(['record', structuredClone(input)]);
      part.state = input.outcome;
      part.token = null;
      aggregate.set(input.id, input.outcome);
      return { applied: true, row: { state: 'delivered' }, part: { cleanup_state: input.outcome } };
    },
    async listActionableWork() { throw new Error('not called'); },
    async prepareDigestParts() { throw new Error('not called'); },
    async claimDigestPartDelivery() { throw new Error('not called'); },
    async markDigestPartDelivered() { throw new Error('not called'); },
    async markDigestPartFailed() { throw new Error('not called'); },
    async markDigestGenerationDiverged() { throw new Error('not called'); },
    async finalizeDigestRun() { throw new Error('not called'); },
    async failDigestRun() { throw new Error('not called'); }
  };
  const slack = slackFake();

  const first = await runDigestCycle({
    store, slack, config: config({ cleanupEnabled: true }), now: NOW, leaseOwner: 'runner:shared'
  });
  assert.deepEqual(first.cleanup, { attempted: 1, settled: 1, failed: 0 });
  assert.deepEqual([...aggregate.entries()], [[bId, 'deleted'], [cId, 'deleted']]);
  assert.equal(calls.filter(([name]) => name === 'claim').length, 2);
  assert.equal(slack.calls.filter(([name]) => name === 'deleteMessage').length, 1);
  assert.equal(part.attempts, 1, 'terminal aggregate repair does not rotate a part attempt');
  assert.equal(part.token, null);

  const finalSweep = await runDigestCycle({
    store, slack, config: config({ cleanupEnabled: true }), now: NOW, leaseOwner: 'runner:shared-final'
  });
  assert.deepEqual(finalSweep.cleanup, { attempted: 0, settled: 0, failed: 0 });
  assert.equal(calls.filter(([name]) => name === 'claim').length, 2);
});

test('invalid clocks, channels, lease bounds, and ambient time access fail before side effects', async () => {
  const store = new FakeStore({ items: [workItem()] });
  const slack = slackFake();
  const originalNow = Date.now;
  Date.now = () => { throw new Error('ambient time used'); };
  try {
    const result = await runDigestCycle({ store, slack, config: config(), now: NOW, leaseOwner: 'runner:a' });
    assert.equal(result.status, 'delivered');
  } finally {
    Date.now = originalNow;
  }
  for (const [badNow, badConfig] of [
    ['not-time', config()],
    [NOW, config({ channelId: '' })],
    [NOW, config({ intervalMinutes: 1.5 })],
    [NOW, config({ leaseSeconds: 901 })],
    [NOW, config({ reconcileWindowSeconds: Infinity })]
  ]) {
    const untouched = new FakeStore();
    await assert.rejects(
      runDigestCycle({ store: untouched, slack, config: badConfig, now: badNow, leaseOwner: 'runner:a' }),
      { message: 'invalid digest runner input' }
    );
    assert.equal(untouched.calls.length, 0);
  }
});
