/**
 * ====================================================================
 * checkAvailability_v3.gs — 빌리지 스케줄 관리 (구글 시트 우선 설계)
 * ====================================================================
 *
 * v3 변경사항:
 * - 메뉴 클릭 불필요: 드롭다운 선택만으로 자동 실행
 * - 같은 요청ID 일괄 처리: 확인 1번 = 전체 장비 확인, 등록 1번 = 전체 등록
 * - 날짜 상속: 같은 요청ID면 첫 행 날짜 자동 적용
 * - 세트 자동 펼침: 세트명 입력 + 확인 → 구성품 행 자동 추가
 * - 확인결과 시트 없음: 결과가 확인요청 행에 직접 표시
 * - 웹앱 지원 유지: AppSheet Bot 웹훅 호환
 *
 * 확인요청 시트 구조 (18열):
 * A: 요청ID | B: 반출일 | C: 반출시간 | D: 반납일 | E: 반납시간
 * F: 장비or세트명 | G: 수량 | H: 확인(드롭다운) | I: 결과 | J: 상세
 * K: 예약자명 | L: 연락처 | M: 업체명 | N: 등록(드롭다운)
 * O: 등록상태 | P: 거래ID | Q: 비고 | R: 추가요청(악세사리 등 자유입력)
 *
 * ★ 이 파일을 Apps Script에 붙여넣으세요 ★
 * ★ Code.gs의 onEdit()에 트리거 코드도 추가 필요 ★
 */


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 커스텀 메뉴 (타임라인 등 부가 기능용)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu("📋 빌리지 스케줄")
    .addItem("🔍 가용 확인 (수동 전체)", "manualProcessAll")
    .addItem("✅ 예약 등록 (수동)", "manualRegister")
    .addItem("📄 계약서 생성", "createContractFromMenu")
    .addItem("🐞 가용확인 디버그 (선택행)", "debugCheckAvailForSelected")
    .addItem("⚡ 가용확인 강제 재실행 (선택행 reqID)", "forceRerunCheckAvailForSelected")
    .addSeparator()
    .addItem("🔍 선택 행 할인유형 재조회", "lookupDiscountForSelectedRow")
    .addSeparator()
    .addItem("🔄 장비 목록 갱신", "refreshEquipmentList")
    .addItem("📸 실사기록 동기화", "syncAuditFromMaster")
    .addSeparator()
    .addItem("🗑️ 확인요청 초기화 (수동)", "clearAllRequests")
    .addSeparator()
    .addItem("⚙️ 계약서 설정", "setupContractSettings")
    .addItem("🔄 계약서 템플릿 가격 동기화", "syncTemplateMasterFromSetMaster")
    .addSeparator()
    .addItem("📖 업무 매뉴얼", "showManual")
    .addToUi();

  // 시트 열 때마다 장비 목록 자동 갱신
  try { refreshEquipmentList(); } catch (e) { /* 첫 실행 시 무시 */ }
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 타임라인
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function showManual() {
  const html = HtmlService.createHtmlOutputFromFile('Manual')
    .setTitle('📖 업무 매뉴얼');
  SpreadsheetApp.getUi().showSidebar(html);
}

function showTimeline() {
  var url = PropertiesService.getScriptProperties().getProperty('WEB_APP_URL');
  if (!url) url = ScriptApp.getService().getUrl();
  url += '?page=timeline';
  const html = HtmlService.createHtmlOutput(
    '<script>window.open("' + url + '", "_blank");google.script.host.close();</script>'
  ).setWidth(200).setHeight(50);
  SpreadsheetApp.getUi().showModalDialog(html, '스케줄 열기');
}

function openDashboard() {
  var url = PropertiesService.getScriptProperties().getProperty('WEB_APP_URL');
  if (!url) url = ScriptApp.getService().getUrl();
  url += '?page=dashboard';
  const html = HtmlService.createHtmlOutput(
    '<script>window.open("' + url + '", "_blank");google.script.host.close();</script>'
  ).setWidth(200).setHeight(50);
  SpreadsheetApp.getUi().showModalDialog(html, '오늘 일정 열기');
}

var TIMELINE_CACHE_VERSION_PROP_ = 'timelineCacheVersion_v1';
var TIMELINE_CACHE_PREFIX_ = 'timeline_v4_';
var TIMELINE_CACHE_CHUNK_SIZE_ = 85000;
var TIMELINE_CACHE_MAX_CHUNKS_ = 30;
var TIMELINE_DEFAULT_LOOKBACK_DAYS_ = 1;
var TIMELINE_DEFAULT_LOOKAHEAD_DAYS_ = 14;
var DASHBOARD_SEARCH_CACHE_VERSION_PROP_ = 'dashboardSearchCacheVersion_v1';
var DASHBOARD_CACHE_CHUNK_SIZE_ = 85000;
var DASHBOARD_CACHE_MAX_CHUNKS_ = 30;
var EQUIPMENT_RISK_RULE_SHEET_NAME = '장비주의사항';

/**
 * 타임라인 HTML/API에서 호출.
 * vis.js 형식으로 groups / items 반환. from/to(yyyy-MM-dd)가 있으면 해당 기간과 겹치는 예약만 반환한다.
 */
function getTimelineData(options) {
  options = options || {};
  var profile = options.profile === true || options.profile === 1 ||
    options.profile === '1' || options.profile === 'true';
  var profileStart = Date.now();
  var profileMarks = [];
  function markTimelineStep_(step, details) {
    if (!profile) return;
    var item = { step: step, ms: Date.now() - profileStart };
    if (details) {
      Object.keys(details).forEach(function(key) { item[key] = details[key]; });
    }
    profileMarks.push(item);
  }

  var fromKey = normalizeTimelineDateKey_(options.from || options.start || '');
  var toKey = normalizeTimelineDateKey_(options.to || options.end || '');
  var allowAllRange = isTimelineOptionEnabled_(options.all) || isTimelineOptionEnabled_(options.fullRange);
  if (!fromKey && !toKey && !allowAllRange) {
    var defaultRange = getDefaultTimelineRange_();
    fromKey = defaultRange.from;
    toKey = defaultRange.to;
  }
  if (fromKey && toKey && fromKey > toKey) {
    var tmpKey = fromKey;
    fromKey = toKey;
    toKey = tmpKey;
  }

  var skipCache = options.skipCache === true || options.skipCache === 1 ||
    options.skipCache === '1' || options.skipCache === 'true';
  var compactValue = (options.compact !== undefined && options.compact !== null && options.compact !== '')
    ? options.compact
    : options.slim;
  var compactLevel = Number(compactValue);
  if (isNaN(compactLevel)) compactLevel = isTimelineOptionEnabled_(compactValue) ? 1 : 0;
  var compact = compactLevel > 0;
  if (compact) compactLevel = Math.max(1, Math.floor(compactLevel || 1));
  var includeContractUrl = options.includeContractUrl === true || options.includeContractUrl === 1 ||
    options.includeContractUrl === '1' || options.includeContractUrl === 'true';
  if (options.includeContractUrl === undefined || options.includeContractUrl === null || options.includeContractUrl === '') {
    includeContractUrl = !compact;
  }
  var cacheKey = TIMELINE_CACHE_PREFIX_ + getTimelineCacheVersion_() + '_' +
    (fromKey || 'all') + '_' + (toKey || 'all') + '_' +
    (compact ? 'compact' + compactLevel : 'full') + '_' + (includeContractUrl ? 'contract' : 'nocontract');
  markTimelineStep_('prepared', { from: fromKey || '', to: toKey || '', compactLevel: compactLevel });

  if (!skipCache) {
    var cached = getTimelineCacheText_(cacheKey);
    markTimelineStep_('cache_read', { hit: !!cached });
    if (cached) {
      try {
        var cachedResult = JSON.parse(cached);
        if (profile && cachedResult) {
          cachedResult.cacheHit = true;
          cachedResult.profile = profileMarks;
        }
        return cachedResult;
      } catch (e) {}
    }
  }

  var result = buildTimelineData_(fromKey, toKey, {
    compact: compact,
    compactLevel: compactLevel,
    includeContractUrl: includeContractUrl,
    profile: profile
  });
  markTimelineStep_('build_complete');
  if (profile && result) {
    result.cacheHit = false;
    result.profile = profileMarks.concat(result.profile || []);
  }
  if (!profile) {
    try { putTimelineCacheText_(cacheKey, JSON.stringify(result), 300); } catch (e2) {}
  }
  return result;
}

function isTimelineOptionEnabled_(value) {
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'yes';
}

function getDefaultTimelineRange_() {
  var now = new Date();
  return {
    from: Utilities.formatDate(
      new Date(now.getTime() - TIMELINE_DEFAULT_LOOKBACK_DAYS_ * 86400000),
      'Asia/Seoul',
      'yyyy-MM-dd'
    ),
    to: Utilities.formatDate(
      new Date(now.getTime() + TIMELINE_DEFAULT_LOOKAHEAD_DAYS_ * 86400000),
      'Asia/Seoul',
      'yyyy-MM-dd'
    )
  };
}

function getInitialTimelineMobileRange_() {
  var now = new Date();
  return {
    from: Utilities.formatDate(
      new Date(now.getTime() - 2 * 86400000),
      'Asia/Seoul',
      'yyyy-MM-dd'
    ),
    to: Utilities.formatDate(
      new Date(now.getTime() + 10 * 86400000),
      'Asia/Seoul',
      'yyyy-MM-dd'
    )
  };
}

function buildTimelineData_(fromKey, toKey, options) {
  options = options || {};
  var profile = options.profile === true || options.profile === 1 ||
    options.profile === '1' || options.profile === 'true';
  var profileStart = Date.now();
  var profileMarks = [];
  function markTimelineBuildStep_(step, details) {
    if (!profile) return;
    var item = { step: step, ms: Date.now() - profileStart };
    if (details) {
      Object.keys(details).forEach(function(key) { item[key] = details[key]; });
    }
    profileMarks.push(item);
  }
  function finishTimelineBuild_(result) {
    if (profile && result) result.profile = profileMarks;
    return result;
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const schedSheet   = ss.getSheetByName('스케줄상세');
  const contractSheet = ss.getSheetByName('계약마스터');
  markTimelineBuildStep_('sheets_opened');

  // 장비마스터: 장비명 → 재고수량
  var includeStock = options.includeStock === true || options.includeStock === 1 ||
    options.includeStock === '1' || options.includeStock === 'true';
  if (options.includeStock === undefined || options.includeStock === null || options.includeStock === '') {
    includeStock = !options.compact;
  }
  var stockMap = includeStock ? getTimelineStockMap_(ss) : {};
  markTimelineBuildStep_('stock_map', {
    enabled: includeStock,
    stockCount: Object.keys(stockMap || {}).length
  });

  if (!schedSheet || schedSheet.getLastRow() < 2) {
    return finishTimelineBuild_({ groups: [], items: [] });
  }

  var rangeStart = parseTimelineDateBoundary_(fromKey, false);
  var rangeEnd = parseTimelineDateBoundary_(toKey, true);
  var scheduleRows = readTimelineScheduleRows_(schedSheet, fromKey, toKey);
  markTimelineBuildStep_('schedule_rows', {
    rowCount: scheduleRows.length,
    totalRowCount: scheduleRows._totalRowCount || scheduleRows.length,
    cacheHit: scheduleRows._cacheHit === true
  });
  var rowIndicesBySet = {};
  scheduleRows.forEach(function(entry) {
    var row = entry.values;
    var tid = String(row[1] || '').trim();
    var setName = String(row[2] || '').trim();
    if (!tid || !setName) return;
    var key = tid + '|' + setName;
    if (!rowIndicesBySet[key]) rowIndicesBySet[key] = [];
    rowIndicesBySet[key].push(entry.rowNum);
  });
  markTimelineBuildStep_('row_indexed', { setCount: Object.keys(rowIndicesBySet).length });

  const seen = {};   // "거래ID|그룹명" → true
  const entries = [];

  // 행 처리 함수
  function processRow(entry, isSetPhase) {
    var row = entry.values;
    var rowNum = entry.rowNum;
    const 거래ID   = row[1];  // B
    const 세트명   = String(row[2] || '').trim();  // C
    const 장비명   = String(row[3] || '').trim();  // D
    const 수량     = Number(row[4]) || 1;  // E
    const 반출일   = row[5];  // F
    const 반출시간 = row[6];  // G
    const 반납일   = row[7];  // H
    const 반납시간 = row[8];  // I
    const 상태     = row[9] || '대기';  // J
    const 단가     = Number(row[11]) || 0;  // L

    if (!반출일 || !반납일) return;

    var groupName, isSingleItem;

    if (isSetPhase) {
      if (!세트명) return;  // Phase 1: 세트명 있는 행만
      groupName = 세트명;
      isSingleItem = false;
    } else {
      if (세트명) return;   // Phase 2: 세트명 없는 행만 (=사용자가 단독 추가한 장비)
      if (!장비명) return;
      groupName = 장비명;
      isSingleItem = true;
    }

    const key = 거래ID + '|' + groupName;
    if (seen[key]) return;  // 중복 방지
    seen[key] = true;

    var checkoutKey = normalizeTimelineDateKey_(반출일);
    var checkinKey = normalizeTimelineDateKey_(반납일);
    if (fromKey && checkinKey && checkinKey < fromKey) return;
    if (toKey && checkoutKey && checkoutKey > toKey) return;

    const startDT = parseDT(반출일, 반출시간);
    const endDT   = parseDT(반납일, 반납시간);
    if (!startDT || !endDT) return;

    if (rangeStart && endDT < rangeStart) return;
    if (rangeEnd && startDT > rangeEnd) return;

    // 같은 거래ID+세트명의 모든 행 인덱스 수집
    var rowIndices = [];
    if (!isSingleItem) {
      rowIndices = rowIndicesBySet[key] || [rowNum];
    } else {
      rowIndices = [rowNum];
    }

    var 반출시간Str = 반출시간 ? String(반출시간).trim() : '';
    var 반납시간Str = 반납시간 ? String(반납시간).trim() : '';
    if (반출시간Str && 반출시간Str.indexOf(':') < 0) 반출시간Str = '';
    if (반납시간Str && 반납시간Str.indexOf(':') < 0) 반납시간Str = '';

    entries.push({
      거래ID:    거래ID,
      groupName: groupName,
      custName:  거래ID || '',
      tel:       '',
      startDT:   startDT,
      endDT:     endDT,
      상태:      상태,
      수량:      수량,
      단가:      단가,
      rowIndices: rowIndices,
      반출:      fmtDT(반출일, 반출시간),
      반납:      fmtDT(반납일, 반납시간),
      isSingleItem: isSingleItem,
      반출시간:  반출시간Str,
      반납시간:  반납시간Str,
      장비명:    장비명,
      세트명원본: 세트명
    });
  }

  // Phase 1: 세트 행 먼저 (세트명 있는 행)
  scheduleRows.forEach(function(entry) { processRow(entry, true); });
  // Phase 2: 개별 장비 행 (세트명 없고 구성품 아닌 것만)
  scheduleRows.forEach(function(entry) { processRow(entry, false); });
  markTimelineBuildStep_('entries_built', { entryCount: entries.length });

  var timelineTradeIds = {};
  entries.forEach(function(e) {
    var tid = String(e.거래ID || '').trim();
    if (tid) timelineTradeIds[tid] = true;
  });
  var timelineTradeIdList = Object.keys(timelineTradeIds);
  var contractMap = getTimelineContractMapForIds_(contractSheet, timelineTradeIdList);
  markTimelineBuildStep_('contract_map', {
    tradeCount: timelineTradeIdList.length,
    totalContractRows: contractMap._totalContractRows || 0,
    cacheHit: contractMap._cacheHit === true
  });
  entries.forEach(function(e) {
    var tid = String(e.거래ID || '').trim();
    var cust = contractMap[tid] || {};
    e.custName = cust.name || e.거래ID || '';
    e.tel = cust.tel || '';
  });

  // 회차 계산: 현재 표시 범위 안에서 같은 예약자+그룹의 몇 번째 예약인지
  var 회차Map = {};
  entries.forEach(function(e) {
    var hkey = (e.custName || '') + '|' + e.groupName;
    if (!회차Map[hkey]) 회차Map[hkey] = 0;
    회차Map[hkey]++;
    e.회차 = 회차Map[hkey];
  });
  markTimelineBuildStep_('sequence_marked');

  // 그룹 및 아이템 생성
  const groupMap  = {};
  const groupList = [];
  const itemList  = [];
  var itemIdx = 0;
  var tradeExtras = {};
  if (options.includeContractUrl !== false) {
    try {
      tradeExtras = getTradeExtrasForIds_(timelineTradeIdList);
    } catch (e) {
      tradeExtras = {};
    }
  }
  markTimelineBuildStep_('trade_extras', { enabled: options.includeContractUrl !== false });

  entries.forEach(function(e) {
    // 그룹 등록
    if (!groupMap[e.groupName]) {
      groupMap[e.groupName] = 'g_' + groupList.length;
      groupList.push({ id: groupMap[e.groupName], content: e.groupName });
    }

    var statusClass = ['대기','반출중','반납완료','취소'].indexOf(e.상태) >= 0
      ? 'status-' + e.상태 : 'status-기타';
    var extra = options.includeContractUrl === false ? {} : (tradeExtras[String(e.거래ID || '').trim()] || {});

    // 세트: 수량만큼 바 생성, 개별장비: 1개 바
    var barCount = e.isSingleItem ? 1 : (e.수량 || 1);

    for (var s = 0; s < barCount; s++) {
      itemList.push({
        id:        'item_' + itemIdx++,
        rowIndex:  e.rowIndices[0],
        rowIndices: e.rowIndices,
        group:     groupMap[e.groupName],
        content:   e.custName,
        start:     e.startDT.toISOString(),
        end:       e.endDT.toISOString(),
        className: statusClass,
        status:    e.상태,
        editable:  { updateTime: true, remove: false },
        custName:  e.custName,
        tel:       e.tel,
        거래ID:    e.거래ID,
        세트명:    e.groupName,
        장비명:    e.isSingleItem ? e.groupName : e.장비명,
        수량:      e.isSingleItem ? e.수량 : barCount + '세트',
        반출:      e.반출,
        반납:      e.반납,
        단가:      e.단가,
        반출시간:  e.반출시간 || '',
        반납시간:  e.반납시간 || '',
        회차:      e.회차 || 1,
        재고:      includeStock ? (stockMap[e.isSingleItem ? e.groupName : e.장비명] || 1) : 0,
        세트명원본: e.세트명원본 || e.groupName,
        contractUrl: extra.contractUrl || ''
      });
    }
  });
  markTimelineBuildStep_('items_built', { groupCount: groupList.length, itemCount: itemList.length });

  if (options.compact) {
    var compactOptions = { compactLevel: Number(options.compactLevel) || 1 };
    return finishTimelineBuild_({
      compact: true,
      compactLevel: compactOptions.compactLevel,
      groups: groupList.map(compactTimelineGroup_),
      items: itemList.map(function(item) { return compactTimelineItem_(item, compactOptions); })
    });
  }

  return finishTimelineBuild_({ groups: groupList, items: itemList });
}

function compactTimelineGroup_(group) {
  return {
    i: group.id,
    c: group.content
  };
}

function compactTimelineItem_(item, options) {
  options = options || {};
  var compactLevel = Number(options.compactLevel) || 1;
  var compact = {
    r: item.rowIndex,
    g: item.group,
    s: Date.parse(item.start),
    e: Date.parse(item.end),
    st: item.status,
    cn: item.custName,
    tid: item.거래ID,
    q: item.수량
  };

  if (compactLevel < 2) {
    compact.i = item.id;
    compact.set = item.세트명;
    compact.eq = item.장비명;
    compact.out = item.반출;
    compact.ret = item.반납;
  } else if (item.장비명 && item.장비명 !== item.세트명) {
    compact.eq = item.장비명;
  }

  if (item.rowIndices && item.rowIndices.length > 1) compact.rs = item.rowIndices;
  if (!compact.s) compact.s = item.start;
  if (!compact.e) compact.e = item.end;
  if (item.tel) compact.t = item.tel;
  if (item.단가) compact.p = item.단가;
  if (item.반출시간) compact.ot = item.반출시간;
  if (item.반납시간) compact.rt = item.반납시간;
  if (item.회차 && item.회차 !== 1) compact.n = item.회차;
  if (item.재고 && item.재고 !== 1) compact.stock = item.재고;
  if (item.세트명원본 && item.세트명원본 !== item.세트명) compact.orig = item.세트명원본;
  if (item.contractUrl) compact.u = item.contractUrl;

  return compact;
}

function getTimelineContractLink(tid) {
  tid = String(tid || '').trim();
  if (!tid) return { success: false, error: '거래ID 필수' };
  var extras = getTradeExtrasForIds_([tid]);
  var extra = extras[tid] || {};
  return {
    success: true,
    tradeId: tid,
    contractUrl: extra.contractUrl || ''
  };
}

function getTimelineStockMap_(ss) {
  return getDashboardCachedJson_("timeline_stock_map_v1", 300, function() {
    var stockMap = {};
    var equipSheet = ss.getSheetByName('장비마스터');
    if (!equipSheet || equipSheet.getLastRow() < 2) return stockMap;

    var lastCol = equipSheet.getLastColumn();
    var headers = equipSheet.getRange(1, 1, 1, lastCol).getValues()[0];
    var nameCol = headers.indexOf('장비명') + 1;
    var stockCol = headers.indexOf('재고수량') + 1;
    if (!nameCol || !stockCol) return stockMap;

    var readCols = Math.max(nameCol, stockCol);
    var rows = equipSheet.getRange(2, 1, equipSheet.getLastRow() - 1, readCols).getValues();
    rows.forEach(function(row) {
      var name = String(row[nameCol - 1] || '').trim();
      if (name) stockMap[name] = Number(row[stockCol - 1]) || 1;
    });
    return stockMap;
  });
}

function getTimelineContractMapForIds_(contractSheet, tradeIds) {
  var result = {};

  var wanted = {};
  (tradeIds || []).forEach(function(tid) {
    tid = String(tid || '').trim();
    if (tid) wanted[tid] = true;
  });
  if (!contractSheet || !tradeIds || tradeIds.length === 0 || Object.keys(wanted).length === 0) return result;

  var contacts = getTimelineContractContactsForCache_(contractSheet);
  var contactMap = contacts.map || {};
  Object.keys(wanted).forEach(function(tid) {
    var row = contactMap[tid];
    if (!row) return;
    result[tid] = {
      name: row.name || '',
      tel: row.tel || ''
    };
  });

  result._cacheHit = contacts._cacheHit === true;
  result._totalContractRows = contacts.totalRows || 0;
  return result;
}

function getTimelineContractContactsForCache_(contractSheet) {
  var empty = { map: {}, totalRows: 0, _cacheHit: false };
  if (!contractSheet || contractSheet.getLastRow() < 2) return empty;

  var rowCount = contractSheet.getLastRow() - 1;
  var cacheKey = TIMELINE_CACHE_PREFIX_ + 'contractContacts_v1_' +
    getTimelineCacheVersion_() + '_' + rowCount;
  var cached = getTimelineCacheText_(cacheKey);
  if (cached) {
    try {
      var cachedContacts = JSON.parse(cached);
      if (cachedContacts && cachedContacts.map) {
        cachedContacts._cacheHit = true;
        return cachedContacts;
      }
    } catch (e) {}
  }

  var rows = contractSheet.getRange(2, 1, rowCount, 3).getDisplayValues();
  var map = {};
  rows.forEach(function(row) {
    var tid = String(row[0] || '').trim();
    if (!tid) return;
    map[tid] = {
      name: String(row[1] || '').trim(),
      tel: String(row[2] || '').trim()
    };
  });

  var payload = { map: map, totalRows: rowCount };
  try { putTimelineCacheText_(cacheKey, JSON.stringify(payload), 300); } catch (e2) {}
  payload._cacheHit = false;
  return payload;
}

function readTimelineScheduleRows_(schedSheet, fromKey, toKey) {
  var lastRow = schedSheet.getLastRow();
  if (lastRow < 2) return [];

  var rows = getTimelineScheduleRowsForCache_(schedSheet, lastRow);
  var filtered = rows.filter(function(entry) {
    if (!fromKey && !toKey) return true;
    var row = entry.values;
    var checkoutKey = row[5] || normalizeTimelineDateKey_(row[5]);
    var checkinKey = row[7] || normalizeTimelineDateKey_(row[7]);
    if (fromKey && checkinKey && checkinKey < fromKey) return;
    if (toKey && checkoutKey && checkoutKey > toKey) return;
    return true;
  });
  filtered._cacheHit = rows._cacheHit === true;
  filtered._totalRowCount = rows.length;
  return filtered;
}

function getTimelineScheduleRowsForCache_(schedSheet, lastRow) {
  var cacheKey = TIMELINE_CACHE_PREFIX_ + 'scheduleRows_v2_' +
    getTimelineCacheVersion_() + '_' + lastRow;
  var cached = getTimelineCacheText_(cacheKey);
  if (cached) {
    try {
      var cachedRows = JSON.parse(cached);
      if (Array.isArray(cachedRows)) {
        cachedRows._cacheHit = true;
        return cachedRows;
      }
    } catch (e) {}
  }

  var values = schedSheet.getRange(2, 1, lastRow - 1, 12).getValues();
  var normalized = values.map(function(row, idx) {
    return {
      rowNum: 2 + idx,
      values: normalizeTimelineScheduleRow_(row)
    };
  });
  normalized._cacheHit = false;
  try { putTimelineCacheText_(cacheKey, JSON.stringify(normalized), 300); } catch (e2) {}
  return normalized;
}

function normalizeTimelineScheduleRow_(row) {
  var out = new Array(12);
  for (var i = 0; i < 12; i++) out[i] = row[i];
  out[0] = String(row[0] || '').trim();
  out[1] = String(row[1] || '').trim();
  out[2] = String(row[2] || '').trim();
  out[3] = String(row[3] || '').trim();
  out[4] = Number(row[4]) || 1;
  out[5] = normalizeTimelineDateKey_(row[5]);
  out[6] = normalizeTimelineTimeValue_(row[6]);
  out[7] = normalizeTimelineDateKey_(row[7]);
  out[8] = normalizeTimelineTimeValue_(row[8]);
  out[9] = String(row[9] || '대기').trim();
  out[10] = row[10] || '';
  out[11] = Number(row[11]) || 0;
  return out;
}

function normalizeTimelineTimeValue_(value) {
  if (!value) return '';
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return Utilities.formatDate(value, 'Asia/Seoul', 'HH:mm');
  }
  return String(value || '').trim();
}

function normalizeTimelineDateKey_(value) {
  if (!value) return '';
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value.getTime())) {
    return value.getFullYear() + '-' + ('0' + (value.getMonth() + 1)).slice(-2) + '-' + ('0' + value.getDate()).slice(-2);
  }
  var s = String(value).trim();
  var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (!m) return '';
  return m[1] + '-' + ('0' + Number(m[2])).slice(-2) + '-' + ('0' + Number(m[3])).slice(-2);
}

function parseTimelineDateBoundary_(dateKey, isEnd) {
  if (!dateKey) return null;
  var m = String(dateKey).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  return new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    isEnd ? 23 : 0,
    isEnd ? 59 : 0,
    isEnd ? 59 : 0,
    isEnd ? 999 : 0
  );
}

function getTimelineCacheVersion_() {
  try {
    return PropertiesService.getScriptProperties().getProperty(TIMELINE_CACHE_VERSION_PROP_) || '0';
  } catch (e) {
    return '0';
  }
}

function getTimelineCacheText_(cacheKey) {
  try {
    var cache = CacheService.getScriptCache();
    var metaKey = cacheKey + '__count';
    var count = Number(cache.get(metaKey));
    if (!count || count < 1 || count > TIMELINE_CACHE_MAX_CHUNKS_) return null;
    var keys = [];
    for (var i = 0; i < count; i++) keys.push(cacheKey + '__' + i);
    var chunks = cache.getAll(keys);
    var parts = [];
    for (var j = 0; j < keys.length; j++) {
      var part = chunks[keys[j]];
      if (part === undefined || part === null) return null;
      parts.push(part);
    }
    return parts.join('');
  } catch (e) {
    return null;
  }
}

function putTimelineCacheText_(cacheKey, text, seconds) {
  if (!text) return;
  var count = Math.ceil(text.length / TIMELINE_CACHE_CHUNK_SIZE_);
  if (count < 1 || count > TIMELINE_CACHE_MAX_CHUNKS_) return;
  try {
    var cache = CacheService.getScriptCache();
    var payload = {};
    payload[cacheKey + '__count'] = String(count);
    for (var i = 0; i < count; i++) {
      payload[cacheKey + '__' + i] = text.slice(
        i * TIMELINE_CACHE_CHUNK_SIZE_,
        (i + 1) * TIMELINE_CACHE_CHUNK_SIZE_
      );
    }
    cache.putAll(payload, seconds || 300);
  } catch (e) {}
}

function invalidateTimelineCache() {
  try {
    PropertiesService.getScriptProperties().setProperty(TIMELINE_CACHE_VERSION_PROP_, String(Date.now()));
  } catch (e) {}
}

/**
 * 타임라인 드래그로 일정 변경 시 스케줄상세 시트 업데이트
 * rowIndex: 대표 행 번호, rowIndices: 같은 세트의 전체 행 (JSON string 가능)
 */
function updateScheduleTime(rowIndex, newStart, newEnd, rowIndices) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('스케줄상세');
  if (!sheet) return { success: false, message: '스케줄상세 시트 없음' };

  var startDate = new Date(newStart);
  var endDate = new Date(newEnd);
  var startTime = ('0' + startDate.getHours()).slice(-2) + ':' + ('0' + startDate.getMinutes()).slice(-2);
  var endTime   = ('0' + endDate.getHours()).slice(-2) + ':' + ('0' + endDate.getMinutes()).slice(-2);

  // 같은 세트의 모든 행 업데이트
  var rows = [];
  if (rowIndices) {
    try { rows = JSON.parse(rowIndices); } catch(e) { rows = [rowIndex]; }
  } else {
    rows = [rowIndex];
  }

  rows.forEach(function(r) {
    sheet.getRange(r, 6).setValue(startDate);   // F: 반출일
    sheet.getRange(r, 7).setValue(startTime);   // G: 반출시간
    sheet.getRange(r, 8).setValue(endDate);     // H: 반납일
    sheet.getRange(r, 9).setValue(endTime);     // I: 반납시간
  });

  // dashboard 캐시 즉시 무효화 → 다음 진입 시 fresh
  try { invalidateDashboardCache(); } catch (e) {}
  try { invalidateTimelineCache(); } catch (e2) {}

  return { success: true };
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 오늘 반출/반납 대시보드 데이터
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function getDashboardData(targetDate, skipCache, options) {
  var today = targetDate || Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');
  options = options || {};
  var evaluateRisk = options.evaluateRisk === true || options.evaluateRisk === '1' || options.evaluateRisk === 'true';

  // 캐시 5분으로 확장. 등록/취소/일정변경 시 invalidateDashboardCache() 호출로 무효화.
  var cache = CacheService.getScriptCache();
  var cacheKey = 'dashboard_v4_' + today + (evaluateRisk ? '_risk' : '');
  if (!skipCache) {
    var cachedResult = getDashboardCacheJson_(cache, cacheKey);
    if (cachedResult) {
      if (!cachedResult.date) cachedResult.date = today;
      return cachedResult;
    }
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const schedSheet   = ss.getSheetByName('스케줄상세');
  const contractSheet = ss.getSheetByName('계약마스터');
  const setSheet = ss.getSheetByName('세트마스터');

  if (!schedSheet || schedSheet.getLastRow() < 2) {
    return {
      date: today,
      checkout: [],
      checkin: [],
      activeCount: 0,
      paymentOptions: getTradePaymentOptions_(),
      proofTypeOptions: getTradeProofTypeOptions_(),
      issueStatusOptions: getTradeIssueStatusOptions_(),
      depositStatusOptions: getTradeDepositStatusOptions_(),
      billingCompanyOptions: getTradeBillingCompanyOptions_()
    };
  }

  var schedLastRow = schedSheet.getLastRow();
  var todayRowSet = {};
  findDashboardRowsByValue_(schedSheet, 6, schedLastRow, today).forEach(function(row) { todayRowSet[row] = true; });
  findDashboardRowsByValue_(schedSheet, 8, schedLastRow, today).forEach(function(row) { todayRowSet[row] = true; });
  var todayRows = Object.keys(todayRowSet).map(function(row) { return Number(row); });
  todayRows.sort(function(a, b) { return a - b; });

  var data = readDashboardScheduleRowsDisplay_(schedSheet, todayRows, 12);

  // 거래ID별 그룹핑
  var tradeGroups = {};

  data.forEach(function(row) {
    var 거래ID   = String(row[1] || '').trim();  // B
    var 세트명   = row[2];  // C
    var 장비명   = row[3];  // D
    var 수량     = row[4] || 1;  // E
    var 반출일str   = String(row[5] || '').trim();  // F (display value)
    var 반출시간str = String(row[6] || '').trim();  // G
    var 반납일str   = String(row[7] || '').trim();  // H
    var 반납시간str = String(row[8] || '').trim();  // I
    var 상태     = row[9] || '대기';  // J

    if (!장비명 || !반출일str || !반납일str || !거래ID) return;
    if (상태 === '취소') return;

    // 빠른 사전 필터: 오늘 반출/반납 행만 읽었으므로 여기서는 안전망으로만 한 번 더 확인
    var isCheckoutToday = (반출일str === today);
    var isCheckinToday = (반납일str === today);
    if (!isCheckoutToday && !isCheckinToday) return;

    if (!tradeGroups[거래ID]) {
      tradeGroups[거래ID] = {
        거래ID: 거래ID,
        반출일: 반출일str,
        반출시간: 반출시간str,
        반납일: 반납일str,
        반납시간: 반납시간str,
        상태: 상태,
        equipments: []
      };
    }

    var 스케줄ID = String(row[0] || '').trim();
    var setNameStr = String(세트명 || '').trim();
    var equipNameStr = String(장비명 || '').trim();
    var isHeader = setNameStr === '' || setNameStr === equipNameStr;  // 단품 또는 세트 대표행
    tradeGroups[거래ID].equipments.push({
      scheduleId: 스케줄ID,
      name: equipNameStr,
      qty: 수량,
      setName: setNameStr,
      isHeader: isHeader
    });
  });

  var checkoutList = [];
  var checkinList = [];
  var activeCount = 0;

  // 반출세팅 완료 플래그 일괄 조회 (ScriptProperties 1회 호출)
  var props = PropertiesService.getScriptProperties().getProperties();
  var dashboardTradeIds = Object.keys(tradeGroups);
  var contractMap = getDashboardContractMapForIds_(contractSheet, dashboardTradeIds);
  var tradeExtras = getTradeExtrasForIds_(dashboardTradeIds, props);
  var equipmentChecks = getEquipmentCheckMapForIds_(dashboardTradeIds);
  var riskRules = getEquipmentRiskRules_();
  var riskCandidateLookup = buildDashboardSetComponentLookup_(setSheet);

  dashboardTradeIds.forEach(function(tid) {
    var g = tradeGroups[tid];
    var cust = contractMap[tid] || {};
    var extra = tradeExtras[tid] || {};

    // 세트(구성품 있는 것) 식별 — 대표행 표시에 'SET' 라벨 붙이기 위함
    var setsWithComponents = {};
    g.equipments.forEach(function(eq) {
      if (!eq.isHeader && eq.setName) setsWithComponents[eq.setName] = true;
    });

    var checkInfo = getEquipmentCheckForTrade_(equipmentChecks, tid);

    // 모든 행 표시 (세트 대표 + 구성품 + 단품). 각 행에 체크 상태 + isSet 라벨 부여.
    var displayEquip = g.equipments.map(function(eq) {
      return {
        scheduleId: eq.scheduleId,
        name: eq.name,
        qty: eq.qty,
        setName: eq.setName,
        isHeader: eq.isHeader,                                       // 단품 또는 세트 대표행
        isSet: eq.isHeader && !!setsWithComponents[eq.name],          // 세트 대표(구성품 있음)
        isComponent: !!eq.setName && !eq.isHeader,                    // 세트 구성품
        checkedCheckout: props['itemCheck_' + eq.scheduleId + '_checkout'] === '1',
        checkedCheckin:  props['itemCheck_' + eq.scheduleId + '_checkin']  === '1'
      };
    });

    var isContractReturned = String(cust.contractStatus || '').trim() === '반납완료';
    var setupDone = props['setupDone_' + tid] === '1';
    var returnDone = props['returnDone_' + tid] === '1' || isContractReturned;
    var setupDoneAt = props['setupDoneAt_' + tid] || '';
    var returnDoneAt = props['returnDoneAt_' + tid] || '';

    var item = {
      tradeId: tid,
      name: cust.name || tid,
      tel: cust.tel || '',
      company: cust.company || '',
      status: g.상태,
      contractStatus: cust.contractStatus || '',
      setupDone: setupDone,
      returnDone: returnDone,
      setupDoneAt: setupDoneAt,
      returnDoneAt: returnDoneAt,
      contractUrl: extra.contractUrl || '',
      paymentMethod: extra.paymentMethod || '',
      paymentSource: extra.paymentSource || '',
      paymentWarning: extra.paymentWarning || '',
      depositStatus: extra.depositStatus || '',
      proofType: extra.proofType || '',
      issueStatus: extra.issueStatus || '',
      billingCompany: extra.billingCompany || '',
      issueNote: extra.issueNote || '',
      returnStatus: checkInfo.returnStatus || '',
      returnMemo: checkInfo.returnMemo || '',
      equipmentCheckRow: checkInfo.row || 0,
      riskWarnings: attachEquipmentRiskWarnings_(buildDashboardEquipmentRiskCandidates_(displayEquip, setSheet, riskCandidateLookup), riskRules),
      equipments: displayEquip
    };

    // 오늘 반출
    if (g.반출일 === today) {
      item.time = g.반출시간 || '시간 미정';
      item.sortTime = normalizeDashboardTimeKey_(g.반출시간);
      item.returnDate = g.반납일 + (g.반납시간 ? ' ' + g.반납시간 : '');
      item._type = 'checkout';
      checkoutList.push(item);
    }

    // 오늘 반납
    if (g.반납일 === today) {
      var checkinItem = JSON.parse(JSON.stringify(item));
      checkinItem.time = g.반납시간 || '시간 미정';
      checkinItem.sortTime = normalizeDashboardTimeKey_(g.반납시간);
      checkinItem.checkoutDate = g.반출일 + (g.반출시간 ? ' ' + g.반출시간 : '');
      checkinItem._type = 'checkin';
      checkinList.push(checkinItem);
    }

    // 현재 대여중 (반출일 <= 오늘 <= 반납일, 취소 아님)
    if (g.반출일 <= today && g.반납일 >= today && g.상태 !== '반납완료' && !isContractReturned) {
      activeCount++;
    }
  });

  // 시간순 정렬
  checkoutList.sort(compareDashboardItemsByTime_);
  checkinList.sort(compareDashboardItemsByTime_);

  var result = {
    date: today,
    checkout: checkoutList,
    checkin: checkinList,
    activeCount: activeCount,
    paymentOptions: getTradePaymentOptions_(),
    proofTypeOptions: getTradeProofTypeOptions_(),
    issueStatusOptions: getTradeIssueStatusOptions_(),
    depositStatusOptions: getTradeDepositStatusOptions_(),
    billingCompanyOptions: getTradeBillingCompanyOptions_()
  };
  if (evaluateRisk) {
    evaluateEquipmentRiskGuidanceStates_(result);
  } else {
    markEquipmentRiskSearchEvaluationSkipped_(result);
  }
  // 등록/취소/일정변경 시 invalidateDashboardCache로 무효화되므로, 날짜 이동 체감을 위해 15분 유지.
  putDashboardCacheJson_(cache, cacheKey, result, 900);
  return result;
}

function getDashboardCacheJson_(cache, cacheKey) {
  try {
    var metaKey = cacheKey + '__count';
    var count = Number(cache.get(metaKey));
    if (count && count > 0 && count <= DASHBOARD_CACHE_MAX_CHUNKS_) {
      var keys = [];
      for (var i = 0; i < count; i++) keys.push(cacheKey + '__' + i);
      var chunks = cache.getAll(keys);
      var parts = [];
      for (var j = 0; j < keys.length; j++) {
        var part = chunks[keys[j]];
        if (part === undefined || part === null) return null;
        parts.push(part);
      }
      return JSON.parse(parts.join(''));
    }

    var cached = cache.get(cacheKey);
    return cached ? JSON.parse(cached) : null;
  } catch (e) {
    return null;
  }
}

function putDashboardCacheJson_(cache, cacheKey, value, seconds) {
  try {
    var text = JSON.stringify(value);
    if (text.length < DASHBOARD_CACHE_CHUNK_SIZE_) {
      cache.put(cacheKey, text, seconds || 900);
      return;
    }

    var count = Math.ceil(text.length / DASHBOARD_CACHE_CHUNK_SIZE_);
    if (count < 1 || count > DASHBOARD_CACHE_MAX_CHUNKS_) return;
    var payload = {};
    payload[cacheKey + '__count'] = String(count);
    for (var i = 0; i < count; i++) {
      payload[cacheKey + '__' + i] = text.slice(
        i * DASHBOARD_CACHE_CHUNK_SIZE_,
        (i + 1) * DASHBOARD_CACHE_CHUNK_SIZE_
      );
    }
    cache.putAll(payload, seconds || 900);
  } catch (e) {}
}

function removeDashboardCacheJson_(cache, cacheKey) {
  try {
    var keys = [cacheKey, cacheKey + '__count'];
    for (var i = 0; i < DASHBOARD_CACHE_MAX_CHUNKS_; i++) keys.push(cacheKey + '__' + i);
    cache.removeAll(keys);
  } catch (e) {
    try { cache.remove(cacheKey); } catch (e2) {}
  }
}

function getDashboardSearchData(query, options) {
  query = String(query || '').trim();
  options = options || {};
  var limit = Number(options.limit) || 80;
  if (limit < 1) limit = 80;
  if (limit > 150) limit = 150;
  var profile = options.profile === true || options.profile === 1 || options.profile === '1' || options.profile === 'true';
  var summaryOnly = options.summary === true || options.summary === 1 || options.summary === '1' || options.summary === 'true';
  var detailGroup = String(options.detailGroup || '').trim();
  var profileStart = Date.now();
  var profileMarks = [];
  function markProfile_(step) {
    if (profile) profileMarks.push({ step: step, ms: Date.now() - profileStart });
  }
  function attachProfile_(result) {
    if (profile) {
      markProfile_('return');
      result.profile = profileMarks;
    }
    return result;
  }

  var terms = normalizeDashboardSearchText_(query).split(' ').filter(Boolean);
  if (!terms.length) {
    return attachProfile_({
      query: query,
      checkout: [],
      checkin: [],
      total: 0,
      limit: limit,
      paymentOptions: getTradePaymentOptions_(),
      proofTypeOptions: getTradeProofTypeOptions_(),
      issueStatusOptions: getTradeIssueStatusOptions_(),
      depositStatusOptions: getTradeDepositStatusOptions_(),
      billingCompanyOptions: getTradeBillingCompanyOptions_()
    });
  }
  markProfile_('terms');

  var cache = CacheService.getScriptCache();
  var resultCacheKey = getDashboardSearchResultCacheKey_(query, limit, summaryOnly, detailGroup);
  if (!profile) {
    var cachedResult = getDashboardCacheJson_(cache, resultCacheKey);
    if (cachedResult) return cachedResult;
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var schedSheet = ss.getSheetByName('스케줄상세');
  var contractSheet = ss.getSheetByName('계약마스터');
  var setSheet = ss.getSheetByName('세트마스터');
  if (!schedSheet || schedSheet.getLastRow() < 2) {
    return attachProfile_({ query: query, checkout: [], checkin: [], total: 0, limit: limit });
  }
  markProfile_('sheets');

  var searchIndex = getDashboardSearchIndex_(ss, schedSheet, contractSheet);
  var entries = (searchIndex && searchIndex.entries) || [];
  markProfile_('search_index');

  var candidates = [];
  entries.forEach(function(entry) {
    var haystack = String(entry.x || entry.searchText || '');
    if (!terms.every(function(term) { return haystack.indexOf(term) >= 0; })) return;
    candidates.push({
      type: 'checkout',
      entry: entry,
      sortDate: normalizeDashboardSearchDateKey_(entry.od),
      sortTime: normalizeDashboardTimeKey_(entry.ot)
    });
    candidates.push({
      type: 'checkin',
      entry: entry,
      sortDate: normalizeDashboardSearchDateKey_(entry.rd),
      sortTime: normalizeDashboardTimeKey_(entry.rt)
    });
  });
  candidates.sort(compareDashboardSearchCandidates_);
  markProfile_('match');

  var visible = candidates.length > limit ? candidates.slice(0, limit) : candidates;
  var detailVisible = visible;
  if (!summaryOnly && detailGroup) {
    detailVisible = visible.filter(function(candidate) {
      return getDashboardSearchCandidateGroupLabel_(candidate) === detailGroup;
    });
    markProfile_('detail_group_filter');
  }
  if (summaryOnly) {
    var summaryCheckout = [];
    var summaryCheckin = [];
    visible.forEach(function(candidate) {
      var summaryItem = buildDashboardSearchSummaryItem_(candidate);
      if (candidate.type === 'checkout') summaryCheckout.push(summaryItem);
      else summaryCheckin.push(summaryItem);
    });
    var summaryResult = {
      query: query,
      checkout: summaryCheckout,
      checkin: summaryCheckin,
      total: candidates.length,
      returned: visible.length,
      limit: limit,
      summaryMode: true
    };
    if (!profile) putDashboardCacheJson_(cache, resultCacheKey, summaryResult, 300);
    return attachProfile_(summaryResult);
  }

  var props = PropertiesService.getScriptProperties().getProperties();
  var includeSearchRiskWarnings = options.includeRiskWarnings === true ||
    options.includeRiskWarnings === 1 ||
    options.includeRiskWarnings === '1' ||
    options.includeRiskWarnings === 'true';
  var riskRules = [];
  var riskCandidateLookup = {};
  if (includeSearchRiskWarnings) {
    riskRules = getEquipmentRiskRules_();
    riskCandidateLookup = buildDashboardSetComponentLookup_(setSheet);
  }
  markProfile_('options');

  var visibleTradeIds = [];
  var visibleSeen = {};
  detailVisible.forEach(function(candidate) {
    var tid = String((candidate.entry && candidate.entry.tid) || '').trim();
    if (tid && !visibleSeen[tid]) {
      visibleSeen[tid] = true;
      visibleTradeIds.push(tid);
    }
  });
  var visibleRowsByTid = {};
  detailVisible.forEach(function(candidate) {
    var entry = candidate.entry || {};
    var tid = String(entry.tid || '').trim();
    var rows = Array.isArray(entry.rs) ? entry.rs : [];
    if (tid && rows.length) {
      if (!visibleRowsByTid[tid]) visibleRowsByTid[tid] = [];
      visibleRowsByTid[tid] = visibleRowsByTid[tid].concat(rows);
    }
  });
  var visibleGroups = getDashboardSearchGroupsForIds_(schedSheet, visibleTradeIds, visibleRowsByTid);
  markProfile_('visible_groups');
  var visibleContracts = getDashboardContractMapForIds_(contractSheet, visibleTradeIds);
  markProfile_('visible_contracts');
  var visibleExtras = getTradeExtrasForIds_(visibleTradeIds, props);
  markProfile_('visible_extras');
  var visibleEquipmentChecks = getEquipmentCheckMapForIds_(visibleTradeIds);
  markProfile_('visible_details');

  var builtByTid = {};
  var checkoutList = [];
  var checkinList = [];

  detailVisible.forEach(function(candidate) {
    var entry = candidate.entry || {};
    var tid = entry.tid || '';
    var g = visibleGroups[tid] || {
      거래ID: tid,
      반출일: entry.od || '',
      반출시간: entry.ot || '',
      반납일: entry.rd || '',
      반납시간: entry.rt || '',
      상태: '',
      equipments: []
    };
    if (!builtByTid[tid]) {
      builtByTid[tid] = buildDashboardSearchItem_(
        tid,
        g,
        visibleContracts[tid] || {},
        visibleExtras[tid] || {},
        getEquipmentCheckForTrade_(visibleEquipmentChecks, tid),
        props,
        riskRules,
        includeSearchRiskWarnings ? setSheet : null,
        riskCandidateLookup,
        { includeRiskWarnings: includeSearchRiskWarnings }
      );
    }

    var item = cloneDashboardItem_(builtByTid[tid]);
    if (candidate.type === 'checkout') {
      item.time = g.반출시간 || '시간 미정';
      item.sortTime = normalizeDashboardTimeKey_(g.반출시간);
      item.sortDate = normalizeDashboardSearchDateKey_(g.반출일);
      item.returnDate = g.반납일 + (g.반납시간 ? ' ' + g.반납시간 : '');
      item.searchDate = g.반출일;
      item.searchPhaseLabel = '반출';
      item.searchGroupLabel = formatDashboardSearchGroupLabel_(g.반출일, '반출');
      item._type = 'checkout';
      checkoutList.push(item);
    } else {
      item.time = g.반납시간 || '시간 미정';
      item.sortTime = normalizeDashboardTimeKey_(g.반납시간);
      item.sortDate = normalizeDashboardSearchDateKey_(g.반납일);
      item.checkoutDate = g.반출일 + (g.반출시간 ? ' ' + g.반출시간 : '');
      item.searchDate = g.반납일;
      item.searchPhaseLabel = '반납';
      item.searchGroupLabel = formatDashboardSearchGroupLabel_(g.반납일, '반납');
      item._type = 'checkin';
      checkinList.push(item);
    }
  });
  markProfile_('build_items');

  checkoutList.sort(compareDashboardSearchItems_);
  checkinList.sort(compareDashboardSearchItems_);
  var all = checkoutList.concat(checkinList).sort(compareDashboardSearchItems_);

  var result = {
    query: query,
    checkout: all.filter(function(item) { return item._type === 'checkout'; }),
    checkin: all.filter(function(item) { return item._type === 'checkin'; }),
    total: candidates.length,
    returned: detailGroup ? visible.length : all.length,
    limit: limit,
    detailGroup: detailGroup,
    partialDetailMode: !!detailGroup,
    paymentOptions: getTradePaymentOptions_(),
    proofTypeOptions: getTradeProofTypeOptions_(),
    issueStatusOptions: getTradeIssueStatusOptions_(),
    depositStatusOptions: getTradeDepositStatusOptions_(),
    billingCompanyOptions: getTradeBillingCompanyOptions_()
  };
  markEquipmentRiskSearchEvaluationSkipped_(result);
  if (!profile) putDashboardCacheJson_(cache, resultCacheKey, result, 300);
  return attachProfile_(result);
}

function getDashboardSearchCandidateGroupLabel_(candidate) {
  candidate = candidate || {};
  var entry = candidate.entry || {};
  var isCheckout = candidate.type === 'checkout';
  return formatDashboardSearchGroupLabel_(
    isCheckout ? entry.od : entry.rd,
    isCheckout ? '반출' : '반납'
  );
}

function buildDashboardSearchSummaryItem_(candidate) {
  candidate = candidate || {};
  var entry = candidate.entry || {};
  var isCheckout = candidate.type === 'checkout';
  var dateValue = isCheckout ? entry.od : entry.rd;
  var timeValue = isCheckout ? entry.ot : entry.rt;
  var otherDate = isCheckout ? entry.rd : entry.od;
  var otherTime = isCheckout ? entry.rt : entry.ot;
  var item = {
    tradeId: entry.tid || '',
    name: entry.n || entry.tid || '',
    tel: entry.tel || '',
    company: entry.co || '',
    status: entry.st || '',
    contractStatus: entry.cs || '',
    time: timeValue || '시간 미정',
    sortTime: normalizeDashboardTimeKey_(timeValue),
    sortDate: normalizeDashboardSearchDateKey_(dateValue),
    searchDate: dateValue || '',
    searchPhaseLabel: isCheckout ? '반출' : '반납',
    searchGroupLabel: formatDashboardSearchGroupLabel_(dateValue, isCheckout ? '반출' : '반납'),
    _type: isCheckout ? 'checkout' : 'checkin',
    equipments: expandDashboardSearchSummaryEquipments_(entry.eq)
  };
  if (isCheckout) item.returnDate = otherDate + (otherTime ? ' ' + otherTime : '');
  else item.checkoutDate = otherDate + (otherTime ? ' ' + otherTime : '');
  return item;
}

function expandDashboardSearchSummaryEquipments_(items) {
  return (items || []).map(function(item) {
    if (Array.isArray(item)) {
      return {
        scheduleId: item[0] || '',
        name: item[1] || '',
        qty: item[2] || 1,
        setName: item[3] || '',
        isHeader: true,
        isSet: item[4] === 1 || item[4] === true,
        isComponent: false
      };
    }
    return item || {};
  });
}

function getDashboardSearchClientIndex_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var schedSheet = ss.getSheetByName('스케줄상세');
  var contractSheet = ss.getSheetByName('계약마스터');
  if (!schedSheet || schedSheet.getLastRow() < 2) {
    return { success: true, builtAt: '', entries: [] };
  }
  var index = getDashboardSearchIndex_(ss, schedSheet, contractSheet);
  return {
    success: true,
    builtAt: index.builtAt || '',
    cacheVersion: getDashboardSearchCacheVersion_(),
    lastRow: schedSheet.getLastRow(),
    entries: index.entries || []
  };
}

function getDashboardSearchIndex_(ss, schedSheet, contractSheet) {
  var cache = CacheService.getScriptCache();
  var cacheKey = 'dashboard_search_index_v8_' + getTimelineCacheVersion_() + '_' +
    getDashboardSearchCacheVersion_() + '_' + schedSheet.getLastRow();
  var cached = getDashboardCacheJson_(cache, cacheKey);
  if (cached && Array.isArray(cached.entries)) return cached;

  var data = schedSheet.getRange(2, 1, schedSheet.getLastRow() - 1, 12).getDisplayValues();
  var tradeGroups = {};
  data.forEach(function(row, idx) {
    var tradeId = String(row[1] || '').trim();
    var setName = String(row[2] || '').trim();
    var equipName = String(row[3] || '').trim();
    var status = String(row[9] || '대기').trim();
    if (!tradeId || !equipName || status === '취소') return;

    if (!tradeGroups[tradeId]) {
      tradeGroups[tradeId] = {
        거래ID: tradeId,
        반출일: String(row[5] || '').trim(),
        반출시간: String(row[6] || '').trim(),
        반납일: String(row[7] || '').trim(),
        반납시간: String(row[8] || '').trim(),
        상태: status,
        rowNums: [],
        equipments: []
      };
    }

    tradeGroups[tradeId].rowNums.push(idx + 2);
    var isHeader = setName === '' || setName === equipName;
    tradeGroups[tradeId].equipments.push({
      scheduleId: String(row[0] || '').trim(),
      name: equipName,
      qty: row[4] || 1,
      setName: setName,
      isHeader: isHeader
    });
  });

  var tradeIds = Object.keys(tradeGroups);
  var contractMap = getDashboardContractMapForIds_(contractSheet, tradeIds);
  var props = PropertiesService.getScriptProperties().getProperties();
  var tradeExtras = getTradeExtrasForIds_(tradeIds, props);
  var equipmentChecks = getEquipmentCheckMapForIds_(tradeIds);
  var entries = tradeIds.map(function(tid) {
    var group = tradeGroups[tid];
    var cust = contractMap[tid] || {};
    var extra = tradeExtras[tid] || {};
    var checkInfo = getEquipmentCheckForTrade_(equipmentChecks, tid);
    return {
      tid: tid,
      n: cust.name || '',
      tel: cust.tel || '',
      co: cust.company || '',
      cs: cust.contractStatus || '',
      st: group.상태 || '',
      od: group.반출일 || '',
      ot: group.반출시간 || '',
      rd: group.반납일 || '',
      rt: group.반납시간 || '',
      rs: group.rowNums || [],
      x: buildDashboardSearchText_(group, cust, extra, checkInfo)
    };
  });

  var index = {
    builtAt: Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss'),
    entries: entries
  };
  putDashboardCacheJson_(cache, cacheKey, index, 300);
  return index;
}

function getDashboardSearchGroupsForIds_(schedSheet, tradeIds, rowsByTid) {
  var groups = {};
  var wanted = {};
  (tradeIds || []).forEach(function(tid) {
    tid = String(tid || '').trim();
    if (tid) wanted[tid] = true;
  });
  if (!schedSheet || schedSheet.getLastRow() < 2 || Object.keys(wanted).length === 0) return groups;

  var rowNums = [];
  var seenRows = {};
  var hasRowsForAll = !!rowsByTid;
  Object.keys(wanted).forEach(function(tid) {
    var rows = rowsByTid && rowsByTid[tid];
    if (!rows || !rows.length) {
      hasRowsForAll = false;
      return;
    }
    rows.forEach(function(rowNum) {
      rowNum = Number(rowNum);
      if (rowNum >= 2 && !seenRows[rowNum]) {
        seenRows[rowNum] = true;
        rowNums.push(rowNum);
      }
    });
  });
  rowNums.sort(function(a, b) { return a - b; });

  var data = hasRowsForAll && rowNums.length
    ? readDashboardScheduleRowsDisplay_(schedSheet, rowNums, 12)
    : schedSheet.getRange(2, 1, schedSheet.getLastRow() - 1, 12).getDisplayValues();
  data.forEach(function(row) {
    var tradeId = String(row[1] || '').trim();
    if (!wanted[tradeId]) return;
    var setName = String(row[2] || '').trim();
    var equipName = String(row[3] || '').trim();
    var status = String(row[9] || '대기').trim();
    if (!tradeId || !equipName || status === '취소') return;

    if (!groups[tradeId]) {
      groups[tradeId] = {
        거래ID: tradeId,
        반출일: String(row[5] || '').trim(),
        반출시간: String(row[6] || '').trim(),
        반납일: String(row[7] || '').trim(),
        반납시간: String(row[8] || '').trim(),
        상태: status,
        equipments: []
      };
    }

    var isHeader = setName === '' || setName === equipName;
    groups[tradeId].equipments.push({
      scheduleId: String(row[0] || '').trim(),
      name: equipName,
      qty: row[4] || 1,
      setName: setName,
      isHeader: isHeader
    });
  });
  return groups;
}

function compareDashboardSearchCandidates_(a, b) {
  var dateCmp = String(a.sortDate || '').localeCompare(String(b.sortDate || ''));
  if (dateCmp) return dateCmp;
  var timeCmp = String(a.sortTime || '').localeCompare(String(b.sortTime || ''));
  if (timeCmp) return timeCmp;
  var at = String((a.entry && a.entry.tid) || '');
  var bt = String((b.entry && b.entry.tid) || '');
  var nameCmp = at.localeCompare(bt);
  if (nameCmp) return nameCmp;
  return String(a.type || '').localeCompare(String(b.type || ''));
}

function getDashboardSearchCacheVersion_() {
  try {
    return PropertiesService.getScriptProperties().getProperty(DASHBOARD_SEARCH_CACHE_VERSION_PROP_) || '0';
  } catch (e) {
    return '0';
  }
}

function touchDashboardSearchCacheVersion_() {
  try {
    PropertiesService.getScriptProperties().setProperty(DASHBOARD_SEARCH_CACHE_VERSION_PROP_, String(Date.now()));
  } catch (e) {}
}

function getDashboardSearchResultCacheKey_(query, limit, summaryOnly, detailGroup) {
  var raw = getTimelineCacheVersion_() + '|' + getDashboardSearchCacheVersion_() + '|' + limit + '|' +
    (summaryOnly ? 'summary' : 'detail') + '|' +
    normalizeDashboardSearchText_(detailGroup || '') + '|' +
    normalizeDashboardSearchText_(query);
  var digest = Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, raw))
    .replace(/=+$/g, '');
  return 'dashboard_search_result_v6_' + digest;
}

function buildDashboardSearchItem_(tid, g, cust, extra, checkInfo, props, riskRules, setSheet, riskCandidateLookup, options) {
  options = options || {};
  var includeRiskWarnings = options.includeRiskWarnings !== false;
  if (includeRiskWarnings && !riskRules) riskRules = getEquipmentRiskRules_();
  var setsWithComponents = {};
  g.equipments.forEach(function(eq) {
    if (!eq.isHeader && eq.setName) setsWithComponents[eq.setName] = true;
  });

  var displayEquip = g.equipments.map(function(eq) {
    return {
      scheduleId: eq.scheduleId,
      name: eq.name,
      qty: eq.qty,
      setName: eq.setName,
      isHeader: eq.isHeader,
      isSet: eq.isHeader && !!setsWithComponents[eq.name],
      isComponent: !!eq.setName && !eq.isHeader,
      checkedCheckout: props['itemCheck_' + eq.scheduleId + '_checkout'] === '1',
      checkedCheckin: props['itemCheck_' + eq.scheduleId + '_checkin'] === '1'
    };
  });

  var isContractReturned = String(cust.contractStatus || '').trim() === '반납완료';
  return {
    tradeId: tid,
    name: cust.name || tid,
    tel: cust.tel || '',
    company: cust.company || '',
    status: g.상태,
    contractStatus: cust.contractStatus || '',
    setupDone: props['setupDone_' + tid] === '1',
    returnDone: props['returnDone_' + tid] === '1' || isContractReturned,
    setupDoneAt: props['setupDoneAt_' + tid] || '',
    returnDoneAt: props['returnDoneAt_' + tid] || '',
    contractUrl: extra.contractUrl || '',
    paymentMethod: extra.paymentMethod || '',
    paymentSource: extra.paymentSource || '',
    paymentWarning: extra.paymentWarning || '',
    depositStatus: extra.depositStatus || '',
    proofType: extra.proofType || '',
    issueStatus: extra.issueStatus || '',
    billingCompany: extra.billingCompany || '',
    issueNote: extra.issueNote || '',
    returnStatus: checkInfo.returnStatus || '',
    returnMemo: checkInfo.returnMemo || '',
    equipmentCheckRow: checkInfo.row || 0,
    riskWarnings: includeRiskWarnings
      ? attachEquipmentRiskWarnings_(buildDashboardEquipmentRiskCandidates_(displayEquip, setSheet, riskCandidateLookup), riskRules)
      : [],
    equipments: displayEquip
  };
}

function dashboardSearchTradeMatches_(terms, group, cust, extra, checkInfo) {
  var haystack = buildDashboardSearchText_(group, cust, extra, checkInfo);
  return terms.every(function(term) { return haystack.indexOf(term) >= 0; });
}

function buildDashboardSearchText_(group, cust, extra, checkInfo) {
  group = group || {};
  cust = cust || {};
  extra = extra || {};
  checkInfo = checkInfo || {};
  var parts = [
    group.거래ID,
    cust.name,
    cust.tel,
    cust.company,
    cust.contractStatus,
    group.상태,
    group.반출일,
    group.반출시간,
    group.반납일,
    group.반납시간,
    extra.paymentMethod,
    extra.depositStatus,
    extra.proofType,
    extra.issueStatus,
    extra.billingCompany,
    checkInfo.returnStatus,
    checkInfo.returnMemo
  ];
  (group.equipments || []).forEach(function(eq) {
    parts.push(eq.name, eq.setName);
  });

  return compactDashboardSearchTextParts_(parts);
}

function compactDashboardSearchTextParts_(parts) {
  var seen = {};
  var out = [];
  (parts || []).forEach(function(part) {
    normalizeDashboardSearchText_(part).split(' ').forEach(function(token) {
      if (!token || seen[token]) return;
      seen[token] = true;
      out.push(token);
    });
  });
  return out.join(' ');
}

function getEquipmentRiskRules_() {
  return getDashboardCachedJson_("dashboard_equipment_risk_rules_v1", 300, function() {
    return readEquipmentRiskRules_();
  });
}

function readEquipmentRiskRules_() {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(EQUIPMENT_RISK_RULE_SHEET_NAME);
    if (!sheet || sheet.getLastRow() < 2) return [];

    var lastCol = sheet.getLastColumn();
    var headers = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
    var headerMap = buildEquipmentRiskHeaderMap_(headers);
    var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, lastCol).getDisplayValues();
    var rules = [];

    values.forEach(function(row, idx) {
      var activeRaw = readEquipmentRiskCell_(row, headerMap.active);
      if (activeRaw && !isEquipmentRiskActive_(activeRaw)) return;

      var equipmentName = readEquipmentRiskCell_(row, headerMap.equipmentName);
      var aliases = splitEquipmentRiskAliases_(readEquipmentRiskCell_(row, headerMap.aliases));
      if (equipmentName) aliases.unshift(equipmentName);
      aliases = uniqueEquipmentRiskAliases_(aliases);
      if (!aliases.length) return;

      var cooldownDays = Number(readEquipmentRiskCell_(row, headerMap.cooldownDays));
      if (!cooldownDays || cooldownDays < 0) cooldownDays = 90;

      var ruleVersion = Number(readEquipmentRiskCell_(row, headerMap.ruleVersion));
      if (!ruleVersion || ruleVersion < 1) ruleVersion = 1;

      var ruleId = readEquipmentRiskCell_(row, headerMap.ruleId) ||
        normalizeEquipmentRiskName_(aliases[0]) + '_v' + ruleVersion;

      rules.push({
        ruleId: ruleId,
        row: idx + 2,
        equipmentName: equipmentName || aliases[0],
        aliases: aliases,
        riskLevel: readEquipmentRiskCell_(row, headerMap.riskLevel) || '주의',
        pickupStaffText: readEquipmentRiskCell_(row, headerMap.pickupStaffText),
        customerMessage: readEquipmentRiskCell_(row, headerMap.customerMessage),
        returnCheckText: readEquipmentRiskCell_(row, headerMap.returnCheckText),
        sensitive: parseEquipmentRiskBoolean_(readEquipmentRiskCell_(row, headerMap.sensitive)),
        cooldownDays: cooldownDays,
        ruleVersion: ruleVersion
      });
    });

    return rules;
  } catch (err) {
    Logger.log('getEquipmentRiskRules_ failed: ' + err.message);
    return [];
  }
}

function buildEquipmentRiskHeaderMap_(headers) {
  return {
    active: findEquipmentRiskHeader_(headers, ['활성', '사용', '사용여부', 'active', 'enabled', 'isActive']),
    ruleId: findEquipmentRiskHeader_(headers, ['규칙ID', '룰ID', 'ruleId', 'rule_id', 'id']),
    equipmentName: findEquipmentRiskHeader_(headers, ['장비명', '장비', '대상장비', 'equipment', 'equipmentName', 'name']),
    aliases: findEquipmentRiskHeader_(headers, ['별칭', '키워드', 'aliases', 'alias', 'keywords']),
    riskLevel: findEquipmentRiskHeader_(headers, ['위험도', '주의도', '리스크레벨', 'riskLevel', 'risk_level', 'level']),
    pickupStaffText: findEquipmentRiskHeader_(headers, ['반출직원문구', '반출직원안내', '직원안내', 'pickupStaffText', 'pickup_staff_text']),
    customerMessage: findEquipmentRiskHeader_(headers, ['고객카톡문구', '고객문구', '고객안내', '고객메시지', 'customerMessage', 'customer_message']),
    returnCheckText: findEquipmentRiskHeader_(headers, ['반납체크문구', '반납확인', '반납검수', 'returnCheckText', 'return_check_text']),
    sensitive: findEquipmentRiskHeader_(headers, ['민감발송', '민감', '민감여부', 'sensitive', 'isSensitive']),
    cooldownDays: findEquipmentRiskHeader_(headers, ['재추천차단일', '쿨다운일', '쿨다운', 'cooldownDays', 'cooldown_days']),
    ruleVersion: findEquipmentRiskHeader_(headers, ['버전', '규칙버전', 'ruleVersion', 'rule_version', 'version'])
  };
}

function findEquipmentRiskHeader_(headers, candidates) {
  var normalized = {};
  (headers || []).forEach(function(header, idx) {
    normalized[normalizeEquipmentRiskHeader_(header)] = idx;
  });
  for (var i = 0; i < candidates.length; i++) {
    var key = normalizeEquipmentRiskHeader_(candidates[i]);
    if (normalized[key] !== undefined) return normalized[key];
  }
  return -1;
}

function normalizeEquipmentRiskHeader_(value) {
  return String(value || '').toLowerCase().replace(/[\s_\-()]/g, '').trim();
}

function readEquipmentRiskCell_(row, idx) {
  if (idx === undefined || idx < 0) return '';
  return String(row[idx] || '').trim();
}

function isEquipmentRiskActive_(value) {
  var v = String(value || '').toLowerCase().replace(/\s+/g, '').trim();
  return ['0', 'false', 'n', 'no', 'off', '비활성', '중지', '아니오', '아님', '미사용'].indexOf(v) === -1;
}

function parseEquipmentRiskBoolean_(value) {
  var v = String(value || '').toLowerCase().replace(/\s+/g, '').trim();
  return ['1', 'true', 'y', 'yes', 'on', '민감', '예', '사용', '주의'].indexOf(v) !== -1;
}

function splitEquipmentRiskAliases_(value) {
  return String(value || '')
    .split(/[,;\n|]+/)
    .map(function(v) { return String(v || '').trim(); })
    .filter(function(v) { return v; });
}

function uniqueEquipmentRiskAliases_(aliases) {
  var seen = {};
  var result = [];
  (aliases || []).forEach(function(alias) {
    var clean = String(alias || '').trim();
    var key = normalizeEquipmentRiskName_(clean);
    if (!clean || !key || seen[key]) return;
    seen[key] = true;
    result.push(clean);
  });
  return result;
}

function normalizeEquipmentRiskName_(value) {
  return String(value || '').toLowerCase().replace(/[\s\[\]\(\){}·•_,.]/g, '').trim();
}

function buildDashboardSetComponentLookup_(setSheet) {
  try {
    return (buildDashboardSetLookup_(setSheet).components || {});
  } catch (err) {
    return {};
  }
}

function buildDashboardEquipmentRiskCandidates_(displayEquip, setSheet, setComponentLookup) {
  var candidates = [];
  var seen = {};
  var setComponentCache = {};
  setComponentLookup = setComponentLookup || {};

  function pushCandidate(eq) {
    var name = String((eq && eq.name) || '').trim();
    if (!name) return;

    var setName = String((eq && (eq.setName || eq.sourceSetName)) || '').trim();
    var key = normalizeEquipmentRiskName_(name) + '|' + normalizeEquipmentRiskName_(setName);
    if (seen[key]) return;
    seen[key] = true;
    candidates.push(eq);
  }

  (displayEquip || []).forEach(function(eq) {
    pushCandidate(eq);

    if (!eq || !eq.isHeader || eq.isComponent) return;

    var setName = String(eq.name || '').trim();
    if (!setName) return;
    if (eq.isSet !== true && !Object.prototype.hasOwnProperty.call(setComponentLookup, setName)) return;

    if (setComponentCache[setName] === undefined) {
      if (Object.prototype.hasOwnProperty.call(setComponentLookup, setName)) {
        setComponentCache[setName] = setComponentLookup[setName] || [];
      } else {
        try {
          setComponentCache[setName] = getSetComponents(setName, setSheet) || [];
        } catch (err) {
          setComponentCache[setName] = [];
        }
      }
    }

    (setComponentCache[setName] || []).forEach(function(component) {
      var componentName = String((component && component.name) || '').trim();
      if (!componentName) return;

      pushCandidate({
        scheduleId: eq.scheduleId,
        name: componentName,
        qty: component.qty || 1,
        setName: setName,
        isHeader: false,
        isSet: false,
        isComponent: true,
        sourceSetName: setName,
        riskSource: 'set_component',
        checkedCheckout: eq.checkedCheckout,
        checkedCheckin: eq.checkedCheckin
      });
    });
  });

  return candidates;
}

function matchEquipmentRiskRulesForEquipments_(equipments, rules) {
  var matches = [];
  var seen = {};
  (equipments || []).forEach(function(eq) {
    var eqName = String((eq && eq.name) || '').trim();
    var eqKey = normalizeEquipmentRiskName_(eqName);
    if (!eqKey) return;

    (rules || []).forEach(function(rule) {
      var aliases = rule.aliases || [];
      var matchedAlias = '';
      for (var i = 0; i < aliases.length; i++) {
        var alias = String(aliases[i] || '').trim();
        var aliasKey = normalizeEquipmentRiskName_(alias);
        if (!aliasKey || aliasKey.length < 2) continue;
        if (eqKey === aliasKey || eqKey.indexOf(aliasKey) >= 0 || aliasKey.indexOf(eqKey) >= 0) {
          matchedAlias = alias;
          break;
        }
      }
      if (!matchedAlias) return;

      var key = String(rule.ruleId || '') + '|' + eqKey;
      if (seen[key]) return;
      seen[key] = true;
      matches.push({
        rule: rule,
        equipment: eq,
        equipmentName: eqName,
        matchedAlias: matchedAlias
      });
    });
  });
  return matches;
}

function attachEquipmentRiskWarnings_(displayEquip, riskRules) {
  return matchEquipmentRiskRulesForEquipments_(displayEquip, riskRules).map(function(match) {
    var rule = match.rule || {};
    return {
      ruleId: rule.ruleId || '',
      ruleVersion: rule.ruleVersion || 1,
      riskLevel: rule.riskLevel || '주의',
      equipmentName: match.equipmentName || rule.equipmentName || '',
      matchedAlias: match.matchedAlias || '',
      pickupStaffText: rule.pickupStaffText || '',
      customerMessage: rule.customerMessage || '',
      returnCheckText: rule.returnCheckText || '',
      sensitive: !!rule.sensitive,
      cooldownDays: rule.cooldownDays || 90,
      guidanceState: 'history_unknown',
      canDirectSend: false,
      guidanceReason: ''
    };
  });
}

function markEquipmentRiskSearchEvaluationSkipped_(result) {
  collectEquipmentRiskDashboardItems_(result).forEach(function(item) {
    (item.riskWarnings || []).forEach(function(warning) {
      warning.guidanceState = 'history_unknown';
      warning.canDirectSend = false;
      warning.guidanceReason = 'search_evaluation_skipped';
    });
  });
  return result;
}

function getEquipmentRiskBackendConfig_() {
  var props = PropertiesService.getScriptProperties();
  var baseUrl = String(props.getProperty('VILLAGE_KAKAO_AI_ADMIN_URL') || '').replace(/\/+$/, '').trim();
  var token = String(props.getProperty('VILLAGE_KAKAO_AI_ADMIN_TOKEN') || '').trim();
  if (!baseUrl || !token) {
    return { error: 'backend_config_missing', baseUrl: baseUrl, hasToken: !!token };
  }
  return { baseUrl: baseUrl, token: token };
}

function diagEquipmentRiskBackendConfig() {
  var props = PropertiesService.getScriptProperties();
  var baseUrl = String(props.getProperty('VILLAGE_KAKAO_AI_ADMIN_URL') || '').replace(/\/+$/, '').trim();
  var token = String(props.getProperty('VILLAGE_KAKAO_AI_ADMIN_TOKEN') || '').trim();
  return {
    ok: !!baseUrl && !!token,
    baseUrl: baseUrl,
    hasToken: !!token,
    tokenLength: token.length
  };
}

function setupEquipmentRiskBackendConfig(adminUrl, adminToken) {
  var baseUrl = String(adminUrl || '').replace(/\/+$/, '').trim();
  var token = String(adminToken || '').trim();
  if (!baseUrl || !token) {
    throw new Error('adminUrl and adminToken are required');
  }
  var verify = verifyEquipmentRiskBackendConfig_(baseUrl, token);
  if (!verify.ok) {
    throw new Error('equipment risk backend verification failed: ' + verify.status);
  }
  PropertiesService.getScriptProperties().setProperties({
    VILLAGE_KAKAO_AI_ADMIN_URL: baseUrl,
    VILLAGE_KAKAO_AI_ADMIN_TOKEN: token
  }, false);
  var result = diagEquipmentRiskBackendConfig();
  result.verified = true;
  result.verifyStatus = verify.status;
  return result;
}

function verifyEquipmentRiskBackendConfig_(baseUrl, token) {
  try {
    var response = UrlFetchApp.fetch(baseUrl + '/admin/equipment-risk/evaluate', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-admin-token': token },
      payload: JSON.stringify({ reservations: [] }),
      muteHttpExceptions: true
    });
    var status = response.getResponseCode();
    return { ok: status >= 200 && status < 300, status: status };
  } catch (err) {
    return { ok: false, status: err && err.message ? err.message : 'request_failed' };
  }
}

function equipmentRiskReservationPayload_(item) {
  item = item || {};
  return {
    tradeId: item.tradeId || '',
    cardType: item._type || '',
    customerName: item.name || '',
    customerPhone: item.customerPhone || item.tel || item.customerTel || '',
    customerTel: item.customerTel || item.tel || '',
    userType: item.userType || '',
    userId: item.userId || '',
    kakaoUser: item.kakaoUser || null,
    company: item.company || '',
    checkoutDate: item.checkoutDate || '',
    returnDate: item.returnDate || '',
    time: item.time || '',
    equipments: (item.equipments || []).map(function(eq) {
      return {
        scheduleId: eq.scheduleId || '',
        name: eq.name || '',
        qty: eq.qty || 1,
        setName: eq.setName || '',
        isSet: !!eq.isSet,
        isComponent: !!eq.isComponent
      };
    }),
    riskItems: (item.riskWarnings || []).map(equipmentRiskBackendItem_)
  };
}

function equipmentRiskBackendItem_(warning) {
  warning = warning || {};
  return {
    ruleId: warning.ruleId || '',
    ruleVersion: warning.ruleVersion || 1,
    riskLevel: warning.riskLevel || '',
    equipmentName: warning.equipmentName || '',
    matchedAlias: warning.matchedAlias || '',
    pickupStaffText: warning.pickupStaffText || '',
    customerMessage: warning.customerMessage || '',
    returnCheckText: warning.returnCheckText || '',
    sensitive: !!warning.sensitive,
    cooldownDays: warning.cooldownDays || 90
  };
}

function evaluateEquipmentRiskGuidanceStates_(result) {
  var items = collectEquipmentRiskDashboardItems_(result);
  var itemsWithWarnings = items.filter(function(item) {
    return item.riskWarnings && item.riskWarnings.length;
  });
  if (!itemsWithWarnings.length) return result;

  var response = postEquipmentRiskBackend_('/admin/equipment-risk/evaluate', {
    reservations: itemsWithWarnings.map(equipmentRiskReservationPayload_)
  });

  if (!response.success) {
    markEquipmentRiskWarnings_(itemsWithWarnings, response.reason || 'backend_evaluation_failed');
    return result;
  }

  applyEquipmentRiskEvaluation_(itemsWithWarnings, response.data || {});
  return result;
}

function collectEquipmentRiskDashboardItems_(result) {
  var items = [];
  ['checkout', 'checkin'].forEach(function(key) {
    ((result && result[key]) || []).forEach(function(item) { items.push(item); });
  });
  return items;
}

function markEquipmentRiskWarnings_(items, reason) {
  (items || []).forEach(function(item) {
    (item.riskWarnings || []).forEach(function(warning) {
      warning.guidanceState = 'history_unknown';
      warning.canDirectSend = false;
      warning.guidanceReason = reason || 'backend_evaluation_failed';
    });
  });
}

function applyEquipmentRiskEvaluation_(items, data) {
  var byTradeId = {};
  var evaluationList = data.reservations || data.items || (Array.isArray(data.results) ? data.results : []);
  evaluationList.forEach(function(entry) {
    if (entry && entry.tradeId) byTradeId[String(entry.tradeId)] = entry;
  });
  if (data.results && !Array.isArray(data.results)) {
    Object.keys(data.results).forEach(function(tid) {
      byTradeId[String(tid)] = data.results[tid];
    });
  }

  (items || []).forEach(function(item) {
    var evaluated = byTradeId[String(item.tradeId || '')] || {};
    var evaluatedWarnings = evaluated.riskItems || evaluated.warnings || evaluated.riskWarnings || [];
    if (!evaluatedWarnings.length && data.riskItems && items.length === 1) {
      evaluatedWarnings = data.riskItems;
    }
    if (!evaluatedWarnings.length && (evaluated.guidanceState || evaluated.canDirectSend !== undefined)) {
      evaluatedWarnings = [evaluated];
    }

    (item.riskWarnings || []).forEach(function(warning) {
      var matched = findEvaluatedRiskWarning_(warning, evaluatedWarnings);
      if (!matched) return;
      if (matched.guidanceState || matched.state) warning.guidanceState = matched.guidanceState || matched.state;
      if (matched.canDirectSend !== undefined) warning.canDirectSend = !!matched.canDirectSend;
      if (matched.guidanceReason || matched.reason) warning.guidanceReason = matched.guidanceReason || matched.reason;
      if (matched.lastSentAt) warning.lastSentAt = matched.lastSentAt;
      if (matched.lastEventAt) warning.lastEventAt = matched.lastEventAt;
      if (matched.requiresApproval !== undefined) warning.requiresApproval = !!matched.requiresApproval;
      if (matched.userType) warning.userType = matched.userType;
      if (matched.userId) warning.userId = matched.userId;
      if (matched.kakaoUser) warning.kakaoUser = matched.kakaoUser;
      if (matched.customerKey) warning.customerKey = matched.customerKey;
      if (matched.recipientSource) warning.recipientSource = matched.recipientSource;
    });
  });
}

function findEvaluatedRiskWarning_(warning, evaluatedWarnings) {
  for (var i = 0; i < evaluatedWarnings.length; i++) {
    var candidate = evaluatedWarnings[i] || {};
    if (candidate.ruleId && warning.ruleId && String(candidate.ruleId) === String(warning.ruleId)) return candidate;
    if (candidate.equipmentName && warning.equipmentName && String(candidate.equipmentName) === String(warning.equipmentName)) return candidate;
  }
  return evaluatedWarnings.length === 1 ? evaluatedWarnings[0] : null;
}

function postEquipmentRiskBackend_(path, payload) {
  var config = getEquipmentRiskBackendConfig_();
  if (config.error) {
    return { success: false, reason: config.error, error: config.error };
  }

  try {
    var response = UrlFetchApp.fetch(config.baseUrl + path, {
      method: 'post',
      contentType: 'application/json',
      headers: {
        Authorization: 'Bearer ' + config.token,
        'X-Admin-Token': config.token
      },
      payload: JSON.stringify(payload || {}),
      muteHttpExceptions: true
    });
    var text = response.getContentText();
    var data = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (parseErr) {
        return { success: false, reason: 'backend_evaluation_failed', error: '백엔드 응답 파싱 실패: ' + text.slice(0, 200) };
      }
    }
    if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
      return {
        success: false,
        reason: 'backend_evaluation_failed',
        error: data.error || ('HTTP ' + response.getResponseCode())
      };
    }
    if (data && data.error) {
      return { success: false, reason: 'backend_evaluation_failed', error: data.error, data: data };
    }
    return { success: true, data: data };
  } catch (err) {
    return { success: false, reason: 'backend_evaluation_failed', error: err.message };
  }
}

function sendEquipmentRiskGuidance_(payload) {
  payload = payload || {};
  if (payload.riskAction === 'approval' || payload.sendMode === 'approval_request') payload.action = 'approval';
  var response = postEquipmentRiskBackend_('/admin/equipment-risk/customer-guidance', payload || {});
  if (response.success) {
    try { invalidateDashboardCache(); } catch (e) {}
    return response.data || { success: true };
  }
  return { success: false, error: response.error || response.reason, reason: response.reason };
}

function recordEquipmentRiskEvent_(payload) {
  var response = postEquipmentRiskBackend_('/admin/equipment-risk/events', payload || {});
  if (response.success) {
    try { invalidateDashboardCache(); } catch (e) {}
    return response.data || { success: true };
  }
  return { success: false, error: response.error || response.reason, reason: response.reason };
}

function recordOnsiteAddonBackend_(payload) {
  var response = postEquipmentRiskBackend_('/admin/onsite-addons', payload || {});
  if (response.success) {
    try { invalidateDashboardCache(); } catch (e) {}
    return response.data || { success: true };
  }
  return { success: false, error: response.error || response.reason, reason: response.reason };
}

function normalizeDashboardSearchText_(value) {
  return String(value || '').toLowerCase().replace(/[-.\s]+/g, ' ').trim();
}

function normalizeDashboardSearchDateKey_(value) {
  var raw = String(value || '').trim();
  var m = raw.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (!m) return raw;
  return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
}

function formatDashboardSearchGroupLabel_(dateValue, phaseLabel) {
  var key = normalizeDashboardSearchDateKey_(dateValue);
  var m = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  var label = m ? (Number(m[2]) + '/' + Number(m[3])) : String(dateValue || '');
  return label + ' ' + phaseLabel;
}

function cloneDashboardItem_(item) {
  return JSON.parse(JSON.stringify(item || {}));
}

function compareDashboardSearchItems_(a, b) {
  var ad = String((a && a.sortDate) || '');
  var bd = String((b && b.sortDate) || '');
  var dateCmp = ad.localeCompare(bd);
  if (dateCmp) return dateCmp;
  return compareDashboardItemsByTime_(a, b);
}

function normalizeDashboardTimeKey_(timeValue) {
  var raw = String(timeValue || '').trim();
  if (!raw || raw === '시간 미정') return '99:99';

  var isPm = raw.indexOf('오후') >= 0 || /\bPM\b/i.test(raw);
  var isAm = raw.indexOf('오전') >= 0 || /\bAM\b/i.test(raw);
  var match = raw.match(/(\d{1,2})\s*(?::|시)\s*(\d{1,2})?/);
  if (!match) return '99:99';

  var hour = Number(match[1]);
  var minute = match[2] !== undefined ? Number(match[2]) : 0;
  if (isNaN(hour) || isNaN(minute) || hour < 0 || hour > 24 || minute < 0 || minute > 59) {
    return '99:99';
  }
  if (isPm && hour < 12) hour += 12;
  if (isAm && hour === 12) hour = 0;
  if (hour === 24 && minute > 0) return '99:99';

  return ('0' + hour).slice(-2) + ':' + ('0' + minute).slice(-2);
}

function compareDashboardItemsByTime_(a, b) {
  var at = normalizeDashboardTimeKey_(a && (a.sortTime || a.time));
  var bt = normalizeDashboardTimeKey_(b && (b.sortTime || b.time));
  var timeCmp = at.localeCompare(bt);
  if (timeCmp) return timeCmp;

  var an = String((a && (a.name || a.tradeId)) || '');
  var bn = String((b && (b.name || b.tradeId)) || '');
  return an.localeCompare(bn);
}

function getDashboardContractMapForIds_(contractSheet, tradeIds) {
  var result = {};
  var wanted = {};
  (tradeIds || []).forEach(function(tid) {
    tid = String(tid || '').trim();
    if (tid) wanted[tid] = true;
  });
  if (!contractSheet || contractSheet.getLastRow() < 2 || Object.keys(wanted).length === 0) return result;

  try {
    var rowCount = contractSheet.getLastRow() - 1;
    var ids = contractSheet.getRange(2, 1, rowCount, 1).getDisplayValues();
    var rowsToRead = [];
    ids.forEach(function(row, idx) {
      var tid = String(row[0] || '').trim();
      if (wanted[tid]) rowsToRead.push(idx + 2);
    });
    var rows = readDashboardScheduleRowsDisplay_(contractSheet, rowsToRead, 10);
    rows.forEach(function(row) {
      var tid = String(row[0] || '').trim();
      if (!wanted[tid]) return;
      result[tid] = {
        name: row[1] || '',
        tel: row[2] || '',
        company: row[3] || '',
        contractStatus: row[9] || ''
      };
    });
  } catch (err) {}
  return result;
}

var DASHBOARD_NOTES_PROP_KEY = 'dashboardPostItNotes_v1';
var DASHBOARD_DEFAULT_NOTES = [
  '세부 구성품 및 추가 요청 사항은 카톡 대화 내용을 한번 더 확인 후 세팅',
  '매직암, 라인, 배터리 등 기타 악세사리류 갯수 철저하게 체크'
];

function getDashboardNotes_() {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(DASHBOARD_NOTES_PROP_KEY);
  if (!raw) return { notes: DASHBOARD_DEFAULT_NOTES.slice(), isDefault: true };

  try {
    var parsed = JSON.parse(raw);
    return { notes: sanitizeDashboardNotes_(parsed), isDefault: false };
  } catch (e) {
    return { notes: DASHBOARD_DEFAULT_NOTES.slice(), isDefault: true, warning: '저장된 메모 형식 오류' };
  }
}

function saveDashboardNotes_(notesInput) {
  var notes = notesInput;
  if (typeof notesInput === 'string') {
    try {
      notes = JSON.parse(notesInput || '[]');
    } catch (e) {
      return { error: '메모 데이터 형식 오류' };
    }
  }

  notes = sanitizeDashboardNotes_(notes);
  PropertiesService.getScriptProperties().setProperty(DASHBOARD_NOTES_PROP_KEY, JSON.stringify(notes));
  return {
    success: true,
    notes: notes,
    savedAt: Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss')
  };
}

function sanitizeDashboardNotes_(notes) {
  if (!Array.isArray(notes)) return [];
  return notes.map(function(note) {
    return String(note || '').replace(/\r\n/g, '\n').trim().slice(0, 180);
  }).filter(function(note) {
    return note !== '';
  }).slice(0, 8);
}

/**
 * 향후 N시간 내 재고 충돌(동시 사용량 > 보유) 진단.
 * 매일 아침 슬랙 보고서에 첨부하는 핵심 알림.
 *
 * @param {number} hoursAhead — 점검 윈도우 (기본 48 = 오늘+내일)
 * @returns {Object} { windowStart, windowEnd, conflictCount, conflicts: [...] }
 */
function getInventoryConflicts(hoursAhead) {
  hoursAhead = Number(hoursAhead) || 48;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var schedSheet = ss.getSheetByName('스케줄상세');
  var equipSheet = ss.getSheetByName('장비마스터');
  if (!schedSheet || !equipSheet) return { error: "시트 없음" };

  var now = new Date();
  var windowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);  // 오늘 00:00 KST
  var windowEnd = new Date(windowStart.getTime() + hoursAhead * 60 * 60 * 1000);

  var allSched = getScheduleData(schedSheet);

  // 윈도우와 겹치는 미완료 예약만 (장비별 그룹핑)
  var byEquip = {};
  allSched.forEach(function(s) {
    if (!s.equipment || !s.startDT || !s.endDT) return;
    if (s.status === '취소' || s.status === '반납완료') return;
    if (s.endDT <= windowStart || s.startDT >= windowEnd) return;
    if (!byEquip[s.equipment]) byEquip[s.equipment] = [];
    byEquip[s.equipment].push(s);
  });

  var conflicts = [];

  Object.keys(byEquip).forEach(function(equipName) {
    var schedules = byEquip[equipName];
    if (schedules.length < 2) return;  // 단일 예약은 충돌 불가

    var info = findEquipment(equipName, equipSheet);
    if (!info) return;
    var 총보유 = info.total;

    // sweep-line: 모든 시작 시점에서 동시사용량 측정
    var tps = {};
    schedules.forEach(function(s) {
      tps[s.startDT.getTime()] = true;
      tps[s.endDT.getTime()] = true;
    });
    var sortedTPs = Object.keys(tps).map(Number).sort(function(a, b) { return a - b; });

    var maxConcurrent = 0;
    var conflictTime = null;
    var conflictingPairs = [];

    for (var i = 0; i < sortedTPs.length; i++) {
      var t = sortedTPs[i];
      var concurrent = 0;
      var atThis = [];
      schedules.forEach(function(s) {
        if (s.startDT.getTime() <= t && s.endDT.getTime() > t) {
          concurrent += s.qty;
          atThis.push(s);
        }
      });
      if (concurrent > 총보유 && conflictTime === null) {
        conflictTime = new Date(t);
        conflictingPairs = atThis;
      }
      if (concurrent > maxConcurrent) maxConcurrent = concurrent;
    }

    if (conflictTime) {
      conflicts.push({
        장비명: equipName,
        총보유: 총보유,
        최대동시사용: maxConcurrent,
        부족수량: maxConcurrent - 총보유,
        충돌시점: Utilities.formatDate(conflictTime, 'Asia/Seoul', 'M/d HH:mm'),
        예약들: conflictingPairs.map(function(s) {
          return {
            거래ID: s.contractID,
            예약자명: s.contractName || '',
            반출: Utilities.formatDate(s.startDT, 'Asia/Seoul', 'M/d HH:mm'),
            반납: Utilities.formatDate(s.endDT, 'Asia/Seoul', 'M/d HH:mm'),
            수량: s.qty
          };
        })
      });
    }
  });

  return {
    windowStart: Utilities.formatDate(windowStart, 'Asia/Seoul', 'yyyy-MM-dd HH:mm'),
    windowEnd: Utilities.formatDate(windowEnd, 'Asia/Seoul', 'yyyy-MM-dd HH:mm'),
    conflictCount: conflicts.length,
    conflicts: conflicts
  };
}

/**
 * 슬랙용으로 포맷팅된 텍스트. 외부 슬랙 봇/n8n/코워크에서 fetch해서 그대로 메시지에 포함.
 */
function getInventoryConflictsSlackMessage(hoursAhead) {
  var data = getInventoryConflicts(hoursAhead);
  if (data.error) return "❌ 진단 실패: " + data.error;
  if (data.conflictCount === 0) {
    return "✅ 재고 충돌 없음 (" + data.windowStart.substring(5) + " ~ " + data.windowEnd.substring(5) + ")";
  }
  var lines = ["🚨 *재고 충돌 경고* (" + data.windowStart.substring(5) + " ~ " + data.windowEnd.substring(5) + ")\n"];
  data.conflicts.forEach(function(c) {
    lines.push("*📦 " + c.장비명 + "* (보유 " + c.총보유 + "개 / 최대 " + c.최대동시사용 + "개 사용 → *" + c.부족수량 + "개 부족*)");
    lines.push("  ⏰ 충돌 시작: " + c.충돌시점);
    c.예약들.forEach(function(p) {
      lines.push("  • " + p.예약자명 + " (" + p.거래ID + ") " + p.반출 + " ~ " + p.반납 + (p.수량 > 1 ? " ×" + p.수량 : ""));
    });
    lines.push("");
  });
  return lines.join("\n");
}

/**
 * 백그라운드 캐시 워머 — 5분마다 트리거에서 호출.
 * 오늘/어제/내일 데이터를 미리 계산해 캐시에 적재 → 사용자는 항상 warm cache 히트.
 */
function warmDashboardCache() {
  try {
    var today = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');
    var yest = Utilities.formatDate(new Date(Date.now() - 86400000), 'Asia/Seoul', 'yyyy-MM-dd');
    var tom = Utilities.formatDate(new Date(Date.now() + 86400000), 'Asia/Seoul', 'yyyy-MM-dd');
    [today, yest, tom].forEach(function(d) {
      try { getDashboardData(d, true); } catch (e) { /* 개별 실패 무시 */ }
    });
    try { warmTimelineCache_(); } catch (eTimeline) { /* 개별 실패 무시 */ }
    try { warmDashboardMutationCaches_(); } catch (eMutation) { /* 개별 실패 무시 */ }
    try { warmDashboardSearchIndex_(); } catch (eSearch) { /* 개별 실패 무시 */ }
    try { warmDashboardAvailabilityRowIndex_(); } catch (e2) { /* 개별 실패 무시 */ }
  } catch (e) { /* ignore */ }
}

function warmTimelineCache_() {
  var range = getDefaultTimelineRange_();
  getTimelineData({ from: range.from, to: range.to, compact: 2 });
  var mobileRange = getInitialTimelineMobileRange_();
  if (mobileRange.from !== range.from || mobileRange.to !== range.to) {
    getTimelineData({ from: mobileRange.from, to: mobileRange.to, compact: 2 });
  }
}

function warmDashboardMutationCaches_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  getDashboardEquipNameList_(ss);
  buildDashboardSetLookup_(ss.getSheetByName("세트마스터"));
  var equipSheet = ss.getSheetByName("장비마스터");
  if (equipSheet) buildDashboardEquipmentMeta_(equipSheet);
}

function warmDashboardSearchIndex_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sched = ss.getSheetByName("스케줄상세");
  if (!sched || sched.getLastRow() < 2) return;
  getDashboardSearchIndex_(ss, sched, ss.getSheetByName("계약마스터"));
}

function warmDashboardAvailabilityRowIndex_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sched = ss.getSheetByName("스케줄상세");
  if (!sched || sched.getLastRow() < 2) return;
  var lastRow = sched.getLastRow();
  getDashboardAvailabilityRowIndex_(sched, lastRow);
  getDashboardAvailabilityScheduleMap_(sched, lastRow);
}

/**
 * 캐시 워머 트리거 1회 셋업.
 */
function setupDashboardWarmerTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function(t) {
    if (t.getHandlerFunction() === 'warmDashboardCache') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('warmDashboardCache')
    .timeBased()
    .everyMinutes(5)
    .create();
  // 즉시 1회 실행해 캐시 적재
  warmDashboardCache();
  return "✅ warmDashboardCache 5분 트리거 등록 + 즉시 실행 완료";
}

/**
 * Dashboard 캐시 무효화. 등록/취소/일정변경 후 호출.
 */
function invalidateDashboardCache() {
  try {
    touchDashboardSearchCacheVersion_();
    var cache = CacheService.getScriptCache();
    var today = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd');
    var yesterday = Utilities.formatDate(new Date(Date.now() - 86400000), 'Asia/Seoul', 'yyyy-MM-dd');
    var tomorrow = Utilities.formatDate(new Date(Date.now() + 86400000), 'Asia/Seoul', 'yyyy-MM-dd');
    [today, yesterday, tomorrow].forEach(function(d) {
      removeDashboardCacheJson_(cache, 'dashboard_v4_' + d);
      removeDashboardCacheJson_(cache, 'dashboard_v4_' + d + '_risk');
      cache.remove('dashboard_v3_' + d);
      cache.remove('dashboard_v2_' + d);
    });
  } catch (e) { /* ignore */ }
}

/**
 * 거래ID 반출세팅 완료 토글 (Dashboard 카드 체크박스에서 호출).
 * @param {string} tid 거래ID
 * @param {boolean} done true=완료, false=미완료
 * @returns {Object} { tid, setupDone }
 */
function toggleSetupDone(tid, done) {
  if (!tid) return { error: "tid 필요" };
  tid = String(tid).trim();
  var key = 'setupDone_' + tid;
  var atKey = 'setupDoneAt_' + tid;
  var props = PropertiesService.getScriptProperties();
  var isDone = done === true || done === "true" || done === "1" || done === 1;
  var doneAt = "";
  if (isDone) {
    doneAt = formatDashboardDoneAt_(new Date());
    props.setProperty(key, '1');
    props.setProperty(atKey, doneAt);
  } else {
    props.deleteProperty(key);
    props.deleteProperty(atKey);
  }
  invalidateDashboardCache();
  return { tid: tid, setupDone: isDone, setupDoneAt: doneAt, doneAt: doneAt };
}

/**
 * 거래ID 반납검수 완료 토글 (Dashboard 반납 카드 체크박스).
 */
function toggleReturnDone(tid, done) {
  if (!tid) return { error: "tid 필요" };
  tid = String(tid).trim();
  var key = 'returnDone_' + tid;
  var atKey = 'returnDoneAt_' + tid;
  var props = PropertiesService.getScriptProperties();
  var isDone = done === true || done === "true" || done === "1" || done === 1;

  var lock = LockService.getScriptLock();
  try { lock.waitLock(5000); } catch (lockErr) {}

  try {
    var contractResult = setDashboardReturnContractStatus_(tid, isDone, props);
    if (contractResult && contractResult.error) return contractResult;

    var doneAt = "";
    if (isDone) {
      doneAt = formatDashboardDoneAt_(new Date());
      props.setProperty(key, '1');
      props.setProperty(atKey, doneAt);
    } else {
      props.deleteProperty(key);
      props.deleteProperty(atKey);
    }
    invalidateDashboardCache();
    return {
      tid: tid,
      returnDone: isDone,
      returnDoneAt: doneAt,
      doneAt: doneAt,
      contractStatus: contractResult.status,
      previousContractStatus: contractResult.previousStatus || '',
      row: contractResult.row
    };
  } finally {
    try { lock.releaseLock(); } catch (releaseErr) {}
  }
}

function formatDashboardDoneAt_(date) {
  return Utilities.formatDate(date || new Date(), "Asia/Seoul", "yyyy-MM-dd HH:mm:ss");
}

function setDashboardReturnContractStatus_(tid, isDone, props) {
  props = props || PropertiesService.getScriptProperties();
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('계약마스터');
  if (!sheet || sheet.getLastRow() < 2) return { error: "계약마스터 시트 없음" };

  var ids = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getDisplayValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0] || '').trim() !== tid) continue;

    var row = i + 2;
    var prevKey = 'returnPrevContractStatus_' + tid;
    var currentStatus = String(sheet.getRange(row, 10).getDisplayValue() || '').trim();
    var nextStatus;

    if (isDone) {
      if (currentStatus === '취소') {
        return { error: '취소 처리된 계약은 반납완료로 바꿀 수 없습니다: ' + tid };
      }
      if (currentStatus && currentStatus !== '반납완료') {
        props.setProperty(prevKey, currentStatus);
      }
      nextStatus = '반납완료';
    } else {
      nextStatus = props.getProperty(prevKey) || '반출';
      props.deleteProperty(prevKey);
    }

    sheet.getRange(row, 10).setValue(nextStatus); // J열: 계약상태
    applyContractMasterStatusRowStyle_(sheet, row, nextStatus);
    return {
      success: true,
      tradeId: tid,
      row: row,
      previousStatus: currentStatus,
      status: nextStatus
    };
  }

  return { error: "계약마스터에서 거래ID를 찾지 못했습니다: " + tid };
}

function applyContractMasterStatusRowStyle_(sheet, row, status) {
  if (!sheet || row < 2) return;

  var lastCol = Math.max(11, Math.min(sheet.getLastColumn(), 11));
  var rowRange = sheet.getRange(row, 1, 1, lastCol);
  status = String(status || '').trim();

  if (status === '반납완료' || status === '완료') {
    rowRange
      .setBackground("#E7E6E6")
      .setFontColor("#7F7F7F")
      .setFontLine("line-through");
    return;
  }

  rowRange
    .setBackground(null)
    .setFontColor(null)
    .setFontLine("none")
    .setFontWeight(null)
    .setFontStyle(null);

  sheet.getRange(row, 5, 1, 2).setBackground("#DAE8FC");      // E,F 반출
  sheet.getRange(row, 7, 1, 2).setBackground("#D5E8D4");      // G,H 반납
  sheet.getRange(row, 9, 1, 1).setBackground("#FFF2CC");      // I 회차
  sheet.getRange(row, 10, 1, 1).setBackground("#BDD7EE");     // J 계약상태
  sheet.getRange(row, 5, 1, 6).setFontWeight("bold");
}

function hasScheduleRowsForTrade_(ss, tradeId) {
  tradeId = String(tradeId || '').trim();
  if (!tradeId) return false;

  var schedSheet = ss.getSheetByName('스케줄상세');
  if (!schedSheet || schedSheet.getLastRow() < 2) return false;

  var ids = schedSheet.getRange(2, 2, schedSheet.getLastRow() - 1, 1).getDisplayValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0] || '').trim() === tradeId) return true;
  }
  return false;
}

function buildScheduleCountByTradeId_(ss) {
  var counts = {};
  var schedSheet = ss.getSheetByName('스케줄상세');
  if (!schedSheet || schedSheet.getLastRow() < 2) return counts;

  var ids = schedSheet.getRange(2, 2, schedSheet.getLastRow() - 1, 1).getDisplayValues();
  ids.forEach(function(row) {
    var tradeId = String(row[0] || '').trim();
    if (!tradeId) return;
    counts[tradeId] = (counts[tradeId] || 0) + 1;
  });
  return counts;
}

function isContractMasterCancelStyle_(sheet, row) {
  if (!sheet || row < 2) return false;

  var range = sheet.getRange(row, 1, 1, Math.min(sheet.getLastColumn(), 11));
  return isCancelStyleFromFormats_(range.getBackgrounds()[0], range.getFontColors()[0]);
}

function isCancelStyleFromFormats_(backgrounds, fontColors) {
  var redBg = 0;
  var redFont = 0;

  for (var i = 0; i < backgrounds.length; i++) {
    if (String(backgrounds[i] || '').toLowerCase() === '#ffc7ce') redBg++;
    if (String(fontColors[i] || '').toLowerCase() === '#9c0006') redFont++;
  }
  return redBg >= 6 || redFont >= 6;
}

/**
 * 계약마스터에서 반납일이 기준일보다 지난 건을 반납완료 처리한다.
 * 기준: 반납일 < asOfDate, 취소/반납완료는 제외.
 */
function markOverdueReturnContracts(asOfDate, dryRun) {
  var asOfSerial = parseContractDateSerial_(asOfDate || Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd'), '');
  if (!asOfSerial) return { error: "기준일 파싱 실패: " + asOfDate };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('계약마스터');
  if (!sheet || sheet.getLastRow() < 2) {
    return { success: true, asOfDate: formatContractDateSerial_(asOfSerial), updated: 0, targets: [] };
  }

  var rowCount = sheet.getLastRow() - 1;
  var values = sheet.getRange(2, 1, rowCount, 10).getValues();
  var display = sheet.getRange(2, 1, rowCount, 10).getDisplayValues();
  var targets = [];
  var skipped = {
    alreadyReturned: 0,
    cancelled: 0,
    notPast: 0,
    missingReturnDate: 0
  };

  for (var i = 0; i < values.length; i++) {
    var row = i + 2;
    var tradeId = String(display[i][0] || values[i][0] || '').trim();
    var status = String(display[i][9] || values[i][9] || '').trim();
    var returnSerial = parseContractDateSerial_(values[i][6], display[i][6]); // G열: 반납일자

    if (!tradeId) continue;
    if (!returnSerial) {
      skipped.missingReturnDate++;
      continue;
    }
    if (returnSerial >= asOfSerial) {
      skipped.notPast++;
      continue;
    }
    if (status === '취소') {
      skipped.cancelled++;
      continue;
    }
    if (status === '반납완료') {
      skipped.alreadyReturned++;
      continue;
    }

    targets.push({
      row: row,
      tradeId: tradeId,
      name: String(display[i][1] || '').trim(),
      returnDate: formatContractDateSerial_(returnSerial),
      previousStatus: status
    });
  }

  if (dryRun === true || dryRun === 'true' || dryRun === '1') {
    return {
      success: true,
      dryRun: true,
      asOfDate: formatContractDateSerial_(asOfSerial),
      cutoffExclusive: formatContractDateSerial_(asOfSerial),
      targetCount: targets.length,
      skipped: skipped,
      targetsPreview: targets.slice(0, 50)
    };
  }

  var lock = LockService.getScriptLock();
  try { lock.waitLock(10000); } catch (lockErr) {}

  try {
    targets.forEach(function(target) {
      sheet.getRange(target.row, 10).setValue('반납완료'); // J열: 계약상태
      applyContractMasterStatusRowStyle_(sheet, target.row, '반납완료');
    });
    invalidateDashboardCache();
    return {
      success: true,
      dryRun: false,
      asOfDate: formatContractDateSerial_(asOfSerial),
      cutoffExclusive: formatContractDateSerial_(asOfSerial),
      updated: targets.length,
      skipped: skipped,
      updatedPreview: targets.slice(0, 50)
    };
  } finally {
    try { lock.releaseLock(); } catch (releaseErr) {}
  }
}

function inspectContractCancelRecovery(asOfDate) {
  var asOfSerial = parseContractDateSerial_(asOfDate || Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd'), '');
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('계약마스터');
  if (!sheet || sheet.getLastRow() < 2) {
    return { success: true, candidateCount: 0, candidates: [] };
  }

  var rowCount = sheet.getLastRow() - 1;
  var values = sheet.getRange(2, 1, rowCount, 12).getValues();
  var display = sheet.getRange(2, 1, rowCount, 12).getDisplayValues();
  var formatsRange = sheet.getRange(2, 1, rowCount, Math.min(sheet.getLastColumn(), 11));
  var backgrounds = formatsRange.getBackgrounds();
  var fontColors = formatsRange.getFontColors();
  var scheduleCounts = buildScheduleCountByTradeId_(ss);
  var props = PropertiesService.getScriptProperties().getProperties();
  var candidates = [];
  var summary = {
    returned: 0,
    cancelled: 0,
    returnedWithCancelStyle: 0,
    returnedWithNoScheduleRows: 0,
    returnedWithPreviousCancelProperty: 0,
    currentCancelledPastCutoff: 0
  };
  var currentCancelledPastCutoff = [];

  for (var i = 0; i < values.length; i++) {
    var row = i + 2;
    var tradeId = String(display[i][0] || values[i][0] || '').trim();
    if (!tradeId) continue;

    var status = String(display[i][9] || values[i][9] || '').trim();
    var returnSerial = parseContractDateSerial_(values[i][6], display[i][6]);
    var scheduleRowCount = scheduleCounts[tradeId] || 0;
    var hasCancelStyle = isCancelStyleFromFormats_(backgrounds[i], fontColors[i]);
    var prevStatusProp = String(props['returnPrevContractStatus_' + tradeId] || '').trim();

    if (status === '반납완료') summary.returned++;
    if (status === '취소') {
      summary.cancelled++;
      if (asOfSerial && returnSerial && returnSerial < asOfSerial) {
        summary.currentCancelledPastCutoff++;
        currentCancelledPastCutoff.push({
          row: row,
          tradeId: tradeId,
          name: String(display[i][1] || '').trim(),
          returnDate: formatContractDateSerial_(returnSerial)
        });
      }
      continue;
    }

    if (status !== '반납완료') continue;

    var reasons = [];
    if (hasCancelStyle) {
      summary.returnedWithCancelStyle++;
      reasons.push('취소 행 서식');
    }
    if (scheduleRowCount === 0) {
      summary.returnedWithNoScheduleRows++;
      reasons.push('스케줄상세 행 없음');
    }
    if (prevStatusProp === '취소') {
      summary.returnedWithPreviousCancelProperty++;
      reasons.push('이전 상태 기록=취소');
    }

    if (reasons.length > 0) {
      candidates.push({
        row: row,
        tradeId: tradeId,
        name: String(display[i][1] || '').trim(),
        returnDate: formatContractDateSerial_(returnSerial),
        status: status,
        scheduleRowCount: scheduleRowCount,
        previousStatusProperty: prevStatusProp,
        reasons: reasons
      });
    }
  }

  return {
    success: true,
    asOfDate: asOfSerial ? formatContractDateSerial_(asOfSerial) : '',
    candidateCount: candidates.length,
    summary: summary,
    candidates: candidates,
    currentCancelledPastCutoff: currentCancelledPastCutoff
  };
}

function restoreCancelledContractsByIds(ids, dryRun) {
  if (typeof ids === 'string') {
    ids = ids.split(',').map(function(id) { return id.trim(); }).filter(Boolean);
  }
  if (!Array.isArray(ids) || ids.length === 0) {
    return { error: '복구할 거래ID 목록이 필요합니다' };
  }

  var idSet = {};
  ids.forEach(function(id) {
    var tradeId = String(id || '').trim();
    if (tradeId) idSet[tradeId] = true;
  });
  var targetIds = Object.keys(idSet);
  if (targetIds.length === 0) return { error: '복구할 거래ID 목록이 비어 있습니다' };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('계약마스터');
  if (!sheet || sheet.getLastRow() < 2) return { error: '계약마스터 시트 없음' };

  var rowCount = sheet.getLastRow() - 1;
  var display = sheet.getRange(2, 1, rowCount, 12).getDisplayValues();
  var scheduleCounts = buildScheduleCountByTradeId_(ss);
  var targets = [];
  var missing = targetIds.slice();

  for (var i = 0; i < display.length; i++) {
    var row = i + 2;
    var tradeId = String(display[i][0] || '').trim();
    if (!idSet[tradeId]) continue;

    missing = missing.filter(function(id) { return id !== tradeId; });
    targets.push({
      row: row,
      tradeId: tradeId,
      name: String(display[i][1] || '').trim(),
      currentStatus: String(display[i][9] || '').trim(),
      scheduleRowCount: scheduleCounts[tradeId] || 0
    });
  }

  var isDryRun = !(dryRun === false || dryRun === 'false' || dryRun === 0 || dryRun === '0');
  if (isDryRun) {
    return { success: true, dryRun: true, targetCount: targets.length, targets: targets, missing: missing };
  }

  var props = PropertiesService.getScriptProperties();
  targets.forEach(function(target) {
    props.deleteProperty('returnDone_' + target.tradeId);
    props.deleteProperty('returnPrevContractStatus_' + target.tradeId);
    sheet.getRange(target.row, 10).setValue('취소');
    cancelContract(ss, target.tradeId, target.row);
  });
  invalidateDashboardCache();
  try { invalidateTimelineCache(); } catch (e) {}

  return {
    success: true,
    dryRun: false,
    restored: targets.length,
    targets: targets,
    missing: missing
  };
}

function parseContractDateSerial_(raw, display) {
  if (raw instanceof Date) {
    return Number(Utilities.formatDate(raw, 'Asia/Seoul', 'yyyyMMdd'));
  }

  var text = String(display || raw || '').trim();
  if (!text) return 0;

  var nums = text.match(/\d+/g);
  if (!nums || nums.length < 3) return 0;

  var y = Number(nums[0]);
  var m = Number(nums[1]);
  var d = Number(nums[2]);
  if (y < 100) y += 2000;
  if (!y || !m || !d || m < 1 || m > 12 || d < 1 || d > 31) return 0;

  return y * 10000 + m * 100 + d;
}

function formatContractDateSerial_(serial) {
  serial = Number(serial) || 0;
  if (!serial) return '';
  var y = Math.floor(serial / 10000);
  var m = Math.floor((serial % 10000) / 100);
  var d = serial % 100;
  return y + '-' + ('0' + m).slice(-2) + '-' + ('0' + d).slice(-2);
}

/**
 * 개별 장비 행 체크 토글 (Dashboard 체크리스트).
 * @param {string} scheduleId — 스케줄상세 A열 ID (e.g., "260423-001-01")
 * @param {string} phase — "checkout" or "checkin"
 * @param {boolean} done
 */
function toggleItemCheck(scheduleId, phase, done) {
  if (!scheduleId || !phase) return { error: "scheduleId/phase 필수" };
  if (phase !== 'checkout' && phase !== 'checkin') return { error: "phase는 checkout/checkin" };
  var key = 'itemCheck_' + String(scheduleId).trim() + '_' + phase;
  var props = PropertiesService.getScriptProperties();
  var isDone = done === true || done === "true" || done === "1" || done === 1;
  if (isDone) props.setProperty(key, '1');
  else props.deleteProperty(key);
  invalidateDashboardCache();
  return { scheduleId: scheduleId, phase: phase, checked: isDone };
}

/**
 * 오늘 일정 거래건별 반납 상태/특이사항.
 * 빌리지2.0(개고생2_URL) > 장비체크 시트 C/D열을 읽고 쓴다.
 * A/B열은 신규 생성 시 거래ID/예약자명으로 만든다.
 */
function getEquipmentCheckMap_() {
  var result = {
    byTradeId: {}
  };

  try {
    var sheet = getEquipmentCheckSheet_(false);
    if (!sheet || sheet.getLastRow() < 2) return result;

    var schema = getEquipmentCheckSchema_(sheet, false);
    var lastCol = Math.max(sheet.getLastColumn(), 4, schema.statusCol, schema.memoCol, schema.keyCol || 0, schema.labelCol || 0);
    var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, lastCol).getDisplayValues();

    values.forEach(function(row, idx) {
      var rawKey = schema.keyCol ? String(row[schema.keyCol - 1] || '').trim() : '';
      var tradeId = normalizeEquipmentCheckTradeId_(rawKey);
      var label = schema.labelCol ? String(row[schema.labelCol - 1] || '').trim() : '';
      var info = {
        row: idx + 2,
        tradeId: tradeId,
        label: label,
        returnStatus: String(row[schema.statusCol - 1] || '').trim(),
        returnMemo: String(row[schema.memoCol - 1] || '').trim(),
        exactTradeId: /^\d{6}-\d{3}$/.test(rawKey)
      };

      if (tradeId && (!result.byTradeId[tradeId] || info.exactTradeId)) result.byTradeId[tradeId] = info;
    });
  } catch (err) {
    result.error = err.message;
  }

  return result;
}

function getEquipmentCheckMapForIds_(tradeIds) {
  var result = { byTradeId: {} };
  var wanted = {};
  (tradeIds || []).forEach(function(tid) {
    tid = String(tid || '').trim();
    if (tid) wanted[tid] = true;
  });
  if (Object.keys(wanted).length === 0) return result;

  try {
    var sheet = getEquipmentCheckSheet_(false);
    if (!sheet || sheet.getLastRow() < 2) return result;

    var schema = getEquipmentCheckSchema_(sheet, false);
    var lastCol = Math.max(sheet.getLastColumn(), 4, schema.statusCol, schema.memoCol, schema.keyCol || 0, schema.labelCol || 0);
    var rowCount = sheet.getLastRow() - 1;
    var keyCol = schema.keyCol || 1;
    var rowIndex = getEquipmentCheckRowIndexForTradeIds_(sheet, schema, rowCount, keyCol);
    var rowsToRead = [];
    Object.keys(wanted).forEach(function(tradeId) {
      (rowIndex[tradeId] || []).forEach(function(rowNum) {
        rowsToRead.push(rowNum);
      });
    });
    rowsToRead.sort(function(a, b) { return a - b; });
    var values = readDashboardScheduleRowsDisplay_(sheet, rowsToRead, lastCol);

    values.forEach(function(row, idx) {
      var rawKey = schema.keyCol ? String(row[schema.keyCol - 1] || '').trim() : '';
      var tradeId = normalizeEquipmentCheckTradeId_(rawKey);
      if (!wanted[tradeId]) return;

      var info = {
        row: rowsToRead[idx],
        tradeId: tradeId,
        label: schema.labelCol ? String(row[schema.labelCol - 1] || '').trim() : '',
        returnStatus: String(row[schema.statusCol - 1] || '').trim(),
        returnMemo: String(row[schema.memoCol - 1] || '').trim(),
        exactTradeId: /^\d{6}-\d{3}$/.test(rawKey)
      };

      if (tradeId && (!result.byTradeId[tradeId] || info.exactTradeId)) result.byTradeId[tradeId] = info;
    });
  } catch (err) {
    result.error = err.message;
  }

  return result;
}

function getEquipmentCheckRowIndexForTradeIds_(sheet, schema, rowCount, keyCol) {
  var cache = null;
  var cacheKey = 'equipmentCheckRowIndex_v1_' + rowCount + '_' + keyCol + '_' +
    (schema.statusCol || 0) + '_' + (schema.memoCol || 0);
  try {
    cache = CacheService.getScriptCache();
    var cached = getDashboardCacheJson_(cache, cacheKey);
    if (cached) return cached;
  } catch (e) {}

  var index = {};
  var ids = sheet.getRange(2, keyCol, rowCount, 1).getDisplayValues();
  ids.forEach(function(row, idx) {
    var tradeId = normalizeEquipmentCheckTradeId_(String(row[0] || '').trim());
    if (!tradeId) return;
    if (!index[tradeId]) index[tradeId] = [];
    index[tradeId].push(idx + 2);
  });
  if (cache) putDashboardCacheJson_(cache, cacheKey, index, 300);
  return index;
}

function getEquipmentCheckForTrade_(map, tradeId) {
  map = map || {};
  var tid = String(tradeId || '').trim();
  if (tid && map.byTradeId && map.byTradeId[tid]) return map.byTradeId[tid];
  return {};
}

function updateEquipmentCheck(scheduleId, tradeId, label, field, value) {
  scheduleId = String(scheduleId || '').trim();
  tradeId = String(tradeId || '').trim();
  label = String(label || '').trim();
  field = String(field || '').trim();
  value = String(value || '').trim();

  if (!tradeId && scheduleId) tradeId = normalizeEquipmentCheckTradeId_(scheduleId);
  if (!tradeId) return { error: "거래ID 필수" };
  if (field !== 'returnStatus' && field !== 'memo') return { error: "field는 returnStatus/memo만 허용" };
  if (value.length > 500) value = value.slice(0, 500);

  var lock = LockService.getScriptLock();
  try { lock.waitLock(5000); } catch (lockErr) {}

  try {
    var sheet = getEquipmentCheckSheet_(true);
    var schema = getEquipmentCheckSchema_(sheet, true);
    var rowNum = findEquipmentCheckRow_(sheet, schema, tradeId);

    if (!rowNum) {
      rowNum = sheet.getLastRow() + 1;
      var seed = [];
      var width = Math.max(sheet.getLastColumn(), 4, schema.statusCol, schema.memoCol, schema.keyCol || 0, schema.labelCol || 0);
      for (var i = 0; i < width; i++) seed.push('');
      if (schema.keyCol) seed[schema.keyCol - 1] = tradeId;
      if (schema.labelCol) seed[schema.labelCol - 1] = label;
      sheet.getRange(rowNum, 1, 1, seed.length).setValues([seed]);
    } else {
      if (schema.keyCol) sheet.getRange(rowNum, schema.keyCol).setValue(tradeId);
      if (schema.labelCol && label) sheet.getRange(rowNum, schema.labelCol).setValue(label);
    }

    var targetCol = field === 'returnStatus' ? schema.statusCol : schema.memoCol;
    sheet.getRange(rowNum, targetCol).setValue(value);
    invalidateDashboardCache();

    return {
      success: true,
      row: rowNum,
      tradeId: tradeId,
      label: label,
      field: field,
      value: value
    };
  } catch (err) {
    return { error: err.message };
  } finally {
    try { lock.releaseLock(); } catch (releaseErr) {}
  }
}

function updateDashboardContractStatus(tradeId, status) {
  tradeId = String(tradeId || '').trim();
  status = String(status || '').trim();
  var allowed = { "예약": true, "반출": true, "취소": true, "반납완료": true };

  if (!tradeId) return { error: "거래ID 필수" };
  if (!allowed[status]) return { error: "계약상태는 예약/반출/취소/반납완료만 허용" };

  var lock = LockService.getScriptLock();
  try { lock.waitLock(5000); } catch (lockErr) {}

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName('계약마스터');
    if (!sheet || sheet.getLastRow() < 2) return { error: "계약마스터 시트 없음" };

    var ids = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getDisplayValues();
    for (var i = 0; i < ids.length; i++) {
      if (String(ids[i][0] || '').trim() === tradeId) {
        var row = i + 2;
        var currentStatus = String(sheet.getRange(row, 10).getDisplayValue() || '').trim();

        if (status === "반납완료" && currentStatus === "취소") {
          return { error: "취소 처리된 계약은 반납완료로 바꿀 수 없습니다: " + tradeId };
        }

        sheet.getRange(row, 10).setValue(status); // J열: 계약상태

        if (status === "취소") {
          var cancelProps = PropertiesService.getScriptProperties();
          cancelProps.deleteProperty('returnDone_' + tradeId);
          cancelProps.deleteProperty('returnPrevContractStatus_' + tradeId);
          cancelContract(ss, tradeId, row);
          invalidateDashboardCache();
          return { success: true, tradeId: tradeId, status: status, row: row, cancelled: true };
        }

        var props = PropertiesService.getScriptProperties();
        if (status === "반납완료") {
          props.setProperty('returnDone_' + tradeId, '1');
          props.setProperty('returnPrevContractStatus_' + tradeId, currentStatus || '반출');
        } else {
          props.deleteProperty('returnDone_' + tradeId);
          props.deleteProperty('returnPrevContractStatus_' + tradeId);
        }

        applyContractMasterStatusRowStyle_(sheet, row, status);
        invalidateDashboardCache();
        return { success: true, tradeId: tradeId, status: status, row: row };
      }
    }
    return { error: "계약마스터에서 거래ID를 찾지 못했습니다" };
  } catch (err) {
    return { error: err.message };
  } finally {
    try { lock.releaseLock(); } catch (releaseErr) {}
  }
}

function getEquipmentCheckSpreadsheet_() {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty("개고생2_URL");
  if (url) {
    try {
      return SpreadsheetApp.openByUrl(url);
    } catch (err) {
      // 빌리지2.0 접근 실패 시 현재 통합 재고 시트로 폴백해 오늘 일정 자체는 멈추지 않게 한다.
    }
  }
  return SpreadsheetApp.getActiveSpreadsheet();
}

function getEquipmentCheckSheet_(createIfMissing) {
  var ss = getEquipmentCheckSpreadsheet_();
  var sheet = ss.getSheetByName('장비체크') || ss.getSheetByName('장비 체크');
  if (!sheet && createIfMissing) {
    sheet = ss.insertSheet('장비체크');
    sheet.getRange(1, 1, 1, 4).setValues([['거래ID', '예약자명', '반납 상태', '특이사항']]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

function getEquipmentCheckSchema_(sheet, ensureHeaders) {
  var lastCol = Math.max(sheet.getLastColumn(), 4);
  if (sheet.getLastRow() < 1 && ensureHeaders) {
    sheet.getRange(1, 1, 1, 4).setValues([['거래ID', '예약자명', '반납 상태', '특이사항']]);
  }

  var headers = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
  var hasHeader = headers.some(function(h) { return String(h || '').trim() !== ''; });
  if (!hasHeader && ensureHeaders) {
    headers = ['거래ID', '예약자명', '반납 상태', '특이사항'];
    sheet.getRange(1, 1, 1, 4).setValues([headers]);
  }
  if (ensureHeaders) {
    var firstHeader = String(headers[0] || '').replace(/\s+/g, '');
    var secondHeader = String(headers[1] || '').replace(/\s+/g, '');
    if (!firstHeader || firstHeader === '스케줄ID' || firstHeader === 'ScheduleID') {
      sheet.getRange(1, 1).setValue('거래ID');
      headers[0] = '거래ID';
    }
    if (!secondHeader || secondHeader === '장비명' || secondHeader === '품목명') {
      sheet.getRange(1, 2).setValue('예약자명');
      headers[1] = '예약자명';
    }
    if (!String(headers[2] || '').trim()) {
      sheet.getRange(1, 3).setValue('반납 상태');
      headers[2] = '반납 상태';
    }
    if (!String(headers[3] || '').trim()) {
      sheet.getRange(1, 4).setValue('특이사항');
      headers[3] = '특이사항';
    }
  }

  var keyCol = _findHeaderCol_(headers, ['거래ID', '거래 Id', '거래id', '스케줄ID', '스케줄 Id', 'Schedule ID', 'ScheduleId']) || 1;
  var labelCol = _findHeaderCol_(headers, ['예약자명', '예약자', '고객명', '장비명', '장비 이름', '품목명', '품목', '장비']) || 2;

  return {
    keyCol: keyCol,
    labelCol: labelCol,
    statusCol: 3,
    memoCol: 4
  };
}

function findEquipmentCheckRow_(sheet, schema, tradeId) {
  if (!sheet || sheet.getLastRow() < 2) return 0;

  var lastCol = Math.max(sheet.getLastColumn(), 4, schema.keyCol || 0);
  var values = sheet.getRange(2, 1, sheet.getLastRow() - 1, lastCol).getDisplayValues();
  var fallbackRow = 0;

  for (var i = 0; i < values.length; i++) {
    var row = values[i];
    var rawKey = schema.keyCol ? String(row[schema.keyCol - 1] || '').trim() : '';
    if (rawKey === tradeId) return i + 2;
    if (!fallbackRow && normalizeEquipmentCheckTradeId_(rawKey) === tradeId) fallbackRow = i + 2;
  }

  return fallbackRow;
}

function normalizeEquipmentCheckTradeId_(value) {
  var raw = String(value || '').trim();
  var exact = raw.match(/^(\d{6}-\d{3})$/);
  if (exact) return exact[1];
  var fromSchedule = raw.match(/^(\d{6}-\d{3})-\d+$/);
  if (fromSchedule) return fromSchedule[1];
  return raw;
}

/**
 * 개고생2.0/빌리지2.0 거래내역에서 계약서 링크, G열 발행처 상호, J열 결제수단을 읽어 대시보드에 붙인다.
 */
var DASHBOARD_TRADE_EXTRA_CACHE_PREFIX_ = 'dashboard_trade_extra_v2_';
var DASHBOARD_TRADE_EXTRA_CACHE_SECONDS_ = 300;

function emptyDashboardTradeExtra_() {
  return {
    contractUrl: '',
    paymentMethod: '',
    paymentSource: '',
    paymentWarning: '',
    depositStatus: '',
    proofType: '',
    issueStatus: '',
    billingCompany: '',
    issueNote: ''
  };
}

function getDashboardTradeExtraCacheKey_(tid) {
  return DASHBOARD_TRADE_EXTRA_CACHE_PREFIX_ +
    String(tid || '').trim().replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
}

function buildDashboardTradeExtraFromRow_(row, columns) {
  var extra = emptyDashboardTradeExtra_();
  extra.contractUrl = String(row[columns.contractCol - 1] || '').trim();
  extra.billingCompany = String(row[columns.billingCompanyCol - 1] || '').trim();
  extra.paymentMethod = String(row[columns.paymentCol - 1] || '').trim();
  extra.paymentSource = extra.paymentMethod ? 'sheet:J' : '';
  extra.proofType = String(row[columns.proofCol - 1] || '').trim();
  extra.issueStatus = String(row[columns.issueCol - 1] || '').trim();
  extra.depositStatus = String(row[columns.depositCol - 1] || '').trim();
  extra.issueNote = String(row[columns.noteCol - 1] || '').trim();
  return extra;
}

function invalidateDashboardTradeExtraCache_(tradeIds) {
  if (!tradeIds || tradeIds.length === 0) return;
  try {
    var cache = CacheService.getScriptCache();
    var keys = [];
    var seen = {};
    tradeIds.forEach(function(tid) {
      tid = String(tid || '').trim();
      if (!tid || seen[tid]) return;
      seen[tid] = true;
      keys.push(getDashboardTradeExtraCacheKey_(tid));
    });
    if (keys.length > 0) cache.removeAll(keys);
  } catch (err) {}
}

function getTradeExtrasForIds_(tradeIds, props) {
  var result = {};
  props = props || PropertiesService.getScriptProperties().getProperties();
  var ids = [];
  var seenIds = {};
  (tradeIds || []).forEach(function(tid) {
    tid = String(tid || '').trim();
    if (!tid || seenIds[tid]) return;
    seenIds[tid] = true;
    ids.push(tid);
    result[tid] = emptyDashboardTradeExtra_();
  });
  if (ids.length === 0) return result;

  var cache = null;
  var missingIds = ids.slice();
  try {
    cache = CacheService.getScriptCache();
    var keys = ids.map(function(tid) {
      return getDashboardTradeExtraCacheKey_(tid);
    });
    var cached = cache.getAll(keys);
    missingIds = [];
    ids.forEach(function(tid) {
      var key = getDashboardTradeExtraCacheKey_(tid);
      if (cached[key]) {
        try {
          result[tid] = JSON.parse(cached[key]);
          return;
        } catch (parseErr) {}
      }
      missingIds.push(tid);
    });
  } catch (cacheErr) {
    cache = null;
  }
  if (missingIds.length === 0) return result;

  try {
    var 개고생URL = PropertiesService.getScriptProperties().getProperty("개고생2_URL");
    if (!개고생URL) return result;
    var 거래시트 = SpreadsheetApp.openByUrl(개고생URL).getSheetByName("거래내역");
    if (!거래시트 || 거래시트.getLastRow() < 2) return result;

    var lastCol = Math.max(거래시트.getLastColumn(), 14);
    var headers = 거래시트.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
    var idCol = _findHeaderCol_(headers, ["거래ID", "거래 Id", "거래id"]) || 5;
    var contractCol = _findHeaderCol_(headers, ["계약서링크", "계약서 링크", "계약서", "계약서URL", "계약서 URL"]) || 3;
    var billingCompanyCol = 7; // G열: 발행처 상호
    var paymentCol = 10; // J열: 결제수단
    var proofCol = 11;   // K열: 증빙유형
    var issueCol = 12;   // L열: 발행상태
    var depositCol = 13; // M열: 입금 상태
    var noteCol = 14;    // N열: 비고
    var wanted = {};
    missingIds.forEach(function(tid) { wanted[String(tid)] = true; });
    var readCols = Math.max(idCol, contractCol, billingCompanyCol, paymentCol, proofCol, issueCol, depositCol, noteCol);
    var idValues = 거래시트.getRange(2, idCol, 거래시트.getLastRow() - 1, 1).getDisplayValues();
    var rowsToRead = [];
    idValues.forEach(function(row, idx) {
      var tid = String(row[0] || '').trim();
      if (wanted[tid]) rowsToRead.push(idx + 2);
    });
    var rows = readDashboardScheduleRowsDisplay_(거래시트, rowsToRead, readCols);
    var cachePayload = {};
    var columns = {
      contractCol: contractCol,
      billingCompanyCol: billingCompanyCol,
      paymentCol: paymentCol,
      proofCol: proofCol,
      issueCol: issueCol,
      depositCol: depositCol,
      noteCol: noteCol
    };

    rows.forEach(function(row) {
      var tid = String(row[idCol - 1] || '').trim();
      if (!wanted[tid]) return;
      result[tid] = buildDashboardTradeExtraFromRow_(row, columns);
      if (cache) cachePayload[getDashboardTradeExtraCacheKey_(tid)] = JSON.stringify(result[tid]);
    });
    if (cache && Object.keys(cachePayload).length > 0) {
      cache.putAll(cachePayload, DASHBOARD_TRADE_EXTRA_CACHE_SECONDS_);
    }
  } catch (err) {
    missingIds.forEach(function(tid) {
      result[tid].paymentWarning = "거래내역 조회 실패: " + err.message;
    });
  }
  return result;
}

var DASHBOARD_PHOTO_SHEET_NAME_ = "반출반납 사진";
var DASHBOARD_PHOTO_FOLDER_NAME_ = "빌리지_반출반납_사진";
var DASHBOARD_PHOTO_APPSHEET_FOLDER_NAME_ = "반출반납 사진_Images";
var DASHBOARD_PHOTO_FILE_INDEX_CACHE_KEY_ = "dashboard_photo_file_index_v1";

function emptyDashboardPhotos_() {
  return { checkout: [], checkin: [], other: [] };
}

function getDashboardPhotosForTrade(tid) {
  tid = String(tid || '').trim();
  if (!tid) return { error: "tid 필요" };
  var map = getDashboardPhotoMap_([tid]);
  return {
    success: true,
    tid: tid,
    photos: map[tid] || emptyDashboardPhotos_()
  };
}

function getDashboardPhotosForTrades(tids) {
  if (typeof tids === 'string') {
    try {
      tids = JSON.parse(tids);
    } catch (parseErr) {
      tids = tids.split(',');
    }
  }
  tids = Array.isArray(tids) ? tids.map(function(tid) {
    return String(tid || '').trim();
  }).filter(Boolean) : [];

  var seen = {};
  tids = tids.filter(function(tid) {
    if (seen[tid]) return false;
    seen[tid] = true;
    return true;
  }).slice(0, 80);

  var map = getDashboardPhotoMap_(tids);
  return {
    success: true,
    photosByTrade: map
  };
}

function getDashboardPhotoMap_(tradeIds) {
  var wanted = {};
  var result = {};
  (tradeIds || []).forEach(function(tid) {
    tid = String(tid || '').trim();
    if (!tid) return;
    wanted[tid] = true;
    result[tid] = emptyDashboardPhotos_();
  });
  if (!tradeIds || tradeIds.length === 0) return result;

  try {
    var sheet = getDashboardPhotoSheet_(false);
    if (!sheet || sheet.getLastRow() < 2) return result;

    var schema = getDashboardPhotoSchema_(sheet);
    if (!schema.tradeIdCol) return result;

    var lastCol = Math.max(sheet.getLastColumn(), schema.maxCol || 1);
    var rowCount = sheet.getLastRow() - 1;
    var ids = sheet.getRange(2, schema.tradeIdCol, rowCount, 1).getDisplayValues();
    var rowsToRead = [];
    ids.forEach(function(row, idx) {
      var tid = normalizeEquipmentCheckTradeId_(String(row[0] || '').trim());
      if (wanted[tid]) rowsToRead.push(idx + 2);
    });
    var display = readDashboardScheduleRowsDisplay_(sheet, rowsToRead, lastCol);
    var fileIndex = getDashboardPhotoFileIndex_();

    display.forEach(function(row, i) {
      var tid = String(row[schema.tradeIdCol - 1] || '').trim();
      tid = normalizeEquipmentCheckTradeId_(tid);
      if (!wanted[tid]) return;

      var phase = schema.phaseCol ? normalizeDashboardPhotoPhase_(row[schema.phaseCol - 1]) : '';
      var uploadedAt = schema.uploadedAtCol ? String(row[schema.uploadedAtCol - 1] || '').trim() : '';
      var memo = schema.memoCol ? String(row[schema.memoCol - 1] || '').trim() : '';
      var fileId = schema.fileIdCol ? String(row[schema.fileIdCol - 1] || '').trim() : '';
      var thumb = schema.thumbCol ? String(row[schema.thumbCol - 1] || '').trim() : '';

      if (schema.checkoutPhotoCol) {
        addDashboardPhotoCell_(result[tid], 'checkout', String(row[schema.checkoutPhotoCol - 1] || '').trim(), {
          tid: tid,
          row: rowsToRead[i],
          fileId: fileId,
          thumbnailUrl: thumb,
          uploadedAt: uploadedAt,
          memo: memo,
          fileIndex: fileIndex
        });
      }
      if (schema.checkinPhotoCol) {
        addDashboardPhotoCell_(result[tid], 'checkin', String(row[schema.checkinPhotoCol - 1] || '').trim(), {
          tid: tid,
          row: rowsToRead[i],
          fileId: fileId,
          thumbnailUrl: thumb,
          uploadedAt: uploadedAt,
          memo: memo,
          fileIndex: fileIndex
        });
      }
      if (schema.photoCol) {
        addDashboardPhotoCell_(result[tid], phase || 'other', String(row[schema.photoCol - 1] || '').trim(), {
          tid: tid,
          row: rowsToRead[i],
          fileId: fileId,
          thumbnailUrl: thumb,
          uploadedAt: uploadedAt,
          memo: memo,
          fileIndex: fileIndex
        });
      }
    });
  } catch (err) {
    Object.keys(result).forEach(function(tid) {
      result[tid].warning = "반출반납 사진 조회 실패: " + err.message;
    });
  }

  return result;
}

function addDashboardPhotoCell_(bucket, phase, value, context) {
  var values = splitDashboardPhotoValues_(value);
  if (values.length === 0 && context.fileId) values = [context.fileId];
  if (values.length === 0) return;

  phase = normalizeDashboardPhotoPhase_(phase) || 'other';
  if (!bucket[phase]) bucket[phase] = [];

  values.forEach(function(raw) {
    var photo = buildDashboardPhotoEntry_(raw, phase, context);
    if (!photo.url && !photo.thumbnailUrl) return;
    if (dashboardPhotoExists_(bucket[phase], photo)) return;
    bucket[phase].push(photo);
  });
}

function dashboardPhotoExists_(list, photo) {
  var key = photo.fileId || photo.url || photo.thumbnailUrl;
  if (!key) return false;
  for (var i = 0; i < list.length; i++) {
    if ((list[i].fileId || list[i].url || list[i].thumbnailUrl) === key) return true;
  }
  return false;
}

function splitDashboardPhotoValues_(value) {
  var raw = String(value || '').trim();
  if (!raw) return [];
  return raw.split(/\n|,\s*(?=https?:\/\/|[-_A-Za-z0-9]{20,}|[가-힣A-Za-z0-9_.-]+\/)/)
    .map(function(v) { return String(v || '').trim(); })
    .filter(Boolean);
}

function buildDashboardPhotoEntry_(raw, phase, context) {
  var fileId = context.fileId || extractDriveFileId_(raw);
  if (!fileId) fileId = resolveDashboardPhotoFileId_(raw, context.fileIndex);
  var url = normalizeDashboardPhotoUrl_(raw, fileId);
  var thumbnailUrl = context.thumbnailUrl || (fileId ? "https://drive.google.com/thumbnail?id=" + encodeURIComponent(fileId) + "&sz=w640" : url);
  return {
    phase: phase,
    url: url,
    thumbnailUrl: thumbnailUrl,
    fileId: fileId,
    uploadedAt: context.uploadedAt || '',
    memo: context.memo || '',
    row: context.row || 0
  };
}

function normalizeDashboardPhotoUrl_(raw, fileId) {
  raw = String(raw || '').trim();
  if (/^https?:\/\//i.test(raw)) return raw;
  if (fileId) return "https://drive.google.com/file/d/" + encodeURIComponent(fileId) + "/view";
  return raw;
}

function extractDriveFileId_(value) {
  var raw = String(value || '').trim();
  if (!raw) return '';
  var m = raw.match(/\/d\/([A-Za-z0-9_-]{20,})/);
  if (m) return m[1];
  m = raw.match(/[?&]id=([A-Za-z0-9_-]{20,})/);
  if (m) return m[1];
  m = raw.match(/\b([A-Za-z0-9_-]{25,})\b/);
  return m ? m[1] : '';
}

function resolveDashboardPhotoFileId_(value, fileIndex) {
  var raw = String(value || '').trim();
  if (!raw || /^https?:\/\//i.test(raw)) return '';
  var fileName = raw.split('/').pop();
  if (!/\.(jpe?g|png|webp|gif|heic)$/i.test(fileName)) return '';
  if (fileIndex && fileIndex[fileName]) return fileIndex[fileName];

  var cacheKey = 'dashboard_photo_file_' + Utilities.base64EncodeWebSafe(fileName).slice(0, 80);
  try {
    var cache = CacheService.getScriptCache();
    var cached = cache.get(cacheKey);
    if (cached) return cached === '-' ? '' : cached;
  } catch (cacheErr) {}

  var fileId = '';
  try {
    var files = DriveApp.getFilesByName(fileName);
    if (files.hasNext()) fileId = files.next().getId();
  } catch (driveErr) {}

  try {
    CacheService.getScriptCache().put(cacheKey, fileId || '-', 21600);
  } catch (cachePutErr) {}
  return fileId;
}

function getDashboardPhotoFileIndex_() {
  var cache = null;
  try {
    cache = CacheService.getScriptCache();
    var cached = cache.get(DASHBOARD_PHOTO_FILE_INDEX_CACHE_KEY_);
    if (cached) return JSON.parse(cached);
  } catch (cacheErr) {}

  var index = {};
  try {
    var folder = getDashboardPhotoStorageFolder_();
    var files = folder.getFiles();
    while (files.hasNext()) {
      var file = files.next();
      index[file.getName()] = file.getId();
    }
  } catch (err) {}

  try {
    if (cache) cache.put(DASHBOARD_PHOTO_FILE_INDEX_CACHE_KEY_, JSON.stringify(index), 21600);
  } catch (cachePutErr) {}
  return index;
}

function normalizeDashboardPhotoPhase_(value) {
  var raw = String(value || '').replace(/\s+/g, '').toLowerCase();
  if (!raw) return '';
  if (raw.indexOf('반납') >= 0 || raw.indexOf('입고') >= 0 || raw.indexOf('회수') >= 0 ||
      raw.indexOf('checkin') >= 0 || raw.indexOf('return') >= 0 || raw === 'in') {
    return 'checkin';
  }
  if (raw.indexOf('반출') >= 0 || raw.indexOf('출고') >= 0 || raw.indexOf('대여') >= 0 ||
      raw.indexOf('checkout') >= 0 || raw.indexOf('out') >= 0) {
    return 'checkout';
  }
  return '';
}

function getDashboardPhotoSchema_(sheet) {
  var lastCol = Math.max(sheet.getLastColumn(), 1);
  var headers = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
  var schema = {
    headers: headers,
    maxCol: lastCol,
    keyCol: _findHeaderCol_(headers, ["사진ID", "사진 ID", "ID", "PhotoID", "photoId"]),
    tradeIdCol: _findHeaderCol_(headers, ["거래ID", "거래 ID", "거래Id", "거래id", "계약ID", "예약ID", "예약번호", "tradeId"]),
    phaseCol: _findHeaderCol_(headers, ["구분", "사진구분", "사진 구분", "반출반납", "반출/반납", "단계", "타입", "유형", "업무", "phase", "type"]),
    photoCol: _findHeaderCol_(headers, ["사진", "사진URL", "사진 URL", "사진링크", "사진 링크", "이미지", "이미지URL", "이미지 URL", "파일", "파일URL", "파일 URL", "링크", "드라이브링크", "photo", "image", "url"]),
    checkoutPhotoCol: _findHeaderCol_(headers, ["반출사진", "반출 사진", "출고사진", "출고 사진", "대여사진", "대여 사진", "반출이미지", "checkoutPhoto"]),
    checkinPhotoCol: _findHeaderCol_(headers, ["반납사진", "반납 사진", "입고사진", "입고 사진", "회수사진", "회수 사진", "반납이미지", "checkinPhoto"]),
    fileIdCol: _findHeaderCol_(headers, ["파일ID", "파일 ID", "드라이브ID", "드라이브 ID", "DriveFileId", "fileId"]),
    thumbCol: _findHeaderCol_(headers, ["썸네일", "썸네일URL", "썸네일 URL", "thumbnail", "thumbnailUrl"]),
    uploadedAtCol: _findHeaderCol_(headers, ["업로드일시", "업로드 일시", "촬영일시", "촬영 일시", "등록일시", "등록 일시", "일시", "타임스탬프", "Timestamp"]),
    memoCol: _findHeaderCol_(headers, ["메모", "비고", "특이사항", "특이 사항", "memo", "note"])
  };
  if (!schema.tradeIdCol) schema.tradeIdCol = detectTradeIdColumn_(sheet, lastCol);
  return schema;
}

function detectTradeIdColumn_(sheet, lastCol) {
  if (!sheet || sheet.getLastRow() < 2) return 0;
  var scanRows = Math.min(sheet.getLastRow() - 1, 30);
  var values = sheet.getRange(2, 1, scanRows, lastCol).getDisplayValues();
  var scores = [];
  for (var c = 0; c < lastCol; c++) scores[c] = 0;
  values.forEach(function(row) {
    row.forEach(function(cell, c) {
      if (/^\d{6}-\d{3}(?:-\d+)?$/.test(String(cell || '').trim())) scores[c]++;
    });
  });
  var bestCol = 0;
  var bestScore = 0;
  scores.forEach(function(score, c) {
    if (score > bestScore) {
      bestScore = score;
      bestCol = c + 1;
    }
  });
  return bestScore > 0 ? bestCol : 0;
}

function getDashboardPhotoSheet_(required) {
  var 개고생URL = PropertiesService.getScriptProperties().getProperty("개고생2_URL");
  if (!개고생URL) {
    if (required) throw new Error("개고생2_URL 미설정");
    return null;
  }
  var sheet = SpreadsheetApp.openByUrl(개고생URL).getSheetByName(DASHBOARD_PHOTO_SHEET_NAME_);
  if (!sheet && required) throw new Error("빌리지2.0 '" + DASHBOARD_PHOTO_SHEET_NAME_ + "' 시트 없음");
  return sheet;
}

function uploadDashboardPhoto(tid, phase, fileName, mimeType, data, memo) {
  tid = normalizeEquipmentCheckTradeId_(String(tid || '').trim());
  phase = normalizeDashboardPhotoPhase_(phase);
  if (!tid) return { error: "tid 필요" };
  if (phase !== 'checkout' && phase !== 'checkin') return { error: "phase는 checkout/checkin만 허용" };
  if (!data) return { error: "사진 데이터 필요" };

  var lock = LockService.getScriptLock();
  try { lock.waitLock(10000); } catch (lockErr) {}

  try {
    var sheet = getDashboardPhotoSheet_(true);
    var schema = getDashboardPhotoSchema_(sheet);
    var targetPhotoCol = getDashboardPhotoWriteCol_(schema, phase);
    if (!schema.tradeIdCol) return { error: "반출반납 사진 시트에서 거래ID 열을 찾지 못했습니다" };
    if (!targetPhotoCol) return { error: "반출반납 사진 시트에서 사진 URL 열을 찾지 못했습니다" };
    if (!schema.phaseCol && targetPhotoCol === schema.photoCol) {
      return { error: "공통 사진 열을 쓰려면 구분/사진구분 열이 필요합니다" };
    }

    var upload = normalizeDashboardUploadData_(data, mimeType);
    var photoId = makeDashboardPhotoId_();
    var safeName = makeDashboardPhotoFileName_(photoId, fileName, upload.mimeType);
    var relativePath = DASHBOARD_PHOTO_APPSHEET_FOLDER_NAME_ + "/" + safeName;
    var blob = Utilities.newBlob(Utilities.base64Decode(upload.base64), upload.mimeType, safeName);
    var folder = getDashboardPhotoStorageFolder_();
    var file = folder.createFile(blob);
    try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (shareErr) {}

    var fileId = file.getId();
    var url = file.getUrl();
    var thumb = "https://drive.google.com/thumbnail?id=" + encodeURIComponent(fileId) + "&sz=w640";
    var now = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
    var width = Math.max(sheet.getLastColumn(), schema.maxCol || 1);
    var row = [];
    for (var i = 0; i < width; i++) row.push('');

    if (schema.keyCol) row[schema.keyCol - 1] = photoId;
    row[schema.tradeIdCol - 1] = tid;
    if (schema.phaseCol) row[schema.phaseCol - 1] = phase === 'checkout' ? '반출' : '반납';
    row[targetPhotoCol - 1] = relativePath;
    if (schema.fileIdCol) row[schema.fileIdCol - 1] = fileId;
    if (schema.thumbCol) row[schema.thumbCol - 1] = thumb;
    if (schema.uploadedAtCol) row[schema.uploadedAtCol - 1] = now;
    if (schema.memoCol) row[schema.memoCol - 1] = String(memo || '').trim();

    sheet.appendRow(row);
    invalidateDashboardPhotoCache_();
    invalidateDashboardCache();

    return {
      success: true,
      tid: tid,
      phase: phase,
      photo: {
        phase: phase,
        url: url,
        thumbnailUrl: thumb,
        fileId: fileId,
        sheetValue: relativePath,
        uploadedAt: now,
        memo: String(memo || '').trim()
      }
    };
  } catch (err) {
    return { error: err.message };
  } finally {
    try { lock.releaseLock(); } catch (releaseErr) {}
  }
}

function invalidateDashboardPhotoCache_() {
  try {
    CacheService.getScriptCache().remove(DASHBOARD_PHOTO_FILE_INDEX_CACHE_KEY_);
  } catch (err) {}
}

function getDashboardPhotoWriteCol_(schema, phase) {
  if (phase === 'checkout' && schema.checkoutPhotoCol) return schema.checkoutPhotoCol;
  if (phase === 'checkin' && schema.checkinPhotoCol) return schema.checkinPhotoCol;
  return schema.photoCol || 0;
}

function normalizeDashboardUploadData_(data, mimeType) {
  var raw = String(data || '').trim();
  var match = raw.match(/^data:([^;]+);base64,(.*)$/);
  if (match) {
    return {
      mimeType: String(match[1] || mimeType || 'image/jpeg').trim(),
      base64: String(match[2] || '').replace(/\s+/g, '')
    };
  }
  return {
    mimeType: String(mimeType || 'image/jpeg').trim(),
    base64: raw.replace(/\s+/g, '')
  };
}

function makeDashboardPhotoId_() {
  return Utilities.getUuid().replace(/-/g, '').slice(0, 8);
}

function makeDashboardPhotoFileName_(photoId, fileName, mimeType) {
  var ext = '.jpg';
  var original = String(fileName || '').trim();
  var m = original.match(/(\.[A-Za-z0-9]{2,5})$/);
  if (m) ext = m[1].toLowerCase();
  else if (String(mimeType || '').indexOf('png') >= 0) ext = '.png';
  else if (String(mimeType || '').indexOf('webp') >= 0) ext = '.webp';
  var stamp = Utilities.formatDate(new Date(), 'Asia/Seoul', 'HHmmss');
  return photoId + ".사진." + stamp + ext;
}

function getDashboardPhotoStorageFolder_() {
  var props = PropertiesService.getScriptProperties();
  var folderId = props.getProperty("DASHBOARD_PHOTO_APPSHEET_FOLDER_ID") ||
    props.getProperty("반출반납사진_이미지_FOLDER_ID");
  if (folderId) {
    try { return DriveApp.getFolderById(folderId); } catch (err) {}
  }
  var folders = DriveApp.getFoldersByName(DASHBOARD_PHOTO_APPSHEET_FOLDER_NAME_);
  return folders.hasNext() ? folders.next() : getDashboardPhotoRootFolder_().createFolder(DASHBOARD_PHOTO_APPSHEET_FOLDER_NAME_);
}

function getDashboardPhotoRootFolder_() {
  var props = PropertiesService.getScriptProperties();
  var folderId = props.getProperty("DASHBOARD_PHOTO_FOLDER_ID") ||
    props.getProperty("반출반납사진_FOLDER_ID") ||
    props.getProperty("PHOTO_FOLDER_ID");
  if (folderId) {
    try { return DriveApp.getFolderById(folderId); } catch (err) {}
  }
  var folders = DriveApp.getFoldersByName(DASHBOARD_PHOTO_FOLDER_NAME_);
  return folders.hasNext() ? folders.next() : DriveApp.createFolder(DASHBOARD_PHOTO_FOLDER_NAME_);
}

function inspectDashboardPhotoSheet() {
  var info = {
    sheet: DASHBOARD_PHOTO_SHEET_NAME_,
    exists: false,
    hidden: false,
    headers: [],
    schema: {},
    lastRow: 0,
    lastColumn: 0,
    writable: false,
    sampleRows: []
  };
  try {
    var sheet = getDashboardPhotoSheet_(false);
    if (!sheet) return info;
    var schema = getDashboardPhotoSchema_(sheet);
    info.exists = true;
    info.hidden = sheet.isSheetHidden();
    info.headers = schema.headers;
    info.schema = {
      tradeIdCol: schema.tradeIdCol ? columnToLetter_(schema.tradeIdCol) : "",
      phaseCol: schema.phaseCol ? columnToLetter_(schema.phaseCol) : "",
      photoCol: schema.photoCol ? columnToLetter_(schema.photoCol) : "",
      checkoutPhotoCol: schema.checkoutPhotoCol ? columnToLetter_(schema.checkoutPhotoCol) : "",
      checkinPhotoCol: schema.checkinPhotoCol ? columnToLetter_(schema.checkinPhotoCol) : "",
      fileIdCol: schema.fileIdCol ? columnToLetter_(schema.fileIdCol) : "",
      thumbCol: schema.thumbCol ? columnToLetter_(schema.thumbCol) : "",
      uploadedAtCol: schema.uploadedAtCol ? columnToLetter_(schema.uploadedAtCol) : "",
      memoCol: schema.memoCol ? columnToLetter_(schema.memoCol) : ""
    };
    info.lastRow = sheet.getLastRow();
    info.lastColumn = sheet.getLastColumn();
    info.writable = !!(schema.tradeIdCol && (schema.checkoutPhotoCol || schema.checkinPhotoCol || (schema.photoCol && schema.phaseCol)));
    if (sheet.getLastRow() >= 2) {
      var rows = Math.min(sheet.getLastRow() - 1, 5);
      info.sampleRows = sheet.getRange(2, 1, rows, Math.min(sheet.getLastColumn(), 12)).getDisplayValues();
    }
  } catch (err) {
    info.error = err.message;
  }
  return info;
}

function getTradePaymentOptions_() {
  return getCachedDashboardTradeOptions_('dashboard_trade_payment_options_v1', function() {
    return getTradePaymentOptionsFromSheet_();
  }, defaultPaymentOptions_());
}

function getTradePaymentOptionsFromSheet_() {
  try {
    var 개고생URL = PropertiesService.getScriptProperties().getProperty("개고생2_URL");
    if (!개고생URL) return defaultPaymentOptions_();
    var 거래시트 = SpreadsheetApp.openByUrl(개고생URL).getSheetByName("거래내역");
    if (!거래시트) return defaultPaymentOptions_();

    var maxRows = Math.max(거래시트.getMaxRows(), 2);
    var scanRows = Math.min(Math.max(maxRows - 1, 1), 50);
    for (var r = 2; r < 2 + scanRows; r++) {
      var rule = 거래시트.getRange(r, 10).getDataValidation(); // J열
      var opts = paymentOptionsFromRule_(rule);
      if (opts.length > 0) return opts;
    }
  } catch (err) {}
  return defaultPaymentOptions_();
}

function getTradeProofTypeOptions_() {
  return getTradeColumnOptions_(11, ["미발행", "세금계산서", "현금영수증(전화번호)", "현금영수증(사업자번호)"]);
}

function getTradeIssueStatusOptions_() {
  return getTradeColumnOptions_(12, ["미발행", "발행요청", "발행완료", "전송실패"]);
}

function getTradeDepositStatusOptions_() {
  return getTradeColumnOptions_(13, ["미입금", "입금완료", "부분입금", "환불"]);
}

function getTradeBillingCompanyOptions_() {
  return getCachedDashboardTradeOptions_('dashboard_trade_billing_company_options_v1', function() {
    var options = getTradeColumnOptionsFromSheet_(7, []);
    if (options.length > 0) return options;
    return getTradeBillingCompanyOptionsFromIssuerDb_();
  }, []);
}

function getTradeBillingCompanyOptionsFromIssuerDb_() {
  try {
    var 개고생URL = PropertiesService.getScriptProperties().getProperty("개고생2_URL");
    if (!개고생URL) return [];
    var 개고생SS = SpreadsheetApp.openByUrl(개고생URL);
    var 발행처시트 = 개고생SS.getSheetByName("발행처DB");
    if (!발행처시트 || 발행처시트.getLastRow() < 2) return [];

    var lastCol = Math.max(발행처시트.getLastColumn(), 1);
    var headers = 발행처시트.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
    var companyCol = _findHeaderCol_(headers, [
      "발행처상호",
      "발행처 상호",
      "상호",
      "업체명",
      "회사명"
    ]) || 1;
    var values = 발행처시트.getRange(2, companyCol, 발행처시트.getLastRow() - 1, 1)
      .getDisplayValues()
      .map(function(row) { return row[0]; });
    return uniqueDashboardStringOptions_(values);
  } catch (err) {}
  return [];
}

function getTradeColumnOptions_(column, fallbackOptions) {
  return getCachedDashboardTradeOptions_('dashboard_trade_col_options_v1_' + column, function() {
    return getTradeColumnOptionsFromSheet_(column, fallbackOptions);
  }, fallbackOptions);
}

function getTradeColumnOptionsFromSheet_(column, fallbackOptions) {
  try {
    var 개고생URL = PropertiesService.getScriptProperties().getProperty("개고생2_URL");
    if (!개고생URL) return fallbackOptions.slice();
    var 거래시트 = SpreadsheetApp.openByUrl(개고생URL).getSheetByName("거래내역");
    if (!거래시트) return fallbackOptions.slice();

    var maxRows = Math.max(거래시트.getMaxRows(), 2);
    var scanRows = Math.min(Math.max(maxRows - 1, 1), 80);
    for (var r = 2; r < 2 + scanRows; r++) {
      var opts = paymentOptionsFromRule_(거래시트.getRange(r, column).getDataValidation());
      if (opts.length > 0) return opts;
    }
  } catch (err) {}
  return fallbackOptions.slice();
}

function uniqueDashboardStringOptions_(values) {
  var seen = {};
  var result = [];
  (values || []).forEach(function(value) {
    var text = String(value || '').trim();
    if (!text || seen[text]) return;
    seen[text] = true;
    result.push(text);
  });
  return result;
}

function getCachedDashboardTradeOptions_(key, loader, fallbackOptions) {
  var cache = CacheService.getScriptCache();
  try {
    var cached = cache.get(key);
    if (cached) {
      var parsed = JSON.parse(cached);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch (err) {}

  var options = [];
  try {
    options = loader() || [];
  } catch (loadErr) {
    options = [];
  }
  if (!Array.isArray(options) || options.length === 0) options = (fallbackOptions || []).slice();

  try { cache.put(key, JSON.stringify(options), 21600); } catch (putErr) {}
  return options;
}

function defaultPaymentOptions_() {
  return ["미정", "계좌", "카드", "현금", "기타"];
}

function paymentOptionsFromRule_(rule) {
  if (!rule) return [];
  try {
    var type = rule.getCriteriaType();
    var vals = rule.getCriteriaValues();
    if (type === SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST) {
      return (vals[0] || []).map(String).map(function(v) { return v.trim(); }).filter(Boolean);
    }
    if (type === SpreadsheetApp.DataValidationCriteria.VALUE_IN_RANGE && vals[0]) {
      return vals[0].getDisplayValues().map(function(r) { return String(r[0] || '').trim(); }).filter(Boolean);
    }
  } catch (err) {}
  return [];
}

function inspectTradePaymentColumn() {
  var info = {
    sheet: "거래내역",
    paymentColumn: "J",
    header: "",
    options: [],
    columns: [],
    sampleRowsByPayment: [],
    note: "스크립트 setValue/API 변경은 일반적으로 대상 스프레드시트의 onEdit 트리거를 실행하지 않습니다."
  };
  try {
    var 개고생URL = PropertiesService.getScriptProperties().getProperty("개고생2_URL");
    if (!개고생URL) {
      info.error = "개고생2_URL 미설정";
      return info;
    }
    var 거래시트 = SpreadsheetApp.openByUrl(개고생URL).getSheetByName("거래내역");
    if (!거래시트) {
      info.error = "거래내역 시트 없음";
      return info;
    }
    var lastCol = Math.min(Math.max(거래시트.getLastColumn(), 18), 30);
    var lastRow = 거래시트.getLastRow();
    var headers = 거래시트.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
    var idCol = _findHeaderCol_(headers, ["거래ID", "거래 Id", "거래id"]) || 5;
    info.header = String(headers[9] || "");
    info.lastColumn = columnToLetter_(lastCol);
    info.idColumn = columnToLetter_(idCol);
    info.options = getTradePaymentOptions_();
    info.sampleValidationA1 = "";

    var validationRows = Math.min(Math.max(거래시트.getMaxRows() - 1, 1), 50);
    var validationGrid = 거래시트.getRange(2, 10, validationRows, lastCol - 9).getDataValidations();
    for (var c = 10; c <= lastCol; c++) {
      var sampleRule = null;
      var sampleA1 = "";
      for (var r = 0; r < validationGrid.length; r++) {
        sampleRule = validationGrid[r][c - 10];
        if (sampleRule) {
          sampleA1 = columnToLetter_(c) + (r + 2);
          break;
        }
      }
      if (c === 10 && sampleA1) info.sampleValidationA1 = sampleA1;
      info.columns.push({
        column: columnToLetter_(c),
        header: String(headers[c - 1] || ""),
        sampleValidationA1: sampleA1,
        validationOptions: paymentOptionsFromRule_(sampleRule),
        validationType: sampleRule ? String(sampleRule.getCriteriaType()) : ""
      });
    }

    if (lastRow >= 2) {
      var scanRows = Math.min(lastRow - 1, 500);
      var display = 거래시트.getRange(2, 1, scanRows, lastCol).getDisplayValues();
      var formulas = 거래시트.getRange(2, 1, scanRows, lastCol).getFormulas();
      var seen = {};
      var samples = [];
      for (var i = 0; i < display.length; i++) {
        var payment = String(display[i][9] || "").trim();
        if (!payment || seen[payment]) continue;
        seen[payment] = true;
        samples.push(compactPaymentInspectRow_(i + 2, idCol, headers, display[i], formulas[i], lastCol));
        if (samples.length >= 10) break;
      }
      info.sampleRowsByPayment = samples;
    }
  } catch (err) {
    info.error = err.message;
  }
  return info;
}

function columnToLetter_(col) {
  var s = "";
  while (col > 0) {
    var mod = (col - 1) % 26;
    s = String.fromCharCode(65 + mod) + s;
    col = Math.floor((col - mod) / 26);
  }
  return s;
}

function compactPaymentInspectRow_(rowNumber, idCol, headers, displayRow, formulaRow, lastCol) {
  var after = {};
  var formulas = {};
  for (var c = 11; c <= lastCol; c++) {
    var header = String(headers[c - 1] || "").trim();
    var label = columnToLetter_(c) + (header ? ":" + header : "");
    var val = String(displayRow[c - 1] || "").trim();
    var formula = String(formulaRow[c - 1] || "").trim();
    if (val || formula || header) {
      after[label] = val;
      if (formula) formulas[label] = formula;
    }
  }
  return {
    row: rowNumber,
    tradeId: String(displayRow[idCol - 1] || "").trim(),
    payment: String(displayRow[9] || "").trim(),
    afterPaymentColumns: after,
    formulasAfterPayment: formulas
  };
}

function _findHeaderCol_(headers, candidates) {
  var normalized = headers.map(function(h) {
    return String(h || '').replace(/\s+/g, '').toLowerCase();
  });
  for (var i = 0; i < candidates.length; i++) {
    var needle = String(candidates[i]).replace(/\s+/g, '').toLowerCase();
    var idx = normalized.indexOf(needle);
    if (idx >= 0) return idx + 1;
  }
  return 0;
}

/**
 * 오늘일정 웹앱에서 결제수단을 빌리지2.0 거래내역 J열에 저장한다.
 */
function updateTradePaymentMethod(tid, method) {
  if (!tid) return { error: "tid 필요" };
  tid = String(tid).trim();
  method = String(method || '').trim();
  var allowed = [""].concat(getTradePaymentOptions_());
  if (allowed.indexOf(method) < 0) return { error: "허용되지 않은 결제수단: " + method };

  var props = PropertiesService.getScriptProperties();

  var wroteSheet = false;
  var warning = "";
  try {
    var 개고생URL = props.getProperty("개고생2_URL");
    if (개고생URL) {
      var 거래시트 = SpreadsheetApp.openByUrl(개고생URL).getSheetByName("거래내역");
      if (거래시트 && 거래시트.getLastRow() >= 2) {
        var lastCol = Math.max(거래시트.getLastColumn(), 6);
        var headers = 거래시트.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
        var idCol = _findHeaderCol_(headers, ["거래ID", "거래 Id", "거래id"]) || 5;
        var paymentCol = 10; // J열: 결제수단
        var ids = 거래시트.getRange(2, idCol, 거래시트.getLastRow() - 1, 1).getDisplayValues();
        for (var i = 0; i < ids.length; i++) {
          if (String(ids[i][0] || '').trim() === tid) {
            거래시트.getRange(i + 2, paymentCol).setValue(method);
            var sideEffects = applyTradePaymentSideEffects_(거래시트, i + 2, method);
            wroteSheet = true;
            break;
          }
        }
        if (!wroteSheet) warning = "거래내역에서 거래ID를 찾지 못했습니다";
      }
    }
  } catch (err) {
    warning = "거래내역 결제수단 반영 실패: " + err.message;
  }
  invalidateDashboardTradeExtraCache_([tid]);
  invalidateDashboardCache();
  return {
    success: wroteSheet,
    tid: tid,
    method: method,
    wroteSheet: wroteSheet,
    sideEffects: sideEffects || { applied: false },
    warning: warning,
    onEditTriggered: false,
    note: "스크립트 setValue/API 변경은 대상 거래내역 시트의 onEdit 트리거를 실행하지 않으므로, 확인된 카드결제 후속값은 API에서 직접 반영합니다."
  };
}

function applyTradePaymentSideEffects_(sheet, row, method) {
  var preset = null;
  if (method === "카드결제") {
    preset = {
      proofType: "미발행",      // K: 증빙 유형
      issueStatus: "발행완료", // L: 발행요청
      depositStatus: "입금완료" // M: 입금 상태
    };
  }
  if (!preset) return { applied: false };

  var values = [preset.proofType, preset.issueStatus, preset.depositStatus];
  var columns = [11, 12, 13]; // K, L, M
  var labels = ["K", "L", "M"];
  var skipped = [];
  for (var i = 0; i < columns.length; i++) {
    var opts = paymentOptionsFromRule_(sheet.getRange(row, columns[i]).getDataValidation());
    if (opts.length > 0 && opts.indexOf(values[i]) < 0) {
      skipped.push(labels[i] + ":" + values[i]);
    }
  }
  if (skipped.length > 0) {
    return {
      applied: false,
      warning: "거래내역 드롭다운에 없는 후속값: " + skipped.join(", ")
    };
  }

  sheet.getRange(row, 11, 1, 3).setValues([values]);
  return {
    applied: true,
    columns: {
      K: preset.proofType,
      L: preset.issueStatus,
      M: preset.depositStatus
    }
  };
}

/**
 * 오늘일정 웹앱에서 발행처 상호를 빌리지2.0 거래내역 G열에 저장한다.
 */
function updateTradeBillingCompany(tid, billingCompany) {
  tid = String(tid || '').trim();
  billingCompany = String(billingCompany || '').trim();

  if (!tid) return { error: "tid 필요" };

  var lock = LockService.getScriptLock();
  try { lock.waitLock(5000); } catch (lockErr) {}

  try {
    var 거래시트 = getVillageTradeSheet_();
    var row = findVillageTradeRow_(거래시트, tid);
    if (!row) return { error: "거래내역에서 거래ID를 찾지 못했습니다: " + tid };

    var billingCompanyCol = 7; // G: 발행처 상호
    var opts = paymentOptionsFromRule_(거래시트.getRange(row, billingCompanyCol).getDataValidation());
    if (billingCompany && opts.length > 0 && opts.indexOf(billingCompany) < 0) {
      return { error: "발행처 상호 드롭다운에 없는 값입니다: " + billingCompany };
    }

    거래시트.getRange(row, billingCompanyCol).setValue(billingCompany);
    invalidateDashboardTradeExtraCache_([tid]);
    invalidateDashboardCache();
    return {
      success: true,
      tid: tid,
      billingCompany: billingCompany,
      row: row,
      column: "G"
    };
  } catch (err) {
    return { error: err.message };
  } finally {
    try { lock.releaseLock(); } catch (releaseErr) {}
  }
}

function updateTradeProofField(tid, field, value) {
  tid = String(tid || '').trim();
  field = String(field || '').trim();
  value = String(value || '').trim();

  if (!tid) return { error: "tid 필요" };
  if (field !== "proofType" && field !== "issueStatus" && field !== "depositStatus") {
    return { error: "field는 proofType/issueStatus/depositStatus만 허용" };
  }

  if (field === "issueStatus" && value === "발행요청") {
    return requestTradeProofIssue(tid);
  }

  var lock = LockService.getScriptLock();
  try { lock.waitLock(5000); } catch (lockErr) {}

  try {
    var 거래시트 = getVillageTradeSheet_();
    var row = findVillageTradeRow_(거래시트, tid);
    if (!row) return { error: "거래내역에서 거래ID를 찾지 못했습니다: " + tid };

    var fieldMeta = {
      proofType: { column: 11, label: "증빙유형" },
      issueStatus: { column: 12, label: "발행상태" },
      depositStatus: { column: 13, label: "입금상태" }
    };
    var column = fieldMeta[field].column; // K/L/M
    var label = fieldMeta[field].label;
    var opts = paymentOptionsFromRule_(거래시트.getRange(row, column).getDataValidation());
    if (value && opts.length > 0 && opts.indexOf(value) < 0) {
      return { error: label + " 드롭다운에 없는 값입니다: " + value };
    }

    거래시트.getRange(row, column).setValue(value);
    invalidateDashboardTradeExtraCache_([tid]);
    invalidateDashboardCache();
    return {
      success: true,
      tid: tid,
      field: field,
      value: value,
      row: row
    };
  } catch (err) {
    return { error: err.message };
  } finally {
    try { lock.releaseLock(); } catch (releaseErr) {}
  }
}

function requestTradeEstimate(tid) {
  return callVillageOpsApi_("sendEstimate", tid);
}

function requestTradeProofIssue(tid) {
  var ready = validateTradeProofIssueReady_(tid);
  if (ready && ready.error) return ready;
  var result = callVillageOpsApi_("issueProof", tid);
  if (result && typeof result === "object" && !result.error) {
    result.billingCompany = ready.billingCompany;
    result.proofType = ready.proofType;
  }
  return result;
}

function validateTradeProofIssueReady_(tid) {
  tid = String(tid || '').trim();
  if (!tid) return { error: "tid 필요" };

  var 거래시트 = getVillageTradeSheet_();
  var row = findVillageTradeRow_(거래시트, tid);
  if (!row) return { error: "거래내역에서 거래ID를 찾지 못했습니다: " + tid };

  var values = 거래시트.getRange(row, 7, 1, 6).getDisplayValues()[0]; // G:L
  var billingCompany = String(values[0] || '').trim(); // G: 발행처 상호
  var proofType = String(values[4] || '').trim();      // K: 증빙유형
  if (proofType === "세금계산서" && !billingCompany) {
    return {
      error: "세금계산서 발행 전 발행처 상호를 선택하세요.",
      tid: tid,
      proofType: proofType,
      billingCompany: billingCompany
    };
  }
  return {
    success: true,
    tid: tid,
    proofType: proofType,
    billingCompany: billingCompany,
    row: row
  };
}

function callVillageOpsApi_(action, tid) {
  tid = String(tid || '').trim();
  if (!tid) return { error: "tid 필요" };

  try {
    var props = PropertiesService.getScriptProperties();
    var url = getVillageOpsApiUrl_(props);
    var payload = {
      action: action,
      id: tid,
      key: getVillageOpsApiKey_(props)
    };
    var res = UrlFetchApp.fetch(url, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    var text = res.getContentText();
    var data;
    try {
      data = JSON.parse(text);
    } catch (parseErr) {
      return { error: "빌리지2.0 응답 파싱 실패: " + text.slice(0, 200) };
    }
    if (res.getResponseCode() < 200 || res.getResponseCode() >= 300) {
      return { error: "빌리지2.0 HTTP " + res.getResponseCode() + ": " + (data.error || text) };
    }
    if (data.error) return data;
    invalidateDashboardTradeExtraCache_([tid]);
    invalidateDashboardCache();
    return data;
  } catch (err) {
    return { error: err.message };
  }
}

function getVillageOpsApiUrl_(props) {
  var url = props.getProperty("개고생2_API_URL") ||
    props.getProperty("VILLAGE2_API_URL") ||
    props.getProperty("VILLAGE_OPS_API_URL") ||
    "https://script.google.com/macros/s/AKfycbwX2V0SqRf23DCwaVojlc5YFXKTfMNLBt68edpGmCx8j0i9hkYdP_bXHKEGIcde2iS5EA/exec";
  return String(url || "").trim();
}

function getVillageOpsApiKey_(props) {
  return String(
    props.getProperty("개고생2_API_KEY") ||
    props.getProperty("VILLAGE_OPS_KEY") ||
    "village2026"
  ).trim();
}

function getVillageTradeSheet_() {
  var 개고생URL = PropertiesService.getScriptProperties().getProperty("개고생2_URL");
  if (!개고생URL) throw new Error("개고생2_URL 미설정");
  var 거래시트 = SpreadsheetApp.openByUrl(개고생URL).getSheetByName("거래내역");
  if (!거래시트) throw new Error("거래내역 시트 없음");
  return 거래시트;
}

function findVillageTradeRow_(sheet, tid) {
  if (!sheet || sheet.getLastRow() < 2) return 0;
  var lastCol = Math.max(sheet.getLastColumn(), 5);
  var headers = sheet.getRange(1, 1, 1, lastCol).getDisplayValues()[0];
  var idCol = _findHeaderCol_(headers, ["거래ID", "거래 Id", "거래id"]) || 5;
  var ids = sheet.getRange(2, idCol, sheet.getLastRow() - 1, 1).getDisplayValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0] || '').trim() === tid) return i + 2;
  }
  return 0;
}

/**
 * 스케줄 웹앱 장비 추가용 거래 후보 검색.
 * 이름은 예약자명/업체명/거래ID 부분검색, 날짜는 계약마스터 반출일 기준.
 */
function findTradeCandidatesForSchedule(name, date) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("계약마스터");
  if (!sheet || sheet.getLastRow() < 2) return { candidates: [] };

  var q = String(name || '').trim().toLowerCase();
  var dateStr = String(date || '').trim();
  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 10).getValues();
  var display = sheet.getRange(2, 1, sheet.getLastRow() - 1, 10).getDisplayValues();
  var out = [];

  for (var i = 0; i < data.length; i++) {
    var tid = String(data[i][0] || '').trim();
    if (!tid) continue;
    var 예약자명 = String(data[i][1] || '').trim();
    var 업체명 = String(data[i][3] || '').trim();
    var 상태 = String(data[i][9] || '').trim();
    if (상태 === "취소") continue;

    var 반출일 = _fmtDateForApi_(data[i][4], display[i][4]);
    if (dateStr && 반출일 !== dateStr) continue;
    if (q) {
      var hay = (tid + " " + 예약자명 + " " + 업체명).toLowerCase();
      if (hay.indexOf(q) < 0) continue;
    }

    out.push({
      tradeId: tid,
      name: 예약자명,
      company: 업체명,
      checkout: 반출일 + (display[i][5] ? " " + display[i][5] : ""),
      checkin: _fmtDateForApi_(data[i][6], display[i][6]) + (display[i][7] ? " " + display[i][7] : ""),
      status: 상태 || "대기"
    });
    if (out.length >= 20) break;
  }
  return { candidates: out };
}

function _fmtDateForApi_(raw, display) {
  if (raw instanceof Date) return Utilities.formatDate(raw, "Asia/Seoul", "yyyy-MM-dd");
  return String(display || raw || '').trim();
}

function resolveEquipmentName_(input, ss) {
  var raw = String(input || '').trim();
  if (!raw) return raw;
  var names = [];
  var listSheet = ss.getSheetByName("목록");
  if (listSheet && listSheet.getLastRow() >= 2) {
    names = listSheet.getRange(2, 1, listSheet.getLastRow() - 1, 1).getDisplayValues()
      .map(function(r) { return String(r[0] || '').trim(); })
      .filter(function(v) { return !!v; });
  }
  return names.length ? fuzzyMatchEquipName(raw, names) : raw;
}

function buildAvailabilityItems_(equipName, qty, components) {
  var map = {};
  qty = Number(qty) || 1;
  if (components && components.length > 0) {
    components.forEach(function(c) {
      var n = String(c.name || '').trim();
      if (!n) return;
      map[n] = (map[n] || 0) + ((Number(c.qty) || 1) * qty);
    });
  } else {
    map[String(equipName || '').trim()] = qty;
  }
  return Object.keys(map).map(function(name) { return { name: name, qty: map[name] }; });
}

function checkAvailabilityForAdd_(itemsToAdd, startDT, endDT, equipSheet, schedSheet) {
  var conflicts = [];
  var warnings = [];
  if (!equipSheet) return { ok: false, conflicts: [{ message: "장비마스터 없음" }] };
  var schedData = getScheduleData(schedSheet);

  (itemsToAdd || []).forEach(function(item) {
    var equipName = String(item.name || '').trim();
    var reqQty = Number(item.qty) || 1;
    var equipInfo = findEquipment(equipName, equipSheet);
    if (!equipInfo) {
      var categoryItems = findEquipmentByCategory(equipName, equipSheet);
      if (categoryItems.length > 0) {
        conflicts.push({ equipment: equipName, message: equipName + " 모델 선택 필요" });
      } else {
        warnings.push({ equipment: equipName, message: equipName + " 미등록, 가용확인 제외" });
      }
      return;
    }

    var overlaps = schedData.filter(function(s) {
      return s.equipment === equipName &&
        s.status !== "반납완료" &&
        s.status !== "취소" &&
        s.startDT < endDT &&
        s.endDT > startDT;
    });
    var points = [startDT.getTime()];
    overlaps.forEach(function(s) {
      if (s.startDT >= startDT && s.startDT < endDT) points.push(s.startDT.getTime());
      if (s.endDT > startDT && s.endDT < endDT) points.push(s.endDT.getTime());
    });
    var seen = {};
    points = points.filter(function(p) {
      if (seen[p]) return false;
      seen[p] = true;
      return true;
    });

    var maxConcurrent = 0;
    points.forEach(function(tp) {
      var concurrent = 0;
      overlaps.forEach(function(s) {
        if (s.startDT.getTime() <= tp && s.endDT.getTime() > tp) concurrent += Number(s.qty) || 1;
      });
      if (concurrent > maxConcurrent) maxConcurrent = concurrent;
    });

    var available = (Number(equipInfo.total) || 0) - maxConcurrent;
    if (available < reqQty) {
      conflicts.push({
        equipment: equipName,
        total: Number(equipInfo.total) || 0,
        available: available,
        requested: reqQty,
        message: equipName + " 가용 " + available + "/" + reqQty
      });
    }
  });
  return { ok: conflicts.length === 0, conflicts: conflicts, warnings: warnings };
}

function normalizeDashboardAddEntries_(entries, fallbackName, fallbackQty) {
  if (typeof entries === "string") {
    try {
      entries = JSON.parse(entries);
    } catch (e) {
      entries = entries.split(/\n|,/).map(function(name) { return { name: name, qty: 1 }; });
    }
  }
  if (!Array.isArray(entries)) {
    if (entries && typeof entries === "object") {
      entries = entries.entries || entries.items || [entries];
    } else {
      entries = [];
    }
  }
  if (entries.length === 0 && fallbackName) {
    entries = [{ name: fallbackName, equipName: fallbackName, qty: fallbackQty || 1 }];
  }

  var merged = {};
  var order = [];
  entries.forEach(function(entry) {
    var name = String((entry && (entry.name || entry.equipName || entry.equipment)) || "").trim();
    if (!name) return;
    var qty = parseInt(entry.qty, 10);
    if (!qty || qty < 1) qty = 1;
    if (!merged[name]) {
      merged[name] = { name: name, qty: qty };
      order.push(name);
    } else {
      merged[name].qty += qty;
    }
  });
  return order.map(function(name) { return merged[name]; });
}

function getDashboardCachedJson_(key, seconds, builder) {
  var cache = null;
  try {
    cache = CacheService.getScriptCache();
    var cached = cache.get(key);
    if (cached) return JSON.parse(cached);
  } catch (e) {}

  var value = builder();
  try {
    if (cache) {
      var text = JSON.stringify(value);
      if (text.length < 90000) cache.put(key, text, seconds);
    }
  } catch (e2) {}
  return value;
}

function getDashboardEquipNameList_(ss) {
  return getDashboardCachedJson_("dashboardEquipNameList_v1", 300, function() {
    var listSheet = ss.getSheetByName("목록");
    if (!listSheet || listSheet.getLastRow() < 2) return [];
    return listSheet.getRange(2, 1, listSheet.getLastRow() - 1, 1).getDisplayValues()
      .map(function(row) { return String(row[0] || "").trim(); })
      .filter(function(name) { return !!name; });
  });
}

function buildDashboardSetLookup_(setSheet) {
  return getDashboardCachedJson_("dashboardSetLookup_v2", 300, function() {
    var lookup = { components: {}, prices: {}, items: {} };
    if (!setSheet || setSheet.getLastRow() < 2) return lookup;

    var lastCol = Math.max(setSheet.getLastColumn(), 7);
    var data = setSheet.getRange(2, 1, setSheet.getLastRow() - 1, lastCol).getValues();
    data.forEach(function(row) {
      var setName = String(row[0] || "").trim();
      if (!setName) return;
      lookup.items[setName] = true;
      if (row[6] !== "" && row[6] !== null && lookup.prices[setName] === undefined) {
        lookup.prices[setName] = row[6];
      }

      var componentName = String(row[1] || "").trim();
      var flag = row.length > 5 ? String(row[5] || "").trim() : "";
      if (!componentName || (flag !== "Y" && flag !== "")) return;
      if (!lookup.components[setName]) lookup.components[setName] = [];
      lookup.components[setName].push({
        name: componentName,
        qty: row[2] || 1,
        alt: row[4] || ""
      });
    });
    return lookup;
  });
}

function buildDashboardEquipmentMeta_(equipSheet) {
  return getDashboardCachedJson_("dashboardEquipmentMeta_v1", 120, function() {
    var meta = { equipment: {}, categories: {} };
    if (!equipSheet || equipSheet.getLastRow() < 2) return meta;

    var data = equipSheet.getRange(2, 1, equipSheet.getLastRow() - 1, 12).getValues();
    data.forEach(function(row) {
      var category = String(row[2] || "").trim();
      var name = String(row[3] || "").trim();
      if (category) meta.categories[category] = true;
      if (name) meta.equipment[name] = { total: Number(row[4]) || 0, 단가: row[11] || 0 };
    });
    return meta;
  });
}

function findDashboardRowsByValue_(sheet, column, lastRow, value) {
  value = String(value || "").trim();
  if (!sheet || lastRow < 2 || !value) return [];
  var matches = sheet.getRange(2, column, lastRow - 1, 1)
    .createTextFinder(value)
    .matchEntireCell(true)
    .findAll();
  var rows = matches.map(function(range) { return range.getRow(); });
  rows.sort(function(a, b) { return a - b; });
  return rows;
}

function readDashboardScheduleRows_(sheet, rowNums, colCount) {
  if (!rowNums || rowNums.length === 0) return [];
  colCount = colCount || 10;
  var rows = [];
  var start = rowNums[0];
  var prev = rowNums[0];

  function flushRange_(from, to) {
    var values = sheet.getRange(from, 1, to - from + 1, colCount).getValues();
    values.forEach(function(row) { rows.push(row); });
  }

  for (var i = 1; i < rowNums.length; i++) {
    if (rowNums[i] === prev + 1) {
      prev = rowNums[i];
      continue;
    }
    flushRange_(start, prev);
    start = rowNums[i];
    prev = rowNums[i];
  }
  flushRange_(start, prev);
  return rows;
}

function readDashboardScheduleRowsDisplay_(sheet, rowNums, colCount) {
  if (!rowNums || rowNums.length === 0) return [];
  colCount = colCount || 12;
  var rows = [];
  var start = rowNums[0];
  var prev = rowNums[0];

  function flushRange_(from, to) {
    var values = sheet.getRange(from, 1, to - from + 1, colCount).getDisplayValues();
    values.forEach(function(row) { rows.push(row); });
  }

  for (var i = 1; i < rowNums.length; i++) {
    if (rowNums[i] === prev + 1) {
      prev = rowNums[i];
      continue;
    }
    flushRange_(start, prev);
    start = rowNums[i];
    prev = rowNums[i];
  }
  flushRange_(start, prev);
  return rows;
}

function getDashboardAvailabilityScheduleData_(sheet, lastRow, equipmentNames) {
  if (!sheet || lastRow < 2 || !equipmentNames || equipmentNames.length === 0) return [];
  var target = {};
  (equipmentNames || []).forEach(function(name) {
    var key = String(name || "").trim();
    if (key) target[key] = true;
  });
  var names = Object.keys(target);
  if (names.length === 0) return [];

  var scheduleMap = getDashboardAvailabilityScheduleMap_(sheet, lastRow);
  var data = [];
  names.forEach(function(name) {
    (scheduleMap[name] || []).forEach(function(row) {
      data.push({
        equipment: name,
        qty: row[0] || 1,
        startDT: new Date(row[1]),
        endDT: new Date(row[2]),
        status: row[3] || ''
      });
    });
  });
  return data;
}

function getDashboardAvailabilityScheduleMap_(sheet, lastRow) {
  var cache = CacheService.getScriptCache();
  var cacheKey = "dashboard_availability_schedule_map_v1_" + getTimelineCacheVersion_() + "_" + lastRow;
  var cached = getDashboardCacheJson_(cache, cacheKey);
  if (cached) return cached;

  var map = {};
  var rows = sheet.getRange(2, 1, lastRow - 1, 10).getValues();
  rows.forEach(function(row) {
    var equipment = String(row[3] || "").trim();
    var status = String(row[9] || "").trim();
    if (!equipment || status === "반납완료" || status === "취소") return;
    var startDT = parseDT(row[5], row[6]);
    var endDT = parseDT(row[7], row[8]);
    if (!startDT || !endDT) return;
    if (!map[equipment]) map[equipment] = [];
    map[equipment].push([
      Number(row[4]) || 1,
      startDT.getTime(),
      endDT.getTime(),
      status
    ]);
  });
  putDashboardCacheJson_(cache, cacheKey, map, 300);
  return map;
}

function findDashboardScheduleRowsForEquipments_(sheet, lastRow, equipmentNames) {
  if (!sheet || lastRow < 2 || !equipmentNames || equipmentNames.length === 0) return [];
  var target = {};
  var targetNames = [];
  (equipmentNames || []).forEach(function(name) {
    var key = String(name || "").trim();
    if (key && !target[key]) {
      target[key] = true;
      targetNames.push(key);
    }
  });
  if (targetNames.length === 0) return [];

  targetNames.sort();
  var cache = CacheService.getScriptCache();
  var rowsCacheKey = getDashboardAvailabilityRowsCacheKey_(lastRow, targetNames);
  var rowsToRead = getDashboardCacheJson_(cache, rowsCacheKey);
  if (!rowsToRead) {
    rowsToRead = [];
    var rowIndex = getDashboardAvailabilityRowIndex_(sheet, lastRow);
    targetNames.forEach(function(key) {
      rowsToRead = rowsToRead.concat(rowIndex[key] || []);
    });
    putDashboardCacheJson_(cache, rowsCacheKey, rowsToRead, 300);
  }
  if (rowsToRead.length === 0) return [];
  rowsToRead.sort(function(a, b) { return a - b; });
  var seenRows = {};
  rowsToRead = rowsToRead.filter(function(rowNum) {
    if (seenRows[rowNum]) return false;
    seenRows[rowNum] = true;
    return true;
  });
  return readDashboardScheduleRows_(sheet, rowsToRead, 10).filter(function(row) {
    return !!target[String(row[3] || "").trim()];
  });
}

function getDashboardAvailabilityRowsCacheKey_(lastRow, targetNames) {
  var raw = getTimelineCacheVersion_() + "|" + lastRow + "|" + (targetNames || []).join("|");
  var digest = Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, raw))
    .replace(/=+$/g, "");
  return "dashboard_availability_rows_v1_" + digest;
}

function getDashboardAvailabilityRowIndex_(sheet, lastRow) {
  var cache = CacheService.getScriptCache();
  var cacheKey = "dashboard_availability_row_index_v1_" + getTimelineCacheVersion_() + "_" + lastRow;
  var cached = getDashboardCacheJson_(cache, cacheKey);
  if (cached) return cached;

  var index = {};
  var names = sheet.getRange(2, 4, lastRow - 1, 1).getValues();
  names.forEach(function(row, idx) {
    var name = String(row[0] || "").trim();
    if (!name) return;
    if (!index[name]) index[name] = [];
    index[name].push(idx + 2);
  });
  putDashboardCacheJson_(cache, cacheKey, index, 300);
  return index;
}

function buildDashboardScheduleData_(scheduleRows, equipmentNames) {
  var target = null;
  if (equipmentNames && equipmentNames.length) {
    target = {};
    equipmentNames.forEach(function(name) {
      target[String(name || "").trim()] = true;
    });
  }

  return (scheduleRows || []).map(function(row) {
    var equipment = String(row[3] || "").trim();
    var status = String(row[9] || "").trim();
    if (!equipment) return null;
    if (target && !target[equipment]) return null;
    if (status === "반납완료" || status === "취소") return null;
    return {
      equipment: equipment,
      qty: row[4] || 1,
      startDT: parseDT(row[5], row[6]),
      endDT: parseDT(row[7], row[8]),
      status: status
    };
  }).filter(function(row) {
    return row && row.startDT && row.endDT;
  });
}

function mergeAvailabilityItems_(items) {
  var merged = {};
  var order = [];
  (items || []).forEach(function(item) {
    var name = String(item.name || "").trim();
    if (!name) return;
    var qty = Number(item.qty) || 1;
    if (!merged[name]) {
      merged[name] = { name: name, qty: qty };
      order.push(name);
    } else {
      merged[name].qty += qty;
    }
  });
  return order.map(function(name) { return merged[name]; });
}

function checkAvailabilityForAddCached_(itemsToAdd, startDT, endDT, equipMeta, scheduleData) {
  var conflicts = [];
  var warnings = [];
  var equipMap = (equipMeta && equipMeta.equipment) || {};
  var categoryMap = (equipMeta && equipMeta.categories) || {};
  (itemsToAdd || []).forEach(function(item) {
    var equipName = String(item.name || "").trim();
    var reqQty = Number(item.qty) || 1;
    var equipInfo = equipMap[equipName];
    if (!equipInfo) {
      if (categoryMap[equipName]) {
        conflicts.push({ equipment: equipName, message: equipName + " 모델 선택 필요" });
      } else {
        warnings.push({ equipment: equipName, message: equipName + " 미등록, 가용확인 제외" });
      }
      return;
    }

    var overlaps = scheduleData.filter(function(s) {
      return s.equipment === equipName &&
        s.status !== "반납완료" &&
        s.status !== "취소" &&
        s.startDT < endDT &&
        s.endDT > startDT;
    });
    var points = [startDT.getTime()];
    overlaps.forEach(function(s) {
      if (s.startDT >= startDT && s.startDT < endDT) points.push(s.startDT.getTime());
      if (s.endDT > startDT && s.endDT < endDT) points.push(s.endDT.getTime());
    });

    var seen = {};
    points = points.filter(function(point) {
      if (seen[point]) return false;
      seen[point] = true;
      return true;
    });

    var maxConcurrent = 0;
    points.forEach(function(point) {
      var concurrent = 0;
      overlaps.forEach(function(s) {
        if (s.startDT.getTime() <= point && s.endDT.getTime() > point) {
          concurrent += Number(s.qty) || 1;
        }
      });
      if (concurrent > maxConcurrent) maxConcurrent = concurrent;
    });

    var available = (Number(equipInfo.total) || 0) - maxConcurrent;
    if (available < reqQty) {
      conflicts.push({
        equipment: equipName,
        total: Number(equipInfo.total) || 0,
        available: available,
        requested: reqQty,
        message: equipName + " 가용 " + available + "/" + reqQty
      });
    }
  });
  return { ok: conflicts.length === 0, conflicts: conflicts, warnings: warnings };
}

function applyDashboardAddRowFormats_(sched, tid, insertRow, rowCount, sourceRow, hadFollowingRow) {
  sched.getRange(insertRow, 6, rowCount, 1).setNumberFormat("yyyy-MM-dd");
  sched.getRange(insertRow, 7, rowCount, 1).setNumberFormat("@");
  sched.getRange(insertRow, 8, rowCount, 1).setNumberFormat("yyyy-MM-dd");
  sched.getRange(insertRow, 9, rowCount, 1).setNumberFormat("@");

  var lastCol = sched.getLastColumn() || 13;
  if (sourceRow) {
    try {
      var sourceBgs = sched.getRange(sourceRow, 1, 1, lastCol).getBackgrounds()[0];
      var bgs = [];
      for (var i = 0; i < rowCount; i++) bgs.push(sourceBgs.slice());
      sched.getRange(insertRow, 1, rowCount, lastCol).setBackgrounds(bgs);
    } catch (e) {}
  } else if (typeof _inheritGroupBackground !== "undefined") {
    try {
      var inheritRows = [];
      for (var ri = 0; ri < rowCount; ri++) inheritRows.push(insertRow + ri);
      _inheritGroupBackground(sched, tid, inheritRows);
    } catch (e2) {}
  }

  if (hadFollowingRow) {
    try {
      sched.getRange(insertRow, 1, rowCount, lastCol)
        .setBorder(null, null, false, null, null, false);
      sched.getRange(insertRow - 1, 1, 1, lastCol)
        .setBorder(null, null, false, null, null, null);
      sched.getRange(insertRow + rowCount - 1, 1, 1, lastCol)
        .setBorder(null, null, true, null, null, null, "#999999", SpreadsheetApp.BorderStyle.SOLID);
    } catch (e3) {}
  }
}

function dashboardAddedItemsFromRows_(rows) {
  rows = rows || [];
  var setNamesWithComponents = {};
  rows.forEach(function(row) {
    var setName = String((row && row[2]) || "").trim();
    var name = String((row && row[3]) || "").trim();
    if (setName && name && setName !== name) setNamesWithComponents[setName] = true;
  });

  return rows.map(function(row) {
    var setName = String((row && row[2]) || "").trim();
    var name = String((row && row[3]) || "").trim();
    var isHeader = !setName || setName === name;
    var qty = Number((row && row[4]) || 1) || 1;
    return {
      scheduleId: String((row && row[0]) || "").trim(),
      name: name,
      qty: qty,
      quantity: qty,
      setName: setName,
      isHeader: isHeader,
      isSet: isHeader && !!setNamesWithComponents[name || setName],
      isComponent: !!setName && !isHeader,
      checkedCheckout: false,
      checkedCheckin: false
    };
  });
}

function deleteDashboardRowsDescending_(sheet, rows) {
  if (!sheet || !rows || rows.length === 0) return;
  rows = rows.slice().sort(function(a, b) { return b - a; });
  var top = rows[0];
  var bottom = rows[0];

  function flush_() {
    sheet.deleteRows(bottom, top - bottom + 1);
  }

  for (var i = 1; i < rows.length; i++) {
    var row = rows[i];
    if (row === bottom - 1) {
      bottom = row;
      continue;
    }
    flush_();
    top = row;
    bottom = row;
  }
  flush_();
}

function dashboardAddEquipments(tid, entries, options) {
  tid = String(tid || "").trim();
  var addEntries = normalizeDashboardAddEntries_(entries);
  if (!tid || addEntries.length === 0) return { error: "tid와 장비명 필수" };

  options = options || {};
  var dryRun = options.dryRun === true || options.dryRun === 1 || options.dryRun === "1" || options.dryRun === "true";
  var profile = options.profile === true || options.profile === 1 || options.profile === "1" || options.profile === "true";
  var profileStart = Date.now();
  var profileMarks = [];
  function markProfile_(step) {
    if (profile) profileMarks.push({ step: step, ms: Date.now() - profileStart });
  }
  function attachProfile_(result) {
    if (profile) {
      markProfile_('return');
      result.profile = profileMarks;
    }
    return result;
  }

  var lock = null;
  if (!dryRun) {
    lock = LockService.getScriptLock();
    try { lock.waitLock(10000); } catch (e) { return { error: "다른 변경 작업 처리 중입니다. 잠시 후 다시 시도하세요." }; }
  }

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sched = ss.getSheetByName("스케줄상세");
    var equipSheet = ss.getSheetByName("장비마스터");
    if (!sched || sched.getLastRow() < 2) return { error: "스케줄상세 비어있음" };
    if (!equipSheet) return { error: "장비마스터 없음" };
    markProfile_('sheets');

    var nameList = getDashboardEquipNameList_(ss);
    markProfile_('equipment_name_list');
    var resolvedMap = {};
    var resolvedOrder = [];
    addEntries.forEach(function(entry) {
      var resolved = nameList.length ? fuzzyMatchEquipName(entry.name, nameList) : entry.name;
      resolved = String(resolved || "").trim();
      if (!resolved) return;
      if (!resolvedMap[resolved]) {
        resolvedMap[resolved] = { name: resolved, qty: entry.qty, inputNames: [entry.name] };
        resolvedOrder.push(resolved);
      } else {
        resolvedMap[resolved].qty += entry.qty;
        resolvedMap[resolved].inputNames.push(entry.name);
      }
    });
    addEntries = resolvedOrder.map(function(name) { return resolvedMap[name]; });
    if (addEntries.length === 0) return { error: "추가할 장비명이 없습니다" };
    markProfile_('resolve_names');

    var lastRow = sched.getLastRow();
    var tidRows = findDashboardRowsByValue_(sched, 2, lastRow, tid);
    if (tidRows.length === 0) return { error: "거래ID '" + tid + "' 못 찾음" };
    markProfile_('find_trade_rows');
    var sourceRow = tidRows[0];
    var lastTidRow = tidRows[tidRows.length - 1];
    var maxN = 0;
    var idRe = new RegExp("^" + tid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "-(\\d+)$");
    var tidIdRows = readDashboardScheduleRows_(sched, tidRows, 1);
    for (var i = 0; i < tidIdRows.length; i++) {
      var match = String(tidIdRows[i][0]).match(idRe);
      if (match) {
        var n = parseInt(match[1], 10);
        if (n > maxN) maxN = n;
      }
    }
    markProfile_('read_trade_ids');

    var sourceDisplay = sched.getRange(sourceRow, 6, 1, 8).getDisplayValues()[0];
    var 반출일 = sourceDisplay[0];
    var 반출시간 = sourceDisplay[1];
    var 반납일 = sourceDisplay[2];
    var 반납시간 = sourceDisplay[3];
    var 예약자명 = sourceDisplay[7];
    var startDT = parseDT(반출일, 반출시간);
    var endDT = parseDT(반납일, 반납시간);
    if (!startDT || !endDT) return { error: "거래ID의 반출/반납 일시를 읽지 못했습니다" };
    markProfile_('read_trade_dates');

    var setLookup = buildDashboardSetLookup_(ss.getSheetByName("세트마스터"));
    markProfile_('set_lookup');
    var rowSpecs = [];
    var availabilityItems = [];
    addEntries.forEach(function(entry) {
      var components = (setLookup.components[entry.name] || []).filter(function(c) {
        var name = String(c.name || "").trim();
        return name !== "" && name !== entry.name;
      });
      rowSpecs.push({
        name: entry.name,
        qty: entry.qty,
        components: components,
        price: setLookup.prices[entry.name] || 0,
        isSetMasterItem: !!(setLookup.items && setLookup.items[entry.name])
      });
      availabilityItems = availabilityItems.concat(buildAvailabilityItems_(entry.name, entry.qty, components));
    });

    var equipMeta = buildDashboardEquipmentMeta_(equipSheet);
    markProfile_('equipment_meta');
    var mergedAvailabilityItems = mergeAvailabilityItems_(availabilityItems);
    var targetEquipmentNames = mergedAvailabilityItems.map(function(item) { return item.name; });
    var scheduleData = getDashboardAvailabilityScheduleData_(sched, lastRow, targetEquipmentNames);
    markProfile_('availability_schedule_rows');
    markProfile_('availability_schedule_data');
    var availability = checkAvailabilityForAddCached_(
      mergedAvailabilityItems,
      startDT,
      endDT,
      equipMeta,
      scheduleData
    );
    markProfile_('availability_check');
    if (!availability.ok) {
      return attachProfile_({
        error: "가용 불가: " + availability.conflicts.map(function(c) { return c.message; }).join(", "),
        conflicts: availability.conflicts
      });
    }

    var newRows = [];
    rowSpecs.forEach(function(spec) {
      if (spec.components.length > 0) {
        maxN++;
        newRows.push([
          tid + "-" + ("0" + maxN).slice(-2),
          tid, spec.name, spec.name, spec.qty, 반출일, 반출시간, 반납일, 반납시간,
          "대기", "", spec.price, 예약자명
        ]);
        spec.components.forEach(function(component) {
          maxN++;
          newRows.push([
            tid + "-" + ("0" + maxN).slice(-2),
            tid, spec.name, component.name, (component.qty || 1) * spec.qty, 반출일, 반출시간, 반납일, 반납시간,
            "대기", "", 0, 예약자명
          ]);
        });
      } else {
        maxN++;
        var setMasterName = spec.isSetMasterItem ? spec.name : "";
        newRows.push([
          tid + "-" + ("0" + maxN).slice(-2),
          tid, setMasterName, spec.name, spec.qty, 반출일, 반출시간, 반납일, 반납시간,
          "대기", "", spec.price, 예약자명
        ]);
      }
    });
    markProfile_('build_new_rows');

    if (dryRun) {
      return attachProfile_({
        success: true,
        dryRun: true,
        availabilityChecked: true,
        addedEquipments: addEntries.length,
        addedRows: newRows.length,
        addedItems: addEntries.map(function(entry) { return { name: entry.name, qty: entry.qty, quantity: entry.qty }; }),
        requestedItems: addEntries.map(function(entry) { return { name: entry.name, qty: entry.qty, quantity: entry.qty }; }),
        equipmentNames: addEntries.map(function(entry) { return entry.name; }),
        customerName: 예약자명,
        warnings: availability.warnings || [],
        message: "가용 확인 완료"
      });
    }

    var insertRow = lastTidRow + 1;
    var hadFollowingRow = insertRow <= lastRow;
    if (insertRow <= lastRow) {
      sched.insertRowsAfter(insertRow - 1, newRows.length);
    }
    sched.getRange(insertRow, 1, newRows.length, 13).setValues(newRows);
    markProfile_('write_new_rows');
    applyDashboardAddRowFormats_(sched, tid, insertRow, newRows.length, lastTidRow, hadFollowingRow);
    markProfile_('format_new_rows');
    scheduleContractRegen(tid);
    try { invalidateDashboardCache(); } catch (eCache) {}
    try { invalidateTimelineCache(); } catch (eTimeline) {}
    markProfile_('schedule_contract_regen');

    return attachProfile_({
      success: true,
      availabilityChecked: true,
      addedEquipments: addEntries.length,
      addedRows: newRows.length,
      addedItems: dashboardAddedItemsFromRows_(newRows),
      requestedItems: addEntries.map(function(entry) { return { name: entry.name, qty: entry.qty, quantity: entry.qty }; }),
      equipmentNames: addEntries.map(function(entry) { return entry.name; }),
      customerName: 예약자명,
      warnings: availability.warnings || [],
      message: "가용 확인 완료 후 추가"
    });
  } finally {
    if (lock) {
      try { lock.releaseLock(); } catch (e) {}
    }
  }
}

function dashboardRecordOnsiteAddon(tid, entries, options) {
  options = options || {};
  var addResult = dashboardAddEquipments(tid, entries, { dryRun: options.dryRun });
  if (!addResult || addResult.error) return addResult;
  if (addResult.dryRun) return addResult;

  var payload = {
    transactionId: String(tid || '').trim(),
    customerName: addResult.customerName || '',
    items: addResult.requestedItems || addResult.addedItems || [],
    settlementStatus: options.settlementStatus || 'pending',
    source: 'schedule_button',
    actorName: options.actorName || '오늘 일정 웹앱'
  };
  var logResult = recordOnsiteAddonBackend_(payload);
  addResult.onsiteAddonLogged = !!(logResult && (logResult.ok || logResult.success));
  addResult.onsiteAddonEvent = logResult && (logResult.event || logResult.data || null);
  if (!addResult.onsiteAddonLogged) {
    addResult.onsiteAddonWarning = (logResult && (logResult.error || logResult.reason)) || 'onsite_addon_log_failed';
  }
  addResult.message = addResult.onsiteAddonLogged
    ? '현장 추가 반출 기록 완료'
    : '장비는 추가됐지만 현장 추가 반출 기록 저장은 확인 필요';
  return addResult;
}

function dashboardUpdateEquipmentQty(tid, scheduleId, qty, options) {
  tid = String(tid || "").trim();
  scheduleId = String(scheduleId || "").trim();
  var newQty = parseInt(qty, 10);
  if (!tid || !scheduleId) return { error: "tid와 scheduleId 필수" };
  if (!newQty || newQty < 1) return { error: "수량은 1 이상이어야 합니다" };

  options = options || {};
  var dryRun = options.dryRun === true || options.dryRun === 1 || options.dryRun === "1" || options.dryRun === "true";

  var lock = null;
  if (!dryRun) {
    lock = LockService.getScriptLock();
    try { lock.waitLock(10000); } catch (e) { return { error: "다른 변경 작업 처리 중입니다. 잠시 후 다시 시도하세요." }; }
  }

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sched = ss.getSheetByName("스케줄상세");
    var equipSheet = ss.getSheetByName("장비마스터");
    var setSheet = ss.getSheetByName("세트마스터");
    if (!sched || sched.getLastRow() < 2) return { error: "스케줄상세 비어있음" };
    if (!equipSheet) return { error: "장비마스터 없음" };

    var lastRow = sched.getLastRow();
    var targetRows = findDashboardRowsByValue_(sched, 1, lastRow, scheduleId);
    if (targetRows.length === 0) return { error: "스케줄ID '" + scheduleId + "' 못 찾음" };

    var targetRow = targetRows[0];
    var row = sched.getRange(targetRow, 1, 1, 13).getValues()[0];
    if (String(row[1] || "").trim() !== tid) return { error: "거래ID와 스케줄ID가 일치하지 않습니다" };

    var display = sched.getRange(targetRow, 1, 1, 13).getDisplayValues()[0];
    var setName = String(row[2] || "").trim();
    var equipName = String(row[3] || "").trim();
    var oldQty = Number(row[4]) || 1;
    if (!equipName) return { error: "장비명이 비어있습니다" };
    if (oldQty === newQty) return { success: true, unchanged: true, qty: newQty, message: "변경 없음" };

    var startDT = parseDT(display[5], display[6]);
    var endDT = parseDT(display[7], display[8]);
    if (!startDT || !endDT) return { error: "반출/반납 일시를 읽지 못했습니다" };

    var setLookup = buildDashboardSetLookup_(setSheet);
    var components = (setLookup.components[equipName] || []).filter(function(c) {
      var name = String(c.name || "").trim();
      return name !== "" && name !== equipName;
    });
    var isSetHeader = !!setName && setName === equipName && components.length > 0;
    var updates = [{
      row: targetRow,
      scheduleId: String(row[0] || "").trim(),
      equipment: equipName,
      oldQty: oldQty,
      newQty: newQty
    }];
    var availabilityItems = [];

    if (isSetHeader) {
      var componentBaseQty = {};
      components.forEach(function(component) {
        componentBaseQty[String(component.name || "").trim()] = Number(component.qty) || 1;
      });

      var tidRows = findDashboardRowsByValue_(sched, 2, lastRow, tid);
      tidRows.forEach(function(rowNum) {
        if (rowNum === targetRow) return;
        var r = sched.getRange(rowNum, 1, 1, 5).getValues()[0];
        var rowSetName = String(r[2] || "").trim();
        var rowEquipName = String(r[3] || "").trim();
        if (rowSetName !== equipName || rowEquipName === equipName || !rowEquipName) return;

        var currentQty = Number(r[4]) || 1;
        var baseQty = componentBaseQty[rowEquipName];
        var targetQty = baseQty ? baseQty * newQty : Math.max(1, Math.round(currentQty * newQty / oldQty));
        updates.push({
          row: rowNum,
          scheduleId: String(r[0] || "").trim(),
          equipment: rowEquipName,
          oldQty: currentQty,
          newQty: targetQty
        });
        if (targetQty > currentQty) {
          availabilityItems.push({ name: rowEquipName, qty: targetQty - currentQty });
        }
      });
    } else if (newQty > oldQty) {
      availabilityItems.push({ name: equipName, qty: newQty - oldQty });
    }

    var availability = { ok: true, conflicts: [], warnings: [] };
    var mergedAvailabilityItems = mergeAvailabilityItems_(availabilityItems);
    if (mergedAvailabilityItems.length > 0) {
      var targetEquipmentNames = mergedAvailabilityItems.map(function(item) { return item.name; });
      availability = checkAvailabilityForAddCached_(
        mergedAvailabilityItems,
        startDT,
        endDT,
        buildDashboardEquipmentMeta_(equipSheet),
        getDashboardAvailabilityScheduleData_(sched, lastRow, targetEquipmentNames)
      );
      if (!availability.ok) {
        return {
          error: "가용 불가: " + availability.conflicts.map(function(c) { return c.message; }).join(", "),
          conflicts: availability.conflicts
        };
      }
    }

    if (!dryRun) {
      updates.forEach(function(update) {
        sched.getRange(update.row, 5).setValue(update.newQty).setNumberFormat("#,##0");
      });
      scheduleContractRegen(tid);
      try { invalidateDashboardCache(); } catch (eCache) {}
      try { invalidateTimelineCache(); } catch (eTimeline) {}
    }

    return {
      success: true,
      dryRun: dryRun,
      scheduleId: scheduleId,
      qty: newQty,
      updatedRows: updates.length,
      updatedItems: updates.map(function(update) {
        return {
          equipment: update.equipment,
          scheduleId: update.scheduleId,
          oldQty: update.oldQty,
          newQty: update.newQty
        };
      }),
      warnings: availability.warnings || [],
      message: dryRun ? "수량 수정 가능" : "수량 수정 완료"
    };
  } finally {
    if (lock) {
      try { lock.releaseLock(); } catch (e) {}
    }
  }
}

/**
 * Dashboard에서 장비 추가 — 같은 거래ID의 기존 행에서 일자/시간/예약자명 가져와 새 행 생성.
 * 세트인 경우 구성품도 자동 펼침. scheduleContractRegen으로 계약서 재생성 예약.
 */
function dashboardAddEquipment(tid, equipName, qty) {
  if (!tid || !equipName) return { error: "tid와 장비명 필수" };
  qty = parseInt(qty, 10) || 1;
  tid = String(tid).trim();
  equipName = String(equipName).trim();

  var lock = LockService.getScriptLock();
  try { lock.waitLock(10000); } catch (e) { return { error: "다른 변경 작업 처리 중입니다. 잠시 후 다시 시도하세요." }; }

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sched = ss.getSheetByName("스케줄상세");
    var equipSheet = ss.getSheetByName("장비마스터");
    if (!sched || sched.getLastRow() < 2) return { error: "스케줄상세 비어있음" };

    var setSheet = ss.getSheetByName("세트마스터");
    equipName = resolveEquipmentName_(equipName, ss);

    var lastRow = sched.getLastRow();
    var data = sched.getRange(2, 1, lastRow - 1, 13).getValues();
    var displayData = sched.getRange(2, 1, lastRow - 1, 13).getDisplayValues();
    var srcIdx = -1;
    for (var i = 0; i < data.length; i++) {
      if (String(data[i][1]).trim() === tid) { srcIdx = i; break; }
    }
    if (srcIdx === -1) return { error: "거래ID '" + tid + "' 못 찾음" };

    var 반출일   = displayData[srcIdx][5];
    var 반출시간 = displayData[srcIdx][6];
    var 반납일   = displayData[srcIdx][7];
    var 반납시간 = displayData[srcIdx][8];
    var 예약자명 = displayData[srcIdx][12];
    var startDT = parseDT(반출일, 반출시간);
    var endDT = parseDT(반납일, 반납시간);
    if (!startDT || !endDT) return { error: "거래ID의 반출/반납 일시를 읽지 못했습니다" };

    var components = getSetComponents(equipName, setSheet).filter(function(c) {
      var n = String(c.name || "").trim();
      return n !== "" && n !== equipName;
    });
    var checkItems = buildAvailabilityItems_(equipName, qty, components);
    var availability = checkAvailabilityForAdd_(checkItems, startDT, endDT, equipSheet, sched);
    if (!availability.ok) {
      return {
        error: "가용 불가: " + availability.conflicts.map(function(c) { return c.message; }).join(", "),
        conflicts: availability.conflicts
      };
    }

    var price = findSetPrice(equipName, setSheet);
    var maxN = 0;
    var re = new RegExp("^" + tid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "-(\\d+)$");
    for (var k = 0; k < data.length; k++) {
      var m = String(data[k][0]).match(re);
      if (m) { var n = parseInt(m[1], 10); if (n > maxN) maxN = n; }
    }

    var newRows = [];
    if (components.length > 0) {
      maxN++;
      newRows.push([
        tid + "-" + ("0" + maxN).slice(-2),
        tid, equipName, equipName, qty, 반출일, 반출시간, 반납일, 반납시간,
        "대기", "", price, 예약자명
      ]);
      components.forEach(function(c) {
        maxN++;
        newRows.push([
          tid + "-" + ("0" + maxN).slice(-2),
          tid, equipName, c.name, (c.qty || 1) * qty, 반출일, 반출시간, 반납일, 반납시간,
          "대기", "", 0, 예약자명
        ]);
      });
    } else {
      maxN++;
      newRows.push([
        tid + "-" + ("0" + maxN).slice(-2),
        tid, equipName, equipName, qty, 반출일, 반출시간, 반납일, 반납시간,
        "대기", "", 0, 예약자명
      ]);
      newRows[0][11] = price;
    }

    // 같은 거래ID의 마지막 행 찾기 → 바로 아래에 삽입
    var lastTidRow = -1;
    for (var j = 0; j < data.length; j++) {
      if (String(data[j][1]).trim() === tid) lastTidRow = j;
    }
    var insertRow = (lastTidRow >= 0) ? (lastTidRow + 2 + 1) : (lastRow + 1);
    // lastTidRow는 0-based data index, +2 = 시트행(헤더1행+1), +1 = 그 다음 행

    // 행 삽입 (시트 중간에 끼워넣기)
    if (insertRow <= lastRow) {
      sched.insertRowsAfter(insertRow - 1, newRows.length);
    }
    sched.getRange(insertRow, 1, newRows.length, 13).setValues(newRows);
    sched.getRange(insertRow, 6, newRows.length, 1).setNumberFormat("yyyy-MM-dd");
    sched.getRange(insertRow, 7, newRows.length, 1).setNumberFormat("@");
    sched.getRange(insertRow, 8, newRows.length, 1).setNumberFormat("yyyy-MM-dd");
    sched.getRange(insertRow, 9, newRows.length, 1).setNumberFormat("@");

    var inheritRows = [];
    for (var ri = 0; ri < newRows.length; ri++) inheritRows.push(insertRow + ri);
    if (typeof _inheritGroupBackground !== "undefined") {
      try { _inheritGroupBackground(sched, tid, inheritRows); } catch (e) {}
    }

    try { formatScheduleSheet(sched); } catch (e) {}
    scheduleContractRegen(tid);
    return {
	      success: true,
	      availabilityChecked: true,
	      addedRows: newRows.length,
	      addedItems: dashboardAddedItemsFromRows_(newRows),
	      isSet: components.length > 0,
	      equipName: equipName,
	      message: "가용 확인 완료 후 추가"
    };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}

/**
 * Dashboard에서 장비 삭제.
 * - scheduleId가 있으면 클릭한 행 기준으로 삭제한다.
 * - 세트 대표행이면 같은 세트 구성품을 함께 삭제한다.
 * - 세트 구성품이면 해당 구성품 행만 삭제한다.
 * - scheduleId가 없으면 기존 호환 경로로 장비명/세트명 일치 행을 삭제한다.
 */
function dashboardRemoveEquipment(tid, equipName, scheduleId) {
  if (!tid || (!equipName && !scheduleId)) return { error: "tid와 장비명 또는 스케줄ID 필수" };
  tid = String(tid).trim();
  equipName = String(equipName || "").trim();
  scheduleId = String(scheduleId || "").trim();

  var lock = LockService.getScriptLock();
  try { lock.waitLock(10000); } catch (e) { return { error: "다른 변경 작업 처리 중입니다. 잠시 후 다시 시도하세요." }; }

  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sched = ss.getSheetByName("스케줄상세");
    if (!sched || sched.getLastRow() < 2) return { error: "스케줄상세 비어있음" };

    var lastRow = sched.getLastRow();
    var data = sched.getRange(2, 1, lastRow - 1, 4).getValues();
    var rowsToDelete = [];

    if (scheduleId) {
      var targetIdx = -1;
      for (var t = 0; t < data.length; t++) {
        if (String(data[t][0] || "").trim() === scheduleId && String(data[t][1] || "").trim() === tid) {
          targetIdx = t;
          break;
        }
      }
      if (targetIdx < 0) return { error: "해당 스케줄 행 없음" };

      var targetRow = targetIdx + 2;
      var targetSetName = String(data[targetIdx][2] || "").trim();
      var targetEquipName = String(data[targetIdx][3] || "").trim();
      var isComponent = !!targetSetName && targetSetName !== targetEquipName;

      if (isComponent) {
        rowsToDelete.push(targetRow);
      } else {
        var setKey = targetSetName || targetEquipName;
        var hasComponents = false;
        for (var cidx = 0; cidx < data.length; cidx++) {
          if (String(data[cidx][1] || "").trim() !== tid) continue;
          var cSet = String(data[cidx][2] || "").trim();
          var cEquip = String(data[cidx][3] || "").trim();
          if (cSet === setKey && cEquip && cEquip !== setKey) {
            hasComponents = true;
            break;
          }
        }

        for (var i = data.length - 1; i >= 0; i--) {
          if (String(data[i][1] || "").trim() !== tid) continue;
          var rowNum = i + 2;
          var rowSetName = String(data[i][2] || "").trim();
          if (rowNum === targetRow || (hasComponents && rowSetName === setKey)) {
            rowsToDelete.push(rowNum);
          }
        }
      }
    } else {
      for (var i = data.length - 1; i >= 0; i--) {
        if (String(data[i][1]).trim() !== tid) continue;
        var c = String(data[i][2] || "").trim();
        var d = String(data[i][3] || "").trim();
        if (c === equipName || d === equipName) {
          rowsToDelete.push(i + 2);
        }
      }
    }
    if (rowsToDelete.length === 0) return { error: "해당 장비 행 없음" };

    var seenRows = {};
    rowsToDelete = rowsToDelete.filter(function(r) {
      if (seenRows[r]) return false;
      seenRows[r] = true;
      return true;
    }).sort(function(a, b) { return b - a; });

    var removedScheduleIds = rowsToDelete.map(function(r) {
      return String((data[r - 2] && data[r - 2][0]) || "").trim();
    }).filter(Boolean);
    var removedEquipments = rowsToDelete.map(function(r) {
      var source = data[r - 2] || [];
      return {
        scheduleId: String(source[0] || "").trim(),
        setName: String(source[2] || "").trim(),
        name: String(source[3] || "").trim()
      };
    });

    deleteDashboardRowsDescending_(sched, rowsToDelete);
    scheduleContractRegen(tid);
    try { invalidateDashboardCache(); } catch (eCache) {}
    try { invalidateTimelineCache(); } catch (eTimeline) {}
    return {
      success: true,
      removedRows: rowsToDelete.length,
      removedScheduleIds: removedScheduleIds,
      removedEquipments: removedEquipments,
      equipName: equipName,
      scheduleId: scheduleId
    };
  } finally {
    try { lock.releaseLock(); } catch (e) {}
  }
}


/** "yyyy-MM-dd" + "HH:mm" → Date */
function parseDT(dateVal, timeVal) {
  try {
    let dateStr;
    if (dateVal instanceof Date) {
      dateStr = Utilities.formatDate(dateVal, 'Asia/Seoul', 'yyyy-MM-dd');
    } else {
      dateStr = String(dateVal).trim();
    }
    if (!dateStr || dateStr === '') return null;

    let timeStr = '09:00';
    if (timeVal instanceof Date) {
      timeStr = Utilities.formatDate(timeVal, 'Asia/Seoul', 'HH:mm');
    } else if (timeVal && String(timeVal).trim() !== '') {
      timeStr = String(timeVal).trim();
    }

    // 한 자리 시간(예: "7:00")을 두 자리로 패딩 (ISO 형식 필수)
    var timeParts = timeStr.split(':');
    if (timeParts.length >= 2) {
      timeStr = ('0' + timeParts[0]).slice(-2) + ':' + ('0' + timeParts[1]).slice(-2);
    }

    var dt = new Date(dateStr + 'T' + timeStr + ':00+09:00');
    if (isNaN(dt.getTime())) return null;
    return dt;
  } catch (e) { return null; }
}

/** 표시용 날짜+시간 문자열 */
function fmtDT(dateVal, timeVal) {
  try {
    let d, t;
    if (dateVal instanceof Date) {
      d = Utilities.formatDate(dateVal, 'Asia/Seoul', 'yyyy-MM-dd');
    } else { d = String(dateVal || '').trim(); }
    if (timeVal instanceof Date) {
      t = Utilities.formatDate(timeVal, 'Asia/Seoul', 'HH:mm');
    } else { t = String(timeVal || '').trim(); }
    return d + (t ? ' ' + t : '');
  } catch (e) { return String(dateVal || ''); }
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// onEdit 핸들러 (Code.gs에서 호출)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Code.gs의 onEdit()에서 호출하는 함수
 * 확인요청 시트:
 *   B열(2): 반출일 입력 → 요청ID 자동생성/상속
 *   H열(8): "확인" 드롭다운 → 가용 확인
 *   N열(14): "등록" 드롭다운 → 예약 등록
 *
 * ※ F열(장비/세트명)은 "목록" 시트 참조 드롭다운 → 구글시트 자체 검색 사용
 */
function handleScheduleEdit(e) {
  const sheet = e.source.getActiveSheet();
  if (sheet.getName() !== "확인요청") return;

  const col = e.range.getColumn();
  const row = e.range.getRow();
  if (row < 2) return;

  const val = e.range.getValue();

  // B열(2): 반출일 입력 시 → 요청ID 자동생성
  if (col === 2 && val) {
    autoGenerateReqID(sheet, row);
  }

  // H열(8): 확인 / 발송 드롭다운
  if (col === 8) {
    if (val === "확인") {
      const aVal = sheet.getRange(row, 1).getValue().toString().trim();
      if (isTradeID(aVal)) {
        checkModificationItem(sheet, row);  // 수정 행: 계약마스터에서 날짜 조회
      } else {
        // 기존 처리된 reqID에서는 H열 확인을 비워둔 행만 다시 가용확인 대상으로 만든다.
        // 이미 처리된 다른 행의 I/J 결과는 보존해서 장비 추가/수정 작업에 맞춘다.
        if (aVal) {
          preparePendingConfirmRows_(sheet, row, aVal);
        }
        processByReqID(sheet, row);  // 같은 reqID 묶음 안에서 결과가 빈 행만 처리
      }
    } else if (val === "발송승인") {
      sendAvailAlimtalk(sheet, row);  // 결재 후 가용확인 알림톡 발송
    }
  }

  // N열(14): 등록/추가/삭제/날짜변경/거절/보류 드롭다운
  if (col === 14) {
    if (val === "등록") {
      // API에서 이미 등록 처리한 경우 onEdit 이중 호출 방지
      var oVal = sheet.getRange(row, 15).getValue();
      if (String(oVal).indexOf("등록완료") >= 0) return;
      registerByReqID(sheet, row);
    } else if (val === "추가") {
      addEquipmentToContract(sheet, row);
    } else if (val === "삭제") {
      removeEquipmentFromContract(sheet, row);
    } else if (val === "날짜변경") {
      changeDatesForContract(sheet, row);
    } else if (val === "거절") {
      sheet.getRange(row, 15).setValue('거절');
      sheet.getRange(row, 15).setBackground('#FFC7CE');
    } else if (val === "보류") {
      sheet.getRange(row, 15).setValue('보류');
      sheet.getRange(row, 15).setBackground('#FFEB9C');
    }
  }
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// "목록" 시트 자동 생성 + F열 드롭다운 설정
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * "목록" 시트를 생성/갱신하여 세트마스터 세트명을
 * 중복 제거 후 정렬하여 A열에 나열합니다.
 * 그리고 확인요청 F열의 데이터 유효성을 목록!A:A 참조로 설정합니다.
 *
 * ★ 장비를 추가/삭제했을 때 메뉴에서 "목록 갱신"을 실행하세요.
 * ★ 또는 onOpen()에서 자동 실행되도록 설정되어 있습니다.
 */
function refreshEquipmentList() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  const setSheet = ss.getSheetByName("세트마스터");

  // ── 목록 생성: 세트마스터 A열 (중복 제거 + 정렬) ──
  const names = new Set();
  if (setSheet && setSheet.getLastRow() >= 2) {
    setSheet.getRange(2, 1, setSheet.getLastRow() - 1, 1)
      .getValues().flat().forEach(n => { if (n) names.add(n.toString().trim()); });
  }

  const sorted = Array.from(names).sort();

  // ── "목록" 시트 생성 또는 초기화 ──
  let listSheet = ss.getSheetByName("목록");
  if (!listSheet) {
    listSheet = ss.insertSheet("목록");
    ss.moveActiveSheet(ss.getNumSheets());
  }
  listSheet.clear();

  listSheet.getRange(1, 1).setValue("장비/세트명");
  listSheet.getRange(1, 1).setFontWeight("bold");

  if (sorted.length > 0) {
    const values = sorted.map(n => [n]);
    listSheet.getRange(2, 1, values.length, 1).setValues(values);
  }

  listSheet.hideSheet();

  // ── 확인요청 F열에 드롭다운 설정 ──
  const reqSheet = ss.getSheetByName("확인요청");
  if (reqSheet) {
    const lastDataRow = reqSheet.getMaxRows();
    const range = reqSheet.getRange(2, 6, lastDataRow - 1, 1);

    const rule = SpreadsheetApp.newDataValidation()
      .requireValueInRange(listSheet.getRange("A2:A" + (sorted.length + 1)), true)
      .setAllowInvalid(true)
      .setHelpText("장비명 또는 세트명을 검색하세요")
      .build();
    range.setDataValidation(rule);

    // ── 확인요청 C열(반출시간), E열(반납시간) 시간 드롭다운 설정 ──
    var timeList = [];
    for (var h = 0; h <= 23; h++) {
      timeList.push(("0" + h).slice(-2) + ":00");
    }
    var timeRule = SpreadsheetApp.newDataValidation()
      .requireValueInList(timeList, true)
      .setAllowInvalid(true)
      .setHelpText("시간을 선택하세요")
      .build();
    reqSheet.getRange(2, 3, lastDataRow - 1, 1).setDataValidation(timeRule); // C열: 반출시간
    reqSheet.getRange(2, 5, lastDataRow - 1, 1).setDataValidation(timeRule); // E열: 반납시간

    // ── 확인요청 H열(확인) 드롭다운 설정 ──
    var hRule = SpreadsheetApp.newDataValidation()
      .requireValueInList(["확인", "발송승인"], true)
      .setAllowInvalid(true)
      .build();
    reqSheet.getRange(2, 8, lastDataRow - 1, 1).setDataValidation(hRule);

    // ── 확인요청 N열(등록) 드롭다운 설정 ──
    var nRule = SpreadsheetApp.newDataValidation()
      .requireValueInList(["등록", "추가", "삭제", "날짜변경", "거절", "보류"], true)
      .setAllowInvalid(true)
      .build();
    reqSheet.getRange(2, 14, lastDataRow - 1, 1).setDataValidation(nRule);

    // ── 확인요청 M열(할인유형) 드롭다운 설정 ──
    var mRule = SpreadsheetApp.newDataValidation()
      .requireValueInList(["일반", "학생", "개인사업자/프리랜서", "단골", "제휴"], true)
      .setAllowInvalid(true)
      .setHelpText("일반=없음 / 학생=30% / 개인사업자/프리랜서=20% / 단골=개사프+10% / 제휴=개사프+20%")
      .build();
    reqSheet.getRange(2, 13, lastDataRow - 1, 1).setDataValidation(mRule);
  }

  // ── 스케줄상세 C열(세트명), D열(장비명)에 드롭다운 설정 ──
  const schedSheet = ss.getSheetByName("스케줄상세");
  if (schedSheet) {
    const schedLastRow = schedSheet.getMaxRows();
    const schedRule = SpreadsheetApp.newDataValidation()
      .requireValueInRange(listSheet.getRange("A2:A" + (sorted.length + 1)), true)
      .setAllowInvalid(true)
      .setHelpText("장비명 또는 세트명을 검색하세요")
      .build();
    schedSheet.getRange(2, 3, schedLastRow - 1, 1).setDataValidation(schedRule); // C열
    schedSheet.getRange(2, 4, schedLastRow - 1, 1).setDataValidation(schedRule); // D열
  }

  return sorted.length;
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 장비명 퍼지 매칭
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 입력된 장비명을 목록에서 가장 유사한 이름과 매칭
 * 정확히 매칭되면 그걸 사용, 아니면 부분 매칭 시도, 실패하면 원본 그대로 반환
 */
function fuzzyMatchEquipName(input, nameList) {
  if (!input || nameList.length === 0) return input;

  var inputLower = input.toLowerCase().replace(/\s+/g, "");

  // 1. 정확히 일치
  for (var i = 0; i < nameList.length; i++) {
    if (nameList[i] === input) return nameList[i];
  }

  // 2. 대소문자/공백 무시 일치
  for (var i = 0; i < nameList.length; i++) {
    if (nameList[i].toLowerCase().replace(/\s+/g, "") === inputLower) return nameList[i];
  }

  // 3. 한쪽이 다른 쪽을 포함 (입력값이 목록 항목 포함 또는 반대)
  var containMatches = [];
  for (var i = 0; i < nameList.length; i++) {
    var nameLower = nameList[i].toLowerCase().replace(/\s+/g, "");
    if (nameLower.indexOf(inputLower) >= 0 || inputLower.indexOf(nameLower) >= 0) {
      containMatches.push({ name: nameList[i], lenDiff: Math.abs(nameLower.length - inputLower.length) });
    }
  }
  if (containMatches.length > 0) {
    containMatches.sort(function(a, b) { return a.lenDiff - b.lenDiff; });
    return containMatches[0].name;
  }

  // 4. 핵심 키워드 매칭 (숫자+영문 조합: a7s3, fx3, gm2 등)
  var inputKeywords = inputLower.match(/[a-z]+\d+[a-z]*\d*|[a-z]{2,}/gi) || [];
  if (inputKeywords.length > 0) {
    var bestMatch = null;
    var bestScore = 0;
    for (var i = 0; i < nameList.length; i++) {
      var nameLower = nameList[i].toLowerCase().replace(/\s+/g, "");
      var score = 0;
      for (var k = 0; k < inputKeywords.length; k++) {
        if (nameLower.indexOf(inputKeywords[k].toLowerCase()) >= 0) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        bestMatch = nameList[i];
      }
    }
    if (bestMatch && bestScore >= 1) return bestMatch;
  }

  // 5. 레벤슈타인 거리 기반 유사도 매칭
  var bestLev = null;
  var bestDist = Infinity;
  for (var i = 0; i < nameList.length; i++) {
    var nameLower = nameList[i].toLowerCase().replace(/\s+/g, "");
    var dist = levenshtein(inputLower, nameLower);
    var maxLen = Math.max(inputLower.length, nameLower.length);
    // 유사도 60% 이상이면 매칭
    if (dist < bestDist && (1 - dist / maxLen) >= 0.6) {
      bestDist = dist;
      bestLev = nameList[i];
    }
  }
  if (bestLev) return bestLev;

  // 6. 매칭 실패 → 원본 그대로 반환
  return input;
}

/**
 * 레벤슈타인 거리 계산
 */
function levenshtein(a, b) {
  var m = a.length, n = b.length;
  var dp = [];
  for (var i = 0; i <= m; i++) {
    dp[i] = [i];
    for (var j = 1; j <= n; j++) {
      if (i === 0) { dp[i][j] = j; continue; }
      dp[i][j] = Math.min(
        dp[i-1][j] + 1,
        dp[i][j-1] + 1,
        dp[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1)
      );
    }
  }
  return dp[m][n];
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 요청ID 자동생성
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * B열(반출일) 입력 시 요청ID 자동생성
 * - 이미 요청ID가 있으면 스킵
 * - 바로 위 행에 요청ID가 있고 반출일이 같으면 상속
 * - 그 외에는 새 요청ID 생성 (RQ-YYMMDD-NNN)
 */
function autoGenerateReqID(sheet, row) {
  const currentReqID = sheet.getRange(row, 1).getValue();
  if (currentReqID) return; // 이미 있으면 스킵

  const 반출일 = sheet.getRange(row, 2).getValue();
  if (!반출일) return;

  // 바로 위 행 확인 → 같은 반출일이면 요청ID 상속
  if (row > 2) {
    const prevReqID = sheet.getRange(row - 1, 1).getValue();
    const prev반출일 = sheet.getRange(row - 1, 2).getValue();
    if (prevReqID && prev반출일) {
      const d1 = new Date(반출일);
      const d2 = new Date(prev반출일);
      if (d1.getFullYear() === d2.getFullYear() &&
          d1.getMonth() === d2.getMonth() &&
          d1.getDate() === d2.getDate()) {
        sheet.getRange(row, 1).setValue(prevReqID);
        // 반출시간, 반납일, 반납시간도 상속
        const prevC = sheet.getRange(row - 1, 3).getValue();
        const prevD = sheet.getRange(row - 1, 4).getValue();
        const prevE = sheet.getRange(row - 1, 5).getValue();
        if (prevC && !sheet.getRange(row, 3).getValue()) sheet.getRange(row, 3).setValue(prevC);
        if (prevD && !sheet.getRange(row, 4).getValue()) sheet.getRange(row, 4).setValue(prevD);
        if (prevE && !sheet.getRange(row, 5).getValue()) sheet.getRange(row, 5).setValue(prevE);
        return;
      }
    }
  }

  // 새 요청ID 생성: RQ-YYMMDD-NNN
  const now = new Date();
  const dateStr = Utilities.formatDate(now, "Asia/Seoul", "yyMMdd");
  const prefix = `RQ-${dateStr}`;

  // 기존 요청ID에서 최대 번호 찾기
  const lastRow = sheet.getLastRow();
  let maxNum = 0;
  if (lastRow >= 2) {
    const ids = sheet.getRange(2, 1, lastRow - 1, 1).getValues().flat();
    ids.forEach(id => {
      if (id && id.toString().startsWith(prefix)) {
        const parts = id.toString().split("-");
        const num = parseInt(parts[2]);
        if (num > maxNum) maxNum = num;
      }
    });
  }

  const newReqID = `${prefix}-${String(maxNum + 1).padStart(3, "0")}`;
  sheet.getRange(row, 1).setValue(newReqID);
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 확인요청 일괄 입력 + 가용확인 (스크립트 호출용)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 파서가 보낸 할인유형 값을 확인요청 M열 드롭다운 값(일반/학생/개인사업자/프리랜서/단골/제휴)으로 정규화.
 * - 빈값/미매칭 → "일반"
 * - 단골/제휴 → 파서가 넣지 말아야 하지만, 실수로 넣었으면 "일반"으로 대체 (단골/제휴는 고객DB 매칭 전용)
 * - "학생" 포함 → "학생"
 * - "사업자" / "프리랜서" / "프리" / "개사프" → "개인사업자/프리랜서"
 */
function _normalizeDiscountType(v) {
  var s = String(v || "").trim();
  if (!s) return "일반";
  // 정식값 그대로 온 경우
  if (s === "일반" || s === "학생" || s === "개인사업자/프리랜서") return s;
  // 단골/제휴는 파서가 넣지 못하게 차단 → 일반으로 변환 (시스템이 고객DB 매칭으로 처리)
  if (s === "단골" || s === "제휴") return "일반";
  // 키워드 매칭
  if (/학생|재학|학번|학사|대학|고등|중학/.test(s)) return "학생";
  if (/사업자|프리랜서|프리|개사프|프리라이더|자영|1인|소상공/.test(s)) return "개인사업자/프리랜서";
  return "일반";
}

function _confirmRequestDateKey_(v, displayValue) {
  var display = String(displayValue || "").trim();
  var s = display || String(v || "").trim();
  if (!s && !v) return "";
  var m = s.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (m) return m[1] + "-" + String(m[2]).padStart(2, "0") + "-" + String(m[3]).padStart(2, "0");
  if (v instanceof Date) return Utilities.formatDate(v, "Asia/Seoul", "yyyy-MM-dd");
  return s;
}

function _confirmRequestTimeKey_(v, displayValue) {
  var s = String(displayValue || "").trim() || String(v || "").trim();
  if (!s && !v) return "";
  var isPm = /오후|\bPM\b/i.test(s);
  var isAm = /오전|\bAM\b/i.test(s);
  var m = s.match(/(\d{1,2})(?::(\d{2}))?/);
  if (m) {
    var hour = parseInt(m[1], 10);
    var minute = parseInt(m[2] || "0", 10);
    if (isPm && hour < 12) hour += 12;
    if (isAm && hour === 12) hour = 0;
    if (hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59) {
      return String(hour).padStart(2, "0") + ":" + String(minute).padStart(2, "0");
    }
  }
  if (v instanceof Date) return Utilities.formatDate(v, "Asia/Seoul", "HH:mm");
  return s;
}

function _confirmRequestPhoneKey_(v) {
  return String(v || "").replace(/\D/g, "");
}

function _confirmRequestEquipKey_(v) {
  return String(v || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[(){}\[\]_\-./·,]/g, "");
}

function _confirmRequestContainsAllEquip_(existingEquips, requestedEquips) {
  if (!requestedEquips || requestedEquips.length === 0) return false;
  var existingKeys = existingEquips.map(_confirmRequestEquipKey_).filter(Boolean);
  return requestedEquips.every(function(reqName) {
    var reqKey = _confirmRequestEquipKey_(reqName);
    if (!reqKey) return false;
    return existingKeys.some(function(exKey) {
      return exKey === reqKey || exKey.indexOf(reqKey) >= 0 || reqKey.indexOf(exKey) >= 0;
    });
  });
}

function _findDuplicateConfirmRequest_(sheet, req, requestedEquipNames) {
  var reqName = String(req.예약자명 || "").trim();
  var reqDate = _confirmRequestDateKey_(req.반출일);
  var reqStartTime = _confirmRequestTimeKey_(req.반출시간);
  var reqEndDate = _confirmRequestDateKey_(req.반납일);
  var reqEndTime = _confirmRequestTimeKey_(req.반납시간);
  var reqPhone = _confirmRequestPhoneKey_(req.연락처);
  if (!reqName || !reqDate || !requestedEquipNames || requestedEquipNames.length === 0) return null;

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;

  var dataRange = sheet.getRange(2, 1, lastRow - 1, 18);
  var allData = dataRange.getValues();
  var allDisplayData = dataRange.getDisplayValues();
  var reqGroups = {};
  for (var di = 0; di < allData.length; di++) {
    var rowData = allData[di];
    var rowDisplay = allDisplayData[di] || [];
    var rid = rowDisplay[0] || rowData[0];
    if (!rid) continue;
    if (!reqGroups[rid]) {
      reqGroups[rid] = {
        reqID: String(rid).trim(),
        name: "",
        phone: "",
        startDate: "",
        startTime: "",
        endDate: "",
        endTime: "",
        equips: []
      };
    }
    var g = reqGroups[rid];
    if ((rowData[10] || rowDisplay[10]) && !g.name) g.name = String(rowDisplay[10] || rowData[10]).trim();      // K: 예약자명
    if ((rowData[11] || rowDisplay[11]) && !g.phone) g.phone = _confirmRequestPhoneKey_(rowDisplay[11] || rowData[11]); // L: 연락처
    if ((rowData[1] || rowDisplay[1]) && !g.startDate) g.startDate = _confirmRequestDateKey_(rowData[1], rowDisplay[1]); // B: 반출일
    if ((rowData[2] || rowDisplay[2]) && !g.startTime) g.startTime = _confirmRequestTimeKey_(rowData[2], rowDisplay[2]); // C: 반출시간
    if ((rowData[3] || rowDisplay[3]) && !g.endDate) g.endDate = _confirmRequestDateKey_(rowData[3], rowDisplay[3]);     // D: 반납일
    if ((rowData[4] || rowDisplay[4]) && !g.endTime) g.endTime = _confirmRequestTimeKey_(rowData[4], rowDisplay[4]);     // E: 반납시간
    if (rowData[5] || rowDisplay[5]) g.equips.push(String(rowDisplay[5] || rowData[5]).trim());             // F: 장비명
  }

  for (var rid in reqGroups) {
    var group = reqGroups[rid];
    if (group.name !== reqName) continue;
    if (reqPhone && group.phone && reqPhone !== group.phone) continue;
    if (group.startDate !== reqDate) continue;
    if (reqStartTime && group.startTime && reqStartTime !== group.startTime) continue;
    if (reqEndDate && group.endDate && group.endDate !== reqEndDate) continue;
    if (reqEndTime && group.endTime && reqEndTime !== group.endTime) continue;
    if (!_confirmRequestContainsAllEquip_(group.equips, requestedEquipNames)) continue;
    return group;
  }
  return null;
}

function _collectConfirmRequestResultsByReqID_(sheet, reqID) {
  var results = [];
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return results;
  var rows = sheet.getRange(2, 1, lastRow - 1, 17).getDisplayValues();
  for (var i = 0; i < rows.length; i++) {
    if (rows[i][0] !== reqID) continue;
    if (!rows[i][5]) continue;
    results.push({
      장비명: rows[i][5],
      수량: rows[i][6],
      결과: rows[i][8],
      상세: rows[i][9]
    });
  }
  return results;
}

/**
 * 확인요청 시트에 데이터 입력 후 가용확인까지 자동 실행
 * @param {Object} req - {
 *   반출일, 반출시간, 반납일, 반납시간,
 *   장비: [{이름, 수량}],
 *   예약자명?, 연락처?,
 *   할인유형? (일반|학생|개인사업자/프리랜서 중 하나; 단골/제휴는 파서가 넣지 않음 — 시스템이 고객DB 매칭으로 자동 처리),
 *   추가요청?
 * }
 * 구버전 호환: req.업체명 이 오면 req.할인유형으로 간주 (코워크 파서 마이그레이션 전 임시 fallback)
 */
function insertAndCheckRequest(req) {
  var insertLock = LockService.getScriptLock();
  try {
    insertLock.waitLock(30000);
  } catch (e) {
    throw new Error("다른 예약 입력을 처리 중입니다. 잠시 후 다시 시도하세요.");
  }

  try {
    return _insertAndCheckRequest(req);
  } finally {
    insertLock.releaseLock();
  }
}

function _insertAndCheckRequest(req) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("확인요청");
  if (!sheet) throw new Error("확인요청 시트 없음");

  // 장비명 매칭: 목록에서 가장 유사한 이름 찾기
  var equipNames = [];
  try {
    var listSheet = ss.getSheetByName("목록");
    if (listSheet && listSheet.getLastRow() >= 2) {
      equipNames = listSheet.getRange(2, 1, listSheet.getLastRow() - 1, 1)
        .getValues().flat().filter(function(v) { return v; }).map(String);
    }
  } catch(e) {}

  // ── 중복 체크: 같은 예약자명 + 반출일 + 장비목록 ──
  var requestedEquipNames = (req.장비 || []).map(function(e) {
    return fuzzyMatchEquipName(String(e.이름 || "").trim(), equipNames);
  }).filter(function(name) { return name; });
  var duplicateRequest = _findDuplicateConfirmRequest_(sheet, req, requestedEquipNames);
  if (duplicateRequest) {
    return {
      reqID: duplicateRequest.reqID,
      duplicate: true,
      message: "중복 요청: 동일한 예약자/반출일시/장비 조합이 이미 존재합니다 (" + duplicateRequest.reqID + ")",
      results: _collectConfirmRequestResultsByReqID_(sheet, duplicateRequest.reqID)
    };
  }

  var reqName = String(req.예약자명 || "").trim();
  var reqDate = _confirmRequestDateKey_(req.반출일);
  if (reqName && reqDate && requestedEquipNames.length > 0) {
    // 스케줄상세(등록 완료된 건)에서도 중복 체크
    var dupTid = checkDuplicateRequest(ss, reqName, reqDate, requestedEquipNames);
    if (dupTid) {
      throw new Error("중복 요청: 동일 건이 이미 예약 등록되어 있습니다 (거래ID: " + dupTid + ")");
    }
  }

  // 요청ID 생성
  const now = new Date();
  const dateStr = Utilities.formatDate(now, "Asia/Seoul", "yyMMdd");
  const prefix = "RQ-" + dateStr;
  const lastRow = sheet.getLastRow();
  let maxNum = 0;
  if (lastRow >= 2) {
    sheet.getRange(2, 1, lastRow - 1, 1).getValues().flat().forEach(function(id) {
      if (id && id.toString().startsWith(prefix)) {
        var num = parseInt(id.toString().split("-")[2]);
        if (num > maxNum) maxNum = num;
      }
    });
  }
  var reqID = prefix + "-" + String(maxNum + 1).padStart(3, "0");

  // 첫 번째 빈 행 찾기 (A열 기준)
  var startRow = 2;
  if (lastRow >= 2) {
    var aCol = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
    for (var r = 0; r < aCol.length; r++) {
      if (!aCol[r][0] || String(aCol[r][0]).trim() === "") {
        startRow = r + 2;
        break;
      }
      startRow = r + 3; // 마지막 데이터 다음 행
    }
  }
  // 연락처 미입력 시 고객DB에서 조회 (동명이인 시 자동입력 안 함)
  var resolvedPhone = req.연락처 || "";
  if (!resolvedPhone && req.예약자명) {
    var dbSheet = ss.getSheetByName("고객DB");
    if (dbSheet && dbSheet.getLastRow() >= 2) {
      var dbData = dbSheet.getDataRange().getValues();
      var matches = [];
      for (var di = 1; di < dbData.length; di++) {
        if (String(dbData[di][1]).trim() === String(req.예약자명).trim()) {
          matches.push(String(dbData[di][0]).trim());
        }
      }
      if (matches.length === 1) resolvedPhone = matches[0];
      // 2명 이상이면 자동입력 안 함 (동명이인 → 수동입력 필요)
    }
  }

  var items = req.장비 || [];
  for (var i = 0; i < items.length; i++) {
    // 장비명 퍼지 매칭
    var inputName = String(items[i].이름 || "").trim();
    var matchedName = fuzzyMatchEquipName(inputName, equipNames);

    var row = startRow + i;
    var rowData = [
      reqID,                              // A: 요청ID
      i === 0 ? req.반출일 : "",          // B: 반출일 (첫 행만)
      i === 0 ? (req.반출시간 || "") : "",// C: 반출시간 (첫 행만)
      i === 0 ? req.반납일 : "",          // D: 반납일 (첫 행만)
      i === 0 ? (req.반납시간 || "") : "",// E: 반납시간 (첫 행만)
      matchedName,              // F: 장비/세트명 (매칭된 이름 또는 원본)
      items[i].수량 || 1,       // G: 수량
      "",                       // H: 확인 (아래에서 채움)
      "",                       // I: 결과
      "",                       // J: 상세
      i === 0 ? (req.예약자명 || "") : "",// K: 예약자명 (첫 행만)
      i === 0 ? resolvedPhone : "",       // L: 연락처 (첫 행만, 고객DB 자동조회)
      i === 0 ? _normalizeDiscountType(req.할인유형 || req.업체명) : "",  // M: 할인유형 (첫 행만)
      "",                       // N: 등록
      "",                       // O: 등록상태
      "",                       // P: 거래ID
      i === 0 ? (req.비고 || "") : "",       // Q: 비고 (첫 행만)
      i === 0 ? (req.추가요청 || "") : ""  // R: 추가요청 (첫 행만)
    ];
    sheet.getRange(row, 1, 1, 18).setValues([rowData]);

    // 첫 행: 굵은 글씨 + 배경색으로 예약 건 구분
    if (i === 0) {
      sheet.getRange(row, 1, 1, 18).setFontWeight("bold").setBackground("#E8F0FE");
    } else {
      sheet.getRange(row, 1, 1, 18).setFontWeight("normal").setBackground(null);
    }
  }
  SpreadsheetApp.flush();

  // 가용확인 실행
  sheet.getRange(startRow, 8).setValue("확인");
  SpreadsheetApp.flush();
  _processByReqID(sheet, startRow);

  // 가용확인 결과 읽기 — 세트 전개로 행이 늘어날 수 있으므로 reqID 기준으로 전체 읽기
  SpreadsheetApp.flush();
  var results = [];
  var sheetLastRow = sheet.getLastRow();
  for (var r = startRow; r <= sheetLastRow; r++) {
    var rowData = sheet.getRange(r, 1, 1, 17).getDisplayValues()[0];
    if (rowData[0] !== reqID) break;  // 다른 reqID가 나오면 종료
    var equipName = rowData[5];  // F
    if (!equipName) continue;    // 빈 행 스킵
    results.push({
      장비명: equipName,
      수량: rowData[6],     // G
      결과: rowData[8],     // I
      상세: rowData[9]      // J
    });
  }

  return { reqID: reqID, results: results };
}


/**
 * 확인요청 수정 — reqID 기준으로 데이터 업데이트 후 가용확인 재실행
 * req: { reqID: "RQ-...", 반출일?, 반출시간?, 반납일?, 반납시간?, 예약자명?, 연락처?, 장비?: [{이름, 수량}] }
 */
/**
 * 확인요청에서 특정 장비 행을 보류 처리 (등록 전 제외용)
 */
function excludeEquipFromRequest(req) {
  if (!req.reqID || !req.제외장비 || req.제외장비.length === 0) return { status: "OK", excluded: 0 };

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("확인요청");
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { status: "OK", excluded: 0 };

  var data = sheet.getRange(2, 1, lastRow - 1, 17).getValues();
  var excluded = 0;

  for (var i = 0; i < data.length; i++) {
    if (String(data[i][0]).trim() !== req.reqID) continue;
    var 장비명 = String(data[i][5] || "").trim();
    if (req.제외장비.indexOf(장비명) >= 0) {
      var row = i + 2;
      sheet.getRange(row, 14).setValue("보류");     // N열
      sheet.getRange(row, 15).setValue("보류");     // O열
      excluded++;
    }
  }
  SpreadsheetApp.flush();
  return { status: "OK", excluded: excluded };
}


function updateRequest(req) {
  if (!req.reqID) throw new Error("reqID 필수");

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("확인요청");
  if (!sheet) throw new Error("확인요청 시트 없음");

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new Error("데이터 없음");

  var data = sheet.getRange(2, 1, lastRow - 1, 18).getValues();
  var targetRows = [];
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][0]).trim() === req.reqID) {
      targetRows.push(i + 2);
    }
  }
  if (targetRows.length === 0) throw new Error("요청ID를 찾을 수 없음: " + req.reqID);

  var firstRow = targetRows[0];

  // 장비 목록 변경이 있으면: 기존 행 삭제 후 재입력
  if (req.장비 && req.장비.length > 0) {
    // 기존 행 삭제 (아래부터 삭제해야 행 번호 안 꼬임)
    for (var d = targetRows.length - 1; d >= 0; d--) {
      sheet.deleteRow(targetRows[d]);
    }
    SpreadsheetApp.flush();

    // 삭제 후 첫 번째 빈 행 찾기 (A열 기준)
    var newLastRow = sheet.getLastRow();
    var startRow = 2;
    if (newLastRow >= 2) {
      var aCol = sheet.getRange(2, 1, newLastRow - 1, 1).getValues();
      for (var r = 0; r < aCol.length; r++) {
        if (!aCol[r][0] || String(aCol[r][0]).trim() === "") {
          startRow = r + 2;
          break;
        }
        startRow = r + 3;
      }
    }

    // 기존 데이터에서 날짜/시간/예약자명/연락처 가져오기 (req에 없으면)
    var origFirst = data[targetRows[0] - 2];
    var 반출일 = req.반출일 || origFirst[1];
    var 반출시간 = req.반출시간 !== undefined ? req.반출시간 : origFirst[2];
    var 반납일 = req.반납일 || origFirst[3];
    var 반납시간 = req.반납시간 !== undefined ? req.반납시간 : origFirst[4];
    var 예약자명 = req.예약자명 !== undefined ? req.예약자명 : origFirst[10];
    var 연락처 = req.연락처 !== undefined ? req.연락처 : origFirst[11];
    var 추가요청 = req.추가요청 !== undefined ? req.추가요청 : origFirst[17];

    var items = req.장비;
    for (var j = 0; j < items.length; j++) {
      var row = startRow + j;
      var rowData = [
        req.reqID,
        j === 0 ? 반출일 : "", j === 0 ? 반출시간 : "",
        j === 0 ? 반납일 : "", j === 0 ? 반납시간 : "",
        items[j].이름, items[j].수량 || 1,
        "", "", "",
        j === 0 ? 예약자명 : "", j === 0 ? 연락처 : "",
        "", "", "", "", "",
        j === 0 ? 추가요청 : ""
      ];
      sheet.getRange(row, 1, 1, 18).setValues([rowData]);
    }
    SpreadsheetApp.flush();

    // 가용확인 재실행
    sheet.getRange(startRow, 8).setValue("확인");
    SpreadsheetApp.flush();
    processByReqID(sheet, startRow);

    return { reqID: req.reqID, action: "수정", items: items.length, recheck: true };
  }

  // 장비 변경 없이 날짜/시간/예약자명/연락처만 수정
  var changed = [];
  if (req.반출일) { sheet.getRange(firstRow, 2).setValue(req.반출일); changed.push("반출일"); }
  if (req.반출시간 !== undefined) { sheet.getRange(firstRow, 3).setValue(req.반출시간); changed.push("반출시간"); }
  if (req.반납일) { sheet.getRange(firstRow, 4).setValue(req.반납일); changed.push("반납일"); }
  if (req.반납시간 !== undefined) { sheet.getRange(firstRow, 5).setValue(req.반납시간); changed.push("반납시간"); }
  if (req.예약자명 !== undefined) { sheet.getRange(firstRow, 11).setValue(req.예약자명); changed.push("예약자명"); }
  if (req.연락처 !== undefined) { sheet.getRange(firstRow, 12).setValue(req.연락처); changed.push("연락처"); }
  if (req.추가요청 !== undefined) { sheet.getRange(firstRow, 18).setValue(req.추가요청); changed.push("추가요청"); }

  // 날짜/시간 변경 시 가용확인 재실행
  var needRecheck = changed.some(function(c) { return ["반출일","반출시간","반납일","반납시간"].includes(c); });
  if (needRecheck) {
    // 결과 초기화
    for (var t = 0; t < targetRows.length; t++) {
      sheet.getRange(targetRows[t], 9, 1, 2).setValues([["", ""]]);
    }
    sheet.getRange(firstRow, 8).setValue("확인");
    SpreadsheetApp.flush();
    processByReqID(sheet, firstRow);
  }

  return { reqID: req.reqID, action: "수정", changed: changed, recheck: needRecheck };
}


/**
 * 확인요청 삭제 — reqID의 모든 행 삭제
 */
function deleteRequest(reqID) {
  if (!reqID) throw new Error("reqID 필수");

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("확인요청");
  if (!sheet) throw new Error("확인요청 시트 없음");

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) throw new Error("데이터 없음");

  var data = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  var targetRows = [];
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][0]).trim() === reqID) {
      targetRows.push(i + 2);
    }
  }
  if (targetRows.length === 0) throw new Error("요청ID를 찾을 수 없음: " + reqID);

  // 아래부터 삭제
  for (var d = targetRows.length - 1; d >= 0; d--) {
    sheet.deleteRow(targetRows[d]);
  }

  return { reqID: reqID, action: "삭제", deletedRows: targetRows.length };
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 가용 확인 — 같은 요청ID 일괄 처리
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 특정 행의 요청ID를 기준으로 같은 ID의 모든 행을 일괄 확인
 */
function processByReqID(sheet, triggerRow) {
  // ── 중복 실행 방지 락 ──
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(30000);
  } catch (e) {
    sheet.getRange(triggerRow, 9).setValue("⏳ 확인대기");
    return;
  }

  try {
  return _processByReqID(sheet, triggerRow);
  } finally {
    lock.releaseLock();
  }
}

function _processByReqID(sheet, triggerRow) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const schedSheet = ss.getSheetByName("스케줄상세");
  const equipSheet = ss.getSheetByName("장비마스터");
  const setSheet = ss.getSheetByName("세트마스터");

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const allData = sheet.getRange(2, 1, lastRow - 1, 17).getValues();
  // 시간 컬럼은 displayValue로 대체 (1899 timezone 이슈 방지)
  var allDisplayData = sheet.getRange(2, 1, lastRow - 1, 17).getDisplayValues();
  for (var di = 0; di < allData.length; di++) { allData[di][2] = allDisplayData[di][2]; allData[di][4] = allDisplayData[di][4]; }
  const triggerReqID = allData[triggerRow - 2][0]; // A열: 요청ID

  if (!triggerReqID) {
    // 요청ID 없으면 해당 행만 처리
    checkSingleRow(sheet, triggerRow, allData, triggerRow - 2, schedSheet, equipSheet, setSheet);
    return;
  }

  // ── 같은 요청ID의 첫 행에서 날짜 정보 가져오기 ──
  let 반출일, 반출시간, 반납일, 반납시간;
  for (let i = 0; i < allData.length; i++) {
    if (allData[i][0] === triggerReqID && allData[i][1]) {
      반출일 = allData[i][1];
      반출시간 = allData[i][2];
      반납일 = allData[i][3];
      반납시간 = allData[i][4];
      break;
    }
  }

  // ── 같은 요청ID의 모든 행 수집 ──
  let expandedRows = false;
  var reqRows = [];
  for (let i = 0; i < allData.length; i++) {
    if (allData[i][0] !== triggerReqID) continue;
    reqRows.push({ idx: i, row: i + 2, 장비명: allData[i][5], 수량: allData[i][6] || 1, result: allData[i][8] });
  }

  // 세트마스터 A열 이름 목록 (한번만 읽기)
  var setMasterNames = new Set();
  if (setSheet.getLastRow() >= 2) {
    setSheet.getRange(2, 1, setSheet.getLastRow() - 1, 1).getValues().flat()
      .forEach(function(n) { if (n) setMasterNames.add(n.toString().trim()); });
  }

  function isMainSetRowForFormatting_(result, equipName, qTag) {
    var cleanEquip = String(equipName || "").trim();
    var cleanQ = String(qTag || "").trim();
    if (!cleanEquip || cleanQ.indexOf("[세트]") === 0) return false;
    if (String(result || "").trim() === "세트") return true;
    if (setMasterNames.has(cleanEquip)) return true;
    return getSetComponents(cleanEquip, setSheet).length > 0;
  }

  // 첫 행 서식 (예약 건 구분). 기존 세트 초록 서식은 여기서 지우지 않는다.
  if (reqRows.length > 0) {
    sheet.getRange(reqRows[0].row, 1, 1, 18).setFontWeight("bold").setBackground("#E8F0FE");
  }

  // ── 변경된 세트의 구성품만 삭제 (다른 세트/장비는 보존) ──
  // 1) 현재 reqID의 세트 헤더 이름 수집 (Q열이 비어있는 행 = 세트 헤더 또는 개별 장비)
  var currentSetNames = new Set();
  for (let r = 0; r < reqRows.length; r++) {
    var rName = reqRows[r].장비명;
    if (rName && getSetComponents(rName, setSheet).length > 0) {
      currentSetNames.add(rName);
    }
  }

  // 2) 고아 구성품 삭제: Q열 "[세트]XXX"에서 XXX가 현재 세트 헤더에 없는 것만 삭제
  var lastRowBeforeClean = sheet.getLastRow();
  var deletedAny = false;
  if (lastRowBeforeClean >= 2) {
    var qCol = sheet.getRange(2, 17, lastRowBeforeClean - 1, 1).getValues();
    var aCol = sheet.getRange(2, 1, lastRowBeforeClean - 1, 1).getValues();
    var fCol = sheet.getRange(2, 6, lastRowBeforeClean - 1, 1).getValues();
    for (let ci = qCol.length - 1; ci >= 0; ci--) {
      var qVal = String(qCol[ci][0]);
      if (String(aCol[ci][0]).trim() !== triggerReqID) continue;
      if (qVal.indexOf("[세트]") !== 0) continue;
      var belongsTo = qVal.substring(4); // "[세트]" 이후 = 소속 세트명
      var componentName = String(fCol[ci][0] || "").trim();
      if (!componentName || !currentSetNames.has(belongsTo)) {
        // 빈 구성품이거나 이 구성품의 소속 세트가 현재 없음 → 삭제 대상
        sheet.deleteRow(ci + 2);
        deletedAny = true;
      }
    }
  }
  if (deletedAny) SpreadsheetApp.flush();

  // 3) 삭제 발생 시 reqRows 재구성
  if (deletedAny) {
    var refreshLastRow = sheet.getLastRow();
    var refreshData = sheet.getRange(2, 1, refreshLastRow - 1, 18).getValues();
    reqRows = [];
    for (let i = 0; i < refreshData.length; i++) {
      if (String(refreshData[i][0]).trim() === triggerReqID) {
        reqRows.push({
          row: i + 2,
          장비명: String(refreshData[i][5]).trim(),
          수량: refreshData[i][6] || 1,
          result: String(refreshData[i][8]).trim()
        });
      }
    }
  }

  // 4) I/J 결과: 이미 결과가 있는 행은 보존, 새 행만 확인 대상
  //    (고아 구성품 삭제로 인해 새로 펼쳐질 세트의 결과만 비어있음)

  // 5) reqRows 최종 재구성
  var finalLastRow = sheet.getLastRow();
  var finalData = sheet.getRange(2, 1, finalLastRow - 1, 18).getValues();
  reqRows = [];
  for (let i = 0; i < finalData.length; i++) {
    if (String(finalData[i][0]).trim() === triggerReqID) {
      reqRows.push({
        row: i + 2,
        장비명: String(finalData[i][5]).trim(),
        수량: finalData[i][6] || 1,
        result: String(finalData[i][8]).trim(),
        qTag: String(finalData[i][16]).trim()
      });
    }
  }

  // 세트 펼침: 아래에서 위로 처리 (행 삽입으로 인한 번호 밀림 방지)
  // + 단일 품목도 세트마스터에 있으면 F열 초록 표시
  var firstRowNum = reqRows.length > 0 ? reqRows[0].row : null;
  for (let r = reqRows.length - 1; r >= 0; r--) {
    var ri = reqRows[r];
    if (!ri.장비명) continue;
    if (ri.qTag.indexOf("[세트]") === 0) continue; // 기존 구성품 행은 스킵 (펼침 불필요)

    // 확인 자동 채우기
    if (sheet.getRange(ri.row, 8).getValue() !== "확인") {
      sheet.getRange(ri.row, 8).setValue("확인");
    }

    // 세트인지 확인 → 구성품이 아직 없는 경우만 펼침
    const setComponents = getSetComponents(ri.장비명, setSheet);
    if (setComponents.length > 0) {
      // 이미 이 세트의 구성품이 존재하는지 확인
      var hasExisting = reqRows.some(function(rr) { return rr.qTag === "[세트]" + ri.장비명; });
      if (!hasExisting) {
        expandSetRows(sheet, ri.row, triggerReqID, setComponents, ri.수량);
        expandedRows = true;
      } else {
        // 기존 구성품 유지, 헤더만 세트 표시
        sheet.getRange(ri.row, 9).setValue("세트");
      }
    } else if (setMasterNames.has(ri.장비명.toString().trim())) {
      // 단일 품목: 세트마스터에 존재 → F열 초록 표시
      sheet.getRange(ri.row, 6).setBackground("#D9EAD3").setFontWeight("bold");
    }
  }

  // 스케줄상세 데이터 미리 읽기 (한 번만)
  const schedData = getScheduleData(schedSheet);

  // 세트 펼침이 있었으면 데이터 다시 읽고 가용확인
  if (expandedRows) {
    SpreadsheetApp.flush();
    const newLastRow = sheet.getLastRow();
    const newAllData = sheet.getRange(2, 1, newLastRow - 1, 18).getValues();

    // 세트명 셀(F열)에 색상 표시 — 단, 첫 행은 요청ID 구분 서식(파란배경) 우선
    var firstRowOfReq = null;
    for (let i = 0; i < newAllData.length; i++) {
      if (newAllData[i][0] !== triggerReqID) continue;
      if (firstRowOfReq === null) firstRowOfReq = i + 2;
      if (newAllData[i][8] === "세트") {
        if (i + 2 === firstRowOfReq) {
          // 첫 행도 세트명 셀(F열)은 초록으로 표시
          sheet.getRange(i + 2, 1, 1, 18).setFontWeight("bold").setBackground("#E8F0FE");
          sheet.getRange(i + 2, 6).setBackground("#D9EAD3").setFontWeight("bold");
        } else {
          sheet.getRange(i + 2, 6).setBackground("#D9EAD3").setFontWeight("bold");
        }
      }
    }

    for (let i = 0; i < newAllData.length; i++) {
      if (newAllData[i][0] !== triggerReqID) continue;
      const row = i + 2;
      const 장비명 = newAllData[i][5];
      if (!장비명) continue;

      if (newAllData[i][8] === "세트") {
        // 세트 헤더: 장비마스터에 존재하면 J열에 가용 정보 표시
        checkSetHeaderAvail(sheet, row, 장비명, newAllData[i][6] || 1,
          반출일, 반출시간, 반납일, 반납시간, schedData, equipSheet);
        continue;
      }
      var existResult = String(newAllData[i][8]).trim();
      if (existResult && existResult !== "") continue; // 이미 결과 있으면 스킵

      checkSingleRowWithData(sheet, row, triggerReqID, 반출일, 반출시간, 반납일, 반납시간,
        장비명, newAllData[i][6] || 1, schedData, equipSheet);
    }
  } else {
    // 펼침 없는 경우: 최신 데이터 다시 읽기 (고아 삭제 반영)
    var latestLastRow = sheet.getLastRow();
    var latestData = sheet.getRange(2, 1, latestLastRow - 1, 18).getValues();
    for (let i = 0; i < latestData.length; i++) {
      if (latestData[i][0] !== triggerReqID) continue;
      const row = i + 2;
      const 장비명 = latestData[i][5];
      if (!장비명) continue;

      if (latestData[i][8] === "세트") {
        checkSetHeaderAvail(sheet, row, 장비명, latestData[i][6] || 1,
          반출일, 반출시간, 반납일, 반납시간, schedData, equipSheet);
        continue;
      }
      var existResult2 = String(latestData[i][8]).trim();
      if (existResult2 && existResult2 !== "") continue;

      checkSingleRowWithData(sheet, row, triggerReqID, 반출일, 반출시간, 반납일, 반납시간,
        장비명, latestData[i][6] || 1, schedData, equipSheet);
    }
  }

  // ━━ 최종 서식 재적용 — 재확인해도 첫행 볼드+파란배경, 세트 F열 초록 유지 ━━
  SpreadsheetApp.flush();
  var finalLastRow2 = sheet.getLastRow();
  if (finalLastRow2 >= 2) {
    var finalData2 = sheet.getRange(2, 1, finalLastRow2 - 1, 18).getValues();
    var isFirstRow = true;
    for (let i = 0; i < finalData2.length; i++) {
      if (String(finalData2[i][0]).trim() !== triggerReqID) continue;
      var fRow = i + 2;
      var fResult = String(finalData2[i][8] || "").trim();
      var fEquip = String(finalData2[i][5] || "").trim();
      var fQTag = String(finalData2[i][16] || "").trim();

      var isMainSetRow = isMainSetRowForFormatting_(fResult, fEquip, fQTag);

      if (isFirstRow) {
        // 첫 행: 볼드 + 파란배경
        sheet.getRange(fRow, 1, 1, 18).setFontWeight("bold").setBackground("#E8F0FE");
        if (isMainSetRow) {
          sheet.getRange(fRow, 6).setBackground("#D9EAD3").setFontWeight("bold");
        }
        isFirstRow = false;
      } else {
        // 나머지 행: 일반 텍스트 + 배경 제거
        sheet.getRange(fRow, 1, 1, 18).setFontWeight("normal").setBackground(null);
        // 세트 헤더 또는 세트마스터 존재 품목이면 F열만 초록
        if (isMainSetRow) {
          sheet.getRange(fRow, 6).setBackground("#D9EAD3").setFontWeight("bold");
        }
      }
      // I/J열 결과 배경색은 보존
      if (fResult) {
        var color = fResult.indexOf("✅") >= 0 ? "#C6EFCE" :
                    fResult.indexOf("⚠") >= 0 || fResult.indexOf("⚠️") >= 0 ? "#FFEB9C" :
                    fResult.indexOf("❌") >= 0 ? "#FFC7CE" : null;
        if (color) sheet.getRange(fRow, 9, 1, 2).setBackground(color);
      }
    }
  }

  // ※ 가용확인 알림톡은 여기서 자동발송하지 않음
  // → H열 "발송" 선택 시 sendAvailAlimtalk()에서 별도 발송 (결재 후)

}


/**
 * 같은 reqID의 다른 행에 이미 결과(I열)가 있는지 확인
 */
function hasProcessedRows_(sheet, triggerRow, reqID) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  var data = sheet.getRange(2, 1, lastRow - 1, 9).getValues();
  for (var i = 0; i < data.length; i++) {
    var r = i + 2;
    if (r === triggerRow) continue;
    if (String(data[i][0]).trim() === reqID && String(data[i][8]).trim() !== "") {
      return true;
    }
  }
  return false;
}

function preparePendingConfirmRows_(sheet, triggerRow, reqID) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2 || !reqID) return;

  var targetReqID = String(reqID).trim();
  var data = sheet.getRange(2, 1, lastRow - 1, 10).getValues();
  var resultRanges = [];
  var confirmRows = [];
  for (var i = 0; i < data.length; i++) {
    var row = i + 2;
    if (String(data[i][0]).trim() !== targetReqID) continue;

    var confirmVal = String(data[i][7] || "").trim();
    if (row !== triggerRow && confirmVal) continue;

    resultRanges.push("I" + row + ":J" + row);
    if (confirmVal !== "확인") confirmRows.push(row);
  }
  if (resultRanges.length) {
    sheet.getRangeList(resultRanges).clearContent();
    confirmRows.forEach(function(row) {
      sheet.getRange(row, 8).setValue("확인");
    });
    SpreadsheetApp.flush();
  }
}

/**
 * 기존에 이미 처리된 reqID 그룹에 새 행을 추가할 때
 * 기존 행의 서식/결과를 건드리지 않고 새 행만 처리
 */
function processAdditionalRow_(sheet, triggerRow, reqID) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var schedSheet = ss.getSheetByName("스케줄상세");
  var equipSheet = ss.getSheetByName("장비마스터");
  var setSheet = ss.getSheetByName("세트마스터");

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;
  var allData = sheet.getRange(2, 1, lastRow - 1, 17).getValues();
  var allDisplayData = sheet.getRange(2, 1, lastRow - 1, 17).getDisplayValues();
  for (var di = 0; di < allData.length; di++) {
    allData[di][2] = allDisplayData[di][2];
    allData[di][4] = allDisplayData[di][4];
  }

  // 같은 reqID의 첫 행에서 날짜 정보 가져오기
  var 반출일, 반출시간, 반납일, 반납시간;
  for (var i = 0; i < allData.length; i++) {
    if (String(allData[i][0]).trim() === reqID && allData[i][1]) {
      반출일 = allData[i][1];
      반출시간 = allData[i][2];
      반납일 = allData[i][3];
      반납시간 = allData[i][4];
      break;
    }
  }

  if (!반출일) return;

  var idx = triggerRow - 2;
  var 장비명 = String(allData[idx][5]).trim();
  var 수량 = allData[idx][6] || 1;

  if (!장비명) return;

  if (!String(allData[idx][0]).trim()) {
    sheet.getRange(triggerRow, 1).setValue(reqID);
  }

  if (!allData[idx][1]) {
    sheet.getRange(triggerRow, 2).setValue(반출일);
    sheet.getRange(triggerRow, 3).setValue(반출시간);
    sheet.getRange(triggerRow, 4).setValue(반납일);
    sheet.getRange(triggerRow, 5).setValue(반납시간);
  }

  var setComponents = getSetComponents(장비명, setSheet);
  var schedData = getScheduleData(schedSheet);

  if (setComponents.length > 0) {
    // 세트 펼침
    expandSetRows(sheet, triggerRow, reqID, setComponents, 수량);
    SpreadsheetApp.flush();

    // 세트 헤더 서식
    sheet.getRange(triggerRow, 9).setValue("세트");
    sheet.getRange(triggerRow, 6).setBackground("#D9EAD3").setFontWeight("bold");

    // 세트 헤더 가용 정보
    checkSetHeaderAvail(sheet, triggerRow, 장비명, 수량,
      반출일, 반출시간, 반납일, 반납시간, schedData, equipSheet);

    // 펼쳐진 구성품 각각 확인
    var newLastRow = sheet.getLastRow();
    var newData = sheet.getRange(2, 1, newLastRow - 1, 17).getValues();
    var newDisplayData = sheet.getRange(2, 1, newLastRow - 1, 17).getDisplayValues();
    for (var di2 = 0; di2 < newData.length; di2++) {
      newData[di2][2] = newDisplayData[di2][2];
      newData[di2][4] = newDisplayData[di2][4];
    }

    for (var ci = idx + 1; ci < newData.length; ci++) {
      if (String(newData[ci][0]).trim() !== reqID) continue;
      var compRow = ci + 2;
      var qTag = String(newData[ci][16]).trim();
      if (qTag.indexOf("[세트]") !== 0) continue;
      var belongsTo = qTag.substring(4);
      if (belongsTo !== 장비명) continue;

      var comp장비 = String(newData[ci][5]).trim();
      if (!comp장비) continue;

      if (sheet.getRange(compRow, 8).getValue() !== "확인") {
        sheet.getRange(compRow, 8).setValue("확인");
      }

      checkSingleRowWithData(sheet, compRow, reqID, 반출일, 반출시간, 반납일, 반납시간,
        comp장비, newData[ci][6] || 1, schedData, equipSheet);

      SpreadsheetApp.flush();
      var compResult = String(sheet.getRange(compRow, 9).getValue()).trim();
      if (compResult) {
      var compColor = compResult.indexOf("✅") >= 0 ? "#C6EFCE" :
                      compResult.indexOf("⚠") >= 0 ? "#FFE89C" :
                      compResult.indexOf("❌") >= 0 ? "#FFC7CE" : null;
        if (compColor) sheet.getRange(compRow, 9, 1, 2).setBackground(compColor);
      }
    }
  } else {
    // 단일 장비
    var setMasterNames = new Set();
    if (setSheet.getLastRow() >= 2) {
      setSheet.getRange(2, 1, setSheet.getLastRow() - 1, 1).getValues().flat()
        .forEach(function(n) { if (n) setMasterNames.add(n.toString().trim()); });
    }
    if (setMasterNames.has(장비명)) {
      sheet.getRange(triggerRow, 6).setBackground("#D9EAD3").setFontWeight("bold");
    }

    checkSingleRowWithData(sheet, triggerRow, reqID, 반출일, 반출시간, 반납일, 반납시간,
      장비명, 수량, schedData, equipSheet);
  }

  // 트리거 행 결과 색상 적용
  SpreadsheetApp.flush();
  var result = String(sheet.getRange(triggerRow, 9).getValue()).trim();
  if (result && result !== "세트") {
    var color = result.indexOf("✅") >= 0 ? "#C6EFCE" :
                result.indexOf("⚠") >= 0 ? "#FFE89C" :
                result.indexOf("❌") >= 0 ? "#FFC7CE" : null;
    if (color) sheet.getRange(triggerRow, 9, 1, 2).setBackground(color);
  }
}


/**
 * H열 "발송승인" → 가용확인 결과 (코워크 에이전트가 카톡으로 직접 발송)
 * 팝빌 알림톡 자동발송 제거됨
 */
function sendAvailAlimtalk(sheet, row) {
  // 코워크 에이전트가 직접 카카오톡 채널에서 발송하므로 자동발송 비활성화
  Logger.log("가용확인 발송승인 — 코워크 에이전트가 카톡으로 직접 발송");
}


/**
 * 단일 행 가용 확인 (요청ID 없을 때)
 */
function checkSingleRow(sheet, row, allData, idx, schedSheet, equipSheet, setSheet) {
  const 반출일 = allData[idx][1];
  const 반출시간 = allData[idx][2];
  const 반납일 = allData[idx][3];
  const 반납시간 = allData[idx][4];
  const 장비명 = allData[idx][5];
  const 수량 = allData[idx][6] || 1;

  const schedData = getScheduleData(schedSheet);

  // 세트 체크 → 기존 구성품 삭제 후 펼침
  const setComponents = getSetComponents(장비명, setSheet);
  if (setComponents.length > 0) {
    const reqID = allData[idx][0] || "REQ-" + new Date().getTime();
    if (!allData[idx][0]) sheet.getRange(row, 1).setValue(reqID);

    // 기존 구성품 행 삭제 (Q열 "[세트]" 태그)
    var sLastRow = sheet.getLastRow();
    if (sLastRow >= 2) {
      var sQcol = sheet.getRange(2, 17, sLastRow - 1, 1).getValues();
      var sAcol = sheet.getRange(2, 1, sLastRow - 1, 1).getValues();
      for (let si = sQcol.length - 1; si >= 0; si--) {
        if (String(sAcol[si][0]).trim() === reqID && String(sQcol[si][0]).indexOf("[세트]") === 0) {
          sheet.deleteRow(si + 2);
        }
      }
    }
    // I열 "세트" 초기화
    sheet.getRange(row, 9).clearContent();
    sheet.getRange(row, 10).clearContent();

    expandSetRows(sheet, row, reqID, setComponents, 수량);
    SpreadsheetApp.flush();

    // 데이터 다시 읽기
    const newLastRow = sheet.getLastRow();
    const newData = sheet.getRange(2, 1, newLastRow - 1, 17).getValues();
    for (let i = 0; i < newData.length; i++) {
      if (newData[i][0] !== reqID) continue;
      checkSingleRowWithData(sheet, i + 2, reqID, 반출일, 반출시간, 반납일, 반납시간,
        newData[i][5], newData[i][6] || 1, schedData, equipSheet);
    }
    return;
  }

  checkSingleRowWithData(sheet, row, allData[idx][0], 반출일, 반출시간, 반납일, 반납시간,
    장비명, 수량, schedData, equipSheet);
}

/**
 * 세트 헤더 행의 가용 확인 — 세트명이 장비마스터에 있으면 J열에 가용 표시
 */
function checkSetHeaderAvail(sheet, row, 장비명, 수량, 반출일, 반출시간, 반납일, 반납시간, schedData, equipSheet) {
  var equipInfo = findEquipment(장비명, equipSheet);
  if (!equipInfo) return; // 장비마스터에 없으면 패스 (순수 세트)

  var reqStartDT = parseDT(반출일, 반출시간);
  var reqEndDT = parseDT(반납일, 반납시간);
  if (!reqStartDT || !reqEndDT) return;

  var overlaps = [];
  schedData.forEach(function(sched) {
    if (sched.equipment !== 장비명) return;
    if (sched.status === "반납완료" || sched.status === "취소") return;
    if (!sched.startDT || !sched.endDT) return;
    if (sched.startDT < reqEndDT && sched.endDT > reqStartDT) {
      overlaps.push(sched);
    }
  });

  var 총보유 = equipInfo.total;
  if (overlaps.length === 0) {
    sheet.getRange(row, 10).setValue("✅ 본체 가용" + 총보유 + " (보유" + 총보유 + ")");
  } else {
    // sweep-line 동시사용량 계산
    var tpSet = {};
    tpSet[reqStartDT.getTime()] = true;
    overlaps.forEach(function(s) {
      var st = s.startDT.getTime(), et = s.endDT.getTime();
      if (st > reqStartDT.getTime() && st < reqEndDT.getTime()) tpSet[st] = true;
      if (et > reqStartDT.getTime() && et < reqEndDT.getTime()) tpSet[et] = true;
    });
    var timePoints = Object.keys(tpSet).map(Number).sort(function(a,b){ return a-b; });
    var maxConcurrent = 0;
    for (var ti = 0; ti < timePoints.length; ti++) {
      var concurrent = 0;
      for (var oi = 0; oi < overlaps.length; oi++) {
        if (overlaps[oi].startDT.getTime() <= timePoints[ti] && overlaps[oi].endDT.getTime() > timePoints[ti]) {
          concurrent += overlaps[oi].qty;
        }
      }
      if (concurrent > maxConcurrent) maxConcurrent = concurrent;
    }
    var 가용수량 = 총보유 - maxConcurrent;
    if (가용수량 >= 수량) {
      sheet.getRange(row, 10).setValue("✅ 본체 가용" + 가용수량 + " (보유" + 총보유 + ")");
    } else {
      sheet.getRange(row, 10).setValue("❌ 본체 가용" + Math.max(0, 가용수량) + " (보유" + 총보유 + ", 사용중" + maxConcurrent + ")");
      sheet.getRange(row, 10).setBackground("#FFC7CE");
    }
  }
}


/**
 * 단일 행 가용 확인 — 핵심 로직
 */
function checkSingleRowWithData(sheet, row, reqID, 반출일, 반출시간, 반납일, 반납시간,
  장비명, 수량, schedData, equipSheet) {

  // ── 날짜 검증 ──
  if (!반출일 || !반납일 || (반출시간 === null || 반출시간 === undefined || 반출시간 === "") || (반납시간 === null || 반납시간 === undefined || 반납시간 === "")) {
    sheet.getRange(row, 9).setValue("❌ 날짜/시간 필요");
    return;
  }

  const reqStartDT = parseDT(반출일, 반출시간);
  const reqEndDT = parseDT(반납일, 반납시간);

  if (!reqStartDT || !reqEndDT || reqStartDT >= reqEndDT) {
    sheet.getRange(row, 9).setValue("❌ 날짜범위 오류");
    return;
  }

  // ── 장비마스터에서 정보 찾기 ──
  const equipInfo = findEquipment(장비명, equipSheet);
  if (!equipInfo) {
    // 카테고리명인지 확인
    const catItems = findEquipmentByCategory(장비명, equipSheet);
    if (catItems.length > 0) {
      sheet.getRange(row, 9).setValue("⚠️ 모델 선택 필요");
      sheet.getRange(row, 10).setValue("F열 드롭다운에서 구체 모델을 선택하세요");
      sheet.getRange(row, 6).setBackground('#FFEB9C');
      return;
    }
    sheet.getRange(row, 9).setValue("❓ 미등록 장비");
    sheet.getRange(row, 10).setValue("장비마스터/세트마스터에 없음");
    return;
  }

  const 총보유 = equipInfo.total;

  // ── 겹치는 기존 예약 수집 ──
  var overlaps = [];
  schedData.forEach(function(sched) {
    if (sched.equipment !== 장비명) return;
    if (sched.status === "반납완료" || sched.status === "취소") return;
    if (!sched.startDT || !sched.endDT) return;
    if (sched.startDT < reqEndDT && sched.endDT > reqStartDT) {
      overlaps.push(sched);
    }
  });

  if (overlaps.length === 0) {
    sheet.getRange(row, 9).setValue("\u2705 가용" + 총보유);
    sheet.getRange(row, 10).setValue("보유" + 총보유);
    sheet.getRange(row, 9, 1, 2).setBackground("#C6EFCE");
    return;
  }

  // ── 시점별 동시사용량 계산 (sweep-line) ──
  var tpSet = {};
  tpSet[reqStartDT.getTime()] = true;
  overlaps.forEach(function(s) {
    var st = s.startDT.getTime(), et = s.endDT.getTime();
    if (st > reqStartDT.getTime() && st < reqEndDT.getTime()) tpSet[st] = true;
    if (et > reqStartDT.getTime() && et < reqEndDT.getTime()) tpSet[et] = true;
  });
  var timePoints = Object.keys(tpSet).map(Number).sort(function(a,b){ return a-b; });

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

  // ── 겹침 상세 목록 ──
  var 겹침목록 = [];
  overlaps.forEach(function(sched) {
    var endStr = Utilities.formatDate(sched.endDT, "Asia/Seoul", "M/d HH:mm");
    var overlapMs = Math.min(reqEndDT, sched.endDT) - Math.max(reqStartDT, sched.startDT);
    겹침목록.push((sched.contractName || sched.contractID) + " 반납" + endStr + "(" + formatDuration_(overlapMs) + "겹침)");
  });

  // ── 결과 판정 (피크 사용량 기반: 기간 내 동시최대를 본다) ──
  // 반출시점만 보면 안 됨. 기간 중 동시 사용량 피크가 보유를 넘으면 부족.
  var result, detail;
  var 가용 = 총보유 - maxConcurrent;

  if (가용 >= 수량) {
    // 기간 내내 충분
    result = "\u2705 가용" + 가용;
    detail = "보유" + 총보유 + (maxConcurrent > 0 ? ", 최대동시" + maxConcurrent : "");
  } else if (가용 > 0) {
    // 부분 부족 — 일부만 가능
    result = "\u26A0\uFE0F 부족(가용" + 가용 + "/" + 수량 + ")";
    detail = "보유" + 총보유 + ", 최대동시" + maxConcurrent +
             (겹침목록.length > 0 ? "\n" + 겹침목록.join("\n") : "");
  } else if (겹침목록.length > 0) {
    // 가용 0 이하 — 완전 부족
    result = "\u26A0\uFE0F 겹침(가용" + Math.max(0, 가용) + ")";
    detail = "보유" + 총보유 + ", 최대동시" + maxConcurrent + "\n" + 겹침목록.join("\n");
  } else {
    result = "\u274C 가용0";
    detail = "보유" + 총보유 + ", 전량사용중";
  }

  sheet.getRange(row, 9).setValue(result);
  sheet.getRange(row, 10).setValue(detail);

  var color = result.indexOf("\u2705") !== -1 ? "#C6EFCE" :
              result.indexOf("\u26A0") !== -1 ? "#FFEB9C" : "#FFC7CE";
  sheet.getRange(row, 9, 1, 2).setBackground(color);
}

/**
 * 밀리초 → 사람이 읽기 쉬운 시간 포맷
 * 120분 → "2시간", 650분 → "10시간 50분", 1500분 → "1일 1시간"
 */
function formatDuration_(ms) {
  var totalMin = Math.round(ms / 60000);
  if (totalMin < 60) return totalMin + "분";
  var hours = Math.floor(totalMin / 60);
  var mins = totalMin % 60;
  if (hours < 24) {
    return mins > 0 ? hours + "시간 " + mins + "분" : hours + "시간";
  }
  var days = Math.floor(hours / 24);
  hours = hours % 24;
  var parts = [days + "일"];
  if (hours > 0) parts.push(hours + "시간");
  if (mins > 0) parts.push(mins + "분");
  return parts.join(" ");
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 세트 자동 펼침
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 세트 구성품 행을 현재 행 아래에 삽입
 */
function expandSetRows(sheet, setRow, reqID, components, qty) {
  const numComponents = components.length;
  const setName = sheet.getRange(setRow, 6).getValue(); // 세트명 보존
  const ss = sheet.getParent();
  const equipSheet = ss.getSheetByName("장비마스터");

  // ── 장비마스터 데이터 한 번만 읽기 (N+1 방지) ──
  const equipLastRow = equipSheet.getLastRow();
  const equipData = equipLastRow >= 2 ? equipSheet.getRange(2, 1, equipLastRow - 1, 12).getValues() : [];

  // 장비마스터 조회를 메모리에서 수행하는 헬퍼
  function findEquipInData(name) {
    for (let ei = 0; ei < equipData.length; ei++) {
      if (equipData[ei][3] === name) {
        return { total: equipData[ei][4] || 0, 단가: equipData[ei][11] || 0 };
      }
    }
    return null;
  }
  function findEquipByCatInData(categoryName) {
    var items = [];
    for (let ei = 0; ei < equipData.length; ei++) {
      if (String(equipData[ei][2]).trim() === String(categoryName).trim() && equipData[ei][3]) {
        items.push({ name: equipData[ei][3], total: equipData[ei][4] || 0, 단가: equipData[ei][11] || 0 });
      }
    }
    return items;
  }

  // ★ 세트 헤더 행 유지: F열 그대로, I열에 "세트" 표시
  sheet.getRange(setRow, 9).setValue("세트"); // I열: 결과 = "세트"
  // 첫 행(요청ID 구분 행)이면 파란배경 유지, 아니면 F열만 초록
  var isFirstRow = false;
  if (setRow >= 2) {
    var aboveVal = setRow > 2 ? sheet.getRange(setRow - 1, 1).getValue().toString().trim() : "";
    isFirstRow = (aboveVal !== reqID);
  }
  if (!isFirstRow) {
    sheet.getRange(setRow, 6).setBackground("#D9EAD3").setFontWeight("bold");
  } else {
    sheet.getRange(setRow, 1, 1, 18).setFontWeight("bold").setBackground("#E8F0FE");
    sheet.getRange(setRow, 6).setBackground("#D9EAD3").setFontWeight("bold");
  }

  // 모든 구성품을 아래에 행 삽입
  if (numComponents > 0) {
    sheet.insertRowsAfter(setRow, numComponents);

    for (let i = 0; i < numComponents; i++) {
      const newRow = setRow + 1 + i;
      sheet.getRange(newRow, 1).setValue(reqID);                        // A: 요청ID
      sheet.getRange(newRow, 6).clearDataValidations();
      sheet.getRange(newRow, 6).setValue(components[i].name);           // F: 장비명
      sheet.getRange(newRow, 7).setValue((components[i].qty || 1) * qty); // G: 수량
      sheet.getRange(newRow, 8).setValue("확인");                       // H: 확인
      sheet.getRange(newRow, 17).setValue("[세트]" + setName);          // Q: 비고 - 세트 소속 태그
      // 구성품 행은 일반 서식
      sheet.getRange(newRow, 1, 1, 18).setFontWeight("normal").setBackground(null);
      if (components[i].alt) {
        sheet.getRange(newRow, 10).setValue("대체: " + components[i].alt); // J: 상세
      }

      // ── 카테고리 구성품 감지 → 필터 드롭다운 생성 ──
      const equipInfo = findEquipInData(components[i].name);
      if (!equipInfo) {
        // 장비마스터 D열에 없음 → C열(카테고리)에서 검색
        const categoryItems = findEquipByCatInData(components[i].name);
        if (categoryItems.length > 0) {
          // 해당 카테고리 장비만 드롭다운
          const names = categoryItems.map(function(e) { return e.name; });
          const catRule = SpreadsheetApp.newDataValidation()
            .requireValueInList(names, true)
            .setAllowInvalid(true)  // 현재 카테고리명 유지 (경고만)
            .build();
          sheet.getRange(newRow, 6).setDataValidation(catRule);
          sheet.getRange(newRow, 6).setBackground('#FFEB9C');
          sheet.getRange(newRow, 6).setNote(
            '⚠️ 구체적인 모델을 선택하세요\n' +
            '─────────────\n' +
            names.map(function(n) { return '• ' + n; }).join('\n')
          );
          continue; // 이 행은 일반 드롭다운 적용 스킵
        }
      }
    }
  }

  // 데이터 유효성 재적용 (일반 구성품 행들에만 — 카테고리 행은 이미 위에서 처리)
  const listSheet = ss.getSheetByName("목록");
  if (listSheet) {
    const listLastRow = listSheet.getLastRow();
    if (listLastRow >= 2) {
      const rule = SpreadsheetApp.newDataValidation()
        .requireValueInRange(listSheet.getRange("A2:A" + listLastRow), true)
        .setAllowInvalid(false)
        .build();
      for (let i = 0; i < numComponents; i++) {
        const cellRow = setRow + 1 + i;
        // 카테고리 행(노란색)은 이미 필터 드롭다운이 설정됨 → 스킵
        if (sheet.getRange(cellRow, 6).getBackground() !== '#ffeb9c') {
          sheet.getRange(cellRow, 6).setDataValidation(rule);
        }
      }
    }
  }
}

/**
 * 세트마스터에서 구성품 조회 (가용체크=Y만)
 */
function getSetComponents(name, setSheet) {
  if (!name) return [];
  if (!setSheet) return [];
  const lastRow = setSheet.getLastRow();
  if (lastRow < 2) return [];

  var lastCol = Math.max(setSheet.getLastColumn(), 5);
  const data = setSheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  // A: 세트명, B: 구성장비명, C: 수량, D: 비고, E: 대체가능장비, F: 가용체크(없으면 전부 포함)
  const items = data.filter(row => {
    if (row[0].toString().trim() !== name.toString().trim()) return false;
    var componentName = String(row[1] || "").trim();
    if (!componentName) return false;
    var flag = (row.length > 5) ? row[5].toString().trim() : "";
    return flag === "Y" || flag === "";  // F열 없거나 비어있으면 포함
  });

  return items.map(row => ({
    name: String(row[1] || "").trim(),
    qty: row[2] || 1,
    alt: row[4] || ""
  }));
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 예약 등록 — 같은 요청ID 일괄
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 비동기 등록 — 1초 후 시간 기반 트리거로 registerByReqID 실행.
 * API에서 즉시 응답을 반환하고, 실제 등록은 백그라운드에서 처리.
 * @param {string} reqID - 요청 ID (RQ-YYMMDD-NNN)
 */
function scheduleRegister(reqID) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("확인요청");
  if (!sheet) return { success: false, error: "확인요청 시트 없음" };

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return { success: false, error: "데이터 없음" };

  var allData = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  var targetRow = -1;
  for (var i = 0; i < allData.length; i++) {
    if (allData[i][0] === reqID) { targetRow = i + 2; break; }
  }
  if (targetRow < 0) return { success: false, error: "요청ID를 찾을 수 없음: " + reqID };

  // O열에 처리중 표시
  sheet.getRange(targetRow, 15).setValue("⏳ 등록 처리중...");

  // PropertiesService에 reqID + targetRow 저장 (트리거에서 읽기 위해)
  PropertiesService.getScriptProperties().setProperty("_pendingRegister", JSON.stringify({ reqID: reqID, row: targetRow }));

  // 1초 후 실행되는 트리거 생성
  ScriptApp.newTrigger("_runPendingRegister")
    .timeBased()
    .after(1000)
    .create();

  return { success: true, message: "등록이 백그라운드에서 시작됩니다. 1~3분 후 완료됩니다.", reqID: reqID };
}

/**
 * 시간 기반 트리거에서 호출 — pendingRegister 처리
 */
function _runPendingRegister() {
  // 트리거 자기 자신 삭제
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function(t) {
    if (t.getHandlerFunction() === "_runPendingRegister") {
      ScriptApp.deleteTrigger(t);
    }
  });

  var prop = PropertiesService.getScriptProperties().getProperty("_pendingRegister");
  if (!prop) return;
  PropertiesService.getScriptProperties().deleteProperty("_pendingRegister");

  var info = JSON.parse(prop);
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("확인요청");
  if (!sheet) return;

  try {
    registerByReqID(sheet, info.row);
  } catch (e) {
    sheet.getRange(info.row, 15).setValue("❌ 등록 실패: " + e.message);
  }
}

/**
 * 특정 행의 요청ID를 기준으로 같은 ID의 모든 행을 일괄 등록
 */
function registerByReqID(sheet, triggerRow) {
  // ── 전체 등록 프로세스 직렬화 (동시 실행 방지) ──
  var regLock = LockService.getScriptLock();
  if (!regLock.tryLock(30000)) {
    sheet.getRange(triggerRow, 15).setValue("⏳ 등록대기");
    sheet.getRange(triggerRow, 15).setBackground("#E8F0FE");
    return;
  }
  try {
  // 락 획득 후 시트 데이터를 새로 읽어야 정확함
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const contractSheet = ss.getSheetByName("계약마스터");
  const schedSheet = ss.getSheetByName("스케줄상세");
  const setSheet = ss.getSheetByName("세트마스터");
  const equipSheet = ss.getSheetByName("장비마스터");

  let lastRow = sheet.getLastRow();
  let allData = sheet.getRange(2, 1, lastRow - 1, 18).getValues();
  // 시간 컬럼은 displayValue로 대체 (1899 timezone 이슈 방지)
  let regDisplayData = sheet.getRange(2, 1, lastRow - 1, 18).getDisplayValues();
  for (var di = 0; di < allData.length; di++) { allData[di][2] = regDisplayData[di][2]; allData[di][4] = regDisplayData[di][4]; allData[di][11] = regDisplayData[di][11]; }
  const triggerIdx = triggerRow - 2;
  const reqID = allData[triggerIdx][0];

  if (!reqID) {
    sheet.getRange(triggerRow, 15).setValue("❌ 요청ID 없음");
    return;
  }

  // 등록 직전 세트 펼침/가용확인을 한 번 더 보장한다.
  // 배치 입력 중 확인 락이 밀리면 I열이 비어 세트가 단품으로 등록될 수 있다.
  _processByReqID(sheet, triggerRow);
  SpreadsheetApp.flush();
  lastRow = sheet.getLastRow();
  allData = sheet.getRange(2, 1, lastRow - 1, 18).getValues();
  regDisplayData = sheet.getRange(2, 1, lastRow - 1, 18).getDisplayValues();
  for (var rdi = 0; rdi < allData.length; rdi++) {
    allData[rdi][2] = regDisplayData[rdi][2];
    allData[rdi][4] = regDisplayData[rdi][4];
    allData[rdi][11] = regDisplayData[rdi][11];
  }

  // ── 예약자명 확인 ──
  let 예약자명, 연락처, 할인유형;
  for (let i = 0; i < allData.length; i++) {
    if (allData[i][0] !== reqID) continue;
    if (allData[i][10]) { 예약자명 = allData[i][10]; }  // K열
    if (allData[i][11]) { 연락처 = allData[i][11]; }    // L열
    if (allData[i][12]) { 할인유형 = allData[i][12]; }  // M열 (과거 업체명 → 현재 할인유형)
  }

  if (!예약자명) {
    sheet.getRange(triggerRow, 15).setValue("❌ 예약자명 입력 필요");
    sheet.getRange(triggerRow, 14).clearContent();
    return;
  }

  if (!연락처 && 예약자명) {
    var dbSheet = ss.getSheetByName("고객DB");
    if (dbSheet && dbSheet.getLastRow() >= 2) {
      var dbData = dbSheet.getDataRange().getValues();
      var matches2 = [];
      for (var di2 = 1; di2 < dbData.length; di2++) {
        if (String(dbData[di2][1]).trim() === String(예약자명).trim()) {
          matches2.push(String(dbData[di2][0]).trim());
        }
      }
      if (matches2.length === 1) {
        연락처 = matches2[0];
        for (var fi = 0; fi < allData.length; fi++) {
          if (allData[fi][0] === reqID && allData[fi][10]) {
            sheet.getRange(fi + 2, 12).setValue(연락처);
            break;
          }
        }
      } else if (matches2.length > 1) {
        // 동명이인 → 연락처 직접 입력 필요
        sheet.getRange(triggerRow, 15).setValue("❌ 동명이인 " + matches2.length + "명 존재 — 연락처 직접 입력 필요");
        sheet.getRange(triggerRow, 15).setBackground("#FFC7CE");
        sheet.getRange(triggerRow, 14).clearContent();
        return;
      }
    }
  }

  if (!연락처) {
    sheet.getRange(triggerRow, 15).setValue("❌ 연락처 입력 필요");
    sheet.getRange(triggerRow, 14).clearContent();
    return;
  }

  // ── 이미 등록된 건인지 확인 (거절/보류된 건은 재등록 허용) ──
  var hasCompleted = false;
  var hasRejectedOrHeld = false;
  for (let i = 0; i < allData.length; i++) {
    if (allData[i][0] === reqID) {
      var rowStatus = String(allData[i][14] || "").trim();
      if (rowStatus === "등록완료") hasCompleted = true;
      if (rowStatus === "거절" || rowStatus === "보류") hasRejectedOrHeld = true;
    }
  }
  if (hasCompleted && !hasRejectedOrHeld) {
    sheet.getRange(triggerRow, 15).setValue("⚠️ 이미 등록됨");
    return;
  }
  // 거절/보류 후 재등록 시 기존 상태 초기화 (시트 + 메모리 allData 양쪽)
  if (hasRejectedOrHeld) {
    for (let i = 0; i < allData.length; i++) {
      if (allData[i][0] === reqID) {
        var rs = String(allData[i][14] || "").trim();
        if (rs === "거절" || rs === "보류" || rs === "등록완료") {
          sheet.getRange(i + 2, 14).clearContent();  // N열 초기화
          sheet.getRange(i + 2, 15).clearContent();  // O열 초기화
          sheet.getRange(i + 2, 15).setBackground(null);
          allData[i][14] = "";  // 메모리도 초기화 (스케줄상세 등록 시 스킵 방지)
        }
      }
    }
    SpreadsheetApp.flush();
  }

  // ── O열 재확인 (동시 클릭 대비 — 락 안에서 실행) ──
  var recheckData = sheet.getRange(2, 1, lastRow - 1, 15).getValues();
  for (let i = 0; i < recheckData.length; i++) {
    if (recheckData[i][0] === reqID && recheckData[i][14] === "등록완료") {
      sheet.getRange(triggerRow, 15).setValue("⚠️ 이미 등록됨");
      sheet.getRange(triggerRow, 14).clearContent();
      return;
    }
  }

  // ── 스케줄상세 중복 등록 체크 ──
  var dupDate = "";
  var dupEquips = [];
  for (var di = 0; di < allData.length; di++) {
    if (allData[di][0] !== reqID) continue;
    if (allData[di][14] === "거절" || allData[di][14] === "보류") continue;
    if (allData[di][1]) {
      var dv = allData[di][1];
      dupDate = dv instanceof Date ? Utilities.formatDate(dv, "Asia/Seoul", "yyyy-MM-dd") : String(dv).trim();
    }
    if (allData[di][5]) dupEquips.push(String(allData[di][5]).trim());
  }
  if (dupDate && dupEquips.length > 0 && 예약자명) {
    var dupTid = checkDuplicateRequest(ss, 예약자명, dupDate, dupEquips);
    if (dupTid) {
      sheet.getRange(triggerRow, 15).setValue("⚠️ 중복: 동일 건이 이미 등록됨 (거래ID: " + dupTid + ")");
      sheet.getRange(triggerRow, 14).clearContent();
      return;
    }
  }

  // ── 카테고리 미선택 장비 체크 (세트 구성품 중 구체 모델 미선택 차단) ──
  const 미선택목록 = [];
  for (let i = 0; i < allData.length; i++) {
    if (allData[i][0] !== reqID) continue;
    const 장비명 = allData[i][5]; // F열
    if (!장비명) continue;
    if (String(allData[i][8]) === "세트") continue; // 세트 헤더 스킵
    const eqCheck = findEquipment(장비명, equipSheet);
    if (!eqCheck) {
      const catItems = findEquipmentByCategory(장비명, equipSheet);
      if (catItems.length > 0) {
        미선택목록.push(장비명);
      }
    }
  }
  if (미선택목록.length > 0) {
    sheet.getRange(triggerRow, 15).setValue("❌ 모델 미선택: " + 미선택목록.join(", ") + " → F열에서 구체 모델을 선택하세요");
    sheet.getRange(triggerRow, 15).setBackground("#FFC7CE");
    sheet.getRange(triggerRow, 14).clearContent();
    return;
  }

  // ── 날짜 정보 (첫 행에서) ──
  let 반출일, 반출시간, 반납일, 반납시간;
  for (let i = 0; i < allData.length; i++) {
    if (allData[i][0] === reqID && allData[i][1]) {
      반출일 = allData[i][1];
      반출시간 = allData[i][2];
      반납일 = allData[i][3];
      반납시간 = allData[i][4];
      break;
    }
  }

  if (!반출일 || !반납일) {
    sheet.getRange(triggerRow, 15).setValue("❌ 날짜 정보 없음");
    sheet.getRange(triggerRow, 14).clearContent();
    return;
  }

  // ── 날짜/시간을 문자열로 변환 (Date객체 → 포맷 문자열) ──
  // fmtDT()로 "yyyy-MM-dd HH:mm" 형태 얻은 후 분리
  const 반출dtStr = fmtDT(반출일, 반출시간);
  const 반납dtStr = fmtDT(반납일, 반납시간);
  const 반출일str = 반출dtStr.split(' ')[0] || "";
  const 반출시간str = 반출dtStr.split(' ')[1] || "";
  const 반납일str = 반납dtStr.split(' ')[0] || "";
  const 반납시간str = 반납dtStr.split(' ')[1] || "";

    // ── 동일 예약자명+일정 기존 거래 합치기 모드 ──
    var mergeMode = false;
    var mergeTargetTID = null;
    if (예약자명 && 반출일str && 반납일str) {
      var _sLR = schedSheet.getLastRow();
      if (_sLR >= 2) {
        var _sData = schedSheet.getRange(2, 1, _sLR - 1, 13).getDisplayValues();
        for (var si = 0; si < _sData.length; si++) {
          if (_sData[si][12] && _sData[si][12].trim() === 예약자명.trim()
              && _sData[si][5] === 반출일str && _sData[si][7] === 반납일str && _sData[si][1]) {
            mergeTargetTID = _sData[si][1];
            break;
          }
        }
      }
      if (mergeTargetTID) mergeMode = true;
    }

  // ── 거래ID 생성: YYMMDD-NNN ──
  // 개고생2.0 거래내역과 동일한 포맷 사용
  const now = new Date();
  const dateStr = Utilities.formatDate(now, "Asia/Seoul", "yyMMdd");
  const prefix거래 = dateStr;
  const contractLastRow = contractSheet.getLastRow();
  let maxNum = 0;

  if (contractLastRow >= 2) {
    const ids = contractSheet.getRange(2, 1, contractLastRow - 1, 1).getValues().flat();
    ids.forEach(id => {
      if (id && id.toString().startsWith(prefix거래 + "-")) {
        const parts = id.toString().split("-");
        const num = parseInt(parts[1]);
        if (num > maxNum) maxNum = num;
      }
    });
  }

  // 개고생2.0 거래내역도 확인 (연결된 경우)
  // 2026-04-23 컬럼 재배치: 거래ID D(4) → E(5)
  try {
    const 개고생URL = PropertiesService.getScriptProperties().getProperty("개고생2_URL");
    if (개고생URL) {
      const 개고생SS = SpreadsheetApp.openByUrl(개고생URL);
      const 거래시트 = 개고생SS.getSheetByName("거래내역");
      if (거래시트) {
          // E열(거래ID) 기준 실제 마지막 데이터 행 (data validation 빈 행 무시)
            const _dCol = 거래시트.getRange(2, 5, Math.max(1, 거래시트.getLastRow() - 1), 1).getValues();
            let 거래lastRow = 1;
            for (let ri = _dCol.length - 1; ri >= 0; ri--) {
              if (_dCol[ri][0] !== "" && _dCol[ri][0] != null) { 거래lastRow = ri + 2; break; }
            }
            if (거래lastRow >= 2) {
          const 거래ids = 거래시트.getRange(2, 5, 거래lastRow - 1, 1).getValues().flat();
          거래ids.forEach(id => {
            if (id && id.toString().startsWith(prefix거래 + "-")) {
              const parts = id.toString().split("-");
              const num = parseInt(parts[1]);
              if (num > maxNum) maxNum = num;
            }
          });
        }
      }
    }
  } catch (err) {
    // 개고생2.0 접근 실패 시 무시 (로컬 번호만 사용)
  }

    var 거래ID;
    if (mergeMode && mergeTargetTID) {
      거래ID = mergeTargetTID;
    } else {
      거래ID = `${prefix거래}-${String(maxNum + 1).padStart(3, "0")}`;
    }

  // ── 회차 계산 (24시간=1회차, 6시간 이내 초과는 같은 회차) ──
  var 회차 = 1;
  try {
    var startDT = parseDT(반출일str, 반출시간str);
    var endDT = parseDT(반납일str, 반납시간str);
    if (startDT && endDT && endDT > startDT) {
      var totalHours = (endDT - startDT) / (1000 * 60 * 60);
      회차 = Math.max(1, Math.ceil((totalHours - 6) / 24));
    }
  } catch (e) { }

    if (!mergeMode) {
  // ── 계약마스터에 등록 (A~L, 12열) — K=할인유형, L=비고 ──
  const newContractRow = contractLastRow + 1;
  contractSheet.getRange(newContractRow, 1, 1, 12).setValues([[
    거래ID, 예약자명, 연락처 || "", "",    // D 업체명/별명은 공란 (필요 시 수동)
    반출일str, 반출시간str, 반납일str, 반납시간str,
    회차, "예약", 할인유형 || "일반", ""
  ]]);
    }


    // ── 스케줄상세에 장비 등록 (세트 헤더/구성품/개별 구분) ──
    let schedLastRow = schedSheet.getLastRow();
    let schedCount = 0;
    // 합치기 모드: 기존 거래의 최대 스케줄 번호부터 이어가기
    if (mergeMode && mergeTargetTID && schedLastRow >= 2) {
      var _es = schedSheet.getRange(2, 1, schedLastRow - 1, 2).getValues();
      for (var esi = 0; esi < _es.length; esi++) {
        if (String(_es[esi][1]).trim() === mergeTargetTID) {
          var _p = String(_es[esi][0]).split('-');
          var _n = parseInt(_p[_p.length - 1]);
          if (!isNaN(_n) && _n > schedCount) schedCount = _n;
        }
      }
    }
      var mergeSchedOffset = schedCount;
      // --- writeBaseRow: merge mode uses insert position, normal uses bottom ---
      var writeBaseRow = schedLastRow;
      var neededRows = 0;
      for (let ci = 0; ci < allData.length; ci++) {
        if (allData[ci][0] === reqID && allData[ci][5] && allData[ci][14] !== "거절" &&
            allData[ci][14] !== "보류") neededRows++;
      }
      if (mergeMode && mergeTargetTID) {
        var _mrgData = schedSheet.getRange(2, 2, schedLastRow - 1, 1).getValues();
        var mergeLastRow = 0;
        for (var mi = _mrgData.length - 1; mi >= 0; mi--) {
          if (String(_mrgData[mi][0]).trim() === mergeTargetTID) { mergeLastRow = mi + 2; break; }
        }
        if (mergeLastRow > 0) {
          schedSheet.insertRowsAfter(mergeLastRow, neededRows + 2);
          writeBaseRow = mergeLastRow - mergeSchedOffset;
          schedLastRow = schedSheet.getLastRow();
        }
      } else {
        if (schedLastRow + neededRows > schedSheet.getMaxRows()) {
          schedSheet.insertRowsAfter(schedSheet.getMaxRows(), neededRows + 10);
        }
      }

    for (let i = 0; i < allData.length; i++) {
      if (allData[i][0] !== reqID) continue;
      const 장비명 = allData[i][5];
      const 수량 = allData[i][6] || 1;
      if (!장비명) continue;
      if (allData[i][14] === "거절" || allData[i][14] === "보류") continue;

      const 결과 = allData[i][8] || "";   // I열
      const 비고 = allData[i][16] || "";   // Q열

      if (String(결과) === "세트") {
        // ── 세트 헤더: C=세트명, D=세트명, L=세트단가 (세트마스터 G열 기준) ──
        const 세트단가 = findSetPrice(장비명, setSheet);
        schedCount++;
        const setSchedID = `${거래ID}-${String(schedCount).padStart(2, "0")}`;
        const setRow = writeBaseRow + schedCount;
        schedSheet.getRange(setRow, 1, 1, 13).setValues([[
          setSchedID, 거래ID, 장비명, 장비명, 수량,
          반출일str, 반출시간str, 반납일str, 반납시간str,
          "대기", "", 세트단가, 예약자명
        ]]);
        schedSheet.getRange(setRow, 5).setNumberFormat("#,##0");
        schedSheet.getRange(setRow, 12).setNumberFormat("#,##0");
        schedSheet.getRange(setRow, 6, 1, 4).setNumberFormat("@");

      } else if (String(비고).indexOf("[세트]") === 0) {
        // ── 세트 구성품: C=소속세트명, D=구성품명, L=0 ──
        const 소속세트 = String(비고).replace("[세트]", "");
        schedCount++;
        const compID = `${거래ID}-${String(schedCount).padStart(2, "0")}`;
        const compRow = writeBaseRow + schedCount;
        schedSheet.getRange(compRow, 1, 1, 13).setValues([[
          compID, 거래ID, 소속세트, 장비명, 수량,
          반출일str, 반출시간str, 반납일str, 반납시간str,
          "대기", "", 0, 예약자명
        ]]);
        schedSheet.getRange(compRow, 5).setNumberFormat("#,##0");
        schedSheet.getRange(compRow, 12).setNumberFormat("#,##0");
        schedSheet.getRange(compRow, 6, 1, 4).setNumberFormat("@");

      } else {
        // ── 단독 품목: 우리 시스템에서는 세트명이 사용자-facing 장비명이다. C=장비명, D=장비명. ──
        const 단가 = findSetPrice(장비명, setSheet);
        schedCount++;
        const schedID = `${거래ID}-${String(schedCount).padStart(2, "0")}`;
        const newRow = writeBaseRow + schedCount;
        schedSheet.getRange(newRow, 1, 1, 13).setValues([[
          schedID, 거래ID, 장비명, 장비명, 수량,
          반출일str, 반출시간str, 반납일str, 반납시간str,
          "대기", "", 단가, 예약자명
        ]]);
        schedSheet.getRange(newRow, 5).setNumberFormat("#,##0");
        schedSheet.getRange(newRow, 12).setNumberFormat("#,##0");
        schedSheet.getRange(newRow, 6, 1, 4).setNumberFormat("@");
      }
    }

  // ── 스케줄상세 가독성 포맷팅 ──
  formatScheduleSheet(schedSheet);

    if (!mergeMode) {
  // ── 개고생2.0 거래내역 입력 ──
  sheet.getRange(triggerRow, 15).setValue("⏳ 개고생2.0 입력 중...");
  try {
    const 개고생URL = PropertiesService.getScriptProperties().getProperty("개고생2_URL");
    if (!개고생URL) throw new Error("개고생2_URL 미설정");
    const 개고생SS = SpreadsheetApp.openByUrl(개고생URL);
    const 거래시트 = 개고생SS.getSheetByName("거래내역");
    if (!거래시트) throw new Error("거래내역 시트 없음");
    const _aCol = 거래시트.getRange(2, 1, Math.max(1, 거래시트.getLastRow() - 1), 1).getValues();
    let 거래newRow = 2;
    for (let ri = _aCol.length - 1; ri >= 0; ri--) {
      if (_aCol[ri][0] !== "" && _aCol[ri][0] != null) { 거래newRow = ri + 3; break; }
    }
    // 2026-04-23 컬럼 재배치 반영:
    //   A(1)=날짜, B(2)=예약자명, C(3)=계약서링크, D(4)=입금자명,
    //   E(5)=거래ID, F(6)=연락처
    거래시트.getRange(거래newRow, 1).setValue(반출일);           // A: 날짜
    거래시트.getRange(거래newRow, 2).setValue(예약자명);         // B: 예약자명
    거래시트.getRange(거래newRow, 5).setValue(거래ID);           // E: 거래ID (구 D=4)
    거래시트.getRange(거래newRow, 6).setNumberFormat("@").setValue(String(연락처 || ""));  // F: 연락처 (구 E=5)
    sheet.getRange(triggerRow, 15).setValue("✅ 개고생2.0 입력완료 (행" + 거래newRow + ")");

    // ── 개고생2.0 고객DB에 신규고객 저장 ──
    // 고객DB 구조: A=연락처(예약자ID), B=성함, C=소속
    try {
      var 고객DB시트 = 개고생SS.getSheetByName("고객DB");
      if (고객DB시트 && 연락처 && 예약자명) {
        var 고객lastRow = 고객DB시트.getLastRow();
        var 기존여부 = false;
        if (고객lastRow >= 2) {
          var 고객data = 고객DB시트.getRange(2, 1, 고객lastRow - 1, 2).getValues();
          var telClean = String(연락처).replace(/[-\s]/g, "");
          for (var gi = 0; gi < 고객data.length; gi++) {
            var existTel = String(고객data[gi][0] || "").replace(/[-\s]/g, "");
            var existName = String(고객data[gi][1] || "").trim();
            if (existTel === telClean || existName === String(예약자명).trim()) {
              기존여부 = true;
              break;
            }
          }
        }
        if (!기존여부) {
          var 고객newRow = 고객lastRow + 1;
          고객DB시트.getRange(고객newRow, 1).setNumberFormat("@").setValue(String(연락처));
          고객DB시트.getRange(고객newRow, 2).setValue(예약자명);
          // C 업체명, D 할인유형 은 수동 관리 (단골/제휴는 사장이 직접 지정)
          Logger.log("신규고객 저장: " + 예약자명 + " " + 연락처);
        }
      }
    } catch (dbErr) {
      Logger.log("고객DB 저장 실패 (계속 진행): " + dbErr.message);
    }
  } catch (err) {
    sheet.getRange(triggerRow, 15).setValue("❌ 개고생2.0 실패: " + err.message);
  }

  // ── R열 추가요청 수집 ──
  var 추가요청목록 = [];
  for (let i = 0; i < allData.length; i++) {
    if (allData[i][0] !== reqID) continue;
    var 추가 = String(allData[i][17] || "").trim();  // R열 (18번째, 인덱스 17)
    if (추가) 추가요청목록.push(추가);
  }
  var 추가요청텍스트 = 추가요청목록.join("\n");

  // ── 계약서 생성 (개고생2.0 입력 후 처리) ──
  try {
    const templateId = PropertiesService.getScriptProperties().getProperty("CONTRACT_TEMPLATE_ID");
    if (templateId) {
      const result = generateContractFile(ss, 거래ID, 추가요청텍스트);
    }
  } catch (err) {
  }
    } // end !mergeMode (skip 개고생2.0 + 계약서)

  // ── 확인요청에 등록 결과 표시 ──
  for (let i = 0; i < allData.length; i++) {
    if (allData[i][0] !== reqID) continue;
      if (allData[i][14] === '거절' || allData[i][14] === '보류') continue;  // 거절/보류 스킵
    const row = i + 2;
    sheet.getRange(row, 14).setValue("등록");      // N열: 등록
      sheet.getRange(row, 15).setValue(mergeMode ? "등록완료(합침)" : "등록완료");   // O열: 등록상태
    sheet.getRange(row, 16).setValue(거래ID);       // P열: 거래ID
    sheet.getRange(row, 15, 1, 2).setBackground("#C6EFCE");
  }

  // ── 등록완료 알림톡 — 비활성화 (코워크 에이전트가 카톡으로 직접 발송) ──
  // 반출/반납 안내톡(checkGuideAlimtalk)은 유지됨

  // dashboard/timeline 캐시 즉시 무효화 → 새로고침 안 해도 다음 fetch는 fresh
  try { invalidateDashboardCache(); } catch (e) {}
  try { invalidateTimelineCache(); } catch (e2) {}

  } finally {
    regLock.releaseLock();
  }

  // ── 대기열 자동 처리: "등록대기" 상태인 건 순차 처리 ──
  processRegistrationQueue_(sheet);
}


/**
 * 등록대기 건 순차 처리
 * O열이 "등록대기"인 행을 찾아서 하나씩 registerByReqID 호출
 */
function processRegistrationQueue_(sheet) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  var oCol = sheet.getRange(2, 15, lastRow - 1, 1).getValues(); // O열
  var aCol = sheet.getRange(2, 1, lastRow - 1, 1).getValues();  // A열
  var processedReqIDs = new Set();

  for (var i = 0; i < oCol.length; i++) {
    if (String(oCol[i][0]).trim() !== "⏳ 등록대기") continue;
    var pendingReqID = String(aCol[i][0]).trim();
    if (!pendingReqID || processedReqIDs.has(pendingReqID)) continue;

    processedReqIDs.add(pendingReqID);
    var pendingRow = i + 2;

    // 대기 상태 표시 업데이트
    sheet.getRange(pendingRow, 15).setValue("⏳ 등록 처리 중...");
    SpreadsheetApp.flush();

    // 등록 실행
    registerByReqID(sheet, pendingRow);
  }
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 수정 워크플로 (추가 / 삭제 / 날짜변경)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 거래ID 형식 판별 (YYMMDD-NNN)
 * reqID(RQ-...)와 구분하기 위해 사용
 */
function isTradeID(val) {
  return /^\d{6}-\d{3}$/.test(String(val || ""));
}

/**
 * 수정 행의 H열 "확인" 처리
 * A열에 거래ID가 있는 경우: 계약마스터에서 날짜를 가져와 가용 확인
 */
function checkModificationItem(sheet, row) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const schedSheet = ss.getSheetByName("스케줄상세");
  const equipSheet = ss.getSheetByName("장비마스터");
  const contractSheet = ss.getSheetByName("계약마스터");

  const 거래ID = sheet.getRange(row, 1).getValue().toString().trim();
  const 장비명 = sheet.getRange(row, 6).getValue().toString().trim();
  const 수량 = sheet.getRange(row, 7).getValue() || 1;

  if (!장비명) {
    sheet.getRange(row, 9).setValue("❌ 장비명 없음");
    return;
  }

  // 계약마스터에서 날짜 가져오기
  const contractLastRow = contractSheet.getLastRow();
  if (contractLastRow < 2) { sheet.getRange(row, 9).setValue("❌ 계약마스터 없음"); return; }

  const contractData = contractSheet.getRange(2, 1, contractLastRow - 1, 8).getValues();
  let 반출일, 반출시간, 반납일, 반납시간;
  for (let i = 0; i < contractData.length; i++) {
    if (contractData[i][0] === 거래ID) {
      반출일 = contractData[i][4];
      반출시간 = contractData[i][5];
      반납일 = contractData[i][6];
      반납시간 = contractData[i][7];
      break;
    }
  }

  if (!반출일 || !반납일) {
    sheet.getRange(row, 9).setValue("❌ 계약마스터에 해당 거래ID 없음");
    return;
  }

  const schedData = getScheduleData(schedSheet);
  checkSingleRowWithData(sheet, row, 거래ID, 반출일, 반출시간, 반납일, 반납시간, 장비명, 수량, schedData, equipSheet);
  sheet.getRange(row, 8).setValue("확인");
}


/**
 * N열 "추가" → 스케줄상세에 장비 1행 추가 + 계약서 재생성
 */
function addEquipmentToContract(sheet, row) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const schedSheet = ss.getSheetByName("스케줄상세");
  const equipSheet = ss.getSheetByName("장비마스터");
  const contractSheet = ss.getSheetByName("계약마스터");

  const 거래ID = sheet.getRange(row, 1).getValue().toString().trim();
  const 장비명 = sheet.getRange(row, 6).getValue().toString().trim();
  const 수량 = sheet.getRange(row, 7).getValue() || 1;
  const 가용결과 = sheet.getRange(row, 9).getValue().toString();

  if (!거래ID || !장비명) {
    sheet.getRange(row, 15).setValue("❌ 거래ID 또는 장비명 없음");
    sheet.getRange(row, 14).clearContent();
    return;
  }

  // 가용 경고 여부 (차단하지 않고 경고만)
  var 가용경고 = "";
  if (가용결과.indexOf("✅") < 0) {
    가용경고 = 가용결과 || "미확인";
  }

  // 계약마스터에서 날짜 가져오기
  const contractData = contractSheet.getRange(2, 1, Math.max(1, contractSheet.getLastRow() - 1), 8).getValues();
  let 반출일str, 반출시간str, 반납일str, 반납시간str;
  const fmtDate = (d) => { if (!d) return ""; if (d instanceof Date) return Utilities.formatDate(d, "Asia/Seoul", "yyyy-MM-dd"); return String(d); };
  const fmtTime = (d) => { if (!d) return ""; if (d instanceof Date) { return Utilities.formatDate(d, 'Asia/Seoul', 'HH:mm'); } return String(d); };

  var 예약자명_add = "";
  for (let i = 0; i < contractData.length; i++) {
    if (contractData[i][0] === 거래ID) {
      예약자명_add = String(contractData[i][1] || "").trim();  // B열: 예약자명
      반출일str = fmtDate(contractData[i][4]);
      반출시간str = fmtTime(contractData[i][5]);
      반납일str = fmtDate(contractData[i][6]);
      반납시간str = fmtTime(contractData[i][7]);
      break;
    }
  }

  if (!반출일str) {
    sheet.getRange(row, 15).setValue("❌ 계약마스터에 해당 거래ID 없음");
    sheet.getRange(row, 14).clearContent();
    return;
  }

  // 스케줄상세 마지막 행 뒤에 추가
  const schedLastRow = schedSheet.getLastRow();
  // 해당 거래ID의 스케줄 수 계산 → 다음 schedID 번호
  const existingScheds = schedSheet.getLastRow() >= 2
    ? schedSheet.getRange(2, 2, schedSheet.getLastRow() - 1, 1).getValues().flat().filter(id => id === 거래ID).length
    : 0;
  const newSchedNum = existingScheds + 1;
  const schedID = `${거래ID}-${String(newSchedNum).padStart(2, "0")}`;

  const setSheet = ss.getSheetByName("세트마스터");
  const 단가 = findSetPrice(장비명, setSheet);

  const newRow = schedLastRow + 1;
  schedSheet.getRange(newRow, 1, 1, 13).setValues([[
    schedID, 거래ID, 장비명, 장비명, 수량,
    반출일str, 반출시간str, 반납일str, 반납시간str,
    "대기", "", 단가, 예약자명_add
  ]]);
  schedSheet.getRange(newRow, 5).setNumberFormat("#,##0");
  schedSheet.getRange(newRow, 12).setNumberFormat("#,##0");
  schedSheet.getRange(newRow, 6, 1, 4).setNumberFormat("@");

  formatScheduleSheet(schedSheet);

  sheet.getRange(row, 15).setValue("⏳ 계약서 재생성 중...");

  // 기존 계약서 삭제 후 재생성
  try {
    const result = deleteAndRegenerateContract(ss, 거래ID);
    if (가용경고) {
      sheet.getRange(row, 15).setValue("⚠️ 추가완료 (경고: " + 가용경고 + ") + 계약서 재생성");
      sheet.getRange(row, 15).setBackground("#FFEB9C");
    } else {
      sheet.getRange(row, 15).setValue("✅ 추가완료 + 계약서 재생성");
      sheet.getRange(row, 15).setBackground("#C6EFCE");
    }
  } catch (err) {
    var errMsg = "✅ 추가완료 (계약서 재생성 실패: " + err.message + ")";
    if (가용경고) errMsg = "⚠️ 추가완료 (경고: " + 가용경고 + ", 계약서 실패: " + err.message + ")";
    sheet.getRange(row, 15).setValue(errMsg);
    sheet.getRange(row, 15).setBackground("#FFEB9C");
  }
}


/**
 * N열 "삭제" → 스케줄상세에서 해당 장비 행 제거 + 계약서 재생성
 */
function removeEquipmentFromContract(sheet, row) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const schedSheet = ss.getSheetByName("스케줄상세");

  const 거래ID = sheet.getRange(row, 1).getValue().toString().trim();
  const 장비명 = sheet.getRange(row, 6).getValue().toString().trim();

  if (!거래ID || !장비명) {
    sheet.getRange(row, 15).setValue("❌ 거래ID 또는 장비명 없음");
    sheet.getRange(row, 14).clearContent();
    return;
  }

  const schedLastRow = schedSheet.getLastRow();
  if (schedLastRow < 2) {
    sheet.getRange(row, 15).setValue("❌ 스케줄상세 데이터 없음");
    sheet.getRange(row, 14).clearContent();
    return;
  }

  // 해당 거래ID + 장비명 매칭 행 찾아서 삭제 (뒤에서부터 삭제해야 행 번호 안 밀림)
  const schedData = schedSheet.getRange(2, 1, schedLastRow - 1, 4).getValues();
  // B열(index 1)=거래ID, D열(index 3)=장비명
  let deletedCount = 0;
  for (let i = schedData.length - 1; i >= 0; i--) {
    if (schedData[i][1] === 거래ID && schedData[i][3] === 장비명) {
      schedSheet.deleteRow(i + 2);
      deletedCount++;
      break; // 1행만 삭제
    }
  }

  if (deletedCount === 0) {
    sheet.getRange(row, 15).setValue("❌ 스케줄상세에서 해당 장비를 찾을 수 없음");
    sheet.getRange(row, 14).clearContent();
    return;
  }

  formatScheduleSheet(schedSheet);

  sheet.getRange(row, 15).setValue("⏳ 계약서 재생성 중...");

  // 기존 계약서 삭제 후 재생성
  try {
    const result = deleteAndRegenerateContract(ss, 거래ID);
    sheet.getRange(row, 15).setValue("✅ 삭제완료 + 계약서 재생성");
    sheet.getRange(row, 15).setBackground("#C6EFCE");
  } catch (err) {
    sheet.getRange(row, 15).setValue("✅ 삭제완료 (계약서 재생성 실패: " + err.message + ")");
    sheet.getRange(row, 15).setBackground("#FFEB9C");
  }
}


/**
 * N열 "날짜변경" → 계약마스터 + 스케줄상세 + 개고생2.0 날짜 일괄 수정 + 계약서 재생성
 * B~E열에 새 날짜/시간 입력 필요
 */
function changeDatesForContract(sheet, row) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const schedSheet = ss.getSheetByName("스케줄상세");
  const contractSheet = ss.getSheetByName("계약마스터");
  const equipSheet = ss.getSheetByName("장비마스터");

  const 거래ID = sheet.getRange(row, 1).getValue().toString().trim();
  const rowDisplayValues = sheet.getRange(row, 1, 1, 5).getDisplayValues()[0];
  const 새반출일Raw = sheet.getRange(row, 2).getValue();
  const 새반출시간str = rowDisplayValues[2]; // C열 displayValue
  const 새반납일Raw = sheet.getRange(row, 4).getValue();
  const 새반납시간str = rowDisplayValues[4]; // E열 displayValue

  if (!거래ID) {
    sheet.getRange(row, 15).setValue("❌ A열에 거래ID 입력 필요");
    sheet.getRange(row, 14).clearContent();
    return;
  }

  if (!새반출일Raw || !새반납일Raw) {
    sheet.getRange(row, 15).setValue("❌ B~E열에 새 반출/반납 일시 입력 필요");
    sheet.getRange(row, 14).clearContent();
    return;
  }

  const fmtDate = (d) => { if (!d) return ""; if (d instanceof Date) return Utilities.formatDate(d, "Asia/Seoul", "yyyy-MM-dd"); return String(d); };
  const 새반출일str = fmtDate(새반출일Raw);
  const 새반납일str = fmtDate(새반납일Raw);

  // 1. 계약마스터 날짜 업데이트
  const contractLastRow = contractSheet.getLastRow();
  let contractRowIndex = -1;
  if (contractLastRow >= 2) {
    const ids = contractSheet.getRange(2, 1, contractLastRow - 1, 1).getValues().flat();
    for (let i = 0; i < ids.length; i++) {
      if (ids[i] === 거래ID) { contractRowIndex = i + 2; break; }
    }
  }

  if (contractRowIndex < 0) {
    sheet.getRange(row, 15).setValue("❌ 계약마스터에 해당 거래ID 없음");
    sheet.getRange(row, 14).clearContent();
    return;
  }

  contractSheet.getRange(contractRowIndex, 5).setValue(새반출일str);
  contractSheet.getRange(contractRowIndex, 6).setValue(새반출시간str);
  contractSheet.getRange(contractRowIndex, 7).setValue(새반납일str);
  contractSheet.getRange(contractRowIndex, 8).setValue(새반납시간str);

  // 2. 스케줄상세 해당 거래ID 전체 날짜 업데이트 + 장비 목록 수집
  const schedLastRow = schedSheet.getLastRow();
  const 대상장비목록 = []; // { 장비명, 수량 }
  if (schedLastRow >= 2) {
    const schedRows = schedSheet.getRange(2, 1, schedLastRow - 1, 5).getValues();
    for (let i = 0; i < schedRows.length; i++) {
      if (schedRows[i][1] === 거래ID) {
        schedSheet.getRange(i + 2, 6).setValue(새반출일str);
        schedSheet.getRange(i + 2, 7).setValue(새반출시간str);
        schedSheet.getRange(i + 2, 8).setValue(새반납일str);
        schedSheet.getRange(i + 2, 9).setValue(새반납시간str);
        schedSheet.getRange(i + 2, 6, 1, 4).setNumberFormat("@");
        if (schedRows[i][3]) { // D열: 장비명
          대상장비목록.push({ 장비명: schedRows[i][3], 수량: schedRows[i][4] || 1 });
        }
      }
    }
  }
  SpreadsheetApp.flush();

  // 3. 새 날짜 기준 가용 확인 (해당 거래ID 본인 스케줄 제외)
  const newStartDT = parseDT(새반출일Raw, 새반출시간str);
  const newEndDT = parseDT(새반납일Raw, 새반납시간str);
  const schedData = getScheduleData(schedSheet).filter(s => s.contractID !== 거래ID);

  const 불가목록 = [];
  const 가용목록 = [];

  대상장비목록.forEach(item => {
    const equipInfo = findEquipment(item.장비명, equipSheet);
    if (!equipInfo) { 불가목록.push(item.장비명 + "(미등록)"); return; }
    const 총보유 = equipInfo.total;

    // sweep-line: 요청 기간 내 동시 사용 최대치 계산
    var overlaps = schedData.filter(function(s) {
      return s.equipment === item.장비명 && s.status !== "반납완료" && s.status !== "취소"
        && s.startDT < newEndDT && s.endDT > newStartDT;
    });
    var timePoints = [newStartDT.getTime()];
    overlaps.forEach(function(s) {
      if (s.startDT >= newStartDT && s.startDT < newEndDT) timePoints.push(s.startDT.getTime());
      if (s.endDT > newStartDT && s.endDT < newEndDT) timePoints.push(s.endDT.getTime());
    });
    var maxConcurrent = 0;
    timePoints.forEach(function(tp) {
      var concurrent = 0;
      overlaps.forEach(function(s) {
        if (s.startDT.getTime() <= tp && s.endDT.getTime() > tp) concurrent += s.qty;
      });
      if (concurrent > maxConcurrent) maxConcurrent = concurrent;
    });

    const 가용 = 총보유 - maxConcurrent;
    if (가용 >= item.수량) {
      가용목록.push(item.장비명);
    } else {
      불가목록.push(item.장비명 + "(가용" + 가용 + "/" + item.수량 + ")");
    }
  });

  // 4. 개고생2.0 거래내역 A열(반출일) 업데이트
  // 2026-04-23 컬럼 재배치: 거래ID D(4) → E(5). A열(반출일)은 위치 안 바뀜.
  try {
    const 개고생URL = PropertiesService.getScriptProperties().getProperty("개고생2_URL");
    if (개고생URL) {
      const 거래시트 = SpreadsheetApp.openByUrl(개고생URL).getSheetByName("거래내역");
      if (거래시트) {
        const ids = 거래시트.getRange(2, 5, Math.max(1, 거래시트.getLastRow() - 1), 1).getValues().flat();
        for (let i = 0; i < ids.length; i++) {
          if (ids[i] === 거래ID) { 거래시트.getRange(i + 2, 1).setValue(새반출일Raw); break; }
        }
      }
    }
  } catch (err) { }

  // 5. 기존 계약서 삭제 후 재생성
  sheet.getRange(row, 15).setValue("⏳ 계약서 재생성 중...");
  let statusMsg;
  try {
    deleteAndRegenerateContract(ss, 거래ID);
    if (불가목록.length > 0) {
      statusMsg = "✅ 날짜변경완료 | ❌ 불가장비: " + 불가목록.join(", ");
      sheet.getRange(row, 15).setBackground("#FFEB9C");
    } else {
      statusMsg = "✅ 날짜변경완료 + 전체 가용";
      sheet.getRange(row, 15).setBackground("#C6EFCE");
    }
  } catch (err) {
    statusMsg = "✅ 날짜변경완료 (계약서 재생성 실패: " + err.message + ")";
    if (불가목록.length > 0) statusMsg += " | ❌ 불가: " + 불가목록.join(", ");
    sheet.getRange(row, 15).setBackground("#FFEB9C");
  }
  sheet.getRange(row, 15).setValue(statusMsg);
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 웹앱 API → sheetAPI.js로 통합됨
// doGet/doPost/doScanAll/doListPending는 sheetAPI.js에서 처리
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 보류 처리 — 같은 요청ID의 모든 행
 */
function holdByReqID(sheet, allData, reqID) {
  for (let i = 0; i < allData.length; i++) {
    if (allData[i][0] !== reqID) continue;
    const row = i + 2;
    sheet.getRange(row, 15).setValue("보류");     // O열: 등록상태
    sheet.getRange(row, 14).clearContent();       // N열: 등록 드롭다운 초기화
    sheet.getRange(row, 15).setBackground("#FFEB9C");  // 노란색
  }
}

/**
 * 거절 처리 — 같은 요청ID의 모든 행
 */
function rejectByReqID(sheet, allData, reqID) {
  for (let i = 0; i < allData.length; i++) {
    if (allData[i][0] !== reqID) continue;
    const row = i + 2;
    sheet.getRange(row, 15).setValue("거절");     // O열: 등록상태
    sheet.getRange(row, 14).clearContent();       // N열: 등록 드롭다운 초기화
    sheet.getRange(row, 15).setBackground("#FFC7CE");  // 빨간색
  }
}

// jsonResponse()는 sheetAPI.js에 통합 정의됨


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 유틸리티 함수
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 스케줄상세 중복 등록 체크: 같은 예약자명 + 반출일 + 장비목록
 * @param {Spreadsheet} ss
 * @param {string} 예약자명
 * @param {string} 반출일 - "yyyy-MM-dd" 문자열 또는 Date
 * @param {string[]} 장비목록 - 장비명 배열
 * @returns {string|null} 중복 거래ID 또는 null
 */
function checkDuplicateRequest(ss, 예약자명, 반출일, 장비목록) {
  if (!예약자명 || !반출일 || !장비목록 || 장비목록.length === 0) return null;

  var schedSheet = ss.getSheetByName("스케줄상세");
  var contractSheet = ss.getSheetByName("계약마스터");
  if (!schedSheet || schedSheet.getLastRow() < 2) return null;
  if (!contractSheet || contractSheet.getLastRow() < 2) return null;

  var dupDate = _confirmRequestDateKey_(반출일);
  var dupEquipArr = 장비목록.map(function(e) { return String(e).trim(); }).filter(function(e) { return e; });

  // 계약마스터에서 거래ID → 예약자명 매핑
  var cMap = {};
  contractSheet.getRange(2, 1, contractSheet.getLastRow() - 1, 2).getValues().forEach(function(r) {
    if (r[0]) cMap[r[0]] = String(r[1] || "").trim();
  });

  // 스케줄상세: 거래ID별 반출일 + 장비목록
  var schedData = schedSheet.getRange(2, 1, schedSheet.getLastRow() - 1, 6).getValues();
  var schedGroups = {};
  for (var si = 0; si < schedData.length; si++) {
    var tid = schedData[si][1];  // B: 거래ID
    if (!tid) continue;
    if (!schedGroups[tid]) schedGroups[tid] = { date: "", equips: [] };
    if (schedData[si][5]) {  // F: 반출일
      var sv = schedData[si][5];
      schedGroups[tid].date = _confirmRequestDateKey_(sv);
    }
    if (schedData[si][3]) schedGroups[tid].equips.push(String(schedData[si][3]).trim());  // D: 장비명
  }
  for (var tid in schedGroups) {
    var sg = schedGroups[tid];
    var schedName = cMap[tid] || "";
    if (schedName === 예약자명 && sg.date === dupDate && _confirmRequestContainsAllEquip_(sg.equips, dupEquipArr)) {
      return tid;
    }
  }
  return null;
}

/**
 * 날짜 + 시간 합치기
 */
// combineDT → parseDT로 통합됨 (308행)

/**
 * 스케줄상세 데이터 미리 읽기 (성능 최적화)
 */
function getScheduleData(schedSheet) {
  const lastRow = schedSheet.getLastRow();
  if (lastRow < 2) return [];

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const contractSheet = ss.getSheetByName("계약마스터");

  // 계약마스터에서 예약자명 매핑
  const contractMap = {};
  const contractLastRow = contractSheet.getLastRow();
  if (contractLastRow >= 2) {
    const contracts = contractSheet.getRange(2, 1, contractLastRow - 1, 4).getValues();
    contracts.forEach(row => {
      contractMap[row[0]] = row[1] || ""; // A: 거래ID → B: 예약자명
    });
  }

  const data = schedSheet.getRange(2, 1, lastRow - 1, 11).getValues();
  return data.map(row => ({
    schedID: row[0],       // A
    contractID: row[1],    // B: 거래ID
    contractName: contractMap[row[1]] || "",
    setName: row[2],       // C: 세트명
    equipment: row[3],     // D: 장비명
    qty: row[4] || 1,      // E: 수량
    startDT: parseDT(row[5], row[6]),  // F,G: 반출일,시간
    endDT: parseDT(row[7], row[8]),    // H,I: 반납일,시간
    status: row[9],        // J: 반출상태
    note: row[10]          // K: 비고
  })).filter(s => s.startDT && s.endDT);
}

/**
 * 장비마스터에서 장비 정보 조회 (보유수량 확인용)
 * 장비마스터: A:대분류, B:장비ID, C:카테고리, D:장비명, E:총보유수량,
 *   F:가용수량, G:대여중수량, H:정비중수량, I:상태, J:비고, K:최근실사, L:단가(레거시)
 */
function findEquipment(name, equipSheet) {
  const lastRow = equipSheet.getLastRow();
  if (lastRow < 2) return null;

  const data = equipSheet.getRange(2, 1, lastRow - 1, 12).getValues();
  for (let i = 0; i < data.length; i++) {
    if (data[i][3] === name) {
      return { total: data[i][4] || 0, 단가: data[i][11] || 0 };
    }
  }
  return null;
}

/**
 * 세트마스터에서 단가 조회 (단가는 세트마스터 G열 기준)
 * 세트마스터: A:세트명, B:구성장비명, C:수량, D:비고, E:대체가능장비, F:가용체크, G:단가
 * - 세트 상품: 첫 행(A열=세트명, B열=비어있지않음)의 G열 단가 사용
 * - 개별 장비: A열=장비명, B열=빈칸인 행의 G열 단가 사용
 */
function findSetPrice(name, setSheet) {
  if (!setSheet) return 0;
  const lastRow = setSheet.getLastRow();
  if (lastRow < 2) return 0;

  const data = setSheet.getRange(2, 1, lastRow - 1, 7).getValues();
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][0]).trim() === String(name).trim()) {
      // 세트 상품: 첫 행에 단가 / 개별 장비: 해당 행에 단가
      if (data[i][6]) return data[i][6];
    }
  }
  return 0;
}

function isSetMasterName(name, setSheet) {
  if (!name || !setSheet) return false;
  const lastRow = setSheet.getLastRow();
  if (lastRow < 2) return false;

  const target = String(name).trim();
  const names = setSheet.getRange(2, 1, lastRow - 1, 1).getValues();
  for (let i = 0; i < names.length; i++) {
    if (String(names[i][0] || "").trim() === target) return true;
  }
  return false;
}

/**
 * 장비마스터 C열(카테고리)로 해당 카테고리에 속하는 구체 장비 목록 반환
 * 예: findEquipmentByCategory("7인치 모니터") → [{name:"티비로직 7인치",...}, {name:"스몰HD 7인치",...}]
 */
function findEquipmentByCategory(categoryName, equipSheet) {
  const lastRow = equipSheet.getLastRow();
  if (lastRow < 2) return [];
  const data = equipSheet.getRange(2, 1, lastRow - 1, 12).getValues();
  const items = [];
  for (let i = 0; i < data.length; i++) {
    if (String(data[i][2]).trim() === String(categoryName).trim() && data[i][3]) {
      items.push({ name: data[i][3], total: data[i][4] || 0, 단가: data[i][11] || 0 });
    }
  }
  return items;
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 수동 실행 (메뉴용 — 백업)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 미처리 건 전체 수동 확인
 */
function manualProcessAll() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("확인요청");
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) {
    SpreadsheetApp.getUi().alert("처리할 데이터가 없습니다.");
    return;
  }

  const data = sheet.getRange(2, 1, lastRow - 1, 17).getValues();
  let count = 0;

  const processedIDs = new Set();
  for (let i = 0; i < data.length; i++) {
    if (data[i][7] === "확인" && !data[i][8]) {
      const reqID = data[i][0];
      if (reqID && processedIDs.has(reqID)) continue;
      processByReqID(sheet, i + 2);
      if (reqID) processedIDs.add(reqID);
      count++;
    }
  }

  SpreadsheetApp.getUi().alert(`✅ ${count}건 처리 완료!`);
}

/**
 * 수동 등록
 */
function manualRegister() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("확인요청");
  const row = sheet.getActiveCell().getRow();
  if (row < 2) {
    SpreadsheetApp.getUi().alert("등록할 행을 선택하세요.");
    return;
  }
  registerByReqID(sheet, row);
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 초기화 (수동 + 자동)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 수동 초기화 (메뉴에서 실행 — 확인 팝업 있음)
 */
function clearAllRequests() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.alert(
    "확인요청 초기화",
    "확인요청 시트의 데이터(헤더 제외)를 모두 삭제합니다.\n계약마스터/스케줄상세는 유지됩니다.\n\n계속하시겠습니까?",
    ui.ButtonSet.YES_NO
  );
  if (response !== ui.Button.YES) return;

  doClearRequests();
  ui.alert("✅ 초기화 완료!");
}

/**
 * 자동 초기화 (타이머 트리거에서 실행 — 팝업 없이 조용히)
 * 등록완료된 건만 삭제합니다. 나머지는 전부 남겨둡니다.
 */
function autoClearRequests() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("확인요청");
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const data = sheet.getRange(2, 1, lastRow - 1, 17).getValues();

  // 아래에서 위로 삭제 (행 번호 꼬임 방지)
  for (let i = data.length - 1; i >= 0; i--) {
    const row = i + 2;
    const regStatus = data[i][14];  // O: 등록상태

    // 등록완료된 건만 삭제 (L열=12 수식은 보존)
    if (regStatus === "등록완료") {
      // A~K열 (1~11) 클리어
      sheet.getRange(row, 1, 1, 11).clearContent();
      sheet.getRange(row, 1, 1, 11).setBackground(null);
      // L열(12)은 수식이므로 건드리지 않음
      // M~Q열 (13~17) 클리어
      sheet.getRange(row, 13, 1, 5).clearContent();
      sheet.getRange(row, 13, 1, 5).setBackground(null);
    }
  }

}

/**
 * 전체 삭제 (수동 초기화용 내부 함수)
 */
function doClearRequests() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("확인요청");
  const lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    // L열(12) 수식 보존: A~K, M~Q만 삭제
    sheet.getRange(2, 1, lastRow - 1, 11).clearContent();   // A~K
    sheet.getRange(2, 1, lastRow - 1, 11).setBackground(null);
    sheet.getRange(2, 13, lastRow - 1, 5).clearContent();   // M~Q
    sheet.getRange(2, 13, lastRow - 1, 5).setBackground(null);
  }
  // 초기화 후 F열 드롭다운(장비+세트) 자동 갱신
  refreshEquipmentList();
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 팝빌 알림톡 API 연동
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 팝빌 API 토큰 발급
 * 스크립트 속성에 POPBILL_LINK_ID, POPBILL_SECRET_KEY 필요
 */
function _getPopbillToken() {
  var props = PropertiesService.getScriptProperties();
  var linkID = props.getProperty('POPBILL_LINK_ID');
  var secretKey = props.getProperty('POPBILL_SECRET_KEY');

  var scope = ['153'];
  var tokenRequestURL = 'https://auth.linkhub.co.kr/POPBILL/Token';

  var xDate = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  var reqBody = JSON.stringify({
    access_id: linkID,
    scope: scope
  });

  var md5 = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, reqBody, Utilities.Charset.UTF_8);
  var contentMD5 = Utilities.base64Encode(md5);

  var stringToSign = 'POST\n' + contentMD5 + '\n' + xDate + '\n\n/POPBILL/Token';
  var hmac = Utilities.computeHmacSha256Signature(stringToSign, Utilities.base64Decode(secretKey));
  var signature = Utilities.base64Encode(hmac);

  var options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-lh-date': xDate,
      'x-lh-version': '2.0',
      'Authorization': 'LINKHUB ' + linkID + ' ' + signature
    },
    payload: reqBody,
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(tokenRequestURL, options);
  var result = JSON.parse(response.getContentText());
  return result.session_token;
}

/**
 * 카카오 알림톡 발송
 * @param {string} templateCode - 팝빌 템플릿 코드
 * @param {string} receiver - 수신 전화번호
 * @param {string} receiverName - 수신자 이름
 * @param {string} content - 메시지 내용
 * @param {Object} [vars] - 템플릿 변수 (예: {"#{고객명}": "홍길동"})
 */
function sendAlimtalk(templateCode, receiver, receiverName, content, vars) {
  var props = PropertiesService.getScriptProperties();
  var corpNum = props.getProperty('POPBILL_CORP_NUM');
  var senderNum = props.getProperty('POPBILL_SENDER_NUM');

  var token = _getPopbillToken();
  var url = 'https://popbill.linkhub.co.kr/KakaoTalk';

  var msgObj = {
    rcv: receiver.replace(/-/g, ''),
    rcvnm: receiverName
  };
  if (vars) {
    msgObj.msg = content;
    msgObj.altmsg = content;
    msgObj.vars = vars;
  }

  var body = {
    snd: senderNum,
    content: content,
    msgs: [msgObj],
    templateCode: templateCode,
    altSendType: 'A'
  };

  var options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Authorization': 'Bearer ' + token,
      'x-pb-userid': 'MASTER'
    },
    payload: JSON.stringify(body),
    muteHttpExceptions: true
  };

  var response = UrlFetchApp.fetch(url + '/' + corpNum, options);
  return JSON.parse(response.getContentText());

}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 반출/반납 안내톡 (3회 미만 고객 대상)
// 반출: 반출 시간 12시간 전 발송
// 반납: 반출 시간 + 3시간 후 발송
// 발송 가능 시간: 09:00~21:00 (밖이면 09:00으로 지연)
// 트리거: 30분마다 checkGuideAlimtalk 실행
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

var TPL_CHECKOUT = '026040000902';  // 반출 안내
var TPL_CHECKIN  = '026040000904';  // 반납 안내

var GUIDE_SEND_START = 8;   // 발송 가능 시작 시각
var GUIDE_SEND_END   = 22;  // 발송 가능 종료 시각

/**
 * 반출 안내톡 메시지 생성
 */
function _buildCheckoutMsg(customerName) {
  return customerName + ' 감독님, 안녕하세요.\n'
    + '빌리지 렌탈샵입니다.\n\n'
    + '예약하신 장비 대여 건의 반출일이 다가와 안내드립니다.\n'
    + '만약 직원이 부재할 시에 아래 내용을 참고해주세요 : )\n\n'
    + '1. 문을 열고 들어오셔서 감독님 성함과 반출 시간이 적힌 테이블을 찾아주시고, 장비를 테스트 하신 후 반출해주시면 됩니다.\n\n'
    + '모든 장비는 담당자가 확인을 마친 장비이며, 반출 시 확인하신 손상이나 이상은 사진과 함께 카톡으로 보내주시면 감사드리겠습니다.\n\n'
    + '2. 결제는 반출 시 견적서상 금액을 상단계좌에 입금해주셔도 되고 반납 시에 결제해주셔도 됩니다. 카드 결제를 원하실 경우 아래 순서에 따라 직접 결제 해주셔도 좋습니다.\n\n'
    + '1) 카드 넣기 2) 금액 입력 (계약서상 \'VAT포함가\') 3) 확인(녹색 버튼) 4) 사인 5) 최종 확인 버튼 6) 영수증 1부는 테이블 위에 놓고 가주시면 됩니다.\n\n'
    + '감사합니다!';
}

/**
 * 반납 안내톡 메시지 생성
 */
function _buildCheckinMsg(customerName) {
  return customerName + ' 감독님, 안녕하세요.\n'
    + '빌리지 렌탈샵입니다.\n\n'
    + '예약하신 장비 대여 건의 반납일이 다가와 안내드립니다.\n'
    + '만약 직원이 부재할 시에 아래 내용을 참고해주세요 : )\n\n'
    + '1. 장비를 한쪽에 잘 모아서 반납하신 후 사진 촬영하여 카카오톡 채널로 공유 부탁드립니다.\n\n'
    + '2. 나가실 때는 검정 철문은 닫지 마시고 나무로 된 문만 잘 닫힌 것 확인 후 가주시면 됩니다.\n\n'
    + '감사합니다 : )\n\n'
    + '*가급적이면 장비는 안쪽부터 차례대로 넣어주세요!';
}

/**
 * 반출일 + 반출시간 → Date 객체 (KST 기준)
 */
function _parseCheckoutDateTime(dateVal, timeVal) {
  var dateStr = dateVal instanceof Date
    ? Utilities.formatDate(dateVal, 'Asia/Seoul', 'yyyy-MM-dd') : String(dateVal || '').trim();
  var timeStr = timeVal instanceof Date
    ? Utilities.formatDate(timeVal, 'Asia/Seoul', 'HH:mm') : String(timeVal || '').trim();

  if (!dateStr) return null;
  if (!timeStr) timeStr = '10:00';  // 시간 미입력 시 기본 10시

  // yyyy-MM-dd HH:mm → Date (KST)
  var parts = dateStr.split('-');
  var timeParts = timeStr.split(':');
  var dt = new Date(
    parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]),
    parseInt(timeParts[0]), parseInt(timeParts[1] || '0'), 0
  );
  return dt;
}

/**
 * 발송 가능 시간 체크 (09:00~21:00 KST)
 * @returns {boolean} 지금 발송 가능하면 true
 */
function _isInSendWindow(nowKST) {
  var hour = parseInt(Utilities.formatDate(nowKST, 'Asia/Seoul', 'HH'));
  return hour >= GUIDE_SEND_START && hour < GUIDE_SEND_END;
}

/**
 * 30분마다 실행 — 반출/반납 안내톡 발송 시점 체크
 *
 * 반출 안내톡: 반출 시간 12시간 전 (발송 가능 시간 내에서)
 * 반납 안내톡: 반출 시간 + 3시간 후 (발송 가능 시간 내에서)
 * 대상: 3회 미만 고객만
 */
function checkGuideAlimtalk() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var schedSheet = ss.getSheetByName('스케줄상세');
  var contractSheet = ss.getSheetByName('계약마스터');

  if (!schedSheet || !contractSheet || schedSheet.getLastRow() < 2 || contractSheet.getLastRow() < 2) return;

  var now = new Date();

  // 발송 가능 시간 아니면 즉시 종료
  if (!_isInSendWindow(now)) {
    Logger.log('⏸ 발송 가능 시간 아님 (08:00~22:00 외)');
    return;
  }

  var todayStr = Utilities.formatDate(now, 'Asia/Seoul', 'yyyyMMdd');

  // ── 계약마스터 데이터 로드 ──
  // A=거래ID, B=예약자명, C=연락처
  var cmLastRow = contractSheet.getLastRow();
  var cmData = contractSheet.getRange(2, 1, cmLastRow - 1, 3).getValues();

  var contractMap = {};   // 거래ID → { name, tel }
  for (var ci = 0; ci < cmData.length; ci++) {
    var tid = String(cmData[ci][0] || '').trim();
    var name = String(cmData[ci][1] || '').trim();
    var tel = String(cmData[ci][2] || '').trim();
    if (tid) contractMap[tid] = { name: name, tel: tel };
  }

  // ── 고객DB에서 누적이용횟수 로드 ──
  // A=연락처, B=예약자명, C=누적이용횟수
  var dbSheet = ss.getSheetByName('고객DB');
  var usageCount = {};  // 예약자명 → 누적이용횟수
  if (dbSheet && dbSheet.getLastRow() >= 2) {
    var dbData = dbSheet.getRange(2, 1, dbSheet.getLastRow() - 1, 3).getValues();
    for (var di = 0; di < dbData.length; di++) {
      var dbName = String(dbData[di][1] || '').trim();
      var count = parseInt(dbData[di][2]) || 0;
      if (dbName) usageCount[dbName] = count;
    }
  }

  // ── 스케줄상세에서 거래ID별 반출일시 수집 ──
  var schedData = schedSheet.getRange(2, 1, schedSheet.getLastRow() - 1, 10).getValues();

  // 거래ID → { checkoutDT: Date, 상태 }  (첫 행 기준, 중복 거래ID는 스킵)
  var tradeInfo = {};

  for (var si = 0; si < schedData.length; si++) {
    var 거래ID = String(schedData[si][1] || '').trim();  // B
    var 반출일 = schedData[si][5];   // F
    var 반출시간 = schedData[si][6]; // G
    var 상태 = String(schedData[si][9] || '').trim();  // J

    if (!거래ID || 상태 === '취소') continue;
    if (tradeInfo[거래ID]) continue;  // 같은 거래ID 첫 행만

    var checkoutDT = _parseCheckoutDateTime(반출일, 반출시간);
    if (!checkoutDT) continue;

    tradeInfo[거래ID] = { checkoutDT: checkoutDT };
  }

  // ── 중복 발송 방지 ──
  var props = PropertiesService.getScriptProperties();
  var sentKey = 'GUIDE_SENT_' + todayStr;
  var sentData = {};
  try {
    var sentRaw = props.getProperty(sentKey);
    if (sentRaw) sentData = JSON.parse(sentRaw);
  } catch(e) {}

  var results = { sent: [], skipped: [], errors: [] };
  var nowMs = now.getTime();

  Object.keys(tradeInfo).forEach(function(tid) {
    var info = tradeInfo[tid];
    var cust = contractMap[tid];
    if (!cust || !cust.name || !cust.tel) return;

    // 3회 미만 고객만
    if ((usageCount[cust.name] || 0) >= 3) return;

    var checkoutMs = info.checkoutDT.getTime();

    // ── 반출 안내톡: 반출 12시간 전 ──
    var outSendMs = checkoutMs - (12 * 60 * 60 * 1000);
    var outFlag = 'out_' + tid;
    if (!sentData[outFlag] && nowMs >= outSendMs && nowMs < checkoutMs) {
      try {
        var outMsg = _buildCheckoutMsg(cust.name);
        var outVars = { '#{고객명}': cust.name };
        var outRes = sendAlimtalk(TPL_CHECKOUT, cust.tel, cust.name, outMsg, outVars);
        sentData[outFlag] = Utilities.formatDate(now, 'Asia/Seoul', 'HH:mm');
        results.sent.push('반출 ' + tid + ' ' + cust.name);
        Logger.log('✅ 반출 안내톡: ' + tid + ' ' + cust.name + ' → ' + JSON.stringify(outRes));
      } catch(err) {
        results.errors.push('반출 ' + tid + ': ' + err.message);
        Logger.log('❌ 반출 안내톡 실패: ' + tid + ' ' + err.message);
      }
    }

    // ── 반납 안내톡: 반출 3시간 후 ──
    var inSendMs = checkoutMs + (3 * 60 * 60 * 1000);
    var inFlag = 'in_' + tid;
    // 반출 당일~다음날 사이에만 발송 (너무 지난 건 무시)
    var inDeadlineMs = checkoutMs + (48 * 60 * 60 * 1000);
    if (!sentData[inFlag] && nowMs >= inSendMs && nowMs < inDeadlineMs) {
      try {
        var inMsg = _buildCheckinMsg(cust.name);
        var inVars = { '#{고객명}': cust.name };
        var inRes = sendAlimtalk(TPL_CHECKIN, cust.tel, cust.name, inMsg, inVars);
        sentData[inFlag] = Utilities.formatDate(now, 'Asia/Seoul', 'HH:mm');
        results.sent.push('반납 ' + tid + ' ' + cust.name);
        Logger.log('✅ 반납 안내톡: ' + tid + ' ' + cust.name + ' → ' + JSON.stringify(inRes));
      } catch(err) {
        results.errors.push('반납 ' + tid + ': ' + err.message);
        Logger.log('❌ 반납 안내톡 실패: ' + tid + ' ' + err.message);
      }
    }
  });

  // ── 발송 기록 저장 ──
  props.setProperty(sentKey, JSON.stringify(sentData));

  // ── 오래된 발송 기록 정리 (7일 이전) ──
  var allKeys = props.getKeys();
  var cutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  var cutoffStr = 'GUIDE_SENT_' + Utilities.formatDate(cutoff, 'Asia/Seoul', 'yyyyMMdd');
  allKeys.forEach(function(k) {
    if (k.indexOf('GUIDE_SENT_') === 0 && k < cutoffStr) {
      props.deleteProperty(k);
    }
  });

  if (results.sent.length > 0 || results.errors.length > 0) {
    Logger.log('📋 안내톡 결과: ' + JSON.stringify(results));
  }
  return results;
}

/**
 * 반출/반납 안내톡 트리거 설정 (최초 1회 실행)
 * 30분마다 checkGuideAlimtalk 자동 실행
 */
function setupGuideAlimtalkTrigger() {
  // 기존 트리거 제거
  var triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(function(t) {
    if (t.getHandlerFunction() === 'checkGuideAlimtalk') {
      ScriptApp.deleteTrigger(t);
    }
  });

  // 30분마다 트리거 생성
  ScriptApp.newTrigger('checkGuideAlimtalk')
    .timeBased()
    .everyMinutes(30)
    .create();

  Logger.log('✅ 반출/반납 안내톡 트리거 설정 완료 (30분마다 체크)');
}

/**
 * 스케줄상세 시트 가독성 포맷팅
 * - 같은 거래ID(B열) 그룹끼리 교차 배경색 (흰색 ↔ 연한 회색)
 * - 거래ID가 바뀌는 경계에 하단 테두리
 */
function formatScheduleSheet(schedSheet) {
  if (!schedSheet) {
    schedSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("스케줄상세");
  }
  if (!schedSheet) return;

  const lastRow = schedSheet.getLastRow();
  if (lastRow < 2) return;

  const lastCol = schedSheet.getLastColumn() || 13;
  const data = schedSheet.getRange(2, 2, lastRow - 1, 1).getValues(); // B열(거래ID)

  const COLOR_A = null;        // 흰색 (기본)
  const COLOR_B = "#F3F3F3";   // 연한 회색
  var colorToggle = 0;
  var prevID = null;

  // 전체 배경 초기화 + 테두리 초기화
  var fullRange = schedSheet.getRange(2, 1, lastRow - 1, lastCol);
  fullRange.setBackground(null);
  fullRange.setBorder(null, null, null, null, null, null);

  for (var i = 0; i < data.length; i++) {
    var curID = String(data[i][0] || "").trim();

    if (curID !== prevID && prevID !== null) {
      // 이전 그룹 마지막 행에 하단 테두리
      schedSheet.getRange(i + 1, 1, 1, lastCol)
        .setBorder(null, null, true, null, null, null, "#999999", SpreadsheetApp.BorderStyle.SOLID);
      colorToggle = 1 - colorToggle;
    }

    // 배경색 적용
    var color = colorToggle === 0 ? COLOR_A : COLOR_B;
    if (color) {
      schedSheet.getRange(i + 2, 1, 1, lastCol).setBackground(color);
    }

    prevID = curID;
  }
}


function fixScheduleHeaders() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("스케줄상세");
  if (!sheet) { return; }
  var newHeaders = ["스케줄ID", "거래ID", "세트명", "장비명", "수량", "반출일", "반출시간", "반납일", "반납시간", "상태", "비고", "단가", "예약자명"];
  sheet.getRange(1, 1, 1, 12).setValues([newHeaders]);
  sheet.getRange(1, 1, 1, 12).setFontWeight("bold");
  sheet.setFrozenRows(1);
  refreshEquipmentList();
  SpreadsheetApp.getUi().alert("✅ 수정 완료!\n\n1. 스케줄상세 헤더 업데이트 (12열)\n2. 확인요청 F열 드롭다운 갱신\n\n⚠️ AppSheet에서 스케줄상세 Regenerate schema도 해주세요.");
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 1회성 셋업/디버깅 함수 정리됨:
// setupScriptProperties, diagGosuURL, diagGosuWrite,
// migratePriceToSetMaster, syncTemplateHiddenSheet,
// fillScheduleNames, dedup252vsExisting, debugSetMasterFrom252,
// cleanSetMasterFrom252, setupAutoClear, setupCustomerDB
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━



/**
 * 진단: 현재 대기 중인 계약서 재생성 큐 + 마지막 편집부터 경과시간 반환.
 */
function listPendingContractRegens() {
  var props = PropertiesService.getScriptProperties().getProperties();
  var now = Date.now();
  var items = [];
  for (var key in props) {
    if (!key.startsWith('contractEditTS_')) continue;
    var id = key.substring('contractEditTS_'.length);
    var ts = Number(props[key]);
    items.push({ 거래ID: id, 편집경과초: Math.round((now - ts) / 1000) });
  }
  return { pending: items.length, items: items };
}

/**
 * 현재 등록된 모든 트리거 목록 반환 (디버깅용)
 */
function listAllTriggers() {
  var triggers = ScriptApp.getProjectTriggers();
  var result = triggers.map(function(t) {
    return {
      handler: t.getHandlerFunction(),
      eventType: t.getEventType().toString(),
      triggerSource: t.getTriggerSource().toString()
    };
  });
  Logger.log(JSON.stringify(result, null, 2));
  return result;
}
function clearValidation() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("확인요청");
  sheet.getRange(2, 1, 300, 18).clearDataValidations();
  refreshEquipmentList();
}

/**
 * 계약마스터 시트 가독성 포맷팅
 * - E,F 반출일/시간: 연파랑
 * - G,H 반납일/시간: 연녹색
 * - I 회차: 연노랑
 * - J 계약상태: 기본 파랑, 조건부서식으로 "취소"→빨강+취소선, "완료/반납완료"→회색+취소선
 * - A,B,C,D,K 기타 정보: 흐린 회색 톤 (글자도 흐리게)
 * - E~J 굵게
 */
function formatContractSheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("계약마스터");
  if (!sheet) return "계약마스터 시트 없음";

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return "데이터 없음";
  var lastCol = 11;
  var maxRow = sheet.getMaxRows();
  var fullRows = maxRow - 1;   // 시트 전체(헤더 제외) — 신규 행도 자동으로 서식 받음

  var COLOR_OUT       = "#DAE8FC"; // 반출
  var COLOR_IN        = "#D5E8D4"; // 반납
  var COLOR_SEQ       = "#FFF2CC"; // 회차
  var COLOR_STAT_DEF  = "#BDD7EE"; // 계약상태 기본

  // 1) 전체 데이터 영역 초기화 (A~K 전부 기본값으로)
  var dataRange = sheet.getRange(2, 1, fullRows, lastCol);
  dataRange.setBackground(null);
  dataRange.setFontColor(null);
  dataRange.setFontWeight(null);
  dataRange.setFontStyle(null);

  // 2) 주요 열 그룹 배경 (E~J 전체 행 — 빈 행 포함, 신규 등록 시 자동 적용)
  sheet.getRange(2, 5, fullRows, 2).setBackground(COLOR_OUT);      // E,F 반출
  sheet.getRange(2, 7, fullRows, 2).setBackground(COLOR_IN);       // G,H 반납
  sheet.getRange(2, 9, fullRows, 1).setBackground(COLOR_SEQ);      // I 회차
  sheet.getRange(2, 10, fullRows, 1).setBackground(COLOR_STAT_DEF);// J 계약상태 기본

  // 3) E~J 굵게 (전체 행)
  sheet.getRange(2, 5, fullRows, 6).setFontWeight("bold");

  // 5) 조건부 서식: 계약상태 기준 행 전체 — 시트 최대 행까지 적용해 신규 행도 자동 커버
  var ruleRange = sheet.getRange(2, 1, fullRows, lastCol);
  var existing = sheet.getConditionalFormatRules().filter(function(r) {
    // 기존 계약마스터 2b 규칙 제거 (A2:K 범위 규칙만)
    var ranges = r.getRanges();
    if (!ranges || ranges.length === 0) return true;
    var a1 = ranges[0].getA1Notation();
    return !/^A2:K\d+$/.test(a1);
  });

  existing.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=$J2="취소"')
      .setBackground("#FFC7CE")
      .setFontColor("#9C0006")
      .setStrikethrough(true)
      .setRanges([ruleRange])
      .build()
  );
  existing.push(
    SpreadsheetApp.newConditionalFormatRule()
      .whenFormulaSatisfied('=OR($J2="완료",$J2="반납완료")')
      .setBackground("#E7E6E6")
      .setFontColor("#7F7F7F")
      .setStrikethrough(true)
      .setRanges([ruleRange])
      .build()
  );

  sheet.setConditionalFormatRules(existing);

  // 6) 헤더 고정
  sheet.setFrozenRows(1);

  return "✅ 시트 전체(" + fullRows + "행) 서식 적용 완료";
}

// ===================================================================
// addEquipmentToRequest: 기존 reqID에 장비만 추가 (기존 행 건드리지 않음)
// ===================================================================
function addEquipmentToRequest(argsStr) {
  var args = typeof argsStr === 'string' ? JSON.parse(argsStr) : argsStr;
  var reqID = args.reqID;
  var equipList = args['\uC7A5\uBE44']; // 장비

  if (!reqID || !equipList || equipList.length === 0) {
    return {success: false, error: "reqID\uC640 \uC7A5\uBE44 \uBAA9\uB85D \uD544\uC218"};
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("\uD655\uC778\uC694\uCCAD"); // 확인요청
  var lastRow = sheet.getLastRow();

  if (lastRow < 2) return {success: false, error: "\uC2DC\uD2B8\uAC00 \uBE44\uC5B4\uC788\uC74C"};

  // 기존 reqID에서 날짜/시간 정보 가져오기 (displayValues로 시간 1899 방지)
  var data = sheet.getRange(2, 1, lastRow - 1, 5).getValues();
  var displayData = sheet.getRange(2, 1, lastRow - 1, 5).getDisplayValues();
  var outDate, outTime, inDate, inTime;

  for (var i = 0; i < data.length; i++) {
    if (String(data[i][0]).trim() === reqID && data[i][1]) {
      outDate = data[i][1];
      outTime = displayData[i][2];
      inDate = data[i][3];
      inTime = displayData[i][4];
      break;
    }
  }

  if (!outDate) return {success: false, error: "reqID\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC74C: " + reqID};

  var results = [];
  var startTime = new Date();

  for (var e = 0; e < equipList.length; e++) {
    var newRow = sheet.getLastRow() + 1;
    sheet.getRange(newRow, 1).setValue(reqID);
    sheet.getRange(newRow, 2).setValue(outDate);
    sheet.getRange(newRow, 3).setValue(outTime);
    sheet.getRange(newRow, 4).setValue(inDate);
    sheet.getRange(newRow, 5).setValue(inTime);
    sheet.getRange(newRow, 6).setValue(equipList[e]['\uC774\uB984']); // 이름
    sheet.getRange(newRow, 7).setValue(equipList[e]['\uC218\uB7C9'] || 1); // 수량
    sheet.getRange(newRow, 8).setValue("\uD655\uC778"); // 확인
    SpreadsheetApp.flush();

    // processAdditionalRow_로 가용확인 (기존 행 건드리지 않음)
    processAdditionalRow_(sheet, newRow, reqID);
    SpreadsheetApp.flush();

    var result = String(sheet.getRange(newRow, 9).getValue());
    var detail = String(sheet.getRange(newRow, 10).getValue());
    results.push({
      "\uC7A5\uBE44\uBA85": equipList[e]['\uC774\uB984'],
      "\uC218\uB7C9": String(equipList[e]['\uC218\uB7C9'] || 1),
      "\uACB0\uACFC": result,
      "\uC0C1\uC138": detail
    });
  }

  var elapsed = new Date() - startTime;
  return {
    success: true,
    "function": "addEquipmentToRequest",
    reqID: reqID,
    addedCount: equipList.length,
    results: results,
    executionTime: elapsed + "ms"
  };
}

/**
 * 디버그: 선택한 확인요청 행이 속한 reqID의 모든 행을 한번에 추적.
 * 헤더 + 모든 구성품 각각에 대해 schedSheet 매칭 결과를 출력.
 */
function debugCheckAvailForSelected() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getActiveSheet();
  if (sheet.getName() !== "확인요청") {
    SpreadsheetApp.getUi().alert("확인요청 시트에서 행을 선택한 후 실행하세요.");
    return;
  }
  var row = sheet.getActiveCell().getRow();
  if (row < 2) {
    SpreadsheetApp.getUi().alert("데이터 행을 선택하세요.");
    return;
  }

  var lastRowReq = sheet.getLastRow();
  var allReqVals = sheet.getRange(2, 1, lastRowReq - 1, 7).getValues();
  var allReqDisp = sheet.getRange(2, 1, lastRowReq - 1, 7).getDisplayValues();
  var triggerReqID = String(allReqVals[row - 2][0] || '').trim();

  var lines = [];
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('선택 행=' + row + ' / triggerReqID=' + triggerReqID);

  if (!triggerReqID) { lines.push('⚠️ 요청ID 없음'); showLog_(lines); return; }

  // 같은 reqID의 첫 행에서 날짜/시간 가져오기
  var 반출일=null, 반출시간=null, 반납일=null, 반납시간=null;
  for (var i = 0; i < allReqVals.length; i++) {
    if (String(allReqVals[i][0]).trim() === triggerReqID && allReqVals[i][1]) {
      반출일 = allReqVals[i][1];
      반출시간 = allReqDisp[i][2];
      반납일 = allReqVals[i][3];
      반납시간 = allReqDisp[i][4];
      break;
    }
  }

  var reqStartDT = parseDT(반출일, 반출시간);
  var reqEndDT = parseDT(반납일, 반납시간);
  lines.push('기간: KST ' +
    (reqStartDT ? Utilities.formatDate(reqStartDT,'Asia/Seoul','M/d HH:mm') : 'NULL') + ' ~ ' +
    (reqEndDT ? Utilities.formatDate(reqEndDT,'Asia/Seoul','M/d HH:mm') : 'NULL'));

  if (!reqStartDT || !reqEndDT) { lines.push('⚠️ 파싱 실패'); showLog_(lines); return; }

  var schedSheet = ss.getSheetByName('스케줄상세');
  if (!schedSheet) { lines.push('스케줄상세 시트 없음'); showLog_(lines); return; }
  var lastRow = schedSheet.getLastRow();
  lines.push('스케줄상세 lastRow=' + lastRow);

  var rawData = schedSheet.getRange(2, 1, lastRow - 1, 11).getValues();

  // 거래마스터 매핑
  var contractSheet = ss.getSheetByName('계약마스터');
  var contractMap = {};
  if (contractSheet && contractSheet.getLastRow() >= 2) {
    var contracts = contractSheet.getRange(2, 1, contractSheet.getLastRow() - 1, 4).getValues();
    contracts.forEach(function(c) { contractMap[c[0]] = c[1] || ''; });
  }

  // 같은 reqID의 모든 행 (장비명) 수집
  var targetEquips = [];
  for (var i = 0; i < allReqVals.length; i++) {
    if (String(allReqVals[i][0]).trim() !== triggerReqID) continue;
    var eq = String(allReqVals[i][5] || '').trim();
    if (!eq) continue;
    targetEquips.push({ row: i + 2, 장비명: eq, 수량: allReqVals[i][6] || 1 });
  }
  lines.push('확인요청 같은 reqID 행 수=' + targetEquips.length);

  // 각 장비명에 대해 schedSheet 매칭
  targetEquips.forEach(function(t) {
    lines.push('');
    lines.push('▶▶ 검사: row=' + t.row + ' 장비명=' + JSON.stringify(t.장비명) + ' (len=' + t.장비명.length + ') 수량=' + t.수량);
    var matched = 0, overlapped = 0, nullParsed = 0, lostByStatus = 0;
    var concurrentSum = 0;  // OVERLAP된 행들의 qty 합
    for (var i = 0; i < rawData.length; i++) {
      var r = rawData[i];
      var equip = String(r[3] || '');
      if (equip !== t.장비명) continue;
      matched++;
      var status = r[9];
      if (status === '반납완료' || status === '취소') {
        lostByStatus++;
        lines.push('  [status제외] row=' + (i+2) + ' tid=' + r[1] + ' status=' + JSON.stringify(status));
        continue;
      }
      var startDT = parseDT(r[5], r[6]);
      var endDT = parseDT(r[7], r[8]);
      if (!startDT || !endDT) {
        nullParsed++;
        lines.push('  [parseDT실패] row=' + (i+2) + ' tid=' + r[1] + ' / 반출일=' + JSON.stringify(r[5]) + ' isDate=' + (r[5] instanceof Date) + ' / 반출시간=' + JSON.stringify(r[6]));
        continue;
      }
      var overlap = startDT < reqEndDT && endDT > reqStartDT;
      if (overlap) {
        overlapped++;
        concurrentSum += (r[4] || 1);
        lines.push('  [OVERLAP ✓] row=' + (i+2) + ' tid=' + r[1] + ' name=' + (contractMap[r[1]] || '?') +
          ' qty=' + r[4] +
          ' / 반출일raw=' + JSON.stringify(r[5]) + ' isDate=' + (r[5] instanceof Date) +
          ' / KST ' + Utilities.formatDate(startDT,'Asia/Seoul','M/d HH:mm') + ' ~ ' + Utilities.formatDate(endDT,'Asia/Seoul','M/d HH:mm'));
      }
    }
    lines.push('  요약: 매칭=' + matched + ' / OVERLAP=' + overlapped + ' (qty합=' + concurrentSum + ') / parseDT실패=' + nullParsed + ' / status제외=' + lostByStatus);
  });

  showLog_(lines);
}

/**
 * 강제 재실행: 선택 행의 reqID에 대해 가용확인을 강제로 다시 돌리고
 * 모든 행의 I열/J열 결과를 출력. processByReqID와 동일한 코드 경로.
 * 단, "이미 결과 있으면 스킵" 우회 위해 I/J열을 먼저 비우고 실행.
 */
function forceRerunCheckAvailForSelected() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getActiveSheet();
  if (sheet.getName() !== "확인요청") {
    SpreadsheetApp.getUi().alert("확인요청 시트에서 행을 선택한 후 실행하세요.");
    return;
  }
  var row = sheet.getActiveCell().getRow();
  if (row < 2) { SpreadsheetApp.getUi().alert("데이터 행을 선택하세요."); return; }

  var lastRowReq = sheet.getLastRow();
  var allReqVals = sheet.getRange(2, 1, lastRowReq - 1, 17).getValues();
  var triggerReqID = String(allReqVals[row - 2][0] || '').trim();
  if (!triggerReqID) { SpreadsheetApp.getUi().alert("요청ID 없는 행입니다."); return; }

  var lines = [];
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('강제 재실행: triggerReqID=' + triggerReqID);

  // I/J열 비우기 (스킵 로직 우회) — 단, 첫 행(세트 헤더)은 "세트" 유지
  var triggerRowAbs = row;
  var sameReqRows = [];
  for (var i = 0; i < allReqVals.length; i++) {
    if (String(allReqVals[i][0]).trim() === triggerReqID) sameReqRows.push(i + 2);
  }
  lines.push('같은 reqID 행 수=' + sameReqRows.length);
  sameReqRows.forEach(function(r) {
    sheet.getRange(r, 9, 1, 2).clearContent();
  });
  SpreadsheetApp.flush();
  lines.push('I/J열 비움 완료. processByReqID 호출…');

  // 진짜 가용확인 함수 호출 (락 포함)
  processByReqID(sheet, triggerRowAbs);
  SpreadsheetApp.flush();
  lines.push('processByReqID 완료. 결과 읽는 중…');
  lines.push('');

  // 결과 출력
  var newLastRow = sheet.getLastRow();
  var newAllVals = sheet.getRange(2, 1, newLastRow - 1, 18).getValues();
  for (var i = 0; i < newAllVals.length; i++) {
    if (String(newAllVals[i][0]).trim() !== triggerReqID) continue;
    var r = i + 2;
    var equip = String(newAllVals[i][5] || '');
    var qty = newAllVals[i][6];
    var iCol = String(newAllVals[i][8] || '').replace(/\n/g, ' ⏎ ');
    var jCol = String(newAllVals[i][9] || '').replace(/\n/g, ' ⏎ ');
    lines.push('row=' + r + ' / 장비명=' + JSON.stringify(equip) + ' / qty=' + qty);
    lines.push('  I열(결과) = ' + JSON.stringify(iCol));
    lines.push('  J열(상세) = ' + JSON.stringify(jCol));
  }

  showLog_(lines);
}

function showLog_(lines) {
  var html = '<pre style="font-family:Menlo,Monaco,monospace;font-size:11px;white-space:pre-wrap;">' +
    lines.join('\n').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') +
    '</pre>';
  var out = HtmlService.createHtmlOutput(html).setWidth(1100).setHeight(700);
  SpreadsheetApp.getUi().showModalDialog(out, '🐞 가용확인 디버그 결과');
  Logger.log(lines.join('\n'));
}

/**
 * 스케줄상세 상태 변경
 * @param {number} rowIndex - 대표 행 번호
 * @param {string} newStatus - 새 상태 (대기/반출중/반납완료/취소)
 * @param {string} [rowIndices] - 같은 세트 전체 행 JSON
 */
function updateScheduleStatus(rowIndex, newStatus, rowIndices) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('스케줄상세');
  if (!sheet) return { success: false, message: '스케줄상세 시트 없음' };

  var validStatuses = ['대기', '반출중', '반납완료', '취소'];
  if (validStatuses.indexOf(newStatus) < 0) {
    return { success: false, message: '유효하지 않은 상태: ' + newStatus };
  }

  var rows = [];
  if (rowIndices) {
    try { rows = JSON.parse(rowIndices); } catch(e) { rows = [rowIndex]; }
  } else {
    rows = [rowIndex];
  }

  rows.forEach(function(r) {
    var ri = Number(r);
    if (ri >= 2) {
      sheet.getRange(ri, 10).setValue(newStatus);  // J열 = 10번째 = 상태
    }
  });

  try { invalidateDashboardCache(); } catch (e) {}
  try { invalidateTimelineCache(); } catch (e2) {}

  return { success: true, message: rows.length + '행 상태 변경 완료', newStatus: newStatus };
}

/**
 * 과거 호환용 stub. 클라이언트에 Claude API 키를 반환하면 안 된다.
 */
function getClaudeApiKey() {
  return { error: "disabled: use aiParse endpoint" };
}

/**
 * Claude API를 사용하여 예약 문의 텍스트/이미지를 파싱
 * @param {string} text - 파싱할 텍스트 (optional)
 * @param {string} imageBase64 - base64 이미지 (optional)
 * @param {string} imageMediaType - image/png, image/jpeg 등 (optional)
 * @returns {object} 파싱된 예약 정보
 */
function parseWithClaude(text, imageBase64, imageMediaType) {
  // API 키는 GAS Script Properties에 저장 (코드에 하드코딩 금지)
  // 설정: GAS 편집기 → 프로젝트 설정 → 스크립트 속성 → ANTHROPIC_API_KEY
  var apiKey = PropertiesService.getScriptProperties().getProperty("ANTHROPIC_API_KEY");
  if (!apiKey) return { error: "ANTHROPIC_API_KEY가 스크립트 속성에 설정되지 않았습니다" };

  var systemPrompt = "너는 카메라 렌탈샵 '빌리지'의 예약 문의 파서야. 카카오톡 메시지나 채팅 캡쳐 이미지를 받아서 예약 정보를 JSON으로 추출해.\n\n반드시 아래 JSON 형식으로만 응답해 (다른 텍스트 없이):\n{\n  \"예약자명\": \"이름 또는 빈 문자열\",\n  \"연락처\": \"010-XXXX-XXXX 형식 또는 빈 문자열\",\n  \"반출일\": \"YYYY-MM-DD 또는 빈 문자열\",\n  \"반출시간\": \"HH:MM 또는 빈 문자열 (기본 10:00)\",\n  \"반납일\": \"YYYY-MM-DD 또는 빈 문자열\",\n  \"반납시간\": \"HH:MM 또는 빈 문자열 (기본 18:00)\",\n  \"할인유형\": \"일반|학생|개인사업자/프리랜서\",\n  \"장비\": [{\"이름\": \"정확한 장비명\", \"수량\": 1}],\n  \"비고\": \"추가 메모\"\n}\n\n장비명 변환 규칙:\n- FX3, fx3 → 소니 FX3 (풀세트/바디세트/바디 구분은 고객 표현 그대로)\n- A7S3, a7s III → 소니 A7S3\n- 코모도, komodo → 레드 코모도\n- 부라노, burano → 부라노\n- A7M4 → 소니 A7M4\n- 70-200 GM2 → 소니 GM 70-200mm II\n- 24-70 GM2 → 소니 GM 24-70mm II\n- 600X → 어퓨쳐 600X\n- V마운트 배터리 → V마운트 배터리\n- C대, 시대 → C스탠드\n- 장비명은 최대한 정확하게, 모호하면 원문 그대로\n\n할인유형:\n- 학생/대학/졸작/과제 → \"학생\"\n- 프리랜서/사업자/크리에이터 → \"개인사업자/프리랜서\"\n- 그 외 → \"일반\"\n\n날짜:\n- 상대 날짜(내일, 모레 등)는 오늘 기준으로 계산. 오늘: " + Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy-MM-dd") + "\n- 시간 미언급 시: 반출 10:00, 반납 18:00\n\n이미지인 경우 채팅 내용을 읽어서 동일하게 파싱해.";

  var messages = [];
  var content = [];

  if (imageBase64 && imageMediaType) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: imageMediaType,
        data: imageBase64
      }
    });
  }

  if (text) {
    content.push({
      type: "text",
      text: text
    });
  } else if (!imageBase64) {
    return { error: "텍스트 또는 이미지가 필요합니다" };
  }

  if (content.length === 0) {
    return { error: "파싱할 내용이 없습니다" };
  }

  messages.push({ role: "user", content: content });

  var payload = {
    model: "claude-sonnet-4-20250514",
    max_tokens: 1024,
    system: systemPrompt,
    messages: messages
  };

  try {
    var response = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
      method: "post",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    var result = JSON.parse(response.getContentText());

    if (result.error) {
      return { error: "Claude API 오류: " + (result.error.message || JSON.stringify(result.error)) };
    }

    var textContent = "";
    if (result.content && result.content.length > 0) {
      textContent = result.content[0].text || "";
    }

    // JSON 파싱 시도
    try {
      // JSON 블록 추출 (마크다운 코드블록 안에 있을 수 있음)
      var jsonMatch = textContent.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        var parsed = JSON.parse(jsonMatch[0]);
        return { success: true, parsed: parsed };
      }
      return { error: "JSON 파싱 실패", raw: textContent };
    } catch (jsonErr) {
      return { error: "JSON 파싱 실패: " + jsonErr.message, raw: textContent };
    }
  } catch (fetchErr) {
    return { error: "API 호출 실패: " + fetchErr.message };
  }
}
