/**
 * companionValidator.gs — N열 등록 전 로컬 검증
 *
 * 5가지 차단 체크 (fail-fast 순서):
 * 1. 스케줄 충돌 (스케줄상세 시트)
 * 2. 필수 필드 빈칸
 * 3. 날짜/시간 포맷 오류
 * 4. 수량 이상
 * 5. H열 확인 미실행
 */

function companion_localChecks(firstRowData, sheet, row) {
  const blocks = [];

  const conflict = companion_checkScheduleConflict(firstRowData, sheet, row);
  if (conflict) blocks.push(conflict);

  const missing = companion_checkRequiredFields(firstRowData);
  if (missing.length > 0) blocks.push('❌ 필수 필드 빈칸: ' + missing.join(', '));

  const fmt = companion_checkDateTimeFormat(firstRowData);
  if (fmt) blocks.push(fmt);

  const qty = companion_checkQuantity(firstRowData);
  if (qty) blocks.push(qty);

  if (String(firstRowData.confirm || '').trim() !== '확인') {
    blocks.push('❌ H열 "확인" 미실행 — 먼저 가용성 체크');
  }

  return blocks;
}

function companion_checkScheduleConflict(data, sheet, row) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const scheduleSheet = ss.getSheetByName('스케줄상세');
  if (!scheduleSheet) return null;

  const lastRow = scheduleSheet.getLastRow();
  if (lastRow < 2) return null;

  const rows = scheduleSheet.getRange(2, 1, lastRow - 1, 10).getValues();

  const targetStart = companion_toDate(data.carryOutDate, data.carryOutTime);
  const targetEnd = companion_toDate(data.returnDate, data.returnTime);
  if (!targetStart || !targetEnd) return null;

  const ownReqId = data.requestId;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const otherTxId = String(r[0] || '');
    const otherEq = String(r[1] || '');
    const otherStart = r[2] instanceof Date ? r[2] : null;
    const otherEnd = r[3] instanceof Date ? r[3] : null;

    if (!otherEq || !otherStart || !otherEnd) continue;
    if (otherEq !== data.equipment) continue;
    if (otherTxId && otherTxId.indexOf(ownReqId) >= 0) continue;

    const overlap = targetStart < otherEnd && targetEnd > otherStart;
    if (overlap) {
      return `❌ 스케줄 충돌 — 거래ID ${otherTxId} (${data.equipment}) 이미 예약됨`;
    }
  }
  return null;
}

function companion_checkRequiredFields(d) {
  const miss = [];
  if (!d.carryOutDate) miss.push('반출일');
  if (!d.carryOutTime) miss.push('반출시간');
  if (!d.returnDate) miss.push('반납일');
  if (!d.returnTime) miss.push('반납시간');
  if (!d.equipment) miss.push('장비');
  if (!d.quantity) miss.push('수량');
  if (!d.customerName) miss.push('예약자명');
  if (!d.customerPhone) miss.push('연락처');
  return miss;
}

function companion_checkDateTimeFormat(d) {
  const timeRe = /^(\d{1,2}):(\d{2})$/;
  const toStr = v => (v instanceof Date) ? Utilities.formatDate(v, 'Asia/Seoul', 'HH:mm') : String(v || '');

  const ot = toStr(d.carryOutTime);
  const rt = toStr(d.returnTime);
  if (!timeRe.test(ot)) return `❌ 반출시간 포맷 이상: "${ot}" → HH:MM 형식 필요`;
  if (!timeRe.test(rt)) return `❌ 반납시간 포맷 이상: "${rt}" → HH:MM 형식 필요`;

  const start = companion_toDate(d.carryOutDate, d.carryOutTime);
  const end = companion_toDate(d.returnDate, d.returnTime);
  if (!start || !end) return '❌ 날짜 파싱 실패';

  if (start >= end) {
    return '❌ 반출 시점이 반납 시점과 같거나 늦음';
  }
  return null;
}

function companion_checkQuantity(d) {
  const q = Number(d.quantity);
  if (!isFinite(q) || q <= 0) return '❌ 수량은 1 이상이어야 함';
  return null;
}

function companion_toDate(dateVal, timeVal) {
  if (!dateVal) return null;
  let y, m, d;
  if (dateVal instanceof Date) {
    y = dateVal.getFullYear(); m = dateVal.getMonth(); d = dateVal.getDate();
  } else {
    const parts = String(dateVal).match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (!parts) return null;
    y = Number(parts[1]); m = Number(parts[2]) - 1; d = Number(parts[3]);
  }

  let hh = 0, mm = 0;
  if (timeVal instanceof Date) {
    hh = timeVal.getHours(); mm = timeVal.getMinutes();
  } else {
    const t = String(timeVal || '').match(/^(\d{1,2}):(\d{2})$/);
    if (t) { hh = Number(t[1]); mm = Number(t[2]); }
  }
  return new Date(y, m, d, hh, mm);
}
