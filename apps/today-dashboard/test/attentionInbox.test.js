const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Module = require("node:module");
const fs = require("node:fs");

const root = path.resolve(__dirname, "../../..");

function loadTypeScriptModule(relativePath) {
  const ts = require(path.join(root, "apps/today-dashboard/node_modules/typescript"));
  const filename = path.join(root, relativePath);
  const source = fs.readFileSync(filename, "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;
  const mod = new Module(filename, module);
  mod.filename = filename;
  mod.paths = Module._nodeModulePaths(path.dirname(filename));
  mod._compile(compiled, filename);
  return mod.exports;
}

const status = loadTypeScriptModule("apps/today-dashboard/lib/domain/status.ts");

function trade({
  id,
  returnDate,
  damaged = 0,
  lost = 0,
  paymentWarning = true,
  cancelled = false,
}) {
  const expected = Math.max(1, damaged + lost);
  return {
    tradeId: id,
    customerName: `고객 ${id}`,
    customerPhone: "010-0000-0000",
    checkoutAt: `${returnDate}T09:00:00+09:00`,
    returnAt: `${returnDate}T18:00:00+09:00`,
    contractStatus: cancelled ? "취소" : "반납완료",
    setupDone: true,
    returnDone: true,
    paymentWarning,
    equipments: [
      {
        scheduleId: `${id}-EQ`,
        name: "테스트 장비",
        qty: expected,
        takenQty: expected,
        checkoutState: "taken",
      },
    ],
    returnCounts: {
      [`${id}-EQ`]: {
        good: damaged + lost > 0 ? 0 : expected,
        damaged,
        lost,
      },
    },
    photos: [],
    riskWarnings: [],
  };
}

test("확인필요는 반납일 기준 오늘 포함 7일과 향후 건만 지금 목록에 둔다", () => {
  assert.equal(typeof status.buildAttentionInbox, "function", "buildAttentionInbox가 필요합니다");

  const rows = [
    trade({ id: "boundary", returnDate: "2026-09-22" }),
    trade({ id: "older", returnDate: "2026-09-21" }),
    trade({ id: "today", returnDate: "2026-09-28" }),
    trade({ id: "future", returnDate: "2026-10-03" }),
    trade({ id: "cancelled", returnDate: "2026-09-28", cancelled: true }),
  ];

  const inbox = status.buildAttentionInbox(rows, "2026-09-28", null);

  assert.deepEqual(
    inbox.current.map((row) => row.tradeId),
    ["boundary", "today", "future"],
    "7일 경계일과 오늘, 향후 건은 지금 확인할 목록이어야 합니다",
  );
  assert.deepEqual(
    inbox.archived.map((row) => row.tradeId),
    ["older"],
    "8일 이상 지난 건은 이전 누적으로 분리해야 합니다",
  );
  assert.equal(inbox.currentTotal, 3);
  assert.equal(inbox.archivedTotal, 1);
});

test("파손과 분실은 별도 필터로 세고 해당 거래만 남긴다", () => {
  assert.equal(typeof status.buildAttentionInbox, "function", "buildAttentionInbox가 필요합니다");

  const rows = [
    trade({ id: "damaged", returnDate: "2026-09-28", damaged: 1, paymentWarning: false }),
    trade({ id: "lost", returnDate: "2026-09-27", lost: 1, paymentWarning: false }),
    trade({ id: "both", returnDate: "2026-09-20", damaged: 1, lost: 1, paymentWarning: false }),
    trade({ id: "payment", returnDate: "2026-09-28" }),
  ];

  const all = status.buildAttentionInbox(rows, "2026-09-28", null);
  assert.equal(all.facetCounts.damaged, 2);
  assert.equal(all.facetCounts.lost, 2);
  assert.equal(all.facetCounts.payment, 1);

  const lostOnly = status.buildAttentionInbox(rows, "2026-09-28", "lost");
  assert.deepEqual(lostOnly.current.map((row) => row.tradeId), ["lost"]);
  assert.deepEqual(lostOnly.archived.map((row) => row.tradeId), ["both"]);
  assert.equal(lostOnly.currentTotal, 3, "필터를 눌러도 지금 할 일의 원래 숫자는 유지해야 합니다");
  assert.equal(lostOnly.archivedTotal, 1, "필터를 눌러도 이전 누적의 원래 숫자는 유지해야 합니다");
});
