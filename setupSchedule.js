function setupScheduleSystem() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  
  // 1. 기존 "시트1" 정리 -> 계약마스터로 변환
  var sheet1 = ss.getSheetByName("시트1");
  if (sheet1) {
    sheet1.clear();
    sheet1.setName("계약마스터");
  } else {
    var cm = ss.getSheetByName("계약마스터");
    if (!cm) { sheet1 = ss.insertSheet("계약마스터"); }
    else { sheet1 = cm; sheet1.clear(); }
  }
  
  // 2. 계약마스터 헤더
  var cmH = ["계약ID","예약자명","예약자연락처","업체명/별명","반출일","반출시간","반납일","반납시간","회차","계약상태","총금액","거래ID링크","계약서링크","비고"];
  sheet1.getRange(1,1,1,cmH.length).setValues([cmH])
    .setBackground("#1B2A4A").setFontColor("#FFFFFF").setFontWeight("bold").setHorizontalAlignment("center");
  sheet1.setFrozenRows(1);
  [130,100,130,120,100,80,100,80,60,90,110,130,150,160].forEach(function(w,i){sheet1.setColumnWidth(i+1,w)});
  sheet1.getRange("J2:J500").setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(["예약","확정","반출","반납완료","취소"]).setAllowInvalid(false).build());
  sheet1.getRange("E2:E500").setNumberFormat("yyyy-mm-dd");
  sheet1.getRange("G2:G500").setNumberFormat("yyyy-mm-dd");
  sheet1.getRange("F2:F500").setNumberFormat("HH:mm");
  sheet1.getRange("H2:H500").setNumberFormat("HH:mm");
  sheet1.getRange("K2:K500").setNumberFormat("#,##0");
  sheet1.setTabColor("#2563EB");
  
  // 3. 스케줄상세 시트
  var sd = ss.getSheetByName("스케줄상세");
  if (!sd) { sd = ss.insertSheet("스케줄상세"); } else { sd.clear(); }
  
  var sdH = ["스케줄ID","계약ID","예약자명","장비명","수량","반출일","반출시간","반납일","반납시간","반출상태","비고"];
  sd.getRange(1,1,1,sdH.length).setValues([sdH])
    .setBackground("#1B2A4A").setFontColor("#FFFFFF").setFontWeight("bold").setHorizontalAlignment("center");
  sd.setFrozenRows(1);
  [140,130,100,180,60,100,80,100,80,90,160].forEach(function(w,i){sd.setColumnWidth(i+1,w)});
  
  var ms = ss.getSheetByName("장비마스터");
  var lr = ms.getLastRow();
  sd.getRange("D2:D500").setDataValidation(SpreadsheetApp.newDataValidation().requireValueInRange(ms.getRange("D2:D"+lr)).setAllowInvalid(false).build());
  sd.getRange("J2:J500").setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(["대기","반출","반납완료","취소"]).setAllowInvalid(false).build());
  sd.getRange("F2:F500").setNumberFormat("yyyy-mm-dd");
  sd.getRange("H2:H500").setNumberFormat("yyyy-mm-dd");
  sd.getRange("G2:G500").setNumberFormat("HH:mm");
  sd.getRange("I2:I500").setNumberFormat("HH:mm");
  sd.setTabColor("#10B981");
  
  // 4. 장비마스터 G열에 SUMPRODUCT 수식
  var sq = "'";
  var formulas = [];
  for (var row = 2; row <= lr; row++) {
    var f = "=IFERROR(SUMPRODUCT((" + sq + "스케줄상세" + sq + "!$D$2:$D$500=$D" + row + ")*(" + sq + "스케줄상세" + sq + "!$J$2:$J$500<>" + String.fromCharCode(34) + "반납완료" + String.fromCharCode(34) + ")*(" + sq + "스케줄상세" + sq + "!$J$2:$J$500<>" + String.fromCharCode(34) + "취소" + String.fromCharCode(34) + ")*(" + sq + "스케줄상세" + sq + "!$J$2:$J$500<>" + String.fromCharCode(34) + String.fromCharCode(34) + ")," + sq + "스케줄상세" + sq + "!$E$2:$E$500),0)";
    formulas.push([f]);
  }
  ms.getRange(2, 7, formulas.length, 1).setFormulas(formulas);
  
  Logger.log("완료! 계약마스터 + 스케줄상세 생성, G열 수식 " + formulas.length + "개 입력");
}

function setupSetMaster() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  
  var sm = ss.getSheetByName("세트마스터");
  if (!sm) { sm = ss.insertSheet("세트마스터"); } else { sm.clear(); }
  
  var headers = ["세트명","구성장비명","수량","비고"];
  sm.getRange(1,1,1,headers.length).setValues([headers])
    .setBackground("#1B2A4A").setFontColor("#FFFFFF").setFontWeight("bold").setHorizontalAlignment("center");
  sm.setFrozenRows(1);
  [200,200,60,200].forEach(function(w,i){sm.setColumnWidth(i+1,w)});
  sm.setTabColor("#F97316");
  
  var data = [
    ["소니 FX3 풀세트","FX3",1,"바디(풀케이지)"],
    ["소니 FX3 풀세트","캠기어 삼각대",1,"75볼 트라이포드"],
    ["소니 FX3 풀세트","베이비",1,""],
    ["소니 FX3 풀세트","하이햇",1,""],
    ["소니 FX3 풀세트","5인치 모니터",1,"포트키 등"],
    ["소니 FX3 풀세트","스몰리그 핸들그립",1,""],
    ["소니 FX3 풀세트","숄더리그",1,""],
    ["소니 FX3 풀세트","틸타 팔로우포커스 미니",1,"싱글"],
    ["소니 FX3 풀세트","틸타 MB-T12 매트박스",1,""],
    ["소니 FX3 풀세트","CF Express A 160G",2,"+80G 1장, 리더기 포함"],
    ["소니 FX3 풀세트","V마운트 배터리",2,"+충전기"],
    
    ["소니 A7S3 풀세트","A7S3",1,"바디(풀케이지)"],
    ["소니 A7S3 풀세트","캠기어 삼각대",1,"75볼 트라이포드"],
    ["소니 A7S3 풀세트","베이비",1,""],
    ["소니 A7S3 풀세트","하이햇",1,""],
    ["소니 A7S3 풀세트","5인치 모니터",1,"포트키 등"],
    ["소니 A7S3 풀세트","스몰리그 핸들그립",1,""],
    ["소니 A7S3 풀세트","숄더리그",1,""],
    ["소니 A7S3 풀세트","틸타 팔로우포커스 미니",1,"싱글"],
    ["소니 A7S3 풀세트","틸타 MB-T12 매트박스",1,""],
    ["소니 A7S3 풀세트","CF Express A 160G",2,"+80G 1장, 리더기 포함"],
    ["소니 A7S3 풀세트","V마운트 배터리",2,"+충전기"],
    
    ["소니 FX6 풀세트","FX6",1,"바디(풀케이지)"],
    ["소니 FX6 풀세트","삼각대",1,"100볼 트라이포드"],
    ["소니 FX6 풀세트","베이비",1,""],
    ["소니 FX6 풀세트","하이햇",1,""],
    ["소니 FX6 풀세트","7인치 모니터",1,"SmallHD INDIE7 or TVlogic"],
    ["소니 FX6 풀세트","17인치 모니터",1,"TVLogic LVM-075A 등"],
    ["소니 FX6 풀세트","스몰리그 핸들그립",1,""],
    ["소니 FX6 풀세트","틸타 팔로우포커스 미니",1,"싱글"],
    ["소니 FX6 풀세트","틸타 MB-T12 매트박스",1,""],
    ["소니 FX6 풀세트","CF Express A 160G",2,"+80G 1장, 리더기 포함"],
    ["소니 FX6 풀세트","V마운트 배터리",4,"+충전기"],
    ["소니 FX6 풀세트","SDI 롱라인",1,""],
    
    ["소니 FX9 풀세트","FX9",1,"바디(풀케이지)"],
    ["소니 FX9 풀세트","삼각대",1,"100볼 트라이포드"],
    ["소니 FX9 풀세트","베이비",1,""],
    ["소니 FX9 풀세트","하이햇",1,""],
    ["소니 FX9 풀세트","7인치 모니터",1,"SmallHD INDIE7 or TVlogic"],
    ["소니 FX9 풀세트","17인치 모니터",1,"TVLogic LVM-075A 등"],
    ["소니 FX9 풀세트","스몰리그 핸들그립",1,""],
    ["소니 FX9 풀세트","틸타 팔로우포커스 미니",1,"싱글"],
    ["소니 FX9 풀세트","틸타 MB-T12 매트박스",1,""],
    ["소니 FX9 풀세트","XQD 메모리",3,"120G*2, 240G*1, 리더기 포함"],
    ["소니 FX9 풀세트","V마운트 배터리",4,"+충전기"],
    ["소니 FX9 풀세트","SDI 롱라인",1,""],
    
    ["RED 코모도 풀세트","코모도 RED 6K",1,"바디(풀케이지, C-박스 개조)"],
    ["RED 코모도 풀세트","드롭인 필터 어댑터",1,"EF/PL 선택, 내장ND"],
    ["RED 코모도 풀세트","삼각대",1,"100볼 트라이포드"],
    ["RED 코모도 풀세트","베이비",1,""],
    ["RED 코모도 풀세트","하이햇",1,""],
    ["RED 코모도 풀세트","7인치 모니터",1,"SmallHD INDIE7 or TVlogic"],
    ["RED 코모도 풀세트","17인치 모니터",1,"TVLogic LVM-075A 등"],
    ["RED 코모도 풀세트","틸타 핸들그립",1,""],
    ["RED 코모도 풀세트","틸타 팔로우포커스 미니",1,"싱글"],
    ["RED 코모도 풀세트","틸타 MB-T12 매트박스",1,""],
    ["RED 코모도 풀세트","CFast 메모리",3,"512G*2, 256G*1, 리더기 포함"],
    ["RED 코모도 풀세트","V마운트 배터리",4,"+충전기"],
    ["RED 코모도 풀세트","SDI 롱라인",1,""],
    
    ["BMPCC 6K 풀세트","BMPCC 6K",1,"바디(풀케이지)"],
    ["BMPCC 6K 풀세트","캠기어 삼각대",1,"75볼 트라이포드"],
    ["BMPCC 6K 풀세트","베이비",1,""],
    ["BMPCC 6K 풀세트","하이햇",1,""],
    ["BMPCC 6K 풀세트","5인치 모니터",1,""],
    ["BMPCC 6K 풀세트","틸타 팔로우포커스 미니",1,"싱글"],
    ["BMPCC 6K 풀세트","삼성 T5 SSD 1TB",2,""],
    ["BMPCC 6K 풀세트","V마운트 배터리",2,"+충전기"],
    
    ["BMPCC 6K Pro 풀세트","BMPCC 6K Pro",1,"바디(풀케이지)"],
    ["BMPCC 6K Pro 풀세트","캠기어 삼각대",1,"75볼 트라이포드"],
    ["BMPCC 6K Pro 풀세트","베이비",1,""],
    ["BMPCC 6K Pro 풀세트","하이햇",1,""],
    ["BMPCC 6K Pro 풀세트","5인치 모니터",1,""],
    ["BMPCC 6K Pro 풀세트","틸타 팔로우포커스 미니",1,"싱글"],
    ["BMPCC 6K Pro 풀세트","삼성 T5 SSD 1TB",2,""],
    ["BMPCC 6K Pro 풀세트","V마운트 배터리",2,"+충전기"],
    
    ["소니 BURANO 베이직 세트","BURANO",1,"BRIGHT TANGERINE CAGE"],
    ["소니 BURANO 베이직 세트","V마운트 핫스왑 플레이트",1,"SWIT KA-S30S"],
    ["소니 BURANO 베이직 세트","CF Express Type B",3,"1920G*1, 960G*2, 리더기"],
    ["소니 BURANO 베이직 세트","삼각대",1,"SACHTLER VIDEO 20"],
    ["소니 BURANO 베이직 세트","베이비",1,""],
    ["소니 BURANO 베이직 세트","하이햇",1,""],
    ["소니 BURANO 베이직 세트","7인치 모니터",1,"TVLogic F-7HS or SmallHD INDIE7"],
    ["소니 BURANO 베이직 세트","17인치 모니터",1,"TVLogic LVM-180A"],
    ["소니 BURANO 베이직 세트","틸타 Nucleus-M",1,"무선 팔로우포커스"],
    ["소니 BURANO 베이직 세트","테라덱 볼트",1,"포커스용 그립 장비 제공"],
    ["소니 BURANO 베이직 세트","틸타 MB-T12 매트박스",1,""],
    ["소니 BURANO 베이직 세트","V마운트 배터리 290Wh",4,"+4CH 충전기"],
    
    ["소니 BURANO 풀세트","BURANO",1,"BRIGHT TANGERINE CAGE"],
    ["소니 BURANO 풀세트","V마운트 핫스왑 플레이트",1,"SWIT KA-S30S"],
    ["소니 BURANO 풀세트","CF Express Type B",3,"1920G*1, 960G*2, 리더기"],
    ["소니 BURANO 풀세트","삼각대",1,"SACHTLER VIDEO 20"],
    ["소니 BURANO 풀세트","베이비",1,""],
    ["소니 BURANO 풀세트","하이햇",1,""],
    ["소니 BURANO 풀세트","7인치 모니터",1,"TVLogic F-7HS or SmallHD INDIE7"],
    ["소니 BURANO 풀세트","17인치 모니터",1,"TVLogic LVM-180A"],
    ["소니 BURANO 풀세트","틸타 Nucleus-M",1,"무선 팔로우포커스"],
    ["소니 BURANO 풀세트","테라덱 볼트",1,"포커스용 그립 장비 제공"],
    ["소니 BURANO 풀세트","틸타 MB-T12 매트박스",1,""],
    ["소니 BURANO 풀세트","V마운트 배터리 290Wh",4,"+4CH 충전기"],
    ["소니 BURANO 풀세트","뉴클 N7",1,"풀세트에만 포함"],
    ["소니 BURANO 풀세트","무선 송수신기",1,"풀세트에만 포함"]
  ];
  
  sm.getRange(2, 1, data.length, 4).setValues(data);
  
  // 교대행 색상
  for (var i = 0; i < data.length; i++) {
    if (i % 2 === 1) {
      sm.getRange(i+2, 1, 1, 4).setBackground("#F8FAFC");
    }
  }
  
  // 세트명별 구분선 (세트명이 바뀌는 행에 윗줄)
  var prevSet = "";
  for (var i = 0; i < data.length; i++) {
    if (data[i][0] !== prevSet && prevSet !== "") {
      sm.getRange(i+2, 1, 1, 4).setBorder(true, null, null, null, null, null, "#CBD5E1", SpreadsheetApp.BorderStyle.SOLID_MEDIUM);
    }
    prevSet = data[i][0];
  }
  
  Logger.log("세트마스터 완료! " + data.length + "개 구성품 입력");
}

function setupSetMaster_v2() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sm = ss.getSheetByName("세트마스터");
  if (!sm) { sm = ss.insertSheet("세트마스터"); } else { sm.clear(); }
  var headers = ["세트명","구성장비명","수량","비고"];
  sm.getRange(1,1,1,4).setValues([headers]).setBackground("#1B2A4A").setFontColor("#FFFFFF").setFontWeight("bold").setHorizontalAlignment("center");
  sm.setFrozenRows(1);
  [200,200,60,200].forEach(function(w,i){sm.setColumnWidth(i+1,w)});
  sm.setTabColor("#F97316");
  var d = [
["소니 FX3 풀세트","FX3",1,"바디(풀케이지)"],
["소니 FX3 풀세트","캠기어 삼각대",1,"75볼"],
["소니 FX3 풀세트","베이비",1,""],
["소니 FX3 풀세트","하이햇",1,""],
["소니 FX3 풀세트","5인치 모니터",1,""],
["소니 FX3 풀세트","스몰리그 핸들그립",1,""],
["소니 FX3 풀세트","숄더리그",1,""],
["소니 FX3 풀세트","틸타 팔로우포커스 미니",1,""],
["소니 FX3 풀세트","틸타 MB-T12 매트박스",1,""],
["소니 FX3 풀세트","CF Express A 160G",2,"+80G 1장,리더기"],
["소니 FX3 풀세트","V마운트 배터리",2,"+충전기"],
["소니 A7S3 풀세트","A7S3",1,"바디(풀케이지)"],
["소니 A7S3 풀세트","캠기어 삼각대",1,"75볼"],
["소니 A7S3 풀세트","베이비",1,""],
["소니 A7S3 풀세트","하이햇",1,""],
["소니 A7S3 풀세트","5인치 모니터",1,""],
["소니 A7S3 풀세트","스몰리그 핸들그립",1,""],
["소니 A7S3 풀세트","숄더리그",1,""],
["소니 A7S3 풀세트","틸타 팔로우포커스 미니",1,""],
["소니 A7S3 풀세트","틸타 MB-T12 매트박스",1,""],
["소니 A7S3 풀세트","CF Express A 160G",2,"+80G 1장,리더기"],
["소니 A7S3 풀세트","V마운트 배터리",2,"+충전기"],
["소니 FX6 풀세트","FX6",1,"바디(풀케이지)"],
["소니 FX6 풀세트","삼각대",1,"100볼"],
["소니 FX6 풀세트","베이비",1,""],
["소니 FX6 풀세트","하이햇",1,""],
["소니 FX6 풀세트","7인치 모니터",1,"SmallHD or TVlogic"],
["소니 FX6 풀세트","17인치 모니터",1,""],
["소니 FX6 풀세트","스몰리그 핸들그립",1,""],
["소니 FX6 풀세트","틸타 팔로우포커스 미니",1,""],
["소니 FX6 풀세트","틸타 MB-T12 매트박스",1,""],
["소니 FX6 풀세트","CF Express A 160G",2,"+80G 1장,리더기"],
["소니 FX6 풀세트","V마운트 배터리",4,"+충전기"],
["소니 FX6 풀세트","SDI 롱라인",1,""],
["소니 FX9 풀세트","FX9",1,"바디(풀케이지)"],
["소니 FX9 풀세트","삼각대",1,"100볼"],
["소니 FX9 풀세트","베이비",1,""],
["소니 FX9 풀세트","하이햇",1,""],
["소니 FX9 풀세트","7인치 모니터",1,"SmallHD or TVlogic"],
["소니 FX9 풀세트","17인치 모니터",1,""],
["소니 FX9 풀세트","스몰리그 핸들그립",1,""],
["소니 FX9 풀세트","틸타 팔로우포커스 미니",1,""],
["소니 FX9 풀세트","틸타 MB-T12 매트박스",1,""],
["소니 FX9 풀세트","XQD 메모리",3,"120G*2,240G*1,리더기"],
["소니 FX9 풀세트","V마운트 배터리",4,"+충전기"],
["소니 FX9 풀세트","SDI 롱라인",1,""],
["RED 코모도 풀세트","코모도 RED 6K",1,"바디(C-박스)"],
["RED 코모도 풀세트","드롭인 필터 어댑터",1,"EF/PL 선택"],
["RED 코모도 풀세트","삼각대",1,"100볼"],
["RED 코모도 풀세트","베이비",1,""],
["RED 코모도 풀세트","하이햇",1,""],
["RED 코모도 풀세트","7인치 모니터",1,""],
["RED 코모도 풀세트","17인치 모니터",1,""],
["RED 코모도 풀세트","틸타 핸들그립",1,""],
["RED 코모도 풀세트","틸타 팔로우포커스 미니",1,""],
["RED 코모도 풀세트","틸타 MB-T12 매트박스",1,""],
["RED 코모도 풀세트","CFast 메모리",3,"512G*2,256G*1,리더기"],
["RED 코모도 풀세트","V마운트 배터리",4,"+충전기"],
["RED 코모도 풀세트","SDI 롱라인",1,""],
["BMPCC 6K 풀세트","BMPCC 6K",1,"바디(풀케이지)"],
["BMPCC 6K 풀세트","캠기어 삼각대",1,"75볼"],
["BMPCC 6K 풀세트","베이비",1,""],
["BMPCC 6K 풀세트","하이햇",1,""],
["BMPCC 6K 풀세트","5인치 모니터",1,""],
["BMPCC 6K 풀세트","틸타 팔로우포커스 미니",1,""],
["BMPCC 6K 풀세트","삼성 T5 SSD 1TB",2,""],
["BMPCC 6K 풀세트","V마운트 배터리",2,"+충전기"],
["BMPCC 6K Pro 풀세트","BMPCC 6K Pro",1,"바디(풀케이지)"],
["BMPCC 6K Pro 풀세트","캠기어 삼각대",1,"75볼"],
["BMPCC 6K Pro 풀세트","베이비",1,""],
["BMPCC 6K Pro 풀세트","하이햇",1,""],
["BMPCC 6K Pro 풀세트","5인치 모니터",1,""],
["BMPCC 6K Pro 풀세트","틸타 팔로우포커스 미니",1,""],
["BMPCC 6K Pro 풀세트","삼성 T5 SSD 1TB",2,""],
["BMPCC 6K Pro 풀세트","V마운트 배터리",2,"+충전기"],
["소니 BURANO 베이직","BURANO",1,"BT CAGE"],
["소니 BURANO 베이직","V마운트 핫스왑 플레이트",1,"SWIT"],
["소니 BURANO 베이직","CF Express Type B",3,"1920G+960G*2,리더기"],
["소니 BURANO 베이직","삼각대",1,"SACHTLER VIDEO 20"],
["소니 BURANO 베이직","베이비",1,""],
["소니 BURANO 베이직","하이햇",1,""],
["소니 BURANO 베이직","7인치 모니터",1,""],
["소니 BURANO 베이직","17인치 모니터",1,"TVLogic LVM-180A"],
["소니 BURANO 베이직","틸타 Nucleus-M",1,"무선 팔로우포커스"],
["소니 BURANO 베이직","테라덱 볼트",1,""],
["소니 BURANO 베이직","틸타 MB-T12 매트박스",1,""],
["소니 BURANO 베이직","V마운트 배터리 290Wh",4,"+4CH 충전기"],
["소니 BURANO 풀세트","BURANO",1,"BT CAGE"],
["소니 BURANO 풀세트","V마운트 핫스왑 플레이트",1,"SWIT"],
["소니 BURANO 풀세트","CF Express Type B",3,"1920G+960G*2,리더기"],
["소니 BURANO 풀세트","삼각대",1,"SACHTLER VIDEO 20"],
["소니 BURANO 풀세트","베이비",1,""],
["소니 BURANO 풀세트","하이햇",1,""],
["소니 BURANO 풀세트","7인치 모니터",1,""],
["소니 BURANO 풀세트","17인치 모니터",1,"TVLogic LVM-180A"],
["소니 BURANO 풀세트","틸타 Nucleus-M",1,"무선 팔로우포커스"],
["소니 BURANO 풀세트","테라덱 볼트",1,""],
["소니 BURANO 풀세트","틸타 MB-T12 매트박스",1,""],
["소니 BURANO 풀세트","V마운트 배터리 290Wh",4,"+4CH 충전기"],
["소니 BURANO 풀세트","뉴클 N7",1,"풀세트만"],
["소니 BURANO 풀세트","무선 송수신기",1,"풀세트만"],

["소니 FX3 바디 세트","FX3",1,"풀케이지"],
["소니 FX3 바디 세트","CF Express A 160G",2,"+80G 1장, 리더기"],
["소니 FX3 바디 세트","바디 배터리",4,"+충전기"],
["소니 A7S3 바디 세트","A7S3",1,"풀케이지"],
["소니 A7S3 바디 세트","CF Express A 160G",2,"+80G 1장, 리더기"],
["소니 A7S3 바디 세트","바디 배터리",4,"+충전기"],
["소니 FX6 바디 세트","FX6",1,"풀케이지"],
["소니 FX6 바디 세트","CF Express A 160G",2,"+80G 1장, 리더기"],
["소니 FX6 바디 세트","바디 배터리",4,"+충전기"],
["소니 FX9 바디 세트","FX9",1,"풀케이지"],
["소니 FX9 바디 세트","XQD 메모리",3,"120G*2, 240G*1, 리더기"],
["소니 FX9 바디 세트","바디 배터리",4,"+충전기"],
["어퓨쳐 300X 세트","어퓨쳐 300X",1,""],
["어퓨쳐 300X 세트","A스탠드",1,""],
["어퓨쳐 300X 세트","라이트돔 or 젬볼",1,"둘 중 선택"],
["어퓨쳐 600X 프로 세트","어퓨쳐 600X 프로",1,""],
["어퓨쳐 600X 프로 세트","C스탠드",1,""],
["어퓨쳐 600X 프로 세트","라이트돔 or 젬볼",1,"둘 중 선택"],
["어퓨쳐 노바 P300C 세트","어퓨쳐 노바 P300C",1,""],
["어퓨쳐 노바 P300C 세트","콤보 스탠드",1,""],
["어퓨쳐 노바 P300C 세트","소프트 박스",1,""]
  ];
  sm.getRange(2,1,d.length,4).setValues(d);
  Logger.log("세트마스터 완료! " + d.length + "개 행");
}

function addMoreSets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sm = ss.getSheetByName("세트마스터");
  var lastRow = sm.getLastRow();
  
  var newData = [
    ["소니 FX3 바디 세트","FX3",1,"풀케이지"],
    ["소니 FX3 바디 세트","CF Express A 160G",2,"+80G 1장, 리더기 포함"],
    ["소니 FX3 바디 세트","바디 배터리",4,"+충전기"],
    
    ["소니 A7S3 바디 세트","A7S3",1,"풀케이지"],
    ["소니 A7S3 바디 세트","CF Express A 160G",2,"+80G 1장, 리더기 포함"],
    ["소니 A7S3 바디 세트","바디 배터리",4,"+충전기"],
    
    ["소니 FX6 바디 세트","FX6",1,"풀케이지"],
    ["소니 FX6 바디 세트","CF Express A 160G",2,"+80G 1장, 리더기 포함"],
    ["소니 FX6 바디 세트","바디 배터리",4,"+충전기"],
    
    ["소니 FX9 바디 세트","FX9",1,"풀케이지"],
    ["소니 FX9 바디 세트","XQD 메모리",3,"120G*2, 240G*1, 리더기 포함"],
    ["소니 FX9 바디 세트","바디 배터리",4,"+충전기"],
    
    ["어퓨쳐 300X 세트","어퓨쳐 300X",1,""],
    ["어퓨쳐 300X 세트","A스탠드",1,""],
    ["어퓨쳐 300X 세트","라이트돔 or 젬볼",1,"둘 중 선택"],
    
    ["어퓨쳐 600X 프로 세트","어퓨쳐 600X 프로",1,""],
    ["어퓨쳐 600X 프로 세트","C스탠드",1,""],
    ["어퓨쳐 600X 프로 세트","라이트돔 or 젬볼",1,"둘 중 선택"],
    
    ["어퓨쳐 노바 P300C 세트","어퓨쳐 노바 P300C",1,""],
    ["어퓨쳐 노바 P300C 세트","콤보 스탠드",1,""],
    ["어퓨쳐 노바 P300C 세트","소프트 박스",1,""]
  ];
  
  sm.getRange(lastRow + 1, 1, newData.length, 4).setValues(newData);
  Logger.log("추가 완료! " + newData.length + "개 행 (바디세트 4종 + 조명세트 3종)");
}

function addAlternativeColumn() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sm = ss.getSheetByName("세트마스터");
  
  // E1에 헤더 추가
  sm.getRange("E1").setValue("대체가능장비")
    .setBackground("#1B2A4A").setFontColor("#FFFFFF").setFontWeight("bold").setHorizontalAlignment("center");
  sm.setColumnWidth(5, 300);
  
  // 대체 가능한 장비 매핑
  var map = {
    "5인치 모니터": "포트키 BM5III, 스몰HD 502",
    "7인치 모니터": "SmallHD INDIE7, TVLogic F-7HS",
    "17인치 모니터": "TVLogic LVM-075A, TVLogic LVM-180A",
    "캠기어 삼각대": "캠기어 마크4, 캠기어 엘리트 15",
    "삼각대": "서튼 V-15, 캠기어 엘리트 20, 셔틀러 비디오 203",
    "라이트돔 or 젬볼": "라이트돔 SE, 라이트돔 미니, 젬볼",
    "A스탠드": "A스탠드 (보유 장비 중 가용)",
    "C스탠드": "C스탠드 (보유 장비 중 가용)",
    "베이비": "베이비 스탠드 (보유 장비 중 가용)",
    "숄더리그": "숄더리그 (보유 장비 중 가용)",
    "틸타 팔로우포커스 미니": "틸타 싱글 FF 미니",
    "틸타 MB-T12 매트박스": "틸타 MB-T12",
    "스몰리그 핸들그립": "스몰리그 핸들그립, 틸타 핸들그립",
    "틸타 핸들그립": "스몰리그 핸들그립, 틸타 핸들그립",
    "콤보 스탠드": "콤보 스탠드 (보유 장비 중 가용)",
    "소프트 박스": "소프트 박스 (보유 장비 중 가용)"
  };
  
  var lastRow = sm.getLastRow();
  var equipNames = sm.getRange(2, 2, lastRow - 1, 1).getValues();
  var altValues = [];
  
  for (var i = 0; i < equipNames.length; i++) {
    var name = equipNames[i][0];
    altValues.push([map[name] || ""]);
  }
  
  sm.getRange(2, 5, altValues.length, 1).setValues(altValues);
  Logger.log("대체가능장비 열 추가 완료! " + altValues.filter(function(v){return v[0]!=="";}).length + "개 항목에 대체장비 매핑");
}

function updateContractMaster() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var cm = ss.getSheetByName("계약마스터");
  if (!cm) return;
  cm.clear();
  var h = ["거래ID","예약자명","예약자연락처","업체명/별명","반출일","반출시간","반납일","반납시간","회차","계약상태","비고"];
  cm.getRange(1,1,1,h.length).setValues([h]).setBackground("#1B2A4A").setFontColor("#FFFFFF").setFontWeight("bold").setHorizontalAlignment("center");
  cm.setFrozenRows(1);
  [130,100,130,120,100,80,100,80,60,90,200].forEach(function(w,i){cm.setColumnWidth(i+1,w)});
  cm.getRange("J2:J500").setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(["예약","확정","반출","반납완료","취소"]).setAllowInvalid(false).build());
  cm.getRange("E2:E500").setNumberFormat("yyyy-mm-dd");
  cm.getRange("G2:G500").setNumberFormat("yyyy-mm-dd");
  cm.getRange("F2:F500").setNumberFormat("HH:mm");
  cm.getRange("H2:H500").setNumberFormat("HH:mm");
  cm.setTabColor("#2563EB");
  var sd = ss.getSheetByName("스케줄상세");
  if (sd) sd.getRange("B1").setValue("거래ID");
  Logger.log("계약마스터 v2 완료 (11열, 개고생 중복 제거)");
}


function updateSetMasterFromJSON() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sm = ss.getSheetByName("세트마스터");
  if (!sm) { sm = ss.insertSheet("세트마스터"); } else { sm.clear(); }
  var h = ["세트명","구성장비명","수량","비고"];
  sm.getRange(1,1,1,4).setValues([h]).setBackground("#1B2A4A").setFontColor("#FFFFFF").setFontWeight("bold").setHorizontalAlignment("center");
  sm.setFrozenRows(1);
  [200,250,60,120].forEach(function(w,i){sm.setColumnWidth(i+1,w)});
  sm.setTabColor("#F97316");
  // Data will be pasted from clipboard
  Logger.log("세트마스터 헤더 설정 완료. 데이터를 직접 붙여넣기 해주세요.");
}