/**
 * ====================================================================
 * sheetAPI.gs — 빌리지 통합 웹앱 API
 * ====================================================================
 *
 * 모든 외부 API 호출을 이 파일에서 처리합니다.
 * - Claude 에이전트: 시트 읽기/쓰기/검색
 * - 스케줄 관리: 가용확인/등록/보류/거절/목록조회
 *
 * ★ 인증: 기존 운영키 호환 + 서버 내부키 ★
 *
 * 수개월간 사용한 운영 자동화는 village2026 키를 계속 사용한다. Today Dashboard
 * 같은 서버 런타임은 Script Properties의 내부 키도 사용할 수 있다. 두 키는 동일한
 * 운영 권한으로 처리한다.
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ★ API principal ★
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 기존 Claude/Codex/Hermes 운영 자동화와 호환되는 안정 키.
const VILLAGE_OPERATOR_API_KEY = "village2026";
const VILLAGE_INTERNAL_API_KEY_PROPERTY = "VILLAGE_API_WRITE_KEY_V1";

function villageApiPrincipal_(key) {
  key = String(key || "").trim();
  if (!key) return "";
  var internalKey = String(
    PropertiesService.getScriptProperties().getProperty(VILLAGE_INTERNAL_API_KEY_PROPERTY) || ""
  ).trim();
  if (internalKey && key === internalKey) return "internal";
  if (key === VILLAGE_OPERATOR_API_KEY) return "internal";
  return "";
}

// Apps Script 실행 API(MYSELF)에서만 호출하는 내부 키 bootstrap.
// runFunction allowlist에는 등록하지 않으므로 웹 API를 통해서는 실행할 수 없다.
function configureVillageApiInternalKeyV1(value) {
  var key = String(value || "").trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error("invalid internal API key");
  PropertiesService.getScriptProperties().setProperty(VILLAGE_INTERNAL_API_KEY_PROPERTY, key);
  return { success: true, configured: true, keyLength: key.length };
}

// Hermes가 소스 파싱 없이 사용할 수 있는 typed operating surface.
// 확인요청 쓰기 계열은 requestSchema를 함께 광고한다 — 스키마를 API가 알려주지 않으면
// 계획 모델이 필드명을 추측(customerName 등)하다 실패하는 근본 원인이 된다.
function getConfirmationRequestSchema_() {
  return {
    fieldLanguage: "korean",
    required: ["반출일", "반출시간", "반납일", "반납시간", "예약자명", "장비"],
    optional: ["연락처", "할인유형", "업체명", "비고", "추가요청", "장비명원문보존"],
    formats: {
      반출일: "YYYY-MM-DD",
      반출시간: "HH:MM (두 자리, 예: 07:00)",
      반납일: "YYYY-MM-DD",
      반납시간: "HH:MM (두 자리, 예: 22:00)",
      장비: "[{\"이름\": \"목록 시트의 정확한 장비명\", \"수량\": 1}]"
    },
    example: {
      반출일: "2026-08-07",
      반출시간: "10:00",
      반납일: "2026-08-08",
      반납시간: "10:00",
      예약자명: "홍길동",
      연락처: "010-1234-5678",
      장비: [{ 이름: "소니 A7S3 바디세트", 수량: 1 }]
    },
    notes: "필드명은 한글 정본을 사용. 영문 별칭(customerName/phone/pickupDate 등)은 Windows 러너(village-confirm-request.js)에서만 자동 매핑되며, GAS API 직접 호출 시에는 한글 필드만 허용."
  };
}

function getVillageOperationCapabilities_() {
  var confirmationRequestSchema = getConfirmationRequestSchema_();
  return {
    success: true,
    version: 2,
    aiRole: "semantic_planner",
    executionRole: "typed_capability_broker",
    liveSourceDiscoveryAllowed: false,
    developmentDiscoveryAllowed: true,
    missingCapabilityLifecycle: "discover_validate_promote_confirm_resume",
    runtimeContracts: {
      heybilly: {
        toggleItems: true,
        completionRevision: 1,
        photoUploadClaim: 2,
        itemNameMutationId: true,
        itemNameStaleCas: true
      }
    },
    capabilities: [
      { id: "inventory.lookup", action: "search", policy: "read_only" },
      { id: "schedule.lookup", action: "search", policy: "read_only" },
      { id: "customer.lookup", action: "search", policy: "read_only" },
      { id: "finance.lookup", action: "search", policy: "read_only" },
      { id: "documents.lookup", action: "search", policy: "read_only" },
      { id: "schedule.timeline", action: "timeline", policy: "read_only" },
      { id: "operations.daily", action: "operations", policy: "read_only" },
      { id: "dashboard.search", action: "dashboardSearch", policy: "read_only" },
      { id: "contract.extras", action: "dashboardContractExtras", policy: "read_only" },
      { id: "schedule.trade_candidates", action: "tradeCandidates", policy: "read_only" },
      { id: "payment.metadata", action: "paymentMeta", policy: "read_only" },
      { id: "confirmation_request.list", action: "list", policy: "read_only" },
      { id: "confirmation_request.scan", action: "scan", policy: "internal_write", verification: "authoritative_server_ack" },
      { id: "operation.receipt", action: "operationReceipt", policy: "read_only", verification: "authoritative_read" },
      { id: "confirmation_request.create", action: "insertAndCheckRequest", policy: "internal_write", verification: "authoritative_readback", requestSchema: confirmationRequestSchema },
      { id: "confirmation_request.create_batch", action: "insertAndCheckRequest", policy: "internal_write", verification: "authoritative_readback", requestSchema: confirmationRequestSchema },
      { id: "confirmation_request.update", action: "updateRequest", policy: "internal_write", verification: "authoritative_readback", requestSchema: confirmationRequestSchema, updateNote: "reqID(RQ-YYMMDD-NNN) 필수 + requestSchema의 필드를 함께 전달. 전체 요청을 항상 완전한 형태로 보낼 것" },
      { id: "schedule.change_dates", action: "scheduleChangeDates", policy: "internal_write", verification: "authoritative_readback" },
      { id: "schedule.correct_registered_trade", action: "scheduleCorrectRegisteredTrade", policy: "internal_write", verification: "authoritative_readback" },
      { id: "schedule.clone_registered_no_send", action: "cloneScheduleNoSend", policy: "internal_write", verification: "authoritative_readback" },
      { id: "schedule.update_time", action: "updateTime", policy: "internal_write", verification: "authoritative_server_ack" },
      { id: "schedule.update_status", action: "updateStatus", policy: "internal_write", verification: "authoritative_server_ack" },
      { id: "schedule.toggle_setup", action: "toggleSetup", policy: "internal_write", verification: "authoritative_server_ack" },
      { id: "schedule.toggle_return", action: "toggleReturn", policy: "internal_write", verification: "authoritative_server_ack" },
      { id: "schedule.toggle_item", action: "toggleItem", policy: "internal_write", verification: "authoritative_server_ack" },
      { id: "schedule.toggle_items", action: "toggleItems", policy: "internal_write", verification: "authoritative_server_ack" },
      { id: "equipment.check_update", action: "updateEquipmentCheck", policy: "internal_write", verification: "authoritative_server_ack" },
      { id: "equipment.add", action: "addEquip", policy: "internal_write", verification: "authoritative_server_ack" },
      { id: "equipment.add_batch", action: "addEquips", policy: "internal_write", verification: "authoritative_server_ack" },
      { id: "equipment.record_onsite_addon", action: "recordOnsiteAddon", policy: "internal_write", verification: "authoritative_server_ack" },
      { id: "equipment.remove", action: "removeEquip", policy: "internal_write", verification: "authoritative_server_ack" },
      { id: "equipment.remove_batch", action: "removeEquips", policy: "internal_write", verification: "authoritative_server_ack" },
      { id: "equipment.update_quantity", action: "updateEquipQty", policy: "internal_write", verification: "authoritative_server_ack" },
      { id: "equipment.update_name", action: "updateEquipName", policy: "internal_write", verification: "authoritative_server_ack" },
      { id: "contract.update_status", action: "updateContractStatus", policy: "internal_write", verification: "authoritative_server_ack" },
      { id: "contract.regenerate", action: "regenerateContract", policy: "internal_write", verification: "authoritative_server_ack" },
      { id: "payment.update_method", action: "updatePayment", policy: "internal_write", verification: "authoritative_server_ack" },
      { id: "billing.update_company", action: "updateBillingCompany", policy: "internal_write", verification: "authoritative_server_ack" },
      { id: "proof.update_field", action: "updateTradeProof", policy: "internal_write", verification: "authoritative_server_ack" },
      { id: "dashboard.save_notes", action: "saveDashboardNotes", policy: "internal_write", verification: "authoritative_server_ack" },
      { id: "dashboard.upload_photo", action: "uploadDashboardPhoto", policy: "internal_write", verification: "authoritative_server_ack" },
      { id: "dashboard.delete_photo", action: "deleteDashboardPhoto", policy: "internal_write", verification: "authoritative_server_ack" },
      { id: "confirmation_request.confirm", action: "확인", policy: "internal_write", verification: "authoritative_server_ack" },
      { id: "confirmation_request.hold", action: "보류", policy: "internal_write", verification: "authoritative_server_ack" },
      { id: "confirmation_request.reject", action: "거절", policy: "internal_write", verification: "authoritative_server_ack" },
      { id: "confirmation_request.register", action: "등록", policy: "final_registration", verification: "authoritative_server_ack" },
      { id: "customer.send_confirmation", action: "발송승인", policy: "customer_send", verification: "authoritative_server_ack" },
      { id: "customer.send_estimate", action: "sendEstimate", policy: "customer_send", verification: "authoritative_server_ack" },
      { id: "customer.send_statement", action: "sendStatement", policy: "customer_send", verification: "authoritative_server_ack" },
      { id: "customer.send_payment_link", action: "sendPayAppPaymentLink", policy: "customer_send", verification: "authoritative_server_ack" },
      { id: "customer.issue_proof", action: "issueProof", policy: "customer_send", verification: "authoritative_server_ack" },
      { id: "customer.issue_tax_invoice", action: "issueTaxInvoice", policy: "customer_send", verification: "authoritative_server_ack" },
      { id: "customer.send_equipment_risk_guidance", action: "equipmentRiskSend", policy: "customer_send", verification: "authoritative_server_ack" }
    ]
  };
}

// 쓰기 허용 시트 화이트리스트
// 스케줄상세는 반출 불변 기준선/가용성/계약서 부작용을 함께 처리해야 하므로
// 범용 setValue API로 쓰지 못한다. dashboardAdd/Remove/Update 전용 액션만 사용한다.
const WRITABLE_SHEETS = ["확인요청", "신규장비 추가", "실사 기록"];
function isWritableSheet(sheetName) {
  return WRITABLE_SHEETS.indexOf(sheetName) !== -1;
}

// sheet="확인요청" + range="'계약마스터'!E2"로 화이트리스트를 우회하지 못하게 한다.
function isRangeBoundToSheet_(sheetName, range) {
  var text = String(range || '').trim();
  var bang = text.indexOf('!');
  if (bang < 0) return true;
  var qualifier = text.slice(0, bang).trim();
  if (qualifier.charAt(0) === "'" && qualifier.charAt(qualifier.length - 1) === "'") {
    qualifier = qualifier.slice(1, -1).replace(/''/g, "'");
  }
  return qualifier === String(sheetName || '').trim();
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 웹앱 엔드포인트 (프로젝트 전체에서 유일)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function villageLegacyPageUrl_(page) {
  page = String(page || "").trim();
  if (page === "dashboard" || page === "timeline") {
    return "https://today-dashboard-ten.vercel.app/schedule";
  }
  if (page === "manage") return "https://today-dashboard-ten.vercel.app/confirm";
  return "";
}

function doGet(e) {
  e = e || {};
  e.villageHttpMethod_ = "GET";
  var params = e.parameter || {};

  // ── 페이지 라우팅 ──
  if (params.page) {
    var replacementUrl = villageLegacyPageUrl_(params.page);
    if (replacementUrl) {
      return HtmlService.createHtmlOutput(
        '<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=' + replacementUrl + '">' +
        '<script>window.location.replace(' + JSON.stringify(replacementUrl) + ');</script>'
      );
    }
  }

  return handleRequest(e);
}

function doPost(e) {
  e = e || {};
  e.villageHttpMethod_ = "POST";
  return handleRequest(e);
}

function requireVillagePost_(e, action) {
  if (e && e.villageHttpMethod_ === "POST") return null;
  return jsonResponse({
    status: "ERROR",
    error: action + " is a write action and requires POST"
  }, 405);
}

function stableVillageOperationJson_(value) {
  if (value === null || value === undefined) return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return "[" + value.map(stableVillageOperationJson_).join(",") + "]";
  if (typeof value === "object") {
    return "{" + Object.keys(value).sort().map(function(key) {
      return JSON.stringify(key) + ":" + stableVillageOperationJson_(value[key]);
    }).join(",") + "}";
  }
  return JSON.stringify(value);
}

function villageOperationDigest_(capability, action, body) {
  var copy = Object.assign({}, body || {});
  delete copy.key;
  delete copy.operationId;
  delete copy.capability;
  delete copy.action;
  var bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    stableVillageOperationJson_({ capability: capability, action: action, parameters: copy }),
    Utilities.Charset.UTF_8
  );
  return bytes.map(function(item) {
    var value = item < 0 ? item + 256 : item;
    return (value < 16 ? "0" : "") + value.toString(16);
  }).join("");
}

function villageOperationReceiptKey_(operationId) {
  return "village_operation_receipt_v1_" + operationId;
}

function villageOperationIssuedAtMs_(operationId) {
  var match = String(operationId || "").match(/^(\d{10,13})-/);
  if (!match) return 0;
  var value = Number(match[1]);
  return match[1].length === 10 ? value * 1000 : value;
}

function getVillageOperationCapability_(capabilityId, action) {
  var capabilities = getVillageOperationCapabilities_().capabilities || [];
  for (var i = 0; i < capabilities.length; i++) {
    var item = capabilities[i];
    if (item.id === capabilityId && item.action === action) return item;
  }
  return null;
}

function readVillageOperationReceipt_(operationId) {
  if (!/^[a-f0-9-]{16,80}$/i.test(String(operationId || ""))) return null;
  var text = PropertiesService.getScriptProperties().getProperty(villageOperationReceiptKey_(operationId));
  if (!text) return null;
  try { return JSON.parse(text); } catch (error) { return { status: "indeterminate", operationId: operationId }; }
}

function pruneVillageOperationReceipts_(properties) {
  var markerKey = "village_operation_receipt_pruned_at_v1";
  var now = Date.now();
  var last = Number(properties.getProperty(markerKey) || 0);
  if (now - last < 86400000) return;
  var all = properties.getProperties();
  Object.keys(all).forEach(function(key) {
    if (key.indexOf("village_operation_receipt_v1_") !== 0) return;
    try {
      var receipt = JSON.parse(all[key]);
      if (now - Number(receipt.updatedAtMs || receipt.startedAtMs || 0) > 2592000000) properties.deleteProperty(key);
    } catch (error) {
      properties.deleteProperty(key);
    }
  });
  properties.setProperty(markerKey, String(now));
}

function withVillageOperationReceipt_(e, execute) {
  var params = e.parameter || {};
  var body = {};
  if (e.postData) {
    try { body = JSON.parse(e.postData.contents); } catch (error) { body = {}; }
  }
  var key = params.key || body.key;
  var action = params.action || body.action || "";
  var operationId = String(body.operationId || "");
  var capabilityId = String(body.capability || "");
  var capability = getVillageOperationCapability_(capabilityId, action);
  if (villageApiPrincipal_(key) !== "internal" || !operationId || action === "operationReceipt") return execute();
  if (
    !/^[a-f0-9-]{16,80}$/i.test(operationId) ||
    !capability ||
    capability.policy === "read_only" ||
    capability.verification !== "authoritative_server_ack"
  ) {
    return jsonResponse({
      success: false,
      status: "ERROR",
      error: "operationId requests require an exact acknowledged capability/action binding"
    });
  }

  var digest = villageOperationDigest_(capabilityId, action, body);
  var properties = PropertiesService.getScriptProperties();
  var receiptKey = villageOperationReceiptKey_(operationId);
  var pending = {
    kind: "village-operation-receipt",
    operationId: operationId,
    capability: capabilityId,
    action: action,
    requestDigest: digest,
    status: "in_progress",
    startedAt: new Date().toISOString(),
    startedAtMs: Date.now()
  };

  // 실행 전체를 ScriptLock 안에 두면 내부 장비/완료 mutation의 lock과 충돌해 10~30초
  // 대기를 만든다. receipt claim만 짧게 직렬화하고 실제 업무는 잠금 밖에서 실행한다.
  var lock = LockService.getScriptLock();
  var locked = false;
  try {
    locked = lock.tryLock(1500);
    if (!locked) return jsonResponse({ error: "operation receipt 접수 중입니다", code: "BUSY", retryable: true });
    var existing = readVillageOperationReceipt_(operationId);
    if (existing) {
      if (existing.requestDigest !== digest || existing.capability !== capabilityId || existing.action !== action) {
        return jsonResponse({ success: false, status: "ERROR", error: "operationId request mismatch" });
      }
      if (existing.status === "applied") {
        return jsonResponse({
          success: true,
          status: "applied",
          operationId: operationId,
          capability: capabilityId,
          idempotentReplay: true,
          resultDigest: existing.resultDigest || ""
        });
      }
      return jsonResponse({
        success: false,
        status: existing.status || "indeterminate",
        operationId: operationId,
        capability: capabilityId,
        error: "operation outcome requires reconciliation"
      });
    }
    pruneVillageOperationReceipts_(properties);
    properties.setProperty(receiptKey, JSON.stringify(pending));
  } finally {
    if (locked) try { lock.releaseLock(); } catch (releaseError) {}
  }

  try {
    var output = execute();
    var content = output && typeof output.getContent === "function" ? output.getContent() : "";
    var result = null;
    try { result = JSON.parse(content); } catch (parseError) { result = null; }
    var applied = !!result && !result.error && result.ok !== false && result.success !== false && result.status !== "ERROR";
    var finalized = Object.assign({}, pending, {
      status: applied ? "applied" : "indeterminate",
      updatedAt: new Date().toISOString(),
      updatedAtMs: Date.now(),
      resultDigest: villageOperationDigest_(capabilityId, action, { result: result })
    });
    properties.setProperty(receiptKey, JSON.stringify(finalized));
    return output;
  } catch (error) {
    properties.setProperty(receiptKey, JSON.stringify(Object.assign({}, pending, {
      status: "indeterminate",
      updatedAt: new Date().toISOString(),
      updatedAtMs: Date.now()
    })));
    throw error;
  }
}


// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 통합 요청 처리
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function handleRequest(e) {
  return withVillageOperationReceipt_(e, function() {
    return handleRequestCore_(e);
  });
}

function handleRequestCore_(e) {
  try {
    // ── 인증 확인 ──
    let params = e.parameter || {};

    // POST body에서도 key/action 추출
    let postBody = {};
    if (e.postData) {
      try { postBody = JSON.parse(e.postData.contents); } catch(pe) {}
    }

    const key = params.key || postBody.key;
    const principal = villageApiPrincipal_(key);
    const action = params.action || postBody.action || "";
    if (!principal) {
      return jsonResponse({ error: "인증 실패. key 파라미터를 확인하세요." }, 403);
    }

    switch (action) {

      case "oneoffA7M5SetMaster":
        return jsonResponse(oneoffA7M5SetMaster_(params));

      case "oneoffA7M5Inventory":
        return jsonResponse(oneoffA7M5Inventory_(params));

      // ━━━ 시트 범용 API ━━━

      case "capabilities":
        return jsonResponse(getVillageOperationCapabilities_());

      case "operationReceipt": {
        var receiptOperationId = params.operationId || postBody.operationId || "";
        var operationReceipt = readVillageOperationReceipt_(receiptOperationId);
        if (!operationReceipt) {
          var issuedAtMs = villageOperationIssuedAtMs_(receiptOperationId);
          var ageMs = issuedAtMs ? Date.now() - issuedAtMs : Number.POSITIVE_INFINITY;
          // 30일 보존 receipt의 부재를 안전한 재시도 근거로 쓰는 것은 최근 24시간 ID뿐이다.
          var safelyAbsent = ageMs >= -300000 && ageMs <= 86400000;
          return jsonResponse({
            success: true,
            found: false,
            status: safelyAbsent ? "not_found" : "expired",
            operationId: receiptOperationId,
            retrySafe: safelyAbsent
          });
        }
        return jsonResponse({
          success: true,
          found: true,
          status: operationReceipt.status || "indeterminate",
          operationId: operationReceipt.operationId,
          capability: operationReceipt.capability,
          action: operationReceipt.action,
          requestDigest: operationReceipt.requestDigest,
          updatedAt: operationReceipt.updatedAt || operationReceipt.startedAt || ""
        });
      }

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
        if (!isRangeBoundToSheet_(wSheet, postBody.range)) return jsonResponse({ error: "range sheet must match the allowlisted sheet" });
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
        var uCell = params.cell || postBody.cell;
        if (!isRangeBoundToSheet_(uSheet, uCell)) return jsonResponse({ error: "cell sheet must match the allowlisted sheet" });
        return jsonResponse(updateCell(uSheet, uCell, params.value !== undefined ? params.value : postBody.value));
      }

      case "equipmentMasterSync": {
        // 재고 원장 앱(equipment_ledger) → 장비마스터 시트 미러링 전용.
        // 일반 write 화이트리스트와 분리해 필요한 열(D/E/H/I/J)만 갱신, 신규는 append.
        return jsonResponse(syncEquipmentMaster(postBody.rows || [], postBody.append || []));
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
        var runFuncName = String(params.func || postBody.func || "");
        // 확인요청을 바꾸는 run 함수들은 목록 캐시를 무효화한다
        if (/Request|deleteTrade|recoverPending/i.test(runFuncName)) invalidateConfirmListCache_();
        return jsonResponse(runFunction(runFuncName, runParams));

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
        // tid: 화면이 캡처한 행 번호가 밀렸을 때 다른 거래를 덮어쓰지 않게 하는 재검증 키
        var updateTimeTid = params.tid || postBody.tid || "";
        if (!row || !newStart || !newEnd) return jsonResponse({ success: false, message: "row, start, end 필수" });
        return jsonResponse(updateScheduleTime(row, newStart, newEnd, rowIndices, updateTimeTid));
      }

      case "scheduleChangeDates": {
        if (!e.postData) return jsonResponse({ success: false, error: "scheduleChangeDates requires POST" });
        var dateChangeArgs = postBody.args || {};
        if (typeof dateChangeArgs === "string") dateChangeArgs = JSON.parse(dateChangeArgs);
        return jsonResponse(changeRegisteredTradeDates(dateChangeArgs));
      }

      case "scheduleCorrectRegisteredTrade": {
        if (!e.postData) return jsonResponse({ success: false, error: "scheduleCorrectRegisteredTrade requires POST" });
        var correctionArgs = postBody.args || {};
        if (typeof correctionArgs === "string") correctionArgs = JSON.parse(correctionArgs);
        return jsonResponse(correctRegisteredTrade(correctionArgs));
      }

      case "cloneScheduleNoSend":
        // 확인요청/등록 알림톡 경로를 통하지 않고 등록 거래를 직접 복제한다.
        return jsonResponse(cloneScheduleNoSend_(postBody));

      case "updateStatus": {
        var row = Number(params.row || postBody.row);
        var newStatus = params.status || postBody.status;
        var rowIndices = params.rowIndices || postBody.rowIndices || null;
        var updateStatusTid = params.tid || postBody.tid || "";
        if (!row || !newStatus) return jsonResponse({ success: false, message: "row, status 필수" });
        return jsonResponse(updateScheduleStatus(row, newStatus, rowIndices, updateStatusTid));
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
        invalidateConfirmListCache_(); // 대기열 상태(O열)가 바뀐다
        return jsonResponse(scheduleRegister(reqID));
      }

      case "dashboard":
        // nocache=1 이면 캐시 우회 (새로고침 버튼용). profile=1 이면 단계별 소요시간 포함(성능 진단용).
        var skipCache = (params.nocache === '1' || postBody.nocache === 1 || postBody.nocache === '1');
        return jsonResponse(getDashboardData(params.date || postBody.date || null, skipCache, {
          profile: params.profile || postBody.profile
        }));

      case "radar":
        // 재방문 레이더 — 읽기 전용 집계 (계약마스터/스케줄상세). PII 포함이라 key 인증 뒤에서만.
        return jsonResponse(getReactivationRadar(params));

      case "equipRadar":
        // 장비 수익 레이더 — 읽기 전용 집계 (장비마스터/스케줄상세). PII 없음.
        return jsonResponse(getEquipmentProfitRadar(params));

      case "autopilot":
        // 그로스 오토파일럿 — 주간 실행 팩(재활성·청구누락·유휴·KPI+할일). 읽기전용, PII 포함(연락처)이라 key 뒤에서만.
        return jsonResponse(getGrowthAutopilot(params));

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

      case "myPageEstimate":
        // 고객용 견적서 PDF — 같은 토큰을 재검증하고 Google Sheets 계약서 원본은 반환하지 않음 (myPage.js)
        return jsonResponse(getMyReservationEstimatePdf(params.token || postBody.token || ""));

      case "dashboardSearch":
        return jsonResponse(getDashboardSearchData(
          params.q || params.query || postBody.q || postBody.query || "",
          {
            limit: Number(params.limit || postBody.limit) || 80,
            profile: params.profile || postBody.profile,
            summary: params.summary || postBody.summary,
            detailGroup: params.detailGroup || postBody.detailGroup,
            includeCautions: params.includeCautions || postBody.includeCautions
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
          (params.done === '1' || params.done === 'true' || postBody.done === true || postBody.done === '1' || postBody.done === 1),
          {
            mutationId: params.mutationId || postBody.mutationId || '',
            remoteDoneAt: params.remoteDoneAt || postBody.remoteDoneAt || ''
          }
        ));

      case "toggleReturn":
        return jsonResponse(toggleReturnDone(
          params.tid || postBody.tid,
          (params.done === '1' || params.done === 'true' || postBody.done === true || postBody.done === '1' || postBody.done === 1),
          // force=1: 미확인 품목이 있어도 작업자가 확인하고 완료 처리(강제 차단 대신 사람이 결정)
          {
            force: (params.force === '1' || params.force === 'true' || postBody.force === true || postBody.force === '1' || postBody.force === 1),
            mutationId: params.mutationId || postBody.mutationId || '',
            remoteDoneAt: params.remoteDoneAt || postBody.remoteDoneAt || '',
            enforceExpectedReturnDoneAt: (
              params.enforceExpectedReturnDoneAt === '1' || params.enforceExpectedReturnDoneAt === 'true' ||
              postBody.enforceExpectedReturnDoneAt === true || postBody.enforceExpectedReturnDoneAt === '1' ||
              postBody.enforceExpectedReturnDoneAt === 1
            ),
            expectedReturnDoneAt: params.expectedReturnDoneAt !== undefined
              ? params.expectedReturnDoneAt
              : (postBody.expectedReturnDoneAt || '')
          }
        ));

      case "toggleItem":
        return jsonResponse(toggleItemCheck(
          params.scheduleId || postBody.scheduleId,
          params.phase || postBody.phase,
          (params.done === '1' || params.done === 'true' || postBody.done === true || postBody.done === '1' || postBody.done === 1),
          { mutationId: params.mutationId || postBody.mutationId || '' }
        ));

      case "toggleItems":
        return jsonResponse(toggleItemChecksBatch(
          params.tid || postBody.tid || params.tradeId || postBody.tradeId,
          params.items || postBody.items || params.entries || postBody.entries
        ));

      case "repairTradeProjection":
        return jsonResponse(repairDashboardTradeProjection_(
          params.tid || postBody.tid || params.tradeId || postBody.tradeId
        ));

      case "getTradeDiscountState":
        return jsonResponse(getTradeDiscountState(
          params.tid || postBody.tid || params.tradeId || postBody.tradeId
        ));

      case "updateTradeDiscount": {
        // 등록된 거래의 할인유형 변경 (계약마스터 K열) — 금액·계약서는 재생성 워커가 반영
        return jsonResponse(updateTradeDiscountType(
          params.tid || postBody.tid || params.tradeId || postBody.tradeId,
          params.discountType || postBody.discountType || params.할인유형 || postBody.할인유형,
          {
            mutationId: params.mutationId || postBody.mutationId || params.mutation_id || postBody.mutation_id || '',
            mutationCreatedAt: params.mutationCreatedAt || postBody.mutationCreatedAt || params.mutation_created_at || postBody.mutation_created_at || 0,
            previousDiscountType: params.previousDiscountType !== undefined
              ? params.previousDiscountType
              : postBody.previousDiscountType,
            previousDiscountTypes: params.previousDiscountTypes || postBody.previousDiscountTypes || '[]',
            clientInstanceId: params.clientInstanceId || postBody.clientInstanceId || params.client_instance_id || postBody.client_instance_id || '',
            clientSequence: params.clientSequence || postBody.clientSequence || params.client_sequence || postBody.client_sequence || 0
          }
        ));
      }

      case "updateEquipmentCheck":
        return jsonResponse(updateEquipmentCheck(
          params.scheduleId || postBody.scheduleId,
          params.tid || postBody.tid || params.tradeId || postBody.tradeId,
          params.label || postBody.label || params.equipName || postBody.equipName,
          params.field || postBody.field,
          params.value !== undefined ? params.value : postBody.value
        ));

      case "updateTrade":
        return jsonResponse(dashboardUpdateTradeDetails(
          params.tid || postBody.tid || params.tradeId || postBody.tradeId,
          {
            customerName: params.customerName || postBody.customerName,
            customerPhone: params.customerPhone !== undefined ? params.customerPhone : postBody.customerPhone,
            company: params.company !== undefined ? params.company : postBody.company,
            checkoutDate: params.checkoutDate || postBody.checkoutDate,
            checkoutTime: params.checkoutTime || postBody.checkoutTime,
            returnDate: params.returnDate || postBody.returnDate,
            returnTime: params.returnTime || postBody.returnTime,
            // 편집 시작 시점 스냅샷(JSON) — 다른 직원의 선행 수정을 덮어쓰지 않는 CAS 키
            expected: params.expected !== undefined ? params.expected : postBody.expected
          }
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
          {
            dryRun: params.dryRun || postBody.dryRun,
            profile: params.profile || postBody.profile,
            mutationId: params.mutationId || postBody.mutationId || params.mutation_id || postBody.mutation_id || '',
            directRegenerate:
              params.directRegenerate || postBody.directRegenerate ||
              params.regenerateNow || postBody.regenerateNow
          }
        ));

      case "addEquips":
      case "addEquipBatch":
        return jsonResponse(dashboardAddEquipments(
          params.tid || postBody.tid,
          params.entries || postBody.entries || params.items || postBody.items,
          {
            dryRun: params.dryRun || postBody.dryRun,
            profile: params.profile || postBody.profile,
            mutationId: params.mutationId || postBody.mutationId || params.mutation_id || postBody.mutation_id || '',
            directRegenerate:
              params.directRegenerate || postBody.directRegenerate ||
              params.regenerateNow || postBody.regenerateNow
          }
        ));

      case "onsiteAddon":
      case "recordOnsiteAddon":
        return jsonResponse(dashboardRecordOnsiteAddon(
          params.tid || postBody.tid,
          params.entries || postBody.entries || params.items || postBody.items,
          {
            dryRun: params.dryRun || postBody.dryRun,
            rawNames: params.rawNames || postBody.rawNames || params.raw_names || postBody.raw_names,
            settlementStatus: params.settlementStatus || postBody.settlementStatus || params.settlement_status || postBody.settlement_status,
            actorName: params.actorName || postBody.actorName || params.actor_name || postBody.actor_name,
            idempotencyKey: params.idempotencyKey || postBody.idempotencyKey || params.idempotency_key || postBody.idempotency_key,
            directRegenerate:
              params.directRegenerate || postBody.directRegenerate ||
              params.regenerateNow || postBody.regenerateNow
          }
        ));

      case "removeEquip":
        return jsonResponse(dashboardRemoveEquipment(
          params.tid || postBody.tid,
          params.equipName || postBody.equipName,
          params.scheduleId || postBody.scheduleId,
          {
            mutationId: params.mutationId || postBody.mutationId || params.mutation_id || postBody.mutation_id || '',
            directRegenerate:
              params.directRegenerate || postBody.directRegenerate ||
              params.regenerateNow || postBody.regenerateNow
          }
        ));

      case "removeEquips":
      case "removeEquipBatch":
        return jsonResponse(dashboardRemoveEquipmentBatch(
          params.tid || postBody.tid || params.tradeId || postBody.tradeId,
          params.items || postBody.items || params.entries || postBody.entries,
          {
            mutationId: params.mutationId || postBody.mutationId || params.mutation_id || postBody.mutation_id || ''
          }
        ));

      case "repairDuplicateScheduleRows":
        return jsonResponse(repairDashboardDuplicateScheduleRows(
          params.tid || postBody.tid || params.tradeId || postBody.tradeId,
          params.pairs || postBody.pairs,
          { dryRun: params.dryRun !== undefined ? params.dryRun : postBody.dryRun }
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
          {
            dryRun: params.dryRun || postBody.dryRun,
            exactName: params.exactName || postBody.exactName,
            skipAvailability: params.skipAvailability || postBody.skipAvailability,
            mutationId: params.mutationId || postBody.mutationId || params.mutation_id || postBody.mutation_id || '',
            previousNames: params.previousNames || postBody.previousNames || []
          }
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
          {
            dryRun: params.dryRun || postBody.dryRun,
            profile: params.profile || postBody.profile,
            mutationId: params.mutationId || postBody.mutationId || params.mutation_id || postBody.mutation_id || '',
            directRegenerate:
              params.directRegenerate || postBody.directRegenerate ||
              params.regenerateNow || postBody.regenerateNow
          }
        ));

      case "scheduleAddEquips":
        return jsonResponse(dashboardAddEquipments(
          params.tid || postBody.tid,
          params.entries || postBody.entries || params.items || postBody.items,
          {
            dryRun: params.dryRun || postBody.dryRun,
            profile: params.profile || postBody.profile,
            mutationId: params.mutationId || postBody.mutationId || params.mutation_id || postBody.mutation_id || '',
            directRegenerate:
              params.directRegenerate || postBody.directRegenerate ||
              params.regenerateNow || postBody.regenerateNow
          }
        ));

      case "scheduleRemoveEquip":
        return jsonResponse(dashboardRemoveEquipment(
          params.tid || postBody.tid,
          params.equipName || postBody.equipName,
          params.scheduleId || postBody.scheduleId,
          {
            mutationId: params.mutationId || postBody.mutationId || params.mutation_id || postBody.mutation_id || '',
            directRegenerate:
              params.directRegenerate || postBody.directRegenerate ||
              params.regenerateNow || postBody.regenerateNow
          }
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
          params.value !== undefined ? params.value : postBody.value,
          { mutationId: params.mutationId || postBody.mutationId || params.mutation_id || postBody.mutation_id || '' }
        ));

      case "sendEstimate":
        return jsonResponse(requestTradeEstimate(
          params.tid || postBody.tid || params.tradeId || postBody.tradeId,
          { mutationId: params.mutationId || postBody.mutationId || params.mutation_id || postBody.mutation_id || '' }
        ));

      case "sendStatement":
        return jsonResponse(requestTradeStatement(
          params.tid || postBody.tid || params.tradeId || postBody.tradeId,
          { mutationId: params.mutationId || postBody.mutationId || params.mutation_id || postBody.mutation_id || '' }
        ));

      case "sendPayAppPaymentLink":
        return jsonResponse(requestPayAppPaymentLink(
          params.tid || postBody.tid || params.tradeId || postBody.tradeId,
          { mutationId: params.mutationId || postBody.mutationId || params.mutation_id || postBody.mutation_id || '' }
        ));

      case "sendPayAppTestPaymentLink":
        return jsonResponse(requestPayAppTestPaymentLink({
          phone: params.phone || postBody.phone || params.recvphone || postBody.recvphone || params.tel || postBody.tel,
          amount: params.amount || postBody.amount || params.price || postBody.price,
          customerName: params.customerName || postBody.customerName || params.name || postBody.name,
          goodname: params.goodname || postBody.goodname,
          memo: params.memo || postBody.memo
        }));

      case "setupPayAppUserId":
        return jsonResponse(setupPayAppUserId(
          params.userid || postBody.userid || params.userId || postBody.userId
        ));

      case "setupPayAppPaymentTypes":
        return jsonResponse(setupPayAppPaymentTypes(
          params.openpaytype || postBody.openpaytype || params.paymentTypes || postBody.paymentTypes
        ));

      case "diagPayAppConfig":
        return jsonResponse(diagPayAppConfig());

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
          params.tid || postBody.tid || params.tradeId || postBody.tradeId,
          postBody
        ));

      case "issueTaxInvoice":
        return jsonResponse(requestDirectTaxInvoice(
          params.tid || postBody.tid || params.tradeId || postBody.tradeId || params.id || postBody.id,
          postBody,
          params
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
          params.memo || postBody.memo,
          params.clientKey || postBody.clientKey
        ));

      case "deleteDashboardPhoto":
        return jsonResponse(deleteDashboardPhoto(
          params.tid || postBody.tid || params.tradeId || postBody.tradeId,
          params.phase || postBody.phase,
          params.fileId || postBody.fileId,
          params.row || postBody.row,
          params.sheetValue || postBody.sheetValue
        ));

      case "paymentMeta":
        return jsonResponse(inspectTradePaymentColumn());

      // ━━━ 스케줄 관리 API ━━━

      case "list":
        return doListPending();

      case "card":
        // 단일 확인요청 카드 — 편집 큐가 저장 후 그 카드만 갱신할 때 사용(전체 목록 재구축 회피)
        return doConfirmCard(params.reqID || postBody.reqID);

      case "scan": {
        var scanMethodError = requireVillagePost_(e, "scan");
        if (scanMethodError) return scanMethodError;
        return doScanAll();
      }

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
          available: getVillageOperationCapabilities_(),
          usage: {
            read: "GET ?key=...&action=read&sheet=시트명&range=A1:E10&limit=100",
            write: "POST {key, action:'write', sheet, range, values}",
            append: "POST {key, action:'append', sheet, values}",
            update: "GET ?key=...&action=update&sheet=시트명&cell=A1&value=값",
            search: "GET ?key=...&action=search&sheet=시트명&col=D&query=FX3",
            list: "GET ?key=...&action=list (확인요청 대기 목록)",
            scan: "POST {key, action:'scan'} (미처리 건 확인/등록 실행)",
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
// 확인요청 목록 캐시 — GAS 재구축(시트 읽기+그룹핑)을 요청마다 반복하지 않는다.
// 확인요청을 바꾸는 모든 경로(doScheduleAction/run 함수들/registerAsync/시트 직접 편집)가 무효화한다.
var CONFIRM_LIST_CACHE_KEY_ = 'confirmList_v1';
function invalidateConfirmListCache_() {
  try { CacheService.getScriptCache().remove(CONFIRM_LIST_CACHE_KEY_); } catch (e) {}
}

function doListPending() {
  var listCache = null;
  try {
    listCache = CacheService.getScriptCache();
    var cachedList = listCache.get(CONFIRM_LIST_CACHE_KEY_);
    if (cachedList) {
      return ContentService.createTextOutput(cachedList).setMimeType(ContentService.MimeType.JSON);
    }
  } catch (listCacheErr) { listCache = null; }

  const items = buildConfirmPendingItems_(null);
  const payload = { status: "OK", count: items.length, items: items };
  if (listCache) {
    try { listCache.put(CONFIRM_LIST_CACHE_KEY_, JSON.stringify(payload), 60); } catch (putErr) {}
  }
  return jsonResponse(payload);
}

/** 단일 확인요청 카드 조회 — card:null이면 목록에서 빠진 것(등록완료/거절/삭제). */
function doConfirmCard(reqID) {
  reqID = String(reqID || '').trim();
  if (!reqID) return jsonResponse({ status: "ERROR", message: "reqID 필수" });
  var card = null;
  try { card = buildConfirmPendingItems_(reqID)[0] || null; } catch (cardErr) {}
  return jsonResponse({ status: "OK", reqID: reqID, card: card });
}

/** 확인요청 대기 목록 구성. onlyReqID를 주면 그 그룹만(액션 응답의 카드 갱신용). */
function buildConfirmPendingItems_(onlyReqID) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName("확인요청");
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const data = sheet.getRange(2, 1, lastRow - 1, 18).getValues();

  // 날짜/시간 셀이 Date 직렬값이면 "시트에 입력된 그대로"를 복원해야 한다.
  // 스프레드시트 타임존(예: LA)과 Asia/Seoul이 다르면 Asia/Seoul 포맷은
  // 날짜에 16:00이 붙고 시간은 1899 LMT(+8:27) 쓰레기가 됐고, 앱 편집 모달이
  // 그 값을 다시 저장하면서 진짜 시간이 오염되는 루프가 있었다.
  const ssTz = ss.getSpreadsheetTimeZone();
  function fmtDateCell(v) {
    if (v instanceof Date) return Utilities.formatDate(v, ssTz, "yyyy-MM-dd");
    return String(v || "").trim();
  }
  function fmtTimeCell(v) {
    if (v instanceof Date) return Utilities.formatDate(v, ssTz, "HH:mm");
    return String(v || "").trim();
  }

  // ── 단일 패스로 reqID별 그룹핑 ──
  const groupMap = {};   // reqID → { firstIdx, items, isCompleted }
  const groupOrder = []; // 출현 순서 보존

  for (let i = 0; i < data.length; i++) {
    const reqID = data[i][0];
    if (!reqID) continue;
    if (onlyReqID && reqID !== onlyReqID) continue;

    if (!groupMap[reqID]) {
      groupMap[reqID] = { firstIdx: i, items: [], isCompleted: false };
      groupOrder.push(reqID);
    }
    const g = groupMap[reqID];

    const rowStatus = String(data[i][14] || "").trim();
    const groupStatus = (typeof normalizeRegisterQueueStatus_ === "function")
      ? normalizeRegisterQueueStatus_(rowStatus)
      : rowStatus;
    const completedStatus = (typeof isRegisterCompletedStatus_ === "function")
      ? isRegisterCompletedStatus_(rowStatus)
      : rowStatus.indexOf("등록완료") === 0;
    if (completedStatus || rowStatus === "거절") {
      g.isCompleted = true;
    }
    // 그룹 등록상태: 행 단위 "제외" 마커는 무시 — 첫 품목이 제외돼도 카드가 비활성화되면 안 됨
    if (!g.status && groupStatus && groupStatus !== "제외") g.status = groupStatus;

    if (data[i][5]) {
      g.items.push({
        장비명: data[i][5],
        수량: data[i][6] || 1,
        결과: data[i][8] || "",
        상세: data[i][9] || "",
        비고: String(data[i][16] || ""), // Q열 — "[세트]세트명" 구성품 마커
        제외: String(data[i][14] || "").trim() === "제외" // O열 행 단위 등록 제외 ("보류"와 구분되는 전용 마커)
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
      반출일: fmtDateCell(data[i][1]),
      반출시간: fmtTimeCell(data[i][2]),
      반납일: fmtDateCell(data[i][3]),
      반납시간: fmtTimeCell(data[i][4]),
      예약자명: data[i][10] || "",     // K열
      연락처: data[i][11] || "",       // L열
      업체명: data[i][12] || "",       // M열 (레거시 라벨 — 실제로는 할인유형)
      할인유형: data[i][12] || "",     // M열 = 할인유형 (헤이빌리에서 선택/수정용)
      장비목록: g.items,
      추가요청: data[i][17] || "",     // R열
      결과요약: data[i][8] || "",
      등록상태: g.status || "대기"
    });
  }

  return pending;
}

/**
 * 미처리 건 전체 스캔 실행
 * POST {key, action:"scan"}
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
      // 멈춘 큐 행 재처리면 복구 모드(중복 시 기존 거래로 완료), 신규면 중복 경고 유지
      registerByReqID(sheet, row, { fromQueue: isRegisterQueueStatus_(registerStatus) });
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

  // 액션은 목록을 바꾼다 — 캐시를 비우고, 갱신된 카드를 응답에 실어
  // 앱이 전체 목록 재조회(수 초) 없이 그 카드만 즉시 교체하게 한다.
  function confirmActionResponse_(action, extra) {
    invalidateConfirmListCache_();
    var card = null;
    try { card = buildConfirmPendingItems_(reqID)[0] || null; } catch (cardErr) {}
    var payload = { status: "OK", action: action, reqID: reqID, card: card };
    if (extra) Object.keys(extra).forEach(function(k) { payload[k] = extra[k]; });
    return jsonResponse(payload);
  }

  switch (action) {
    case "확인":
      processByReqID(sheet, targetRow);
      return confirmActionResponse_("확인");

    case "등록":
      try {
        var preRegisterStatus = String(sheet.getRange(targetRow, 15).getDisplayValue() || "");
        registerByReqID(sheet, targetRow, { fromQueue: isRegisterQueueStatus_(preRegisterStatus) });
      } catch (regErr) {
        sheet.getRange(targetRow, 15).setValue("❌ 등록 실패: " + regErr.message);
        sheet.getRange(targetRow, 14).clearContent();
        invalidateConfirmListCache_();
        return jsonResponse({ status: "ERROR", action: "등록", reqID: reqID, message: regErr.message });
      }
      // 등록 후 O열 상태 읽어서 반환
      var regStatus = sheet.getRange(targetRow, 15).getDisplayValue();
      return confirmActionResponse_("등록", { message: regStatus });

    case "보류":
      holdByReqID(sheet, allData, reqID);
      return confirmActionResponse_("보류");

    case "거절":
      rejectByReqID(sheet, allData, reqID);
      return confirmActionResponse_("거절");

    case "발송승인":
      sendAvailAlimtalk(sheet, targetRow);
      return confirmActionResponse_("발송승인");

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
  if (!isRangeBoundToSheet_(sheetName, range)) {
    return { error: "range sheet must match the allowlisted sheet" };
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
  if (!isRangeBoundToSheet_(sheetName, cell)) {
    return { error: "cell sheet must match the allowlisted sheet" };
  }
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
    "refreshModelSelectionPrompts",
    "syncAuditFromMaster",
    "insertAndCheckRequest",
    "updateRequest",
    "lookupConfirmRequestCustomer",
    "updateRequestItem",
    "normalizeConfirmRequestDates",
    "recoverPendingRegistrations",
    "recoverPartiallyRegisteredRequests",
    "repairMissingTradeLedgerRow",
    "autoClearRequests",
    "setupAutoClearTrigger",
    "deleteRequest",
    "deleteTrade",
    "excludeEquipFromRequest",
    "formatScheduleSheet",
    "inspectScheduleDetailVisualState",
    "normalizeScheduleDetailSetNames",
    "formatContractSheet",
    "inspectContractStatusValidation",
    "restoreContractStatusDropdown",
    "resyncAllContractDates",
    "scanCorruptedContractTimes",
    "listPendingContractRegens",
    "regenPendingContracts",
    "regenerateContractById",
    "extendRegisteredTrade",
    "markOverdueReturnContracts",
    "inspectContractCancelRecovery",
    "restoreCancelledContractsByIds",
    "backfillDashboardCheckoutBaselineMarkers",
    "setupDiscountColumns",
    "inspectContractTemplateDiscounts",
    "setupContractTemplate",
    "fixSchedQuantityTextOne",
    "setupDashboardWarmerTrigger",
    "warmDashboardCache",
    "inspectTradeBillingCompanyDropdown",
    "repairTradeBillingCompanyDropdown",
    "getInventoryConflicts",
    "getInventoryConflictsSlackMessage",
    "listAllTriggers",
    "setupInstallableTrigger",
    "diagEquipmentRiskBackendConfig",
    "setupEquipmentRiskBackendConfig",
    "getMyPageLink",
    "setupMyPage",
    "testRegisterAlimtalk",
    "testGuideAlimtalk",
    "diagGuideAlimtalkSchedule",
    "markGuideAlimtalkSent"
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
    if (funcName === "lookupConfirmRequestCustomer") {
      var args = params.args ? (typeof params.args === "string" ? JSON.parse(params.args) : params.args) : params;
      var result = lookupConfirmRequestCustomer(args || {});
      return { success: !result.error, function: funcName, result: result, executionTime: (new Date() - startTime) + "ms" };
    }
    if (funcName === "updateRequestItem" && params.args) {
      var args = typeof params.args === "string" ? JSON.parse(params.args) : params.args;
      var result = updateRequestItem(args);
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
    if (funcName === "deleteTrade" && params.args) {
      var delArgs = typeof params.args === "string" ? JSON.parse(params.args) : params.args;
      var tradeId = typeof delArgs === "string" ? delArgs : (delArgs.tradeId || delArgs.거래ID || delArgs.id);
      var delResult = deleteTrade(tradeId);
      return { success: true, function: funcName, result: delResult, executionTime: (new Date() - startTime) + "ms" };
    }
    if (funcName === "getMyPageLink") {
      var args = params.args;
      if (typeof args === "string") {
        try { args = JSON.parse(args); } catch (argErr) { /* 평문 ID("260615-001")는 그대로 사용 */ }
      }
      if (args === undefined || args === null || args === "") args = params;
      var linkId = typeof args === "string" ? args : (args.id || args.tradeId || args.reqID || args.거래ID || "");
      var result = getMyPageLink(linkId);
      return { success: !result.error, function: funcName, result: result, executionTime: (new Date() - startTime) + "ms" };
    }
    if (funcName === "testRegisterAlimtalk") {
      var taArgs = params.args;
      if (typeof taArgs === "string") {
        try { taArgs = JSON.parse(taArgs); } catch (taErr) { taArgs = { 연락처: taArgs }; }
      }
      var taResult = testRegisterAlimtalk(taArgs || {});
      return { success: !taResult.error, function: funcName, result: taResult, executionTime: (new Date() - startTime) + "ms" };
    }
    if (funcName === "testGuideAlimtalk") {
      var tgArgs = params.args;
      if (typeof tgArgs === "string") {
        try { tgArgs = JSON.parse(tgArgs); } catch (tgErr) { tgArgs = { 연락처: tgArgs }; }
      }
      var tgResult = testGuideAlimtalk(tgArgs || {});
      return { success: !tgResult.error, function: funcName, result: tgResult, executionTime: (new Date() - startTime) + "ms" };
    }
    if (funcName === "diagGuideAlimtalkSchedule") {
      var dgArgs = params.args;
      if (typeof dgArgs === "string") {
        try { dgArgs = JSON.parse(dgArgs); } catch (dgErr) { dgArgs = { tradeIds: dgArgs }; }
      }
      var dgResult = diagGuideAlimtalkSchedule(dgArgs || {});
      return { success: !dgResult.error, function: funcName, result: dgResult, executionTime: (new Date() - startTime) + "ms" };
    }
    if (funcName === "markGuideAlimtalkSent") {
      var mgArgs = params.args;
      if (typeof mgArgs === "string") {
        try { mgArgs = JSON.parse(mgArgs); } catch (mgErr) { mgArgs = { tradeIds: mgArgs }; }
      }
      var mgResult = markGuideAlimtalkSent(mgArgs || {});
      return { success: !mgResult.error, function: funcName, result: mgResult, executionTime: (new Date() - startTime) + "ms" };
    }
    if (funcName === "setupMyPage") {
      var setupArgs = params.args;
      if (typeof setupArgs === "string") {
        try { setupArgs = JSON.parse(setupArgs); } catch (suErr) { setupArgs = {}; }
      }
      if (setupArgs === undefined || setupArgs === null || setupArgs === "") setupArgs = params;
      var suResult = setupMyPage(setupArgs || {});
      return { success: !suResult.error, function: funcName, result: suResult, executionTime: (new Date() - startTime) + "ms" };
    }
    if (funcName === "regenerateContractById") {
      var args = params.args ? (typeof params.args === "string" ? JSON.parse(params.args) : params.args) : params;
      var tradeId = typeof args === "string" ? args : (args.tradeId || args.거래ID || args.id);
      var extraText = (args && typeof args === "object") ? (args.extraText || args.추가요청 || args.note || args.memo) : undefined;
      var result = regenerateContractById(tradeId, extraText);
      return { success: !result.error, function: funcName, result: result, executionTime: (new Date() - startTime) + "ms" };
    }
    if (funcName === "repairMissingTradeLedgerRow") {
      var repairArgs = params.args ? (typeof params.args === "string" ? JSON.parse(params.args) : params.args) : params;
      var repairResult = repairMissingTradeLedgerRow(repairArgs || {});
      return { success: !!repairResult.success, function: funcName, result: repairResult, executionTime: (new Date() - startTime) + "ms" };
    }
    if (funcName === "extendRegisteredTrade") {
      var args = params.args ? (typeof params.args === "string" ? JSON.parse(params.args) : params.args) : params;
      var result = extendRegisteredTrade(args || {});
      return { success: !!result.success, function: funcName, result: result, executionTime: (new Date() - startTime) + "ms" };
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
    if (funcName === "backfillDashboardCheckoutBaselineMarkers") {
      var markerArgs = typeof params.args === "string" ? JSON.parse(params.args) : params.args;
      var markerTradeIds = Array.isArray(markerArgs) ? markerArgs : (markerArgs && markerArgs.tradeIds) || [];
      var markerResult = backfillDashboardCheckoutBaselineMarkers(markerTradeIds);
      return { success: !markerResult.error, function: funcName, result: markerResult, executionTime: (new Date() - startTime) + "ms" };
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
      inspectScheduleDetailVisualState: typeof inspectScheduleDetailVisualState !== "undefined" ? inspectScheduleDetailVisualState : null,
      normalizeScheduleDetailSetNames: typeof normalizeScheduleDetailSetNames !== "undefined" ? normalizeScheduleDetailSetNames : null,
      formatContractSheet: typeof formatContractSheet !== "undefined" ? formatContractSheet : null,
      inspectContractStatusValidation: typeof inspectContractStatusValidation !== "undefined" ? inspectContractStatusValidation : null,
      restoreContractStatusDropdown: typeof restoreContractStatusDropdown !== "undefined" ? restoreContractStatusDropdown : null,
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
      inspectTradeBillingCompanyDropdown: typeof inspectTradeBillingCompanyDropdown !== "undefined" ? inspectTradeBillingCompanyDropdown : null,
      repairTradeBillingCompanyDropdown: typeof repairTradeBillingCompanyDropdown !== "undefined" ? repairTradeBillingCompanyDropdown : null,
      getInventoryConflicts: typeof getInventoryConflicts !== "undefined" ? getInventoryConflicts : null,
      getInventoryConflictsSlackMessage: typeof getInventoryConflictsSlackMessage !== "undefined" ? getInventoryConflictsSlackMessage : null,
      listAllTriggers: typeof listAllTriggers !== "undefined" ? listAllTriggers : null,
      setupInstallableTrigger: typeof setupInstallableTrigger !== "undefined" ? setupInstallableTrigger : null,
      syncTemplateMasterFromSetMaster: typeof syncTemplateMasterFromSetMaster !== "undefined" ? syncTemplateMasterFromSetMaster : null,
      normalizeConfirmRequestDates: typeof normalizeConfirmRequestDates !== "undefined" ? normalizeConfirmRequestDates : null,
      recoverPendingRegistrations: typeof recoverPendingRegistrations !== "undefined" ? recoverPendingRegistrations : null,
      recoverPartiallyRegisteredRequests: typeof recoverPartiallyRegisteredRequests !== "undefined" ? recoverPartiallyRegisteredRequests : null,
      autoClearRequests: typeof autoClearRequests !== "undefined" ? autoClearRequests : null,
      setupAutoClearTrigger: typeof setupAutoClearTrigger !== "undefined" ? setupAutoClearTrigger : null
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
    // 조기 반납(반납완료) 건은 더 이상 장비를 점유하지 않음 — 가용성 엔진과 동일 기준
    if (status !== "반납완료" && coDate && ciDate && coDate <= todayStr && todayStr <= ciDate) {
      activeQtySum += (Number(row[4]) || 0);
    }

    // 재고 충돌 — 향후 90일 이내 활성 스케줄을 일자×장비별로 누적 (세트 헤더 행 제외, 반납완료 제외)
    if (status !== "반납완료" && coDate && ciDate && opItem && opItem.name) {
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
        company: (function(dt) { return dt && dt !== "일반" ? dt : ""; })(String(r[12] || "").trim()), // M열=할인유형 (구 업체명)
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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 장비마스터 미러링 (재고 원장 앱 → 시트)
// 열: A대분류 B장비ID C카테고리 D장비명 E총보유 F가용 G대여중 H정비중 I상태 J비고 K최근실사 L단가
// F(가용)/G(대여중)/K(최근실사)는 절대 건드리지 않는다.
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function syncEquipmentMaster(rows, newRows) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName("장비마스터");
  if (!sheet) return { error: "장비마스터 시트 없음" };
  var last = sheet.getLastRow();
  var ids = last > 1 ? sheet.getRange(2, 2, last - 1, 1).getValues() : [];
  var rowById = {};
  for (var i = 0; i < ids.length; i++) {
    var id = String(ids[i][0] || "").trim();
    if (id && !rowById[id]) rowById[id] = i + 2;
  }
  var updated = 0, appended = 0, skipped = [];
  (rows || []).forEach(function (r) {
    var rowNum = rowById[String(r.id || "").trim()];
    if (!rowNum) { skipped.push(r.id || "(no id)"); return; }
    if (r.name != null)  sheet.getRange(rowNum, 4).setValue(r.name);
    if (r.total != null) sheet.getRange(rowNum, 5).setValue(r.total);
    if (r.maint != null) sheet.getRange(rowNum, 8).setValue(r.maint);
    if (r.state != null) sheet.getRange(rowNum, 9).setValue(r.state);
    if (r.note !== undefined) sheet.getRange(rowNum, 10).setValue(r.note || "");
    updated++;
  });
  (newRows || []).forEach(function (r) {
    var idNew = String(r.id || "").trim();
    if (!idNew || rowById[idNew]) { skipped.push(idNew || "(no id)"); return; }
    var target = sheet.getLastRow() + 1;
    sheet.getRange(target, 1, 1, 12).setValues([[
      r.major || "", idNew, r.category || "", r.name || "",
      r.total != null ? r.total : "", "", "",
      r.maint != null ? r.maint : 0,
      r.state || "정상", r.note || "", "", r.price != null ? r.price : ""
    ]]);
    rowById[idNew] = target;
    appended++;
  });
  return { success: true, updated: updated, appended: appended, skipped: skipped };
}
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Registered schedule exact clone — no confirmation request / no Alimtalk
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function cloneScheduleNoSend_(input) {
  input = input || {};
  var targetStart = cloneParseDateTime_(input.targetStart, 'targetStart');
  var targetEnd = cloneParseDateTime_(input.targetEnd, 'targetEnd');
  if (targetStart.error || targetEnd.error) return { success: false, status: 'INVALID_TARGET', error: targetStart.error || targetEnd.error };
  if (targetEnd.dateTime.getTime() <= targetStart.dateTime.getTime()) {
    return { success: false, status: 'INVALID_TARGET', error: 'targetEnd must be later than targetStart' };
  }

  var customerName = String(input.customerName || '').trim();
  var sourceTradeId = String(input.sourceTradeId || '').trim();
  if (!customerName && !sourceTradeId) return { success: false, status: 'INVALID_SOURCE', error: 'customerName or sourceTradeId is required' };
  if (sourceTradeId && !/^\d{6}-\d{3}$/.test(sourceTradeId)) {
    return { success: false, status: 'INVALID_SOURCE', error: 'sourceTradeId is invalid' };
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return { success: false, status: 'LOCK_TIMEOUT', error: 'registered schedule clone lock timeout' };
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var source = cloneResolveSourceTrade_(ss, customerName, sourceTradeId);
    if (source.error) return source;
    var sourceFingerprint = cloneSourceFingerprint_(source);
    var target = { start: targetStart, end: targetEnd };

    var duplicate = cloneFindTargetDuplicate_(ss, source, target);
    if (duplicate.error) return duplicate;
    var availability = cloneCheckAvailability_(ss, source.scheduleRows, target);
    if (!availability.ok) {
      return {
        success: false,
        status: 'CONFLICT',
        sourceTradeId: source.tradeId,
        sourceFingerprint: sourceFingerprint,
        targetStart: targetStart.text,
        targetEnd: targetEnd.text,
        conflicts: availability.conflicts || [],
        warnings: availability.warnings || []
      };
    }

    var preview = clonePreviewResult_(source, sourceFingerprint, target, availability, duplicate);
    if (input.dryRun === true || input.dryRun === 'true' || input.dryRun === 1 || input.dryRun === '1') return preview;
    if (String(input.expectedSourceFingerprint || '').trim() !== sourceFingerprint) {
      return { success: false, status: 'SOURCE_CHANGED', error: 'source fingerprint changed or was not supplied', sourceTradeId: source.tradeId };
    }
    if (duplicate.duplicate) return preview;

    var ledger = cloneOpenLedger_();
    if (ledger.error) return ledger;
    var newTradeId = cloneNextTradeId_(ss.getSheetByName('계약마스터'), ledger.sheet);
    if (!newTradeId) return { success: false, status: 'ID_ALLOCATION_FAILED', error: 'unable to allocate trade ID' };

    var writeState = { tradeId: newTradeId, contractRow: 0, scheduleStartRow: 0, scheduleCount: 0, ledgerRow: 0, ledgerSheet: ledger.sheet };
    try {
      cloneWriteTrade_(ss, source, target, newTradeId, ledger.sheet, writeState);
      PropertiesService.getScriptProperties().setProperty('cloneNoSend_' + newTradeId, JSON.stringify({
        sourceTradeId: source.tradeId,
        sourceFingerprint: sourceFingerprint,
        customerSendSuppressed: true,
        createdAt: new Date().toISOString()
      }));
      try { scheduleContractRegen(newTradeId); } catch (regenError) { /* readback below keeps the schedule authoritative even if PDF generation queues late */ }
      try { if (typeof supaMarkTradeDirty_ === 'function') supaMarkTradeDirty_(newTradeId); } catch (syncError) {}
      try { invalidateDashboardCache([target.start.date, target.end.date]); } catch (cacheError) {}
      try { invalidateTimelineCache(); } catch (timelineError) {}
    } catch (writeError) {
      cloneRollbackWrite_(writeState);
      return { success: false, status: 'WRITE_FAILED', error: String(writeError && writeError.message || writeError), sourceTradeId: source.tradeId };
    }

    var readback = cloneReadback_(ss, ledger.sheet, source, target, newTradeId);
    if (!readback.contract || !readback.schedule || !readback.ledger || !readback.customerSendFlagPresent) {
      cloneRollbackWrite_(writeState);
      return { success: false, status: 'READBACK_FAILED', error: 'contract, schedule, ledger, or no-send marker readback failed', tradeId: newTradeId, readback: readback };
    }
    return {
      success: true,
      tradeId: newTradeId,
      sourceTradeId: source.tradeId,
      sourceFingerprint: sourceFingerprint,
      targetStart: target.start.text,
      targetEnd: target.end.text,
      sourceRowCount: source.scheduleRows.length,
      targetRowCount: readback.targetRowCount,
      topLevelItems: cloneTopLevelItems_(source.scheduleRows),
      warnings: availability.warnings || [],
      confirmRequestCleaned: true,
      customerSendSuppressed: true,
      customerSendFlagPresent: true,
      contractRegenerationQueued: true,
      readback: readback
    };
  } finally {
    lock.releaseLock();
  }
}

function cloneParseDateTime_(value, field) {
  var text = String(value || '').trim();
  var match = text.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})$/);
  if (!match) return { error: field + ' must use YYYY-MM-DD HH:MM' };
  var dateTime = parseDT(match[1], match[2]);
  if (!(dateTime instanceof Date) || isNaN(dateTime.getTime())) return { error: field + ' is invalid' };
  return { text: match[1] + ' ' + match[2], date: match[1], time: match[2], dateTime: dateTime };
}

function cloneNormalizeName_(value) {
  return String(value || '').trim().replace(/\s+/g, '').toLowerCase();
}

function clonePhoneKey_(value) {
  return String(value || '').replace(/\D/g, '');
}

function cloneResolveSourceTrade_(ss, customerName, sourceTradeId) {
  var contractSheet = ss.getSheetByName('계약마스터');
  var scheduleSheet = ss.getSheetByName('스케줄상세');
  if (!contractSheet || !scheduleSheet) return { success: false, status: 'SOURCE_NOT_FOUND', error: '계약마스터 or 스케줄상세 is missing' };
  if (contractSheet.getLastRow() < 2 || scheduleSheet.getLastRow() < 2) return { success: false, status: 'SOURCE_NOT_FOUND', error: 'registered schedule data is empty' };
  var values = contractSheet.getRange(2, 1, contractSheet.getLastRow() - 1, 12).getValues();
  var display = contractSheet.getRange(2, 1, contractSheet.getLastRow() - 1, 12).getDisplayValues();
  var wantedName = cloneNormalizeName_(customerName);
  var candidates = [];
  values.forEach(function(row, index) {
    var tid = String(row[0] || '').trim();
    var name = String(row[1] || '').trim();
    var status = String(row[9] || '').trim();
    if (!tid || status === '취소') return;
    if (sourceTradeId ? tid === sourceTradeId : cloneNormalizeName_(name) === wantedName) {
      candidates.push({ tid: tid, row: row, display: display[index], contractRow: index + 2 });
    }
  });
  if (!candidates.length) return { success: false, status: 'SOURCE_NOT_FOUND', error: 'matching registered trade was not found' };
  if (candidates.length !== 1) {
    return {
      success: false,
      status: 'SOURCE_AMBIGUOUS',
      error: 'multiple registered trades match; sourceTradeId is required',
      candidates: candidates.slice(0, 8).map(function(candidate) {
        return { tradeId: candidate.tid, name: String(candidate.row[1] || ''), checkout: String(candidate.display[4] || '') + ' ' + String(candidate.display[5] || ''), checkin: String(candidate.display[6] || '') + ' ' + String(candidate.display[7] || ''), status: String(candidate.row[9] || '') };
      })
    };
  }
  var selected = candidates[0];
  var phone = clonePhoneKey_(selected.row[2]);
  if (phone.length < 10) return { success: false, status: 'SOURCE_CONTACT_MISSING', error: 'source trade has no usable customer phone' };
  var allSchedule = scheduleSheet.getRange(2, 1, scheduleSheet.getLastRow() - 1, 13).getValues();
  var sourceRows = allSchedule.filter(function(row) {
    return String(row[1] || '').trim() === selected.tid && String(row[3] || '').trim() && String(row[9] || '').trim() !== '취소';
  });
  if (!sourceRows.length) return { success: false, status: 'SOURCE_NOT_FOUND', error: 'source trade has no active schedule rows' };
  return {
    success: true,
    tradeId: selected.tid,
    contractRow: selected.contractRow,
    contractValues: selected.row,
    contractDisplay: selected.display,
    name: String(selected.row[1] || '').trim(),
    phone: phone,
    scheduleRows: sourceRows
  };
}

function cloneCanonicalValue_(value) {
  if (value instanceof Date) return Utilities.formatDate(value, 'Asia/Seoul', 'yyyy-MM-dd HH:mm:ss');
  if (value === null || value === undefined) return '';
  return String(value);
}

function cloneDigest_(value) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, JSON.stringify(value), Utilities.Charset.UTF_8);
  return bytes.map(function(item) { var n = item < 0 ? item + 256 : item; return (n < 16 ? '0' : '') + n.toString(16); }).join('');
}

function cloneSourceFingerprint_(source) {
  return cloneDigest_({
    tradeId: source.tradeId,
    contract: source.contractValues.map(cloneCanonicalValue_),
    rows: source.scheduleRows.map(function(row) { return row.slice(2, 13).map(cloneCanonicalValue_); })
  });
}

function cloneRowSignatures_(rows) {
  return (rows || []).map(function(row) {
    return JSON.stringify([
      cloneCanonicalValue_(row[2]), cloneCanonicalValue_(row[3]), Number(row[4]) || 1,
      cloneCanonicalValue_(row[10]), cloneCanonicalValue_(row[11]), cloneCanonicalValue_(row[12])
    ]);
  }).sort();
}

function cloneSignaturesEqual_(left, right) {
  left = cloneRowSignatures_(left);
  right = cloneRowSignatures_(right);
  return left.length === right.length && left.every(function(value, index) { return value === right[index]; });
}

function cloneFindTargetDuplicate_(ss, source, target) {
  var contractSheet = ss.getSheetByName('계약마스터');
  var scheduleSheet = ss.getSheetByName('스케줄상세');
  var contracts = contractSheet.getRange(2, 1, contractSheet.getLastRow() - 1, 12).getValues();
  var displays = contractSheet.getRange(2, 1, contractSheet.getLastRow() - 1, 12).getDisplayValues();
  var targetTrades = [];
  contracts.forEach(function(row, index) {
    var tid = String(row[0] || '').trim();
    if (!tid || String(row[9] || '').trim() === '취소') return;
    if (clonePhoneKey_(row[2]) !== source.phone) return;
    if (String(displays[index][4] || '').trim() !== target.start.date || String(displays[index][5] || '').trim() !== target.start.time) return;
    if (String(displays[index][6] || '').trim() !== target.end.date || String(displays[index][7] || '').trim() !== target.end.time) return;
    targetTrades.push(tid);
  });
  if (!targetTrades.length) return { duplicate: false };
  var allRows = scheduleSheet.getRange(2, 1, scheduleSheet.getLastRow() - 1, 13).getValues();
  for (var i = 0; i < targetTrades.length; i++) {
    var rows = allRows.filter(function(row) { return String(row[1] || '').trim() === targetTrades[i] && String(row[9] || '').trim() !== '취소'; });
    if (cloneSignaturesEqual_(source.scheduleRows, rows)) return { duplicate: true, tradeId: targetTrades[i] };
  }
  return { success: false, status: 'TARGET_CONFLICT', error: 'same customer already has a different schedule in the target window', candidateTradeIds: targetTrades };
}

function clonePhysicalAvailabilityItems_(rows) {
  var hasComponents = {};
  (rows || []).forEach(function(row) {
    var setName = String(row[2] || '').trim();
    var equipName = String(row[3] || '').trim();
    if (setName && equipName && setName !== equipName) hasComponents[setName] = true;
  });
  var grouped = {};
  (rows || []).forEach(function(row) {
    var setName = String(row[2] || '').trim();
    var equipName = String(row[3] || '').trim();
    if (!equipName) return;
    if (setName === equipName && hasComponents[setName]) return;
    grouped[equipName] = (grouped[equipName] || 0) + (Number(row[4]) || 1);
  });
  return Object.keys(grouped).map(function(name) { return { name: name, qty: grouped[name] }; });
}

function cloneCheckAvailability_(ss, sourceRows, target) {
  var items = clonePhysicalAvailabilityItems_(sourceRows);
  if (!items.length) return { ok: false, conflicts: [{ message: 'source schedule has no physical equipment rows' }], warnings: [] };
  return checkAvailabilityForAdd_(items, target.start.dateTime, target.end.dateTime, ss.getSheetByName('장비마스터'), ss.getSheetByName('스케줄상세'));
}

function cloneTopLevelItems_(rows) {
  return (rows || []).filter(function(row) {
    var setName = String(row[2] || '').trim();
    var equipName = String(row[3] || '').trim();
    return equipName && (!setName || setName === equipName);
  }).map(function(row) { return { name: String(row[3] || ''), qty: Number(row[4]) || 1 }; });
}

function clonePreviewResult_(source, fingerprint, target, availability, duplicate) {
  return {
    success: true,
    dryRun: true,
    duplicate: !!duplicate.duplicate,
    tradeId: duplicate.tradeId || '',
    sourceTradeId: source.tradeId,
    sourceFingerprint: fingerprint,
    targetStart: target.start.text,
    targetEnd: target.end.text,
    sourceRowCount: source.scheduleRows.length,
    topLevelItems: cloneTopLevelItems_(source.scheduleRows),
    warnings: availability.warnings || [],
    confirmRequestCleaned: true,
    customerSendSuppressed: true,
    customerSendFlagPresent: true,
    readback: { contract: true, schedule: true, ledger: true }
  };
}

function cloneOpenLedger_() {
  try {
    var url = PropertiesService.getScriptProperties().getProperty('개고생2_URL');
    if (!url) return { success: false, status: 'LEDGER_UNAVAILABLE', error: '개고생2_URL is not configured' };
    var sheet = SpreadsheetApp.openByUrl(url).getSheetByName('거래내역');
    if (!sheet) return { success: false, status: 'LEDGER_UNAVAILABLE', error: '거래내역 sheet is missing' };
    return { success: true, sheet: sheet };
  } catch (error) {
    return { success: false, status: 'LEDGER_UNAVAILABLE', error: String(error && error.message || error) };
  }
}

function cloneNextTradeId_(contractSheet, ledgerSheet) {
  if (!contractSheet) return '';
  var prefix = Utilities.formatDate(new Date(), 'Asia/Seoul', 'yyMMdd') + '-';
  var maxNumber = 0;
  function observe_(value) {
    var text = String(value || '').trim();
    if (text.indexOf(prefix) !== 0) return;
    var n = Number(text.slice(prefix.length));
    if (n > maxNumber) maxNumber = n;
  }
  if (contractSheet.getLastRow() >= 2) contractSheet.getRange(2, 1, contractSheet.getLastRow() - 1, 1).getDisplayValues().forEach(function(row) { observe_(row[0]); });
  if (ledgerSheet && ledgerSheet.getLastRow() >= 2) ledgerSheet.getRange(2, 5, ledgerSheet.getLastRow() - 1, 1).getDisplayValues().forEach(function(row) { observe_(row[0]); });
  return prefix + ('000' + (maxNumber + 1)).slice(-3);
}

function cloneRentalRounds_(start, end) {
  var hours = (end.dateTime.getTime() - start.dateTime.getTime()) / 3600000;
  return Math.max(1, Math.ceil((hours - 3) / 24));
}

function cloneWriteTrade_(ss, source, target, tradeId, ledgerSheet, state) {
  var contractSheet = ss.getSheetByName('계약마스터');
  var scheduleSheet = ss.getSheetByName('스케줄상세');
  if (!contractSheet || !scheduleSheet) throw new Error('contract or schedule sheet is missing');
  var contractRow = contractSheet.getLastRow() + 1;
  if (contractRow > contractSheet.getMaxRows()) contractSheet.insertRowsAfter(contractSheet.getMaxRows(), 10);
  var sourceContract = source.contractValues;
  contractSheet.getRange(contractRow, 1, 1, 12).setValues([[
    tradeId, source.name, source.phone, sourceContract[3] || '',
    target.start.date, target.start.time, target.end.date, target.end.time,
    cloneRentalRounds_(target.start, target.end), '예약', sourceContract[10] || '일반', sourceContract[11] || ''
  ]]);
  state.contractRow = contractRow;

  var scheduleStartRow = scheduleSheet.getLastRow() + 1;
  var count = source.scheduleRows.length;
  if (scheduleStartRow + count - 1 > scheduleSheet.getMaxRows()) scheduleSheet.insertRowsAfter(scheduleSheet.getMaxRows(), count + 10);
  var scheduleValues = source.scheduleRows.map(function(row, index) {
    return [
      tradeId + '-' + ('00' + (index + 1)).slice(-2), tradeId, row[2] || '', row[3] || '', Number(row[4]) || 1,
      target.start.date, target.start.time, target.end.date, target.end.time, '대기', row[10] || '', row[11] || 0, source.name
    ];
  });
  scheduleSheet.getRange(scheduleStartRow, 1, count, 13).setValues(scheduleValues);
  scheduleSheet.getRange(scheduleStartRow, 5, count, 1).setNumberFormat('#,##0');
  scheduleSheet.getRange(scheduleStartRow, 6, count, 4).setNumberFormat('@');
  scheduleSheet.getRange(scheduleStartRow, 12, count, 1).setNumberFormat('#,##0');
  state.scheduleStartRow = scheduleStartRow;
  state.scheduleCount = count;
  try { formatScheduleSheet(scheduleSheet); } catch (formatError) {}

  var ledgerRow = ledgerSheet.getLastRow() + 1;
  if (ledgerRow > ledgerSheet.getMaxRows()) ledgerSheet.insertRowsAfter(ledgerSheet.getMaxRows(), 10);
  ledgerSheet.getRange(ledgerRow, 1, 1, 6).setValues([[target.start.date, source.name, '', '', tradeId, source.phone]]);
  ledgerSheet.getRange(ledgerRow, 6).setNumberFormat('@');
  state.ledgerRow = ledgerRow;
  SpreadsheetApp.flush();
}

function cloneRollbackWrite_(state) {
  try {
    if (state.ledgerSheet && state.ledgerRow && String(state.ledgerSheet.getRange(state.ledgerRow, 5).getDisplayValue() || '').trim() === state.tradeId) {
      state.ledgerSheet.getRange(state.ledgerRow, 1, 1, Math.max(6, state.ledgerSheet.getLastColumn())).clearContent();
    }
  } catch (ledgerError) {}
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var scheduleSheet = ss.getSheetByName('스케줄상세');
    if (scheduleSheet && state.scheduleStartRow && state.scheduleCount) {
      var tids = scheduleSheet.getRange(state.scheduleStartRow, 2, state.scheduleCount, 1).getDisplayValues();
      if (tids.every(function(row) { return String(row[0] || '').trim() === state.tradeId; })) scheduleSheet.deleteRows(state.scheduleStartRow, state.scheduleCount);
    }
  } catch (scheduleError) {}
  try {
    var contractSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('계약마스터');
    if (contractSheet && state.contractRow && String(contractSheet.getRange(state.contractRow, 1).getDisplayValue() || '').trim() === state.tradeId) contractSheet.deleteRow(state.contractRow);
  } catch (contractError) {}
  try { PropertiesService.getScriptProperties().deleteProperty('cloneNoSend_' + state.tradeId); } catch (markerError) {}
}

function cloneReadback_(ss, ledgerSheet, source, target, tradeId) {
  var contractSheet = ss.getSheetByName('계약마스터');
  var scheduleSheet = ss.getSheetByName('스케줄상세');
  var contract = false;
  if (contractSheet && contractSheet.getLastRow() >= 2) {
    var rows = contractSheet.getRange(2, 1, contractSheet.getLastRow() - 1, 12).getDisplayValues();
    contract = rows.some(function(row) {
      return String(row[0] || '').trim() === tradeId && String(row[4] || '').trim() === target.start.date && String(row[5] || '').trim() === target.start.time && String(row[6] || '').trim() === target.end.date && String(row[7] || '').trim() === target.end.time;
    });
  }
  var targetRows = [];
  if (scheduleSheet && scheduleSheet.getLastRow() >= 2) {
    targetRows = scheduleSheet.getRange(2, 1, scheduleSheet.getLastRow() - 1, 13).getValues().filter(function(row) { return String(row[1] || '').trim() === tradeId; });
  }
  var schedule = targetRows.length === source.scheduleRows.length && cloneSignaturesEqual_(source.scheduleRows, targetRows) && targetRows.every(function(row) {
    return cloneCanonicalValue_(row[5]) === target.start.date && cloneCanonicalValue_(row[6]) === target.start.time && cloneCanonicalValue_(row[7]) === target.end.date && cloneCanonicalValue_(row[8]) === target.end.time && String(row[9] || '').trim() === '대기';
  });
  var ledger = false;
  if (ledgerSheet && ledgerSheet.getLastRow() >= 2) ledger = ledgerSheet.getRange(2, 5, ledgerSheet.getLastRow() - 1, 1).getDisplayValues().some(function(row) { return String(row[0] || '').trim() === tradeId; });
  var marker = null;
  try { marker = JSON.parse(PropertiesService.getScriptProperties().getProperty('cloneNoSend_' + tradeId) || ''); } catch (markerError) {}
  return { contract: contract, schedule: schedule, ledger: ledger, customerSendFlagPresent: !!(marker && marker.customerSendSuppressed === true), targetRowCount: targetRows.length };
}
