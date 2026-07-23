/**
 * ====================================================================
 * equipmentRadar.js — 장비 수익 레이더 (2026-07-12, v2 재작성)
 * ====================================================================
 *
 * 목적: 자산 관점 손익. 어떤 상품이 실제로 돈을 벌고, 어떤 장비가 놀며 매출을
 *   놓치고 있고, 청구가 새는 건 없는지 자동 산출.
 *
 * ★ v2 핵심 교정(모델: Fable 5 재분석) ─────────────────────────────
 *   스케줄상세 구조를 실데이터로 확인한 결과:
 *     - "청구 단위" 행 = 세트헤더/단품 (세트명 C == 장비명 D, 또는 C 비어있음)
 *       → 여기에만 실제 단가(L)가 들어있다(예: A7S3 풀세트 80,000).
 *     - "구성품" 행 = 세트에 딸린 물리 장비 (C != D) → 단가는 항상 0.
 *   v1은 장비명(D)으로만 묶어 세트헤더+구성품을 이중 집계 → 매출이 부풀었다.
 *   v2는 매출을 "청구 단위 행(C==D/C빈칸)의 실제 단가"로만 계산 → 중복 없음, 실단가 기준.
 *   물리 장비의 가동/유휴는 별개로 모든 장비명(구성품 포함) 등장 여부로 판정.
 *
 * 데이터(읽기 전용): 스케줄상세(C세트명 D장비명 E수량 F반출일 H반납일 L단가), 장비마스터(D장비명 E보유 L단가 등)
 * 노출: sheetAPI.js action=equipRadar (key 인증, PII 없음). 헤이빌리 /profit.
 */

function getEquipmentProfitRadar(params) {
  params = params || {};
  var limit = Math.min(parseInt(params.limit, 10) || 60, 200);
  var windowDays = Math.min(parseInt(params.windowDays, 10) || 90, 730);

  // ── 결과 캐시: 5년치 풀스캔이 무겁고 이력은 천천히 변함 → 10분 TTL (nocache=1로 우회)
  var skipCache = (params.nocache === '1' || params.nocache === 1);
  var cache = CacheService.getScriptCache();
  var cacheKey = 'equipRadar_v1_' + windowDays + '_' + limit;
  if (!skipCache) {
    var cached = cache.get(cacheKey);
    if (cached) {
      try { return JSON.parse(cached); } catch (e) {}
    }
  }

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
  function fmt(ms) { return ms ? Utilities.formatDate(new Date(ms), tz, 'yyyy-MM-dd') : ''; }

  // ── 장비마스터: 이름 → {name, category, stock, price, status} ──
  var master = {};
  if (em && em.getLastRow() >= 2) {
    var mr = em.getRange(2, 1, em.getLastRow() - 1, 13).getValues();
    for (var i = 0; i < mr.length; i++) {
      var nm = String(mr[i][3] || '').trim();  // D 장비명
      if (!nm) continue;
      var mk = normName(nm);
      if (master[mk]) {
        master[mk].stock += Number(mr[i][4]) || 0;
        master[mk].price = Math.max(master[mk].price, Number(mr[i][11]) || 0);
      } else {
        master[mk] = {
          name: nm, category: String(mr[i][2] || '').trim(),
          stock: Number(mr[i][4]) || 0, price: Number(mr[i][11]) || 0,
          status: String(mr[i][8] || '').trim()
        };
      }
    }
  }

  // ── 스케줄상세 스캔 ──
  var products = {};   // 청구단위(C==D/빈칸) → 매출/횟수  key=normName(장비명)
  var usedWindow = {}; // window 내 등장한 물리 장비명(구성품 포함) → idle 판정용
  var seenAll = {};    // 전체 기간 마지막 대여일 → idle 카드에 "마지막 대여" 표기
  var unbilled = {};   // 청구단위인데 단가 0 → 청구누락 후보
  var totalRevenue = 0;

  var sr = sd.getRange(2, 3, sd.getLastRow() - 1, 10).getValues(); // C..L (실사용 열: C,D,E,F,H,L)
  for (var r = 0; r < sr.length; r++) {
    var setName = String(sr[r][0] || '').trim();  // C 세트명
    var gear = String(sr[r][1] || '').trim();     // D 장비명
    if (!gear) continue;
    var qty = Number(sr[r][2]) || 1;               // E 수량
    var outD = toDate(sr[r][3]);                   // F 반출일
    var retD = toDate(sr[r][5]);                   // H 반납일
    var price = Number(sr[r][9]) || 0;             // L 단가
    if (!outD) continue;
    var outMs = outD.getTime();
    var inWindow = outMs >= windowStart;
    var days = 1;
    if (retD) days = Math.max(1, Math.round((retD.getTime() - outMs) / MS_DAY));
    var gk = normName(gear);

    // 전체/윈도우 사용 기록(물리 장비 가동·유휴 판정) — 청구단위/구성품 무관
    if (outMs > (seenAll[gk] || 0)) seenAll[gk] = outMs;
    if (inWindow) usedWindow[gk] = true;

    // 청구 단위 = 세트명 비었거나 세트명==장비명 (실제 단가를 지닌 행)
    var isBillable = (!setName) || (setName === gear);
    if (isBillable) {
      if (inWindow) {
        var rev = price * days * qty;
        var p = products[gk] || (products[gk] = { name: gear, count: 0, revenue: 0, last: 0, price: 0 });
        p.count++;
        p.revenue += rev;
        if (price > 0) p.price = Math.max(p.price, price);
        if (outMs > p.last) { p.last = outMs; p.name = gear; }
        totalRevenue += rev;
      }
      if (price === 0) {
        var ub = unbilled[gk] || (unbilled[gk] = { name: gear, count: 0, last: 0 });
        ub.count++;
        if (outMs > ub.last) { ub.last = outMs; ub.name = gear; }
      }
    }
  }

  // ── 효자 상품(실매출순) ──
  var earners = [];
  Object.keys(products).forEach(function (k) {
    var p = products[k];
    if (p.count === 0) return;
    var m = master[k];
    earners.push({
      name: p.name,
      category: (m && m.category) || '',
      count: p.count,
      revenue: Math.round(p.revenue),
      avgPerRental: p.count ? Math.round(p.revenue / p.count) : 0,
      price: p.price || 0,
      lastRentedAt: fmt(p.last)
    });
  });
  earners.sort(function (a, b) { return b.revenue - a.revenue || b.count - a.count; });

  // ── 노는 장비: 장비마스터 보유>0, 최근 windowDays일 미대여 ──
  var idle = [], idleForegone = 0;
  Object.keys(master).forEach(function (k) {
    var m = master[k];
    if (m.stock <= 0) return;
    if (/폐기|처분|판매/.test(m.status)) return;
    if (usedWindow[k]) return;   // 최근 나감 → 유휴 아님
    var foregone = m.price * m.stock;   // 다 나가면 하루에 벌 수 있는 금액(놓치는 매출)
    idleForegone += foregone;
    idle.push({
      name: m.name, category: m.category, stock: m.stock, price: m.price,
      foregone: foregone,
      lastRentedAt: fmt(seenAll[k] || 0),
      neverRented: !seenAll[k]
    });
  });
  idle.sort(function (a, b) { return b.foregone - a.foregone || b.price - a.price; });

  // ── 청구 누락 후보: 청구 단위인데 단가 0으로 나감 ──
  var unbilledArr = [];
  Object.keys(unbilled).forEach(function (k) {
    var ub = unbilled[k];
    var m = master[k];
    unbilledArr.push({
      name: ub.name, count: ub.count, lastRentedAt: fmt(ub.last),
      masterPrice: (m && m.price) || 0, inMaster: !!m
    });
  });
  // 마스터 단가가 있는데도 0원으로 나간 건(확실한 누락)을 우선, 그다음 빈도순
  unbilledArr.sort(function (a, b) {
    return (b.masterPrice > 0 ? 1 : 0) - (a.masterPrice > 0 ? 1 : 0) || b.count - a.count;
  });

  var result = {
    ok: true,
    generatedAt: now.toISOString(),
    today: fmt(nowMs),
    windowDays: windowDays,
    stats: {
      revenue: Math.round(totalRevenue),
      productCount: earners.length,
      idleCount: idle.length,
      idleForegonePerDay: Math.round(idleForegone),
      unbilledCount: unbilledArr.length
    },
    earners: earners.slice(0, limit),
    idle: idle.slice(0, limit),
    unbilled: unbilledArr.slice(0, 40)
  };

  // 캐시 저장 — 100KB 초과 등 실패해도 응답은 정상 반환
  try { cache.put(cacheKey, JSON.stringify(result), 600); } catch (cacheErr) {}
  return result;
}
