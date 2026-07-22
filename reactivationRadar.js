/**
 * ====================================================================
 * reactivationRadar.js — 재방문 레이더 (2026-07-12 신규)
 * ====================================================================
 *
 * 목적: 렌탈샵 최대 수익 레버 = 재방문. 5년치 계약 이력에서
 *   "지금 연락하면 재대여 가능성이 높은 고객"을 자동 산출한다.
 *
 * 데이터 소스(전부 읽기 전용):
 *   - 계약마스터: A거래ID B예약자명 C연락처 E반출일 G반납일 J계약상태 K할인유형
 *   - 스케줄상세: B거래ID C세트명 D장비명 L단가  → 거래별 금액·대표장비
 *
 * 방식: 고객별 RFM(최근성·빈도·금액) + 개인 대여 주기(중앙값) 계산 →
 *   자기 주기에 도달/근접했고 아직 활성 예약이 없는 고객을 우선순위로 정렬.
 *   각 고객에게 개인화된 카톡 메시지 초안까지 만들어 준다(발송은 사장이 직접).
 *
 * 노출: sheetAPI.js `action=radar` (key 인증). 헤이빌리 /radar 페이지가
 *   로그인된 /api/gas 프록시로 호출한다.
 */

function getReactivationRadar(params) {
  params = params || {};
  var limit = Math.min(parseInt(params.limit, 10) || 40, 100);

  // ── 결과 캐시: 5년치 계약 이력 집계라 천천히 변함 → 15분 TTL (nocache=1로 우회)
  var skipCache = (params.nocache === '1' || params.nocache === 1);
  var cache = CacheService.getScriptCache();
  var cacheKey = 'reactRadar_v1_' + limit;
  if (!skipCache) {
    var cached = cache.get(cacheKey);
    if (cached) {
      try { return JSON.parse(cached); } catch (e) {}
    }
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var cm = ss.getSheetByName('계약마스터');
  var sd = ss.getSheetByName('스케줄상세');
  if (!cm || cm.getLastRow() < 2) return { ok: false, error: '계약마스터 데이터 없음' };

  var tz = Session.getScriptTimeZone() || 'Asia/Seoul';
  var now = new Date();
  var nowMs = now.getTime();
  var todayStr = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  var MS_DAY = 86400000;

  // ── 1) 스케줄상세 → 거래ID별 총액·대표장비 ──
  var tradeAmount = {}, tradeGear = {};
  if (sd && sd.getLastRow() >= 2) {
    var sdata = sd.getRange(2, 1, sd.getLastRow() - 1, 13).getValues();
    for (var i = 0; i < sdata.length; i++) {
      var stid = String(sdata[i][1] || '').trim();
      if (!stid) continue;
      var price = Number(sdata[i][11]) || 0;
      tradeAmount[stid] = (tradeAmount[stid] || 0) + price;
      var gear = String(sdata[i][2] || '').trim() || String(sdata[i][3] || '').trim();
      if (gear) {
        if (!tradeGear[stid] || price > tradeGear[stid].price) tradeGear[stid] = { name: gear, price: price };
      }
    }
  }

  // ── 2) 계약마스터 → 고객별 집계 ──
  var rows = cm.getRange(2, 1, cm.getLastRow() - 1, 11).getValues();
  var byCust = {};
  for (var r = 0; r < rows.length; r++) {
    var tid = String(rows[r][0] || '').trim();
    var name = String(rows[r][1] || '').trim();
    var phone = String(rows[r][2] || '').trim();
    var status = String(rows[r][9] || '').trim();
    var discount = String(rows[r][10] || '').trim();
    if (!name && !phone) continue;
    if (/취소/.test(status)) continue;               // 취소 건 제외
    var outD = _radarToDate_(rows[r][4]);
    var retD = _radarToDate_(rows[r][6]) || outD;
    var key = _radarPhoneKey_(phone) || ('name:' + name);
    var c = byCust[key];
    if (!c) c = byCust[key] = { name: name, phone: phone, count: 0, outs: [], rets: [], revenue: 0, gears: {}, discount: '' };
    if (name) c.name = name;
    if (phone) c.phone = phone;
    if (discount) c.discount = discount;
    c.count++;
    if (outD) c.outs.push(outD.getTime());
    if (retD) c.rets.push(retD.getTime());
    c.revenue += (tradeAmount[tid] || 0);
    var g = tradeGear[tid];
    if (g && g.name) c.gears[g.name] = (c.gears[g.name] || 0) + 1;
  }

  // ── 3) 지표 + 랭킹 ──
  var due = [], atRisk = [], repeatTotal = 0;
  for (var k in byCust) {
    var cust = byCust[k];
    if (cust.count < 2) continue;                    // 재방문 이력이 있는 고객만
    repeatTotal++;
    cust.outs.sort(function (a, b) { return a - b; });
    var lastOut = cust.outs.length ? cust.outs[cust.outs.length - 1] : 0;
    var lastRet = cust.rets.length ? Math.max.apply(null, cust.rets) : lastOut;
    if (!lastRet) continue;
    if (lastRet >= nowMs - MS_DAY) continue;         // 현재 활성/예정 반납 → 제외

    var gaps = [];
    for (var gi = 1; gi < cust.outs.length; gi++) gaps.push((cust.outs[gi] - cust.outs[gi - 1]) / MS_DAY);
    gaps.sort(function (a, b) { return a - b; });
    var interval = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 45;   // 개인 주기(중앙값)
    if (!interval || interval < 7) interval = 30;

    var daysSince = Math.round((nowMs - lastRet) / MS_DAY);
    if (daysSince < interval * 0.7) continue;         // 아직 이른 고객 제외
    if (daysSince > 900) continue;                    // 2.5년 초과 = 사실상 이탈, 소음 제외

    var favGear = Object.keys(cust.gears).sort(function (a, b) { return cust.gears[b] - cust.gears[a]; }).slice(0, 2);
    var avgRevenue = cust.count ? Math.round(cust.revenue / cust.count) : 0;
    var overdue = daysSince / interval;               // 1 ≈ 딱 그 주기

    var freqScore = Math.min(cust.count, 10);
    var timingScore = overdue <= 2.5 ? (1.5 - Math.abs(1 - overdue) * 0.4) : 0.5;
    var moneyScore = avgRevenue > 0 ? Math.min(avgRevenue / 100000, 3) : 0.5;
    var priority = Math.round((freqScore * 2 + timingScore * 3 + moneyScore) * 10) / 10;

    var rec = {
      name: cust.name,
      phone: cust.phone,
      count: cust.count,
      daysSince: daysSince,
      intervalDays: Math.round(interval),
      totalRevenue: cust.revenue,
      avgRevenue: avgRevenue,
      favGear: favGear,
      discount: cust.discount,
      priority: priority,
      lastRentedAt: Utilities.formatDate(new Date(lastRet), tz, 'yyyy-MM-dd'),
      reason: _radarReason_(cust.count, daysSince, Math.round(interval), favGear, overdue),
      draft: _radarDraft_(cust.name, favGear, cust.discount)
    };

    if (cust.count >= 4 && overdue > 2.5) atRisk.push(rec);   // 단골인데 오래 안 옴 = 이탈 위험
    else if (overdue <= 2.5) due.push(rec);                    // 재방문 적기
  }

  due.sort(function (a, b) { return b.priority - a.priority; });
  atRisk.sort(function (a, b) { return (b.count - a.count) || (b.totalRevenue - a.totalRevenue); });
  var dueTop = due.slice(0, limit);
  var opportunity = dueTop.reduce(function (s, x) { return s + (x.avgRevenue || 0); }, 0);

  var result = {
    ok: true,
    generatedAt: now.toISOString(),
    today: todayStr,
    stats: {
      totalRepeatCustomers: repeatTotal,
      dueNow: due.length,
      atRisk: atRisk.length,
      opportunityAmount: opportunity
    },
    due: dueTop,
    atRisk: atRisk.slice(0, 20)
  };

  // 캐시 저장 — 100KB 초과 등 실패해도 응답은 정상 반환
  try { cache.put(cacheKey, JSON.stringify(result), 900); } catch (cacheErr) {}
  return result;
}

function _radarToDate_(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  var d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function _radarPhoneKey_(p) {
  var digits = String(p || '').replace(/\D/g, '');
  if (digits.length < 9) return '';
  return digits.slice(-10);
}

function _radarReason_(count, daysSince, interval, favGear, overdue) {
  var gearTxt = (favGear && favGear[0]) ? favGear[0] : '장비';
  if (overdue > 1.8) {
    return count + '회 단골인데 평소 주기(' + interval + '일)의 ' + (Math.round(overdue * 10) / 10) + '배(' + daysSince + '일)째 미방문 — 이탈 전 재접촉 권장';
  }
  if (overdue >= 0.9 && overdue <= 1.3) {
    return count + '회 대여, 평소 ' + interval + '일 주기인데 마지막 반납 후 ' + daysSince + '일 — 지금이 재대여 적기 (' + gearTxt + ' 선호)';
  }
  return count + '회 대여 고객, 마지막 반납 ' + daysSince + '일 전 — 슬슬 다음 촬영 타이밍';
}

function _radarDraft_(name, favGear, discount) {
  var nm = name || '고객';
  var gear = (favGear && favGear[0]) ? favGear[0] : '';
  var lead = '안녕하세요 ' + nm + '님, 카메라렌탈 빌리지입니다 :)';
  var body = gear
    ? ' 지난번 ' + gear + ' 대여 잘 사용하셨어요? 요즘 촬영 준비 있으시면 편하게 문의 주세요.'
    : ' 잘 지내시죠? 촬영 준비 있으시면 편하게 문의 주세요.';
  var perk = /단골|제휴|VIP/.test(discount || '')
    ? ' 단골 고객님 감사 혜택도 챙겨드리겠습니다!'
    : ' 필요하신 장비 미리 잡아드릴게요!';
  return lead + body + perk;
}
