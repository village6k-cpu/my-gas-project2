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
executor and observation module hashes and an `owned_drains` reference. The latter has schema
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

Detached Bun/GBrain processes require an explicit ownership resolution before a closed
store can be claimed. Both bun.exe and gbrain.exe are included even though no service
owner uses it as its main executable. A child Bun is preserved only when exact
ancestor identities attach it to a verified current service owner.

Current observation/executor tests pass43/43 on Windows and native Mac with exact
matching module/test hashes. This is controller/fixture
evidence, not proof of an actual service recovery. Actual source-stop input
generation, closed capture, activation binding and live recovery remain separate
requirements before declaring rollback_ready.

## Closed capture continuation

`migration_closed_capture.py` requires the real five-owner stop receipt, a bound
accepted-work closure receipt, the current scheduler fence, paused owned watcher,
absent source descendants/scheduled writers and fresh destination inactivity.
It preserves six roots, rechecks closure after each root and never stops/starts a
service. Pending uncertain obligations require an explicit no-replay preservation
manifest; a cold copy does not resolve them.

Sixteen capture tests pass on Windows and native Mac (59 total with observation
and recovery). Real temporary SQLite WAL pairs, empty directories and failed /
reserved obligation payloads also survive capture on both hosts. These are
fixture results only. Independent review found two Important bugs, both reproduced
and fixed: success is now published after a staged durable write, and a strict
exclusion allowlist prevents omitting WAL, queue, receipt or current learning data.
Write, flush and fsync fault cases leave no success marker.

Live sizing found12,304,556,471bytes to copy but only10,441,895,936bytes free on
Windows, before the1GiB reserve. Therefore the full local copy mode must NOT be
used for this cutover. No production capture was attempted. The source-closed
direct-stream mode now exists, described below. Do not make a second full database
copy, delete unrelated backups, or clear obligations to bypass this limitation.

`migration_closed_stream.py`, selected with `--stream`, reuses the pinned sender /
receiver with exact relative exclusions. It requires the same real stop and
accepted-work receipts, current fence/watcher and destination inactivity. It
compares independent source inventories to the transport manifest, confirms native
hash readback, checks unchanged source trees and rechecks closure before publishing
the local `COLD-VERIFIED.json`. The native transport `VERIFIED.json` alone never
authorizes final restoration or activation. The cold proof and its bound source /
stop provenance still have to be transferred and validated by the current native
restoration/activation path.

All66current controller tests pass on Windows and native Mac. A closed synthetic
Windows fixture also streamed14files/16directories/98,926bytes through the actual
SSH sender/receiver. Native readback verified all hashes, two WAL pairs and retained
nested `memory/backups` while excluding only root `backups`. No operational source
data or actual stop receipt was used. Independent one-pass stream review reported
no Critical/Important findings. Current final restoration must be adapted from the
old four-owner delta layout to this full-byte streamed layout before actual stop.

The voice frontend now receives both old and new URLs. Complete source recovery
therefore also requires restoring its fresh Windows dispatch lease after backend
recovery. Backend port8788 and five healthy owners alone cannot prove public voice
recovery. The original temporary lease is bound to the original root/voice PIDs
and stops on SOURCE_STOP_REQUESTED, so it cannot simply be restarted after a
replacement process is created. This integration remains required before claiming
rollback_ready or publishing a full source recovery success receipt.
