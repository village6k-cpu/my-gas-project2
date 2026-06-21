const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const watchdog = fs.readFileSync('/Users/village6k/.hermes/scripts/village_kakao_dom_watchdog.py', 'utf8');
const envFile = fs.readFileSync(path.join(root, 'tools/kakao-dom-bridge/.env'), 'utf8');
const automation = fs.readFileSync(path.join(root, 'scripts/kakao-automation'), 'utf8');

assert.match(
  watchdog,
  /USES_NORMAL_CHROME_PROFILE and APPLESCRIPT_FALLBACK_ENABLED/,
  'Watchdog must not treat DevTools-unreachable as unhealthy in supported normal-profile CUA mode'
);

assert.match(
  watchdog,
  /VILLAGE_KAKAO_JOBS_NO_RESULTS_GRACE_MINUTES/,
  'Watchdog must give fresh worker jobs a grace window before declaring jobs-no-results'
);

assert.match(
  watchdog,
  /worker_still_within_budget = worker_running and worker_run_ms < 10 \* 60 \* 1000/,
  'Watchdog must not restart the bridge while a current worker is still within the normal run budget'
);

assert.match(
  watchdog,
  /oldestAgeSeconds/,
  'Watchdog jobs-no-results alerts must include age evidence and only fire for stale jobs'
);

assert.match(
  watchdog,
  /VILLAGE_KAKAO_EVENTS_NO_JOBS_GRACE_MINUTES/,
  'Watchdog must wait past the debounce window before events-no-jobs recovery'
);

assert.match(
  envFile,
  /^SUPABASE_RECOVERY_ENABLED=true$/m,
  'Kakao bridge must keep durable Supabase ready/error recovery enabled'
);

assert.match(
  automation,
  /<key>KeepAlive<\/key>\s*\n\s*<true\/>/,
  'Kakao bridge LaunchAgent must be generated with KeepAlive to survive crashes'
);
