/**
 * ====================================================================
 * sheetAPI.gs — 빌리지 통합 웹앱 API
 * ====================================================================
 *
 * 모든 외부 API 호출을 이 파일에서 처리합니다.
 * - Claude 에이전트: 시트 읽기/쓰기/검색
 * - 스케줄 관리: 가용확인/등록/보류/거절/목록조회
 *
 * ★ 보안: API_KEY 인증 필수 ★
 *
 * 사용 예시:
 * GET  ?key=village2026&action=read&sheet=확인요청
 * GET  ?key=village2026&action=list
 * GET  ?key=village2026&action=scan
 * POST ?key=village2026  (body: {action:"확인", reqID:"RQ-..."})
 * POST ?key=village2026  (body: {action:"write", sheet:"...", range:"...", values:[...]})
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ★ API 비밀키 ★
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const API_KEY = "village2026";

// 쓰기 허용 시트 화이트리스트
const WRITABLE_SHEETS = ["확인요청", "스케줄상세", "신규장비 추가", "실사 기록"];
function isWritableSheet(sheetName) {
  return WRITABLE_SHEETS.indexOf(sheetName) !== -1;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 웹앱 엔드포인트 (프로젝트 전체에서 유일)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function doGet(e) {
  var params = e.parameter || {};

  // ── 페이지 라우팅 ──
  if (params.page) {
    var pageMap = {
      "timeline": { file: "timelineMobile", title: "빌리지 스케줄" },
      "dashboard": { file: "dashboard",    title: "빌리지 오늘 일정" },
      "manage":   { file: "requestManage",  title: "확인요청 관리" }
    };
    var pg = pageMap[params.page];
    if (pg) {
      var html = HtmlService.createHtmlOutputFromFile(pg.file);
      var webAppUrl = ScriptApp.getService().getUrl();
      var content = html.getContent().replace(
        'var API_URL = "";',
        'var API_URL = "' + webAppUrl + '";'
      );

      // ── dashboard는 초기 데이터를 HTML에 직접 박아서 fetch 왕복 1회 절약 ──
      if (params.page === "dashboard") {
        try {
          var initialData = getDashboardData(params.date || null, false);
          content = content.replace(
            'var INITIAL_DATA = null;',
            'var INITIAL_DATA = ' + JSON.stringify(initialData) + ';'
          );
        } catch (err) {
          // 데이터 조회 실패해도 페이지는 로드 — 클라이언트가 fetch로 재시도
          Logger.log("dashboard 초기 데이터 로드 실패: " + err.message);
        }
        try {
          var initialEquipNames = getDashboardEquipNameList_(SpreadsheetApp.getActiveSpreadsheet());
          content = content.replace(
            'var INITIAL_EQUIP_NAMES = null;',
            'var INITIAL_EQUIP_NAMES = ' + JSON.stringify(initialEquipNames) + ';'
          );
        } catch (errEquipNames) {
          // 장비명 목록 실패는 모달 오픈 시 전용 API로 재시도
        }
      }

      // ── timeline은 초기 데이터를 HTML에 직접 박아서 첫 API 왕복 1회 절약 ──
      if (params.page === "timeline") {
        try {
          var initialTimelineRange = getInitialTimelineMobileRange_();
          var initialTimelineData = getTimelineData({
            from: initialTimelineRange.from,
            to: initialTimelineRange.to,
            compact: 2
          });
          content = content.replace(
            'var INITIAL_TIMELINE_DATA = null;',
            'var INITIAL_TIMELINE_DATA = ' + JSON.stringify(initialTimelineData) + ';'
          );
          content = content.replace(
            'var INITIAL_TIMELINE_KEY = "";',
            'var INITIAL_TIMELINE_KEY = "' + initialTimelineRange.from + '_' + initialTimelineRange.to + '";'
          );
        } catch (errTimeline) {
          // 데이터 조회 실패해도 페이지는 로드, 클라이언트가 fetch로 재시도
        }
      }

      html.setContent(content);
      html.setTitle(pg.title);
      html.setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
      return html;
    }
  }

  return handleRequest(e);
}

function doPost(e) {
  return handleRequest(e);
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 통합 요청 처리
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function handleRequest(e) {
  try {
    // ── 인증 확인 ──
    let params = e.parameter || {};

    // POST body에서도 key/action 추출
    let postBody = {};
    if (e.postData) {
      try { postBody = JSON.parse(e.postData.contents); } catch(pe) {}
    }

    const key = params.key || postBody.key;
    if (key !== API_KEY) {
      return jsonResponse({ error: "인증 실패. key 파라미터를 확인하세요." }, 403);
    }

    const action = params.action || postBody.action || "";

    switch (action) {

      // ━━━ 시트 범용 API ━━━

      case "sheets":
        return jsonResponse(getSheetList());

      case "info":
        return jsonResponse(getSheetInfo(params.sheet));

      case "read":
        return jsonResponse(readSheet(
          params.sheet,
          params.range || null,
          parseInt(params.limit) || 0
        ));

      case "write": {
        var wSheet = postBody.sheet;
        if (!isWritableSheet(wSheet)) return jsonResponse({ error: "쓰기 허용되지 않은 시트: " + wSheet });
        return jsonResponse(writeSheet(wSheet, postBody.range, postBody.values));
      }

      case "append": {
        var aSheet = postBody.sheet;
        if (!isWritableSheet(aSheet)) return jsonResponse({ error: "쓰기 허용되지 않은 시트: " + aSheet });
        return jsonResponse(appendRows(aSheet, postBody.values));
      }

      case "update": {
        var uSheet = params.sheet || postBody.sheet;
        if (!isWritableSheet(uSheet)) return jsonResponse({ error: "쓰기 허용되지 않은 시트: " + uSheet });
        return jsonResponse(updateCell(uSheet, params.cell || postBody.cell, params.value !== undefined ? params.value : postBody.value));
      }

      case "search":
        return jsonResponse(searchSheet(
          params.sheet,
          params.col,
          params.query
        ));

      case "run":
        var runParams = Object.assign({}, params);
        if (postBody.args) runParams.args = postBody.args;
        return jsonResponse(runFunction(params.func || postBody.func, runParams));

      case "timeline": {
        var skipTimelineCache = (params.nocache === '1' || params.nocache === 'true' ||
          postBody.nocache === 1 || postBody.nocache === '1' || postBody.nocache === true);
        return jsonResponse(getTimelineData({
          from: params.from || postBody.from || params.start || postBody.start || "",
          to: params.to || postBody.to || params.end || postBody.end || "",
          skipCache: skipTimelineCache,
          compact: params.compact || postBody.compact || params.slim || postBody.slim || "",
          all: params.all || postBody.all || params.fullRange || postBody.fullRange || "",
          includeContractUrl: params.includeContractUrl || postBody.includeContractUrl || "",
          includeStock: params.includeStock || postBody.includeStock || "",
          profile: params.profile || postBody.profile || ""
        }));
      }

      case "timelineContract":
        return jsonResponse(getTimelineContractLink(params.tid || postBody.tid || params.tradeId || postBody.tradeId || ""));

      case "updateTime": {
        var row = Number(params.row || postBody.row);
        var newStart = params.start || postBody.start;
        var newEnd   = params.end   || postBody.end;
        var rowIndices = params.rowIndices || postBody.rowIndices || null;
        if (!row || !newStart || !newEnd) return jsonResponse({ success: false, message: "row, start, end 필수" });
        return jsonResponse(updateScheduleTime(row, newStart, newEnd, rowIndices));
      }

      case "updateStatus": {
        var row = Number(params.row || postBody.row);
        var newStatus = params.status || postBody.status;
        var rowIndices = params.rowIndices || postBody.rowIndices || null;
        if (!row || !newStatus) return jsonResponse({ success: false, message: "row, status 필수" });
        return jsonResponse(updateScheduleStatus(row, newStatus, rowIndices));
      }

      case "aiParse": {
        var text = params.text || postBody.text || "";
        var imageBase64 = postBody.image || "";
        var imageMediaType = postBody.imageType || "image/png";
        return jsonResponse(parseWithClaude(text, imageBase64, imageMediaType));
      }

      case "registerAsync": {
        var reqID = params.reqID || postBody.reqID;
        if (!reqID) return jsonResponse({ success: false, error: "reqID 필수" });
        return jsonResponse(scheduleRegister(reqID));
      }

      case "dashboard":
        // nocache=1 이면 캐시 우회 (새로고침 버튼용)
        var skipCache = (params.nocache === '1' || postBody.nocache === 1 || postBody.nocache === '1');
        return jsonResponse(getDashboardData(params.date || postBody.date || null, skipCache, {
          evaluateRisk: params.riskEval || postBody.riskEval
        }));

      case "dashboardEquipNames":
        return jsonResponse({
          success: true,
          names: getDashboardEquipNameList_(SpreadsheetApp.getActiveSpreadsheet())
        });

      case "dashboardEquipmentCatalog":
        return jsonResponse({
          success: true,
          catalog: getDashboardEquipmentCatalog_(SpreadsheetApp.getActiveSpreadsheet())
        });

      case "myPage":
        // 고객용 내 예약 조회 — 거래/요청별 토큰 검증, 연락처 등 민감정보 미포함 (myPage.js)
        return jsonResponse(getMyReservation(params.token || postBody.token || ""));

      case "dashboardSearch":
        return jsonResponse(getDashboardSearchData(
          params.q || params.query || postBody.q || postBody.query || "",
          {
            limit: Number(params.limit || postBody.limit) || 80,
            profile: params.profile || postBody.profile,
            summary: params.summary || postBody.summary,
            detailGroup: params.detailGroup || postBody.detailGroup
          }
        ));

      case "dashboardSearchIndex":
        return jsonResponse(getDashboardSearchClientIndex_());

      case "dashboardContractExtras":
        return jsonResponse(getDashboardContractExtrasByIds_(
          params.tids || postBody.tids || params.tradeIds || postBody.tradeIds || params.ids || postBody.ids || []
        ));

      case "dashboardNotes":
        return jsonResponse(getDashboardNotes_());

      case "saveDashboardNotes":
        return jsonResponse(saveDashboardNotes_(
          params.notes !== undefined ? params.notes : postBody.notes
        ));

      case "operations": {
        var opSkip = (params.nocache === '1' || params.nocache === 'true' ||
          postBody.nocache === 1 || postBody.nocache === '1' || postBody.nocache === true);
        return jsonResponse(getOperationsData_(params.date || postBody.date || null, opSkip));
      }

      case "equipmentRiskSend":
        return jsonResponse(sendEquipmentRiskGuidance_(postBody.payload || postBody));

      case "equipmentRiskEvent":
        return jsonResponse(recordEquipmentRiskEvent_(postBody.payload || postBody));

      case "toggleSetup":
        return jsonResponse(toggleSetupDone(
          params.tid || postBody.tid,
          (params.done === '1' || params.done === 'true' || postBody.done === true || postBody.done === '1' || postBody.done === 1)
        ));

      case "toggleReturn":
        return jsonResponse(toggleReturnDone(
          params.tid || postBody.tid,
          (params.done === '1' || params.done === 'true' || postBody.done === true || postBody.done === '1' || postBody.done === 1)
        ));

      case "toggleItem":
        return jsonResponse(toggleItemCheck(
          params.scheduleId || postBody.scheduleId,
          params.phase || postBody.phase,
          (params.done === '1' || params.done === 'true' || postBody.done === true || postBody.done === '1' || postBody.done === 1)
        ));

      case "updateEquipmentCheck":
        return jsonResponse(updateEquipmentCheck(
          params.scheduleId || postBody.scheduleId,
          params.tid || postBody.tid || params.tradeId || postBody.tradeId,
          params.label || postBody.label || params.equipName || postBody.equipName,
          params.field || postBody.field,
          params.value !== undefined ? params.value : postBody.value
        ));

      case "updateContractStatus":
        return jsonResponse(updateDashboardContractStatus(
          params.tid || postBody.tid || params.tradeId || postBody.tradeId,
          params.status || postBody.status
        ));

      case "addEquip":
        return jsonResponse(dashboardAddEquipments(
          params.tid || postBody.tid,
          [{
            name: params.equipName || postBody.equipName,
            qty: params.qty || postBody.qty || 1
          }],
          { dryRun: params.dryRun || postBody.dryRun, profile: params.profile || postBody.profile }
        ));

      case "addEquips":
      case "addEquipBatch":
        return jsonResponse(dashboardAddEquipments(
          params.tid || postBody.tid,
          params.entries || postBody.entries || params.items || postBody.items,
          { dryRun: params.dryRun || postBody.dryRun, profile: params.profile || postBody.profile }
        ));

      case "onsiteAddon":
      case "recordOnsiteAddon":
        return jsonResponse(dashboardRecordOnsiteAddon(
          params.tid || postBody.tid,
          params.entries || postBody.entries || params.items || postBody.items,
          {
            dryRun: params.dryRun || postBody.dryRun,
            settlementStatus: params.settlementStatus || postBody.settlementStatus || params.settlement_status || postBody.settlement_status,
            actorName: params.actorName || postBody.actorName || params.actor_name || postBody.actor_name
          }
        ));

      case "removeEquip":
        return jsonResponse(dashboardRemoveEquipment(
          params.tid || postBody.tid,
          params.equipName || postBody.equipName,
          params.scheduleId || postBody.scheduleId
        ));

      case "updateEquipQty":
        return jsonResponse(dashboardUpdateEquipmentQty(
          params.tid || postBody.tid,
          params.scheduleId || postBody.scheduleId,
          params.qty || postBody.qty,
          { dryRun: params.dryRun || postBody.dryRun }
        ));

      case "updateEquipName":
        return jsonResponse(dashboardUpdateEquipmentName(
          params.tid || postBody.tid,
          params.scheduleId || postBody.scheduleId,
          params.equipName || postBody.equipName || params.name || postBody.name,
          { dryRun: params.dryRun || postBody.dryRun }
        ));

      case "tradeCandidates":
        return jsonResponse(findTradeCandidatesForSchedule(
          params.name || postBody.name || "",
          params.date || postBody.date || ""
        ));

      case "scheduleAddEquip":
        return jsonResponse(dashboardAddEquipments(
          params.tid || postBody.tid,
          [{
            name: params.equipName || postBody.equipName,
            qty: params.qty || postBody.qty || 1
          }],
          { dryRun: params.dryRun || postBody.dryRun, profile: params.profile || postBody.profile }
        ));

      case "scheduleAddEquips":
        return jsonResponse(dashboardAddEquipments(
          params.tid || postBody.tid,
          params.entries || postBody.entries || params.items || postBody.items,
          { dryRun: params.dryRun || postBody.dryRun, profile: params.profile || postBody.profile }
        ));

      case "scheduleRemoveEquip":
        return jsonResponse(dashboardRemoveEquipment(
          params.tid || postBody.tid,
          params.equipName || postBody.equipName
        ));

      case "scheduleUpdateEquipQty":
        return jsonResponse(dashboardUpdateEquipmentQty(
          params.tid || postBody.tid,
          params.scheduleId || postBody.scheduleId,
          params.qty || postBody.qty,
          { dryRun: params.dryRun || postBody.dryRun }
        ));

      case "updatePayment":
        return jsonResponse(updateTradePaymentMethod(
          params.tid || postBody.tid,
          params.method || postBody.method || ""
        ));

      case "updateBillingCompany":
        return jsonResponse(updateTradeBillingCompany(
          params.tid || postBody.tid || params.tradeId || postBody.tradeId,
          params.billingCompany !== undefined ? params.billingCompany : postBody.billingCompany
        ));

      case "updateTradeProof":
        return jsonResponse(updateTradeProofField(
          params.tid || postBody.tid || params.tradeId || postBody.tradeId,
          params.field || postBody.field,
          params.value !== undefined ? params.value : postBody.value
        ));

      case "sendEstimate":
        return jsonResponse(requestTradeEstimate(
          params.tid || postBody.tid || params.tradeId || postBody.tradeId
        ));

      case "regenerateContract":
        var contractExtraText =
          params.extraText !== undefined ? params.extraText :
          postBody.extraText !== undefined ? postBody.extraText :
          params.추가요청 !== undefined ? params.추가요청 :
          postBody.추가요청 !== undefined ? postBody.추가요청 :
          params.memo !== undefined ? params.memo :
          postBody.memo !== undefined ? postBody.memo :
          params.note !== undefined ? params.note : postBody.note;
        return jsonResponse(regenerateContractById(
          params.tid || postBody.tid || params.tradeId || postBody.tradeId || params.거래ID || postBody.거래ID,
          contractExtraText
        ));

      case "issueProof":
        return jsonResponse(requestTradeProofIssue(
          params.tid || postBody.tid || params.tradeId || postBody.tradeId
        ));

      case "dashboardPhotoMeta":
        return jsonResponse(inspectDashboardPhotoSheet());

      case "dashboardPhotos":
        return jsonResponse(getDashboardPhotosForTrade(
          params.tid || postBody.tid || params.tradeId || postBody.tradeId
        ));

      case "dashboardPhotosBatch":
        return jsonResponse(getDashboardPhotosForTrades(
          params.tids || postBody.tids || []
        ));

      case "uploadDashboardPhoto":
        return jsonResponse(uploadDashboardPhoto(
          params.tid || postBody.tid || params.tradeId || postBody.tradeId,
          params.phase || postBody.phase,
          params.fileName || postBody.fileName,
          params.mimeType || postBody.mimeType,
          params.data || postBody.data || params.base64 || postBody.base64,
          params.memo || postBody.memo
        ));

      case "paymentMeta":
        return jsonResponse(inspectTradePaymentColumn());

      // ━━━ 스케줄 관리 API ━━━

      case "list":
        return doListPending();

      case "scan":
        return doScanAll();

      case "확인": {
        const reqID = params.reqID || postBody.reqID;
        if (!reqID) return jsonResponse({ status: "ERROR", message: "reqID 필수" });
        return doScheduleAction("확인", reqID);
      }

      case "등록": {
        const reqID = params.reqID || postBody.reqID;
        if (!reqID) return jsonResponse({ status: "ERROR", message: "reqID 필수" });
        return doScheduleAction("등록", reqID);
      }

      case "보류": {
        const reqID = params.reqID || postBody.reqID;
        if (!reqID) return jsonResponse({ status: "ERROR", message: "reqID 필수" });
        return doScheduleAction("보류", reqID);
      }

      case "거절": {
        const reqID = params.reqID || postBody.reqID;
        if (!reqID) return jsonResponse({ status: "ERROR", message: "reqID 필수" });
        return doScheduleAction("거절", reqID);
      }

      case "발송승인": {
        const reqID = params.reqID || postBody.reqID;
        if (!reqID) return jsonResponse({ status: "ERROR", message: "reqID 필수" });
        return doScheduleAction("발송승인", reqID);
      }

      default:
        return jsonResponse({
          error: "알 수 없는 action: " + action,
          available: {
            시트API: ["sheets", "info", "read", "write", "append", "update", "search", "run"],
            스케줄API: ["list", "scan", "확인", "등록", "보류", "거절", "발송승인"]
          },
          usage: {
            read: "GET ?key=...&action=read&sheet=시트명&range=A1:E10&limit=100",
            write: "POST {key, action:'write', sheet, range, values}",
            append: "POST {key, action:'append', sheet, values}",
            update: "GET ?key=...&action=update&sheet=시트명&cell=A1&value=값",
            search: "GET ?key=...&action=search&sheet=시트명&col=D&query=FX3",
            list: "GET ?key=...&action=list (확인요청 대기 목록)",
            scan: "GET ?key=...&action=scan (미처리 건 전체 스캔)",
            "확인/등록/보류/거절/발송승인": "POST {key, action:'확인', reqID:'RQ-...'}"
          }
        });
    }

  } catch (error) {
    return jsonResponse({ error: error.message, stack: error.stack }, 500);
  }
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 스케줄 관리 API 함수들
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 대기 중인 확인요청 목록 반환
 * GET ?key=...&action=list
 */
function doListPending() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("확인요청");
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return jsonResponse({ status: "OK", count: 0, items: [] });

  const data = sheet.getRange(2, 1, lastRow - 1, 18).getValues();

  // Date → 문자열 변환 헬퍼 (getDisplayValues 호출 제거)
  function fmtCell(v) {
    if (v instanceof Date) return Utilities.formatDate(v, "Asia/Seoul", "yyyy-MM-dd HH:mm");
    return String(v || "");
  }

  // ── 단일 패스로 reqID별 그룹핑 ──
  const groupMap = {};   // reqID → { firstIdx, items, isCompleted }
  const groupOrder = []; // 출현 순서 보존

  for (let i = 0; i < data.length; i++) {
    const reqID = data[i][0];
    if (!reqID) continue;

    if (!groupMap[reqID]) {
      groupMap[reqID] = { firstIdx: i, items: [], isCompleted: false };
      groupOrder.push(reqID);
    }
    const g = groupMap[reqID];

    const rowStatus = String(data[i][14] || "").trim();
    if (rowStatus === "등록완료" || rowStatus === "거절") {
      g.isCompleted = true;
    }

    if (data[i][5]) {
      g.items.push({
        장비명: data[i][5],
        수량: data[i][6] || 1,
        결과: data[i][8] || "",
        상세: data[i][9] || ""
      });
    }
  }

  const pending = [];
  for (let gi = 0; gi < groupOrder.length; gi++) {
    const reqID = groupOrder[gi];
    const g = groupMap[reqID];
    if (g.isCompleted) continue;

    const i = g.firstIdx;
    pending.push({
      reqID: reqID,
      반출일: fmtCell(data[i][1]),
      반출시간: fmtCell(data[i][2]),
      반납일: fmtCell(data[i][3]),
      반납시간: fmtCell(data[i][4]),
      예약자명: data[i][10] || "",     // K열
      연락처: data[i][11] || "",       // L열
      업체명: data[i][12] || "",       // M열
      장비목록: g.items,
      추가요청: data[i][17] || "",     // R열
      결과요약: data[i][8] || "",
      등록상태: data[i][14] || "대기"
    });
  }

  return jsonResponse({ status: "OK", count: pending.length, items: pending });
}

/**
 * 미처리 건 전체 스캔 실행
 * GET ?key=...&action=scan
 */
function doScanAll() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("확인요청");
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return jsonResponse({ status: "OK", action: "scan", processed: 0 });

  const data = sheet.getRange(2, 1, lastRow - 1, 18).getValues();
  let processed = 0;

  for (let i = 0; i < data.length; i++) {
    const row = i + 2;
    const confirmVal = data[i][7];   // H열: 확인
    const resultVal = data[i][8];    // I열: 결과
    const registerVal = data[i][13]; // N열: 등록
    const registerStatus = data[i][14]; // O열: 등록상태

    if (confirmVal === "확인" && !resultVal) {
      processByReqID(sheet, row);
      processed++;
    }

    if (registerVal === "등록" && registerStatus !== "등록완료") {
      registerByReqID(sheet, row);
      processed++;
    }
  }

  return jsonResponse({ status: "OK", action: "scan", processed: processed });
}

/**
 * 특정 요청ID에 대해 액션 실행
 */
function doScheduleAction(action, reqID) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("확인요청");
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return jsonResponse({ status: "ERROR", message: "데이터 없음" });

  const allData = sheet.getRange(2, 1, lastRow - 1, 18).getValues();

  // 해당 reqID의 첫 번째 행 찾기
  let targetRow = -1;
  for (let i = 0; i < allData.length; i++) {
    if (allData[i][0] === reqID) {
      targetRow = i + 2;
      break;
    }
  }

  if (targetRow < 0) {
    return jsonResponse({ status: "ERROR", message: "요청ID를 찾을 수 없음: " + reqID });
  }

  switch (action) {
    case "확인":
      processByReqID(sheet, targetRow);
      return jsonResponse({ status: "OK", action: "확인", reqID: reqID });

    case "등록":
      try {
        registerByReqID(sheet, targetRow);
      } catch (regErr) {
        return jsonResponse({ status: "ERROR", action: "등록", reqID: reqID, message: regErr.message });
      }
      // 등록 후 O열 상태 읽어서 반환
      var regStatus = sheet.getRange(targetRow, 15).getDisplayValue();
      return jsonResponse({ status: "OK", action: "등록", reqID: reqID, message: regStatus });

    case "보류":
      holdByReqID(sheet, allData, reqID);
      return jsonResponse({ status: "OK", action: "보류", reqID: reqID });

    case "거절":
      rejectByReqID(sheet, allData, reqID);
      return jsonResponse({ status: "OK", action: "거절", reqID: reqID });

    case "발송승인":
      sendAvailAlimtalk(sheet, targetRow);
      return jsonResponse({ status: "OK", action: "발송승인", reqID: reqID });

    default:
      return jsonResponse({ status: "ERROR", message: "알 수 없는 action: " + action });
  }
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 시트 범용 API 함수들
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function getSheetList() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheets = ss.getSheets();
  return {
    spreadsheetName: ss.getName(),
    spreadsheetId: ss.getId(),
    sheets: sheets.map(s => ({
      name: s.getName(),
      rows: s.getLastRow(),
      cols: s.getLastColumn(),
      index: s.getIndex()
    }))
  };
}

function getSheetInfo(sheetName) {
  if (!sheetName) return { error: "sheet 파라미터가 필요합니다" };

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return { error: `"${sheetName}" 시트를 찾을 수 없습니다` };

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();

  let headers = [];
  if (lastCol > 0) {
    headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  }

  return {
    name: sheetName,
    lastRow: lastRow,
    lastCol: lastCol,
    headers: headers,
    headerMap: headers.reduce((acc, h, i) => {
      acc[h] = String.fromCharCode(65 + i);
      return acc;
    }, {})
  };
}

function readSheet(sheetName, range, limit) {
  if (!sheetName) return { error: "sheet 파라미터가 필요합니다" };

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return { error: `"${sheetName}" 시트를 찾을 수 없습니다` };

  let data;
  if (range) {
    data = sheet.getRange(range).getValues();
  } else {
    const lastRow = sheet.getLastRow();
    const lastCol = sheet.getLastColumn();
    if (lastRow === 0 || lastCol === 0) return { data: [], rowCount: 0 };
    data = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  }

  if (limit > 0 && data.length > limit + 1) {
    const headers = data[0];
    data = [headers, ...data.slice(1, limit + 1)];
  }

  data = data.map(row => row.map(cell => {
    if (cell instanceof Date) {
      return Utilities.formatDate(cell, "Asia/Seoul", "yyyy-MM-dd HH:mm:ss");
    }
    return cell;
  }));

  return {
    sheet: sheetName,
    rowCount: data.length - 1,
    headers: data[0],
    data: data.slice(1)
  };
}

function writeSheet(sheetName, range, values) {
  if (!sheetName || !range || !values) {
    return { error: "sheet, range, values 모두 필요합니다" };
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return { error: `"${sheetName}" 시트를 찾을 수 없습니다` };

  sheet.getRange(range).setValues(values);
  return { success: true, sheet: sheetName, range: range, rowsWritten: values.length };
}

function appendRows(sheetName, values) {
  if (!sheetName || !values) {
    return { error: "sheet, values 필요합니다" };
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return { error: `"${sheetName}" 시트를 찾을 수 없습니다` };

  const lastRow = sheet.getLastRow();
  const startRow = lastRow + 1;
  const rows = Array.isArray(values[0]) ? values : [values];
  sheet.getRange(startRow, 1, rows.length, rows[0].length).setValues(rows);

  return {
    success: true,
    sheet: sheetName,
    startRow: startRow,
    rowsAdded: rows.length
  };
}

function updateCell(sheetName, cell, value) {
  if (!sheetName || !cell) {
    return { error: "sheet, cell 파라미터가 필요합니다" };
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return { error: `"${sheetName}" 시트를 찾을 수 없습니다` };

  sheet.getRange(cell).setValue(value);
  return { success: true, sheet: sheetName, cell: cell, value: value };
}

function searchSheet(sheetName, col, query) {
  if (!sheetName || !query) {
    return { error: "sheet, query 파라미터가 필요합니다" };
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) return { error: `"${sheetName}" 시트를 찾을 수 없습니다` };

  const lastRow = sheet.getLastRow();
  const lastCol = sheet.getLastColumn();
  if (lastRow < 2) return { results: [], count: 0 };

  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  const data = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();

  let searchColIdx = -1;
  if (col) {
    if (col.length === 1 && col >= 'A' && col <= 'Z') {
      searchColIdx = col.charCodeAt(0) - 65;
    } else {
      searchColIdx = headers.indexOf(col);
    }
  }

  const results = [];
  const queryLower = query.toLowerCase();

  data.forEach((row, idx) => {
    let match = false;
    if (searchColIdx >= 0) {
      match = String(row[searchColIdx]).toLowerCase().includes(queryLower);
    } else {
      match = row.some(cell => String(cell).toLowerCase().includes(queryLower));
    }
    if (match) {
      results.push({
        row: idx + 2,
        data: row.map(cell => {
          if (cell instanceof Date) {
            return Utilities.formatDate(cell, "Asia/Seoul", "yyyy-MM-dd HH:mm:ss");
          }
          return cell;
        })
      });
    }
  });

  return {
    sheet: sheetName,
    query: query,
    column: col || "전체",
    headers: headers,
    count: results.length,
    results: results
  };
}

function runFunction(funcName, params) {
  if (!funcName) return { error: "func 파라미터가 필요합니다" };

  const allowedFunctions = [
    "refreshEquipmentList",
    "syncAuditFromMaster",
    "insertAndCheckRequest",
    "updateRequest",
    "deleteRequest",
    "excludeEquipFromRequest",
    "formatScheduleSheet",
    "normalizeScheduleDetailSetNames",
    "formatContractSheet",
    "resyncAllContractDates",
    "scanCorruptedContractTimes",
    "listPendingContractRegens",
    "regenPendingContracts",
    "regenerateContractById",
    "markOverdueReturnContracts",
    "inspectContractCancelRecovery",
    "restoreCancelledContractsByIds",
    "setupDiscountColumns",
    "inspectContractTemplateDiscounts",
    "setupContractTemplate",
    "fixSchedQuantityTextOne",
    "setupDashboardWarmerTrigger",
    "warmDashboardCache",
    "getInventoryConflicts",
    "getInventoryConflictsSlackMessage",
    "listAllTriggers",
    "diagEquipmentRiskBackendConfig",
    "setupEquipmentRiskBackendConfig",
    "getMyPageLink"
  ];

  if (!allowedFunctions.includes(funcName)) {
    return {
      error: `"${funcName}"은 허용되지 않은 함수입니다`,
      allowed: allowedFunctions
    };
  }

  const startTime = new Date();
  try {
    if (funcName === "insertAndCheckRequest" && params.args) {
      var args = typeof params.args === "string" ? JSON.parse(params.args) : params.args;
      var result = insertAndCheckRequest(args);
      var response = {
        success: true,
        function: funcName,
        reqID: result.reqID,
        results: result.results,
        executionTime: (new Date() - startTime) + "ms"
      };
      if (result.duplicate) response.duplicate = true;
      if (result.message) response.message = result.message;
      return response;
    }
    if (funcName === "updateRequest" && params.args) {
      var args = typeof params.args === "string" ? JSON.parse(params.args) : params.args;
      var result = updateRequest(args);
      return { success: true, function: funcName, result: result, executionTime: (new Date() - startTime) + "ms" };
    }
    if (funcName === "excludeEquipFromRequest" && params.args) {
      var args = typeof params.args === "string" ? JSON.parse(params.args) : params.args;
      var result = excludeEquipFromRequest(args);
      return { success: true, function: funcName, result: result, executionTime: (new Date() - startTime) + "ms" };
    }
    if (funcName === "deleteRequest" && params.args) {
      var args = typeof params.args === "string" ? JSON.parse(params.args) : params.args;
      var reqID = typeof args === "string" ? args : args.reqID;
      var result = deleteRequest(reqID);
      return { success: true, function: funcName, result: result, executionTime: (new Date() - startTime) + "ms" };
    }
    if (funcName === "getMyPageLink") {
      var args = params.args ? (typeof params.args === "string" ? JSON.parse(params.args) : params.args) : params;
      var linkId = typeof args === "string" ? args : (args.id || args.tradeId || args.reqID || args.거래ID || "");
      var result = getMyPageLink(linkId);
      return { success: !result.error, function: funcName, result: result, executionTime: (new Date() - startTime) + "ms" };
    }
    if (funcName === "regenerateContractById") {
      var args = params.args ? (typeof params.args === "string" ? JSON.parse(params.args) : params.args) : params;
      var tradeId = typeof args === "string" ? args : (args.tradeId || args.거래ID || args.id);
      var extraText = (args && typeof args === "object") ? (args.extraText || args.추가요청 || args.note || args.memo) : undefined;
      var result = regenerateContractById(tradeId, extraText);
      return { success: !result.error, function: funcName, result: result, executionTime: (new Date() - startTime) + "ms" };
    }
    if (funcName === "markOverdueReturnContracts") {
      var args = params.args ? (typeof params.args === "string" ? JSON.parse(params.args) : params.args) : params;
      if (typeof args === "string") args = { asOfDate: args };
      var result = markOverdueReturnContracts(args.asOfDate || args.date, args.dryRun);
      return { success: !result.error, function: funcName, result: result, executionTime: (new Date() - startTime) + "ms" };
    }
    if (funcName === "inspectContractCancelRecovery") {
      var args = params.args ? (typeof params.args === "string" ? JSON.parse(params.args) : params.args) : params;
      if (typeof args === "string") args = { asOfDate: args };
      var result = inspectContractCancelRecovery(args.asOfDate || args.date);
      return { success: !result.error, function: funcName, result: result, executionTime: (new Date() - startTime) + "ms" };
    }
    if (funcName === "restoreCancelledContractsByIds") {
      var args = params.args ? (typeof params.args === "string" ? JSON.parse(params.args) : params.args) : params;
      var ids = args.ids || args.tradeIds || args;
      var result = restoreCancelledContractsByIds(ids, args.dryRun);
      return { success: !result.error, function: funcName, result: result, executionTime: (new Date() - startTime) + "ms" };
    }
    if (funcName === "diagEquipmentRiskBackendConfig") {
      var result = diagEquipmentRiskBackendConfig();
      return { success: !!result.ok, function: funcName, result: result, executionTime: (new Date() - startTime) + "ms" };
    }
    if (funcName === "setupEquipmentRiskBackendConfig") {
      var args = params.args ? (typeof params.args === "string" ? JSON.parse(params.args) : params.args) : params;
      var result = setupEquipmentRiskBackendConfig(
        args.adminUrl || args.baseUrl || args.url,
        args.adminToken || args.token
      );
      return { success: !!result.ok, function: funcName, result: result, executionTime: (new Date() - startTime) + "ms" };
    }
    // 일반 함수 호출 (인자 없는 함수)
    var globalFuncs = {
      refreshEquipmentList: typeof refreshEquipmentList !== "undefined" ? refreshEquipmentList : null,
      syncAuditFromMaster: typeof syncAuditFromMaster !== "undefined" ? syncAuditFromMaster : null,
      formatScheduleSheet: typeof formatScheduleSheet !== "undefined" ? formatScheduleSheet : null,
      normalizeScheduleDetailSetNames: typeof normalizeScheduleDetailSetNames !== "undefined" ? normalizeScheduleDetailSetNames : null,
      formatContractSheet: typeof formatContractSheet !== "undefined" ? formatContractSheet : null,
      resyncAllContractDates: typeof resyncAllContractDates !== "undefined" ? resyncAllContractDates : null,
      scanCorruptedContractTimes: typeof scanCorruptedContractTimes !== "undefined" ? scanCorruptedContractTimes : null,
      listPendingContractRegens: typeof listPendingContractRegens !== "undefined" ? listPendingContractRegens : null,
      regenPendingContracts: typeof regenPendingContracts !== "undefined" ? regenPendingContracts : null,
      regenerateContractById: typeof regenerateContractById !== "undefined" ? regenerateContractById : null,
      markOverdueReturnContracts: typeof markOverdueReturnContracts !== "undefined" ? markOverdueReturnContracts : null,
      inspectContractCancelRecovery: typeof inspectContractCancelRecovery !== "undefined" ? inspectContractCancelRecovery : null,
      restoreCancelledContractsByIds: typeof restoreCancelledContractsByIds !== "undefined" ? restoreCancelledContractsByIds : null,
      setupDiscountColumns: typeof setupDiscountColumns !== "undefined" ? setupDiscountColumns : null,
      inspectContractTemplateDiscounts: typeof inspectContractTemplateDiscounts !== "undefined" ? inspectContractTemplateDiscounts : null,
      setupContractTemplate: typeof setupContractTemplate !== "undefined" ? setupContractTemplate : null,
      fixSchedQuantityTextOne: typeof fixSchedQuantityTextOne !== "undefined" ? fixSchedQuantityTextOne : null,
      setupDashboardWarmerTrigger: typeof setupDashboardWarmerTrigger !== "undefined" ? setupDashboardWarmerTrigger : null,
      warmDashboardCache: typeof warmDashboardCache !== "undefined" ? warmDashboardCache : null,
      getInventoryConflicts: typeof getInventoryConflicts !== "undefined" ? getInventoryConflicts : null,
      getInventoryConflictsSlackMessage: typeof getInventoryConflictsSlackMessage !== "undefined" ? getInventoryConflictsSlackMessage : null,
      listAllTriggers: typeof listAllTriggers !== "undefined" ? listAllTriggers : null,
      syncTemplateMasterFromSetMaster: typeof syncTemplateMasterFromSetMaster !== "undefined" ? syncTemplateMasterFromSetMaster : null
    };
    if (globalFuncs[funcName]) {
      var fnResult = globalFuncs[funcName]();
      return { success: true, function: funcName, result: fnResult || "완료", executionTime: (new Date() - startTime) + "ms" };
    }
    this[funcName]();
  } catch (e) {
    if (!e.message.includes("Cannot call")) {
      return { error: e.message };
    }
  }
  const endTime = new Date();

  return {
    success: true,
    function: funcName,
    executionTime: (endTime - startTime) + "ms"
  };
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 운영판 (operations) — 사장님 한눈 보기
// 출처: 스케줄상세, 확인요청, 계약마스터, 장비마스터 + ScriptProperties contractUrl
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

// 시트 셀은 행마다 Date 객체 또는 "yyyy-MM-dd" 문자열로 섞여 저장돼있을 수 있어
// 두 케이스를 모두 yyyy-MM-dd로 정규화한다.
function operationsDateStr_(cell, tz) {
  if (cell instanceof Date && !isNaN(cell.getTime())) {
    return Utilities.formatDate(cell, tz, "yyyy-MM-dd");
  }
  if (cell == null) return "";
  var s = String(cell).trim();
  if (!s) return "";
  var m = s.match(/^(\d{4})[-./\s]?(\d{1,2})[-./\s]?(\d{1,2})/);
  if (m) {
    return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
  }
  return "";
}

function operationsTimeStr_(cell, tz) {
  if (cell instanceof Date && !isNaN(cell.getTime())) {
    return Utilities.formatDate(cell, tz, "HH:mm");
  }
  if (cell == null) return "";
  var s = String(cell).trim();
  if (!s) return "";
  var m = s.match(/^(\d{1,2})[:.](\d{1,2})/);
  if (m) {
    return ('0' + m[1]).slice(-2) + ':' + ('0' + m[2]).slice(-2);
  }
  return "";
}

function operationsToDate_(cell, dateStr) {
  if (cell instanceof Date && !isNaN(cell.getTime())) return cell;
  if (dateStr) {
    var d = new Date(dateStr + "T00:00:00");
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

function operationsScheduleItem_(row) {
  var setName = String(row[2] || "").trim();
  var itemName = String(row[3] || row[2] || "").trim();
  if (!itemName) return null;
  if (setName && setName !== itemName) return null;
  return { name: itemName, qty: row[4] || 1 };
}

function getOperationsData_(targetDate, skipCache) {
  var tz = "Asia/Seoul";
  var today = targetDate ? new Date(targetDate) : new Date();
  if (isNaN(today.getTime())) today = new Date();
  var todayStr = Utilities.formatDate(today, tz, "yyyy-MM-dd");

  var cache = CacheService.getScriptCache();
  var cacheKey = "operations_v2_" + todayStr;
  if (!skipCache) {
    var cached = cache.get(cacheKey);
    if (cached) {
      try { return JSON.parse(cached); } catch (e) {}
    }
  }

  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // ── 스케줄상세: 오늘 출고/회수 + 임박 반출 ──
  var schedSh = ss.getSheetByName("스케줄상세");
  var schedLast = schedSh ? schedSh.getLastRow() : 0;
  var sched = schedLast >= 2 ? schedSh.getRange(2, 1, schedLast - 1, 13).getValues() : [];

  var weekRange = getWeekRange_(today, tz);

  var todayCheckoutMap = {};
  var todayCheckinMap = {};
  var imminentMap = {};
  var paceThisWeekTids = {};
  var pacePrev4WeeksTids = {};
  var activeQtySum = 0;  // 오늘 활성 스케줄(반출일 ≤ 오늘 ≤ 반납일) 수량 합 → 가동률 분자

  // 재고 충돌 — 향후 90일까지의 일자×장비 예약 누적
  // bookingMap[dateStr][equipName] = [{ tid, customer, qty }]
  var bookingMap = {};
  var conflictHorizonEnd = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 90);
  var conflictHorizonEndStr = Utilities.formatDate(conflictHorizonEnd, tz, "yyyy-MM-dd");

  // 출고 페이스 비교 구간: 이번주 시작 기준 직전 4주 (28일)
  var weekStartDate = new Date(weekRange.start + "T00:00:00");
  var pacePrevStart = new Date(weekStartDate.getFullYear(), weekStartDate.getMonth(), weekStartDate.getDate() - 28);
  var pacePrevEnd = new Date(weekStartDate.getFullYear(), weekStartDate.getMonth(), weekStartDate.getDate() - 1);
  var pacePrevStartStr = Utilities.formatDate(pacePrevStart, tz, "yyyy-MM-dd");
  var pacePrevEndStr = Utilities.formatDate(pacePrevEnd, tz, "yyyy-MM-dd");

  for (var i = 0; i < sched.length; i++) {
    var row = sched[i];
    var tid = row[1];
    if (!tid) continue;
    var status = String(row[9] || "").trim();
    if (status === "취소") continue;

    var coCell = row[5];
    var ciCell = row[7];
    var coDate = operationsDateStr_(coCell, tz);
    var ciDate = operationsDateStr_(ciCell, tz);
    var coTime = operationsTimeStr_(row[6], tz);
    var ciTime = operationsTimeStr_(row[8], tz);
    var customer = String(row[12] || "");
    var opItem = operationsScheduleItem_(row);

    if (coDate === todayStr) {
      if (!todayCheckoutMap[tid]) {
        todayCheckoutMap[tid] = { tid: String(tid), customer: customer, time: coTime, items: [] };
      }
      if (opItem) todayCheckoutMap[tid].items.push(opItem);
    }
    if (ciDate === todayStr) {
      if (!todayCheckinMap[tid]) {
        todayCheckinMap[tid] = { tid: String(tid), customer: customer, time: ciTime, items: [] };
      }
      if (opItem) todayCheckinMap[tid].items.push(opItem);
    }

    if (coDate && coDate > todayStr) {
      var coDateObj = operationsToDate_(coCell, coDate);
      var diff = coDateObj ? diffDays_(today, coDateObj) : -1;
      if (diff >= 1 && diff <= 3) {
        if (!imminentMap[tid]) {
          imminentMap[tid] = {
            tid: String(tid),
            customer: customer,
            date: coDate,
            time: coTime,
            daysAway: diff,
            items: []
          };
        }
        if (opItem) imminentMap[tid].items.push(opItem);
      }
    }

    // 출고 페이스 (반출일 기준): 이번주 / 이전 4주
    if (coDate) {
      if (coDate >= weekRange.start && coDate <= weekRange.end) {
        paceThisWeekTids[tid] = true;
      } else if (coDate >= pacePrevStartStr && coDate <= pacePrevEndStr) {
        pacePrev4WeeksTids[tid] = true;
      }
    }

    // 가동률 분자: 오늘 활성 스케줄(반출일 ≤ 오늘 ≤ 반납일)의 수량 합
    if (coDate && ciDate && coDate <= todayStr && todayStr <= ciDate) {
      activeQtySum += (Number(row[4]) || 0);
    }

    // 재고 충돌 — 향후 90일 이내 활성 스케줄을 일자×장비별로 누적 (세트 헤더 행 제외)
    if (coDate && ciDate && opItem && opItem.name) {
      var winStart = coDate < todayStr ? todayStr : coDate;
      var winEnd = ciDate > conflictHorizonEndStr ? conflictHorizonEndStr : ciDate;
      if (winStart <= winEnd) {
        var bookQty = Number(row[4]) || 0;
        if (bookQty > 0) {
          var iterStart = new Date(winStart + "T00:00:00");
          var iterEnd = new Date(winEnd + "T00:00:00");
          for (var dIter = new Date(iterStart); dIter <= iterEnd; dIter.setDate(dIter.getDate() + 1)) {
            var dStr = Utilities.formatDate(dIter, tz, "yyyy-MM-dd");
            if (!bookingMap[dStr]) bookingMap[dStr] = {};
            if (!bookingMap[dStr][opItem.name]) bookingMap[dStr][opItem.name] = { totalQty: 0, bookings: [] };
            bookingMap[dStr][opItem.name].totalQty += bookQty;
            bookingMap[dStr][opItem.name].bookings.push({
              tid: String(tid),
              customer: customer,
              qty: bookQty,
              from: coDate,
              to: ciDate
            });
          }
        }
      }
    }
  }

  var sortByTime = function(a, b) { return (a.time || "").localeCompare(b.time || ""); };
  var todayCheckout = mapValues_(todayCheckoutMap).sort(sortByTime);
  var todayCheckin = mapValues_(todayCheckinMap).sort(sortByTime);
  var imminent = mapValues_(imminentMap).sort(function(a, b) {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return (a.time || "").localeCompare(b.time || "");
  });

  // ── 확인요청: 미확정 (H열 ≠ "확인" 그리고 등록완료/거절 아님) ──
  var reqSh = ss.getSheetByName("확인요청");
  var reqLast = reqSh ? reqSh.getLastRow() : 0;
  var req = reqLast >= 2 ? reqSh.getRange(2, 1, reqLast - 1, 18).getValues() : [];

  var unconfirmedMap = {};
  var unconfirmedOrder = [];

  for (var j = 0; j < req.length; j++) {
    var r = req[j];
    var reqID = r[0];
    if (!reqID) continue;
    var oStatus = String(r[14] || "").trim();
    if (oStatus === "등록완료" || oStatus === "거절") continue;
    var hConfirm = String(r[7] || "").trim();
    if (hConfirm === "확인") continue;

    if (!unconfirmedMap[reqID]) {
      var rDate = operationsDateStr_(r[1], tz);
      var rTime = operationsTimeStr_(r[2], tz);
      unconfirmedMap[reqID] = {
        reqID: String(reqID),
        customer: String(r[10] || ""),
        company: String(r[12] || ""),
        checkoutDate: rDate,
        checkoutTime: rTime,
        items: []
      };
      unconfirmedOrder.push(reqID);
    }
    var equipName = String(r[5] || "");
    if (equipName) {
      unconfirmedMap[reqID].items.push({ name: equipName, qty: r[6] || 1 });
    }
  }

  var unconfirmed = unconfirmedOrder.map(function(k) { return unconfirmedMap[k]; })
    .sort(function(a, b) { return (a.checkoutDate || "").localeCompare(b.checkoutDate || ""); });

  // ── 계약마스터: 계약서 미발송 + 이번주 신규 예약 ──
  var contractSh = ss.getSheetByName("계약마스터");
  var contractLast = contractSh ? contractSh.getLastRow() : 0;
  var contracts = contractLast >= 2 ? contractSh.getRange(2, 1, contractLast - 1, 12).getValues() : [];

  var allTids = [];
  var tidCustomerMap = {};
  var weeklyTids = {};

  for (var k = 0; k < contracts.length; k++) {
    var c = contracts[k];
    var tid = c[0];
    if (!tid) continue;
    var cStatus = String(c[9] || "").trim();
    if (cStatus === "취소" || cStatus === "거절") continue;
    var sTid = String(tid);
    allTids.push(sTid);
    tidCustomerMap[sTid] = String(c[1] || "");

    var ccoDate = operationsDateStr_(c[4], tz);
    if (ccoDate && ccoDate >= weekRange.start && ccoDate <= weekRange.end) {
      weeklyTids[sTid] = true;
    }
  }

  var missingContract = [];
  try {
    var extras = getDashboardContractExtrasByIds_(allTids);
    var items = (extras && extras.items) || {};
    for (var ti = 0; ti < allTids.length; ti++) {
      var t = allTids[ti];
      var entry = items[t] || {};
      var hasUrl = !!(entry.contractUrl && String(entry.contractUrl).trim());
      if (!hasUrl) {
        missingContract.push({ tid: t, customer: tidCustomerMap[t] || "" });
      }
    }
  } catch (extraErr) {
    // helper 실패하면 미발송 목록 비움 (전체 차단 방지)
  }

  // ── 장비마스터: 정비 중 ──
  var equipSh = ss.getSheetByName("장비마스터");
  var equipLast = equipSh ? equipSh.getLastRow() : 0;
  var equips = equipLast >= 2 ? equipSh.getRange(2, 1, equipLast - 1, 12).getValues() : [];

  var maintenance = [];
  var totalStockSum = 0;
  var stockByName = {};  // 장비명 → 총보유 수량
  for (var m = 0; m < equips.length; m++) {
    var st = String(equips[m][8] || "").trim();
    var equipName = String(equips[m][3] || "").trim();
    if (st === "정비중" || st === "수리중") {
      maintenance.push({
        name: equipName,
        category: String(equips[m][0] || ""),
        status: st,
        note: String(equips[m][9] || "")
      });
    }
    var stockNum = Number(equips[m][4]) || 0;
    totalStockSum += stockNum;
    if (equipName && stockNum > 0) {
      stockByName[equipName] = (stockByName[equipName] || 0) + stockNum;
    }
  }

  // ── 건강 지표: 장비 가동률 (스케줄상세 활성 수량 / 장비마스터 총보유) + 이번주 출고 페이스 ──
  var utilizationPercent = totalStockSum > 0
    ? Math.round((activeQtySum / totalStockSum) * 1000) / 10
    : 0;

  // ── 재고 충돌/부족 ──
  // 각 (date, equipment)에서 sum vs 총보유 비교
  var inventoryAlerts = [];
  var inventoryUnknownNames = {};
  var dateKeys = Object.keys(bookingMap).sort();
  for (var di = 0; di < dateKeys.length; di++) {
    var dStr = dateKeys[di];
    var byEquip = bookingMap[dStr];
    var equipNames = Object.keys(byEquip);
    for (var ei = 0; ei < equipNames.length; ei++) {
      var ename = equipNames[ei];
      var entry = byEquip[ename];
      var stock = stockByName[ename];
      if (stock == null) {
        // 장비마스터에 없는 이름은 충돌 판정 불가 — 한 번만 기록
        if (!inventoryUnknownNames[ename]) inventoryUnknownNames[ename] = true;
        continue;
      }
      var ratio = entry.totalQty / stock;
      if (entry.totalQty > stock) {
        inventoryAlerts.push({
          date: dStr,
          equipment: ename,
          booked: entry.totalQty,
          stock: stock,
          overBy: entry.totalQty - stock,
          ratio: Math.round(ratio * 1000) / 10,
          severity: "conflict",
          bookings: entry.bookings
        });
      } else if (ratio >= 0.9) {
        inventoryAlerts.push({
          date: dStr,
          equipment: ename,
          booked: entry.totalQty,
          stock: stock,
          overBy: 0,
          ratio: Math.round(ratio * 1000) / 10,
          severity: "tight",
          bookings: entry.bookings
        });
      }
    }
  }
  // 충돌 먼저 → 부족 우려 / 같은 severity 안에서는 날짜 빠른 순
  inventoryAlerts.sort(function(a, b) {
    if (a.severity !== b.severity) return a.severity === "conflict" ? -1 : 1;
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    return b.ratio - a.ratio;
  });

  var paceThisWeekCount = countKeys_(paceThisWeekTids);
  var pacePrevCount = countKeys_(pacePrev4WeeksTids);
  var paceAvg4Week = pacePrevCount / 4;
  var pacePercent = paceAvg4Week > 0
    ? Math.round((paceThisWeekCount / paceAvg4Week) * 100)
    : null;

  var result = {
    success: true,
    date: todayStr,
    generatedAt: Utilities.formatDate(new Date(), tz, "yyyy-MM-dd HH:mm:ss"),
    week: weekRange,
    summary: {
      todayCheckout: todayCheckout.length,
      todayCheckin: todayCheckin.length,
      unconfirmed: unconfirmed.length,
      missingContract: missingContract.length,
      imminent: imminent.length,
      maintenance: maintenance.length,
      weeklyReservations: countKeys_(weeklyTids),
      inventoryConflicts: inventoryAlerts.filter(function(a) { return a.severity === "conflict"; }).length,
      inventoryTight: inventoryAlerts.filter(function(a) { return a.severity === "tight"; }).length
    },
    health: {
      utilization: {
        inUse: activeQtySum,
        total: totalStockSum,
        percent: utilizationPercent
      },
      checkoutPace: {
        thisWeek: paceThisWeekCount,
        avg4Week: Math.round(paceAvg4Week * 10) / 10,
        prevTotal: pacePrevCount,
        percent: pacePercent,
        prevRange: { start: pacePrevStartStr, end: pacePrevEndStr }
      }
    },
    todayCheckout: todayCheckout,
    todayCheckin: todayCheckin,
    unconfirmed: unconfirmed,
    missingContract: missingContract,
    imminent: imminent,
    maintenance: maintenance,
    inventoryAlerts: inventoryAlerts,
    inventoryHorizonDays: 90,
    inventoryUnknownCount: Object.keys(inventoryUnknownNames).length
  };

  try { cache.put(cacheKey, JSON.stringify(result), 300); } catch (cacheErr) {}
  return result;
}

function mapValues_(obj) {
  var out = [];
  for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) out.push(obj[k]);
  return out;
}

function countKeys_(obj) {
  var n = 0;
  for (var k in obj) if (Object.prototype.hasOwnProperty.call(obj, k)) n++;
  return n;
}

function diffDays_(a, b) {
  if (!(a instanceof Date) || !(b instanceof Date)) return -1;
  var aD = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  var bD = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((bD - aD) / 86400000);
}

function getWeekRange_(refDate, tz) {
  // 월요일~일요일 (한국 관행)
  var d = new Date(refDate);
  var day = d.getDay();
  var mondayOffset = (day === 0) ? -6 : 1 - day;
  var monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() + mondayOffset);
  var sunday = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + 6);
  return {
    start: Utilities.formatDate(monday, tz, "yyyy-MM-dd"),
    end: Utilities.formatDate(sunday, tz, "yyyy-MM-dd")
  };
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 유틸리티
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function jsonResponse(data, statusCode) {
  const output = ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
  return output;
}
