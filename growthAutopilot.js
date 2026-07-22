/**
 * ====================================================================
 * growthAutopilot.js — 그로스 오토파일럿 (2026-07-12 신규)
 * ====================================================================
 *
 * 목적: 성장 전략의 "매주 반복해야 하는 일"을 사장이 손으로 안 하게 만든다.
 *   버튼 한 번 → 이번 주 할 일이 전부 계산·초안까지 완성돼서 나온다.
 *   1인 운영 + AI 네이티브 사장을 위한 자동/반자동 실행 엔진.
 *
 * 묶는 것(전부 읽기 전용 집계 — 재사용):
 *   - 재방문 레이더(getReactivationRadar): 지금 연락 적기 + 이탈위험 + 개인화 초안
 *   - 장비 수익 레이더(getEquipmentProfitRadar): 청구누락(돈 새는 곳) + 유휴 고가장비
 *   - 주간 KPI: 이번달/지난달 매출·활성고객 (계약마스터/스케줄상세)
 *   - 시즌 액션: 계절성 기반 이번 시기 우선순위
 *   → 우선순위 '이번 주 할 일(todos)'로 자동 조립
 *
 * 발송은 사장이 원탭으로(반자동) — 고객 대상 자동발송은 하지 않는다.
 * 노출: sheetAPI.js action=autopilot (key 인증). 헤이빌리 /autopilot 페이지.
 */

function getGrowthAutopilot(params) {
  params = params || {};

  // ── 결과 캐시: 하위 레이더 2개 + KPI 풀스캔 묶음이라 가장 무거움 → 10분 TTL (nocache=1로 우회)
  var skipCache = (params.nocache === '1' || params.nocache === 1);
  var cache = CacheService.getScriptCache();
  var cacheKey = 'autopilot_v1';
  if (!skipCache) {
    var cached = cache.get(cacheKey);
    if (cached) {
      try { return JSON.parse(cached); } catch (e) {}
    }
  }

  var tz = Session.getScriptTimeZone() || 'Asia/Seoul';
  var now = new Date();
  var todayStr = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  var month = now.getMonth() + 1;

  // ── 1) 재방문 레이더 (엔진 재사용) ──
  var react = { due: [], atRisk: [], stats: {} };
  try {
    var r = getReactivationRadar({ limit: 25 });
    if (r && r.ok) react = r;
  } catch (e) {}

  // ── 2) 장비 수익 레이더 (엔진 재사용) — 청구누락·유휴 ──
  var equip = { unbilled: [], idle: [], stats: {} };
  try {
    var e2 = getEquipmentProfitRadar({ limit: 20 });
    if (e2 && e2.ok) equip = e2;
  } catch (e) {}
  // 청구누락은 "정가 있는데 0원"(확실)만 액션 대상으로
  var sureUnbilled = (equip.unbilled || []).filter(function (u) { return u.masterPrice > 0; });
  var topIdle = (equip.idle || []).slice(0, 6);

  // ── 3) 주간 KPI (계약마스터 월별 활성고객 + 스케줄상세 월 매출) ──
  var kpi = _autopilotKpi_(tz, now);

  // ── 4) 시즌 액션 (5년 계절성 기반) ──
  var season = _autopilotSeason_(month);

  // ── 5) '이번 주 할 일' 자동 조립 (우선순위순) ──
  var todos = [];
  if ((react.due || []).length > 0) {
    todos.push({
      key: 'reactivate', icon: '🎯', priority: 1,
      title: '재방문 적기 고객 ' + react.due.length + '명에게 카톡',
      desc: '지금 연락하면 재대여 확률 높은 고객. 초안까지 준비됨 — 아래에서 원탭 발송.',
      count: react.due.length, action: '발송'
    });
  }
  if ((react.atRisk || []).length > 0) {
    todos.push({
      key: 'atrisk', icon: '⚠️', priority: 2,
      title: '이탈위험 단골 ' + react.atRisk.length + '명 안부 연락',
      desc: '잘 오던 단골이 평소 주기의 2.5배 넘게 안 왔음. 이탈 전에 붙잡기.',
      count: react.atRisk.length, action: '발송'
    });
  }
  if (sureUnbilled.length > 0) {
    todos.push({
      key: 'unbilled', icon: '💸', priority: 3,
      title: '청구누락 의심 ' + sureUnbilled.length + '건 점검',
      desc: '정가가 있는 장비가 0원으로 나갔음 — 새는 매출. 계약 확인.',
      count: sureUnbilled.length, action: '점검'
    });
  }
  if (topIdle.length > 0) {
    var idleWon = topIdle.reduce(function (s, x) { return s + (x.foregone || 0); }, 0);
    todos.push({
      key: 'idle', icon: '📦', priority: 4,
      title: '노는 고가장비 ' + topIdle.length + '종 굴리기',
      desc: '최근 미대여 = 하루 약 ' + Math.round(idleWon).toLocaleString() + '원 놓치는 중. 세트 끼워팔기·이번 주 프로모.',
      count: topIdle.length, action: '프로모'
    });
  }
  todos.push({
    key: 'season', icon: season.icon, priority: 5,
    title: season.title, desc: season.desc, count: 0, action: '준비'
  });

  var result = {
    ok: true,
    generatedAt: now.toISOString(),
    today: todayStr,
    weekOf: _weekLabel_(tz, now),
    kpi: kpi,
    season: season,
    todos: todos,
    reactivation: { due: react.due || [], atRisk: react.atRisk || [], stats: react.stats || {} },
    billing: { unbilled: sureUnbilled, idle: topIdle, stats: equip.stats || {} },
    summary: {
      dueNow: (react.due || []).length,
      atRisk: (react.atRisk || []).length,
      unbilled: sureUnbilled.length,
      idle: topIdle.length,
      actionsThisWeek: todos.length
    }
  };

  // 캐시 저장 — 100KB 초과 등 실패해도 응답은 정상 반환
  try { cache.put(cacheKey, JSON.stringify(result), 600); } catch (cacheErr) {}
  return result;
}

function _autopilotKpi_(tz, now, preloaded) {
  preloaded = preloaded || {};   // 선택 인자 { cmRows, sdRows }: 미리 읽은 시트 데이터 재사용 (기본 = 기존처럼 직접 읽음)
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var MS_DAY = 86400000;
  var thisMonth = Utilities.formatDate(now, tz, 'yyyy-MM');
  var lastMonthD = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  var lastMonth = Utilities.formatDate(lastMonthD, tz, 'yyyy-MM');

  // 계약마스터: 월별 고유고객 + 거래건수
  var custThis = {}, custLast = {}, txThis = 0, txLast = 0;
  var rows = preloaded.cmRows;
  if (!rows) {
    var cm = ss.getSheetByName('계약마스터');
    rows = (cm && cm.getLastRow() >= 2) ? cm.getRange(2, 1, cm.getLastRow() - 1, 6).getValues() : [];
  }
  for (var i = 0; i < rows.length; i++) {
    var nm = String(rows[i][1] || '').trim();
    var out = rows[i][4];
    var ym = (out instanceof Date) ? Utilities.formatDate(out, tz, 'yyyy-MM') : String(out || '').slice(0, 7);
    if (ym === thisMonth) { txThis++; if (nm) custThis[nm] = true; }
    else if (ym === lastMonth) { txLast++; if (nm) custLast[nm] = true; }
  }
  // 스케줄상세: 월 매출(청구단위 실단가×일수) — 한 번만 읽어서 이번달/지난달 계산에 재사용 (기존: 월마다 풀리드 2회)
  var sdRows = preloaded.sdRows || _autopilotSdRows_(ss);
  var revThis = _autopilotMonthRevenue_(ss, tz, thisMonth, sdRows);
  var revLast = _autopilotMonthRevenue_(ss, tz, lastMonth, sdRows);

  return {
    thisMonth: thisMonth, lastMonth: lastMonth,
    revenueThisMonth: revThis, revenueLastMonth: revLast,
    activeThisMonth: Object.keys(custThis).length, activeLastMonth: Object.keys(custLast).length,
    txThisMonth: txThis, txLastMonth: txLast
  };
}

function _autopilotSdRows_(ss) {
  // 스케줄상세 C..L 행 읽기 (월 매출 계산용 공용 리더)
  var sd = ss.getSheetByName('스케줄상세');
  if (!sd || sd.getLastRow() < 2) return [];
  return sd.getRange(2, 3, sd.getLastRow() - 1, 10).getValues(); // C..L
}

function _autopilotMonthRevenue_(ss, tz, ym, preloadedRows) {
  var rows = preloadedRows || _autopilotSdRows_(ss); // 선택 인자: 미리 읽은 C..L 행 재사용 (기본 = 기존처럼 직접 읽음)
  var total = 0;
  var MS_DAY = 86400000;
  for (var i = 0; i < rows.length; i++) {
    var setn = String(rows[i][0] || '').trim();   // C 세트명
    var gear = String(rows[i][1] || '').trim();    // D 장비명
    if (!gear) continue;
    if (!((!setn) || setn === gear)) continue;     // billable only
    var out = rows[i][3];                            // F 반출일
    var ymRow = (out instanceof Date) ? Utilities.formatDate(out, tz, 'yyyy-MM') : String(out || '').slice(0, 7);
    if (ymRow !== ym) continue;
    var price = Number(rows[i][9]) || 0;            // L 단가
    var qty = Number(rows[i][2]) || 1;              // E 수량
    var days = 1;
    var ret = rows[i][5];                            // H 반납일
    if (out instanceof Date && ret instanceof Date) days = Math.max(1, Math.round((ret.getTime() - out.getTime()) / MS_DAY));
    total += price * qty * days;
  }
  return Math.round(total);
}

function _autopilotSeason_(month) {
  // 5년 실측 계절성 기반 시즌 액션
  if (month === 11 || month === 10) return { icon: '🔥', tag: '연중 최고', title: '연중 최대 성수기 총력전', desc: '11월이 5년 연중 최고. 재고·인력·광고 총동원. 공연·팬사인회·직캠·연말 촬영.' };
  if (month === 9) return { icon: '📈', tag: '성수기 대비', title: '11월 성수기 준비 시작', desc: '9월부터 준비 끝나 있어야. 인기 6종 안전재고 확보, 부라노·FX6 풀세트 프로 캠페인.' };
  if (month === 8) return { icon: '🎬', tag: '가을 진입', title: '8월 성수기 + 가을 진입', desc: '8월은 5년 3번째로 높음. 학생 방학 단편·개인작 + 신학기 2차 학생 유입.' };
  if (month === 6 || month === 7) return { icon: '🎓', tag: '학생 방학', title: '학생 방학 프로젝트 공략', desc: '방학 = 단편·개인작 폭증. 학교 커뮤니티(에타) 침투 + 장기할인 밀기.' };
  if (month === 5) return { icon: '🌸', tag: '봄 성수기', title: '봄 촬영 성수기', desc: '봄 촬영·대학축제·웨딩스냅 피크. 재고 사전확충, 광고 화력 집중.' };
  if (month >= 1 && month <= 4) return { icon: '🌱', tag: '비수기·씨뿌리기', title: '비수기 — 콘텐츠·재활성 축적', desc: '4월이 5년 최저. 광고 줄이고 릴스·후기 쌓고 휴면 재활성 집중해서 성수기에 터뜨리기.' };
  return { icon: '🎁', tag: '연말·감사제', title: '연말 감사제 + 단골 리워드', desc: '한 해 단골 감사 쿠폰 + 내년 재방문 예약. 미수 정리·정산.' };
}

function _weekLabel_(tz, now) {
  var MS_DAY = 86400000;
  var day = now.getDay(); // 0=일
  var mon = new Date(now.getTime() - ((day + 6) % 7) * MS_DAY);
  return Utilities.formatDate(mon, tz, 'M/d') + ' 주간';
}

/**
 * 완전 자동 리마인더: 매주 시스템이 스스로 오토파일럿을 계산해 슬랙으로 다이제스트를 쏜다.
 * 사장은 슬랙 하나 보고 → 헤이빌리 /autopilot에서 원탭 발송. (고객 대상 자동발송은 안 함)
 * Slack Incoming Webhook URL을 Script Property 'GROWTH_SLACK_WEBHOOK'에 넣어두면 동작.
 * 미설정 시 조용히 skip(안전).
 */
function runGrowthAutopilotWeekly() {
  var pack;
  try { pack = getGrowthAutopilot({ nocache: '1' }); } catch (e) { Logger.log('오토파일럿 계산 실패: ' + e); return; }  // 주간 발송은 항상 최신 계산
  if (!pack || !pack.ok) { Logger.log('오토파일럿 결과 없음'); return; }

  var webhook = PropertiesService.getScriptProperties().getProperty('GROWTH_SLACK_WEBHOOK');
  var appUrl = PropertiesService.getScriptProperties().getProperty('HEYVILLY_AUTOPILOT_URL') || '';
  var s = pack.summary;
  var due3 = (pack.reactivation.due || []).slice(0, 3).map(function (d) { return '• ' + d.name + ' (' + d.count + '회, ' + d.daysSince + '일 전)'; }).join('\n');

  var lines = [];
  lines.push('🚀 *이번 주 그로스 오토파일럿* (' + pack.weekOf + ')');
  lines.push('이번달 매출 ' + _kwon_(pack.kpi.revenueThisMonth) + ' · 활성고객 ' + pack.kpi.activeThisMonth + '명');
  lines.push('');
  lines.push('*이번 주 할 일 ' + s.actionsThisWeek + '개*');
  lines.push('🎯 재방문 적기 ' + s.dueNow + '명  ⚠️ 이탈위험 ' + s.atRisk + '명  💸 청구누락 ' + s.unbilled + '건  📦 유휴 ' + s.idle + '종');
  if (due3) { lines.push(''); lines.push('*지금 연락 적기 Top3*'); lines.push(due3); }
  lines.push('');
  lines.push('👉 헤이빌리 → *오토파일럿*에서 원탭 발송' + (appUrl ? (' : ' + appUrl) : ''));

  if (!webhook) { Logger.log('GROWTH_SLACK_WEBHOOK 미설정 — 슬랙 발송 skip. 계산은 완료:\n' + lines.join('\n')); return; }
  try {
    UrlFetchApp.fetch(webhook, {
      method: 'post', contentType: 'application/json',
      payload: JSON.stringify({ text: lines.join('\n') }), muteHttpExceptions: true
    });
    Logger.log('오토파일럿 슬랙 발송 완료');
  } catch (e) { Logger.log('슬랙 발송 실패: ' + e); }
}

function _kwon_(n) {
  n = Math.round(n || 0);
  if (n >= 100000000) return '₩' + (n / 100000000).toFixed(1) + '억';
  if (n >= 10000) return '₩' + Math.round(n / 10000).toLocaleString() + '만';
  return '₩' + n.toLocaleString();
}

/** 1회 실행: 매주 월요일 오전 9시 오토파일럿 자동 발송 트리거 설치. */
function setupGrowthAutopilotWeekly() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'runGrowthAutopilotWeekly') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runGrowthAutopilotWeekly').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(9).create();
  return '✅ 매주 월요일 9시 오토파일럿 자동 리마인더 설치 완료 (슬랙 발송하려면 Script Property GROWTH_SLACK_WEBHOOK 설정)';
}
