const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

const checkAvailability = read('checkAvailability.js');
const code = read('Code.js');

assert.match(
  checkAvailability,
  /status\s*===\s*['"]취소['"][\s\S]{0,800}cancelContract\(ss,\s*tradeId,\s*row\)/,
  'updateDashboardContractStatus must route 취소 through cancelContract()'
);

assert.match(
  checkAvailability,
  /deleteProperty\(['"]returnDone_['"]\s*\+\s*tradeId\)[\s\S]{0,160}deleteProperty\(['"]returnPrevContractStatus_['"]\s*\+\s*tradeId\)/,
  '취소 status update should clear return-complete script state'
);

const manualStatusEditBody = code.slice(
  code.indexOf('function handleContractMasterStatusEdit_'),
  code.indexOf('\nfunction ', code.indexOf('function handleContractMasterStatusEdit_') + 20),
);
assert.match(
  manualStatusEditBody,
  /status\s*===\s*['"]취소['"][\s\S]*isDashboardTradeCheckoutStarted_\(ss,\s*tradeId\)[\s\S]*if \(checkoutStarted\)[\s\S]*return;/,
  'manual 계약마스터 J열 취소 edits must reject cancellation once checkout has started',
);
assert.match(
  manualStatusEditBody,
  /deleteProperty\(['"]returnDone_['"]\s*\+\s*tradeId\)[\s\S]*deleteProperty\(['"]returnPrevContractStatus_['"]\s*\+\s*tradeId\)[\s\S]*cancelContract\(ss,\s*tradeId,\s*row\)[\s\S]*ensureCancelledTradeCleanupTrigger_\(1000\)/,
  'allowed manual cancellations must clear return state, commit local cancellation, and wake durable cleanup',
);

const cancelBody = code.slice(
  code.indexOf('function cancelContract'),
  code.indexOf('function setupInstallableTrigger'),
);
assert.match(
  cancelBody,
  /scheduleCancelledTradeCleanup_\(거래ID\)/,
  'cancelContract should queue external cleanup after applying local sheet changes',
);
assert.doesNotMatch(
  cancelBody,
  /supaCancelTrade_|SpreadsheetApp\.openByUrl|DriveApp\.|trashCancelledContractFiles_/,
  'cancelContract must not hold the caller ScriptLock across Supabase, external ledger, or Drive I/O',
);

const cleanupIo = code.slice(
  code.indexOf('function runCancelledTradeCleanupOutsideLock_'),
  code.indexOf('function finishCancelledTradeCleanup_'),
);
assert.match(cleanupIo, /supaCancelTrade_\(거래ID\)/, 'outside-lock worker must cancel Supabase occupancy');
assert.match(cleanupIo, /deleteCancelledTradeFromExternalLedger_\(거래ID\)/, 'outside-lock worker must clean external ledger');
assert.match(cleanupIo, /trashCancelledContractFiles_\(거래ID\)/, 'outside-lock worker must trash contract files');
assert.doesNotMatch(cleanupIo, /LockService\.getScriptLock/, 'external cleanup steps must not acquire the global lock');
assert.match(
  code,
  /CANCEL_CLEANUP_MAX_ATTEMPTS_\s*=\s*5[\s\S]*Math\.min\(5 \* 60 \* 1000, 15000 \* Math\.pow/,
  'external cleanup queue needs bounded exponential retry',
);
const cancelTriggerBody = code.slice(
  code.indexOf('function scheduleCancelledTradeCleanupTriggerOutsideLock_'),
  code.indexOf('\nfunction ensureCancelledTradeCleanupTrigger_', code.indexOf('function scheduleCancelledTradeCleanupTriggerOutsideLock_')),
);
assert.match(cancelTriggerBody, /currentAt > Date\.now\(\) && currentAt <= desiredAt \+ 1000/);
// 트리거 교체는 공용 프리미티브(replaceOneShotTrigger_)가 담당한다. 그 안에서
// "1개 남긴 채 create → 성공 뒤 잔여 삭제" 순서를 지키므로 실행 경로가 0개가 되지 않고,
// 동시에 개수가 1로 수렴해 20개 쿼터를 먹지 않는다.
// 순서 불변식 자체는 test/one-shot-trigger-quota.behavior.test.js가 행위로 검증한다.
assert.ok(
  cancelTriggerBody.includes("replaceOneShotTrigger_(CANCEL_CLEANUP_HANDLER_"),
  'cancel cleanup must schedule through the bounded one-shot trigger primitive',
);
assert.match(
  code,
  /CANCEL_CLEANUP_HANDLER_\s*=\s*['"]processCancelledTradeCleanup['"][\s\S]*function processCancelledTradeCleanup\(\)/,
  'the queued cleanup must use a public GAS time-trigger handler',
);

['dashboard.html'].forEach((file) => {
  const html = read(file);

  assert.match(
    html,
    /cardActionHtml\(item,\s*cardType\)/,
    `${file} must pass cardType into cardActionHtml`
  );

  assert.match(
    html,
    /function cardActionHtml\(item,\s*cardType\)/,
    `${file} cardActionHtml must accept cardType`
  );

  assert.match(
    html,
    /cardType\s*===\s*['"]checkin['"][\s\S]{0,600}cancelDashboardTrade/,
    `${file} must render the cancel action for return/checkin cards`
  );

  assert.match(
    html,
    /function cancelDashboardTrade\(btn,\s*tid,\s*name\)/,
    `${file} must implement cancelDashboardTrade`
  );

  assert.match(
    html,
    /action:\s*['"]updateContractStatus['"][\s\S]{0,220}status:\s*['"]취소['"]/,
    `${file} cancel action must call updateContractStatus with 취소`
  );

  assert.match(
    html,
    /cancelDashboardTrade[\s\S]{0,1200}loadData\(true\)/,
    `${file} must refresh the dashboard after a successful cancel`
  );
});

console.log('dashboard cancel static checks passed');
