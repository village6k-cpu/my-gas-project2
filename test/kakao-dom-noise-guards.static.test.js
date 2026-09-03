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
  /topRowBadge = \/\^중요\\s\+/,
  'Kakao watcher must infer unread badges only from the Kakao top-row badge shape'
);

assert.match(
  content,
  /\.ReactVirtualized__List\.list_board > \.ReactVirtualized__Grid__innerScrollContainer > li/,
  'Kakao watcher must anchor discovery to real virtualized chat-list rows'
);

assert.doesNotMatch(
  content,
  /const structuralRow = el\.closest\('[^']*\[role="row"\]/,
  'Kakao watcher must not mistake the whole virtualized row container for one customer chat'
);

assert.match(
  content,
  /input\[id\^="chat-select-"\]/,
  'Kakao watcher must use the stable chat id exposed by the real list row'
);

assert.match(
  content,
  /customerName,/,
  'Kakao watcher must pass structured customer identity to Hermes'
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

assert.doesNotMatch(
  bridge,
  /event\.raw\?\.unreadSignal === true \|\| event\.unreadSignal === true/,
  'Bridge must not promote broad Badge-only unread signals without a visible unread count'
);

assert.match(
  bridge,
  /event\.unreadCount \?\? event\.unread_count \?\? event\.raw\?\.unreadCount \?\? event\.raw\?\.unread_count/,
  'Bridge must trust structured unreadCount fields supplied by the watcher'
);

assert.match(
  bridge,
  /function inferKakaoUnreadCountFromPreview\(text = ''\)/,
  'Bridge must recover missing Kakao unread counts from the conservative top-row badge shape'
);

assert.match(
  bridge,
  /count > 20/,
  'Bridge must not treat arbitrary large numbers in previews as unread badges'
);

assert.match(
  bridge,
  /if \(event\.reason === 'top_rows_backstop'\) return false;/,
  'Bridge must not queue a generic read backstop row without a visible unread count'
);

assert.match(
  bridge,
  /return event\.reason === 'top_row_changed'\s*&& isLiveTopRowPreview\(event\.previewText\);/,
  'Bridge may queue only a genuinely live top-row change when an unread count is absent'
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
  /duplicate_supabase_job_waiting_for_recovery_sweeper/,
  'Bridge must not requeue fresh duplicate ready jobs on every DOM scan; recovery sweeper owns them'
);

assert.match(
  bridge,
  /rowAgeMs\(existing, \['updated_at', 'created_at'\]\) > Math\.max\(CONFIG\.workerTimeoutMs \* 2, 10 \* 60_000\)/,
  'Bridge must only replay duplicate ready/pending jobs after a stale-age threshold'
);

assert.match(
  bridge,
  /status === 'ai_worker_error'/,
  'Bridge must still retry duplicate worker errors through bounded retry logic'
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
  /activeWorkerJobIds: new Set\(\)/,
  'Bridge must track active local worker job ids'
);

assert.match(
  bridge,
  /local_duplicate_job_active/,
  'Bridge must not enqueue the same stable job id while it is already running or queued locally'
);

assert.match(
  bridge,
  /await updateSupabaseEventByHash\(job\.jobId, buildWorkerResultPatch\(job, workerResult\)\)/,
  'Bridge must mark local worker results as handled in Supabase'
);

assert.match(
  bridge,
  /const WORKER_STDOUT_LIMIT = 2_000_000;/,
  'Bridge must not truncate large AI worker JSON stdout before parsing it'
);

assert.match(
  bridge,
  /stdout = appendLimited\(stdout, chunk, WORKER_STDOUT_LIMIT\)/,
  'Bridge worker stdout capture must use the large JSON-safe limit'
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
  'Bridge must expose the semantic prefilter boundary explicitly'
);

assert.doesNotMatch(
  bridge,
  /function isThanksOnlyTerminalPreview\(text\)/,
  'Bridge must not replace Hermes judgment with a thanks-only text heuristic'
);

assert.match(
  bridge,
  /void event;\s*return '';/,
  'Every structurally valid message preview must reach Hermes for semantic judgment'
);

assert.doesNotMatch(
  bridge,
  /네\|넵\|네네\|넵넵[\s\S]*변경해\\s\*드리겠습니다/,
  'Bridge must not classify staff/customer intent from preview keywords before Hermes opens the room'
);

assert.doesNotMatch(
  bridge,
  /non_actionable_failure_preview/,
  'Bridge must not suppress a failed AI read based on preview semantics'
);

assert.match(
  bridge,
  /function roomKeyForDebounce\(event = \{\}\)/,
  'Bridge must preserve stable Kakao chat identity through debounce grouping'
);

assert.match(
  bridge,
  /const queuedWorkerSlotsByRoom = new Map\(\)/,
  'Bridge must coalesce queued reads for the same room instead of starving Hermes with duplicates'
);

assert.match(
  bridge,
  /superseded_by_newer_room_event/,
  'Bridge must audit same-room jobs superseded by a newer full-room AI read'
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
  'Bridge may keep an explicit catch-up helper, but stale read top-row changes must not enter the live worker path'
);

assert.match(
  bridge,
  /event\.reason === 'top_row_changed'\s+&& isLiveTopRowPreview\(event\.previewText\)/,
  'Bridge must only queue unread-free top-row changes inside the short live window'
);

assert.doesNotMatch(
  bridge,
  /event\.reason === 'top_row_changed'\s+&& \(isLiveTopRowPreview\(event\.previewText\) \|\| isRecentReadCatchupPreview\(event\.previewText\)\)/,
  'Bridge must not reopen hours-old read rows through the catch-up window'
);

assert.match(
  bridge,
  /if \(event\.reason === 'top_rows_backstop'\) return false;/,
  'Bridge must not let read-only periodic backstop rows flood the AI worker queue'
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

// Hermes 결정 타임아웃은 바깥 브리지 수명(WORKER_TIMEOUT_MS)을 상속하면 안 된다.
// 상속하던 시절 Hermes 결정 1건이 직렬 카카오 워커를 6분 넘게 독점했다.
// 동작 검증은 tools/ai-browser-worker/worker.test.mjs가 담당하고,
// 여기서는 상속이 되살아나지 않는지만 못 박는다.
assert.match(
  worker,
  /export function hermesDecisionTimeoutFromEnv\(environment = process\.env\)/,
  'Hermes timeout must stay an isolated, unit-testable resolver'
);
assert.match(
  worker,
  /hermesTimeoutMs: hermesDecisionTimeoutFromEnv\(process\.env\)/,
  'AI worker must resolve its Hermes timeout through that resolver'
);
{
  const from = worker.indexOf('export function hermesDecisionTimeoutFromEnv');
  const to = worker.indexOf('function requireConfig()', from);
  assert.ok(from >= 0 && to > from, 'Hermes timeout resolver body must be locatable');
  assert.doesNotMatch(
    worker.slice(from, to),
    /(?<!HERMES_)WORKER_TIMEOUT_MS/,
    'Hermes timeout resolver must never read the outer bridge WORKER_TIMEOUT_MS'
  );
}

// 진짜 지켜야 할 불변식: 런처가 주는 Hermes 타임아웃이 바깥 브리지 타임아웃보다 짧아야
// 결정 1건이 직렬 워커를 독점하지 못한다. 두 값이 역전되면 그 사고가 그대로 재현된다.
{
  const contract = read('scripts/windows/KakaoLive.Common.psm1');
  const numberOf = (key) => {
    const hit = contract.match(new RegExp(`${key}\\s*=\\s*'(\\d+)'`));
    assert.ok(hit, `launcher contract must define ${key}`);
    return Number(hit[1]);
  };
  assert.ok(
    numberOf('HERMES_WORKER_TIMEOUT_MS') < numberOf('WORKER_TIMEOUT_MS'),
    'HERMES_WORKER_TIMEOUT_MS must stay below WORKER_TIMEOUT_MS so one Hermes decision cannot monopolize the serial Kakao worker'
  );
}

// 정규식 리터럴을 그대로 문자열 대조하면 사소한 수정(끝 슬래시 허용 등)마다 깨지면서
// 정작 보호가 살아 있는지는 알려주지 않는다. 코드에서 정규식을 꺼내 실제 URL로 검증한다.
{
  const hit = worker.match(/const isChatListUrl = (\/\^https:[^\n]+?\/)\.test\(targetUrl\);/);
  assert.ok(hit, 'AI worker must keep an explicit chat-list URL matcher for DevTools tab targeting');
  const source = hit[1].replace(/^\//, '').replace(/\/$/, '');
  const isChatListUrl = new RegExp(source);
  for (const host of ['business', 'center-pf']) {
    assert.ok(isChatListUrl.test(`https://${host}.kakao.com/_xhPMls/chats`), `${host} chat list must match`);
    assert.ok(isChatListUrl.test(`https://${host}.kakao.com/_xhPMls/chats?t_src=x`), `${host} chat list with query must match`);
    assert.ok(
      isChatListUrl.test(`https://${host}.kakao.com/space/353491/channel/_xhPMls/chats`),
      `${host} current space channel chat list must match`
    );
    assert.ok(
      !isChatListUrl.test(`https://${host}.kakao.com/_xhPMls/chats/123456`),
      'AI worker DevTools tab targeting must not treat individual customer conversation URLs as the main chat list'
    );
  }
  assert.ok(!isChatListUrl.test('https://example.com/_xhPMls/chats'), 'unrelated hosts must not match');
}

assert.match(
  content,
  /space\\\/\[\^\/\]\+\\\/channel/,
  'Watcher page guards must accept the current Kakao space channel route'
);

assert.match(
  bridge,
  /space\\\/\[\^\/\]\+\\\/channel/,
  'Bridge DevTools targeting must accept the current Kakao space channel route'
);

assert.match(
  automation,
  /space\\\/\[\^\/\]\+\\\/channel/,
  'Kakao automation tab cleanup must preserve the current main list route'
);

assert.ok(
  !automation.includes('kakao\\.com\\/_[^/]+\\/chats'),
  'Every Kakao automation readiness matcher must accept the current space channel route'
);

assert.match(
  worker,
  /tabUrl contains "\/chats\/"/,
  'AI worker AppleScript fallback must not focus individual customer conversation tabs as the main chat list'
);

assert.match(
  content,
  /topRowsBackstopIntervalMs: 60000/,
  'Watcher must periodically re-check visible rows for explicit unread signals'
);

assert.match(
  content,
  /signature === STATE\.lastTopRowsSignature && !backstopDue/,
  'Watcher must not skip the explicit-unread backstop just because the visible chat list is unchanged'
);

assert.match(
  content,
  /const unreadBackstop = currentRows\.filter\(\(row\) => hasUnreadSignal\(row\.row, row\.text\)\);/,
  'Watcher backstop must retain only rows with an explicit unread signal'
);

assert.match(
  content,
  /const readBackstop = \[\];/,
  'Watcher must not periodically re-post every read row as a new customer event'
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
  automation.includes('isMainChatList = /^https:\\/\\/(business|center-pf)\\.kakao\\.com(?:\\/space') &&
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
  /function cleanupIdleKakaoConversationTabs\(reason = 'interval', \{ allowQueued = false \} = \{\}\)/,
  'Bridge must clean up individual Kakao conversation tabs when the worker is idle'
);

assert.match(
  bridge,
  /cleanupIdleKakaoConversationTabs\('worker_finished', \{ allowQueued: true \}\)/,
  'Bridge must close worker-opened conversation tabs even when another AI read is queued'
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
