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

console.log('slack-heybilli direct-sync static checks passed');
