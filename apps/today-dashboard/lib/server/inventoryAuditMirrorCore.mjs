const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_LEDGER_ROWS = 100_000;
const SHEET_NAME = "장비마스터";
const LEDGER_SELECT =
  "equipment_id,major,category,name,stock_total,stock_maint,price,state,note,open_issues";

const SAFE_ERRORS = Object.freeze({
  mirror_invalid_request: {
    status: 400,
    message: "시트 반영 요청이 올바르지 않습니다.",
  },
  mirror_write_requires_api: {
    status: 400,
    message: "실제 시트 반영은 사장님 승인 화면에서만 실행할 수 있습니다.",
  },
  mirror_service_unavailable: {
    status: 503,
    message: "시트 반영 서버 설정을 확인할 수 없습니다.",
  },
  mirror_ledger_read_failed: {
    status: 503,
    message: "현재 재고 원장을 불러오지 못했습니다.",
  },
  mirror_upstream_timeout: {
    status: 504,
    message: "장비마스터 응답 시간이 초과되었습니다.",
  },
  mirror_upstream_failed: {
    status: 502,
    message: "장비마스터 요청에 실패했습니다.",
  },
  mirror_sheet_contract_invalid: {
    status: 502,
    message: "장비마스터 구조가 예상과 다릅니다.",
  },
  mirror_duplicate_equipment_id: {
    status: 502,
    message: "장비 ID가 중복되어 시트 반영을 중단했습니다.",
  },
  mirror_result_mismatch: {
    status: 502,
    message: "장비마스터 반영 건수가 일치하지 않습니다.",
  },
  mirror_verification_failed: {
    status: 502,
    message: "장비마스터 반영 후 검증에 실패했습니다.",
  },
  mirror_attempt_stale: {
    status: 502,
    message: "시트 반영 작업권이 만료되었습니다.",
  },
});

export class InventoryAuditMirrorError extends Error {
  constructor(code) {
    const safe = SAFE_ERRORS[code] || SAFE_ERRORS.mirror_upstream_failed;
    super(safe.message);
    this.name = "InventoryAuditMirrorError";
    this.code = SAFE_ERRORS[code] ? code : "mirror_upstream_failed";
    this.status = safe.status;
  }
}

export function sanitizeInventoryAuditMirrorError(error) {
  const code =
    error instanceof InventoryAuditMirrorError && SAFE_ERRORS[error.code]
      ? error.code
      : "mirror_upstream_failed";
  const safe = SAFE_ERRORS[code];
  return { code, status: safe.status, message: safe.message };
}

export function isInventoryAuditMirrorUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    String(value || ""),
  );
}

export function getInventoryAuditMirrorConfig(env = process.env) {
  const gasUrl = String(env.GAS_SYNC_URL || "").trim();
  const gasKey = String(env.GAS_API_KEY || "").trim();
  if (!gasUrl || !gasKey) {
    throw new InventoryAuditMirrorError("mirror_service_unavailable");
  }
  try {
    const parsed = new URL(gasUrl);
    if (parsed.protocol !== "https:") {
      throw new InventoryAuditMirrorError("mirror_service_unavailable");
    }
  } catch (error) {
    if (error instanceof InventoryAuditMirrorError) throw error;
    throw new InventoryAuditMirrorError("mirror_service_unavailable");
  }
  return { gasUrl, gasKey };
}

/** 원장 행을 장비마스터 비고(J) 문자열로 변환한다. */
export function mirrorNote(row) {
  const labels = (row.open_issues || [])
    .map((issue) => issue?.label)
    .filter(Boolean);
  return [...new Set([row.note, ...labels].filter(Boolean))].join(" · ");
}

function requiredColumnIndexes(sheetHeaders) {
  if (!Array.isArray(sheetHeaders)) {
    throw new InventoryAuditMirrorError("mirror_sheet_contract_invalid");
  }
  const names = [
    "장비ID",
    "장비명",
    "총보유수량",
    "정비중수량",
    "상태",
    "비고",
  ];
  const result = {};
  for (const name of names) {
    const indexes = [];
    for (let index = 0; index < sheetHeaders.length; index += 1) {
      if (sheetHeaders[index] === name) indexes.push(index);
    }
    if (indexes.length !== 1) {
      throw new InventoryAuditMirrorError("mirror_sheet_contract_invalid");
    }
    result[name] = indexes[0];
  }
  return result;
}

function normalizedLedgerRow(row) {
  const id = String(row?.equipment_id || "").trim();
  if (!id) {
    throw new InventoryAuditMirrorError("mirror_sheet_contract_invalid");
  }
  const archived = row.state === "보관종료";
  return {
    id,
    name: String(row.name || ""),
    total: archived ? 0 : row.stock_total,
    maint: archived ? 0 : row.stock_maint ?? 0,
    state: row.state || "정상",
    note: mirrorNote(row),
    major: row.major || "",
    category: row.category || "",
    price: row.price,
  };
}

/** 현재 전체 원장과 장비마스터를 비교해 수렴에 필요한 변경만 계산한다. */
export function diffLedgerAgainstSheet(ledger, sheetHeaders, sheetData) {
  if (!Array.isArray(ledger) || !Array.isArray(sheetData)) {
    throw new InventoryAuditMirrorError("mirror_sheet_contract_invalid");
  }
  const columns = requiredColumnIndexes(sheetHeaders);
  const sheetById = new Map();
  for (const row of sheetData) {
    if (!Array.isArray(row)) {
      throw new InventoryAuditMirrorError("mirror_sheet_contract_invalid");
    }
    const id = String(row[columns["장비ID"]] || "").trim();
    if (!id) continue;
    if (sheetById.has(id)) {
      throw new InventoryAuditMirrorError("mirror_duplicate_equipment_id");
    }
    sheetById.set(id, row);
  }

  const ledgerIds = new Set();
  const rows = [];
  const append = [];
  for (const raw of ledger) {
    const wanted = normalizedLedgerRow(raw);
    if (ledgerIds.has(wanted.id)) {
      throw new InventoryAuditMirrorError("mirror_duplicate_equipment_id");
    }
    ledgerIds.add(wanted.id);
    const sheetRow = sheetById.get(wanted.id);
    if (!sheetRow) {
      append.push(wanted);
      continue;
    }
    const current = {
      name: String(sheetRow[columns["장비명"]] ?? ""),
      total:
        sheetRow[columns["총보유수량"]] === "" ||
        sheetRow[columns["총보유수량"]] == null
          ? null
          : Number(sheetRow[columns["총보유수량"]]),
      maint:
        sheetRow[columns["정비중수량"]] === "" ||
        sheetRow[columns["정비중수량"]] == null
          ? 0
          : Number(sheetRow[columns["정비중수량"]]),
      state: String(sheetRow[columns["상태"]] ?? "") || "정상",
      note: String(sheetRow[columns["비고"]] ?? ""),
    };
    if (
      current.name !== wanted.name ||
      current.total !== (wanted.total ?? null) ||
      current.maint !== wanted.maint ||
      current.state !== wanted.state ||
      current.note !== wanted.note
    ) {
      rows.push({
        id: wanted.id,
        name: wanted.name,
        total: wanted.total,
        maint: wanted.maint,
        state: wanted.state,
        note: wanted.note,
      });
    }
  }
  return { rows, append };
}

function gasEndpoint(gasUrl, action, body) {
  let endpoint;
  try {
    endpoint = new URL(gasUrl);
  } catch {
    throw new InventoryAuditMirrorError("mirror_service_unavailable");
  }
  endpoint.searchParams.delete("key");

  // 현재 운영 GAS의 read 분기는 POST body에서 action/key는 읽지만 sheet는
  // e.parameter에서만 읽는다. 비밀키는 body에만 두고, 비밀이 아닌 read
  // action/sheet만 query에도 반복해 기존 배포와 안전하게 호환한다.
  if (action === "read") {
    endpoint.searchParams.set("action", "read");
    endpoint.searchParams.set("sheet", body.sheet);
  } else {
    endpoint.searchParams.delete("action");
    endpoint.searchParams.delete("sheet");
  }
  return endpoint.toString();
}

async function postGasJson({
  action,
  body,
  gasUrl,
  gasKey,
  fetchImpl,
  signal,
}) {
  let response;
  try {
    response = await fetchImpl(gasEndpoint(gasUrl, action, body), {
      method: "POST",
      redirect: "follow",
      cache: "no-store",
      headers: { "content-type": "text/plain;charset=utf-8" },
      body: JSON.stringify({ key: gasKey, action, ...body }),
      signal,
    });
  } catch (error) {
    if (signal?.aborted || error?.name === "AbortError") {
      throw new InventoryAuditMirrorError("mirror_upstream_timeout");
    }
    throw new InventoryAuditMirrorError("mirror_upstream_failed");
  }
  if (!response?.ok) {
    throw new InventoryAuditMirrorError("mirror_upstream_failed");
  }
  try {
    return await response.json();
  } catch {
    throw new InventoryAuditMirrorError("mirror_upstream_failed");
  }
}

function validateSheetRead(payload) {
  if (
    !payload ||
    payload.error ||
    !Array.isArray(payload.headers) ||
    !Array.isArray(payload.data) ||
    !Number.isInteger(payload.rowCount) ||
    payload.rowCount < 0 ||
    payload.rowCount !== payload.data.length
  ) {
    throw new InventoryAuditMirrorError("mirror_sheet_contract_invalid");
  }
  requiredColumnIndexes(payload.headers);
  return payload;
}

async function readEquipmentMaster(options) {
  return validateSheetRead(
    await postGasJson({
      ...options,
      action: "read",
      body: { sheet: SHEET_NAME },
    }),
  );
}

async function loadCompleteLedger(loadLedgerPage, pageSize, signal) {
  const ledger = [];
  for (let from = 0; from < MAX_LEDGER_ROWS; from += pageSize) {
    let page;
    try {
      page = await loadLedgerPage({
        from,
        to: from + pageSize - 1,
        signal,
      });
    } catch (error) {
      if (signal.aborted || error?.name === "AbortError") {
        throw new InventoryAuditMirrorError("mirror_upstream_timeout");
      }
      if (error instanceof InventoryAuditMirrorError) throw error;
      throw new InventoryAuditMirrorError("mirror_ledger_read_failed");
    }
    if (!Array.isArray(page) || page.length > pageSize) {
      throw new InventoryAuditMirrorError("mirror_ledger_read_failed");
    }
    ledger.push(...page);
    if (page.length < pageSize) return ledger;
  }
  throw new InventoryAuditMirrorError("mirror_ledger_read_failed");
}

function validateWriteResult(payload, expectedUpdates, expectedAppends) {
  if (!payload || payload.error || payload.success !== true) {
    throw new InventoryAuditMirrorError("mirror_upstream_failed");
  }
  if (
    !Array.isArray(payload.skipped) ||
    payload.skipped.length > 0 ||
    payload.updated !== expectedUpdates ||
    payload.appended !== expectedAppends
  ) {
    throw new InventoryAuditMirrorError("mirror_result_mismatch");
  }
  return payload;
}

/**
 * 현재 전체 원장을 장비마스터에 수렴시키고, 쓰기 후 전체 diff를 다시 검증한다.
 * sessionId는 전달 추적용이며 어떤 원장 행도 세션 범위로 축소하지 않는다.
 */
export async function runInventoryAuditMirror({
  sessionId,
  dryRun = false,
  pageSize = DEFAULT_PAGE_SIZE,
  loadLedgerPage,
  gasUrl,
  gasKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (
    !sessionId ||
    typeof loadLedgerPage !== "function" ||
    typeof fetchImpl !== "function" ||
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1
  ) {
    throw new InventoryAuditMirrorError("mirror_invalid_request");
  }
  const config = getInventoryAuditMirrorConfig({
    GAS_SYNC_URL: gasUrl,
    GAS_API_KEY: gasKey,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();

  try {
    const ledger = await loadCompleteLedger(
      loadLedgerPage,
      pageSize,
      controller.signal,
    );
    const sheet = await readEquipmentMaster({
      ...config,
      fetchImpl,
      signal: controller.signal,
    });
    const changes = diffLedgerAgainstSheet(
      ledger,
      sheet.headers,
      sheet.data,
    );
    const base = {
      sessionId,
      dryRun: Boolean(dryRun),
      ledgerRowCount: ledger.length,
      sheetRowCount: sheet.rowCount,
      updateCount: changes.rows.length,
      appendCount: changes.append.length,
    };
    if (dryRun) {
      return {
        ...base,
        wrote: false,
        updatedCount: 0,
        appendedCount: 0,
        alreadyCurrent:
          changes.rows.length === 0 && changes.append.length === 0,
      };
    }
    if (changes.rows.length === 0 && changes.append.length === 0) {
      return {
        ...base,
        wrote: false,
        updatedCount: 0,
        appendedCount: 0,
        alreadyCurrent: true,
      };
    }

    const write = validateWriteResult(
      await postGasJson({
        ...config,
        fetchImpl,
        signal: controller.signal,
        action: "equipmentMasterSync",
        body: { rows: changes.rows, append: changes.append },
      }),
      changes.rows.length,
      changes.append.length,
    );
    const verifiedSheet = await readEquipmentMaster({
      ...config,
      fetchImpl,
      signal: controller.signal,
    });
    const remaining = diffLedgerAgainstSheet(
      ledger,
      verifiedSheet.headers,
      verifiedSheet.data,
    );
    if (remaining.rows.length > 0 || remaining.append.length > 0) {
      throw new InventoryAuditMirrorError("mirror_verification_failed");
    }
    return {
      ...base,
      sheetRowCount: verifiedSheet.rowCount,
      wrote: true,
      updatedCount: write.updated,
      appendedCount: write.appended,
      alreadyCurrent: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function createSupabaseRestLedgerPageLoader({
  supabaseUrl,
  serviceRoleKey,
  fetchImpl = globalThis.fetch,
}) {
  let baseUrl;
  try {
    baseUrl = new URL("rest/v1/equipment_ledger", `${supabaseUrl}/`);
  } catch {
    throw new InventoryAuditMirrorError("mirror_service_unavailable");
  }
  if (!serviceRoleKey || typeof fetchImpl !== "function") {
    throw new InventoryAuditMirrorError("mirror_service_unavailable");
  }

  return async ({ from, to, signal }) => {
    const endpoint = new URL(baseUrl);
    endpoint.searchParams.set("select", LEDGER_SELECT);
    endpoint.searchParams.set("order", "equipment_id.asc");
    endpoint.searchParams.set("offset", String(from));
    endpoint.searchParams.set("limit", String(to - from + 1));
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "GET",
        cache: "no-store",
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
          "Accept-Profile": "village",
        },
        signal,
      });
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") {
        throw new InventoryAuditMirrorError("mirror_upstream_timeout");
      }
      throw new InventoryAuditMirrorError("mirror_ledger_read_failed");
    }
    if (!response.ok) {
      throw new InventoryAuditMirrorError("mirror_ledger_read_failed");
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw new InventoryAuditMirrorError("mirror_ledger_read_failed");
    }
    if (!Array.isArray(data)) {
      throw new InventoryAuditMirrorError("mirror_ledger_read_failed");
    }
    return data;
  };
}
