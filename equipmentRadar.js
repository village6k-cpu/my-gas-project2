/**
 * ====================================================================
 * equipmentRadar.js — 장비 수익 레이더 (2026-07-12 신규)
 * ====================================================================
 *
 * 목적: 렌탈샵 수익성 = 장비 회전율. 어떤 장비가 돈을 벌고, 어떤 고가 장비가
 *   놀면서 자본을 묶고 있는지, 대여됐는데 단가가 0이라 청구가 새는 건 없는지
 *   자산 관점 손익을 자동 산출한다.
 *
 * 데이터 소스(전부 읽기 전용):
 *   - 장비마스터: C카테고리 D장비명 E총보유수량 G대여중수량 I상태 L단가(1일 요금) — 가격의 기준
 *   - 스케줄상세: D장비명 E수량 F반출일 H반납일 — 실제 대여 이력(빈도·기간)
 *
 * 방식: 스케줄상세에서 장비별 대여횟수·대여일수를 집계하고, 장비마스터 단가로
 *   추정매출(대여일수 × 단가 × 수량)을 계산. 최근 90일 기준으로 효자/유휴를 가른다.
 *
 * 노출: sheetAPI.js action=equipRadar (key 인증). 헤이빌리 /profit 페이지가 호출.
 */

function getEquipmentProfitRadar(params) {
  params = params || {};
  var limit = Math.min(parseInt(params.limit, 10) || 40, 200);
  var windowDays = Math.min(parseInt(params.windowDays, 10) || 90, 365);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var em = ss.getSheetByName('장비마스터');
  var sd = ss.getSheetByName('스케줄상세');
  if (!sd || sd.getLastRow() < 2) return { ok: false, error: '스케줄상세 데이터 없음' };

  var tz = Session.getScriptTimeZone() || 'Asia/Seoul';
  var now = new Date();
  var nowMs = now.getTime();
  var MS_DAY = 86400000;
  var windowStart = nowMs - windowDays * MS_DAY;

  function normName(s) { return String(s || '').trim().replace(/\s+/g, ' ').toLowerCase(); }
  function toDate(v) {
    if (!v) return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }

  // ── 1) 장비마스터: 이름별 단가·보유·상태 ──
  var master = {};   // normName → { name, category, stock, price, inUse, status }
  if (em && em.getLastRow() >= 2) {
    var mrows = em.getRange(2, 1, em.getLastRow() - 1, 13).getValues();
    for (var i = 0; i < mrows.length; i++) {
      var mName = String(mrows[i][3] || '').trim();   // D 장비명
      if (!mName) continue;
      var key = normName(mName);
      if (master[key]) {
        // 동일 이름 중복 행: 보유수량 합산, 단가는 최대값
        master[key].stock += Number(mrows[i][4]) || 0;
        master[key].price = Math.max(master[key].price, Number(mrows[i][11]) || 0);
        master[key].inUse += Number(mrows[i][6]) || 0;
      } else {
        master[key] = {
          name: mName,
          category: String(mrows[i][2] || '').trim(),
          stock: Number(mrows[i][4]) || 0,
          price: Number(mrows[i][11]) || 0,   // L 단가(1일)
          inUse: Number(mrows[i][6]) || 0,    // G 대여중
          status: String(mrows[i][8] || '').trim()
        };
      }
    }
  }

  // ── 2) 스케줄상세: 장비명별 대여 집계 ──
  var srows = sd.getRange(2, 1, sd.getLastRow() - 1, 13).getValues();
  var rentals = {};   // normName → { name, count90, countAll, days90, lastOut, revenue90, hadPriceOnRow }
  for (var r = 0; r < srows.length; r++) {
    var gName = String(srows[r][3] || '').trim();     // D 장비명
    if (!gName) continue;
    var key2 = normName(gName);
    var qty = Number(srows[r][4]) || 1;               // E 수량
    var outD = toDate(srows[r][5]);                    // F 반출일
    var retD = toDate(srows[r][7]);                    // H 반납일
    var rowPrice = Number(srows[r][11]) || 0;          // L 단가(행)
    if (!outD) continue;
    var outMs = outD.getTime();
    var days = 1;
    if (retD) days = Math.max(1, Math.round((retD.getTime() - outMs) / MS_DAY));

    var rec = rentals[key2] || (rentals[key2] = {
      name: gName, count90: 0, countAll: 0, days90: 0, lastOut: 0, revenue90: 0, anyRowPrice: false
    });
    rec.countAll++;
    if (outMs >= rec.lastOut) { rec.lastOut = outMs; rec.name = gName; }
    if (rowPrice > 0) rec.anyRowPrice = true;
    if (outMs >= windowStart) {
      rec.count90++;
      rec.days90 += days * qty;
      var unitPrice = (master[key2] && master[key2].price) || rowPrice || 0;
      rec.revenue90 += days * qty * unitPrice;
    }
  }

  // ── 3) 버킷 구성 ──
  var earners = [], idle = [], unpriced = [];
  var totalRevenue90 = 0, activeCount = 0, idleCapital = 0;

  // 효자·미가격: 대여 이력 기준
  Object.keys(rentals).forEach(function (key) {
    var rec = rentals[key];
    var m = master[key];
    var price = (m && m.price) || 0;
    if (rec.count90 > 0) {
      activeCount++;
      totalRevenue90 += rec.revenue90;
      earners.push({
        name: rec.name,
        category: (m && m.category) || '',
        count90: rec.count90,
        days90: rec.days90,
        revenue90: rec.revenue90,
        price: price,
        stock: (m && m.stock) || null,
        lastRentedAt: rec.lastOut ? Utilities.formatDate(new Date(rec.lastOut), tz, 'yyyy-MM-dd') : '',
        inMaster: !!m
      });
    }
    // 미가격(청구 누락 위험): 장비마스터에 "등록된" 장비인데 단가가 0이고 실제 대여 이력이 있음.
    // inMaster 조건이 핵심 — 세트 구성품 등 마스터에 없는 이름은 매칭 실패 노이즈라 제외.
    if (m && rec.countAll > 0 && price === 0 && !rec.anyRowPrice) {
      unpriced.push({
        name: rec.name, countAll: rec.countAll, count90: rec.count90,
        lastRentedAt: rec.lastOut ? Utilities.formatDate(new Date(rec.lastOut), tz, 'yyyy-MM-dd') : ''
      });
    }
  });

  // 유휴(노는 자본): 장비마스터에 있는데 최근 90일 대여 0회, 보유수량>0
  Object.keys(master).forEach(function (key) {
    var m = master[key];
    if (m.stock <= 0) return;
    if (/폐기|처분|판매/.test(m.status)) return;
    var rec = rentals[key];
    var count90 = rec ? rec.count90 : 0;
    if (count90 > 0) return;   // 최근 대여 있음 → 유휴 아님
    var capital = m.price * m.stock;   // 묶인 자본(1일 요금 × 보유수량)
    idleCapital += capital;
    idle.push({
      name: m.name, category: m.category, stock: m.stock, price: m.price,
      capital: capital,
      lastRentedAt: rec && rec.lastOut ? Utilities.formatDate(new Date(rec.lastOut), tz, 'yyyy-MM-dd') : '',
      neverRented: !rec
    });
  });

  earners.sort(function (a, b) { return b.revenue90 - a.revenue90 || b.count90 - a.count90; });
  idle.sort(function (a, b) { return b.capital - a.capital || b.price - a.price; });
  unpriced.sort(function (a, b) { return b.countAll - a.countAll; });

  return {
    ok: true,
    generatedAt: now.toISOString(),
    today: Utilities.formatDate(now, tz, 'yyyy-MM-dd'),
    windowDays: windowDays,
    stats: {
      activeEquipment: activeCount,
      idleEquipment: idle.length,
      revenue90: Math.round(totalRevenue90),
      idleCapitalPerDay: Math.round(idleCapital),
      unpricedCount: unpriced.length
    },
    earners: earners.slice(0, limit),
    idle: idle.slice(0, limit),
    unpriced: unpriced.slice(0, 40)
  };
}
