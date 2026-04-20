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
    .addItem("📅 오늘 일정", "openDashboard")
    .addSeparator()
    .addItem("🔍 가용 확인 (수동 전체)", "manualProcessAll")
    .addItem("✅ 예약 등록 (수동)", "manualRegister")
    .addItem("📄 계약서 생성", "createContractFromMenu")
    .addSeparator()
    .addItem("🔄 장비 목록 갱신", "refreshEquipmentList")
    .addItem("🎨 계약마스터 서식 적용", "formatContractSheet")
    .addItem("📸 실사기록 동기화", "syncAuditFromMaster")
    .addSeparator()
    .addItem("🗑️ 확인요청 초기화 (수동)", "clearAllRequests")
    .addSeparator()
    .addItem("⚙️ 계약서 설정", "setupContractSettings")
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

function openDashboard() {
  var url = PropertiesService.getScriptProperties().getProperty('WEB_APP_URL');
  if (!url) url = ScriptApp.getService().getUrl();
  url += '?page=dashboard';
  const html = HtmlService.createHtmlOutput(
    '<script>window.open("' + url + '", "_blank");google.script.host.close();</script>'
  ).setWidth(200).setHeight(50);
  SpreadsheetApp.getUi().showModalDialog(html, '오늘 일정 열기');
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

  const seen = {};   // "거래ID|그룹명" → true
  const entries = [];

  // 행 처리 함수
  function processRow(row, idx, isSetPhase) {
    const 거래ID   = row[1];  // B
    const 세트명   = String(row[2] || '').trim();  // C
    const 장비명   = String(row[3] || '').trim();  // D
    const 수량     = Number(row[4]) || 1;  // E
    const 반출일   = row[5];  // F
    const 반출시간 = row[6];  // G
    const 반납일   = row[7];  // H
    const 반납시간 = row[8];  // I
    const 상태     = row[9] || '대기';  // J
    const 단가     = Number(row[11]) || 0;  // L

    if (!반출일 || !반납일) return;

    var groupName, isSingleItem;

    if (isSetPhase) {
      if (!세트명) return;  // Phase 1: 세트명 있는 행만
      groupName = 세트명;
      isSingleItem = false;
    } else {
      if (세트명) return;   // Phase 2: 세트명 없는 행만 (=사용자가 단독 추가한 장비)
      if (!장비명) return;
      groupName = 장비명;
      isSingleItem = true;
    }

    const key = 거래ID + '|' + groupName;
    if (seen[key]) return;  // 중복 방지
    seen[key] = true;

    const startDT = parseDT(반출일, 반출시간);
    const endDT   = parseDT(반납일, 반납시간);
    if (!startDT || !endDT) return;

    const cust = contractMap[거래ID] || {};

    // 같은 거래ID+세트명의 모든 행 인덱스 수집
    var rowIndices = [];
    if (!isSingleItem) {
      data.forEach(function(r, i) {
        if (r[1] === 거래ID && String(r[2] || '').trim() === 세트명) {
          rowIndices.push(i + 2);
        }
      });
    } else {
      rowIndices = [idx + 2];
    }

    entries.push({
      거래ID:    거래ID,
      groupName: groupName,
      custName:  cust.name || 거래ID || '',
      tel:       cust.tel || '',
      startDT:   startDT,
      endDT:     endDT,
      상태:      상태,
      수량:      수량,
      단가:      단가,
      rowIndices: rowIndices,
      반출:      fmtDT(반출일, 반출시간),
      반납:      fmtDT(반납일, 반납시간),
      isSingleItem: isSingleItem
    });
  }

  // Phase 1: 세트 행 먼저 (세트명 있는 행)
  data.forEach(function(row, idx) { processRow(row, idx, true); });
  // Phase 2: 개별 장비 행 (세트명 없고 구성품 아닌 것만)
  data.forEach(function(row, idx) { processRow(row, idx, false); });

  // 그룹 및 아이템 생성
  const groupMap  = {};
  const groupList = [];
  const itemList  = [];
  var itemIdx = 0;

  entries.forEach(function(e) {
    // 그룹 등록
    if (!groupMap[e.groupName]) {
      groupMap[e.groupName] = 'g_' + groupList.length;
      groupList.push({ id: groupMap[e.groupName], content: e.groupName });
    }

    var statusClass = ['대기','반출중','반납완료','취소'].indexOf(e.상태) >= 0
      ? 'status-' + e.상태 : 'status-기타';

    // 세트: 수량만큼 바 생성, 개별장비: 1개 바
    var barCount = e.isSingleItem ? 1 : (e.수량 || 1);

    for (var s = 0; s < barCount; s++) {
      itemList.push({
        id:        'item_' + itemIdx++,
        rowIndex:  e.rowIndices[0],
        rowIndices: e.rowIndices,
        group:     groupMap[e.groupName],
        content:   e.custName,
        start:     e.startDT.toISOString(),
        end:       e.endDT.toISOString(),
        className: statusClass,
        status:    e.상태,
        editable:  { updateTime: true, remove: false },
        custName:  e.custName,
        tel:       e.tel,
        거래ID:    e.거래ID,
        세트명:    e.groupName,
        장비명:    e.isSingleItem ? e.groupName : '세트 구성품',
        수량:      e.isSingleItem ? e.수량 : barCount + '세트',
        반출:      e.반출,
        반납:      e.반납,
        단가:      e.단가
      });
    }
  });

  return { groups: groupList, items: itemList };
}

/**
 * 타임라인 드래그로 일정 변경 시 스케줄상세 시트 업데이트
 * rowIndex: 대표 행 번호, rowIndices: 같은 세트의 전체 행 (JSON string 가능)
 */
function updateScheduleTime(rowIndex, newStart, newEnd, rowIndices) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('스케줄상세');
  if (!sheet) return { success: false, message: '스케줄상세 시트 없음' };

  var startDate = new Date(newStart);
  var endDate = new Date(newEnd);
  var startTime = ('0' + startDate.getHours()).slice(-2) + ':' + ('0' + startDate.getMinutes()).slice(-2);
  var endTime   = ('0' + endDate.getHours()).slice(-2) + ':' + ('0' + endDate.getMinutes()).slice(-2);

  // 같은 세트의 모든 행 업데이트
  var rows = [];
  if (rowIndices) {
    try { rows = JSON.parse(rowIndices); } catch(e) { rows = [rowIndex]; }
  } else {
    rows = [rowIndex];
  }

  rows.forEach(function(r) {
    sheet.getRange(r, 6).setValue(startDate);   // F: 반출일
    sheet.getRange(r, 7).setValue(startTime);   // G: 반출시간
    sheet.getRange(r, 8).setValue(endDate);     // H: 반납일
    sheet.getRange(r, 9).setValue(endTime);     // I: 반납시간
  });

  return { success: true };
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 오늘 반출/반납 대시보드 데이터
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function getDashboardData(targetDate) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const schedSheet   = ss.getSheetByName('스케줄상세');
  const contractSheet = ss.getSheetByName('계약마스터');

  var today = targetDate || Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');

  // 계약마스터: 거래ID → { 예약자명, 연락처, 업체명 }
  var contractMap = {};
  if (contractSheet && contractSheet.getLastRow() >= 2) {
    var cData = contractSheet.getRange(2, 1, contractSheet.getLastRow() - 1, 4).getValues();
    cData.forEach(function(r) {
      if (r[0]) contractMap[r[0]] = { name: r[1] || '', tel: r[2] || '', company: r[3] || '' };
    });
  }

  if (!schedSheet || schedSheet.getLastRow() < 2) {
    return { checkout: [], checkin: [], activeCount: 0 };
  }

  var data = schedSheet.getRange(2, 1, schedSheet.getLastRow() - 1, 12).getValues();

  // 거래ID별 그룹핑
  var tradeGroups = {};

  data.forEach(function(row) {
    var 거래ID   = row[1];  // B
    var 세트명   = row[2];  // C
    var 장비명   = row[3];  // D
    var 수량     = row[4] || 1;  // E
    var 반출일   = row[5];  // F
    var 반출시간 = row[6];  // G
    var 반납일   = row[7];  // H
    var 반납시간 = row[8];  // I
    var 상태     = row[9] || '대기';  // J

    if (!장비명 || !반출일 || !반납일 || !거래ID) return;
    if (상태 === '취소') return;

    var 반출일str = 반출일 instanceof Date
      ? Utilities.formatDate(반출일, 'Asia/Seoul', 'yyyy-MM-dd') : String(반출일).trim();
    var 반납일str = 반납일 instanceof Date
      ? Utilities.formatDate(반납일, 'Asia/Seoul', 'yyyy-MM-dd') : String(반납일).trim();

    var 반출시간str = 반출시간 instanceof Date
      ? Utilities.formatDate(반출시간, 'Asia/Seoul', 'HH:mm') : String(반출시간 || '').trim();
    var 반납시간str = 반납시간 instanceof Date
      ? Utilities.formatDate(반납시간, 'Asia/Seoul', 'HH:mm') : String(반납시간 || '').trim();

    if (!tradeGroups[거래ID]) {
      tradeGroups[거래ID] = {
        거래ID: 거래ID,
        반출일: 반출일str,
        반출시간: 반출시간str,
        반납일: 반납일str,
        반납시간: 반납시간str,
        상태: 상태,
        equipments: []
      };
    }

    var isSet = (세트명 && 장비명 === 세트명);
    tradeGroups[거래ID].equipments.push({
      name: 장비명,
      qty: 수량,
      isSet: isSet,
      setName: 세트명 || ''
    });
  });

  var checkoutList = [];
  var checkinList = [];
  var activeCount = 0;

  Object.keys(tradeGroups).forEach(function(tid) {
    var g = tradeGroups[tid];
    var cust = contractMap[tid] || {};

    // 세트 구성품 제외 (세트 헤더만 표시)
    var setNames = {};
    g.equipments.forEach(function(eq) { if (eq.isSet) setNames[eq.name] = true; });
    var displayEquip = g.equipments.filter(function(eq) {
      if (eq.setName && setNames[eq.setName] && !eq.isSet) return false;
      return true;
    });

    var item = {
      tradeId: tid,
      name: cust.name || tid,
      tel: cust.tel || '',
      company: cust.company || '',
      status: g.상태,
      equipments: displayEquip
    };

    // 오늘 반출
    if (g.반출일 === today) {
      item.time = g.반출시간 || '시간 미정';
      item.sortTime = g.반출시간 || '99:99';
      item.returnDate = g.반납일 + (g.반납시간 ? ' ' + g.반납시간 : '');
      item._type = 'checkout';
      checkoutList.push(item);
    }

    // 오늘 반납
    if (g.반납일 === today) {
      var checkinItem = JSON.parse(JSON.stringify(item));
      checkinItem.time = g.반납시간 || '시간 미정';
      checkinItem.sortTime = g.반납시간 || '99:99';
      checkinItem.checkoutDate = g.반출일 + (g.반출시간 ? ' ' + g.반출시간 : '');
      checkinItem._type = 'checkin';
      checkinList.push(checkinItem);
    }

    // 현재 대여중 (반출일 <= 오늘 <= 반납일, 취소 아님)
    if (g.반출일 <= today && g.반납일 >= today && g.상태 !== '반납완료') {
      activeCount++;
    }
  });

  // 시간순 정렬
  checkoutList.sort(function(a, b) { return (a.sortTime || '').localeCompare(b.sortTime || ''); });
  checkinList.sort(function(a, b) { return (a.sortTime || '').localeCompare(b.sortTime || ''); });

  return { checkout: checkoutList, checkin: checkinList, activeCount: activeCount };
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
      timeStr = Utilities.formatDate(timeVal, 'Asia/Seoul', 'HH:mm');
    } else if (timeVal && String(timeVal).trim() !== '') {
      timeStr = String(timeVal).trim();
    }

    // 한 자리 시간(예: "7:00")을 두 자리로 패딩 (ISO 형식 필수)
    var timeParts = timeStr.split(':');
    if (timeParts.length >= 2) {
      timeStr = ('0' + timeParts[0]).slice(-2) + ':' + ('0' + timeParts[1]).slice(-2);
    }

    var dt = new Date(dateStr + 'T' + timeStr + ':00+09:00');
    if (isNaN(dt.getTime())) return null;
    return dt;
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
      t = Utilities.formatDate(timeVal, 'Asia/Seoul', 'HH:mm');
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
      // API에서 이미 등록 처리한 경우 onEdit 이중 호출 방지
      var oVal = sheet.getRange(row, 15).getValue();
      if (String(oVal).indexOf("등록완료") >= 0) return;
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
    const lastDataRow = reqSheet.getMaxRows();
    const range = reqSheet.getRange(2, 6, lastDataRow - 1, 1);

    const rule = SpreadsheetApp.newDataValidation()
      .requireValueInRange(listSheet.getRange("A2:A" + (sorted.length + 1)), true)
      .setAllowInvalid(true)
      .setHelpText("장비명 또는 세트명을 검색하세요")
      .build();
    range.setDataValidation(rule);

    // ── 확인요청 C열(반출시간), E열(반납시간) 시간 드롭다운 설정 ──
    var timeList = [];
    for (var h = 0; h <= 23; h++) {
      timeList.push(("0" + h).slice(-2) + ":00");
    }
    var timeRule = SpreadsheetApp.newDataValidation()
      .requireValueInList(timeList, true)
      .setAllowInvalid(true)
      .setHelpText("시간을 선택하세요")
      .build();
    reqSheet.getRange(2, 3, lastDataRow - 1, 1).setDataValidation(timeRule); // C열: 반출시간
    reqSheet.getRange(2, 5, lastDataRow - 1, 1).setDataValidation(timeRule); // E열: 반납시간

    // ── 확인요청 H열(확인) 드롭다운 설정 ──
    var hRule = SpreadsheetApp.newDataValidation()
      .requireValueInList(["확인", "발송승인"], true)
      .setAllowInvalid(true)
      .build();
    reqSheet.getRange(2, 8, lastDataRow - 1, 1).setDataValidation(hRule);

    // ── 확인요청 N열(등록) 드롭다운 설정 ──
    var nRule = SpreadsheetApp.newDataValidation()
      .requireValueInList(["등록", "추가", "삭제", "날짜변경", "거절", "보류"], true)
      .setAllowInvalid(true)
      .build();
    reqSheet.getRange(2, 14, lastDataRow - 1, 1).setDataValidation(nRule);
  }

  // ── 스케줄상세 C열(세트명), D열(장비명)에 드롭다운 설정 ──
  const schedSheet = ss.getSheetByName("스케줄상세");
  if (schedSheet) {
    const schedLastRow = schedSheet.getMaxRows();
    const schedRule = SpreadsheetApp.newDataValidation()
      .requireValueInRange(listSheet.getRange("A2:A" + (sorted.length + 1)), true)
      .setAllowInvalid(true)
      .setHelpText("장비명 또는 세트명을 검색하세요")
      .build();
    schedSheet.getRange(2, 3, schedLastRow - 1, 1).setDataValidation(schedRule); // C열
    schedSheet.getRange(2, 4, schedLastRow - 1, 1).setDataValidation(schedRule); // D열
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

  // 5. 레벤슈타인 거리 기반 유사도 매칭
  var bestLev = null;
  var bestDist = Infinity;
  for (var i = 0; i < nameList.length; i++) {
    var nameLower = nameList[i].toLowerCase().replace(/\s+/g, "");
    var dist = levenshtein(inputLower, nameLower);
    var maxLen = Math.max(inputLower.length, nameLower.length);
    // 유사도 60% 이상이면 매칭
    if (dist < bestDist && (1 - dist / maxLen) >= 0.6) {
      bestDist = dist;
      bestLev = nameList[i];
    }
  }
  if (bestLev) return bestLev;

  // 6. 매칭 실패 → 원본 그대로 반환
  return input;
}

/**
 * 레벤슈타인 거리 계산
 */
function levenshtein(a, b) {
  var m = a.length, n = b.length;
  var dp = [];
  for (var i = 0; i <= m; i++) {
    dp[i] = [i];
    for (var j = 1; j <= n; j++) {
      if (i === 0) { dp[i][j] = j; continue; }
      dp[i][j] = Math.min(
        dp[i-1][j] + 1,
        dp[i][j-1] + 1,
        dp[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1)
      );
    }
  }
  return dp[m][n];
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

  // ── 중복 체크: 같은 예약자명 + 반출일 + 장비목록 ──
  var reqEquipSet = (req.장비 || []).map(function(e) { return String(e.이름 || "").trim(); }).sort().join("|");
  var reqName = String(req.예약자명 || "").trim();
  var reqDate = String(req.반출일 || "").trim();

  if (reqName && reqDate && reqEquipSet) {
    var dupCheckLastRow = sheet.getLastRow();
    if (dupCheckLastRow >= 2) {
      var allData = sheet.getRange(2, 1, dupCheckLastRow - 1, 18).getValues();
      // reqID별로 그룹핑해서 비교
      var reqGroups = {};
      for (var di = 0; di < allData.length; di++) {
        var rid = allData[di][0];
        if (!rid) continue;
        if (!reqGroups[rid]) reqGroups[rid] = { name: "", date: "", equips: [] };
        if (allData[di][10]) reqGroups[rid].name = String(allData[di][10]).trim();  // K열: 예약자명
        if (allData[di][1]) {  // B열: 반출일
          var dv = allData[di][1];
          reqGroups[rid].date = dv instanceof Date ? Utilities.formatDate(dv, "Asia/Seoul", "yyyy-MM-dd") : String(dv).trim();
        }
        if (allData[di][5]) reqGroups[rid].equips.push(String(allData[di][5]).trim());  // F열: 장비명
      }
      for (var rid in reqGroups) {
        var g = reqGroups[rid];
        var existEquipSet = g.equips.sort().join("|");
        if (g.name === reqName && g.date === reqDate && existEquipSet === reqEquipSet) {
          throw new Error("중복 요청: 동일한 예약자/반출일/장비 조합이 이미 존재합니다 (" + rid + ")");
        }
      }
    }

    // 스케줄상세(등록 완료된 건)에서도 중복 체크
    var dupEquipArr = (req.장비 || []).map(function(e) { return String(e.이름 || "").trim(); });
    var dupTid = checkDuplicateRequest(ss, reqName, reqDate, dupEquipArr);
    if (dupTid) {
      throw new Error("중복 요청: 동일 건이 이미 예약 등록되어 있습니다 (거래ID: " + dupTid + ")");
    }
  }

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

  // 연락처 미입력 시 고객DB에서 조회 (동명이인 시 자동입력 안 함)
  var resolvedPhone = req.연락처 || "";
  if (!resolvedPhone && req.예약자명) {
    var dbSheet = ss.getSheetByName("고객DB");
    if (dbSheet && dbSheet.getLastRow() >= 2) {
      var dbData = dbSheet.getDataRange().getValues();
      var matches = [];
      for (var di = 1; di < dbData.length; di++) {
        if (String(dbData[di][1]).trim() === String(req.예약자명).trim()) {
          matches.push(String(dbData[di][0]).trim());
        }
      }
      if (matches.length === 1) resolvedPhone = matches[0];
      // 2명 이상이면 자동입력 안 함 (동명이인 → 수동입력 필요)
    }
  }

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
      i === 0 ? resolvedPhone : "",       // L: 연락처 (첫 행만, 고객DB 자동조회)
      "",                       // M: 업체명
      "",                       // N: 등록
      "",                       // O: 등록상태
      "",                       // P: 거래ID
      "",                       // Q: 비고
      i === 0 ? (req.추가요청 || "") : ""  // R: 추가요청 (첫 행만)
    ];
    sheet.getRange(row, 1, 1, 18).setValues([rowData]);

    // 첫 행: 굵은 글씨 + 배경색으로 예약 건 구분
    if (i === 0) {
      sheet.getRange(row, 1, 1, 18).setFontWeight("bold").setBackground("#E8F0FE");
    } else {
      sheet.getRange(row, 1, 1, 18).setFontWeight("normal").setBackground(null);
    }
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
  // ── 중복 실행 방지 락 ──
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) {
    Logger.log("processByReqID: 다른 인스턴스 실행 중 — 스킵");
    return;
  }

  try {
  return _processByReqID(sheet, triggerRow);
  } finally {
    lock.releaseLock();
  }
}

function _processByReqID(sheet, triggerRow) {
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

  // ── 같은 요청ID의 모든 행 수집 ──
  let expandedRows = false;
  var reqRows = [];
  for (let i = 0; i < allData.length; i++) {
    if (allData[i][0] !== triggerReqID) continue;
    reqRows.push({ idx: i, row: i + 2, 장비명: allData[i][5], 수량: allData[i][6] || 1, result: allData[i][8] });
  }

  // 첫 행 서식 (예약 건 구분)
  if (reqRows.length > 0) {
    sheet.getRange(reqRows[0].row, 1, 1, 18).setFontWeight("bold").setBackground("#E8F0FE");
    for (let r = 1; r < reqRows.length; r++) {
      sheet.getRange(reqRows[r].row, 1, 1, 18).setFontWeight("normal").setBackground(null);
    }
  }

  // 세트마스터 A열 이름 목록 (한번만 읽기)
  var setMasterNames = new Set();
  if (setSheet.getLastRow() >= 2) {
    setSheet.getRange(2, 1, setSheet.getLastRow() - 1, 1).getValues().flat()
      .forEach(function(n) { if (n) setMasterNames.add(n.toString().trim()); });
  }

  // ── 변경된 세트의 구성품만 삭제 (다른 세트/장비는 보존) ──
  // 1) 현재 reqID의 세트 헤더 이름 수집 (Q열이 비어있는 행 = 세트 헤더 또는 개별 장비)
  var currentSetNames = new Set();
  for (let r = 0; r < reqRows.length; r++) {
    var rName = reqRows[r].장비명;
    if (rName && getSetComponents(rName, setSheet).length > 0) {
      currentSetNames.add(rName);
    }
  }

  // 2) 고아 구성품 삭제: Q열 "[세트]XXX"에서 XXX가 현재 세트 헤더에 없는 것만 삭제
  var lastRowBeforeClean = sheet.getLastRow();
  var deletedAny = false;
  if (lastRowBeforeClean >= 2) {
    var qCol = sheet.getRange(2, 17, lastRowBeforeClean - 1, 1).getValues();
    var aCol = sheet.getRange(2, 1, lastRowBeforeClean - 1, 1).getValues();
    for (let ci = qCol.length - 1; ci >= 0; ci--) {
      var qVal = String(qCol[ci][0]);
      if (String(aCol[ci][0]).trim() !== triggerReqID) continue;
      if (qVal.indexOf("[세트]") !== 0) continue;
      var belongsTo = qVal.substring(4); // "[세트]" 이후 = 소속 세트명
      if (!currentSetNames.has(belongsTo)) {
        // 이 구성품의 소속 세트가 현재 없음 → 삭제 대상
        sheet.deleteRow(ci + 2);
        deletedAny = true;
      }
    }
  }
  if (deletedAny) SpreadsheetApp.flush();

  // 3) 삭제 발생 시 reqRows 재구성
  if (deletedAny) {
    var refreshLastRow = sheet.getLastRow();
    var refreshData = sheet.getRange(2, 1, refreshLastRow - 1, 18).getValues();
    reqRows = [];
    for (let i = 0; i < refreshData.length; i++) {
      if (String(refreshData[i][0]).trim() === triggerReqID) {
        reqRows.push({
          row: i + 2,
          장비명: String(refreshData[i][5]).trim(),
          수량: refreshData[i][6] || 1,
          result: String(refreshData[i][8]).trim()
        });
      }
    }
  }

  // 4) I/J 결과: 이미 결과가 있는 행은 보존, 새 행만 확인 대상
  //    (고아 구성품 삭제로 인해 새로 펼쳐질 세트의 결과만 비어있음)

  // 5) reqRows 최종 재구성
  var finalLastRow = sheet.getLastRow();
  var finalData = sheet.getRange(2, 1, finalLastRow - 1, 18).getValues();
  reqRows = [];
  for (let i = 0; i < finalData.length; i++) {
    if (String(finalData[i][0]).trim() === triggerReqID) {
      reqRows.push({
        row: i + 2,
        장비명: String(finalData[i][5]).trim(),
        수량: finalData[i][6] || 1,
        result: String(finalData[i][8]).trim(),
        qTag: String(finalData[i][16]).trim()
      });
    }
  }

  // 세트 펼침: 아래에서 위로 처리 (행 삽입으로 인한 번호 밀림 방지)
  // + 단일 품목도 세트마스터에 있으면 F열 초록 표시
  var firstRowNum = reqRows.length > 0 ? reqRows[0].row : null;
  for (let r = reqRows.length - 1; r >= 0; r--) {
    var ri = reqRows[r];
    if (!ri.장비명) continue;
    if (ri.qTag.indexOf("[세트]") === 0) continue; // 기존 구성품 행은 스킵 (펼침 불필요)

    // 확인 자동 채우기
    if (sheet.getRange(ri.row, 8).getValue() !== "확인") {
      sheet.getRange(ri.row, 8).setValue("확인");
    }

    // 세트인지 확인 → 구성품이 아직 없는 경우만 펼침
    const setComponents = getSetComponents(ri.장비명, setSheet);
    if (setComponents.length > 0) {
      // 이미 이 세트의 구성품이 존재하는지 확인
      var hasExisting = reqRows.some(function(rr) { return rr.qTag === "[세트]" + ri.장비명; });
      if (!hasExisting) {
        expandSetRows(sheet, ri.row, triggerReqID, setComponents, ri.수량);
        expandedRows = true;
      } else {
        // 기존 구성품 유지, 헤더만 세트 표시
        sheet.getRange(ri.row, 9).setValue("세트");
      }
    } else if (setMasterNames.has(ri.장비명.toString().trim())) {
      // 단일 품목: 세트마스터에 존재 → F열 초록 표시
      if (ri.row === firstRowNum) {
        // 첫 행: 파란배경 유지, F열 볼드만
        sheet.getRange(ri.row, 6).setFontWeight("bold");
      } else {
        sheet.getRange(ri.row, 6).setBackground("#D9EAD3").setFontWeight("bold");
      }
    }
  }

  // 스케줄상세 데이터 미리 읽기 (한 번만)
  const schedData = getScheduleData(schedSheet);

  // 세트 펼침이 있었으면 데이터 다시 읽고 가용확인
  if (expandedRows) {
    SpreadsheetApp.flush();
    const newLastRow = sheet.getLastRow();
    const newAllData = sheet.getRange(2, 1, newLastRow - 1, 18).getValues();

    // 세트명 셀(F열)에 색상 표시 — 단, 첫 행은 요청ID 구분 서식(파란배경) 우선
    var firstRowOfReq = null;
    for (let i = 0; i < newAllData.length; i++) {
      if (newAllData[i][0] !== triggerReqID) continue;
      if (firstRowOfReq === null) firstRowOfReq = i + 2;
      if (newAllData[i][8] === "세트") {
        if (i + 2 === firstRowOfReq) {
          // 첫 행: F열만 초록, 행 전체는 파란배경 유지
          sheet.getRange(i + 2, 6).setFontWeight("bold");
          sheet.getRange(i + 2, 1, 1, 18).setFontWeight("bold").setBackground("#E8F0FE");
        } else {
          sheet.getRange(i + 2, 6).setBackground("#D9EAD3").setFontWeight("bold");
        }
      }
    }

    for (let i = 0; i < newAllData.length; i++) {
      if (newAllData[i][0] !== triggerReqID) continue;
      const row = i + 2;
      const 장비명 = newAllData[i][5];
      if (!장비명) continue;

      if (newAllData[i][8] === "세트") {
        // 세트 헤더: 장비마스터에 존재하면 J열에 가용 정보 표시
        checkSetHeaderAvail(sheet, row, 장비명, newAllData[i][6] || 1,
          반출일, 반출시간, 반납일, 반납시간, schedData, equipSheet);
        continue;
      }
      var existResult = String(newAllData[i][8]).trim();
      if (existResult && existResult !== "") continue; // 이미 결과 있으면 스킵

      checkSingleRowWithData(sheet, row, triggerReqID, 반출일, 반출시간, 반납일, 반납시간,
        장비명, newAllData[i][6] || 1, schedData, equipSheet);
    }
  } else {
    // 펼침 없는 경우: 최신 데이터 다시 읽기 (고아 삭제 반영)
    var latestLastRow = sheet.getLastRow();
    var latestData = sheet.getRange(2, 1, latestLastRow - 1, 18).getValues();
    for (let i = 0; i < latestData.length; i++) {
      if (latestData[i][0] !== triggerReqID) continue;
      const row = i + 2;
      const 장비명 = latestData[i][5];
      if (!장비명) continue;

      if (latestData[i][8] === "세트") {
        checkSetHeaderAvail(sheet, row, 장비명, latestData[i][6] || 1,
          반출일, 반출시간, 반납일, 반납시간, schedData, equipSheet);
        continue;
      }
      var existResult2 = String(latestData[i][8]).trim();
      if (existResult2 && existResult2 !== "") continue;

      checkSingleRowWithData(sheet, row, triggerReqID, 반출일, 반출시간, 반납일, 반납시간,
        장비명, latestData[i][6] || 1, schedData, equipSheet);
    }
  }

  // ━━ 최종 서식 재적용 — 재확인해도 첫행 볼드+파란배경, 세트 F열 초록 유지 ━━
  SpreadsheetApp.flush();
  var finalLastRow2 = sheet.getLastRow();
  if (finalLastRow2 >= 2) {
    var finalData2 = sheet.getRange(2, 1, finalLastRow2 - 1, 18).getValues();
    var isFirstRow = true;
    for (let i = 0; i < finalData2.length; i++) {
      if (String(finalData2[i][0]).trim() !== triggerReqID) continue;
      var fRow = i + 2;
      var fResult = String(finalData2[i][8] || "").trim();
      var fEquip = String(finalData2[i][5] || "").trim();
      var fQTag = String(finalData2[i][16] || "").trim();

      if (isFirstRow) {
        // 첫 행: 볼드 + 파란배경
        sheet.getRange(fRow, 1, 1, 18).setFontWeight("bold").setBackground("#E8F0FE");
        isFirstRow = false;
      } else {
        // 나머지 행: 일반 텍스트 + 배경 제거
        sheet.getRange(fRow, 1, 1, 18).setFontWeight("normal").setBackground(null);
        // 세트 헤더 또는 세트마스터 존재 품목이면 F열만 초록
        if (fResult === "세트" || (setMasterNames.has(fEquip) && fQTag.indexOf("[세트]") !== 0)) {
          sheet.getRange(fRow, 6).setBackground("#D9EAD3").setFontWeight("bold");
        }
      }
      // I/J열 결과 배경색은 보존
      if (fResult) {
        var color = fResult.indexOf("✅") >= 0 ? "#C6EFCE" :
                    fResult.indexOf("⚠") >= 0 || fResult.indexOf("⚠️") >= 0 ? "#FFEB9C" :
                    fResult.indexOf("❌") >= 0 ? "#FFC7CE" : null;
        if (color) sheet.getRange(fRow, 9, 1, 2).setBackground(color);
      }
    }
  }

  // ※ 가용확인 알림톡은 여기서 자동발송하지 않음
  // → H열 "발송" 선택 시 sendAvailAlimtalk()에서 별도 발송 (결재 후)

}


/**
 * H열 "발송승인" → 가용확인 결과 (코워크 에이전트가 카톡으로 직접 발송)
 * 팝빌 알림톡 자동발송 제거됨
 */
function sendAvailAlimtalk(sheet, row) {
  // 코워크 에이전트가 직접 카카오톡 채널에서 발송하므로 자동발송 비활성화
  Logger.log("가용확인 발송승인 — 코워크 에이전트가 카톡으로 직접 발송");
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

  // 세트 체크 → 기존 구성품 삭제 후 펼침
  const setComponents = getSetComponents(장비명, setSheet);
  if (setComponents.length > 0) {
    const reqID = allData[idx][0] || "REQ-" + new Date().getTime();
    if (!allData[idx][0]) sheet.getRange(row, 1).setValue(reqID);

    // 기존 구성품 행 삭제 (Q열 "[세트]" 태그)
    var sLastRow = sheet.getLastRow();
    if (sLastRow >= 2) {
      var sQcol = sheet.getRange(2, 17, sLastRow - 1, 1).getValues();
      var sAcol = sheet.getRange(2, 1, sLastRow - 1, 1).getValues();
      for (let si = sQcol.length - 1; si >= 0; si--) {
        if (String(sAcol[si][0]).trim() === reqID && String(sQcol[si][0]).indexOf("[세트]") === 0) {
          sheet.deleteRow(si + 2);
        }
      }
    }
    // I열 "세트" 초기화
    sheet.getRange(row, 9).clearContent();
    sheet.getRange(row, 10).clearContent();

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
 * 세트 헤더 행의 가용 확인 — 세트명이 장비마스터에 있으면 J열에 가용 표시
 */
function checkSetHeaderAvail(sheet, row, 장비명, 수량, 반출일, 반출시간, 반납일, 반납시간, schedData, equipSheet) {
  var equipInfo = findEquipment(장비명, equipSheet);
  if (!equipInfo) return; // 장비마스터에 없으면 패스 (순수 세트)

  var reqStartDT = parseDT(반출일, 반출시간);
  var reqEndDT = parseDT(반납일, 반납시간);
  if (!reqStartDT || !reqEndDT) return;

  var overlaps = [];
  schedData.forEach(function(sched) {
    if (sched.equipment !== 장비명) return;
    if (sched.status === "반납완료" || sched.status === "취소") return;
    if (!sched.startDT || !sched.endDT) return;
    if (sched.startDT < reqEndDT && sched.endDT > reqStartDT) {
      overlaps.push(sched);
    }
  });

  var 총보유 = equipInfo.total;
  if (overlaps.length === 0) {
    sheet.getRange(row, 10).setValue("✅ 본체 가용" + 총보유 + " (보유" + 총보유 + ")");
  } else {
    // sweep-line 동시사용량 계산
    var tpSet = {};
    tpSet[reqStartDT.getTime()] = true;
    overlaps.forEach(function(s) {
      var st = s.startDT.getTime(), et = s.endDT.getTime();
      if (st > reqStartDT.getTime() && st < reqEndDT.getTime()) tpSet[st] = true;
      if (et > reqStartDT.getTime() && et < reqEndDT.getTime()) tpSet[et] = true;
    });
    var timePoints = Object.keys(tpSet).map(Number).sort(function(a,b){ return a-b; });
    var maxConcurrent = 0;
    for (var ti = 0; ti < timePoints.length; ti++) {
      var concurrent = 0;
      for (var oi = 0; oi < overlaps.length; oi++) {
        if (overlaps[oi].startDT.getTime() <= timePoints[ti] && overlaps[oi].endDT.getTime() > timePoints[ti]) {
          concurrent += overlaps[oi].qty;
        }
      }
      if (concurrent > maxConcurrent) maxConcurrent = concurrent;
    }
    var 가용수량 = 총보유 - maxConcurrent;
    if (가용수량 >= 수량) {
      sheet.getRange(row, 10).setValue("✅ 본체 가용" + 가용수량 + " (보유" + 총보유 + ")");
    } else {
      sheet.getRange(row, 10).setValue("❌ 본체 가용" + Math.max(0, 가용수량) + " (보유" + 총보유 + ", 사용중" + maxConcurrent + ")");
      sheet.getRange(row, 10).setBackground("#FFC7CE");
    }
  }
}


/**
 * 단일 행 가용 확인 — 핵심 로직
 */
function checkSingleRowWithData(sheet, row, reqID, 반출일, 반출시간, 반납일, 반납시간,
  장비명, 수량, schedData, equipSheet) {

  // ── 날짜 검증 ──
  if (!반출일 || !반납일 || (반출시간 === null || 반출시간 === undefined || 반출시간 === "") || (반납시간 === null || 반납시간 === undefined || 반납시간 === "")) {
    sheet.getRange(row, 9).setValue("❌ 날짜/시간 필요");
    return;
  }

  const reqStartDT = parseDT(반출일, 반출시간);
  const reqEndDT = parseDT(반납일, 반납시간);

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

  // ── 겹치는 기존 예약 수집 ──
  var overlaps = [];
  schedData.forEach(function(sched) {
    if (sched.equipment !== 장비명) return;
    if (sched.status === "반납완료" || sched.status === "취소") return;
    if (!sched.startDT || !sched.endDT) return;
    if (sched.startDT < reqEndDT && sched.endDT > reqStartDT) {
      overlaps.push(sched);
    }
  });

  if (overlaps.length === 0) {
    sheet.getRange(row, 9).setValue("\u2705 가용" + 총보유);
    sheet.getRange(row, 10).setValue("보유" + 총보유);
    sheet.getRange(row, 9, 1, 2).setBackground("#C6EFCE");
    return;
  }

  // ── 시점별 동시사용량 계산 (sweep-line) ──
  var tpSet = {};
  tpSet[reqStartDT.getTime()] = true;
  overlaps.forEach(function(s) {
    var st = s.startDT.getTime(), et = s.endDT.getTime();
    if (st > reqStartDT.getTime() && st < reqEndDT.getTime()) tpSet[st] = true;
    if (et > reqStartDT.getTime() && et < reqEndDT.getTime()) tpSet[et] = true;
  });
  var timePoints = Object.keys(tpSet).map(Number).sort(function(a,b){ return a-b; });

  var maxConcurrent = 0;
  var concurrentAtStart = 0;
  var firstFreeTime = null;

  for (var ti = 0; ti < timePoints.length; ti++) {
    var tp = timePoints[ti];
    var concurrent = 0;
    for (var oi = 0; oi < overlaps.length; oi++) {
      if (overlaps[oi].startDT.getTime() <= tp && overlaps[oi].endDT.getTime() > tp) {
        concurrent += overlaps[oi].qty;
      }
    }
    if (ti === 0) concurrentAtStart = concurrent;
    if (concurrent > maxConcurrent) maxConcurrent = concurrent;
    if (총보유 - concurrent >= 수량 && firstFreeTime === null) {
      firstFreeTime = new Date(tp);
    }
  }

  // ── 겹침 상세 목록 ──
  var 겹침목록 = [];
  overlaps.forEach(function(sched) {
    var endStr = Utilities.formatDate(sched.endDT, "Asia/Seoul", "M/d HH:mm");
    var overlapMs = Math.min(reqEndDT, sched.endDT) - Math.max(reqStartDT, sched.startDT);
    겹침목록.push((sched.contractName || sched.contractID) + " 반납" + endStr + "(" + formatDuration_(overlapMs) + "겹침)");
  });

  // ── 결과 판정 ──
  var result, detail;
  var 가용AtStart = 총보유 - concurrentAtStart;

  if (가용AtStart >= 수량) {
    // 반출시점부터 바로 가용
    result = "\u2705 가용" + 가용AtStart;
    detail = "보유" + 총보유 + (concurrentAtStart > 0 ? ", 사용중" + concurrentAtStart : "");
  } else if (firstFreeTime) {
    // 기간 중 가용 발생 (반납 후 사용 가능)
    var freeStr = Utilities.formatDate(firstFreeTime, "Asia/Seoul", "M/d HH:mm");
    result = "\u2705 가용(" + freeStr + "~)";
    detail = "보유" + 총보유 + ", 사용중" + concurrentAtStart + "\n" + 겹침목록.join("\n");
  } else if (겹침목록.length > 0) {
    // 기간 내내 가용 없음
    result = "\u26A0\uFE0F 겹침(가용0)";
    detail = "보유" + 총보유 + ", 사용중" + maxConcurrent + "\n" + 겹침목록.join("\n");
  } else {
    result = "\u274C 가용0";
    detail = "보유" + 총보유 + ", 전량사용중";
  }

  sheet.getRange(row, 9).setValue(result);
  sheet.getRange(row, 10).setValue(detail);

  var color = result.indexOf("\u2705") !== -1 ? "#C6EFCE" :
              result.indexOf("\u26A0") !== -1 ? "#FFEB9C" : "#FFC7CE";
  sheet.getRange(row, 9, 1, 2).setBackground(color);
}

/**
 * 밀리초 → 사람이 읽기 쉬운 시간 포맷
 * 120분 → "2시간", 650분 → "10시간 50분", 1500분 → "1일 1시간"
 */
function formatDuration_(ms) {
  var totalMin = Math.round(ms / 60000);
  if (totalMin < 60) return totalMin + "분";
  var hours = Math.floor(totalMin / 60);
  var mins = totalMin % 60;
  if (hours < 24) {
    return mins > 0 ? hours + "시간 " + mins + "분" : hours + "시간";
  }
  var days = Math.floor(hours / 24);
  hours = hours % 24;
  var parts = [days + "일"];
  if (hours > 0) parts.push(hours + "시간");
  if (mins > 0) parts.push(mins + "분");
  return parts.join(" ");
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

  // ── 장비마스터 데이터 한 번만 읽기 (N+1 방지) ──
  const equipLastRow = equipSheet.getLastRow();
  const equipData = equipLastRow >= 2 ? equipSheet.getRange(2, 1, equipLastRow - 1, 12).getValues() : [];

  // 장비마스터 조회를 메모리에서 수행하는 헬퍼
  function findEquipInData(name) {
    for (let ei = 0; ei < equipData.length; ei++) {
      if (equipData[ei][3] === name) {
        return { total: equipData[ei][4] || 0, 단가: equipData[ei][11] || 0 };
      }
    }
    return null;
  }
  function findEquipByCatInData(categoryName) {
    var items = [];
    for (let ei = 0; ei < equipData.length; ei++) {
      if (String(equipData[ei][2]).trim() === String(categoryName).trim() && equipData[ei][3]) {
        items.push({ name: equipData[ei][3], total: equipData[ei][4] || 0, 단가: equipData[ei][11] || 0 });
      }
    }
    return items;
  }

  // ★ 세트 헤더 행 유지: F열 그대로, I열에 "세트" 표시
  sheet.getRange(setRow, 9).setValue("세트"); // I열: 결과 = "세트"
  // 첫 행(요청ID 구분 행)이면 파란배경 유지, 아니면 F열만 초록
  var isFirstRow = false;
  if (setRow >= 2) {
    var aboveVal = setRow > 2 ? sheet.getRange(setRow - 1, 1).getValue().toString().trim() : "";
    isFirstRow = (aboveVal !== reqID);
  }
  if (!isFirstRow) {
    sheet.getRange(setRow, 6).setBackground("#D9EAD3").setFontWeight("bold");
  } else {
    sheet.getRange(setRow, 6).setFontWeight("bold");
    sheet.getRange(setRow, 1, 1, 18).setFontWeight("bold").setBackground("#E8F0FE");
  }

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
      // 구성품 행은 일반 서식
      sheet.getRange(newRow, 1, 1, 18).setFontWeight("normal").setBackground(null);
      if (components[i].alt) {
        sheet.getRange(newRow, 10).setValue("대체: " + components[i].alt); // J: 상세
      }

      // ── 카테고리 구성품 감지 → 필터 드롭다운 생성 ──
      const equipInfo = findEquipInData(components[i].name);
      if (!equipInfo) {
        // 장비마스터 D열에 없음 → C열(카테고리)에서 검색
        const categoryItems = findEquipByCatInData(components[i].name);
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

  var lastCol = Math.max(setSheet.getLastColumn(), 5);
  const data = setSheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  // A: 세트명, B: 구성장비명, C: 수량, D: 비고, E: 대체가능장비, F: 가용체크(없으면 전부 포함)
  const items = data.filter(row => {
    if (row[0].toString().trim() !== name.toString().trim()) return false;
    var flag = (row.length > 5) ? row[5].toString().trim() : "";
    return flag === "Y" || flag === "";  // F열 없거나 비어있으면 포함
  });

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
  // ── 전체 등록 프로세스 직렬화 (동시 실행 방지) ──
  var regLock = LockService.getScriptLock();
  if (!regLock.tryLock(30000)) {
    sheet.getRange(triggerRow, 15).setValue("⏳ 등록대기");
    sheet.getRange(triggerRow, 15).setBackground("#E8F0FE");
    return;
  }
  try {
  // 락 획득 후 시트 데이터를 새로 읽어야 정확함
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

  if (!연락처 && 예약자명) {
    var dbSheet = ss.getSheetByName("고객DB");
    if (dbSheet && dbSheet.getLastRow() >= 2) {
      var dbData = dbSheet.getDataRange().getValues();
      var matches2 = [];
      for (var di2 = 1; di2 < dbData.length; di2++) {
        if (String(dbData[di2][1]).trim() === String(예약자명).trim()) {
          matches2.push(String(dbData[di2][0]).trim());
        }
      }
      if (matches2.length === 1) {
        연락처 = matches2[0];
        for (var fi = 0; fi < allData.length; fi++) {
          if (allData[fi][0] === reqID && allData[fi][10]) {
            sheet.getRange(fi + 2, 12).setValue(연락처);
            break;
          }
        }
      } else if (matches2.length > 1) {
        // 동명이인 → 연락처 직접 입력 필요
        sheet.getRange(triggerRow, 15).setValue("❌ 동명이인 " + matches2.length + "명 존재 — 연락처 직접 입력 필요");
        sheet.getRange(triggerRow, 15).setBackground("#FFC7CE");
        sheet.getRange(triggerRow, 14).clearContent();
        return;
      }
    }
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
  // 거절/보류 후 재등록 시 기존 상태 초기화 (시트 + 메모리 allData 양쪽)
  if (hasRejectedOrHeld) {
    for (let i = 0; i < allData.length; i++) {
      if (allData[i][0] === reqID) {
        var rs = String(allData[i][14] || "").trim();
        if (rs === "거절" || rs === "보류" || rs === "등록완료") {
          sheet.getRange(i + 2, 14).clearContent();  // N열 초기화
          sheet.getRange(i + 2, 15).clearContent();  // O열 초기화
          sheet.getRange(i + 2, 15).setBackground(null);
          allData[i][14] = "";  // 메모리도 초기화 (스케줄상세 등록 시 스킵 방지)
        }
      }
    }
    SpreadsheetApp.flush();
  }

  // ── O열 재확인 (동시 클릭 대비 — 락 안에서 실행) ──
  var recheckData = sheet.getRange(2, 1, lastRow - 1, 15).getValues();
  for (let i = 0; i < recheckData.length; i++) {
    if (recheckData[i][0] === reqID && recheckData[i][14] === "등록완료") {
      sheet.getRange(triggerRow, 15).setValue("⚠️ 이미 등록됨");
      sheet.getRange(triggerRow, 14).clearContent();
      return;
    }
  }

  // ── 스케줄상세 중복 등록 체크 ──
  var dupDate = "";
  var dupEquips = [];
  for (var di = 0; di < allData.length; di++) {
    if (allData[di][0] !== reqID) continue;
    if (allData[di][14] === "거절" || allData[di][14] === "보류") continue;
    if (allData[di][1]) {
      var dv = allData[di][1];
      dupDate = dv instanceof Date ? Utilities.formatDate(dv, "Asia/Seoul", "yyyy-MM-dd") : String(dv).trim();
    }
    if (allData[di][5]) dupEquips.push(String(allData[di][5]).trim());
  }
  if (dupDate && dupEquips.length > 0 && 예약자명) {
    var dupTid = checkDuplicateRequest(ss, 예약자명, dupDate, dupEquips);
    if (dupTid) {
      sheet.getRange(triggerRow, 15).setValue("⚠️ 중복: 동일 건이 이미 등록됨 (거래ID: " + dupTid + ")");
      sheet.getRange(triggerRow, 14).clearContent();
      return;
    }
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
  // fmtDT()로 "yyyy-MM-dd HH:mm" 형태 얻은 후 분리
  const 반출dtStr = fmtDT(반출일, 반출시간);
  const 반납dtStr = fmtDT(반납일, 반납시간);
  const 반출일str = 반출dtStr.split(' ')[0] || "";
  const 반출시간str = 반출dtStr.split(' ')[1] || "";
  const 반납일str = 반납dtStr.split(' ')[0] || "";
  const 반납시간str = 반납dtStr.split(' ')[1] || "";

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
  }

  const 거래ID = `${prefix거래}-${String(maxNum + 1).padStart(3, "0")}`;

  // ── 회차 계산 (24시간=1회차, 6시간 이내 초과는 같은 회차) ──
  var 회차 = 1;
  try {
    var startDT = parseDT(반출일str, 반출시간str);
    var endDT = parseDT(반납일str, 반납시간str);
    if (startDT && endDT && endDT > startDT) {
      var totalHours = (endDT - startDT) / (1000 * 60 * 60);
      회차 = Math.max(1, Math.ceil((totalHours - 6) / 24));
    }
  } catch (e) { }

  // ── 계약마스터에 등록 ──
  const newContractRow = contractLastRow + 1;
  contractSheet.getRange(newContractRow, 1, 1, 11).setValues([[
    거래ID, 예약자명, 연락처 || "", 업체명 || "",
    반출일str, 반출시간str, 반납일str, 반납시간str,
    회차, "예약", ""
  ]]);


    // ── 스케줄상세에 장비 등록 (세트 헤더/구성품/개별 구분) ──
    let schedLastRow = schedSheet.getLastRow();
    let schedCount = 0;
    // 스케줄상세 시트에 충분한 빈 행 확보
    var neededRows = 0;
    for (let ci = 0; ci < allData.length; ci++) {
      if (allData[ci][0] === reqID && allData[ci][5] && allData[ci][14] !== "거절" && allData[ci][14] !== "보류") neededRows++;
    }
    if (schedLastRow + neededRows > schedSheet.getMaxRows()) {
      schedSheet.insertRowsAfter(schedSheet.getMaxRows(), neededRows + 10);
    }

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
        schedSheet.getRange(setRow, 1, 1, 13).clearDataValidations();
        schedSheet.getRange(setRow, 1, 1, 13).setValues([[
          setSchedID, 거래ID, 장비명, 장비명, 수량,
          반출일str, 반출시간str, 반납일str, 반납시간str,
          "대기", "", 세트단가, 예약자명
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
        schedSheet.getRange(compRow, 1, 1, 13).clearDataValidations();
        schedSheet.getRange(compRow, 1, 1, 13).setValues([[
          compID, 거래ID, 소속세트, 장비명, 수량,
          반출일str, 반출시간str, 반납일str, 반납시간str,
          "대기", "", 0, 예약자명
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
        schedSheet.getRange(newRow, 1, 1, 13).clearDataValidations();
        schedSheet.getRange(newRow, 1, 1, 13).setValues([[
          schedID, 거래ID, "", 장비명, 수량,
          반출일str, 반출시간str, 반납일str, 반납시간str,
          "대기", "", 단가, 예약자명
        ]]);
        schedSheet.getRange(newRow, 5).setNumberFormat("#,##0");
        schedSheet.getRange(newRow, 12).setNumberFormat("#,##0");
        schedSheet.getRange(newRow, 6, 1, 4).setNumberFormat("@");
      }
    }

  // ── 스케줄상세 가독성 포맷팅 ──
  formatScheduleSheet(schedSheet);

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

    // ── 개고생2.0 고객DB에 신규고객 저장 ──
    // 고객DB 구조: A=연락처(예약자ID), B=성함, C=소속
    try {
      var 고객DB시트 = 개고생SS.getSheetByName("고객DB");
      if (고객DB시트 && 연락처 && 예약자명) {
        var 고객lastRow = 고객DB시트.getLastRow();
        var 기존여부 = false;
        if (고객lastRow >= 2) {
          var 고객data = 고객DB시트.getRange(2, 1, 고객lastRow - 1, 2).getValues();
          var telClean = String(연락처).replace(/[-\s]/g, "");
          for (var gi = 0; gi < 고객data.length; gi++) {
            var existTel = String(고객data[gi][0] || "").replace(/[-\s]/g, "");
            var existName = String(고객data[gi][1] || "").trim();
            if (existTel === telClean || existName === String(예약자명).trim()) {
              기존여부 = true;
              break;
            }
          }
        }
        if (!기존여부) {
          var 고객newRow = 고객lastRow + 1;
          고객DB시트.getRange(고객newRow, 1).setNumberFormat("@").setValue(String(연락처));
          고객DB시트.getRange(고객newRow, 2).setValue(예약자명);
          if (업체명) 고객DB시트.getRange(고객newRow, 3).setValue(업체명);
          Logger.log("신규고객 저장: " + 예약자명 + " " + 연락처);
        }
      }
    } catch (dbErr) {
      Logger.log("고객DB 저장 실패 (계속 진행): " + dbErr.message);
    }
  } catch (err) {
    sheet.getRange(triggerRow, 15).setValue("❌ 개고생2.0 실패: " + err.message);
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
    }
  } catch (err) {
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

  // ── 등록완료 알림톡 — 비활성화 (코워크 에이전트가 카톡으로 직접 발송) ──
  // 반출/반납 안내톡(checkGuideAlimtalk)은 유지됨

  } finally {
    regLock.releaseLock();
  }

  // ── 대기열 자동 처리: "등록대기" 상태인 건 순차 처리 ──
  processRegistrationQueue_(sheet);
}


/**
 * 등록대기 건 순차 처리
 * O열이 "등록대기"인 행을 찾아서 하나씩 registerByReqID 호출
 */
function processRegistrationQueue_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  var oCol = sheet.getRange(2, 15, lastRow - 1, 1).getValues(); // O열
  var aCol = sheet.getRange(2, 1, lastRow - 1, 1).getValues();  // A열
  var processedReqIDs = new Set();

  for (var i = 0; i < oCol.length; i++) {
    if (String(oCol[i][0]).trim() !== "⏳ 등록대기") continue;
    var pendingReqID = String(aCol[i][0]).trim();
    if (!pendingReqID || processedReqIDs.has(pendingReqID)) continue;

    processedReqIDs.add(pendingReqID);
    var pendingRow = i + 2;

    // 대기 상태 표시 업데이트
    sheet.getRange(pendingRow, 15).setValue("⏳ 등록 처리 중...");
    SpreadsheetApp.flush();

    // 등록 실행
    registerByReqID(sheet, pendingRow);
  }
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

  // 가용 경고 여부 (차단하지 않고 경고만)
  var 가용경고 = "";
  if (가용결과.indexOf("✅") < 0) {
    가용경고 = 가용결과 || "미확인";
  }

  // 계약마스터에서 날짜 가져오기
  const contractData = contractSheet.getRange(2, 1, Math.max(1, contractSheet.getLastRow() - 1), 8).getValues();
  let 반출일str, 반출시간str, 반납일str, 반납시간str;
  const fmtDate = (d) => { if (!d) return ""; if (d instanceof Date) return Utilities.formatDate(d, "Asia/Seoul", "yyyy-MM-dd"); return String(d); };
  const fmtTime = (d) => { if (!d) return ""; if (d instanceof Date) { return Utilities.formatDate(d, 'Asia/Seoul', 'HH:mm'); } return String(d); };

  var 예약자명_add = "";
  for (let i = 0; i < contractData.length; i++) {
    if (contractData[i][0] === 거래ID) {
      예약자명_add = String(contractData[i][1] || "").trim();  // B열: 예약자명
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
  schedSheet.getRange(newRow, 1, 1, 13).clearDataValidations();
  schedSheet.getRange(newRow, 1, 1, 13).setValues([[
    schedID, 거래ID, "", 장비명, 수량,
    반출일str, 반출시간str, 반납일str, 반납시간str,
    "대기", "", 단가, 예약자명_add
  ]]);
  schedSheet.getRange(newRow, 5).setNumberFormat("#,##0");
  schedSheet.getRange(newRow, 12).setNumberFormat("#,##0");
  schedSheet.getRange(newRow, 6, 1, 4).setNumberFormat("@");

  formatScheduleSheet(schedSheet);

  sheet.getRange(row, 15).setValue("⏳ 계약서 재생성 중...");

  // 기존 계약서 삭제 후 재생성
  try {
    const result = deleteAndRegenerateContract(ss, 거래ID);
    if (가용경고) {
      sheet.getRange(row, 15).setValue("⚠️ 추가완료 (경고: " + 가용경고 + ") + 계약서 재생성");
      sheet.getRange(row, 15).setBackground("#FFEB9C");
    } else {
      sheet.getRange(row, 15).setValue("✅ 추가완료 + 계약서 재생성");
      sheet.getRange(row, 15).setBackground("#C6EFCE");
    }
  } catch (err) {
    var errMsg = "✅ 추가완료 (계약서 재생성 실패: " + err.message + ")";
    if (가용경고) errMsg = "⚠️ 추가완료 (경고: " + 가용경고 + ", 계약서 실패: " + err.message + ")";
    sheet.getRange(row, 15).setValue(errMsg);
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

  formatScheduleSheet(schedSheet);

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
  const newStartDT = parseDT(새반출일Raw, 새반출시간str);
  const newEndDT = parseDT(새반납일Raw, 새반납시간str);
  const schedData = getScheduleData(schedSheet).filter(s => s.contractID !== 거래ID);

  const 불가목록 = [];
  const 가용목록 = [];

  대상장비목록.forEach(item => {
    const equipInfo = findEquipment(item.장비명, equipSheet);
    if (!equipInfo) { 불가목록.push(item.장비명 + "(미등록)"); return; }
    const 총보유 = equipInfo.total;

    // sweep-line: 요청 기간 내 동시 사용 최대치 계산
    var overlaps = schedData.filter(function(s) {
      return s.equipment === item.장비명 && s.status !== "반납완료" && s.status !== "취소"
        && s.startDT < newEndDT && s.endDT > newStartDT;
    });
    var timePoints = [newStartDT.getTime()];
    overlaps.forEach(function(s) {
      if (s.startDT >= newStartDT && s.startDT < newEndDT) timePoints.push(s.startDT.getTime());
      if (s.endDT > newStartDT && s.endDT < newEndDT) timePoints.push(s.endDT.getTime());
    });
    var maxConcurrent = 0;
    timePoints.forEach(function(tp) {
      var concurrent = 0;
      overlaps.forEach(function(s) {
        if (s.startDT.getTime() <= tp && s.endDT.getTime() > tp) concurrent += s.qty;
      });
      if (concurrent > maxConcurrent) maxConcurrent = concurrent;
    });

    const 가용 = 총보유 - maxConcurrent;
    if (가용 >= item.수량) {
      가용목록.push(item.장비명);
    } else {
      불가목록.push(item.장비명 + "(가용" + 가용 + "/" + item.수량 + ")");
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
  } catch (err) { }

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

// jsonResponse()는 sheetAPI.js에 통합 정의됨


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 유틸리티 함수
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 스케줄상세 중복 등록 체크: 같은 예약자명 + 반출일 + 장비목록
 * @param {Spreadsheet} ss
 * @param {string} 예약자명
 * @param {string} 반출일 - "yyyy-MM-dd" 문자열 또는 Date
 * @param {string[]} 장비목록 - 장비명 배열
 * @returns {string|null} 중복 거래ID 또는 null
 */
function checkDuplicateRequest(ss, 예약자명, 반출일, 장비목록) {
  if (!예약자명 || !반출일 || !장비목록 || 장비목록.length === 0) return null;

  var schedSheet = ss.getSheetByName("스케줄상세");
  var contractSheet = ss.getSheetByName("계약마스터");
  if (!schedSheet || schedSheet.getLastRow() < 2) return null;
  if (!contractSheet || contractSheet.getLastRow() < 2) return null;

  var dupDate = 반출일 instanceof Date ? Utilities.formatDate(반출일, "Asia/Seoul", "yyyy-MM-dd") : String(반출일).trim();
  var dupEquipSet = 장비목록.map(function(e) { return String(e).trim(); }).sort().join("|");

  // 계약마스터에서 거래ID → 예약자명 매핑
  var cMap = {};
  contractSheet.getRange(2, 1, contractSheet.getLastRow() - 1, 2).getValues().forEach(function(r) {
    if (r[0]) cMap[r[0]] = String(r[1] || "").trim();
  });

  // 스케줄상세: 거래ID별 반출일 + 장비목록
  var schedData = schedSheet.getRange(2, 1, schedSheet.getLastRow() - 1, 6).getValues();
  var schedGroups = {};
  for (var si = 0; si < schedData.length; si++) {
    var tid = schedData[si][1];  // B: 거래ID
    if (!tid) continue;
    if (!schedGroups[tid]) schedGroups[tid] = { date: "", equips: [] };
    if (schedData[si][5]) {  // F: 반출일
      var sv = schedData[si][5];
      schedGroups[tid].date = sv instanceof Date ? Utilities.formatDate(sv, "Asia/Seoul", "yyyy-MM-dd") : String(sv).trim();
    }
    if (schedData[si][3]) schedGroups[tid].equips.push(String(schedData[si][3]).trim());  // D: 장비명
  }
  for (var tid in schedGroups) {
    var sg = schedGroups[tid];
    var schedName = cMap[tid] || "";
    var schedEquipSet = sg.equips.sort().join("|");
    if (schedName === 예약자명 && sg.date === dupDate && schedEquipSet === dupEquipSet) {
      return tid;
    }
  }
  return null;
}

/**
 * 날짜 + 시간 합치기
 */
// combineDT → parseDT로 통합됨 (308행)

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
    startDT: parseDT(row[5], row[6]),  // F,G: 반출일,시간
    endDT: parseDT(row[7], row[8]),    // H,I: 반납일,시간
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
 * @param {Object} [vars] - 템플릿 변수 (예: {"#{고객명}": "홍길동"})
 */
function sendAlimtalk(templateCode, receiver, receiverName, content, vars) {
  var props = PropertiesService.getScriptProperties();
  var corpNum = props.getProperty('POPBILL_CORP_NUM');
  var senderNum = props.getProperty('POPBILL_SENDER_NUM');

  var token = _getPopbillToken();
  var url = 'https://popbill.linkhub.co.kr/KakaoTalk';

  var msgObj = {
    rcv: receiver.replace(/-/g, ''),
    rcvnm: receiverName
  };
  if (vars) {
    msgObj.msg = content;
    msgObj.altmsg = content;
    msgObj.vars = vars;
  }

  var body = {
    snd: senderNum,
    content: content,
    msgs: [msgObj],
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
  return JSON.parse(response.getContentText());

}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 반출/반납 안내톡 (3회 미만 고객 대상)
// 반출: 반출 시간 12시간 전 발송
// 반납: 반출 시간 + 3시간 후 발송
// 발송 가능 시간: 09:00~21:00 (밖이면 09:00으로 지연)
// 트리거: 30분마다 checkGuideAlimtalk 실행
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

var TPL_CHECKOUT = '026040000902';  // 반출 안내
var TPL_CHECKIN  = '026040000904';  // 반납 안내

var GUIDE_SEND_START = 8;   // 발송 가능 시작 시각
var GUIDE_SEND_END   = 22;  // 발송 가능 종료 시각

/**
 * 반출 안내톡 메시지 생성
 */
function _buildCheckoutMsg(customerName) {
  return customerName + ' 감독님, 안녕하세요.\n'
    + '빌리지 렌탈샵입니다.\n\n'
    + '예약하신 장비 대여 건의 반출일이 다가와 안내드립니다.\n'
    + '만약 직원이 부재할 시에 아래 내용을 참고해주세요 : )\n\n'
    + '1. 문을 열고 들어오셔서 감독님 성함과 반출 시간이 적힌 테이블을 찾아주시고, 장비를 테스트 하신 후 반출해주시면 됩니다.\n\n'
    + '모든 장비는 담당자가 확인을 마친 장비이며, 반출 시 확인하신 손상이나 이상은 사진과 함께 카톡으로 보내주시면 감사드리겠습니다.\n\n'
    + '2. 결제는 반출 시 견적서상 금액을 상단계좌에 입금해주셔도 되고 반납 시에 결제해주셔도 됩니다. 카드 결제를 원하실 경우 아래 순서에 따라 직접 결제 해주셔도 좋습니다.\n\n'
    + '1) 카드 넣기 2) 금액 입력 (계약서상 \'VAT포함가\') 3) 확인(녹색 버튼) 4) 사인 5) 최종 확인 버튼 6) 영수증 1부는 테이블 위에 놓고 가주시면 됩니다.\n\n'
    + '감사합니다!';
}

/**
 * 반납 안내톡 메시지 생성
 */
function _buildCheckinMsg(customerName) {
  return customerName + ' 감독님, 안녕하세요.\n'
    + '빌리지 렌탈샵입니다.\n\n'
    + '예약하신 장비 대여 건의 반납일이 다가와 안내드립니다.\n'
    + '만약 직원이 부재할 시에 아래 내용을 참고해주세요 : )\n\n'
    + '1. 장비를 한쪽에 잘 모아서 반납하신 후 사진 촬영하여 카카오톡 채널로 공유 부탁드립니다.\n\n'
    + '2. 나가실 때는 검정 철문은 닫지 마시고 나무로 된 문만 잘 닫힌 것 확인 후 가주시면 됩니다.\n\n'
    + '감사합니다 : )\n\n'
    + '*가급적이면 장비는 안쪽부터 차례대로 넣어주세요!';
}

/**
 * 반출일 + 반출시간 → Date 객체 (KST 기준)
 */
function _parseCheckoutDateTime(dateVal, timeVal) {
  var dateStr = dateVal instanceof Date
    ? Utilities.formatDate(dateVal, 'Asia/Seoul', 'yyyy-MM-dd') : String(dateVal || '').trim();
  var timeStr = timeVal instanceof Date
    ? Utilities.formatDate(timeVal, 'Asia/Seoul', 'HH:mm') : String(timeVal || '').trim();

  if (!dateStr) return null;
  if (!timeStr) timeStr = '10:00';  // 시간 미입력 시 기본 10시

  // yyyy-MM-dd HH:mm → Date (KST)
  var parts = dateStr.split('-');
  var timeParts = timeStr.split(':');
  var dt = new Date(
    parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]),
    parseInt(timeParts[0]), parseInt(timeParts[1] || '0'), 0
  );
  return dt;
}

/**
 * 발송 가능 시간 체크 (09:00~21:00 KST)
 * @returns {boolean} 지금 발송 가능하면 true
 */
function _isInSendWindow(nowKST) {
  var hour = parseInt(Utilities.formatDate(nowKST, 'Asia/Seoul', 'HH'));
  return hour >= GUIDE_SEND_START && hour < GUIDE_SEND_END;
}

/**
 * 30분마다 실행 — 반출/반납 안내톡 발송 시점 체크
 *
 * 반출 안내톡: 반출 시간 12시간 전 (발송 가능 시간 내에서)
 * 반납 안내톡: 반출 시간 + 3시간 후 (발송 가능 시간 내에서)
 * 대상: 3회 미만 고객만
 */
function checkGuideAlimtalk() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var schedSheet = ss.getSheetByName('스케줄상세');
  var contractSheet = ss.getSheetByName('계약마스터');

  if (!schedSheet || !contractSheet || schedSheet.getLastRow() < 2 || contractSheet.getLastRow() < 2) return;

  var now = new Date();

  // 발송 가능 시간 아니면 즉시 종료
  if (!_isInSendWindow(now)) {
    Logger.log('⏸ 발송 가능 시간 아님 (08:00~22:00 외)');
    return;
  }

  var todayStr = Utilities.formatDate(now, 'Asia/Seoul', 'yyyyMMdd');

  // ── 계약마스터 데이터 로드 ──
  // A=거래ID, B=예약자명, C=연락처
  var cmLastRow = contractSheet.getLastRow();
  var cmData = contractSheet.getRange(2, 1, cmLastRow - 1, 3).getValues();

  var contractMap = {};   // 거래ID → { name, tel }
  for (var ci = 0; ci < cmData.length; ci++) {
    var tid = String(cmData[ci][0] || '').trim();
    var name = String(cmData[ci][1] || '').trim();
    var tel = String(cmData[ci][2] || '').trim();
    if (tid) contractMap[tid] = { name: name, tel: tel };
  }

  // ── 고객DB에서 누적이용횟수 로드 ──
  // A=연락처, B=예약자명, C=누적이용횟수
  var dbSheet = ss.getSheetByName('고객DB');
  var usageCount = {};  // 예약자명 → 누적이용횟수
  if (dbSheet && dbSheet.getLastRow() >= 2) {
    var dbData = dbSheet.getRange(2, 1, dbSheet.getLastRow() - 1, 3).getValues();
    for (var di = 0; di < dbData.length; di++) {
      var dbName = String(dbData[di][1] || '').trim();
      var count = parseInt(dbData[di][2]) || 0;
      if (dbName) usageCount[dbName] = count;
    }
  }

  // ── 스케줄상세에서 거래ID별 반출일시 수집 ──
  var schedData = schedSheet.getRange(2, 1, schedSheet.getLastRow() - 1, 10).getValues();

  // 거래ID → { checkoutDT: Date, 상태 }  (첫 행 기준, 중복 거래ID는 스킵)
  var tradeInfo = {};

  for (var si = 0; si < schedData.length; si++) {
    var 거래ID = String(schedData[si][1] || '').trim();  // B
    var 반출일 = schedData[si][5];   // F
    var 반출시간 = schedData[si][6]; // G
    var 상태 = String(schedData[si][9] || '').trim();  // J

    if (!거래ID || 상태 === '취소') continue;
    if (tradeInfo[거래ID]) continue;  // 같은 거래ID 첫 행만

    var checkoutDT = _parseCheckoutDateTime(반출일, 반출시간);
    if (!checkoutDT) continue;

    tradeInfo[거래ID] = { checkoutDT: checkoutDT };
  }

  // ── 중복 발송 방지 ──
  var props = PropertiesService.getScriptProperties();
  var sentKey = 'GUIDE_SENT_' + todayStr;
  var sentData = {};
  try {
    var sentRaw = props.getProperty(sentKey);
    if (sentRaw) sentData = JSON.parse(sentRaw);
  } catch(e) {}

  var results = { sent: [], skipped: [], errors: [] };
  var nowMs = now.getTime();

  Object.keys(tradeInfo).forEach(function(tid) {
    var info = tradeInfo[tid];
    var cust = contractMap[tid];
    if (!cust || !cust.name || !cust.tel) return;

    // 3회 미만 고객만
    if ((usageCount[cust.name] || 0) >= 3) return;

    var checkoutMs = info.checkoutDT.getTime();

    // ── 반출 안내톡: 반출 12시간 전 ──
    var outSendMs = checkoutMs - (12 * 60 * 60 * 1000);
    var outFlag = 'out_' + tid;
    if (!sentData[outFlag] && nowMs >= outSendMs && nowMs < checkoutMs) {
      try {
        var outMsg = _buildCheckoutMsg(cust.name);
        var outVars = { '#{고객명}': cust.name };
        var outRes = sendAlimtalk(TPL_CHECKOUT, cust.tel, cust.name, outMsg, outVars);
        sentData[outFlag] = Utilities.formatDate(now, 'Asia/Seoul', 'HH:mm');
        results.sent.push('반출 ' + tid + ' ' + cust.name);
        Logger.log('✅ 반출 안내톡: ' + tid + ' ' + cust.name + ' → ' + JSON.stringify(outRes));
      } catch(err) {
        results.errors.push('반출 ' + tid + ': ' + err.message);
        Logger.log('❌ 반출 안내톡 실패: ' + tid + ' ' + err.message);
      }
    }

    // ── 반납 안내톡: 반출 3시간 후 ──
    var inSendMs = checkoutMs + (3 * 60 * 60 * 1000);
    var inFlag = 'in_' + tid;
    // 반출 당일~다음날 사이에만 발송 (너무 지난 건 무시)
    var inDeadlineMs = checkoutMs + (48 * 60 * 60 * 1000);
    if (!sentData[inFlag] && nowMs >= inSendMs && nowMs < inDeadlineMs) {
      try {
        var inMsg = _buildCheckinMsg(cust.name);
        var inVars = { '#{고객명}': cust.name };
        var inRes = sendAlimtalk(TPL_CHECKIN, cust.tel, cust.name, inMsg, inVars);
        sentData[inFlag] = Utilities.formatDate(now, 'Asia/Seoul', 'HH:mm');
        results.sent.push('반납 ' + tid + ' ' + cust.name);
        Logger.log('✅ 반납 안내톡: ' + tid + ' ' + cust.name + ' → ' + JSON.stringify(inRes));
      } catch(err) {
        results.errors.push('반납 ' + tid + ': ' + err.message);
        Logger.log('❌ 반납 안내톡 실패: ' + tid + ' ' + err.message);
      }
    }
  });

  // ── 발송 기록 저장 ──
  props.setProperty(sentKey, JSON.stringify(sentData));

  // ── 오래된 발송 기록 정리 (7일 이전) ──
  var allKeys = props.getKeys();
  var cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  var cutoffStr = 'GUIDE_SENT_' + Utilities.formatDate(cutoff, 'Asia/Seoul', 'yyyyMMdd');
  allKeys.forEach(function(k) {
    if (k.indexOf('GUIDE_SENT_') === 0 && k < cutoffStr) {
      props.deleteProperty(k);
    }
  });

  if (results.sent.length > 0 || results.errors.length > 0) {
    Logger.log('📋 안내톡 결과: ' + JSON.stringify(results));
  }
  return results;
}

/**
 * 반출/반납 안내톡 트리거 설정 (최초 1회 실행)
 * 30분마다 checkGuideAlimtalk 자동 실행
 */
function setupGuideAlimtalkTrigger() {
  // 기존 트리거 제거
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function(t) {
    if (t.getHandlerFunction() === 'checkGuideAlimtalk') {
      ScriptApp.deleteTrigger(t);
    }
  });

  // 30분마다 트리거 생성
  ScriptApp.newTrigger('checkGuideAlimtalk')
    .timeBased()
    .everyMinutes(30)
    .create();

  Logger.log('✅ 반출/반납 안내톡 트리거 설정 완료 (30분마다 체크)');
}

/**
 * 스케줄상세 시트 가독성 포맷팅
 * - 같은 거래ID(B열) 그룹끼리 교차 배경색 (흰색 ↔ 연한 회색)
 * - 거래ID가 바뀌는 경계에 하단 테두리
 */
function formatScheduleSheet(schedSheet) {
  if (!schedSheet) {
    schedSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("스케줄상세");
  }
  if (!schedSheet) return;

  const lastRow = schedSheet.getLastRow();
  if (lastRow < 2) return;

  const lastCol = schedSheet.getLastColumn() || 13;
  const data = schedSheet.getRange(2, 2, lastRow - 1, 1).getValues(); // B열(거래ID)

  const COLOR_A = null;        // 흰색 (기본)
  const COLOR_B = "#F3F3F3";   // 연한 회색
  var colorToggle = 0;
  var prevID = null;

  // 전체 배경 초기화 + 테두리 초기화
  var fullRange = schedSheet.getRange(2, 1, lastRow - 1, lastCol);
  fullRange.setBackground(null);
  fullRange.setBorder(null, null, null, null, null, null);

  for (var i = 0; i < data.length; i++) {
    var curID = String(data[i][0] || "").trim();

    if (curID !== prevID && prevID !== null) {
      // 이전 그룹 마지막 행에 하단 테두리
      schedSheet.getRange(i + 1, 1, 1, lastCol)
        .setBorder(null, null, true, null, null, null, "#999999", SpreadsheetApp.BorderStyle.SOLID);
      colorToggle = 1 - colorToggle;
    }

    // 배경색 적용
    var color = colorToggle === 0 ? COLOR_A : COLOR_B;
    if (color) {
      schedSheet.getRange(i + 2, 1, 1, lastCol).setBackground(color);
    }

    prevID = curID;
  }
}


function fixScheduleHeaders() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("스케줄상세");
  if (!sheet) { return; }
  var newHeaders = ["스케줄ID", "거래ID", "세트명", "장비명", "수량", "반출일", "반출시간", "반납일", "반납시간", "상태", "비고", "단가", "예약자명"];
  sheet.getRange(1, 1, 1, 12).setValues([newHeaders]);
  sheet.getRange(1, 1, 1, 12).setFontWeight("bold");
  sheet.setFrozenRows(1);
  refreshEquipmentList();
  SpreadsheetApp.getUi().alert("✅ 수정 완료!\n\n1. 스케줄상세 헤더 업데이트 (12열)\n2. 확인요청 F열 드롭다운 갱신\n\n⚠️ AppSheet에서 스케줄상세 Regenerate schema도 해주세요.");
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 1회성 셋업/디버깅 함수 정리됨:
// setupScriptProperties, diagGosuURL, diagGosuWrite,
// migratePriceToSetMaster, syncTemplateHiddenSheet,
// fillScheduleNames, dedup252vsExisting, debugSetMasterFrom252,
// cleanSetMasterFrom252, setupAutoClear, setupCustomerDB
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━



/**
 * 현재 등록된 모든 트리거 목록 반환 (디버깅용)
 */
function listAllTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  var result = triggers.map(function(t) {
    return {
      handler: t.getHandlerFunction(),
      eventType: t.getEventType().toString(),
      triggerSource: t.getTriggerSource().toString()
    };
  });
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}
function clearValidation() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("확인요청");
  sheet.getRange(2, 1, 300, 18).clearDataValidations();
  refreshEquipmentList();
}

/**
 * 계약마스터 시트 가독성 포맷팅
 * - E,F 반출일/시간: 연파랑
 * - G,H 반납일/시간: 연녹색
 * - I 회차: 연노랑
 * - J 계약상태: 기본 파랑, 조건부서식으로 "취소"→빨강+취소선, "완료"→회색
 * - A,B,C,D,K 기타 정보: 흐린 회색 톤 (글자도 흐리게)
 * - E~J 굵게
 */
function formatContractSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("계약마스터");
  if (!sheet) return "계약마스터 시트 없음";

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return "데이터 없음";
  var dataRows = lastRow - 1;
  var lastCol = 11;

  var COLOR_OUT       = "#DAE8FC"; // 반출
  var COLOR_IN        = "#D5E8D4"; // 반납
  var COLOR_SEQ       = "#FFF2CC"; // 회차
  var COLOR_STAT_DEF  = "#BDD7EE"; // 계약상태 기본
  var COLOR_DIM_BG    = "#F5F5F5";
  var COLOR_DIM_FG    = "#A6A6A6";

  // 1) 데이터 영역 초기화
  var dataRange = sheet.getRange(2, 1, dataRows, lastCol);
  dataRange.setBackground(null);
  dataRange.setFontColor(null);
  dataRange.setFontWeight(null);
  dataRange.setFontStyle(null);

  // 2) 흐린 열 (A, B, C, D, K)
  [1, 2, 3, 4, 11].forEach(function(c) {
    sheet.getRange(2, c, dataRows, 1)
      .setBackground(COLOR_DIM_BG)
      .setFontColor(COLOR_DIM_FG);
  });

  // 3) 주요 열 그룹 배경
  sheet.getRange(2, 5, dataRows, 2).setBackground(COLOR_OUT);      // E,F 반출
  sheet.getRange(2, 7, dataRows, 2).setBackground(COLOR_IN);       // G,H 반납
  sheet.getRange(2, 9, dataRows, 1).setBackground(COLOR_SEQ);      // I 회차
  sheet.getRange(2, 10, dataRows, 1).setBackground(COLOR_STAT_DEF);// J 계약상태 기본

  // 4) E~J 굵게
  sheet.getRange(2, 5, dataRows, 6).setFontWeight("bold");

  // 5) 조건부 서식: 계약상태 기준 행 전체
  var ruleRange = sheet.getRange(2, 1, dataRows, lastCol);
  var existing = sheet.getConditionalFormatRules().filter(function(r) {
    // 기존 계약마스터 2b 규칙 제거 (A2:K 범위 규칙만)
    var ranges = r.getRanges();
    if (!ranges || ranges.length === 0) return true;
    var a1 = ranges[0].getA1Notation();
    return !/^A2:K\d+$/.test(a1);
  });

  existing.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$J2="취소"')
      .setBackground("#FFC7CE")
      .setFontColor("#9C0006")
      .setStrikethrough(true)
      .setRanges([ruleRange])
      .build()
  );
  existing.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$J2="완료"')
      .setBackground("#E7E6E6")
      .setFontColor("#7F7F7F")
      .setRanges([ruleRange])
      .build()
  );

  sheet.setConditionalFormatRules(existing);

  // 6) 헤더 고정
  sheet.setFrozenRows(1);

  return "✅ " + dataRows + "행 서식 적용 완료";
}