/** Durable AI evidence. Only an explicit, public-reader-verified migration activates Drive. */
var INVENTORY_SEMANTIC_STORAGE_BUILD_ = 'semantic-drive-doc-bootstrap-v2-20261023';
var INVENTORY_SEMANTIC_STORAGE_MANIFEST_ = 'inventorySemanticStore_v1_manifest';
var INVENTORY_SEMANTIC_STORAGE_BOOTSTRAP_ = 'inventorySemanticStore_v1_bootstrap';
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
  var scriptText = all[INVENTORY_SEMANTIC_STORAGE_MANIFEST_] || '', doc = inventorySemanticStorageDocument_();
  var documentText = doc ? doc.getProperty(INVENTORY_SEMANTIC_STORAGE_MANIFEST_) || '' : '';
  if (scriptText && documentText && scriptText !== documentText) throw new Error('AI 판단 manifest stores 충돌');
  var manifestText = scriptText || documentText, legacy = inventorySemanticStorageRecords_(all), records = legacy, manifest = null;
  var proofText = doc ? doc.getProperty(INVENTORY_SEMANTIC_STORAGE_BOOTSTRAP_) || '' : '', proof = null;
  if (proofText) {
    try { proof = JSON.parse(proofText); } catch (e) { throw new Error('AI 판단 bootstrap 파손'); }
    if (proof.version !== 1 || !/^[a-f0-9]{64}$/.test(proof.snapshotHash || '') || !proof.generation
        || ['creating', 'staged', 'active'].indexOf(proof.phase) < 0) throw new Error('AI 판단 bootstrap 검증 실패');
  }
  // A missing document context cannot be interpreted as an empty migrated store.
  if (!doc && !manifestText && !Object.keys(legacy).length) throw new Error('AI 판단 DocumentProperties 권위 확인 필요');
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
    scriptText: scriptText, documentText: documentText, document: doc, proof: proof, proofText: proofText,
    manifestStore: scriptText && documentText ? 'both' : scriptText ? 'script' : documentText ? 'document' : null,
    snapshotHash: inventorySemanticStorageDigest_(JSON.stringify(records)) };
}

function inventorySemanticStorageDocument_() {
  return typeof PropertiesService.getDocumentProperties === 'function' ? PropertiesService.getDocumentProperties() : null;
}

function inventorySemanticStorageCasWrite_(props, key, expected, text) {
  if (Utilities.newBlob(text).getBytes().length > 4000) throw new Error('AI 판단 pointer metadata 크기 초과');
  if ((props.getProperty(key) || '') !== expected) throw new Error('AI 판단 pointer metadata CAS changed');
  try { props.setProperty(key, text); } catch (writeError) { /* Exact durable readback decides uncertain writes. */ }
  if (props.getProperty(key) !== text) throw new Error('AI 판단 pointer metadata commit 확인 실패');
}

function inventorySemanticStorageRead_() { return inventorySemanticStorageState_(false).records; }

function inventorySemanticStorageStatus_(state, nonce) {
  var bytes = 0;
  Object.keys(state.records).forEach(function(key) { bytes += Utilities.newBlob(state.records[key]).getBytes().length; });
  return { readerBuild: INVENTORY_SEMANTIC_STORAGE_BUILD_, mode: state.manifest ? 'drive' : 'legacy',
    manifestStore: state.manifestStore, bootstrapPhase: state.proof ? state.proof.phase : null,
    recordCount: Object.keys(state.records).length, valueBytes: bytes, legacyCount: Object.keys(state.legacy).length,
    snapshotHash: state.snapshotHash, manifestHash: inventorySemanticStorageDigest_(state.manifestText),
    triggerObservation: state.proof?.triggerObservation || null, nonce: String(nonce || '').slice(0, 100) };
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

function inventorySemanticStorageVerifyPublic_(state, requireDocument) {
  var key = PropertiesService.getScriptProperties().getProperty('VILLAGE_API_WRITE_KEY_V1');
  if (!key) throw new Error('public reader 검증용 내부 인증 없음');
  var nonce = Utilities.getUuid(), result;
  try {
    var response = UrlFetchApp.fetch(INVENTORY_SEMANTIC_STORAGE_PUBLIC_URL_, { method: 'post', contentType: 'application/json',
      payload: JSON.stringify({ key: key, action: 'run', func: 'getInventorySemanticStorageStatus', args: [{ nonce: nonce, includeDocumentStore: true }] }),
      muteHttpExceptions: true });
    if (response.getResponseCode() !== 200) throw new Error('public reader 응답 실패');
    var body = JSON.parse(response.getContentText());result = body.success === true && body.result;
  } catch (e) { throw new Error('public reader 확인 실패: 이전 실행 금지'); }
  if (!result || result.readerBuild !== INVENTORY_SEMANTIC_STORAGE_BUILD_ || result.nonce !== nonce
      || result.snapshotHash !== state.snapshotHash || result.manifestHash !== inventorySemanticStorageDigest_(state.manifestText)
      || result.manifestStore !== state.manifestStore || result.recordCount !== Object.keys(state.records).length
      || (requireDocument && (!result.documentStore || result.documentStore.available !== true || result.documentStore.readable !== true)))
    throw new Error('public reader 검증 불일치: 이전 실행 금지');
}

/** Caller holds ScriptLock. Failed or orphan generations are retained, never automatically deleted. */
function inventorySemanticStorageCommit_(state, records) {
  var props = PropertiesService.getScriptProperties(), target = state.manifestStore === 'document' ? state.document : props;
  if (state.manifestStore === 'both') throw new Error('AI 판단 중복 manifest stores 정리 필요');
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
  if ((props.getProperty(INVENTORY_SEMANTIC_STORAGE_MANIFEST_) || '') !== state.scriptText
      || (state.document && (state.document.getProperty(INVENTORY_SEMANTIC_STORAGE_MANIFEST_) || '') !== state.documentText))
    throw new Error('AI 판단 manifest CAS changed');
  var manifestText = JSON.stringify(manifest);
  inventorySemanticStorageCasWrite_(target, INVENTORY_SEMANTIC_STORAGE_MANIFEST_, state.manifestText, manifestText);
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
    if (state.proof) throw new Error('AI 판단 bootstrap 진행 중: 기존 원문 보존');
    reviews.forEach(function(review) { var key = inventorySemanticKey_(review);props.setProperty(key, records[key]); });
    reviews.forEach(function(review) { var key = inventorySemanticKey_(review);if (props.getProperty(key) !== records[key]) throw new Error('AI 구성품 판단 저장 확인 필요'); });
    return;
  }
  if (Object.keys(state.legacy).length || (state.manifestStore === 'document' && state.proof?.phase !== 'active'))
    throw new Error('AI 판단 migration cleanup 완료 필요');
  if (inventorySemanticStorageDigest_(JSON.stringify(records)) === state.snapshotHash) return;
  inventorySemanticStorageCommit_(state, records);
}

/** Existing installed minute trigger only. No new trigger, customer send, or legacy cleanup. */
function inventorySemanticStorageObserveTrigger_(event) {
  if (!event || !event.triggerUid) return;
  // The regular minute heartbeat must not acquire migration locks or read Drive outside staging.
  var doc = inventorySemanticStorageDocument_();if (!doc) return;
  var raw = doc.getProperty(INVENTORY_SEMANTIC_STORAGE_BOOTSTRAP_);if (!raw) return;
  var pending = JSON.parse(raw);
  if (!pending || pending.version !== 1 || pending.phase !== 'staged' || !pending.generation
      || !/^[a-f0-9]{64}$/.test(pending.snapshotHash || '')) return;
  var uid = String(event.triggerUid), trigger = ScriptApp.getProjectTriggers().filter(function(t) {
    return String(t.getUniqueId()) === uid && t.getHandlerFunction() === 'inventoryRiskHeartbeat'
      && t.getEventType() === ScriptApp.EventType.CLOCK;
  });
  if (trigger.length !== 1) return;
  var lock = LockService.getScriptLock();if (!lock.tryLock(500)) return;
  try {
    var state = inventorySemanticStorageState_(true), proof = state.proof;
    if (!proof || proof.phase !== 'staged' || !state.manifest || state.manifestStore !== 'document'
        || !Object.keys(state.records).length || proof.manifestHash !== inventorySemanticStorageDigest_(state.manifestText)
        || proof.snapshotHash !== state.snapshotHash) return;
    if (proof.triggerObservation?.manifestHash === proof.manifestHash && proof.triggerObservation?.snapshotHash === state.snapshotHash
        && proof.triggerObservation?.readerBuild === INVENTORY_SEMANTIC_STORAGE_BUILD_
        && proof.triggerObservation?.triggerUid === uid && proof.triggerObservation?.recordCount === Object.keys(state.records).length) return;
    var next = Object.assign({}, proof, { triggerObservation: { triggerUid: uid, handler: 'inventoryRiskHeartbeat',
      readerBuild: INVENTORY_SEMANTIC_STORAGE_BUILD_, manifestHash: proof.manifestHash, snapshotHash: state.snapshotHash,
      recordCount: Object.keys(state.records).length, observedAt: new Date().toISOString() } });
    inventorySemanticStorageCasWrite_(state.document, INVENTORY_SEMANTIC_STORAGE_BOOTSTRAP_, state.proofText, JSON.stringify(next));
  } finally { lock.releaseLock(); }
}

/** Stage retains every legacy property. Finalize separately requires both real reader contexts. */
function migrateInventorySemanticStorage(input) {
  input = input || {};
  if (Object.keys(input).some(function(key) { return ['execute', 'expectedSnapshotHash', 'expectedManifestHash', 'phase', 'targetStore', 'resumeFileId'].indexOf(key) < 0; }))
    throw new Error('AI 판단 이전 입력 형식 오류');
  var before = inventorySemanticStorageState_(true);
  if (input.execute !== true) return inventorySemanticStorageStatus_(before);
  if (input.targetStore !== 'document' || ['stage', 'finalize'].indexOf(input.phase) < 0)
    throw new Error('AI 판단 이전은 명시적 document stage/finalize 필요');
  if (!before.document || before.scriptText) throw new Error('AI 판단 document bootstrap 대상 store 확인 필요');
  if (input.expectedSnapshotHash !== before.snapshotHash) throw new Error('AI 판단 snapshot CAS changed');
  if (!Object.keys(before.records).length) throw new Error('AI 판단 빈 snapshot으로 store identity를 증명할 수 없음');
  inventorySemanticStorageVerifyPublic_(before, true);
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) throw new Error('AI 판단 이전 중');
  try {
    var state = inventorySemanticStorageState_(true), props = PropertiesService.getScriptProperties();
    if (state.snapshotHash !== before.snapshotHash || state.manifestText !== before.manifestText || state.proofText !== before.proofText)
      throw new Error('AI 판단 snapshot CAS changed');
    if (input.phase === 'stage') {
      inventorySemanticStorageStage_(state, input);
      var staged = inventorySemanticStorageState_(true);
      inventorySemanticStorageVerifyPublic_(staged, true);
      return Object.assign(inventorySemanticStorageStatus_(staged), { publicPointerVerified: true });
    }
    var manifestText = state.manifestText, proof = state.proof, observation = proof && proof.triggerObservation;
    if (!manifestText || input.expectedManifestHash !== inventorySemanticStorageDigest_(manifestText)
        || !proof || proof.manifestHash !== input.expectedManifestHash || proof.snapshotHash !== state.snapshotHash
        || !observation || observation.readerBuild !== INVENTORY_SEMANTIC_STORAGE_BUILD_
        || observation.manifestHash !== proof.manifestHash || observation.snapshotHash !== state.snapshotHash
        || observation.recordCount !== Object.keys(state.records).length)
      throw new Error('AI 판단 동일 generation trigger 관측 필요');
    var installed = ScriptApp.getProjectTriggers().filter(function(t) { return String(t.getUniqueId()) === observation.triggerUid
      && t.getHandlerFunction() === 'inventoryRiskHeartbeat' && t.getEventType() === ScriptApp.EventType.CLOCK; });
    if (installed.length !== 1) throw new Error('AI 판단 설치된 trigger 관측 확인 필요');
    Object.keys(state.legacy).forEach(function(key) {
      if ((props.getProperty(INVENTORY_SEMANTIC_STORAGE_MANIFEST_) || '') !== state.scriptText
          || state.document.getProperty(INVENTORY_SEMANTIC_STORAGE_MANIFEST_) !== manifestText
          || state.document.getProperty(INVENTORY_SEMANTIC_STORAGE_BOOTSTRAP_) !== state.proofText
          || props.getProperty(key) !== state.records[key])
        throw new Error('AI 판단 cleanup CAS changed');
      props.deleteProperty(key);
      if (props.getProperty(key) !== null) throw new Error('AI 판단 cleanup readback 확인 필요');
    });
    inventorySemanticStorageCasWrite_(state.document, INVENTORY_SEMANTIC_STORAGE_BOOTSTRAP_, state.proofText,
      JSON.stringify(Object.assign({}, proof, { phase: 'active' })));
    return inventorySemanticStorageStatus_(inventorySemanticStorageState_(true));
  } finally { lock.releaseLock(); }
}

function inventorySemanticStorageStage_(state, input) {
  if (state.manifest) {
    if (state.proof?.phase === 'creating' && state.proof.fileId === state.manifest.fileId
        && state.proof.payloadHash === state.manifest.payloadHash && state.proof.snapshotHash === state.snapshotHash
        && state.proof.recordCount === state.manifest.recordCount) {
      var recovered = Object.assign({}, state.proof, { phase: 'staged', manifestHash: inventorySemanticStorageDigest_(state.manifestText) });
      inventorySemanticStorageCasWrite_(state.document, INVENTORY_SEMANTIC_STORAGE_BOOTSTRAP_, state.proofText, JSON.stringify(recovered));
      state = inventorySemanticStorageState_(true);
    }
    if (!state.proof || state.proof.manifestHash !== inventorySemanticStorageDigest_(state.manifestText)
        || state.proof.snapshotHash !== state.snapshotHash) throw new Error('AI 판단 stage 증거 확인 필요');
    return inventorySemanticStorageStatus_(state);
  }
  var proof = state.proof, proofText = state.proofText, createdNow = false;
  if (!proof) {
    proof = { version: 1, phase: 'creating', generation: Utilities.getUuid(), snapshotHash: state.snapshotHash,
      recordCount: Object.keys(state.records).length, createdAt: new Date().toISOString() };
    var payload = JSON.stringify({ format: 'inventory-semantic-v1', generation: proof.generation, records: state.records, previousManifest: null });
    proof.payloadHash = inventorySemanticStorageDigest_(payload);proofText = JSON.stringify(proof);
    inventorySemanticStorageCasWrite_(state.document, INVENTORY_SEMANTIC_STORAGE_BOOTSTRAP_, '', proofText);
    createdNow = true;
  }
  if (proof.phase !== 'creating' || proof.snapshotHash !== state.snapshotHash) throw new Error('AI 판단 bootstrap snapshot CAS changed');
  var fileId = proof.fileId || input.resumeFileId;
  if (proof.fileId && input.resumeFileId && proof.fileId !== input.resumeFileId) throw new Error('AI 판단 resume fileId 불일치');
  if (!fileId) {
    if (!createdNow) throw new Error('AI 판단 Drive create outcome 불확실: 명시적 fileId 재조정 필요');
    var file = DriveApp.createFile(Utilities.gzip(Utilities.newBlob(payload, 'application/json'), 'inventory-semantic-' + proof.generation + '.json.gz'));
    fileId = file.getId();
    // Persist the exact returned file ID before verification/pointer activation. No filename search or create retry.
    var withFile = Object.assign({}, proof, { fileId: fileId });
    inventorySemanticStorageCasWrite_(state.document, INVENTORY_SEMANTIC_STORAGE_BOOTSTRAP_, proofText, JSON.stringify(withFile));
    proof = withFile;proofText = JSON.stringify(proof);
    file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
  }
  var manifest = { version: 1, fileId: String(fileId), payloadHash: proof.payloadHash, snapshotHash: proof.snapshotHash, recordCount: proof.recordCount };
  inventorySemanticStorageDecode_(manifest);
  if (!proof.fileId) {
    // Explicit orphan reconciliation must itself be resumable if the following pointer checkpoint is interrupted.
    proof = Object.assign({}, proof, { fileId: manifest.fileId });
    inventorySemanticStorageCasWrite_(state.document, INVENTORY_SEMANTIC_STORAGE_BOOTSTRAP_, proofText, JSON.stringify(proof));
    proofText = JSON.stringify(proof);
  }
  if (JSON.stringify(inventorySemanticStorageRecords_(PropertiesService.getScriptProperties().getProperties())) !== JSON.stringify(state.legacy)
      || PropertiesService.getScriptProperties().getProperty(INVENTORY_SEMANTIC_STORAGE_MANIFEST_)
      || state.document.getProperty(INVENTORY_SEMANTIC_STORAGE_MANIFEST_)) throw new Error('AI 판단 bootstrap CAS changed');
  var manifestText = JSON.stringify(manifest);
  inventorySemanticStorageCasWrite_(state.document, INVENTORY_SEMANTIC_STORAGE_MANIFEST_, '', manifestText);
  var staged = Object.assign({}, proof, { fileId: manifest.fileId, phase: 'staged', manifestHash: inventorySemanticStorageDigest_(manifestText) });
  inventorySemanticStorageCasWrite_(state.document, INVENTORY_SEMANTIC_STORAGE_BOOTSTRAP_, proofText, JSON.stringify(staged));
  return inventorySemanticStorageStatus_(inventorySemanticStorageState_(true));
}
