// Temporary one-off route for 2026-07-06: add A7M5 body set to 세트마스터.
// Safe/idempotent: appends only when the exact target set name is absent.
function oneoffA7M5SetMaster_(params) {
  params = params || {};
  var dryRun = String(params.dryRun || params.dry || "").toLowerCase() === "1" ||
    String(params.dryRun || params.dry || "").toLowerCase() === "true";

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var setSheet = ss.getSheetByName("세트마스터");
  var equipSheet = ss.getSheetByName("장비마스터");
  if (!setSheet) throw new Error("세트마스터 시트 없음");

  var sourceName = "소니 A7S3 바디세트";
  var sourceBody = "소니 A7S3 바디(케이지)";
  var targetName = "소니 A7M5 바디세트";
  var targetBody = "소니 A7M5 바디(케이지)";

  var lastRow = setSheet.getLastRow();
  var data = lastRow >= 2 ? setSheet.getRange(2, 1, lastRow - 1, 7).getValues() : [];
  var sourceRows = [];
  var sourceRowNumbers = [];
  var existingTargetRows = [];

  for (var i = 0; i < data.length; i++) {
    var setName = String(data[i][0] || "").trim();
    if (setName === sourceName) {
      var row = data[i].slice();
      row[0] = targetName;
      if (String(row[1] || "").trim() === sourceBody) row[1] = targetBody;
      sourceRows.push(row);
      sourceRowNumbers.push(i + 2);
    }
    if (setName === targetName) existingTargetRows.push(i + 2);
  }
  if (!sourceRows.length) throw new Error(sourceName + " 원본 행을 찾을 수 없음");

  var bodyExists = false;
  var bodyInfo = null;
  if (equipSheet && equipSheet.getLastRow() >= 2) {
    var equipData = equipSheet.getRange(2, 1, equipSheet.getLastRow() - 1, 13).getValues();
    for (var e = 0; e < equipData.length; e++) {
      if (String(equipData[e][3] || "").trim() === targetBody) {
        bodyExists = true;
        bodyInfo = {
          row: e + 2,
          id: equipData[e][1],
          total: equipData[e][4],
          status: equipData[e][8]
        };
        break;
      }
    }
  }

  var result = {
    ok: true,
    dryRun: dryRun,
    sourceName: sourceName,
    targetName: targetName,
    targetBody: targetBody,
    sourceRowNumbers: sourceRowNumbers,
    plannedRows: sourceRows,
    existingTargetRows: existingTargetRows,
    appended: false,
    startRow: null,
    bodyExistsInEquipmentMaster: bodyExists,
    bodyInfo: bodyInfo
  };

  if (existingTargetRows.length) {
    result.message = "이미 존재해서 추가 생략";
    return result;
  }
  if (dryRun) {
    result.message = "dry-run: append 생략";
    return result;
  }

  var startRow = setSheet.getLastRow() + 1;
  // Copy source formatting when source rows are contiguous; if not, values are still enough.
  try {
    if (sourceRowNumbers.length && sourceRowNumbers[sourceRowNumbers.length - 1] - sourceRowNumbers[0] + 1 === sourceRowNumbers.length) {
      setSheet.getRange(sourceRowNumbers[0], 1, sourceRowNumbers.length, 7)
        .copyTo(setSheet.getRange(startRow, 1, sourceRows.length, 7), { formatOnly: true });
    }
  } catch (fmtErr) {
    result.formatCopyWarning = fmtErr.message;
  }
  setSheet.getRange(startRow, 1, sourceRows.length, 7).setValues(sourceRows);
  result.appended = true;
  result.startRow = startRow;

  try {
    var refreshResult = refreshEquipmentList();
    result.refreshEquipmentList = refreshResult || "완료";
  } catch (refreshErr) {
    result.refreshEquipmentListError = refreshErr.message;
  }
  try {
    var syncResult = syncTemplateMasterFromSetMaster();
    result.syncTemplateMasterFromSetMaster = syncResult || "완료";
  } catch (syncErr) {
    result.syncTemplateMasterFromSetMasterError = syncErr.message;
  }

  return result;
}
