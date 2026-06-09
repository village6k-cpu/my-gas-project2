/**
 * 빌리지 → Supabase 시트→앱 자동 동기화 (격리·폴트톨러런트).
 * 기존 코드 안 건드림. 편집되면 거래ID만 dirty 표시(즉시) → 1분 트리거가 변경분만 push.
 * 설정: Script Properties 에 SUPABASE_URL, SUPABASE_ANON_KEY 넣고 setupSupabaseSync() 1회 실행.
 */

function SUPA_CFG_() {
  // RLS 잠금 후엔 서비스키(secret)로 RLS 우회. 우선순위: SERVICE_KEY > ANON_KEY > 공개키 기본값.
  // 서비스키는 비밀 → 코드에 두지 말고 initSupabaseConfig()로 Script Property에만 저장.
  var p = PropertiesService.getScriptProperties();
  return {
    url: p.getProperty('SUPABASE_URL') || 'https://tedffwpijiylklfuzkua.supabase.co',
    key: p.getProperty('SUPABASE_SERVICE_KEY') || p.getProperty('SUPABASE_ANON_KEY') || 'sb_publishable_bSfUmM7z0scyXEPEQvIfWQ_Cx7fyuHg'
  };
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
      'Content-Profile': 'village', // village 스키마 지정 (public 아님)
      'Accept-Profile': 'village',
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
  Logger.log('초기 백필 시작…');
  fullSyncToSupabase();
  Logger.log('🎉 전부 완료. 이제 시트 편집하면 ~1분 내 앱에 자동 반영됩니다.');
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

/* ───────────── 스크립트 속성 관리 (속성 50개+ 라 UI 읽기전용일 때 사용) ───────────── */

/**
 * Supabase 서비스키(secret)를 저장(UI 읽기전용 우회 + RLS 잠금 후 동기화용).
 * RLS를 잠그면 publishable 키로는 못 쓰므로 service_role(secret) 키가 필요함.
 * 사용법: Supabase Settings>API Keys의 secret(service_role) 키를 아래 SERVICE_KEY에 붙여넣고 ▶ 실행 → 끝나면 다시 비우세요.
 */
function initSupabaseConfig() {
  var URL = 'https://tedffwpijiylklfuzkua.supabase.co';
  var SERVICE_KEY = ''; // ← Supabase secret(service_role) 키 붙여넣고 실행, 실행 후 다시 '' 로 비우기 (비밀키라 코드에 남기면 안 됨)
  if (!SERVICE_KEY) { Logger.log('⚠️ SERVICE_KEY를 채우고 다시 실행하세요 (Supabase Settings>API의 secret 키)'); return; }
  PropertiesService.getScriptProperties().setProperties({
    SUPABASE_URL: URL,
    SUPABASE_SERVICE_KEY: SERVICE_KEY
  }, false); // false = 기존 속성 유지(삭제 안 함)
  Logger.log('✅ 서비스키 저장 완료. 이제 위 SERVICE_KEY 줄을 다시 비워 저장하세요. (RLS 잠금 후에도 동기화 동작)');
}

/** 진단(읽기전용): 속성이 몇 개인지, 종류별 개수, 보존 대상(설정값) 표시 */
function auditScriptProperties() {
  var all = PropertiesService.getScriptProperties().getProperties();
  var keys = Object.keys(all);
  var cat = {};
  keys.forEach(function (k) {
    var pre = /^(itemCheck|setupDone|setupDoneAt)_/.test(k) ? k.split('_')[0] + '_*' : k;
    cat[pre] = (cat[pre] || 0) + 1;
  });
  Logger.log('총 속성: ' + keys.length + '개');
  Logger.log('── 종류별 ──');
  Object.keys(cat).sort(function (a, b) { return cat[b] - cat[a]; }).forEach(function (pre) {
    if (cat[pre] > 1) Logger.log('  ' + pre + ' : ' + cat[pre] + '개');
  });
  var config = keys.filter(function (k) { return !/^(itemCheck|setupDone|setupDoneAt)_/.test(k); });
  Logger.log('── 설정/기타(보존해야 함) ' + config.length + '개 ──');
  Logger.log('  ' + config.join('\n  '));
}

/**
 * 오래된 거래의 검수상태 속성 정리. itemCheck_/setupDone_/setupDoneAt_ 중
 * 거래ID 날짜(YYMMDD)가 cutoff 이전인 것만 삭제. 설정값(개고생2_URL 등)은 절대 안 건드림.
 * 사용법: 먼저 cleanupOldTradeProps('260401', true) 로 미리보기 → 확인 후 false로 실제 삭제.
 */
function cleanupOldTradeProps(cutoffYYMMDD, dryRun) {
  if (!cutoffYYMMDD || !/^\d{6}$/.test(cutoffYYMMDD)) { Logger.log("⚠️ cutoff를 'YYMMDD'로 주세요. 예: cleanupOldTradeProps('260401', true)"); return; }
  if (dryRun === undefined) dryRun = true;
  var p = PropertiesService.getScriptProperties();
  var all = p.getProperties();
  var toDelete = [];
  Object.keys(all).forEach(function (k) {
    var m = k.match(/^(?:itemCheck|setupDone|setupDoneAt)_(\d{6})-/);
    if (m && m[1] < cutoffYYMMDD) toDelete.push(k);
  });
  Logger.log((dryRun ? '[미리보기] ' : '[실제삭제] ') + cutoffYYMMDD + ' 이전 거래 속성 ' + toDelete.length + '개');
  Logger.log(toDelete.slice(0, 30).join('\n') + (toDelete.length > 30 ? '\n…외 ' + (toDelete.length - 30) + '개' : ''));
  if (!dryRun) {
    toDelete.forEach(function (k) { p.deleteProperty(k); });
    Logger.log('✅ 삭제 완료. 남은 속성: ' + Object.keys(p.getProperties()).length + '개');
  } else {
    Logger.log('→ 실제 삭제하려면 dryRun=false 로: cleanupOldTradeProps(\'' + cutoffYYMMDD + '\', false)');
  }
}
