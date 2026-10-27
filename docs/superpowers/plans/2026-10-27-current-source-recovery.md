# Current source recovery observation boundary

The October 27 source has five service owners: root, Kakao worker, guarded
bridge, guarded browser relay, and voice. The old four-owner recovery planner
cannot establish closure or restoration for this source. The browser is preserved
separately; its process is not a service to restart through this planner.

`scripts/windows/migration_source_recovery.py` ports the existing read-only
planner to this five-owner contract and the 16 prepared Mac service labels. It
never starts a process, enables a task, changes a watcher, restores data, repairs
a receipt, or authorizes execution. Its `ready` result is an observation plan,
not `rollback_ready` or migration activation authority.

Required observations include a hash-bound stop receipt for exactly five owners,
complete pre-stop child inventories, fresh source identities and listener owners,
and fresh authenticated Mac inactivity. A previously activated destination forbids
this preactivation source recovery path even when currently inactive. Missing or
unreadable evidence fails closed. Actual launchctl absence requires a verified
gui/501 domain, exit 113 and the exact pinned missing-service diagnostic.

Root/worker/voice missing-owner steps name their original scheduler tasks; those
names do not grant permission or establish ability to start them. Bridge and
relay missing-owner steps require the current guarded recovery procedure. They
never name the old normal-send bridge start task. The executor still has to bind
the 21-task fence, its current administrator lease, current guarded dependencies,
watcher ownership, startup holds, source identity and final health/readback.

Old parents and every recorded old child must be gone for a stopped role. An
exact replacement requires the full original execution contract and matching
listener ownership. Unknown processes sharing the profile block an absence
claim. A different helper entrypoint is excluded only if its observed ancestor
identities prove it belongs to the exact selected replacement. A second gateway
entrypoint with altered arguments still blocks, including under that replacement.
Separate scheduled/detached-writer auditing is mandatory before final capture.

Tests port the existing identity, stale-proof, listener, old-child, duplicate and
partial-observation cases and add guarded relay closure, rejection of four-role
receipts, 16-label/domain proof, replacement-helper lineage and changed gateway
arguments. The original four-role implementation was observed failing these
five-role and helper-lineage cases before adaptation. No stop receipt has been
fabricated and no live restoration has been executed.

Current verification: 26/26 cases pass on both Windows and native Mac. The one
independent review found an Important helper-classification bypass: inserted
interpreter options or invoking a module through its script path could hide a
second gateway. Seven failing subcases were observed, then passed after parsing
known invocation forms and blocking unclassified forms. No re-review was used
in place of the regression tests. Live Mac observation also confirms gui/501,
all 16 labels absent, inactive marker present and activation absent. These facts
still do not validate the unfinished recovery executor or production cutover.
