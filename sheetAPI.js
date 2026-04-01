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


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 웹앱 엔드포인트 (프로젝트 전체에서 유일)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function doGet(e) {
  var params = e.parameter || {};

  // ── 페이지 라우팅 ──
  if (params.page) {
    var pageMap = {
      "request":  { file: "requestForm",    title: "빌리지 확인요청" },
      "timeline": { file: "timelineMobile", title: "빌리지 스케줄" }
    };
    var pg = pageMap[params.page];
    if (pg) {
      var html = HtmlService.createHtmlOutputFromFile(pg.file);
      var webAppUrl = ScriptApp.getService().getUrl();
      html.setContent(html.getContent().replace(
        'var API_URL = "";',
        'var API_URL = "' + webAppUrl + '";'
      ));
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

      case "write":
        return jsonResponse(writeSheet(
          postBody.sheet,
          postBody.range,
          postBody.values
        ));

      case "append":
        return jsonResponse(appendRows(
          postBody.sheet,
          postBody.values
        ));

      case "update":
        return jsonResponse(updateCell(
          params.sheet || postBody.sheet,
          params.cell || postBody.cell,
          params.value !== undefined ? params.value : postBody.value
        ));

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

      case "timeline":
        return jsonResponse(getTimelineData());

      case "parseImage":
        return jsonResponse(parseImageWithClaude(
          postBody.image,
          postBody.mediaType
        ));

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

  const data = sheet.getRange(2, 1, lastRow - 1, 17).getValues();
  // Date → 문자열 변환용
  const displayData = sheet.getRange(2, 1, lastRow - 1, 17).getDisplayValues();

  const pending = [];
  const seen = new Set();

  for (let i = 0; i < data.length; i++) {
    const reqID = data[i][0];
    if (!reqID || seen.has(reqID)) continue;
    seen.add(reqID);

    const status = data[i][14] || "";  // O열: 등록상태
    const result = data[i][8] || "";   // I열: 결과

    if (status !== "등록완료" && status !== "거절") {
      // 같은 reqID의 모든 장비 수집
      const items = [];
      for (let j = 0; j < data.length; j++) {
        if (data[j][0] === reqID && data[j][5]) {
          items.push({
            장비명: data[j][5],
            수량: data[j][6] || 1,
            결과: data[j][8] || "",
            상세: data[j][9] || ""
          });
        }
      }

      pending.push({
        reqID: reqID,
        반출일: displayData[i][1],
        반출시간: displayData[i][2],
        반납일: displayData[i][3],
        반납시간: displayData[i][4],
        예약자명: data[i][10] || "",     // K열
        연락처: data[i][11] || "",       // L열
        업체명: data[i][12] || "",       // M열
        장비목록: items,
        결과요약: result,
        등록상태: status || "대기"
      });
    }
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

  const data = sheet.getRange(2, 1, lastRow - 1, 17).getValues();
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

  const allData = sheet.getRange(2, 1, lastRow - 1, 17).getValues();

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
      registerByReqID(sheet, targetRow);
      return jsonResponse({ status: "OK", action: "등록", reqID: reqID });

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
    "processAllPending",
    "clearResults",
    "refreshEquipmentList",
    "syncAuditFromMaster",
    "insertAndCheckRequest",
    "updateRequest",
    "deleteRequest"
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
      var reqID = insertAndCheckRequest(args);
      return { success: true, function: funcName, reqID: reqID, executionTime: (new Date() - startTime) + "ms" };
    }
    if (funcName === "updateRequest" && params.args) {
      var args = typeof params.args === "string" ? JSON.parse(params.args) : params.args;
      var result = updateRequest(args);
      return { success: true, function: funcName, result: result, executionTime: (new Date() - startTime) + "ms" };
    }
    if (funcName === "deleteRequest" && params.args) {
      var args = typeof params.args === "string" ? JSON.parse(params.args) : params.args;
      var reqID = typeof args === "string" ? args : args.reqID;
      var result = deleteRequest(reqID);
      return { success: true, function: funcName, result: result, executionTime: (new Date() - startTime) + "ms" };
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
// 이미지 파싱 (Claude API)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 카카오톡 캡처 이미지를 Claude API로 파싱하여 예약 정보 추출
 * @param {string} base64Image - base64 인코딩된 이미지 데이터
 * @param {string} mediaType - 이미지 MIME 타입 (image/png, image/jpeg 등)
 * @returns {Object} 파싱된 예약 정보
 */
function parseImageWithClaude(base64Image, mediaType) {
  if (!base64Image) return { error: "이미지 데이터가 없습니다" };

  // Script Properties에서 Claude API 키 가져오기
  var apiKey = PropertiesService.getScriptProperties().getProperty("CLAUDE_API_KEY");
  if (!apiKey) {
    return { error: "Claude API 키가 설정되지 않았습니다. GAS Script Properties에 CLAUDE_API_KEY를 추가해주세요." };
  }

  var prompt = '이 카카오톡 대화 캡처 이미지에서 렌탈 장비 예약 정보를 추출해주세요.\n\n' +
    '다음 JSON 형식으로만 응답해주세요 (설명 없이 JSON만):\n' +
    '{\n' +
    '  "예약자명": "이름 (대화 상대방 이름)",\n' +
    '  "연락처": "전화번호 (있으면)",\n' +
    '  "반출일": "YYYY-MM-DD",\n' +
    '  "반출시간": "HH:MM",\n' +
    '  "반납일": "YYYY-MM-DD",\n' +
    '  "반납시간": "HH:MM",\n' +
    '  "장비": [{"이름": "장비명", "수량": 1}]\n' +
    '}\n\n' +
    '주의사항:\n' +
    '- 날짜가 0402 같은 형식이면 올해 기준으로 2026-04-02로 변환\n' +
    '- 대화에서 제외/취소된 장비는 목록에서 빼주세요\n' +
    '- 대체 장비로 합의된 경우 대체된 장비명을 사용하세요\n' +
    '- 수량이 명시되지 않으면 1로 설정\n' +
    '- 예약자명은 카톡 대화 상대방 이름을 사용하세요';

  try {
    var response = UrlFetchApp.fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      },
      payload: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        messages: [{
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mediaType || "image/png",
                data: base64Image
              }
            },
            {
              type: "text",
              text: prompt
            }
          ]
        }]
      }),
      muteHttpExceptions: true
    });

    var status = response.getResponseCode();
    var body = JSON.parse(response.getContentText());

    if (status !== 200) {
      return { error: "Claude API 오류 (" + status + "): " + (body.error && body.error.message || JSON.stringify(body)) };
    }

    // Claude 응답에서 JSON 추출
    var text = body.content[0].text;
    // ```json ... ``` 블록이 있으면 추출
    var jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    var jsonStr = jsonMatch ? jsonMatch[1].trim() : text.trim();

    var parsed = JSON.parse(jsonStr);
    return parsed;

  } catch (e) {
    return { error: "파싱 실패: " + e.message };
  }
}

/**
 * Claude API 키 설정 헬퍼 (GAS 편집기에서 직접 실행)
 * 사용법: GAS 편집기 → setupClaudeApiKey() 실행 → 프롬프트에 키 입력
 */
function setupClaudeApiKey() {
  var ui = SpreadsheetApp.getUi();
  var result = ui.prompt("Claude API 키 설정", "Anthropic API 키를 입력하세요 (sk-ant-...)", ui.ButtonSet.OK_CANCEL);
  if (result.getSelectedButton() === ui.Button.OK) {
    var key = result.getResponseText().trim();
    if (key) {
      PropertiesService.getScriptProperties().setProperty("CLAUDE_API_KEY", key);
      ui.alert("API 키가 저장되었습니다.");
    }
  }
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 유틸리티
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function jsonResponse(data, statusCode) {
  const output = ContentService.createTextOutput(JSON.stringify(data, null, 2))
    .setMimeType(ContentService.MimeType.JSON);
  return output;
}
