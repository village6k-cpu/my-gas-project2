const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..");
const gas = fs.readFileSync(path.join(root, "checkAvailability.js"), "utf8");
const view = fs.readFileSync(path.join(root, "apps/today-dashboard/components/ConfirmView.tsx"), "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const updateRequest = gas.slice(
  gas.indexOf("function _updateRequestUnderLock_(req)"),
  gas.indexOf("\n\n/**", gas.indexOf("function updateRequest(req)")),
);

assert(
  /function _updateConfirmRequestRowsInPlace_/.test(gas),
  "같은 행 수의 확인요청 수정은 행 삭제 없이 제자리 일괄 저장하는 fast path가 필요하다",
);
assert(
  /_updateConfirmRequestRowsInPlace_\(sheet, targetRows, data, req, items\)/.test(updateRequest),
  "updateRequest는 장비 행 수가 같을 때 제자리 저장 fast path를 호출해야 한다",
);
assert(
  /sheet\.deleteRows\(targetRows\[0\], targetRows\.length\)/.test(updateRequest) &&
    /getRange\(startRow, 1, items\.length, 18\)\.setValues\(replacementRows\)/.test(updateRequest),
  "행 수가 바뀌는 수정도 연속 행 삭제와 일괄 쓰기로 처리해야 한다",
);
assert(
  /function updateRequest\(req\)[\s\S]*getUserLock\(\)[\s\S]*_updateRequestUnderLock_\(req\)[\s\S]*releaseLock\(\)[\s\S]*processByReqID\(sheet, req\.reqID\)/.test(gas),
  "확인요청 수정은 짧은 쓰기 구간만 잠그고 가용확인은 잠금 밖에서 reqID로 다시 찾아야 한다",
);
assert(
  /function updateRequestItem\(req\)[\s\S]*getUserLock\(\)[\s\S]*releaseLock\(\)[\s\S]*processByReqID\(sheet, req\.reqID\)/.test(gas),
  "품목 단위 수정도 전체 수정과 같은 쓰기 잠금을 사용해야 한다",
);
assert(
  /function scheduleRegister\(reqID\)[\s\S]*getUserLock\(\)[\s\S]*markRegisterQueued_\(sheet, targetRow\)[\s\S]*releaseLock\(\)/.test(gas) &&
    /_assertConfirmRequestEditableRows_\(targetRows, data\)/.test(updateRequest),
  "등록대기 표시와 편집 가능성 검사는 같은 확인요청 락/상태 경계를 공유해야 한다",
);
assert(
  /function processByReqID\(sheet, triggerRowOrReqID\)[\s\S]*throw new Error\("가용확인 대기시간을 초과/.test(gas),
  "reqID 재확인 락 timeout을 성공으로 숨기면 안 된다",
);

const fastPath = extractFunction(gas, "_updateConfirmRequestRowsInPlace_");
assert(
  /getRange\(targetRows\[0\], 1, items\.length, 13\)\.setValues/.test(fastPath) &&
    /getRange\(targetRows\[0\], 17, items\.length, 2\)\.setValues/.test(fastPath),
  "확인요청 편집 열은 일괄 저장하되 등록 전용 N/O/P열은 덮지 않아야 한다",
);
assert(
  !/getRange\(targetRows\[0\], 1, items\.length, 18\)\.setValues/.test(fastPath),
  "등록대기/등록완료/거래ID가 있는 N/O/P열을 오래된 전체 행 스냅샷으로 덮으면 안 된다",
);
assert(
  !/deleteRow\(/.test(fastPath),
  "제자리 저장 fast path에서 deleteRow로 전체 시트를 밀면 안 된다",
);
assert(
  /availabilityChanged/.test(fastPath) && /preservedResult/.test(fastPath),
  "바뀐 품목만 결과를 비우고, 안 바뀐 품목의 가용결과는 보존해야 한다",
);

const editPanel = view.slice(view.indexOf("function EditPanel"), view.indexOf("function Field"));
assert(
  /originalEquipmentSignature/.test(editPanel) && /equipmentChanged/.test(editPanel),
  "수정 패널은 장비가 실제로 바뀌었는지 비교해야 한다",
);
assert(
  /if \(equipmentChanged\) args\.장비 =/.test(editPanel),
  "고객명·연락처·할인만 저장할 때 장비 전체 목록을 GAS로 다시 보내면 안 된다",
);
assert(
  /originalSetHeaderName/.test(editPanel) && /isUnchangedSetHeader\(e\) \? "세트" : ""/.test(editPanel),
  "세트 대표명을 다른 이름으로 바꾸면 오래된 세트 플래그를 보내면 안 된다",
);

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  if (start < 0) throw new Error(`${name} 함수 없음`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`${name} 함수 끝을 찾지 못함`);
}

const rows = [
  ["RQ-TEST", "2026-08-01", "10:00", "2026-08-02", "10:00", "장비 A", 1, "확인", "✅ 가용2", "보유2", "테스트", "010-0000-0000", "일반", "", "", "", "", ""],
  ["RQ-TEST", "", "", "", "", "장비 B", 1, "확인", "✅ 가용3", "보유3", "", "", "", "", "", "", "", ""],
];
let batchWrites = 0;
const sheet = {
  getRange(row, column, rowCount = 1, columnCount = 1) {
    return {
      setNumberFormat() { return this; },
      setFontWeight() { return this; },
      setBackground() { return this; },
      setValues(values) {
        if (column === 1 && columnCount === 13) batchWrites++;
        for (let r = 0; r < rowCount; r++) {
          for (let c = 0; c < columnCount; c++) rows[row - 2 + r][column - 1 + c] = values[r][c];
        }
        return this;
      },
    };
  },
};
const context = { _sanitizeConfirmRequestFreeText_: (v) => String(v || "") };
vm.runInNewContext([
  extractFunction(gas, "_confirmRequestDateKey_"),
  extractFunction(gas, "_confirmRequestTimeKey_"),
  extractFunction(gas, "_normalizeConfirmRequestEquipmentForUpdate_"),
  extractFunction(gas, "_updateConfirmRequestRowsInPlace_"),
].join("\n"), context);

const normalizedSetRows = context._normalizeConfirmRequestEquipmentForUpdate_([
  { 이름: "단품 장비", 수량: 1, 결과: "세트" },
  { 이름: "구성품", 수량: 1, 결과: "" },
], [2, 3], [
  ["RQ-TEST", "", "", "", "", "기존 세트", 1, "", "세트"],
  ["RQ-TEST", "", "", "", "", "구성품", 1, "", ""],
]);
assert(normalizedSetRows[0].결과 === "", "이름이 바뀐 세트 헤더 플래그는 서버에서도 제거해야 한다");
const preservedSetRow = context._normalizeConfirmRequestEquipmentForUpdate_([
  { 이름: "기존 세트", 수량: 1, 결과: "세트" },
], [2], [["RQ-TEST", "", "", "", "", "기존 세트", 1, "", "세트"]]);
assert(preservedSetRow[0].결과 === "세트", "이름이 그대로인 기존 세트 헤더는 보존해야 한다");

const result = context._updateConfirmRequestRowsInPlace_(sheet, [2, 3], rows.map((r) => r.slice()), {
  reqID: "RQ-TEST",
  반출일: "2026-08-01",
  반출시간: "10:00",
  반납일: "2026-08-02",
  반납시간: "10:00",
  예약자명: "테스트",
  연락처: "010-0000-0000",
  할인유형: "일반",
}, [
  { 이름: "장비 A", 수량: 1, 비고: "", 결과: "", 제외: false },
  { 이름: "장비 B", 수량: 2, 비고: "", 결과: "", 제외: false },
]);

assert(batchWrites === 1, "품목 두 행 수정도 setValues 한 번이어야 한다");
assert(result.availabilityChanged === 1 && result.recheck === true, "수량이 바뀐 한 행만 재확인 대상으로 잡아야 한다");
assert(rows[0][8] === "✅ 가용2" && rows[0][9] === "보유2", "안 바뀐 품목 가용결과를 보존해야 한다");
assert(rows[1][8] === "" && rows[1][9] === "", "바뀐 품목의 과거 가용결과는 지워야 한다");

console.log("confirm request update fast path checks passed");
