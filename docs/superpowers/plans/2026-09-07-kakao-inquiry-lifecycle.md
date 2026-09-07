# Kakao inquiry lifecycle repair

> Execute with superpowers:subagent-driven-development. The current user's seven incident reports are the specification.

**Goal:** Preserve native Hermes reasoning while making inquiry capture, pending revision, registered state reconciliation, and multiple rental periods coherent.

**Architecture:** Hermes interprets the full latest conversation and authoritative records. Execution validates typed complete plans, exact targets, current revisions, catalog membership and durable receipts. No customer-name or Korean keyword routing.

**Constraints:** No customer messages; no automatic replay of uncertain writes; no schema/column changes; preserve existing registered trades and commercial fields; integration/deployment uses repository scripts. The user's explicit 24-hour single-session default applies to an otherwise unqualified dated pickup inquiry. Existing explicit return dates/times and live bookings take priority. Unknown pickup dates remain unknown.

## Evidence

- The September 7 worker prompt orders capture regardless of registration, while GAS `_insertAndCheckRequest` discovers `registeredTradeId` but continues inserting.
- Pending equipment changes require staff authorization; a new full plan escapes that gate if the model omits existing IDs. The changed plan creates a second RQ.
- One Gateway operation owns a lease; repeated confirmation calls for different rental periods conflict after the first succeeds. A batch must be represented and validated before the first write.
- The blanket missing-time instruction overrides ordinary single-session interpretation. UI read markers were also mislabelled as staff messages in incident decisions.
- Existing live data differs from screenshots. Diagnostics are saved outside Git under `C:/Village/tmp/kakao-20260907-*`; never copy credentials/raw customer data into committed fixtures.

## Tasks

- [x] 1. GAS authoritative registered duplicate reconciliation: RED tests for exact and subset already-applied equipment including partial input periods; retain a real new addition path and explicit independent rentals. Readback must distinguish trade duplicate from an RQ.
- [x] 2. Worker lifecycle interpretation: remove contradictory unconditional capture instructions; provide native decision fields for new inquiry, pending revision, registered reconciliation, declined/catalog-only inquiry; retain truly incomplete new inquiries. Prove invalid transitions write zero times.
- [x] 3. Pending revisions: exact customer-authorized inquiry plan revision may update only mutable pending RQs with full baseline/period CAS; registration and registered mutations still require staff authority. Prove stale/registered targets never change.
- [x] 4. Multi-period capture: one durable confirmation operation contains all explicitly AI-selected period groups; validate all before execution, preserve every result, stop on uncertainty, never replay completed groups. Prove two-group capture and second-group failure evidence.
- [x] 5. Native prompt and runtime contract: ensure current room roles/context, lookup results, catalog and receipt semantics are available; test single-session interpretation without a deterministic text parser.
- [ ] 6. Independent review; focused plus affected regression suites; integrate and deploy through authorized scripts. Verify real runtime hashes/processes and no-send replay. Reconcile incident RQs before any authorized repair; do not replay already repaired records.

## Interface ownership

GAS work owns `checkAvailability.js`, `sheetAPI.js`, GAS behavior tests. Worker work owns `tools/ai-browser-worker/worker.mjs`, worker tests and prompt policy. Any native plugin change requires its own repository state/start instructions before editing. Changes are coordinated in this single isolated worktree, and only the main integrator deploys.

## Verification before integration

- Focused plus affected GAS/worker/Gateway/audit tests: 656 passed, 4 existing skipped, 0 failed (2026-09-07).
- Repository static suite: 256 passed using bundled Git Bash on Windows.
- Independent review found the independent-rental exception bypassed pending deduplication. Corrected: it bypasses registered reconciliation only; pending duplicate and revision guards remain active.
- Native Hermes xai-oauth/grok-4.5 xhigh, zero tools: seven sanitized synthetic semantic scenarios passed. This does not claim historical end-to-end replay or live write verification. Initial default SSE timeout failed; only the isolated second run used a longer timeout.
- Customer pending revision supports an explicit four-field baseline with blank unknown values, and a complete desired period. Existing staff/registered authority remains separate. Commercial fields, including blank values, remain unchanged.
- Live incident repair is recorded privately outside Git. Deployment must independently read back GAS version, production file hashes, direct CDP authentication/watcher, and Gateway state. Preserve production-only outbound attachment/readback protection with a three-way worker merge.
