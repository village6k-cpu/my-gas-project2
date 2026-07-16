# Hermes Full Windows Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reconstruct the Mac mini's complete Hermes/Village operating capability on AX2 Windows as a verified, non-sending staging candidate while preserving every source, brain, state, secret, and rollback artifact needed for a later cutover.

**Architecture:** A Mac-side exporter creates five independently hashed transfer units without changing any live repository or daemon. Tailscale Taildrop delivers the snapshot to a Windows inbox, where PowerShell verifies and separates code from ACL-protected secrets/state before rebuilding each repository in an isolated import root. Windows Hermes 0.18.2 keeps its own OpenAI Codex authentication and model while an allowlisted translator imports portable SOUL, Village skills, memory, and disabled schedule definitions into a fresh session namespace.

**Tech Stack:** macOS Bash/Python 3/Git/tar/Tailscale CLI; Windows PowerShell 5.1/Git/tar/Tailscale CLI; Hermes Agent 0.18.2; Node.js 24 LTS; Python 3; Windows Task Scheduler XML.

## Global Constraints

- Keep `AI_WORKER_LIVE=0` and `AI_WORKER_AUTO_SEND=0` at Windows user scope and inside every launcher process.
- Do not send Slack, Kakao, iMessage, SMS, tax-invoice, notification, or webhook traffic.
- Do not start a Hermes gateway, live bot, worker, DOM bridge, Chrome automation profile, BlueBubbles client, or production queue consumer.
- Do not expose a public port, enable Tailscale Funnel, deploy GAS/Fly/Vercel, or change an external production service.
- Do not register or start an operational Task Scheduler task; export disabled XML definitions only.
- Do not print or commit `.env`, `auth.json`, tokens, cookies, passwords, customer data, or secret values.
- Do not copy Mac Hermes authentication, Chrome profiles, Keychain, Apple ID, or Apple permission databases into the active Windows runtime.
- Do not overwrite `C:\Village\my-gas-project2`; all reconstruction starts under a unique `C:\Village\MigrationImport\<snapshot-id>` root.
- Preserve Mac dirty worktrees and the Windows dirty worktree exactly; GitHub origin is not a complete source of truth.
- Mac remains the owner of every live sender and Apple-only relay until a separate cutover approval.

## File Structure

- `scripts/migration/New-HermesMacSnapshot.sh`: read-only Mac exporter for Git bundles, dirty overlays, portable Hermes assets, protected secrets, and protected state.
- `scripts/migration/Test-HermesMigrationSafety.ps1`: fail-closed Windows guard for live flags, listeners, gateway, scheduled tasks, and safe destination roots.
- `scripts/migration/Receive-HermesMigration.ps1`: Taildrop receiver, archive path validation, SHA-256 manifest verification, and inbox quarantine.
- `scripts/migration/Import-HermesRepositories.ps1`: isolated Git-bundle cloning, branch/HEAD verification, tracked-patch application, and untracked classification extraction.
- `scripts/migration/Import-HermesPortableState.ps1`: ACL-protected vault import, Windows Hermes backup, allowlisted portable-state merge, and disabled scheduler export.
- `scripts/migration/Test-HermesMigrationDryRun.ps1`: end-to-end no-send verification and redacted readiness report.
- `test/migration-snapshot.static.test.js`: static contract tests for the Mac exporter.
- `test/hermes-migration-safety.test.ps1`: executable PowerShell tests for fail-closed safety behavior.
- `test/hermes-migration-import.test.ps1`: fixture-based archive, manifest, Git-bundle, traversal, and portable-state import tests.
- `docs/operations/hermes-windows-migration-runbook.md`: repeatable staging, verification, login/2FA, rollback, and cutover-gate instructions.

---

### Task 1: Add Fail-Closed Windows Safety Gate

**Files:**
- Create: `scripts/migration/Test-HermesMigrationSafety.ps1`
- Create: `test/hermes-migration-safety.test.ps1`

**Interfaces:**
- Consumes: `-ImportRoot`, `-VaultRoot`, Windows user environment, TCP listener table, process table, and Task Scheduler.
- Produces: exit code `0` plus a redacted JSON object when safe; throws before mutation when any live condition is detected.

- [ ] **Step 1: Write the failing safety test**

Create a test harness that runs the safety script in a child PowerShell process so temporary environment overrides cannot affect the parent:

```powershell
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$script = Join-Path $repo 'scripts\migration\Test-HermesMigrationSafety.ps1'
if (Test-Path $script) { Remove-Item $script -Force }
& powershell.exe -NoProfile -Command "& '$script' -AsJson"
if ($LASTEXITCODE -eq 0) { throw 'Expected missing implementation to fail' }
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File test/hermes-migration-safety.test.ps1
```

Expected: non-zero exit because `Test-HermesMigrationSafety.ps1` does not exist.

- [ ] **Step 3: Implement the minimal safety contract**

Implement parameters `ImportRoot`, `VaultRoot`, `TaskNamePattern`, and `AsJson`; force both safety variables to `0` at process and user scope; reject roots outside the approved prefixes; reject listeners `8787`, `9223`, `8644`, `8645`, or `9120`; reject running commands containing `hermes gateway`, `ai-browser-worker`, `kakao-dom-bridge`, or `slack-followup`; reject registered Village/Hermes/Kakao scheduled tasks; and emit only names, booleans, counts, and paths.

```powershell
[CmdletBinding()]
param(
  [string]$ImportRoot = 'C:\Village\MigrationImport',
  [string]$VaultRoot = "$env:LOCALAPPDATA\Village\MigrationVault",
  [string]$TaskNamePattern = 'Village|Hermes|Kakao',
  [switch]$AsJson
)
$ErrorActionPreference = 'Stop'
[Environment]::SetEnvironmentVariable('AI_WORKER_LIVE', '0', 'Process')
[Environment]::SetEnvironmentVariable('AI_WORKER_AUTO_SEND', '0', 'Process')
[Environment]::SetEnvironmentVariable('AI_WORKER_LIVE', '0', 'User')
[Environment]::SetEnvironmentVariable('AI_WORKER_AUTO_SEND', '0', 'User')
$approvedImport = [IO.Path]::GetFullPath('C:\Village\MigrationImport')
$approvedVault = [IO.Path]::GetFullPath("$env:LOCALAPPDATA\Village\MigrationVault")
$actualImport = [IO.Path]::GetFullPath($ImportRoot)
$actualVault = [IO.Path]::GetFullPath($VaultRoot)
if (-not $actualImport.StartsWith($approvedImport, [StringComparison]::OrdinalIgnoreCase)) { throw 'Import root is outside the approved prefix' }
if (-not $actualVault.StartsWith($approvedVault, [StringComparison]::OrdinalIgnoreCase)) { throw 'Vault root is outside the approved prefix' }
$unsafePorts = @(8787, 9223, 8644, 8645, 9120)
$listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object LocalPort -in $unsafePorts)
$commands = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'hermes(.exe)?\s+gateway|ai-browser-worker|kakao-dom-bridge|slack-followup' })
$tasks = @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -match $TaskNamePattern })
if ($listeners.Count) { throw "Unsafe listener count: $($listeners.Count)" }
if ($commands.Count) { throw "Unsafe automation process count: $($commands.Count)" }
if ($tasks.Count) { throw "Unexpected scheduled task count: $($tasks.Count)" }
$result = [ordered]@{ Safe = $true; Live = '0'; AutoSend = '0'; ListenerCount = 0; ProcessCount = 0; TaskCount = 0; ImportRoot = $actualImport; VaultRoot = $actualVault }
if ($AsJson) { $result | ConvertTo-Json -Compress } else { [pscustomobject]$result }
```

- [ ] **Step 4: Replace the harness with positive and negative assertions, then run it**

The final test must call the script successfully, assert both variables are `0`, assert `Safe=true`, then call it with `-ImportRoot C:\Temp\Unsafe` and require a non-zero exit.

Run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File test/hermes-migration-safety.test.ps1
```

Expected: `Hermes migration safety tests passed.`

- [ ] **Step 5: Commit the safety gate**

```powershell
git add scripts/migration/Test-HermesMigrationSafety.ps1 test/hermes-migration-safety.test.ps1
git commit -m "feat: add fail-closed Hermes migration safety gate"
```

### Task 2: Add Mac Forensic Snapshot Exporter

**Files:**
- Create: `scripts/migration/New-HermesMacSnapshot.sh`
- Create: `test/migration-snapshot.static.test.js`

**Interfaces:**
- Consumes: the five known Mac Git worktrees, resolved Mac Hermes data roots, and a private `0700` staging directory.
- Produces: `<snapshot-id>.tar.gz`, `<snapshot-id>.sha256`, and a redacted `manifest.json` with units `git`, `overlays`, `hermes-portable`, `secrets`, and `state`.

- [ ] **Step 1: Write a failing static contract test**

The Node test reads the exporter as text and asserts `set -euo pipefail`, `umask 077`, all five repository paths, `git bundle create`, `git diff --binary`, NUL-delimited untracked discovery, explicit secret excludes, `AI_WORKER_LIVE=0`, `AI_WORKER_AUTO_SEND=0`, per-unit SHA-256 manifests, and no service-control commands.

```javascript
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
const file = path.resolve('scripts/migration/New-HermesMacSnapshot.sh');
test('Mac snapshot exporter is forensic and non-activating', () => {
  const source = fs.readFileSync(file, 'utf8');
  for (const token of ['set -euo pipefail', 'umask 077', 'git bundle create', 'git diff --binary', 'git ls-files --others --exclude-standard -z', 'AI_WORKER_LIVE=0', 'AI_WORKER_AUTO_SEND=0']) assert.match(source, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  for (const repo of ['my-gas-project2', 'windows-migration-staging', 'my-gas-project', 'village-ai', 'village-kakao-ai']) assert.match(source, new RegExp(repo));
  assert.doesNotMatch(source, /launchctl\s+(load|unload|kickstart)|kill(all)?\b|tailscale\s+funnel/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
node --test test/migration-snapshot.static.test.js
```

Expected: `ENOENT` for the missing exporter.

- [ ] **Step 3: Implement snapshot creation without touching live state**

Implement these exact behaviors in Bash:

```bash
#!/usr/bin/env bash
set -euo pipefail
umask 077
: "${HOME:?HOME is required}"
snapshot_id="$(date -u +%Y%m%dT%H%M%SZ)-$(hostname -s)"
stage="${TMPDIR:-/tmp}/village-hermes-migration/${snapshot_id}"
mkdir -p "$stage"/{git,overlays,hermes-portable,secrets,state,meta}
repos=(
  "$HOME/my-gas-project2"
  "$HOME/my-gas-project2-worktrees/windows-migration-staging"
  "$HOME/my-gas-project"
  "$HOME/village-ai"
  "$HOME/village-kakao-ai"
)
export AI_WORKER_LIVE=0 AI_WORKER_AUTO_SEND=0
for repo in "${repos[@]}"; do
  test -d "$repo/.git" -o -f "$repo/.git"
  name="$(basename "$repo")"
  if [[ "$repo" == *windows-migration-staging ]]; then name="my-gas-project2-windows-migration-staging"; fi
  git -C "$repo" bundle create "$stage/git/$name.bundle" --all
  git -C "$repo" diff --binary HEAD > "$stage/overlays/$name.tracked.patch"
  git -C "$repo" status --porcelain=v2 -z > "$stage/meta/$name.status.z"
  git -C "$repo" ls-files --others --exclude-standard -z > "$stage/meta/$name.untracked.z"
done
```

Use a Python 3 helper embedded in the script to classify every NUL-delimited untracked path as `source`, `backup`, `runtime`, `secret`, or `customer`; reject path traversal; write only relative path hash/count records to the protected inventory; archive `source` into overlays, `secret` into secrets, and the remaining classes into state. Copy only resolved `SOUL.md`, Village-specific skill directories, curated memory, redacted config-key metadata, cron metadata, and launch definitions into `hermes-portable`. Use SQLite backup or a filesystem snapshot copy for the 3 GB database, never the live database file while it is changing. Hash every unit, write `manifest.json`, create a final tarball, and generate the outer `.sha256`.

- [ ] **Step 4: Run static and shell syntax checks**

Run on Windows:

```powershell
node --test test/migration-snapshot.static.test.js
```

Run through the Mac remote task before export:

```bash
bash -n scripts/migration/New-HermesMacSnapshot.sh
```

Expected: both checks pass; no snapshot has been sent yet.

- [ ] **Step 5: Commit the exporter**

```powershell
git add scripts/migration/New-HermesMacSnapshot.sh test/migration-snapshot.static.test.js
git commit -m "feat: add forensic Mac Hermes snapshot exporter"
```

### Task 3: Add Taildrop Receiver and Manifest Verifier

**Files:**
- Create: `scripts/migration/Receive-HermesMigration.ps1`
- Create: `test/hermes-migration-import.test.ps1`

**Interfaces:**
- Consumes: Taildrop files in `%LOCALAPPDATA%\Village\MigrationInbox`, outer `.sha256`, archive, and inner `manifest.json`.
- Produces: a verified, immutable inbox snapshot or a quarantined snapshot; returns `{ SnapshotId, ArchivePath, ManifestPath, Verified }`.

- [ ] **Step 1: Write failing fixture tests**

Build a small temporary archive with `manifest.json` and a payload, verify success, alter one byte and require quarantine, and create an archive entry `../escape.txt` and require rejection before extraction.

```powershell
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$receiver = Join-Path $repo 'scripts\migration\Receive-HermesMigration.ps1'
if (-not (Test-Path $receiver)) { throw 'Receiver implementation missing as expected' }
```

- [ ] **Step 2: Run the fixture test to verify it fails**

Run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File test/hermes-migration-import.test.ps1
```

Expected: failure stating the receiver is missing.

- [ ] **Step 3: Implement receive, validation, and quarantine**

The script must support `-ArchivePath` for tests and `-GetTaildrop` for the real transfer. `-GetTaildrop` runs `tailscale.exe file get --conflict=skip <unique-inbox>`; direct mode never overwrites. Before extraction, run `tar -tf` and reject absolute paths, drive-qualified paths, backslashes, or any `..` segment. Compare the outer SHA-256 with `Get-FileHash`; extract into a new directory; parse the manifest; verify each relative file size and hash; then mark the snapshot verified using a new `verified.json`. On any failure, move only the new unique snapshot directory under `MigrationInbox\Quarantine` and throw.

```powershell
function Test-SafeArchiveEntry([string]$Entry) {
  if ([string]::IsNullOrWhiteSpace($Entry)) { return $true }
  if ($Entry.StartsWith('/') -or $Entry -match '^[A-Za-z]:' -or $Entry.Contains('\')) { return $false }
  return -not (@($Entry.Split('/')) -contains '..')
}
function Assert-Hash([string]$Path, [string]$Expected) {
  $actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
  if ($actual -ne $Expected.ToLowerInvariant()) { throw "SHA-256 mismatch for $([IO.Path]::GetFileName($Path))" }
}
```

- [ ] **Step 4: Run success, tamper, and traversal tests**

Run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File test/hermes-migration-import.test.ps1
```

Expected: `Hermes migration archive tests passed.` and no file outside the fixture root.

- [ ] **Step 5: Commit the receiver**

```powershell
git add scripts/migration/Receive-HermesMigration.ps1 test/hermes-migration-import.test.ps1
git commit -m "feat: verify and quarantine Hermes migration transfers"
```

### Task 4: Reconstruct All Repository States in Isolation

**Files:**
- Create: `scripts/migration/Import-HermesRepositories.ps1`
- Extend: `test/hermes-migration-import.test.ps1`

**Interfaces:**
- Consumes: verified snapshot directory and expected repository HEAD map.
- Produces: isolated clones under `C:\Village\MigrationImport\<snapshot-id>\repos`, import branches containing tracked and reviewed source overlays, and `repository-verification.json`.

- [ ] **Step 1: Extend tests with a dirty Git fixture**

Create a fixture repository with two commits, one modified tracked file, one untracked source file, and one untracked secret-shaped file. Bundle all refs and build matching overlay inputs. Assert the importer reproduces commit history and source changes, does not copy the secret into Git, and refuses an unexpected HEAD.

- [ ] **Step 2: Run the focused fixture test to verify it fails**

Run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File test/hermes-migration-import.test.ps1 -RepositoryCasesOnly
```

Expected: failure because `Import-HermesRepositories.ps1` is missing.

- [ ] **Step 3: Implement deterministic reconstruction**

For each manifest repository, run `git clone <bundle> <new-path>`, verify the bundle with `git bundle verify`, fetch every bundle ref, checkout the recorded branch or detached HEAD, create `migration/<snapshot-id>-overlay`, apply the binary tracked patch with `git apply --index --3way`, extract only manifest-classified `source`, `test`, and `documentation` untracked entries, and leave them uncommitted for byte-for-byte inspection. Set the GitHub URL as `origin` only after reconstruction; do not fetch, push, or authenticate.

```powershell
$expected = [ordered]@{
  'my-gas-project2' = '4db5ec794176'
  'my-gas-project2-windows-migration-staging' = 'fd29adb8a7a3'
  'my-gas-project' = 'fb4c11e07866'
  'village-ai' = '65dabea34560'
  'village-kakao-ai' = 'c9d25c86c78b'
}
foreach ($name in $expected.Keys) {
  $actual = (& git -C $repoPath rev-parse HEAD).Trim()
  if (-not $actual.StartsWith($expected[$name], [StringComparison]::OrdinalIgnoreCase)) { throw "Unexpected HEAD for $name" }
}
```

- [ ] **Step 4: Run fixture tests and compare the real Windows tree without modifying it**

Run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File test/hermes-migration-import.test.ps1 -RepositoryCasesOnly
git -C C:\Village\my-gas-project2 status --short
```

Expected: fixture tests pass; the current Windows status is unchanged.

- [ ] **Step 5: Commit the repository importer**

```powershell
git add scripts/migration/Import-HermesRepositories.ps1 test/hermes-migration-import.test.ps1
git commit -m "feat: reconstruct migration repositories in isolation"
```

### Task 5: Import Protected State and Portable Hermes Brain

**Files:**
- Create: `scripts/migration/Import-HermesPortableState.ps1`
- Extend: `test/hermes-migration-import.test.ps1`

**Interfaces:**
- Consumes: verified `hermes-portable`, `secrets`, and `state` units; Windows Hermes home; explicit config and environment key allowlists.
- Produces: ACL-restricted vault snapshot, timestamped Windows Hermes backup, imported SOUL/Village skills/memories, translated disabled profile/schedule definitions, and fresh active session storage.

- [ ] **Step 1: Add a portable-state fixture test**

The fixture contains SOUL, one Village skill, one memory, a redacted config map with an allowed key and a forbidden Mac-only key, a fake old session DB, and secret presence metadata. Assert the allowed portable files import, the forbidden key is reported by name only, the old DB remains in the vault, the active Windows auth file hash is unchanged, and both live flags remain `0`.

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File test/hermes-migration-import.test.ps1 -PortableStateCasesOnly
```

Expected: failure because the portable-state importer is missing.

- [ ] **Step 3: Implement vault ACL and allowlisted translation**

Create a unique vault root, disable inheritance with `icacls`, grant only the current user, `SYSTEM`, and `BUILTIN\Administrators`, and verify the resulting ACL. Back up the Windows Hermes home before changing portable files. Record the active `auth.json` hash without outputting its content. Import only SOUL, Village-specific skills, curated memory, and these config concepts: provider name, model selection, tool allowlist, workspace roots, profile name, local bind addresses, read-only knowledge endpoint names, and disabled schedule metadata. Reject Mac paths, launchd plists as executable configuration, provider credentials, auth/session database replacement, and enabled delivery flags.

```powershell
$allowedEnvironmentKeys = @(
  'SLACK_APP_TOKEN','SLACK_BOT_TOKEN','SLACK_SIGNING_SECRET',
  'SUPABASE_URL','SUPABASE_ANON_KEY','SUPABASE_SERVICE_ROLE_KEY',
  'VILLAGE_AI_URL','VILLAGE_OPS_API_URL','GAS_WEB_APP_URL',
  'POPBILL_LINK_ID','POPBILL_SECRET_KEY','BLUEBUBBLES_URL','BLUEBUBBLES_PASSWORD'
)
[Environment]::SetEnvironmentVariable('AI_WORKER_LIVE','0','User')
[Environment]::SetEnvironmentVariable('AI_WORKER_AUTO_SEND','0','User')
```

Secret values must be copied directly from protected source files to protected destination files without `Write-Output`, `Write-Host`, `ConvertTo-Json` of values, or command-line arguments containing values. Missing keys are reported as names only. Generate Task Scheduler XML with `<Enabled>false</Enabled>` and `LeastPrivilege`; do not call `Register-ScheduledTask`.

- [ ] **Step 4: Run portable-state tests and inspect ACLs**

Run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File test/hermes-migration-import.test.ps1 -PortableStateCasesOnly
icacls "$env:LOCALAPPDATA\Village\MigrationVault"
```

Expected: tests pass; ACL output contains only the current user, SYSTEM, and Administrators on the protected snapshot root.

- [ ] **Step 5: Commit the portable-state importer**

```powershell
git add scripts/migration/Import-HermesPortableState.ps1 test/hermes-migration-import.test.ps1
git commit -m "feat: import portable Hermes brain into protected staging"
```

### Task 6: Add End-to-End Dry-Run Verifier and Runbook

**Files:**
- Create: `scripts/migration/Test-HermesMigrationDryRun.ps1`
- Create: `docs/operations/hermes-windows-migration-runbook.md`
- Extend: `test/hermes-migration-safety.test.ps1`

**Interfaces:**
- Consumes: the verified snapshot, repository report, portable-state report, Hermes status, process/listener/task state, and required login-name list.
- Produces: `migration-readiness.json` containing only booleans, versions, hashes, counts, paths, login key names, and blockers.

- [ ] **Step 1: Write a failing dry-run report test**

Use fixture reports to assert that readiness is false when a live flag, listener, enabled task, missing repository, auth hash change, or unclassified file exists; readiness may remain staging-ready with named login blockers. Assert serialized output does not contain values matching the fixture secrets.

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File test/hermes-migration-safety.test.ps1 -DryRunCasesOnly
```

Expected: failure because the dry-run verifier is missing.

- [ ] **Step 3: Implement verification and documentation**

The verifier must run the safety gate, verify all five unit hashes, verify the five expected repository states, verify zero unclassified paths, compare Windows auth hash before/after, confirm Hermes gateway stopped and zero active scheduled jobs, confirm no Task Scheduler registration, confirm no listeners, run Node/PowerShell syntax and unit tests, and record integration readiness for GitHub, Slack, Kakao, Google/clasp, Supabase, Fly, Vercel, GAS/Popbill, BlueBubbles relay, and watch relay. It must never prompt a model or call an external API.

The runbook must contain exact commands for preflight, Mac export, Taildrop, receive, import, test, rollback, and the separate cutover gate. Rollback first rewrites both live flags to `0`, stops only Windows-owned PIDs validated by recorded executable path and command marker, and restores the timestamped Windows Hermes backup. It must explicitly say never to stop BlueBubbles, Messages, the Mac watch relay, or a Mac sender as part of Windows rollback.

- [ ] **Step 4: Run the complete local verification suite**

Run:

```powershell
node --test test/migration-snapshot.static.test.js
powershell.exe -NoProfile -ExecutionPolicy Bypass -File test/hermes-migration-safety.test.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File test/hermes-migration-import.test.ps1
git diff --check
```

Expected: all suites pass and `git diff --check` has no output.

- [ ] **Step 5: Commit verifier and runbook**

```powershell
git add scripts/migration/Test-HermesMigrationDryRun.ps1 docs/operations/hermes-windows-migration-runbook.md test/hermes-migration-safety.test.ps1
git commit -m "docs: add verified Hermes migration dry-run runbook"
```

### Task 7: Produce and Transfer the Real Mac Snapshot

**Files:**
- Consume on Mac: a verified copy of `scripts/migration/New-HermesMacSnapshot.sh`
- Create outside Git on Mac: `${TMPDIR}/village-hermes-migration/<snapshot-id>/`
- Create outside Git on Windows: `%LOCALAPPDATA%\Village\MigrationInbox\<snapshot-id>\`

**Interfaces:**
- Consumes: the audited Mac source/runtime state and Taildrop target `AX2`.
- Produces: one real verified snapshot in the Windows inbox; no source process or repository changes.

- [ ] **Step 1: Re-audit source identities immediately before snapshot**

Run through the existing Mac remote task and compare the five HEADs, status counts, Hermes version, listener ownership, and Taildrop target against the approved design. Abort if a repository disappeared, a new unclassified root appeared, or Taildrop no longer resolves to AX2.

- [ ] **Step 2: Copy the exporter to a private Mac staging path and validate it**

Run on Mac:

```bash
install -m 700 scripts/migration/New-HermesMacSnapshot.sh "$TMPDIR/New-HermesMacSnapshot.sh"
bash -n "$TMPDIR/New-HermesMacSnapshot.sh"
```

Expected: syntax passes; no repository status changes.

- [ ] **Step 3: Create and locally verify all five units**

Run on Mac:

```bash
"$TMPDIR/New-HermesMacSnapshot.sh"
shasum -a 256 -c "$SNAPSHOT_ARCHIVE.sha256"
```

Expected: all inner units and the outer archive verify. The remote task reports only snapshot ID, sizes, hashes, counts, and classification totals.

- [ ] **Step 4: Send only the verified archive and checksum over Taildrop**

Run on Mac:

```bash
tailscale file cp "$SNAPSHOT_ARCHIVE" AX2:
tailscale file cp "$SNAPSHOT_ARCHIVE.sha256" AX2:
```

Expected: both commands succeed. Do not enable SSH, Funnel, or any new listener.

- [ ] **Step 5: Receive and verify on Windows**

Run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/migration/Receive-HermesMigration.ps1 -GetTaildrop
```

Expected: `Verified=true`, and the snapshot remains isolated in the inbox.

### Task 8: Reconstruct the Real Staging Candidate and Report Blockers

**Files:**
- Create outside Git: `C:\Village\MigrationImport\<snapshot-id>\`
- Create outside Git: `%LOCALAPPDATA%\Village\MigrationVault\<snapshot-id>\`
- Create outside Git: `%LOCALAPPDATA%\Village\MigrationReports\<snapshot-id>\migration-readiness.json`

**Interfaces:**
- Consumes: the verified real snapshot and scripts from Tasks 1-6.
- Produces: a complete non-sending Windows staging candidate, evidence report, login/2FA list, ownership matrix, and explicit cutover blockers.

- [ ] **Step 1: Re-run the safety gate immediately before mutation**

Run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/migration/Test-HermesMigrationSafety.ps1 -AsJson
```

Expected: `Safe=true`, live flags `0`, and zero listeners/processes/tasks.

- [ ] **Step 2: Import repositories and portable state**

Run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/migration/Import-HermesRepositories.ps1 -SnapshotPath $verifiedSnapshot
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/migration/Import-HermesPortableState.ps1 -SnapshotPath $verifiedSnapshot
```

Expected: all expected HEADs verify, all overlays are present, every untracked path is classified, protected assets remain in the vault, and Windows auth/model remain unchanged.

- [ ] **Step 3: Install dependencies without lifecycle scripts and run safe tests**

For each imported directory containing a lockfile, run `npm.cmd ci --ignore-scripts`; then run repository syntax/unit/static tests that make no network writes. Do not run a dev server, browser worker, Slack bridge, dashboard server, deployment, or GAS/Popbill integration test.

- [ ] **Step 4: Generate the final staging-readiness report**

Run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/migration/Test-HermesMigrationDryRun.ps1 -SnapshotPath $verifiedSnapshot -AsJson
```

Expected: staging verification contains no secret/customer values; Mac is still every live writer owner; Windows is `candidate`; missing user logins/2FA are listed by integration name; cutover remains blocked.

- [ ] **Step 5: Final no-send proof**

Run:

```powershell
if ([Environment]::GetEnvironmentVariable('AI_WORKER_LIVE','User') -ne '0') { throw 'AI_WORKER_LIVE changed' }
if ([Environment]::GetEnvironmentVariable('AI_WORKER_AUTO_SEND','User') -ne '0') { throw 'AI_WORKER_AUTO_SEND changed' }
if (Get-NetTCPConnection -State Listen -LocalPort 8787,9223,8644,8645,9120 -ErrorAction SilentlyContinue) { throw 'Unexpected listener' }
if (Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object TaskName -match 'Village|Hermes|Kakao') { throw 'Unexpected task registration' }
```

Expected: no output and exit code `0`.

## Plan Self-Review

- Spec coverage: transfer units, Taildrop, five Git states, dirty overlays, Hermes translation, secrets/state separation, Apple relay boundary, disabled scheduling, rollback, logins, and cutover gate each map to Tasks 1-8.
- Placeholder scan: no unresolved marker, deferred implementation marker, or unspecified error-handling step remains.
- Interface consistency: every real import consumes the verified snapshot returned by the receiver; repository and portable-state importers write reports consumed by the dry-run verifier; the five repository names and expected HEAD prefixes match the approved design.
- Safety review: no task starts a sender, gateway, browser worker, bridge, public port, Funnel, deployment, or registered schedule.
