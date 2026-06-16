/**
 * ====================================================================
 * myPage.js — 고객용 "내 예약 페이지" 백엔드 (토큰 기반)
 * ====================================================================
 *
 * 고객이 자기 예약 하나만 볼 수 있는 토큰 링크를 제공한다.
 * - 토큰 = {ID}.{HMAC-SHA256(ID, 비밀키) 앞 20자리} → 추측 불가, 저장 불필요
 * - ID = 거래ID(등록 후) 또는 요청ID(RQ-..., 등록 전)
 * - 응답에 연락처는 절대 포함하지 않고, 예약자명은 마스킹한다.
 * - 변경/연장/취소는 페이지에서 받지 않는다 — 카카오톡 채널 안내만 표시.
 * - 가용성/단가/다른 고객 정보는 노출하지 않는다.
 * - 고객에게 Google Sheets 계약서 원본 링크를 노출하지 않는다. 문서는 견적서 PDF만 별도 토큰 검증 후 제공한다.
 *
 * 진입 (sheetAPI.js):
 *   action=myPage&token=...            → getMyReservation(token)
 *   action=myPageEstimate&token=...    → getMyReservationEstimatePdf(token)
 *   action=run&func=getMyPageLink      → 직원/봇이 고객에게 보낼 링크 생성
 *
 * 1회 설정: setupMyPage({baseUrl,kakaoUrl,notice}) 실행 → 비밀키/고객 페이지 설정 준비.
 */

function MYPAGE_CFG_() {
  var p = PropertiesService.getScriptProperties();
  return {
    secret: p.getProperty("MYPAGE_SECRET") || "",
    baseUrl: (p.getProperty("MYPAGE_BASE_URL") || "").replace(/\/+$/, "")
  };
}

var MYPAGE_VIEW_CACHE_SECONDS_ = 90;
var MYPAGE_ESTIMATE_CACHE_SECONDS_ = 21600;

function myPageSafeKey_(value) {
  return String(value || "").trim().replace(/[^A-Za-z0-9가-힣_-]/g, "_").slice(0, 120);
}

function myPageReservationCacheKey_(id) {
  return "mypage_view_v4_" + myPageSafeKey_(id);
}

function myPageEstimateCacheKey_(tradeId) {
  return "mypage_estimate_pdf_v2_" + myPageSafeKey_(tradeId);
}

function myPageGetCachedJson_(key) {
  try {
    var raw = CacheService.getScriptCache().get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function myPagePutCachedJson_(key, value, seconds) {
  try {
    CacheService.getScriptCache().put(key, JSON.stringify(value), seconds || 60);
  } catch (e) {}
}

/** 1회 설정 — 비밀키가 없으면 생성. opts로 도메인/안내문도 함께 설정 가능 (API run 호출용) */
function setupMyPage(opts) {
  var p = PropertiesService.getScriptProperties();
  if (!p.getProperty("MYPAGE_SECRET")) {
    p.setProperty("MYPAGE_SECRET", Utilities.getUuid() + Utilities.getUuid());
  }
  opts = opts || {};
  if (opts.baseUrl) p.setProperty("MYPAGE_BASE_URL", String(opts.baseUrl).trim());
  if (opts.kakaoUrl) p.setProperty("MYPAGE_KAKAO_URL", String(opts.kakaoUrl).trim());
  if (opts.notice) p.setProperty("MYPAGE_NOTICE", String(opts.notice));
  if (opts.tplRegister) p.setProperty("POPBILL_TPL_REGISTER", String(opts.tplRegister).trim());
  return {
    success: true,
    message: "MYPAGE_SECRET 준비 완료.",
    baseUrl: MYPAGE_CFG_().baseUrl || "(미설정)",
    kakaoUrl: p.getProperty("MYPAGE_KAKAO_URL") || "(미설정)",
    noticeSet: !!p.getProperty("MYPAGE_NOTICE"),
    tplRegister: p.getProperty("POPBILL_TPL_REGISTER") || "(미설정)"
  };
}

function myPageSig_(id) {
  var cfg = MYPAGE_CFG_();
  if (!cfg.secret) throw new Error("MYPAGE_SECRET 미설정 — setupMyPage() 먼저 실행");
  var raw = Utilities.computeHmacSha256Signature(String(id), cfg.secret);
  var hex = raw.map(function (b) {
    var v = (b < 0 ? b + 256 : b).toString(16);
    return v.length === 1 ? "0" + v : v;
  }).join("");
  return hex.slice(0, 20);
}

/** 토큰 파싱+검증 → ID 반환 (실패 시 null) */
function myPageVerify_(token) {
  var s = String(token || "").trim();
  var dot = s.lastIndexOf(".");
  if (dot <= 0) return null;
  var id = s.slice(0, dot);
  var sig = s.slice(dot + 1);
  if (!id || !sig) return null;
  try {
    if (myPageSig_(id) !== sig) return null;
  } catch (e) {
    return null;
  }
  return id;
}

/** 직원/봇용 — 고객에게 보낼 내 예약 링크 생성 (거래ID 또는 요청ID) */
function getMyPageLink(id) {
  id = String(id || "").trim();
  if (!id) return { success: false, error: "id(거래ID 또는 요청ID) 필수" };
  var token = id + "." + myPageSig_(id);
  var cfg = MYPAGE_CFG_();
  return {
    success: true,
    id: id,
    token: token,
    url: (cfg.baseUrl || "") + "/my?t=" + encodeURIComponent(token)
  };
}

/** 이름 마스킹: 홍길동→홍*동, 홍길→홍*, 단자/빈값은 그대로 */
function myPageMaskName_(name) {
  var s = String(name || "").trim();
  if (s.length <= 1) return s;
  if (s.length === 2) return s.charAt(0) + "*";
  return s.charAt(0) + Array(s.length - 1).join("*") + s.charAt(s.length - 1);
}

function myPageFmtDT_(dateVal, timeVal) {
  var dt = parseDT(dateVal, timeVal);
  if (!dt) return "";
  return Utilities.formatDate(dt, "Asia/Seoul", "yyyy-MM-dd HH:mm");
}

function myPageNormalizeDateText_(value) {
  if (value instanceof Date) return Utilities.formatDate(value, "Asia/Seoul", "yyyy-MM-dd");
  var s = String(value || "").trim();
  if (!s) return "";

  var m = s.match(/^(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (m) return m[1] + "-" + ("0" + m[2]).slice(-2) + "-" + ("0" + m[3]).slice(-2);
  return s;
}

function myPageNormalizeTimeText_(value) {
  if (value instanceof Date) return Utilities.formatDate(value, "Asia/Seoul", "HH:mm");
  var s = String(value || "").trim();
  if (!s) return "";

  var m = s.match(/(\d{1,2}):(\d{2})/);
  if (m) return ("0" + m[1]).slice(-2) + ":" + m[2];
  return s;
}

function myPageJoinDTText_(dateVal, timeVal) {
  var d = myPageNormalizeDateText_(dateVal);
  var t = myPageNormalizeTimeText_(timeVal);
  return d ? (d + (t ? " " + t : "")) : "";
}

function myPageFindRowByExact_(sheet, col, value) {
  if (!sheet || sheet.getLastRow() < 2) return 0;
  var range = sheet.getRange(2, col, sheet.getLastRow() - 1, 1);
  var finder = range.createTextFinder(String(value));
  finder.matchEntireCell(true);
  var cell = finder.findNext();
  return cell ? cell.getRow() : 0;
}

function myPageFindRowsByExact_(sheet, col, value) {
  if (!sheet || sheet.getLastRow() < 2) return [];
  var range = sheet.getRange(2, col, sheet.getLastRow() - 1, 1);
  var finder = range.createTextFinder(String(value));
  finder.matchEntireCell(true);
  var cells = finder.findAll() || [];
  return cells.map(function(cell) { return cell.getRow(); }).sort(function(a, b) { return a - b; });
}

function myPageReadRows_(sheet, rowNums, width) {
  if (!rowNums || rowNums.length === 0) return [];
  var rows = [];
  var start = rowNums[0];
  var prev = rowNums[0];

  function flushGroup_(s, e) {
    var len = e - s + 1;
    var values = sheet.getRange(s, 1, len, width).getValues();
    var display = sheet.getRange(s, 1, len, width).getDisplayValues();
    for (var i = 0; i < len; i++) rows.push({ values: values[i], display: display[i] });
  }

  for (var i = 1; i < rowNums.length; i++) {
    if (rowNums[i] === prev + 1) {
      prev = rowNums[i];
      continue;
    }
    flushGroup_(start, prev);
    start = rowNums[i];
    prev = rowNums[i];
  }
  flushGroup_(start, prev);
  return rows;
}

function myPageTradeScheduleView_(ss, tradeId) {
  var schedSheet = ss.getSheetByName("스케줄상세");
  if (!schedSheet || schedSheet.getLastRow() < 2) return { checkoutAt: "", returnAt: "", items: [] };

  var rows = myPageReadRows_(schedSheet, myPageFindRowsByExact_(schedSheet, 2, tradeId), 10);
  var view = { checkoutAt: "", returnAt: "", items: [] };
  for (var i = 0; i < rows.length; i++) {
    var values = rows[i].values;
    var display = rows[i].display;
    if (!view.checkoutAt) {
      view.checkoutAt = myPageJoinDTText_(display[5] || values[5], display[6] || values[6]);
      view.returnAt = myPageJoinDTText_(display[7] || values[7], display[8] || values[8]);
    }
    var setName = String(values[2] || "").trim();   // C: 세트명
    var equip = String(values[3] || "").trim();     // D: 장비명
    if (!setName && !equip) continue;
    view.items.push({
      name: equip || setName,
      setName: setName,
      isSetHeader: !!setName && !equip,
      qty: Number(values[4]) || 1                    // E: 수량
    });
  }
  return view;
}

function myPageScheduleSnapshot_(ss, tradeId) {
  var view = myPageTradeScheduleView_(ss, tradeId);
  if (!view || (!view.checkoutAt && !view.returnAt)) return null;
  return {
    checkoutAt: view.checkoutAt,
    returnAt: view.returnAt
  };
}

/**
 * 고객용 내 예약 조회 — 본인 건 1건만, 민감정보 미포함.
 * 거래ID 토큰 → 계약마스터+스케줄상세 / 요청ID 토큰 → 확인요청 (등록되면 거래 뷰 포함)
 */
function getMyReservation(token) {
  var id = myPageVerify_(token);
  if (!id) return { success: false, error: "유효하지 않은 링크입니다" };

  var cacheKey = myPageReservationCacheKey_(id);
  var cached = myPageGetCachedJson_(cacheKey);
  if (cached) return cached;

  var props = PropertiesService.getScriptProperties();
  var notice = props.getProperty("MYPAGE_NOTICE") || "";
  var kakaoUrl = props.getProperty("MYPAGE_KAKAO_URL") || ""; // 카카오톡 채널 링크 (선택)
  var result;

  if (id.indexOf("RQ-") === 0) {
    var reqView = myPageRequestView_(id);
    if (!reqView) return { success: false, error: "요청을 찾을 수 없습니다" };
    // 등록 완료된 요청이면 거래 상세도 함께
    if (reqView.tradeId) {
      var tradeView = myPageTradeView_(reqView.tradeId);
      if (tradeView) {
        result = { success: true, kind: "trade", request: reqView, trade: tradeView, notice: notice, kakaoUrl: kakaoUrl };
        myPagePutCachedJson_(cacheKey, result, MYPAGE_VIEW_CACHE_SECONDS_);
        return result;
      }
    }
    result = { success: true, kind: "request", request: reqView, notice: notice, kakaoUrl: kakaoUrl };
    myPagePutCachedJson_(cacheKey, result, MYPAGE_VIEW_CACHE_SECONDS_);
    return result;
  }

  var trade = myPageTradeView_(id);
  if (!trade) return { success: false, error: "예약을 찾을 수 없습니다" };
  result = { success: true, kind: "trade", trade: trade, notice: notice, kakaoUrl: kakaoUrl };
  myPagePutCachedJson_(cacheKey, result, MYPAGE_VIEW_CACHE_SECONDS_);
  return result;
}

/** 확인요청 단계 뷰 — 같은 요청ID의 행 묶음 */
function myPageRequestView_(reqID) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("확인요청");
  if (!sheet || sheet.getLastRow() < 2) return null;

  var data = sheet.getRange(2, 1, sheet.getLastRow() - 1, 16).getValues();
  var first = null;
  var items = [];
  for (var i = 0; i < data.length; i++) {
    if (String(data[i][0]).trim() !== reqID) continue;
    if (!first) first = data[i];
    var equipName = String(data[i][5] || "").trim(); // F: 장비/세트명
    if (equipName) {
      items.push({
        name: equipName,
        qty: Number(data[i][6]) || 1 // G: 수량
      });
    }
  }
  if (!first) return null;

  var regStatus = String(first[14] || "").trim(); // O: 등록상태
  var tradeId = String(first[15] || "").trim();   // P: 거래ID
  // 같은 요청 묶음에서 O/P가 첫 행에 없을 수 있어 전체에서 보강
  for (var j = 0; j < data.length; j++) {
    if (String(data[j][0]).trim() !== reqID) continue;
    if (!regStatus) regStatus = String(data[j][14] || "").trim();
    if (!tradeId) tradeId = String(data[j][15] || "").trim();
  }

  var status = "확인중";
  if (regStatus.indexOf("등록완료") !== -1) status = "등록완료";
  else if (regStatus.indexOf("거절") !== -1) status = "거절";
  else if (regStatus.indexOf("보류") !== -1) status = "보류";

  return {
    reqID: reqID,
    status: status,
    checkoutAt: myPageFmtDT_(first[1], first[2]), // B,C
    returnAt: myPageFmtDT_(first[3], first[4]),   // D,E
    customerName: myPageMaskName_(first[10]),     // K
    items: items,
    tradeId: status === "등록완료" ? tradeId : ""
  };
}

function myPageVillageOpsApiUrl_(props) {
  if (typeof getVillageOpsApiUrl_ === "function") return getVillageOpsApiUrl_(props);
  return String(
    props.getProperty("개고생2_API_URL") ||
    props.getProperty("VILLAGE2_API_URL") ||
    props.getProperty("VILLAGE_OPS_API_URL") ||
    "https://script.google.com/macros/s/AKfycbwX2V0SqRf23DCwaVojlc5YFXKTfMNLBt68edpGmCx8j0i9hkYdP_bXHKEGIcde2iS5EA/exec"
  ).trim();
}

function myPageVillageOpsApiKey_(props) {
  if (typeof getVillageOpsApiKey_ === "function") return getVillageOpsApiKey_(props);
  return String(
    props.getProperty("개고생2_API_KEY") ||
    props.getProperty("VILLAGE_OPS_KEY") ||
    "village2026"
  ).trim();
}

function myPageEstimatePdfUrl_(tradeId) {
  tradeId = String(tradeId || "").trim();
  if (!tradeId) throw new Error("거래ID 필수");

  var cacheKey = myPageEstimateCacheKey_(tradeId);
  var cached = myPageGetCachedJson_(cacheKey);
  if (cached && cached.pdfUrl) return cached.pdfUrl;

  var props = PropertiesService.getScriptProperties();
  var url = myPageVillageOpsApiUrl_(props);
  var payload = {
    action: "previewQuote",
    id: tradeId,
    key: myPageVillageOpsApiKey_(props),
    reuse: "1"
  };
  var qs = Object.keys(payload).map(function(key) {
    return encodeURIComponent(key) + "=" + encodeURIComponent(payload[key]);
  }).join("&");
  var sep = url.indexOf("?") === -1 ? "?" : "&";
  var res = UrlFetchApp.fetch(url + sep + qs, {
    method: "get",
    muteHttpExceptions: true
  });
  var text = res.getContentText();
  var data;
  try {
    data = JSON.parse(text);
  } catch (parseErr) {
    throw new Error("견적서 PDF 응답 파싱 실패");
  }
  if (res.getResponseCode() < 200 || res.getResponseCode() >= 300) {
    throw new Error("견적서 PDF 생성 실패: HTTP " + res.getResponseCode());
  }
  if (data.error) throw new Error(data.error);

  var pdfUrl = String(data.pdfUrl || (data.result && data.result.pdfUrl) || "").trim();
  if (!pdfUrl || !/^https:\/\/.+/i.test(pdfUrl)) throw new Error("견적서 PDF URL을 받지 못했습니다");
  myPagePutCachedJson_(cacheKey, { pdfUrl: pdfUrl }, MYPAGE_ESTIMATE_CACHE_SECONDS_);
  return pdfUrl;
}

function myPagePrimeFastCaches_(id) {
  id = String(id || "").trim();
  if (!id) return { success: false, error: "id 필수" };

  var token = id + "." + myPageSig_(id);
  var warmed = { success: true, id: id, reservation: false, estimate: false, publicApi: false };

  try {
    getMyReservation(token);
    warmed.reservation = true;
  } catch (e) {}

  if (id.indexOf("RQ-") !== 0) {
    try {
      var quotePdfUrl = myPageEstimatePdfUrl_(id);
      if (quotePdfUrl) {
        warmed.estimate = true;
      }
    } catch (estimateErr) {}
  }

  try {
    var cfg = MYPAGE_CFG_();
    if (cfg.baseUrl) {
      var publicUrl = cfg.baseUrl + "/api/my?t=" + encodeURIComponent(token);
      UrlFetchApp.fetch(publicUrl, { method: "get", muteHttpExceptions: true });
      warmed.publicApi = true;
    }
  } catch (publicErr) {}

  return warmed;
}

function getMyReservationEstimatePdf(token) {
  var id = myPageVerify_(token);
  if (!id) return { success: false, error: "유효하지 않은 링크입니다" };

  var tradeId = id;
  if (id.indexOf("RQ-") === 0) {
    var reqView = myPageRequestView_(id);
    if (!reqView) return { success: false, error: "요청을 찾을 수 없습니다" };
    tradeId = reqView.tradeId || "";
    if (!tradeId) return { success: false, error: "예약 확정 후 견적서 PDF를 확인할 수 있습니다" };
  }

  if (!myPageTradeExists_(tradeId)) return { success: false, error: "예약을 찾을 수 없습니다" };

  try {
    return {
      success: true,
      tradeId: tradeId,
      pdfUrl: myPageEstimatePdfUrl_(tradeId)
    };
  } catch (e) {
    return { success: false, error: e.message || "견적서 PDF 생성 실패" };
  }
}

/** 등록(거래) 단계 뷰 — 계약마스터 + 스케줄상세. 고객에게 문서 원본 링크는 내려주지 않는다. */
function myPageTradeView_(tradeId) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var contractSheet = ss.getSheetByName("계약마스터");
  if (!contractSheet || contractSheet.getLastRow() < 2) return null;

  var row = myPageFindRowByExact_(contractSheet, 1, tradeId);
  if (!row) return null;
  var c = contractSheet.getRange(row, 1, 1, 12).getValues()[0];

  // 스케줄상세에서 품목 (세트 헤더/구성품 구조 유지, 본인 거래 행만)
  var scheduleView = myPageTradeScheduleView_(ss, tradeId);

  return {
    tradeId: tradeId,
    customerName: myPageMaskName_(c[1]),            // B: 예약자명
    checkoutAt: (scheduleView && scheduleView.checkoutAt) || myPageFmtDT_(c[4], c[5]),
    returnAt: (scheduleView && scheduleView.returnAt) || myPageFmtDT_(c[6], c[7]),
    status: String(c[9] || "").trim() || "예약",    // J: 계약상태
    discountType: String(c[10] || "").trim(),       // K: 할인유형
    items: (scheduleView && scheduleView.items) || []
  };
}

function myPageTradeExists_(tradeId) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var contractSheet = ss.getSheetByName("계약마스터");
  return !!myPageFindRowByExact_(contractSheet, 1, tradeId);
}
