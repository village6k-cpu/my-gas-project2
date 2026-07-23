/**
 * 빌리지 → Supabase 시트→앱 자동 동기화 (격리·폴트톨러런트).
 * 기존 코드 안 건드림. 편집되면 거래ID만 dirty 표시(즉시) → 1분 트리거가 변경분만 push.
 * 설정: Script Properties 에 SUPABASE_URL, SUPABASE_ANON_KEY 넣고 setupSupabaseSync() 1회 실행.
 */

function SUPA_CFG_() {
  // 봇 계정 로그인 방식: publishable 키(apikey, 공개·차단없음) + 봇 user JWT(Authorization).
  // secret/service 키는 GAS(브라우저로 오인)에서 전부 차단되므로 안 씀.
  var p = PropertiesService.getScriptProperties();
  return {
    url: p.getProperty('SUPABASE_URL') || 'https://tedffwpijiylklfuzkua.supabase.co',
    apikey: p.getProperty('SUPABASE_ANON_KEY') || 'sb_publishable_bSfUmM7z0scyXEPEQvIfWQ_Cx7fyuHg',
    botEmail: p.getProperty('SUPABASE_BOT_EMAIL'),
    botPassword: p.getProperty('SUPABASE_BOT_PASSWORD')
  };
}

// 봇 계정으로 로그인해 access_token 획득 (캐시 + 만료 시 재로그인). user JWT라 secret-키 차단에 안 걸림.
function supaToken_(cfg) {
  var p = PropertiesService.getScriptProperties();
  var cached = p.getProperty('SUPA_TOKEN');
  var exp = Number(p.getProperty('SUPA_TOKEN_EXP') || 0);
  if (cached && Date.now() < exp - 60000) return cached;
  if (!cfg.botEmail || !cfg.botPassword) { Logger.log('봇 계정 미설정 — initSupabaseConfig 실행 필요'); return null; }
  var res = UrlFetchApp.fetch(cfg.url + '/auth/v1/token?grant_type=password', {
    method: 'post',
    contentType: 'application/json',
    headers: { apikey: cfg.apikey },
    payload: JSON.stringify({ email: cfg.botEmail, password: cfg.botPassword }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) { Logger.log('봇 로그인 실패: ' + res.getContentText().slice(0, 200)); return null; }
  var j = JSON.parse(res.getContentText());
  p.setProperty('SUPA_TOKEN', j.access_token);
  p.setProperty('SUPA_TOKEN_EXP', String(Date.now() + ((j.expires_in || 3600) * 1000)));
  return j.access_token;
}

/** 설치형 onEdit (별도 트리거) — 편집된 거래ID만 dirty 목록에 표시. 절대 편집을 막지 않음. */
function onEditSupabaseMark(e) {
  try {
    if (!e || !e.range) return;
    var sheet = e.range.getSheet();
    var name = sheet.getName();
    var col = name === '계약마스터' ? 1 : name === '스케줄상세' ? 2 : 0; // 거래ID 열
    if (!col) return;
    // 다중 행 붙여넣기/드래그 채우기도 전부 마킹 (기존엔 첫 행만)
    var startRow = e.range.getRow();
    var numRows = Math.min(e.range.getNumRows(), 200);
    var tidValues = sheet.getRange(startRow, col, numRows, 1).getValues();
    for (var ri = 0; ri < tidValues.length; ri++) {
      if (tidValues[ri][0]) supaMarkTradeDirty_(tidValues[ri][0]);
    }
  } catch (err) {
    // 편집 경로는 무조건 보호 — 에러 삼킴
  }
}

/**
 * 거래 완전 삭제용 — Supabase village.schedule_items + village.trades 행을 제거한다.
 * 시트 삭제(deleteTrade)와 짝. 자식(schedule_items) 먼저, 부모(trades) 나중 삭제.
 */
function supaDeleteTrade_(tid) {
  tid = String(tid || '').trim();
  if (!tid) return { ok: false, error: 'tid 없음' };
  var cfg = SUPA_CFG_();
  var token = supaToken_(cfg);
  if (!token) return { ok: false, error: '봇 토큰 없음' };
  var headers = {
    apikey: cfg.apikey,
    Authorization: 'Bearer ' + token,
    'Content-Profile': 'village',
    'Accept-Profile': 'village',
    Prefer: 'return=minimal'
  };
  var filt = '?trade_id=eq.' + encodeURIComponent(tid);
  var rItems = UrlFetchApp.fetch(cfg.url + '/rest/v1/schedule_items' + filt, { method: 'delete', headers: headers, muteHttpExceptions: true });
  var rTrade = UrlFetchApp.fetch(cfg.url + '/rest/v1/trades' + filt, { method: 'delete', headers: headers, muteHttpExceptions: true });
  var ci = rItems.getResponseCode(), ct = rTrade.getResponseCode();
  var ok = ci < 300 && ct < 300;
  if (!ok) Logger.log('supaDeleteTrade_ 실패 items=' + ci + ' trade=' + ct + ' : ' +
    rItems.getContentText().slice(0, 150) + ' / ' + rTrade.getContentText().slice(0, 150));
  return { ok: ok, items: ci, trade: ct };
}

/**
 * 계약 취소용 — 거래 기록은 남기고 일정 점유(schedule_items)만 제거한 뒤 상태를 취소로 남긴다.
 * 계약마스터 취소와 같은 요청 안에서 실행해 1분 동기화 전에도 앱 재고 점유가 즉시 사라지게 한다.
 */
function supaCancelTrade_(tid) {
  tid = String(tid || '').trim();
  if (!tid) return { ok: false, error: 'tid 없음' };
  var cfg = SUPA_CFG_();
  var token = supaToken_(cfg);
  if (!token) return { ok: false, error: '봇 토큰 없음' };
  var headers = {
    apikey: cfg.apikey,
    Authorization: 'Bearer ' + token,
    'Content-Profile': 'village',
    'Accept-Profile': 'village',
    Prefer: 'return=minimal'
  };
  var filt = '?trade_id=eq.' + encodeURIComponent(tid);
  var rItems = UrlFetchApp.fetch(cfg.url + '/rest/v1/schedule_items' + filt, {
    method: 'delete',
    headers: headers,
    muteHttpExceptions: true
  });
  var rTrade = UrlFetchApp.fetch(cfg.url + '/rest/v1/trades' + filt, {
    method: 'patch',
    contentType: 'application/json',
    headers: headers,
    payload: JSON.stringify({ contract_status: '취소', contract_url: null }),
    muteHttpExceptions: true
  });
  var ci = rItems.getResponseCode(), ct = rTrade.getResponseCode();
  var ok = ci < 300 && ct < 300;
  if (!ok) Logger.log('supaCancelTrade_ 실패 items=' + ci + ' trade=' + ct + ' : ' +
    rItems.getContentText().slice(0, 150) + ' / ' + rTrade.getContentText().slice(0, 150));
  return { ok: ok, items: ci, trade: ct };
}

/**
 * 반출 기준선 행은 감사용으로 보존하되 현재 예약/반납 목록에서는 제외한다.
 * 모든 대상 행에 removed_at이 기록된 경우에만 성공한다.
 */
function supaMarkScheduleItemsRemoved_(tid, scheduleIds) {
  tid = String(tid || '').trim();
  scheduleIds = (scheduleIds || []).map(function(id) { return String(id || '').trim(); }).filter(Boolean);
  if (!tid || !scheduleIds.length) return { ok: false, error: '거래ID/스케줄ID 없음' };
  var cfg = SUPA_CFG_();
  var token = supaToken_(cfg);
  if (!token) return { ok: false, error: '봇 토큰 없음' };
  var headers = {
    apikey: cfg.apikey,
    Authorization: 'Bearer ' + token,
    'Content-Profile': 'village',
    'Accept-Profile': 'village',
    Prefer: 'return=representation'
  };
  var removedAt = new Date().toISOString();
  for (var i = 0; i < scheduleIds.length; i++) {
    var scheduleId = scheduleIds[i];
    var url = cfg.url + '/rest/v1/schedule_items'
      + '?trade_id=eq.' + encodeURIComponent(tid)
      + '&schedule_id=eq.' + encodeURIComponent(scheduleId);
    var response = UrlFetchApp.fetch(url, {
      method: 'patch',
      contentType: 'application/json',
      headers: headers,
      payload: JSON.stringify({ removed_at: removedAt }),
      muteHttpExceptions: true
    });
    var code = response.getResponseCode();
    var rows = [];
    try { rows = JSON.parse(response.getContentText() || '[]'); } catch (parseErr) {}
    if (code >= 300 || !Array.isArray(rows) || rows.length !== 1) {
      return { ok: false, error: 'Supabase 품목 제외 실패 ' + scheduleId + ' (' + code + ')' };
    }
  }
  return { ok: true, removedAt: removedAt, scheduleIds: scheduleIds };
}

/**
 * 반출완료 서버 권한 저장. 브라우저 전체 upsert와 분리해 다른 탭/기기의 오래된
 * 스냅샷이 setup_done을 되돌리지 못하게 한다. 행 없음도 성공으로 간주하지 않는다.
 */
function supaSetTradeSetupDone_(tid, done, doneAt) {
  tid = String(tid || '').trim();
  if (!tid) return { ok: false, error: '거래ID 없음' };
  try {
    var cfg = SUPA_CFG_();
    var token = supaToken_(cfg);
    if (!token) return { ok: false, error: 'Supabase 봇 토큰 없음' };
    var res = UrlFetchApp.fetch(
      cfg.url + '/rest/v1/trades?trade_id=eq.' + encodeURIComponent(tid) + '&select=trade_id',
      {
        method: 'patch',
        contentType: 'application/json',
        headers: {
          apikey: cfg.apikey,
          Authorization: 'Bearer ' + token,
          'Content-Profile': 'village',
          'Accept-Profile': 'village',
          Prefer: 'return=representation'
        },
        payload: JSON.stringify({
          setup_done: done === true,
          setup_done_at: done === true ? String(doneAt || '') : null
        }),
        muteHttpExceptions: true
      }
    );
    var code = res.getResponseCode();
    if (code >= 300) {
      return { ok: false, error: 'Supabase 반출완료 저장 실패 (' + code + ')' };
    }
    var rows = JSON.parse(res.getContentText() || '[]');
    if (!rows || !rows.length) return { ok: false, error: 'Supabase 거래 행 없음: ' + tid };
    return { ok: true, tradeId: tid };
  } catch (err) {
    return { ok: false, error: 'Supabase 반출완료 저장 오류: ' + (err && err.message ? err.message : String(err)) };
  }
}

/**
 * 반납완료 서버 검증용 상세 수량 조회.
 * 브라우저가 보낸 boolean을 신뢰하지 않고, 먼저 내구 저장된 village.trades.return_counts를
 * GAS가 봇 세션으로 직접 읽는다. 조회 실패/행 없음은 완료 허용이 아니라 명시적 실패다.
 */
function supaActualTakenQty_(item) {
  if (item && item.actual_taken_qty !== null && item.actual_taken_qty !== undefined && item.actual_taken_qty !== '') {
    return Math.max(0, Number(item.actual_taken_qty) || 0);
  }
  return Math.max(0, Number(item && item.taken_qty || 0));
}

function supaActualItemName_(item) {
  return String(item && item.actual_name || item && item.name || '').trim();
}

function supaGetTradeReturnCounts_(tid) {
  tid = String(tid || '').trim();
  if (!tid) return { ok: false, error: '거래ID 없음', returnCounts: {} };
  try {
    var cfg = SUPA_CFG_();
    var token = supaToken_(cfg);
    if (!token) return { ok: false, error: 'Supabase 봇 토큰 없음', returnCounts: {} };
    var url = cfg.url + '/rest/v1/trades?select=trade_id,return_counts&trade_id=eq.'
      + encodeURIComponent(tid) + '&limit=1';
    var res = UrlFetchApp.fetch(url, {
      method: 'get',
      headers: {
        apikey: cfg.apikey,
        Authorization: 'Bearer ' + token,
        'Accept-Profile': 'village'
      },
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    if (code >= 300) {
      return { ok: false, error: 'Supabase 상세 수량 조회 실패 (' + code + ')', returnCounts: {} };
    }
    var rows = JSON.parse(res.getContentText() || '[]');
    if (!rows || !rows.length) {
      return { ok: false, error: 'Supabase 거래 행 없음: ' + tid, returnCounts: {} };
    }
    var counts = rows[0].return_counts;
    if (!counts || typeof counts !== 'object' || Array.isArray(counts)) counts = {};
    var itemRes = UrlFetchApp.fetch(
      cfg.url + '/rest/v1/schedule_items?select=schedule_id,name,qty,taken_qty,actual_name,actual_taken_qty,set_name,is_set_header,is_component,checkout_state,onsite,removed_at'
        + '&trade_id=eq.' + encodeURIComponent(tid) + '&order=sort.asc',
      {
        method: 'get',
        headers: {
          apikey: cfg.apikey,
          Authorization: 'Bearer ' + token,
          'Accept-Profile': 'village'
        },
        muteHttpExceptions: true
      }
    );
    var itemCode = itemRes.getResponseCode();
    if (itemCode >= 300) {
      return { ok: false, error: 'Supabase 반출 기준선 조회 실패 (' + itemCode + ')', returnCounts: {}, scheduleItems: [] };
    }
    var scheduleItems = (JSON.parse(itemRes.getContentText() || '[]') || []).filter(function(item) { return !item.removed_at; });
    return { ok: true, returnCounts: counts, scheduleItems: scheduleItems || [] };
  } catch (err) {
    return {
      ok: false,
      error: 'Supabase 상세 수량 조회 오류: ' + (err && err.message ? err.message : String(err)),
      returnCounts: {},
      scheduleItems: []
    };
  }
}

/** 이미 고정된 반출 기준선 조회. 조회 실패와 기준선 없음은 호출부가 구분해 실패-폐쇄한다. */
function supaGetCheckoutBaselineState_(tid) {
  tid = String(tid || '').trim();
  if (!tid) return { ok: false, error: '거래ID 없음', started: false, items: [] };
  try {
    var cfg = SUPA_CFG_();
    var token = supaToken_(cfg);
    if (!token) return { ok: false, error: 'Supabase 봇 토큰 없음', started: false, items: [] };
    var res = UrlFetchApp.fetch(
      cfg.url + '/rest/v1/schedule_items?select=schedule_id,name,qty,taken_qty,actual_name,actual_taken_qty,set_name,is_set_header,is_component,checkout_state,onsite,removed_at'
        + '&trade_id=eq.' + encodeURIComponent(tid) + '&taken_qty=gt.0&order=sort.asc',
      {
        method: 'get',
        headers: {
          apikey: cfg.apikey,
          Authorization: 'Bearer ' + token,
          'Accept-Profile': 'village'
        },
        muteHttpExceptions: true
      }
    );
    var code = res.getResponseCode();
    if (code >= 300) {
      return { ok: false, error: 'Supabase 반출 기준선 조회 실패 (' + code + ')', started: false, items: [] };
    }
    var items = (JSON.parse(res.getContentText() || '[]') || []).filter(function(item) { return !item.removed_at; });
    return { ok: true, started: items.length > 0, items: items };
  } catch (err) {
    return {
      ok: false,
      error: 'Supabase 반출 기준선 조회 오류: ' + (err && err.message ? err.message : String(err)),
      started: false,
      items: []
    };
  }
}

/**
 * 반출 순간의 장비 정체성과 수량을 taken_qty로 고정한다.
 * 이미 고정된 행은 절대 덮어쓰지 않고, 동일성 불일치면 실패한다.
 * exactExisting=true는 전체 반출완료 시점에 기존 기준선의 삭제/추가까지 검증한다.
 */
function supaCaptureCheckoutBaseline_(tid, equipments, exactExisting) {
  tid = String(tid || '').trim();
  equipments = equipments || [];
  if (!tid || !equipments.length) return { ok: false, error: '반출 기준선 품목 없음' };
  try {
    var cfg = SUPA_CFG_();
    var rows = equipments.map(function(eq, index) {
      var qty = Number(String(eq.qty || 1).replace(/[^0-9.]/g, '')) || 1;
      return {
        schedule_id: String(eq.scheduleId || eq.schedule_id || '').trim(),
        trade_id: tid,
        sort: Number(eq.sort || index),
        name: String(eq.name || '').trim(),
        qty: qty,
        taken_qty: qty,
        set_name: String(eq.setName || eq.set_name || '').trim() || null,
        is_set_header: !!(eq.isHeader || eq.is_set_header),
        is_component: !!(eq.isComponent || eq.is_component),
        checkout_state: 'taken',
        onsite: !!eq.onsite
      };
    }).filter(function(row) { return row.schedule_id && row.name; });
    if (!rows.length) return { ok: false, error: '반출 기준선 유효 품목 없음' };

    var existing = supaGetCheckoutBaselineState_(tid);
    if (!existing || !existing.ok) {
      return { ok: false, error: String(existing && existing.error || '기존 반출 기준선 조회 실패') };
    }
    var existingById = {};
    (existing.items || []).forEach(function(item) {
      existingById[String(item.schedule_id || '').trim()] = item;
    });
    var proposedById = {};
    for (var i = 0; i < rows.length; i++) {
      if (proposedById[rows[i].schedule_id]) return { ok: false, error: '중복 스케줄ID: ' + rows[i].schedule_id };
      proposedById[rows[i].schedule_id] = rows[i];
    }
    if (exactExisting) {
      for (var existingId in existingById) {
        if (!proposedById[existingId]) {
          return { ok: false, error: '기존 반출 기준선 품목이 현재 시트에서 사라졌습니다: ' + existingId };
        }
      }
    }

    var newRows = [];
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      var baseline = existingById[row.schedule_id];
      if (!baseline) {
        newRows.push(row);
        continue;
      }
      var same = Number(baseline.taken_qty || 0) === Number(row.taken_qty || 0) &&
        String(baseline.name || '').trim() === row.name &&
        String(baseline.set_name || '').trim() === String(row.set_name || '').trim() &&
        !!baseline.is_set_header === !!row.is_set_header &&
        !!baseline.is_component === !!row.is_component;
      if (!same) {
        return { ok: false, error: '이미 고정된 반출 기준선과 현재 품목이 다릅니다: ' + row.schedule_id };
      }
    }
    if (!newRows.length) {
      markDashboardCheckoutBaselineStarted_(tid);
      return { ok: true, count: rows.length, reused: true };
    }
    // DB에 기준선이 생겼는데 로컬 보호 표식만 없는 중간 상태를 만들지 않는다.
    // 표식을 먼저 확보하고, DB 저장 실패 때만 표식을 되돌린다(실패-폐쇄).
    markDashboardCheckoutBaselineStarted_(tid);
    if (!supaUpsert_(cfg, 'schedule_items', newRows, 'schedule_id')) {
      clearDashboardCheckoutBaselineStarted_(tid);
      return { ok: false, error: 'Supabase 반출 기준선 저장 실패' };
    }
    return { ok: true, count: rows.length, added: newRows.length };
  } catch (err) {
    return { ok: false, error: 'Supabase 반출 기준선 저장 오류: ' + (err && err.message ? err.message : String(err)) };
  }
}

/**
 * 스크립트 쓰기용 dirty 마킹 — onEdit은 사람 손 편집에만 발화하므로,
 * registerByReqID/추가/삭제/날짜변경처럼 스크립트가 계약·스케줄 시트를 쓰는 경로는
 * 이 함수를 직접 호출해야 1분 트리거(flushDirtyToSupabase)가 Supabase로 밀어준다.
 * 절대 throw하지 않음 (호출부 흐름 보호).
 */
function supaMarkTradeDirty_(tid) {
  try {
    tid = String(tid || '').trim();
    if (!tid) return;
    var p = PropertiesService.getScriptProperties();
    var dirty = {};
    try { dirty = JSON.parse(p.getProperty('SUPA_DIRTY') || '{}'); } catch (x) {}
    // 타임스탬프 값 — flushDirtyToSupabase가 업서트 중 새로 dirty가 된 거래를 구분해 보존한다
    dirty[tid] = Date.now();
    p.setProperty('SUPA_DIRTY', JSON.stringify(dirty));
  } catch (err) {
    // 동기화 마킹 실패가 본 작업을 막으면 안 됨
  }
}

/** 1분 트리거 — dirty 거래들을 빌드해 Supabase upsert 후 클리어. */
function flushDirtyToSupabase() {
  var cfg = SUPA_CFG_();
  if (!cfg.url || !cfg.apikey) { Logger.log('Supabase 설정 없음'); return; }
  var p = PropertiesService.getScriptProperties();
  var dirty = {};
  try { dirty = JSON.parse(p.getProperty('SUPA_DIRTY') || '{}'); } catch (x) {}
  var tids = Object.keys(dirty);
  if (!tids.length) return;
  // dirty 마크 스냅샷 — 업서트 동안 새로 dirty가 된 거래는 지우지 않고 다음 분에 재동기화
  var snapshot = {};
  for (var s = 0; s < tids.length; s++) snapshot[tids[s]] = dirty[tids[s]];

  // ★ 잠금은 시트 읽기(빌드) 동안만 쥔다. HTTP 업서트(수 초)까지 잠금 안에서 돌리면
  //   1분마다 반납완료·품목체크 같은 인터랙티브 쓰기와 경합해 버튼이 실패한다.
  var built = null;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    built = buildSupabaseTrades_(tids);
  } catch (buildErr) {
    Logger.log('flushDirty 빌드 오류: ' + buildErr);
    return;
  } finally {
    lock.releaseLock();
  }

  var ok = true;
  try {
    if (built.trades.length) {
      if (!supaUpsertGrouped_(cfg, 'trades', built.trades, 'trade_id')) ok = false;
      if (built.items.length) {
        if (!supaUpsertGrouped_(cfg, 'schedule_items', built.items, 'schedule_id')) ok = false;
        // 시트에서 삭제된 장비 행을 Supabase에서도 제거해 앱의 '유령 장비'를 없앤다.
        // 거래별로 이번에 빌드된 schedule_id만 남기고 나머지를 삭제(최소 1개 있을 때만 — 위 가드 참조).
        var keepByTrade = {};
        built.items.forEach(function (it) {
          var tid = String(it.trade_id || '').trim();
          if (!tid) return;
          (keepByTrade[tid] = keepByTrade[tid] || []).push(it.schedule_id);
        });
        for (var tKey in keepByTrade) {
          if (!supaDeleteStaleItems_(cfg, tKey, keepByTrade[tKey])) ok = false;
        }
      }
    }
  } catch (err) {
    Logger.log('flushDirty 오류: ' + err);
    return;
  }
  // ★ 성공한 경우에만 dirty에서 제거. 실패(Supabase 장애·봇 토큰 만료·스키마 오류)면
  //    dirty를 유지해 다음 1분 트리거가 재시도한다. 예전엔 실패해도 무조건 지워서
  //    그 분(minute)의 변경분이 영구 유실 → 앱이 낡은 반출/반납 데이터를 표시했다.
  //    업서트 중 다시 dirty가 된 거래(마크 값이 달라짐)도 보존한다.
  if (ok) {
    var after = {};
    try { after = JSON.parse(p.getProperty('SUPA_DIRTY') || '{}'); } catch (x) {}
    for (var i = 0; i < tids.length; i++) {
      if (after[tids[i]] === snapshot[tids[i]]) delete after[tids[i]];
    }
    p.setProperty('SUPA_DIRTY', JSON.stringify(after));
    Logger.log('Supabase push: ' + built.trades.length + '건');
  } else {
    Logger.log('Supabase push 일부 실패 → dirty 유지(재시도 예정): ' + tids.length + '건');
  }
}

/** 거래ID 배열 → Supabase 행({trades, items}). 날짜는 timeline(보정됨), 상세는 dashboard에서. */
function buildSupabaseTrades_(tids) {
  var want = {};
  for (var i = 0; i < tids.length; i++) want[String(tids[i])] = true;

  // 1) 날짜·예약 골격: 넓은 윈도우 timeline (보정된 epoch ms)
  var today = new Date();
  var fromKey = Utilities.formatDate(new Date(today.getTime() - 30 * 86400000), 'Asia/Seoul', 'yyyy-MM-dd');
  var toKey = Utilities.formatDate(new Date(today.getTime() + 365 * 86400000), 'Asia/Seoul', 'yyyy-MM-dd');
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
    // skipCache=false: 편집 경로가 변경 시 대시보드 캐시를 선별 무효화하므로 웜 캐시 재사용이 안전.
    // 강제 재구축(true)은 매분 플러시마다 날짜당 2~6초 전체 리빌드로 트리거 쿼터를 소모했다.
    try { dd = getDashboardData(dk, false, {}); } catch (x) { continue; }
    (dd.checkout || []).concat(dd.checkin || []).forEach(function (t) {
      if (want[t.tradeId] && !detail[t.tradeId]) detail[t.tradeId] = t;
    });
  }

  // 계약마스터 폴백/취소 판정용 — tid -> {name, status, startISO, endISO}
  var master = {};
  try {
    var mSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('계약마스터');
    if (mSheet && mSheet.getLastRow() >= 2) {
      var mRows = mSheet.getRange(2, 1, mSheet.getLastRow() - 1, 10).getValues();
      var mDisp = mSheet.getRange(2, 1, mSheet.getLastRow() - 1, 10).getDisplayValues();
      for (var mi = 0; mi < mRows.length; mi++) {
        var mTid = String(mRows[mi][0]).trim();
        if (!mTid || !want[mTid]) continue;
        var mStart = parseDT(mRows[mi][4], mDisp[mi][5]); // E,F: 반출 일시
        var mEnd = parseDT(mRows[mi][6], mDisp[mi][7]);   // G,H: 반납 일시
        master[mTid] = {
          name: String(mRows[mi][1] || '').trim(),
          status: String(mRows[mi][9] || '').trim(),      // J: 계약상태
          startISO: mStart ? mStart.toISOString() : null,
          endISO: mEnd ? mEnd.toISOString() : null
        };
      }
    }
  } catch (mErr) {}

  var trades = [], items = [];
  for (var tid2 in dates) {
    var d = detail[tid2] || null;
    var m = master[tid2] || {};
    var startISO = new Date(dates[tid2].start).toISOString();
    var endISO = new Date(dates[tid2].end).toISOString();

    if (!d) {
      // 상세 조회 실패/누락 — 운영 필드를 기본값으로 덮어쓰지 않도록 골격만 부분 upsert
      var skeleton = { trade_id: tid2, checkout_at: startISO, return_at: endISO };
      if (m.name) skeleton.customer_name = m.name;
      if (m.status) skeleton.contract_status = m.status;
      trades.push(skeleton);
      continue;
    }

    var row = {
      trade_id: tid2,
      customer_phone: d.tel || null,
      company: d.company || null,
      checkout_at: startISO,
      return_at: endISO,
      contract_status: d.contractStatus || m.status || '예약',
      return_done: !!d.returnDone,
      return_done_at: d.returnDoneAt || null,
      contract_url: d.contractUrl || null,
      contract_regen_pending: !!d.contractRegenPending
    };
    // GAS paymentWarning은 '거래내역 조회 실패' 에러 문자열 — 실패 시 결제 필드를 보내지 않아 기존값 보존.
    // payment_warning 플래그는 앱 전용이라 flush가 관리하지 않음 (에러를 경고로 둔갑시키지 않음).
    var extrasFailed = typeof d.paymentWarning === 'string' && d.paymentWarning.trim();
    if (!extrasFailed) {
      row.payment_method = d.paymentMethod || null;
      row.deposit_status = d.depositStatus || null;
      row.proof_type = d.proofType || null;
      row.issue_status = d.issueStatus || null;
      row.billing_company = d.billingCompany || null;
    }
    // 빈 값으로 기존 데이터를 지우지 않는 필드는 값이 있을 때만 포함 (부분 upsert)
    var rowName = d.name || m.name || '';
    if (rowName) row.customer_name = rowName;
    if (typeof d.actualAmount === 'number') row.amount = d.actualAmount;
    if (d.returnMemo) row.note_checkin = d.returnMemo; // 앱 입력 메모를 null로 지우지 않음
    trades.push(row);

    var eqs = d.equipments || [];
    for (var k = 0; k < eqs.length; k++) {
      var e2 = eqs[k];
      var item = {
        schedule_id: e2.scheduleId,
        trade_id: tid2,
        sort: k,
        name: e2.name,
        qty: Number(e2.qty) || 1,
        set_name: e2.setName || null,
        is_set_header: !!e2.isHeader,
        is_component: !!e2.isComponent,
        category: e2.category || null
      };
      // 시트 체크된 것만 taken으로 — 미체크는 키 자체를 빼서 앱의 excluded/taken 상태 보존
      if (e2.checkedCheckout) item.checkout_state = 'taken';
      items.push(item);
    }
  }

  // 취소/과거 등 timeline에 더는 없는 거래 — 계약마스터 기준으로 상태 반영 (조용한 유실 방지)
  for (var wTid in want) {
    if (dates[wTid]) continue;
    var wm = master[wTid];
    if (!wm || !wm.startISO || !wm.endISO) continue; // 계약마스터에도 없으면 보류
    var cancelled = {
      trade_id: wTid,
      checkout_at: wm.startISO,
      return_at: wm.endISO,
      contract_status: wm.status || '취소'
    };
    if (wm.name) cancelled.customer_name = wm.name;
    trades.push(cancelled);
  }

  return { trades: trades, items: items };
}

/** payload 키 구성이 같은 행끼리 묶어 upsert — PostgREST는 배치 내 키 불일치를 거부하므로.
 *  반환: 모든 그룹이 성공했을 때만 true (하나라도 실패하면 false → 호출부가 dirty 유지). */
function supaUpsertGrouped_(cfg, table, rows, conflict) {
  var groups = {};
  for (var i = 0; i < rows.length; i++) {
    var sig = Object.keys(rows[i]).sort().join(',');
    (groups[sig] = groups[sig] || []).push(rows[i]);
  }
  var allOk = true;
  for (var sig2 in groups) {
    if (!supaUpsert_(cfg, table, groups[sig2], conflict)) allOk = false;
  }
  return allOk;
}

/** Supabase REST 벌크 upsert (anon 키, merge-duplicates). 성공 시 true, 실패 시 false. */
function supaUpsert_(cfg, table, rows, conflict) {
  if (!rows.length) return true;
  // 같은 conflict 키(schedule_id/trade_id) 중복 제거 — Postgres 'ON CONFLICT ... twice'(21000) 방지. 마지막 값 유지.
  var byKey = {};
  for (var di = 0; di < rows.length; di++) byKey[String(rows[di][conflict])] = rows[di];
  var keys = Object.keys(byKey);
  if (keys.length < rows.length) {
    var deduped = [];
    for (var ki = 0; ki < keys.length; ki++) deduped.push(byKey[keys[ki]]);
    rows = deduped;
  }
  var token = supaToken_(cfg);
  if (!token) { Logger.log('봇 토큰 없음 → 동기화 중단'); return false; }
  var res = UrlFetchApp.fetch(cfg.url + '/rest/v1/' + table + '?on_conflict=' + conflict, {
    method: 'post',
    contentType: 'application/json',
    headers: {
      apikey: cfg.apikey,                 // publishable (공개·차단 없음)
      Authorization: 'Bearer ' + token,   // 봇 user JWT (authenticated 역할 → RLS auth_rw 통과)
      'Content-Profile': 'village',       // village 스키마 지정 (public 아님)
      'Accept-Profile': 'village',
      Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    payload: JSON.stringify(rows),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code >= 300) {
    Logger.log('Supabase ' + table + ' upsert 실패 ' + code + ': ' + res.getContentText().slice(0, 200));
    return false;
  }
  return true;
}

/** 특정 거래의 schedule_items 중 keepIds에 없는 행(시트에서 삭제된 장비)을 Supabase에서 제거.
 *  ★ keepIds가 비어 있으면 절대 삭제하지 않는다 — 상세 조회 실패로 items가 비었을 때
 *    거래 전체를 날리는 사고를 원천 차단(최소 1개는 남는 것이 보장될 때만 정리). */
function supaDeleteStaleItems_(cfg, tradeId, keepIds) {
  if (!tradeId || !keepIds || !keepIds.length) return true;
  var token = supaToken_(cfg);
  if (!token) return false;
  var inList = keepIds.map(function (id) { return '"' + String(id).replace(/"/g, '') + '"'; }).join(',');
  var url = cfg.url + '/rest/v1/schedule_items'
    + '?trade_id=eq.' + encodeURIComponent(tradeId)
    + '&schedule_id=not.in.(' + encodeURIComponent(inList) + ')'
    // 반출 기준선(taken_qty)은 시트 행이 지워져도 감사/완료 검증을 위해 보존한다.
    + '&taken_qty=is.null';
  var res = UrlFetchApp.fetch(url, {
    method: 'delete',
    headers: {
      apikey: cfg.apikey,
      Authorization: 'Bearer ' + token,
      'Content-Profile': 'village',
      Prefer: 'return=minimal'
    },
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code >= 300) {
    Logger.log('Supabase schedule_items 정리 실패 ' + code + ': ' + res.getContentText().slice(0, 200));
    return false;
  }
  return true;
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
  var fromKey = Utilities.formatDate(new Date(today.getTime() - 30 * 86400000), 'Asia/Seoul', 'yyyy-MM-dd');
  var toKey = Utilities.formatDate(new Date(today.getTime() + 180 * 86400000), 'Asia/Seoul', 'yyyy-MM-dd');
  var tl = getTimelineData({ from: fromKey, to: toKey, compact: 2 });
  var tids = {};
  (tl.items || []).forEach(function (it) { if (it.tid) tids[it.tid] = 1; });
  var cfg = SUPA_CFG_();
  if (!cfg.url || !cfg.apikey) { Logger.log('Supabase 설정 없음'); return; }
  var built = buildSupabaseTrades_(Object.keys(tids));
  supaUpsert_(cfg, 'trades', built.trades, 'trade_id');
  supaUpsert_(cfg, 'schedule_items', built.items, 'schedule_id');
  Logger.log('전체 동기화: ' + built.trades.length + '건');
}

/* ───────────── 스크립트 속성 관리 (속성 50개+ 라 UI 읽기전용일 때 사용) ───────────── */

/**
 * 동기화용 봇 계정(이메일+비번)을 저장. GAS가 이걸로 로그인해 user JWT로 씀 → secret 키 차단 회피.
 * 사용법: Supabase에 만든 계정(직원 계정 재사용 가능)을 아래에 넣고 ▶ 실행 → 끝나면 비밀번호 줄 비우세요.
 */
function initSupabaseConfig() {
  var URL = 'https://tedffwpijiylklfuzkua.supabase.co';
  var BOT_EMAIL = '';    // ← 동기화용 계정 이메일 (직원 계정 재사용 OK)
  var BOT_PASSWORD = ''; // ← 그 계정 비밀번호 (실행 후 이 줄 비우기)
  if (!BOT_EMAIL || !BOT_PASSWORD) { Logger.log('⚠️ BOT_EMAIL, BOT_PASSWORD 둘 다 채우고 실행하세요'); return; }
  var p = PropertiesService.getScriptProperties();
  p.setProperties({ SUPABASE_URL: URL, SUPABASE_BOT_EMAIL: BOT_EMAIL, SUPABASE_BOT_PASSWORD: BOT_PASSWORD }, false);
  p.deleteProperty('SUPABASE_SERVICE_KEY'); // 차단됐던 secret 키 제거
  p.deleteProperty('SUPA_TOKEN'); p.deleteProperty('SUPA_TOKEN_EXP'); // 토큰 캐시 초기화
  Logger.log('✅ 봇 계정 저장 완료. 이제 위 BOT_PASSWORD 줄을 다시 비워 저장하세요.');
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
  var config = keys.filter(function (k) { return !/^(itemCheck|setupDone|setupDoneAt|checkoutBaselineStarted)_/.test(k); });
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
    var m = k.match(/^(?:itemCheck|setupDone|setupDoneAt|checkoutBaselineStarted)_(\d{6})-/);
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
