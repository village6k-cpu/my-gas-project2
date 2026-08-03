const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

function section(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `missing section: ${startMarker}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end > start, `missing end marker: ${endMarker}`);
  return source.slice(start, end);
}

test('사진 원본 보존 실패와 일시적 BUSY를 저장 성공/영구 실패로 오인하지 않는다', () => {
  const queue = read('apps/today-dashboard/lib/data/photoUploadQueue.ts');
  const store = read('apps/today-dashboard/lib/data/store.ts');

  const write = section(queue, 'async function idbWrite', '\nasync function idbDelete');
  assert.match(write, /Promise<boolean>/, 'IndexedDB 보존 성공 여부를 호출자에게 반환해야 한다');
  assert.match(write, /tx\.onerror\s*=\s*\(\)\s*=>\s*resolve\(false\)/);
  assert.match(write, /tx\.onabort\s*=\s*\(\)\s*=>\s*resolve\(false\)/);

  const enqueue = section(queue, 'export async function enqueuePhotoUpload', '\n\/\*\* 앱 재시작');
  assert.match(enqueue, /const persisted = await idbWrite\(job\)/);
  assert.match(enqueue, /if \(!persisted\)[\s\S]*await sendPhotoWithoutDurableStorage_\(job\)/,
    '기기 보존이 막히면 백그라운드 성공처럼 끝내지 말고 서버 확정을 직접 기다려야 한다');
  const upload = section(store, 'export async function uploadTradePhoto', '\nexport async function retryTradePhotoUpload');
  assert.ok(
    upload.indexOf('await enqueuePhotoUpload') < upload.indexOf('mergePhotos(t.photos, [optimistic])'),
    '업로드 타일은 원본이 IndexedDB에 내구 보존된 뒤에만 보여야 한다',
  );

  const failure = section(queue, '} catch (error) {', '\n        if \(permanent\)');
  assert.match(failure, /retryable|outcomeUnknown|NETWORK_ERROR_RE/);
  assert.match(failure, /job\.attempts를 소모하지 않는다|시도 횟수를 소모하지 않는다/,
    'BUSY/응답유실은 7분 서버 claim보다 먼저 재시도 예산을 소진하면 안 된다');

  const sender = section(store, 'function sendQueuedPhoto_', '\nif (typeof window !== "undefined")');
  assert.match(sender, /payload\?\.success !== true/);
  assert.match(sender, /photo\?\.fileId/);
  assert.match(sender, /photo\?\.sheetValue/,
    'HTTP 200 빈 응답은 사진 저장 완료로 인정하면 안 된다');

  const discard = section(queue, 'export async function discardPhotoUpload', '\nexport function pendingPhotoUploadCount');
  assert.ok(
    discard.indexOf('await idbDelete(queueId)') < discard.indexOf('jobs.delete(queueId)'),
    '사용자 폐기는 IndexedDB 삭제 확인 후에만 메모리/UI에서 없애야 한다',
  );
  const badge = read('apps/today-dashboard/components/PhotoQueueBadge.tsx');
  assert.match(badge, /await retryTradePhotoUpload/);
  assert.match(badge, /await discardTradePhotoUpload/);
});

test('장비명 수정은 로컬 내구 outbox 접수 직후 끝나고 새로고침 뒤 재생된다', () => {
  const store = read('apps/today-dashboard/lib/data/store.ts');
  const rename = section(store, 'export async function setItemName', '/** GAS updateEquipQty');
  const replay = section(store, 'function replayDurableMutationOutboxes', '\nlet durableMutationOnlineResumeRegistered');

  assert.match(store, /ITEM_NAME_OUTBOX_KEY\s*=\s*"heybilly:item-name-outbox:v1"/);
  assert.match(rename, /putItemNameOutboxTarget/);
  assert.match(rename, /armItemNameCommit_/);
  assert.ok(
    rename.indexOf('return true;') < rename.indexOf('await gasMutation("updateEquipName"'),
    '일반 장비명 저장은 GAS 왕복 전에 UI 호출을 끝내야 한다',
  );
  assert.match(rename, /mutationId/);
  assert.match(rename, /previousNames:\s*JSON\.stringify\(target\.previousNames\)/);
  assert.match(rename, /if \(res\?\.stale === true\)[\s\S]*reconcileCompletionMutationCanonical_[\s\S]*return;[\s\S]*clearReturnCountsPersist/,
    '오래된 장비명을 거절한 뒤 반납 정본을 지우면 안 된다');
  assert.match(rename, /acknowledgeItemNameOutboxTarget/);
  assert.match(replay, /readItemNameOutbox/);
  assert.match(replay, /armItemNameCommit_/);
});

test('GAS 병합본은 최신 HeyBillie 저장 계약과 운영 전용 기능을 함께 보존한다', () => {
  const gas = read('checkAvailability.js');
  const api = read('sheetAPI.js');

  assert.match(gas, /function requestDirectTaxInvoice\(/, '운영에서 추가된 직접 세금계산서 기능을 보존해야 한다');
  assert.match(gas, /function dashboardUpdateEquipmentName[\s\S]*beginDashboardMutation_\(/,
    '장비명 outbox 재생은 mutationId로 멱등해야 한다');
  assert.match(gas, /previousNames\.indexOf\(oldName\) === -1[\s\S]*stale: true/,
    '오프라인의 오래된 장비명이 더 최신 서버 정본을 덮으면 안 된다');
  assert.match(api, /function getVillageOperationCapabilities_\(/);
  assert.match(api, /function withVillageOperationReceipt_\(/);
  assert.match(api, /case "cloneScheduleNoSend"[\s\S]{0,220}cloneScheduleNoSend_\(postBody\)/);
  assert.doesNotMatch(api, /cloneRegisteredScheduleNoSend_\(/, '존재하지 않는 clone 함수 호출을 배포하면 안 된다');
  assert.match(api, /case "issueTaxInvoice"/);
  assert.match(api, /itemNameStaleCas: true/);
});
