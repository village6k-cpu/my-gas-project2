const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const backend = read('checkAvailability.js');
const api = read('sheetAPI.js');

assert(
  /function registerByReqID\(sheet, triggerRow, options\)/.test(backend),
  'registerByReqID must accept explicit registration options'
);
assert(
  /options\s*=\s*options\s*\|\|\s*\{\}/.test(backend) &&
    /suppressCustomerSend/.test(backend),
  'registration options must include the explicit customer-send suppression path'
);
assert(
  /if \(!regLock\.tryLock\(30000\)\) \{[\s\S]{0,260}options\.suppressCustomerSend[\s\S]{0,180}throw new Error/.test(backend),
  'no-send registration must fail closed instead of entering the normal delayed queue'
);
assert(
  /if \(!options\.suppressCustomerSend\) \{[\s\S]{0,260}_postRegisterAlimtalk\s*=/.test(backend),
  'no-send registration must not construct a customer Alimtalk payload'
);

assert(
  /function cloneRegisteredScheduleNoSend\(args\)/.test(backend),
  'backend must expose a bounded no-send schedule clone operation'
);
assert(
  /function buildScheduleCloneSourceFingerprint_\(/.test(backend) &&
    /expectedSourceFingerprint/.test(backend),
  'clone must fingerprint the authoritative source and require the expected fingerprint before mutation'
);
assert(
  /dryRun/.test(backend) &&
    /targetDuplicateTradeId/.test(backend) &&
    /targetConflictTradeId/.test(backend),
  'clone must support dry-run, exact duplicate detection, and near-target conflict detection'
);
assert(
  /var registrationOptions\s*=\s*\{ suppressCustomerSend: true, forbidMerge: true \}/.test(backend) &&
    /registerByReqID\(confirmSheet, triggerRow, registrationOptions\)/.test(backend) &&
    /options\.forbidMerge && mergeMode/.test(backend),
  'clone must use no-send registration and fail closed instead of merging into an existing trade'
);
assert(
  /function replaceClonedScheduleRowsExactly_\(/.test(backend) &&
    /function buildScheduleCloneComparableSignature_\(/.test(backend),
  'clone must replace and compare every schedule-detail row, not only top-level request items'
);
assert(
  /targetRowCount:\s*targetRowsAfter\.length/.test(backend),
  'clone response must report the actual verified target row count'
);
assert(
  /ownsCreatedRequest/.test(backend) &&
    /if \(ownsCreatedRequest && createdReqID\)/.test(backend) &&
    /var rollbackResult = deleteTrade\(rollbackTradeId\)/.test(backend),
  'failed clone must roll back only the trade and confirmation request it owns'
);
assert(
  /function _findScheduleCloneTargetCandidates_\(/.test(backend) &&
    /합침\/덮어쓰기를 중단했습니다/.test(backend),
  'clone must fail closed when the same customer/window already has a different schedule'
);
assert(
  /customerSendSuppressed:\s*true/.test(backend) &&
    /setScheduleCustomerSendSuppressed_\(거래ID\)/.test(backend) &&
    /isScheduleCustomerSendSuppressed_\(tid\)/.test(backend),
  'successful clone must persist a no-customer-send flag used by registration and guide senders'
);
assert(
  /preserveExistingRequests:\s*true/.test(backend) &&
    /req\.preserveExistingRequests && replacedGroups\.length > 0/.test(backend),
  'clone must not replace or delete a pre-existing mutable confirmation request'
);
assert(
  /row\[10\]/.test(backend.slice(backend.indexOf('function buildScheduleCloneSourceFingerprint_'), backend.indexOf('function _getScheduleCloneSource_'))),
  'source fingerprint must include schedule memo column K that is copied to the target'
);
assert(
  /finalCandidates\.length !== 1/.test(backend) &&
    /!finalCandidates\[0\]\.exact/.test(backend),
  'final verification must reject one exact target plus any concurrent conflicting target'
);
assert(
  /hour < 0 \|\| hour > 23/.test(backend) &&
    /day > maxDay/.test(backend),
  'clone interval validation must reject semantically invalid dates and times'
);

assert(
  /case "cloneScheduleNoSend"/.test(api) &&
    /cloneRegisteredScheduleNoSend\(cloneArgs\)/.test(api),
  'authenticated sheet API must route the bounded no-send clone action'
);
assert(
  /cloneScheduleNoSend 실제 실행은 JSON POST만 허용됩니다/.test(api) &&
    /cloneDryRun/.test(api),
  'live clone mutation must be POST-only while dry-run remains available'
);

console.log('schedule-clone-nosend.static.test.js OK');
