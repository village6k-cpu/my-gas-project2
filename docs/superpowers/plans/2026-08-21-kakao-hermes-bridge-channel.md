# Kakao Hermes Bridge Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an authenticated, durable bridge channel that hands Kakao jobs to the native Hermes Gateway, executes the existing confirmation-request write path as a native tool call, and applies the final same-turn Hermes decision through the existing Kakao safety/follow-up pipeline.

**Architecture:** `server.mjs` remains the DOM capture, debounce, durable recovery, and transport owner. A focused channel module persists claim/lease/result state under the existing queue directory and exposes loopback-only HTTP endpoints. `worker.mjs` is refactored at seams: read-only evidence construction, one authoritative confirmation operation, and final-decision preparation. The Gateway replaces only the process/turn lifecycle; existing freshness, contract validation, owner-review, auto-send, follow-up, and Slack approval gates remain authoritative.

**Tech Stack:** Node.js 18+ ESM, built-in `http`, `crypto`, `fs`, `node:test`, current GAS client functions and Kakao phase scheduler.

**Spec:** [`2026-08-20-kakao-native-hermes-gateway-session-design.md`](../specs/2026-08-20-kakao-native-hermes-gateway-session-design.md)

## Global Constraints

- Work only in `C:\Village\my-gas-project2-worktrees\kakao-hermes-gateway-session` on `codex/kakao-hermes-gateway-session`.
- Run a regression test RED before each implementation change.
- Do not change GAS files, sheet columns, webhook state, live environment files, scheduled tasks, or installed profiles in this plan.
- `KAKAO_HERMES_TRANSPORT` defaults to `cli`; adding the Gateway path must not silently cut production over.
- The bridge may validate contracts and enforce negative safety gates, but it must not classify intent or generate customer prose.
- A schedule result is owner-review-only based on a trusted tool receipt, independent of words in the answer.
- Tests use fake DOM/GAS/Kakao/Slack transports. They must not send or mutate externally.

---

## Task 1: Add the durable Gateway job channel

**Files:**
- Create: `tools/kakao-dom-bridge/hermes-gateway-channel.mjs`
- Create: `tools/kakao-dom-bridge/hermes-gateway-channel.test.mjs`
- Modify: `tools/kakao-dom-bridge/package.json`

- [ ] **Step 1: Write failing persistence and lease tests**

Test the public surface:

```javascript
const channel = createHermesGatewayChannel({
  directory,
  leaseMs: 300_000,
  maxAttempts: 2,
  now: () => clock.now,
});

await channel.enqueue(event);
const claimed = await channel.claim({ consumerId: 'gateway-1', waitMs: 0 });
await channel.recordToolReceipt(receipt);
await channel.complete(resultEnvelope);
```

Cover atomic persistence, restart recovery, FIFO across rooms, at most one active lease per room, same-room coalescing/supersession, expired lease retry, maximum two claims, idempotent duplicate completion, stale `room_revision` rejection, and terminal error after retry exhaustion.

- [ ] **Step 2: Run the test and confirm RED**

```powershell
node --test tools/kakao-dom-bridge/hermes-gateway-channel.test.mjs
```

Expected: module-not-found.

- [ ] **Step 3: Implement the minimal durable state machine**

Persist one JSON document per job under `path.join(CONFIG.queueDir, 'hermes-gateway')` using write-to-temp then same-directory rename. File names must use a SHA-256 digest of `job_id`, never raw customer/room text. The persisted states are exactly:

```text
ready -> claimed -> completed
                -> superseded
                -> retry_wait -> ready
                -> failed
```

Expose `enqueue`, `claim`, `recordToolReceipt`, `complete`, `recordOutcome`, `reapExpiredLeases`, `get`, and `status`. Serialize state mutations inside the Node process; do not add a second database or message broker.

- [ ] **Step 4: Run channel tests and confirm GREEN**

```powershell
node --test tools/kakao-dom-bridge/hermes-gateway-channel.test.mjs
```

- [ ] **Step 5: Commit the channel checkpoint**

```powershell
git add tools/kakao-dom-bridge/hermes-gateway-channel.mjs tools/kakao-dom-bridge/hermes-gateway-channel.test.mjs tools/kakao-dom-bridge/package.json
git commit -m "feat: add durable Hermes Gateway job channel"
```

---

## Task 2: Expose loopback-only authenticated Gateway endpoints

**Files:**
- Create: `tools/kakao-dom-bridge/hermes-gateway-http.mjs`
- Create: `tools/kakao-dom-bridge/hermes-gateway-http.test.mjs`
- Modify: `tools/kakao-dom-bridge/server.mjs`
- Modify: `tools/kakao-dom-bridge/server.test.mjs`
- Modify: `tools/kakao-dom-bridge/.env.example`

- [ ] **Step 1: Write failing HTTP contract tests**

Test these routes against an ephemeral server and fake channel:

```text
GET  /hermes/v1/events?consumer_id=gateway-1&wait_ms=25000
POST /hermes/v1/results
POST /hermes/v1/outcomes
POST /hermes/v1/tools/confirmation-request
GET  /hermes/v1/status
```

Require `Authorization: Bearer <KAKAO_HERMES_BRIDGE_TOKEN>`, reject a missing/invalid token with 401, reject non-loopback remote addresses with 403, cap request bodies, use constant-time token comparison, and never echo the token. Assert health exposes only `transport`, `gatewayConfigured`, queue counts, and oldest lease age.

- [ ] **Step 2: Run tests and confirm RED**

```powershell
node --test tools/kakao-dom-bridge/hermes-gateway-http.test.mjs
```

- [ ] **Step 3: Implement the route handler and integrate it before public bridge routes**

Export `createHermesGatewayHttpHandler({ token, channel, executeConfirmation })`; its returned async handler accepts `(req, res, url)` and returns `true` only when it handled the route.

In `server.mjs`, invoke this handler before `/health`, `/events`, or manual-send routing. The handler must be disabled unless transport is `gateway` or `gateway_no_send` and the token is non-empty. Add configuration:

```text
KAKAO_HERMES_TRANSPORT=cli
KAKAO_HERMES_BRIDGE_TOKEN=
KAKAO_HERMES_LEASE_MS=300000
KAKAO_HERMES_MAX_ATTEMPTS=2
```

Do not put example secret values in `.env.example`.

- [ ] **Step 4: Run HTTP and existing server tests**

```powershell
node --test tools/kakao-dom-bridge/hermes-gateway-http.test.mjs tools/kakao-dom-bridge/server.test.mjs
node --check tools/kakao-dom-bridge/server.mjs
```

- [ ] **Step 5: Commit the endpoint checkpoint**

```powershell
git add tools/kakao-dom-bridge
git commit -m "feat: expose authenticated Hermes Gateway bridge API"
```

---

## Task 3: Extract read-only turn evidence from the one-shot worker

**Files:**
- Modify: `tools/ai-browser-worker/worker.mjs`
- Modify: `tools/ai-browser-worker/worker.test.mjs`

- [ ] **Step 1: Write failing evidence-builder tests**

Add tests for:

```javascript
const turn = await buildKakaoGatewayTurn({ config, job, capture, dependencies });
assert.equal(turn.schema, 'village-kakao-gateway-event/v1');
assert.equal(turn.job_id, job.jobId);
assert.equal(turn.room_key, job.roomKey);
assert.equal(turn.room_revision, job.roomRevision);
assert.match(turn.prompt, /FINAL_JSON/);
```

Assert dependencies for Hermes execution, sheet mutation, Kakao send, follow-up insert, and Slack delivery are never called. Assert the prompt preserves the current model/reasoning/tool/skill policy and tells Hermes to call `village_confirmation_request` when it judges an authoritative schedule check necessary.

- [ ] **Step 2: Run the focused test and confirm RED**

```powershell
node --test --test-name-pattern="buildKakaoGatewayTurn" tools/ai-browser-worker/worker.test.mjs
```

- [ ] **Step 3: Extract the existing read-only prefix**

Create the exported async function `buildKakaoGatewayTurn({ config, job, capture, dependencies = {}, signal = null })`.

Reuse the existing immutable snapshot, `buildReadOnlyLookupContext`, RAG/Brain context, recent sends, corrections, freshness guard, and `buildHermesPrompt`. Return the bridge event plus internal `snapshot` and lookup evidence needed later. Do not duplicate prompt wording. Keep `prepareKakaoDecisionFromSnapshot` working by calling this extraction internally before its legacy CLI path.

- [ ] **Step 4: Run focused and full worker tests**

```powershell
node --test --test-name-pattern="buildKakaoGatewayTurn|prepareKakaoDecisionFromSnapshot" tools/ai-browser-worker/worker.test.mjs
node --test tools/ai-browser-worker/worker.test.mjs
```

- [ ] **Step 5: Commit the extraction checkpoint**

```powershell
git add tools/ai-browser-worker/worker.mjs tools/ai-browser-worker/worker.test.mjs
git commit -m "refactor: extract Kakao Gateway turn evidence"
```

---

## Task 4: Extract one authoritative confirmation operation

**Files:**
- Modify: `tools/ai-browser-worker/worker.mjs`
- Modify: `tools/ai-browser-worker/worker.test.mjs`
- Modify: `tools/kakao-dom-bridge/server.mjs`
- Modify: `tools/kakao-dom-bridge/hermes-gateway-http.test.mjs`

- [ ] **Step 1: Write failing confirmation-operation tests**

Test:

```javascript
const result = await executeVillageConfirmationRequest({
  config,
  job,
  roomRevision: 7,
  decision,
  dependencies: { appendToSheet: fakeAppend },
});
```

Require current freshness before mutation, existing `validateAiDecisionContract`, `buildSheetAppendPayload`, additions-only merge, customer discount enrichment, and existing GAS append behavior. The result must include a server-generated receipt:

```javascript
{
  schema: 'village-confirmation-receipt/v1',
  receipt_id,
  job_id,
  room_key,
  room_revision,
  authoritative_sheet_result,
  availability_report,
  created_at
}
```

Test invalid/stale/missing contact/GAS failure and duplicate receipt idempotency. Assert it never calls Hermes, Kakao send, follow-up insertion, or Slack delivery.

- [ ] **Step 2: Run the focused tests and confirm RED**

```powershell
node --test --test-name-pattern="executeVillageConfirmationRequest" tools/ai-browser-worker/worker.test.mjs
```

- [ ] **Step 3: Extract and export the operation**

Move the current sheet-payload preparation through availability-report construction into `executeVillageConfirmationRequest`. Make the legacy `prepareKakaoDecisionFromSnapshot` call the new function, then continue its old post-action CLI reconciliation unchanged while `KAKAO_HERMES_TRANSPORT=cli`.

Wire `/hermes/v1/tools/confirmation-request` to this exported operation and persist the returned receipt in the channel before replying. The route must reject `gateway_no_send` with a typed `writes_disabled` result.

- [ ] **Step 4: Run worker and HTTP suites**

```powershell
node --test tools/ai-browser-worker/worker.test.mjs
node --test tools/kakao-dom-bridge/hermes-gateway-http.test.mjs tools/kakao-dom-bridge/server.test.mjs
```

- [ ] **Step 5: Commit the operation checkpoint**

```powershell
git add tools/ai-browser-worker/worker.mjs tools/ai-browser-worker/worker.test.mjs tools/kakao-dom-bridge
git commit -m "refactor: expose native confirmation operation"
```

---

## Task 5: Prepare and apply one-turn Gateway decisions

**Files:**
- Modify: `tools/ai-browser-worker/worker.mjs`
- Modify: `tools/ai-browser-worker/worker.test.mjs`
- Modify: `tools/kakao-dom-bridge/server.mjs`
- Modify: `tools/kakao-dom-bridge/hermes-gateway-channel.test.mjs`

- [ ] **Step 1: Write failing final-decision tests**

Create tests for:

```javascript
const prepared = await prepareKakaoGatewayDecision({
  config, job, turn, finalText, trustedToolReceipts
});
```

Cover:

- valid FAQ with no tool receipt remains eligible for the existing auto-send gates;
- any trusted confirmation receipt forces `replyMode="draft_only"`, `safetyClass="no_send"`, `grounding="authoritative_sheet"`, `requiresRag=false`, `owner_review_required=true`, and an explicit schedule follow-up;
- an agent-supplied/fabricated receipt inside `finalText` has no authority;
- a schedule claim without a trusted receipt cannot auto-send and creates owner review;
- stale revision, malformed final JSON, contradictory result, and failed confirmation all fail closed;
- `applyPreparedKakaoDecision` still performs a fresh DOM snapshot check before any Kakao send;
- `finalizePreparedKakaoDecision` still writes the owner follow-up/Slack card only after apply.

- [ ] **Step 2: Run the focused test and confirm RED**

```powershell
node --test --test-name-pattern="prepareKakaoGatewayDecision|trusted confirmation receipt" tools/ai-browser-worker/worker.test.mjs
```

- [ ] **Step 3: Implement final decision preparation without a second Hermes call**

Parse the adapter's final text with the existing JSON extractor and validate with the existing decision contract. Attach authoritative sheet evidence only from `trustedToolReceipts` loaded by the channel. Reuse `buildFollowUpRows`, sheet-failure rows, availability enrichment, and the current schedule owner-review validator. Return the same prepared shape consumed by `applyPreparedKakaoDecision` and `finalizePreparedKakaoDecision`.

Do not call `runHermesDecision` or `runHermesPostActionDecision` anywhere in the Gateway path.

- [ ] **Step 4: Wire result completion to the existing apply/finalize path**

When `/hermes/v1/results` completes a job, enqueue a local application phase that calls `prepareKakaoGatewayDecision`, `applyPreparedKakaoDecision`, and `finalizePreparedKakaoDecision`, then records the same worker-result audit/Supabase status used by `runWorkerAndRecord`. Preserve one apply lane so Kakao browser mutations remain serialized.

- [ ] **Step 5: Run full worker and bridge tests**

```powershell
node --test tools/ai-browser-worker/worker.test.mjs
node --test tools/kakao-dom-bridge/*.test.mjs
```

- [ ] **Step 6: Commit the same-turn checkpoint**

```powershell
git add tools/ai-browser-worker tools/kakao-dom-bridge
git commit -m "feat: apply same-turn Hermes Gateway decisions"
```

---

## Task 6: Add the transport switch and native timeout/retry semantics

**Files:**
- Modify: `tools/kakao-dom-bridge/server.mjs`
- Modify: `tools/kakao-dom-bridge/server.test.mjs`
- Modify: `tools/kakao-dom-bridge/hermes-gateway-channel.mjs`
- Modify: `tools/kakao-dom-bridge/hermes-gateway-channel.test.mjs`
- Modify: `tools/ai-browser-worker/worker.test.mjs`

- [ ] **Step 1: Write failing transport tests**

Assert:

- default/missing `KAKAO_HERMES_TRANSPORT` uses the existing CLI path;
- `gateway` enqueues a native event and never invokes `spawn`, `hermes-stdin-runner.py`, `runHermesDecision`, or `runHermesPostActionDecision`;
- a newer same-room event is claimable immediately so stock Hermes can interrupt the active session;
- `CANCELLED` for a superseded job is terminal, not retried;
- lease timeout requeues the same `job_id`/`room_key`/revision once, then fails after the second timeout;
- timeout retry does not create a new session identifier or kill/restart Gateway;
- failed jobs create the existing human-review failure follow-up.

- [ ] **Step 2: Run tests and confirm RED**

```powershell
node --test tools/kakao-dom-bridge/hermes-gateway-channel.test.mjs tools/kakao-dom-bridge/server.test.mjs
```

- [ ] **Step 3: Implement the switch at the dispatch seam**

Replace the direct call in `flushRoom` with `dispatchAiJob(job)`:

```javascript
if (CONFIG.hermesTransport === 'gateway' || CONFIG.hermesTransport === 'gateway_no_send') {
  return enqueueGatewayJob(job);
}
return runWorkerAndRecord(job, context);
```

The event prompt comes from `captureKakaoRoomSnapshot` plus `buildKakaoGatewayTurn`; it must not be generated by a new code router. A newer same-room event remains a normal native `MessageEvent`, letting `BasePlatformAdapter` own interruption. Lease expiry only re-exposes the same event to the same Gateway profile/session key.

- [ ] **Step 4: Add health/readback fields**

Health must report current transport, Gateway configured/consumer last-seen, ready/claimed/retry/failed counts, oldest claim age, and last completed job ID. `ok: true` alone must not be treated as Gateway readiness.

- [ ] **Step 5: Run all targeted tests and static checks**

```powershell
node --test tools/kakao-dom-bridge/*.test.mjs tools/ai-browser-worker/worker.test.mjs
node --check tools/kakao-dom-bridge/server.mjs
node --check tools/ai-browser-worker/worker.mjs
git diff --check
```

- [ ] **Step 6: Commit the bridge implementation**

```powershell
git add tools/kakao-dom-bridge tools/ai-browser-worker
git commit -m "feat: route Kakao turns through native Hermes Gateway"
```

---

## Plan Acceptance Checklist

- [ ] CLI remains the default and passes all pre-existing tests.
- [ ] Gateway mode starts zero Hermes child processes and zero stdin runners per request.
- [ ] One agent turn can call the confirmation tool and interpret its result before final JSON.
- [ ] Trusted tool receipts, not keywords or agent claims, enforce schedule owner approval.
- [ ] Existing FAQ auto-send gates, freshness checks, kill switch, DOM send path, follow-up rows, and Slack approval cards remain intact.
- [ ] Timeout retries the same stock session at most twice and never restarts Gateway.
- [ ] All validation is offline/no-send; no GAS, Kakao, Slack, scheduled task, profile, or deployment mutation occurs.
