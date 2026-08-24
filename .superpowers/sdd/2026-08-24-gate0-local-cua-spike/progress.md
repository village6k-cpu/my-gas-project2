# SDD ledger — plan: /Users/choijaehyeong/my-gas-project2-worktrees/gate0-local-cua/docs/superpowers/plans/2026-08-24-gate0-local-cua-spike.md

Spec: /Users/choijaehyeong/.gstack/projects/village6k-cpu-my-gas-project2/choijaehyeong-main-design-20260824-090035.md
Branch: codex/gate0-local-cua
Start HEAD: 9d2f087
Start guard: `./scripts/startwork.sh` passed.
Baseline: no root package/test command; Desktop `node_repl` read-only Chrome observation returned mac target, AX available, screenshot available, with no page text retained.

## Pre-flight interaction scan

| Tasks | Producer → consumer / shared interface | Finding |
|---|---|---|
| 1 → 2 | strict evidence contract → terminal/LaunchAgent runner | Compatible; Task 2 must import rather than duplicate serialization. |
| 1 → 3 | verdict states and redaction → restricted/orphan probes | Compatible; Task 3 must not add raw stdout fields. |
| 1 → 4 | report derivation → live verdict | Compatible; Task 4 consumes only schema-valid evidence. |
| 2 → 3 | Codex spawn/parser contract → restricted profile comparison | Compatible; Task 3 may reuse injected runner interfaces. |
| 2 → 4 | terminal/LaunchAgent runner → live execution | Compatible; live launchctl is deferred to Task 4. |
| 3 → 4 | denial/orphan probes → autonomous/supervised verdict | Compatible; an unproven narrow helper forces `SUPERVISED_ONLY`. |
| 1 self | contract, runtime collector, tests | Consistent; dependency-free Node 22 and injected subprocess output. |
| 2 self | unit-only runner implementation before live launchd | Consistent; temporary label and cleanup are testable without side effects. |
| 3 self | denial feasibility without real clicks | Consistent; outcome may be supervised rather than forced pass. |
| 4 self | live probe order, report, cleanup | Consistent; TCC/security prompts stop only that probe and are never accepted. |

Ruling: The external approved design is the binding spec; this in-repo plan is the bite-sized execution argument — if they conflict, preserve the design's fail-closed Gate 0 criterion — cost if wrong: a probe may stop earlier and classify supervised rather than claim autonomy.

Ruling: Gate 0 does not justify building the Slack daemon or production native helper — implement only enough harness to prove or disprove feasibility — cost if wrong: a later v0 task may need additional helper implementation.

Ruling: A TCC, credential, CAPTCHA, Keychain, or permission prompt is evidence of a human boundary, not permission to click it — cost if wrong: the corresponding live criterion remains BLOCKED until the user acts.

Ruling: The one allowed final-review fix wave is code/test/non-live artifact correction only; it must preserve operational `BLOCKED`, must not target the retrospectively unowned residual label/PID/PGID, and must not reinterpret the historical synthetic checkpoint as audited human resume evidence — cost if wrong: a cleanup or resume claim could authorize unsafe unattended operation.

## Task status

- Task 1: complete (`69226de..6c61532`); tests 4/4; `git diff --check` passed; independent task review CLEAN after fail-closed probe-set, nested-schema, runtime-failure, and sensitive-value fixes.
- Task 2: complete (`6c61532..96d788f`); full suite 19/19 on three reviewer runs; `git diff --check` passed; independent task review CLEAN after bounded child identity, PID-reuse, exact-child reaping, and LaunchAgent cleanup fixes.
- Task 3: complete (`96d788f..f0fe7dc`); full suite 30/30; `git diff --check` passed; independent task review CLEAN after mechanical restricted-profile fail-closed rules and private epoch/grant/orphan ownership fixes.
- Task 4: complete (`f0fe7dc..1c01158`); full Gate 0 suite 42/42 twice; strict committed-artifact roundtrips and `git diff --check` passed; operational verdict `BLOCKED`; task review CLEAN after the single final-review fix wave.
- Final-review fix wave: complete (`1c01158`); exact-label cleanup failure overrides PASS and retains the private recovery mapping, all nine PASS schemas are exact/complete, orphan recovery uses separate revoked-daemon/recovery authority, JSONL is single-result and 64 KiB bounded, runtime diagnostics are non-contract, and canonical `human_resume` is `NOT_RUN`.
