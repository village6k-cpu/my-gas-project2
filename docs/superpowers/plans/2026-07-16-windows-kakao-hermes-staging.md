# Windows Kakao and Hermes Staging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Windows staging bundle that can validate configuration, start and stop only its own Kakao Chrome, DOM bridge, and optional Hermes gateway processes, and document a no-send cutover and rollback while leaving the production Mac untouched.

**Architecture:** A portable Node configuration contract parses a Windows-local env file, forces no-send staging defaults unless an explicit write switch is supplied, validates required connector names, and emits only redacted status. PowerShell lifecycle scripts consume the same env file without printing values, use a dedicated Chrome profile and localhost ports, and track process ownership in `%LOCALAPPDATA%\Village\kakao-staging`. A runbook keeps BlueBubbles, Messages, and watch voice relay on the Mac during the first cutover.

**Tech Stack:** Node.js built-in test runner, PowerShell 7/Windows PowerShell 5.1-compatible scripts, Chrome DevTools Protocol, existing Node DOM bridge and Hermes CLI.

## Global Constraints

- Do not stop, restart, reconfigure, or send through the production Mac during implementation or verification.
- Do not send Slack, Kakao, iMessage, or SMS messages.
- Do not copy or print `.env` values, tokens, URLs, auth files, Chrome cookies, or customer data.
- Windows staging must force `AI_WORKER_LIVE=0`, `AI_WORKER_AUTO_SEND=0`, `SLACK_ACTION_POLL_ENABLED=false`, `SLACK_AGENT_CARD_DELIVERY_ENABLED=false`, `KAKAO_TAB_CLEANUP_ENABLED=false`, `KAKAO_WORKER_CONTROL_MODE=devtools_only`, and `KAKAO_APPLESCRIPT_FALLBACK=0` unless the operator explicitly supplies `-EnableWrites` during a later approved cutover.
- DevTools and the DOM bridge must bind to `127.0.0.1`; defaults are `9223` and `8787`.
- Windows stop and rollback commands may stop only processes whose PID, executable, and command marker match records created by the Windows staging scripts.
- BlueBubbles, macOS Messages, and watch voice relay remain on the Mac in the first cutover.
- Do not run `clasp`, GAS deployment, GitHub push, or any production automation command from this feature branch.

---

### Task 1: Portable Windows runtime configuration contract

**Files:**

- Create: `scripts/windows/windows-runtime-config.mjs`
- Create: `scripts/windows/.env.windows.example`
- Create: `test/windows-runtime-config.test.mjs`

**Interfaces:**

- Consumes: a file path supplied as `--env <path>` and an optional `--enable-writes` flag.
- Produces: `parseEnvText(text)`, `buildWindowsStagingConfig(values, options)`, `validateWindowsStagingConfig(config)`, and `redactWindowsStagingConfig(config)` exports; CLI stdout is redacted JSON only.
- Exit codes: `0` valid, `2` missing or invalid required settings, `1` unexpected error.

- [ ] **Step 1: Write the failing unit tests**

Create tests using `node:test` and `node:assert/strict` that assert:

```js
const raw = parseEnvText('SUPABASE_URL=https://example.invalid\nSUPABASE_SERVICE_ROLE_KEY=secret\n');
assert.equal(raw.SUPABASE_SERVICE_ROLE_KEY, 'secret');

const staging = buildWindowsStagingConfig({
  AI_WORKER_LIVE: '1',
  AI_WORKER_AUTO_SEND: 'true',
  SLACK_ACTION_POLL_ENABLED: 'true',
  SLACK_AGENT_CARD_DELIVERY_ENABLED: 'true',
  KAKAO_TAB_CLEANUP_ENABLED: 'true'
});
assert.equal(staging.AI_WORKER_LIVE, '0');
assert.equal(staging.AI_WORKER_AUTO_SEND, '0');
assert.equal(staging.SLACK_ACTION_POLL_ENABLED, 'false');
assert.equal(staging.SLACK_AGENT_CARD_DELIVERY_ENABLED, 'false');
assert.equal(staging.KAKAO_TAB_CLEANUP_ENABLED, 'false');
assert.equal(staging.KAKAO_WORKER_CONTROL_MODE, 'devtools_only');
assert.equal(staging.KAKAO_APPLESCRIPT_FALLBACK, '0');
assert.equal(staging.KAKAO_REMOTE_DEBUGGING_PORT, '9223');
assert.equal(staging.PORT, '8787');

const redacted = redactWindowsStagingConfig({
  SUPABASE_SERVICE_ROLE_KEY: 'secret',
  BLUEBUBBLES_PASSWORD: 'secret',
  SUPABASE_URL: 'https://example.invalid',
  PORT: '8787'
});
assert.equal(redacted.SUPABASE_SERVICE_ROLE_KEY, '[set]');
assert.equal(redacted.BLUEBUBBLES_PASSWORD, '[set]');
assert.equal(redacted.SUPABASE_URL, '[set]');
assert.equal(redacted.PORT, '8787');
assert.doesNotMatch(JSON.stringify(redacted), /secret|example\.invalid/);
```

Validation must require the names `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_TABLE`, `HERMES_WORKER_COMMAND`, `HERMES_WORKER_PROFILE`, `BLUEBUBBLES_SERVER_URL`, and `BLUEBUBBLES_PASSWORD`. `SUPABASE_FOLLOW_UP_TABLE` is required only when Slack card delivery or action polling is enabled.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
node --test test/windows-runtime-config.test.mjs
```

Expected: FAIL because `scripts/windows/windows-runtime-config.mjs` does not exist.

- [ ] **Step 3: Implement the configuration contract**

Implement only Node built-ins. The parser must ignore blank/comment lines, split on the first `=`, preserve the remainder verbatim, and reject malformed non-comment lines. `buildWindowsStagingConfig(values, { enableWrites = false })` must apply the exact safe defaults from Global Constraints when `enableWrites` is false. The CLI must read only the explicitly supplied env path and output `redactWindowsStagingConfig(config)` plus `valid` and `missing` fields; it must never output a raw value for names ending in `_URL`, `_KEY`, `_TOKEN`, `_SECRET`, `_PASSWORD`, `_COMMAND`, or `_PATH`.

The example env file must contain setting names and non-secret safe defaults only. Secret and endpoint entries must be empty:

```dotenv
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_TABLE=ai_processing_events
SUPABASE_FOLLOW_UP_TABLE=ai_follow_up_items
HERMES_WORKER_COMMAND=
HERMES_WORKER_PROFILE=kakaoworker
BLUEBUBBLES_SERVER_URL=
BLUEBUBBLES_PASSWORD=
BLUEBUBBLES_WEBHOOK_HOST=
BLUEBUBBLES_WEBHOOK_PORT=
BLUEBUBBLES_WEBHOOK_PATH=
VILLAGE_AI_URL=
PORT=8787
KAKAO_REMOTE_DEBUGGING_PORT=9223
AI_WORKER_LIVE=0
AI_WORKER_AUTO_SEND=0
SLACK_ACTION_POLL_ENABLED=false
SLACK_AGENT_CARD_DELIVERY_ENABLED=false
KAKAO_TAB_CLEANUP_ENABLED=false
KAKAO_WORKER_CONTROL_MODE=devtools_only
KAKAO_APPLESCRIPT_FALLBACK=0
```

- [ ] **Step 4: Run tests and verify GREEN**

Run:

```bash
node --test test/windows-runtime-config.test.mjs
node --check scripts/windows/windows-runtime-config.mjs
```

Expected: all tests pass and syntax check exits `0`.

- [ ] **Step 5: Commit Task 1**

```bash
git add scripts/windows/windows-runtime-config.mjs scripts/windows/.env.windows.example test/windows-runtime-config.test.mjs
git commit -m "feat: add safe Windows runtime config contract"
```

---

### Task 2: Windows-owned lifecycle scripts

**Files:**

- Create: `scripts/windows/KakaoStaging.Common.psm1`
- Create: `scripts/windows/start-kakao-staging.ps1`
- Create: `scripts/windows/status-kakao-staging.ps1`
- Create: `scripts/windows/stop-kakao-staging.ps1`
- Create: `scripts/windows/restart-kakao-staging.ps1`
- Create: `test/windows-kakao-staging.static.test.js`

**Interfaces:**

- Consumes: `-EnvFile`, `-ChromePath`, `-NodePath`, optional `-HermesPath`, `-IncludeGateway`, `-EnableWrites`, and PowerShell common `-WhatIf`.
- Produces: dedicated Chrome, bridge, and optional gateway processes plus JSON ownership records under `%LOCALAPPDATA%\Village\kakao-staging`.
- `status-kakao-staging.ps1` emits only process state, PID, executable basename, port reachability, profile path, and whether required configuration names are set.
- `stop-kakao-staging.ps1` refuses to stop a PID when executable or command marker does not match its ownership record.

- [ ] **Step 1: Write the failing static contract test**

The test must read all PowerShell files and assert:

```js
assert.match(start, /SupportsShouldProcess/);
assert.match(start, /--remote-debugging-address=127\.0\.0\.1/);
assert.match(start, /--remote-debugging-port=/);
assert.match(start, /--user-data-dir=/);
assert.match(start, /windows-runtime-config\.mjs/);
assert.match(common, /AI_WORKER_AUTO_SEND/);
assert.match(common, /KAKAO_WORKER_CONTROL_MODE/);
assert.match(stop, /Get-CimInstance\s+Win32_Process/);
assert.match(stop, /CommandLine/);
assert.match(stop, /ExecutablePath/);
assert.doesNotMatch(allScripts, /launchctl|osascript|\/Applications\/Google Chrome|Library\/Application Support/);
assert.doesNotMatch(stop, /taskkill\s+\/IM|Get-Process\s+-Name/);
```

Also assert start order by source position: configuration validation, Chrome, bridge, optional gateway. Assert `restart-kakao-staging.ps1` forwards `-EnableWrites` only when explicitly supplied.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
node --test test/windows-kakao-staging.static.test.js
```

Expected: FAIL because the PowerShell scripts do not exist.

- [ ] **Step 3: Implement the common module**

Implement these exported functions:

```powershell
Import-DotEnvFile -Path <string>                    # sets process env without printing values
Get-KakaoStagingRoot                                # %LOCALAPPDATA%\Village\kakao-staging
Write-OwnedProcessRecord -Name -Process -ExecutablePath -CommandMarker
Read-OwnedProcessRecord -Name
Test-OwnedProcessRecord -Record                     # PID + ExecutablePath + CommandLine marker
Stop-OwnedProcess -Name -WhatIf                     # refuses mismatches
Test-LocalTcpPort -Port <int>                       # 127.0.0.1 only
```

Use `ConvertTo-Json` records and atomic temp-file rename. Never serialize environment values.

- [ ] **Step 4: Implement start/status/stop/restart**

`start-kakao-staging.ps1` must:

1. Support `ShouldProcess` and `-WhatIf`.
2. Invoke `node scripts/windows/windows-runtime-config.mjs --env <path>` before any process start.
3. Import the env locally, then force the exact safe staging variables unless `-EnableWrites` is present.
4. Use `%LOCALAPPDATA%\Village\chrome-kakao` by default and load `tools/kakao-dom-watcher-extension`.
5. Start Chrome with localhost DevTools, wait for port readiness, then start `tools/kakao-dom-bridge/server.mjs` with working directory `tools/kakao-dom-bridge`.
6. Start Hermes gateway only when `-IncludeGateway` is present.
7. Write ownership records immediately after each successful process start.
8. On partial failure, stop only processes started by the current invocation using ownership records.

`status-kakao-staging.ps1` must be read-only. `stop-kakao-staging.ps1` must stop in gateway → bridge → Chrome order. `restart-kakao-staging.ps1` must call stop, then start, preserving `-IncludeGateway`; it must never infer `-EnableWrites` from the env file.

- [ ] **Step 5: Run tests and syntax/static verification**

Run:

```bash
node --test test/windows-kakao-staging.static.test.js
node --test test/windows-runtime-config.test.mjs
```

Expected: all tests pass. Because PowerShell is unavailable on the Mac audit host, record Windows execution as a required cutover gate rather than claiming it was run.

- [ ] **Step 6: Commit Task 2**

```bash
git add scripts/windows/KakaoStaging.Common.psm1 scripts/windows/*-kakao-staging.ps1 test/windows-kakao-staging.static.test.js
git commit -m "feat: add Windows-owned Kakao staging lifecycle"
```

---

### Task 3: Disabled scheduled tasks and cutover/rollback runbook

**Files:**

- Create: `scripts/windows/register-kakao-scheduled-tasks.ps1`
- Create: `docs/windows-kakao-hermes-migration-runbook.md`
- Modify: `test/windows-kakao-staging.static.test.js`

**Interfaces:**

- Consumes: Windows staging paths from Task 2.
- Produces: disabled-at-creation Task Scheduler entries and a manual operator runbook.

- [ ] **Step 1: Extend the failing static test**

Assert the registration script:

```js
assert.match(register, /Register-ScheduledTask/);
assert.match(register, /New-ScheduledTaskTrigger\s+-AtLogOn/);
assert.match(register, /Disable-ScheduledTask/);
assert.match(register, /SupportsShouldProcess/);
assert.doesNotMatch(register, /Start-ScheduledTask/);
```

Assert the runbook contains headings for Preconditions, Secret transfer, No-send staging, Mac-retained services, Cutover, Verification, Rollback, and Abort criteria, and names the four safe flags `AI_WORKER_AUTO_SEND`, `SLACK_ACTION_POLL_ENABLED`, `KAKAO_WORKER_CONTROL_MODE`, and `KAKAO_APPLESCRIPT_FALLBACK`.

- [ ] **Step 2: Run the test and verify RED**

Run:

```bash
node --test test/windows-kakao-staging.static.test.js
```

Expected: FAIL because the registration script and runbook are absent.

- [ ] **Step 3: Implement disabled task registration**

Register separate at-logon status/start tasks only after `ShouldProcess` approval. Every created task must be disabled before the script exits. Do not start any task. The start action must omit `-EnableWrites`; writes can only be enabled manually during an approved cutover.

- [ ] **Step 4: Write the runbook**

The runbook must state:

- Mac retains BlueBubbles, Messages, and watch voice relay.
- BlueBubbles and Hermes setting names only; no sample values or live endpoints.
- Windows staging order: config validate → Chrome/CDP → bridge → optional Hermes → read-only status.
- Cutover order: disable Mac Kakao watchdog and Slack backstop, stop Mac Kakao bridge, start Windows safe staging, verify, then explicitly enable one write path at a time; Kakao auto-send is last.
- Rollback order: disable Windows writes and scheduled tasks, stop Windows-owned processes, restore Mac bridge/watchdog/backstop, verify local ports and queue health, leave BlueBubbles and Messages untouched.
- Abort on duplicate workers, missing CDP, configuration validation failure, PID ownership mismatch, BlueBubbles relay failure, or any unexpected external send.

- [ ] **Step 5: Run full scoped verification**

Run:

```bash
node --test test/windows-runtime-config.test.mjs test/windows-kakao-staging.static.test.js
node --check scripts/windows/windows-runtime-config.mjs
git diff --check
```

Expected: all tests pass, syntax check exits `0`, and `git diff --check` is clean.

- [ ] **Step 6: Commit Task 3**

```bash
git add scripts/windows/register-kakao-scheduled-tasks.ps1 docs/windows-kakao-hermes-migration-runbook.md test/windows-kakao-staging.static.test.js
git commit -m "docs: add Windows cutover and rollback runbook"
```

---

## Self-Review

- Spec coverage: source audit findings are converted into staging configuration, Windows lifecycle ownership, Mac-retained relay boundaries, and rollback gates.
- Placeholder scan: no unresolved implementation placeholders are permitted.
- Type consistency: all lifecycle scripts use the same env path, runtime root, process record schema, and safe flag names.
- Platform limitation: PowerShell execution cannot be claimed until run on the Windows target; Mac verification is limited to Node behavior, static contracts, and repository checks.
