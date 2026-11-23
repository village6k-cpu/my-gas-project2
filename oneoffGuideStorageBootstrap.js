/** Temporary owner-run maintenance. Archive one unused health summary before staging guide storage. */
function bootstrapGuideStorageFromArchivedHealth() {
  return operationalPropertyWithLock_(function() {
    var props = PropertiesService.getScriptProperties();
    var config = operationalPropertyConfig_(props);
    if (!config) throw new Error('Existing private operational storage is required');
    if (config.guideDeliveryReadyAt) return getOperationalPropertyStorageStatus();
    var key = 'GUIDE_SAFETY_HEALTH';
    var raw = props.getProperty(key);
    if (raw === null) throw new Error('Unused health summary is unavailable; no other properties were changed');
    var book = SpreadsheetApp.openById(config.fileId);
    var sheet = book.getSheetByName('maintenance_backups');
    if (!sheet) {
      sheet = book.insertSheet('maintenance_backups');
      sheet.getRange(1, 1, 1, 2).setValues([OPERATIONAL_PROPERTY_HEADER_]);
    }
    if (JSON.stringify(sheet.getRange(1, 1, 1, 2).getValues()[0]) !== JSON.stringify(OPERATIONAL_PROPERTY_HEADER_)) {
      throw new Error('Maintenance backup schema is invalid');
    }
    var backupKey = 'guide-storage-bootstrap-20261123:' + key;
    var row = operationalPropertyRow_(sheet, backupKey);
    operationalPropertyWriteRow_(sheet, row, backupKey, raw);
    if (props.getProperty(key) !== raw) throw new Error('Health summary changed during archival');
    props.deleteProperty(key);
    if (props.getProperty(key) !== null) throw new Error('Archived health summary removal was not verified');
    var result = prepareOperationalPropertyStorage();
    return { archivedKey: key, backupVerified: true, storage: result };
  });
}
