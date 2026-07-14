import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  InventoryAuditMirrorError,
  diffLedgerAgainstSheet,
  getInventoryAuditMirrorConfig,
  getInventoryAuditMirrorLedgerVersion,
  inventoryAuditMirrorErrorPreservesLease,
  runInventoryAuditMirror,
  sanitizeInventoryAuditMirrorError,
} from "../lib/server/inventoryAuditMirrorCore.mjs";

const SESSION_ID = "00000000-0000-4000-8000-000000000091";
const SECRET = "do-not-put-this-in-a-url";
const HEADERS = [
  "대분류",
  "장비ID",
  "카테고리",
  "장비명",
  "총보유수량",
  "가용수량",
  "대여중수량",
  "정비중수량",
  "상태",
  "비고",
  "최근실사",
  "단가",
];

function ledgerRow(overrides = {}) {
  return {
    equipment_id: "CAM-001",
    major: "카메라",
    category: "바디",
    name: "Sony A7 IV",
    stock_total: 3,
    stock_maint: 1,
    price: 100000,
    state: "정상",
    note: "메모",
    open_issues: [{ label: "바디캡 누락" }],
    updated_at: "2026-07-14T08:00:00.000Z",
    ...overrides,
  };
}

function sheetRow(row) {
  return [
    row.major ?? "",
    row.equipment_id,
    row.category ?? "",
    row.name,
    row.state === "보관종료" ? 0 : row.stock_total,
    "",
    "",
    row.state === "보관종료" ? 0 : row.stock_maint ?? 0,
    row.state || "정상",
    [row.note, ...(row.open_issues || []).map((issue) => issue?.label)]
      .filter(Boolean)
      .filter((value, index, values) => values.indexOf(value) === index)
      .join(" · "),
    "",
    row.price ?? "",
  ];
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function makeGasFetch(initialRows, options = {}) {
  let rows = initialRows.map((row) => [...row]);
  const requests = [];

  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), init });
    const payload = JSON.parse(String(init.body));
    if (payload.action === "read") {
      return jsonResponse({
        sheet: "장비마스터",
        rowCount: rows.length,
        headers: HEADERS,
        data: rows,
      });
    }
    if (payload.action !== "equipmentMasterSync") {
      return jsonResponse({ error: "unexpected action" });
    }
    if (options.writeResponse) return jsonResponse(options.writeResponse);

    const idIndex = HEADERS.indexOf("장비ID");
    for (const update of payload.rows) {
      const index = rows.findIndex((row) => row[idIndex] === update.id);
      if (index === -1) continue;
      rows[index][3] = update.name;
      rows[index][4] = update.total;
      rows[index][7] = update.maint;
      rows[index][8] = update.state;
      rows[index][9] = update.note;
    }
    for (const append of payload.append) {
      rows.push([
        append.major,
        append.id,
        append.category,
        append.name,
        append.total,
        "",
        "",
        append.maint,
        append.state,
        append.note,
        "",
        append.price,
      ]);
    }
    return jsonResponse({
      success: true,
      updated: payload.rows.length,
      appended: payload.append.length,
      skipped: [],
    });
  };

  return { fetchImpl, requests, getRows: () => rows };
}

test("dry-run paginates the complete ledger, keeps the key in POST bodies, and writes nothing", async () => {
  const ledger = [
    ledgerRow(),
    ledgerRow({ equipment_id: "CAM-002", name: "Sony FX3", stock_total: 2 }),
    ledgerRow({ equipment_id: "LENS-001", name: "Sony 24-70", stock_total: 1 }),
  ];
  const pageCalls = [];
  const gas = makeGasFetch([sheetRow(ledger[0])]);

  const result = await runInventoryAuditMirror({
    sessionId: SESSION_ID,
    dryRun: true,
    pageSize: 2,
    loadLedgerPage: async ({ from, to }) => {
      pageCalls.push({ from, to });
      return ledger.slice(from, to + 1);
    },
    gasUrl: "https://script.google.com/macros/s/deployment/exec?key=old-leak",
    gasKey: SECRET,
    fetchImpl: gas.fetchImpl,
  });

  assert.deepEqual(pageCalls, [
    { from: 0, to: 1 },
    { from: 2, to: 3 },
  ]);
  assert.deepEqual(result, {
    sessionId: SESSION_ID,
    dryRun: true,
    ledgerRowCount: 3,
    sheetRowCount: 1,
    updateCount: 0,
    appendCount: 2,
    wrote: false,
    updatedCount: 0,
    appendedCount: 0,
    alreadyCurrent: false,
  });
  assert.equal(gas.requests.length, 1, "dry-run must only read the sheet");
  assert.equal(gas.requests[0].init.method, "POST");
  assert.equal(gas.requests[0].init.cache, "no-store");
  assert.equal(gas.requests[0].url.includes(SECRET), false);
  assert.equal(gas.requests[0].url.includes("key="), false);
  assert.equal(JSON.parse(gas.requests[0].init.body).key, SECRET);
  assert.equal(JSON.parse(gas.requests[0].init.body).sheet, "장비마스터");
});

test("a real mirror converges every current ledger row and verifies the resulting sheet", async () => {
  const current = ledgerRow();
  const appended = ledgerRow({
    equipment_id: "CAM-002",
    name: "Sony FX3",
    stock_total: 1,
    stock_maint: 0,
    note: "",
    open_issues: [],
  });
  const stale = sheetRow({ ...current, stock_total: 99 });
  const gas = makeGasFetch([stale]);

  const result = await runInventoryAuditMirror({
    sessionId: SESSION_ID,
    loadLedgerPage: async ({ from }) => (from === 0 ? [current, appended] : []),
    gasUrl: "https://script.google.com/macros/s/deployment/exec",
    gasKey: SECRET,
    fetchImpl: gas.fetchImpl,
  });

  assert.deepEqual(result, {
    sessionId: SESSION_ID,
    dryRun: false,
    ledgerRowCount: 2,
    sheetRowCount: 2,
    updateCount: 1,
    appendCount: 1,
    wrote: true,
    updatedCount: 1,
    appendedCount: 1,
    alreadyCurrent: false,
  });
  assert.equal(gas.requests.length, 3, "read, write, and verification read");
  assert.equal(
    gas.requests.some((request) => request.url.includes(SECRET)),
    false,
  );
  assert.deepEqual(
    gas.getRows().map((row) => row[1]),
    ["CAM-001", "CAM-002"],
  );
  assert.deepEqual(getInventoryAuditMirrorLedgerVersion(result), [
    {
      equipment_id: "CAM-001",
      updated_at: "2026-07-14T08:00:00.000Z",
    },
    {
      equipment_id: "CAM-002",
      updated_at: "2026-07-14T08:00:00.000Z",
    },
  ]);
  assert.equal(JSON.stringify(result).includes("updated_at"), false);
  assert.equal(JSON.stringify({ ...result }).includes("ledgerVersion"), false);
});

test("an already-current mirror performs no write and reports reusable success", async () => {
  const ledger = [ledgerRow()];
  const gas = makeGasFetch(ledger.map(sheetRow));

  const result = await runInventoryAuditMirror({
    sessionId: SESSION_ID,
    loadLedgerPage: async ({ from }) => (from === 0 ? ledger : []),
    gasUrl: "https://script.google.com/macros/s/deployment/exec",
    gasKey: SECRET,
    fetchImpl: gas.fetchImpl,
  });

  assert.equal(result.wrote, false);
  assert.equal(result.alreadyCurrent, true);
  assert.equal(result.updateCount, 0);
  assert.equal(result.appendCount, 0);
  assert.equal(gas.requests.length, 1);
  assert.equal(getInventoryAuditMirrorLedgerVersion(result).length, 1);
});

test("post-write verification re-reads the ledger and rejects a mid-flight quantity change", async () => {
  const before = ledgerRow({ stock_total: 3 });
  const after = ledgerRow({
    stock_total: 4,
    updated_at: "2026-07-14T08:01:00.000Z",
  });
  const gas = makeGasFetch([sheetRow({ ...before, stock_total: 99 })]);
  let ledgerReads = 0;

  await assert.rejects(
    runInventoryAuditMirror({
      sessionId: SESSION_ID,
      loadLedgerPage: async ({ from }) => {
        if (from !== 0) return [];
        ledgerReads += 1;
        return [ledgerReads === 1 ? before : after];
      },
      gasUrl: "https://script.google.com/macros/s/deployment/exec",
      gasKey: SECRET,
      fetchImpl: gas.fetchImpl,
    }),
    (error) => error.code === "mirror_verification_failed",
  );
  assert.equal(ledgerReads, 2);
});

test("a null stock total is sent as an explicit blank and verifies as null", async () => {
  const row = ledgerRow({ stock_total: null });
  const gas = makeGasFetch([sheetRow({ ...row, stock_total: 9 })]);

  const result = await runInventoryAuditMirror({
    sessionId: SESSION_ID,
    loadLedgerPage: async ({ from }) => (from === 0 ? [row] : []),
    gasUrl: "https://script.google.com/macros/s/deployment/exec",
    gasKey: SECRET,
    fetchImpl: gas.fetchImpl,
  });

  const writePayload = gas.requests
    .map((request) => JSON.parse(String(request.init.body)))
    .find((payload) => payload.action === "equipmentMasterSync");
  assert.equal(writePayload.rows[0].total, "");
  assert.equal(result.wrote, true);
  assert.equal(gas.getRows()[0][4], "");
});

for (const [name, failure, expectedCode] of [
  ["network rejection", new TypeError(`network ${SECRET}`), "mirror_upstream_failed"],
  ["abort", new DOMException(`abort ${SECRET}`, "AbortError"), "mirror_upstream_timeout"],
]) {
  test(`an equipmentMasterSync ${name} preserves the global lease`, async () => {
    const row = ledgerRow();
    const gas = makeGasFetch([sheetRow({ ...row, stock_total: 99 })]);
    const fetchImpl = async (url, init) => {
      const payload = JSON.parse(String(init.body));
      if (payload.action === "equipmentMasterSync") throw failure;
      return gas.fetchImpl(url, init);
    };

    await assert.rejects(
      runInventoryAuditMirror({
        sessionId: SESSION_ID,
        loadLedgerPage: async ({ from }) => (from === 0 ? [row] : []),
        gasUrl: "https://script.google.com/macros/s/deployment/exec",
        gasKey: SECRET,
        fetchImpl,
      }),
      (error) => {
        assert.equal(error.code, expectedCode);
        assert.equal(inventoryAuditMirrorErrorPreservesLease(error), true);
        assert.equal(error.message.includes(SECRET), false);
        return true;
      },
    );
  });
}

test("headers and IDs are validated before any write", () => {
  assert.throws(
    () => diffLedgerAgainstSheet([ledgerRow()], ["장비ID"], []),
    (error) => error instanceof InventoryAuditMirrorError && error.code === "mirror_sheet_contract_invalid",
  );
  assert.throws(
    () =>
      diffLedgerAgainstSheet(
        [ledgerRow()],
        HEADERS,
        [sheetRow(ledgerRow()), sheetRow(ledgerRow())],
      ),
    (error) => error instanceof InventoryAuditMirrorError && error.code === "mirror_duplicate_equipment_id",
  );
  assert.throws(
    () =>
      diffLedgerAgainstSheet(
        [ledgerRow(), ledgerRow()],
        HEADERS,
        [sheetRow(ledgerRow())],
      ),
    (error) => error instanceof InventoryAuditMirrorError && error.code === "mirror_duplicate_equipment_id",
  );
});

test("stale attempt errors are reduced to a stable public code", () => {
  assert.deepEqual(
    sanitizeInventoryAuditMirrorError(
      new InventoryAuditMirrorError("mirror_attempt_stale"),
    ),
    {
      code: "mirror_attempt_stale",
      status: 502,
      message: "시트 반영 작업권이 만료되었습니다.",
    },
  );
});

test("manual live writes have a stable fail-closed error", () => {
  assert.deepEqual(
    sanitizeInventoryAuditMirrorError(
      new InventoryAuditMirrorError("mirror_write_requires_api"),
    ),
    {
      code: "mirror_write_requires_api",
      status: 400,
      message: "실제 시트 반영은 사장님 승인 화면에서만 실행할 수 있습니다.",
    },
  );
});

test("shared server config fails closed and contains no legacy deployment credential", () => {
  assert.throws(
    () => getInventoryAuditMirrorConfig({}),
    (error) =>
      error instanceof InventoryAuditMirrorError &&
      error.code === "mirror_service_unavailable",
  );
  const source = readFileSync(
    new URL("../lib/server/inventoryAuditMirrorCore.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /village2026|AKfy[a-zA-Z0-9_-]+/);
});

test("inventory database configuration errors sanitize to the stable 503 mirror code", () => {
  assert.deepEqual(
    sanitizeInventoryAuditMirrorError({
      name: "InventoryAuditServiceUnavailableError",
      status: 503,
      code: "inventory_audit_service_unavailable",
      message: `raw ${SECRET}`,
    }),
    {
      code: "mirror_service_unavailable",
      status: 503,
      message: "시트 반영 서버 설정을 확인할 수 없습니다.",
    },
  );
});

for (const [name, writeResponse, expectedCode] of [
  ["logical error", { error: `raw ${SECRET}` }, "mirror_upstream_failed"],
  ["success false", { success: false }, "mirror_upstream_failed"],
  ["skipped IDs", { success: true, updated: 0, appended: 0, skipped: ["CAM-001"] }, "mirror_result_mismatch"],
  ["count mismatch", { success: true, updated: 0, appended: 0, skipped: [] }, "mirror_result_mismatch"],
]) {
  test(`GAS ${name} fails closed without exposing raw upstream data`, async () => {
    const row = ledgerRow();
    const gas = makeGasFetch([sheetRow({ ...row, stock_total: 999 })], {
      writeResponse,
    });

    await assert.rejects(
      runInventoryAuditMirror({
        sessionId: SESSION_ID,
        loadLedgerPage: async ({ from }) => (from === 0 ? [row] : []),
        gasUrl: "https://script.google.com/macros/s/deployment/exec",
        gasKey: SECRET,
        fetchImpl: gas.fetchImpl,
      }),
      (error) => {
        assert.equal(error.code, expectedCode);
        assert.equal(error.message.includes(SECRET), false);
        assert.equal("details" in error, false);
        return true;
      },
    );
  });
}

test("the CLI delegates to the shared core and has no legacy GET or query-string key path", () => {
  const source = readFileSync(
    new URL("../supabase/sync-ledger-to-sheet.mjs", import.meta.url),
    "utf8",
  );

  assert.match(source, /runInventoryAuditMirror/);
  assert.match(source, /--dry-run/);
  assert.match(source, /--session-id/);
  assert.match(source, /if \(!dryRun\)[\s\S]*mirror_write_requires_api/);
  assert.ok(
    source.indexOf("mirror_write_requires_api") <
      source.indexOf("runInventoryAuditMirror({"),
    "the live-write guard must run before the shared core",
  );
  assert.doesNotMatch(source, /method:\s*["']GET["']/);
  assert.doesNotMatch(source, /\?key=|searchParams\.set\(["']key["']/);
  assert.doesNotMatch(source, /village2026|AKfy[a-zA-Z0-9_-]+/);
});
