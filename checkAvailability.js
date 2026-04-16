/**
 * ====================================================================
 * checkAvailability_v3.gs — 빌리지 스케줄 관리 (구글 시트 우선 설계)
 * ====================================================================
 *
 * v3 변경사항:
 * - 메뉴 클릭 불필요: 드롭다운 선택만으로 자동 실행
 * - 같은 요청ID 일괄 처리: 확인 1번 = 전체 장비 확인, 등록 1번 = 전체 등록
 * - 날짜 상속: 같은 요청ID면 첫 행 날짜 자동 적용
 * - 세트 자동 펼침: 세트명 입력 + 확인 → 구성품 행 자동 추가
 * - 확인결과 시트 없음: 결과가 확인요청 행에 직접 표시
 * - 웹앱 지원 유지: AppSheet Bot 웹훅 호환
 *
 * 확인요청 시트 구조 (18열):
 * A: 요청ID | B: 반출일 | C: 반출시간 | D: 반납일 | E: 반납시간
 * F: 장비or세트명 | G: 수량 | H: 확인(드롭다운) | I: 결과 | J: 상세
 * K: 예약자명 | L: 연락처 | M: 업체명 | N: 등록(드롭다운)
 * O: 등록상태 | P: 거래ID | Q: 비고 | R: 추가요청(악세사리 등 자유입력)
 *
 * ★ 이 파일을 Apps Script에 붙여넣으세요 ★
 * ★ Code.gs의 onEdit()에 트리거 코드도 추가 필요 ★
 */


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 커스텀 메뉴 (타임라인 등 부가 기능용)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu("📋 빌리지 스케줄")
    .addItem("📊 타임라인 보기", "showTimeline")
    .addSeparator()
    .addItem("🔍 가용 확인 (수동 전체)", "manualProcessAll")
    .addItem("✅ 예약 등록 (수동)", "manualRegister")
    .addItem("📄 계약서 생성", "createContractFromMenu")
    .addSeparator()
    .addItem("🔄 장비 목록 갱신", "refreshEquipmentList")
    .addItem("📸 실사기록 동기화", "syncAuditFromMaster")
    .addSeparator()
    .addItem("🗑️ 확인요청 초기화 (수동)", "clearAllRequests")
    .addItem("⏰ 자동 초기화 설정", "setupAutoClear")
    .addSeparator()
    .addItem("⚙️ 계약서 설정", "setupContractSettings")
    .addItem("👤 고객DB 연동", "setupCustomerDB")
    .addSeparator()
    .addItem("📖 업무 매뉴얼", "showManual")
    .addToUi();

  // 시트 열 때마다 장비 목록 자동 갱신
  try { refreshEquipmentList(); } catch (e) { /* 첫 실행 시 무시 */ }
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 타임라인
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function showManual() {
  const html = HtmlService.createHtmlOutputFromFile('Manual')
    .setTitle('📖 업무 매뉴얼');
  SpreadsheetApp.getUi().showSidebar(html);
}

function showTimeline() {
  const html = HtmlService.createHtmlOutputFromFile('timeline')
    .setWidth(1200)
    .setHeight(680)
    .setTitle('빌리지 스케줄 타임라인');
  SpreadsheetApp.getUi().showModalDialog(html, '📊 스케줄 타임라인');
}

/**
 * 타임라인 HTML에서 google.script.run으로 호출
 * vis.js 형식으로 groups / items 반환
 */
function getTimelineData() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const schedSheet   = ss.getSheetByName('스케줄상세');
  const contractSheet = ss.getSheetByName('계약마스터');

  // 계약마스터: 거래ID → { 예약자명, 연락처 }
  const contractMap = {};
  if (contractSheet && contractSheet.getLastRow() >= 2) {
    contractSheet.getRange(2, 1, contractSheet.getLastRow() - 1, 3).getValues()
      .forEach(function(r) {
        if (r[0]) contractMap[r[0]] = { name: r[1] || '', tel: r[2] || '' };
      });
  }

  if (!schedSheet || schedSheet.getLastRow() < 2) {
    return { groups: [], items: [] };
  }

  const data = schedSheet.getRange(2, 1, schedSheet.getLastRow() - 1, 12).getValues();

  // 장비명 → group id 매핑 (중복 제거, 순서 유지)
  const groupMap  = {};
  const groupList = [];
  const itemList  = [];

  data.forEach(function(row, idx) {
    const schedID  = row[0];  // A
    const 거래ID   = row[1];  // B
    const 세트명   = row[2];  // C
    const 장비명   = row[3];  // D
    const 수량     = row[4] || 1;  // E
    const 반출일   = row[5];  // F
    const 반출시간 = row[6];  // G
    const 반납일   = row[7];  // H
    const 반납시간 = row[8];  // I
    const 상태     = row[9] || '대기';  // J
    const 단가     = row[11] || 0;  // L

    if (!장비명 || !반출일 || !반납일) return;

    // Date 파싱
    const startDT = parseDT(반출일, 반출시간);
    const endDT   = parseDT(반납일, 반납시간);
    if (!startDT || !endDT) return;

    // 그룹 등록
    if (!groupMap[장비명]) {
      groupMap[장비명] = '그룹_' + groupList.length;
      groupList.push({ id: groupMap[장비명], content: 장비명 });
    }

    // 고객 정보
    const cust = contractMap[거래ID] || {};
    const label = (cust.name ? cust.name : 거래ID) + (수량 > 1 ? ' ×' + 수량 : '');

    // 툴팁
    const tooltip = [
      '거래ID: ' + 거래ID,
      '예약자: ' + (cust.name || '-'),
      '연락처: ' + (cust.tel  || '-'),
      '장비: '  + 장비명 + (세트명 ? ' (' + 세트명 + ')' : ''),
      '수량: '  + 수량,
      '반출: '  + fmtDT(반출일, 반출시간),
      '반납: '  + fmtDT(반납일, 반납시간),
      '상태: '  + 상태,
      단가 > 0 ? '단가: ' + 단가.toLocaleString() + '원' : ''
    ].filter(Boolean).join('\n');

    // 상태 → 클래스
    const statusClass = ['대기','반출중','반납완료','취소'].indexOf(상태) >= 0
      ? 'status-' + 상태 : 'status-기타';

    itemList.push({
      id:        'item_' + idx,
      group:     groupMap[장비명],
      content:   label,
      title:     tooltip,
      start:     startDT.toISOString(),
      end:       endDT.toISOString(),
      className: statusClass,
      status:    상태
    });
  });

  return { groups: groupList, items: itemList };
}


/** "yyyy-MM-dd" + "HH:mm" → Date */
function parseDT(dateVal, timeVal) {
  try {
    let dateStr;
    if (dateVal instanceof Date) {
      dateStr = Utilities.formatDate(dateVal, 'Asia/Seoul', 'yyyy-MM-dd');
    } else {
      dateStr = String(dateVal).trim();
    }
    if (!dateStr || dateStr === '') return null;

    let timeStr = '09:00';
    if (timeVal instanceof Date) {
      timeStr = ('0' + timeVal.getHours()).slice(-2) + ':' + ('0' + timeVal.getMinutes()).slice(-2);
    } else if (timeVal && String(timeVal).trim() !== '') {
      timeStr = String(timeVal).trim();
    }

    return new Date(dateStr + 'T' + timeStr + ':00+09:00');
  } catch (e) { return null; }
}

/** 표시용 날짜+시간 문자열 */
function fmtDT(dateVal, timeVal) {
  try {
    let d, t;
    if (dateVal instanceof Date) {
      d = Utilities.formatDate(dateVal, 'Asia/Seoul', 'yyyy-MM-dd');
    } else { d = String(dateVal || '').trim(); }
    if (timeVal instanceof Date) {
      t = ('0' + timeVal.getHours()).slice(-2) + ':' + ('0' + timeVal.getMinutes()).slice(-2);
    } else { t = String(timeVal || '').trim(); }
    return d + (t ? ' ' + t : '');
  } catch (e) { return String(dateVal || ''); }
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// onEdit 핸들러 (Code.gs에서 호출)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Code.gs의 onEdit()에서 호출하는 함수
 * 확인요청 시트:
 *   B열(2): 반출일 입력 → 요청ID 자동생성/상속
 *   H열(8): "확인" 드롭다운 → 가용 확인
 *   N열(14): "등록" 드롭다운 → 예약 등록
 *
 * ※ F열(장비/세트명)은 "목록" 시트 참조 드롭다운 → 구글시트 자체 검색 사용
 */
function handleScheduleEdit(e) {
  const sheet = e.source.getActiveSheet();
  if (sheet.getName() !== "확인요청") return;

  const col = e.range.getColumn();
  const row = e.range.getRow();
  if (row < 2) return;

  const val = e.range.getValue();

  // B열(2): 반출일 입력 시 → 요청ID 자동생성
  if (col === 2 && val) {
    autoGenerateReqID(sheet, row);
  }

  // H열(8): 확인 / 발송 드롭다운
  if (col === 8) {
    if (val === "확인") {
      const aVal = sheet.getRange(row, 1).getValue().toString().trim();
      if (isTradeID(aVal)) {
        checkModificationItem(sheet, row);  // 수정 행: 계약마스터에서 날짜 조회
      } else {
        processByReqID(sheet, row);  // 신규 행: 기존 흐름
      }
    } else if (val === "발송승인") {
      sendAvailAlimtalk(sheet, row);  // 결재 후 가용확인 알림톡 발송
    }
  }

  // N열(14): 등록/추가/삭제/날짜변경/거절/보류 드롭다운
  if (col === 14) {
    if (val === "등록") {
      registerByReqID(sheet, row);
    } else if (val === "추가") {
      addEquipmentToContract(sheet, row);
    } else if (val === "삭제") {
      removeEquipmentFromContract(sheet, row);
    } else if (val === "날짜변경") {
      changeDatesForContract(sheet, row);
    } else if (val === "거절") {
      sheet.getRange(row, 15).setValue('거절');
      sheet.getRange(row, 15).setBackground('#FFC7CE');
    } else if (val === "보류") {
      sheet.getRange(row, 15).setValue('보류');
      sheet.getRange(row, 15).setBackground('#FFEB9C');
    }
  }
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// "목록" 시트 자동 생성 + F열 드롭다운 설정
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * "목록" 시트를 생성/갱신하여 장비마스터 장비명 + 세트마스터 세트명을
 * 중복 제거 후 정렬하여 A열에 나열합니다.
 * 그리고 확인요청 F열의 데이터 유효성을 목록!A:A 참조로 설정합니다.
 *
 * ★ 장비를 추가/삭제했을 때 메뉴에서 "목록 갱신"을 실행하세요.
 * ★ 또는 onOpen()에서 자동 실행되도록 설정되어 있습니다.
 */
function refreshEquipmentList() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const equipSheet = ss.getSheetByName("장비마스터");
  const setSheet = ss.getSheetByName("세트마스터");

  // ── 장비마스터 → 세트마스터 자동 동기화 ──
  // 장비마스터 D열에 있는데 세트마스터 A열에 없는 장비를 세트마스터에 자동 추가
  if (equipSheet && setSheet && equipSheet.getLastRow() >= 2) {
    const equipNames = equipSheet.getRange(2, 4, equipSheet.getLastRow() - 1, 1)
      .getValues().flat().filter(n => n).map(n => n.toString().trim());

    // 세트마스터 A열 기존 이름 수집 (중복 제거)
    const existingSetNames = new Set();
    if (setSheet.getLastRow() >= 2) {
      setSheet.getRange(2, 1, setSheet.getLastRow() - 1, 1)
        .getValues().flat().forEach(n => { if (n) existingSetNames.add(n.toString().trim()); });
    }

    // 세트마스터에 없는 장비 추가 (A=장비명, B~F 빈칸 — 개별장비로 취급)
    const toAdd = [];
    const addedCheck = new Set(); // 중복 방지
    equipNames.forEach(name => {
      if (!existingSetNames.has(name) && !addedCheck.has(name)) {
        toAdd.push([name, "", "", "", "", "", ""]);
        addedCheck.add(name);
      }
    });

    if (toAdd.length > 0) {
      const appendRow = setSheet.getLastRow() + 1;
      setSheet.getRange(appendRow, 1, toAdd.length, 7).setValues(toAdd);
      Logger.log("세트마스터에 개별장비 " + toAdd.length + "개 자동 추가됨");
    }
  }

  // ── 목록 생성: 세트마스터 A열에서만 (중복 제거 + 정렬) ──
  const names = new Set();
  if (setSheet && setSheet.getLastRow() >= 2) {
    setSheet.getRange(2, 1, setSheet.getLastRow() - 1, 1)
      .getValues().flat().forEach(n => { if (n) names.add(n.toString().trim()); });
  }

  const sorted = Array.from(names).sort();

  // ── "목록" 시트 생성 또는 초기화 ──
  let listSheet = ss.getSheetByName("목록");
  if (!listSheet) {
    listSheet = ss.insertSheet("목록");
    ss.moveActiveSheet(ss.getNumSheets());
  }
  listSheet.clear();

  listSheet.getRange(1, 1).setValue("장비/세트명");
  listSheet.getRange(1, 1).setFontWeight("bold");

  if (sorted.length > 0) {
    const values = sorted.map(n => [n]);
    listSheet.getRange(2, 1, values.length, 1).setValues(values);
  }

  listSheet.hideSheet();

  // ── 확인요청 F열에 드롭다운 설정 ──
  const reqSheet = ss.getSheetByName("확인요청");
  if (reqSheet) {
    const lastDataRow = Math.max(reqSheet.getLastRow(), 200);
    const range = reqSheet.getRange(2, 6, lastDataRow - 1, 1);

    const rule = SpreadsheetApp.newDataValidation()
      .requireValueInRange(listSheet.getRange("A2:A" + (sorted.length + 1)), true)
      .setAllowInvalid(true)
      .setHelpText("장비명 또는 세트명을 검색하세요")
      .build();
    range.setDataValidation(rule);
  }

  return sorted.length;
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 장비명 퍼지 매칭
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 입력된 장비명을 목록에서 가장 유사한 이름과 매칭
 * 정확히 매칭되면 그걸 사용, 아니면 부분 매칭 시도, 실패하면 원본 그대로 반환
 */
function fuzzyMatchEquipName(input, nameList) {
  if (!input || nameList.length === 0) return input;

  var inputLower = input.toLowerCase().replace(/\s+/g, "");

  // 1. 정확히 일치
  for (var i = 0; i < nameList.length; i++) {
    if (nameList[i] === input) return nameList[i];
  }

  // 2. 대소문자/공백 무시 일치
  for (var i = 0; i < nameList.length; i++) {
    if (nameList[i].toLowerCase().replace(/\s+/g, "") === inputLower) return nameList[i];
  }

  // 3. 한쪽이 다른 쪽을 포함 (입력값이 목록 항목 포함 또는 반대)
  var containMatches = [];
  for (var i = 0; i < nameList.length; i++) {
    var nameLower = nameList[i].toLowerCase().replace(/\s+/g, "");
    if (nameLower.indexOf(inputLower) >= 0 || inputLower.indexOf(nameLower) >= 0) {
      containMatches.push({ name: nameList[i], lenDiff: Math.abs(nameLower.length - inputLower.length) });
    }
  }
  if (containMatches.length > 0) {
    containMatches.sort(function(a, b) { return a.lenDiff - b.lenDiff; });
    return containMatches[0].name;
  }

  // 4. 핵심 키워드 매칭 (숫자+영문 조합: a7s3, fx3, gm2 등)
  var inputKeywords = inputLower.match(/[a-z]+\d+[a-z]*\d*|[a-z]{2,}/gi) || [];
  if (inputKeywords.length > 0) {
    var bestMatch = null;
    var bestScore = 0;
    for (var i = 0; i < nameList.length; i++) {
      var nameLower = nameList[i].toLowerCase().replace(/\s+/g, "");
      var score = 0;
      for (var k = 0; k < inputKeywords.length; k++) {
        if (nameLower.indexOf(inputKeywords[k].toLowerCase()) >= 0) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        bestMatch = nameList[i];
      }
    }
    if (bestMatch && bestScore >= 1) return bestMatch;
  }

  // 5. 매칭 실패 → 원본 그대로 반환 (시트에 입력은 됨)
  return input;
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 요청ID 자동생성
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * B열(반출일) 입력 시 요청ID 자동생성
 * - 이미 요청ID가 있으면 스킵
 * - 바로 위 행에 요청ID가 있고 반출일이 같으면 상속
 * - 그 외에는 새 요청ID 생성 (RQ-YYMMDD-NNN)
 */
function autoGenerateReqID(sheet, row) {
  const currentReqID = sheet.getRange(row, 1).getValue();
  if (currentReqID) return; // 이미 있으면 스킵

  const 반출일 = sheet.getRange(row, 2).getValue();
  if (!반출일) return;

  // 바로 위 행 확인 → 같은 반출일이면 요청ID 상속
  if (row > 2) {
    const prevReqID = sheet.getRange(row - 1, 1).getValue();
    const prev반출일 = sheet.getRange(row - 1, 2).getValue();
    if (prevReqID && prev반출일) {
      const d1 = new Date(반출일);
      const d2 = new Date(prev반출일);
      if (d1.getFullYear() === d2.getFullYear() &&
          d1.getMonth() === d2.getMonth() &&
          d1.getDate() === d2.getDate()) {
        sheet.getRange(row, 1).setValue(prevReqID);
        // 반출시간, 반납일, 반납시간도 상속
        const prevC = sheet.getRange(row - 1, 3).getValue();
        const prevD = sheet.getRange(row - 1, 4).getValue();
        const prevE = sheet.getRange(row - 1, 5).getValue();
        if (prevC && !sheet.getRange(row, 3).getValue()) sheet.getRange(row, 3).setValue(prevC);
        if (prevD && !sheet.getRange(row, 4).getValue()) sheet.getRange(row, 4).setValue(prevD);
        if (prevE && !sheet.getRange(row, 5).getValue()) sheet.getRange(row, 5).setValue(prevE);
        return;
      }
    }
  }

  // 새 요청ID 생성: RQ-YYMMDD-NNN
  const now = new Date();
  const dateStr = Utilities.formatDate(now, "Asia/Seoul", "yyMMdd");
  const prefix = `RQ-${dateStr}`;

  // 기존 요청ID에서 최대 번호 찾기
  const lastRow = sheet.getLastRow();
  let maxNum = 0;
  if (lastRow >= 2) {
    const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues().flat();
    ids.forEach(id => {
      if (id && id.toString().startsWith(prefix)) {
        const parts = id.toString().split("-");
        const num = parseInt(parts[2]);
        if (num > maxNum) maxNum = num;
      }
    });
  }

  const newReqID = `${prefix}-${String(maxNum + 1).padStart(3, "0")}`;
  sheet.getRange(row, 1).setValue(newReqID);
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 확인요청 일괄 입력 + 가용확인 (스크립트 호출용)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 확인요청 시트에 데이터 입력 후 가용확인까지 자동 실행
 * @param {Object} req - { 반출일, 반출시간, 반납일, 반납시간, 장비: [{이름, 수량}], 예약자명?, 연락처? }
 */
function insertAndCheckRequest(req) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("확인요청");
  if (!sheet) throw new Error("확인요청 시트 없음");

  // 요청ID 생성
  const now = new Date();
  const dateStr = Utilities.formatDate(now, "Asia/Seoul", "yyMMdd");
  const prefix = "RQ-" + dateStr;
  const lastRow = sheet.getLastRow();
  let maxNum = 0;
  if (lastRow >= 2) {
    sheet.getRange(2, 1, lastRow - 1, 1).getValues().flat().forEach(function(id) {
      if (id && id.toString().startsWith(prefix)) {
        var num = parseInt(id.toString().split("-")[2]);
        if (num > maxNum) maxNum = num;
      }
    });
  }
  var reqID = prefix + "-" + String(maxNum + 1).padStart(3, "0");

  // 첫 번째 빈 행 찾기 (A열 기준)
  var startRow = 2;
  if (lastRow >= 2) {
    var aCol = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var r = 0; r < aCol.length; r++) {
      if (!aCol[r][0] || String(aCol[r][0]).trim() === "") {
        startRow = r + 2;
        break;
      }
      startRow = r + 3; // 마지막 데이터 다음 행
    }
  }
  // 장비명 매칭: 목록에서 가장 유사한 이름 찾기
  var equipNames = [];
  try {
    var listSheet = ss.getSheetByName("목록");
    if (listSheet && listSheet.getLastRow() >= 2) {
      equipNames = listSheet.getRange(2, 1, listSheet.getLastRow() - 1, 1)
        .getValues().flat().filter(function(v) { return v; }).map(String);
    }
  } catch(e) {}

  var items = req.장비 || [];
  for (var i = 0; i < items.length; i++) {
    // 장비명 퍼지 매칭
    var inputName = String(items[i].이름 || "").trim();
    var matchedName = fuzzyMatchEquipName(inputName, equipNames);

    var row = startRow + i;
    var rowData = [
      reqID,                              // A: 요청ID
      i === 0 ? req.반출일 : "",          // B: 반출일 (첫 행만)
      i === 0 ? (req.반출시간 || "") : "",// C: 반출시간 (첫 행만)
      i === 0 ? req.반납일 : "",          // D: 반납일 (첫 행만)
      i === 0 ? (req.반납시간 || "") : "",// E: 반납시간 (첫 행만)
      matchedName,              // F: 장비/세트명 (매칭된 이름 또는 원본)
      items[i].수량 || 1,       // G: 수량
      "",                       // H: 확인 (아래에서 채움)
      "",                       // I: 결과
      "",                       // J: 상세
      i === 0 ? (req.예약자명 || "") : "",// K: 예약자명 (첫 행만)
      i === 0 ? (req.연락처 || "") : "",  // L: 연락처 (첫 행만)
      "",                       // M: 업체명
      "",                       // N: 등록
      "",                       // O: 등록상태
      "",                       // P: 거래ID
      "",                       // Q: 비고
      i === 0 ? (req.추가요청 || "") : ""  // R: 추가요청 (첫 행만)
    ];
    sheet.getRange(row, 1, 1, 18).setValues([rowData]);
  }
  SpreadsheetApp.flush();

  // 가용확인 실행
  sheet.getRange(startRow, 8).setValue("확인");
  SpreadsheetApp.flush();
  processByReqID(sheet, startRow);

  // 가용확인 결과 읽기
  SpreadsheetApp.flush();
  var results = [];
  for (var i = 0; i < items.length; i++) {
    var row = startRow + i;
    var rowData = sheet.getRange(row, 1, 1, 17).getDisplayValues()[0];
    results.push({
      장비명: rowData[5],   // F
      수량: rowData[6],     // G
      결과: rowData[8],     // I
      상세: rowData[9]      // J
    });
  }

  Logger.log("확인요청 입력 + 가용확인 완료: " + reqID + " (" + items.length + "건)");
  return { reqID: reqID, results: results };
}


/**
 * 확인요청 수정 — reqID 기준으로 데이터 업데이트 후 가용확인 재실행
 * req: { reqID: "RQ-...", 반출일?, 반출시간?, 반납일?, 반납시간?, 예약자명?, 연락처?, 장비?: [{이름, 수량}] }
 */
/**
 * 확인요청에서 특정 장비 행을 보류 처리 (등록 전 제외용)
 */
function excludeEquipFromRequest(req) {
  if (!req.reqID || !req.제외장비 || req.제외장비.length === 0) return { status: "OK", excluded: 0 };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("확인요청");
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { status: "OK", excluded: 0 };

  var data = sheet.getRange(2, 1, lastRow - 1, 17).getValues();
  var excluded = 0;

  for (var i = 0; i < data.length; i++) {
    if (String(data[i][0]).trim() !== req.reqID) continue;
    var 장비명 = String(data[i][5] || "").trim();
    if (req.제외장비.indexOf(장비명) >= 0) {
      var row = i + 2;
      sheet.getRange(row, 14).setValue("보류");     // N열
      sheet.getRange(row, 15).setValue("보류");     // O열
      excluded++;
    }
  }
  SpreadsheetApp.flush();
  return { status: "OK", excluded: excluded };
}


function updateRequest(req) {
  if (!req.reqID) throw new Error("reqID 필수");

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("확인요청");
  if (!sheet) throw new Error("확인요청 시트 없음");

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new Error("데이터 없음");

  var data = sheet.getRange(2, 1, lastRow - 1, 18).getValues();
  var targetRows = [];
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][0]).trim() === req.reqID) {
      targetRows.push(i + 2);
    }
  }
  if (targetRows.length === 0) throw new Error("요청ID를 찾을 수 없음: " + req.reqID);

  var firstRow = targetRows[0];

  // 장비 목록 변경이 있으면: 기존 행 삭제 후 재입력
  if (req.장비 && req.장비.length > 0) {
    // 기존 행 삭제 (아래부터 삭제해야 행 번호 안 꼬임)
    for (var d = targetRows.length - 1; d >= 0; d--) {
      sheet.deleteRow(targetRows[d]);
    }
    SpreadsheetApp.flush();

    // 삭제 후 첫 번째 빈 행 찾기 (A열 기준)
    var newLastRow = sheet.getLastRow();
    var startRow = 2;
    if (newLastRow >= 2) {
      var aCol = sheet.getRange(2, 1, newLastRow - 1, 1).getValues();
      for (var r = 0; r < aCol.length; r++) {
        if (!aCol[r][0] || String(aCol[r][0]).trim() === "") {
          startRow = r + 2;
          break;
        }
        startRow = r + 3;
      }
    }

    // 기존 데이터에서 날짜/시간/예약자명/연락처 가져오기 (req에 없으면)
    var origFirst = data[targetRows[0] - 2];
    var 반출일 = req.반출일 || origFirst[1];
    var 반출시간 = req.반출시간 !== undefined ? req.반출시간 : origFirst[2];
    var 반납일 = req.반납일 || origFirst[3];
    var 반납시간 = req.반납시간 !== undefined ? req.반납시간 : origFirst[4];
    var 예약자명 = req.예약자명 !== undefined ? req.예약자명 : origFirst[10];
    var 연락처 = req.연락처 !== undefined ? req.연락처 : origFirst[11];
    var 추가요청 = req.추가요청 !== undefined ? req.추가요청 : origFirst[17];

    var items = req.장비;
    for (var j = 0; j < items.length; j++) {
      var row = startRow + j;
      var rowData = [
        req.reqID,
        j === 0 ? 반출일 : "", j === 0 ? 반출시간 : "",
        j === 0 ? 반납일 : "", j === 0 ? 반납시간 : "",
        items[j].이름, items[j].수량 || 1,
        "", "", "",
        j === 0 ? 예약자명 : "", j === 0 ? 연락처 : "",
        "", "", "", "", "",
        j === 0 ? 추가요청 : ""
      ];
      sheet.getRange(row, 1, 1, 18).setValues([rowData]);
    }
    SpreadsheetApp.flush();

    // 가용확인 재실행
    sheet.getRange(startRow, 8).setValue("확인");
    SpreadsheetApp.flush();
    processByReqID(sheet, startRow);

    return { reqID: req.reqID, action: "수정", items: items.length, recheck: true };
  }

  // 장비 변경 없이 날짜/시간/예약자명/연락처만 수정
  var changed = [];
  if (req.반출일) { sheet.getRange(firstRow, 2).setValue(req.반출일); changed.push("반출일"); }
  if (req.반출시간 !== undefined) { sheet.getRange(firstRow, 3).setValue(req.반출시간); changed.push("반출시간"); }
  if (req.반납일) { sheet.getRange(firstRow, 4).setValue(req.반납일); changed.push("반납일"); }
  if (req.반납시간 !== undefined) { sheet.getRange(firstRow, 5).setValue(req.반납시간); changed.push("반납시간"); }
  if (req.예약자명 !== undefined) { sheet.getRange(firstRow, 11).setValue(req.예약자명); changed.push("예약자명"); }
  if (req.연락처 !== undefined) { sheet.getRange(firstRow, 12).setValue(req.연락처); changed.push("연락처"); }
  if (req.추가요청 !== undefined) { sheet.getRange(firstRow, 18).setValue(req.추가요청); changed.push("추가요청"); }

  // 날짜/시간 변경 시 가용확인 재실행
  var needRecheck = changed.some(function(c) { return ["반출일","반출시간","반납일","반납시간"].includes(c); });
  if (needRecheck) {
    // 결과 초기화
    for (var t = 0; t < targetRows.length; t++) {
      sheet.getRange(targetRows[t], 9, 1, 2).setValues([["", ""]]);
    }
    sheet.getRange(firstRow, 8).setValue("확인");
    SpreadsheetApp.flush();
    processByReqID(sheet, firstRow);
  }

  return { reqID: req.reqID, action: "수정", changed: changed, recheck: needRecheck };
}


/**
 * 확인요청 삭제 — reqID의 모든 행 삭제
 */
function deleteRequest(reqID) {
  if (!reqID) throw new Error("reqID 필수");

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("확인요청");
  if (!sheet) throw new Error("확인요청 시트 없음");

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new Error("데이터 없음");

  var data = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  var targetRows = [];
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][0]).trim() === reqID) {
      targetRows.push(i + 2);
    }
  }
  if (targetRows.length === 0) throw new Error("요청ID를 찾을 수 없음: " + reqID);

  // 아래부터 삭제
  for (var d = targetRows.length - 1; d >= 0; d--) {
    sheet.deleteRow(targetRows[d]);
  }

  return { reqID: reqID, action: "삭제", deletedRows: targetRows.length };
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 가용 확인 — 같은 요청ID 일괄 처리
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 특정 행의 요청ID를 기준으로 같은 ID의 모든 행을 일괄 확인
 */
function processByReqID(sheet, triggerRow) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const schedSheet = ss.getSheetByName("스케줄상세");
  const equipSheet = ss.getSheetByName("장비마스터");
  const setSheet = ss.getSheetByName("세트마스터");

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const allData = sheet.getRange(2, 1, lastRow - 1, 17).getValues();
  // 시간 컬럼은 displayValue로 대체 (1899 timezone 이슈 방지)
  var allDisplayData = sheet.getRange(2, 1, lastRow - 1, 17).getDisplayValues();
  for (var di = 0; di < allData.length; di++) { allData[di][2] = allDisplayData[di][2]; allData[di][4] = allDisplayData[di][4]; }
  const triggerReqID = allData[triggerRow - 2][0]; // A열: 요청ID

  if (!triggerReqID) {
    // 요청ID 없으면 해당 행만 처리
    checkSingleRow(sheet, triggerRow, allData, triggerRow - 2, schedSheet, equipSheet, setSheet);
    return;
  }

  // ── 같은 요청ID의 첫 행에서 날짜 정보 가져오기 ──
  let 반출일, 반출시간, 반납일, 반납시간;
  for (let i = 0; i < allData.length; i++) {
    if (allData[i][0] === triggerReqID && allData[i][1]) {
      반출일 = allData[i][1];
      반출시간 = allData[i][2];
      반납일 = allData[i][3];
      반납시간 = allData[i][4];
      break;
    }
  }

  // ── 같은 요청ID의 모든 행 처리 ──
  let expandedRows = false;
  for (let i = 0; i < allData.length; i++) {
    if (allData[i][0] !== triggerReqID) continue;

    const row = i + 2;
    const 장비명 = allData[i][5]; // F열
    if (!장비명) continue;

    // 같은 요청ID 행에 "확인" 자동 채우기
    if (sheet.getRange(row, 8).getValue() !== "확인") {
      sheet.getRange(row, 8).setValue("확인");
    }

    // 세트인지 확인 → 자동 펼침
    const setComponents = getSetComponents(장비명, setSheet);
    if (setComponents.length > 0 && !allData[i][8]) { // I열(결과)이 비어있을 때만 펼침
      expandSetRows(sheet, row, triggerReqID, setComponents, allData[i][6] || 1);
      expandedRows = true;
    }
  }

  // 세트 펼침이 있었으면 데이터 다시 읽기
  if (expandedRows) {
    SpreadsheetApp.flush();
    const newLastRow = sheet.getLastRow();
    const newAllData = sheet.getRange(2, 1, newLastRow - 1, 17).getValues();

    // 스케줄상세 데이터 미리 읽기
    const schedData = getScheduleData(schedSheet);

      for (let i = 0; i < newAllData.length; i++) {
        if (newAllData[i][0] !== triggerReqID) continue;
        if (newAllData[i][8] === "세트") continue; // 세트 헤더 행 스킵 (가용확인 불필요)
        const row = i + 2;
        const 장비명 = newAllData[i][5];
      if (!장비명) continue;

      checkSingleRowWithData(sheet, row, triggerReqID, 반출일, 반출시간, 반납일, 반납시간,
        장비명, newAllData[i][6] || 1, schedData, equipSheet);
    }
  } else {
    // 스케줄상세 데이터 미리 읽기
    const schedData = getScheduleData(schedSheet);

    for (let i = 0; i < allData.length; i++) {
      if (allData[i][0] !== triggerReqID) continue;
      const row = i + 2;
      const 장비명 = allData[i][5];
      if (!장비명) continue;

      checkSingleRowWithData(sheet, row, triggerReqID, 반출일, 반출시간, 반납일, 반납시간,
        장비명, allData[i][6] || 1, schedData, equipSheet);
    }
  }

  // ※ 가용확인 알림톡은 여기서 자동발송하지 않음
  // → H열 "발송" 선택 시 sendAvailAlimtalk()에서 별도 발송 (결재 후)

}


/**
 * H열 "발송" → 가용확인 결과 알림톡 발송 (결재 후 수동)
 * I열 결과가 이미 채워진 상태에서 발송
 */
function sendAvailAlimtalk(sheet, row) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const allData = sheet.getRange(2, 1, lastRow - 1, 17).getValues();
  const triggerIdx = row - 2;
  const reqID = allData[triggerIdx][0];
  if (!reqID) return;

  try {
    var props = PropertiesService.getScriptProperties();
    var tplCode = props.getProperty('POPBILL_TPL_AVAIL');
    var 예약자명 = '';
    var 연락처 = '';
    for (var ai = 0; ai < allData.length; ai++) {
      if (allData[ai][0] === reqID && allData[ai][10]) {
        예약자명 = allData[ai][10];
        연락처 = allData[ai][11] || '';
        break;
      }
    }
    if (!tplCode) { Logger.log('POPBILL_TPL_AVAIL 미설정'); return; }
    if (!예약자명 || !연락처) { Logger.log('예약자명/연락처 없음'); return; }

    var itemList = '';
    for (var ai2 = 0; ai2 < allData.length; ai2++) {
      if (allData[ai2][0] !== reqID) continue;
      var r = ai2 + 2;
      var name = allData[ai2][5];
      var result = sheet.getRange(r, 9).getValue();
      if (name) {
        var mark = result.toString().indexOf('✅') >= 0 ? '✅ 가능' : '❌ 불가';
        itemList += name + ' : ' + mark + '\n';
      }
    }
    var msg = '[빌리지] 장비 예약 가능 여부 안내\n\n안녕하세요, ' + 예약자명 + '님.\n빌리지입니다.\n\n'
      + '문의하신 장비의 예약 가능 여부를 안내드립니다.\n\n'
      + itemList + '\n예약을 원하시면 편하게 말씀해주세요.\n감사합니다.';
    sendAlimtalk(tplCode, 연락처, 예약자명, msg);
    Logger.log('가용확인 알림톡 발송 완료: ' + reqID);
  } catch(err) { Logger.log('가용확인 알림톡 발송 실패: ' + err.message); }
}


/**
 * 단일 행 가용 확인 (요청ID 없을 때)
 */
function checkSingleRow(sheet, row, allData, idx, schedSheet, equipSheet, setSheet) {
  const 반출일 = allData[idx][1];
  const 반출시간 = allData[idx][2];
  const 반납일 = allData[idx][3];
  const 반납시간 = allData[idx][4];
  const 장비명 = allData[idx][5];
  const 수량 = allData[idx][6] || 1;

  const schedData = getScheduleData(schedSheet);

  // 세트 체크 → 펼침
  const setComponents = getSetComponents(장비명, setSheet);
  if (setComponents.length > 0) {
    const reqID = allData[idx][0] || "REQ-" + new Date().getTime();
    if (!allData[idx][0]) sheet.getRange(row, 1).setValue(reqID);
    expandSetRows(sheet, row, reqID, setComponents, 수량);
    SpreadsheetApp.flush();

    // 데이터 다시 읽기
    const newLastRow = sheet.getLastRow();
    const newData = sheet.getRange(2, 1, newLastRow - 1, 17).getValues();
    for (let i = 0; i < newData.length; i++) {
      if (newData[i][0] !== reqID) continue;
      checkSingleRowWithData(sheet, i + 2, reqID, 반출일, 반출시간, 반납일, 반납시간,
        newData[i][5], newData[i][6] || 1, schedData, equipSheet);
    }
    return;
  }

  checkSingleRowWithData(sheet, row, allData[idx][0], 반출일, 반출시간, 반납일, 반납시간,
    장비명, 수량, schedData, equipSheet);
}

/**
 * 단일 행 가용 확인 — 핵심 로직
 */
function checkSingleRowWithData(sheet, row, reqID, 반출일, 반출시간, 반납일, 반납시간,
  장비명, 수량, schedData, equipSheet) {

  // ── 날짜 검증 ──
  if (!반출일 || !반납일 || !반출시간 || !반납시간) {
    sheet.getRange(row, 9).setValue("❌ 날짜/시간 필요");
    return;
  }

  const reqStartDT = combineDT(반출일, 반출시간);
  const reqEndDT = combineDT(반납일, 반납시간);

  if (!reqStartDT || !reqEndDT || reqStartDT >= reqEndDT) {
    sheet.getRange(row, 9).setValue("❌ 날짜범위 오류");
    return;
  }

  // ── 장비마스터에서 정보 찾기 ──
  const equipInfo = findEquipment(장비명, equipSheet);
  if (!equipInfo) {
    // 카테고리명인지 확인
    const catItems = findEquipmentByCategory(장비명, equipSheet);
    if (catItems.length > 0) {
      sheet.getRange(row, 9).setValue("⚠️ 모델 선택 필요");
      sheet.getRange(row, 10).setValue("F열 드롭다운에서 구체 모델을 선택하세요");
      sheet.getRange(row, 6).setBackground('#FFEB9C');
      return;
    }
    sheet.getRange(row, 9).setValue("❓ 미등록 장비");
    sheet.getRange(row, 10).setValue("장비마스터/세트마스터에 없음");
    return;
  }

  const 총보유 = equipInfo.total;

  // ── 시간대 겹치는 기존 예약 수량 계산 ──
  let 사용중 = 0;
  let 겹침목록 = [];

  schedData.forEach(sched => {
    if (sched.equipment !== 장비명) return;
    if (sched.status === "반납완료" || sched.status === "취소") return;

    const schedStart = sched.startDT;
    const schedEnd = sched.endDT;
    if (!schedStart || !schedEnd) return;

    // 시간 겹침 판정
    if (schedStart < reqEndDT && schedEnd > reqStartDT) {
      사용중 += sched.qty;
      const endStr = Utilities.formatDate(schedEnd, "Asia/Seoul", "M/d HH:mm");
      const overlapMin = Math.round((Math.min(reqEndDT, schedEnd) - Math.max(reqStartDT, schedStart)) / 60000);
      겹침목록.push(`${sched.contractName || sched.contractID} 반납${endStr}(${overlapMin}분겹침)`);
    }
  });

  const 가용 = 총보유 - 사용중;

  // ── 결과 판정 ──
  let result, detail;

  if (가용 >= 수량) {
    result = `✅ 가용${가용}`;
    detail = `보유${총보유}` + (사용중 > 0 ? `, 사용중${사용중}` : "");
  } else if (가용 > 0 && 가용 < 수량) {
    result = `⚠️ 부족(가용${가용}/${수량})`;
    detail = `보유${총보유}, 사용중${사용중}`;
    if (겹침목록.length > 0) detail += "\n" + 겹침목록.join("\n");
  } else if (겹침목록.length > 0) {
    result = `⚠️ 겹침(가용${가용})`;
    detail = `보유${총보유}, 사용중${사용중}\n` + 겹침목록.join("\n");
  } else {
    result = `❌ 가용0`;
    detail = `보유${총보유}, 전량사용중`;
  }

  sheet.getRange(row, 9).setValue(result);   // I열: 결과
  sheet.getRange(row, 10).setValue(detail);  // J열: 상세

  // 결과에 따른 배경색
  const color = result.startsWith("✅") ? "#C6EFCE" :
                result.startsWith("⚠️") ? "#FFEB9C" : "#FFC7CE";
  sheet.getRange(row, 9, 1, 2).setBackground(color);
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 세트 자동 펼침
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 세트 구성품 행을 현재 행 아래에 삽입
 */
function expandSetRows(sheet, setRow, reqID, components, qty) {
  const numComponents = components.length;
  const setName = sheet.getRange(setRow, 6).getValue(); // 세트명 보존
  const ss = sheet.getParent();
  const equipSheet = ss.getSheetByName("장비마스터");

  // ★ 세트 헤더 행 유지: F열 그대로, I열에 "세트" 표시
  sheet.getRange(setRow, 9).setValue("세트"); // I열: 결과 = "세트"

  // 모든 구성품을 아래에 행 삽입
  if (numComponents > 0) {
    sheet.insertRowsAfter(setRow, numComponents);

    for (let i = 0; i < numComponents; i++) {
      const newRow = setRow + 1 + i;
      sheet.getRange(newRow, 1).setValue(reqID);                        // A: 요청ID
      sheet.getRange(newRow, 6).clearDataValidations();
      sheet.getRange(newRow, 6).setValue(components[i].name);           // F: 장비명
      sheet.getRange(newRow, 7).setValue((components[i].qty || 1) * qty); // G: 수량
      sheet.getRange(newRow, 8).setValue("확인");                       // H: 확인
      sheet.getRange(newRow, 17).setValue("[세트]" + setName);          // Q: 비고 - 세트 소속 태그
      if (components[i].alt) {
        sheet.getRange(newRow, 10).setValue("대체: " + components[i].alt); // J: 상세
      }

      // ── 카테고리 구성품 감지 → 필터 드롭다운 생성 ──
      const equipInfo = findEquipment(components[i].name, equipSheet);
      if (!equipInfo) {
        // 장비마스터 D열에 없음 → C열(카테고리)에서 검색
        const categoryItems = findEquipmentByCategory(components[i].name, equipSheet);
        if (categoryItems.length > 0) {
          // 해당 카테고리 장비만 드롭다운
          const names = categoryItems.map(function(e) { return e.name; });
          const catRule = SpreadsheetApp.newDataValidation()
            .requireValueInList(names, true)
            .setAllowInvalid(true)  // 현재 카테고리명 유지 (경고만)
            .build();
          sheet.getRange(newRow, 6).setDataValidation(catRule);
          sheet.getRange(newRow, 6).setBackground('#FFEB9C');
          sheet.getRange(newRow, 6).setNote(
            '⚠️ 구체적인 모델을 선택하세요\n' +
            '─────────────\n' +
            names.map(function(n) { return '• ' + n; }).join('\n')
          );
          continue; // 이 행은 일반 드롭다운 적용 스킵
        }
      }
    }
  }

  // 데이터 유효성 재적용 (일반 구성품 행들에만 — 카테고리 행은 이미 위에서 처리)
  const listSheet = ss.getSheetByName("목록");
  if (listSheet) {
    const listLastRow = listSheet.getLastRow();
    if (listLastRow >= 2) {
      const rule = SpreadsheetApp.newDataValidation()
        .requireValueInRange(listSheet.getRange("A2:A" + listLastRow), true)
        .setAllowInvalid(false)
        .build();
      for (let i = 0; i < numComponents; i++) {
        const cellRow = setRow + 1 + i;
        // 카테고리 행(노란색)은 이미 필터 드롭다운이 설정됨 → 스킵
        if (sheet.getRange(cellRow, 6).getBackground() !== '#ffeb9c') {
          sheet.getRange(cellRow, 6).setDataValidation(rule);
        }
      }
    }
  }
}

/**
 * 세트마스터에서 구성품 조회 (가용체크=Y만)
 */
function getSetComponents(name, setSheet) {
  if (!name) return [];
  const lastRow = setSheet.getLastRow();
  if (lastRow < 2) return [];

  const data = setSheet.getRange(2, 1, lastRow - 1, 6).getValues();
  // A: 세트명, B: 구성장비명, C: 수량, D: 비고, E: 대체가능장비, F: 가용체크
  const items = data.filter(row => row[0].toString().trim() === name.toString().trim() && row[5].toString().trim() === "Y");

  return items.map(row => ({
    name: row[1],
    qty: row[2] || 1,
    alt: row[4] || ""
  }));
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 예약 등록 — 같은 요청ID 일괄
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 특정 행의 요청ID를 기준으로 같은 ID의 모든 행을 일괄 등록
 */
function registerByReqID(sheet, triggerRow) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const contractSheet = ss.getSheetByName("계약마스터");
  const schedSheet = ss.getSheetByName("스케줄상세");
  const setSheet = ss.getSheetByName("세트마스터");
  const equipSheet = ss.getSheetByName("장비마스터");

  const lastRow = sheet.getLastRow();
  const allData = sheet.getRange(2, 1, lastRow - 1, 18).getValues();
  // 시간 컬럼은 displayValue로 대체 (1899 timezone 이슈 방지)
  var regDisplayData = sheet.getRange(2, 1, lastRow - 1, 18).getDisplayValues();
  for (var di = 0; di < allData.length; di++) { allData[di][2] = regDisplayData[di][2]; allData[di][4] = regDisplayData[di][4]; allData[di][11] = regDisplayData[di][11]; }
  const triggerIdx = triggerRow - 2;
  const reqID = allData[triggerIdx][0];

  if (!reqID) {
    sheet.getRange(triggerRow, 15).setValue("❌ 요청ID 없음");
    return;
  }

  // ── 예약자명 확인 ──
  let 예약자명, 연락처, 업체명;
  for (let i = 0; i < allData.length; i++) {
    if (allData[i][0] !== reqID) continue;
    if (allData[i][10]) { 예약자명 = allData[i][10]; }  // K열
    if (allData[i][11]) { 연락처 = allData[i][11]; }    // L열
    if (allData[i][12]) { 업체명 = allData[i][12]; }    // M열
  }

  if (!예약자명) {
    sheet.getRange(triggerRow, 15).setValue("❌ 예약자명 입력 필요");
    sheet.getRange(triggerRow, 14).clearContent();
    return;
  }

  if (!연락처) {
    sheet.getRange(triggerRow, 15).setValue("❌ 연락처 입력 필요");
    sheet.getRange(triggerRow, 14).clearContent();
    return;
  }

  // ── 이미 등록된 건인지 확인 (거절/보류된 건은 재등록 허용) ──
  var hasCompleted = false;
  var hasRejectedOrHeld = false;
  for (let i = 0; i < allData.length; i++) {
    if (allData[i][0] === reqID) {
      var rowStatus = String(allData[i][14] || "").trim();
      if (rowStatus === "등록완료") hasCompleted = true;
      if (rowStatus === "거절" || rowStatus === "보류") hasRejectedOrHeld = true;
    }
  }
  if (hasCompleted && !hasRejectedOrHeld) {
    sheet.getRange(triggerRow, 15).setValue("⚠️ 이미 등록됨");
    return;
  }

  // ── 카테고리 미선택 장비 체크 (세트 구성품 중 구체 모델 미선택 차단) ──
  const 미선택목록 = [];
  for (let i = 0; i < allData.length; i++) {
    if (allData[i][0] !== reqID) continue;
    const 장비명 = allData[i][5]; // F열
    if (!장비명) continue;
    if (String(allData[i][8]) === "세트") continue; // 세트 헤더 스킵
    const eqCheck = findEquipment(장비명, equipSheet);
    if (!eqCheck) {
      const catItems = findEquipmentByCategory(장비명, equipSheet);
      if (catItems.length > 0) {
        미선택목록.push(장비명);
      }
    }
  }
  if (미선택목록.length > 0) {
    sheet.getRange(triggerRow, 15).setValue("❌ 모델 미선택: " + 미선택목록.join(", ") + " → F열에서 구체 모델을 선택하세요");
    sheet.getRange(triggerRow, 15).setBackground("#FFC7CE");
    sheet.getRange(triggerRow, 14).clearContent();
    return;
  }

  // ── 날짜 정보 (첫 행에서) ──
  let 반출일, 반출시간, 반납일, 반납시간;
  for (let i = 0; i < allData.length; i++) {
    if (allData[i][0] === reqID && allData[i][1]) {
      반출일 = allData[i][1];
      반출시간 = allData[i][2];
      반납일 = allData[i][3];
      반납시간 = allData[i][4];
      break;
    }
  }

  if (!반출일 || !반납일) {
    sheet.getRange(triggerRow, 15).setValue("❌ 날짜 정보 없음");
    sheet.getRange(triggerRow, 14).clearContent();
    return;
  }

  // ── 날짜/시간을 문자열로 변환 (Date객체 → 포맷 문자열) ──
  const fmtDate = (d) => { if (!d) return ""; if (typeof d === "string") return d; if (d instanceof Date) return Utilities.formatDate(d, "Asia/Seoul", "yyyy-MM-dd"); return String(d); };
  const fmtTime = (d) => { if (!d) return ""; if (typeof d === "string") return d; if (d instanceof Date) { const h = d.getHours(), m = d.getMinutes(); return ("0"+h).slice(-2)+":"+("0"+m).slice(-2); } return String(d); };
  const 반출일str = fmtDate(반출일);
  const 반출시간str = fmtTime(반출시간);
  const 반납일str = fmtDate(반납일);
  const 반납시간str = fmtTime(반납시간);

  // ── 거래ID 생성: YYMMDD-NNN ──
  // 개고생2.0 거래내역과 동일한 포맷 사용
  const now = new Date();
  const dateStr = Utilities.formatDate(now, "Asia/Seoul", "yyMMdd");
  const prefix거래 = dateStr;
  const contractLastRow = contractSheet.getLastRow();
  let maxNum = 0;

  if (contractLastRow >= 2) {
    const ids = contractSheet.getRange(2, 1, contractLastRow - 1, 1).getValues().flat();
    ids.forEach(id => {
      if (id && id.toString().startsWith(prefix거래 + "-")) {
        const parts = id.toString().split("-");
        const num = parseInt(parts[1]);
        if (num > maxNum) maxNum = num;
      }
    });
  }

  // 개고생2.0 거래내역도 확인 (연결된 경우) — D열(4)이 거래ID
  try {
    const 개고생URL = PropertiesService.getScriptProperties().getProperty("개고생2_URL");
    if (개고생URL) {
      const 개고생SS = SpreadsheetApp.openByUrl(개고생URL);
      const 거래시트 = 개고생SS.getSheetByName("거래내역");
      if (거래시트) {
          // D열(거래ID) 기준 실제 마지막 데이터 행 (data validation 빈 행 무시)
            const _dCol = 거래시트.getRange(2, 4, Math.max(1, 거래시트.getLastRow() - 1), 1).getValues();
            let 거래lastRow = 1;
            for (let ri = _dCol.length - 1; ri >= 0; ri--) {
              if (_dCol[ri][0] !== "" && _dCol[ri][0] != null) { 거래lastRow = ri + 2; break; }
            }
            if (거래lastRow >= 2) {
          const 거래ids = 거래시트.getRange(2, 4, 거래lastRow - 1, 1).getValues().flat();
          거래ids.forEach(id => {
            if (id && id.toString().startsWith(prefix거래 + "-")) {
              const parts = id.toString().split("-");
              const num = parseInt(parts[1]);
              if (num > maxNum) maxNum = num;
            }
          });
        }
      }
    }
  } catch (err) {
    // 개고생2.0 접근 실패 시 무시 (로컬 번호만 사용)
    Logger.log("개고생2.0 접근 실패: " + err.message);
  }

  const 거래ID = `${prefix거래}-${String(maxNum + 1).padStart(3, "0")}`;

  // ── 계약마스터에 등록 ──
  const newContractRow = contractLastRow + 1;
  contractSheet.getRange(newContractRow, 1, 1, 11).setValues([[
    거래ID, 예약자명, 연락처 || "", 업체명 || "",
    반출일str, 반출시간str, 반납일str, 반납시간str,
    "", "예약", ""
  ]]);


    // ── 스케줄상세에 장비 등록 (세트 헤더/구성품/개별 구분) ──
    let schedLastRow = schedSheet.getLastRow();
    let schedCount = 0;

    for (let i = 0; i < allData.length; i++) {
      if (allData[i][0] !== reqID) continue;
      const 장비명 = allData[i][5];
      const 수량 = allData[i][6] || 1;
      if (!장비명) continue;
      if (allData[i][14] === "거절" || allData[i][14] === "보류") continue;

      const 결과 = allData[i][8] || "";   // I열
      const 비고 = allData[i][16] || "";   // Q열

      if (String(결과) === "세트") {
        // ── 세트 헤더: C=세트명, D=세트명, L=세트단가 (세트마스터 G열 기준) ──
        const 세트단가 = findSetPrice(장비명, setSheet);
        schedCount++;
        const setSchedID = `${거래ID}-${String(schedCount).padStart(2, "0")}`;
        const setRow = schedLastRow + schedCount;
        schedSheet.getRange(setRow, 1, 1, 12).clearDataValidations();
        schedSheet.getRange(setRow, 1, 1, 12).setValues([[
          setSchedID, 거래ID, 장비명, 장비명, 수량,
          반출일str, 반출시간str, 반납일str, 반납시간str,
          "대기", "", 세트단가
        ]]);
        schedSheet.getRange(setRow, 5).setNumberFormat("#,##0");
        schedSheet.getRange(setRow, 12).setNumberFormat("#,##0");
        schedSheet.getRange(setRow, 6, 1, 4).setNumberFormat("@");

      } else if (String(비고).indexOf("[세트]") === 0) {
        // ── 세트 구성품: C=소속세트명, D=구성품명, L=0 ──
        const 소속세트 = String(비고).replace("[세트]", "");
        schedCount++;
        const compID = `${거래ID}-${String(schedCount).padStart(2, "0")}`;
        const compRow = schedLastRow + schedCount;
        schedSheet.getRange(compRow, 1, 1, 12).clearDataValidations();
        schedSheet.getRange(compRow, 1, 1, 12).setValues([[
          compID, 거래ID, 소속세트, 장비명, 수량,
          반출일str, 반출시간str, 반납일str, 반납시간str,
          "대기", "", 0
        ]]);
        schedSheet.getRange(compRow, 5).setNumberFormat("#,##0");
        schedSheet.getRange(compRow, 12).setNumberFormat("#,##0");
        schedSheet.getRange(compRow, 6, 1, 4).setNumberFormat("@");

      } else {
        // ── 개별 장비: C=빈칸, D=장비명, L=단가 (세트마스터 G열 기준) ──
        const 단가 = findSetPrice(장비명, setSheet);
        schedCount++;
        const schedID = `${거래ID}-${String(schedCount).padStart(2, "0")}`;
        const newRow = schedLastRow + schedCount;
        schedSheet.getRange(newRow, 1, 1, 12).clearDataValidations();
        schedSheet.getRange(newRow, 1, 1, 12).setValues([[
          schedID, 거래ID, "", 장비명, 수량,
          반출일str, 반출시간str, 반납일str, 반납시간str,
          "대기", "", 단가
        ]]);
        schedSheet.getRange(newRow, 5).setNumberFormat("#,##0");
        schedSheet.getRange(newRow, 12).setNumberFormat("#,##0");
        schedSheet.getRange(newRow, 6, 1, 4).setNumberFormat("@");
      }
    }

  // ── 개고생2.0 거래내역 입력 ──
  sheet.getRange(triggerRow, 15).setValue("⏳ 개고생2.0 입력 중...");
  try {
    const 개고생URL = PropertiesService.getScriptProperties().getProperty("개고생2_URL");
    if (!개고생URL) throw new Error("개고생2_URL 미설정");
    const 개고생SS = SpreadsheetApp.openByUrl(개고생URL);
    const 거래시트 = 개고생SS.getSheetByName("거래내역");
    if (!거래시트) throw new Error("거래내역 시트 없음");
    const _aCol = 거래시트.getRange(2, 1, Math.max(1, 거래시트.getLastRow() - 1), 1).getValues();
    let 거래newRow = 2;
    for (let ri = _aCol.length - 1; ri >= 0; ri--) {
      if (_aCol[ri][0] !== "" && _aCol[ri][0] != null) { 거래newRow = ri + 3; break; }
    }
    거래시트.getRange(거래newRow, 1).setValue(반출일);
    거래시트.getRange(거래newRow, 2).setValue(예약자명);
    거래시트.getRange(거래newRow, 4).setValue(거래ID);
    거래시트.getRange(거래newRow, 5).setNumberFormat("@").setValue(String(연락처 || ""));
    sheet.getRange(triggerRow, 15).setValue("✅ 개고생2.0 입력완료 (행" + 거래newRow + ")");
    Logger.log("개고생2.0 거래내역 입력 완료: " + 거래ID + " (행 " + 거래newRow + ")");
  } catch (err) {
    sheet.getRange(triggerRow, 15).setValue("❌ 개고생2.0 실패: " + err.message);
    Logger.log("개고생2.0 거래내역 입력 실패: " + err.message);
  }

  // ── R열 추가요청 수집 ──
  var 추가요청목록 = [];
  for (let i = 0; i < allData.length; i++) {
    if (allData[i][0] !== reqID) continue;
    var 추가 = String(allData[i][17] || "").trim();  // R열 (18번째, 인덱스 17)
    if (추가) 추가요청목록.push(추가);
  }
  var 추가요청텍스트 = 추가요청목록.join("\n");

  // ── 계약서 생성 (개고생2.0 입력 후 처리) ──
  try {
    const templateId = PropertiesService.getScriptProperties().getProperty("CONTRACT_TEMPLATE_ID");
    if (templateId) {
      const result = generateContractFile(ss, 거래ID, 추가요청텍스트);
      Logger.log("계약서 자동 생성 완료: " + 거래ID);
    }
  } catch (err) {
    Logger.log("계약서 자동 생성 실패 (계속 진행): " + err.message);
  }

  // ── 확인요청에 등록 결과 표시 ──
  for (let i = 0; i < allData.length; i++) {
    if (allData[i][0] !== reqID) continue;
      if (allData[i][14] === '거절' || allData[i][14] === '보류') continue;  // 거절/보류 스킵
    const row = i + 2;
    sheet.getRange(row, 14).setValue("등록");      // N열: 등록
    sheet.getRange(row, 15).setValue("등록완료");   // O열: 등록상태
    sheet.getRange(row, 16).setValue(거래ID);       // P열: 거래ID
    sheet.getRange(row, 15, 1, 2).setBackground("#C6EFCE");
  }

  // ── 알림톡 발송 — 예약 등록 완료 ──
  try {
    var props = PropertiesService.getScriptProperties();
    var tplCode = props.getProperty('POPBILL_TPL_REGISTER');
    if (tplCode && 예약자명 && 연락처) {
      var itemList = '';
      for (var ai = 0; ai < allData.length; ai++) {
        if (allData[ai][0] !== reqID) continue;
        if (allData[ai][14] === '거절' || allData[ai][14] === '보류') continue;
        // 세트 구성품 행(Q열이 "[세트]"로 시작) 제외 → 세트 헤더와 개별 장비만 포함
        if (String(allData[ai][16] || '').indexOf('[세트]') === 0) continue;
        if (allData[ai][5]) itemList += allData[ai][5] + '\n';
      }
      var 반출일Str = Utilities.formatDate(new Date(반출일), 'Asia/Seoul', 'yyyy-MM-dd');
      var 반납일Str = Utilities.formatDate(new Date(반납일), 'Asia/Seoul', 'yyyy-MM-dd');
      var msg = '[빌리지] 장비 예약 등록 완료 안내\n\n안녕하세요, ' + 예약자명 + '님.\n빌리지입니다.\n\n'
        + '요청하신 장비 예약이 등록되었습니다.\n\n'
        + '■ 거래번호: ' + 거래ID + '\n'
        + '■ 반출: ' + 반출일Str + ' ' + 반출시간 + '\n'
        + '■ 반납: ' + 반납일Str + ' ' + 반납시간 + '\n'
        + '■ 예약 장비:\n' + itemList
        + '\n문의사항은 카카오톡 채널로 편하게 연락주세요.\n감사합니다.';
      sendAlimtalk(tplCode, 연락처, 예약자명, msg);
    }
  } catch(err) { Logger.log('알림톡 발송 실패: ' + err.message); }

}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 수정 워크플로 (추가 / 삭제 / 날짜변경)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 거래ID 형식 판별 (YYMMDD-NNN)
 * reqID(RQ-...)와 구분하기 위해 사용
 */
function isTradeID(val) {
  return /^\d{6}-\d{3}$/.test(String(val || ""));
}

/**
 * 수정 행의 H열 "확인" 처리
 * A열에 거래ID가 있는 경우: 계약마스터에서 날짜를 가져와 가용 확인
 */
function checkModificationItem(sheet, row) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const schedSheet = ss.getSheetByName("스케줄상세");
  const equipSheet = ss.getSheetByName("장비마스터");
  const contractSheet = ss.getSheetByName("계약마스터");

  const 거래ID = sheet.getRange(row, 1).getValue().toString().trim();
  const 장비명 = sheet.getRange(row, 6).getValue().toString().trim();
  const 수량 = sheet.getRange(row, 7).getValue() || 1;

  if (!장비명) {
    sheet.getRange(row, 9).setValue("❌ 장비명 없음");
    return;
  }

  // 계약마스터에서 날짜 가져오기
  const contractLastRow = contractSheet.getLastRow();
  if (contractLastRow < 2) { sheet.getRange(row, 9).setValue("❌ 계약마스터 없음"); return; }

  const contractData = contractSheet.getRange(2, 1, contractLastRow - 1, 8).getValues();
  let 반출일, 반출시간, 반납일, 반납시간;
  for (let i = 0; i < contractData.length; i++) {
    if (contractData[i][0] === 거래ID) {
      반출일 = contractData[i][4];
      반출시간 = contractData[i][5];
      반납일 = contractData[i][6];
      반납시간 = contractData[i][7];
      break;
    }
  }

  if (!반출일 || !반납일) {
    sheet.getRange(row, 9).setValue("❌ 계약마스터에 해당 거래ID 없음");
    return;
  }

  const schedData = getScheduleData(schedSheet);
  checkSingleRowWithData(sheet, row, 거래ID, 반출일, 반출시간, 반납일, 반납시간, 장비명, 수량, schedData, equipSheet);
  sheet.getRange(row, 8).setValue("확인");
}


/**
 * N열 "추가" → 스케줄상세에 장비 1행 추가 + 계약서 재생성
 */
function addEquipmentToContract(sheet, row) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const schedSheet = ss.getSheetByName("스케줄상세");
  const equipSheet = ss.getSheetByName("장비마스터");
  const contractSheet = ss.getSheetByName("계약마스터");

  const 거래ID = sheet.getRange(row, 1).getValue().toString().trim();
  const 장비명 = sheet.getRange(row, 6).getValue().toString().trim();
  const 수량 = sheet.getRange(row, 7).getValue() || 1;
  const 가용결과 = sheet.getRange(row, 9).getValue().toString();

  if (!거래ID || !장비명) {
    sheet.getRange(row, 15).setValue("❌ 거래ID 또는 장비명 없음");
    sheet.getRange(row, 14).clearContent();
    return;
  }

  if (가용결과.indexOf("✅") < 0) {
    sheet.getRange(row, 15).setValue("❌ 가용 확인 먼저 필요 (H열 확인)");
    sheet.getRange(row, 14).clearContent();
    return;
  }

  // 계약마스터에서 날짜 가져오기
  const contractData = contractSheet.getRange(2, 1, Math.max(1, contractSheet.getLastRow() - 1), 8).getValues();
  let 반출일str, 반출시간str, 반납일str, 반납시간str;
  const fmtDate = (d) => { if (!d) return ""; if (d instanceof Date) return Utilities.formatDate(d, "Asia/Seoul", "yyyy-MM-dd"); return String(d); };
  const fmtTime = (d) => { if (!d) return ""; if (d instanceof Date) { const h = d.getHours(), m = d.getMinutes(); return ("0"+h).slice(-2)+":"+("0"+m).slice(-2); } return String(d); };

  for (let i = 0; i < contractData.length; i++) {
    if (contractData[i][0] === 거래ID) {
      반출일str = fmtDate(contractData[i][4]);
      반출시간str = fmtTime(contractData[i][5]);
      반납일str = fmtDate(contractData[i][6]);
      반납시간str = fmtTime(contractData[i][7]);
      break;
    }
  }

  if (!반출일str) {
    sheet.getRange(row, 15).setValue("❌ 계약마스터에 해당 거래ID 없음");
    sheet.getRange(row, 14).clearContent();
    return;
  }

  // 스케줄상세 마지막 행 뒤에 추가
  const schedLastRow = schedSheet.getLastRow();
  // 해당 거래ID의 스케줄 수 계산 → 다음 schedID 번호
  const existingScheds = schedSheet.getLastRow() >= 2
    ? schedSheet.getRange(2, 2, schedSheet.getLastRow() - 1, 1).getValues().flat().filter(id => id === 거래ID).length
    : 0;
  const newSchedNum = existingScheds + 1;
  const schedID = `${거래ID}-${String(newSchedNum).padStart(2, "0")}`;

  const setSheet = ss.getSheetByName("세트마스터");
  const 단가 = findSetPrice(장비명, setSheet);

  const newRow = schedLastRow + 1;
  schedSheet.getRange(newRow, 1, 1, 12).clearDataValidations();
  schedSheet.getRange(newRow, 1, 1, 12).setValues([[
    schedID, 거래ID, "", 장비명, 수량,
    반출일str, 반출시간str, 반납일str, 반납시간str,
    "대기", "", 단가
  ]]);
  schedSheet.getRange(newRow, 5).setNumberFormat("#,##0");
  schedSheet.getRange(newRow, 12).setNumberFormat("#,##0");
  schedSheet.getRange(newRow, 6, 1, 4).setNumberFormat("@");

  sheet.getRange(row, 15).setValue("⏳ 계약서 재생성 중...");

  // 기존 계약서 삭제 후 재생성
  try {
    const result = deleteAndRegenerateContract(ss, 거래ID);
    sheet.getRange(row, 15).setValue("✅ 추가완료 + 계약서 재생성");
    sheet.getRange(row, 15).setBackground("#C6EFCE");
  } catch (err) {
    sheet.getRange(row, 15).setValue("✅ 추가완료 (계약서 재생성 실패: " + err.message + ")");
    sheet.getRange(row, 15).setBackground("#FFEB9C");
  }
}


/**
 * N열 "삭제" → 스케줄상세에서 해당 장비 행 제거 + 계약서 재생성
 */
function removeEquipmentFromContract(sheet, row) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const schedSheet = ss.getSheetByName("스케줄상세");

  const 거래ID = sheet.getRange(row, 1).getValue().toString().trim();
  const 장비명 = sheet.getRange(row, 6).getValue().toString().trim();

  if (!거래ID || !장비명) {
    sheet.getRange(row, 15).setValue("❌ 거래ID 또는 장비명 없음");
    sheet.getRange(row, 14).clearContent();
    return;
  }

  const schedLastRow = schedSheet.getLastRow();
  if (schedLastRow < 2) {
    sheet.getRange(row, 15).setValue("❌ 스케줄상세 데이터 없음");
    sheet.getRange(row, 14).clearContent();
    return;
  }

  // 해당 거래ID + 장비명 매칭 행 찾아서 삭제 (뒤에서부터 삭제해야 행 번호 안 밀림)
  const schedData = schedSheet.getRange(2, 1, schedLastRow - 1, 4).getValues();
  // B열(index 1)=거래ID, D열(index 3)=장비명
  let deletedCount = 0;
  for (let i = schedData.length - 1; i >= 0; i--) {
    if (schedData[i][1] === 거래ID && schedData[i][3] === 장비명) {
      schedSheet.deleteRow(i + 2);
      deletedCount++;
      break; // 1행만 삭제
    }
  }

  if (deletedCount === 0) {
    sheet.getRange(row, 15).setValue("❌ 스케줄상세에서 해당 장비를 찾을 수 없음");
    sheet.getRange(row, 14).clearContent();
    return;
  }

  sheet.getRange(row, 15).setValue("⏳ 계약서 재생성 중...");

  // 기존 계약서 삭제 후 재생성
  try {
    const result = deleteAndRegenerateContract(ss, 거래ID);
    sheet.getRange(row, 15).setValue("✅ 삭제완료 + 계약서 재생성");
    sheet.getRange(row, 15).setBackground("#C6EFCE");
  } catch (err) {
    sheet.getRange(row, 15).setValue("✅ 삭제완료 (계약서 재생성 실패: " + err.message + ")");
    sheet.getRange(row, 15).setBackground("#FFEB9C");
  }
}


/**
 * N열 "날짜변경" → 계약마스터 + 스케줄상세 + 개고생2.0 날짜 일괄 수정 + 계약서 재생성
 * B~E열에 새 날짜/시간 입력 필요
 */
function changeDatesForContract(sheet, row) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const schedSheet = ss.getSheetByName("스케줄상세");
  const contractSheet = ss.getSheetByName("계약마스터");
  const equipSheet = ss.getSheetByName("장비마스터");

  const 거래ID = sheet.getRange(row, 1).getValue().toString().trim();
  const rowDisplayValues = sheet.getRange(row, 1, 1, 5).getDisplayValues()[0];
  const 새반출일Raw = sheet.getRange(row, 2).getValue();
  const 새반출시간str = rowDisplayValues[2]; // C열 displayValue
  const 새반납일Raw = sheet.getRange(row, 4).getValue();
  const 새반납시간str = rowDisplayValues[4]; // E열 displayValue

  if (!거래ID) {
    sheet.getRange(row, 15).setValue("❌ A열에 거래ID 입력 필요");
    sheet.getRange(row, 14).clearContent();
    return;
  }

  if (!새반출일Raw || !새반납일Raw) {
    sheet.getRange(row, 15).setValue("❌ B~E열에 새 반출/반납 일시 입력 필요");
    sheet.getRange(row, 14).clearContent();
    return;
  }

  const fmtDate = (d) => { if (!d) return ""; if (d instanceof Date) return Utilities.formatDate(d, "Asia/Seoul", "yyyy-MM-dd"); return String(d); };
  const 새반출일str = fmtDate(새반출일Raw);
  const 새반납일str = fmtDate(새반납일Raw);

  // 1. 계약마스터 날짜 업데이트
  const contractLastRow = contractSheet.getLastRow();
  let contractRowIndex = -1;
  if (contractLastRow >= 2) {
    const ids = contractSheet.getRange(2, 1, contractLastRow - 1, 1).getValues().flat();
    for (let i = 0; i < ids.length; i++) {
      if (ids[i] === 거래ID) { contractRowIndex = i + 2; break; }
    }
  }

  if (contractRowIndex < 0) {
    sheet.getRange(row, 15).setValue("❌ 계약마스터에 해당 거래ID 없음");
    sheet.getRange(row, 14).clearContent();
    return;
  }

  contractSheet.getRange(contractRowIndex, 5).setValue(새반출일str);
  contractSheet.getRange(contractRowIndex, 6).setValue(새반출시간str);
  contractSheet.getRange(contractRowIndex, 7).setValue(새반납일str);
  contractSheet.getRange(contractRowIndex, 8).setValue(새반납시간str);

  // 2. 스케줄상세 해당 거래ID 전체 날짜 업데이트 + 장비 목록 수집
  const schedLastRow = schedSheet.getLastRow();
  const 대상장비목록 = []; // { 장비명, 수량 }
  if (schedLastRow >= 2) {
    const schedRows = schedSheet.getRange(2, 1, schedLastRow - 1, 5).getValues();
    for (let i = 0; i < schedRows.length; i++) {
      if (schedRows[i][1] === 거래ID) {
        schedSheet.getRange(i + 2, 6).setValue(새반출일str);
        schedSheet.getRange(i + 2, 7).setValue(새반출시간str);
        schedSheet.getRange(i + 2, 8).setValue(새반납일str);
        schedSheet.getRange(i + 2, 9).setValue(새반납시간str);
        schedSheet.getRange(i + 2, 6, 1, 4).setNumberFormat("@");
        if (schedRows[i][3]) { // D열: 장비명
          대상장비목록.push({ 장비명: schedRows[i][3], 수량: schedRows[i][4] || 1 });
        }
      }
    }
  }
  SpreadsheetApp.flush();

  // 3. 새 날짜 기준 가용 확인 (해당 거래ID 본인 스케줄 제외)
  const newStartDT = combineDT(새반출일Raw, 새반출시간str);
  const newEndDT = combineDT(새반납일Raw, 새반납시간str);
  const schedData = getScheduleData(schedSheet).filter(s => s.contractID !== 거래ID);

  const 불가목록 = [];
  const 가용목록 = [];

  대상장비목록.forEach(item => {
    const equipInfo = findEquipment(item.장비명, equipSheet);
    if (!equipInfo) { 불가목록.push(item.장비명 + "(미등록)"); return; }
    const 총보유 = equipInfo.total;
    let 사용중 = 0;
    schedData.forEach(s => {
      if (s.equipment !== item.장비명) return;
      if (s.status === "반납완료" || s.status === "취소") return;
      if (s.startDT < newEndDT && s.endDT > newStartDT) 사용중 += s.qty;
    });
    const 가용 = 총보유 - 사용중;
    if (가용 >= item.수량) {
      가용목록.push(item.장비명);
    } else {
      불가목록.push(item.장비명 + `(가용${가용}/${item.수량})`);
    }
  });

  // 4. 개고생2.0 거래내역 A열(반출일) 업데이트
  try {
    const 개고생URL = PropertiesService.getScriptProperties().getProperty("개고생2_URL");
    if (개고생URL) {
      const 거래시트 = SpreadsheetApp.openByUrl(개고생URL).getSheetByName("거래내역");
      if (거래시트) {
        const ids = 거래시트.getRange(2, 4, Math.max(1, 거래시트.getLastRow() - 1), 1).getValues().flat();
        for (let i = 0; i < ids.length; i++) {
          if (ids[i] === 거래ID) { 거래시트.getRange(i + 2, 1).setValue(새반출일Raw); break; }
        }
      }
    }
  } catch (err) { Logger.log("개고생2.0 날짜 업데이트 실패: " + err.message); }

  // 5. 기존 계약서 삭제 후 재생성
  sheet.getRange(row, 15).setValue("⏳ 계약서 재생성 중...");
  let statusMsg;
  try {
    deleteAndRegenerateContract(ss, 거래ID);
    if (불가목록.length > 0) {
      statusMsg = "✅ 날짜변경완료 | ❌ 불가장비: " + 불가목록.join(", ");
      sheet.getRange(row, 15).setBackground("#FFEB9C");
    } else {
      statusMsg = "✅ 날짜변경완료 + 전체 가용";
      sheet.getRange(row, 15).setBackground("#C6EFCE");
    }
  } catch (err) {
    statusMsg = "✅ 날짜변경완료 (계약서 재생성 실패: " + err.message + ")";
    if (불가목록.length > 0) statusMsg += " | ❌ 불가: " + 불가목록.join(", ");
    sheet.getRange(row, 15).setBackground("#FFEB9C");
  }
  sheet.getRange(row, 15).setValue(statusMsg);
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 웹앱 API → sheetAPI.js로 통합됨
// doGet/doPost/doScanAll/doListPending는 sheetAPI.js에서 처리
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 보류 처리 — 같은 요청ID의 모든 행
 */
function holdByReqID(sheet, allData, reqID) {
  for (let i = 0; i < allData.length; i++) {
    if (allData[i][0] !== reqID) continue;
    const row = i + 2;
    sheet.getRange(row, 15).setValue("보류");     // O열: 등록상태
    sheet.getRange(row, 14).clearContent();       // N열: 등록 드롭다운 초기화
    sheet.getRange(row, 15).setBackground("#FFEB9C");  // 노란색
  }
}

/**
 * 거절 처리 — 같은 요청ID의 모든 행
 */
function rejectByReqID(sheet, allData, reqID) {
  for (let i = 0; i < allData.length; i++) {
    if (allData[i][0] !== reqID) continue;
    const row = i + 2;
    sheet.getRange(row, 15).setValue("거절");     // O열: 등록상태
    sheet.getRange(row, 14).clearContent();       // N열: 등록 드롭다운 초기화
    sheet.getRange(row, 15).setBackground("#FFC7CE");  // 빨간색
  }
}

/**
 * 날짜 → 문자열 변환 (JSON 출력용)
 */
function formatDateStr(d) {
  if (!d) return "";
  try {
    const date = new Date(d);
    if (isNaN(date.getTime())) return d.toString();
    return Utilities.formatDate(date, "Asia/Seoul", "yyyy-MM-dd");
  } catch (e) {
    return d.toString();
  }
}

// jsonResponse()는 sheetAPI.js에 통합 정의됨


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 유틸리티 함수
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 날짜 + 시간 합치기
 */
function combineDT(date, time) {
  if (!date) return null;
  try {
    const d = new Date(date);
    if (isNaN(d.getTime())) return null;
    if (time) {
      const t = new Date(time);
      if (!isNaN(t.getTime())) {
        d.setHours(t.getHours(), t.getMinutes(), 0, 0);
      } else if (typeof time === "string") {
        // "09:00" 형태 문자열 처리
        const parts = time.split(":");
        if (parts.length >= 2) {
          d.setHours(parseInt(parts[0]), parseInt(parts[1]), 0, 0);
        }
      }
    }
    return d;
  } catch (e) {
    return null;
  }
}

/**
 * 스케줄상세 데이터 미리 읽기 (성능 최적화)
 */
function getScheduleData(schedSheet) {
  const lastRow = schedSheet.getLastRow();
  if (lastRow < 2) return [];

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const contractSheet = ss.getSheetByName("계약마스터");

  // 계약마스터에서 예약자명 매핑
  const contractMap = {};
  const contractLastRow = contractSheet.getLastRow();
  if (contractLastRow >= 2) {
    const contracts = contractSheet.getRange(2, 1, contractLastRow - 1, 4).getValues();
    contracts.forEach(row => {
      contractMap[row[0]] = row[1] || ""; // A: 거래ID → B: 예약자명
    });
  }

  const data = schedSheet.getRange(2, 1, lastRow - 1, 11).getValues();
  return data.map(row => ({
    schedID: row[0],       // A
    contractID: row[1],    // B: 거래ID
    contractName: contractMap[row[1]] || "",
    setName: row[2],       // C: 세트명
    equipment: row[3],     // D: 장비명
    qty: row[4] || 1,      // E: 수량
    startDT: combineDT(row[5], row[6]),  // F,G: 반출일,시간
    endDT: combineDT(row[7], row[8]),    // H,I: 반납일,시간
    status: row[9],        // J: 반출상태
    note: row[10]          // K: 비고
  })).filter(s => s.startDT && s.endDT);
}

/**
 * 장비마스터에서 장비 정보 조회 (보유수량 확인용)
 * 장비마스터: A:대분류, B:장비ID, C:카테고리, D:장비명, E:총보유수량,
 *   F:가용수량, G:대여중수량, H:정비중수량, I:상태, J:비고, K:최근실사, L:단가(레거시)
 */
function findEquipment(name, equipSheet) {
  const lastRow = equipSheet.getLastRow();
  if (lastRow < 2) return null;

  const data = equipSheet.getRange(2, 1, lastRow - 1, 12).getValues();
  for (let i = 0; i < data.length; i++) {
    if (data[i][3] === name) {
      return { total: data[i][4] || 0, 단가: data[i][11] || 0 };
    }
  }
  return null;
}

/**
 * 세트마스터에서 단가 조회 (단가는 세트마스터 G열 기준)
 * 세트마스터: A:세트명, B:구성장비명, C:수량, D:비고, E:대체가능장비, F:가용체크, G:단가
 * - 세트 상품: 첫 행(A열=세트명, B열=비어있지않음)의 G열 단가 사용
 * - 개별 장비: A열=장비명, B열=빈칸인 행의 G열 단가 사용
 */
function findSetPrice(name, setSheet) {
  if (!setSheet) return 0;
  const lastRow = setSheet.getLastRow();
  if (lastRow < 2) return 0;

  const data = setSheet.getRange(2, 1, lastRow - 1, 7).getValues();
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][0]).trim() === String(name).trim()) {
      // 세트 상품: 첫 행에 단가 / 개별 장비: 해당 행에 단가
      if (data[i][6]) return data[i][6];
    }
  }
  return 0;
}

/**
 * 장비마스터 C열(카테고리)로 해당 카테고리에 속하는 구체 장비 목록 반환
 * 예: findEquipmentByCategory("7인치 모니터") → [{name:"티비로직 7인치",...}, {name:"스몰HD 7인치",...}]
 */
function findEquipmentByCategory(categoryName, equipSheet) {
  const lastRow = equipSheet.getLastRow();
  if (lastRow < 2) return [];
  const data = equipSheet.getRange(2, 1, lastRow - 1, 12).getValues();
  const items = [];
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][2]).trim() === String(categoryName).trim() && data[i][3]) {
      items.push({ name: data[i][3], total: data[i][4] || 0, 단가: data[i][11] || 0 });
    }
  }
  return items;
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 수동 실행 (메뉴용 — 백업)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 미처리 건 전체 수동 확인
 */
function manualProcessAll() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("확인요청");
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    SpreadsheetApp.getUi().alert("처리할 데이터가 없습니다.");
    return;
  }

  const data = sheet.getRange(2, 1, lastRow - 1, 17).getValues();
  let count = 0;

  const processedIDs = new Set();
  for (let i = 0; i < data.length; i++) {
    if (data[i][7] === "확인" && !data[i][8]) {
      const reqID = data[i][0];
      if (reqID && processedIDs.has(reqID)) continue;
      processByReqID(sheet, i + 2);
      if (reqID) processedIDs.add(reqID);
      count++;
    }
  }

  SpreadsheetApp.getUi().alert(`✅ ${count}건 처리 완료!`);
}

/**
 * 수동 등록
 */
function manualRegister() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("확인요청");
  const row = sheet.getActiveCell().getRow();
  if (row < 2) {
    SpreadsheetApp.getUi().alert("등록할 행을 선택하세요.");
    return;
  }
  registerByReqID(sheet, row);
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 초기화 (수동 + 자동)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 수동 초기화 (메뉴에서 실행 — 확인 팝업 있음)
 */
function clearAllRequests() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.alert(
    "확인요청 초기화",
    "확인요청 시트의 데이터(헤더 제외)를 모두 삭제합니다.\n계약마스터/스케줄상세는 유지됩니다.\n\n계속하시겠습니까?",
    ui.ButtonSet.YES_NO
  );
  if (response !== ui.Button.YES) return;

  doClearRequests();
  ui.alert("✅ 초기화 완료!");
}

/**
 * 자동 초기화 (타이머 트리거에서 실행 — 팝업 없이 조용히)
 * 등록완료된 건만 삭제합니다. 나머지는 전부 남겨둡니다.
 */
function autoClearRequests() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("확인요청");
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const data = sheet.getRange(2, 1, lastRow - 1, 17).getValues();

  // 아래에서 위로 삭제 (행 번호 꼬임 방지)
  for (let i = data.length - 1; i >= 0; i--) {
    const row = i + 2;
    const regStatus = data[i][14];  // O: 등록상태

    // 등록완료된 건만 삭제 (L열=12 수식은 보존)
    if (regStatus === "등록완료") {
      // A~K열 (1~11) 클리어
      sheet.getRange(row, 1, 1, 11).clearContent();
      sheet.getRange(row, 1, 1, 11).setBackground(null);
      // L열(12)은 수식이므로 건드리지 않음
      // M~Q열 (13~17) 클리어
      sheet.getRange(row, 13, 1, 5).clearContent();
      sheet.getRange(row, 13, 1, 5).setBackground(null);
    }
  }

  Logger.log("확인요청 자동 정리 완료 (등록완료 건 삭제): " + new Date());
}

/**
 * 전체 삭제 (수동 초기화용 내부 함수)
 */
function doClearRequests() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("확인요청");
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    // L열(12) 수식 보존: A~K, M~Q만 삭제
    sheet.getRange(2, 1, lastRow - 1, 11).clearContent();   // A~K
    sheet.getRange(2, 1, lastRow - 1, 11).setBackground(null);
    sheet.getRange(2, 13, lastRow - 1, 5).clearContent();   // M~Q
    sheet.getRange(2, 13, lastRow - 1, 5).setBackground(null);
  }
  // 초기화 후 F열 드롭다운(장비+세트) 자동 갱신
  refreshEquipmentList();
}


/**
 * ★ 자동 초기화 트리거 설정 ★
 * Apps Script에서 이 함수를 한 번만 실행하면
 * 매일 새벽 4시에 자동 정리가 돌아갑니다.
 *
 * 변경하고 싶으면 이 함수 수정 후 다시 실행하세요.
 * (기존 트리거 삭제 → 새로 생성)
 */
function setupAutoClear() {
  // 기존 autoClearRequests 트리거 삭제
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => {
    if (t.getHandlerFunction() === "autoClearRequests") {
      ScriptApp.deleteTrigger(t);
    }
  });

  // 이틀마다 새벽 4시~5시 사이 실행
  ScriptApp.newTrigger("autoClearRequests")
    .timeBased()
    .everyDays(2)      // 이틀마다
    .atHour(4)         // 새벽 4시
    .create();

  Logger.log("✅ 자동 초기화 트리거 설정 완료 (이틀마다 새벽 4시)");

  try {
    SpreadsheetApp.getUi().alert("✅ 자동 초기화 트리거 설정 완료!\n\n이틀마다 새벽 4시에 '등록완료' 건만 자동 삭제됩니다.\n(확인만 한 건, 입력 중인 건은 그대로 남아있습니다)");
  } catch (e) { /* 타이머에서 실행 시 UI 없음 */ }
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 고객DB 연동 (개고생2.0 → 숨김 시트 미러링)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 개고생2.0의 고객DB를 "고객DB" 숨김 시트로 IMPORTRANGE 연결하고,
 * 확인요청 L열에 자동 연락처 조회 수식을 설정합니다.
 *
 * ★ 최초 1회 실행 필요 ★
 * 실행 후 시트에서 IMPORTRANGE 승인 팝업이 뜨면 "액세스 허용"을 눌러야 합니다.
 */
function setupCustomerDB() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const props = PropertiesService.getScriptProperties();
  const 개고생URL = props.getProperty("개고생2_URL");

  if (!개고생URL) {
    SpreadsheetApp.getUi().alert(
      "❌ 개고생2_URL이 설정되지 않았습니다.\n" +
      "프로젝트 설정 → 스크립트 속성에 개고생2_URL을 먼저 입력하세요."
    );
    return;
  }

  // ── "고객DB" 숨김 시트 생성 ──
  let dbSheet = ss.getSheetByName("고객DB");
  if (!dbSheet) {
    dbSheet = ss.insertSheet("고객DB");
    ss.moveActiveSheet(ss.getNumSheets());
  }
  dbSheet.clear();

  // A1에 IMPORTRANGE 수식 — 고객DB의 A:B열 (연락처, 성함) 가져오기
  // 고객DB 구조: A=예약자ID(휴대폰), B=성함, C=소속
  const importFormula = `=IMPORTRANGE("${개고생URL}", "고객DB!A:B")`;
  dbSheet.getRange("A1").setFormula(importFormula);

  // 숨기기
  dbSheet.hideSheet();

  // ── 확인요청 L열에 자동 조회 수식 설정 ──
  const reqSheet = ss.getSheetByName("확인요청");
  if (reqSheet) {
    const lastRow = Math.max(reqSheet.getLastRow(), 200);

    // L3부터 수식 설정 (L2는 샘플행이므로 L3부터)
    // K열(예약자명)을 고객DB의 B열(성함)에서 찾아서 A열(연락처) 반환
    // ※ VLOOKUP은 B:A를 A:B로 자동 변환하므로 INDEX/MATCH 사용
    for (let row = 2; row <= lastRow; row++) {
      const formula = `=IF(K${row}="","",IFERROR(INDEX('고객DB'!A:A,MATCH(K${row},'고객DB'!B:B,0)),""))`;
      reqSheet.getRange(row, 12).setFormula(formula);  // L열 = 12
    }
  }

  SpreadsheetApp.getUi().alert(
    "✅ 고객DB 연동 완료!\n\n" +
    "1. '고객DB' 숨김 시트가 생성되었습니다.\n" +
    "2. 확인요청 L열에 자동 조회 수식이 설정되었습니다.\n\n" +
    "⚠️ 처음 실행 시 '고객DB' 시트를 열어서\n" +
    "IMPORTRANGE '액세스 허용' 버튼을 눌러야 합니다.\n" +
    "(숨김 해제: 시트 탭 우클릭 → 숨겨진 시트 표시)"
  );
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 팝빌 알림톡 API 연동
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 팝빌 API 토큰 발급
 * 스크립트 속성에 POPBILL_LINK_ID, POPBILL_SECRET_KEY 필요
 */
function _getPopbillToken() {
  var props = PropertiesService.getScriptProperties();
  var linkID = props.getProperty('POPBILL_LINK_ID');
  var secretKey = props.getProperty('POPBILL_SECRET_KEY');

  var scope = ['153'];
  var tokenRequestURL = 'https://auth.linkhub.co.kr/POPBILL/Token';

  var xDate = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  var reqBody = JSON.stringify({
    access_id: linkID,
    scope: scope
  });

  var md5 = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, reqBody, Utilities.Charset.UTF_8);
  var contentMD5 = Utilities.base64Encode(md5);

  var stringToSign = 'POST\n' + contentMD5 + '\n' + xDate + '\n\n/POPBILL/Token';
  var hmac = Utilities.computeHmacSha256Signature(stringToSign, Utilities.base64Decode(secretKey));
  var signature = Utilities.base64Encode(hmac);

  var options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-lh-date': xDate,
      'x-lh-version': '2.0',
      'Authorization': 'LINKHUB ' + linkID + ' ' + signature
    },
    payload: reqBody,
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(tokenRequestURL, options);
  var result = JSON.parse(response.getContentText());
  return result.session_token;
}

/**
 * 카카오 알림톡 발송
 * @param {string} templateCode - 팝빌 템플릿 코드
 * @param {string} receiver - 수신 전화번호
 * @param {string} receiverName - 수신자 이름
 * @param {string} content - 메시지 내용
 */
function sendAlimtalk(templateCode, receiver, receiverName, content) {
  var props = PropertiesService.getScriptProperties();
  var corpNum = props.getProperty('POPBILL_CORP_NUM');
  var senderNum = props.getProperty('POPBILL_SENDER_NUM');

  var token = _getPopbillToken();
  var url = 'https://popbill.linkhub.co.kr/KakaoTalk';

  var body = {
    snd: senderNum,
    content: content,
    msgs: [{
      rcv: receiver.replace(/-/g, ''),
      rcvnm: receiverName
    }],
    templateCode: templateCode,
    altSendType: 'A'
  };

  var options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Authorization': 'Bearer ' + token,
      'x-pb-userid': 'MASTER'
    },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(url + '/' + corpNum, options);
  Logger.log('알림톡 발송 결과: ' + response.getContentText());
  return JSON.parse(response.getContentText());

}

function fixScheduleHeaders() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("스케줄상세");
  if (!sheet) { Logger.log("스케줄상세 시트 없음"); return; }
  var newHeaders = ["스케줄ID", "거래ID", "세트명", "장비명", "수량", "반출일", "반출시간", "반납일", "반납시간", "상태", "비고", "단가"];
  sheet.getRange(1, 1, 1, 12).setValues([newHeaders]);
  sheet.getRange(1, 1, 1, 12).setFontWeight("bold");
  sheet.setFrozenRows(1);
  refreshEquipmentList();
  SpreadsheetApp.getUi().alert("✅ 수정 완료!\n\n1. 스케줄상세 헤더 업데이트 (12열)\n2. 확인요청 F열 드롭다운 갱신\n\n⚠️ AppSheet에서 스케줄상세 Regenerate schema도 해주세요.");
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ★ 스크립트 속성 초기 설정 (한 번만 실행) ★
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function setupScriptProperties() {
  const props = PropertiesService.getScriptProperties();
  props.setProperty("개고생2_URL", "https://docs.google.com/spreadsheets/d/1ssb6EyuRRCU04Zf4UAtdbpYYkWcseGqnhWVONdrqol8/edit");
  Logger.log("개고생2_URL 설정 완료: " + props.getProperty("개고생2_URL"));
}


function diagGosuURL() {
  const props = PropertiesService.getScriptProperties();
  const url = props.getProperty("개고생2_URL");
  Logger.log("저장된 개고생2_URL: " + url);
  if (!url) { Logger.log("❌ 개고생2_URL 미설정"); return; }
  try {
    const ss = SpreadsheetApp.openByUrl(url);
    Logger.log("✅ 접속 성공: " + ss.getName() + " (ID: " + ss.getId() + ")");
    const sheet = ss.getSheetByName("거래내역");
    Logger.log(sheet ? "✅ 거래내역 시트 존재" : "❌ 거래내역 시트 없음");
  } catch(e) {
    Logger.log("❌ 접속 실패: " + e.message);
  }
}

function diagGosuWrite() {
  try {
    const props = PropertiesService.getScriptProperties();
    const url = props.getProperty("개고생2_URL");
    const ss = SpreadsheetApp.openByUrl(url);
    const sheet = ss.getSheetByName("거래내역");

    // 마지막 행 찾기 로직 그대로
    const _aCol = sheet.getRange(2, 1, Math.max(1, sheet.getLastRow() - 1), 1).getValues();
    let newRow = 2;
    for (let ri = _aCol.length - 1; ri >= 0; ri--) {
      if (_aCol[ri][0] !== "" && _aCol[ri][0] != null) { newRow = ri + 3; break; }
    }
    Logger.log("쓰기 대상 행: " + newRow);

    // A열(날짜) 쓰기 테스트
    try {
      sheet.getRange(newRow, 1).setValue(new Date());
      Logger.log("✅ A열(날짜) 쓰기 성공");
    } catch(e) { Logger.log("❌ A열(날짜) 실패: " + e.message); }

    // B열(예약자명) 쓰기 테스트
    try {
      sheet.getRange(newRow, 2).setValue("테스트");
      Logger.log("✅ B열(예약자명) 쓰기 성공");
    } catch(e) { Logger.log("❌ B열(예약자명) 실패: " + e.message); }

    // D열(거래ID) 쓰기 테스트
    try {
      sheet.getRange(newRow, 4).setValue("260101-TEST");
      Logger.log("✅ D열(거래ID) 쓰기 성공");
    } catch(e) { Logger.log("❌ D열(거래ID) 실패: " + e.message); }

    // E열(연락처) 쓰기 테스트
    try {
      sheet.getRange(newRow, 5).setNumberFormat("@").setValue("01000000000");
      Logger.log("✅ E열(연락처) 쓰기 성공");
    } catch(e) { Logger.log("❌ E열(연락처) 실패: " + e.message); }

    // F열(업체명) 쓰기 테스트
    try {
      sheet.getRange(newRow, 6).setValue("테스트업체");
      Logger.log("✅ F열(업체명) 쓰기 성공");
    } catch(e) { Logger.log("❌ F열(업체명) 실패: " + e.message); }

    Logger.log("진단 완료. " + newRow + "행에 테스트 데이터 입력됨 — 확인 후 수동 삭제하세요.");
  } catch(e) {
    Logger.log("❌ 전체 오류: " + e.message);
  }
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ★ 단가 마이그레이션: 장비마스터 → 세트마스터 G열 ★
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 장비마스터 L열(단가) → 세트마스터 G열로 자동 이관
 * 매칭 조건: 세트마스터 A열 == 장비마스터 D열 (장비명 일치)
 * 세트마스터에 이미 G열 값이 있으면 덮어쓰지 않음 (skipExisting=true)
 *
 * ★ GAS 에디터에서 한 번만 실행하세요 ★
 */
function migratePriceToSetMaster() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const equipSheet = ss.getSheetByName("장비마스터");
  const setSheet = ss.getSheetByName("세트마스터");

  if (!equipSheet || !setSheet) {
    Logger.log("❌ 장비마스터 또는 세트마스터 시트가 없습니다.");
    return;
  }

  // 장비마스터: D열(장비명) → L열(단가) 매핑
  const equipLastRow = equipSheet.getLastRow();
  if (equipLastRow < 2) { Logger.log("장비마스터에 데이터 없음"); return; }

  const equipData = equipSheet.getRange(2, 4, equipLastRow - 1, 9).getValues(); // D~L열
  const priceMap = {};
  for (let i = 0; i < equipData.length; i++) {
    const name = String(equipData[i][0]).trim(); // D열 (index 0)
    const price = equipData[i][8]; // L열 (D+8 = index 8)
    if (name && price) {
      priceMap[name] = price;
    }
  }
  Logger.log("장비마스터 단가 " + Object.keys(priceMap).length + "건 로드");

  // 세트마스터: A열(세트/장비명), G열(단가)
  const setLastRow = setSheet.getLastRow();
  if (setLastRow < 2) { Logger.log("세트마스터에 데이터 없음"); return; }

  // G열 헤더 확인 및 설정
  const gHeader = setSheet.getRange(1, 7).getValue();
  if (!gHeader || String(gHeader).trim() === "") {
    setSheet.getRange(1, 7).setValue("단가");
    setSheet.getRange(1, 7).setFontWeight("bold");
  }

  const setData = setSheet.getRange(2, 1, setLastRow - 1, 7).getValues(); // A~G열
  let updated = 0;
  let skipped = 0;

  for (let i = 0; i < setData.length; i++) {
    const setName = String(setData[i][0]).trim(); // A열
    const existingPrice = setData[i][6]; // G열

    // 이미 단가가 있으면 스킵
    if (existingPrice) { skipped++; continue; }

    // 장비마스터에서 매칭
    if (setName && priceMap[setName]) {
      setSheet.getRange(i + 2, 7).setValue(priceMap[setName]);
      setSheet.getRange(i + 2, 7).setNumberFormat("#,##0");
      updated++;
    }
  }

  Logger.log("✅ 세트마스터 단가 이관 완료: " + updated + "건 업데이트, " + skipped + "건 스킵(기존값 유지)");
  Logger.log("매칭 안 된 항목은 세트 상품(풀세트 등)이므로 수동 입력 필요");

  try {
    SpreadsheetApp.getUi().alert(
      "✅ 단가 이관 완료!\n\n" +
      "• 장비마스터 → 세트마스터: " + updated + "건 자동 입력\n" +
      "• 기존값 유지: " + skipped + "건 스킵\n\n" +
      "⚠️ 세트 상품(풀세트 등)의 단가는 세트마스터 G열에 직접 입력해주세요."
    );
  } catch(e) {
    // UI 없는 환경에서도 동작
  }
}


/**
 * 계약서 템플릿의 숨김 "마스터" 시트를 세트마스터 데이터로 교체
 * A열: 세트/장비명 (세트마스터 A열, 중복 제거)
 * B열: 단가 (세트마스터 G열)
 *
 * ★ migratePriceToSetMaster() 실행 후에 이 함수를 실행하세요 ★
 */
function syncTemplateHiddenSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const setSheet = ss.getSheetByName("세트마스터");
  if (!setSheet) { Logger.log("❌ 세트마스터 없음"); return; }

  const props = PropertiesService.getScriptProperties();
  const templateId = props.getProperty("CONTRACT_TEMPLATE_ID");
  if (!templateId) {
    Logger.log("❌ CONTRACT_TEMPLATE_ID 미설정");
    try { SpreadsheetApp.getUi().alert("❌ 계약서 템플릿 ID가 설정되지 않았습니다.\n⚙️ 계약서 설정 먼저 실행하세요."); } catch(e) {}
    return;
  }

  // 세트마스터에서 이름+단가 수집 (A열 기준 중복 제거, 첫 등장 단가 사용)
  const setLastRow = setSheet.getLastRow();
  if (setLastRow < 2) { Logger.log("세트마스터 데이터 없음"); return; }

  const setData = setSheet.getRange(2, 1, setLastRow - 1, 7).getValues();
  const nameMap = new Map(); // 이름 → 단가 (중복 제거, 첫 등장 우선)

  for (let i = 0; i < setData.length; i++) {
    const name = String(setData[i][0]).trim();
    if (!name) continue;
    if (!nameMap.has(name)) {
      nameMap.set(name, setData[i][6] || 0);
    }
  }

  const entries = Array.from(nameMap.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  Logger.log("세트마스터에서 " + entries.length + "개 항목 수집");

  // 템플릿 파일 열기
  const templateSS = SpreadsheetApp.openById(templateId);
  let masterSheet = templateSS.getSheetByName("마스터");

  if (!masterSheet) {
    // "마스터" 시트가 없으면 생성
    masterSheet = templateSS.insertSheet("마스터");
    masterSheet.hideSheet();
    Logger.log("템플릿에 '마스터' 시트 생성");
  }

  // 기존 데이터 클리어
  masterSheet.clear();

  // 헤더
  masterSheet.getRange(1, 1).setValue("장비/세트명");
  masterSheet.getRange(1, 2).setValue("단가");
  masterSheet.getRange(1, 1, 1, 2).setFontWeight("bold");

  // 데이터 쓰기
  if (entries.length > 0) {
    const values = entries.map(e => [e[0], e[1]]);
    masterSheet.getRange(2, 1, values.length, 2).setValues(values);
    masterSheet.getRange(2, 2, values.length, 1).setNumberFormat("#,##0");
  }

  Logger.log("✅ 계약서 템플릿 '마스터' 시트 업데이트 완료: " + entries.length + "개 항목");

  try {
    SpreadsheetApp.getUi().alert(
      "✅ 계약서 템플릿 '마스터' 시트 업데이트 완료!\n\n" +
      "• " + entries.length + "개 항목 (세트마스터 기준)\n" +
      "• A열: 장비/세트명\n" +
      "• B열: 단가\n\n" +
      "기존 드롭다운 참조(='마스터'!$A$2:$A$...)는 그대로 유지됩니다."
    );
  } catch(e) {}
}


