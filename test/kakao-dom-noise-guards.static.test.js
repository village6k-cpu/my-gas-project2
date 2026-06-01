const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const content = read('tools/kakao-dom-watcher-extension/content.js');
const bridge = read('tools/kakao-dom-bridge/server.mjs');
const worker = read('tools/ai-browser-worker/worker.mjs');
const automation = read('scripts/kakao-automation');

assert.match(
  content,
  /function canonicalTopRowText\(text\)/,
  'Kakao watcher must canonicalize top-row text before comparing rows'
);

assert.doesNotMatch(
  content,
  /\\b\(\[1-9\]\[0-9\]\?\)\\b\/g/,
  'Kakao watcher must not treat arbitrary row numbers, dates, or minutes as unread counts'
);

assert.match(
  content,
  /unreadSignal/,
  'Kakao watcher must send an explicit unread signal instead of relying on arbitrary numeric text'
);

assert.match(
  content,
  /const structuralRow = el\.closest\('\[role="listitem"\], \[role="row"\], li'\)/,
  'Kakao watcher must prefer whole chat row containers over nested message text fragments'
);

assert.match(
  content,
  /const seenRows = new Set\(\);/,
  'Kakao watcher must dedupe nested DOM fragments that resolve to the same chat row'
);

assert.match(
  content,
  /return rows\.map\(\(row\) => row\.signature\)\.join\('\|'\);/,
  'Top-row polling must not treat coordinate-only movement as a row change'
);

assert.doesNotMatch(
  content,
  /previousBySlot/,
  'Top-row polling must not key row changes by unstable DOM slot or coordinates'
);

assert.doesNotMatch(
  content,
  /currentRows\[0\] \? \[currentRows\[0\]\]/,
  'Top-row polling must not turn harmless row reorders into synthetic changes'
);

assert.match(
  content,
  /kakao-chat-toprow:\$\{roomKey\}:\$\{topRowText\}:\$\{reason\}/,
  'Top-row event hashes must be stable across URL and coordinate changes'
);

assert.match(
  bridge,
  /function isLiveTopRowPreview\(text, now = new Date\(\)\)/,
  'Bridge must distinguish live chat-list changes from dated backstop rows'
);

assert.match(
  bridge,
  /topRowLiveWindowMinutes: Number\(process\.env\.TOP_ROW_LIVE_WINDOW_MINUTES \|\| 20\)/,
  'Bridge must bound live top-row changes to a short recency window'
);

assert.match(
  bridge,
  /readBackstopLookbackHours: Number\(process\.env\.READ_BACKSTOP_LOOKBACK_HOURS \|\| 36\)/,
  'Bridge must keep a bounded catch-up window for read chat-list rows'
);

assert.match(
  bridge,
  /readBackstopLookbackDays: Number\(process\.env\.READ_BACKSTOP_LOOKBACK_DAYS \|\| 2\)/,
  'Bridge must catch up recent dated previews without reopening week-old rows'
);

assert.match(
  bridge,
  /ageMinutes <= CONFIG\.topRowLiveWindowMinutes/,
  'Bridge must use recency only for read top-row changes'
);

assert.match(
  bridge,
  /function hasUnreadCount\(event = \{\}\)/,
  'Bridge must detect unread rows explicitly'
);

assert.match(
  bridge,
  /event\.raw\?\.unreadSignal === true \|\| event\.unreadSignal === true/,
  'Bridge must prefer explicit unread signals over parsed date or time numbers'
);

assert.match(
  bridge,
  /event\.unreadCount \?\? event\.unread_count \?\? event\.raw\?\.unreadCount \?\? event\.raw\?\.unread_count/,
  'Bridge must trust structured unreadCount fields supplied by the watcher'
);

assert.match(
  bridge,
  /event\.reason === 'top_rows_backstop' \|\| event\.reason === 'top_row_changed'\) return true;/,
  'Bridge must queue unread top-row/backstop events even when unreadSignal is absent'
);

assert.match(
  bridge,
  /function isStaleDatedMutation\(event = \{\}\)/,
  'Bridge must detect dated mutation rows that are reload/backlog noise rather than live inquiries'
);

assert.match(
  bridge,
  /ignored: 'stale_dated_mutation'/,
  'Bridge must keep day-old mutation rows out of the AI worker queue'
);

assert.match(
  bridge,
  /unreadCounts\.length \? Math\.max\(\.\.\.unreadCounts\) : null/,
  'Bridge jobs must preserve structured unread counts even when the latest grouped event has null unreadCount'
);

assert.match(
  bridge,
  /function buildStableJobId\(roomKey, events = \[\]\)/,
  'Bridge must use stable job ids for repeated identical Kakao event groups'
);

assert.doesNotMatch(
  bridge,
  /sha256\(`\$\{roomKey\}:\$\{roomState\.firstAt\}:\$\{roomState\.lastAt\}`\)/,
  'Bridge job ids must not include debounce timestamps that turn duplicates into new jobs'
);

assert.match(
  bridge,
  /function shouldRunDuplicateJob\(existing = \{\}\)/,
  'Bridge must inspect duplicate Supabase job state before deciding whether to replay or skip'
);

assert.match(
  bridge,
  /\['ready_for_ai_worker', 'ai_worker_error', 'ai_decision_ready_no_sheet_write', 'pending_ai_review'\]\.includes\(status\)/,
  'Bridge must replay duplicate jobs that are still unprocessed or previously failed'
);

assert.match(
  bridge,
  /status === 'processing_by_ai_worker'\) return isDuplicateProcessingStale\(existing\)/,
  'Bridge must replay stale processing jobs after a bridge or worker restart'
);

assert.match(
  bridge,
  /reason: 'duplicate_supabase_job_requeued'/,
  'Bridge must record when a duplicate Supabase job is requeued for durable recovery'
);

assert.match(
  bridge,
  /function updateSupabaseEventByHash\(eventHash, patch\)/,
  'Bridge must update Supabase job status after local worker execution'
);

assert.match(
  bridge,
  /await updateSupabaseEventByHash\(job\.jobId, buildWorkerResultPatch\(job, workerResult\)\)/,
  'Bridge must mark local worker results as handled in Supabase'
);

assert.match(
  bridge,
  /function isActionChromePreview\(text\)/,
  'Bridge must filter Kakao UI/action chrome rows before queueing AI jobs'
);

assert.match(
  bridge,
  /ignored: 'action_chrome'/,
  'Bridge must report ignored Kakao action chrome rows'
);

assert.match(
  bridge,
  /function shouldSkipWorkerForPreview\(event = \{\}\)/,
  'Bridge must keep obvious staff/outbound and terminal thanks rows out of the worker queue'
);

assert.match(
  bridge,
  /function isThanksOnlyTerminalPreview\(text\)/,
  'Bridge must skip thanks-only unread rows without spending a live AI worker run'
);

assert.match(
  bridge,
  /ignored-low-value-events\.ndjson/,
  'Bridge must record low-value ignored rows for auditability'
);

assert.match(
  bridge,
  /non_actionable_failure_preview/,
  'Bridge must not create urgent failure cards for non-actionable timeout previews'
);

assert.match(
  bridge,
  /function shouldSkipSupabaseRowAsLowValue\(row = \{\}\)/,
  'Supabase recovery must not keep replaying low-value ready rows'
);

assert.match(
  bridge,
  /function hasDatedPreview\(text\)/,
  'Bridge must detect Kakao display dates without treating rental dates inside the message as stale'
);

assert.match(
  bridge,
  /function isRecentReadCatchupPreview\(text, now = new Date\(\)\)/,
  'Bridge must have an explicit bounded path for chats the user read before automation saw the unread badge'
);

assert.match(
  bridge,
  /isLiveTopRowPreview\(event\.previewText\) \|\| isRecentReadCatchupPreview\(event\.previewText\)/,
  'Bridge must queue recent read top-row changes so manually-read chats are still inspected by AI'
);

assert.match(
  bridge,
  /\(event\.reason === 'top_row_changed' \|\| event\.reason === 'top_rows_backstop'\)/,
  'Bridge must allow periodic read backstop rows through the same bounded recency gate'
);

assert.match(
  bridge,
  /hasUnreadCount\(event\)\) return !hasDatedPreview\(event\.previewText\) \|\| isRecentDatedPreview\(event\.previewText\)/,
  'Bridge must allow unread rows with recent Kakao display dates while still blocking old dated rows'
);

assert.match(
  bridge,
  /&& !isRecentDatedPreview\(event\.previewText\)/,
  'Bridge stale mutation guard must not discard recent dated previews'
);

assert.match(
  bridge,
  /matches\[matches\.length - 1\]/,
  'Bridge must use the last visible Kakao clock in a preview, not rental times inside the message'
);

assert.match(
  bridge,
  /if \(diff < -1\) diff \+= 1440;/,
  'Bridge must treat previous-evening clock previews as recent overnight catch-up rows'
);

assert.match(
  worker,
  /HERMES_WORKER_TIMEOUT_MS \|\| process\.env\.WORKER_TIMEOUT_MS \|\| '240000'/,
  'AI worker Hermes timeout must inherit the launcher worker timeout'
);

assert.match(
  worker,
  /\^https:\\\/\\\/\(business\|center-pf\)\\\.kakao\\\.com\\\/_\[\^\/\]\+\\\/chats\(\?:\[\?#\]\|\$\)/,
  'AI worker DevTools tab targeting must not treat individual customer conversation URLs as the main chat list'
);

assert.match(
  worker,
  /tabUrl contains "\/chats\/"/,
  'AI worker AppleScript fallback must not focus individual customer conversation tabs as the main chat list'
);

assert.match(
  content,
  /topRowsBackstopIntervalMs: 60000/,
  'Watcher must periodically re-emit visible recent rows so manually-read stable chats are inspected'
);

assert.match(
  content,
  /signature === STATE\.lastTopRowsSignature && !backstopDue/,
  'Watcher must not skip the periodic backstop just because the visible chat list is unchanged'
);

assert.match(
  content,
  /const readBackstop = backstopDue \? currentRows : \[\];/,
  'Watcher must include read visible rows in bounded periodic catch-up scans'
);

assert.match(
  content,
  /async function runDeepBackstopSweep\(reason = 'deep_backstop'\)/,
  'Watcher must periodically scroll the main chat list to catch manually-read rows below the visible viewport'
);

assert.match(
  content,
  /deepBackstopMaxRows: 80/,
  'Deep backstop must be bounded so it does not scan weeks of old chats'
);

assert.match(
  content,
  /scroller\.scrollTop = originalTop;/,
  'Deep backstop must restore the chat list scroll position after scanning'
);

assert.ok(
  automation.includes('isMainChatList = /^https:\\/\\/(business|center-pf)\\.kakao\\.com\\/_') &&
    automation.includes('\\/chats(?:[?#]|$)/.test(url)'),
  'Automation launcher must close individual Kakao conversation tabs and keep only the main chat list'
);

assert.match(
  bridge,
  /function runSupabaseRecoverySweep\(reason = 'interval'\)/,
  'Bridge must periodically replay durable Supabase ready/error jobs instead of relying only on in-memory queue state'
);

assert.match(
  bridge,
  /createWorkerFailureFollowUp\(job, error/,
  'Bridge must create a follow-up card when the AI worker fails or times out'
);

assert.match(
  bridge,
  /function cleanupIdleKakaoConversationTabs\(reason = 'interval'\)/,
  'Bridge must clean up individual Kakao conversation tabs when the worker is idle'
);

assert.match(
  bridge,
  /\(event\.reason === 'top_rows_backstop' \|\| event\.reason === 'top_row_changed'\) && !shouldQueueTopRowEvent\(event\)/,
  'Bridge must keep only read stale top-row changes out of the AI worker queue'
);

assert.match(
  bridge,
  /'read_backstop_row' : 'non_live_top_row_change'/,
  'Bridge must explain whether it ignored a read backstop row or a stale read change'
);

console.log('kakao dom noise guard static checks passed');
