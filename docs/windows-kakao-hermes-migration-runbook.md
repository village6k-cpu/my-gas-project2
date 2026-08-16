# Windows Kakao and Hermes migration runbook

This runbook is a manual, no-send-first migration procedure. The scheduled task definitions remain disabled throughout staging and cutover; operators use the lifecycle scripts directly. Never use a scheduled task to enable a write path.

## Preconditions

- Approve a maintenance window and identify the operator who may authorize each write path.
- Confirm the production Mac is healthy before changing ownership. Record the Mac Kakao bridge, Kakao watchdog, Slack backstop, queue, BlueBubbles, Messages, and watch voice relay state without sending a message.
- Confirm the Windows checkout contains the reviewed runtime-config, lifecycle, status, stop, and scheduled-task registration files.
- Confirm `C:\Village\VILLAGE_Brain\Ops\brain-context-latest.md` is present and non-empty. Gateway start refuses to continue without it.
- Run the Node tests and syntax check from the reviewed commit.
- Point `-ChromePath` at Chrome for Testing or unbranded Chromium. Google Chrome 137 and later block the command-line extension loading used by this runtime, so the start script rejects that browser before launching any process.
- Treat PowerShell execution on the target Windows host as a required gate. The disabled task definitions use process-scoped `-ExecutionPolicy Bypass` so AX2's default `Restricted` policy does not block the reviewed scripts; confirm the tasks remain disabled.
- Stop immediately if an abort criterion is present.

## Secret transfer

Move the Windows environment file through the approved encrypted transfer method. Restrict its Windows ACL to the runtime account, validate the setting names, and do not paste values into a terminal, ticket, chat, log, or this runbook.

BlueBubbles setting names:

- `BLUEBUBBLES_SERVER_URL`
- `BLUEBUBBLES_PASSWORD`
- `BLUEBUBBLES_WEBHOOK_HOST`
- `BLUEBUBBLES_WEBHOOK_PORT`
- `BLUEBUBBLES_WEBHOOK_PATH`

Hermes setting names:

- `HERMES_WORKER_COMMAND`
- `HERMES_WORKER_PROFILE`
- `HERMES_WORKER_TIMEOUT_MS`

Windows AI worker setting name:

- `VILLAGE_AI_WORKER_CMD`

The lifecycle does not trust this environment value. `start-kakao-staging.ps1` computes `VILLAGE_AI_WORKER_CMD` from the validated `NodePath` and the reviewed `scripts/windows/windows-ai-worker.mjs` wrapper, then passes that exact command to validation and the bridge. The wrapper uses `process.execPath` with `shell: false`, inherits standard input/output/error, and always invokes the actual worker with `--stdin-job`.

Do not add sample values or live endpoints to migration notes. Validate only whether required names are set and rely on redacted validator output.

## No-send staging

Keep the scheduled tasks disabled. Run the staging sequence manually in this order:

1. Validate the configuration with `windows-runtime-config.mjs` and confirm its redacted result is valid.
2. Start the dedicated Windows Chrome profile. The lifecycle opens only the fixed `https://business.kakao.com/` origin; verify that tab and the local CDP endpoint.
3. Start the Windows-owned Kakao DOM bridge.
4. Optionally start the Windows-owned Hermes gateway. A normal bridge, gateway, restart, or watchdog start validates the existing `kakaoworker` profile but never imports or replaces its skill tree. The live profile owns its native Hermes learning. Use `sync-hermes-profile-overlay.ps1` only as an explicit migration/recovery command after a verified backup and conflict review.
5. Run `status-kakao-staging.ps1` and inspect its read-only process, ownership, port, profile, and required-setting-name results.

Safe staging must use a dedicated Supabase data plane. Both `SUPABASE_TABLE` and `SUPABASE_FOLLOW_UP_TABLE` must end in `_windows_staging`. The follow-up table is required even when Slack polling and card delivery are disabled because worker failure handling can write follow-up records. The Windows bridge must not share production queue tables while the Mac owns production. Production table names are accepted only during an approved cutover invocation that explicitly supplies `-EnableWrites`.

The validator-enforced no-send state must set `AI_WORKER_LIVE=0`, `AI_WORKER_AUTO_SEND=0`, `AI_WORKER_DRY_RUN=1`, `VILLAGE_WINDOWS_WRITES_ENABLED=0`, `SLACK_ACTION_POLL_ENABLED=0`, `SLACK_AGENT_CARD_DELIVERY_ENABLED=0`, `KAKAO_TAB_CLEANUP_ENABLED=1`, `KAKAO_WORKER_CONTROL_MODE=devtools_first`, `KAKAO_WORKER_SEARCH_TARGET_CHAT=1`, and `KAKAO_APPLESCRIPT_FALLBACK=0`. DevTools-first search is a read-only evidence-navigation capability, not send authorization; it lets Hermes find the complete customer conversation before deciding. The reviewed wrapper also supplies `--dry-run` and forces `AI_WORKER_DRY_RUN=1` unless the lifecycle-created marker is exactly `VILLAGE_WINDOWS_WRITES_ENABLED=1`; an environment file cannot create that marker in safe staging. Boolean values are normalized to `1` or `0`; any other value aborts validation. Do not pass the manual write-enablement switch during staging. Do not type, click Send, or trigger any external delivery while validating the UI.

The Windows Brain consumer is pinned to `VILLAGE_ROLE=mini`, `VILLAGE_DISABLE_MINI_PUSH=1`, and `VILLAGE_VAULT_ROOT=C:\Village\VILLAGE_Brain`. The lifecycle forces these values even when the environment file contains conflicting values, preventing the transferred mini-side renderer from entering the HQ push path.

Concurrent manual and scheduled starts are serialized by the named Windows lifecycle mutex `Local\Village.KakaoStaging.Start.v1`. A second start refuses immediately while the first holds the mutex, and the mutex remains held across configuration validation, ownership-record preflight, and stable process-record creation.

## Mac-retained services

The first cutover keeps BlueBubbles, Messages, and the watch voice relay on the Mac. Windows does not install, replace, stop, restart, or reconfigure those services. Their health is a cutover gate and a rollback invariant.

The Mac Kakao bridge, Kakao watchdog, and Slack backstop are separate migration-owned services. Change them only at the ordered cutover steps below, after no-send Windows verification passes.

## Cutover

Perform one step at a time and preserve the visible state after every step:

1. Complete Windows safe staging against the `_windows_staging` tables and every no-send verification gate below while the Mac still owns production. If any gate fails, stop without changing Mac ownership.
2. Stop Windows safe staging with `stop-kakao-staging.ps1`.
3. Confirm the stop succeeded, all ownership records are removed, status reports the components as `not_owned`, and there are zero descendant processes from the owned process trees.
4. Transfer production ownership only now: disable the Mac Kakao watchdog, disable the Mac Slack backstop, and stop the Mac Kakao bridge.
5. Start Windows manually with `start-kakao-staging.ps1 ... -EnableWrites` using only the approved production settings; keep both scheduled tasks disabled.
6. Verify ownership, queue behavior, and absence of duplicate delivery before approving another write path. Stop the owned runtime and repeat the explicit ownership-checked transition for each separately approved setting change.
7. Enable Kakao automatic sending last. It requires its own explicit approval after every earlier write path is stable.

Do not call `start-kakao-staging.ps1` while any ownership records exist; use the owned stop command and verify the process tree first. Never enable two new write paths in one step. Never infer approval from an environment file, a scheduled task definition, or a previously approved path.

## Verification

- Configuration validation succeeds and reveals no secret or endpoint values.
- Exactly one owner exists for each migrated worker; there are no duplicate workers on Mac and Windows.
- The dedicated Windows Chrome profile is the expected profile, CDP is reachable locally, and the required Kakao tab and watcher extension are present.
- The Windows bridge and optional Hermes gateway have matching PID, executable, and command-marker ownership records.
- Hermes skill discovery and `skill_view` resolve the canonical `village-brain-first`, `village-operations`, `village-confirm-request`, and profile-owned `rpa-automation-operations` skills directly from the active worker profile. The retired `village-runtime-router`, `*-windows` aliases, and obsolete `000-windows` tree must be absent. The local Brain renderer builds a non-empty leak-checked context without printing its contents.
- Read-only status reports the expected process state, required setting names, and local port reachability.
- Queue health is stable: no duplicate claims, unexplained backlog movement, or repeated follow-up actions.
- BlueBubbles relay health, Messages health, and watch voice relay health remain good on the Mac without a test send.
- No unexpected Kakao, Slack, iMessage, or SMS delivery occurred.

## Rollback

Rollback in this order:

1. Disable every Windows write path and confirm both Windows scheduled tasks are disabled.
2. Stop only Windows-owned gateway, bridge, and Chrome process trees with `stop-kakao-staging.ps1`. The script validates the recorded PID, executable, and command marker before using PID-scoped tree termination; abort the stop if ownership does not match. If a recorded PID is already absent, remove only that stale ownership record.
3. Confirm the stop command succeeded, status reports every component as `not_owned`, and there are zero descendant processes from each captured tree.
4. Do not restore the Mac Kakao bridge, Kakao watchdog, or Slack backstop until the Windows parent and child process verification is clean.
5. Restore the Mac Kakao bridge, then the Mac Kakao watchdog, then the Mac Slack backstop.
6. Verify Mac local ports, single-worker ownership, and queue health before closing the maintenance window.
7. Leave BlueBubbles and Messages untouched. The watch voice relay also remains on the Mac and is not part of the ownership rollback.

Keep Windows writes and scheduled tasks disabled after rollback. Preserve redacted status evidence and escalate before another cutover attempt.

## Abort criteria

Abort cutover and begin Rollback on any of these conditions:

- duplicate workers on Mac and Windows;
- missing or unreachable CDP;
- configuration validation failure;
- PID ownership mismatch;
- BlueBubbles relay failure;
- any unexpected external send.

Do not continue forward after an abort condition, even if a later check appears healthy.

## Production operation (post-cutover)

The rules above govern the migration window, where a scheduled task must never enable a write path because the Mac still owns production. Once cutover step 4 is complete and Windows is the **only** Kakao owner, permanently manual operation becomes its own failure mode: any reboot, crash, or logoff silently kills the pipeline until a human notices. Post-cutover, always-on operation is the supported posture:

1. Confirm cutover finished: Mac bridge/watchdog/backstop disabled, `status-kakao-staging.ps1` healthy after a manual `start-kakao-staging.ps1 ... -EnableWrites` run, no duplicate delivery.
2. Switch the environment file to production values: `SUPABASE_TABLE=ai_processing_events`, `SUPABASE_FOLLOW_UP_TABLE=ai_follow_up_items`, `AI_WORKER_LIVE=1`, `AI_WORKER_DRY_RUN=0`, `VILLAGE_WINDOWS_WRITES_ENABLED` is stamped by the lifecycle itself. Keep `AI_WORKER_AUTO_SEND=0` until automatic customer sending has its own approval (cutover step 7), then set it to `1`.
3. Register the enabled tasks: `register-kakao-production-tasks.ps1 -EnvFile ... -ChromePath ... -NodePath ... [-HermesPath ... -IncludeGateway] -ConfirmProductionOwnership`. This creates `Village-Kakao-Production-Start` (at logon, write-enabled) and `Village-Kakao-Production-Watchdog` (default every 5 minutes). The `-ConfirmProductionOwnership` switch is the recorded operator approval; the script refuses to run without it.
4. The watchdog is read-only while the runtime is healthy. When an owned component's record, process, or port is dead it runs the ownership-validated `stop-kakao-staging.ps1` and then `start-kakao-staging.ps1 -EnableWrites`. A live PID whose executable or command marker does not match the ownership record still aborts the automatic path and requires a human — the watchdog never terminates a process it cannot prove it owns. Its log is `%LOCALAPPDATA%\Village\kakao-staging\watchdog.log`.
5. The disabled staging tasks may remain registered for later isolated testing; they never start anything on their own.

Model changes (root gateway or `kakaoworker` profile) are made only through `scripts/windows/hermes-model-contract.json`, then `configure-hermes-village-routing.py --config %LOCALAPPDATA%\hermes\config.yaml`, then updating the worker profile `config.yaml` to the same contract values, then a runtime restart. The provider and model are written together from the contract, so a provider switch can never leave a mixed provider/model state.
