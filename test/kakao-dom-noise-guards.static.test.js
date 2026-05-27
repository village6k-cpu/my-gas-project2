const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const content = read('tools/kakao-dom-watcher-extension/content.js');
const bridge = read('tools/kakao-dom-bridge/server.mjs');

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
  /function hasDatedPreview\(text\)/,
  'Bridge must detect day-old and week-old chat-list previews'
);

assert.match(
  bridge,
  /if \(hasUnreadCount\(event\)\) return !hasDatedPreview\(event\.previewText\) && !isActionChromePreview\(event\.previewText\);/,
  'Bridge must queue unread rows only when Kakao still shows a same-day relative or clock preview'
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
