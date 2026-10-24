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

function supaTokenCacheStorageQuota_(error) {
  var message = String(error && error.message || error || '');
  return /exceeded\s+(?:the\s+)?property\s+storage\s+quota|속성\s*저장\s*용량\s*한도(?:를|가)?\s*초과/i.test(message);
}

// 봇 계정으로 로그인해 access_token 획득 (캐시 + 만료 시 재로그인). user JWT라 secret-키 차단에 안 걸림.
function supaToken_(cfg) {
  var p = PropertiesService.getScriptProperties();
  var cached = p.getProperty('SUPA_TOKEN');
  var exp = Number(p.getProperty('SUPA_TOKEN_EXP') || 0);
  if (cached && Date.now() < exp - 60000) return cached;
  if (!cfg.botEmail || !cfg.botPassword) { Logger.log('봇 계정 미설정 — initSupabaseConfig 실행 필요'); return null; }
  var res = supaSyncFetch_(cfg.url + '/auth/v1/token?grant_type=password', {
    method: 'post',
    contentType: 'application/json',
    headers: { apikey: cfg.apikey },
    payload: JSON.stringify({ email: cfg.botEmail, password: cfg.botPassword }),
    muteHttpExceptions: true
  });
  if (res.getResponseCode() >= 300) { Logger.log('봇 로그인 실패: ' + res.getContentText().slice(0, 200)); return null; }
  var j = JSON.parse(res.getContentText());
  try {
    p.setProperty('SUPA_TOKEN', j.access_token);
    p.setProperty('SUPA_TOKEN_EXP', String(Date.now() + ((j.expires_in || 3600) * 1000)));
  } catch (cacheError) {
    // A successful login is authoritative; a full optional cache must not block ledger access.
    // Keep both writes in order: never extend the old token's expiry if replacing it failed.
    if (!supaTokenCacheStorageQuota_(cacheError)) throw cacheError;
  }
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
  var rItems = supaSyncFetch_(cfg.url + '/rest/v1/schedule_items' + filt, { method: 'delete', headers: headers, muteHttpExceptions: true });
  var rTrade = supaSyncFetch_(cfg.url + '/rest/v1/trades' + filt, { method: 'delete', headers: headers, muteHttpExceptions: true });
  var ci = rItems.getResponseCode(), ct = rTrade.getResponseCode();
  var ok = ci < 300 && ct < 300;
  if (!ok) Logger.log('supaDeleteTrade_ 실패 items=' + ci + ' trade=' + ct + ' : ' +
    rItems.getContentText().slice(0, 150) + ' / ' + rTrade.getContentText().slice(0, 150));
  return { ok: ok, items: ci, trade: ct };
}

/**
 * 계약 취소용 — 거래 기록은 남기고 일정 점유(schedule_items)만 제거한 뒤 상태를 취소로 남긴다.
 * 취소 정리 워커와 1분 dirty 동기화가 함께 사용하는 멱등 투영이다.
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
  var rItems = supaSyncFetch_(cfg.url + '/rest/v1/schedule_items' + filt, {
    method: 'delete',
    headers: headers,
    muteHttpExceptions: true
  });
  var rTrade = supaSyncFetch_(cfg.url + '/rest/v1/trades' + filt, {
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
 * 반출 전 예약 행만 현재 목록에서 제외한다. taken_qty가 고정된 물리 반출 기준선은
 * 삭제/제외 요청이 와도 그대로 보존해 반납 의무가 사라지지 않게 한다.
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
      + '&schedule_id=eq.' + encodeURIComponent(scheduleId)
      + '&taken_qty=is.null';
    var response = supaSyncFetch_(url, {
      method: 'patch',
      contentType: 'application/json',
      headers: headers,
      payload: JSON.stringify({ removed_at: removedAt }),
      muteHttpExceptions: true
    });
    var code = response.getResponseCode();
    var rows = [];
    try { rows = JSON.parse(response.getContentText() || '[]'); } catch (parseErr) {}
    if (code < 300 && Array.isArray(rows) && rows.length === 0) {
      // 브라우저의 이전 버전/중복 재시도가 이미 물리 삭제했거나 앞선 worker가 제외했을 수 있다.
      // 대상이 없으면 목표 상태(현재 목록에서 제거)는 이미 달성된 것이므로 멱등 성공이다.
      var check = supaSyncFetch_(
        cfg.url + '/rest/v1/schedule_items?select=schedule_id,removed_at,taken_qty'
          + '&trade_id=eq.' + encodeURIComponent(tid)
          + '&schedule_id=eq.' + encodeURIComponent(scheduleId),
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
      var existingRows = [];
      try { existingRows = JSON.parse(check.getContentText() || '[]'); } catch (checkParseErr) {}
      if (check.getResponseCode() < 300 && (
        !existingRows.length || existingRows.every(function(row) {
          return !!row.removed_at || Number(row.taken_qty || 0) > 0;
        })
      )) continue;
    }
    if (code >= 300 || !Array.isArray(rows) || rows.length !== 1) {
      return { ok: false, error: 'Supabase 품목 제외 실패 ' + scheduleId + ' (' + code + ')' };
    }
  }
  return { ok: true, removedAt: removedAt, scheduleIds: scheduleIds };
}

/**
 * 이미 반납완료된 거래의 예약 문서 오기를 바로잡을 때만 쓰는 exact projection.
 * 물리 반출 기준선(taken_qty)은 절대 생성·수정하지 않고, 새 문서 행은 excluded audit
 * row로만 남긴다. 호출부는 GAS 시트 변경 후 ScriptLock을 놓은 상태여야 한다.
 */
function supaApplyReturnedTradeHistoricalCorrection_(tid, removedScheduleIds, addedItems) {
  tid = String(tid || '').trim();
  removedScheduleIds = (removedScheduleIds || []).map(function(id) {
    return String(id || '').trim();
  }).filter(Boolean);
  addedItems = Array.isArray(addedItems) ? addedItems : [];
  if (!/^\d{6}-\d{3,}$/.test(tid) || !addedItems.length) {
    return { ok: false, error: '반납완료 과거 정정의 거래/제거/추가 증거가 불완전합니다' };
  }

  var authority = supaGetCheckoutBaselineState_(tid);
  if (!authority || authority.ok !== true || authority.tradeFound !== true ||
      authority.returnDone !== true || String(authority.contractStatus || '').trim() !== '반납완료') {
    return { ok: false, error: String(authority && authority.error || 'Supabase 반납완료 권한 상태가 정확하지 않습니다') };
  }
  var protectedIds = {};
  (authority.items || []).forEach(function(item) {
    if (Number(item.taken_qty || 0) > 0) protectedIds[String(item.schedule_id || '').trim()] = true;
  });
  var protectedRemovals = removedScheduleIds.filter(function(id) { return !!protectedIds[id]; });
  if (protectedRemovals.length) {
    return { ok: false, error: '불변 반출 기준선(taken_qty) 품목은 제거할 수 없습니다: ' + protectedRemovals.join(', ') };
  }

  var seenAddedIds = {};
  var rows = [];
  for (var i = 0; i < addedItems.length; i++) {
    var item = addedItems[i] || {};
    var scheduleId = String(item.scheduleId || item.schedule_id || '').trim();
    var name = String(item.name || '').trim();
    var setName = String(item.setName || item.set_name || '').trim();
    var qty = Number(item.qty || item.quantity);
    var prefix = scheduleId.match(/^(\d{6}-\d{3,})-(\d+)$/);
    if (!prefix || prefix[1] !== tid || !name || !Number.isInteger(qty) || qty < 1 || qty > 99 || seenAddedIds[scheduleId]) {
      return { ok: false, error: '반납완료 과거 정정 추가 행의 정체성이 올바르지 않습니다: ' + scheduleId };
    }
    seenAddedIds[scheduleId] = true;
    rows.push({
      schedule_id: scheduleId,
      trade_id: tid,
      sort: Number(prefix[2]),
      name: name,
      qty: qty,
      set_name: setName || null,
      is_set_header: !setName || setName === name,
      is_component: !!setName && setName !== name,
      checkout_state: 'excluded',
      onsite: false,
      removed_at: null
    });
  }

  try {
    var cfg = SUPA_CFG_();
    var token = supaToken_(cfg);
    if (!token) return { ok: false, error: 'Supabase 봇 토큰 없음' };
    var headers = {
      apikey: cfg.apikey,
      Authorization: 'Bearer ' + token,
      'Content-Profile': 'village',
      'Accept-Profile': 'village'
    };
    var addedIds = rows.map(function(row) { return row.schedule_id; });
    var inList = addedIds.map(function(id) { return '"' + id.replace(/"/g, '') + '"'; }).join(',');
    var existing = supaSyncFetch_(
      cfg.url + '/rest/v1/schedule_items?select=schedule_id,taken_qty,removed_at'
        + '&trade_id=eq.' + encodeURIComponent(tid)
        + '&schedule_id=in.(' + encodeURIComponent(inList) + ')',
      { method: 'get', headers: { apikey: cfg.apikey, Authorization: 'Bearer ' + token, 'Accept-Profile': 'village' }, muteHttpExceptions: true }
    );
    var existingRows = [];
    try { existingRows = JSON.parse(existing.getContentText() || '[]'); } catch (existingParseError) {}
    if (existing.getResponseCode() >= 300) {
      return { ok: false, error: 'Supabase 과거 정정 추가ID 조회 실패 (' + existing.getResponseCode() + ')' };
    }
    if (!Array.isArray(existingRows) || existingRows.length) {
      return { ok: false, error: 'Supabase에 과거 정정 추가 스케줄ID가 이미 존재해 충돌했습니다' };
    }

    var inserted = supaSyncFetch_(
      cfg.url + '/rest/v1/schedule_items?on_conflict=schedule_id',
      {
        method: 'post',
        contentType: 'application/json',
        headers: Object.assign({}, headers, { Prefer: 'resolution=ignore-duplicates,return=representation' }),
        payload: JSON.stringify(rows),
        muteHttpExceptions: true
      }
    );
    var insertedRows = [];
    try { insertedRows = JSON.parse(inserted.getContentText() || '[]'); } catch (insertParseError) {}
    var insertedIds = Array.isArray(insertedRows) ? insertedRows.map(function(row) {
      return String(row.schedule_id || '').trim();
    }).sort() : [];
    if (inserted.getResponseCode() >= 300 || JSON.stringify(insertedIds) !== JSON.stringify(addedIds.slice().sort())) {
      return { ok: false, error: 'Supabase 과거 정정 추가 행 저장/검증 실패 (' + inserted.getResponseCode() + ')' };
    }

    var removed = removedScheduleIds.length
      ? supaMarkScheduleItemsRemoved_(tid, removedScheduleIds)
      : { ok: true, scheduleIds: [] };
    if (!removed || removed.ok !== true) {
      return {
        ok: false,
        partial: true,
        error: String(removed && removed.error || 'Supabase 과거 정정 제거 행 반영 실패'),
        addedScheduleIds: addedIds
      };
    }
    return {
      ok: true,
      addedScheduleIds: addedIds,
      removedScheduleIds: removedScheduleIds,
      physicalCheckoutBaselineChanged: false
    };
  } catch (err) {
    return { ok: false, error: 'Supabase 반납완료 과거 정정 오류: ' + (err && err.message ? err.message : String(err)) };
  }
}

/**
 * 반출완료 서버 권한 저장. 브라우저 전체 upsert와 분리해 다른 탭/기기의 오래된
 * 스냅샷이 setup_done을 되돌리지 못하게 한다. 행 없음도 성공으로 간주하지 않는다.
 */
function supaSetTradeSetupDone_(tid, done, doneAt) {
  tid = String(tid || '').trim();
  if (!tid) return { ok: false, error: '거래ID 없음' };
  var cfg = null;
  var token = null;
  var targetDone = done === true;
  try {
    cfg = SUPA_CFG_();
    token = supaToken_(cfg);
    if (!token) return { ok: false, error: 'Supabase 봇 토큰 없음' };
    var res = supaSyncFetch_(
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
    var rows = null;
    try { rows = JSON.parse(res.getContentText() || '[]'); } catch (parseErr) {}
    if (code < 300 && rows && rows.length === 1) return { ok: true, tradeId: tid };
    var canonical = supaReadAuthorityRow_(
      cfg, token, 'trades', { trade_id: tid }, 'trade_id,setup_done,setup_done_at'
    );
    if (canonical.ok && canonical.row.setup_done === targetDone) {
      return { ok: true, tradeId: tid, deduped: true, confirmedAfterError: true };
    }
    if (code < 300 && rows && rows.length === 0) return { ok: false, error: 'Supabase 거래 행 없음: ' + tid };
    return {
      ok: false,
      outcomeUnknown: code >= 500 || !canonical.ok || !rows,
      error: 'Supabase 반출완료 저장 실패 (' + code + ')'
    };
  } catch (err) {
    var afterError = supaReadAuthorityRow_(
      cfg, token, 'trades', { trade_id: tid }, 'trade_id,setup_done,setup_done_at'
    );
    if (afterError.ok && afterError.row.setup_done === targetDone) {
      return { ok: true, tradeId: tid, deduped: true, confirmedAfterError: true };
    }
    return {
      ok: false,
      outcomeUnknown: true,
      error: 'Supabase 반출완료 저장 오류: ' + (err && err.message ? err.message : String(err))
    };
  }
}

function supaReadAuthorityRow_(cfg, token, table, filters, select) {
  try {
    cfg = cfg || SUPA_CFG_();
    token = token || supaToken_(cfg);
    if (!token) return { ok: false, error: 'Supabase 봇 토큰 없음' };
    var query = Object.keys(filters || {}).map(function(key) {
      return key + '=eq.' + encodeURIComponent(String(filters[key]));
    });
    query.push('select=' + encodeURIComponent(select));
    var res = supaSyncFetch_(cfg.url + '/rest/v1/' + table + '?' + query.join('&'), {
      method: 'get',
      headers: {
        apikey: cfg.apikey,
        Authorization: 'Bearer ' + token,
        'Accept-Profile': 'village'
      },
      muteHttpExceptions: true
    });
    if (res.getResponseCode() >= 300) return { ok: false, error: 'Supabase 정본 재확인 실패 (' + res.getResponseCode() + ')' };
    var rows = JSON.parse(res.getContentText() || '[]');
    if (!rows || rows.length !== 1) return { ok: false, error: 'Supabase 정본 행 없음' };
    return { ok: true, row: rows[0] };
  } catch (err) {
    return { ok: false, error: 'Supabase 정본 재확인 오류: ' + (err && err.message ? err.message : String(err)) };
  }
}

function supaStableJson_(value) {
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(supaStableJson_).join(',') + ']';
  return '{' + Object.keys(value).sort().map(function(key) {
    return JSON.stringify(key) + ':' + supaStableJson_(value[key]);
  }).join(',') + '}';
}

function supaReturnTargetMatches_(state, done, status, expectedReturnCounts) {
  if (!(state && state.ok && state.row &&
    state.row.return_done === (done === true) &&
    String(state.row.contract_status || '') === String(status || ''))) return false;
  if (done !== true && expectedReturnCounts && typeof expectedReturnCounts === 'object') {
    return supaStableJson_(state.row.return_counts || {}) === supaStableJson_(expectedReturnCounts);
  }
  return true;
}

/** 반납완료 전용 CAS. 응답이 유실돼도 정본 readback으로 같은 mutation을 멱등 수렴시킨다. */
function supaSetTradeReturnDone_(tid, done, doneAt, contractStatus, expectedReturnCounts, force) {
  tid = String(tid || '').trim();
  if (!tid) return { ok: false, error: '거래ID 없음' };
  var cfg = null;
  var token = null;
  var isDone = done === true;
  var targetStatus = String(contractStatus || (isDone ? '반납완료' : '반출'));
  try {
    cfg = SUPA_CFG_();
    token = supaToken_(cfg);
    if (!token) return { ok: false, error: 'Supabase 봇 토큰 없음' };
    var url = cfg.url + '/rest/v1/trades?trade_id=eq.' + encodeURIComponent(tid) + '&select=trade_id';
    if (isDone) {
      url += '&or=' + encodeURIComponent('(return_done.is.null,return_done.eq.false)');
      if (!force) {
        var snapshot = expectedReturnCounts && typeof expectedReturnCounts === 'object' ? expectedReturnCounts : {};
        url += '&return_counts=eq.' + encodeURIComponent(JSON.stringify(snapshot));
      }
    }
    var payload = {
      return_done: isDone,
      return_done_at: isDone ? String(doneAt || '') : null,
      contract_status: targetStatus
    };
    // 구조/수량 변경으로 재개방할 때는 영향을 받은 반납 상세 제거까지 같은 PATCH로 묶는다.
    if (!isDone && expectedReturnCounts && typeof expectedReturnCounts === 'object') {
      payload.return_counts = expectedReturnCounts;
    }
    var res = supaSyncFetch_(url, {
      method: 'patch',
      contentType: 'application/json',
      headers: {
        apikey: cfg.apikey,
        Authorization: 'Bearer ' + token,
        'Content-Profile': 'village',
        'Accept-Profile': 'village',
        Prefer: 'return=representation'
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    var code = res.getResponseCode();
    var rows = null;
    try { rows = JSON.parse(res.getContentText() || '[]'); } catch (parseErr) {}
    if (code < 300 && rows && rows.length === 1) return { ok: true, tradeId: tid };

    var canonical = supaReadAuthorityRow_(
      cfg, token, 'trades', { trade_id: tid }, 'trade_id,return_done,return_done_at,contract_status,return_counts'
    );
    if (supaReturnTargetMatches_(canonical, isDone, targetStatus, expectedReturnCounts)) {
      return { ok: true, tradeId: tid, deduped: true, confirmedAfterError: true };
    }
    if (code < 300 && rows && rows.length === 0) {
      return {
        ok: false,
        conflict: isDone,
        error: isDone
          ? '다른 직원이 반납 수량 또는 완료 상태를 먼저 변경했습니다. 최신 상태에서 다시 시도해주세요.'
          : 'Supabase 거래 행 없음: ' + tid
      };
    }
    return {
      ok: false,
      outcomeUnknown: code >= 500 || !canonical.ok || !rows,
      error: 'Supabase 반납 상태 저장 실패 (' + code + ')'
    };
  } catch (err) {
    var afterError = supaReadAuthorityRow_(
      cfg, token, 'trades', { trade_id: tid }, 'trade_id,return_done,return_done_at,contract_status,return_counts'
    );
    if (supaReturnTargetMatches_(afterError, isDone, targetStatus, expectedReturnCounts)) {
      return { ok: true, tradeId: tid, deduped: true, confirmedAfterError: true };
    }
    return {
      ok: false,
      outcomeUnknown: true,
      error: 'Supabase 반납 상태 저장 오류: ' + (err && err.message ? err.message : String(err))
    };
  }
}

/** Read-only server code contract marker; not proof of database health or frontend deployment. */
function getCheckoutMutationProtocol() {
  return { protocol: 'checkout_updated_at_cas_v1', expectedUpdatedAtRequired: true };
}

/** Preserve PostgreSQL microseconds and timezone verbatim; never round through Date. */
function validCheckoutVersion_(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value);
}

function checkoutVersionRequired_() {
  return { ok: false, applied: false, code: 'CHECKOUT_REFRESH_REQUIRED', outcomeUnknown: false,
    error: '반출 품목의 기준 정보가 없습니다. 새로고침 후 다시 선택해주세요.' };
}

/** A returned row is evidence only for this exact item, version and canonical state. */
function supaCheckoutAuthorityRow_(rows, tid, scheduleId) {
  if (!Array.isArray(rows) || rows.length !== 1) return null;
  var row = rows[0];
  return row && row.trade_id === tid && row.schedule_id === scheduleId &&
    validCheckoutVersion_(row.updated_at) && Object.prototype.hasOwnProperty.call(row, 'removed_at') &&
    ['pending', 'taken', 'excluded'].indexOf(row.checkout_state) >= 0 ? row : null;
}

function supaCheckoutResult_(row, scheduleId, targetState, applied) {
  if (!row) return { ok: false, applied: false, scheduleId: scheduleId, outcomeUnknown: true,
    code: 'OUTCOME_UNKNOWN', error: '반출 체크 정본 조회가 필요합니다.' };
  if (row.missing || row.removed_at !== null) return { ok: false, applied: false, scheduleId: scheduleId,
    outcomeUnknown: false, code: 'CHECKOUT_ITEM_UNAVAILABLE', error: '품목이 삭제 또는 제외되었습니다. 새로고침해주세요.' };
  var matched = row.checkout_state === targetState;
  return { ok: matched, applied: matched && applied === true, scheduleId: scheduleId,
    checked: matched ? targetState === 'taken' : undefined, updatedAt: row.updated_at,
    canonicalState: row.checkout_state, outcomeUnknown: false,
    deduped: matched && applied !== true, confirmedAfterError: matched && applied !== true,
    code: matched ? undefined : 'CHECKOUT_CONFLICT',
    error: matched ? undefined : '다른 변경이 먼저 저장되었습니다. 현재 상태를 확인 후 다시 선택해주세요.' };
}

function supaReadCheckoutAuthority_(cfg, token, tid, scheduleId) {
  if (!cfg || !token) return null;
  try {
    var response = supaSyncFetch_(cfg.url + '/rest/v1/schedule_items?trade_id=eq.' + encodeURIComponent(tid)
      + '&schedule_id=eq.' + encodeURIComponent(scheduleId) + '&select=trade_id,schedule_id,checkout_state,updated_at,removed_at', {
      method: 'get', headers: { apikey: cfg.apikey, Authorization: 'Bearer ' + token, 'Accept-Profile': 'village' }, muteHttpExceptions: true
    });
    if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) return null;
    var rows = JSON.parse(response.getContentText());
    return Array.isArray(rows) && !rows.length ? { missing: true } : supaCheckoutAuthorityRow_(rows, tid, scheduleId);
  } catch (readError) { return null; }
}

/** 품목 반출 체크도 전용 부분 PATCH + 정본 readback으로 멱등 확정한다. */
function supaSetScheduleItemCheckoutState_(tid, scheduleId, done, expectedUpdatedAt) {
  tid = String(tid || '').trim();
  scheduleId = String(scheduleId || '').trim();
  if (!tid || !scheduleId) return { ok: false, error: '거래ID/스케줄ID 없음' };
  if (!validCheckoutVersion_(expectedUpdatedAt)) return checkoutVersionRequired_();
  var cfg = null;
  var token = null;
  var targetState = done === true ? 'taken' : 'pending';
  try {
    cfg = SUPA_CFG_();
    token = supaToken_(cfg);
    if (!token) return { ok: false, error: 'Supabase 봇 토큰 없음' };
    var res = supaSyncFetch_(
      cfg.url + '/rest/v1/schedule_items?trade_id=eq.' + encodeURIComponent(tid)
        + '&schedule_id=eq.' + encodeURIComponent(scheduleId) + '&updated_at=eq.' + encodeURIComponent(expectedUpdatedAt)
        + '&removed_at=is.null&select=trade_id,schedule_id,checkout_state,updated_at,removed_at',
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
        payload: JSON.stringify({ checkout_state: targetState }),
        muteHttpExceptions: true
      }
    );
    var code = res.getResponseCode();
    var rows = null;
    try { rows = JSON.parse(res.getContentText() || '[]'); } catch (parseErr) {}
    var returned = supaCheckoutAuthorityRow_(rows, tid, scheduleId);
    if (code >= 200 && code < 300 && returned && returned.checkout_state === targetState && returned.removed_at === null)
      return supaCheckoutResult_(returned, scheduleId, targetState, true);
    var canonical = supaReadCheckoutAuthority_(cfg, token, tid, scheduleId);
    return supaCheckoutResult_(canonical, scheduleId, targetState, false);
  } catch (err) {
    var afterError = supaReadCheckoutAuthority_(cfg, token, tid, scheduleId);
    return supaCheckoutResult_(afterError, scheduleId, targetState, false);
  }
}

/**
 * 여러 반출 체크를 한 번의 GAS 실행에서 병렬 PATCH한다.
 * 모바일에서 품목을 연속으로 누를 때 브라우저→GAS 왕복과 Supabase HTTP를 품목 수만큼
 * 직렬로 기다리던 병목을 없앤다. 실패 응답은 마지막에 한 번의 정본 조회로 재확인한다.
 */
function supaSetScheduleItemCheckoutStatesBatch_(tid, items) {
  tid = String(tid || '').trim();
  items = Array.isArray(items) ? items : [];
  if (!tid || !items.length) return { ok: false, results: [], error: '거래ID/품목 없음' };

  var cfg = null;
  var token = null;
  var headers = null;
  var requests = [];
  var normalized = items.map(function(item) {
    return { scheduleId: String(item && item.scheduleId || '').trim(), done: item && item.done === true,
      targetState: item && item.done === true ? 'taken' : 'pending', expectedUpdatedAt: item && item.expectedUpdatedAt };
  });
  var seen = Object.create(null);
  if (normalized.some(function(item) {
    if (!item.scheduleId || seen[item.scheduleId]) return true;
    seen[item.scheduleId] = true;
    return false;
  }))
    return { ok: false, results: [], error: '품목 ID 누락 또는 중복' };
  if (normalized.some(function(item) { return !validCheckoutVersion_(item.expectedUpdatedAt); }))
    return { ok: false, results: normalized.map(function(item) { return Object.assign({ scheduleId: item.scheduleId }, checkoutVersionRequired_()); }) };
  var results = null;
  try {
    cfg = SUPA_CFG_();
    token = supaToken_(cfg);
    if (!token) return { ok: false, results: [], error: 'Supabase 봇 토큰 없음' };
    headers = {
      apikey: cfg.apikey,
      Authorization: 'Bearer ' + token,
      'Content-Profile': 'village',
      'Accept-Profile': 'village',
      Prefer: 'return=representation'
    };
    requests = normalized.map(function(item) {
      return {
        url: cfg.url + '/rest/v1/schedule_items?trade_id=eq.' + encodeURIComponent(tid)
          + '&schedule_id=eq.' + encodeURIComponent(item.scheduleId) + '&updated_at=eq.' + encodeURIComponent(item.expectedUpdatedAt)
          + '&removed_at=is.null&select=trade_id,schedule_id,checkout_state,updated_at,removed_at',
        method: 'patch',
        contentType: 'application/json',
        headers: headers,
        payload: JSON.stringify({ checkout_state: item.targetState }),
        muteHttpExceptions: true
      };
    });

    var responses = supaSyncFetchAll_(requests);
    results = normalized.map(function(item, index) {
      var response = responses[index];
      var code = response ? response.getResponseCode() : 0;
      var rows = null;
      try { rows = JSON.parse(response && response.getContentText() || '[]'); } catch (parseErr) {}
      var returned = supaCheckoutAuthorityRow_(rows, tid, item.scheduleId);
      var matched = !!(code >= 200 && code < 300 && returned && returned.checkout_state === item.targetState && returned.removed_at === null);
      return supaCheckoutResult_(matched ? returned : null, item.scheduleId, item.targetState, matched);
    });
    var unresolved = results.filter(function(result) { return !result.ok; });
    if (unresolved.length) {
      var ids = unresolved.map(function(result) { return result.scheduleId; });
      var read = supaSyncFetch_(
        cfg.url + '/rest/v1/schedule_items?trade_id=eq.' + encodeURIComponent(tid)
          + '&schedule_id=in.' + encodeURIComponent('(' + ids.join(',') + ')')
          + '&select=trade_id,schedule_id,checkout_state,updated_at,removed_at',
        { method: 'get', headers: headers, muteHttpExceptions: true }
      );
      var readRows = null;
      try { readRows = JSON.parse(read.getContentText() || '[]'); } catch (readParseErr) {}
      var canonical = Object.create(null);
      var readKnown = read.getResponseCode() >= 200 && read.getResponseCode() < 300 && Array.isArray(readRows)
        && readRows.every(function(row) { return row && ids.indexOf(row.schedule_id) >= 0 && !!supaCheckoutAuthorityRow_([row], tid, row.schedule_id); });
      if (readKnown) {
        readRows.forEach(function(row) {
          if (!row || typeof row.schedule_id !== 'string') return;
          (canonical[row.schedule_id] || (canonical[row.schedule_id] = [])).push(row);
        });
      }
      results.forEach(function(result, index) {
        if (result.ok) return;
        var target = normalized[index].targetState;
        var verified = readKnown && !canonical[result.scheduleId] ? { missing: true }
          : supaCheckoutAuthorityRow_(canonical[result.scheduleId], tid, result.scheduleId);
        results[index] = supaCheckoutResult_(verified, result.scheduleId, target, false);
      });
    }
    return {
      ok: results.every(function(result) { return result.ok; }),
      results: results
    };
  } catch (err) {
    // fetchAll 자체가 예외를 던진 경우에도 단건 helper처럼 서버 정본을 확인한다.
    var fallback = normalized.map(function(item, index) {
      if (results && results[index] && results[index].ok) return results[index];
      var canonical = supaReadCheckoutAuthority_(cfg, token, tid, item.scheduleId);
      return supaCheckoutResult_(canonical, item.scheduleId, item.targetState, false);
    });
    return { ok: fallback.length > 0 && fallback.every(function(result) { return result.ok; }), results: fallback };
  }
}

/**
 * 대시보드 checkedCheckout 정본 조회.
 * Script Properties itemCheck_* 는 용량 초과/완료 후 정리로 자주 비어 있다.
 * 앱 품목 체크 쓰기는 Supabase schedule_items.checkout_state 가 정본이므로
 * 대시보드 응답도 여기서 읽어 합친다. 실패 시 빈 맵(호출부가 props 폴백).
 */
function supaGetScheduleItemCheckoutStateMap_(tradeIds) {
  var byScheduleId = {};
  var byUpdatedAt = {};
  var ids = [];
  var seen = {};
  (tradeIds || []).forEach(function(tid) {
    tid = String(tid || '').trim();
    if (!tid || seen[tid]) return;
    seen[tid] = true;
    ids.push(tid);
  });
  if (!ids.length) return { ok: true, byScheduleId: byScheduleId };

  try {
    var cfg = SUPA_CFG_();
    var token = supaToken_(cfg);
    if (!token) return { ok: false, byScheduleId: byScheduleId, error: 'Supabase 봇 토큰 없음' };
    var headers = {
      apikey: cfg.apikey,
      Authorization: 'Bearer ' + token,
      'Accept-Profile': 'village'
    };
    var CHUNK = 40;
    for (var offset = 0; offset < ids.length; offset += CHUNK) {
      var chunk = ids.slice(offset, offset + CHUNK);
      var inList = '(' + chunk.map(function(tid) {
        return '"' + String(tid).replace(/"/g, '') + '"';
      }).join(',') + ')';
      var res = supaSyncFetch_(
        cfg.url + '/rest/v1/schedule_items?select=trade_id,schedule_id,checkout_state,updated_at,removed_at&removed_at=is.null'
          + '&trade_id=in.' + encodeURIComponent(inList)
          + '&limit=2000',
        { method: 'get', headers: headers, muteHttpExceptions: true }
      );
      var code = res.getResponseCode();
      if (code >= 300) {
        return {
          ok: false,
          byScheduleId: byScheduleId,
          error: 'Supabase 품목 체크 조회 실패 (' + code + ')'
        };
      }
      var rows = [];
      try { rows = JSON.parse(res.getContentText() || '[]') || []; } catch (parseErr) { rows = []; }
      rows.forEach(function(row) {
        var sid = String(row && row.schedule_id || '').trim();
        if (!sid) return;
        byScheduleId[sid] = String(row.checkout_state || '').trim();
        if (ids.indexOf(row.trade_id) >= 0 && validCheckoutVersion_(row.updated_at)) byUpdatedAt[sid] = row.updated_at;
      });
    }
    return { ok: true, byScheduleId: byScheduleId, byUpdatedAt: byUpdatedAt };
  } catch (err) {
    return {
      ok: false,
      byScheduleId: byScheduleId,
      error: 'Supabase 품목 체크 조회 오류: ' + (err && err.message ? err.message : String(err))
    };
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
    var res = supaSyncFetch_(url, {
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
    var itemRes = supaSyncFetch_(
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
    // taken_qty > 0은 물리 반출의 불변 기준선이다. 과거 버전이 removed_at을 잘못
    // 기록했어도 반납 완료 검증에서는 반드시 다시 포함한다.
    var scheduleItems = JSON.parse(itemRes.getContentText() || '[]') || [];
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
    // 로컬 ScriptProperties가 소실돼도 완료 거래를 신규 예약처럼 upsert하지 않도록
    // 거래 권한 상태와 taken_qty 기준선을 한 번에 확인한다.
    var responses = supaSyncFetchAll_([
      {
        url: cfg.url + '/rest/v1/trades?select=trade_id,setup_done,setup_done_at,return_done,contract_status'
          + '&trade_id=eq.' + encodeURIComponent(tid),
        method: 'get',
        headers: {
          apikey: cfg.apikey,
          Authorization: 'Bearer ' + token,
          'Accept-Profile': 'village'
        },
        muteHttpExceptions: true
      },
      {
        url: cfg.url + '/rest/v1/schedule_items?select=schedule_id,name,qty,taken_qty,actual_name,actual_taken_qty,set_name,is_set_header,is_component,checkout_state,onsite,removed_at'
          + '&trade_id=eq.' + encodeURIComponent(tid) + '&taken_qty=gt.0&order=sort.asc',
        method: 'get',
        headers: {
          apikey: cfg.apikey,
          Authorization: 'Bearer ' + token,
          'Accept-Profile': 'village'
        },
        muteHttpExceptions: true
      }
    ]);
    var tradeRes = responses[0];
    var itemRes = responses[1];
    var tradeCode = tradeRes.getResponseCode();
    var itemCode = itemRes.getResponseCode();
    if (tradeCode >= 300 || itemCode >= 300) {
      return {
        ok: false,
        error: 'Supabase 반출 상태 조회 실패 (거래 ' + tradeCode + ' / 품목 ' + itemCode + ')',
        started: false,
        items: []
      };
    }
    var tradeRows = JSON.parse(tradeRes.getContentText() || '[]') || [];
    if (tradeRows.length > 1) {
      return { ok: false, error: 'Supabase 거래 상태 중복: ' + tid, started: false, items: [] };
    }
    var trade = tradeRows[0] || {};
    var items = JSON.parse(itemRes.getContentText() || '[]') || [];
    var contractStatus = String(trade.contract_status || '').trim();
    var setupDone = trade.setup_done === true;
    var returnDone = trade.return_done === true;
    return {
      ok: true,
      tradeFound: tradeRows.length === 1,
      setupDone: setupDone,
      setupDoneAt: String(trade.setup_done_at || '').trim() || null,
      returnDone: returnDone,
      contractStatus: contractStatus,
      started: items.length > 0 || setupDone || returnDone ||
        contractStatus === '반출' || contractStatus === '반출중' || contractStatus === '반납완료',
      items: items
    };
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
var SUPA_DIRTY_PREFIX_ = 'SUPA_DIRTY_v2_';

function supaDirtyPropertyKey_(tid) {
  return SUPA_DIRTY_PREFIX_ + String(tid || '').trim();
}

function supaMarkTradeDirty_(tid) {
  var lock = null, acquired = false;
  try {
    tid = String(tid || '').trim();
    if (!tid) return;
    var p = PropertiesService.getScriptProperties();
    var revision = String(Date.now()) + ':' + String(Math.random()).slice(2);
    lock = LockService.getScriptLock();
    if (!lock.hasLock()) acquired = lock.tryLock(1000);
    if (acquired || lock.hasLock()) p.setProperty(supaDirtyPropertyKey_(tid), revision);
    else {
      // Coalesce contention by trade, not event: repeated edits cannot grow property history.
      // The existing worker merges before reading fresh source; no new trigger or HTTP.
      p.setProperty('SUPA_DIRTY_PENDING_v1_' + encodeURIComponent(tid), JSON.stringify({ tid: tid }));
    }
    if (typeof requestInventoryRiskScan_ === 'function') requestInventoryRiskScan_();
  } catch (err) {
    // Keep the original non-throwing edit contract; persistence failure is operationally visible.
    Logger.log('Supabase 변경 표식 저장 실패');
  } finally { if (acquired) lock.releaseLock(); }
}

/** 이전 배포의 단일 JSON dirty 표식을 거래별 키로 한 번 옮긴다. */
function migrateLegacySupaDirtyProperties_(p) {
  var legacyRaw = String(p.getProperty('SUPA_DIRTY') || '');
  if (!legacyRaw) return;
  var legacy = {};
  try { legacy = JSON.parse(legacyRaw || '{}'); } catch (parseErr) { return; }
  Object.keys(legacy || {}).forEach(function(tid) {
    var cleanTid = String(tid || '').trim();
    if (!cleanTid) return;
    var key = supaDirtyPropertyKey_(cleanTid);
    if (!p.getProperty(key)) p.setProperty(key, String(legacy[tid] || Date.now()) + ':legacy');
  });
  p.deleteProperty('SUPA_DIRTY');
}

/** 상시 1분 트리거가 one-shot 생성 실패/강제종료 뒤 남은 내구 큐를 다시 깨운다. */
function rescueDashboardAsyncWorkerTriggers_() {
  try {
    var props = PropertiesService.getScriptProperties();
    var all = props.getProperties();
    var keys = Object.keys(all);
    if (typeof ensureDashboardStructureProjectionTrigger_ === 'function' && keys.some(function(key) {
      return key.indexOf('dashboardStructureQueue_v1_') === 0;
    })) ensureDashboardStructureProjectionTrigger_(1000);
    if (typeof ensureContractRegenTrigger_ === 'function' && keys.some(function(key) {
      return key.indexOf('contractEditTS_') === 0;
    })) ensureContractRegenTrigger_();
    if (typeof ensureCancelledTradeCleanupTrigger_ === 'function' && keys.some(function(key) {
      return key.indexOf('cancelCleanup_v1_') === 0;
    })) ensureCancelledTradeCleanupTrigger_(1000);
    // 등록 시 고객DB 쓰기 실패분 재시도 (checkAvailability.js drainPendingCustomerDbWrites_)
    if (typeof drainPendingCustomerDbWrites_ === 'function' && keys.some(function(key) {
      return key.indexOf('customerDbPending_v1_') === 0;
    })) drainPendingCustomerDbWrites_();
    // 날짜변경 등에서 실패한 거래내역(개고생2.0) 동기화 재시도
    if (typeof drainPendingTradeLedgerSyncs_ === 'function' && keys.some(function(key) {
      return key.indexOf('tradeLedgerSyncPending_v1_') === 0;
    })) drainPendingTradeLedgerSyncs_();
  } catch (rescueErr) {
    Logger.log('비동기 worker rescue 보류: ' + rescueErr);
  }
}

/** 여러 거래의 Supabase 반출 권한 신호를 두 종류의 배치 조회로 확인한다. */
function supaGetCheckoutAuthorityStates_(tids) {
  tids = (tids || []).map(function(tid) { return String(tid || '').trim(); }).filter(Boolean);
  var states = {};
  tids.forEach(function(tid) { states[tid] = { started: false, tradeFound: false, baselineFound: false }; });
  if (!tids.length) return { ok: true, states: states };
  try {
    var cfg = SUPA_CFG_();
    var token = supaToken_(cfg);
    if (!token) return { ok: false, error: 'Supabase 봇 토큰 없음', states: states };
    var headers = {
      apikey: cfg.apikey,
      Authorization: 'Bearer ' + token,
      'Accept-Profile': 'village'
    };
    for (var offset = 0; offset < tids.length; offset += 50) {
      var chunk = tids.slice(offset, offset + 50);
      var inList = chunk.map(function(tid) { return '"' + tid.replace(/"/g, '') + '"'; }).join(',');
      var responses = supaSyncFetchAll_([
        {
          url: cfg.url + '/rest/v1/trades?select=trade_id,setup_done,return_done,contract_status'
            + '&trade_id=in.(' + encodeURIComponent(inList) + ')',
          method: 'get', headers: headers, muteHttpExceptions: true
        },
        {
          url: cfg.url + '/rest/v1/schedule_items?select=trade_id'
            + '&trade_id=in.(' + encodeURIComponent(inList) + ')'
            + '&taken_qty=gt.0',
          method: 'get', headers: headers, muteHttpExceptions: true
        }
      ]);
      var tradeCode = responses[0].getResponseCode();
      var itemCode = responses[1].getResponseCode();
      if (tradeCode >= 300 || itemCode >= 300) {
        return {
          ok: false,
          error: 'Supabase 반출 권한 배치 조회 실패 (거래 ' + tradeCode + ' / 품목 ' + itemCode + ')',
          states: states
        };
      }
      var tradeRows = JSON.parse(responses[0].getContentText() || '[]') || [];
      tradeRows.forEach(function(row) {
        var tid = String(row.trade_id || '').trim();
        if (!states[tid]) return;
        var status = String(row.contract_status || '').trim();
        states[tid].tradeFound = true;
        states[tid].started = row.setup_done === true || row.return_done === true ||
          status === '반출' || status === '반출중' || status === '반납완료';
      });
      var itemRows = JSON.parse(responses[1].getContentText() || '[]') || [];
      itemRows.forEach(function(row) {
        var tid = String(row.trade_id || '').trim();
        if (!states[tid]) return;
        states[tid].baselineFound = true;
        states[tid].started = true;
      });
    }
    return { ok: true, states: states };
  } catch (err) {
    return {
      ok: false,
      error: 'Supabase 반출 권한 배치 조회 오류: ' + (err && err.message ? err.message : String(err)),
      states: states
    };
  }
}

/** trades.note_checkin은 앱이 정본이다(remote.ts tradeStructureRow 선언).
 * 시트 실사기록의 returnMemo는 비어 있는 노트를 시드할 때만 채우고, 앱이 이미 쓴
 * 값은 덮어쓰지 않는다. 현재값 조회가 실패하면 보수적으로 노트를 보내지 않는다. */
function supaDropOverwritingNotes_(cfg, tradeRows) {
  var withNotes = (tradeRows || []).filter(function(row) {
    return row && Object.prototype.hasOwnProperty.call(row, 'note_checkin');
  });
  if (!withNotes.length) return;
  try {
    var token = supaToken_(cfg);
    if (!token) throw new Error('봇 토큰 없음');
    var idList = withNotes.map(function(row) { return String(row.trade_id || '').trim(); }).filter(Boolean);
    var res = supaSyncFetch_(
      cfg.url + '/rest/v1/trades?select=trade_id,note_checkin&trade_id=in.('
        + encodeURIComponent(idList.join(',')) + ')',
      {
        method: 'get',
        headers: { apikey: cfg.apikey, Authorization: 'Bearer ' + token, 'Accept-Profile': 'village' },
        muteHttpExceptions: true
      }
    );
    if (res.getResponseCode() >= 300) throw new Error('노트 조회 실패 ' + res.getResponseCode());
    var existing = {};
    (JSON.parse(res.getContentText() || '[]') || []).forEach(function(row) {
      existing[String(row.trade_id || '').trim()] = String(row.note_checkin || '').trim();
    });
    withNotes.forEach(function(row) {
      if (existing[String(row.trade_id || '').trim()]) delete row.note_checkin;
    });
  } catch (noteErr) {
    // 조회 불가 — 앱 노트 보호를 우선해 이번 주기에는 노트를 보내지 않는다
    withNotes.forEach(function(row) { delete row.note_checkin; });
  }
}

/** 1분 트리거 — dirty 거래들을 빌드해 Supabase upsert 후 클리어. */
function flushDirtyToSupabase() {
  rescueDashboardAsyncWorkerTriggers_();
  var cfg = SUPA_CFG_();
  if (!cfg.url || !cfg.apikey) return;
  var p = PropertiesService.getScriptProperties(), now = Date.now();
  var lock = LockService.getScriptLock(), locked = false, snapshot = {}, retry = {}, tids = [];
  var lease = JSON.stringify({ id: String(now) + ':' + String(Math.random()), until: now + 600000 });
  try {
    locked = lock.tryLock(1000);
    if (!locked) return;
    migrateLegacySupaDirtyProperties_(p);
    supaSyncMergePendingMarks_(p);
    var all = p.getProperties();
    if (supaSyncState_(all.SUPA_SYNC_LEASE_v1).until > now) return;
    if (supaSyncState_(all.SUPA_SYNC_COOLDOWN_v1).until > now) return;
    Object.keys(all).filter(function(key) { return key.indexOf(SUPA_DIRTY_PREFIX_) === 0; }).forEach(function(key) {
      var state = supaSyncState_(all[key]);
      // The original dirty revision remains inside its existing property; no retry-history keys.
      if (state.nextAt > now && state.nextAt <= now + 21600000) return;
      var tid = key.substring(SUPA_DIRTY_PREFIX_.length);
      if (!tid) return;
      tids.push(tid); snapshot[key] = all[key]; retry[tid] = state;
    });
    if (!tids.length) return;
    // A durable ownership lease prevents HTTP overlap without holding the UI's ScriptLock.
    p.setProperty('SUPA_SYNC_LEASE_v1', lease);
  } catch (leaseError) {
    Logger.log('Supabase 동기화 실행권 저장 실패: 작업 보존');
    return;
  } finally { if (locked) lock.releaseLock(); }

  var attempt = { p: p, startedAt: now, httpRequests: 0, fetchBatches: 0, quotaBlocked: false };
  SUPA_SYNC_ATTEMPT_ = attempt;
  var outcomes = {}, deferred = {}, stage = {};
  tids.forEach(function(tid) { outcomes[tid] = false; stage[tid] = true; });
  try {
    var buildLock = LockService.getScriptLock();
    if (!buildLock.tryLock(5000)) return;
    var built;
    try { built = buildSupabaseTrades_(tids); } finally { buildLock.releaseLock(); }
    (built.deferredTradeIds || []).forEach(function(tid) { deferred[tid] = true; stage[tid] = false; });
    var eligibleTids = tids.filter(function(tid) { return !deferred[tid]; });
    var cancelledTradeIds = built.cancelledTradeIds || [];
    var represented = {};
    built.trades.forEach(function(row) { represented[row.trade_id] = true; });
    cancelledTradeIds.forEach(function(tid) { represented[tid] = true; });
    eligibleTids.forEach(function(tid) { if (!represented[tid]) stage[tid] = false; });
    if (cancelledTradeIds.length) {
      var cancellationAuthority = supaGetCheckoutAuthorityStates_(cancelledTradeIds);
      cancelledTradeIds.forEach(function(tid) {
        var authority = cancellationAuthority.states && cancellationAuthority.states[tid];
        if (!cancellationAuthority.ok || !authority || authority.started) { stage[tid] = false; return; }
        var cancelled = supaCancelTrade_(tid);
        if (!cancelled || !cancelled.ok) stage[tid] = false;
      });
    }
    if (built.trades.length) {
      supaDropOverwritingNotes_(cfg, built.trades);
      var tradeReport = {};
      var tradesOk = supaUpsertGrouped_(cfg, 'trades', built.trades, 'trade_id', tradeReport);
      supaSyncMergeReport_(stage, built.trades.map(function(row) { return row.trade_id; }), tradesOk, tradeReport);
      if (built.items.length) {
        var propSnapshot = p.getProperties();
        var durableAuthority = supaGetCheckoutAuthorityStates_(eligibleTids);
        var ssForAuthority = SpreadsheetApp.getActiveSpreadsheet(), localAuthority = {};
        eligibleTids.forEach(function(tid) {
          localAuthority[tid] = typeof isDashboardTradeCheckoutStarted_ === 'function'
            ? isDashboardTradeCheckoutStarted_(ssForAuthority, tid) : false;
        });
        var insertItems = [], patchItems = [];
        built.items.forEach(function(builtItem) {
          var tid = String(builtItem.trade_id || '').trim();
          if (!stage[tid]) return;
          var remoteStarted = durableAuthority.ok && durableAuthority.states[tid] && durableAuthority.states[tid].started;
          var checkoutStarted = !durableAuthority.ok || !!localAuthority[tid] || !!remoteStarted ||
            propSnapshot['setupDone_' + tid] === '1' || propSnapshot['returnDone_' + tid] === '1' ||
            propSnapshot['checkoutBaselineStarted_' + tid] === '1';
          if (checkoutStarted) patchItems.push(builtItem);
          else insertItems.push(Object.assign({}, builtItem, { removed_at: null }));
        });
        if (insertItems.length) {
          var insertReport = {};
          var inserted = supaUpsertGrouped_(cfg, 'schedule_items', insertItems, 'schedule_id', insertReport);
          supaSyncMergeReport_(stage, insertItems.map(function(row) { return row.trade_id; }), inserted, insertReport);
        }
        if (patchItems.length) {
          var patchReport = {};
          var patched = supaPatchExistingScheduleItems_(cfg, patchItems, patchReport);
          supaSyncMergeReport_(stage, patchItems.map(function(row) { return row.trade_id; }), patched, patchReport);
        }
      }
    }
    var paymentTids = eligibleTids.filter(function(tid) { return stage[tid]; });
    if (paymentTids.length && typeof flushPaymentLedgerMirror_ === 'function') {
      var paymentReport = {};
      var paymentOk = flushPaymentLedgerMirror_(paymentTids, paymentReport);
      supaSyncMergeReport_(stage, paymentTids, paymentOk, paymentReport);
    }
    eligibleTids.forEach(function(tid) { outcomes[tid] = stage[tid]; });
  } catch (error) {
    // No unknown or uncompleted stage is acknowledged. Quota transport has already stopped further HTTP.
    Logger.log('Supabase 동기화 보류: ' + (supaSyncDailyQuota_(error) ? 'urlfetch_daily_quota' : 'stage_failed'));
  } finally {
    SUPA_SYNC_ATTEMPT_ = null;
    var completed = 0, cleanup = LockService.getScriptLock(), cleanupLocked = false;
    try {
      cleanupLocked = cleanup.tryLock(1000);
      if (cleanupLocked && p.getProperty('SUPA_SYNC_LEASE_v1') === lease) {
        tids.forEach(function(tid) {
          var key = SUPA_DIRTY_PREFIX_ + tid;
          if (deferred[tid] || p.getProperty(key) !== snapshot[key]) return;
          if (outcomes[tid]) { p.deleteProperty(key); completed++; }
          else {
            var previous = retry[tid], failures = Math.min(16, Number(previous.failures || 0) + 1);
            p.setProperty(key, JSON.stringify({ revision: previous.revision || snapshot[key], failures: failures,
              nextAt: Date.now() + Math.min(1800000, 60000 * Math.pow(2, failures - 1)) }));
          }
        });
        if (attempt.httpRequests && !attempt.quotaBlocked) p.deleteProperty('SUPA_SYNC_COOLDOWN_v1');
      }
    } catch (cleanupError) { Logger.log('Supabase 동기화 완료표시 보류: 작업 보존'); }
    finally {
      if (cleanupLocked) {
        try { if (p.getProperty('SUPA_SYNC_LEASE_v1') === lease) p.deleteProperty('SUPA_SYNC_LEASE_v1'); }
        finally { cleanup.releaseLock(); }
      }
    }
    var summary = { type: 'supabase_sync_attempt', at: Date.now(), httpRequests: attempt.httpRequests,
      fetchBatches: attempt.fetchBatches, quotaBlocked: attempt.quotaBlocked, selected: tids.length,
      completed: completed, retained: tids.length - completed, elapsedMs: Date.now() - now };
    Logger.log(JSON.stringify(summary));
    // One bounded summary; no customer data, URLs, credentials, or per-attempt history.
    try { p.setProperty('SUPA_SYNC_LAST_v1', JSON.stringify(summary)); } catch (summaryError) {}
  }
}

var SUPA_SYNC_ATTEMPT_ = null;
function supaSyncMergePendingMarks_(p) {
  var all = p.getProperties();
  Object.keys(all).filter(function(key) { return key.indexOf('SUPA_DIRTY_PENDING_v1_') === 0; }).slice(0, 100).forEach(function(key) {
    var pending = supaSyncState_(all[key]), tid = String(pending.tid || '').trim();
    if (!tid) return;
    p.setProperty(supaDirtyPropertyKey_(tid), String(Date.now()) + ':' + String(Math.random()).slice(2));
    p.deleteProperty(key); // Source changes behind coalesced marks are read AFTER this merge; later marks remain for the next run.
  });
}
function supaSyncState_(raw) {
  try { var state = JSON.parse(raw || '{}'); return state && typeof state === 'object' ? state : {}; }
  catch (error) { return {}; }
}
function supaSyncMergeReport_(outcomes, tids, ok, report) {
  tids.forEach(function(tid) {
    if (!tid) return;
    var success = Object.prototype.hasOwnProperty.call(report, tid) ? report[tid] : ok;
    outcomes[tid] = outcomes[tid] !== false && !!success;
  });
}
function supaSyncReportRows_(report, rows, ok) {
  if (!report) return;
  rows.forEach(function(row) {
    var tid = String(row.trade_id || '').trim();
    if (tid) report[tid] = report[tid] !== false && !!ok;
  });
}
function supaSyncDailyQuota_(error) {
  var text = String(error && error.message || error || '');
  return /(?:Service invoked too many times for one day:\s*urlfetch|하루에\s*urlfetch\s*서비스를\s*너무\s*많이\s*호출)/i.test(text);
}
function supaSyncHttp_(batch, url, args) {
  var attempt = SUPA_SYNC_ATTEMPT_;
  if (attempt && attempt.quotaBlocked) throw new Error('Service invoked too many times for one day: urlfetch.');
  if (attempt) { attempt.httpRequests += batch ? url.length : 1; if (batch) attempt.fetchBatches++; }
  try { return batch ? UrlFetchApp.fetchAll(url) : UrlFetchApp.fetch(url, args); }
  catch (error) {
    if (attempt && supaSyncDailyQuota_(error)) {
      attempt.quotaBlocked = true;
      try {
        var previous = supaSyncState_(attempt.p.getProperty('SUPA_SYNC_COOLDOWN_v1'));
        var failures = Math.min(16, Number(previous.failures || 0) + 1);
        attempt.p.setProperty('SUPA_SYNC_COOLDOWN_v1', JSON.stringify({ failures: failures,
          until: Date.now() + 900000 }));
      } catch (recordError) { Logger.log('Supabase 일일 호출한도 대기 저장 실패'); }
    }
    throw error;
  }
}
function supaSyncFetch_(url, args) { return supaSyncHttp_(false, url, args); }
function supaSyncFetchAll_(requests) { return supaSyncHttp_(true, requests); }

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
    try { dd = getDashboardData(dk, false, { includeCautions: false }); } catch (x) { continue; }
    (dd.checkout || []).concat(dd.checkin || []).forEach(function (t) {
      if (want[t.tradeId] && !detail[t.tradeId]) detail[t.tradeId] = t;
    });
  }

  // Contract/amount are ledger authority, not date-wide display-cache authority.
  // forceFresh uses the existing sheet reader and adds no UrlFetch request.
  var financialById = {};
  var financialIds = Object.keys(dates);
  if (financialIds.length && typeof getTradeExtrasForIds_ === 'function') {
    try { financialById = getTradeExtrasForIds_(financialIds, null, { forceFresh: true }) || {}; }
    catch (financialReadErr) { financialById = {}; }
  }
  function applyFinancialAuthority_(row, financial) {
    row.contract_url = financial.contractUrl || null;
    row.contract_regen_pending = !!financial.contractRegenPending;
    if (typeof financial.actualAmount === 'number') row.amount = financial.actualAmount;
  }
  var deferredTradeIds = [];

  // 계약마스터 폴백/취소 판정용 — tid -> {name, status, discountType, startISO, endISO}
  var master = {};
  try {
    var mSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('계약마스터');
    if (mSheet && mSheet.getLastRow() >= 2) {
      var mRows = mSheet.getRange(2, 1, mSheet.getLastRow() - 1, 11).getValues();
      var mDisp = mSheet.getRange(2, 1, mSheet.getLastRow() - 1, 11).getDisplayValues();
      for (var mi = 0; mi < mRows.length; mi++) {
        var mTid = String(mRows[mi][0]).trim();
        if (!mTid || !want[mTid]) continue;
        var mStart = parseDT(mRows[mi][4], mDisp[mi][5]); // E,F: 반출 일시
        var mEnd = parseDT(mRows[mi][6], mDisp[mi][7]);   // G,H: 반납 일시
        master[mTid] = {
          name: String(mRows[mi][1] || '').trim(),
          phone: String(mRows[mi][2] || '').trim(),
          sourceCount: master[mTid] ? master[mTid].sourceCount + 1 : 1,
          status: String(mRows[mi][9] || '').trim(),      // J: 계약상태
          discountType: String(mRows[mi][10] || '').trim(), // K: 할인유형
          startISO: mStart ? mStart.toISOString() : null,
          endISO: mEnd ? mEnd.toISOString() : null
        };
      }
    }
  } catch (mErr) {}

  // 3) 품목: 스케줄상세 정본에서 직접 읽는다 — dashboard 캐시가 아니라.
  // 캐시에서 뽑던 시절, 등록 직후 flush가 반출일의 옛(stale) 캐시를 읽으면 detail이
  // 누락돼 골격만 올라갔고, 그 push가 "성공"이라 dirty 키가 소진돼 영원히 재시도되지
  // 않았다. 결과: 앱에 품목 0건 유령 거래 → 스케줄 화면·검색에서 통째로 안 보임
  // (2026-08-10 실제 사고: 당일 신규 등록 8건 중 4건). 정본에서 읽으면 캐시 신선도와
  // 등록-flush 타이밍이 결과에 영향을 주지 못한다.
  var sheetItems = {}; // tid -> [{scheduleId, name, qty, setName, isHeader}]
  try {
    var sSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('스케줄상세');
    if (sSheet && sSheet.getLastRow() >= 2) {
      var sRows = sSheet.getRange(2, 1, sSheet.getLastRow() - 1, 11).getValues();
      for (var si = 0; si < sRows.length; si++) {
        var sTid = String(sRows[si][1] || '').trim();
        if (!want[sTid]) continue;
        var sSet = String(sRows[si][2] || '').trim();
        var sName = String(sRows[si][3] || '').trim();
        if (!sName) continue;
        (sheetItems[sTid] = sheetItems[sTid] || []).push({
          scheduleId: String(sRows[si][0] || '').trim(),
          name: sName,
          qty: Number(sRows[si][4]) || 1,
          supplyNote: String(sRows[si][10] || "").split(/\r?\n/).filter(function(line){return /^\[(외부조달|상위대체)\]/.test(line);}).join("\n"),
          setName: sSet,
          // dashboard displayEquip과 같은 규칙: 단품 또는 세트 대표행
          isHeader: sSet === '' || sSet === sName
        });
      }
    }
  } catch (sheetErr) {
    // 시트 읽기 실패는 아래 detail 폴백이 감당한다. 여기서 던지면 flush 전체가 죽는다.
  }

  function buildItemsForTrade_(tid, d) {
    var eqs = sheetItems[tid];
    if (eqs && eqs.length) {
      // category는 부가 정보 — detail(dashboard)이 있으면 이름으로 보강, 없으면 null
      var catMap = {};
      if (d) (d.equipments || []).forEach(function (de) { if (de.category) catMap[de.name] = de.category; });
      return eqs.map(function (eq, k) {
        return {
          schedule_id: eq.scheduleId,
          trade_id: tid,
          sort: k,
          name: eq.name,
          qty: eq.qty,
          supply_note: eq.supplyNote || "",
          set_name: eq.setName || null,
          is_set_header: eq.isHeader,
          is_component: !!eq.setName && !eq.isHeader,
          category: catMap[eq.name] || null
        };
      });
    }
    // 시트 읽기 실패 시에만 dashboard detail로 폴백
    return (d && d.equipments || []).map(function (e2, k) {
      return {
        schedule_id: e2.scheduleId,
        trade_id: tid,
        sort: k,
        name: e2.name,
        qty: Number(e2.qty) || 1,
        set_name: e2.setName || null,
        is_set_header: !!e2.isHeader,
        is_component: !!e2.isComponent,
        category: e2.category || null
      };
    });
  }

  var trades = [], items = [];
  var cancelledTradeIds = Object.keys(master).filter(function(tid) {
    return master[tid].status === '취소';
  });
  for (var tid2 in dates) {
    // 취소 원본이 stale timeline/dashboard보다 우선한다. 옛 캐시의 장비를
    // fallback으로 되살리지 않고 전용 취소 투영에 맡긴다.
    if (cancelledTradeIds.indexOf(tid2) >= 0) continue;
    var financial = financialById[tid2];
    if (!financial || financial.tradeRowFound !== true) {
      deferredTradeIds.push(tid2);
      continue; // Retain the dirty marker; no stale/null projection HTTP for this trade.
    }
    var d = detail[tid2] || null;
    var m = master[tid2] || {};
    var startISO = new Date(dates[tid2].start).toISOString();
    var endISO = new Date(dates[tid2].end).toISOString();

    if (!d) {
      // 상세 조회 실패/누락 — 운영 필드를 기본값으로 덮어쓰지 않도록 골격만 부분 upsert.
      // 품목은 정본에서 이미 확보했으므로 detail 유무와 무관하게 함께 올린다.
      var skeleton = { trade_id: tid2, checkout_at: startISO, return_at: endISO };
      if (m.name) skeleton.customer_name = m.name;
      if (m.discountType) skeleton.discount_type = m.discountType;
      applyFinancialAuthority_(skeleton, financial);
      trades.push(skeleton);
      items = items.concat(buildItemsForTrade_(tid2, null));
      continue;
    }

    var row = {
      trade_id: tid2,
      customer_phone: d.tel || null,
      company: d.company || null,
      checkout_at: startISO,
      return_at: endISO,
      discount_type: d.discountType || m.discountType || null
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
    applyFinancialAuthority_(row, financial);
    if (d.returnMemo) row.note_checkin = d.returnMemo; // 앱 입력 메모를 null로 지우지 않음
    trades.push(row);

    // checkout_state는 toggleItemCheck의 GAS+Supabase 단일 writer만 쓴다. 1분 dirty
    // worker의 오래된 snapshot이 최신 체크/해제를 되돌리지 않도록 여기서는 항상 제외한다.
    // 품목 목록 자체는 스케줄상세 정본 기준 — stale dashboard 캐시가 품목을 누락/과잉
    // 시키지 못한다.
    items = items.concat(buildItemsForTrade_(tid2, d));
  }

  // 최근 30일 윈도우 밖 거래도 금액/계약서 정본은 거래내역에 있다. 옛 거래의
  // 할인유형 복원이 골격만 만들거나 stale 금액을 영구 보존하지 않도록 1회 읽는다.
  // 고객/연락처/반출일/유일한 문서 연결이 확인된 값만 복사하며 정산 상태는 쓰지 않는다.
  var archivalFinancial = {};
  var archivalIds = Object.keys(want).filter(function(id) {
    return !dates[id] && master[id] && master[id].startISO && master[id].endISO && cancelledTradeIds.indexOf(id) < 0;
  });
  if (archivalIds.length && typeof openTradeLedgerContext_ === 'function') {
    var archivalProps = PropertiesService.getScriptProperties().getProperties();
    var ledgerContext = openTradeLedgerContext_(), ledgerSheet = ledgerContext.sheet;
    var ledgerRows = ledgerSheet.getLastRow() > 1 ? ledgerSheet.getRange(2, 1, ledgerSheet.getLastRow() - 1, 9).getValues() : [];
    var ledgerById = {}, documentCounts = {};
    function documentId(value) {
      var match = String(value || '').trim().match(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/([\w-]+)(?:\/|$)/);
      return match ? match[1] : '';
    }
    function phoneDigits(value) {
      var digits = String(value || '').replace(/\D/g, '');
      if (digits.indexOf('82') === 0) digits = '0' + digits.slice(2);
      if (digits.length === 10 && digits.indexOf('10') === 0) digits = '0' + digits;
      return digits;
    }
    function ledgerDate(value) {
      if (value instanceof Date) return Utilities.formatDate(value, ledgerContext.spreadsheet.getSpreadsheetTimeZone(), 'yyyy-MM-dd');
      var match = String(value || '').match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:\D|$)/);
      return match ? match[1] + '-' + ('0' + match[2]).slice(-2) + '-' + ('0' + match[3]).slice(-2) : '';
    }
    ledgerRows.forEach(function(row) {
      var id = String(row[4] || '').trim(), file = documentId(row[2]);
      if (want[id]) (ledgerById[id] || (ledgerById[id] = [])).push(row);
      if (file) documentCounts[file] = (documentCounts[file] || 0) + 1;
    });
    archivalIds.forEach(function(id) {
      var m = master[id], matches = ledgerById[id] || [];
      if (m.sourceCount !== 1 || matches.length !== 1 || archivalProps['contractEditTS_' + id] ||
          archivalProps['contractRegenClaim_v1_' + id] || archivalProps['contractDirectRegen_v1_' + id] ||
          archivalProps['registeredTradePriceMutation_' + id]) return;
      var row = matches[0], file = documentId(row[2]), tel = phoneDigits(m.phone);
      if (!tel || phoneDigits(row[5]) !== tel || String(row[1] || '').trim() !== m.name ||
          ledgerDate(row[0]) !== Utilities.formatDate(new Date(m.startISO), 'Asia/Seoul', 'yyyy-MM-dd') ||
          !file || documentCounts[file] !== 1 || !Number.isSafeInteger(row[8]) || row[8] <= 0) return;
      archivalFinancial[id] = { amount: row[8], contract_url: String(row[2]).trim() };
    });
  }

  // 취소/과거 등 timeline에 더는 없는 거래 — 계약마스터 기준으로 상태 반영 (조용한 유실 방지)
  for (var wTid in want) {
    if (cancelledTradeIds.indexOf(wTid) >= 0) continue;
    if (dates[wTid]) continue;
    var wm = master[wTid];
    if (!wm || !wm.startISO || !wm.endISO) continue; // 계약마스터에도 없으면 보류
    var cancelled = {
      trade_id: wTid,
      checkout_at: wm.startISO,
      return_at: wm.endISO,
      discount_type: wm.discountType || null
    };
    if (wm.name) cancelled.customer_name = wm.name;
    if (archivalFinancial[wTid]) {
      cancelled.amount = archivalFinancial[wTid].amount;
      cancelled.contract_url = archivalFinancial[wTid].contract_url;
    }
    trades.push(cancelled);
  }

  return { trades: trades, items: items, cancelledTradeIds: cancelledTradeIds, deferredTradeIds: deferredTradeIds };
}

/** payload 키 구성이 같은 행끼리 묶어 upsert — PostgREST는 배치 내 키 불일치를 거부하므로.
 *  반환: 모든 그룹이 성공했을 때만 true (하나라도 실패하면 false → 호출부가 dirty 유지). */
function supaUpsertGrouped_(cfg, table, rows, conflict, report) {
  var groups = {};
  for (var i = 0; i < rows.length; i++) {
    var sig = Object.keys(rows[i]).sort().join(',');
    (groups[sig] = groups[sig] || []).push(rows[i]);
  }
  var allOk = true;
  for (var sig2 in groups) {
    var groupOk = supaUpsert_(cfg, table, groups[sig2], conflict);
    supaSyncReportRows_(report, groups[sig2], groupOk);
    if (!groupOk) allOk = false;
  }
  return allOk;
}

/** 시트 추가 작업이 발급한 ID만 투영한다. 충돌 행은 수정하지 않으며 실제 반출을 추정하지 않는다. */
function supaInsertAuthorizedScheduleItems_(cfg, tid, rows, addedScheduleIds) {
  addedScheduleIds = addedScheduleIds || [];
  if (!addedScheduleIds.length) return true;
  var byId = Object.create(null);
  (rows || []).forEach(function(row) { byId[row.schedule_id] = row; });
  var inserts = [];
  var seen = Object.create(null);
  for (var i = 0; i < addedScheduleIds.length; i++) {
    var id = String(addedScheduleIds[i] || '').trim();
    var row = byId[id];
    if (!row || row.trade_id !== tid || id.indexOf(tid + '-') !== 0 || !row.name ||
        !Number.isInteger(row.qty) || row.qty < 1) return false;
    if (seen[id]) continue;
    seen[id] = true;
    // UI 소유 상태/불변 기준선은 복사하지 않는다. 재시도도 이미 존재하는 행을 덮지 않는다.
    inserts.push({ schedule_id: id, trade_id: tid, sort: row.sort, name: row.name, qty: row.qty,
      set_name: row.set_name || null, is_set_header: !!row.is_set_header,
      is_component: !!row.is_component, category: row.category || null, supply_note: row.supply_note || '', checkout_state: 'pending' });
  }
  var token = supaToken_(cfg);
  if (!token) return false;
  var response = supaSyncFetch_(cfg.url + '/rest/v1/schedule_items?on_conflict=schedule_id', {
    method: 'post', contentType: 'application/json',
    headers: { apikey: cfg.apikey, Authorization: 'Bearer ' + token,
      'Content-Profile': 'village', 'Accept-Profile': 'village',
      Prefer: 'resolution=ignore-duplicates,return=minimal' },
    payload: JSON.stringify(inserts), muteHttpExceptions: true
  });
  return response.getResponseCode() >= 200 && response.getResponseCode() < 300;
}

/** 반출 후 schedule_items 구조 동기화. PATCH만 사용해 기준선 없는 행을
 * 신규 생성하지 않고, 한 행이라도 없으면 실패로 돌려 안전 복구 큐가 담당하게 한다. */
function supaPatchExistingScheduleItems_(cfg, rows, report) {
  if (!rows || !rows.length) return true;
  var token = supaToken_(cfg);
  if (!token) { Logger.log('봇 토큰 없음 → schedule_items PATCH 중단'); return false; }
  var byId = {};
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i] || {};
    var scheduleId = String(row.schedule_id || '').trim();
    var tradeId = String(row.trade_id || '').trim();
    if (!scheduleId || !tradeId) continue;
    byId[scheduleId] = row;
  }
  var ids = Object.keys(byId), allOk = true;
  for (var offset = 0; offset < ids.length; offset += 50) {
    var chunk = ids.slice(offset, offset + 50);
    var requests = chunk.map(function(scheduleId) {
      var source = byId[scheduleId];
      var payload = {};
      Object.keys(source).forEach(function(key) {
        if (key !== 'schedule_id' && key !== 'trade_id') payload[key] = source[key];
      });
      return {
        url: cfg.url + '/rest/v1/schedule_items'
          + '?trade_id=eq.' + encodeURIComponent(String(source.trade_id || '').trim())
          + '&schedule_id=eq.' + encodeURIComponent(scheduleId),
        method: 'patch',
        contentType: 'application/json',
        headers: {
          apikey: cfg.apikey,
          Authorization: 'Bearer ' + token,
          'Content-Profile': 'village',
          'Accept-Profile': 'village',
          Prefer: 'return=representation'
        },
        payload: JSON.stringify(payload),
        muteHttpExceptions: true
      };
    });
    var responses;
    try { responses = supaSyncFetchAll_(requests); }
    catch (fetchErr) {
      Logger.log('Supabase schedule_items PATCH 오류: ' + fetchErr.message);
      supaSyncReportRows_(report, ids.slice(offset).map(function(id) { return byId[id]; }), false);
      return false;
    }
    for (var ri = 0; ri < chunk.length; ri++) {
      var response = responses[ri], returned = [], code = response ? response.getResponseCode() : 0;
      try { returned = response ? JSON.parse(response.getContentText() || '[]') : []; } catch (parseErr) {}
      var source = byId[chunk[ri]];
      var ok = code >= 200 && code < 300 && Array.isArray(returned) && returned.length === 1
        && returned[0].schedule_id === source.schedule_id && returned[0].trade_id === source.trade_id;
      supaSyncReportRows_(report, [source], ok);
      if (!ok) allOk = false;
    }
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
  var res = supaSyncFetch_(cfg.url + '/rest/v1/' + table + '?on_conflict=' + conflict, {
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
  var res = supaSyncFetch_(url, {
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
  if ((built.deferredTradeIds || []).length) {
    throw new Error('계약 원장 조회 보류: 전체 동기화를 완료할 수 없습니다');
  }
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
  // Metadata only: values may contain credentials or customer notification receipts.
  var storage = { keyBytes: 0, valueBytes: 0, totalBytes: 0, categories: [], largest: [] };
  var storageCategories = {};
  keys.forEach(function (k) {
    var pre = /^(itemCheck|setupDone|setupDoneAt)_/.test(k) ? k.split('_')[0] + '_*' : k;
    cat[pre] = (cat[pre] || 0) + 1;
    var prefix = k.replace(/(?:RQ-)?\d{6}-\d{3,}.*$/, '*');
    if (prefix === k) prefix = k.replace(/_[a-f0-9-]{16,}$/i, '_*');
    var keyBytes = Utilities.newBlob(k).getBytes().length;
    var valueBytes = Utilities.newBlob(String(all[k] || '')).getBytes().length;
    var totalBytes = keyBytes + valueBytes;
    var category = storageCategories[prefix] || (storageCategories[prefix] = {
      prefix: prefix, count: 0, keyBytes: 0, valueBytes: 0, totalBytes: 0
    });
    category.count++;
    category.keyBytes += keyBytes;
    category.valueBytes += valueBytes;
    category.totalBytes += totalBytes;
    storage.keyBytes += keyBytes;
    storage.valueBytes += valueBytes;
    storage.totalBytes += totalBytes;
    storage.largest.push({ key: k, keyBytes: keyBytes, valueBytes: valueBytes, totalBytes: totalBytes });
  });
  storage.categories = Object.keys(storageCategories).map(function(prefix) { return storageCategories[prefix]; })
    .sort(function(a, b) { return b.totalBytes - a.totalBytes; });
  storage.largest.sort(function(a, b) { return b.totalBytes - a.totalBytes; });
  storage.largest = storage.largest.slice(0, 30);
  Logger.log('총 속성: ' + keys.length + '개');
  Logger.log('── 종류별 ──');
  Object.keys(cat).sort(function (a, b) { return cat[b] - cat[a]; }).forEach(function (pre) {
    if (cat[pre] > 1) Logger.log('  ' + pre + ' : ' + cat[pre] + '개');
  });
  var config = keys.filter(function (k) { return !/^(itemCheck|setupDone|setupDoneAt|checkoutBaselineStarted)_/.test(k); });
  Logger.log('── 설정/기타(보존해야 함) ' + config.length + '개 ──');
  Logger.log('  ' + config.join('\n  '));
  // 내부 운영 진단에는 취소 큐의 진행 상태만 반환한다. 설정값/토큰은 반환하지 않는다.
  var cancellations = keys.filter(function(k) {
    return k.indexOf('cancelCleanup_v1_') === 0;
  }).map(function(k) {
    var state = parseCancelledTradeCleanup_(all[k], k.substring('cancelCleanup_v1_'.length));
    return {
      tradeId: state.tradeId, status: state.status, attempts: state.attempts,
      queuedAt: Number(state.queuedAt || 0), nextAt: state.nextAt,
      leaseUntil: state.leaseUntil,
      completed: { supabase: !!state.completed.supabase,
        externalLedger: !!state.completed.externalLedger, drive: !!state.completed.drive },
      lastError: String(state.lastError || '').replace(/https?:\/\/\S+/g, '[url]').slice(0, 1000)
    };
  });
  return { propertyCount: keys.length, storage: storage, cancellations: cancellations,
    supabaseSync: { protocolVersion: 1, lastAttempt: supaSyncState_(all.SUPA_SYNC_LAST_v1),
      cooldown: supaSyncState_(all.SUPA_SYNC_COOLDOWN_v1), leaseUntil: Number(supaSyncState_(all.SUPA_SYNC_LEASE_v1).until || 0) },
    dashboardPhotoUploads: auditDashboardPhotoUploadClaims_(all, Date.now()),
    cancellationTriggerAt: Number(all.cancelCleanupTriggerAt_v1 || 0),
    cancellationDirty: cancellations.filter(function(s) {
      return !!all[SUPA_DIRTY_PREFIX_ + s.tradeId];
    }).map(function(s) { return s.tradeId; }) };

}

/** Read-only photo-claim metadata. Expiry eligibility is not deletion authority. */
function auditDashboardPhotoUploadClaims_(all, now) {
  var prefix = 'dashboardPhotoUpload_v2_';
  var ttlMs = 24 * 60 * 60 * 1000;
  var keys = Object.keys(all).filter(function(key) { return key.indexOf(prefix) === 0; });
  var audit = {
    namespace: prefix, auditedAt: now, count: keys.length,
    keyBytes: 0, valueBytes: 0, totalBytes: 0, invalidJsonCount: 0,
    legacyCleanupEligibleCount: 0, legacyCleanupEligibleBytes: 0, legacyCleanupEvaluationErrors: 0,
    policy: { source: 'cleanupDashboardPhotoUploadClaims_', ttlMs: ttlMs,
      stateIndependent: true, deletionExecuted: false, backupRequired: true },
    ledgerReadback: keys.length ? 'unavailable' : 'not_needed',
    driveReadback: 'not_checked', ledgerStatusCounts: {}, byState: {},
    entries: [], entriesTruncated: Math.max(0, keys.length - 200)
  };
  var rows = [];
  var schema = null;
  if (keys.length) {
    try {
      var sheet = getDashboardPhotoSheet_(true);
      schema = getDashboardPhotoSchema_(sheet);
      if (!schema.tradeIdCol) throw new Error('missing_trade_column');
      var rowCount = Math.max(0, sheet.getLastRow() - 1);
      if (rowCount) rows = sheet.getRange(2, 1, rowCount, Math.max(sheet.getLastColumn(), schema.maxCol || 1)).getDisplayValues();
      audit.ledgerReadback = 'read';
      audit.ledgerRowCount = rows.length;
    } catch (readError) {
      // Do not return raw errors: they can contain spreadsheet URLs or tokens.
      audit.ledgerReadback = 'unavailable';
    }
  }
  keys.forEach(function(key, index) {
    var raw = String(all[key] || '');
    var parsed = null;
    var parseStatus = 'object';
    try { parsed = JSON.parse(raw); } catch (parseError) { parseStatus = 'invalid_json'; audit.invalidJsonCount++; }
    var validObject = parsed && typeof parsed === 'object' && !Array.isArray(parsed);
    if (parseStatus === 'object' && !validObject) parseStatus = 'invalid_shape';
    var claim = validObject ? parsed : {};
    var state = ['pending', 'file', 'done'].indexOf(claim.state) >= 0 ? claim.state : 'unknown';
    // Completed claims may omit exact duplicates already preserved in result.
    // Expand only absent fields for readback; present conflicts remain evidence.
    var compactResult = claim.result;
    var compactPhoto = compactResult && compactResult.photo;
    if (state === 'done' && compactResult && typeof compactResult === 'object' && !Array.isArray(compactResult)
      && compactResult.success === true && typeof compactResult.tid === 'string' && compactResult.tid
      && ['checkout', 'checkin'].indexOf(compactResult.phase) >= 0
      && claim.scope === compactResult.tid + '|' + compactResult.phase
      && compactPhoto && typeof compactPhoto === 'object' && !Array.isArray(compactPhoto)
      && compactPhoto.phase === compactResult.phase && typeof compactPhoto.fileId === 'string' && compactPhoto.fileId
      && typeof compactPhoto.sheetValue === 'string' && compactPhoto.sheetValue
      && typeof compactPhoto.row === 'number' && isFinite(compactPhoto.row) && compactPhoto.row >= 2 && Math.floor(compactPhoto.row) === compactPhoto.row) {
      var expandedClaim = Object.create(null);
      Object.keys(claim).forEach(function(field) { expandedClaim[field] = claim[field]; });
      var identityFields = { tid: compactResult.tid, phase: compactResult.phase, fileId: compactPhoto.fileId,
        relativePath: compactPhoto.sheetValue, row: compactPhoto.row };
      Object.keys(identityFields).forEach(function(field) {
        if (!Object.prototype.hasOwnProperty.call(expandedClaim, field)) expandedClaim[field] = identityFields[field];
      });
      claim = expandedClaim;
    }
    var at = typeof claim.at === 'number' || typeof claim.at === 'string' ? Number(claim.at) : NaN;
    var timestampStatus = !claim.at ? 'missing' : (!isFinite(at) || at <= 0 ? 'invalid' : (at > now ? 'future' : 'valid'));
    var knownAt = timestampStatus === 'valid' || timestampStatus === 'future';
    var ageMs = knownAt ? now - at : null;
    // Match the current cleanup predicate exactly, including its NaN behavior.
    var eligible = null;
    try { eligible = !parsed || !parsed.at || now - Number(parsed.at) > ttlMs; }
    catch (cleanupEvaluationError) { audit.legacyCleanupEvaluationErrors++; }
    var keyBytes = Utilities.newBlob(key).getBytes().length;
    var valueBytes = Utilities.newBlob(raw).getBytes().length;
    var totalBytes = keyBytes + valueBytes;
    var bucket = audit.byState[state] || (audit.byState[state] = {
      count: 0, keyBytes: 0, valueBytes: 0, totalBytes: 0, legacyCleanupEligibleCount: 0,
      oldestAgeMs: null, newestAgeMs: null, invalidTimestampCount: 0
    });
    bucket.count++;
    bucket.keyBytes += keyBytes; bucket.valueBytes += valueBytes; bucket.totalBytes += totalBytes;
    if (eligible) { bucket.legacyCleanupEligibleCount++; audit.legacyCleanupEligibleCount++; audit.legacyCleanupEligibleBytes += totalBytes; }
    if (knownAt) {
      bucket.oldestAgeMs = bucket.oldestAgeMs === null ? ageMs : Math.max(bucket.oldestAgeMs, ageMs);
      bucket.newestAgeMs = bucket.newestAgeMs === null ? ageMs : Math.min(bucket.newestAgeMs, ageMs);
    } else bucket.invalidTimestampCount++;
    audit.keyBytes += keyBytes; audit.valueBytes += valueBytes; audit.totalBytes += totalBytes;
    var receipt = claim.result;
    var receiptStatus = 'absent';
    if (receipt != null) {
      var receiptRow = receipt && receipt.photo && (typeof receipt.photo.row === 'number' || typeof receipt.photo.row === 'string') ? Number(receipt.photo.row) : 0;
      var claimRow = typeof claim.row === 'number' || typeof claim.row === 'string' ? Number(claim.row) : 0;
      if (!receipt || typeof receipt !== 'object' || !receipt.photo || typeof receipt.tid !== 'string' || !receipt.tid
        || typeof receipt.phase !== 'string' || !receipt.phase || typeof receipt.photo.fileId !== 'string' || !receipt.photo.fileId
        || !isFinite(receiptRow) || receiptRow <= 0) receiptStatus = 'invalid_shape';
      else if (receipt.success !== true) receiptStatus = 'not_success';
      else if (receipt.tid !== claim.tid || receipt.phase !== claim.phase || receipt.photo.fileId !== claim.fileId
        || (receipt.photo.sheetValue || '') !== (claim.relativePath || '') || receiptRow !== claimRow) receiptStatus = 'identity_mismatch';
      else receiptStatus = 'consistent_success';
    }
    var ledgerStatus = audit.ledgerReadback === 'read'
      ? auditDashboardPhotoUploadLedger_(claim, schema, rows) : 'unavailable';
    audit.ledgerStatusCounts[ledgerStatus] = (audit.ledgerStatusCounts[ledgerStatus] || 0) + 1;
    if (index < 200) {
      var keyHash = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, key).map(function(byte) {
        return ('0' + ((byte + 256) % 256).toString(16)).slice(-2);
      }).join('');
      audit.entries.push({ keyHash: keyHash, state: state, parseStatus: parseStatus,
        at: knownAt ? at : null, ageMs: ageMs, timestampStatus: timestampStatus,
        keyBytes: keyBytes, valueBytes: valueBytes, totalBytes: totalBytes,
        legacyCleanupEligible: eligible, legacyCleanupEvaluation: eligible === null ? 'error' : 'evaluated',
        receiptStatus: receiptStatus, ledgerStatus: ledgerStatus,
        safeToDelete: false });
    }
  });
  return audit;
}

/** Match identity and phase against one sheet snapshot; never touch Drive or claims. */
function auditDashboardPhotoUploadLedger_(claim, schema, rows) {
  if (typeof claim.tid !== 'string') return 'incomplete_claim';
  var tid = normalizeEquipmentCheckTradeId_(claim.tid.trim());
  if (!tid || ['checkout', 'checkin'].indexOf(claim.phase) < 0) return 'incomplete_claim';
  var targetCol = getDashboardPhotoWriteCol_(schema, claim.phase);
  var identities = [[schema.keyCol, claim.photoId], [schema.fileIdCol, claim.fileId], [targetCol, claim.relativePath]]
    .filter(function(pair) { return pair[0] && typeof pair[1] === 'string' && pair[1].trim(); });
  if (!identities.length) return 'incomplete_claim';
  if (!schema.phaseCol && (!targetCol || targetCol === schema.photoCol)) return 'unverifiable_schema';
  var matches = rows.filter(function(row) {
    return normalizeEquipmentCheckTradeId_(String(row[schema.tradeIdCol - 1] || '').trim()) === tid
      && identities.some(function(pair) { return String(row[pair[0] - 1] || '').trim() === String(pair[1]).trim(); });
  });
  if (!matches.length) return 'missing';
  if (matches.length > 1) return 'ambiguous';
  var row = matches[0];
  if (identities.some(function(pair) { return String(row[pair[0] - 1] || '').trim() !== String(pair[1]).trim(); })) return 'conflict';
  if (schema.phaseCol && normalizeDashboardPhotoPhase_(row[schema.phaseCol - 1]) !== claim.phase) return 'conflict';
  return 'matched';
}

/** Explicit internal diagnostic only. One 64..128-byte value, no retries or business writes.
 * A successful probe proves this tiny write at this instant, not total free capacity.
 * Cleanup compares its exact value under ScriptLock; unrelated keys are never touched.
 */
function probeScriptPropertiesCapacity(bytes) {
  var size = bytes === undefined ? 128 : (typeof bytes === 'number' || typeof bytes === 'string' ? Number(bytes) : NaN);
  var result = { ok: false, capacity: 'unknown', valueBytes: null, keyBytes: null,
    probeKey: null, write: 'not_attempted', readback: 'not_attempted',
    cleanup: 'not_needed', otherKeysDeleted: 0 };
  if (!isFinite(size) || Math.floor(size) !== size || size < 64 || size > 128) {
    result.reason = 'invalid_probe_size';
    return result;
  }
  result.valueBytes = size;
  var lock = null;
  var locked = false;
  var props = null;
  var value = '';
  var attempted = false;
  var stage = 'lock';
  try {
    lock = LockService.getScriptLock();
    locked = lock.tryLock(1000);
    if (!locked) { result.reason = 'busy'; return result; }
    stage = 'collision_check';
    props = PropertiesService.getScriptProperties();
    var uuid = Utilities.getUuid();
    result.probeKey = 'scriptPropertiesCapacityProbe_v1_' + uuid;
    result.keyBytes = result.probeKey.length;
    if (props.getProperty(result.probeKey) !== null) { result.reason = 'key_collision'; return result; }
    value = 'capacity-probe:' + uuid;
    value += new Array(size - value.length + 1).join('x');
    stage = 'write';
    attempted = true;
    result.write = 'attempted';
    props.setProperty(result.probeKey, value);
    stage = 'readback';
    if (props.getProperty(result.probeKey) === value) {
      result.write = 'verified'; result.readback = 'matched'; result.capacity = 'available';
    } else {
      result.readback = 'mismatch'; result.reason = 'write_not_verified';
    }
  } catch (probeError) {
    result.error = scriptPropertiesProbeError_(probeError, stage);
    var quota = stage === 'write' && result.error.category === 'property_storage_quota';
    result.capacity = quota ? 'quota_exceeded' : 'unknown';
    result.reason = quota ? 'storage_quota_rejected' : stage + '_failed';
  } finally {
    if (attempted) {
      try {
        var current = props.getProperty(result.probeKey);
        if (current === null) result.cleanup = 'absent';
        else if (current !== value) result.cleanup = 'ownership_changed';
        else {
          if (result.capacity === 'quota_exceeded') { result.capacity = 'unknown'; result.reason = 'quota_write_inconsistent'; }
          props.deleteProperty(result.probeKey);
          var after = props.getProperty(result.probeKey);
          result.cleanup = after === null ? 'deleted_verified' : (after === value ? 'delete_not_confirmed' : 'ownership_changed');
        }
      } catch (cleanupError) {
        result.cleanup = 'failed';
        result.cleanupError = scriptPropertiesProbeError_(cleanupError, 'cleanup');
      }
    }
    if (locked) {
      try { lock.releaseLock(); } catch (releaseError) {
        result.lockRelease = 'failed';
        result.lockReleaseError = scriptPropertiesProbeError_(releaseError, 'lock_release');
      }
    }
  }
  result.ok = result.capacity === 'available' && result.cleanup === 'deleted_verified' && result.lockRelease !== 'failed';
  return result;
}

/** Bounded diagnostics for this nonce-only probe; never expose stacks or credentials. */
function scriptPropertiesProbeError_(error, stage) {
  var raw = 'unreadable_error';
  try { raw = String(error && error.message || error || '').slice(0, 4096).split(/[\r\n]/)[0]; } catch (readError) {}
  var category = 'unknown';
  if ((/property\s+storage\s+quota/i.test(raw) && /\b(?:exceed\w*|reach\w*|exhaust\w*|full)\b/i.test(raw))
    || /속성\s*저장\s*(?:소|용량|공간)?[^\n]{0,80}(?:초과|가득|부족)/i.test(raw)) category = 'property_storage_quota';
  else if (/argument too large|property value[^\n]{0,80}(?:too large|maximum|limit)|속성\s*값[^\n]{0,50}(?:너무\s*[크큽]|최대|한도)/i.test(raw)) category = 'property_value_limit';
  else if (/service invoked too many times|too many (?:calls|requests)|(?:rate|daily) limit|per day|너무 많이 호출|호출[^\n]{0,50}한도/i.test(raw)) category = 'daily_rate';
  else if (/permission|not authorized|unauthorized|access denied|권한|접근[^\n]{0,30}거부/i.test(raw)) category = 'permission';
  else if (/service unavailable|temporarily unavailable|server error|internal error|timed? out|timeout|서비스[^\n]{0,30}(?:사용할 수 없|일시)|시간[^\n]{0,30}초과/i.test(raw)) category = 'service_unavailable';
  var name = 'unknown';
  try {
    if (['Error', 'Exception', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError', 'EvalError', 'URIError', 'AggregateError', 'ServiceError'].indexOf(error && error.name) >= 0) name = error.name;
  } catch (nameError) {}
  var safe = raw
    .replace(/\b(?:https?|wss?):\/\/[^\s"'<>]+/gi, '[url]')
    .replace(/\bBearer\s+[^\s,;}]+/gi, 'Bearer [redacted]')
    .replace(/(["']?\b(?:api[_-]?key|key|(?:access[_-]?|refresh[_-]?)?token|secret|authorization|password|credential)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}\]]+)/gi, '$1[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/[A-Za-z0-9_-]{24,}/g, '[redacted]')
    .slice(0, 320);
  return { stage: stage, category: category, name: name, type: typeof error, message: safe };
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
