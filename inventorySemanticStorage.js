/** Durable AI evidence. Only an explicit, public-reader-verified migration activates Drive. */
var INVENTORY_SEMANTIC_STORAGE_BUILD_ = 'semantic-drive-v1-20261023';
var INVENTORY_SEMANTIC_STORAGE_MANIFEST_ = 'inventorySemanticStore_v1_manifest';
var INVENTORY_SEMANTIC_STORAGE_MEMORY_ = null;
// Probe the production deployment, never the calling /dev execution or a caller-supplied URL.
var INVENTORY_SEMANTIC_STORAGE_PUBLIC_URL_ = 'https://script.google.com/macros/s/AKfycbyRff4-lLXmne-iPIEf87x4-CH_5wb-Uv5dCGymELLrpiKluhg2gDdLdVP4Y0MmxnnT/exec';

function inventorySemanticStorageDigest_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)
    .map(function(b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join('');
}

function inventorySemanticStorageRecords_(values) {
  var records = {};
  Object.keys(values).sort().forEach(function(key) {
    if (key.indexOf(INVENTORY_SEMANTIC_PREFIX_) === 0) records[key] = String(values[key]);
  });
  return records;
}

function inventorySemanticStoragePrivate_(file) {
  if (file.getSharingAccess() !== DriveApp.Access.PRIVATE || file.getEditors().length || file.getViewers().length)
    throw new Error('AI 판단 저장 파일은 private이어야 합니다');
}

function inventorySemanticStorageDecode_(manifest) {
  var file = DriveApp.getFileById(manifest.fileId);
  inventorySemanticStoragePrivate_(file);
  var text = Utilities.ungzip(file.getBlob()).getDataAsString('UTF-8');
  if (inventorySemanticStorageDigest_(text) !== manifest.payloadHash) throw new Error('AI 판단 저장 파일 hash 불일치');
  var payload = JSON.parse(text);
  if (payload.format !== 'inventory-semantic-v1' || !payload.records || Array.isArray(payload.records))
    throw new Error('AI 판단 저장 파일 형식 오류');
  var records = inventorySemanticStorageRecords_(payload.records), keys = Object.keys(payload.records);
  if (keys.length !== Object.keys(records).length || keys.some(function(key) { return typeof payload.records[key] !== 'string'; })
      || keys.length !== manifest.recordCount || inventorySemanticStorageDigest_(JSON.stringify(records)) !== manifest.snapshotHash)
    throw new Error('AI 판단 저장 원문 검증 실패');
  return records;
}

function inventorySemanticStorageState_(fresh) {
  var props = PropertiesService.getScriptProperties(), all = props.getProperties();
  var manifestText = all[INVENTORY_SEMANTIC_STORAGE_MANIFEST_] || '', legacy = inventorySemanticStorageRecords_(all), records = legacy, manifest = null;
  if (manifestText) {
    try { manifest = JSON.parse(manifestText); } catch (e) { throw new Error('AI 판단 manifest 파손'); }
    if (manifest.version !== 1 || !manifest.fileId || !/^[a-f0-9]{64}$/.test(manifest.payloadHash || '')
        || !/^[a-f0-9]{64}$/.test(manifest.snapshotHash || '') || !Number.isInteger(manifest.recordCount) || manifest.recordCount < 0)
      throw new Error('AI 판단 manifest 검증 실패');
    if (!fresh && INVENTORY_SEMANTIC_STORAGE_MEMORY_ && INVENTORY_SEMANTIC_STORAGE_MEMORY_.manifestText === manifestText)
      records = JSON.parse(INVENTORY_SEMANTIC_STORAGE_MEMORY_.recordsText);
    else {
      records = inventorySemanticStorageDecode_(manifest);
      INVENTORY_SEMANTIC_STORAGE_MEMORY_ = { manifestText: manifestText, recordsText: JSON.stringify(records) };
    }
    Object.keys(legacy).forEach(function(key) {
      if (legacy[key] !== records[key]) throw new Error('AI 판단 legacy 원문 changed: migration 확인 필요');
    });
  }
  return { records: records, legacy: legacy, manifest: manifest, manifestText: manifestText,
    snapshotHash: inventorySemanticStorageDigest_(JSON.stringify(records)) };
}

function inventorySemanticStorageRead_() { return inventorySemanticStorageState_(false).records; }

function inventorySemanticStorageStatus_(state, nonce) {
  var bytes = 0;
  Object.keys(state.records).forEach(function(key) { bytes += Utilities.newBlob(state.records[key]).getBytes().length; });
  return { readerBuild: INVENTORY_SEMANTIC_STORAGE_BUILD_, mode: state.manifest ? 'drive' : 'legacy',
    recordCount: Object.keys(state.records).length, valueBytes: bytes, legacyCount: Object.keys(state.legacy).length,
    snapshotHash: state.snapshotHash, manifestHash: inventorySemanticStorageDigest_(state.manifestText), nonce: String(nonce || '').slice(0, 100) };
}

/** Read-only availability evidence; even identical/empty hashes do not prove shared store identity. */
function inventorySemanticDocumentStoreMetadata_() {
  var result = { available: null, readable: false, manifestHash: null, identityVerified: false };
  try {
    if (typeof PropertiesService.getDocumentProperties !== 'function') return result;
    var props = PropertiesService.getDocumentProperties();
    result.available = !!props;
    if (!props) return result;
    var raw = props.getProperty(INVENTORY_SEMANTIC_STORAGE_MANIFEST_);
    if (raw !== null && typeof raw !== 'string') return result;
    result.manifestHash = raw ? inventorySemanticStorageDigest_(raw) : null;
    result.readable = true;
  } catch (unavailable) { /* Optional metadata remains unknown; never expose exception details. */ }
  return result;
}

function getInventorySemanticStorageStatus(input) {
  var result = inventorySemanticStorageStatus_(inventorySemanticStorageState_(true), input && input.nonce);
  if (input && input.includeDocumentStore === true) result.documentStore = inventorySemanticDocumentStoreMetadata_();
  return result;
}

function inventorySemanticStorageVerifyPublic_(state) {
  var key = PropertiesService.getScriptProperties().getProperty('VILLAGE_API_WRITE_KEY_V1');
  if (!key) throw new Error('public reader 검증용 내부 인증 없음');
  var nonce = Utilities.getUuid(), result;
  try {
    var response = UrlFetchApp.fetch(INVENTORY_SEMANTIC_STORAGE_PUBLIC_URL_, { method: 'post', contentType: 'application/json',
      payload: JSON.stringify({ key: key, action: 'run', func: 'getInventorySemanticStorageStatus', args: [{ nonce: nonce }] }),
      muteHttpExceptions: true });
    if (response.getResponseCode() !== 200) throw new Error('public reader 응답 실패');
    var body = JSON.parse(response.getContentText());result = body.success === true && body.result;
  } catch (e) { throw new Error('public reader 확인 실패: 이전 실행 금지'); }
  if (!result || result.readerBuild !== INVENTORY_SEMANTIC_STORAGE_BUILD_ || result.nonce !== nonce
      || result.snapshotHash !== state.snapshotHash || result.manifestHash !== inventorySemanticStorageDigest_(state.manifestText))
    throw new Error('public reader 검증 불일치: 이전 실행 금지');
}

/** Caller holds ScriptLock. Failed or orphan generations are retained, never automatically deleted. */
function inventorySemanticStorageCommit_(state, records) {
  var props = PropertiesService.getScriptProperties();
  var payload = JSON.stringify({ format: 'inventory-semantic-v1', records: records, previousManifest: state.manifest });
  var blob = Utilities.gzip(Utilities.newBlob(payload, 'application/json'), 'inventory-semantic-' + Utilities.getUuid() + '.json.gz');
  var file = DriveApp.createFile(blob);
  file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
  var manifest = { version: 1, fileId: file.getId(), payloadHash: inventorySemanticStorageDigest_(payload),
    snapshotHash: inventorySemanticStorageDigest_(JSON.stringify(records)), recordCount: Object.keys(records).length };
  // Read the created file back through Drive before switching authority.
  inventorySemanticStorageDecode_(manifest);
  if (JSON.stringify(inventorySemanticStorageRecords_(props.getProperties())) !== JSON.stringify(state.legacy))
    throw new Error('AI 판단 legacy snapshot CAS changed');
  if ((props.getProperty(INVENTORY_SEMANTIC_STORAGE_MANIFEST_) || '') !== state.manifestText)
    throw new Error('AI 판단 manifest CAS changed');
  var manifestText = JSON.stringify(manifest);
  try { props.setProperty(INVENTORY_SEMANTIC_STORAGE_MANIFEST_, manifestText); } catch (writeError) { /* Exact readback decides. */ }
  if (props.getProperty(INVENTORY_SEMANTIC_STORAGE_MANIFEST_) !== manifestText)
    throw new Error('AI 판단 저장 commit 확인 실패; 이전 원장 보존');
  INVENTORY_SEMANTIC_STORAGE_MEMORY_ = { manifestText: manifestText, recordsText: JSON.stringify(records) };
  return manifestText;
}

/** Existing applyInventorySemanticReview holds ScriptLock and validates all source identities first. */
function inventorySemanticStorageWrite_(reviews) {
  var state = inventorySemanticStorageState_(true), props = PropertiesService.getScriptProperties();
  var records = Object.assign({}, state.records);
  reviews.forEach(function(review) {
    var raw = JSON.stringify(review);
    if (Utilities.newBlob(raw).getBytes().length > 8500) throw new Error('재고 판단 근거 크기 초과');
    records[inventorySemanticKey_(review)] = raw;
  });
  records = inventorySemanticStorageRecords_(records);
  if (!state.manifest) {
    reviews.forEach(function(review) { var key = inventorySemanticKey_(review);props.setProperty(key, records[key]); });
    reviews.forEach(function(review) { var key = inventorySemanticKey_(review);if (props.getProperty(key) !== records[key]) throw new Error('AI 구성품 판단 저장 확인 필요'); });
    return;
  }
  if (Object.keys(state.legacy).length) throw new Error('AI 판단 migration cleanup 완료 필요');
  if (inventorySemanticStorageDigest_(JSON.stringify(records)) === state.snapshotHash) return;
  inventorySemanticStorageCommit_(state, records);
}

/** Explicit cutover only; dry-run is the default. Caller must first deploy the compatible PUBLIC reader. */
function migrateInventorySemanticStorage(input) {
  input = input || {};
  if (Object.keys(input).some(function(key) { return ['execute', 'expectedSnapshotHash'].indexOf(key) < 0; }))
    throw new Error('AI 판단 이전 입력 형식 오류');
  var before = inventorySemanticStorageState_(true);
  if (input.execute !== true) return inventorySemanticStorageStatus_(before);
  if (input.expectedSnapshotHash !== before.snapshotHash) throw new Error('AI 판단 snapshot CAS changed');
  inventorySemanticStorageVerifyPublic_(before);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('AI 판단 이전 중');
  try {
    var state = inventorySemanticStorageState_(true), props = PropertiesService.getScriptProperties();
    if (state.snapshotHash !== before.snapshotHash || state.manifestText !== before.manifestText) throw new Error('AI 판단 snapshot CAS changed');
    var manifestText = state.manifestText || inventorySemanticStorageCommit_(state, state.records);
    Object.keys(state.legacy).forEach(function(key) {
      if (props.getProperty(INVENTORY_SEMANTIC_STORAGE_MANIFEST_) !== manifestText || props.getProperty(key) !== state.records[key])
        throw new Error('AI 판단 cleanup CAS changed');
      props.deleteProperty(key);
    });
    return inventorySemanticStorageStatus_(inventorySemanticStorageState_(true));
  } finally { lock.releaseLock(); }
}
