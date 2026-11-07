/** Move growing operational records out of the shared settings quota. */
var OPERATIONAL_PROPERTY_STORE_KEY_ = 'OPERATIONS_RECORDS_STORE_V1';
var OPERATIONAL_PROPERTY_GROUPS_ = ['inventory', 'photos', 'receipts'];
var OPERATIONAL_PROPERTY_HEADER_ = ['key', 'encoded_value'];
var OPERATIONAL_PROPERTY_BUILD_ = 'sheet-records-v1';

function operationalPropertyGroup_(key) {
  if (/^preRegStock_v1_(?:dirty|checked|state|registering|registered|predecessor)_RQ-\d{6}-\d{3}$/.test(key) ||
      /^inventoryStock(?:Question|Retired)_[A-Za-z0-9-]{8,80}$/.test(key)) return 'inventory';
  if (/^dashboardPhotoUpload_v2_[A-Za-z0-9_-]{1,80}$/.test(key)) return 'photos';
  if (/^historicalDiscountRestore_v1_\d{6}-\d{3}$/.test(key)) return 'receipts';
  return null;
}

function operationalPropertyConfig_(base) {
  var text = base.getProperty(OPERATIONAL_PROPERTY_STORE_KEY_);
  if (!text) return null;
  var config = JSON.parse(text);
  if (config.version !== 1 || !/^[A-Za-z0-9_-]{20,100}$/.test(config.fileId || '') ||
      !Number.isSafeInteger(config.readyAt) || config.readyAt <= 0) {
    throw new Error('Operational record storage configuration is invalid');
  }
  return config;
}

function operationalPropertySheet_(config, group) {
  var sheet = SpreadsheetApp.openById(config.fileId).getSheetByName(group);
  if (!sheet || JSON.stringify(sheet.getRange(1, 1, 1, 2).getValues()[0]) !== JSON.stringify(OPERATIONAL_PROPERTY_HEADER_)) {
    throw new Error('Operational record storage sheet is missing or invalid');
  }
  return sheet;
}

function operationalPropertyDecode_(encoded) {
  if (encoded === '') return null;
  if (typeof encoded !== 'string' || encoded.indexOf('v:') !== 0) {
    throw new Error('Operational record encoding is invalid');
  }
  return encoded.slice(2);
}

function operationalPropertyRow_(sheet, key) {
  var count = sheet.getLastRow() - 1;
  if (count <= 0) return 0;
  var matches = sheet.getRange(2, 1, count, 1).createTextFinder(key)
    .matchEntireCell(true).matchCase(true).findAll();
  if (matches.length > 1) throw new Error('Duplicate operational record key');
  return matches.length ? matches[0].getRow() : 0;
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
  return records;
}

function operationalPropertyWriteRow_(sheet, row, key, value) {
  var encoded = value === null ? '' : 'v:' + value;
  row = row || sheet.getLastRow() + 1;
  var maxRows = sheet.getMaxRows();
  if (row > maxRows) sheet.insertRowsAfter(maxRows, Math.max(200, row - maxRows));
  var cells = sheet.getRange(row, 1, 1, 2);
  cells.setValues([[key, encoded]]);
  SpreadsheetApp.flush();
  var actual = cells.getValues()[0];
  if (actual[0] !== key || actual[1] !== encoded) throw new Error('Operational record write could not be verified');
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
  base = base || PropertiesService.getScriptProperties();
  var openedSheet, openedId;
  function sheetFor(config) {
    if (!openedSheet || openedId !== config.fileId) {
      openedSheet = operationalPropertySheet_(config, group);
      openedId = config.fileId;
    }
    return openedSheet;
  }
  function change(key, value) {
    if (operationalPropertyGroup_(key) !== group || !operationalPropertyConfig_(base)) {
      return value === null ? base.deleteProperty(key) : base.setProperty(key, value);
    }
    return operationalPropertyWithLock_(function() {
      var config = operationalPropertyConfig_(base);
      if (!config || Date.now() < config.readyAt) {
        return value === null ? base.deleteProperty(key) : base.setProperty(key, value);
      }
      // A legacy value stays authoritative until its exact copy has been verified.
      if (value !== null && base.getProperty(key) !== null) return base.setProperty(key, value);
      var sheet = sheetFor(config);
      var row = operationalPropertyRow_(sheet, key);
      if (row || value !== null) operationalPropertyWriteRow_(sheet, row, key, value);
      if (value === null) base.deleteProperty(key);
    });
  }
  return {
    getProperty: function(key) {
      var legacy = base.getProperty(key);
      if (legacy !== null || operationalPropertyGroup_(key) !== group) return legacy;
      var config = operationalPropertyConfig_(base);
      if (!config || Date.now() < config.readyAt) return null;
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
      var config = operationalPropertyConfig_(base);
      if (!config || Date.now() < config.readyAt) return legacy;
      var records = operationalPropertySheetRows_(sheetFor(config), group);
      Object.keys(records).forEach(function(key) {
        if (!Object.prototype.hasOwnProperty.call(legacy, key) && records[key].value !== null) {
          legacy[key] = records[key].value;
        }
      });
      return legacy;
    },
    setProperties: function(values, deleteOthers) {
      if (deleteOthers) throw new Error('Operational record stores cannot replace all properties');
      if (!operationalPropertyConfig_(base)) return base.setProperties(values, false);
      var markers = {}, records = [];
      Object.keys(values).forEach(function(key) {
        if (operationalPropertyGroup_(key) === group) records.push(key);
        else markers[key] = values[key];
      });
      if (Object.keys(markers).length) base.setProperties(markers, false);
      records.forEach(function(key) { change(key, String(values[key])); });
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

function getOperationalPropertyStorageStatus() {
  var base = PropertiesService.getScriptProperties();
  var config = operationalPropertyConfig_(base), snapshot = operationalPropertyLegacySnapshot_(base);
  return { build: OPERATIONAL_PROPERTY_BUILD_, mode: !config ? 'legacy' : Date.now() < config.readyAt ? 'staged' : 'sheet',
    readyAt: config && new Date(config.readyAt).toISOString(), legacyCount: snapshot.entries.length,
    legacyBytesByGroup: snapshot.bytesByGroup, snapshotHash: snapshot.snapshotHash };
}

/** Internal rollout endpoint. Call from the published version, then wait out earlier executions. */
function prepareOperationalPropertyStorage() {
  var base = PropertiesService.getScriptProperties();
  return operationalPropertyWithLock_(function() {
    if (operationalPropertyConfig_(base)) return getOperationalPropertyStorageStatus();
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
  var base = PropertiesService.getScriptProperties(), inputLock = LockService.getUserLock();
  inputLock.waitLock(10000);
  try {
    return operationalPropertyWithLock_(function() {
      var config = operationalPropertyConfig_(base);
      if (!config || Date.now() < config.readyAt) throw new Error('Operational record storage is not ready');
      var snapshot = operationalPropertyLegacySnapshot_(base);
      if (snapshot.snapshotHash !== input.expectedSnapshotHash) throw new Error('Operational record migration snapshot changed');
      var batch = snapshot.entries.slice(0, 150), moved = 0;
      OPERATIONAL_PROPERTY_GROUPS_.forEach(function(group) {
        var entries = batch.filter(function(entry) { return operationalPropertyGroup_(entry[0]) === group; });
        if (!entries.length) return;
        var sheet = operationalPropertySheet_(config, group);
        var records = operationalPropertySheetRows_(sheet, group);
        var append = [];
        entries.forEach(function(entry) {
          var existing = records[entry[0]];
          if (!existing) append.push([entry[0], 'v:' + entry[1]]);
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
      return Object.assign({ moved: moved }, getOperationalPropertyStorageStatus());
    });
  } finally { inputLock.releaseLock(); }
}
