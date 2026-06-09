/**
 * 빌리지 → Supabase 시트→앱 자동 동기화 (격리·폴트톨러런트).
 * 기존 코드 안 건드림. 편집되면 거래ID만 dirty 표시(즉시) → 1분 트리거가 변경분만 push.
 * 설정: Script Properties 에 SUPABASE_URL, SUPABASE_ANON_KEY 넣고 setupSupabaseSync() 1회 실행.
 */

function SUPA_CFG_() {
  var p = PropertiesService.getScriptProperties();
  return { url: p.getProperty('SUPABASE_URL'), key: p.getProperty('SUPABASE_ANON_KEY') };
}

/** 설치형 onEdit (별도 트리거) — 편집된 거래ID만 dirty 목록에 표시. 절대 편집을 막지 않음. */
function onEditSupabaseMark(e) {
  try {
    if (!e || !e.range) return;
    var sheet = e.range.getSheet();
    var name = sheet.getName();
    var col = name === '계약마스터' ? 1 : name === '스케줄상세' ? 2 : 0; // 거래ID 열
    if (!col) return;
    var tid = sheet.getRange(e.range.getRow(), col).getValue();
    if (!tid) return;
    var p = PropertiesService.getScriptProperties();
    var dirty = {};
    try { dirty = JSON.parse(p.getProperty('SUPA_DIRTY') || '{}'); } catch (x) {}
    dirty[String(tid)] = 1;
    p.setProperty('SUPA_DIRTY', JSON.stringify(dirty));
  } catch (err) {
    // 편집 경로는 무조건 보호 — 에러 삼킴
  }
}

/** 1분 트리거 — dirty 거래들을 빌드해 Supabase upsert 후 클리어. */
function flushDirtyToSupabase() {
  var cfg = SUPA_CFG_();
  if (!cfg.url || !cfg.key) { Logger.log('Supabase 설정 없음'); return; }
  var p = PropertiesService.getScriptProperties();
  var dirty = {};
  try { dirty = JSON.parse(p.getProperty('SUPA_DIRTY') || '{}'); } catch (x) {}
  var tids = Object.keys(dirty);
  if (!tids.length) return;
  // 동시성: 잠금
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    var built = buildSupabaseTrades_(tids);
    if (built.trades.length) {
      supaUpsert_(cfg, 'trades', built.trades, 'trade_id');
      if (built.items.length) supaUpsert_(cfg, 'schedule_items', built.items, 'schedule_id');
    }
    // 처리된 것만 제거(처리 중 새로 들어온 건 유지)
    var after = {};
    try { after = JSON.parse(p.getProperty('SUPA_DIRTY') || '{}'); } catch (x) {}
    for (var i = 0; i < tids.length; i++) delete after[tids[i]];
    p.setProperty('SUPA_DIRTY', JSON.stringify(after));
    Logger.log('Supabase push: ' + built.trades.length + '건');
  } catch (err) {
    Logger.log('flushDirty 오류: ' + err);
  } finally {
    lock.releaseLock();
  }
}

/** 거래ID 배열 → Supabase 행({trades, items}). 날짜는 timeline(보정됨), 상세는 dashboard에서. */
function buildSupabaseTrades_(tids) {
  var want = {};
  for (var i = 0; i < tids.length; i++) want[String(tids[i])] = true;

  // 1) 날짜·예약 골격: 넓은 윈도우 timeline (보정된 epoch ms)
  var today = new Date();
  var fromKey = Utilities.formatDate(new Date(today.getTime() - 14 * 86400000), 'Asia/Seoul', 'yyyy-MM-dd');
  var toKey = Utilities.formatDate(new Date(today.getTime() + 60 * 86400000), 'Asia/Seoul', 'yyyy-MM-dd');
  var tl = getTimelineData({ from: fromKey, to: toKey, compact: 2 });
  var groups = {};
  (tl.groups || []).forEach(function (g) { groups[g.i] = g.c; });
  var dates = {}; // tid -> {start, end}
  (tl.items || []).forEach(function (it) {
    if (!want[it.tid]) return;
    var s = typeof it.s === 'number' ? it.s : new Date(it.s).getTime();
    var e = typeof it.e === 'number' ? it.e : new Date(it.e).getTime();
    if (!dates[it.tid]) dates[it.tid] = { start: s, end: e };
    else { if (s < dates[it.tid].start) dates[it.tid].start = s; if (e > dates[it.tid].end) dates[it.tid].end = e; }
  });

  // 2) 상세(검수·결제·장비): 관련 날짜의 dashboard
  var dateSet = {};
  for (var tid in dates) {
    dateSet[Utilities.formatDate(new Date(dates[tid].start), 'Asia/Seoul', 'yyyy-MM-dd')] = true;
  }
  var detail = {}; // tid -> dashboard item
  for (var dk in dateSet) {
    var dd;
    try { dd = getDashboardData(dk, true, {}); } catch (x) { continue; }
    (dd.checkout || []).concat(dd.checkin || []).forEach(function (t) {
      if (want[t.tradeId] && !detail[t.tradeId]) detail[t.tradeId] = t;
    });
  }

  var trades = [], items = [];
  for (var tid2 in dates) {
    var d = detail[tid2] || {};
    var startISO = new Date(dates[tid2].start).toISOString();
    var endISO = new Date(dates[tid2].end).toISOString();
    trades.push({
      trade_id: tid2,
      customer_name: d.name || '',
      customer_phone: d.tel || null,
      company: d.company || null,
      checkout_at: startISO,
      return_at: endISO,
      contract_status: d.contractStatus || '예약',
      setup_done: !!d.setupDone,
      setup_done_at: d.setupDoneAt || null,
      return_done: !!d.returnDone,
      return_done_at: d.returnDoneAt || null,
      payment_method: d.paymentMethod || null,
      payment_warning: !!d.paymentWarning,
      deposit_status: d.depositStatus || null,
      proof_type: d.proofType || null,
      issue_status: d.issueStatus || null,
      billing_company: d.billingCompany || null,
      contract_url: d.contractUrl || null,
      contract_regen_pending: !!d.contractRegenPending,
      note_checkin: d.returnMemo || null
    });
    var eqs = d.equipments || [];
    for (var k = 0; k < eqs.length; k++) {
      var e2 = eqs[k];
      items.push({
        schedule_id: e2.scheduleId,
        trade_id: tid2,
        sort: k,
        name: e2.name,
        qty: Number(e2.qty) || 1,
        set_name: e2.setName || null,
        is_set_header: !!e2.isHeader,
        is_component: !!e2.isComponent,
        checkout_state: e2.checkedCheckout ? 'taken' : 'pending'
      });
    }
  }
  return { trades: trades, items: items };
}

/** Supabase REST 벌크 upsert (anon 키, merge-duplicates). */
function supaUpsert_(cfg, table, rows, conflict) {
  if (!rows.length) return;
  var res = UrlFetchApp.fetch(cfg.url + '/rest/v1/' + table + '?on_conflict=' + conflict, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      apikey: cfg.key,
      Authorization: 'Bearer ' + cfg.key,
      Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    payload: JSON.stringify(rows),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code >= 300) Logger.log('Supabase ' + table + ' upsert 실패 ' + code + ': ' + res.getContentText().slice(0, 200));
}

/** 트리거 설치 (1회 실행). 기존 트리거 중복 방지. */
function setupSupabaseSync() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    var fn = triggers[i].getHandlerFunction();
    if (fn === 'onEditSupabaseMark' || fn === 'flushDirtyToSupabase') ScriptApp.deleteTrigger(triggers[i]);
  }
  ScriptApp.newTrigger('onEditSupabaseMark').forSpreadsheet(SpreadsheetApp.getActive()).onEdit().create();
  ScriptApp.newTrigger('flushDirtyToSupabase').timeBased().everyMinutes(1).create();
  Logger.log('✅ Supabase 동기화 트리거 설치 완료 (onEdit 표시 + 1분 flush)');
}

/** 수동 전체 동기화(초기 1회용): 활성 윈도우 거래 전부 push. */
function fullSyncToSupabase() {
  var today = new Date();
  var fromKey = Utilities.formatDate(new Date(today.getTime() - 7 * 86400000), 'Asia/Seoul', 'yyyy-MM-dd');
  var toKey = Utilities.formatDate(new Date(today.getTime() + 30 * 86400000), 'Asia/Seoul', 'yyyy-MM-dd');
  var tl = getTimelineData({ from: fromKey, to: toKey, compact: 2 });
  var tids = {};
  (tl.items || []).forEach(function (it) { if (it.tid) tids[it.tid] = 1; });
  var cfg = SUPA_CFG_();
  if (!cfg.url || !cfg.key) { Logger.log('Supabase 설정 없음'); return; }
  var built = buildSupabaseTrades_(Object.keys(tids));
  supaUpsert_(cfg, 'trades', built.trades, 'trade_id');
  supaUpsert_(cfg, 'schedule_items', built.items, 'schedule_id');
  Logger.log('전체 동기화: ' + built.trades.length + '건');
}
