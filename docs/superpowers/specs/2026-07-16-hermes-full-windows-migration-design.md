# Hermes Full Windows Migration Design

**Date:** 2026-07-16  
**Status:** Approved design, pending written-spec review  
**Target:** AX2 Windows at `C:\Village`  
**Source:** VILLAGEs Mac mini user `village6k`

## Goal

Reconstruct the Mac mini's effective Hermes/Heybill operating capability on AX2 Windows without treating GitHub origin as the complete source, without losing dirty working-tree or Hermes state assets, and without enabling any live sender during migration.

The resulting Windows staging environment must preserve the business reasoning chain, source code, operational prompts, curated memory, integration configuration, schedules, and rollback evidence needed to become the primary Hermes host. Apple-only messaging remains on the Mac as a private Tailscale relay.

## Non-goals

- Do not send Slack, Kakao, iMessage, SMS, tax invoice, notification, or webhook traffic during staging.
- Do not enable Funnel, expose a public port, deploy GAS/Fly/Vercel, or change external production configuration.
- Do not register or start an enabled Task Scheduler workload.
- Do not copy macOS Chrome profiles, Keychain data, Apple ID material, or Mac Hermes `auth.json` into the active Windows runtime.
- Do not activate old Hermes sessions or cron delivery records on Windows.
- Do not stop the Mac gateway, Kakao bridge, BlueBubbles, watch relay, or Codex automations during staging.

## Evidence Baseline

### Mac runtime

- Hermes `0.16.0`, source `298bb93d397f`, provider `openai-codex`; exact provider-default model is not recorded.
- Global gateway PID 660 owns Slack, BlueBubbles, and webhook adapters.
- Active listeners: gateway `127.0.0.1:8644/8645`, watch relay `127.0.0.1:8788`, BlueBubbles `*:1234`, Kakao bridge `127.0.0.1:8787`, Kakao CDP `127.0.0.1:9223`, dashboard `127.0.0.1:9120`.
- Hermes assets include a 3 GB state database, 168 global sessions, 128 `kakaoworker` sessions, four global memories, two profile memories, curated Village skills, and two Hermes cron records.
- Mac Remote Login and Tailscale SSH are disabled. Tailscale Taildrop is available between `village-macmini-1` and `AX2`.

### Source repositories

| Repository | Mac branch/HEAD | State that must be preserved |
|---|---|---|
| `my-gas-project2` | `codex/kakao-reconcile-safety` / `4db5ec794176` | 5 modified + 1 untracked after the checkpoint |
| Windows staging worktree | `codex/windows-migration-staging` / `fd29adb8a7a3` | clean; 10 Windows lifecycle/config/test/runbook commits |
| `my-gas-project` | `main` / `fb4c11e07866` | 21 untracked items requiring code-vs-backup classification |
| `village-ai` | `village-brain/deep-knowledge-batches` / `65dabea34560` | 8 tracked changes and 43 total status entries |
| `village-kakao-ai` | `main` / `c9d25c86c78b` | 25 status entries; active Codex daily audit reference |

The post-checkpoint `my-gas-project2` paths are the AI worker, worker test, Chrome launcher, bridge server, watcher extension content script, and an untracked bridge test. They are required for parity.

### Windows baseline

- Hermes `0.18.2`, OpenAI Codex authenticated, model `gpt-5.6-sol`.
- Slack, SMS, and BlueBubbles are not configured; gateway stopped; zero scheduled jobs and zero active Hermes sessions.
- `C:\Village\my-gas-project2` is origin `main` at `9f716f9` with intentional Windows migration changes. It must not be overwritten.
- `AI_WORKER_LIVE=0` and `AI_WORKER_AUTO_SEND=0` are set at user scope.
- Tailscale address is `100.79.164.9`; no automation listeners or registered Village task are active.

## Effective Brain and Execution Architecture

The migrated agent is a composition, not a single model or folder.

1. **Hermes controller:** Windows Hermes `0.18.2` with the existing Windows OpenAI Codex authentication and `gpt-5.6-sol` model selection.
2. **Kakao business reasoning:** `my-gas-project2/tools/ai-browser-worker/worker.mjs` builds the operational policy prompt and runs Hermes with terminal, computer-use, and vision tools.
3. **Long-term business knowledge:** `village-ai` exposes `/api/ask`, searches Supabase knowledge, and generates grounded answers with Claude Sonnet 4.6. Hermes uses it as read-only reference memory. Its briefings use a Haiku model and Slack delivery.
4. **Accounting execution:** `my-gas-project` contains the GAS/Popbill functions that validate trades, issue or correct tax invoices, check NTS status, and record results.
5. **Hands and feet:** Kakao watcher extension, CDP, DOM bridge, CUA/UI Automation, Slack Socket Mode and follow-up bridge, GAS/Sheets/Drive, Supabase queues, and Popbill.
6. **Apple relay:** BlueBubbles, Messages, iMessage/SMS, Apple Watch/Shortcuts voice relay, and macOS-only permissions remain on the Mac.
7. **Additional Kakao operations:** `village-kakao-ai` is preserved and audited separately. Its daily Codex audit is active on the source machine, while `village-auto-reply` is paused and no local daemon is currently active.

## Approved Approach

Use a forensic mirror followed by an isolated, no-send Windows reconstruction.

The rejected alternatives are:

- **GitHub-only rebuild:** simpler, but loses four dirty worktrees, Mac-only configuration, memory, and the already-reviewed Windows staging branch.
- **Direct overwrite and live switch:** faster, but risks losing current Windows changes, auto-resuming old sessions, duplicate Slack/Kakao writers, and activating incompatible macOS paths.

## Transfer Units

The Mac produces five independently hashed units in a private staging directory:

1. **Git history:** one Git bundle per repository, including all local branches and the clean `fd29adb` Windows staging worktree branch.
2. **Dirty source overlays:** binary-safe patches for tracked changes plus a tar archive of reviewed untracked source/test files. Runtime caches, generated logs, node modules, `.env`, auth, browser data, and customer exports are excluded.
3. **Portable Hermes brain:** `SOUL.md`, curated Village skills, curated memories, redacted config key template, cron schedule metadata, adapter patch sources, and launch definitions. Bundled generic skills are not recopied when the Windows version already supplies them.
4. **Protected secrets:** required `.env` and credential material except Mac Hermes `auth.json`, Chrome cookies, Keychain, and Apple credentials. This unit is transferred only over Taildrop into a Windows ACL-restricted vault and is never printed or committed.
5. **Protected state archive:** consistent snapshots of Hermes state/session/memory databases and operational metadata. It is stored offline for completeness and rollback evidence; it is not installed as the active Windows state database.

Each unit has a SHA-256 manifest containing only relative paths, sizes, hashes, sensitivity class, and source snapshot time. Customer-bearing directory entries use aggregate counts and hashes rather than customer-identifying filenames.

## Transfer and Import Data Flow

```text
Mac live repos/state
  -> read-only inventory + consistent snapshots
  -> private Mac migration staging directory
  -> SHA-256 manifest
  -> Tailscale Taildrop to AX2
  -> C:\Users\ssper\AppData\Local\Village\MigrationInbox
  -> hash verification
  -> C:\Village\MigrationImport\<snapshot-id> (code)
  -> C:\Users\ssper\AppData\Local\Village\MigrationVault\<snapshot-id> (secrets/state)
  -> isolated repo reconstruction and comparison
  -> Windows-compatible config translation
  -> forced dry-run verification
```

Taildrop avoids enabling Remote Login or changing Mac SSH configuration. Inbox retrieval must use conflict mode `skip` or a unique snapshot directory; it never overwrites an earlier transfer.

## Repository Reconstruction

- Clone each Git bundle into a new import directory. Set the GitHub URL as `origin` only after reconstruction; no push occurs.
- Recreate the `fd29adb` staging branch exactly and verify its commit graph contains `4db5ec7`.
- Apply dirty overlays in an import branch so the original Mac working-tree state remains inspectable and reversible.
- Classify every untracked path as source/test/documentation, backup, runtime/generated, secret, or customer data.
- Preserve source/test/documentation in the import branch. Store backups and customer/runtime state in the protected archive, not Git.
- Compare the imported `my-gas-project2` against the current Windows tree. Integrate intentionally; never replace `C:\Village\my-gas-project2` wholesale.
- Keep `my-gas-project`, `village-ai`, and `village-kakao-ai` as separate repositories under `C:\Village`.

## Hermes Translation

- Back up the complete Windows Hermes directory before changing active configuration.
- Retain the Windows `0.18.2` binary, virtual environment, OpenAI Codex `auth.json`, and `gpt-5.6-sol` selection.
- Translate Mac `0.16.0` YAML keys into the Windows `0.18.2` schema through an allowlisted merger; do not copy Mac `config.yaml` wholesale.
- Import Mac `SOUL.md`, Village-specific skills, and curated memories after hash verification. Generic bundled skills remain sourced from Windows Hermes.
- Create a Windows `kakaoworker` profile with Windows paths and the OpenAI Codex provider.
- Preserve old session/state snapshots offline. Start Windows with a fresh session namespace so no Mac Slack thread, delivery record, or cron job auto-resumes.
- Translate only schedule definitions into disabled Windows Task Scheduler XML. Delivery remains disabled.

## Secret Handling

- Vault root: `C:\Users\ssper\AppData\Local\Village\MigrationVault`.
- ACL: current user, SYSTEM, and local Administrators only; inherited broad access removed.
- Secret values are processed in memory or copied directly to protected files. Commands and reports expose key names and presence only.
- Environment merge uses an explicit key allowlist for Slack, Supabase, GAS, Popbill, village-ai, Kakao bridge, BlueBubbles relay, and watch callback configuration.
- `AI_WORKER_LIVE` and `AI_WORKER_AUTO_SEND` are forcibly written as `0`, regardless of source values.
- BlueBubbles points to the Mac Tailscale address, never a public endpoint. Funnel remains disabled.
- The Mac BlueBubbles shim `.env`, currently mode 644, is treated as high sensitivity in the transfer. Its Mac permission is not changed during staging.

## External and Nonportable State

The following require user login or verification on Windows and are not copied from macOS:

- GitHub Credential Manager for private fetch/push.
- Slack app/Socket Mode and the expired Codex Slack connector reauthentication.
- Kakao Business Channel Manager in a dedicated Windows Chrome profile.
- Google account and `clasp` authorization.
- Fly, Vercel, Supabase CLI, and any required organization SSO.

External production services remain deployed in place during staging. The migration verifies configuration contracts and source parity but does not redeploy them.

## Windows Runtime Boundaries

- Chrome/CDP `9223`, DOM bridge `8787`, and local worker endpoints bind to `127.0.0.1` only.
- Windows CUA replaces AppleScript for UI fallback. CDP/DOM paths are preferred.
- BlueBubbles continues on the Mac. Windows may access it only over Tailscale with the existing password and allowed-user restrictions.
- Task Scheduler definitions use least privilege, interactive-user requirements for Chrome, disabled state, and no `-EnableWrites` argument.
- Process lifecycle scripts stop only PIDs they started and validate executable path, command marker, and ownership record before termination.
- Only one machine may own each writer or sender. Mac remains owner until an explicit cutover step changes the ownership matrix.

## Failure Handling and Rollback

- A manifest or hash mismatch quarantines the entire unit; no partial import proceeds.
- A patch conflict is resolved in the isolated import tree and never against the live Mac or current Windows tree.
- A config schema mismatch produces a key-name report without values and blocks activation.
- A missing login blocks only the dependent integration; it does not relax dry-run flags.
- Any unexpected listener, enabled task, live flag, production queue table, or sender configuration aborts verification.
- Rollback first forces Windows write/send flags off, stops only Windows-owned processes, preserves queue/idempotency state, and leaves Apple relays untouched. Mac ownership is restored only after duplicate-processing checks.

## Verification Strategy

1. Verify every transfer-unit hash and Git bundle.
2. Verify all expected repository HEADs, branches, dirty overlays, and untracked classifications.
3. Run PowerShell static safety tests, parser checks, Node syntax checks, worker tests, bridge tests, Slack follow-up tests, dashboard tests, and repository-specific tests that do not send or deploy.
4. Run Hermes status and computer-use diagnostics without sending a prompt or starting the gateway.
5. Validate `village-ai` RAG configuration structurally without calling production `/api/ask` unless a later read-only test is explicitly approved.
6. Validate tax-invoice routing through unit/static tests only; do not call GAS/Popbill issue actions.
7. Export disabled Task Scheduler definitions and confirm no matching task is registered.
8. Confirm no listeners on `8787` or `9223`, no Village scheduled task, gateway stopped, and both live flags equal `0`.

## Staging Completion Criteria

Staging is complete only when:

- all four repository states and the Windows staging branch are reconstructed with verified hashes;
- every dirty and untracked item is classified and preserved in Git or the protected archive;
- the Windows Hermes brain contains the approved SOUL, Village skills, curated memory, compatible profile, and fresh session namespace;
- GBrain/village-ai, Slack, Kakao, Supabase, GAS, accounting, Popbill, BlueBubbles relay, watch relay, and Codex automation dependencies each have an owner and verification result;
- all safe tests pass or every pre-existing/environment-only failure is documented with evidence;
- no live sender, writer, gateway, webhook exposure, Funnel, or enabled scheduled task was started.

## Cutover Gate

Cutover is a separate approval boundary. It requires completed Windows logins/2FA, a reviewed ownership matrix, verified rollback commands, a maintenance window, and explicit permission to relax the original no-live constraints. Until then the Mac continues production operation and Windows remains a non-sending staging candidate.
