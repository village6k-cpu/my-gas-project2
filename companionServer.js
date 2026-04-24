/**
 * companionServer.gs — 동행 모드 사이드바 서버 측 함수
 *
 * 클라이언트(companionSidebar.html) 가 google.script.run 으로 호출.
 */

/**
 * 사이드바를 띄운다 (메뉴에서 호출).
 */
function showCompanionSidebar() {
  const html = HtmlService.createHtmlOutputFromFile('companionSidebar')
    .setTitle('🎓 동행 모드');
  SpreadsheetApp.getUi().showSidebar(html);
}

/**
 * 현재 선택된 행을 기준으로 단계 판별.
 * 확인요청 시트가 아니면 null 반환.
 */
function getCurrentBookingContext() {
  const sheet = SpreadsheetApp.getActiveSheet();
  if (sheet.getName() !== '확인요청') return null;

  const row = sheet.getActiveCell().getRow();
  if (row < 2) return null;

  return getBookingContextForRow(row);
}

/**
 * 특정 행의 단계 판별.
 */
function getBookingContextForRow(row) {
  const sheet = SpreadsheetApp.getSheetByName('확인요청');
  if (!sheet) return null;

  const values = sheet.getRange(row, 1, 1, 18).getValues()[0];
  const data = {
    requestId: values[0], carryOutDate: values[1], carryOutTime: values[2],
    returnDate: values[3], returnTime: values[4], equipment: values[5],
    quantity: values[6], confirm: values[7], result: values[8], detail: values[9],
    customerName: values[10], customerPhone: values[11], company: values[12],
    register: values[13], registerStatus: values[14], transactionId: values[15],
    note: values[16], extraRequest: values[17]
  };

  const firstRow = findFirstRowOfRequest(sheet, data.requestId, row);
  const firstRowData = firstRow ? readRowData(sheet, firstRow) : data;

  return determineStep(data, firstRowData);
}

function findFirstRowOfRequest(sheet, requestId, currentRow) {
  if (!requestId) return currentRow;
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return currentRow;
  const aCol = sheet.getRange(2, 1, lastRow - 1, 1).getValues().flat();
  for (let i = 0; i < aCol.length; i++) {
    if (aCol[i] === requestId) return i + 2;
  }
  return currentRow;
}

function readRowData(sheet, row) {
  const values = sheet.getRange(row, 1, 1, 18).getValues()[0];
  return {
    requestId: values[0], carryOutDate: values[1], carryOutTime: values[2],
    returnDate: values[3], returnTime: values[4], equipment: values[5],
    quantity: values[6], confirm: values[7], result: values[8], detail: values[9],
    customerName: values[10], customerPhone: values[11], company: values[12],
    register: values[13], registerStatus: values[14], transactionId: values[15],
    note: values[16], extraRequest: values[17]
  };
}

function isEmpty(v) {
  return v === null || v === undefined || String(v).trim() === '';
}

function determineStep(row, firstRow) {
  const r = row;
  const f = firstRow;

  const allEmpty = isEmpty(r.carryOutDate) && isEmpty(r.returnDate) && isEmpty(r.equipment);
  if (allEmpty) {
    return {
      step: 0,
      stepName: '신규 예약 시작',
      action: 'B열(반출일)부터 입력하세요',
      tips: []
    };
  }

  const basicEmpty = [];
  if (isEmpty(r.carryOutDate)) basicEmpty.push('반출일');
  if (isEmpty(r.carryOutTime)) basicEmpty.push('반출시간');
  if (isEmpty(r.returnDate)) basicEmpty.push('반납일');
  if (isEmpty(r.returnTime)) basicEmpty.push('반납시간');
  if (isEmpty(r.equipment)) basicEmpty.push('장비or세트명');
  if (isEmpty(r.quantity)) basicEmpty.push('수량');
  if (basicEmpty.length > 0) {
    return {
      step: 1,
      stepName: '기본 정보 입력 중',
      action: `빈 필드: ${basicEmpty.join(', ')}`,
      tips: ['F열 장비는 반드시 드롭다운에서 선택', 'C/E열 시간 포맷: HH:MM (예: 14:30)']
    };
  }

  if (isEmpty(r.confirm)) {
    return {
      step: 2,
      stepName: '가용성 확인 필요',
      action: "H열 드롭다운에서 '확인' 선택",
      tips: ['시스템이 I/J열에 자동으로 가용성 결과 표시']
    };
  }

  if (String(r.confirm).trim() === '확인' && isEmpty(r.result)) {
    return {
      step: 3,
      stepName: '가용성 체크 중',
      action: '잠시 기다리세요 (3~5초)',
      tips: []
    };
  }

  const resultText = String(r.result || '') + ' ' + String(r.detail || '');
  const isUnavailable = resultText.indexOf('❌') >= 0
    || resultText.indexOf('없음') >= 0
    || resultText.indexOf('선택하세요') >= 0
    || resultText.indexOf('사용중') >= 0;
  const isAvailable = resultText.indexOf('✅') >= 0 || resultText.indexOf('가용') >= 0 || resultText.indexOf('보유') >= 0;

  if (isUnavailable && !isAvailable) {
    return {
      step: 4,
      stepName: '가용성 불가',
      action: `${r.result || r.detail || '확인 필요'} — 대안: 날짜 변경 또는 대체 장비`,
      tips: ['챗봇에 "대체 장비" 질문 가능'],
      error: String(r.result || r.detail || '')
    };
  }

  if (isAvailable && (isEmpty(f.customerName) || isEmpty(f.customerPhone))) {
    const miss = [];
    if (isEmpty(f.customerName)) miss.push('예약자명(K)');
    if (isEmpty(f.customerPhone)) miss.push('연락처(L)');
    return {
      step: 5,
      stepName: '고객 정보 입력',
      action: miss.join(' + ') + ' 입력',
      tips: ['사업자 고객이면 M열 업체명도 입력']
    };
  }

  if (isAvailable && !isEmpty(f.customerName) && !isEmpty(f.customerPhone) && isEmpty(f.register)) {
    return {
      step: 6,
      stepName: '등록 준비 완료',
      action: "N열 드롭다운에서 '등록' 선택",
      tips: [
        '할인율 맞게 계산했나? (장기/학생/사업자/쿠폰)',
        '같은 고객+같은 장비+겹치는 날짜면 중복 확인',
        'N 선택 시 계약서·거래내역 자동 생성됨'
      ]
    };
  }

  if (String(f.register).trim() === '등록' && isEmpty(f.registerStatus)) {
    return {
      step: 7,
      stepName: '검증 + 등록 진행 중',
      action: '잠시 기다리세요',
      tips: ['O열이 "등록실패" 면 즉시 사장님 호출']
    };
  }

  const reg = String(f.registerStatus || '');
  if (reg.indexOf('등록완료') >= 0) {
    return {
      step: 8,
      stepName: '등록 완료',
      action: `🎉 거래ID: ${f.transactionId || '?'}`,
      tips: ['다음: 약관 동의 링크 전송', '슬랙 #예약관리 공유']
    };
  }

  return {
    step: 0,
    stepName: '상태 판별 불가',
    action: '행 값을 다시 확인하세요',
    tips: [`requestId: ${r.requestId}, register: ${r.register}, status: ${r.registerStatus}`]
  };
}
