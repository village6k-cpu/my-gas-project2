/**
 * ====================================================================
 * Code.gs — v3 (기존 코드 + 확인요청 트리거 통합)
 * ====================================================================
 *
 * 변경사항:
 * - 확인요청 H열(확인) / N열(등록) 드롭다운 트리거 추가
 * - handleScheduleEdit() 호출 (checkAvailability_v3.gs에 정의)
 *
 * ★ 이 파일 전체를 기존 Code.gs에 덮어쓰세요. ★
 */

function onEdit(e) {
  if (!e || !e.source) return;

  const sheet = e.source.getActiveSheet();
  const col = e.range.getColumn();
  const row = e.range.getRow();
  if (row === 1) return;

  // ─── 기존: 실사 기록 자동입력 ───
  if (sheet.getName() === "실사 기록") {
    if (col === 6 || col === 7) {
      const 현재실사 = sheet.getRange(row, 6).getValue();
      if (현재실사 !== "") {
        const email = Session.getActiveUser().getEmail().split("@")[0];
        sheet.getRange(row, 9).setValue(email);
        sheet.getRange(row, 10).setValue(new Date());
      } else {
        sheet.getRange(row, 9).setValue("");
        sheet.getRange(row, 10).setValue("");
      }
    }
  }

  // ─── 기존: 신규장비 추가 - 카테고리 입력 시 장비ID 자동생성 ───
  if (sheet.getName() === "신규장비 추가") {
    if (col === 2) {
      const 카테고리 = e.range.getValue();
      const 기존ID = sheet.getRange(row, 3).getValue();
      if (!카테고리 || 기존ID) return;

      const 카테고리PREFIX = {
        '카메라': 'CAM', '렌즈': 'LNS', '어댑터': 'ADP',
        '매트박스': 'MTB', '필터': 'FLT', '배터리': 'BAT',
        '리더기': 'RDR', '메모리': 'MEM', '삼각대': 'TRP',
        '카트': 'CRT', '모니터': 'MON', '무선': 'WRL',
        '로닌/짐벌': 'GBL', '오디오': 'AUD', '조명': 'LGT',
        '기타': 'ETC', '케이블': 'CBL'
      };

      const prefix = 카테고리PREFIX[카테고리] || 'ETC';
      const ss = e.source;
      const 마스터시트 = ss.getSheetByName("장비마스터");
      const 마스터lastRow = 마스터시트.getLastRow();
      const IDs = 마스터시트.getRange(2, 2, 마스터lastRow-1, 1).getValues()
        .flat()
        .filter(id => id && id.toString().startsWith(prefix));

      let maxNum = 0;
      IDs.forEach(id => {
        const num = parseInt(id.toString().split('-')[1]);
        if (num > maxNum) maxNum = num;
      });

      const newID = `${prefix}-${String(maxNum + 1).padStart(3, '0')}`;
      sheet.getRange(row, 3).setValue(newID);
    }
  }

  // ─── 신규: 확인요청 - 요청ID / 가용확인 ───
  // N열(14) 등록은 installable trigger(onEditInstallable)에서만 처리
  // → 다른 스프레드시트(개고생2.0) 접근에 OAuth 필요하기 때문
  if (sheet.getName() === "확인요청") {
    if (col === 2 || col === 8) {
      handleScheduleEdit(e);
    }
  }
}

/**
 * Installable trigger 전용 함수
 * N열(14) "등록" 처리 → 개고생2.0 거래내역 쓰기 포함
 *
 * 설치 방법: setupInstallableTrigger() 를 한 번 실행하면 자동 등록됨
 */
function onEditInstallable(e) {
  if (!e || !e.source) return;

  const sheet = e.source.getActiveSheet();
  const col = e.range.getColumn();
  const row = e.range.getRow();
  if (row === 1) return;

  if (sheet.getName() === "확인요청" && col === 14) {
    handleScheduleEdit(e);
  }

  // ── 계약마스터에서 행 삭제 시 스케줄상세 + 개고생2.0 연동 삭제 ──
  if (sheet.getName() === "계약마스터") {
    syncDeletedContracts(e.source);
  }
}

/**
 * Installable trigger 등록 함수
 * GAS 에디터에서 딱 한 번만 실행하세요.
 * 중복 방지: 이미 등록된 경우 새로 만들지 않음
 */
function setupInstallableTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  for (const t of triggers) {
    if (t.getHandlerFunction() === "onEditInstallable") {
      Logger.log("이미 등록된 트리거가 있습니다. 중복 생성 안 함.");
      return;
    }
  }
  ScriptApp.newTrigger("onEditInstallable")
    .forSpreadsheet(SpreadsheetApp.getActiveSpreadsheet())
    .onEdit()
    .create();
  Logger.log("✅ onEditInstallable 트리거 등록 완료");
}


/**
 * 계약마스터에서 삭제된 거래ID를 감지하여 스케줄상세 + 개고생2.0에서도 삭제
 * 계약마스터의 거래ID 목록과 스케줄상세의 거래ID를 비교하여 차이를 찾음
 */
function syncDeletedContracts(ss) {
  try {
    var contractSheet = ss.getSheetByName("계약마스터");
    var schedSheet = ss.getSheetByName("스케줄상세");
    if (!contractSheet || !schedSheet) return;

    // 계약마스터의 현재 거래ID 목록
    var contractLastRow = contractSheet.getLastRow();
    var contractIDs = new Set();
    if (contractLastRow >= 2) {
      contractSheet.getRange(2, 1, contractLastRow - 1, 1).getValues()
        .flat().forEach(function(id) { if (id) contractIDs.add(String(id).trim()); });
    }

    // 스케줄상세에서 계약마스터에 없는 거래ID 행 삭제
    var schedLastRow = schedSheet.getLastRow();
    if (schedLastRow < 2) return;

    var schedData = schedSheet.getRange(2, 1, schedLastRow - 1, 2).getValues(); // A:스케줄ID, B:거래ID
    var deletedIDs = new Set();
    var rowsToDelete = [];

    for (var i = 0; i < schedData.length; i++) {
      var 거래ID = String(schedData[i][1] || "").trim();
      if (거래ID && !contractIDs.has(거래ID)) {
        rowsToDelete.push(i + 2);
        deletedIDs.add(거래ID);
      }
    }

    // 뒤에서부터 삭제 (행 번호 꼬임 방지)
    for (var d = rowsToDelete.length - 1; d >= 0; d--) {
      schedSheet.deleteRow(rowsToDelete[d]);
    }

    // 개고생2.0 거래내역에서도 삭제
    if (deletedIDs.size > 0) {
      try {
        var 개고생URL = PropertiesService.getScriptProperties().getProperty("개고생2_URL");
        if (개고생URL) {
          var 개고생SS = SpreadsheetApp.openByUrl(개고생URL);
          var 거래시트 = 개고생SS.getSheetByName("거래내역");
          if (거래시트 && 거래시트.getLastRow() >= 2) {
            var 거래Data = 거래시트.getRange(2, 1, 거래시트.getLastRow() - 1, 4).getValues();
            var 거래Rows = [];
            for (var j = 0; j < 거래Data.length; j++) {
              var tid = String(거래Data[j][3] || "").trim(); // D열: 거래ID
              if (deletedIDs.has(tid)) {
                거래Rows.push(j + 2);
              }
            }
            for (var k = 거래Rows.length - 1; k >= 0; k--) {
              거래시트.deleteRow(거래Rows[k]);
            }
            Logger.log("개고생2.0 거래내역 삭제: " + Array.from(deletedIDs).join(", "));
          }
        }
      } catch (err) {
        Logger.log("개고생2.0 거래내역 삭제 실패: " + err.message);
      }

      Logger.log("계약마스터 삭제 연동 완료 — 스케줄상세 " + rowsToDelete.length + "행 삭제, 거래ID: " + Array.from(deletedIDs).join(", "));
    }
  } catch (err) {
    Logger.log("syncDeletedContracts 오류: " + err.message);
  }
}


// ─── 기존 함수들 (변경 없음) ───

function 회차완료() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const 실사시트 = ss.getSheetByName("실사 기록");
  const 회차시트 = ss.getSheetByName("실사 회차 이력");

  const lastRow = 실사시트.getLastRow();
  const 현재실사 = 실사시트.getRange(2, 6, lastRow-1, 1).getValues();
  const 입력수 = 현재실사.filter(r => r[0] !== "").length;

  if (입력수 === 0) {
    SpreadsheetApp.getUi().alert("입력된 실사 데이터가 없습니다.");
    return;
  }

  const ui = SpreadsheetApp.getUi();
  const response = ui.alert(
    "회차 완료",
    `총 ${입력수}개 장비 실사 데이터를 확정하시겠습니까?`,
    ui.ButtonSet.YES_NO
  );
  if (response !== ui.Button.YES) return;

  const today = new Date();
  const dateStr = Utilities.formatDate(today, "Asia/Seoul", "yyMMdd");
  const email = Session.getActiveUser().getEmail().split("@")[0];
  const 열헤더 = `${dateStr}_${email}`;

  실사시트.insertColumnBefore(13);
  실사시트.getRange(1, 13).setValue(열헤더);

  for (let r = 2; r <= lastRow; r++) {
    const val = 실사시트.getRange(r, 6).getValue();
    실사시트.getRange(r, 13).setValue(val);
  }

  실사시트.getRange(2, 6, lastRow-1, 1).clearContent();
  실사시트.getRange(2, 7, lastRow-1, 1).clearContent();
  실사시트.getRange(2, 9, lastRow-1, 1).clearContent();
  실사시트.getRange(2, 10, lastRow-1, 1).clearContent();

  const 회차lastRow = 회차시트.getLastRow();
  const 회차ID = `RC-${String(회차lastRow).padStart(3,'0')}`;
  회차시트.getRange(회차lastRow+1, 1).setValue(회차ID);
  회차시트.getRange(회차lastRow+1, 2).setValue(today);
  회차시트.getRange(회차lastRow+1, 3).setValue(email);
  회차시트.getRange(회차lastRow+1, 4).setValue("100%");

  ui.alert("회차 완료! 데이터가 저장됐습니다.");
}

function 신규장비확정() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const 신규시트 = ss.getSheetByName("신규장비 추가");
  const 마스터시트 = ss.getSheetByName("장비마스터");

  const ui = SpreadsheetApp.getUi();
  const lastRow = 신규시트.getLastRow();

  let 추가수 = 0;
  for (let r = 2; r <= lastRow; r++) {
    const 확정 = 신규시트.getRange(r, 7).getValue();
    if (확정 !== "확정") continue;

    const 대분류  = 신규시트.getRange(r, 1).getValue();
    const 카테고리 = 신규시트.getRange(r, 2).getValue();
    const 장비ID  = 신규시트.getRange(r, 3).getValue();
    const 장비명  = 신규시트.getRange(r, 4).getValue();
    const 총보유  = 신규시트.getRange(r, 5).getValue();
    const 비고    = 신규시트.getRange(r, 6).getValue();

    if (!장비ID || !장비명) continue;

    const 마스터lastRow = 마스터시트.getLastRow();
    마스터시트.getRange(마스터lastRow+1, 1).setValue(대분류);
    마스터시트.getRange(마스터lastRow+1, 2).setValue(장비ID);
    마스터시트.getRange(마스터lastRow+1, 3).setValue(카테고리);
    마스터시트.getRange(마스터lastRow+1, 4).setValue(장비명);
    마스터시트.getRange(마스터lastRow+1, 5).setValue(총보유);
    마스터시트.getRange(마스터lastRow+1, 9).setValue("정상");
    마스터시트.getRange(마스터lastRow+1, 10).setValue(비고);

    신규시트.getRange(r, 7).setValue("완료");
    추가수++;
  }

  if (추가수 === 0) {
    ui.alert("확정 상태인 신규장비가 없습니다.");
  } else {
    ui.alert(`${추가수}개 장비가 장비마스터에 추가됐습니다.`);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 장비마스터 → 실사기록 동기화 (장비ID 기준)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 장비마스터와 실사기록을 장비ID(B열) 기준으로 동기화
 * - 이름/카테고리/대분류 변경 → 자동 반영
 * - 신규 장비 → 실사기록 하단에 추가
 * - 삭제된 장비 → 실사기록에서 삭제 안 함 (H열에 "삭제됨" 표시)
 * - 기존 실사 입력값(F~L열) → 절대 안 건드림
 *
 * ★ 메뉴에서 "실사기록 동기화" 클릭 또는 GAS에서 직접 실행 ★
 */
function syncAuditFromMaster() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const masterSheet = ss.getSheetByName("장비마스터");
  const auditSheet = ss.getSheetByName("실사 기록");

  if (!masterSheet || !auditSheet) {
    try { SpreadsheetApp.getUi().alert("❌ 장비마스터 또는 실사 기록 시트가 없습니다."); } catch(e) {}
    return;
  }

  const masterLastRow = masterSheet.getLastRow();
  if (masterLastRow < 2) return;

  // 장비마스터 데이터: A(대분류), B(장비ID), C(카테고리), D(장비명), M(사진)
  const masterData = masterSheet.getRange(2, 1, masterLastRow - 1, 13).getValues();
  // { 장비ID → { 대분류, 카테고리, 장비명, 사진URL } }
  const masterMap = {};
  for (let i = 0; i < masterData.length; i++) {
    const id = String(masterData[i][1]).trim(); // B열
    if (!id) continue;
    masterMap[id] = {
      대분류: masterData[i][0] || "",     // A열
      카테고리: masterData[i][2] || "",   // C열
      장비명: masterData[i][3] || "",     // D열
      사진: masterData[i][12] || ""       // M열
    };
  }

  // 실사기록 데이터: A(대분류), B(장비ID), C(카테고리), D(장비명)
  const auditLastRow = auditSheet.getLastRow();
  const auditIDs = new Set();
  let updated = 0;
  let marked = 0;

  if (auditLastRow >= 2) {
    const auditData = auditSheet.getRange(2, 1, auditLastRow - 1, 4).getValues();

    for (let i = 0; i < auditData.length; i++) {
      const auditID = String(auditData[i][1]).trim(); // B열
      if (!auditID) continue;
      auditIDs.add(auditID);
      const row = i + 2;

      if (masterMap[auditID]) {
        // ── 장비ID 매칭: 이름/카테고리/대분류 업데이트 ──
        const m = masterMap[auditID];
        const changed = [];

        if (String(auditData[i][0]).trim() !== String(m.대분류).trim()) {
          auditSheet.getRange(row, 1).setValue(m.대분류);
          changed.push("대분류");
        }
        if (String(auditData[i][2]).trim() !== String(m.카테고리).trim()) {
          auditSheet.getRange(row, 3).setValue(m.카테고리);
          changed.push("카테고리");
        }
        if (String(auditData[i][3]).trim() !== String(m.장비명).trim()) {
          auditSheet.getRange(row, 4).setValue(m.장비명);
          changed.push("장비명");
        }

        if (changed.length > 0) updated++;
      } else {
        // ── 장비마스터에서 삭제된 장비 → 표시만 ──
        const currentH = auditSheet.getRange(row, 8).getValue();
        if (String(currentH) !== "삭제됨") {
          auditSheet.getRange(row, 8).setValue("삭제됨");
          auditSheet.getRange(row, 8).setBackground("#F4CCCC");
          marked++;
        }
      }
    }
  }

  // ── 장비마스터에 있는데 실사기록에 없는 → 새 행 추가 ──
  let added = 0;
  let nextRow = Math.max(auditLastRow + 1, 2);
  const masterIDs = Object.keys(masterMap);

  for (let i = 0; i < masterIDs.length; i++) {
    const id = masterIDs[i];
    if (auditIDs.has(id)) continue;

    const m = masterMap[id];
    // A: 대분류, B: 장비ID, C: 카테고리, D: 장비명 (F~L은 빈칸 유지)
    auditSheet.getRange(nextRow, 1).setValue(m.대분류);
    auditSheet.getRange(nextRow, 2).setValue(id);
    auditSheet.getRange(nextRow, 3).setValue(m.카테고리);
    auditSheet.getRange(nextRow, 4).setValue(m.장비명);
    nextRow++;
    added++;
  }

  SpreadsheetApp.flush();
  const msg = "✅ 실사기록 동기화 완료!\n\n" +
    "• 정보 업데이트: " + updated + "건 (이름/카테고리 변경 반영)\n" +
    "• 신규 장비 추가: " + added + "건\n" +
    "• 삭제 표시: " + marked + "건\n\n" +
    "⚠️ 기존 실사 입력값(F~L열)은 변경되지 않았습니다.";
  Logger.log(msg);
  try { SpreadsheetApp.getUi().alert(msg); } catch(e) {}
}


/**
 * 장비마스터 M열에 "장비사진" 헤더 추가 (한 번만 실행)
 * AppSheet에서 M열을 Image 타입으로 설정하면
 * 앱에서 카메라로 촬영 → 자동 업로드 가능
 */
function setupPhotoColumn() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const masterSheet = ss.getSheetByName("장비마스터");
  if (!masterSheet) return;

  const currentHeader = masterSheet.getRange(1, 13).getValue();
  if (currentHeader && String(currentHeader).trim() !== "") {
    Logger.log("M열에 이미 헤더 있음: " + currentHeader);
    try {
      SpreadsheetApp.getUi().alert("M열에 이미 '" + currentHeader + "' 헤더가 있습니다.\n직접 확인해주세요.");
    } catch(e) {}
    return;
  }

  masterSheet.getRange(1, 13).setValue("장비사진");
  masterSheet.getRange(1, 13).setFontWeight("bold");
  masterSheet.setColumnWidth(13, 120);

  Logger.log("✅ 장비마스터 M열 '장비사진' 헤더 추가 완료");
  try {
    SpreadsheetApp.getUi().alert(
      "✅ 장비마스터 M열 '장비사진' 헤더 추가 완료!\n\n" +
      "AppSheet 설정:\n" +
      "1. AppSheet → 장비마스터 테이블 → Regenerate schema\n" +
      "2. M열(장비사진) 타입을 'Image'로 변경\n" +
      "3. 앱에서 카메라로 사진 촬영 → 자동 업로드"
    );
  } catch(e) {}
}


function updateCustomerDB() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("고객DB");
  var lastRow = sheet.getLastRow();
  var data = sheet.getRange(2, 1, lastRow - 1, 2).getValues();
  
  // 1. Fill in phone numbers for existing entries with empty phones
  var phoneUpdates = {
    "조준서": "010-8938-2762",
    "박수민": "010-6899-3848",
    "김병찬": "010-2680-1327"
  };
  
  for (var i = 0; i < data.length; i++) {
    var phone = data[i][0].toString().trim();
    var name = data[i][1].toString().trim();
    if (phone === "" && phoneUpdates[name]) {
      sheet.getRange(i + 2, 1).setValue(phoneUpdates[name]);
      Logger.log("Updated phone for " + name + ": " + phoneUpdates[name]);
    }
  }
  
  // 2. Add new entries
  var newEntries = [
    ["010-9240-0661", "김찬위"],
    ["010-7681-7440", "권오준"],
    ["010-3520-3408", "최승식"],
    ["010-2262-8425", "선우용"],
    ["", "김민준"],
    ["", "유희준"]
  ];
  
  // Check which names already exist
  var existingNames = {};
  for (var i = 0; i < data.length; i++) {
    existingNames[data[i][1].toString().trim()] = true;
  }
  
  var nextRow = lastRow + 1;
  var added = [];
  for (var j = 0; j < newEntries.length; j++) {
    var entryName = newEntries[j][1];
    if (!existingNames[entryName]) {
      sheet.getRange(nextRow, 1).setValue(newEntries[j][0]);
      sheet.getRange(nextRow, 2).setValue(newEntries[j][1]);
      added.push(entryName);
      nextRow++;
    } else {
      Logger.log("Skipped (already exists): " + entryName);
    }
  }
  
  SpreadsheetApp.flush();
  Logger.log("Updated phones: " + Object.keys(phoneUpdates).join(", "));
  Logger.log("Added new: " + added.join(", "));
  Logger.log("Done! Total rows now: " + sheet.getLastRow());
}


