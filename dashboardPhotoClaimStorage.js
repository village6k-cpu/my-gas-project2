/** Explicit lossless compaction of completed photo receipts; compatible with public GAS 804. */
var DASHBOARD_PHOTO_COMPACTION_PREFIX_ = 'dashboardPhotoUpload_v2_';
var DASHBOARD_PHOTO_COMPACTION_QUIET_MS_ = 7 * 60 * 1000;

function dashboardPhotoClaimDigest_(text) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, text, Utilities.Charset.UTF_8)
    .map(function(byte) { return ('0' + (byte & 255).toString(16)).slice(-2); }).join('');
}

function dashboardPhotoClaimBytes_(text) { return Utilities.newBlob(text).getBytes().length; }

function dashboardPhotoClaimRecords_(props) {
  var all = props.getProperties(), records = {};
  Object.keys(all).sort().forEach(function(key) {
    if (key.indexOf(DASHBOARD_PHOTO_COMPACTION_PREFIX_) === 0) records[key] = String(all[key]);
  });
  return records;
}

function dashboardPhotoClaimCompactCandidate_(raw, now) {
  var claim;
  try { claim = JSON.parse(raw); } catch (error) { return { reason: 'invalid_json' }; }
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)) return { reason: 'invalid_shape' };
  if (claim.state !== 'done') return { reason: 'not_done' };
  if (typeof claim.at !== 'number' || !isFinite(claim.at) || claim.at <= 0 || claim.at > now)
    return { reason: 'invalid_time' };
  // 804 writes the terminal receipt outside ScriptLock. Let every earlier invocation finish.
  if (now - claim.at < DASHBOARD_PHOTO_COMPACTION_QUIET_MS_) return { reason: 'not_quiet' };
  var result = claim.result, photo = result && result.photo;
  if (!result || typeof result !== 'object' || Array.isArray(result) || result.success !== true
      || typeof result.tid !== 'string' || !result.tid || ['checkout', 'checkin'].indexOf(result.phase) < 0
      || !photo || typeof photo !== 'object' || Array.isArray(photo) || photo.phase !== result.phase
      || typeof photo.fileId !== 'string' || !photo.fileId || typeof photo.sheetValue !== 'string' || !photo.sheetValue
      || typeof photo.url !== 'string' || typeof photo.thumbnailUrl !== 'string' || typeof photo.uploadedAt !== 'string'
      || typeof photo.memo !== 'string' || !Number.isInteger(photo.row) || photo.row < 2 || typeof result.deduped !== 'boolean')
    return { reason: 'invalid_result' };
  if (claim.scope !== result.tid + '|' + result.phase) return { reason: 'scope_mismatch' };
  var duplicates = { tid: result.tid, phase: result.phase, fileId: photo.fileId, relativePath: photo.sheetValue,
    thumb: photo.thumbnailUrl, url: photo.url, uploadedAt: photo.uploadedAt, memo: photo.memo, row: photo.row, recovered: result.deduped };
  var fields = Object.keys(duplicates).filter(function(key) { return Object.prototype.hasOwnProperty.call(claim, key); });
  if (fields.some(function(key) { return claim[key] !== duplicates[key]; })) return { reason: 'duplicate_mismatch' };
  if (!fields.length) return { reason: 'already_compact' };
  var compact = Object.create(null);
  Object.keys(claim).forEach(function(key) { compact[key] = claim[key]; });
  fields.forEach(function(key) { delete compact[key]; });
  var compactRaw = JSON.stringify(compact), savedBytes = dashboardPhotoClaimBytes_(raw) - dashboardPhotoClaimBytes_(compactRaw);
  if (savedBytes <= 0 || JSON.stringify(compact.result) !== JSON.stringify(claim.result)) return { reason: 'not_smaller' };
  return { raw: compactRaw, savedBytes: savedBytes, removedFields: fields.length };
}

function dashboardPhotoClaimCompactionPlan_(records, now) {
  var candidates = [], valueBytes = 0, savings = 0, reasons = {};
  Object.keys(records).forEach(function(key) {
    valueBytes += dashboardPhotoClaimBytes_(records[key]);
    var candidate = dashboardPhotoClaimCompactCandidate_(records[key], now);
    if (candidate.reason) reasons[candidate.reason] = (reasons[candidate.reason] || 0) + 1;
    else { candidates.push({ key: key, before: records[key], after: candidate.raw, savedBytes: candidate.savedBytes }); savings += candidate.savedBytes; }
  });
  return { candidates: candidates, metadata: { ok: true, dryRun: true, snapshotHash: dashboardPhotoClaimDigest_(JSON.stringify(records)),
    claimCount: Object.keys(records).length, eligibleCount: candidates.length, valueBytes: valueBytes,
    expectedValueBytes: valueBytes - savings, expectedSavedBytes: savings, skippedByReason: reasons,
    compactedCount: 0, attemptedCount: 0, savedBytes: 0, backup: null, outcomeUnknown: false } };
}

/** Default dry run. Never deletes a claim/file, extends TTL, or changes a business result. */
function compactDashboardPhotoUploadClaims(input) {
  input = input || {};
  if (typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(function(key) { return ['execute', 'expectedSnapshotHash'].indexOf(key) < 0; })
      || (input.execute !== undefined && typeof input.execute !== 'boolean'))
    return { ok: false, reason: 'invalid_input' };
  var execute = input.execute === true;
  if (execute && !/^[a-f0-9]{64}$/.test(input.expectedSnapshotHash || '')) return { ok: false, reason: 'snapshot_hash_required' };
  var lock = null, locked = false, output = { ok: false, dryRun: !execute, backup: null, compactedCount: 0, attemptedCount: 0, savedBytes: 0, outcomeUnknown: false };
  var stage = 'snapshot_read';
  try {
    if (execute) {
      stage = 'lock';lock = LockService.getScriptLock();locked = lock.tryLock(5000);
      if (!locked) { output.reason = 'busy'; return output; }
    }
    stage = 'snapshot_read';
    var props = PropertiesService.getScriptProperties(), records = dashboardPhotoClaimRecords_(props);
    var plan = dashboardPhotoClaimCompactionPlan_(records, Date.now());output = plan.metadata;output.dryRun = !execute;
    if (!execute) return output;
    if (output.snapshotHash !== input.expectedSnapshotHash) { output.ok = false;output.reason = 'snapshot_changed';return output; }
    if (!plan.candidates.length) return output;

    stage = 'backup_create';
    var payload = JSON.stringify({ format: 'dashboard-photo-claim-backup-v1', createdAt: new Date().toISOString(),
      snapshotHash: output.snapshotHash, records: records });
    output.backup = { fileId: null, payloadHash: dashboardPhotoClaimDigest_(payload), snapshotHash: output.snapshotHash,
      verified: false, creationOutcomeUnknown: false };
    var blob = Utilities.gzip(Utilities.newBlob(payload, 'application/json'), 'dashboard-photo-claims-' + Utilities.getUuid() + '.json.gz');
    output.backup.creationOutcomeUnknown = true;
    var file = DriveApp.createFile(blob);output.backup.fileId = file.getId();
    output.backup.creationOutcomeUnknown = false;
    stage = 'backup_private';file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
    var savedFile = DriveApp.getFileById(output.backup.fileId);
    if (savedFile.getSharingAccess() !== DriveApp.Access.PRIVATE || savedFile.getEditors().length || savedFile.getViewers().length)
      throw new Error('backup_not_private');
    stage = 'backup_verify';
    var readback = Utilities.ungzip(savedFile.getBlob()).getDataAsString('UTF-8');
    if (readback !== payload || dashboardPhotoClaimDigest_(readback) !== output.backup.payloadHash) throw new Error('backup_mismatch');
    output.backup.verified = true;

    stage = 'snapshot_cas';
    if (dashboardPhotoClaimDigest_(JSON.stringify(dashboardPhotoClaimRecords_(props))) !== output.snapshotHash) {
      output.ok = false;output.reason = 'snapshot_changed';return output;
    }
    for (var i = 0; i < plan.candidates.length; i++) {
      var candidate = plan.candidates[i];stage = 'claim_cas';
      if (props.getProperty(candidate.key) !== candidate.before) { output.ok = false;output.reason = 'claim_changed';return output; }
      stage = 'claim_write';output.attemptedCount++;
      try { props.setProperty(candidate.key, candidate.after); } catch (writeError) { /* Exact readback decides; no write retry. */ }
      stage = 'claim_readback';
      var actual = props.getProperty(candidate.key);
      if (actual !== candidate.after) {
        output.ok = false;output.reason = actual === candidate.before ? 'write_unconfirmed' : 'claim_changed';
        output.outcomeUnknown = actual !== candidate.before;return output;
      }
      output.compactedCount++;output.savedBytes += candidate.savedBytes;
    }
    return output;
  } catch (error) {
    output.ok = false;output.reason = stage + '_failed';
    if (stage === 'claim_readback') output.outcomeUnknown = true;
    return output;
  } finally { if (locked) try { lock.releaseLock(); } catch (releaseError) {} }
}
