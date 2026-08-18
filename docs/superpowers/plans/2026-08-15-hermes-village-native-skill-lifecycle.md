# Hermes Village Native Skill Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` for inline execution. Use `superpowers:subagent-driven-development` only if the owner explicitly requests delegation. Track every step with the checkboxes below.

**Goal:** Restore a stock-Hermes-first Village runtime in which native skill selection and learning remain authoritative, Village operational knowledge stays complete but loads narrowly, restarts cannot overwrite learning, and quote/Kakao latency can be measured without live writes or sends.

**Architecture:** Root Heybilli owns staff-facing operational reasoning through a compact, substantive `village-operations` umbrella. `kakaoworker` owns customer-event runtime procedures. Village Brain is loaded only for historical, policy, evidence, customer-knowledge, or strategy work; Gary Tan's G-Brain remains separate. Sheets/GAS/API runners remain deterministic sources and executors, but no broker or code router replaces Hermes judgment. Startup never imports a snapshot; import remains an explicit, backed-up recovery operation.

**Tech Stack:** Hermes CLI and native curator, PowerShell 7/Windows PowerShell, Node.js built-in test runner, JSON/Markdown skill artifacts, Windows Scheduled Tasks, existing Kakao DOM bridge and AI worker.

**Design source:** `docs/superpowers/specs/2026-08-15-hermes-village-native-skill-lifecycle-design.md`

## Global constraints

- [ ] Preserve every pre-existing dirty file. Do not reset, clean, checkout, rebase, or overwrite either `main`, `ax2-hermes-final`, or `hermes-skill-provenance`.
- [ ] Continue the existing `codex/hermes-skill-provenance` worktree after reviewing its two known changes; do not create a competing implementation over them.
- [ ] Do not commit, push, merge, deploy GAS, change Sheets, mutate schedules, or send Slack/Kakao/customer messages without a separate explicit authorization.
- [ ] Do not modify the live root or `kakaoworker` profile until the isolated-profile tests and benchmark have passed and the owner has reviewed the report.
- [ ] Do not delete `sync-hermes-profile-overlay.ps1`; remove it only from automatic startup/recovery callers and label it as an explicit migration/recovery command.
- [ ] Do not add a broker, semantic router, universal executor, or mandatory Village Brain lookup.
- [ ] Do not bulk-adopt unmanaged skills. Curator ownership is granted only to an explicitly reviewed allowlist.
- [ ] All benchmarks run with no customer send and no live business mutation.
- [ ] Every code change follows RED -> smallest implementation -> GREEN -> focused regression suite.

---

## Task 1: Freeze the evidence and protect every current variant

**Files:**

- Inspect: `C:\Village\my-gas-project2-worktrees\hermes-skill-provenance\scripts\windows\sync-hermes-profile-overlay.ps1`
- Inspect: `C:\Village\my-gas-project2-worktrees\hermes-skill-provenance\test\windows-hermes-skill-provenance.static.test.js`
- Inspect: `C:\Village\my-gas-project2-worktrees\ax2-hermes-final\tools\ai-browser-worker\worker.mjs`
- Inspect: `C:\Village\my-gas-project2-worktrees\ax2-hermes-final\tools\kakao-dom-bridge\server.mjs`
- Create during execution: `%LOCALAPPDATA%\hermes\backups\native-lifecycle-<timestamp>\manifest.json`
- Create during execution: `%LOCALAPPDATA%\hermes\backups\native-lifecycle-<timestamp>\scheduled-tasks\*.xml`

- [ ] **Step 1: Re-read repository and worktree state without changing it**

Run:

```powershell
git -C C:\Village\my-gas-project2 status --short --branch
git -C C:\Village\my-gas-project2-worktrees\ax2-hermes-final status --short --branch
git -C C:\Village\my-gas-project2-worktrees\hermes-skill-provenance status --short --branch
git -C C:\Village\my-gas-project2-worktrees\hermes-skill-provenance diff -- scripts/windows/sync-hermes-profile-overlay.ps1
git -C C:\Village\my-gas-project2-worktrees\hermes-skill-provenance diff -- test/windows-hermes-skill-provenance.static.test.js
```

Expected: the pre-existing provenance work is visible and nothing is reverted. Record exact paths and hashes in the execution log.

- [ ] **Step 2: Reconfirm which Kakao tree is live**

Read the scheduled-task action, hidden launcher, bridge command line, and `VILLAGE_AI_WORKER_CMD`. The accepted path must resolve to `C:\Village\my-gas-project2-worktrees\ax2-hermes-final`.

Run the current focused suite before touching implementation files:

```powershell
node --test C:\Village\my-gas-project2-worktrees\ax2-hermes-final\tools\ai-browser-worker\worker.test.mjs C:\Village\my-gas-project2-worktrees\ax2-hermes-final\tools\kakao-dom-bridge\server.test.mjs
```

Expected baseline: 0 failures. Save the test totals and duration.

- [ ] **Step 3: Create a recoverable snapshot without altering live state**

Write a bounded PowerShell backup helper only if an equivalent reviewed helper does not already exist. Copy these exact inputs into a new timestamped directory:

- `%LOCALAPPDATA%\hermes\skills` (the live root profile is the Hermes home itself; there is no `profiles\root` directory)
- `%LOCALAPPDATA%\hermes\profiles\kakaoworker\skills`
- each profile's `.usage.json`, `.curator_state.json`, suppressions, hub/bundled manifests, and profile config
- `Hermes_Gateway`, `Village-Kakao-Production-Start`, and `Village-Kakao-Production-Watchdog` task XML
- current launcher scripts by content hash, not by moving them

Produce `manifest.json` containing source absolute path, backup-relative path, byte count, SHA-256, and timestamp. Secrets must not be printed or copied into repository documentation.

- [ ] **Step 4: Verify the backup, not merely its existence**

Re-hash every copied file and fail if any source/backup digest differs. Confirm the old 108 KB `village-operations/SKILL.md` and current `village-brain-first/SKILL.md` are both present. Do not proceed if the manifest is incomplete.

---

## Task 2: Put the startup ownership rule under failing tests

**Files:**

- Modify: `test/windows-hermes-profile-overlay.static.test.js`
- Modify: `test/windows-kakao-production.static.test.js`
- Modify: `test/windows-hermes-skill-parity.static.test.js`
- Test: `scripts/windows/start-kakao-staging.ps1`
- Test: `scripts/windows/start-kakao-live.ps1`
- Test: `scripts/windows/watch-kakao-production.ps1`
- Test: `scripts/windows/sync-hermes-profile-overlay.ps1`

- [ ] **Step 1: Replace the obsolete always-sync expectations**

Add/replace assertions so the tests require:

1. `start-kakao-staging.ps1`, `start-kakao-live.ps1`, restart helpers, and watchdog recovery contain no invocation of `sync-hermes-profile-overlay.ps1`.
2. These normal start paths contain neither `-ProfileScoped` nor an equivalent whole-tree import.
3. `sync-hermes-profile-overlay.ps1` still exists and identifies itself as explicit migration/recovery tooling.
4. No root gateway start path invokes it.

- [ ] **Step 2: Run the focused tests and observe RED**

```powershell
node --test test/windows-hermes-profile-overlay.static.test.js test/windows-kakao-production.static.test.js test/windows-hermes-skill-parity.static.test.js
```

Expected: at least the staging startup test fails because `start-kakao-staging.ps1` currently invokes the sync. If it passes unexpectedly, inspect the test for a false positive before changing production code.

---

## Task 3: Remove migration synchronization from the hot path

**Files:**

- Modify: `scripts/windows/start-kakao-staging.ps1`
- Modify if its help text is ambiguous: `scripts/windows/sync-hermes-profile-overlay.ps1`
- Modify: `docs/windows-kakao-hermes-migration-runbook.md`
- Test: `test/windows-hermes-profile-overlay.static.test.js`
- Test: `test/windows-kakao-production.static.test.js`
- Test: `test/windows-hermes-skill-parity.static.test.js`

- [ ] **Step 1: Make the smallest startup change**

Remove only:

- resolution of `$profileOverlayScriptPath` from `start-kakao-staging.ps1`;
- the startup block that calls the overlay sync with `-ProfileScoped`;
- any claim that parity import is a prerequisite for a normal start.

Retain worker model/provider configuration, watcher/bridge startup, health checks, queue behavior, and all current Kakao safety controls unchanged.

- [ ] **Step 2: Make explicit recovery intent unmistakable**

Add comment-based help to `sync-hermes-profile-overlay.ps1` saying that it is a manual migration/recovery import, that it atomically replaces a profile skill tree, and that callers must make a backup and review the conflict report. Do not rename or delete it in this change because existing recovery documentation may reference the path.

- [ ] **Step 3: Run the RED tests to GREEN**

```powershell
node --test test/windows-hermes-profile-overlay.static.test.js test/windows-kakao-production.static.test.js test/windows-hermes-skill-parity.static.test.js
```

Expected: all pass.

- [ ] **Step 4: Re-run Kakao regressions**

```powershell
node --test tools/ai-browser-worker/worker.test.mjs tools/kakao-dom-bridge/server.test.mjs
```

Expected: 0 failures and no reduction in executed test count relative to Task 1.

---

## Task 4: Finish preservation and provenance behavior for explicit imports

**Files:**

- Preserve and finish: `scripts/windows/sync-hermes-profile-overlay.ps1`
- Preserve and finish: `test/windows-hermes-skill-provenance.static.test.js`
- Modify if necessary: `test/windows-hermes-profile-overlay.static.test.js`

- [ ] **Step 1: Review the existing dirty provenance test before editing**

Confirm that the existing test covers all of these cases:

- a locally changed skill is not silently replaced;
- usage counters merge monotonically rather than resetting;
- `created_by: agent` remains agent-managed;
- ordinary imported skills do not become curator-managed automatically;
- curator state, suppressions, and hub/bundled ownership metadata survive;
- worker profile metadata is scoped to the worker and does not borrow root ownership.

Add only missing cases. Do not discard or recreate the user's existing test.

- [ ] **Step 2: Run the provenance test and observe RED if a contract is missing**

```powershell
node --test test/windows-hermes-skill-provenance.static.test.js
```

Expected: any genuinely uncovered preservation defect fails before implementation. If all cases already pass, record that no production change is required for that contract.

- [ ] **Step 3: Apply the smallest explicit-import fix**

Change only the metadata merge or conflict-report path proven defective. Keep the atomic staging/replace mechanism for manual recovery. Never turn the script back into an automatic caller.

- [ ] **Step 4: Run the complete sync contract suite**

```powershell
node --test test/windows-hermes-skill-provenance.static.test.js test/windows-hermes-profile-overlay.static.test.js test/windows-hermes-skill-parity.static.test.js
```

Expected: all pass.

---

## Task 5: Define objective native-skill structure as tests

**Files:**

- Create: `test/windows-hermes-village-native-skill.static.test.js`
- Test: `scripts/windows/hermes-profile-overlay/skills/productivity/village-operations/SKILL.md`
- Test: `scripts/windows/hermes-profile-overlay/adapters/village-brain-first.md`

- [ ] **Step 1: Add a frontmatter/reference parser in the test file**

The test must parse Markdown frontmatter, count Unicode characters and body lines, and resolve every local `references/...` link relative to the skill root. Keep the parser in the test file unless a production consumer already exists.

- [ ] **Step 2: Encode only structural rules, not business judgment**

Require:

- each description is a single sentence of at most 60 characters;
- `village-operations` body is no more than 200 lines;
- it contains substantive authority, source-of-truth, execution/readback, uncertainty, and learning sections;
- it does not invoke `village_operation`, a broker, a router, or mandatory Brain retrieval;
- every referenced support file exists;
- `village-brain-first` is not triggered by wording equivalent to “every Village business question”;
- `village-brain-first` does not call Village RAG `GBrain` or `G-Brain`;
- ordinary quote, confirmation, schedule, and live-state examples do not require the Brain skill.

Do not test exact prose beyond the negative/structural contract. Hermes must retain semantic freedom.

- [ ] **Step 3: Run the new test and observe RED**

```powershell
node --test test/windows-hermes-village-native-skill.static.test.js
```

Expected: failures for the 108 KB operations entrypoint, broad Brain trigger, and G-Brain naming contamination.

---

## Task 6: Rebuild `village-operations` as a compact substantive umbrella

**Files:**

- Modify: `scripts/windows/hermes-profile-overlay/skills/productivity/village-operations/SKILL.md`
- Preserve: `scripts/windows/hermes-profile-overlay/skills/productivity/village-operations/references/**`
- Create if absent: `scripts/windows/hermes-profile-overlay/skills/productivity/village-operations/references/windows-runtime-and-sources.md`
- Create during execution outside Git: `%LOCALAPPDATA%\hermes\backups\native-lifecycle-<timestamp>\legacy\village-operations-SKILL.md`
- Test: `test/windows-hermes-village-native-skill.static.test.js`

- [ ] **Step 1: Classify before rewriting**

Build a temporary classification table from every heading/section of the 108 KB file with exactly one disposition:

- shared root contract;
- existing task reference;
- new task reference;
- historical/archive only;
- duplicated or superseded text retained only in the lossless archive.

Do not remove the old root until every section has a disposition and the archived file hash matches the backup manifest.

- [ ] **Step 2: Write the compact root**

Use this bounded frontmatter description:

```yaml
description: Handle staff-requested Village operations safely.
```

Keep the body within 100-200 lines and make it operationally useful on its own. It must include:

1. owner authority and customer-send boundary;
2. live source selection and no-stale-memory rule;
3. AI interpretation before deterministic execution;
4. shared validate -> execute -> readback procedure;
5. short task-family sections for confirmations/reservations, schedule changes, quotes/documents, payments/tax, returns/equipment, and messaging;
6. exact links to the relevant existing references for exceptional detail;
7. explicit handling of ambiguity and missing data;
8. native learning guidance that patches the narrowest useful location.

The root must not be an index-only shell and must not force every task through a helper layer.

- [ ] **Step 3: Move only Windows mechanics into a support reference**

Put path, PowerShell/Git Bash, environment-variable, and executable invocation details in `references/windows-runtime-and-sources.md`. Do not duplicate those mechanics across every task section.

- [ ] **Step 4: Run the structural test**

```powershell
node --test test/windows-hermes-village-native-skill.static.test.js
```

Expected: operations-specific assertions pass; Brain assertions may remain RED until Task 7.

- [ ] **Step 5: Check retained knowledge mechanically**

Compare the classification table with the compact root plus references. Fail the task if any unique heading has no destination or archive entry. This is a preservation check, not a claim that all archived prose belongs in active context.

---

## Task 7: Narrow Village Brain and separate G-Brain

**Files:**

- Modify: `scripts/windows/hermes-profile-overlay/adapters/village-brain-first.md`
- Preserve/reference: `C:\Village\VILLAGE_Brain\Ops\brain-context-latest.md`
- Test: `test/windows-hermes-village-native-skill.static.test.js`

- [ ] **Step 1: Replace the broad trigger contract**

Use a description within 60 characters, for example:

```yaml
description: Use Village Brain for history, policy, and strategy.
```

Limit automatic use to historical evidence, policy rationale, customer knowledge, strategy, and cross-period analysis. State that current reservation, price, availability, schedule, payment, and inventory facts come from their live project route.

- [ ] **Step 2: Correct the naming contamination**

Rename all Village retrieval instructions that say `GBrain` or `G-Brain` to `Village Brain`. Add one concise negative boundary: Gary Tan's G-Brain is a separate optional system and is not implicitly invoked.

- [ ] **Step 3: Remove the reverse router behavior**

Do not tell the Brain skill to dispatch normal write work to `village-operations`. It may state its own read/evidence boundary, while normal Hermes skill selection decides whether another skill is relevant.

- [ ] **Step 4: Run the structural test to GREEN**

```powershell
node --test test/windows-hermes-village-native-skill.static.test.js
```

Expected: all assertions pass.

---

## Task 8: Prove native ownership and curator behavior in an isolated profile

**Files:**

- Create: `scripts/windows/test-hermes-native-skill-lifecycle.ps1`
- Create: `test/windows-hermes-native-lifecycle.static.test.js`
- Read only: local Hermes CLI help and curator state format
- Do not modify: `%LOCALAPPDATA%\hermes` live root profile
- Do not modify: `%LOCALAPPDATA%\hermes\profiles\kakaoworker`

- [ ] **Step 1: Test the harness safety contract first**

The static test must require the harness to:

- accept an explicit temporary profile root;
- reject `root` and `kakaoworker` live profile paths;
- create a new timestamped directory;
- disable live worker writes and automatic send;
- never call `adopt --all-unmanaged`;
- emit before/after SHA-256 manifests;
- clean up only the exact temporary directory after resolving and validating its absolute path.

Run and observe RED:

```powershell
node --test test/windows-hermes-native-lifecycle.static.test.js
```

- [ ] **Step 2: Implement the isolated lifecycle harness**

The script must seed only the candidate operations and Brain skills plus the minimum profile metadata required by Hermes. Reuse authentication/config through read-only references only if the CLI requires it; do not copy secrets into the repository or logs.

- [ ] **Step 3: Keep the umbrella owner-managed and isolate agent learning**

Within the isolated profile, run the equivalent of:

```powershell
hermes curator list-unmanaged
hermes curator run --dry-run --consolidate
```

Assert that `village-operations` and Village Brain remain unmanaged, while the
focused lifecycle marker created through background review is agent-managed.
Never adopt the owner-managed umbrella or unrelated unmanaged skills.

- [ ] **Step 4: Prove backup, real consolidation, and restore**

Run in the isolated profile only:

```powershell
hermes curator backup --reason native-lifecycle-isolated-test
hermes curator run --consolidate
```

Then exercise the native restore path and compare the restored hashes, usage data, ownership markers, curator state, and discoverability to the pre-run manifest. Any mismatch blocks cutover.

- [ ] **Step 5: Run the harness tests to GREEN**

```powershell
node --test test/windows-hermes-native-lifecycle.static.test.js
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows/test-hermes-native-skill-lifecycle.ps1 -WhatIf
```

Expected: all static tests pass and `-WhatIf` reports only isolated paths.

---

## Task 9: Prove that restarts do not erase native learning

**Files:**

- Modify: `scripts/windows/test-hermes-native-skill-lifecycle.ps1`
- Modify: `test/windows-hermes-native-lifecycle.static.test.js`
- Exercise in isolation: `scripts/windows/start-kakao-staging.ps1`
- Exercise in isolation: `scripts/windows/watch-kakao-production.ps1`

- [ ] **Step 1: Add a native learning marker through Hermes**

Use native `skill_manage` behavior in the isolated profile to create or patch an agent-managed fixture skill. Do not edit the marker directly after baseline creation. Capture its file hash, usage metadata, `created_by`, and catalog discoverability.

- [ ] **Step 2: Restart through the real wrapper logic with injected isolated paths**

Run the same start/recovery functions used by staging and watchdog, but with fake ports, an isolated profile, empty queues, and all write/send flags disabled. Do not stop or restart the live worker, bridge, Chrome, or scheduled tasks during this phase.

- [ ] **Step 3: Assert durability**

After each restart, require:

- identical learned-file hash;
- monotonic usage metadata;
- unchanged curator ownership;
- successful skill discovery;
- no profile-tree replace event in logs;
- no live external call or customer-send attempt.

- [ ] **Step 4: Run the lifecycle suite**

```powershell
node --test test/windows-hermes-native-lifecycle.static.test.js test/windows-hermes-profile-overlay.static.test.js test/windows-kakao-production.static.test.js
```

Expected: all pass.

---

## Task 10: Build a fixed no-send A/B benchmark

**Files:**

- Create: `test/fixtures/hermes-village-native-benchmark.json`
- Create: `scripts/windows/measure-hermes-village-skill-latency.ps1`
- Create: `test/windows-hermes-village-benchmark.static.test.js`
- Create during execution: `%LOCALAPPDATA%\hermes\benchmarks\native-lifecycle-<timestamp>\results.json`

- [ ] **Step 1: Test benchmark safety and comparability first**

The static test must require:

- separate isolated legacy and candidate profiles;
- identical model, provider, and reasoning level for both arms;
- cold one-shot execution using `python.exe -m hermes_cli.main -z`;
- explicit `--usage-file` per run;
- `VILLAGE_WINDOWS_WRITES_ENABLED=0`, `AI_WORKER_LIVE=0`, and `AI_WORKER_AUTO_SEND=0`;
- rejection of live root/worker profile paths;
- result fields for selected skills/references, input tokens, model/tool call counts, model/tool/wall latency, correctness assertions, and attempted mutations/sends;
- no Slack/Kakao send API and no Sheet/GAS write endpoint.

Run and observe RED:

```powershell
node --test test/windows-hermes-village-benchmark.static.test.js
```

- [ ] **Step 2: Add the fixed fixture set**

Include these eight no-send cases with deterministic expected facts or explicit mocked readback:

1. simple unregistered manual quote preview;
2. registered-trade quote preview with one correction;
3. confirmation request from text containing one equipment alias;
4. confirmation request with split return times;
5. existing schedule equipment-addition plan;
6. return-equipment memo/update plan;
7. historical or policy question that must select Village Brain;
8. ordinary live-state question that must not select Village Brain.

Fixtures must not contain real customer contact data or authorize final registration/send.

- [ ] **Step 3: Implement the benchmark runner**

For each arm and fixture:

1. create a fresh conversation/session state;
2. set the same Grok model/provider/reasoning configuration as the currently approved live worker configuration;
3. run one-shot Hermes with an isolated `--usage-file`;
4. capture stdout/stderr, skill calls, support-file reads, tool attempts, tokens, and monotonic wall-clock timings;
5. fail closed on any write/send attempt;
6. write structured JSON without credentials.

- [ ] **Step 4: Run the static benchmark test to GREEN**

```powershell
node --test test/windows-hermes-village-benchmark.static.test.js
```

- [ ] **Step 5: Execute the A/B benchmark**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows/measure-hermes-village-skill-latency.ps1
```

Pass only if the candidate retains required judgment/correctness, selects Brain only for the intended fixtures, makes no forbidden attempt, and improves irrelevant skill loading and long-tail latency. Do not declare success from prompt size alone.

---

## Task 11: Full regression, drift audit, and owner review gate

**Files:**

- Review: all changed files in `codex/hermes-skill-provenance`
- Create during execution: `%LOCALAPPDATA%\hermes\benchmarks\native-lifecycle-<timestamp>\review.md`

- [ ] **Step 1: Run the complete focused suite**

```powershell
node --test test/windows-hermes-profile-overlay.static.test.js test/windows-kakao-production.static.test.js test/windows-hermes-skill-parity.static.test.js test/windows-hermes-skill-provenance.static.test.js test/windows-hermes-village-native-skill.static.test.js test/windows-hermes-native-lifecycle.static.test.js test/windows-hermes-village-benchmark.static.test.js
node --test tools/ai-browser-worker/worker.test.mjs tools/kakao-dom-bridge/server.test.mjs
git diff --check
```

Expected: 0 failures and no whitespace errors.

- [ ] **Step 2: Check that implementation stayed AI-first**

Inspect the diff and explicitly confirm:

- no semantic dispatch/routing code was added;
- no AI judgment was replaced by aliases, branches, or a task broker;
- only deterministic validation, safety gates, execution, readback, and lifecycle checks remain in code;
- all original business knowledge remains in active root/reference material or the hashed archive;
- Village Brain and G-Brain names are separated;
- no worker runtime improvement in `ax2-hermes-final` was overwritten.

- [ ] **Step 3: Produce the owner review report and stop**

Report:

- exact files changed;
- RED and GREEN commands/results;
- legacy/candidate benchmark table;
- restart-durability proof;
- archive and rollback paths;
- remaining difference between `main` and `ax2-hermes-final`;
- explicit statement that live profiles and scheduled tasks remain unchanged.

Do not perform live cutover, commit, push, merge, or deployment in this task.

---

## Task 12: Live cutover only after separate owner approval

**Files:**

- Potentially modify after approval: `%LOCALAPPDATA%\hermes\skills\productivity\village-operations\SKILL.md`
- Potentially modify after approval: `%LOCALAPPDATA%\hermes\skills\village\village-brain-first\SKILL.md`
- Potentially modify after approval: `%LOCALAPPDATA%\hermes\profiles\kakaoworker\skills\...`
- Read/verify: scheduled task actions, process command lines, bridge/watcher/worker logs

- [ ] **Step 1: Reconfirm approval and make a fresh pre-cutover backup**

Approval must name the live root and/or worker scope. Root and worker are cut over separately. Re-run SHA-256 inventory immediately before each mutation.

- [ ] **Step 2: Apply only reviewed candidate files**

Do not copy a whole historical skill tree. Preserve live usage/curator metadata and install only the approved root/Brain or worker-owned changes.

- [ ] **Step 3: Restart only the affected runtime**

Verify the actual process command line and profile, not merely a health endpoint. For Kakao, prove direct CDP authentication/watcher readiness, queue/worker state, and no duplicate work before considering recovery successful.

- [ ] **Step 4: Run a bounded internal Slack readback check**

No customer send, schedule mutation, or live business write is included. Any Slack test message still requires explicit send approval at cutover time.

- [ ] **Step 5: Roll back on the first failed gate**

Restore only the affected profile from the verified snapshot, restart that runtime, and prove restored hashes and process identity. Never roll back business data as part of a skill/config rollback.

- [ ] **Step 6: Commit/push/deploy only if separately requested**

If authorized later, preserve the multi-session workflow: feature branch/worktree first, integration through `scripts/integrate.sh` only from the integration session. GAS deployment is not required for skill-only changes.

## Definition of done

- [ ] Normal root, Kakao start, restart, and watchdog paths perform no profile-overlay import.
- [ ] Recent Kakao worker/bridge improvements still pass their full focused suite and remain the actual runtime source.
- [ ] `village-operations` is a substantive 100-200-line native umbrella with a <=60-character description and no broker/router.
- [ ] Village Brain has a narrow trigger and contains no G-Brain conflation.
- [ ] Every legacy operations section is accounted for in compact root, references, or a verified lossless archive.
- [ ] Explicit import preserves locally learned content, usage, curator ownership/state, suppressions, and upstream ownership metadata.
- [ ] Only reviewed operational skills are curator-managed; no bulk adoption occurs.
- [ ] Native learning survives isolated root and worker/watchdog restarts.
- [ ] Fixed no-send A/B results show preserved correctness and judgment plus reduced irrelevant loading/long-tail latency.
- [ ] The owner reviews the evidence before any live cutover.
- [ ] No unauthorized send, live business mutation, deploy, commit, push, merge, or destructive Git operation occurs.
