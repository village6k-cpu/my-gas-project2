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
 *
 * 진입 (sheetAPI.js):
 *   action=myPage&token=...            → getMyReservation(token)
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
  return {
    success: true,
    message: "MYPAGE_SECRET 준비 완료.",
    baseUrl: MYPAGE_CFG_().baseUrl || "(미설정)",
    kakaoUrl: p.getProperty("MYPAGE_KAKAO_URL") || "(미설정)",
    noticeSet: !!p.getProperty("MYPAGE_NOTICE")
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

/**
 * 고객용 내 예약 조회 — 본인 건 1건만, 민감정보 미포함.
 * 거래ID 토큰 → 계약마스터+스케줄상세 / 요청ID 토큰 → 확인요청 (등록되면 거래 뷰 포함)
 */
function getMyReservation(token) {
  var id = myPageVerify_(token);
  if (!id) return { success: false, error: "유효하지 않은 링크입니다" };

  var props = PropertiesService.getScriptProperties();
  var notice = props.getProperty("MYPAGE_NOTICE") || "";
  var kakaoUrl = props.getProperty("MYPAGE_KAKAO_URL") || ""; // 카카오톡 채널 링크 (선택)

  if (id.indexOf("RQ-") === 0) {
    var reqView = myPageRequestView_(id);
    if (!reqView) return { success: false, error: "요청을 찾을 수 없습니다" };
    // 등록 완료된 요청이면 거래 상세도 함께
    if (reqView.tradeId) {
      var tradeView = myPageTradeView_(reqView.tradeId);
      if (tradeView) return { success: true, kind: "trade", request: reqView, trade: tradeView, notice: notice, kakaoUrl: kakaoUrl };
    }
    return { success: true, kind: "request", request: reqView, notice: notice, kakaoUrl: kakaoUrl };
  }

  var trade = myPageTradeView_(id);
  if (!trade) return { success: false, error: "예약을 찾을 수 없습니다" };
  return { success: true, kind: "trade", trade: trade, notice: notice, kakaoUrl: kakaoUrl };
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

/** 등록(거래) 단계 뷰 — 계약마스터 + 스케줄상세 + 계약서 링크 */
function myPageTradeView_(tradeId) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var contractSheet = ss.getSheetByName("계약마스터");
  if (!contractSheet || contractSheet.getLastRow() < 2) return null;

  var rows = contractSheet.getRange(2, 1, contractSheet.getLastRow() - 1, 12).getValues();
  var c = null;
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][0]).trim() === tradeId) { c = rows[i]; break; }
  }
  if (!c) return null;

  // 스케줄상세에서 품목 (세트 헤더/구성품 구조 유지, 본인 거래 행만)
  var items = [];
  var schedSheet = ss.getSheetByName("스케줄상세");
  if (schedSheet && schedSheet.getLastRow() >= 2) {
    var sched = schedSheet.getRange(2, 1, schedSheet.getLastRow() - 1, 10).getValues();
    for (var s = 0; s < sched.length; s++) {
      if (String(sched[s][1]).trim() !== tradeId) continue; // B: 거래ID
      var setName = String(sched[s][2] || "").trim();   // C: 세트명
      var equip = String(sched[s][3] || "").trim();     // D: 장비명
      if (!setName && !equip) continue;
      items.push({
        name: equip || setName,
        setName: setName,
        isSetHeader: !!setName && !equip,
        qty: Number(sched[s][4]) || 1                    // E: 수량
      });
    }
  }

  var contractUrl = "";
  try {
    var link = getTimelineContractLink(tradeId);
    if (link && link.success) contractUrl = link.contractUrl || "";
  } catch (e) {}

  return {
    tradeId: tradeId,
    customerName: myPageMaskName_(c[1]),            // B: 예약자명
    checkoutAt: myPageFmtDT_(c[4], c[5]),           // E,F: 반출 일시
    returnAt: myPageFmtDT_(c[6], c[7]),             // G,H: 반납 일시
    status: String(c[9] || "").trim() || "예약",    // J: 계약상태
    discountType: String(c[10] || "").trim(),       // K: 할인유형
    items: items,
    contractUrl: contractUrl
  };
}
