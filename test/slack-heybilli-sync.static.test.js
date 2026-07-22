const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const route = read('apps/today-dashboard/app/api/internal/slack-ops/route.ts');
const server = read('apps/today-dashboard/lib/server/slackOps.ts');
const migration = read('apps/today-dashboard/supabase/slack-ops-sync.sql');
const remote = read('apps/today-dashboard/lib/data/remote.ts');
const gas = read('checkAvailability.js');
const sheetApi = read('sheetAPI.js');
const windowsRunner = read('tools/slack-heybilli-sync/hermes-cron-runner.py');
const windowsInstaller = read('tools/slack-heybilli-sync/install-ax2.ps1');
const syncSkill = read('tools/slack-heybilli-sync/SKILL.md');

assert(!server.includes('ai_follow_up_items'), 'Slack ops sync must never write the Kakao follow-up board');
assert(route.includes('timingSafeEqual') && route.includes('SLACK_OPS_SYNC_SECRET || process.env.SLACK_BOT_TOKEN'), 'internal API must fail closed behind a timing-safe shared secret');
assert(server.includes('dryRun: true') && server.includes('if (!execute) return'), 'live mutations must be preceded by a dry-run path');
assert(server.includes('assertUniqueTopCandidate') && server.includes('topCount !== 1'), 'live plans must target the unique top transaction candidate');
assert(server.includes('previous?.applied_at ?? null') && server.includes('previous?.last_error ?? null'), 'routine scans must preserve reconciliation audit timestamps and reasons');
assert(server.includes('actual_name') && server.includes('actual_taken_qty') && server.includes('actual_source'), 'confirmed Slack corrections must use an audited overlay instead of rewriting baseline identity');
assert(remote.includes('delete row.actual_name') && remote.includes('delete row.actual_taken_qty'), 'stale browsers must not erase server-owned correction overlays');
assert(migration.includes('revoke all on village.slack_ops_events from anon, authenticated'), 'internal sync ledger must not become another employee-visible board');
assert(gas.includes('slackOpsOnsiteIdempotency_v1') && gas.includes('duplicate: true'), 'GAS onsite additions must be idempotent across retries');
assert(sheetApi.includes('idempotencyKey:'), 'sheet API must forward the onsite idempotency key');
assert(windowsRunner.includes('os.environ["AI_WORKER_LIVE"] = "0"') && windowsRunner.includes('os.environ["AI_WORKER_AUTO_SEND"] = "0"'), 'AX2 cron must keep the general AI worker switches fail-closed');
assert(windowsRunner.includes('from hermes_cli.oneshot import run_oneshot'), 'Windows cron must avoid the Windows command-line prompt length limit');
assert(windowsInstaller.includes("$env:COMPUTERNAME -ne 'AX2'"), 'the Windows installer must fail closed off AX2');
assert(windowsInstaller.includes("SLACK_HEYBILLI_WRITE_ENABLED' $(if ($Mode -eq 'Live')"), 'the Windows installer must make dry-run/live state explicit');
assert(syncSkill.includes('후속조치 보드와 무관') && !syncSkill.includes('ai_follow_up_items'), 'the deployed AX2 skill must keep Slack reconciliation out of the Kakao follow-up board');

console.log('slack-heybilli direct-sync static checks passed');
