# Gate 2 — Slack employee intake shell

## Outcome

Prove the smallest Slack-shaped employee flow without connecting to Slack or handling credentials:
one verified synthetic event is authorized, deduplicated durably, routed to the existing Gate 1
`desktop_readiness` action, and posted once through a controlled result sink.

## What already exists

- Gate 1 already owns the pinned Codex executable, short-lived app-server thread, fixed CUA code,
  strict four-boolean result, timeout, and exact-child cleanup.
- Gate 2 imports that bridge. It does not create a second CUA implementation or accept arbitrary
  prompts.
- The repository already uses Node's built-in test runner. No dependency or service is added.

## Scope challenge

The minimum useful slice is one module, one test file, one synthetic runner, and human-facing docs.
A real Slack HTTP/Socket receiver would require signing-secret or app-token authority, a verified
channel installation, network retry behavior, and external message readback. Those are deliberately
deferred until the local lifecycle is proven.

## Architecture

```text
verified synthetic Slack envelope
  -> exact schema validation
  -> fixed team/channel allowlist
  -> fixed action allowlist: desktop_readiness
  -> deterministic requestId = hash(teamId + eventId)
  -> bind canonical full-envelope digest to the request ledger
  -> atomic local ledger claim (open with exclusive create)
       ├── completed            -> DUPLICATE, no execute, no post
       ├── claimed              -> BLOCKED/in_progress
       ├── result_ready         -> resume post only, never re-execute
       └── delivery_unknown     -> BLOCKED, manual review boundary
  -> Gate 1 runDesktopCuaBridge in one short-lived session
  -> persist strict redacted result_ready record
  -> acquire one delivery claim
  -> injected result sink
       ├── delivered=true       -> completed
       ├── delivered=false      -> result_ready, safe retry can resume post
       └── throw/unknown        -> delivery_unknown, never auto-repost
  -> strict redacted Gate 2 receipt
```

The production default action map contains only `desktop_readiness`. Test overrides are available
only behind an explicit seam. The result sink is required, so this gate cannot accidentally claim a
Slack message was posted.

## Contract

- Employee ID: `village-tax-document-clerk`
- Input schema: `gate2-slack-envelope/v1`
- Receipt schema: `gate2-slack-receipt/v1`
- Ledger schema: `gate2-slack-ledger/v1`
- Allowed action: `desktop_readiness`
- Fixed receipt statuses: `PASS`, `BLOCKED`, `REJECTED`, `DUPLICATE`
- No message text, actor profile, Slack token, credential, screen text, screenshot, raw subprocess
  output, thread ID, or Gate 1 run ID is serialized in the receipt.

## State machine

```text
ABSENT --atomic claim--> CLAIMED --Gate 1 result--> RESULT_READY
  ^                         |                         |
  |                         | crash/duplicate         | delivered=false
  |                         v                         v
  |                    BLOCKED/IN_PROGRESS       RESULT_READY
  |                                                   |
  |                                      delivery claim + post
  |                                      /                    \
  |                              delivered=true           unknown throw
  |                                    |                       |
  +---------------------------- COMPLETED             DELIVERY_UNKNOWN
                                      |
                                 DUPLICATE only
```

## Failure modes

| Failure | Handling | User-visible result | Test |
|---|---|---|---|
| Extra/missing envelope field | Reject before ledger/action | `REJECTED/invalid_envelope` | unit |
| Wrong team or channel | Reject before ledger/action | `REJECTED/unauthorized_route` | unit |
| Unknown action | Reject before ledger/action | `REJECTED/action_not_allowed` | unit |
| Same completed event repeated | Read completed ledger | `DUPLICATE`, zero execute/post | integration |
| Same event ID with changed thread/fields | Compare bound envelope digest | `BLOCKED/envelope_mismatch`, zero execute/post | integration |
| Concurrent/unfinished event repeated | Read claimed ledger | `BLOCKED/in_progress` | integration |
| Gate 1 returns malformed data | Store no trusted result | `BLOCKED/malformed_action_result` | unit |
| Known non-delivery | Keep `result_ready` | `BLOCKED/post_failed`, retry posts only | integration |
| Ambiguous sink exception | Keep delivery claim | `BLOCKED/delivery_unknown`, no auto-repost | integration |
| Ledger write failure | Fail closed | `BLOCKED/ledger_failed` | unit |

## Test coverage diagram

```text
CODE PATHS                                      USER FLOWS
[+] processSlackEnvelope                        [+] Synthetic employee request
  ├── exact input validation                      ├── valid -> execute -> post -> PASS
  ├── route/action rejection                      ├── repeated completed -> DUPLICATE
  ├── atomic claim                                ├── post not delivered -> resume only
  ├── Gate 1 strict-result validation             └── ambiguous post -> manual boundary
  ├── result_ready persistence
  ├── one delivery claim
  └── completed/delivery_unknown transition

Target: every branch above has a Node unit or temp-directory integration test.
No E2E Slack test yet because no Slack receiver or credential is in scope.
```

## Performance

- One bounded JSON file and one bounded delivery-claim file per request.
- Direct request-ID lookup, no directory scan or database query.
- Input and stored payload size caps prevent unbounded memory or disk records.
- Gate 1's CUA timeout remains the dominant latency.

## NOT in scope

- Slack app installation, Socket Mode, HTTP Events API, signing-secret verification, OAuth, tokens,
  or real message posting.
- HomeTax navigation, login, certificate/autofill, lookup, issuance, cancellation, or PDF handling.
- Arbitrary natural-language routing, model-authored CUA, multiple employees, scheduling, or daemon
  installation.
- Automatic recovery from ambiguous delivery. That needs Slack message readback or an external
  idempotency key and belongs in the real-connector gate.

## Implementation order

1. Write failing contract, rejection, deduplication, recovery, and delivery-ambiguity tests.
2. Implement the strict receipt validator and file ledger.
3. Implement the fixed action router and controlled result sink.
4. Add the synthetic runner using one real Gate 1 read-only action and a local fake sink.
5. Run Gate 0–2 tests, one safe synthetic live round-trip, and independent review.

Sequential implementation, no parallelization opportunity: all behavior centers on one state
machine and ledger module.

## Stop condition

Stop when the full suite passes, a synthetic live request executes Gate 1 once, a repeat is
suppressed without execution or posting, all temporary ledger files are cleaned, and independent
review finds no material issue. Do not connect Slack or HomeTax in this gate.
