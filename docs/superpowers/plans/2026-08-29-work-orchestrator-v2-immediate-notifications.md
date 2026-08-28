# Work Orchestrator v2 Immediate Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver one idempotent immediate Slack notice for every accepted inbound Kakao customer-message event, independently of Hermes latency or outcome.

**Architecture:** The bridge claims a durable receipt, claims its delivery state, posts through a focused Slack client with deterministic `client_msg_id`, reconciles ambiguous responses by history readback, and stores exact coordinates. Legacy human-work cards remain enabled throughout this plan; disabling them before digests exist would violate the approved safety sequence.

**Tech Stack:** Node.js 24 ESM, built-in `node:test`, Slack Web API, Supabase PostgREST/RPC, existing Kakao DOM bridge.

**Spec:** `docs/superpowers/specs/2026-08-29-work-orchestrator-v2-design.md`

## Global Constraints

- The first notice is mandatory for every accepted customer-message event and cannot wait for Hermes.
- Heartbeats, diagnostic snapshots, stale dated events, page containers, and action chrome are not customer-message events and must not notify.
- Delivery is exact-once by `source_event_key`; an ambiguous Slack response must reconcile before retry.
- Store exact `channel_id` and `message_ts` only after Slack readback/success.
- Do not send any customer-facing Kakao message, write Sheets/GAS, disable legacy cards, or delete Slack messages in this plan.
- A live internal Slack test message is an explicit cutover gate; mocked tests and shadow writes run first.
- Keep `SLACK_BOT_TOKEN` server-side and redact it from errors.

## File map

- Create `tools/work-orchestrator-v2/slack-client.mjs`: bounded Slack post/history/update/delete primitives; only post/history are used in this plan.
- Create `tools/work-orchestrator-v2/slack-client.test.mjs`: success, rate limit, ambiguous timeout, and reconciliation tests.
- Create `tools/work-orchestrator-v2/immediate-notifications.mjs`: receipt delivery state machine and notice rendering.
- Create `tools/work-orchestrator-v2/immediate-notifications.test.mjs`: exact-once and failure behavior.
- Modify `tools/work-orchestrator-v2/supabase-store.mjs`: delivery claim/reconciliation queries.
- Modify `tools/work-orchestrator-v2/supabase-store.test.mjs`: compare-and-swap coverage.
- Modify `tools/kakao-dom-bridge/server.mjs`: invoke immediate delivery before Supabase legacy event write/debounce.
- Modify `tools/kakao-dom-bridge/server.test.mjs`: event-path ordering and health readback.
- Modify `tools/kakao-dom-bridge/.env.example`: inbox channel and delivery retry configuration.

---

### Task 1: Build the bounded Slack client

**Files:**
- Create: `tools/work-orchestrator-v2/slack-client.mjs`
- Create: `tools/work-orchestrator-v2/slack-client.test.mjs`

**Interfaces:**
- Consumes: `{token,fetchImpl}`, `postMessage({channel,text,blocks,clientMsgId})`, and `findMessageByClientId({channel,clientMsgId,oldest,latest})`.
- Produces: normalized `{ok,channel,ts,message}` or a typed `SlackApiError` with `{kind,status,code,retryAfterSeconds,ambiguous}`.

- [ ] **Step 1: Write failing client tests**

Cover:

```js
assert.deepEqual(await client.postMessage(input), { ok: true, channel: 'CINBOX', ts: '100.1', message: {} });
assert.equal(JSON.parse(request.init.body).client_msg_id, input.clientMsgId);
await assert.rejects(() => client.postMessage(input), (error) => error.ambiguous === true);
assert.equal((await client.findMessageByClientId(search)).ts, '100.1');
```

Add HTTP 429 coverage asserting `retryAfterSeconds` is parsed and no token appears in the thrown message.

- [ ] **Step 2: Run RED**

```powershell
node --test tools\work-orchestrator-v2\slack-client.test.mjs
```

Expected: FAIL because the client is missing.

- [ ] **Step 3: Implement the client**

Export:

```js
export class SlackApiError extends Error {
  constructor(message, fields = {}) { super(message); Object.assign(this, fields); }
}
export function createSlackClient({ token, fetchImpl = fetch, timeoutMs = 7000 } = {}) {
  if (!token) throw new Error('Slack bot token is missing');
  const call = async (method, body) => {
    let response;
    try {
      response = await fetchImpl(`https://slack.com/api/${method}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch {
      throw new SlackApiError(`Slack ${method} transport failed`, { kind: 'transport', ambiguous: method === 'chat.postMessage' });
    }
    const retryAfterSeconds = Number(response.headers.get('retry-after') || 0) || null;
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok !== true) {
      throw new SlackApiError(`Slack ${method} failed: HTTP ${response.status}, code ${String(payload.error || 'unknown').slice(0, 80)}`, {
        kind: response.status === 429 ? 'rate_limit' : 'api',
        status: response.status,
        code: payload.error || null,
        retryAfterSeconds,
        ambiguous: method === 'chat.postMessage' && response.status >= 500
      });
    }
    return payload;
  };
  return {
    postMessage: async ({ channel, text, blocks, clientMsgId }) => {
      const payload = await call('chat.postMessage', {
        channel,
        text,
        blocks,
        client_msg_id: clientMsgId,
        reply_broadcast: false,
        unfurl_links: false,
        unfurl_media: false
      });
      return { ok: true, channel: payload.channel, ts: payload.ts, message: payload.message || {} };
    },
    findMessageByClientId: async ({ channel, clientMsgId, oldest, latest }) => {
      let cursor = '';
      for (let page = 0; page < 10; page += 1) {
        const payload = await call('conversations.history', {
          channel,
          oldest: String(oldest),
          latest: String(latest),
          inclusive: true,
          limit: 200,
          cursor
        });
        const match = (payload.messages || []).find((message) => message.client_msg_id === clientMsgId);
        if (match) return match;
        cursor = payload.response_metadata?.next_cursor || '';
        if (!cursor) break;
      }
      return null;
    }
  };
}
```

Use `reply_broadcast: false`, `unfurl_links: false`, and `unfurl_media: false`. History search must be bounded to ten pages of 200 messages and compare the exact `client_msg_id`.

- [ ] **Step 4: Run GREEN and commit**

```powershell
node --test tools\work-orchestrator-v2\slack-client.test.mjs
git add -- tools/work-orchestrator-v2/slack-client.mjs tools/work-orchestrator-v2/slack-client.test.mjs
git commit -m "feat: add bounded Slack notification client"
```

---

### Task 2: Implement exact-once receipt delivery and reconciliation

**Files:**
- Create: `tools/work-orchestrator-v2/immediate-notifications.mjs`
- Create: `tools/work-orchestrator-v2/immediate-notifications.test.mjs`
- Modify: `tools/work-orchestrator-v2/supabase-store.mjs`
- Modify: `tools/work-orchestrator-v2/supabase-store.test.mjs`

**Interfaces:**
- Consumes: `store.claimNotificationReceipt`, `store.transitionNotification`, `slack.postMessage`, `slack.findMessageByClientId`.
- Produces: `ensureImmediateNotification({event,config,store,slack,now}) -> {status,receipt,delivery,reconciled}`.

- [ ] **Step 1: Write RED tests for the state machine**

Required cases:

1. a new receipt transitions `pending -> delivering -> delivered` and posts once;
2. a duplicate event whose receipt is `delivered` posts zero times;
3. two concurrent calls allow only one `pending|failed -> delivering` claim;
4. an ambiguous timeout finds the exact `client_msg_id`, stores coordinates, and does not repost;
5. an ambiguous timeout with no readback moves to `failed` with `last_delivery_error`;
6. P0 is not inferred before Hermes; the immediate event starts with `urgency=normal` unless the source event carries an explicit trusted alert level.

Use an expected delivered row:

```js
assert.equal(result.status, 'delivered');
assert.equal(result.receipt.notification_state, 'delivered');
assert.equal(result.receipt.slack_channel_id, 'CINBOX');
assert.equal(result.receipt.slack_message_ts, '100.1');
assert.equal(slack.posts.length, 1);
```

- [ ] **Step 2: Run RED**

```powershell
node --test tools\work-orchestrator-v2\immediate-notifications.test.mjs
```

Expected: FAIL because the state machine is missing.

- [ ] **Step 3: Extend store compare-and-swap operations**

Add:

```js
claimNotificationDelivery({ id })
markNotificationDelivered({ id, channelId, messageTs, deliveredAt })
markNotificationFailed({ id, error, attemptedAt })
```

`claimNotificationDelivery` must filter `notification_state=in.(pending,failed)` and increment `delivery_attempts`. Empty representation means another process owns the claim.

- [ ] **Step 4: Implement rendering and delivery**

Export:

```js
export function buildImmediateNotice(event = {}, { mentionUserIds = [] } = {}) {
  const mentions = [...new Set(mentionUserIds)].map((id) => `<@${id}>`).join(' ');
  const customer = String(event.customerName || '고객명 미확인').slice(0, 200);
  const preview = String(event.messagePreview || event.previewText || '내용 확인 필요').slice(0, 1000);
  return {
    text: `${mentions ? `${mentions} ` : ''}💬 카카오 새 메시지 · ${customer} · ${preview}`.slice(0, 2900),
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: '💬 카카오 새 메시지', emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: `${mentions ? `${mentions}\n` : ''}*${customer}*\n${preview}`.slice(0, 2900) } }
    ]
  };
}

export async function ensureImmediateNotification({ event, config, store, slack, now = () => new Date() } = {}) {
  const receipt = await store.claimNotificationReceipt(notificationReceiptInput(event));
  if (receipt.notification_state === 'delivered') return { status: 'delivered', receipt, delivery: null, reconciled: false };
  const claimed = await store.claimNotificationDelivery({ id: receipt.id });
  if (!claimed.applied) {
    const current = await store.getNotificationByEventKey(receipt.source_event_key);
    return { status: current?.notification_state || 'busy', receipt: current || receipt, delivery: null, reconciled: false };
  }
  const notice = buildImmediateNotice(event, { mentionUserIds: config.mentionUserIds });
  try {
    const delivery = await slack.postMessage({
      channel: config.inboxChannelId,
      ...notice,
      clientMsgId: claimed.row.slack_client_msg_id
    });
    const delivered = await store.markNotificationDelivered({ id: receipt.id, channelId: delivery.channel, messageTs: delivery.ts, deliveredAt: now().toISOString() });
    return { status: 'delivered', receipt: delivered.row, delivery, reconciled: false };
  } catch (error) {
    if (error?.ambiguous) {
      const createdAt = Date.parse(receipt.created_at);
      const match = await slack.findMessageByClientId({
        channel: config.inboxChannelId,
        clientMsgId: claimed.row.slack_client_msg_id,
        oldest: (createdAt - 300000) / 1000,
        latest: (now().getTime() + 300000) / 1000
      });
      if (match) {
        const delivered = await store.markNotificationDelivered({ id: receipt.id, channelId: config.inboxChannelId, messageTs: match.ts, deliveredAt: now().toISOString() });
        return { status: 'delivered', receipt: delivered.row, delivery: match, reconciled: true };
      }
    }
    await store.markNotificationFailed({ id: receipt.id, error: String(error?.message || error).slice(0, 500), attemptedAt: now().toISOString() });
    throw error;
  }
}
```

On ambiguous error, search from five minutes before receipt creation to five minutes after the attempt. Do not retry inside the same call unless reconciliation proves absence and `delivery_attempts < 3`.

- [ ] **Step 5: Run GREEN and commit**

```powershell
node --test tools\work-orchestrator-v2\supabase-store.test.mjs tools\work-orchestrator-v2\immediate-notifications.test.mjs
git add -- tools/work-orchestrator-v2/supabase-store.mjs tools/work-orchestrator-v2/supabase-store.test.mjs tools/work-orchestrator-v2/immediate-notifications.mjs tools/work-orchestrator-v2/immediate-notifications.test.mjs
git commit -m "feat: deliver idempotent immediate notifications"
```

---

### Task 3: Put immediate delivery on the accepted-event path

**Files:**
- Modify: `tools/kakao-dom-bridge/server.mjs:3903-4000,4040-4130`
- Modify: `tools/kakao-dom-bridge/server.test.mjs`
- Modify: `tools/kakao-dom-bridge/.env.example`

**Interfaces:**
- Consumes: `ensureImmediateNotification` and the existing accepted normalized event.
- Produces: HTTP 202 only after immediate delivery succeeds or a typed 503 when the mandatory notice is not confirmed; legacy Hermes scheduling remains unchanged after success.

- [ ] **Step 1: Add bridge RED tests**

Test:

```js
assert.deepEqual(callOrder, ['accept-room-revision', 'immediate-notice', 'legacy-supabase-event', 'schedule-worker']);
assert.equal(response.statusCode, 202);
```

Add a worker-slow test where the response includes the delivered notification before any Hermes promise resolves, a duplicate event test with one Slack post, and a failed-delivery test expecting HTTP 503 plus no worker scheduling. The 503 is intentional: accepting an event without the mandatory notice would violate the first-notification invariant.

- [ ] **Step 2: Run RED**

```powershell
node --test --test-name-pattern "immediate notification" tools\kakao-dom-bridge\server.test.mjs
```

Expected: FAIL because `handleEvent` does not call the v2 delivery path.

- [ ] **Step 3: Wire feature-gated delivery**

When `WORK_ORCHESTRATOR_V2_IMMEDIATE_ENABLED=1`:

1. require `WORK_ORCHESTRATOR_V2_INBOX_CHANNEL_ID` and Slack token at startup;
2. call `ensureImmediateNotification` after event acceptance and before `writeSupabaseEvent`;
3. return 503 with `{ok:false,error:'immediate_notification_unconfirmed',eventHash}` if it is not delivered;
4. append a bounded error record without message content;
5. leave `AI_WORKER_FOLLOW_UP_ITEMS_ENABLED`, `KAKAO_FOLLOW_UP_ITEMS_ENABLED`, and `SLACK_AGENT_CARD_DELIVERY_ENABLED` untouched.

Add health fields:

```js
config.workOrchestrator.immediateEnabled
state.workOrchestrator.immediateDelivered
state.workOrchestrator.immediateDuplicates
state.workOrchestrator.immediateFailed
state.workOrchestrator.oldestPendingNotificationAgeMs
```

- [ ] **Step 4: Run focused and full GREEN**

```powershell
node --test --test-name-pattern "immediate notification" tools\kakao-dom-bridge\server.test.mjs
npm --prefix tools\work-orchestrator-v2 test
npm --prefix tools\kakao-dom-bridge test
git diff --check
```

Expected: all tests pass; test doubles record Slack only, never Kakao/GAS.

- [ ] **Step 5: Commit**

```powershell
git add -- tools/kakao-dom-bridge/server.mjs tools/kakao-dom-bridge/server.test.mjs tools/kakao-dom-bridge/.env.example
git commit -m "feat: notify immediately on accepted Kakao events"
```

---

### Task 4: Dark production verification and activation gate

**Files:**
- Modify: `docs/kakao-automation-followup-dashboard-ops.md`

**Interfaces:**
- Consumes: production migration, shadow receipt metrics, configured inbox channel.
- Produces: a cutover record proving one internal test event -> one receipt -> one Slack message -> Slack readback.

- [ ] **Step 1: Verify migration history before any production DDL**

```powershell
npx --yes supabase@2.116.0 login
npx --yes supabase@2.116.0 link
npx --yes supabase@2.116.0 migration list --linked
```

Expected: local/remote history is understood. If divergent, stop and document the exact rows; do not run `migration repair` automatically.

- [ ] **Step 2: Run database advisors and push once**

```powershell
npx --yes supabase@2.116.0 db advisors --linked --level error
npx --yes supabase@2.116.0 db push --linked
npx --yes supabase@2.116.0 migration list --linked
```

Expected: no error-level advisor finding caused by v2 and the foundation migration appears applied once.

- [ ] **Step 3: Enable shadow writes only and verify readback**

Set the owned production profile to:

```dotenv
WORK_ORCHESTRATOR_V2_SHADOW_WRITES=1
WORK_ORCHESTRATOR_V2_IMMEDIATE_ENABLED=0
```

Restart through the existing `Village-Kakao-Production-Start`/watchdog lifecycle, then verify `/health.config.workOrchestrator.shadowWrites=true` and duplicate test events produce one receipt. Do not send a Slack message in this step.

- [ ] **Step 4: Request the explicit internal Slack test gate**

Before enabling `WORK_ORCHESTRATOR_V2_IMMEDIATE_ENABLED=1`, obtain approval for one internal non-customer Slack test event. The verification record must include event hash, receipt id/state, Slack coordinates, `auth.test` bot identity, and `conversations.history` readback. Do not use a real customer conversation to manufacture the test.

- [ ] **Step 5: Document and commit the operating procedure**

```powershell
git add -- docs/kakao-automation-followup-dashboard-ops.md
git commit -m "docs: add immediate notification cutover gate"
```

---

## Immediate-notification completion gate

Do not start persistent-card cutover until:

- an approved internal test proves one accepted event, one durable receipt, and one Slack readback;
- duplicate and ambiguous-response tests prove no duplicate first notice;
- the worker-slow/down tests still deliver immediately;
- pending/failed receipt metrics are zero after recovery;
- legacy cards remain enabled;
- phone sound/push is reported separately from Slack API delivery and is not inferred from API success.
