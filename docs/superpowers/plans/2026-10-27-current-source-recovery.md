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
still do not validate operational recovery or production cutover.

## Current executor continuation

`migration_source_recovery_executor.py` now implements guarded preactivation
recovery sequencing. It starts the worker before guarded bridge/relay recovery,
then root and voice. It preserves verified replacements/unaffected owners and
never enables a scheduler task, starts the normal-send bridge task or rewinds data.
Each step rechecks exact owners, current task definitions/fencing, protected
dependency hashes, owned watcher state and fresh native inactivity. Source
readiness must be verified before resuming the owned watcher and writing the
five-role recovery proof consumed by the administrator broker. The broker alone
restores the original21scheduler states.

Recovery requires a hash-bound `village-current-recovery-inputs/v1` document in
the current protected control directory. It binds intent, stop receipt, scheduler
manifest/states, browser, watcher pause/helper, captured per-role environments,
executor hash and an `owned_drains` reference. The latter has schema
`village-owned-drains/v1`, migration ID, intent SHA and root/worker records with
exact marker path/hash, original absence, creation status and source owner identity.
These must be produced by the real source-stop controller; none has been fabricated.

Independent review found two Important failures. Both were observed failing and
fixed: a migration drain left on Windows would park a restarted gateway, and a
helper inheriting production HOME would reject itself as an unknown source owner.
Only the exact hash-bound migration drain can be removed, under fresh fencing and
closure proofs. An unaffected old owner may cancel its own migration drain only
when the planner proves its exact preserved identity. Unrelated/changed markers
are retained. Removal intent is persisted before the operation.

Every controller/helper must start with HERMES_HOME equal to the protected
control's `helper-home` and PYTHONPATH absent. The child launcher sets these in its
own PowerShell environment; captured original environment is passed only to the
real service. The parent controller launcher must apply the same isolation.
Writer detection is not weakened. An exclusive child-attempt journal prevents
two copies of the child launcher from starting the same role.

Current observation/executor tests pass38/38 on Windows and native Mac. This is controller/fixture
evidence, not proof of an actual service recovery. Actual source-stop input
generation, closed capture, activation binding and live recovery remain separate
requirements before declaring rollback_ready.
