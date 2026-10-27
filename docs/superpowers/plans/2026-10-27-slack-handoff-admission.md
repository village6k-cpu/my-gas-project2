# Slack handoff: capture and one-consumer admission

Migration step 4b builds on `2026-10-27-slack-handoff-storage.md`. It prepares the
connection-facing capture callback and a durable journal around the installed
original Bolt dispatcher. It opens no connection, creates no operational
authority, changes no live source code and does not complete the migration.

## Invariants

- `CaptureReceiver.on_socket_request` accepts the installed SDK request, retains
  retry/capability metadata omitted by SDK `to_dict()`, then commits before ACK.
  Only the storage component's supported event callbacks are ACKed. Interactive,
  slash and unknown requests remain held without ACK; no live collector may be
  started while their handoff policy and current source closure are unresolved.
- A process-held OS file lock permits one admission owner per inbox. SQLite
  transactions serialize capture and admission across independent connections.
- Before invoking Bolt, commit a unique `dispatching` claim bound to the captured
  payload and delivery hash. Admit pending events in capture sequence. Verify the
  live authority both before and after claim, and again after dispatch.
- Invoke the installed `run_async_bolt_app` against the original initialized app.
  Preserve its authorization, middleware, listener and background processing.
  No second network ACK is sent by this dispatch helper.
- Bolt HTTP status 200 means `admitted`, never completed customer/business work.
  Its asynchronous listener may still be running. No API here returns migration
  complete or customer outcome verified.
- A worker finish writes blocking `admission_pending`; a short synchronous final
  commit confirms it only after the surviving caller rechecks authority, with no
  async cancellation point through return. A cancelled worker cannot later clear
  the fence. A crash/interruption/exception/non-200 or unconfirmed finish leaves a
  `dispatching`/`admission_pending`/`uncertain` fence. It blocks new admission, including after process
  restart. There is no retry, reset or presumed-zero-write recovery API.
- Conflicting/held input blocks admission; conflict arriving during dispatch
  prevents a subsequent `admitted` result. The original payload remains stored.

## Caller boundary

`can_dispatch` is a trusted orchestration callback, not Slack input or a health
check. It must revalidate the current single-consumer closure, final copied state,
activation manifest and recovery authority. Only literal `True` permits a claim.
The current production launcher has not been connected to this module. Supplying
a synthetic test callback is not production activation evidence.

Existing source intake cannot yet be detached losslessly by the available
maintenance marker. A real handoff still needs that source boundary, all supported
interactive/request classes, a connection readiness/closure protocol and final
state reconciliation. No Windows task/process may be stopped on the strength of
this component's offline test results.

## Verification and review focus

Synthetic tests cover capture-before-ACK, independent-process ownership, ordered
one-time admission, duplicate suppression, authority revocation, cancellation and
interrupted claims. A real SQLite reader lock makes finish COMMIT fail and proves
the earlier no-retry fence survives. The installed real Bolt middleware/listener
pipeline is exercised with a synthetic authorizer and network connections denied.

Review race conditions between capture, claim, callback and finish; crash/commit
failure outcomes; lock lifetime; receipt identity; and the difference between
admission and authoritative business completion. Treat the unfinished production
connection/closure/interactive work as an explicit remaining migration gate.

Current verification: 20 admission/installed-SDK cases pass on Windows and Mac.
The full helper suite passes 70/70 on native Mac and 69 with one POSIX skip on
Windows. One independent review found cancellation during the finish worker could
clear the intended blocking fence. Two regression tests were observed failing,
then passing after the pending-confirmation fix; no re-review was substituted for
those tests. No Socket Mode connection or operational consumer was started.
