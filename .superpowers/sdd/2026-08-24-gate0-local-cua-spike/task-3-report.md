# Task 3 report — restricted-profile and orphan-recovery feasibility

## Implementation summary

Implemented the fail-closed Task 3 feasibility layer on top of the Task 1 evidence contract and Task 2
identity seams.

- `restricted-profile-probe.mjs` compares normal diagnostic execution with the exact restricted invocation
  `codex exec --ignore-user-config --sandbox read-only`. It accepts one exact boolean record only, records
  normal/restricted shell presence separately, and requires mechanical denial of direct `node_repl`, raw input,
  helper sockets, and ledger writes before the narrow action path can pass.
- `orphan-recovery-probe.mjs` authorizes only synthetic one-use epoch grants and identity-matched disposable
  child PID/PGID records. It re-reads executable/start identity before TERM and before KILL, and blocks wrong
  epochs, reused grants, PID reuse, identity mismatch, and unrelated targets without signaling.
- Adversarial tests cover forged evidence, malformed output, direct `node_repl` still available, command failure,
  wrong epoch, revoked/reused grants, executable/start mismatch, PID reuse, and unrelated PID protection.
- README documents the restricted boundary and states that live disposable-child validation remains Task 4.

## Verification

Command:

`node --test tools/local-cua-clerk/gate0/*.test.mjs && git diff --check`

Result: **27 passed, 0 failed, 0 skipped; `git diff --check` passed.**

No real Codex, node_repl, GUI, raw input, launchctl, HomeTax, credential, GAS, Sheets, or unrelated process
action was performed. Task 4 remains responsible for live disposable-child validation.

## Concerns

- The restricted probe intentionally returns `SUPERVISED_ONLY` at Gate 0 report level unless the complete
  restricted assertion set proves a narrow action path while all raw/global CUA capabilities are denied.
- The orphan runner's live default child path is not exercised here; only injected seams and adversarial unit
  tests were run.

## Review fixes

- Restricted-profile model claims can no longer produce `PASS`; an out-of-band denial/helper check is required
  in a later live gate. Restricted PASS evidence now requires all comparison booleans, including explicit direct
  `node_repl` denial and both shell observations.
- Orphan grants are bound in a private ownership registry to the exact PID/PGID/executable/start identity and
  are consumed before the first signal, preventing partial-cleanup replay.
- Identity capture failure uses only the exact spawned child handle for a bounded cleanup attempt and records
  `cleanup_incomplete` when the handle remains alive.

Review-fix verification: `node --test tools/local-cua-clerk/gate0/*.test.mjs && git diff --check` — **30 passed,
0 failed, 0 skipped; diff check passed.**

## Second review fixes

- Orphan grant creation, registration, and recovery are now private; the module exports only the runner.
  Injected tests can supply a child/identity/signal seam but cannot authorize an arbitrary target.
- The private registry binds grant ID, epoch, and exact child identity together and owns consumption state.
  Caller-supplied used sets cannot reset replay protection.
- `orphan_recovery: PASS` requires positive registered-child, exact-identity, active-epoch, one-time-consumed,
  unrelated-PID, and cleanup-completed booleans. Empty evidence cannot contribute to global PASS.
- Regressions cover public export absence, same-ID/different-epoch denial, fresh-run replay isolation, and
  positive global orphan proof.

Second review verification: `node --test tools/local-cua-clerk/gate0/*.test.mjs && git diff --check` — **31 passed,
0 failed, 0 skipped; diff check passed.**
