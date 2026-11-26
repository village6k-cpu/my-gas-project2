/** Move growing operational records out of the shared settings quota. */
var OPERATIONAL_PROPERTY_STORE_KEY_ = 'OPERATIONS_RECORDS_STORE_V1';
var OPERATIONAL_PROPERTY_GROUPS_ = ['inventory', 'photos', 'receipts', 'runtime'];
var OPERATIONAL_PROPERTY_HEADER_ = ['key', 'encoded_value'];
var OPERATIONAL_PROPERTY_BUILD_ = 'sheet-records-v3-all-operations';
var OPERATIONAL_PROPERTY_SHEETS_ = Object.create(null);
var OPERATIONAL_PROPERTY_ROWS_ = new WeakMap();
var OPERATIONAL_PROPERTY_PAYLOADS_ = Object.create(null);
var OPERATIONAL_PROPERTY_MIGRATION_HEADER_ = ['created_at', 'source_snapshot', 'batch_hash', 'record_count', 'backup_file_id', 'payload_hash', 'state'];

function operationalPropertyGroup_(key) {
  if (typeof key !== 'string' || !key) return null;
  if (villagePropertyIsSetting_(key)) return null;
  var probe = key.match(/^operationalStorageProbe_v1_(inventory|photos|receipts|runtime)_[A-Za-z0-9-]{8,80}$/);
  if (probe) return probe[1];
  if (/^preRegStock_v1_(?:dirty|checked|state|registering|registered|predecessor)_RQ-\d{6}-\d{3}$/.test(key) ||
      /^inventoryStock(?:Question|Retired)_[A-Za-z0-9-]{8,80}$/.test(key)) return 'inventory';
  if (/^dashboardPhotoUpload_v2_[A-Za-z0-9_-]{1,80}$/.test(key)) return 'photos';
  if (/^GUIDE_DELIVERY_V3_(?:out|in)_\d{6}_\d{3}$/.test(key)) return 'receipts';
  if (/^(?:historicalDiscountRestore|bookingConfirmationAlimtalk)_v1_\d{6}-\d{3}$/.test(key)) return 'receipts';
  return 'runtime';
}

function operationalPropertyConfig_(base) {
  var text = base.getProperty(OPERATIONAL_PROPERTY_STORE_KEY_);
  if (!text) return null;
  var config = JSON.parse(text);
  if (config.version !== 1 || !/^[A-Za-z0-9_-]{20,100}$/.test(config.fileId || '') ||
      !Number.isSafeInteger(config.readyAt) || config.readyAt <= 0 ||
      (config.guideDeliveryReadyAt !== undefined &&
        (!Number.isSafeInteger(config.guideDeliveryReadyAt) || config.guideDeliveryReadyAt <= 0)) ||
      (config.runtimeReadyAt !== undefined &&
        (!Number.isSafeInteger(config.runtimeReadyAt) || config.runtimeReadyAt <= 0)) ||
      (config.runtimeLegacyClearedAt !== undefined &&
        (!Number.isSafeInteger(config.runtimeLegacyClearedAt) || config.runtimeLegacyClearedAt <= 0))) {
    throw new Error('Operational record storage configuration is invalid');
  }
  return config;
}

function operationalPropertyReady_(config, key) {
  if (!config || Date.now() < config.readyAt) return false;
  if (operationalPropertyGroup_(key) === 'runtime') return villagePropertyRuntimeReady_(config);
  // Existing groups are already live. Stage only the newly routed guide readers/writers.
  return !/^GUIDE_DELIVERY_V3_/.test(key) ||
    !!config.guideDeliveryReadyAt && Date.now() >= config.guideDeliveryReadyAt;
}

function operationalPropertySheet_(config, group) {
  var cacheKey = config.fileId + ':' + group;
  if (OPERATIONAL_PROPERTY_SHEETS_[cacheKey]) return OPERATIONAL_PROPERTY_SHEETS_[cacheKey];
  var sheet = SpreadsheetApp.openById(config.fileId).getSheetByName(group);
  if (!sheet || JSON.stringify(sheet.getRange(1, 1, 1, 2).getValues()[0]) !== JSON.stringify(OPERATIONAL_PROPERTY_HEADER_)) {
    throw new Error('Operational record storage sheet is missing or invalid');
  }
  OPERATIONAL_PROPERTY_SHEETS_[cacheKey] = sheet;
  return sheet;
}

function operationalPropertyDecode_(encoded) {
  if (encoded === '') return null;
  if (typeof encoded === 'string' && /^f:[A-Za-z0-9_-]{10,100}:[a-f0-9]{64}$/.test(encoded)) {
    if (Object.prototype.hasOwnProperty.call(OPERATIONAL_PROPERTY_PAYLOADS_, encoded)) return OPERATIONAL_PROPERTY_PAYLOADS_[encoded];
    var parts = encoded.split(':'), file = DriveApp.getFileById(parts[1]);
    operationalPropertyPrivateFile_(file);
    var text = file.getBlob().getDataAsString('UTF-8');
    if (dashboardPhotoClaimDigest_(text) !== parts[2]) throw new Error('Operational payload hash mismatch');
    OPERATIONAL_PROPERTY_PAYLOADS_[encoded] = text;
    return text;
  }
  if (typeof encoded !== 'string' || encoded.indexOf('v:') !== 0) {
    throw new Error('Operational record encoding is invalid');
  }
  return encoded.slice(2);
}

function operationalPropertyPrivateFile_(file) {
  if (file.getSharingAccess() !== DriveApp.Access.PRIVATE || file.getEditors().length || file.getViewers().length) {
    throw new Error('Operational record files must be private');
  }
}

/** Large values use verified private files, never a cell-size or settings-size fallback. */
function operationalPropertyEncode_(value) {
  if (value === null) return '';
  if (value.length <= 40000) return 'v:' + value;
  var file = DriveApp.createFile(Utilities.newBlob(value, 'text/plain', 'VILLAGE-operation-' + Utilities.getUuid() + '.txt'));
  file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
  operationalPropertyPrivateFile_(file);
  var encoded = 'f:' + file.getId() + ':' + dashboardPhotoClaimDigest_(value);
  if (operationalPropertyDecode_(encoded) !== value) throw new Error('Operational payload readback mismatch');
  return encoded;
}

function operationalPropertyRow_(sheet, key) {
  var known = OPERATIONAL_PROPERTY_ROWS_.get(sheet);
  if (known && known[key] && sheet.getRange(known[key], 1).getValue() === key) return known[key];
  var count = sheet.getLastRow() - 1;
  if (count <= 0) return 0;
  var matches = sheet.getRange(2, 1, count, 1).createTextFinder(key)
    .matchEntireCell(true).matchCase(true).findAll();
  if (matches.length > 1) throw new Error('Duplicate operational record key');
  var row = matches.length ? matches[0].getRow() : 0;
  if (row) {
    if (!known) { known = Object.create(null); OPERATIONAL_PROPERTY_ROWS_.set(sheet, known); }
    known[key] = row;
  }
  return row;
}

function operationalPropertySheetRows_(sheet, group) {
  var count = sheet.getLastRow() - 1;
  var records = Object.create(null);
  if (count <= 0) return records;
  sheet.getRange(2, 1, count, 2).getValues().forEach(function(row, index) {
    var key = row[0];
    if (operationalPropertyGroup_(key) !== group || Object.prototype.hasOwnProperty.call(records, key)) {
      throw new Error('Invalid or duplicate operational record key');
    }
    records[key] = { row: index + 2, value: operationalPropertyDecode_(row[1]) };
  });
  var known = Object.create(null);
  Object.keys(records).forEach(function(key) { known[key] = records[key].row; });
  OPERATIONAL_PROPERTY_ROWS_.set(sheet, known);
  return records;
}

function operationalPropertyWriteRow_(sheet, row, key, value) {
  operationalPropertyWriteBatch_(sheet, [{ row: row, key: key, value: value }]);
}

function operationalPropertyWriteBatch_(sheet, changes) {
  if (!changes.length) return;
  var nextRow = sheet.getLastRow() + 1;
  changes = changes.map(function(change) {
    return { row: change.row || nextRow++, key: change.key, encoded: operationalPropertyEncode_(change.value) };
  }).sort(function(a, b) { return a.row - b.row; });
  var last = changes[changes.length - 1].row, maxRows = sheet.getMaxRows();
  if (last > maxRows) sheet.insertRowsAfter(maxRows, Math.max(200, last - maxRows));
  var chunks = [];
  changes.forEach(function(change) {
    var prior = chunks[chunks.length - 1];
    if (!prior || prior.row + prior.values.length !== change.row) {
      prior = { row: change.row, values: [] }; chunks.push(prior);
    }
    prior.values.push([change.key, change.encoded]);
  });
  chunks.forEach(function(chunk) { sheet.getRange(chunk.row, 1, chunk.values.length, 2).setValues(chunk.values); });
  SpreadsheetApp.flush();
  chunks.forEach(function(chunk) {
    if (JSON.stringify(sheet.getRange(chunk.row, 1, chunk.values.length, 2).getValues()) !== JSON.stringify(chunk.values)) {
      throw new Error('Operational record write could not be verified');
    }
  });
  var known = OPERATIONAL_PROPERTY_ROWS_.get(sheet) || Object.create(null);
  changes.forEach(function(change) { known[change.key] = change.row; });
  OPERATIONAL_PROPERTY_ROWS_.set(sheet, known);
}

function operationalPropertyWithLock_(fn) {
  var lock = LockService.getScriptLock();
  var owned = !lock.hasLock();
  if (owned) lock.waitLock(10000);
  try { return fn(); }
  finally { if (owned) lock.releaseLock(); }
}

/** Existing lock/lease protocols still own booking, relay, and upload state transitions. */
function operationalPropertyStore_(group, base) {
  base = base || villageRawProperties_();
  base = base.__villageRawStore || base;
  var openedSheet, openedId, storeConfig, storeConfigRead = false;
  function configuration() {
    if (!storeConfigRead) { storeConfig = operationalPropertyConfig_(base); storeConfigRead = true; }
    return storeConfig;
  }
  function sheetFor(config) {
    if (!openedSheet || openedId !== config.fileId) {
      openedSheet = operationalPropertySheet_(config, group);
      openedId = config.fileId;
    }
    return openedSheet;
  }
  function change(key, value) {
    if (operationalPropertyGroup_(key) !== group && villagePropertyRuntimeReady_(configuration())) {
      var unified = villageScriptProperties_();
      return value === null ? unified.deleteProperty(key) : unified.setProperty(key, value);
    }
    if (operationalPropertyGroup_(key) !== group || !configuration()) {
      return value === null ? base.deleteProperty(key) : base.setProperty(key, value);
    }
    return operationalPropertyWithLock_(function() {
      var config = configuration();
      if (!operationalPropertyReady_(config, key)) {
        return value === null ? base.deleteProperty(key) : base.setProperty(key, value);
      }
      // A legacy value stays authoritative until its exact copy has been verified.
      if (value !== null && !config.runtimeLegacyClearedAt && base.getProperty(key) !== null) return base.setProperty(key, value);
      var sheet = sheetFor(config);
      var row = operationalPropertyRow_(sheet, key);
      if (row || value !== null) operationalPropertyWriteRow_(sheet, row, key, value);
      if (value === null && !config.runtimeLegacyClearedAt) base.deleteProperty(key);
    });
  }
  return {
    getProperty: function(key) {
      var config = configuration();
      if (operationalPropertyGroup_(key) !== group && villagePropertyRuntimeReady_(config)) {
        return villageScriptProperties_().getProperty(key);
      }
      var legacy = config && config.runtimeLegacyClearedAt ? null : base.getProperty(key);
      if (legacy !== null || operationalPropertyGroup_(key) !== group) return legacy;
      if (!operationalPropertyReady_(config, key)) return null;
      var sheet = sheetFor(config);
      var row = operationalPropertyRow_(sheet, key);
      if (!row) return null;
      var value = operationalPropertyDecode_(sheet.getRange(row, 2).getValue());
      // Match the existing 24-hour upload replay lifetime; keep the durable record for audit.
      if (group === 'photos' && value !== null) {
        var photo = JSON.parse(value);
        if (!photo || !photo.at || Date.now() - Number(photo.at) > 86400000) return null;
      }
      return value;
    },
    setProperty: function(key, value) { return change(key, String(value)); },
    deleteProperty: function(key) { return change(key, null); },
    getProperties: function() {
      var legacy = base.getProperties();
      var config = configuration();
      if (!config || Date.now() < config.readyAt) return legacy;
      if (villagePropertyRuntimeReady_(config)) return villagePropertyReadAll_(base, config);
      var records = operationalPropertySheetRows_(sheetFor(config), group);
      Object.keys(records).forEach(function(key) {
        if (operationalPropertyReady_(config, key) &&
            !Object.prototype.hasOwnProperty.call(legacy, key) && records[key].value !== null) {
          legacy[key] = records[key].value;
        }
      });
      return legacy;
    },
    setProperties: function(values, deleteOthers) {
      if (deleteOthers) throw new Error('Operational record stores cannot replace all properties');
      if (!configuration()) return base.setProperties(values, false);
      var markers = {}, records = [];
      Object.keys(values).forEach(function(key) {
        if (operationalPropertyGroup_(key) === group) records.push(key);
        else markers[key] = values[key];
      });
      if (Object.keys(markers).length) {
        if (villagePropertyRuntimeReady_(configuration())) villageScriptProperties_().setProperties(markers, false);
        else base.setProperties(markers, false);
      }
      if (records.length) operationalPropertyWithLock_(function() {
        var config = configuration(), pending = {}, changes = [], sheet;
        records.forEach(function(key) {
          if (!operationalPropertyReady_(config, key) || (!config.runtimeLegacyClearedAt && base.getProperty(key) !== null)) pending[key] = String(values[key]);
          else {
            sheet = sheet || sheetFor(config);
            changes.push({ row: operationalPropertyRow_(sheet, key), key: key, value: String(values[key]) });
          }
        });
        if (Object.keys(pending).length) base.setProperties(pending, false);
        if (changes.length) operationalPropertyWriteBatch_(sheet, changes);
      });
    }
  };
}

function operationalPropertyLegacySnapshot_(base) {
  var all = base.getProperties(), entries = [], bytesByGroup = {};
  Object.keys(all).sort().forEach(function(key) {
    var group = operationalPropertyGroup_(key);
    if (!group) return;
    entries.push([key, all[key]]);
    bytesByGroup[group] = (bytesByGroup[group] || 0) + Utilities.newBlob(key + all[key]).getBytes().length;
  });
  return { entries: entries, bytesByGroup: bytesByGroup,
    snapshotHash: dashboardPhotoClaimDigest_(JSON.stringify(entries)) };
}

function getOperationalPropertyStorageStatus(input) {
  var base = villageRawProperties_();
  var config = operationalPropertyConfig_(base), snapshot = operationalPropertyLegacySnapshot_(base);
  var all = base.getProperties(), settings = [], settingBytes = 0, namespaces = {};
  Object.keys(all).forEach(function(key) {
    if (villagePropertyIsSetting_(key)) {
      settings.push(key); settingBytes += Utilities.newBlob(key + all[key]).getBytes().length;
    } else {
      var family = key.replace(/(?:RQ-)?\d{6}.*$/, '*').replace(/[a-f0-9-]{16,}$/i, '*');
      namespaces[family] = (namespaces[family] || 0) + 1;
    }
  });
  return { build: OPERATIONAL_PROPERTY_BUILD_, mode: !config ? 'legacy' : Date.now() < config.readyAt ? 'staged' : 'sheet',
    guideDeliveryMode: !config || !config.guideDeliveryReadyAt ? 'legacy'
      : operationalPropertyReady_(config, 'GUIDE_DELIVERY_V3_out_000000_000') ? 'sheet' : 'staged',
    runtimeMode: !config || !config.runtimeReadyAt ? 'legacy' : villagePropertyRuntimeReady_(config) ? 'sheet' : 'staged',
    runtimeReadyAt: config && config.runtimeReadyAt ? new Date(config.runtimeReadyAt).toISOString() : null,
    runtimeLegacyClearedAt: config && config.runtimeLegacyClearedAt ? new Date(config.runtimeLegacyClearedAt).toISOString() : null,
    guideDeliveryReadyAt: config && config.guideDeliveryReadyAt ? new Date(config.guideDeliveryReadyAt).toISOString() : null,
    readyAt: config && new Date(config.readyAt).toISOString(), legacyCount: snapshot.entries.length,
    legacyBytesByGroup: snapshot.bytesByGroup, snapshotHash: snapshot.snapshotHash,
    settings: { count: settings.length, totalBytes: settingBytes, keys: settings.sort() },
    legacyNamespaces: namespaces, otherStores: operationalPropertyOtherStoresAudit_(),
    nonce: input ? String(input.nonce || '').slice(0, 100) : '' };
}

/** Owner-context metadata only. Document pointers are control configuration, not review payloads. */
function operationalPropertyOtherStoresAudit_() {
  var result = {};
  ['document', 'user'].forEach(function(scope) {
    var method = scope === 'document' ? 'getDocumentProperties' : 'getUserProperties';
    var entry = result[scope] = { available: false, readable: false, operationalCount: null, keys: [] };
    if (typeof PropertiesService[method] !== 'function') return;
    var store = PropertiesService[method]();
    if (!store) return;
    entry.available = true;
    var all = store.getProperties();
    entry.readable = true;
    entry.keys = Object.keys(all).sort();
    entry.operationalKeys = entry.keys.filter(function(key) {
      return !villagePropertyIsSetting_(key) && !(scope === 'document' && key === 'inventorySemanticStore_v1_bootstrap');
    });
    entry.operationalCount = entry.operationalKeys.length;
  });
  return result;
}

/** Internal rollout endpoint. Call from the published version, then wait out earlier executions. */
function prepareOperationalPropertyStorage() {
  var base = villageRawProperties_();
  return operationalPropertyWithLock_(function() {
    var existing = operationalPropertyConfig_(base);
    if (existing) {
      var existingBook = SpreadsheetApp.openById(existing.fileId);
      operationalPropertyPrivateFile_(DriveApp.getFileById(existing.fileId));
      if (!existingBook.getSheetByName('runtime')) {
        var runtimeSheet = existingBook.insertSheet('runtime');
        runtimeSheet.deleteColumns(3, runtimeSheet.getMaxColumns() - 2);
        runtimeSheet.getRange(1, 1, 1, 2).setValues([OPERATIONAL_PROPERTY_HEADER_]);
      }
      operationalPropertySheet_(existing, 'runtime');
      operationalPropertyMigrationSheet_(existing, true);
      var changed = false;
      if (!existing.guideDeliveryReadyAt) {
        existing.guideDeliveryReadyAt = Date.now() + 7 * 60000;
        changed = true;
      }
      if (!existing.runtimeReadyAt) { existing.runtimeReadyAt = Date.now() + 7 * 60000; changed = true; }
      if (changed) {
        var staged = JSON.stringify(existing);
        base.setProperty(OPERATIONAL_PROPERTY_STORE_KEY_, staged);
        if (base.getProperty(OPERATIONAL_PROPERTY_STORE_KEY_) !== staged) throw new Error('Operational storage activation was not verified');
      }
      return getOperationalPropertyStorageStatus();
    }
    var book = SpreadsheetApp.create('VILLAGE private operational records v1');
    var file = DriveApp.getFileById(book.getId());
    file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
    if (file.getSharingAccess() !== DriveApp.Access.PRIVATE || file.getEditors().length || file.getViewers().length) {
      throw new Error('Operational record spreadsheet must be private');
    }
    OPERATIONAL_PROPERTY_GROUPS_.forEach(function(group, index) {
      var sheet = index === 0 ? book.getSheets()[0].setName(group) : book.insertSheet(group);
      sheet.deleteColumns(3, sheet.getMaxColumns() - 2);
      sheet.getRange(1, 1, 1, 2).setValues([OPERATIONAL_PROPERTY_HEADER_]);
    });
    SpreadsheetApp.flush();
    var config = { version: 1, fileId: book.getId(), readyAt: Date.now() + 7 * 60000 };
    config.guideDeliveryReadyAt = config.readyAt;
    config.runtimeReadyAt = config.readyAt;
    operationalPropertyMigrationSheet_(config, true);
    OPERATIONAL_PROPERTY_GROUPS_.forEach(function(group) { operationalPropertySheet_(config, group); });
    var encoded = JSON.stringify(config);
    base.setProperty(OPERATIONAL_PROPERTY_STORE_KEY_, encoded);
    if (base.getProperty(OPERATIONAL_PROPERTY_STORE_KEY_) !== encoded) throw new Error('Operational record storage activation was not verified');
    return getOperationalPropertyStorageStatus();
  });
}

/** Copy and read back before removing any duplicate legacy value. Partial runs are resumable. */
function migrateOperationalProperties(input) {
  if (!input || !/^[a-f0-9]{64}$/.test(input.expectedSnapshotHash || '')) throw new Error('Exact migration snapshot required');
  var base = villageRawProperties_(), inputLock = LockService.getUserLock();
  inputLock.waitLock(10000);
  try {
    return operationalPropertyWithLock_(function() {
      var config = operationalPropertyConfig_(base);
      if (!config || Date.now() < config.readyAt) throw new Error('Operational record storage is not ready');
      var snapshot = operationalPropertyLegacySnapshot_(base);
      if (config.runtimeLegacyClearedAt && snapshot.entries.length) throw new Error('Unexpected legacy writer after operational cutover; preserve both copies for review');
      if (snapshot.entries.some(function(entry) { return !operationalPropertyReady_(config, entry[0]); })) {
        throw new Error('Operational record storage is not ready');
      }
      if (snapshot.snapshotHash !== input.expectedSnapshotHash) throw new Error('Operational record migration snapshot changed');
      var batch = snapshot.entries.slice(0, config.runtimeReadyAt ? 50 : 150), moved = 0;
      var backup = config.runtimeReadyAt && batch.length ? operationalPropertyBackupBatch_(config, batch, snapshot.snapshotHash) : null;
      OPERATIONAL_PROPERTY_GROUPS_.forEach(function(group) {
        var entries = batch.filter(function(entry) { return operationalPropertyGroup_(entry[0]) === group; });
        if (!entries.length) return;
        var sheet = operationalPropertySheet_(config, group);
        var records = operationalPropertySheetRows_(sheet, group);
        var append = [];
        entries.forEach(function(entry) {
          var existing = records[entry[0]];
          if (!existing) append.push([entry[0], operationalPropertyEncode_(entry[1])]);
          else if (existing.value !== entry[1]) {
            // Legacy is authoritative until migration removes its exact value.
            operationalPropertyWriteRow_(sheet, existing.row, entry[0], entry[1]);
          }
        });
        if (append.length) {
          var first = sheet.getLastRow() + 1, last = first + append.length - 1;
          if (last > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), last - sheet.getMaxRows());
          sheet.getRange(first, 1, append.length, 2).setValues(append);
        }
        SpreadsheetApp.flush();
        var verified = operationalPropertySheetRows_(sheet, group);
        entries.forEach(function(entry) {
          if (!verified[entry[0]] || verified[entry[0]].value !== entry[1]) throw new Error('Operational record migration readback mismatch');
          if (base.getProperty(entry[0]) !== entry[1]) throw new Error('Operational record changed during migration');
          base.deleteProperty(entry[0]);
          if (base.getProperty(entry[0]) !== null) throw new Error('Legacy operational record removal was not verified');
          moved++;
        });
      });
      if (backup) {
        var log = operationalPropertyMigrationSheet_(config, false);
        log.getRange(backup.row, 7).setValue('migrated:' + moved);
        SpreadsheetApp.flush();
        if (log.getRange(backup.row, 7).getValue() !== 'migrated:' + moved) throw new Error('Migration receipt verification failed');
      }
      if (config.runtimeReadyAt && villagePropertyRuntimeReady_(config) && operationalPropertyLegacySnapshot_(base).entries.length === 0 && !config.runtimeLegacyClearedAt) {
        config.runtimeLegacyClearedAt = Date.now();
        var completed = JSON.stringify(config);
        base.setProperty(OPERATIONAL_PROPERTY_STORE_KEY_, completed);
        if (base.getProperty(OPERATIONAL_PROPERTY_STORE_KEY_) !== completed) throw new Error('Operational cutover completion was not verified');
      }
      return Object.assign({ moved: moved, backup: backup }, getOperationalPropertyStorageStatus());
    });
  } finally { inputLock.releaseLock(); }
}

/** Non-business nonce records exercise each real writer and verify their cleanup. */
function probeOperationalPropertyStorage() {
  var base = villageRawProperties_(), config = operationalPropertyConfig_(base);
  if (!villagePropertyRuntimeReady_(config)) return { ok: false, reason: 'storage_not_ready' };
  return operationalPropertyWithLock_(function() {
    var props = villageScriptProperties_(), results = [], owned = [], reason = null;
    try {
      OPERATIONAL_PROPERTY_GROUPS_.forEach(function(group) {
        var key = 'operationalStorageProbe_v1_' + group + '_' + Utilities.getUuid();
        var value = JSON.stringify({ kind: 'storage-probe', at: Date.now(), group: group, nonce: Utilities.getUuid() });
        if (props.getProperty(key) !== null || base.getProperty(key) !== null) throw new Error('probe_key_collision');
        owned.push({ key: key, value: value, group: group });
        props.setProperty(key, value);
        if (props.getProperty(key) !== value || base.getProperty(key) !== null) throw new Error('probe_readback_mismatch');
        results.push({ group: group, write: 'verified', readback: 'matched' });
      });
    } catch (error) { reason = 'operational_write_not_verified'; }
    finally {
      owned.forEach(function(record) {
        var result = results.filter(function(row) { return row.group === record.group; })[0];
        if (!result) { result = { group: record.group, write: 'not_verified' }; results.push(result); }
        try {
          var actual = props.getProperty(record.key);
          if (actual === record.value) props.deleteProperty(record.key);
          result.cleanup = props.getProperty(record.key) === null && base.getProperty(record.key) === null ? 'deleted_verified' : 'not_verified';
        } catch (cleanupError) { result.cleanup = 'not_verified'; }
      });
    }
    var ok = !reason && results.length === OPERATIONAL_PROPERTY_GROUPS_.length &&
      results.every(function(row) { return row.write === 'verified' && row.cleanup === 'deleted_verified'; });
    return { ok: ok, groups: results, reason: reason, otherKeysDeleted: 0 };
  });
}

function operationalPropertyMigrationSheet_(config, create) {
  var book = SpreadsheetApp.openById(config.fileId), sheet = book.getSheetByName('property_migrations');
  if (!sheet && create) {
    sheet = book.insertSheet('property_migrations');
    sheet.getRange(1, 1, 1, 7).setValues([OPERATIONAL_PROPERTY_MIGRATION_HEADER_]);
  }
  if (!sheet || JSON.stringify(sheet.getRange(1, 1, 1, 7).getValues()[0]) !== JSON.stringify(OPERATIONAL_PROPERTY_MIGRATION_HEADER_)) {
    throw new Error('Operational migration log is missing or invalid');
  }
  return sheet;
}

/** Preserve an exact private recovery copy before removing any legacy operational value. */
function operationalPropertyBackupBatch_(config, entries, snapshotHash) {
  var createdAt = new Date().toISOString(), batchHash = dashboardPhotoClaimDigest_(JSON.stringify(entries));
  var text = JSON.stringify({ format: 'village-property-migration-v1', createdAt: createdAt,
    snapshotHash: snapshotHash, batchHash: batchHash, records: entries });
  var hash = dashboardPhotoClaimDigest_(text);
  var file = DriveApp.createFile(Utilities.gzip(Utilities.newBlob(text, 'application/json'), 'VILLAGE-property-backup-' + Utilities.getUuid() + '.json.gz'));
  file.setSharing(DriveApp.Access.PRIVATE, DriveApp.Permission.NONE);
  operationalPropertyPrivateFile_(file);
  var readback = Utilities.ungzip(file.getBlob()).getDataAsString('UTF-8');
  if (readback !== text || dashboardPhotoClaimDigest_(readback) !== hash) throw new Error('Operational backup verification failed');
  var sheet = operationalPropertyMigrationSheet_(config, false), row = sheet.getLastRow() + 1;
  if (row > sheet.getMaxRows()) sheet.insertRowsAfter(sheet.getMaxRows(), 200);
  var values = [[createdAt, snapshotHash, batchHash, entries.length, file.getId(), hash, 'backed_up']];
  sheet.getRange(row, 1, 1, 7).setValues(values);
  SpreadsheetApp.flush();
  if (JSON.stringify(sheet.getRange(row, 1, 1, 7).getValues()) !== JSON.stringify(values)) throw new Error('Operational backup receipt mismatch');
  return { fileId: file.getId(), hash: hash, count: entries.length, verified: true, row: row };
}
