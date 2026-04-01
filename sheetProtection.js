function scanFormulas() {
  // 이전 스캔 함수 유지
}

function protectSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var results = [];
  
  // === 1. 장비마스터 보호 ===
  // 수식: A(대분류), F(가용수량), G(대여중수), K(최근실사)
  // 입력: B(장비ID), C(카테고리), D(장비명), E(총보유수량), H(장비중수), I(상태), J(비고), L(단가)
  var eqSheet = ss.getSheetByName('장비마스터');
  if (eqSheet) {
    var prots = eqSheet.getProtections(SpreadsheetApp.ProtectionType.SHEET);
    for (var i = 0; i < prots.length; i++) prots[i].remove();
    
    var prot = eqSheet.protect().setDescription('장비마스터 수식 보호');
    var lr = Math.max(eqSheet.getLastRow(), 300);
    var unprotected = [
      eqSheet.getRange('B2:E' + lr),   // 장비ID, 카테고리, 장비명, 총보유수량
      eqSheet.getRange('H2:J' + lr),   // 장비중수, 상태, 비고
      eqSheet.getRange('L2:M' + lr),   // 단가, 장비사진
    ];
    prot.setUnprotectedRanges(unprotected);
    prot.setWarningOnly(false);
    results.push('장비마스터: 보호 완료 (A,F,G,K열 수식 보호)');
  }
  
  // === 2. 실사 기록 보호 ===
  // 수식: A(대분류), E(단가), H(완료상태)
  // 입력: B(장비ID), C(카테고리), D(장비명), F(현재실사), G(현재실사), I~L
  var auditSheet = ss.getSheetByName('실사 기록');
  if (auditSheet) {
    var prots2 = auditSheet.getProtections(SpreadsheetApp.ProtectionType.SHEET);
    for (var i = 0; i < prots2.length; i++) prots2[i].remove();
    
    var prot2 = auditSheet.protect().setDescription('실사 기록 수식 보호');
    var lr2 = Math.max(auditSheet.getLastRow(), 300);
    var lc2 = auditSheet.getLastColumn();
    var unprotected2 = [
      auditSheet.getRange('B2:D' + lr2),   // 장비ID, 카테고리, 장비명
      auditSheet.getRange('F2:G' + lr2),   // 현재실사 입력
    ];
    if (lc2 >= 9) {
      unprotected2.push(auditSheet.getRange('I2:L' + lr2)); // 담당자, 날짜 등
    }
    prot2.setUnprotectedRanges(unprotected2);
    prot2.setWarningOnly(false);
    results.push('실사 기록: 보호 완료 (A,E,H열 수식 보호)');
  }
  
  // === 3. 확인요청 보호 ===
  // 수식: L(고객DB lookup)
  // 입력: A-K, M-Q
  var confirmSheet = ss.getSheetByName('확인요청');
  if (confirmSheet) {
    var prots3 = confirmSheet.getProtections(SpreadsheetApp.ProtectionType.SHEET);
    for (var i = 0; i < prots3.length; i++) prots3[i].remove();
    
    var prot3 = confirmSheet.protect().setDescription('확인요청 수식 보호');
    var lr3 = Math.max(confirmSheet.getLastRow(), 200);
    var lc3 = confirmSheet.getLastColumn();
    var unprotected3 = [
      confirmSheet.getRange('A2:K' + lr3),  // L열 전까지
    ];
    if (lc3 >= 13) {
      unprotected3.push(confirmSheet.getRange('M2:Q' + lr3));  // L열 이후
    }
    prot3.setUnprotectedRanges(unprotected3);
    prot3.setWarningOnly(false);
    results.push('확인요청: 보호 완료 (L열 수식 보호)');
  }
  
  // === 4. 고객DB 보호 ===
  // 수식: A(IMPORTRANGE) - 전체 보호
  var custSheet = ss.getSheetByName('고객DB');
  if (custSheet) {
    var prots4 = custSheet.getProtections(SpreadsheetApp.ProtectionType.SHEET);
    for (var i = 0; i < prots4.length; i++) prots4[i].remove();
    
    var prot4 = custSheet.protect().setDescription('고객DB IMPORTRANGE 보호');
    // IMPORTRANGE 시트는 전체 보호 (데이터 수정 불가)
    prot4.setWarningOnly(false);
    results.push('고객DB: 전체 보호 (IMPORTRANGE 수식)');
  }
  
  // === 5. 세트마스터 헤더 보호 ===
  var setSheet = ss.getSheetByName('세트마스터');
  if (setSheet) {
    var prots5 = setSheet.getProtections(SpreadsheetApp.ProtectionType.SHEET);
    for (var i = 0; i < prots5.length; i++) prots5[i].remove();
    
    var prot5 = setSheet.protect().setDescription('세트마스터 헤더 보호');
    var lr5 = Math.max(setSheet.getLastRow(), 500);
    var lc5 = setSheet.getLastColumn();
    var unprotected5 = [
      setSheet.getRange(2, 1, lr5 - 1, lc5)
    ];
    prot5.setUnprotectedRanges(unprotected5);
    prot5.setWarningOnly(false);
    results.push('세트마스터: 헤더 보호 완료');
  }
  
  // === 6. 신규장비 추가 - 입력 시트이므로 헤더만 보호 ===
  var newEqSheet = ss.getSheetByName('신규장비 추가');
  if (newEqSheet) {
    var prots6 = newEqSheet.getProtections(SpreadsheetApp.ProtectionType.SHEET);
    for (var i = 0; i < prots6.length; i++) prots6[i].remove();
    
    var prot6 = newEqSheet.protect().setDescription('신규장비 추가 헤더 보호');
    var lr6 = Math.max(newEqSheet.getLastRow(), 100);
    var lc6 = newEqSheet.getLastColumn();
    if (lc6 > 0) {
      var unprotected6 = [
        newEqSheet.getRange(2, 1, lr6 - 1, lc6)
      ];
      prot6.setUnprotectedRanges(unprotected6);
    }
    prot6.setWarningOnly(false);
    results.push('신규장비 추가: 헤더 보호 완료');
  }
  
  Logger.log(results.join('\n'));
}