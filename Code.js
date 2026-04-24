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
    // K열(11) 예약자명 입력 시 L열(12) 연락처 자동조회 수식 복원 + 동명이인 경고
    if (col === 11 && row >= 2) {
      var kCell = sheet.getRange(row, 11);
      var lCell = sheet.getRange(row, 12);
      var kVal = String(kCell.getValue() || "").trim();
      // 동명이인 체크: 고객DB에서 같은 이름이 몇 개 있는지 확인
      var dupCount = 0;
      try {
        var dbSheet = e.source.getSheetByName("고객DB");
        if (dbSheet && dbSheet.getLastRow() >= 2 && kVal) {
          var dbNames = dbSheet.getRange(2, 2, dbSheet.getLastRow() - 1, 1).getValues();
          for (var dni = 0; dni < dbNames.length; dni++) {
            if (String(dbNames[dni][0]).trim() === kVal) dupCount++;
          }
        }
      } catch(e1) {}

      if (dupCount > 1) {
        // 동명이인 존재 → L열 비우고 K열에 경고 메모
        lCell.clearContent();
        kCell.setNote("⚠️ 고객DB에 동명이인 " + dupCount + "명 존재\n연락처를 직접 입력하세요");
        kCell.setBackground("#FFEB9C");
      } else {
        // 단일 또는 미등록 → 자동조회 수식 설정 + 경고 제거
        kCell.clearNote();
        kCell.setBackground(null);
        if (!lCell.getFormula() && !lCell.getValue()) {
          lCell.setFormula(
            '=IF(K' + row + '="","",IFERROR(INDEX(\'고객DB\'!A:A,MATCH(K' + row + ',\'고객DB\'!B:B,0)),""))'
          );
        }
      }
    }
    // F열(6) 장비명 입력 시 위 행에서 요청ID만 자동 상속 (날짜는 첫 행만 유지)
    if (col === 6 && row >= 3 && e.range.getValue()) {
      var currentReqID = sheet.getRange(row, 1).getValue();
      if (!currentReqID) {
        var prevReqID = sheet.getRange(row - 1, 1).getValue();
        if (prevReqID && String(prevReqID).startsWith("RQ-")) {
          sheet.getRange(row, 1).setValue(prevReqID);
        }
      }
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

  // 확인요청 A열: 거래ID만 입력하면 자동으로 RQ- 붙이기
  if (sheet.getName() === "확인요청" && col === 1 && row >= 2) {
    var aVal = String(e.range.getValue()).trim();
    if (aVal && !aVal.startsWith("RQ-") && /^\d{6}-\d{3}$/.test(aVal)) {
      e.range.setValue("RQ-" + aVal);
    }
  }

  if (sheet.getName() === "확인요청" && col === 14) {
    handleScheduleEdit(e);
  }

  // 계약마스터 J열(10) "취소" → 스케줄상세 삭제 + 개고생2.0 삭제
  if (sheet.getName() === "계약마스터" && col === 10 && row >= 2) {
    var val = e.range.getValue();
    if (String(val).trim() === "취소") {
      var 거래ID = String(sheet.getRange(row, 1).getValue()).trim();
      if (거래ID) cancelContract(e.source, 거래ID, row);
    }
  }

  // 확인요청 K(예약자명) / L(연락처) 변경 시: 개고생2.0 고객DB 매칭 → M열(할인유형) 자동 채움
  if (sheet.getName() === "확인요청" && (col === 11 || col === 12) && row >= 2) {
    try {
      lookupDiscountFromCustomerDB(sheet, row);
    } catch (err) {
      Logger.log("고객DB 할인유형 조회 실패: " + err.message);
    }
  }

  // 스케줄상세 B열(거래ID) 입력 시: 반출일/시간 · 반납일/시간 · 예약자명 · 상태 · 스케줄ID 자동 채움
  if (sheet.getName() === "스케줄상세" && col === 2 && row >= 2) {
    try {
      var sd거래ID = String(e.range.getValue()).trim();
      if (sd거래ID) autoFillScheduleRow(e.source, sheet, row, sd거래ID);
    } catch (err) {
      Logger.log("스케줄상세 자동완성 실패: " + err.message);
    }
  }

  // 스케줄상세 C열(세트/장비명) 입력 시: 세트면 구성품 자동 펼침, 단품이면 D열·단가 자동 채움
  if (sheet.getName() === "스케줄상세" && col === 3 && row >= 2) {
    try {
      var cVal = String(e.range.getValue()).trim();
      if (cVal) autoExpandSetInSchedule(e.source, sheet, row, cVal);
    } catch (err) {
      Logger.log("스케줄상세 세트 펼침 실패: " + err.message);
    }
  }

  // 스케줄상세 품목/수량 수정 시 계약서 재생성 (디바운스) — 여러 건 연속 편집 시 단 1회 재생성
  if (sheet.getName() === "스케줄상세" && (col === 3 || col === 4 || col === 5) && row >= 2) {
    try {
      var 거래ID = sheet.getRange(row, 2).getValue();  // B열: 거래ID
      if (거래ID) {
        scheduleContractRegen(String(거래ID).trim());
        Logger.log("스케줄상세 수정 → 계약서 재생성 예약: " + 거래ID);
      }
    } catch (err) {
      Logger.log("스케줄상세 수정 → 재생성 예약 실패: " + err.message);
    }
  }

  // 계약마스터 E-I열(반출일/시간 · 반납일/시간 · 회차) 수정 → 스케줄상세 + 거래내역 전파 + 계약서 재생성 예약
  if (sheet.getName() === "계약마스터" && col >= 5 && col <= 9 && row >= 2) {
    try {
      var cm거래ID = String(sheet.getRange(row, 1).getValue()).trim();
      if (cm거래ID) {
        // 5-8열(날짜/시간): 스케줄상세/거래내역 즉시 반영. 9열(회차)은 계약서 재생성만
        if (col >= 5 && col <= 8) {
          propagateContractDates(e.source, sheet, row, cm거래ID);
        }
        scheduleContractRegen(cm거래ID);
      }
    } catch (err) {
      Logger.log("계약마스터 일정 변경 처리 실패: " + err.message);
    }
  }
}

/**
 * 확인요청 K(예약자명) / L(연락처)을 입력하면 개고생2.0 고객DB에서 연락처로 매칭해
 * 할인유형(D열)이 '단골' 또는 '제휴'이면 확인요청 M열에 자동 채움.
 * 연락처 부재 시 이름으로 매칭 (동명이인은 이미 다른 로직이 경고 처리).
 * 이미 M열에 값이 있으면 덮어쓰지 않음(수동 입력 보존).
 */
/**
 * 연락처 정규화: 숫자만 남기고 맨 앞 0 제거 → 뒤 10자리로 통일.
 * 예: "010-4506-6615" → "1045066615", 1045066615 (숫자) → "1045066615",
 *     "82-10-4506-6615" → "82104506661510"? (국가코드 포함 시 주의 — 보통 010으로 저장됨)
 * 매칭 기준: 끝 10자리만 비교 (가장 안전)
 */
function _normPhone(v) {
  var s = String(v == null ? "" : v).replace(/[^0-9]/g, "");
  return s.length > 10 ? s.slice(-10) : s;
}

function lookupDiscountFromCustomerDB(sheet, row) {
  var mCell = sheet.getRange(row, 13);
  var existing = String(mCell.getValue() || "").trim();
  if (existing && existing !== "일반") return; // 이미 입력됨

  var 예약자명 = String(sheet.getRange(row, 11).getValue() || "").trim();
  var 연락처Raw = sheet.getRange(row, 12).getValue();
  var 연락처Norm = _normPhone(연락처Raw);
  if (!예약자명 && !연락처Norm) return;

  var url = PropertiesService.getScriptProperties().getProperty("개고생2_URL");
  if (!url) return;
  var dbSheet;
  try {
    dbSheet = SpreadsheetApp.openByUrl(url).getSheetByName("고객DB");
  } catch (e) { return; }
  if (!dbSheet || dbSheet.getLastRow() < 2) return;

  // A=예약자ID(휴대폰), B=성함, C=누적이용횟수, D=소개건수, E=소개리워드발급,
  // F=소개리워드사용, G=5회쿠폰발송, H=10회쿠폰발송, I=할인유형
  var data = dbSheet.getRange(2, 1, dbSheet.getLastRow() - 1, 9).getValues();
  var matched = null;
  for (var i = 0; i < data.length; i++) {
    var dbTel = _normPhone(data[i][0]);
    var dbName = String(data[i][1] || "").trim();
    if (연락처Norm && dbTel && dbTel === 연락처Norm) { matched = data[i]; break; }
    if (!연락처Norm && 예약자명 && dbName === 예약자명) { matched = data[i]; break; }
  }
  if (!matched) {
    Logger.log("고객DB 매칭 실패 — 이름:" + 예약자명 + " 폰(norm):" + 연락처Norm);
    return;
  }

  var 할인 = String(matched[8] || "").trim();  // I열
  // 단골/제휴만 자동 채움. 학생/개사프리는 Cowork 파싱이 담당.
  if (할인 === "단골" || 할인 === "제휴") {
    mCell.setValue(할인);
    Logger.log("고객DB 매칭 → " + 예약자명 + " 할인유형 " + 할인);
  }
}

/**
 * 계약마스터 K/L 스왑 + 할인유형 드롭다운 + 헤더 서식 통일.
 * 고객DB I열 '할인유형' 헤더도 세팅.
 *
 * 최종 구조: K=할인유형(드롭다운), L=비고
 * 기존 L1='할인유형', K1='비고'였던 상태에서 호출하면
 *   1) K열 전체를 L열로, L열 전체를 K열로 복사(헤더 포함)
 *   2) 헤더 bold + 중앙정렬 기존 헤더들과 통일
 *   3) K열 드롭다운 규칙 적용(일반/학생/개인사업자·프리랜서/단골/제휴)
 * 멱등: 이미 K1='할인유형'이면 스왑 스킵, 드롭다운/서식만 갱신.
 */
function setupDiscountColumns() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var out = [];

  var cm = ss.getSheetByName("계약마스터");
  if (cm) {
    var maxRow = cm.getMaxRows();
    var lastRow = cm.getLastRow();
    var k1 = String(cm.getRange(1, 11).getValue() || "").trim();
    var l1 = String(cm.getRange(1, 12).getValue() || "").trim();

    // 1) K↔L 스왑 (K1 !== 할인유형일 때만)
    if (k1 !== "할인유형") {
      if (lastRow >= 1) {
        var kData = cm.getRange(1, 11, lastRow, 1).getValues();
        var lData = cm.getRange(1, 12, lastRow, 1).getValues();
        // 헤더 행 강제 세팅
        kData[0][0] = "할인유형";
        lData[0][0] = "비고";
        cm.getRange(1, 11, lastRow, 1).setValues(kData.map(function(r, i) {
          return i === 0 ? ["할인유형"] : [lData[i] ? lData[i][0] : ""];
        }));
        cm.getRange(1, 12, lastRow, 1).setValues(lData.map(function(r, i) {
          return i === 0 ? ["비고"] : [kData[i] ? kData[i][0] : ""];
        }));
        out.push("계약마스터 K↔L 스왑 완료 (" + (lastRow - 1) + "행)");
      } else {
        cm.getRange(1, 11).setValue("할인유형");
        cm.getRange(1, 12).setValue("비고");
        out.push("계약마스터 K1/L1 헤더만 세팅 (데이터 없음)");
      }
    } else {
      out.push("계약마스터 K1 이미 '할인유형'");
    }

    // 2) 헤더 서식 통일 (A1:L1 bold + 가운데 정렬)
    cm.getRange(1, 1, 1, 12).setFontWeight("bold").setHorizontalAlignment("center");

    // 3) K열 할인유형 드롭다운 (시트 최대 행까지)
    var disRule = SpreadsheetApp.newDataValidation()
      .requireValueInList(["일반", "학생", "개인사업자/프리랜서", "단골", "제휴"], true)
      .setAllowInvalid(true)
      .setHelpText("일반/학생/개인사업자/프리랜서/단골/제휴")
      .build();
    cm.getRange(2, 11, maxRow - 1, 1).setDataValidation(disRule);
    out.push("계약마스터 K열 드롭다운 적용");
  }

  // 4) 고객DB I열 헤더
  try {
    var url = PropertiesService.getScriptProperties().getProperty("개고생2_URL");
    if (url) {
      var dbSheet = SpreadsheetApp.openByUrl(url).getSheetByName("고객DB");
      if (dbSheet) {
        var i1 = dbSheet.getRange(1, 9).getValue();
        if (!i1) {
          dbSheet.getRange(1, 9).setValue("할인유형").setFontWeight("bold");
          out.push("개고생2.0 고객DB I1=할인유형 추가");
        } else {
          out.push("고객DB I1 이미 있음: " + i1);
        }
      }
    }
  } catch (e) { out.push("고객DB 업데이트 실패: " + e.message); }

  return out.join(" | ");
}

/**
 * 스케줄상세 C열(세트/장비명)이 입력되면:
 *   - 세트마스터에 세트로 등록되어 있으면 → 현재 행을 세트 대표행으로 만들고(D=세트명, 수량='1세트', 단가=세트단가),
 *     구성품을 바로 아래 행들에 삽입(D=구성품, 수량=구성품수량, 단가=0).
 *   - 세트가 아닌 단품이면 → D열에 동일값, 수량=1, 단가 자동 조회.
 *   - 거래ID가 비어있으면 경고만 남기고 스킵.
 * 기존 D열에 이미 값이 있는 경우는 덮어쓰지 않음(사용자 수동 편집 보존).
 */
function autoExpandSetInSchedule(ss, sheet, row, 세트명) {
  var 거래ID = String(sheet.getRange(row, 2).getValue()).trim();
  if (!거래ID) {
    sheet.getRange(row, 11).setValue("❌ B열 거래ID 먼저 입력").setBackground("#FFC7CE");
    return;
  }
  var setSheet = ss.getSheetByName("세트마스터");
  if (!setSheet) return;

  var currentD = String(sheet.getRange(row, 4).getValue()).trim();
  // 세트마스터는 "단품 행"(A=이름, B=빈칸, G=단가)도 포함하므로,
  // 실제 구성품(이름 있는 것)만 추려냄. 자기 자신과 같은 이름도 제거(무한 확장 방지).
  var components = getSetComponents(세트명, setSheet).filter(function(c) {
    var n = String(c.name || "").trim();
    return n !== "" && n !== 세트명;
  });
  var price = findSetPrice(세트명, setSheet);

  if (components.length > 0) {
    // === 세트 ===
    // 현재 행을 세트 대표행으로 설정 (D가 비어있을 때만 덮어씀)
    if (!currentD) sheet.getRange(row, 4).setValue(세트명);
    if (!sheet.getRange(row, 5).getValue()) sheet.getRange(row, 5).setValue("1세트");
    if (!sheet.getRange(row, 12).getValue()) sheet.getRange(row, 12).setValue(price);

    // 이미 같은 세트의 구성품 행이 아래에 있으면 중복 생성 방지 체크
    var lastRow = sheet.getLastRow();
    var belowCheckRange = Math.min(components.length + 2, lastRow - row);
    if (belowCheckRange > 0) {
      var below = sheet.getRange(row + 1, 2, belowCheckRange, 2).getValues();  // B거래ID, C세트명
      var hasComponents = 0;
      for (var i = 0; i < below.length; i++) {
        if (String(below[i][0]).trim() === 거래ID && String(below[i][1]).trim() === 세트명) {
          hasComponents++;
        } else break;
      }
      if (hasComponents >= components.length) {
        sheet.getRange(row, 11).setValue("ℹ️ 이미 구성품 있음 — 재삽입 안 함").setBackground("#FFF2CC");
        return;
      }
    }

    // 구성품 행 삽입
    var headerValues = sheet.getRange(row, 1, 1, 13).getValues()[0];
    sheet.insertRowsAfter(row, components.length);

    var maxN = 0;
    var sLast2 = sheet.getLastRow();
    if (sLast2 >= 2) {
      var sIds = sheet.getRange(2, 1, sLast2 - 1, 1).getValues().flat();
      var re = new RegExp("^" + 거래ID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "-(\\d+)$");
      sIds.forEach(function(sid) {
        var m = String(sid).match(re);
        if (m) { var n = parseInt(m[1], 10); if (n > maxN) maxN = n; }
      });
    }

    var newRows = [];
    for (var j = 0; j < components.length; j++) {
      maxN++;
      newRows.push([
        거래ID + "-" + ("0" + maxN).slice(-2),  // A 스케줄ID
        거래ID,                                   // B 거래ID
        세트명,                                   // C 세트명 (그룹핑)
        components[j].name,                      // D 구성품 장비명
        components[j].qty || 1,                   // E 수량
        headerValues[5],                          // F 반출일
        headerValues[6],                          // G 반출시간
        headerValues[7],                          // H 반납일
        headerValues[8],                          // I 반납시간
        "대기",                                   // J 상태
        "",                                       // K 비고
        0,                                        // L 단가 (구성품은 0, 대표행이 세트 단가)
        headerValues[12]                          // M 예약자명
      ]);
    }
    // 숫자열은 숫자로 남기고 텍스트(시간)는 @ 서식 유지하기 위해 범위 지정 후 setValues
    sheet.getRange(row + 1, 1, newRows.length, 13).setValues(newRows);
    sheet.getRange(row + 1, 6, newRows.length, 1).setNumberFormat("yyyy-MM-dd");
    sheet.getRange(row + 1, 7, newRows.length, 1).setNumberFormat("@");
    sheet.getRange(row + 1, 8, newRows.length, 1).setNumberFormat("yyyy-MM-dd");
    sheet.getRange(row + 1, 9, newRows.length, 1).setNumberFormat("@");

    sheet.getRange(row, 11).clearContent().setBackground(null);
  } else {
    // === 단품 ===
    if (!currentD) sheet.getRange(row, 4).setValue(세트명);
    if (!sheet.getRange(row, 5).getValue()) sheet.getRange(row, 5).setValue(1);
    if (!sheet.getRange(row, 12).getValue() && price) sheet.getRange(row, 12).setValue(price);
    sheet.getRange(row, 11).clearContent().setBackground(null);
  }
}

/**
 * 스케줄상세 B열(거래ID)이 입력되면 계약마스터에서 거래 정보를 읽어
 * 반출일/시간/반납일/시간/예약자명/상태/스케줄ID를 자동으로 채움.
 * 이미 값이 있는 셀은 건드리지 않음 — 사용자가 미리 입력한 건 존중.
 * 장비추가 워크플로우 단순화의 핵심: 거래ID만 치면 나머지 거의 다 채워짐.
 */
function autoFillScheduleRow(ss, sheet, row, 거래ID) {
  var cm = ss.getSheetByName("계약마스터");
  if (!cm || cm.getLastRow() < 2) return;

  var cmRaw  = cm.getRange(2, 1, cm.getLastRow() - 1, 8).getValues();
  var cmDisp = cm.getRange(2, 1, cm.getLastRow() - 1, 8).getDisplayValues();
  var found = -1;
  for (var i = 0; i < cmRaw.length; i++) {
    if (String(cmRaw[i][0]).trim() === 거래ID) { found = i; break; }
  }
  if (found === -1) {
    sheet.getRange(row, 11).setValue("❌ 계약마스터에 없는 거래ID");
    sheet.getRange(row, 11).setBackground("#FFC7CE");
    return;
  }

  var 예약자명   = cmRaw[found][1];
  var 반출일str   = _fmtDateStr(cmRaw[found][4]);
  var 반납일str   = _fmtDateStr(cmRaw[found][6]);
  var 반출시간str = String(cmDisp[found][5] || "").trim();
  var 반납시간str = String(cmDisp[found][7] || "").trim();

  // 스케줄ID 생성: 거래ID-NN (기존 최대 번호 + 1)
  var sLast = sheet.getLastRow();
  var sIds = sLast >= 2 ? sheet.getRange(2, 1, sLast - 1, 1).getValues().flat() : [];
  var maxN = 0;
  var re = new RegExp("^" + 거래ID.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "-(\\d+)$");
  sIds.forEach(function(sid) {
    var m = String(sid).match(re);
    if (m) { var n = parseInt(m[1], 10); if (n > maxN) maxN = n; }
  });
  var newSid = 거래ID + "-" + ("0" + (maxN + 1)).slice(-2);

  // 현재 행 상태 확인 (빈 셀만 채우기)
  var rowData = sheet.getRange(row, 1, 1, 13).getValues()[0];
  // A 스케줄ID
  if (!rowData[0]) sheet.getRange(row, 1).setValue(newSid);
  // F 반출일 (col 6)
  if (!rowData[5]) { sheet.getRange(row, 6).setNumberFormat("yyyy-MM-dd").setValue(반출일str); }
  // G 반출시간 (col 7)
  if (!rowData[6]) { sheet.getRange(row, 7).setNumberFormat("@").setValue(반출시간str); }
  // H 반납일 (col 8)
  if (!rowData[7]) { sheet.getRange(row, 8).setNumberFormat("yyyy-MM-dd").setValue(반납일str); }
  // I 반납시간 (col 9)
  if (!rowData[8]) { sheet.getRange(row, 9).setNumberFormat("@").setValue(반납시간str); }
  // J 상태
  if (!rowData[9]) sheet.getRange(row, 10).setValue("대기");
  // M 예약자명 (col 13)
  if (!rowData[12]) sheet.getRange(row, 13).setValue(예약자명);

  // 상태바(K열 비고 활용)에 안내 — 장비명만 선택하면 됨
  var 장비명Cell = sheet.getRange(row, 4).getValue();
  if (!장비명Cell) {
    sheet.getRange(row, 11).setValue("👉 D열 장비명 선택하세요");
    sheet.getRange(row, 11).setBackground("#FFF2CC");
  } else {
    sheet.getRange(row, 11).clearContent().setBackground(null);
  }
}

/**
 * 날짜/시간 값을 register가 쓰는 문자열 포맷으로 변환 (Date → 'yyyy-MM-dd' / 'HH:mm').
 * Date 객체를 그대로 쓰면 스케줄상세 셀 서식이 1899-12-30으로 깨져서 반드시 문자열로.
 */
function _fmtDateStr(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Seoul', 'yyyy-MM-dd');
  return String(v || '').trim();
}
function _fmtTimeStr(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Seoul', 'HH:mm');
  return String(v || '').trim();
}

/**
 * 계약마스터 반출/반납 일시 변경을 스케줄상세와 개고생2.0 거래내역에 즉시 전파.
 * 같은 거래ID의 모든 스케줄상세 행은 계약마스터의 새 날짜/시간으로 통일됨.
 */
function propagateContractDates(ss, contractSheet, row, 거래ID) {
  // 날짜는 Date→yyyy-MM-dd 포맷, 시간은 사용자가 보는 표시값 그대로 복사 (LMT 역해석 회피)
  var 반출일Raw   = contractSheet.getRange(row, 5).getValue();
  var 반납일Raw   = contractSheet.getRange(row, 7).getValue();
  var 반출시간Disp = contractSheet.getRange(row, 6).getDisplayValue();
  var 반납시간Disp = contractSheet.getRange(row, 8).getDisplayValue();

  var 반출일str   = _fmtDateStr(반출일Raw);
  var 반출시간str = String(반출시간Disp || "").trim();
  var 반납일str   = _fmtDateStr(반납일Raw);
  var 반납시간str = String(반납시간Disp || "").trim();

  // 1) 스케줄상세 F~I열 덮어쓰기 (반출일/시간/반납일/시간) — 문자열 + 서식 복구
  var schedSheet = ss.getSheetByName("스케줄상세");
  if (schedSheet && schedSheet.getLastRow() >= 2) {
    var lastRow = schedSheet.getLastRow();
    var bCol = schedSheet.getRange(2, 2, lastRow - 1, 1).getValues();  // B열: 거래ID
    var updatedRows = 0;
    for (var i = 0; i < bCol.length; i++) {
      if (String(bCol[i][0]).trim() === 거래ID) {
        var r = i + 2;
        var rng = schedSheet.getRange(r, 6, 1, 4);
        // 이전 버그로 셀 포맷이 '1899-12-30'으로 깨진 상태를 복구
        rng.setNumberFormats([['yyyy-MM-dd', '@', 'yyyy-MM-dd', '@']]);
        rng.setValues([[반출일str, 반출시간str, 반납일str, 반납시간str]]);
        updatedRows++;
      }
    }
    Logger.log("스케줄상세 일정 전파: " + updatedRows + "행 (" + 거래ID + ")");
  }

  // 2) 개고생2.0 거래내역 A열(반출일) 업데이트 — 거래내역엔 반납일 필드 없음
  try {
    var 개고생URL = PropertiesService.getScriptProperties().getProperty("개고생2_URL");
    if (개고생URL) {
      var 개고생SS = SpreadsheetApp.openByUrl(개고생URL);
      var 거래시트 = 개고생SS.getSheetByName("거래내역");
      if (거래시트 && 거래시트.getLastRow() >= 2) {
        // 2026-04-23 컬럼 재배치: 거래ID D(4) → E(5)
        var ids = 거래시트.getRange(2, 5, 거래시트.getLastRow() - 1, 1).getValues();
        for (var j = 0; j < ids.length; j++) {
          if (String(ids[j][0]).trim() === 거래ID) {
            거래시트.getRange(j + 2, 1).setValue(반출일Raw);  // 거래내역 A열(날짜)은 위치 안 바뀜
            Logger.log("개고생2.0 거래내역 반출일 업데이트: 행 " + (j + 2) + " (" + 거래ID + ")");
          }
        }
      }
    }
  } catch (err) {
    Logger.log("개고생2.0 거래내역 업데이트 실패: " + err.message);
  }
}

/**
 * LMT 복원: 저장된 Date 값에 +32분 8초 더하고 일(day) 정보 제거 → 순수 HH:mm 문자열.
 * 1899-12-31 04:27:52 → 05:00
 */
function _lmtRestoreHHmm(dateVal) {
  if (!(dateVal instanceof Date)) return String(dateVal || "").trim();
  // 저장된 ms에 32m08s(= 1928000ms) 더함
  var restored = new Date(dateVal.getTime() + 1928 * 1000);
  return Utilities.formatDate(restored, "Asia/Seoul", "HH:mm");
}

/**
 * 드라이런: scanCorruptedContractTimes 결과에 각 행의 제안 시간까지 붙여서 반환.
 * 실제 시트는 건드리지 않음. 사용자 검토용.
 */
function previewContractTimeFix() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var cm = ss.getSheetByName("계약마스터");
  if (!cm || cm.getLastRow() < 2) return [];
  var data = cm.getRange(2, 1, cm.getLastRow() - 1, 8).getValues();
  var tz = "Asia/Seoul";
  var out = [];
  for (var i = 0; i < data.length; i++) {
    var id = String(data[i][0]).trim();
    if (!id) continue;
    var ft = data[i][5], bt = data[i][7];
    var fCorrupt = (ft instanceof Date) && Utilities.formatDate(ft, tz, "yyyy-MM-dd") !== "1899-12-30";
    var bCorrupt = (bt instanceof Date) && Utilities.formatDate(bt, tz, "yyyy-MM-dd") !== "1899-12-30";
    if (!fCorrupt && !bCorrupt) continue;
    out.push({
      row: i + 2,
      거래ID: id,
      반출_현재: ft instanceof Date ? Utilities.formatDate(ft, tz, "HH:mm:ss") : String(ft),
      반출_제안: fCorrupt ? _lmtRestoreHHmm(ft) : (ft instanceof Date ? Utilities.formatDate(ft, tz, "HH:mm") : String(ft || "").trim()),
      반납_현재: bt instanceof Date ? Utilities.formatDate(bt, tz, "HH:mm:ss") : String(bt),
      반납_제안: bCorrupt ? _lmtRestoreHHmm(bt) : (bt instanceof Date ? Utilities.formatDate(bt, tz, "HH:mm") : String(bt || "").trim())
    });
  }
  return { count: out.length, items: out };
}

/**
 * 실제 적용: 계약마스터 F/H의 깨진 Date 값을 LMT 복원 문자열로 덮어쓰고
 * 셀 서식을 '@'(text)로 변경. 그리고 스케줄상세까지 resync.
 */
function applyContractTimeFix() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var cm = ss.getSheetByName("계약마스터");
  if (!cm || cm.getLastRow() < 2) return "계약마스터 없음";
  var data = cm.getRange(2, 1, cm.getLastRow() - 1, 8).getValues();
  var tz = "Asia/Seoul";
  var fixed = 0;
  for (var i = 0; i < data.length; i++) {
    var id = String(data[i][0]).trim();
    if (!id) continue;
    var ft = data[i][5], bt = data[i][7];
    var fCorrupt = (ft instanceof Date) && Utilities.formatDate(ft, tz, "yyyy-MM-dd") !== "1899-12-30";
    var bCorrupt = (bt instanceof Date) && Utilities.formatDate(bt, tz, "yyyy-MM-dd") !== "1899-12-30";
    if (fCorrupt) {
      cm.getRange(i + 2, 6).setNumberFormat("@").setValue(_lmtRestoreHHmm(ft));
      fixed++;
    }
    if (bCorrupt) {
      cm.getRange(i + 2, 8).setNumberFormat("@").setValue(_lmtRestoreHHmm(bt));
    }
  }
  // 스케줄상세까지 동일한 새 값으로 재전파 (기존 배치 함수 재사용)
  var resync = resyncAllContractDates();
  return "✅ 계약마스터 시간 복원 완료 (" + fixed + "개 F/H 셀 수정) | " + resync;
}

/**
 * 진단용: 계약마스터 F(반출시간) / H(반납시간) 중 1899-12-30이 아닌 Date 값(= 하루+이상 offset) 찾기.
 * 이런 값은 내부 fraction이 1을 넘어 HH:mm이 의도한 값과 달라진 깨진 셀.
 * 반환: [{row, 거래ID, 반출시간, 반납시간}, ...]
 */
function scanCorruptedContractTimes() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var cm = ss.getSheetByName("계약마스터");
  if (!cm || cm.getLastRow() < 2) return [];

  var data = cm.getRange(2, 1, cm.getLastRow() - 1, 8).getValues();
  var tz = "Asia/Seoul";
  var bad = [];
  for (var i = 0; i < data.length; i++) {
    var id = String(data[i][0]).trim();
    if (!id) continue;
    var 반출시간 = data[i][5];
    var 반납시간 = data[i][7];
    var reason = [];
    if (반출시간 instanceof Date) {
      var d1 = Utilities.formatDate(반출시간, tz, "yyyy-MM-dd");
      if (d1 !== "1899-12-30") reason.push("반출=" + d1 + " " + Utilities.formatDate(반출시간, tz, "HH:mm:ss"));
    }
    if (반납시간 instanceof Date) {
      var d2 = Utilities.formatDate(반납시간, tz, "yyyy-MM-dd");
      if (d2 !== "1899-12-30") reason.push("반납=" + d2 + " " + Utilities.formatDate(반납시간, tz, "HH:mm:ss"));
    }
    if (reason.length > 0) {
      bad.push({ row: i + 2, 거래ID: id, 반출시간: String(반출시간), 반납시간: String(반납시간), reason: reason.join(" | ") });
    }
  }
  return { count: bad.length, items: bad };
}

/**
 * 복구용 (스케줄상세 전용, 배치): 계약마스터 전체 1회 + 스케줄상세 F~I 1회 read/write.
 * 거래내역(개고생2.0)은 건드리지 않음 — 복구 속도가 핵심이므로.
 * 사용자가 보는 그대로를 전파하려고 getDisplayValues 사용 — LMT 역해석으로 값이 밀리는 문제 회피.
 */
function resyncAllContractDates() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var cm = ss.getSheetByName("계약마스터");
  if (!cm || cm.getLastRow() < 2) return "계약마스터 없음";
  var sched = ss.getSheetByName("스케줄상세");
  if (!sched || sched.getLastRow() < 2) return "스케줄상세 없음";

  // 계약마스터 한 번에 읽기 (A~H) — 시간 값은 표시값 그대로 사용
  var cmRaw = cm.getRange(2, 1, cm.getLastRow() - 1, 8).getValues();          // 날짜(Date)는 raw로
  var cmDisp = cm.getRange(2, 1, cm.getLastRow() - 1, 8).getDisplayValues();   // 시간 텍스트 보존용
  var contractMap = {};
  for (var i = 0; i < cmRaw.length; i++) {
    var id = String(cmRaw[i][0]).trim();
    if (!id) continue;
    contractMap[id] = [
      _fmtDateStr(cmRaw[i][4]),       // E 반출일 (Date → 'yyyy-MM-dd')
      String(cmDisp[i][5] || "").trim(), // F 반출시간 (사용자가 보는 텍스트 그대로)
      _fmtDateStr(cmRaw[i][6]),       // G 반납일
      String(cmDisp[i][7] || "").trim()  // H 반납시간
    ];
  }

  // 스케줄상세 B열(거래ID) + F~I열 한 번에 읽기
  var sRows = sched.getLastRow() - 1;
  var bCol = sched.getRange(2, 2, sRows, 1).getValues();
  var existing = sched.getRange(2, 6, sRows, 4).getValues();

  var newValues = [];
  var newFormats = [];
  var changed = 0;
  for (var j = 0; j < bCol.length; j++) {
    var id2 = String(bCol[j][0]).trim();
    var c = contractMap[id2];
    if (c) {
      newValues.push(c);
      changed++;
    } else {
      newValues.push(existing[j]);
    }
    newFormats.push(['yyyy-MM-dd', '@', 'yyyy-MM-dd', '@']);
  }

  var rng = sched.getRange(2, 6, sRows, 4);
  rng.setNumberFormats(newFormats);
  rng.setValues(newValues);

  return "✅ 스케줄상세 " + changed + "행 재전파/서식복구 완료";
}

/**
 * 계약서 재생성을 디바운스하여 예약.
 * - ScriptProperties에 마지막 편집 타임스탬프 기록
 * - regenPendingContracts 트리거가 없으면 3초 뒤 one-time 트리거 생성
 * - 이미 예약된 트리거가 있으면 그대로 두고 타임스탬프만 갱신
 * - 트리거가 fire되면 타임스탬프를 다시 읽어 안정 기간(2.8초) 지난 것만 처리
 */
function scheduleContractRegen(거래ID) {
  var props = PropertiesService.getScriptProperties();
  props.setProperty('contractEditTS_' + 거래ID, String(Date.now()));

  var exists = ScriptApp.getProjectTriggers().some(function(t) {
    return t.getHandlerFunction() === 'regenPendingContracts';
  });
  if (!exists) {
    ScriptApp.newTrigger('regenPendingContracts').timeBased().after(3000).create();
  }
}

/**
 * 디바운스 트리거 핸들러: 안정된 거래ID 계약서 재생성.
 * 편집이 STABLE_MS 이상 없었던 거래ID만 처리하고, 남아있으면 다시 예약.
 */
function regenPendingContracts() {
  var STABLE_MS = 2800;
  var lock = LockService.getScriptLock();
  try { lock.waitLock(10000); } catch (e) { return; }

  try {
    // 자기 자신(트리거) 먼저 삭제 — 재예약은 마지막에 결정
    ScriptApp.getProjectTriggers().forEach(function(t) {
      if (t.getHandlerFunction() === 'regenPendingContracts') {
        ScriptApp.deleteTrigger(t);
      }
    });

    var props = PropertiesService.getScriptProperties();
    var all = props.getProperties();
    var now = Date.now();
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var stillPending = false;

    for (var key in all) {
      if (!key.startsWith('contractEditTS_')) continue;
      var 거래ID = key.substring('contractEditTS_'.length);

      // 타임스탬프 재조회 — 루프 중 onEdit이 새로 썼을 수 있음
      var freshTs = Number(props.getProperty(key));
      if (!freshTs) continue;

      var age = now - freshTs;
      if (age >= STABLE_MS) {
        try {
          deleteAndRegenerateContract(ss, 거래ID);
          Logger.log("계약서 재생성 완료(디바운스): " + 거래ID);
        } catch (err) {
          Logger.log("계약서 재생성 실패: " + 거래ID + " - " + err.message);
        }
        props.deleteProperty(key);
      } else {
        stillPending = true;
      }
    }

    if (stillPending) {
      ScriptApp.newTrigger('regenPendingContracts').timeBased().after(3000).create();
    }
  } finally {
    lock.releaseLock();
  }
}

/**
 * 계약 취소: 스케줄상세 삭제 + 개고생2.0 거래내역 삭제
 */
function cancelContract(ss, 거래ID, contractRow) {
  var contractSheet = ss.getSheetByName("계약마스터");

  // 1. 스케줄상세에서 해당 거래ID 행 삭제 (아래부터)
  var schedSheet = ss.getSheetByName("스케줄상세");
  if (schedSheet && schedSheet.getLastRow() >= 2) {
    var schedData = schedSheet.getRange(2, 1, schedSheet.getLastRow() - 1, 2).getValues();
    var deletedSched = 0;
    for (var i = schedData.length - 1; i >= 0; i--) {
      if (String(schedData[i][1]).trim() === 거래ID) {
        schedSheet.deleteRow(i + 2);
        deletedSched++;
      }
    }
    Logger.log("스케줄상세 삭제: " + deletedSched + "행 (" + 거래ID + ")");
  }

  // 2. 개고생2.0 거래내역에서 해당 거래ID 행 삭제
  try {
    var 개고생URL = PropertiesService.getScriptProperties().getProperty("개고생2_URL");
    if (개고생URL) {
      var 개고생SS = SpreadsheetApp.openByUrl(개고생URL);
      var 거래시트 = 개고생SS.getSheetByName("거래내역");
      if (거래시트 && 거래시트.getLastRow() >= 2) {
        // 2026-04-23 컬럼 재배치: 거래ID D(4) → E(5)
        var ids = 거래시트.getRange(2, 5, 거래시트.getLastRow() - 1, 1).getValues();
        for (var j = ids.length - 1; j >= 0; j--) {
          if (String(ids[j][0]).trim() === 거래ID) {
            거래시트.deleteRow(j + 2);
            Logger.log("개고생2.0 거래내역 삭제: 행 " + (j + 2) + " (" + 거래ID + ")");
          }
        }
      }
    }
  } catch (err) {
    Logger.log("개고생2.0 거래내역 삭제 실패: " + err.message);
  }

  // 3. 계약마스터 행 전체를 취소 스타일로 (연빨강 배경 + 취소선 + 어두운 글자)
  var rowRange = contractSheet.getRange(contractRow, 1, 1, 11);  // A:K
  rowRange.setBackground("#FFC7CE");
  rowRange.setFontColor("#9C0006");
  rowRange.setFontLine("line-through");

  Logger.log("계약 취소 완료: " + 거래ID);
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



