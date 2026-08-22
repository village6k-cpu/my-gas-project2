# Kakao Native Hermes Gateway Session Design

**Date:** 2026-08-20
**Status:** Approved for implementation planning on 2026-08-21; live cutover remains a separate owner-approval gate
**Primary objective:** Replace the Kakao worker's per-decision Hermes CLI processes with one long-lived stock Hermes Gateway lifecycle while preserving AI-first judgment, current safety gates, and owner approval for every schedule result.

## 1. Non-negotiable principles

1. Hermes remains the business decision-maker. Code may transport evidence, expose tools, validate typed contracts, enforce negative safety gates, execute an AI-selected action, and verify readback; it must not classify customer intent or author customer prose.
2. Use stock Hermes Gateway sessions, turn handling, agent caching, interruption, persistence, and recovery. Do not build a Village session engine, semantic router, broker, or custom agent daemon.
3. Kakao-specific code is a thin platform boundary. It must not duplicate the Slack adapter's session or reasoning implementation.
4. A schedule or availability result is never sent to a customer without owner approval. This rule applies to available, warning, unavailable, unknown, and contradictory results.
5. General FAQ and other currently approved safe classes may remain auto-send candidates when the existing high-confidence, grounding, kill-switch, freshness, and transport gates all pass.
6. Validation must not send Kakao, Slack, SMS, or other messages, mutate Sheets/GAS, deploy, or change live webhooks.
7. Keep internal GAS credentials outside prompts, browser code, logs, plugin descriptors, and versioned documentation.
8. Preserve unrelated dirty worktrees and repositories. In particular, the existing `C:\Village\village-ai` working tree is not an implementation target; any work there uses a fresh worktree.

## 2. Confirmed current state

### 2.1 One-shot Hermes lifecycle

The Kakao worker currently builds a CLI call equivalent to:

```text
hermes --profile kakaoworker chat --yolo --max-turns 90 -Q \
  -t terminal,file,web,skills,memory,session_search,vision \
  -s village-operations,village-confirm-request -q <prompt>
```

`runHermes()` starts a new child process for every call. On Windows it starts `hermes-stdin-runner.py`, which reads one JSON object, imports `hermes_cli.main`, runs one query, and exits. No resume identifier or native gateway session key is passed.

`runHermesDecision()` may start a second fresh process when the first output times out or fails the typed decision contract. A schedule request then performs a separate post-action Hermes decision after the Sheet result, with its own first/recovery process possibilities.

One customer event can therefore pay for:

1. Python and Hermes import/startup;
2. profile, prompt, skill, and tool initialization;
3. initial model reasoning;
4. optional recovery startup and reasoning;
5. authoritative Sheet action;
6. a second Hermes startup and reasoning over the Sheet result;
7. optional second-pass recovery.

This is a legacy subprocess boundary, not a stock Hermes requirement.

### 2.2 Measured production latency

The latest 80 audited worker results on 2026-08-20 showed:

| Stage | Sample | Median | P95 | Average |
|---|---:|---:|---:|---:|
| read-only lookup | 80 | 3.6 s | 4.6 s | 3.7 s |
| DOM capture | 80 | 2.2 s | 5.3 s | 2.9 s |
| Hermes | 30 | 100.9 s | 151.8 s | 106.7 s |
| Sheet plus post-action reconciliation | 30 | 37.8 s | 99.5 s | 45.7 s |
| total, all audited outcomes | 80 | 65.7 s | 237.8 s | 92.3 s |
| total, completed outcomes | 23 | 176.3 s | 246.3 s | 176.9 s |

DOM capture and GAS lookup are not the primary bottleneck. Long decisions also occupy the two decision lanes, creating secondary queue delay and superseded work.

The live machine had zero dead-parent `git.exe` processes during this audit. The active `village-operations` and `village-confirm-request` entrypoints were about 9.7 KB and 7.3 KB. The prior orphaned-git and oversized-skill incidents are not the current shared cause.

The active worker profile was `grok-4.5`, `xai-oauth`, `reasoning_effort: xhigh`, and `max_turns: 90`. Exact startup, provider queue, first-token, tool, and inference shares remain unknown because the current audit records only the aggregate Hermes span.

### 2.3 Current timeout behavior

There are three different failure boundaries:

1. **Decision-pass failure:** the first one-shot CLI process is killed; a fresh recovery CLI process runs only if at least 45 seconds of the decision budget remains.
2. **Post-action failure:** the authoritative schedule result is retained, but the customer reply is suppressed and an owner-review path is produced.
3. **Outer worker timeout:** at 300 seconds the bridge kills the complete worker tree, records `ai_worker_error`, creates an urgent human-review follow-up, and leaves the durable recovery sweeper to retry. The sweeper runs every five minutes, waits fifteen minutes before replaying an error, attempts at most twice, and then changes the case to `needs_human_review`.

This behavior is fail-closed, but it destroys useful warm state and repeats the most expensive work.

### 2.4 Stock Hermes capabilities already available

The installed Hermes source already provides:

- an official platform-plugin path using `BasePlatformAdapter`;
- deterministic `SessionSource` to `session_key` construction;
- profile namespaces, so `kakaoworker` sessions cannot collide with default-profile sessions;
- persisted session IDs and SQLite conversation history;
- per-session turn serialization, interruption, queued-message handling, and stale-result protection;
- per-session `AIAgent` caching when the configuration signature is unchanged;
- idle/LRU eviction with resumable persisted state;
- reset policy defaulting to `none`, meaning sessions persist unless explicitly reset or compressed.

The native gateway is therefore the session owner. The Village system only needs to provide a transport adapter and bounded operational tools.

## 3. Evaluated approaches

### 3.1 Continue one-shot CLI with `--resume`

This would restore transcript history but still start Python, import Hermes, reconstruct the agent, load the profile, and initialize tools on every phase. It also leaves Node responsible for session ID mapping, locking, recovery, and corruption handling.

**Decision:** Rejected as the target. It may be used only as an emergency rollback-compatible bridge.

### 3.2 Call the stock Hermes API Server

The API Server keeps the Python interpreter alive and supports persisted sessions. However, its current request path constructs a new `AIAgent` for each session-chat call. It is safer than CLI resume and useful for isolated benchmarks, but does not provide full Slack-style agent-cache parity.

**Decision:** Retain as a diagnostic fallback, not the production target.

### 3.3 Build a custom persistent stdin/JSON daemon

This would load Hermes once but duplicate gateway session, agent-cache, interrupt, queue, persistence, recovery, and resource-eviction behavior.

**Decision:** Rejected. This is the extra layer the architecture must remove.

### 3.4 Use the experimental generic Relay connector

Relay is designed for external connectors and already reaches the native adapter path, but its protocol is explicitly experimental and carries capability negotiation and multi-platform behavior the local Kakao DOM bridge does not need.

**Decision:** Rejected for the first production implementation. Re-evaluate only if Relay becomes stable and replaces rather than supplements the thin Kakao plugin.

### 3.5 Stock Gateway plus a thin Kakao platform plugin

The plugin converts the bridge's captured Kakao event into `MessageEvent`/`SessionSource`, calls the standard adapter `handle_message()` path, and returns the final typed result to the bridge. Hermes owns the session and agent; the bridge owns browser I/O and final delivery.

**Decision:** Approved target.

## 4. Target architecture

```text
Kakao Channel Manager Chrome
        |
        | DOM/CDP read-only capture
        v
Village Kakao DOM bridge
  - debounce and durable job
  - freshness / supersession
  - final transport safety gate
        |
        | authenticated loopback event
        v
Kakao platform plugin in stock Hermes Gateway
  - roomKey -> SessionSource(chat_type=dm)
  - no semantic routing
  - no customer prose
        |
        v
Stock Hermes Gateway / kakaoworker profile
  - persistent session_key
  - cached AIAgent
  - native skills and tools
  - native interrupt / queue / recovery
        |
        +--> read-only Village lookup tools
        +--> bounded confirmation-request tool
        |      - typed validation
        |      - idempotent GAS action
        |      - authoritative result readback
        |
        v
Typed Kakao decision envelope
        |
        v
Village Kakao DOM bridge
  - validate envelope
  - owner-review gate for every schedule result
  - send only when all existing gates pass
```

There is one long-lived Hermes process for the `kakaoworker` profile. Customer rooms are isolated by the stock session key generated from the profile, platform, DM type, and stable `roomKey`.

## 5. Component ownership

### 5.1 `my-gas-project2`

Keeps only Village system and transport responsibilities:

- Kakao DOM/CDP watcher and evidence capture;
- debounce, durable queue, job freshness, recovery sweeper, and result audit;
- GAS/Sheet APIs and their structural validation;
- final Kakao delivery implementation;
- negative safety gates, including mandatory schedule-result owner approval;
- the small loopback transport contract used by the plugin.

It must no longer contain a Hermes CLI launcher, recovery prompt, or a second semantic reasoning pass in the production decision path after cutover.

### 5.2 `village-ai`

Owns versioned Hermes/Village agent integration source:

- the thin Kakao platform plugin;
- the native Village confirmation-request tool wrapper;
- profile-facing tests and packaging metadata;
- the concise Kakao worker operating skill and tool descriptions.

Implementation uses a new clean worktree. Existing dirty files and the current `village-brain/deep-knowledge-batches` branch are preserved untouched.

### 5.3 Installed Hermes profile

`C:\Users\ssper\AppData\Local\hermes\profiles\kakaoworker` contains the installed runtime artifact and native session state. It is not hand-edited as the canonical source.

Routine startup must not perform whole-tree migration or overwrite native session/learning state. Installation and rollback are explicit operations with hashes and backups.

## 6. Session and turn model

### 6.1 Stable identity

- `roomKey` is the stable `chat_id` supplied to `SessionSource`.
- The source is a DM and does not synthesize a per-message `thread_id`.
- The `kakaoworker` profile namespace isolates these sessions from Slack and other profiles.
- Customer display name is metadata only; it is never the session identity because names can collide or change.
- `jobId`/`eventHash` identifies one transport event and is the idempotency key, not the conversational session key.

### 6.2 Normal FAQ turn

1. Bridge captures the current room and verifies the room/revision.
2. Plugin emits one native Hermes message event under the room session.
3. Hermes uses current policy or read-only RAG as needed and returns one typed decision.
4. Bridge validates the decision and applies the existing FAQ auto-send gates.
5. The next message in that room reuses the same cached agent when configuration is unchanged.

### 6.3 Reservation or schedule turn

1. Hermes reads the Kakao evidence and decides whether a confirmation request or authoritative schedule lookup is needed.
2. Hermes calls the native confirmation-request tool with typed arguments.
3. The tool validates structure, asserts event freshness, executes the existing idempotent GAS operation, and returns the complete authoritative availability result.
4. Hermes interprets that tool result in the same native agent turn. There is no outer post-action Hermes restart.
5. Hermes returns a typed decision and proposed customer draft.
6. Because the turn observed an authoritative schedule result, the bridge forces `draft_only + owner_review_required` regardless of the result status or wording.
7. Owner review may later authorize delivery through the existing explicit action path.

The tool performs I/O and contract enforcement only. It does not decide customer intent, equipment equivalence, whether to write, how to interpret availability, or how to phrase the response.

### 6.4 Same-room concurrency

- Native Gateway per-session serialization is authoritative.
- A newer room revision interrupts or supersedes the in-flight turn using native interruption rather than killing the gateway process.
- Before any tool mutation and before final delivery, the bridge/tool checks that the job's room revision is still current.
- A stale result is persisted for audit but cannot write or send.
- Different rooms may execute concurrently within the configured gateway and bridge limits.

## 7. Tool and transport contracts

### 7.1 Inbound event

The bridge supplies a bounded, authenticated event containing:

- `jobId`, `eventHash`, `roomKey`, `roomRevision`, and timestamps;
- captured room title and sender-labelled visible message evidence;
- capture provenance and target identity proof;
- kill-switch/read-only lookup status;
- recent bot-send evidence needed for duplicate prevention;
- no internal GAS credential.

The plugin maps this mechanically into a native `MessageEvent`. It does not choose a business classification.

### 7.2 Confirmation-request tool

The tool accepts the same business candidate fields currently validated by the worker and GAS, including customer, dates, equipment, quantities, optional component selections, contact, discount type, memo, and idempotency/freshness identifiers.

Before execution it must:

1. validate the typed schema;
2. verify the event is still current;
3. verify the internal principal is authenticated;
4. preserve exact equipment-name and set-component safeguards;
5. use the existing duplicate protections;
6. avoid exposing credentials or raw private responses to the prompt.

The returned value includes the generated request ID, executed arguments, per-item status/detail, overall status, and explicit error type. Hermes receives the facts needed to reason without running another process.

### 7.3 Decision envelope

Keep a typed final envelope so the bridge can enforce safety without interpreting prose. At minimum it carries:

- classification and confidence chosen by Hermes;
- kill-switch observation;
- customer/reply decision;
- Sheet action summary and authoritative tool-result metadata;
- follow-up item;
- owner-review requirement;
- evidence/freshness identifiers;
- safety class and grounding.

Contract validation may reject malformed or contradictory output. Repair occurs as a continuation in the same native session/agent, not a new CLI process. Code must not fill missing business decisions from keywords.

### 7.4 Schedule approval signal

The hard gate is based on authoritative execution state:

```text
turn.used_authoritative_schedule_tool == true
OR decision.authoritative_sheet_result is present
    => customer transport requires owner approval
```

It is not based on detecting words such as `가능`, `스케줄`, or `예약` in prose. This keeps the gate deterministic without adding a semantic router.

## 8. Timeout, retry, and recovery design

### 8.1 Instrument before tuning

Add timings for:

- gateway queue wait;
- session lookup/acquisition;
- cached-agent hit/miss and construction;
- model request start and first token;
- each tool call;
- decision-contract repair;
- final result and total wall time.

Do not lower model, reasoning effort, tools, or prompt capability to manufacture a latency improvement.

### 8.2 Turn timeout

- A bounded Kakao turn deadline remains, initially matching the current safe outer budget until benchmarks justify a lower value.
- Deadline expiry invokes the native session interrupt/cancel path.
- The gateway process and session mapping remain alive.
- No customer delivery occurs from a timed-out or interrupted generation.
- The case is persisted as retryable with its session key and event identity.

### 8.3 Retry

- Retry continues the same room session with a compact system-authored recovery event describing the failed phase and preserved authoritative results.
- A tool action is never repeated when its idempotency key has already completed; the prior readback is reused.
- At most two durable retries remain, followed by `needs_human_review`.
- A newer customer event supersedes the old retry and becomes the next native turn.

### 8.4 Gateway restart

- The scheduled task restarts the `kakaoworker` Gateway/profile, not an individual per-request CLI.
- Native persisted sessions are reloaded after restart.
- In-flight jobs remain in the bridge's durable queue and resume or escalate according to idempotency/readback state.
- Restart does not sync or overwrite the profile's skills or session state.

## 9. Security and authority

1. Plugin transport is loopback-only and authenticated with a runtime secret stored outside Git.
2. The internal GAS credential is owned by the tool/bridge runtime and never included in model text, browser JavaScript, or the event envelope.
3. Public `village2026` remains read-only and cannot perform confirmation, registration, approval, or send actions.
4. Every internal response must prove `authenticated:true`; HTTP 200 alone is failure.
5. The plugin cannot directly type into Kakao. All customer delivery goes through the existing bridge gate and immutable room snapshot check.
6. Logs store hashes, timings, status, and bounded redacted tails rather than full customer conversations or secrets.

## 10. Test strategy

Implementation follows test-driven development. Add each regression test first and confirm it fails for the intended reason.

### 10.1 Lifecycle tests

- two messages for one `roomKey` map to one stock session key;
- different rooms and profiles do not collide;
- the second warm turn reuses the cached agent;
- production decision handling does not spawn `hermes-stdin-runner.py`;
- restart reloads the same persisted session mapping.

### 10.2 Reasoning-flow tests

- FAQ completes in one native agent turn;
- confirmation request invokes one native tool and interprets its result in the same turn;
- malformed final output repairs within the same session;
- no custom code classifies reservation/FAQ/price intent or authors reply prose.

### 10.3 Safety tests

- every authoritative schedule status forces owner review and blocks customer send;
- ordinary grounded FAQ remains eligible for the existing auto-send gate;
- stale room revision blocks tool mutation and send;
- duplicate event/tool key cannot create a second confirmation request;
- timed-out/interrupted output cannot send;
- internal credentials never enter prompts, responses, logs, or browser code.

### 10.4 Recovery tests

- a timeout interrupts only the affected session turn;
- a retry reuses the same session and prior tool readback;
- a newer room event supersedes an old retry;
- two failed retries escalate once to human review without looping;
- gateway restart preserves completed-tool idempotency and owner-review state.

### 10.5 No-send integration proof

Use fixed, anonymized fixtures for:

- simple policy FAQ;
- complete reservation request;
- missing-phone reservation request;
- available, warning, unavailable, and unknown schedule results;
- malformed first decision requiring repair;
- timeout after tool completion;
- same-room rapid follow-up;
- two rooms running concurrently.

Validation uses fake GAS and fake Kakao transports. Live customer rooms are not used for mutation or delivery tests.

## 11. Performance acceptance criteria

Compare identical fixtures on the same PC, model, provider, reasoning effort, skill set, and tool capability.

The candidate passes only when all are true:

1. zero per-request Hermes/Python process starts after the gateway is warm;
2. zero production calls to `hermes-stdin-runner.py` in the new path;
3. a schedule request uses one native agent run, with its GAS action as a tool call, rather than initial plus post-action agent processes;
4. completed-fixture median wall time improves by at least 40% from the recorded baseline;
5. completed-fixture P95 improves by at least 30%;
6. queue wait does not increase under the same two-room concurrency fixture;
7. output correctness, exact equipment handling, duplicate prevention, owner approval, and no-send safety do not regress;
8. no model/reasoning/tool reduction is used to reach the target.

If the structural criteria pass but latency does not, use the new first-token/tool timings to separate provider latency from local lifecycle cost before changing any model setting.

## 12. Migration and rollout

1. Capture current process tree, hashes, profile config, scheduled-task definition, worker timing baseline, and rollback artifacts.
2. Create a clean `village-ai` worktree for plugin/tool source; do not touch its dirty working tree.
3. Add failing lifecycle and safety tests.
4. Implement the loopback plugin and fake transport against an isolated Hermes profile.
5. Implement the native confirmation-request tool against a fake GAS server.
6. Connect the plugin to the existing bridge in dry-run/no-send mode; current production worker remains authoritative.
7. Run read-only shadow fixtures. The shadow path cannot write Sheets or send Kakao.
8. Run isolated one-writer tests using only fake/local fixtures and prove idempotency/readback.
9. Benchmark against the recorded one-shot baseline and review results.
10. Prepare explicit installation and rollback scripts with SHA-256 inventories.
11. Request owner approval for live cutover.
12. At cutover, stop the old worker decision consumer, start the persistent `kakaoworker` Gateway path, and keep Kakao auto-send disabled until runtime readback passes.
13. Verify profile/session identity, adapter connection, direct CDP authentication/watcher readiness, queue ownership, tool authentication, and no-send decision results.
14. Enable only previously allowed general FAQ auto-send after approval. Schedule results remain owner-review-only.

No step runs both old and new consumers with write authority.

## 13. Rollback

- Stop the new Kakao plugin consumer.
- Restore the old bridge worker command and its known-good runtime configuration.
- Preserve new Hermes session and audit artifacts for diagnosis; do not delete them.
- Restart through the existing bounded no-send path.
- Verify CDP authentication, watcher readiness, queue ownership, internal GAS authentication, and no customer delivery before returning control.
- Rollback never rewrites business data. Completed idempotent Sheet actions remain authoritative and are read back before replay.

## 14. Rejected architectural drift

The implementation is non-compliant if it introduces any of the following:

- a Node or Python customer-intent router before Hermes;
- keyword-based business classification or reply generation;
- a custom persistent agent/session daemon;
- a room-to-session database that duplicates Hermes session ownership;
- a second Hermes reasoning process after the schedule tool result;
- direct customer delivery from the plugin that bypasses the bridge safety gate;
- startup-time whole-tree skill/profile synchronization;
- lower model/reasoning/tool settings presented as an architectural speed fix.

## 15. Completion criteria

- One persistent stock Hermes Gateway lifecycle serves Kakao.
- `roomKey` uses stock profile-scoped session persistence and cached agents.
- Schedule lookup/write and interpretation complete inside one native agent turn.
- All schedule results require owner approval and cannot auto-send.
- General FAQ safety behavior remains available.
- Timeouts interrupt a turn without destroying the gateway/session and retry without duplicate writes.
- The production decision path no longer starts `hermes-stdin-runner.py` or runs post-action Hermes CLI recovery.
- Component ownership is separated: Village system/transport in `my-gas-project2`, Hermes integration in `village-ai`, installed state in the `kakaoworker` profile.
- Fixed no-send benchmarks meet the latency and correctness gates.
- Installation, runtime readback, and rollback are documented and tested before live cutover.
