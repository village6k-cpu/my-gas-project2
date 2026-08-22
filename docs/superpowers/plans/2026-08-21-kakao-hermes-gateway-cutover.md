# Kakao Hermes Gateway No-Send Validation and Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Package the approved plugin into the `kakaoworker` profile, prove the native Gateway lifecycle in offline/no-send mode, benchmark it against the one-shot CLI baseline, and make live cutover a reversible explicit owner action.

**Architecture:** The source plugin remains versioned in `village-ai`; a hash-verifying sync script copies it into the profile's user-plugin directory. The existing clean-lineage Task Scheduler launcher owns the `kakaoworker` Gateway. Runtime health requires direct profile/plugin/session/consumer readback plus Kakao CDP authentication/watcher evidence. Validation replays fixed fixtures with writes and sends disabled. Production changes only after all gates and a separate owner approval.

**Tech Stack:** PowerShell 7/Windows PowerShell 5.1-compatible scripts, stock Hermes Gateway CLI/service, Node.js tests, Python pytest, existing Kakao runtime probes and benchmark tools.

**Spec:** [`2026-08-20-kakao-native-hermes-gateway-session-design.md`](../specs/2026-08-20-kakao-native-hermes-gateway-session-design.md)

## Global Constraints

- This plan depends on both the platform-plugin plan and bridge-channel plan being complete and green.
- Do not hand-edit `%LOCALAPPDATA%\hermes\profiles\kakaoworker` or installed Hermes source. Sync from a reviewed source artifact and verify hashes.
- Do not send Kakao/Slack messages or mutate GAS/Sheets during validation.
- Do not enable production tasks, disable the legacy worker, alter live environment files, or restart live components before the explicit cutover gate in Task 5.
- A port, PID, `/health 200`, or plugin file presence is insufficient proof. Require runtime profile, loaded plugin path/hash, consumer heartbeat, native session reuse, and end-to-end no-send result readback.
- Preserve model `grok-4.5`, provider `xai-oauth`, reasoning `xhigh`, max turns 90, enabled tools, and Village skills unless a separate approved model contract changes them.

---

## Task 1: Add deterministic plugin packaging and hash verification

**Files:**
- Create: `scripts/windows/sync-kakao-hermes-plugin.ps1`
- Create: `test/windows-hermes-kakao-plugin-sync.test.mjs`
- Modify: `scripts/windows/hermes-model-contract.json`
- Modify: `scripts/windows/sync-hermes-profile-overlay.ps1`

- [ ] **Step 1: Write failing plan-only packaging tests**

The script must accept `-SourcePluginPath`, `-HermesHome`, and `-PlanOnly`. Plan-only output must include resolved source, profile target `%LOCALAPPDATA%\hermes\profiles\kakaoworker\plugins\kakao_village`, file manifest, SHA-256 per file, and `changed=false`; it must not create directories or copy files.

Test refusal for a dirty/unresolved source, missing descriptor, symlink/reparse-point escape, target outside the profile root, unexpected executable/binary files, and a manifest containing secrets. Because stock Hermes requires explicit opt-in for user-installed platform plugins, also assert that the generated profile plan adds `kakao_village` to `plugins.enabled` and enables the `platforms.kakao_village` configuration without disturbing other enabled plugins/platforms.

- [ ] **Step 2: Run test and confirm RED**

```powershell
node --test test/windows-hermes-kakao-plugin-sync.test.mjs
```

- [ ] **Step 3: Implement atomic, source-owned sync**

Copy only `.py`, `.yaml`, and `.md` files from the reviewed source plugin into a temporary sibling directory, verify hashes, then rename into the profile plugin directory. Preserve a previous version as one bounded rollback directory. Never copy test fixtures, `.env`, logs, caches, or credentials.

Add the plugin source location and required plugin name to the model/runtime contract without embedding a machine secret. Update profile configuration with a merge operation that preserves all existing `plugins.enabled` and platform settings while adding `kakao_village`; never replace the arrays/maps wholesale. Keep skill overlay sync separate; it may invoke plugin sync but must not merge plugin code into a skill file.

- [ ] **Step 4: Run packaging tests and plan-only command**

```powershell
node --test test/windows-hermes-kakao-plugin-sync.test.mjs
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows/sync-kakao-hermes-plugin.ps1 -SourcePluginPath C:\Village\village-ai-worktrees\kakao-hermes-platform-plugin\migration\hermes\plugins\kakao_village -PlanOnly
```

- [ ] **Step 5: Commit the packaging checkpoint**

```powershell
git add scripts/windows/sync-kakao-hermes-plugin.ps1 scripts/windows/sync-hermes-profile-overlay.ps1 scripts/windows/hermes-model-contract.json test/windows-hermes-kakao-plugin-sync.test.mjs
git commit -m "feat: package Kakao Hermes plugin reproducibly"
```

---

## Task 2: Make the `kakaoworker` Gateway a first-class no-send runtime

**Files:**
- Modify: `scripts/windows/register-hermes-gateway-tasks.ps1`
- Modify: `scripts/windows/restart-hermes-gateway.ps1`
- Modify: `scripts/windows/KakaoLiveNoSend.Common.psm1`
- Modify: `scripts/windows/start-kakao-live-nosend.ps1`
- Modify: `test/windows-hermes-slack-gateway-runtime.integration.test.js`
- Modify: `test/windows-kakao-live-nosend-task.test.mjs`
- Create: `test/windows-hermes-kakao-gateway-runtime.integration.test.js`

- [ ] **Step 1: Replace the legacy expectation with failing native-Gateway tests**

The current test asserts Kakao stays on the bridge worker and `Hermes_Gateway_Kakaoworker` is disabled. Replace it with tests requiring a separate, profile-scoped, disabled-by-default task plan that launches stock:

```text
python -m hermes_cli.main --profile kakaoworker gateway run
```

Require the existing clean-lineage scheduled-task launch, correct `venv\Scripts\python.exe`, profile-scoped PID file, `plugins.enabled` opt-in, active `kakao_village` platform adapter, loaded plugin path/hash, and no root-Slack Gateway disruption.

- [ ] **Step 2: Run tests and confirm RED**

```powershell
node --test test/windows-hermes-slack-gateway-runtime.integration.test.js test/windows-hermes-kakao-gateway-runtime.integration.test.js test/windows-kakao-live-nosend-task.test.mjs
```

- [ ] **Step 3: Implement disabled-by-default Gateway ownership**

Add a `kakaoworker` task definition but do not enable it without an explicit switch. `restart-hermes-gateway.ps1 -Target kakaoworker` must continue using Task Scheduler for clean process lineage and verify the official profile PID plus mitigation policy. The no-send startup plan must require:

```text
KAKAO_HERMES_TRANSPORT=gateway_no_send
AI_WORKER_AUTO_SEND=0
AI_WORKER_DRY_RUN=1
VILLAGE_WINDOWS_WRITES_ENABLED=0
```

It must also require a current Gateway consumer heartbeat and plugin hash before declaring healthy.

- [ ] **Step 4: Run tests and `-PlanOnly` checks**

Run the three tests again and both relevant scripts with `-PlanOnly`. Expected: no process/task/profile mutation and all assertions pass.

- [ ] **Step 5: Commit the no-send runtime checkpoint**

```powershell
git add scripts/windows test/windows-hermes-kakao-gateway-runtime.integration.test.js test/windows-hermes-slack-gateway-runtime.integration.test.js test/windows-kakao-live-nosend-task.test.mjs
git commit -m "feat: define no-send Kakao Hermes Gateway runtime"
```

---

## Task 3: Build an offline replay and session/timeout proof suite

**Files:**
- Create: `tools/kakao-dom-bridge/fixtures/hermes-gateway-replay.json`
- Create: `scripts/windows/test-kakao-hermes-gateway-nosend.ps1`
- Create: `test/windows-hermes-kakao-gateway-nosend.test.mjs`
- Modify: `test/windows-hermes-native-lifecycle.static.test.js`

- [ ] **Step 1: Define sanitized replay fixtures**

Include at minimum: two consecutive FAQ turns in one room, a simultaneous FAQ in another room, one schedule inquiry whose fake confirmation tool returns available/warning/unavailable rows, one malformed final JSON, one stale revision, one forced timeout followed by success, and one second timeout that reaches terminal failure. Use synthetic names, phone numbers, dates, and equipment.

- [ ] **Step 2: Write failing no-send proof tests**

The test must prove:

- same room produces one stable native session key across turns;
- different room produces a different session key;
- plugin and agent are loaded once for the Gateway process, not once per request;
- schedule flow uses one native agent run with one tool call and no post-action Hermes run;
- timeout retry uses the same session and at most two attempts;
- no `hermes-stdin-runner.py`, `git.exe`, Kakao send, Slack send, or GAS mutation is started;
- every schedule result ends as an owner-review draft/card.

- [ ] **Step 3: Run test and confirm RED**

```powershell
node --test test/windows-hermes-kakao-gateway-nosend.test.mjs
```

- [ ] **Step 4: Implement the bounded harness**

The PowerShell harness starts only a disposable fake bridge plus a profile-isolated Gateway using temporary config/state directories. It must stop only processes it started and emit a JSON evidence bundle containing PIDs, command lines, loaded plugin path/hash, session keys, tool receipts, result envelopes, attempts, timings, and send/write counters.

- [ ] **Step 5: Run the replay twice and confirm deterministic invariants**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows/test-kakao-hermes-gateway-nosend.ps1
node --test test/windows-hermes-kakao-gateway-nosend.test.mjs
```

AI wording may vary; structural invariants and safety outcomes must not.

- [ ] **Step 6: Commit the no-send proof suite**

```powershell
git add tools/kakao-dom-bridge/fixtures scripts/windows/test-kakao-hermes-gateway-nosend.ps1 test/windows-hermes-kakao-gateway-nosend.test.mjs test/windows-hermes-native-lifecycle.static.test.js
git commit -m "test: prove native Kakao Gateway lifecycle offline"
```

---

## Task 4: Benchmark against the measured one-shot baseline

**Files:**
- Modify: `scripts/windows/hermes-village-benchmark-invoke.py`
- Modify: `scripts/windows/hermes-village-benchmark-analyze.py`
- Modify: `test/windows-hermes-kakaoworker-benchmark.test.mjs`
- Create: `docs/kakao-hermes-gateway-benchmark.md`

- [ ] **Step 1: Write failing benchmark contract tests**

Require the analyzer to compare the existing baseline stages and Gateway stages without changing model/provider/reasoning/tools/skills. Required output fields:

```text
sample_count
baseline_total_median_ms / p95_ms
gateway_total_median_ms / p95_ms
gateway_agent_median_ms / p95_ms
process_starts_per_request
post_action_agent_runs_per_schedule
session_reuse_rate
schedule_owner_review_rate
send_count / write_count
```

- [ ] **Step 2: Run test and confirm RED**

```powershell
node --test test/windows-hermes-kakaoworker-benchmark.test.mjs
```

- [ ] **Step 3: Implement fixture-based A/B invocation and analysis**

Use the same synthetic replay set and at least 20 completed turns per mode after one warm-up. Preserve `grok-4.5`, `xai-oauth`, `xhigh`, max turns 90, toolsets, and skills. Do not compare a warmed Gateway to a cold model/config with reduced reasoning.

- [ ] **Step 4: Enforce acceptance thresholds**

The benchmark passes only when:

- process starts per Gateway request = 0;
- post-action agent runs per schedule = 0;
- same-room session reuse = 100%;
- schedule owner-review = 100%;
- customer sends and live writes = 0;
- total median improves at least 40% from the recorded 176.3s baseline;
- total P95 improves at least 30% from the recorded 246.3s baseline.

If latency thresholds fail, report measured stage evidence; do not reduce reasoning, tools, skills, or add a semantic shortcut.

- [ ] **Step 5: Run tests, benchmark, and document evidence**

```powershell
node --test test/windows-hermes-kakaoworker-benchmark.test.mjs
```

Populate the report from machine-generated JSON; do not hand-enter pass values.

- [ ] **Step 6: Commit benchmark artifacts**

```powershell
git add scripts/windows/hermes-village-benchmark-*.py test/windows-hermes-kakaoworker-benchmark.test.mjs docs/kakao-hermes-gateway-benchmark.md
git commit -m "test: benchmark Kakao native Gateway sessions"
```

---

## Task 5: Prepare reversible live cutover, then stop for owner approval

**Files:**
- Modify: `scripts/windows/KakaoLive.Common.psm1`
- Modify: `scripts/windows/start-kakao-live.ps1`
- Modify: `scripts/windows/register-kakao-production-tasks.ps1`
- Modify: `scripts/windows/watch-kakao-production.ps1`
- Modify: `test/windows-kakao-production.static.test.js`
- Modify: `docs/windows-kakao-hermes-migration-runbook.md`

- [ ] **Step 1: Write failing cutover/rollback tests**

Require `-ConfirmKakaoGatewayCutover` before any production task or env transition. The cutover plan must atomically verify plugin hash, model contract, Gateway PID/profile, consumer heartbeat, native session smoke result, bridge queue idle state, Kakao `authenticated=true`, and `watcherReady=true`. The rollback plan must restore `KAKAO_HERMES_TRANSPORT=cli`, stop only the owned `kakaoworker` Gateway, and leave root Slack Gateway plus healthy Kakao Chrome untouched.

- [ ] **Step 2: Run test and confirm RED**

```powershell
node --test test/windows-kakao-production.static.test.js
```

- [ ] **Step 3: Implement plan-only and explicit cutover actions**

Production health must require all of:

```text
bridge transport = gateway
plugin loaded path/hash = reviewed artifact
kakaoworker Gateway profile/PID = expected
consumer last-seen within threshold
no exhausted/unknown Gateway jobs
Kakao CDP authenticated = true
watcherReady = true
schedule owner-review gate = enabled
general auto-send kill switch = observed
```

Update watchdog ownership so it heals the bridge, Kakao Chrome/watcher, and `kakaoworker` Gateway independently. Never restart root Slack Gateway because Kakao is unhealthy.

- [ ] **Step 4: Run static tests and plan-only cutover/rollback**

```powershell
node --test test/windows-kakao-production.static.test.js test/windows-hermes-kakao-gateway-runtime.integration.test.js
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows/register-kakao-production-tasks.ps1 -PlanOnly
```

Expected: all plans render, no live state changes.

- [ ] **Step 5: Stop and present the evidence bundle to the owner**

Report FACT/UNKNOWN/BLOCKED for each runtime proof, benchmark threshold, safety invariant, and rollback check. Do not run the real cutover switch, restart, task enablement, customer send, GAS mutation, deployment, or environment edit until the owner explicitly approves the live cutover after seeing this bundle.

- [ ] **Step 6: After explicit approval only, perform cutover and bounded observation**

Run the reviewed cutover command, then verify direct runtime readback. Observe the first bounded set of real turns without initiating customer contact. Any missing plugin/session/consumer/freshness proof, schedule auto-send attempt, double tool call, duplicate result, exhausted lease, or latency regression triggers immediate rollback to CLI.

- [ ] **Step 7: Commit runbook and cutover guards after validation**

```powershell
git add scripts/windows test/windows-kakao-production.static.test.js docs/windows-kakao-hermes-migration-runbook.md
git commit -m "feat: guard Kakao Hermes Gateway cutover"
```

---

## Plan Acceptance Checklist

- [ ] Source artifact and installed plugin hashes match; installed files were not hand-edited.
- [ ] Runtime proves the expected profile, PID, plugin path/hash, consumer heartbeat, and same-room session reuse.
- [ ] No-send replay proves one native schedule turn, native tool use, owner approval, timeout reuse, and zero sends/writes.
- [ ] Benchmark meets median/P95 thresholds without weakening Hermes.
- [ ] Cutover is disabled by default, requires explicit owner approval, and has a tested rollback.
- [ ] Root Slack Hermes, GAS, Sheets, Kakao customers, and scheduled production tasks remain unchanged until the cutover step is explicitly authorized.
