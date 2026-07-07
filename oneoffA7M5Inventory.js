// Temporary one-off route for 2026-07-06: add A7M5/OSEE inventory master rows.
// Safe/idempotent: appends only when the exact equipment name is absent.
function oneoffA7M5Inventory_(params) {
  params = params || {};
  var dryRun = String(params.dryRun || params.dry || "").toLowerCase() === "1" ||
    String(params.dryRun || params.dry || "").toLowerCase() === "true";
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var equipSheet = ss.getSheetByName("장비마스터");
  if (!equipSheet) throw new Error("장비마스터 시트 없음");

  var targets = [
    {
      prefix: "CAM",
      row: ["카메라/렌즈", "", "카메라", "소니 A7M5 바디(케이지)", 1, 1, 0, 0, "정상", "홈페이지 신규 등록 기반 추가(2026-07-06)", 1, 40000, ""]
    },
    {
      prefix: "MON",
      row: ["기타", "", "모니터", "OSEE MEGA22S4", 1, 1, 0, 0, "정상", "홈페이지 신규 등록 기반 추가(2026-07-06)", 1, 40000, ""]
    }
  ];

  var lastRow = equipSheet.getLastRow();
  var data = lastRow >= 2 ? equipSheet.getRange(2, 1, lastRow - 1, 13).getValues() : [];
  var existingByName = {};
  var maxByPrefix = {};
  for (var i = 0; i < data.length; i++) {
    var id = String(data[i][1] || "").trim();
    var name = String(data[i][3] || "").trim();
    if (name) existingByName[name] = { row: i + 2, id: id, data: data[i] };
    var m = id.match(/^([A-Z]+)-(\d+)$/);
    if (m) {
      var p = m[1];
      var n = Number(m[2]) || 0;
      maxByPrefix[p] = Math.max(maxByPrefix[p] || 0, n);
    }
  }

  var result = { ok: true, dryRun: dryRun, appended: [], existing: [], planned: [] };
  targets.forEach(function(target) {
    var name = target.row[3];
    if (existingByName[name]) {
      result.existing.push({ name: name, row: existingByName[name].row, id: existingByName[name].id });
      return;
    }
    var nextNum = (maxByPrefix[target.prefix] || 0) + 1;
    maxByPrefix[target.prefix] = nextNum;
    var row = target.row.slice();
    row[1] = target.prefix + "-" + String(nextNum).padStart(3, "0");
    result.planned.push(row.slice());
    if (!dryRun) {
      var appendRow = equipSheet.getLastRow() + 1;
      equipSheet.getRange(appendRow, 1, 1, row.length).setValues([row]);
      result.appended.push({ name: name, row: appendRow, id: row[1], values: row });
    }
  });
  SpreadsheetApp.flush();
  if (!dryRun && result.appended.length) {
    try { result.syncAuditFromMaster = syncAuditFromMaster() || "완료"; } catch (e) { result.syncAuditFromMasterError = e.message; }
  }
  return result;
}
