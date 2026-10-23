/**
 * Internal, no-send disposition of one approved stale confirmation request.
 * baselineFormat sheet-api-values-18-v1: complete A:R getValues() rows, with
 * Date cells serialized exactly like searchSheet(): Asia/Seoul yyyy-MM-dd HH:mm:ss.
 * Other primitive values retain their types and whitespace. Row positions are
 * deliberately excluded; complete row multiplicity is compared instead.
 * Source evidence is bound by the caller's real fresh room capture; this API
 * checks its shape/freshness, not the conversation's business meaning.
 * No new receipt/property storage: callers persist their one-shot local fence
 * before POST and never replay an unknown outcome. Exact terminal state can be
 * proven read-only without invoking rejectByReqID again.
 */
function pendingRequestReconciliationError_(code, message) {
  var error = new Error(message);
  error.code = code;
  return error;
}

function pendingRequestReconciliationJsonRows_(rows) {
  return rows.map(function(row) {
    return row.map(function(value) {
      return value instanceof Date
        ? Utilities.formatDate(value, "Asia/Seoul", "yyyy-MM-dd HH:mm:ss") : value;
    });
  });
}

function pendingRequestReconciliationSignature_(rows) {
  return JSON.stringify(rows.map(function(row) { return JSON.stringify(row); }).sort());
}

function pendingRequestReconciliationInput_(args) {
  if (!args || args.disposition !== "reject" || args.send !== false ||
      args.baselineFormat !== "sheet-api-values-18-v1" ||
      !/^RQ-\d{6}-\d{3}$/.test(String(args.requestId || ""))) {
    throw pendingRequestReconciliationError_("invalid_input", "Exact pending request, reject disposition and send:false are required.");
  }
  if (!Array.isArray(args.expectedRows) || !args.expectedRows.length || args.expectedRows.length > 200 ||
      args.expectedRows.some(function(row) {
        return !Array.isArray(row) || row.length !== 18 || row[0] !== args.requestId ||
          row[13] !== "" || row[14] !== "" || row[15] !== "" ||
          row.some(function(value) {
            return !["string", "number", "boolean"].includes(typeof value) ||
              (typeof value === "number" && !isFinite(value));
          });
      })) {
    throw pendingRequestReconciliationError_("invalid_baseline", "Complete pending A:R rows with blank N/O/P are required.");
  }
  var source = args.sourceEvidence || {};
  var age = Date.now() - Date.parse(source.capturedAt || "");
  if (source.confirmed !== true || !/^chat:\d+$/.test(String(source.roomKey || "")) ||
      !/^[a-f0-9]{64}$/i.test(String(source.snapshotSha256 || "")) ||
      !Array.isArray(source.decisionMessageIds) || !source.decisionMessageIds.length ||
      source.decisionMessageIds.some(function(id) { return typeof id !== "string" || !id.trim(); }) ||
      !isFinite(age) || age < -30000 || age > 300000) {
    throw pendingRequestReconciliationError_("invalid_source", "A real approved room snapshot captured within five minutes is required.");
  }
  return args;
}

function reconcilePendingRequest(args) {
  var scriptLock, userLock, scriptHeld = false, userHeld = false;
  var writeAttempted = false, sheet, beforeAll, requestId = "";
  var proof = { ok: false, status: "blocked", writeAttempted: false,
    readbackVerified: false, noReplay: true, customerNotificationSent: false };
  try {
    args = pendingRequestReconciliationInput_(args);
    requestId = args.requestId;
    proof.requestId = requestId;
    proof.baselineFormat = args.baselineFormat;
    proof.sourceEvidence = args.sourceEvidence;
    // Same order as commitConfirmedReservation. ScriptLock excludes legacy
    // registration; UserLock excludes request edits, inserts and row deletion.
    scriptLock = LockService.getScriptLock();
    userLock = LockService.getUserLock();
    if (!scriptLock.tryLock(30000)) {
      throw pendingRequestReconciliationError_("registration_busy", "Registration lock is busy.");
    }
    scriptHeld = true;
    userLock.waitLock(10000);
    userHeld = true;
    // Lock wait must not turn an expired source into accepted evidence.
    pendingRequestReconciliationInput_(args);
    sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("확인요청");
    if (!sheet || sheet.getLastRow() < 2) {
      throw pendingRequestReconciliationError_("request_missing", "Request not found.");
    }
    var rawAll = sheet.getRange(2, 1, sheet.getLastRow() - 1, 18).getValues();
    beforeAll = pendingRequestReconciliationJsonRows_(rawAll);
    var current = beforeAll.filter(function(row) { return row[0] === requestId; });
    if (!current.length) throw pendingRequestReconciliationError_("request_missing", "Request not found.");
    var desired = args.expectedRows.map(function(row) {
      var copy = row.slice(); copy[14] = "거절"; return copy;
    });
    proof.before = current;
    if (pendingRequestReconciliationSignature_(current) === pendingRequestReconciliationSignature_(desired)) {
      proof.ok = true;
      proof.status = "already_applied";
      proof.readbackVerified = true;
      proof.after = current;
      return proof;
    }
    if (current.some(function(row) { return row[13] !== "" || row[14] !== "" || row[15] !== ""; })) {
      throw pendingRequestReconciliationError_("request_not_pending", "Request has a command, registration state, or bound trade.");
    }
    if (pendingRequestReconciliationSignature_(current) !== pendingRequestReconciliationSignature_(args.expectedRows)) {
      throw pendingRequestReconciliationError_("baseline_changed", "Full A:R request baseline changed.");
    }
    writeAttempted = true;
    proof.writeAttempted = true;
    // Existing behavior: O=거절, N cleared, O background and stock-resume
    // housekeeping. It does not send customer notifications or cancel trades.
    rejectByReqID(sheet, rawAll, requestId);
    SpreadsheetApp.flush();
    var afterAll = pendingRequestReconciliationJsonRows_(sheet.getRange(2, 1, sheet.getLastRow() - 1, 18).getValues());
    var expectedAll = beforeAll.map(function(row) {
      var copy = row.slice();
      if (copy[0] === requestId) { copy[13] = ""; copy[14] = "거절"; }
      return copy;
    });
    proof.after = afterAll.filter(function(row) { return row[0] === requestId; });
    if (JSON.stringify(afterAll) !== JSON.stringify(expectedAll)) {
      throw pendingRequestReconciliationError_("readback_mismatch", "Independent sheet readback differs from the exact permitted N/O changes.");
    }
    proof.ok = true;
    proof.status = "applied";
    proof.readbackVerified = true;
    proof.unrelatedRowsPreserved = true;
    return proof;
  } catch (error) {
    proof.status = writeAttempted ? "outcome_unknown" : "blocked";
    proof.writeAttempted = writeAttempted;
    proof.code = String(error.code || (writeAttempted ? "mutation_failed" : "preflight_failed"));
    proof.error = String(error.message || error);
    return proof;
  } finally {
    if (userHeld) userLock.releaseLock();
    if (scriptHeld) scriptLock.releaseLock();
  }
}
