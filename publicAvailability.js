/**
 * ====================================================================
 * publicAvailability.js — 고객용 공개 가용성/견적 조회 (읽기 전용)
 * ====================================================================
 *
 * 시트에 아무것도 쓰지 않는다. 확인요청 행 생성 없이 가용성과 예상 견적만 계산한다.
 * 응답에 예약자명·연락처 등 개인정보를 절대 포함하지 않는다 (가용 수치만 반환).
 *
 * 진입: sheetAPI.js → action=publicAvail → getPublicAvailability(req)
 * req = {
 *   반출일: "2026-06-15", 반출시간: "10:00",
 *   반납일: "2026-06-18", 반납시간: "16:00",
 *   장비: [{ 이름: "...", 수량: 1 }, ...],
 *   할인유형: "일반" | "학생" | "개인사업자/프리랜서"   (선택, 견적 표시용)
 * }
 *
 * 재사용하는 기존 전역 함수 (GAS 전역 스코프 공유):
 *   parseDT, getScheduleData, findEquipment, findEquipmentByCategory,
 *   getSetComponents, findSetPrice, isSetMasterName, fuzzyMatchEquipName,
 *   calcRentalDays, getLongTermDiscountRate, _normalizeDiscountType
 */

/** 할인유형 → 사전할인율(%) — generatecontract.js 계약서 드롭다운 매핑과 동일 */
function _publicPreDiscountRate_(discountType) {
  switch (String(discountType || "").trim()) {
    case "학생": return 30;
    case "개인사업자/프리랜서": return 20;
    default: return 0; // 일반/미지정 (단골·제휴는 사장 수동 지정이므로 공개 견적에선 제외)
  }
}

/**
 * 특정 장비명·수량·기간의 가용 수량 계산 (sweep-line 피크 방식).
 * checkSingleRowWithData(checkAvailability.js)와 같은 판정 로직의 무기록 버전.
 * @return {number} 기간 내 가용 수량 (총보유 - 동시사용 피크)
 */
function _publicAvailQty_(equipName, equipTotal, reqStartDT, reqEndDT, schedData) {
  var overlaps = [];
  for (var i = 0; i < schedData.length; i++) {
    var s = schedData[i];
    if (s.equipment !== equipName) continue;
    if (s.status === "반납완료" || s.status === "취소") continue;
    if (!s.startDT || !s.endDT) continue;
    if (s.startDT < reqEndDT && s.endDT > reqStartDT) overlaps.push(s);
  }
  if (overlaps.length === 0) return equipTotal;

  var tpSet = {};
  tpSet[reqStartDT.getTime()] = true;
  overlaps.forEach(function (s) {
    var st = s.startDT.getTime(), et = s.endDT.getTime();
    if (st > reqStartDT.getTime() && st < reqEndDT.getTime()) tpSet[st] = true;
    if (et > reqStartDT.getTime() && et < reqEndDT.getTime()) tpSet[et] = true;
  });
  var timePoints = Object.keys(tpSet).map(Number);

  var maxConcurrent = 0;
  for (var ti = 0; ti < timePoints.length; ti++) {
    var tp = timePoints[ti];
    var concurrent = 0;
    for (var oi = 0; oi < overlaps.length; oi++) {
      if (overlaps[oi].startDT.getTime() <= tp && overlaps[oi].endDT.getTime() > tp) {
        concurrent += overlaps[oi].qty;
      }
    }
    if (concurrent > maxConcurrent) maxConcurrent = concurrent;
  }
  return equipTotal - maxConcurrent;
}

/**
 * 단일 항목(장비명 또는 카테고리명) 가용 판정.
 * 카테고리명이면 소속 모델 중 가용 최대값으로 판정 (직원이 모델을 골라줄 수 있으므로).
 * @return {{found:boolean, availQty:number, total:number, isCategory:boolean}}
 */
function _publicCheckOne_(name, reqStartDT, reqEndDT, schedData, equipSheet) {
  var info = findEquipment(name, equipSheet);
  if (info) {
    return {
      found: true,
      isCategory: false,
      total: Number(info.total) || 0,
      availQty: _publicAvailQty_(name, Number(info.total) || 0, reqStartDT, reqEndDT, schedData)
    };
  }
  var catItems = findEquipmentByCategory(name, equipSheet);
  if (catItems.length > 0) {
    var best = 0, totalSum = 0;
    for (var i = 0; i < catItems.length; i++) {
      var t = Number(catItems[i].total) || 0;
      totalSum += t;
      var a = _publicAvailQty_(catItems[i].name, t, reqStartDT, reqEndDT, schedData);
      if (a > best) best = a;
    }
    return { found: true, isCategory: true, total: totalSum, availQty: best };
  }
  return { found: false, isCategory: false, total: 0, availQty: 0 };
}

/**
 * 공개 가용성 + 견적 조회 (메인 진입점, 읽기 전용)
 * @return {{success:boolean, days:number, longTermRate:number, preRate:number,
 *           items:Array, listTotal:number, estimatedTotal:number, priceComplete:boolean}}
 */
function getPublicAvailability(req) {
  req = req || {};
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var equipSheet = ss.getSheetByName("장비마스터");
  var setSheet = ss.getSheetByName("세트마스터");
  var schedSheet = ss.getSheetByName("스케줄상세");
  if (!equipSheet || !setSheet || !schedSheet) {
    return { success: false, error: "필수 시트 없음" };
  }

  var reqStartDT = parseDT(req.반출일, req.반출시간);
  var reqEndDT = parseDT(req.반납일, req.반납시간);
  if (!reqStartDT || !reqEndDT || reqStartDT >= reqEndDT) {
    return { success: false, error: "날짜/시간 범위 오류" };
  }
  // 과거 시점 차단 + 과도한 미래(1년 초과) 차단
  var now = new Date();
  if (reqEndDT <= now) return { success: false, error: "이미 지난 기간입니다" };
  if (reqStartDT.getTime() - now.getTime() > 366 * 24 * 3600 * 1000) {
    return { success: false, error: "1년 이후 일정은 별도 문의해주세요" };
  }

  var rawItems = req.장비 || [];
  if (!rawItems.length) return { success: false, error: "장비 목록이 비었습니다" };
  if (rawItems.length > 30) return { success: false, error: "한 번에 30개 항목까지 조회 가능합니다" };

  // 목록 시트 기준 퍼지 매칭 (확인요청 입력과 동일한 매칭 규칙)
  var equipNames = [];
  try {
    var listSheet = ss.getSheetByName("목록");
    if (listSheet && listSheet.getLastRow() >= 2) {
      equipNames = listSheet.getRange(2, 1, listSheet.getLastRow() - 1, 1)
        .getValues().flat().filter(function (v) { return v; }).map(String);
    }
  } catch (e) {}

  var schedData = getScheduleData(schedSheet);
  var days = calcRentalDays(req.반출일, req.반출시간, req.반납일, req.반납시간);
  var longTermRate = getLongTermDiscountRate(days);
  var preRate = _publicPreDiscountRate_(_normalizeDiscountType(req.할인유형));

  var items = [];
  var listTotal = 0;
  var priceComplete = true;

  for (var i = 0; i < rawItems.length; i++) {
    var inputName = String(rawItems[i].이름 || rawItems[i].name || "").trim();
    var qty = Math.max(1, parseInt(rawItems[i].수량 || rawItems[i].qty, 10) || 1);
    if (!inputName) continue;

    var matched = fuzzyMatchEquipName(inputName, equipNames);
    var unitPrice = Number(findSetPrice(matched, setSheet)) || 0;
    var components = getSetComponents(matched, setSheet);

    var item = {
      input: inputName,
      name: matched,
      qty: qty,
      isSet: components.length > 0,
      unitPrice: unitPrice,
      status: "가용",      // 가용 | 부족 | 불가 | 미등록
      availQty: null,
      components: []
    };

    if (components.length > 0) {
      // 세트: 모든 구성품이 가용해야 세트 가용
      var worst = "가용";
      for (var c = 0; c < components.length; c++) {
        var comp = components[c];
        var need = (Number(comp.qty) || 1) * qty;
        var chk = _publicCheckOne_(comp.name, reqStartDT, reqEndDT, schedData, equipSheet);
        var compStatus;
        if (!chk.found) compStatus = "미등록";
        else if (chk.availQty >= need) compStatus = "가용";
        else if (chk.availQty > 0) compStatus = "부족";
        else compStatus = "불가";
        item.components.push({ name: comp.name, need: need, status: compStatus });
        if (compStatus === "불가" || compStatus === "미등록") worst = "불가";
        else if (compStatus === "부족" && worst !== "불가") worst = "부족";
      }
      item.status = worst;
    } else {
      var chk1 = _publicCheckOne_(matched, reqStartDT, reqEndDT, schedData, equipSheet);
      if (!chk1.found) {
        item.status = "미등록";
      } else {
        item.availQty = Math.max(0, chk1.availQty);
        if (chk1.availQty >= qty) item.status = "가용";
        else if (chk1.availQty > 0) item.status = "부족";
        else item.status = "불가";
      }
    }

    if (unitPrice > 0) listTotal += unitPrice * qty;
    else priceComplete = false;
    items.push(item);
  }

  // 견적 = Σ(단가×수량) × 일수 × (1-사전할인) × (1-장기할인)  — 계약서 곱셈 정책과 동일
  var grossTotal = listTotal * days;
  var estimatedTotal = Math.round(grossTotal * (1 - preRate / 100) * (1 - longTermRate / 100));

  return {
    success: true,
    days: days,
    longTermRate: longTermRate,
    preRate: preRate,
    items: items,
    listTotal: listTotal,
    grossTotal: grossTotal,
    estimatedTotal: estimatedTotal,
    priceComplete: priceComplete,
    allAvailable: items.length > 0 && items.every(function (it) { return it.status === "가용"; })
  };
}
