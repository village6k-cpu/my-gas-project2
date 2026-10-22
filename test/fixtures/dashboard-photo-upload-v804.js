// Immutable GAS version 804 photo-claim reader/writer fixture, extracted verbatim.
// Source SHA256: 6cc2531739378f5d1de89ac4883db997c376b2b16fe7c5b8d66f566d9aef888b
var DASHBOARD_PHOTO_UPLOAD_CLAIM_PREFIX_ = 'dashboardPhotoUpload_v2_';
var DASHBOARD_PHOTO_UPLOAD_CLAIM_MS_ = 7 * 60 * 1000;

function dashboardPhotoUploadClaimKey_(clientKey) {
  var clean = String(clientKey || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80);
  return clean ? DASHBOARD_PHOTO_UPLOAD_CLAIM_PREFIX_ + clean : '';
}

function cleanupDashboardPhotoUploadClaims_(props) {
  try {
    var cache = CacheService.getScriptCache();
    if (cache.get('dashboardPhotoUploadCleanup_v2')) return;
    cache.put('dashboardPhotoUploadCleanup_v2', '1', 3600);
    var all = props.getProperties();
    var now = Date.now();
    Object.keys(all).forEach(function(key) {
      if (key.indexOf(DASHBOARD_PHOTO_UPLOAD_CLAIM_PREFIX_) !== 0) return;
      var claim = null;
      try { claim = JSON.parse(all[key] || ''); } catch (err) {}
      if (!claim || !claim.at || now - Number(claim.at) > 24 * 60 * 60 * 1000) props.deleteProperty(key);
    });
  } catch (cleanupErr) {}
}

function findDashboardPhotoUploadRow_(sheet, schema, state, targetPhotoCol) {
  if (!sheet || !state || sheet.getLastRow() < 2) return 0;
  var width = Math.max(sheet.getLastColumn(), schema.maxCol || 1);
  var rows = sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getDisplayValues();
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (normalizeEquipmentCheckTradeId_(String(row[schema.tradeIdCol - 1] || '').trim()) !== state.tid) continue;
    if (schema.keyCol && state.photoId && String(row[schema.keyCol - 1] || '').trim() === state.photoId) return i + 2;
    if (schema.fileIdCol && state.fileId && String(row[schema.fileIdCol - 1] || '').trim() === state.fileId) return i + 2;
    if (state.relativePath && String(row[targetPhotoCol - 1] || '').trim() === state.relativePath) return i + 2;
  }
  return 0;
}

function dashboardPhotoUploadResult_(state, row) {
  var fileId = String(state.fileId || '').trim();
  return {
    success: true,
    tid: state.tid,
    phase: state.phase,
    deduped: !!state.recovered,
    photo: {
      phase: state.phase,
      url: state.url || ('https://drive.google.com/file/d/' + fileId + '/view?usp=drivesdk'),
      thumbnailUrl: state.thumb || ('https://drive.google.com/thumbnail?id=' + encodeURIComponent(fileId) + '&sz=w640'),
      fileId: fileId,
      sheetValue: state.relativePath || '',
      uploadedAt: state.uploadedAt || '',
      memo: String(state.memo || ''),
      row: Number(row || state.row || 0)
    }
  };
}

function uploadDashboardPhoto(tid, phase, fileName, mimeType, data, memo, clientKey) {
  tid = normalizeEquipmentCheckTradeId_(String(tid || '').trim());
  phase = normalizeDashboardPhotoPhase_(phase);
  if (!tid) return { error: "tid 필요" };
  if (phase !== 'checkout' && phase !== 'checkin') return { error: "phase는 checkout/checkin만 허용" };
  if (!data) return { error: "사진 데이터 필요" };

  // CacheService 조회만으로는 동시에 시작한 재시도 2개가 모두 miss가 되어 Drive 파일과
  // 시트 행을 중복 생성한다. ScriptProperties claim으로 pending/file/done 단계를 내구 기록한다.
  var dedupKey = clientKey ? 'dashboard_photo_upload_' + String(clientKey).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 80) : '';
  var claimKey = dashboardPhotoUploadClaimKey_(clientKey);
  var claimScope = tid + '|' + phase;
  var props = PropertiesService.getScriptProperties();
  var claimState = null;
  if (claimKey) {
    var claimLock = LockService.getScriptLock();
    var claimLocked = false;
    try {
      claimLocked = claimLock.tryLock(1500);
      if (!claimLocked) return { error: '사진 업로드 접수 중입니다. 잠시 후 다시 시도해주세요.', code: 'BUSY', retryable: true };
      cleanupDashboardPhotoUploadClaims_(props);
      try { claimState = JSON.parse(props.getProperty(claimKey) || 'null'); } catch (claimParseErr) { claimState = null; }
      if (claimState && String(claimState.scope || '') !== claimScope) {
        return { error: '같은 사진 요청키가 다른 거래에 사용되었습니다.' };
      }
      if (claimState && claimState.state === 'done' && claimState.result) return claimState.result;
      if (
        claimState && claimState.state === 'pending' && !claimState.retryReady &&
        Date.now() - Number(claimState.at || 0) < DASHBOARD_PHOTO_UPLOAD_CLAIM_MS_
      ) {
        return { error: '같은 사진을 업로드 중입니다.', code: 'BUSY', retryable: true };
      }
      claimState = claimState || {};
      claimState.scope = claimScope;
      claimState.tid = tid;
      claimState.phase = phase;
      claimState.state = claimState.fileId ? 'file' : 'pending';
      claimState.at = Date.now();
      claimState.retryReady = false;
      props.setProperty(claimKey, JSON.stringify(claimState));
    } finally {
      if (claimLocked) try { claimLock.releaseLock(); } catch (claimReleaseErr) {}
    }
  }

  try {
    var sheet = getDashboardPhotoSheet_(true);
    var schema = getDashboardPhotoSchema_(sheet);
    var targetPhotoCol = getDashboardPhotoWriteCol_(schema, phase);
    if (!schema.tradeIdCol) throw new Error("반출반납 사진 시트에서 거래ID 열을 찾지 못했습니다");
    if (!targetPhotoCol) throw new Error("반출반납 사진 시트에서 사진 URL 열을 찾지 못했습니다");
    if (!schema.phaseCol && targetPhotoCol === schema.photoCol) {
      throw new Error("공통 사진 열을 쓰려면 구분/사진구분 열이 필요합니다");
    }

    var photoId = String(claimState && claimState.photoId || '') || makeDashboardPhotoId_();
    var fileId = String(claimState && claimState.fileId || '');
    var recoveredExistingFile = !!fileId;
    var relativePath = String(claimState && claimState.relativePath || '');
    var thumb = String(claimState && claimState.thumb || '');
    var now = String(claimState && claimState.uploadedAt || '');
    if (!fileId) {
      var upload = normalizeDashboardUploadData_(data, mimeType);
      var safeName = makeDashboardPhotoFileName_(photoId, fileName, upload.mimeType);
      relativePath = DASHBOARD_PHOTO_APPSHEET_FOLDER_NAME_ + "/" + safeName;
      var blob = Utilities.newBlob(Utilities.base64Decode(upload.base64), upload.mimeType, safeName);
      var folder = getDashboardPhotoStorageFolder_();
      var file = folder.createFile(blob);
      try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (shareErr) {}
      fileId = file.getId();
      thumb = "https://drive.google.com/thumbnail?id=" + encodeURIComponent(fileId) + "&sz=w640";
      now = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
      if (claimKey) {
        claimState.photoId = photoId;
        claimState.fileId = fileId;
        claimState.relativePath = relativePath;
        claimState.thumb = thumb;
        claimState.uploadedAt = now;
        claimState.memo = String(memo || '').trim();
        claimState.state = 'file';
        try {
          props.setProperty(claimKey, JSON.stringify(claimState));
        } catch (claimFileErr) {
          try { file.setTrashed(true); } catch (trashErr) {}
          throw claimFileErr;
        }
      }
    }
    // Drive 추가 왕복(getUrl) 대신 fileId로 URL을 직접 구성해 업로드 응답을 빠르게 한다
    var url = "https://drive.google.com/file/d/" + fileId + "/view?usp=drivesdk";
    if (!thumb) thumb = "https://drive.google.com/thumbnail?id=" + encodeURIComponent(fileId) + "&sz=w640";
    if (!now) now = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
    var width = Math.max(sheet.getLastColumn(), schema.maxCol || 1);
    var row = [];
    for (var i = 0; i < width; i++) row.push('');

    if (schema.keyCol) row[schema.keyCol - 1] = photoId;
    row[schema.tradeIdCol - 1] = tid;
    if (schema.phaseCol) row[schema.phaseCol - 1] = phase === 'checkout' ? '반출' : '반납';
    row[targetPhotoCol - 1] = relativePath;
    if (schema.fileIdCol) row[schema.fileIdCol - 1] = fileId;
    if (schema.thumbCol) row[schema.thumbCol - 1] = thumb;
    if (schema.uploadedAtCol) row[schema.uploadedAtCol - 1] = now;
    if (schema.memoCol) row[schema.memoCol - 1] = String(memo || '').trim();

    var appendedRow = 0;
    var appendLock = LockService.getScriptLock();
    var appendLocked = false;
    try {
      appendLocked = appendLock.tryLock(2000);
      if (!appendLocked) throw new Error('사진 기록 저장 중입니다. 잠시 후 다시 시도해주세요.');
      appendedRow = findDashboardPhotoUploadRow_(sheet, schema, {
        tid: tid, photoId: photoId, fileId: fileId, relativePath: relativePath
      }, targetPhotoCol);
      if (!appendedRow) {
        appendedRow = sheet.getLastRow() + 1;
        sheet.getRange(appendedRow, 1, 1, row.length).setValues([row]);
      }
    } finally {
      if (appendLocked) try { appendLock.releaseLock(); } catch (appendReleaseErr) {}
    }
    rememberDashboardPhotoFileIndexEntry_(String(relativePath || '').split('/').pop(), fileId);
    invalidateDashboardPhotoCache_();
    invalidateDashboardCache();

    claimState = claimState || {};
    claimState.tid = tid;
    claimState.phase = phase;
    claimState.photoId = photoId;
    claimState.fileId = fileId;
    claimState.relativePath = relativePath;
    claimState.thumb = thumb;
    claimState.url = url;
    claimState.uploadedAt = now;
    claimState.memo = String(memo || '').trim();
    claimState.row = appendedRow;
    claimState.recovered = recoveredExistingFile;
    var result = dashboardPhotoUploadResult_(claimState, appendedRow);
    if (dedupKey) {
      try { CacheService.getScriptCache().put(dedupKey, JSON.stringify(result), 21600); } catch (dedupPutErr) {}
    }
    if (claimKey) {
      claimState.state = 'done';
      claimState.at = Date.now();
      claimState.retryReady = false;
      claimState.result = result;
      try { props.setProperty(claimKey, JSON.stringify(claimState)); } catch (claimDoneErr) {}
    }
    return result;
  } catch (err) {
    if (claimKey) {
      try {
        claimState = claimState || {};
        claimState.scope = claimScope;
        claimState.tid = tid;
        claimState.phase = phase;
        claimState.state = claimState.fileId ? 'file' : 'pending';
        claimState.retryReady = true;
        claimState.at = Date.now();
        claimState.lastError = err && err.message ? err.message : String(err);
        props.setProperty(claimKey, JSON.stringify(claimState));
      } catch (claimErrorPersistErr) {}
    }
    return { error: err && err.message ? err.message : String(err), retryable: true };
  }
}

